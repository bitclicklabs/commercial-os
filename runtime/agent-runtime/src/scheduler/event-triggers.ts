/**
 * EVENT triggers: TaskDefinitions with `schedule.type = "EVENT"` fired by domain events.
 *
 * Registration mirrors CRON: `BullTaskScheduler.syncTask` (API hooks after create, patch,
 * pause, resume and archive, plus the periodic `syncAll`) writes or removes the task in a
 * Redis hash (`pxos:{events_queue}:triggers`, field = task id). Only ACTIVE + enabled tasks
 * with a valid EVENT schedule are registered.
 *
 * The consumer reads the `{QUEUE_NAME}-events` queue. For every event it looks up the
 * registered triggers of the same tenant and type, re-checks the task in PostgreSQL (source
 * of truth; a stale registration is dropped), applies the filter and the anti-loop guard and
 * calls `requestTaskRun` with `taskrun:{task_id}:event:{event_id}`: the same event delivered
 * twice never creates a second TaskRun.
 */
import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, taskDefinitions, type TaskDefinition } from '../db/schema.js';
import { EventEnvelopeSchema, type EventEnvelope } from '../events/envelope.js';
import type { EventPublisher } from '../events/event-bus.js';
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  deepEqual,
  desiredEventTrigger,
  evaluateTrigger,
  eventTaskRunIdempotencyKey,
  eventTriggeredInput,
  type EventTrigger,
  type TriggerDecision,
} from '../events/triggers.js';
import { redisConnectionFromUrl, type RunQueue } from '../queue/run-queue.js';
import { QueueUnavailableError, requestTaskRun } from '../services/task-runs.js';
import type { ProcessorLogger } from '../worker/processor.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export interface RegisteredTrigger {
  task_id: string;
  tenant_id: string;
  event_type: string;
  filter: Record<string, unknown>;
  registered_at: string;
}

export function triggerRegistryKey(eventsQueueName: string): string {
  return `pxos:${eventsQueueName}:triggers`;
}

export function sameTrigger(registered: RegisteredTrigger | null | undefined, task: Pick<TaskDefinition, 'tenantId'>, desired: EventTrigger): boolean {
  return Boolean(
    registered &&
      registered.tenant_id === task.tenantId &&
      registered.event_type === desired.eventType &&
      deepEqual(registered.filter ?? {}, desired.filter),
  );
}

/** Redis hash of registered triggers. Uses the connection of an existing BullMQ queue. */
export class EventTriggerRegistry {
  constructor(
    private readonly queue: Queue,
    readonly key: string,
  ) {}

  private async redis() {
    return this.queue.getBackend().client;
  }

  async get(taskId: string): Promise<RegisteredTrigger | null> {
    const raw = await (await this.redis()).hget(this.key, taskId);
    return raw ? (JSON.parse(raw) as RegisteredTrigger) : null;
  }

  async set(trigger: RegisteredTrigger): Promise<void> {
    await (await this.redis()).hset(this.key, { [trigger.task_id]: JSON.stringify(trigger) });
  }

  async remove(taskId: string): Promise<boolean> {
    return (await (await this.redis()).hdel(this.key, taskId)) > 0;
  }

  async list(): Promise<RegisteredTrigger[]> {
    const all = await (await this.redis()).hgetall(this.key);
    return Object.values(all).map((v) => JSON.parse(v) as RegisteredTrigger);
  }
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------
export type EventTriggerOutcome =
  | { taskId: string; outcome: 'created' | 'deduplicated' | 'created_unqueued'; taskRunId: string }
  | {
      taskId: string;
      outcome: 'task_missing' | 'skipped_inactive' | 'skipped_agent_inactive' | Extract<TriggerDecision, { fire: false }>['reason'];
    };

export interface EventTriggerConsumerOptions {
  /** `{QUEUE_NAME}-events`. */
  queueName: string;
  redisUrl: string;
  /** Emits task.scheduled for fired runs. */
  events?: EventPublisher;
  maxChainDepth?: number;
  concurrency?: number;
  logger?: ProcessorLogger;
}

/** What the consumer needs from the scheduler: drop stale registrations. */
export interface TriggerSync {
  readonly triggers?: EventTriggerRegistry;
  sync(task: TaskDefinition): Promise<unknown>;
}

const silent: ProcessorLogger = { info() {}, warn() {}, error() {} };

export class EventTriggerConsumer {
  private worker: Worker<EventEnvelope> | undefined;
  private readonly logger: ProcessorLogger;

