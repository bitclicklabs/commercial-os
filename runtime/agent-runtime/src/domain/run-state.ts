import type { RunStatus } from './statuses.js';

/**
 * State machine shared by TaskRun and AgentExecution.
 *
 *   QUEUED  -> RUNNING | CANCELLED
 *   RUNNING -> COMPLETED | FAILED | CANCELLED | TIMED_OUT | QUEUED (retry)
 *   COMPLETED, FAILED, CANCELLED, TIMED_OUT are terminal (execution is immutable, LLD P4).
 */
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'QUEUED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`Invalid run status transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses from which a transition into `to` is legal (used for guarded SQL updates). */
export function allowedSources(to: RunStatus): RunStatus[] {
  return (Object.keys(TRANSITIONS) as RunStatus[]).filter((from) => TRANSITIONS[from].includes(to));
}
