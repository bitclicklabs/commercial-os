/**
 * Agent OS platform schema (LLD v0.1 sections 6.1, 6.2, 12, 17.1, 17.3).
 *
 * Rules:
 * - Every table carries `tenant_id` (C6). No multi-tenant infra yet, only the column.
 * - No physical DELETE: lifecycle is expressed through status columns (section 22).
 * - Executions, traces and versions are append-only / immutable once terminal (P3, P4).
 * - Entities not yet modelled (router, policies, environments) are referenced by opaque
 *   text ids until their tables exist. Skills (0005) and harnesses (0008) have tables and
 *   are referenced by name (`skill_refs`, `harness_ref`).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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

/**
 * MVP-0 reference to a prompt versioned in code (`src/agents/*-prompt.ts`). `version` is
 * the code version of the constant, NOT a `skill_versions.version`: these refs always
 * resolve to the code constant (see src/skills/resolver.ts).
 */
export interface LegacySkillRef {
  skill_id: string;
  version: number;
}

/**
 * MVP-1 reference to a skill in the database (`skills.name`). With `version` it pins that
 * exact `skill_versions.version`; without it, the run uses the skill's ACTIVE version.
 */
export interface DbSkillRef {
  name: string;
  version?: number;
}

export type SkillRef = LegacySkillRef | DbSkillRef;

/** What a run used for one skill ref (task_runs.skill_versions, traces.skill_versions). */
export interface SkillVersionUsed {
  name: string;
  /** `skill_versions.version` (db) or the code version of the constant (code). */
  version: number | null;
  skill_version_id: string | null;
  /** sha256 of the exact text injected into the prompt (null when nothing was resolved). */
  content_hash: string | null;
  source: 'db' | 'code' | 'none';
  /** The ref of the agent version; null when the agent used a code skill it does not reference. */
  requested: SkillRef | null;
  /**
   * Why the db was not used (only when source != 'db'). `source: 'none'` means the ref did not
   * resolve and the agent did not inject it (yet: task_runs keeps the state at start).
   */
  fallback_reason?: 'legacy_ref' | 'skill_not_found' | 'version_not_found' | 'no_active_version' | 'db_error' | 'not_referenced';
  /** Exact text, stored in the trace only for source 'code' (constants are not versioned in the db). */
  text?: string;
  /**
   * The skill had a canary (0012_skill_canaries) when the run started and the ref follows the
   * ACTIVE version: which arm this run got and why (deterministic hash of `routing_key`).
   */
  canary?: SkillCanaryRouting;
}

/** Canary routing of one run (src/skills/canary.ts): reproducible from `canary_id` + `routing_key`. */
export interface SkillCanaryRouting {
  canary_id: string;
  arm: 'canary' | 'stable';
  percent: number;
  /** 0..9999: `arm = canary` when `bucket < percent * 100`; null without routing key (always stable). */
  bucket: number | null;
  /** task_run id (task runs: every attempt gets the same arm) or execution id (direct executions). */
  routing_key: string | null;
  stable_version: number;
  canary_version: number;
}

/**
 * MVP-1 reference to a harness in the database (`harnesses.name`), like `DbSkillRef`: with
 * `version` it pins that exact `harness_versions.version`; without it, the run uses the
 * harness's ACTIVE version, read when the attempt starts.
 */
export interface HarnessRef {
  name: string;
  version?: number;
}

/**
 * Policies of one harness version (LLD v0.1 section 7.2), v1 scope. `null` (or a missing
 * key) means "not set by the harness": the run keeps today's source (task, env, agent
 * version, code). Fields marked placeholder are stored but have no effect yet. Normalised
 * by src/harness/config.ts (every key present), so the content hash is stable.
 */
export interface HarnessConfig {
  execution: {
    /** Live: overrides `task_definitions.timeout_ms` (and the 300 s of direct executions). */
    timeout_seconds: number | null;
    /** Live: overrides `task_definitions.retry_policy` (BullMQ attempts at enqueue + run attempts). */
    retry: { max_attempts: number; backoff_ms: number } | null;
    /** Placeholder: agents orchestrate their own loop (no processor graph yet). */
    max_turns: number | null;
  };
  tools: {
    /** Live, ceiling: min with the version's `tool_policy.max_calls_per_execution`. */
    max_calls_per_execution: number | null;
    /** Live, ceiling: the lower of the version's `tool_policy.max_risk_level` and this one. */
    max_risk_level: 'READ' | 'LOW_WRITE' | 'HIGH_WRITE' | 'EXTERNAL_SIDE_EFFECT' | null;
    /** Placeholder: tool calls are sequential per agent. */
    parallel_calls: boolean | null;
  };
  context: {
    /** Live, ceiling: min with `configuration.max_output_tokens` (or this value when the version sets none). */
    max_output_tokens: number | null;
  };
  safety: {
    /** Live: overrides env `TWENTY_WAIT_MAX_MS` for the Twenty health gate (0 disables it). */
    twenty_wait_max_ms: number | null;
    /** Placeholder: no semantic validator yet (LLD v0.2 section 10.4, point 8). */
    verify_before_commit: boolean | null;
  };
}

/** What a run used for its harness (traces.harness; `task_runs/traces.harness_version` keep `name@version`). */
export interface HarnessUsed {
  name: string | null;
  version: number | null;
  harness_version_id: string | null;
  /** sha256 of the normalised config (null when nothing was resolved). */
  content_hash: string | null;
  source: 'db' | 'none';
  requested: HarnessRef | null;
  fallback_reason?: 'no_ref' | 'invalid_ref' | 'harness_not_found' | 'version_not_found' | 'no_active_version' | 'invalid_config' | 'db_error';
  /** Effective values of the run (after precedence) and which of them came from the harness. */
  effective: Record<string, unknown>;
  overrides: string[];
}

