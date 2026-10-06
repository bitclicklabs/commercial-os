import { Queue, type ConnectionOptions } from 'bullmq';
import { toQueueJobId } from '../domain/idempotency.js';

export type RunJob =
  | { kind: 'task_run'; tenantId: string; taskRunId: string; idempotencyKey: string }
  | { kind: 'execution'; tenantId: string; executionId: string; idempotencyKey: string };

export interface EnqueueOptions {
  attempts?: number;
  backoffMs?: number;
  priority?: number;
}

export interface EnqueueResult {
  jobId: string;
  /** False when a job with the same idempotency key already existed in the queue. */
  created: boolean;
}

/** BullMQ job states plus `null` when the job does not exist (anymore). */
export type QueueJobState =
  | 'waiting'
  | 'active'
  | 'delayed'
  | 'prioritized'
  | 'waiting-children'
  | 'completed'
  | 'failed'
  | 'unknown';

/** States in which the queue still owns the job and will (re)deliver it. */
export const LIVE_JOB_STATES: readonly QueueJobState[] = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'];

export interface RunQueue {
  enqueue(job: RunJob, options?: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Like `enqueue`, but first removes a finished (completed/failed) job holding the same
   * idempotency key, so a recovered run gets a fresh job under the same id.
   */
  requeue(job: RunJob, options?: EnqueueOptions): Promise<EnqueueResult>;
  /** State of the job for `idempotencyKey`, or null when it does not exist. */
  getJobState(idempotencyKey: string): Promise<QueueJobState | null>;
  close(): Promise<void>;
}

/** Parses a redis:// URL into ioredis options understood by BullMQ. */
export function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db: Number.isFinite(db) ? db : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export class BullRunQueue implements RunQueue {
  private readonly queue: Queue;

  constructor(queueName: string, redisUrl: string) {
    this.queue = new Queue(queueName, {
      // Fail fast instead of buffering when Redis is down; the API answers 503.
      connection: { ...redisConnectionFromUrl(redisUrl), enableOfflineQueue: false } as ConnectionOptions,
      defaultJobOptions: { removeOnComplete: { age: 24 * 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600 } },
    });
    this.queue.on('error', () => {
      /* connection errors surface on enqueue; avoid unhandled 'error' events */
    });
  }

  async enqueue(job: RunJob, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const jobId = toQueueJobId(job.idempotencyKey);
    const existing = await this.queue.getJob(jobId);
    if (existing) return { jobId, created: false };
    await this.queue.add(job.kind, job, {
      jobId,
      attempts: Math.max(1, options.attempts ?? 1),
      ...(options.backoffMs ? { backoff: { type: 'exponential', delay: options.backoffMs } } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    });
    return { jobId, created: true };
  }

  async requeue(job: RunJob, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const existing = await this.queue.getJob(toQueueJobId(job.idempotencyKey));
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed' && state !== 'unknown') {
        return { jobId: toQueueJobId(job.idempotencyKey), created: false };
      }
      await existing.remove();
    }
    return this.enqueue(job, options);
  }

  async getJobState(idempotencyKey: string): Promise<QueueJobState | null> {
    const job = await this.queue.getJob(toQueueJobId(idempotencyKey));
    if (!job) return null;
    return (await job.getState()) as QueueJobState;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** In-process queue used by tests (and handy for local experiments without Redis). */
export class MemoryRunQueue implements RunQueue {
  readonly jobs = new Map<string, { job: RunJob; options: EnqueueOptions }>();

  async enqueue(job: RunJob, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const jobId = toQueueJobId(job.idempotencyKey);
    if (this.jobs.has(jobId)) return { jobId, created: false };
    this.jobs.set(jobId, { job, options });
    return { jobId, created: true };
  }

  async requeue(job: RunJob, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    return this.enqueue(job, options);
  }

  async getJobState(idempotencyKey: string): Promise<QueueJobState | null> {
    return this.jobs.has(toQueueJobId(idempotencyKey)) ? 'waiting' : null;
  }

  /** Removes and returns all pending jobs. */
  drain(): Array<{ job: RunJob; options: EnqueueOptions }> {
    const all = [...this.jobs.values()];
    this.jobs.clear();
    return all;
  }

  async close(): Promise<void> {}
}
