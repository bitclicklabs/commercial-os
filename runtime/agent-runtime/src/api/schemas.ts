/**
 * Request contracts (LLD section 21: "Contratos de API"). Versioned names are kept
 * in CONTRACTS so they can be exported as JSON Schema later (z.toJSONSchema).
 */
import { z } from 'zod';
import { HarnessConfigInput } from '../harness/config.js';
import { RUN_STATUSES, SCHEDULE_TYPES, TASK_DEFINITION_STATUSES, AGENT_STATUSES } from '../domain/statuses.js';

const JsonObject = z.record(z.string(), z.unknown());

/**
 * `{ name, version? }`: database skill (exact version, or the ACTIVE one without version).
 * `{ skill_id, version }`: MVP-0 legacy ref to a code constant (kept for compatibility).
 */
export const SkillRefSchema = z.union([
  z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), version: z.number().int().positive().optional() }),
  z.object({ skill_id: z.string().min(1), version: z.number().int().positive() }),
]);

/** `{ name, version? }`: database harness (exact version, or the ACTIVE one without version). */
export const HarnessRefSchema = z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), version: z.number().int().positive().optional() }).strict();

export const AgentVersionInput = z.object({
  model: z.string().min(1).optional(),
  model_provider: z.enum(['stub', 'anthropic', 'gemini']).optional(),
  system_prompt: z.string().default(''),
  configuration: JsonObject.default({}),
  skill_refs: z.array(SkillRefSchema).default([]),
  harness_version_id: z.string().optional(),
  /** MVP-1: `{ name }` (ACTIVE version) or `{ name, version }` of a harness in the database. */
  harness_ref: HarnessRefSchema.nullable().optional(),
  router_version_id: z.string().optional(),
  tool_policy_id: z.string().optional(),
  memory_policy_id: z.string().optional(),
  evaluation_policy_id: z.string().optional(),
});

export const CreateAgentBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  role: z.string().optional(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('LOW'),
  owner: z.string().optional(),
  status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
  version: AgentVersionInput.default({ system_prompt: '', configuration: {}, skill_refs: [] }),
  created_by: z.string().optional(),
});

export const PatchAgentBody = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().nullable(),
    role: z.string().nullable(),
    risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    owner: z.string().nullable(),
    default_schedule_id: z.string().nullable(),
    status: z.enum(AGENT_STATUSES),
  })
  .partial()
  .strict();

export const ListAgentsQuery = z.object({ status: z.enum(AGENT_STATUSES).optional() });

export const ScheduleSchema = z.object({
  type: z.enum(SCHEDULE_TYPES).default('MANUAL'),
  expression: z.string().optional(),
  at: z.iso.datetime({ offset: true }).optional(),
  interval_seconds: z.number().int().positive().optional(),
  event: z.string().optional(),
  // Scheduler aliases (LLD v0.2 section 5.6); validated by src/scheduler/schedule.ts.
  cron: z.string().optional(),
  run_at: z.iso.datetime({ offset: true }).optional(),
  every_seconds: z.number().int().positive().optional(),
  timezone: z.string().optional(),
  // EVENT trigger (src/events/triggers.ts): event type plus filter on the event data
  // ({path: literal} or {path: {"in": [values]}}); the filter is validated by parseEventTrigger.
  event_type: z.string().optional(),
  filter: JsonObject.optional(),
});

export const RetryPolicySchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(1),
  backoff_ms: z.number().int().min(0).default(0),
});

const TaskFields = {
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  agent_id: z.uuid(),
  input_schema: JsonObject.nullable().optional(),
  output_schema: JsonObject.nullable().optional(),
  default_input: JsonObject.default({}),
  schedule: ScheduleSchema.default({ type: 'MANUAL' }),
  timezone: z.string().default('Europe/Madrid'),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1000).default(0),
  max_concurrency: z.number().int().min(1).max(100).default(1),
  retry_policy: RetryPolicySchema.default({ max_attempts: 1, backoff_ms: 0 }),
  timeout_ms: z.number().int().min(1000).max(3_600_000).default(300_000),
  approval_policy: JsonObject.nullable().optional(),
  environment_id: z.string().nullable().optional(),
  evaluation_policy: JsonObject.nullable().optional(),
};

export const CreateTaskBody = z.object({ ...TaskFields, created_by: z.string().optional() });

export const PatchTaskBody = z
  .object({
    name: TaskFields.name,
    description: z.string().nullable(),
    agent_id: TaskFields.agent_id,
    input_schema: JsonObject.nullable(),
    output_schema: JsonObject.nullable(),
    default_input: JsonObject,
    schedule: ScheduleSchema,
    timezone: z.string(),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(1000),
    max_concurrency: z.number().int().min(1).max(100),
    retry_policy: RetryPolicySchema,
    timeout_ms: z.number().int().min(1000).max(3_600_000),
    approval_policy: JsonObject.nullable(),
    environment_id: z.string().nullable(),
    evaluation_policy: JsonObject.nullable(),
    updated_by: z.string(),
    change_reason: z.string(),
  })
  .partial()
  .strict();

export const ListTasksQuery = z.object({
  status: z.enum(TASK_DEFINITION_STATUSES).optional(),
  agent_id: z.uuid().optional(),
});

