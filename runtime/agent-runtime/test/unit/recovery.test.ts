import { describe, expect, it } from 'vitest';
import { decideRecovery, type RecoveryInput } from '../../src/worker/recovery.js';

const base: RecoveryInput = {
  status: 'RUNNING',
  attempts: 1,
  maxAttempts: 3,
  jobState: null,
  ageMs: 10 * 60_000,
  graceMs: 120_000,
};

describe('decideRecovery', () => {
  it('leaves terminal runs alone', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const) {
      expect(decideRecovery({ ...base, status })).toBe('none');
    }
  });

  it('respects the grace period (API or worker may be mid-flight)', () => {
    expect(decideRecovery({ ...base, ageMs: 1_000 })).toBe('none');
    expect(decideRecovery({ ...base, status: 'QUEUED', ageMs: 1_000 })).toBe('none');
  });

  it('does nothing while BullMQ still owns the job (stalled jobs are handled by BullMQ)', () => {
    for (const jobState of ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'] as const) {
      expect(decideRecovery({ ...base, jobState })).toBe('none');
      expect(decideRecovery({ ...base, status: 'QUEUED', jobState })).toBe('none');
    }
  });

  it('requeues RUNNING runs without a live job while attempts remain', () => {
    expect(decideRecovery({ ...base, jobState: null })).toBe('requeue');
    expect(decideRecovery({ ...base, jobState: 'completed' })).toBe('requeue');
    expect(decideRecovery({ ...base, jobState: 'failed' })).toBe('requeue');
  });

  it('fails RUNNING runs that exhausted max_attempts', () => {
    expect(decideRecovery({ ...base, attempts: 3, maxAttempts: 3 })).toBe('fail');
    expect(decideRecovery({ ...base, attempts: 1, maxAttempts: 1, jobState: 'failed' })).toBe('fail');
  });

  it('re-enqueues QUEUED runs whose job is gone (e.g. Redis down at enqueue)', () => {
    expect(decideRecovery({ ...base, status: 'QUEUED', attempts: 0 })).toBe('enqueue');
    expect(decideRecovery({ ...base, status: 'QUEUED', attempts: 0, jobState: 'failed' })).toBe('enqueue');
  });
});
