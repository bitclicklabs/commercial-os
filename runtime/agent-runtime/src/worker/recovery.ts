/**
 * Orphan recovery: reconciles TaskRuns in PostgreSQL with their BullMQ jobs.
 *
 * A TaskRun is an orphan when the queue no longer owns a job that will move it forward:
 *
 *   status   job state                          action
 *   QUEUED   missing | completed | failed       enqueue  (fresh job, same idempotency key)
 *   RUNNING  missing | completed | failed       requeue  (RUNNING -> QUEUED + fresh job)
 *                                                or fail (RUNNING -> FAILED) once attempts >= max_attempts
 *   any      waiting | delayed | active | ...   none     (BullMQ still owns it)
 *
 * An `active` job whose worker died is BullMQ's job: its stalled checker moves it back to
 * `wait` (or fails it after `maxStalledCount`). When the processor then receives a job whose
 * run is still RUNNING it knows the previous attempt died and applies the same
 * `recoverOrphanRun` transition before continuing (see RunProcessor).
 *
 * Every transition is a guarded UPDATE (`WHERE status = 'RUNNING'`), so the reconciler never
 * overrides a worker that finished in the meantime and never leaves the state machine.
 *
 * Liveness: the job state is only known for the reconciler's own queue (a run processed
 * in-process by a test or script on the same database, or a job BullMQ failed after a stall
 * while its worker kept going, looks "missing"). So the processor heartbeats
 * `task_runs.updated_at` while an attempt runs (RunProcessor.heartbeatMs, < graceMs), and the
 * reconciler's UPDATE re-checks what it decided on: same attempt and still older than the
 * cutoff. A heartbeat, a retry or a finish landing between its SELECT and its UPDATE wins.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentExecutions, taskDefinitions, taskRuns, type TaskRun } from '../db/schema.js';
import { allowedSources, isTerminal } from '../domain/run-state.js';
import type { RunStatus } from '../domain/statuses.js';
import { LIVE_JOB_STATES, type QueueJobState, type RunQueue } from '../queue/run-queue.js';
import type { ProcessorLogger } from './processor.js';

export type RecoveryAction = 'none' | 'enqueue' | 'requeue' | 'fail';

export interface RecoveryInput {
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  jobState: QueueJobState | null;
  /** Time since the run row was last updated. */
  ageMs: number;
  /** Runs younger than this are left alone (an API call or worker may be mid-flight). */
  graceMs: number;
}

/** Pure decision used by the reconciler (unit tested). */
export function decideRecovery(input: RecoveryInput): RecoveryAction {
  if (isTerminal(input.status)) return 'none';
  if (input.ageMs < input.graceMs) return 'none';
  if (input.jobState && LIVE_JOB_STATES.includes(input.jobState)) return 'none';
  if (input.status === 'QUEUED') return 'enqueue';
  if (input.status === 'RUNNING') return input.attempts >= input.maxAttempts ? 'fail' : 'requeue';
  return 'none';
}

export type RecoveryOutcome = 'requeued' | 'failed' | 'noop';

export interface RecoveryGuard {
  /** Only recover if the run was not touched since this instant (no heartbeat, no new attempt). */
  staleBefore?: Date;
}

/**
 * RUNNING -> QUEUED (attempts left) or RUNNING -> FAILED (attempts exhausted), plus
 * RUNNING -> FAILED on the dangling AgentExecution of the dead attempt. Guarded: returns
 * 'noop' if the run is no longer RUNNING, is on another attempt than the one read, or (with
 * `guard.staleBefore`) was updated after the cutoff.
 */