export const RunTaskBody = z
  .object({
    /** Slot being executed; part of the idempotency key. Defaults to "now". */
    scheduled_at: z.iso.datetime({ offset: true }).optional(),
    /** Merged over the task's default_input. */
    input: JsonObject.optional(),
  })
  .default({});

export const CreateExecutionBody = z.object({
  agent_id: z.uuid(),
  agent_version_id: z.uuid().optional(),
  input: JsonObject.default({}),
  idempotency_key: z.string().min(1).max(300).optional(),
});

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(RUN_STATUSES).optional(),
  agent_id: z.uuid().optional(),
  task_run_id: z.uuid().optional(),
});

export const CONTRACTS = {
  'agent.create.v1': CreateAgentBody,
  'agent.patch.v1': PatchAgentBody,
  'agent.task.create.v1': CreateTaskBody,
  'agent.task.patch.v1': PatchTaskBody,
  'agent.task.run.v1': RunTaskBody,
  'agent.execution.create.v1': CreateExecutionBody,
} as const;

// ---------------------------------------------------------------------------
// Skills (MVP-1, LLD v0.1 section 6.3)
// ---------------------------------------------------------------------------
const SkillContentFields = {
  constraints: z.string().max(50_000).nullable().optional(),
  examples: z.array(z.unknown()).max(50).nullable().optional(),
  anti_patterns: z.string().max(50_000).nullable().optional(),
  metadata: JsonObject.optional(),
};

export const CreateSkillBody = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case (a-z, 0-9, -)'),
  description: z.string().max(2_000).optional(),
  domain: z.string().max(100).optional(),
  instructions: z.string().min(1).max(100_000),
  ...SkillContentFields,
  created_by: z.string().optional(),
});

export const CreateSkillVersionBody = z
  .object({
    /** Copy the ACTIVE version ("active") or a given version number; the fields sent override it. */
    copy_from: z.union([z.literal('active'), z.number().int().positive()]).optional(),
    instructions: z.string().min(1).max(100_000).optional(),
    ...SkillContentFields,
    change_reason: z.string().max(2_000).optional(),
    created_by: z.string().optional(),
  })
  .refine((b) => b.copy_from !== undefined || b.instructions !== undefined, { message: 'instructions or copy_from is required' });

export const ListSkillsQuery = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'DEPRECATED']).optional() });

export const SkillParams = z.object({ id: z.string().min(1).max(100) });
export const SkillVersionParams = z.object({ id: z.string().min(1).max(100), v: z.coerce.number().int().positive() });

/**
 * Body of `POST /skills/:id/versions/:v/activate` (and the harness one). Without it the
 * Release Gate decides; `force: true` with a `reason` (>= 10 characters) is a human override
 * of a blocked gate (LLD v0.1 section 19), logged and returned in the response.
 */
export const ActivateVersionBody = z
  .object({
    force: z.boolean().optional(),
    reason: z.string().trim().max(2_000).optional(),
    by: z.string().trim().max(200).optional(),
  })
  .refine((b) => b.force !== true || (b.reason ?? '').length >= 10, { message: 'force requires a reason (at least 10 characters)', path: ['reason'] });

/**
 * Body of `POST /skills/:id/versions/:v/canary` (src/skills/canary.ts). Strict: there is no
 * `force` (a canary always needs a gate PASS / PASS_FORM experiment).
 */
export const StartCanaryBody = z
  .object({
    percent: z.number().int().min(1).max(99),
    by: z.string().trim().max(200).optional(),
  })
  .strict();

/** Body of `POST /skills/:id/canary/promote` and `/rollback` (no force: promote re-checks the gate, rollback always passes). */
export const FinishCanaryBody = z
  .object({
    by: z.string().trim().max(200).optional(),
    reason: z.string().trim().max(2_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Experiments (MVP-2, LLD v0.1 sections 11.5-11.6): read only, `pnpm experiment:run` writes
// ---------------------------------------------------------------------------
export const ListExperimentsQuery = z.object({
  subject_type: z.enum(['skill', 'harness']).optional(),
  subject_name: z.string().min(1).max(100).optional(),
  candidate_version: z.coerce.number().int().positive().optional(),
  status: z.enum(['DRAFT', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const ExperimentParams = z.object({ id: z.string().min(1).max(100) });

// ---------------------------------------------------------------------------
// Harnesses (MVP-1, LLD v0.1 section 7.1): the config is validated by src/harness/config.ts
// ---------------------------------------------------------------------------
export const CreateHarnessBody = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case (a-z, 0-9, -)'),
  description: z.string().max(2_000).optional(),
  config: HarnessConfigInput,
  metadata: JsonObject.optional(),
  created_by: z.string().optional(),
});

export const CreateHarnessVersionBody = z
  .object({
    /** Copy the ACTIVE version ("active") or a given version number; the dimensions sent override it. */
    copy_from: z.union([z.literal('active'), z.number().int().positive()]).optional(),
    config: HarnessConfigInput.optional(),
    metadata: JsonObject.optional(),
    change_reason: z.string().max(2_000).optional(),
    created_by: z.string().optional(),
  })
  .refine((b) => b.copy_from !== undefined || b.config !== undefined, { message: 'config or copy_from is required' });

export const ListHarnessesQuery = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'DEPRECATED']).optional() });
export const HarnessParams = z.object({ id: z.string().min(1).max(100) });
export const HarnessVersionParams = z.object({ id: z.string().min(1).max(100), v: z.coerce.number().int().positive() });
