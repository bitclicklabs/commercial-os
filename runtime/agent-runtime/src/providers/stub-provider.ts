import type {
  CompletionRequest,
  CompletionResult,
  CostBreakdown,
  ModelProvider,
  StreamChunk,
  TokenUsage,
} from './model-provider.js';

export interface StubProviderOptions {
  /** Fixed text returned by every completion. */
  responseText?: string;
  /** Usage reported by every completion (defaults to zero, as required for MVP traces). */
  usage?: TokenUsage;
}

/** Deterministic provider without network access. Zero tokens and zero cost by default. */
export class StubProvider implements ModelProvider {
  readonly name = 'stub';
  private readonly responseText: string;
  private readonly usage: TokenUsage;

  constructor(options: StubProviderOptions = {}) {
    this.responseText = options.responseText ?? 'stub-response';
    this.usage = options.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  }

  estimateCost(_model: string, _usage: TokenUsage): CostBreakdown {
    return { modelCost: 0, currency: 'USD' };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    request.signal?.throwIfAborted();
    return {
      text: this.responseText,
      model: request.model,
      provider: this.name,
      stopReason: 'end_turn',
      usage: { ...this.usage },
      cost: this.estimateCost(request.model, this.usage),
      latencyMs: 0,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    for (const word of result.text.split(/(\s+)/)) {
      if (word) yield { type: 'text', text: word };
    }
    yield { type: 'done', result };
  }
}
