import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { taskRuns, type TaskDefinition, type TaskRun } from '../db/schema.js';
import { normalizeScheduledAt, taskRunIdempotencyKey } from '../domain/idempotency.js';
import type { EnqueueResult, RunQueue } from '../queue/run-queue.js';

export interface RequestTaskRunInput {
  scheduledAt?: string | Date;
  input?: Record<string, unknown>;
}

export interface RequestTaskRunResult {
  taskRun: TaskRun;
  /** True when a TaskRun with the same idempotency key already existed. */
  deduplicated: boolean;
  enqueue: EnqueueResult | null;
}

export class QueueUnavailableError extends Error {
  constructor(
    readonly taskRun: TaskRun,
    cause: unknown,
  ) {
    super('run queue unavailable', { cause });
    this.name = 'QueueUnavailableError';
  }
}

/**
 * Creates (or reuses) the TaskRun for `taskrun:{task_id}:{scheduled_at}` and enqueues it.
 *
 * Idempotency is enforced twice: by the unique index (tenant_id, idempotency_key) on
 * task_runs and by the deterministic BullMQ job id. A duplicate request never creates a
 * second TaskRun; if the original is still QUEUED it is re-enqueued (no-op when the job
 * already exists), which also heals a previous enqueue that failed because Redis was down.
 */
export async function requestTaskRun(
  db: Db,
  queue: RunQueue,
  task: TaskDefinition,
  req: RequestTaskRunInput,
): Promise<RequestTaskRunResult> {
  const scheduledAt = normalizeScheduledAt(req.scheduledAt ?? new Date());
  const idempotencyKey = taskRunIdempotencyKey(task.id, scheduledAt);

  const [inserted] = await db
    .insert(taskRuns)
    .values({
      tenantId: task.tenantId,
      taskDefinitionId: task.id,
      taskDefinitionVersionId: task.currentVersionId,
      idempotencyKey,
      status: 'QUEUED',
      scheduledAt: new Date(scheduledAt),
      input: { ...task.defaultInput, ...(req.input ?? {}) },
    })
    .onConflictDoNothing({ target: [taskRuns.tenantId, taskRuns.idempotencyKey] })
    .returning();

  const taskRun =
    inserted ??
    (await db.query.taskRuns.findFirst({
      where: and(eq(taskRuns.tenantId, task.tenantId), eq(taskRuns.idempotencyKey, idempotencyKey)),
    }));
  if (!taskRun) throw new Error(`task run ${idempotencyKey} vanished`);

  const deduplicated = !inserted;
  if (taskRun.status !== 'QUEUED') return { taskRun, deduplicated, enqueue: null };

  try {
    const enqueue = await queue.enqueue(
      { kind: 'task_run', tenantId: task.tenantId, taskRunId: taskRun.id, idempotencyKey },
      { attempts: task.retryPolicy.max_attempts, backoffMs: task.retryPolicy.backoff_ms, priority: task.priority },
    );
    return { taskRun, deduplicated, enqueue };
  } catch (err) {
    throw new QueueUnavailableError(taskRun, err);
  }
}
