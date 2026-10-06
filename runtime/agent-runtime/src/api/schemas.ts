/**
 * Request contracts (LLD section 21: "Contratos de API"). Versioned names are kept
 * in CONTRACTS so they can be exported as JSON Schema later (z.toJSONSchema).
 */
import { z } from 'zod';
import { RUN_STATUSES, SCHEDULE_TYPES, TASK_DEFINITION_STATUSES, AGENT_STATUSES } from '../domain/statuses.js';

const JsonObject = z.record(z.string(), z.unknown());

export const SkillRefSchema = z.object({ skill_id: z.string().min(1), version: z.number().int().positive() });

export const AgentVersionInput = z.object({
  model: z.string().min(1).optional(),
  model_provider: z.enum(['stub', 'anthropic']).optional(),
  system_prompt: z.string().default(''),
  configuration: JsonObject.default({}),
  skill_refs: z.array(SkillRefSchema).default([]),
  harness_version_id: z.string().optional(),
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
