import { DelayedError, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { redisConnectionFromUrl, type RunJob } from '../queue/run-queue.js';
import { ConcurrencyLimitError, RetryableRunError, TwentyUnavailableError, type ProcessorLogger, type RunProcessor } from './processor.js';
import type { TwentyWaitState } from './twenty-gate.js';

/** Job data plus the Twenty wait window, persisted across TwentyUnavailableError deferrals. */
type GatedRunJob = RunJob & { twentyWait?: TwentyWaitState };

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

async function clearTwentyWait(job: Job<RunJob>, logger: ProcessorLogger): Promise<void> {
  try {
    const { twentyWait: _drop, ...rest } = job.data as GatedRunJob;
    await job.updateData(rest as RunJob);
  } catch (err) {
    logger.warn({ jobId: job.id, err: err instanceof Error ? err.message : String(err) }, 'could not clear twentyWait from job data');
  }
}

export function startBullWorker(processor: RunProcessor, opts: BullWorkerOptions): Worker<RunJob> {
  const deferMs = opts.concurrencyDeferMs ?? DEFAULT_CONCURRENCY_DEFER_MS;
  const worker = new Worker<RunJob>(
    opts.queueName,
    async (job, token) => {
      const maxAttempts = job.opts.attempts ?? 1;
      const { twentyWait } = job.data as GatedRunJob;
      try {
        await processor.process(job.data, { attempt: job.attemptsMade + 1, maxAttempts, twentyWait });
      } catch (err) {
        if (err instanceof TwentyUnavailableError) {
          // Twenty still booting: keep the run QUEUED, remember the wait window in the job
          // data and park the job without consuming an attempt (same as max_concurrency).
          await job.updateData({ ...job.data, twentyWait: err.state } as GatedRunJob);
          await job.moveToDelayed(Date.now() + err.delayMs, token);
          throw new DelayedError();
        }
        // The gate let the run through: a later deferral (retry) opens a fresh wait window.
        if (twentyWait) await clearTwentyWait(job, opts.logger);
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
