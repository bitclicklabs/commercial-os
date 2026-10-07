/**
 * EventBus (LLD v0.1 section 21, LLD v0.2 section 7.1): minimal outbox on PostgreSQL + BullMQ.
 *
 * publish(event):
 *   1. INSERT into `events` (append-only). With an idempotency key, a second publish returns
 *      the existing row instead of a new one.
 *   2. Add a job to the `{QUEUE_NAME}-events` queue with job id = event id, then set
 *      `dispatched_at`. If Redis fails the row stays with `dispatched_at = null` and the
 *      re-publisher (`republishPending`, periodic) enqueues it later.
 *
 * Consumers must tolerate duplicates: the same event can reach the queue twice (re-publisher
 * racing a slow publish, or a job re-added after BullMQ removed the completed one).
 */
import { randomUUID } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, type EventRow } from '../db/schema.js';
import { redisConnectionFromUrl } from '../queue/run-queue.js';
import {
  envelopeFromRow,
  EventEnvelopeSchema,
  schemaVersionFor,
  sourceOfProducer,
  type EventEnvelope,
  type EventProducer,
} from './envelope.js';

export interface EventBusLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silent: EventBusLogger = { info() {}, warn() {}, error() {} };

export interface PublishEventInput {
  tenantId: string;
  type: string;
  data: Record<string, unknown>;
  /** task_run id or execution id at the root of the flow. */
  correlationId: string;
  producer?: EventProducer;
  occurredAt?: Date | string;
  /** Dedup key (e.g. `evt:task.completed:{taskRunId}`). */
  idempotencyKey?: string;
  /** Defaults to `{type}.v1`. */
  schemaVersion?: string;
}

export interface PublishResult {
  event: EventEnvelope;
  /** False when a row with the same idempotency key already existed. */
  created: boolean;
  /** True when the event is known to be in the queue. */
  dispatched: boolean;
}

export interface EventPublisher {
  /** Persists and dispatches. Throws only when the event is invalid or the INSERT fails. */
  publish(input: PublishEventInput): Promise<PublishResult>;
  /** Same as publish but never throws (emission points in the run path): logs and returns null. */
  emit(input: PublishEventInput): Promise<PublishResult | null>;
}

/** Used when no bus is wired (tests, scripts): emission is a no-op. */
export const NOOP_EVENT_PUBLISHER: EventPublisher = {
  async publish(input) {
    throw new Error(`event bus not configured (publish ${input.type})`);
  },
  async emit() {
    return null;
  },
};

// ---------------------------------------------------------------------------
// Queue transport
// ---------------------------------------------------------------------------
export interface EventQueue {
  add(envelope: EventEnvelope): Promise<void>;
  close(): Promise<void>;
}

export function eventsQueueName(runQueueName: string): string {
  return `${runQueueName}-events`;
}

export class BullEventQueue implements EventQueue {
  readonly queue: Queue<EventEnvelope>;

