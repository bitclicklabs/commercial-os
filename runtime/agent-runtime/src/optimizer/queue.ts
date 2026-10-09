/**
 * Queue of the Skill Optimizer: `POST /optimizer/skills/:name/run` creates a PENDING run and
 * enqueues `{ tenantId, runId }` in `{QUEUE_NAME}-optimizer`; the worker role processes it with
 * `runOptimization` (src/optimizer/pipeline.ts).
 *
 * - One attempt, no retries: an experiment spends money and burns cases (P5); a failed run
 *   ends in ERROR and a human launches a new one.
 * - Job id = run id: enqueuing the same run twice is a no-op, and a redelivered job finds the
 *   run no longer PENDING and does nothing.
 * - Concurrency 1 per worker process (experiments are sequential by design).
 * - On start, open runs without progress for `staleAfterMs` (a worker that died) go to ERROR.
 *
 * Manual, or scheduled by the scheduler role when OPTIMIZER_SCHEDULE_ENABLED=true
 * (src/optimizer/schedule-job.ts): both go through src/optimizer/launch.ts.
 */
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Db } from '../db/client.js';
import { redisConnectionFromUrl } from '../queue/run-queue.js';
import type { ProcessorLogger } from '../worker/processor.js';
import { runOptimization, type OptimizerDeps } from './pipeline.js';
import { failStaleRuns, transitionRun } from './service.js';

export interface OptimizerJob {
  tenantId: string;
  runId: string;
}

export interface OptimizerQueue {
  enqueue(job: OptimizerJob): Promise<{ jobId: string; created: boolean }>;
  close(): Promise<void>;
}

export function optimizerQueueName(runQueueName: string): string {
  return `${runQueueName}-optimizer`;
}

export class BullOptimizerQueue implements OptimizerQueue {
  readonly queue: Queue<OptimizerJob>;

  constructor(
    readonly name: string,
    redisUrl: string,
  ) {
    this.queue = new Queue<OptimizerJob>(name, {
      connection: { ...redisConnectionFromUrl(redisUrl), enableOfflineQueue: false } as ConnectionOptions,
      defaultJobOptions: { attempts: 1, removeOnComplete: { age: 7 * 24 * 3600, count: 500 }, removeOnFail: { age: 30 * 24 * 3600 } },
    });
    this.queue.on('error', () => {
      /* surfaced on add */
    });
  }

  async enqueue(job: OptimizerJob): Promise<{ jobId: string; created: boolean }> {
    const existing = await this.queue.getJob(job.runId);
    if (existing) return { jobId: job.runId, created: false };
    await this.queue.add('optimization_run', job, { jobId: job.runId });
    return { jobId: job.runId, created: true };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** In-memory queue for tests. */
export class MemoryOptimizerQueue implements OptimizerQueue {
  readonly jobs = new Map<string, OptimizerJob>();
  failNext = false;

  async enqueue(job: OptimizerJob): Promise<{ jobId: string; created: boolean }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('queue unavailable (simulated)');
    }
    if (this.jobs.has(job.runId)) return { jobId: job.runId, created: false };
    this.jobs.set(job.runId, job);
    return { jobId: job.runId, created: true };
  }

  drain(): OptimizerJob[] {
    const all = [...this.jobs.values()];
    this.jobs.clear();
    return all;
  }

  async close(): Promise<void> {}
}

export const DEFAULT_STALE_AFTER_MS = 6 * 3600 * 1000;

export interface OptimizerWorkerOptions {
  queueName: string;
  redisUrl: string;
  logger: ProcessorLogger;
  /** Builds the dependencies of one run (providers, Twenty client...). */
  deps: () => OptimizerDeps;
  staleAfterMs?: number;
}

export class OptimizerWorker {
  private worker: Worker<OptimizerJob> | undefined;

  constructor(
    private readonly db: Db,
    private readonly opts: OptimizerWorkerOptions,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    try {
      const stale = await failStaleRuns(this.db, this.opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
      if (stale.length > 0) this.opts.logger.warn({ runs: stale }, 'optimizer: stale runs closed as ERROR');
    } catch (err) {
      // Before migration 0013 the table does not exist: the worker still starts.
      this.opts.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'optimizer: could not check stale runs');
    }
    this.worker = new Worker<OptimizerJob>(
      this.opts.queueName,
      async (job) => {
        let deps: OptimizerDeps;
        try {
          deps = this.opts.deps();
        } catch (err) {
          // Never leave a run PENDING (it would block the skill until the stale check).
          await transitionRun(this.db, job.data.runId, 'ERROR', { error: `el worker no pudo preparar el run: ${err instanceof Error ? err.message : String(err)}` }, 'PENDING').catch(() => undefined);
          throw err;
        }
        const run = await runOptimization({ ...deps, onProgress: (msg) => this.opts.logger.info({ runId: job.data.runId }, msg) }, job.data.tenantId, job.data.runId);
        return { status: run.status };
      },
      { connection: { ...redisConnectionFromUrl(this.opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => this.opts.logger.warn({ jobId: job?.id, err: err.message }, 'optimizer job failed'));
    this.worker.on('error', (err) => this.opts.logger.error({ err: err.message }, 'optimizer worker error'));
  }

  async close(): Promise<void> {
    await this.worker?.close();
  }
}
