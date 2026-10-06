/**
 * Idempotency keys (LLD section 21).
 *
 * The canonical key is `taskrun:{task_id}:{scheduled_at}`, where `scheduled_at` is
 * normalised to an ISO-8601 UTC string with second precision so that two requests
 * for the same slot (e.g. "2026-10-06T08:00:00Z" and "2026-10-06T08:00:00.000Z")
 * collapse into the same key.
 */

export function normalizeScheduledAt(input: Date | string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid scheduled_at: ${String(input)}`);
  }
  const truncated = new Date(Math.floor(date.getTime() / 1000) * 1000);
  return truncated.toISOString().replace('.000Z', 'Z');
}

export function taskRunIdempotencyKey(taskId: string, scheduledAt: Date | string): string {
  if (!taskId) throw new RangeError('taskId is required');
  return `taskrun:${taskId}:${normalizeScheduledAt(scheduledAt)}`;
}

export function executionIdempotencyKey(executionId: string): string {
  return `execution:${executionId}`;
}

/**
 * BullMQ forbids ':' in custom job ids, so the canonical key is mapped to a
 * deterministic, reversible-enough job id. Same key -> same job id -> BullMQ
 * ignores the duplicate add while the job still exists.
 */
export function toQueueJobId(idempotencyKey: string): string {
  return idempotencyKey.replaceAll(':', '__');
}