export interface ScheduleSpec {
  type: string;
  expression?: string;
  at?: string;
  interval_seconds?: number;
  event?: string;
  /** CRON alias of `expression` (LLD v0.2 section 5.6). */
  cron?: string;
  /** ONCE alias of `at`. */
  run_at?: string;
  /** INTERVAL alias of `interval_seconds`. */
  every_seconds?: number;
  /** Overrides the task timezone for CRON schedules. */
  timezone?: string;
  /** EVENT: event type that fires the task (alias: `event`). */
  event_type?: string;
  /**
   * EVENT: filter on the event `data`, keyed by dot path. Each value is a literal (equality,
   * e.g. `{"status":"COMPLETED"}`) or `{"in": [v1, v2]}` (any of them). See src/events/triggers.ts.
   */
  filter?: Record<string, unknown>;
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
    /** MVP-1 (0008_harness): `{ name }` or `{ name, version }` of a harness in the database; null = no harness. */
    harnessRef: jsonb('harness_ref').$type<HarnessRef | null>(),
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
// 6.3 Skill + SkillVersion (MVP-1, migration 0005_skills)
// ---------------------------------------------------------------------------
export const SKILL_STATUSES = ['DRAFT', 'ACTIVE', 'DEPRECATED'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];
export const SKILL_VERSION_STATUSES = ['DRAFT', 'ACTIVE', 'DEPRECATED'] as const;
export type SkillVersionStatus = (typeof SKILL_VERSION_STATUSES)[number];

/**
 * A versioned skill (LLD v0.1 section 6.3). `name` is the stable kebab-case id agent
 * versions reference (`skill_refs[].name`). DRAFT until a version is activated. No DELETE
 * (trigger): a skill is retired with status DEPRECATED.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    domain: text('domain'),
    status: text('status').$type<SkillStatus>().notNull().default('DRAFT'),
    activeVersionId: uuid('active_version_id').references((): AnyPgColumn => skillVersions.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skills_tenant_name_uq').on(t.tenantId, t.name),
    check('skills_status_ck', sql`${t.status} in ('DRAFT', 'ACTIVE', 'DEPRECATED')`),
  ],
);

/**
 * Immutable content of one skill version: a trigger rejects UPDATE of the content columns
 * and any DELETE; only `status`, `activated_at` and `deprecated_at` change. `version` is
 * 1, 2, 3... per skill. At most one ACTIVE version per skill (partial unique index).
 * `content_hash` = sha256 of the rendered text the runtime injects (src/skills/render.ts).
 */
export const skillVersions = pgTable(
  'skill_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    skillId: uuid('skill_id')
      .notNull()
      .references((): AnyPgColumn => skills.id),
    version: integer('version').notNull(),
    status: text('status').$type<SkillVersionStatus>().notNull().default('DRAFT'),
    instructions: text('instructions').notNull(),
    constraints: text('constraints'),
    examples: jsonb('examples').$type<unknown[]>(),
    antiPatterns: text('anti_patterns'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text('content_hash').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
    createdAt: createdAt(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('skill_versions_skill_version_uq').on(t.skillId, t.version),
    uniqueIndex('skill_versions_one_active_uq').on(t.skillId).where(sql`${t.status} = 'ACTIVE'`),
    index('skill_versions_tenant_idx').on(t.tenantId),
    check('skill_versions_status_ck', sql`${t.status} in ('DRAFT', 'ACTIVE', 'DEPRECATED')`),
    check('skill_versions_version_ck', sql`${t.version} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// 7.1 Harness + HarnessVersion (MVP-1, migration 0008_harness; same pattern as skills)
// ---------------------------------------------------------------------------
export const HARNESS_STATUSES = ['DRAFT', 'ACTIVE', 'DEPRECATED'] as const;
export type HarnessStatus = (typeof HARNESS_STATUSES)[number];
export const HARNESS_VERSION_STATUSES = ['DRAFT', 'ACTIVE', 'DEPRECATED'] as const;
export type HarnessVersionStatus = (typeof HARNESS_VERSION_STATUSES)[number];

/**
 * A versioned harness (LLD v0.1 section 7.1): the policies a run executes under. `name` is
 * the stable kebab-case id agent versions reference (`harness_ref.name`). DRAFT until a
 * version is activated. No DELETE (trigger): a harness is retired with status DEPRECATED.
 */
export const harnesses = pgTable(
  'harnesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<HarnessStatus>().notNull().default('DRAFT'),
    activeVersionId: uuid('active_version_id').references((): AnyPgColumn => harnessVersions.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('harnesses_tenant_name_uq').on(t.tenantId, t.name),
    check('harnesses_status_ck', sql`${t.status} in ('DRAFT', 'ACTIVE', 'DEPRECATED')`),
  ],
);

/**
 * Immutable policies of one harness version: a trigger rejects UPDATE of the content
 * columns and any DELETE; only `status`, `activated_at` and `deprecated_at` change. At most
 * one ACTIVE version per harness (partial unique index). `content_hash` = sha256 of the
 * normalised config (src/harness/config.ts).
 */
export const harnessVersions = pgTable(
  'harness_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    harnessId: uuid('harness_id')
      .notNull()
      .references((): AnyPgColumn => harnesses.id),
    version: integer('version').notNull(),
    status: text('status').$type<HarnessVersionStatus>().notNull().default('DRAFT'),
    config: jsonb('config').$type<HarnessConfig>().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text('content_hash').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
    createdAt: createdAt(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('harness_versions_harness_version_uq').on(t.harnessId, t.version),
    uniqueIndex('harness_versions_one_active_uq').on(t.harnessId).where(sql`${t.status} = 'ACTIVE'`),
    index('harness_versions_tenant_idx').on(t.tenantId),
    check('harness_versions_status_ck', sql`${t.status} in ('DRAFT', 'ACTIVE', 'DEPRECATED')`),
    check('harness_versions_version_ck', sql`${t.version} > 0`),
  ],
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
    /** Refs of the agent version, resolved: exactly which skill versions the run used. */
    skillVersions: jsonb('skill_versions').$type<Array<SkillVersionUsed | SkillRef>>().notNull().default([]),
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
    // Orphan reconciler: scans QUEUED/RUNNING runs across tenants by age.
    index('task_runs_status_updated_idx').on(t.status, t.updatedAt),
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
    /** Harness the execution used (LLD P4): exact version, effective values, fallback reason (0008_harness). */
    harness: jsonb('harness').$type<HarnessUsed | null>(),
    /** Skill versions the execution used (LLD P4), with the code text when it fell back. */
    skillVersions: jsonb('skill_versions').$type<SkillVersionUsed[]>().notNull().default([]),
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

// ---------------------------------------------------------------------------
// 21 Entity locks (one holder per business entity, with TTL)
// ---------------------------------------------------------------------------
/**
 * Lease-style lock on a business entity (e.g. company:acme.com). A row is reused across
 * acquisitions: release sets `expires_at = now()` instead of deleting (section 22), and a
 * new acquisition takes over any row whose lease has expired. `locked_by_execution` is the
 * AgentExecution id holding the lease (no FK so direct executions and tests can use it).
 */
export const entityLocks = pgTable(
  'entity_locks',
  {
    tenantId: tenantId(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    lockedByExecution: uuid('locked_by_execution').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'entity_locks_pk', columns: [t.tenantId, t.entityType, t.entityId] }),
    index('entity_locks_execution_idx').on(t.lockedByExecution),
  ],
);

// ---------------------------------------------------------------------------
// 21 Event bus (LLD v0.2 section 7): domain events, minimal outbox
// ---------------------------------------------------------------------------
export const EVENT_SOURCES = ['runtime', 'twenty', 'n8n'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/**
 * Append-only log of domain events (`event.envelope.v1`). The row is written first and the
 * BullMQ job second; `dispatched_at` stays null until the job is in Redis, and the
 * re-publisher retries rows still null. A trigger forbids DELETE (section 22).
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    type: text('type').notNull(),
    schemaVersion: text('schema_version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    source: text('source').$type<EventSource>().notNull(),
    /** Envelope `producer` (agent-runtime, scheduler, twenty-app, n8n). */
    producer: text('producer').notNull(),
    /** Root id the event belongs to: task_run id or execution id. */
    correlationId: text('correlation_id').notNull(),
    /** Optional dedup key: a second publish with the same key returns the existing row. */
    idempotencyKey: text('idempotency_key'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('events_tenant_type_occurred_idx').on(t.tenantId, t.type, t.occurredAt),
    index('events_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
    index('events_correlation_idx').on(t.tenantId, t.correlationId),
    uniqueIndex('events_idem_uq').on(t.tenantId, t.idempotencyKey),
    // Re-publisher scan: only rows not yet in the queue.
    index('events_undispatched_idx').on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
    check('events_source_ck', sql`${t.source} in ('runtime', 'twenty', 'n8n')`),
  ],
);

// ---------------------------------------------------------------------------
// 11 Evaluation (MVP-0: evaluador HUMAN, LLD v0.2 sections 5.5 and 6.4, D14)
// ---------------------------------------------------------------------------
/**
 * One row per human verdict on an agent output (append-only). `subject_id` is the record
 * id in Twenty (e.g. a commercialHypothesis). `agent_execution_id` / `task_run_id` link the
 * verdict to the run that produced the subject when it can be resolved; otherwise they
 * stay null and `details.link.resolved = false`.
 */
export const evaluations = pgTable(
  'evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text('kind').notNull().default('HUMAN'),
    evaluatorId: text('evaluator_id').notNull().default('human-v1'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    agentExecutionId: uuid('agent_execution_id').references(() => agentExecutions.id),
    taskRunId: uuid('task_run_id').references(() => taskRuns.id),
    feedback: text('feedback').notNull(),
    score: numeric('score', { precision: 5, scale: 4, mode: 'number' }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    source: text('source').notNull().default('api'),
    idempotencyKey: text('idempotency_key'),
    evaluatedBy: text('evaluated_by'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('evaluations_tenant_subject_idx').on(t.tenantId, t.subjectType, t.subjectId, t.occurredAt),
    index('evaluations_tenant_execution_idx').on(t.tenantId, t.agentExecutionId),
    uniqueIndex('evaluations_idem_uq').on(t.tenantId, t.idempotencyKey),
  ],
);

// ---------------------------------------------------------------------------
// 10.2 Inbound Manager (LLD v0.1): IMAP cursors
// ---------------------------------------------------------------------------
/**
 * Read cursor of an inbound consumer over one IMAP mailbox: the highest UID already
 * processed under a given UIDVALIDITY. One row per (tenant, consumer, mailbox), updated in
 * place (it is a cursor, not history; the history is the TaskRun/Trace of each run).
 * `consumer` separates readers of the same mailbox (`bajas` today, general triage later).
 * If the server reports a different UIDVALIDITY the cursor is no longer valid and the
 * consumer starts again from its initial date (the suppression list dedupes).
 */
export const inboundState = pgTable(
  'inbound_state',
  {
    tenantId: tenantId(),
    consumer: text('consumer').notNull(),
    /** `user@host/MAILBOX` (no password). */
    mailbox: text('mailbox').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    lastUid: bigint('last_uid', { mode: 'number' }).notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    /** Counters of the last run that advanced the cursor (no message content). */
    lastSummary: jsonb('last_summary').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'inbound_state_pk', columns: [t.tenantId, t.consumer, t.mailbox] }),
    check('inbound_state_last_uid_ck', sql`${t.lastUid} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Event bus, outbound side (LLD v0.1 section 20): webhook subscriptions (n8n first)
// ---------------------------------------------------------------------------
/**
 * One outbound webhook per row: every event of the tenant whose type matches `event_types`
 * (exact `task.completed` or prefix `task.*`) is POSTed to `target_url`, signed with
 * `secret` (HMAC-SHA256 of `timestamp:body`, same scheme as Twenty). No DELETE: a
 * subscription is switched off with `enabled = false` (section 22). The secret is stored
 * in clear because the runtime must sign with it; the API never returns it after creation.
 */
export const eventSubscriptions = pgTable(
  'event_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    targetUrl: text('target_url').notNull(),
    secret: text('secret').notNull(),
    eventTypes: text('event_types').array().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Last successful delivery (2xx). */
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    /** Last delivery error (kept after later successes; compare with `last_error_at`). */
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    /** Deliveries that failed for good (all attempts) since the last success. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('event_subscriptions_tenant_name_uq').on(t.tenantId, t.name),
    index('event_subscriptions_tenant_enabled_idx').on(t.tenantId, t.enabled),
    check('event_subscriptions_types_ck', sql`cardinality(${t.eventTypes}) > 0`),
    check('event_subscriptions_url_ck', sql`${t.targetUrl} ~ '^https?://'`),
  ],
);

// ---------------------------------------------------------------------------
// 10.1 Email outbound (LLD v0.1): sends observed from Twenty (email-ops)
// ---------------------------------------------------------------------------
/**
 * One row per email sent from Twenty with the manual workflow "Enviar borrador de email",
 * recorded when the Twenty webhook reports `commercialHypothesis.emailStatus -> SENT`.
 * The runtime never sends: this table only OBSERVES. Append-only (trigger anti-DELETE).
 * Dedupe: one row per (tenant, hypothesis, sent_at) where `sent_at` is the `updatedAt` of
 * the record in the webhook, so a redelivered webhook adds nothing.
 * `to_email` keeps the recipients (CRM data, already in Twenty); events only carry the domain.
 */
export const emailSends = pgTable(
  'email_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    hypothesisId: text('hypothesis_id').notNull(),
    companyId: text('company_id'),
    /** Normalised recipients, comma separated ('' if the record had none). */
    toEmail: text('to_email').notNull(),
    /** Domain of the first recipient. */
    toDomain: text('to_domain'),
    subject: text('subject'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    /** Workspace member of the change in Twenty, when the webhook names one. */
    workspaceMemberId: text('workspace_member_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('email_sends_dedupe_uq').on(t.tenantId, t.hypothesisId, t.sentAt),
    index('email_sends_tenant_sent_idx').on(t.tenantId, t.sentAt),
  ],
);

// ---------------------------------------------------------------------------
// 6.4 / 16 Knowledge layer: semantic memory (MVP-1, migration 0009_knowledge)
// ---------------------------------------------------------------------------
export const KNOWLEDGE_STATUSES = ['PROPOSED', 'VALIDATED', 'ACTIVE', 'SUPERSEDED', 'REJECTED'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export const KNOWLEDGE_SOURCES = ['human', 'experiment', 'agent_proposal'] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

/** One piece of evidence of a knowledge entry: what it points to (execution, evaluation, experiment...). */
export interface KnowledgeEvidence {
  type: 'execution' | 'evaluation' | 'experiment' | 'feedback' | 'skill_version' | 'document';
  /** Id of the referenced object (uuid of an execution/evaluation, `EXP-001`, a date...). */
  ref: string;
  note?: string;
  /** Repository path or URL of the document that records it. */
  doc?: string;
}

/**
 * A KnowledgeEntry (LLD v0.1 section 6.4): RAW EXPERIENCE -> KNOWLEDGE -> SKILL. A short,
 * actionable `statement` backed by `evidence`. Lifecycle PROPOSED -> VALIDATED -> ACTIVE ->
 * SUPERSEDED (or REJECTED); only ACTIVE entries of the agent's `knowledge_domains` are
 * injected in its prompt. Triggers: no DELETE, valid transitions only, content immutable
 * once it leaves PROPOSED/VALIDATED. A CHECK forbids ACTIVE without evidence.
 */
export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    domain: text('domain').notNull(),
    topic: text('topic').notNull(),
    statement: text('statement').notNull(),
    evidence: jsonb('evidence').$type<KnowledgeEvidence[]>().notNull().default([]),
    confidence: numeric('confidence', { precision: 3, scale: 2, mode: 'number' }).notNull(),
    source: text('source').$type<KnowledgeSource>().notNull(),
    status: text('status').$type<KnowledgeStatus>().notNull().default('PROPOSED'),
    statusReason: text('status_reason'),
    /** Entry that replaces this one (set when it is SUPERSEDED by a newer entry). */
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => knowledgeEntries.id),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    createdBy: text('created_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('knowledge_entries_active_idx').on(t.tenantId, t.status, t.domain),
    check('knowledge_entries_status_ck', sql`${t.status} in ('PROPOSED', 'VALIDATED', 'ACTIVE', 'SUPERSEDED', 'REJECTED')`),
    check('knowledge_entries_source_ck', sql`${t.source} in ('human', 'experiment', 'agent_proposal')`),
    check('knowledge_entries_confidence_ck', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    check('knowledge_entries_evidence_ck', sql`jsonb_typeof(${t.evidence}) = 'array'`),
    check('knowledge_entries_active_evidence_ck', sql`${t.status} <> 'ACTIVE' or jsonb_array_length(${t.evidence}) > 0`),
  ],
);

// ---------------------------------------------------------------------------
// 11.4 Evaluation datasets (MVP-2, migration 0010_eval_datasets) and P5
// ---------------------------------------------------------------------------
export const DATASET_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];
export const DATASET_SPLITS = ['TRAIN', 'VALIDATION', 'TEST'] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];
export const CASE_ORIGINS = ['harvested', 'synthetic', 'manual'] as const;
export type CaseOrigin = (typeof CASE_ORIGINS)[number];
/** Role of a case in an experiment (P5): `design` burns it for any future validation/test. */
export const CASE_USE_ROLES = ['design', 'validation', 'test'] as const;
export type CaseUseRole = (typeof CASE_USE_ROLES)[number];

/** One use of a case by an experiment (`evaluation_cases.used_by`, append-only). */
export interface CaseUse {
  experiment: string;
  role: CaseUseRole;
  /** ISO timestamp of the mark (the registry date for static exclusions). */
  at: string;
  /** `registry` (src/datasets/exclusions.ts), `mark_used` (API/service) or `inherited` (from an older version). */
  via: 'registry' | 'mark_used' | 'inherited';
  by?: string | null;
  note?: string | null;
  /** Older version the use was inherited from (`via: 'inherited'`). */
  from_version?: number;
}

/** Provenance of a case (`evaluation_cases.source`). */
export interface CaseSource {
  origin: CaseOrigin;
  trace_id?: string;
  execution_id?: string;
  evaluation_id?: string;
  /** Where the expected value comes from: the commercial's verdict, a declared rule, or nothing. */
  expected_source: 'human' | 'rule' | 'none';
  [key: string]: unknown;
}

/**
 * A versioned EvaluationDataset (LLD v0.1 section 11.4). One row per (name, version): a
 * re-harvest creates a new version, it never mutates an older one. `build_info` records the
 * rules, exclusions and counts of the build. Trigger: no DELETE, only status transitions
 * DRAFT -> ACTIVE -> ARCHIVED (or DRAFT -> ARCHIVED), everything else immutable.
 */
export const evaluationDatasets = pgTable(
  'evaluation_datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    version: integer('version').notNull(),
    description: text('description'),
    status: text('status').$type<DatasetStatus>().notNull().default('DRAFT'),
    buildInfo: jsonb('build_info').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('evaluation_datasets_name_version_uq').on(t.tenantId, t.name, t.version),
    index('evaluation_datasets_tenant_domain_idx').on(t.tenantId, t.domain, t.status),
    check('evaluation_datasets_status_ck', sql`${t.status} in ('DRAFT', 'ACTIVE', 'ARCHIVED')`),
    check('evaluation_datasets_version_ck', sql`${t.version} >= 1`),
  ],
);

/**
 * An EvaluationCase: input the agent received, context of the run, expected behaviour (human
 * verdict or rule) and provenance. Immutable (trigger) except `used_by`, which only grows:
 * it is the P5 ledger of the experiments that consumed the case and in which role.
 * `entity_key` (folded exhibitor name) drives the split, so one entity never lands in two
 * splits; `content_hash` (sha256 of input + expected) is unique per dataset.
 */
export const evaluationCases = pgTable(
  'evaluation_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => evaluationDatasets.id),
    tenantId: tenantId(),
    split: text('split').$type<DatasetSplit>().notNull(),
    entityKey: text('entity_key').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    expected: jsonb('expected').$type<Record<string, unknown>>().notNull().default({}),
    source: jsonb('source').$type<CaseSource>().notNull(),
    difficulty: text('difficulty'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    contentHash: text('content_hash').notNull(),
    usedBy: jsonb('used_by').$type<CaseUse[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('evaluation_cases_dataset_hash_uq').on(t.datasetId, t.contentHash),
    index('evaluation_cases_dataset_split_idx').on(t.datasetId, t.split),
    index('evaluation_cases_tenant_entity_idx').on(t.tenantId, t.entityKey),
    check('evaluation_cases_split_ck', sql`${t.split} in ('TRAIN', 'VALIDATION', 'TEST')`),
    check('evaluation_cases_used_by_ck', sql`jsonb_typeof(${t.usedBy}) = 'array'`),
    check('evaluation_cases_origin_ck', sql`${t.source}->>'origin' in ('harvested', 'synthetic', 'manual')`),
  ],
);

export const EXPERIMENT_STATUSES = ['DRAFT', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const EXPERIMENT_SUBJECT_TYPES = ['skill', 'harness'] as const;
export type ExperimentSubjectType = (typeof EXPERIMENT_SUBJECT_TYPES)[number];
/** PASS_FORM: every evaluated criterion passed but there were no labelled cases (see src/experiments/gate.ts). */
export const EXPERIMENT_DECISIONS = ['PASS', 'PASS_FORM', 'FAIL', 'INCONCLUSIVE'] as const;
export type ExperimentDecision = (typeof EXPERIMENT_DECISIONS)[number];

/**
 * An Experiment (LLD v0.1 section 11.5): baseline vs candidate of one subject (a skill or a
 * harness) on the same cases, with the Release Gate verdict (section 11.6). `name` is
 * EXP-NNN, numbered per tenant (`number`). Trigger: no DELETE; identity and `config` are
 * immutable from creation; the rest only changes while DRAFT/RUNNING, and a COMPLETED,
 * FAILED or CANCELLED experiment is immutable.
 */
export const experiments = pgTable(
  'experiments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    number: integer('number').notNull(),
    subjectType: text('subject_type').$type<ExperimentSubjectType>().notNull(),
    subjectName: text('subject_name').notNull(),
    baselineVersion: integer('baseline_version'),
    candidateVersion: integer('candidate_version').notNull(),
    datasetId: uuid('dataset_id').references(() => evaluationDatasets.id),
    /** Cases used per split and role (`{ VALIDATION: { role, case_ids, labeled }, ... }`). */
    splits: jsonb('splits').$type<Record<string, unknown>>().notNull().default({}),
    /** Budget, repetitions, evaluators, gate criteria, versions compared (immutable). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Per phase and version: composite, dimensions, evaluators, decisions, cost. */
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    /** Every gate criterion with its values and pass/fail. */
    gateResult: jsonb('gate_result').$type<Record<string, unknown>>().notNull().default({}),
    decision: text('decision').$type<ExperimentDecision>(),
    status: text('status').$type<ExperimentStatus>().notNull().default('DRAFT'),
    costEur: numeric('cost_eur', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    createdBy: text('created_by'),
  },
  (t) => [
    uniqueIndex('experiments_tenant_name_uq').on(t.tenantId, t.name),
    uniqueIndex('experiments_tenant_number_uq').on(t.tenantId, t.number),
    index('experiments_subject_idx').on(t.tenantId, t.subjectType, t.subjectName, t.candidateVersion, t.status),
    check('experiments_status_ck', sql`${t.status} in ('DRAFT', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')`),
    check('experiments_subject_type_ck', sql`${t.subjectType} in ('skill', 'harness')`),
    check('experiments_decision_ck', sql`${t.decision} is null or ${t.decision} in ('PASS', 'PASS_FORM', 'FAIL', 'INCONCLUSIVE')`),
    check('experiments_completed_ck', sql`(${t.status} = 'COMPLETED') = (${t.decision} is not null)`),
    check('experiments_versions_ck', sql`${t.candidateVersion} >= 1 and (${t.baselineVersion} is null or (${t.baselineVersion} >= 1 and ${t.baselineVersion} <> ${t.candidateVersion}))`),
    check('experiments_name_ck', sql`${t.name} ~ '^EXP-[0-9]{3,}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Skill canary (post Release Gate; migration 0012_skill_canaries)
// ---------------------------------------------------------------------------
export const SKILL_CANARY_STATUSES = ['ACTIVE', 'PROMOTED', 'ROLLED_BACK'] as const;
export type SkillCanaryStatus = (typeof SKILL_CANARY_STATUSES)[number];

/**
 * A canary deployment of a skill version (src/skills/canary.ts): after a Release Gate PASS /
 * PASS_FORM a human sends `percent` % of the runs that follow the ACTIVE version to the
 * candidate (deterministic hash of the run id), compares and decides: PROMOTED (the candidate
 * becomes ACTIVE, gate re-checked) or ROLLED_BACK (everything back to the stable version).
 * At most one ACTIVE canary per skill (partial unique index). Trigger: no DELETE; identity,
 * versions, percent and experiment immutable; ACTIVE -> PROMOTED | ROLLED_BACK only, and a
 * finished canary is immutable.
 */
export const skillCanaries = pgTable(
  'skill_canaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    canaryVersionId: uuid('canary_version_id')
      .notNull()
      .references(() => skillVersions.id),
    canaryVersion: integer('canary_version').notNull(),
    /** The ACTIVE version when the canary started (the rest of the runs). */
    stableVersionId: uuid('stable_version_id')
      .notNull()
      .references(() => skillVersions.id),
    stableVersion: integer('stable_version').notNull(),
    percent: integer('percent').notNull(),
    status: text('status').$type<SkillCanaryStatus>().notNull().default('ACTIVE'),
    /** The experiment whose gate let the canary start. */
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id),
    /** Release Gate result when it started (and, on promote, the re-check in `finishGate`). */
    gate: jsonb('gate').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    startedBy: text('started_by'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    finishedBy: text('finished_by'),
    finishReason: text('finish_reason'),
    finishGate: jsonb('finish_gate').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('skill_canaries_one_active_uq').on(t.skillId).where(sql`${t.status} = 'ACTIVE'`),
    index('skill_canaries_tenant_skill_idx').on(t.tenantId, t.skillId, t.startedAt),
    check('skill_canaries_status_ck', sql`${t.status} in ('ACTIVE', 'PROMOTED', 'ROLLED_BACK')`),
    check('skill_canaries_percent_ck', sql`${t.percent} between 1 and 99`),
    check('skill_canaries_versions_ck', sql`${t.canaryVersionId} <> ${t.stableVersionId}`),
    check('skill_canaries_finished_ck', sql`(${t.status} = 'ACTIVE') = (${t.finishedAt} is null)`),
  ],
);

export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type TaskDefinition = typeof taskDefinitions.$inferSelect;
export type TaskDefinitionVersion = typeof taskDefinitionVersions.$inferSelect;
export type TaskRun = typeof taskRuns.$inferSelect;
export type AgentExecution = typeof agentExecutions.$inferSelect;
export type Trace = typeof traces.$inferSelect;
export type TraceStep = typeof traceSteps.$inferSelect;
export type EntityLock = typeof entityLocks.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type Evaluation = typeof evaluations.$inferSelect;
export type InboundState = typeof inboundState.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type EventSubscription = typeof eventSubscriptions.$inferSelect;
export type EmailSend = typeof emailSends.$inferSelect;
export type Harness = typeof harnesses.$inferSelect;
export type HarnessVersion = typeof harnessVersions.$inferSelect;
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type EvaluationDataset = typeof evaluationDatasets.$inferSelect;
export type EvaluationCase = typeof evaluationCases.$inferSelect;
export type Experiment = typeof experiments.$inferSelect;
export type SkillCanary = typeof skillCanaries.$inferSelect;

// ---------------------------------------------------------------------------
// Skill Optimizer (MVP-3, LLD v0.1 section 18). Migration 0013.
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an optimization run (src/optimizer/): the pipeline moves it forward, a human
 * closes it. Terminal: BLOCKED_NO_DATA, ERROR, PROMOTED, DISCARDED. GATE_PASS and GATE_FAIL wait
 * for the human (PROMOTED after activating the candidate, DISCARDED otherwise).
 */
export const OPTIMIZATION_RUN_STATUSES = [
  'PENDING',
  'HARVESTING',
  'CLUSTERED',
  'CANDIDATE_CREATED',
  'EXPERIMENT_RUNNING',
  'GATE_PASS',
  'GATE_FAIL',
  'BLOCKED_NO_DATA',
  'ERROR',
  'PROMOTED',
  'DISCARDED',
] as const;
export type OptimizationRunStatus = (typeof OPTIMIZATION_RUN_STATUSES)[number];

/**
 * An automatic Skill Optimizer run (LLD v0.1 section 18): harvest of production failures,
 * clustering, a bounded candidate (edit-ops, DRAFT), an experiment against the ACTIVE version
 * and the Release Gate verdict. The run never activates anything. Trigger: no DELETE; status
 * changes are guarded UPDATEs (`WHERE status IN (...)`) in src/optimizer/service.ts. At most one
 * open run per (tenant, skill) (partial unique index).
 */
export const optimizationRuns = pgTable(
  'optimization_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    skillName: text('skill_name').notNull(),
    /** ACTIVE version when the run was requested (the base of the candidate and the experiment baseline). */
    baseVersion: integer('base_version').notNull(),
    status: text('status').$type<OptimizationRunStatus>().notNull().default('PENDING'),
    /** Options of the run (dataset, budgets, minimums). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Failure clusters (with the failures they group) from the clustering step. */
    failureClusters: jsonb('failure_clusters').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Edit operations of the candidate (as applied, with their size), and the attempts. */
    proposedOps: jsonb('proposed_ops').$type<Record<string, unknown>[]>().notNull().default([]),
    candidateVersion: integer('candidate_version'),
    experimentId: uuid('experiment_id').references(() => experiments.id),
    /** Release Gate decision of the experiment (PASS, PASS_FORM, FAIL, INCONCLUSIVE). */
    verdict: text('verdict').$type<ExperimentDecision>(),
    /** LLM cost of the optimizer itself plus the experiment, EUR. */
    costEur: money('cost_eur'),
    /** Harvest stats, data check, dataset, P5 marks, attempts, note, human close. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by'),
  },
  (t) => [
    index('optimization_runs_skill_idx').on(t.tenantId, t.skillName, t.createdAt),
    uniqueIndex('optimization_runs_open_uq')
      .on(t.tenantId, t.skillName)
      .where(sql`${t.status} in ('PENDING', 'HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING')`),
    check(
      'optimization_runs_status_ck',
      sql`${t.status} in ('PENDING', 'HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING', 'GATE_PASS', 'GATE_FAIL', 'BLOCKED_NO_DATA', 'ERROR', 'PROMOTED', 'DISCARDED')`,
    ),
    check('optimization_runs_verdict_ck', sql`${t.verdict} is null or ${t.verdict} in ('PASS', 'PASS_FORM', 'FAIL', 'INCONCLUSIVE')`),
    check('optimization_runs_versions_ck', sql`${t.baseVersion} >= 1 and (${t.candidateVersion} is null or (${t.candidateVersion} >= 1 and ${t.candidateVersion} <> ${t.baseVersion}))`),
  ],
);

export type OptimizationRun = typeof optimizationRuns.$inferSelect;

// ---------------------------------------------------------------------------
// Re-validation of PASS_FORM experiments (src/experiments/revalidation.ts). Migration 0016.
// ---------------------------------------------------------------------------
export const REVALIDATION_VERDICTS = ['CONFIRMED', 'REFUTED', 'INSUFFICIENT'] as const;
export type RevalidationVerdict = (typeof REVALIDATION_VERDICTS)[number];

/**
 * A re-validation of a finished PASS_FORM experiment: the accuracy of each arm measured on the
 * per-case outputs the experiment already stored, against human labels that arrived later.
 * No model runs (cost 0). The experiment itself is immutable, so this is a new linked record.
 * One row per (experiment, label set + criteria): `labels_hash` makes a repeated request with
 * the same labels return the existing row. Trigger: no DELETE; everything immutable except
 * `consequence` (the Twenty note and the event), which can be written once, from `{}`.
 */
export const experimentRevalidations = pgTable(
  'experiment_revalidations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    experimentId: uuid('experiment_id')
      .notNull()
      .references(() => experiments.id),
    experimentName: text('experiment_name').notNull(),
    subjectType: text('subject_type').$type<ExperimentSubjectType>().notNull(),
    subjectName: text('subject_name').notNull(),
    baselineVersion: integer('baseline_version'),
    candidateVersion: integer('candidate_version').notNull(),
    verdict: text('verdict').$type<RevalidationVerdict>().notNull(),
    /** sha256 of the labels used (executed case, label case, evaluation) and the criteria. */
    labelsHash: text('labels_hash').notNull(),
    /** Dataset cases whose label was used (the newer version's case, or the executed one). */
    labelCaseIds: text('label_case_ids').array().notNull().default(sql`'{}'::text[]`),
    /** HUMAN evaluations behind those labels. */
    evaluationIds: text('evaluation_ids').array().notNull().default(sql`'{}'::text[]`),
    /** Every label used: executed case, label case, dataset version, evaluation, expected. */
    labels: jsonb('labels').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Labels left out and why (P5 design, TRAIN label at run time, no outputs). */
    excluded: jsonb('excluded').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Accuracy per arm (`baseline`, `candidate`): labelled cases, decisions, correct, value, mismatches. */
    accuracy: jsonb('accuracy').$type<Record<string, unknown>>().notNull().default({}),
    baselineAccuracy: numeric('baseline_accuracy', { precision: 5, scale: 4, mode: 'number' }),
    candidateAccuracy: numeric('candidate_accuracy', { precision: 5, scale: 4, mode: 'number' }),
    /** Criteria applied: minimum labels, accuracy min_delta of the experiment's gate, threshold. */
    criteria: jsonb('criteria').$type<Record<string, unknown>>().notNull().default({}),
    summary: text('summary').notNull(),
    /** State of the candidate when re-validated (ACTIVE, canary, other) and whether it still matters. */
    versionState: jsonb('version_state').$type<Record<string, unknown>>().notNull().default({}),
    /** Where the per-case outputs came from: `metrics` (experiments row) or `artifact` (informe.json). */
    outputsSource: text('outputs_source').notNull(),
    /** Note in Twenty and event emitted on a REFUTED of a version still in use (written once). */
    consequence: jsonb('consequence').$type<Record<string, unknown>>().notNull().default({}),
    /** Always 0: a re-validation never calls a model. */
    costEur: money('cost_eur'),
    source: text('source').notNull().default('api'),
    requestedBy: text('requested_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('experiment_revalidations_labels_uq').on(t.tenantId, t.experimentId, t.labelsHash),
    index('experiment_revalidations_experiment_idx').on(t.tenantId, t.experimentId, t.createdAt),
    check('experiment_revalidations_verdict_ck', sql`${t.verdict} in ('CONFIRMED', 'REFUTED', 'INSUFFICIENT')`),
    check('experiment_revalidations_cost_ck', sql`${t.costEur} = 0`),
    check('experiment_revalidations_outputs_ck', sql`${t.outputsSource} in ('metrics', 'artifact')`),
  ],
);

export type ExperimentRevalidation = typeof experimentRevalidations.$inferSelect;

// ---------------------------------------------------------------------------
// Audit log of administrative API actions (LLD v0.1 sections 22 and 24). Migration 0015.
// ---------------------------------------------------------------------------

export const AUDIT_RESULTS = ['ok', 'rejected', 'error'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * One row per administrative API request (activations, force overrides, canary steps, optimizer
 * close, datasets, knowledge, harnesses...), written by the hook of src/audit/ with the outcome:
 * `ok` (2xx), `rejected` (4xx, e.g. a 409 of the Release Gate) or `error` (5xx). GETs are never
 * audited. Append-only: triggers reject UPDATE, DELETE and TRUNCATE. `payload` is a summary of
 * the request body (long texts and objects go as sha256 + length + excerpt, never in full).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who acted: `api` today (the API has no authentication yet). */
    actor: text('actor').notNull().default('api'),
    actorIp: text('actor_ip'),
    /** Free label: `x-actor` header, else the `by` / `created_by` of the body. Not authenticated. */
    actorLabel: text('actor_label'),
    /** e.g. `skill.activate`, `skill.force_activate`, `canary.promote`, `optimizer.close`. */
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    /** Id or name of the subject as the request addressed it (or as the response resolved it). */
    subjectId: text('subject_id'),
    subjectVersion: integer('subject_version'),
    method: text('method').notNull(),
    /** Route pattern (e.g. `/skills/:id/versions/:v/activate`). */
    route: text('route').notNull(),
    requestId: text('request_id'),
    /** Summary of the request body (src/audit/summary.ts). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: text('result').$type<AuditResult>().notNull(),
    statusCode: integer('status_code').notNull(),
    /** `error` of the response body when rejected (e.g. `release_gate_blocked`). */
    errorCode: text('error_code'),
    /** Short facts of the response: `changed`, gate mode, message of the error. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('audit_log_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
    index('audit_log_tenant_action_idx').on(t.tenantId, t.action, t.occurredAt),
    index('audit_log_subject_idx').on(t.tenantId, t.subjectType, t.subjectId),
    check('audit_log_result_ck', sql`${t.result} in ('ok', 'rejected', 'error')`),
    check('audit_log_status_ck', sql`${t.statusCode} between 100 and 599`),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
