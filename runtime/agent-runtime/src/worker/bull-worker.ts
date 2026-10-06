import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import { redisConnectionFromUrl, type RunJob } from '../queue/run-queue.js';
import { RetryableRunError, type ProcessorLogger, type RunProcessor } from './processor.js';

export interface BullWorkerOptions {
  queueName: string;
  redisUrl: string;
  concurrency: number;
  logger: ProcessorLogger;
}

export function startBullWorker(processor: RunProcessor, opts: BullWorkerOptions): Worker<RunJob> {
  const worker = new Worker<RunJob>(
    opts.queueName,
    async (job) => {
      const maxAttempts = job.opts.attempts ?? 1;
      try {
        await processor.process(job.data, { attempt: job.attemptsMade + 1, maxAttempts });
      } catch (err) {
        if (err instanceof RetryableRunError) throw err;
        // Infrastructure errors (DB down, bug): no blind retries that could duplicate work.
        throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
      }
    },
    {
      connection: { ...redisConnectionFromUrl(opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions,
      concurrency: opts.concurrency,
    },
  );
  worker.on('failed', (job, err) => opts.logger.warn({ jobId: job?.id, err: err.message }, 'job failed'));
  worker.on('completed', (job) => opts.logger.info({ jobId: job.id }, 'job completed'));
  worker.on('error', (err) => opts.logger.error({ err: err.message }, 'worker error'));
  return worker;
}
