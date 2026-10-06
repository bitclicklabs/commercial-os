import Anthropic from '@anthropic-ai/sdk';
import {
  priceUsage,
  type CompletionRequest,
  type CompletionResult,
  type CostBreakdown,
  type ModelPricing,
  type ModelProvider,
  type StreamChunk,
  type TokenUsage,
} from './model-provider.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** List prices in USD per 1M tokens (cached 2026-09-25). Unknown models are priced at 0 and logged by callers. */
export const ANTHROPIC_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cachedPerMTok: 0.2 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cachedPerMTok: 0.2 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 0.1 },
};

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicProviderOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY (the SDK also resolves other credential sources). */
  apiKey?: string;
  /** Inject a preconfigured client (tests). */
  client?: Anthropic;
  /** Server-side refusal fallbacks (`fallbacks: "default"`). Enabled by default. */
  serverSideFallbacks?: boolean;
  defaultMaxTokens?: number;
}

/**
 * Skeleton Anthropic provider. Not exercised against the real API in tests.
 *
 * - Thinking is left at the model default (adaptive on claude-opus-5-5); depth is
 *   controlled with `options.effort` -> `output_config.effort`.
 * - `stop_reason === "refusal"` is surfaced through `stopReason`; callers decide.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;
  private readonly defaultMaxTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = options.client ?? new Anthropic(apiKey ? { apiKey } : {});
    this.fallbacks = options.serverSideFallbacks ?? true;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 16_000;
  }

  estimateCost(model: string, usage: TokenUsage): CostBreakdown {
    return { modelCost: priceUsage(ANTHROPIC_PRICING[model], usage), currency: 'USD' };
  }

  private buildParams(request: CompletionRequest) {
    const effort = request.options?.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
    return {
      model: request.model || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(effort ? { output_config: { effort } } : {}),
      ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }

  private toResult(message: Anthropic.Beta.BetaMessage, model: string, startedAt: number): CompletionResult {
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage: TokenUsage = {
      // Cache writes are billed close to input price; folded into input for the MVP.
      inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      cachedTokens: message.usage.cache_read_input_tokens ?? 0,
    };
    return {
      text,
      model: message.model ?? model,
      provider: this.name,
      stopReason: message.stop_reason ?? null,
      usage,
      cost: this.estimateCost(model, usage),
      latencyMs: Date.now() - startedAt,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const params = this.buildParams(request);
    const startedAt = Date.now();
    const message = await this.client.beta.messages.create(
      { ...params, stream: false },
      request.signal ? { signal: request.signal } : undefined,
    );
    return this.toResult(message, params.model, startedAt);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const params = this.buildParams(request);
    const startedAt = Date.now();
    const stream = this.client.beta.messages.stream(params, request.signal ? { signal: request.signal } : undefined);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
    const message = await stream.finalMessage();
    yield { type: 'done', result: this.toResult(message, params.model, startedAt) };
  }
}
