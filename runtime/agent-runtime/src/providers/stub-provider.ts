import type {
  CompletionRequest,
  CompletionResult,
  CostBreakdown,
  GroundingResult,
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
  responses?: Array<string | StubResponse>;
  /** Usage reported by every completion (defaults to zero, as required for MVP traces). */
  usage?: TokenUsage;
  /** Cost reported by every completion (defaults to 0). */
  costPerCall?: number;
}

/** Scripted response with optional grounding metadata (only returned when the request asks for `grounding`). */
export interface StubResponse {
  text: string;
  grounding?: GroundingResult;
  /** Overrides `costPerCall` for this response. */
  cost?: number;
}

/** Deterministic provider without network access. Zero tokens and zero cost by default. */
export class StubProvider implements ModelProvider {
  readonly name = 'stub';
  private readonly responseText: string;
  private readonly responses: Array<string | StubResponse>;
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
    const next = this.responses.shift() ?? this.responseText;
    const scripted: StubResponse = typeof next === 'string' ? { text: next } : next;
    const wantsGrounding = (request.options as { grounding?: unknown } | undefined)?.grounding === true;
    const cost = this.estimateCost(request.model, this.usage);
    if (scripted.cost !== undefined) cost.modelCost = scripted.cost;
    return {
      text: scripted.text,
      model: request.model,
      provider: this.name,
      stopReason: 'end_turn',
      usage: { ...this.usage },
      cost,
      latencyMs: 0,
      ...(wantsGrounding ? { grounding: scripted.grounding ?? { queries: [], sources: [] } } : {}),
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
