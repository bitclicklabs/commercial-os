/**
 * Outbound webhooks: every event of the bus that matches an active `event_subscriptions`
 * row is POSTed (full envelope, signed) to its `target_url`. Runs with the scheduler role.
 *
 *   events queue ──> EventTriggerConsumer ──(observer)──> WebhookDispatcher.onEvent
 *                                                          │ one job per (subscription, event)
 *                                                          v
 *                         {QUEUE_NAME}-webhooks ──> WebhookDeliveryWorker ──POST──> n8n, ...
 *
 * - Fan-out: job id `{subscriptionId}_{eventId}`, so an event delivered twice to the
 *   dispatcher while the job exists is enqueued once.
 * - Retries: 3 attempts with exponential backoff (BullMQ). Network errors, timeouts, 5xx,
 *   408 and 429 are retried; any other status (4xx, 3xx: redirects are never followed) and
 *   SSRF refusals fail at once.
 * - Bookkeeping per subscription: `last_delivery_at` on success (and `consecutive_failures`
 *   back to 0); `last_error` / `last_error_at` on every failed attempt;
 *   `consecutive_failures + 1` when a delivery is given up.
 * - The subscription is re-read before every attempt: disabled, type no longer matching or
 *   URL now refused = the job ends without sending.
 *
 * Receivers must tolerate duplicates (at-least-once): dedupe on `X-Pxos-Event-Id`.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { eventSubscriptions, type EventSubscription } from '../db/schema.js';
import { redisConnectionFromUrl } from '../queue/run-queue.js';
import { EventEnvelopeSchema, type EventEnvelope } from './envelope.js';
import type { EventBusLogger } from './event-bus.js';
import {
  DELIVERY_ATTEMPT_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  matchesSubscription,
  signEventBody,
  SIGNATURE_HEADER,
  SUBSCRIPTION_ID_HEADER,
  TIMESTAMP_HEADER,
} from './subscriptions.js';
import { checkWebhookTarget, type LookupAll, type PrivateAllowEntry, type ResolvedAddress } from './webhook-target.js';

const silent: EventBusLogger = { info() {}, warn() {}, error() {} };

export const WEBHOOK_DELIVERY_ATTEMPTS = 3;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_BACKOFF_MS = 5_000;
const MAX_ERROR_LENGTH = 500;
const MAX_RESPONSE_SNIPPET = 200;

export function webhooksQueueName(runQueueName: string): string {
  return `${runQueueName}-webhooks`;
}

export function deliveryJobId(subscriptionId: string, eventId: string): string {
  // BullMQ custom ids cannot contain ':'.
  return `${subscriptionId}_${eventId}`;
}

// ---------------------------------------------------------------------------
// Transport (node:http pinned to the checked address)
// ---------------------------------------------------------------------------
export interface WebhookRequest {
  url: URL;
  /** Address the socket must connect to (already checked by the SSRF guard). */
  address: ResolvedAddress | null;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookResponse {
  status: number;
  /** First bytes of the response body (untrusted; only for `last_error`). */
  snippet: string;
}

export type WebhookTransport = (req: WebhookRequest) => Promise<WebhookResponse>;

