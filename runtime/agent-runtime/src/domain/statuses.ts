/** Status vocabularies from LLD v0.1 (sections 6.1, 6.2, 12 and 17.1). */

export const AGENT_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'DEPRECATED', 'ARCHIVED'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_VERSION_STATUSES = [
  'DRAFT',
  'CANDIDATE',
  'EVALUATING',
  'APPROVED',
  'ACTIVE',
  'REJECTED',
  'DEPRECATED',
] as const;
export type AgentVersionStatus = (typeof AGENT_VERSION_STATUSES)[number];

export const TASK_DEFINITION_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type TaskDefinitionStatus = (typeof TASK_DEFINITION_STATUSES)[number];

export const SCHEDULE_TYPES = ['ONCE', 'CRON', 'INTERVAL', 'EVENT', 'MANUAL', 'DEPENDENCY', 'CONDITION'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

/** Shared by TaskRun and AgentExecution. */
export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TRACE_STEP_TYPES = [
  'THINK',
  'MODEL',
  'TOOL',
  'DELEGATE',
  'MEMORY_READ',
  'MEMORY_WRITE',
  'VERIFY',
  'REFLECT',
  'FINAL',
] as const;
export type TraceStepType = (typeof TRACE_STEP_TYPES)[number];