  constructor(
    readonly name: string,
    redisUrl: string,
  ) {
    this.queue = new Queue<EventEnvelope>(name, {
      // Fail fast when Redis is down: the row stays undispatched and the re-publisher retries.
      connection: { ...redisConnectionFromUrl(redisUrl), enableOfflineQueue: false } as ConnectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    this.queue.on('error', () => {
      /* surfaced on add */
    });
  }

  async add(envelope: EventEnvelope): Promise<void> {
    // Job id = event id: BullMQ ignores a second add while the job exists.
    await this.queue.add(envelope.type, envelope, { jobId: envelope.id });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** In-memory transport for tests. `failing = true` simulates Redis being down. */
export class MemoryEventQueue implements EventQueue {
  readonly jobs = new Map<string, EventEnvelope>();
  failing = false;

  async add(envelope: EventEnvelope): Promise<void> {
    if (this.failing) throw new Error('event queue unavailable');
    if (!this.jobs.has(envelope.id)) this.jobs.set(envelope.id, envelope);
  }

  drain(): EventEnvelope[] {
    const all = [...this.jobs.values()];
    this.jobs.clear();
    return all;
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------
export interface EventBusOptions {
  logger?: EventBusLogger;
  /** Undispatched rows younger than this are left to their publisher (default 15 s). */
  republishGraceMs?: number;
  /** Max rows per re-publisher pass (default 200). */
  republishBatchSize?: number;
  /** Restrict the re-publisher to one tenant (tests); production handles every tenant. */
  tenantId?: string;
}

export interface RepublishResult {
  scanned: number;
  dispatched: number;
  failed: number;
}

export class EventBus implements EventPublisher {
  private readonly logger: EventBusLogger;
  private timer: NodeJS.Timeout | undefined;
  private republishing = false;

  constructor(
    private readonly db: Db,
    private readonly queue: EventQueue,
    private readonly opts: EventBusOptions = {},
  ) {
    this.logger = opts.logger ?? silent;
  }

  async publish(input: PublishEventInput): Promise<PublishResult> {
    const producer = input.producer ?? 'agent-runtime';
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const candidate = EventEnvelopeSchema.parse({
      id: randomUUID(),
      type: input.type,
      schemaVersion: input.schemaVersion ?? schemaVersionFor(input.type),
      tenantId: input.tenantId,
      occurredAt: occurredAt.toISOString(),
      producer,
      correlationId: input.correlationId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      data: input.data,
    });

    const [inserted] = await this.db
      .insert(events)
      .values({
        id: candidate.id,
        tenantId: candidate.tenantId,
        type: candidate.type,
        schemaVersion: candidate.schemaVersion,
        occurredAt,
        payload: candidate.data,
        source: sourceOfProducer(producer),
        producer,
        correlationId: candidate.correlationId,
        idempotencyKey: candidate.idempotencyKey ?? null,
      })
      .onConflictDoNothing({ target: [events.tenantId, events.idempotencyKey] })
      .returning();

    let row: EventRow | undefined = inserted;
    if (!row && candidate.idempotencyKey) {
      row = await this.db.query.events.findFirst({
        where: and(eq(events.tenantId, candidate.tenantId), eq(events.idempotencyKey, candidate.idempotencyKey)),
      });
    }
    if (!row) throw new Error(`event ${candidate.type} could not be persisted`);
    const envelope = envelopeFromRow(row);
    if (row.dispatchedAt) return { event: envelope, created: Boolean(inserted), dispatched: true };
    const dispatched = await this.dispatch(row);
    return { event: envelope, created: Boolean(inserted), dispatched };
  }

  async emit(input: PublishEventInput): Promise<PublishResult | null> {
    try {
      return await this.publish(input);
    } catch (err) {
      this.logger.error({ type: input.type, correlationId: input.correlationId, err: (err as Error).message }, 'event publish failed');
      return null;
    }
  }

  /** Puts the row on the queue and marks it dispatched. Never throws. */
  async dispatch(row: EventRow): Promise<boolean> {
    try {
      await this.queue.add(envelopeFromRow(row));
    } catch (err) {
      this.logger.warn({ eventId: row.id, type: row.type, err: (err as Error).message }, 'event not dispatched; re-publisher will retry');
      await this.db
        .update(events)
        .set({ dispatchAttempts: sql`${events.dispatchAttempts} + 1` })
        .where(eq(events.id, row.id))
        .catch(() => undefined);
      return false;
    }
    try {
      await this.db
        .update(events)
        .set({ dispatchedAt: new Date(), dispatchAttempts: sql`${events.dispatchAttempts} + 1` })
        .where(and(eq(events.id, row.id), isNull(events.dispatchedAt)));
    } catch (err) {
      // The job is in the queue; at worst the re-publisher adds it again (same job id).
      this.logger.warn({ eventId: row.id, err: (err as Error).message }, 'event dispatched but not marked');
    }
    return true;
  }

  /** Re-enqueues rows still undispatched after the grace period. Stops at the first queue failure. */
  async republishPending(): Promise<RepublishResult> {
    const graceMs = this.opts.republishGraceMs ?? 15_000;
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          isNull(events.dispatchedAt),
          lt(events.createdAt, new Date(Date.now() - graceMs)),
          this.opts.tenantId ? eq(events.tenantId, this.opts.tenantId) : undefined,
        ),
      )
      .orderBy(asc(events.createdAt))
      .limit(this.opts.republishBatchSize ?? 200);
    const result: RepublishResult = { scanned: rows.length, dispatched: 0, failed: 0 };
    for (const row of rows) {
      if (await this.dispatch(row)) result.dispatched++;
      else {
        result.failed++;
        break; // Redis is down: try again on the next pass.
      }
    }
    return result;
  }

  /** Runs `republishPending` at boot and every `intervalMs`. */
  startRepublisher(intervalMs: number): void {
    if (this.timer) return;
    const pass = async () => {
      if (this.republishing) return;
      this.republishing = true;
      try {
        const res = await this.republishPending();
        if (res.scanned > 0) this.logger.info({ ...res }, 'event re-publisher pass');
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, 'event re-publisher failed');
      } finally {
        this.republishing = false;
      }
    };
    void pass();
    this.timer = setInterval(() => void pass(), intervalMs);
    this.timer.unref();
  }

  stopRepublisher(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async close(): Promise<void> {
    this.stopRepublisher();
    await this.queue.close();
  }
}
