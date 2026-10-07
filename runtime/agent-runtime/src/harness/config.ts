/**
 * Harness config v1 (LLD v0.1 section 7.2): validation, normalisation, hash and the
 * precedence rules that turn a harness version into the effective policies of one run.
 *
 * Dimensions in v1 (no processor graph):
 *
 *   dimension  field                     state        today's source it replaces
 *   ---------  ------------------------  -----------  -----------------------------------------
 *   execution  timeout_seconds           live         task_definitions.timeout_ms (300 s direct)
 *   execution  retry                     live         task_definitions.retry_policy
 *   execution  max_turns                 placeholder  (agents run their own loop)
 *   tools      max_calls_per_execution   live (cap)   tool_policy.max_calls_per_execution
 *   tools      max_risk_level            live (cap)   tool_policy.max_risk_level
 *   tools      parallel_calls            placeholder  (calls are sequential)
 *   context    max_output_tokens         live (cap)   configuration.max_output_tokens
 *   safety     twenty_wait_max_ms        live         env TWENTY_WAIT_MAX_MS
 *   safety     verify_before_commit      placeholder  (no semantic validator yet)
 *
 * Precedence: a non-null value of the harness wins over the env / task value it replaces.
 * Values that today come from the agent version itself (tool policy, output tokens) are
 * more specific than a shared harness, so there the harness is a CEILING: it can tighten the
 * agent's policy, never loosen it. `null` always means "not set": the run keeps today's
 * source. D1 MODEL stays in the agent version (model, model_provider); worker concurrency
 * (WORKER_CONCURRENCY) is a per-process setting, not a per-run policy, and is not here.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HarnessConfig, RetryPolicy } from '../db/schema.js';
import { riskRank, type AgentToolPolicy, type RiskLevel } from '../tools/types.js';

export const HARNESS_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Risk ceilings a harness may set (DESTRUCTIVE is never a valid ceiling, as in tool_policy). */
export const HARNESS_RISK_LEVELS = ['READ', 'LOW_WRITE', 'HIGH_WRITE', 'EXTERNAL_SIDE_EFFECT'] as const;

const nullableInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

