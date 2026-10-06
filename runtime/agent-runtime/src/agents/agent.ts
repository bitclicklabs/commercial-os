import type { TraceStepType } from '../domain/statuses.js';
import type { ModelProvider, TokenUsage } from '../providers/model-provider.js';

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