export async function recoverOrphanRun(
  db: Db,
  run: Pick<TaskRun, 'id' | 'attempts' | 'executionId'>,
  maxAttempts: number,
  reason: string,
  guard: RecoveryGuard = {},
): Promise<RecoveryOutcome> {
  const exhausted = run.attempts >= maxAttempts;
  const to: RunStatus = exhausted ? 'FAILED' : 'QUEUED';
  const error = { name: 'OrphanedRun', message: reason, attempts: run.attempts, max_attempts: maxAttempts };
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(taskRuns)
      .set({
        status: to,
        error,
        ...(exhausted ? { finishedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskRuns.id, run.id),
          eq(taskRuns.status, 'RUNNING'),
          inArray(taskRuns.status, allowedSources(to)),
          eq(taskRuns.attempts, run.attempts),
          guard.staleBefore ? lt(taskRuns.updatedAt, guard.staleBefore) : undefined,
        ),
      )
      .returning({ id: taskRuns.id });
    if (!updated) return 'noop';
    if (run.executionId) {
      await tx
        .update(agentExecutions)
        .set({ status: 'FAILED', error, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentExecutions.id, run.executionId), inArray(agentExecutions.status, allowedSources('FAILED'))));
    }
    return exhausted ? 'failed' : 'requeued';
  });
}

export interface ReconcilerOptions {
  graceMs: number;
  batchSize?: number;
  /** Restrict to one tenant (tests); production reconciles every tenant. */
  tenantId?: string;
  logger?: ProcessorLogger;
}

export interface ReconcileSummary {
  scanned: number;
  enqueued: number;
  requeued: number;
  failed: number;
}

export class OrphanReconciler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly queue: RunQueue,
    private readonly opts: ReconcilerOptions,
  ) {}

  async runOnce(now: Date = new Date()): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { scanned: 0, enqueued: 0, requeued: 0, failed: 0 };
    const cutoff = new Date(now.getTime() - this.opts.graceMs);
    const rows = await this.db
      .select({
        run: taskRuns,
        maxAttempts: sql<number>`coalesce((${taskDefinitions.retryPolicy}->>'max_attempts')::int, 1)`,
        backoffMs: sql<number>`coalesce((${taskDefinitions.retryPolicy}->>'backoff_ms')::int, 0)`,
        priority: taskDefinitions.priority,
      })
      .from(taskRuns)
      .innerJoin(taskDefinitions, eq(taskDefinitions.id, taskRuns.taskDefinitionId))
      .where(
        and(
          inArray(taskRuns.status, ['QUEUED', 'RUNNING']),
          lt(taskRuns.updatedAt, cutoff),
          this.opts.tenantId ? eq(taskRuns.tenantId, this.opts.tenantId) : undefined,
        ),
      )
      .orderBy(taskRuns.updatedAt)
      .limit(this.opts.batchSize ?? 500);

    for (const { run, maxAttempts, backoffMs, priority } of rows) {
      summary.scanned++;
      const jobState = await this.queue.getJobState(run.idempotencyKey);
      const action = decideRecovery({
        status: run.status,
        attempts: run.attempts,
        maxAttempts,
        jobState,
        ageMs: now.getTime() - run.updatedAt.getTime(),
        graceMs: this.opts.graceMs,
      });
      if (action === 'none') continue;
      const job = { kind: 'task_run' as const, tenantId: run.tenantId, taskRunId: run.id, idempotencyKey: run.idempotencyKey };
      const enqueueOpts = { attempts: maxAttempts, backoffMs, priority };

      if (action === 'enqueue') {
        await this.queue.requeue(job, enqueueOpts);
        summary.enqueued++;
        this.opts.logger?.warn({ taskRunId: run.id, jobState }, 'queued run without live job; re-enqueued');
        continue;
      }
      // Guarded by the same cutoff as the SELECT: a heartbeat since then means it is alive.
      const outcome = await recoverOrphanRun(this.db, run, maxAttempts, `orphaned RUNNING run (job ${jobState ?? 'missing'})`, {
        staleBefore: cutoff,
      });
      if (outcome === 'requeued') {
        await this.queue.requeue(job, enqueueOpts);
        summary.requeued++;
      } else if (outcome === 'failed') {
        summary.failed++;
      }
      this.opts.logger?.warn({ taskRunId: run.id, jobState, outcome }, 'orphaned running run recovered');
    }
    return summary;
  }

  /** Runs once now and then every `intervalMs`; overlapping passes are skipped. */
  start(intervalMs: number): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        const s = await this.runOnce();
        if (s.enqueued + s.requeued + s.failed > 0) this.opts.logger?.info({ ...s }, 'orphan reconciliation');
      } catch (err) {
        this.opts.logger?.error({ err: (err as Error).message }, 'orphan reconciliation failed');
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