  constructor(
    private readonly db: Db,
    private readonly runQueue: RunQueue,
    private readonly scheduler: TriggerSync,
    private readonly opts: EventTriggerConsumerOptions,
  ) {
    this.logger = opts.logger ?? silent;
  }

  /** Fires every registered task the event matches. Idempotent per (task, event). */
  async handleEvent(raw: unknown): Promise<EventTriggerOutcome[]> {
    const parsed = EventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues.slice(0, 3) }, 'invalid event envelope; ignored');
      return [];
    }
    const envelope = parsed.data;
    const registry = this.scheduler.triggers;
    if (!registry) return [];
    const candidates = (await registry.list()).filter((t) => t.tenant_id === envelope.tenantId && t.event_type === envelope.type);
    const outcomes: EventTriggerOutcome[] = [];
    for (const candidate of candidates) outcomes.push(await this.fire(candidate, envelope, registry));
    return outcomes;
  }

  private async fire(candidate: RegisteredTrigger, envelope: EventEnvelope, registry: EventTriggerRegistry): Promise<EventTriggerOutcome> {
    const taskId = candidate.task_id;
    const task = await this.db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, candidate.tenant_id), eq(taskDefinitions.id, taskId)),
    });
    if (!task) {
      await registry.remove(taskId);
      return { taskId, outcome: 'task_missing' };
    }
    const trigger = desiredEventTrigger(task);
    if (!trigger || trigger.eventType !== envelope.type) {
      // Paused, archived, disabled or no longer EVENT for this type: drop the stale registration.
      await this.scheduler.sync(task);
      return { taskId, outcome: 'skipped_inactive' };
    }
    const decision = evaluateTrigger(task, trigger, envelope, this.opts.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH);
    if (!decision.fire) {
      if (decision.reason === 'chain_depth_exceeded' || decision.reason === 'self_event') {
        this.logger.warn({ taskId, eventId: envelope.id, type: envelope.type, reason: decision.reason }, 'event trigger blocked by loop guard');
      }
      return { taskId, outcome: decision.reason };
    }
    const agent = await this.db.query.agents.findFirst({ where: eq(agents.id, task.agentId) });
    if (!agent || agent.status !== 'ACTIVE' || !agent.activeVersionId) {
      this.logger.warn({ taskId, eventId: envelope.id }, 'event trigger skipped: agent not ACTIVE or without active version');
      return { taskId, outcome: 'skipped_agent_inactive' };
    }
    try {
      const result = await requestTaskRun(
        this.db,
        this.runQueue,
        task,
        { idempotencyKey: eventTaskRunIdempotencyKey(task.id, envelope.id), input: eventTriggeredInput(envelope), trigger: 'EVENT' },
        { ...(this.opts.events ? { events: this.opts.events } : {}), producer: 'scheduler' },
      );
      return { taskId, outcome: result.deduplicated ? 'deduplicated' : 'created', taskRunId: result.taskRun.id };
    } catch (err) {
      // The TaskRun is persisted QUEUED; the orphan reconciler enqueues it.
      if (err instanceof QueueUnavailableError) return { taskId, outcome: 'created_unqueued', taskRunId: err.taskRun.id };
      throw err;
    }
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<EventEnvelope>(
      this.opts.queueName,
      async (job) => {
        const outcomes = await this.handleEvent(job.data);
        const fired = outcomes.filter((o) => o.outcome === 'created');
        if (fired.length > 0) this.logger.info({ eventId: job.data.id, type: job.data.type, fired }, 'event triggers fired');
        return outcomes;
      },
      {
        connection: { ...redisConnectionFromUrl(this.opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions,
        concurrency: this.opts.concurrency ?? 4,
      },
    );
    this.worker.on('failed', (job, err) => this.logger.warn({ eventId: job?.id, err: err.message }, 'event consumer job failed'));
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'event consumer error'));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