/** Input accepted by the API and the seed (missing keys = null). Unknown keys are rejected (typos). */
export const HarnessConfigInput = z
  .object({
    execution: z
      .object({
        timeout_seconds: nullableInt(1, 3_600),
        retry: z
          .object({ max_attempts: z.number().int().min(1).max(10), backoff_ms: z.number().int().min(0).max(3_600_000) })
          .strict()
          .nullable()
          .optional(),
        max_turns: nullableInt(1, 1_000),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        max_calls_per_execution: nullableInt(1, 100_000),
        max_risk_level: z.enum(HARNESS_RISK_LEVELS).nullable().optional(),
        parallel_calls: z.boolean().nullable().optional(),
      })
      .strict()
      .optional(),
    context: z.object({ max_output_tokens: nullableInt(1, 1_000_000) }).strict().optional(),
    safety: z
      .object({
        twenty_wait_max_ms: nullableInt(0, 86_400_000),
        verify_before_commit: z.boolean().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HarnessConfigInput = z.infer<typeof HarnessConfigInput>;

/** Every key present (null when unset): the stored form, so the hash does not depend on omissions. */
export function normalizeHarnessConfig(input: HarnessConfigInput): HarnessConfig {
  return {
    execution: {
      timeout_seconds: input.execution?.timeout_seconds ?? null,
      retry: input.execution?.retry ? { max_attempts: input.execution.retry.max_attempts, backoff_ms: input.execution.retry.backoff_ms } : null,
      max_turns: input.execution?.max_turns ?? null,
    },
    tools: {
      max_calls_per_execution: input.tools?.max_calls_per_execution ?? null,
      max_risk_level: input.tools?.max_risk_level ?? null,
      parallel_calls: input.tools?.parallel_calls ?? null,
    },
    context: { max_output_tokens: input.context?.max_output_tokens ?? null },
    safety: {
      twenty_wait_max_ms: input.safety?.twenty_wait_max_ms ?? null,
      verify_before_commit: input.safety?.verify_before_commit ?? null,
    },
  };
}

/** Parses a stored config (jsonb); null when it no longer validates (the run falls back). */
export function parseStoredHarnessConfig(raw: unknown): HarnessConfig | null {
  const parsed = HarnessConfigInput.safeParse(raw);
  return parsed.success ? normalizeHarnessConfig(parsed.data) : null;
}

/** JSON independent of key order (jsonb does not preserve it). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function harnessConfigHash(config: HarnessConfig): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}

/** Placeholder fields that carry a value: stored, but with no effect in v1 (non-blocking). */
export function placeholderWarnings(config: HarnessConfig): string[] {
  const out: string[] = [];
  if (config.execution.max_turns !== null) out.push('execution.max_turns es un placeholder en v1: se guarda pero no tiene efecto (los agentes orquestan su propio bucle)');
  if (config.tools.parallel_calls !== null) out.push('tools.parallel_calls es un placeholder en v1: se guarda pero no tiene efecto (las tools se llaman en secuencia)');
  if (config.safety.verify_before_commit !== null) out.push('safety.verify_before_commit es un placeholder en v1: se guarda pero no tiene efecto (no hay validador semántico)');
  return out;
}

/**
 * The harness `default-commercial` v1 of the seed: TODAY's real values, so referencing it
 * changes nothing. Only global values are set (TWENTY_WAIT_MAX_MS default and the LOW_WRITE
 * risk ceiling every seeded agent has); per-task and per-agent values (timeouts, retries,
 * call limits, output tokens) differ between tasks and stay null = inherited.
 */
export const DEFAULT_COMMERCIAL_HARNESS_NAME = 'default-commercial';
export const DEFAULT_COMMERCIAL_CONFIG: HarnessConfig = normalizeHarnessConfig({
  tools: { max_risk_level: 'LOW_WRITE' },
  safety: { twenty_wait_max_ms: 600_000 },
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------
/** What a run uses today without a harness (task, env, agent version, code). */
export interface PolicyBaseline {
  timeoutMs: number;
  retry: RetryPolicy;
  /** Max wait of the Twenty gate (env); null when the gate is disabled (no gate at all). */
  twentyWaitMaxMs: number | null;
  toolPolicy: AgentToolPolicy;
  configuration: Record<string, unknown>;
}

/** Effective policies of one attempt. `overrides` lists the fields the harness changed or capped. */
export interface EffectivePolicies {
  timeoutMs: number;
  retry: RetryPolicy;
  twentyWaitMaxMs: number | null;
  toolPolicy: AgentToolPolicy;
  /** The version configuration with `max_output_tokens` capped (same object when untouched). */
  configuration: Record<string, unknown>;
  overrides: string[];
}

const lowerRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (riskRank(a) <= riskRank(b) ? a : b);

export function applyHarness(config: HarnessConfig | null, base: PolicyBaseline): EffectivePolicies {
  const effective: EffectivePolicies = { ...base, overrides: [] };
  if (!config) return effective;
  const o = effective.overrides;

  if (config.execution.timeout_seconds !== null) {
    effective.timeoutMs = config.execution.timeout_seconds * 1000;
    o.push('execution.timeout_seconds');
  }
  if (config.execution.retry !== null) {
    effective.retry = { ...config.execution.retry };
    o.push('execution.retry');
  }
  // A disabled gate (null) stays disabled: the harness sets the wait, it does not create a gate.
  if (config.safety.twenty_wait_max_ms !== null && base.twentyWaitMaxMs !== null) {
    effective.twentyWaitMaxMs = config.safety.twenty_wait_max_ms;
    o.push('safety.twenty_wait_max_ms');
  }

  let toolPolicy = base.toolPolicy;
  const maxCalls = config.tools.max_calls_per_execution;
  if (maxCalls !== null && maxCalls < toolPolicy.maxCallsPerExecution) {
    toolPolicy = { ...toolPolicy, maxCallsPerExecution: maxCalls };
    o.push('tools.max_calls_per_execution');
  }
  const ceiling = config.tools.max_risk_level;
  if (ceiling !== null && lowerRisk(toolPolicy.maxRiskLevel, ceiling) !== toolPolicy.maxRiskLevel) {
    toolPolicy = { ...toolPolicy, maxRiskLevel: ceiling };
    o.push('tools.max_risk_level');
  }
  effective.toolPolicy = toolPolicy;

  const maxOut = config.context.max_output_tokens;
  if (maxOut !== null) {
    const declared = base.configuration.max_output_tokens;
    const current = typeof declared === 'number' && Number.isFinite(declared) ? declared : undefined;
    if (current === undefined || maxOut < current) {
      effective.configuration = { ...base.configuration, max_output_tokens: maxOut };
      o.push('context.max_output_tokens');
    }
  }
  return effective;
}

/** Effective values stored in the trace (`traces.harness.effective`). */
export function effectiveRecord(p: EffectivePolicies): Record<string, unknown> {
  const maxOut = p.configuration.max_output_tokens;
  return {
    timeout_ms: p.timeoutMs,
    retry: { ...p.retry },
    twenty_wait_max_ms: p.twentyWaitMaxMs,
    max_calls_per_execution: p.toolPolicy.maxCallsPerExecution,
    max_risk_level: p.toolPolicy.maxRiskLevel,
    max_output_tokens: typeof maxOut === 'number' ? maxOut : null,
  };
}
