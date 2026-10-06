/**
 * LLM provider abstraction (LLD section 25: "LLMs - Abstracción de proveedor").
 * Every call reports tokens and cost (section 17.3) so the runtime can persist them
 * in TaskRun / AgentExecution / Trace without knowing the provider.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Provider specific knobs (e.g. effort), passed through untouched. */
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** Costs in EUR-agnostic "currency units"; the pricing table defines the unit (USD for Anthropic list prices). */
export interface CostBreakdown {
  modelCost: number;
  currency: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  stopReason: string | null;
  usage: TokenUsage;
  cost: CostBreakdown;
  latencyMs: number;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; result: CompletionResult };

export interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  /** Cost for a given usage; exposed so callers can price usage reported elsewhere. */
  estimateCost(model: string, usage: TokenUsage): CostBreakdown;
}

export interface ModelPricing {
  /** Price per 1M input tokens. */
  inputPerMTok: number;
  /** Price per 1M output tokens. */
  outputPerMTok: number;
  /** Price per 1M cache-read tokens. */
  cachedPerMTok: number;
}

export function priceUsage(pricing: ModelPricing | undefined, usage: TokenUsage): number {
  if (!pricing) return 0;
  const cost =
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cachedTokens * pricing.cachedPerMTok) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
