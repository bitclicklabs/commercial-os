import { DelayedError, UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { redisConnectionFromUrl, type RunJob } from '../queue/run-queue.js';
import { ConcurrencyLimitError, RetryableRunError, type ProcessorLogger, type RunProcessor } from './processor.js';

export interface BullWorkerOptions {
  queueName: string;
  redisUrl: string;
  concurrency: number;
  logger: ProcessorLogger;
  /** Delay before a job deferred by max_concurrency is tried again. */
  concurrencyDeferMs?: number;
  /** BullMQ lock on an active job; a worker that stops renewing it is considered stalled. */
  lockDurationMs?: number;
  /** How often this worker looks for stalled jobs of dead workers. */
  stalledIntervalMs?: number;
  /** Times a job may stall before BullMQ fails it (the reconciler then closes the run). */
  maxStalledCount?: number;
}

export const DEFAULT_CONCURRENCY_DEFER_MS = 2_000;

export function startBullWorker(processor: RunProcessor, opts: BullWorkerOptions): Worker<RunJob> {
  const deferMs = opts.concurrencyDeferMs ?? DEFAULT_CONCURRENCY_DEFER_MS;
  const worker = new Worker<RunJob>(
    opts.queueName,
    async (job, token) => {
      const maxAttempts = job.opts.attempts ?? 1;
      try {
        await processor.process(job.data, { attempt: job.attemptsMade + 1, maxAttempts });
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          // No slot: keep the run QUEUED and park the job without consuming an attempt.
          // Small jitter so deferred jobs of the same task do not wake up in lockstep.
          const delay = deferMs + Math.floor(Math.random() * Math.min(500, deferMs));
          await job.moveToDelayed(Date.now() + delay, token);
          throw new DelayedError();
        }
        if (err instanceof RetryableRunError) throw err;
        // Infrastructure errors (DB down, bug): no blind retries that could duplicate work.
        throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
      }
    },
    {
      connection: { ...redisConnectionFromUrl(opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions,
      concurrency: opts.concurrency,
      ...(opts.lockDurationMs ? { lockDuration: opts.lockDurationMs } : {}),
      ...(opts.stalledIntervalMs ? { stalledInterval: opts.stalledIntervalMs } : {}),
      ...(opts.maxStalledCount !== undefined ? { maxStalledCount: opts.maxStalledCount } : {}),
    },
  );
  worker.on('failed', (job, err) => opts.logger.warn({ jobId: job?.id, err: err.message }, 'job failed'));
  worker.on('completed', (job) => opts.logger.info({ jobId: job.id }, 'job completed'));
  worker.on('stalled', (jobId) => opts.logger.warn({ jobId }, 'job stalled; moved back to wait'));
  worker.on('error', (err) => opts.logger.error({ err: err.message }, 'worker error'));
  return worker;
}
