/**
 * Agent OS platform schema (LLD v0.1 sections 6.1, 6.2, 12, 17.1, 17.3).
 *
 * Rules:
 * - Every table carries `tenant_id` (C6). No multi-tenant infra yet, only the column.
 * - No physical DELETE: lifecycle is expressed through status columns (section 22).
 * - Executions, traces and versions are append-only / immutable once terminal (P3, P4).
 * - Entities not yet modelled (harness, router, skills, policies, environments) are
 *   referenced by opaque text ids until their tables exist.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  AGENT_STATUSES,
  AGENT_VERSION_STATUSES,
  RUN_STATUSES,
  TASK_DEFINITION_STATUSES,
  TRACE_STEP_TYPES,
} from '../domain/statuses.js';

export const agentStatus = pgEnum('agent_status', AGENT_STATUSES);
export const agentVersionStatus = pgEnum('agent_version_status', AGENT_VERSION_STATUSES);
export const taskDefinitionStatus = pgEnum('task_definition_status', TASK_DEFINITION_STATUSES);
export const runStatus = pgEnum('run_status', RUN_STATUSES);
export const traceStepType = pgEnum('trace_step_type', TRACE_STEP_TYPES);

const tenantId = () => text('tenant_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 14, scale: 6, mode: 'number' }).notNull().default(0);
const tokens = (name: string) => integer(name).notNull().default(0);

export interface SkillRef {
  skill_id: string;
  version: number;
}

export interface ScheduleSpec {
  type: string;
  expression?: string;
  at?: string;
  interval_seconds?: number;
  event?: string;
}

export interface RetryPolicy {
  max_attempts: number;
  backoff_ms: number;
}

// ---------------------------------------------------------------------------
// 6.1 Agent
// ---------------------------------------------------------------------------
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    role: text('role'),
    status: agentStatus('status').notNull().default('DRAFT'),
    activeVersionId: uuid('active_version_id').references((): AnyPgColumn => agentVersions.id),
    defaultScheduleId: text('default_schedule_id'),
    riskLevel: text('risk_level').notNull().default('LOW'),
    owner: text('owner'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agents_tenant_name_uq').on(t.tenantId, t.name), index('agents_tenant_status_idx').on(t.tenantId, t.status)],
);

// ---------------------------------------------------------------------------
// 6.2 AgentVersion
// ---------------------------------------------------------------------------
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: uuid('agent_id')
      .notNull()
      .references((): AnyPgColumn => agents.id),
    version: integer('version').notNull(),
    status: agentVersionStatus('status').notNull().default('DRAFT'),
    model: text('model').notNull(),
    modelProvider: text('model_provider').notNull(),
    systemPrompt: text('system_prompt').notNull().default(''),
    configuration: jsonb('configuration').$type<Record<string, unknown>>().notNull().default({}),
    skillRefs: jsonb('skill_refs').$type<SkillRef[]>().notNull().default([]),
    harnessVersionId: text('harness_version_id'),
    routerVersionId: text('router_version_id'),
    toolPolicyId: text('tool_policy_id'),
    memoryPolicyId: text('memory_policy_id'),
    evaluationPolicyId: text('evaluation_policy_id'),
    createdAt: createdAt(),
    createdBy: text('created_by'),
  },
  (t) => [uniqueIndex('agent_versions_agent_version_uq').on(t.agentId, t.version), index('agent_versions_tenant_idx').on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// 12 TaskDefinition + TaskDefinitionVersion
// ---------------------------------------------------------------------------
export const taskDefinitions = pgTable(
  'task_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    status: taskDefinitionStatus('status').notNull().default('ACTIVE'),
    currentVersion: integer('current_version').notNull().default(1),
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => taskDefinitionVersions.id),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    defaultInput: jsonb('default_input').$type<Record<string, unknown>>().notNull().default({}),
    schedule: jsonb('schedule').$type<ScheduleSpec>().notNull().default({ type: 'MANUAL' }),
    timezone: text('timezone').notNull().default('Europe/Madrid'),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    maxConcurrency: integer('max_concurrency').notNull().default(1),
    retryPolicy: jsonb('retry_policy').$type<RetryPolicy>().notNull().default({ max_attempts: 1, backoff_ms: 0 }),
    timeoutMs: integer('timeout_ms').notNull().default(300_000),
    approvalPolicy: jsonb('approval_policy').$type<Record<string, unknown>>(),
    environmentId: text('environment_id'),
    evaluationPolicy: jsonb('evaluation_policy').$type<Record<string, unknown>>(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('task_definitions_tenant_status_idx').on(t.tenantId, t.status), index('task_definitions_agent_idx').on(t.agentId)],
);

/** Immutable snapshot of a TaskDefinition at a given version (reproducibility, section 12). */
export const taskDefinitionVersions = pgTable(
  'task_definition_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    taskDefinitionId: uuid('task_definition_id')
      .notNull()
      .references((): AnyPgColumn => taskDefinitions.id),
    version: integer('version').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    changeReason: text('change_reason'),
    createdAt: createdAt(),
    createdBy: text('created_by'),
  },
  (t) => [uniqueIndex('task_definition_versions_uq').on(t.taskDefinitionId, t.version)],
);