export const nodeWebhookTransport: WebhookTransport = (req) =>
  new Promise<WebhookResponse>((resolve, reject) => {
    const pinned: LookupFunction | undefined = req.address
      ? (_hostname, options, callback) => {
          const cb = callback as unknown as (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
          if ((options as { all?: boolean }).all) cb(null, [{ address: req.address!.address, family: req.address!.family }]);
          else cb(null, req.address!.address, req.address!.family);
        }
      : undefined;
    const lib = req.url.protocol === 'https:' ? https : http;
    const request = lib.request(
      req.url,
      {
        method: 'POST',
        headers: { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) },
        ...(pinned ? { lookup: pinned } : {}),
        agent: false,
        signal: AbortSignal.timeout(req.timeoutMs),
        ...(req.url.protocol === 'https:' && !isIP(req.url.hostname) ? { servername: req.url.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size < MAX_RESPONSE_SNIPPET) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, snippet: Buffer.concat(chunks).subarray(0, MAX_RESPONSE_SNIPPET).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(req.body);
  });

// ---------------------------------------------------------------------------
// One delivery attempt
// ---------------------------------------------------------------------------
export type DeliveryResult =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; error: string; status?: number };

export interface DeliverOptions {
  allowPrivate: readonly PrivateAllowEntry[];
  transport?: WebhookTransport;
  lookup?: LookupAll;
  timeoutMs?: number;
  attempt?: number;
  now?: () => number;
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function clip(s: string, n = MAX_ERROR_LENGTH): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

/** Signed headers + body of a delivery (exported for tests and the docs). */
export function buildDelivery(
  subscription: Pick<EventSubscription, 'id' | 'secret'>,
  envelope: EventEnvelope,
  opts: { timestamp: string; attempt: number },
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(envelope);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'pxos-agent-runtime/0.1 (+event-subscriptions)',
      [TIMESTAMP_HEADER]: opts.timestamp,
      [SIGNATURE_HEADER]: signEventBody(subscription.secret, opts.timestamp, body),
      [EVENT_ID_HEADER]: envelope.id,
      [EVENT_TYPE_HEADER]: envelope.type,
      [SUBSCRIPTION_ID_HEADER]: subscription.id,
      [DELIVERY_ATTEMPT_HEADER]: String(opts.attempt),
    },
  };
}

export async function deliverOnce(
  subscription: Pick<EventSubscription, 'id' | 'secret' | 'targetUrl'>,
  envelope: EventEnvelope,
  opts: DeliverOptions,
): Promise<DeliveryResult> {
  const target = await checkWebhookTarget(subscription.targetUrl, { allowPrivate: opts.allowPrivate, ...(opts.lookup ? { lookup: opts.lookup } : {}) });
  if (!target.ok) return { ok: false, retryable: false, error: clip(`target refused: ${target.reason}`) };
  const timestamp = String((opts.now ?? Date.now)());
  const { body, headers } = buildDelivery(subscription, envelope, { timestamp, attempt: opts.attempt ?? 1 });
  try {
    const res = await (opts.transport ?? nodeWebhookTransport)({
      url: target.url,
      address: target.addresses[0] ?? null,
      headers,
      body,
      timeoutMs: opts.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    const redirect = res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : '';
    return {
      ok: false,
      retryable: isRetryableStatus(res.status),
      status: res.status,
      error: clip(`HTTP ${res.status}${redirect}${res.snippet ? `: ${res.snippet}` : ''}`),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : (e.code ?? e.message);
    return { ok: false, retryable: true, error: clip(`network error: ${reason}`) };
  }
}

// ---------------------------------------------------------------------------
// Delivery queue
// ---------------------------------------------------------------------------
export interface WebhookDeliveryJob {
  subscriptionId: string;
  tenantId: string;
  envelope: EventEnvelope;
}

export interface WebhookDeliveryQueue {
  add(job: WebhookDeliveryJob): Promise<void>;
  close(): Promise<void>;
}

export class BullWebhookDeliveryQueue implements WebhookDeliveryQueue {
  readonly queue: Queue<WebhookDeliveryJob>;

  constructor(
    readonly name: string,
    redisUrl: string,
    opts: { backoffMs?: number } = {},
  ) {
    this.queue = new Queue<WebhookDeliveryJob>(name, {
      connection: redisConnectionFromUrl(redisUrl) as ConnectionOptions,
      defaultJobOptions: {
        attempts: WEBHOOK_DELIVERY_ATTEMPTS,
        backoff: { type: 'exponential', delay: opts.backoffMs ?? DEFAULT_WEBHOOK_BACKOFF_MS },
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    this.queue.on('error', () => {
      /* surfaced on add */
    });
  }

  async add(job: WebhookDeliveryJob): Promise<void> {
    await this.queue.add(job.envelope.type, job, { jobId: deliveryJobId(job.subscriptionId, job.envelope.id) });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** In-memory queue for tests. */
export class MemoryWebhookDeliveryQueue implements WebhookDeliveryQueue {
  readonly jobs = new Map<string, WebhookDeliveryJob>();

  async add(job: WebhookDeliveryJob): Promise<void> {
    const id = deliveryJobId(job.subscriptionId, job.envelope.id);
    if (!this.jobs.has(id)) this.jobs.set(id, job);
  }

  drain(): WebhookDeliveryJob[] {
    const all = [...this.jobs.values()];
    this.jobs.clear();
    return all;
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Dispatcher (observer of the events consumer)
// ---------------------------------------------------------------------------
/** What EventTriggerConsumer calls for every event after its triggers. */
export interface EventObserver {
  readonly name: string;
  onEvent(envelope: EventEnvelope): Promise<unknown>;
}

export class WebhookDispatcher implements EventObserver {
  readonly name = 'webhooks';
  private readonly logger: EventBusLogger;

  constructor(
    private readonly db: Db,
    private readonly queue: WebhookDeliveryQueue,
    opts: { logger?: EventBusLogger } = {},
  ) {
    this.logger = opts.logger ?? silent;
  }

  /** Enqueues one delivery per active subscription of the tenant whose patterns match. */
  async onEvent(raw: unknown): Promise<{ matched: string[] }> {
    const parsed = EventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return { matched: [] };
    const envelope = parsed.data;
    const subs = await this.db
      .select({ id: eventSubscriptions.id, eventTypes: eventSubscriptions.eventTypes })
      .from(eventSubscriptions)
      .where(and(eq(eventSubscriptions.tenantId, envelope.tenantId), eq(eventSubscriptions.enabled, true)));
    const matched = subs.filter((s) => matchesSubscription(envelope.type, s.eventTypes)).map((s) => s.id);
    // A failed add throws: the events job is retried (triggers and this fan-out are idempotent).
    for (const subscriptionId of matched) await this.queue.add({ subscriptionId, tenantId: envelope.tenantId, envelope });
    if (matched.length > 0) this.logger.info({ eventId: envelope.id, type: envelope.type, subscriptions: matched.length }, 'event webhooks enqueued');
    return { matched };
  }
}

// ---------------------------------------------------------------------------
// Delivery worker
// ---------------------------------------------------------------------------
export type DeliveryOutcome =
  | { outcome: 'delivered'; status: number }
  | { outcome: 'skipped'; reason: 'subscription_missing' | 'subscription_disabled' | 'type_not_subscribed' }
  | { outcome: 'failed'; retryable: boolean; final: boolean; error: string };

export interface WebhookDeliveryWorkerOptions {
  queueName: string;
  redisUrl: string;
  allowPrivate: readonly PrivateAllowEntry[];
  concurrency?: number;
  timeoutMs?: number;
  transport?: WebhookTransport;
  lookup?: LookupAll;
  logger?: EventBusLogger;
}

export class WebhookDeliveryWorker {
  private worker: Worker<WebhookDeliveryJob> | undefined;
  private readonly logger: EventBusLogger;

  constructor(
    private readonly db: Db,
    private readonly opts: WebhookDeliveryWorkerOptions,
  ) {
    this.logger = opts.logger ?? silent;
  }

  /** One attempt of one job (no BullMQ needed: unit and integration tests call it). */
  async process(job: WebhookDeliveryJob, attempt: number, maxAttempts = WEBHOOK_DELIVERY_ATTEMPTS): Promise<DeliveryOutcome> {
    const sub = await this.db.query.eventSubscriptions.findFirst({
      where: and(eq(eventSubscriptions.tenantId, job.tenantId), eq(eventSubscriptions.id, job.subscriptionId)),
    });
    if (!sub) return { outcome: 'skipped', reason: 'subscription_missing' };
    if (!sub.enabled) return { outcome: 'skipped', reason: 'subscription_disabled' };
    if (!matchesSubscription(job.envelope.type, sub.eventTypes)) return { outcome: 'skipped', reason: 'type_not_subscribed' };

    const result = await deliverOnce(sub, job.envelope, {
      allowPrivate: this.opts.allowPrivate,
      attempt,
      ...(this.opts.transport ? { transport: this.opts.transport } : {}),
      ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
    });
    const now = new Date();
    if (result.ok) {
      await this.db
        .update(eventSubscriptions)
        .set({ lastDeliveryAt: now, consecutiveFailures: 0, updatedAt: now })
        .where(eq(eventSubscriptions.id, sub.id));
      return { outcome: 'delivered', status: result.status };
    }
    const final = !result.retryable || attempt >= maxAttempts;
    await this.db
      .update(eventSubscriptions)
      .set({
        lastError: `[${now.toISOString()}] attempt ${attempt}/${maxAttempts} event ${job.envelope.id} (${job.envelope.type}): ${result.error}`.slice(0, 1000),
        lastErrorAt: now,
        ...(final ? { consecutiveFailures: sql`${eventSubscriptions.consecutiveFailures} + 1` } : {}),
        updatedAt: now,
      })
      .where(eq(eventSubscriptions.id, sub.id));
    return { outcome: 'failed', retryable: result.retryable, final, error: result.error };
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<WebhookDeliveryJob>(
      this.opts.queueName,
      async (job) => {
        const maxAttempts = job.opts.attempts ?? WEBHOOK_DELIVERY_ATTEMPTS;
        const attempt = job.attemptsMade + 1;
        const outcome = await this.process(job.data, attempt, maxAttempts);
        if (outcome.outcome === 'failed') {
          const ctx = { subscriptionId: job.data.subscriptionId, eventId: job.data.envelope.id, attempt, error: outcome.error };
          if (outcome.final) this.logger.warn(ctx, 'event webhook delivery given up');
          else this.logger.info(ctx, 'event webhook delivery failed; will retry');
          if (!outcome.retryable) throw new UnrecoverableError(outcome.error);
          throw new Error(outcome.error);
        }
        return outcome;
      },
      {
        connection: { ...redisConnectionFromUrl(this.opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions,
        concurrency: this.opts.concurrency ?? 4,
      },
    );
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'event webhook worker error'));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
