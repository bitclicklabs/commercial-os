import { z } from 'zod';
import { RISK_LEVELS, type AgentToolPolicy } from './types.js';

export const DEFAULT_MAX_CALLS_PER_EXECUTION = 60;
export const DEFAULT_MAX_RISK_LEVEL = 'LOW_WRITE' as const;

const ToolIds = z.array(z.string().min(1)).max(200);

const PolicyObject = z
  .object({
    allow: ToolIds.default([]),
    maxCallsPerExecution: z.number().int().positive().optional(),
    max_calls_per_execution: z.number().int().positive().optional(),
    maxCallsPerTool: z.record(z.string(), z.number().int().nonnegative()).optional(),
    max_calls_per_tool: z.record(z.string(), z.number().int().nonnegative()).optional(),
    maxRiskLevel: z.enum(RISK_LEVELS).optional(),
    max_risk_level: z.enum(RISK_LEVELS).optional(),
  })
  .loose();

/**
 * Reads the agent tool policy from `agent_version.configuration`:
 *
 * - `tool_policy: ["find_company", "create_signal"]` (just the allowlist), or
 * - `tool_policy: { allow: [...], max_calls_per_execution?, max_calls_per_tool?, max_risk_level? }`
 *   (camelCase keys accepted too; `toolPolicy` accepted as the key).
 *
 * Missing or invalid policy means deny-all. The risk ceiling defaults to LOW_WRITE
 * (LLD v0.2 section 9.2) and DESTRUCTIVE is never accepted as a ceiling.
 */
export function parseToolPolicy(configuration: Record<string, unknown> | null | undefined): AgentToolPolicy {
  const raw = configuration?.tool_policy ?? configuration?.toolPolicy;
  const denyAll: AgentToolPolicy = {
    allow: [],
    maxCallsPerExecution: DEFAULT_MAX_CALLS_PER_EXECUTION,
    maxRiskLevel: DEFAULT_MAX_RISK_LEVEL,
  };
  if (raw === undefined || raw === null) return denyAll;

  const asList = ToolIds.safeParse(raw);
  if (asList.success) return { ...denyAll, allow: [...new Set(asList.data)] };

  const parsed = PolicyObject.safeParse(raw);
  if (!parsed.success) return denyAll;
  const p = parsed.data;
  let maxRiskLevel = p.maxRiskLevel ?? p.max_risk_level ?? DEFAULT_MAX_RISK_LEVEL;
  if (maxRiskLevel === 'DESTRUCTIVE') maxRiskLevel = 'EXTERNAL_SIDE_EFFECT';
  const maxCallsPerTool = p.maxCallsPerTool ?? p.max_calls_per_tool;
  return {
    allow: [...new Set(p.allow)],
    maxCallsPerExecution: p.maxCallsPerExecution ?? p.max_calls_per_execution ?? DEFAULT_MAX_CALLS_PER_EXECUTION,
    maxRiskLevel,
    ...(maxCallsPerTool ? { maxCallsPerTool } : {}),
  };
}
