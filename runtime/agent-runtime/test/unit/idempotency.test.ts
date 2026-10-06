import { describe, expect, it } from 'vitest';
import { normalizeScheduledAt, taskRunIdempotencyKey, toQueueJobId } from '../../src/domain/idempotency.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

const TASK = '6f1c2a0e-1111-4c2b-9a8e-0a0b0c0d0e0f';

describe('taskRunIdempotencyKey', () => {
  it('follows the LLD format taskrun:{task_id}:{scheduled_at}', () => {
    expect(taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00Z')).toBe(`taskrun:${TASK}:2026-10-06T08:00:00Z`);
  });

  it('collapses equivalent representations of the same slot', () => {
    const a = taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00Z');
    const b = taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00.000Z');
    const c = taskRunIdempotencyKey(TASK, '2026-10-06T10:00:00+02:00');
    const d = taskRunIdempotencyKey(TASK, new Date(Date.UTC(2026, 9, 6, 8, 0, 0, 450)));
    expect(new Set([a, b, c, d]).size).toBe(1);
  });

  it('distinguishes different slots and different tasks', () => {
    expect(taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00Z')).not.toBe(taskRunIdempotencyKey(TASK, '2026-10-06T08:00:01Z'));
    expect(taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00Z')).not.toBe(taskRunIdempotencyKey('other', '2026-10-06T08:00:00Z'));
  });

  it('rejects invalid input', () => {
    expect(() => taskRunIdempotencyKey(TASK, 'not-a-date')).toThrow(RangeError);
    expect(() => taskRunIdempotencyKey('', '2026-10-06T08:00:00Z')).toThrow(RangeError);
    expect(() => normalizeScheduledAt(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('toQueueJobId', () => {
  it('produces a BullMQ-safe, deterministic job id', () => {
    const key = taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00Z');
    const jobId = toQueueJobId(key);
    expect(jobId).not.toContain(':');
    expect(jobId).toBe(toQueueJobId(key));
    expect(Number.isInteger(Number(jobId))).toBe(false);
  });
});

describe('queue deduplication', () => {
  it('does not enqueue the same idempotency key twice', async () => {
    const queue = new MemoryRunQueue();
    const key = taskRunIdempotencyKey(TASK, '2026-10-06T08:00:00Z');
    const job = { kind: 'task_run' as const, tenantId: 't1', taskRunId: 'r1', idempotencyKey: key };
    const first = await queue.enqueue(job);
    const second = await queue.enqueue({ ...job });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(queue.jobs.size).toBe(1);
  });
});
