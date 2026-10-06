import { describe, expect, it } from 'vitest';
import {
  allowedSources,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
} from '../../src/domain/run-state.js';
import { RUN_STATUSES } from '../../src/domain/statuses.js';

describe('TaskRun state machine', () => {
  it('allows the happy path QUEUED -> RUNNING -> COMPLETED', () => {
    expect(canTransition('QUEUED', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(true);
  });

  it('allows failure, timeout, cancellation and retry from RUNNING', () => {
    for (const to of ['FAILED', 'TIMED_OUT', 'CANCELLED', 'QUEUED'] as const) {
      expect(canTransition('RUNNING', to)).toBe(true);
    }
    expect(canTransition('QUEUED', 'CANCELLED')).toBe(true);
  });

  it('rejects skipping RUNNING', () => {
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('QUEUED', 'FAILED')).toBe(false);
    expect(() => assertTransition('QUEUED', 'COMPLETED')).toThrow(InvalidTransitionError);
  });

  it('treats COMPLETED, FAILED, CANCELLED and TIMED_OUT as immutable terminal states', () => {
    const terminal = RUN_STATUSES.filter(isTerminal);
    expect(terminal.sort()).toEqual(['CANCELLED', 'COMPLETED', 'FAILED', 'TIMED_OUT']);
    for (const from of terminal) {
      for (const to of RUN_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('derives guarded-update source sets', () => {
    expect(allowedSources('RUNNING')).toEqual(['QUEUED']);
    expect(allowedSources('CANCELLED').sort()).toEqual(['QUEUED', 'RUNNING']);
    expect(allowedSources('COMPLETED')).toEqual(['RUNNING']);
  });
});