// ---------------------------------------------------------------------------
// Agent execution (one per attempt; immutable once terminal)
// ---------------------------------------------------------------------------
export const agentExecutions = pgTable(
  'agent_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    agentVersionId: uuid('agent_version_id').references(() => agentVersions.id),
    taskRunId: uuid('task_run_id').references((): AnyPgColumn => taskRuns.id),
    idempotencyKey: text('idempotency_key'),
    status: runStatus('status').notNull().default('QUEUED'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    inputTokens: tokens('input_tokens'),
    outputTokens: tokens('output_tokens'),
    cachedTokens: tokens('cached_tokens'),
    toolCalls: tokens('tool_calls'),
    toolCost: money('tool_cost'),
    modelCost: money('model_cost'),
    totalCost: money('total_cost'),
    latencyMs: integer('latency_ms'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_executions_idem_uq').on(t.tenantId, t.idempotencyKey),
    index('agent_executions_tenant_status_idx').on(t.tenantId, t.status),
    index('agent_executions_task_run_idx').on(t.taskRunId),
  ],
);

// ---------------------------------------------------------------------------
// 12 TaskRun
// ---------------------------------------------------------------------------
export const taskRuns = pgTable(
  'task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    taskDefinitionId: uuid('task_definition_id')
      .notNull()
      .references(() => taskDefinitions.id),
    taskDefinitionVersionId: uuid('task_definition_version_id').references(() => taskDefinitionVersions.id),
    idempotencyKey: text('idempotency_key').notNull(),
    status: runStatus('status').notNull().default('QUEUED'),
    attempts: integer('attempts').notNull().default(0),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    agentVersionId: uuid('agent_version_id').references(() => agentVersions.id),
    agentVersion: integer('agent_version'),
    harnessVersion: text('harness_version'),
    skillVersions: jsonb('skill_versions').$type<SkillRef[]>().notNull().default([]),
    environmentVersion: text('environment_version'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    executionId: uuid('execution_id').references((): AnyPgColumn => agentExecutions.id),
    score: numeric('score', { precision: 6, scale: 4, mode: 'number' }),
    cost: money('cost'),
    inputTokens: tokens('input_tokens'),
    outputTokens: tokens('output_tokens'),
    cachedTokens: tokens('cached_tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('task_runs_idem_uq').on(t.tenantId, t.idempotencyKey),
    index('task_runs_task_scheduled_idx').on(t.taskDefinitionId, t.scheduledAt),
    index('task_runs_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// 17.1 Trace + TraceStep (17.3 cost fields)
// ---------------------------------------------------------------------------
export const traces = pgTable(
  'traces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => agentExecutions.id),
    taskRunId: uuid('task_run_id').references(() => taskRuns.id),
    taskDefinitionId: uuid('task_definition_id').references(() => taskDefinitions.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    agentVersionId: uuid('agent_version_id').references(() => agentVersions.id),
    harnessVersion: text('harness_version'),
    toolCalls: jsonb('tool_calls').$type<unknown[]>().notNull().default([]),
    messages: jsonb('messages').$type<unknown[]>().notNull().default([]),
    memoryReads: jsonb('memory_reads').$type<unknown[]>().notNull().default([]),
    memoryWrites: jsonb('memory_writes').$type<unknown[]>().notNull().default([]),
    delegations: jsonb('delegations').$type<unknown[]>().notNull().default([]),
    errors: jsonb('errors').$type<unknown[]>().notNull().default([]),
    finalOutput: jsonb('final_output').$type<Record<string, unknown>>(),
    evaluation: jsonb('evaluation').$type<Record<string, unknown>>(),
    inputTokens: tokens('input_tokens'),
    outputTokens: tokens('output_tokens'),
    cachedTokens: tokens('cached_tokens'),
    toolCallCount: tokens('tool_call_count'),
    toolCost: money('tool_cost'),
    modelCost: money('model_cost'),
    totalCost: money('total_cost'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('traces_execution_uq').on(t.executionId), index('traces_tenant_agent_idx').on(t.tenantId, t.agentId)],
);

export const traceSteps = pgTable(
  'trace_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    traceId: uuid('trace_id')
      .notNull()
      .references(() => traces.id),
    sequence: integer('sequence').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    type: traceStepType('type').notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    model: text('model'),
    inputTokens: tokens('input_tokens'),
    outputTokens: tokens('output_tokens'),
    tool: text('tool'),
    toolInput: jsonb('tool_input'),
    toolOutput: jsonb('tool_output'),
    latencyMs: integer('latency_ms'),
    error: jsonb('error'),
    reward: numeric('reward', { precision: 8, scale: 4, mode: 'number' }),
  },
  (t) => [uniqueIndex('trace_steps_trace_seq_uq').on(t.traceId, t.sequence)],
);

export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type TaskDefinition = typeof taskDefinitions.$inferSelect;
export type TaskDefinitionVersion = typeof taskDefinitionVersions.$inferSelect;
export type TaskRun = typeof taskRuns.$inferSelect;
export type AgentExecution = typeof agentExecutions.$inferSelect;
export type Trace = typeof traces.$inferSelect;
export type TraceStep = typeof traceSteps.$inferSelect;
