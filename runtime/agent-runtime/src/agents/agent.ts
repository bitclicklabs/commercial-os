import type { TraceStepType } from '../domain/statuses.js';
import type { ModelProvider, TokenUsage } from '../providers/model-provider.js';
import type { SkillSet } from '../skills/resolver.js';
import type { AgentToolbox } from '../tools/executor.js';

/** Resolved, immutable configuration the runtime hands to an agent implementation. */
export interface AgentContext {
  tenantId: string;
  executionId: string;
  agent: { id: string; name: string; role: string | null };
  version: {
    id: string;
    version: number;
    model: string;
    modelProvider: string;
    systemPrompt: string;
    configuration: Record<string, unknown>;
  };
  input: Record<string, unknown>;
  provider: ModelProvider;
  signal: AbortSignal;
  /**
   * Real tools from the registry, already filtered by the version's `tool_policy`.
   * Every call yields a TOOL step the agent appends to its steps.
   */
  tools?: AgentToolbox;
  /**
   * Skills of the version resolved from the database when the run started (MVP-1). Read
   * them with `useSkill(ctx, name, fallback)`: without them (or for an unresolved skill)
   * the agent keeps its MVP-0 prompt. The set records what was injected for the trace.
   */
  skills?: SkillSet;
}

/** Operational event recorded in the trace (no private model reasoning, section 17.1). */
export interface AgentStep {
  type: TraceStepType;
  timestamp: Date;
  input?: unknown;
  output?: unknown;
  model?: string;
  usage?: TokenUsage;
  tool?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  latencyMs?: number;
  error?: Record<string, unknown>;
  reward?: number;
}

export interface AgentResult {
  output: Record<string, unknown>;
  steps: AgentStep[];
  usage: TokenUsage;
  modelCost: number;
  toolCost: number;
}

export interface AgentImplementation {
  readonly kind: string;
  run(ctx: AgentContext): Promise<AgentResult>;
}
