/**
 * Tool contract (LLD v0.2 section 5.2, LLD v0.1 section 15).
 * Schemas are zod; `toToolSpec()` exports them as JSON Schema for model providers.
 */
import { z } from 'zod';

export const RISK_LEVELS = ['READ', 'LOW_WRITE', 'HIGH_WRITE', 'EXTERNAL_SIDE_EFFECT', 'DESTRUCTIVE'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

export type SourceTrust = 'trusted' | 'untrusted';

export interface ApprovalPolicy {
  mode: 'NONE' | 'REQUIRED' | 'NEVER_AUTONOMOUS';
  approverRole?: string;
}

export interface ToolLogger {
  info(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

export interface ToolContext {
  tenantId: string;
  executionId: string;
  agentId: string;
  /** PROSPECTOR | RESEARCHER | SCORER when known. */
  stage: string | null;
  /** Derived by the runtime per call: `tool:{executionId}:{toolId}:{callIndex}`. */
  idempotencyKey: string;
  signal: AbortSignal;
  logger: ToolLogger;
}

export type ToolResult<O> =
  | { status: 'ok'; output: O; costEur?: number }
  | { status: 'approval_required'; draftId: string; summary: string }
  | { status: 'error'; code: string; message: string; retryable: boolean };

export interface Tool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** snake_case, unique; the id used in `tool_policy` allowlists. */
  readonly id: string;
  /** Human readable name. */
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly riskLevel: RiskLevel;
  /** True if it changes state outside the runtime. */
  readonly sideEffects: boolean;
  readonly approvalPolicy: ApprovalPolicy;
  /** e.g. ['twenty:signals:write']. */
  readonly permissions: string[];
  readonly timeoutMs: number;
  readonly outputTrust: SourceTrust;
  enabled: boolean;
  execute(input: z.output<I>, ctx: ToolContext): Promise<ToolResult<z.input<O>>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = Tool<any, any>;

/** Identity helper that infers input/output types from the zod schemas. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(tool: Tool<I, O>): Tool<I, O> {
  return tool;
}

export interface AgentToolPolicy {
  /** Explicit allowlist of tool ids; everything else is forbidden. */
  allow: string[];
  maxCallsPerExecution: number;
  maxCallsPerTool?: Record<string, number>;
  /** Risk ceiling of the agent. */
  maxRiskLevel: RiskLevel;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toToolSpec(tool: AnyTool): ToolSpec {
  return {
    name: tool.id,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<string, unknown>,
  };
}
