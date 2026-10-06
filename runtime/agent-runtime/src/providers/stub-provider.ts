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
  /**
   * Scripted texts returned in order, one per completion (tests). When exhausted,
   * `responseText` is returned.
   */
  responses?: string[];
  /** Usage reported by every completion (defaults to zero, as required for MVP traces). */
  usage?: TokenUsage;
  /** Cost reported by every completion (defaults to 0). */
  costPerCall?: number;
}

/** Deterministic provider without network access. Zero tokens and zero cost by default. */
export class StubProvider implements ModelProvider {
  readonly name = 'stub';
  private readonly responseText: string;
  private readonly responses: string[];
  private readonly usage: TokenUsage;
  private readonly costPerCall: number;
  /** Requests received, in order (tests). */
  readonly requests: CompletionRequest[] = [];

  constructor(options: StubProviderOptions = {}) {
    this.responseText = options.responseText ?? 'stub-response';
    this.responses = [...(options.responses ?? [])];
    this.usage = options.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    this.costPerCall = options.costPerCall ?? 0;
  }

  estimateCost(_model: string, _usage: TokenUsage): CostBreakdown {
    return { modelCost: this.costPerCall, currency: 'USD' };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    request.signal?.throwIfAborted();
    this.requests.push(request);
    return {
      text: this.responses.shift() ?? this.responseText,
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
