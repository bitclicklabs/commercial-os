import {
  type CompletionRequest,
  type CompletionResult,
  type CostBreakdown,
  type ModelProvider,
  type StreamChunk,
  type TokenUsage,
} from './model-provider.js';
import { priceGeminiUsage } from './gemini-pricing.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiProviderOptions {
  /** Defaults to process.env.GEMINI_API_KEY. Never logged nor included in errors. */
  apiKey?: string | undefined;
  /** Model used when the request has none. Defaults to GEMINI_MODEL, then `gemini-flash-latest`. */
  defaultModel?: string | undefined;
  baseUrl?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after the first one, for 429 / 5xx / network errors. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  defaultMaxTokens?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Clock used to pick the pricing period (tests). */
  now?: () => Date;
}

/**
 * Knobs accepted in `CompletionRequest.options` (all optional):
 * - `responseSchema`: JSON Schema of the expected output. Sends
 *   `responseMimeType: application/json` + `responseJsonSchema`.
 * - `responseMimeType`: e.g. `application/json` without a schema.
 * - `temperature`, `topP`.
 * - `thinkingLevel` (`minimal` | `low` | `medium` | `high`, Gemini 3.x) or `thinkingBudget` (tokens, Gemini 2.5).
 */
export interface GeminiRequestOptions {
  responseSchema?: Record<string, unknown>;
  responseMimeType?: string;
  temperature?: number;
  topP?: number;
  thinkingLevel?: string;
  thinkingBudget?: number;
}

export type GeminiErrorCode =
  | 'GEMINI_NOT_CONFIGURED'
  | 'GEMINI_BAD_REQUEST'
  | 'GEMINI_UNAUTHORIZED'
  | 'GEMINI_NOT_FOUND'
  | 'GEMINI_RATE_LIMITED'
  | 'GEMINI_SERVER_ERROR'
  | 'GEMINI_TIMEOUT'
  | 'GEMINI_NETWORK_ERROR'
  | 'GEMINI_INVALID_RESPONSE';

export class GeminiApiError extends Error {
  constructor(
    readonly code: GeminiErrorCode,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Token usage from `usageMetadata`. Thinking tokens are billed as output. */
export function geminiUsage(meta: GeminiResponse['usageMetadata']): TokenUsage {
  const prompt = (meta?.promptTokenCount ?? 0) + (meta?.toolUsePromptTokenCount ?? 0);
  const cached = meta?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cachedTokens: cached,
  };
}

/** Delay hint from `Retry-After` or the `google.rpc.RetryInfo` detail (`"retryDelay": "17s"`). */
function retryDelayMs(res: Response, body: unknown): number | null {
  const header = res.headers.get('retry-after');
  if (header && Number.isFinite(Number(header))) return Number(header) * 1000;
  const details = (body as { error?: { details?: Array<{ retryDelay?: string }> } } | null)?.error?.details ?? [];
  for (const d of details) {
    const m = typeof d.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay) : null;
    if (m) return Number(m[1]) * 1000;
  }
  return null;
}

function classify(status: number): { code: GeminiErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'GEMINI_UNAUTHORIZED', retryable: false };
  if (status === 404) return { code: 'GEMINI_NOT_FOUND', retryable: false };
  if (status === 429) return { code: 'GEMINI_RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'GEMINI_SERVER_ERROR', retryable: true };
  return { code: 'GEMINI_BAD_REQUEST', retryable: false };
}

/**
 * Google Gemini provider over the REST API v1beta (`models/{model}:generateContent`).
 *
 * - `system` goes to `systemInstruction`; `assistant` messages are sent as role `model`.
 * - Structured output with `responseMimeType: application/json` + `responseJsonSchema`.
 * - Usage from `usageMetadata`; cost from the editable table in `gemini-pricing.ts`,
 *   priced by the concrete model in `modelVersion` (so `*-latest` aliases are priced right).
 * - Retries 429 / 5xx / network errors / timeouts with exponential backoff (honours
 *   Retry-After and RetryInfo). A generateContent call has no side effects, so retrying is safe.
 * - Costs are reported in USD, like the Anthropic provider.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini';
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly defaultMaxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: GeminiProviderOptions = {}) {
    const key = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.apiKey = key && key.length > 0 ? key : undefined;
    const envModel = process.env.GEMINI_MODEL;
    this.defaultModel = options.defaultModel || (envModel && envModel.length > 0 ? envModel : DEFAULT_GEMINI_MODEL);
    this.baseUrl = (options.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 8_192;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  /** `agent_version.model` wins; non-Gemini placeholders (e.g. `stub-model`) fall back to the default. */
  resolveModel(model: string | undefined): string {
    const m = (model ?? '').replace(/^models\//, '').trim();
    return m.startsWith('gemini') ? m : this.defaultModel;
  }

  estimateCost(model: string, usage: TokenUsage): CostBreakdown {
    return { modelCost: priceGeminiUsage(model, usage, this.now()), currency: 'USD' };
  }

  buildBody(request: CompletionRequest): Record<string, unknown> {
    const o = (request.options ?? {}) as GeminiRequestOptions;
    const generationConfig: Record<string, unknown> = { maxOutputTokens: request.maxTokens ?? this.defaultMaxTokens };
    if (o.responseSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseJsonSchema = o.responseSchema;
    } else if (o.responseMimeType) {
      generationConfig.responseMimeType = o.responseMimeType;
    }
    if (o.temperature !== undefined) generationConfig.temperature = o.temperature;
    if (o.topP !== undefined) generationConfig.topP = o.topP;
    if (o.thinkingLevel !== undefined) generationConfig.thinkingConfig = { thinkingLevel: o.thinkingLevel };
    else if (o.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: o.thinkingBudget };
    return {
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      contents: request.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new GeminiApiError('GEMINI_NOT_CONFIGURED', 'GEMINI_API_KEY is not set', null, false);
    const model = this.resolveModel(request.model);
    const startedAt = Date.now();
    const json = (await this.post(`/models/${encodeURIComponent(model)}:generateContent`, this.buildBody(request), request.signal)) as GeminiResponse;

    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const usage = geminiUsage(json.usageMetadata);
    const servedBy = json.modelVersion ? json.modelVersion.replace(/^models\//, '') : model;
    const blocked = json.promptFeedback?.blockReason;
    return {
      text,
      model: servedBy,
      provider: this.name,
      stopReason: blocked ? `BLOCKED:${blocked}` : (candidate?.finishReason ?? null),
      usage,
      cost: this.estimateCost(servedBy, usage),
      latencyMs: Date.now() - startedAt,
    };
  }

  /** Non-incremental stream: one text chunk with the full completion, then `done`. */
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    if (result.text) yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }

  private async post(path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let lastError: GeminiApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      signal?.throwIfAborted();
      let delayHint: number | null = null;
      try {
        const signals = [AbortSignal.timeout(this.timeoutMs)];
        if (signal) signals.push(signal);
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey ?? '' },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        });
        const raw = await res.text();
        let json: unknown = null;
        try {
          json = raw.length > 0 ? JSON.parse(raw) : null;
        } catch {
          json = null;
        }
        if (res.ok) {
          if (json === null) throw new GeminiApiError('GEMINI_INVALID_RESPONSE', 'Non-JSON response from Gemini', res.status, false);
          return json;
        }
        const { code, retryable } = classify(res.status);
        const apiMessage = (json as { error?: { message?: string } } | null)?.error?.message;
        lastError = new GeminiApiError(code, `Gemini ${res.status}${apiMessage ? `: ${apiMessage.slice(0, 500)}` : ''}`, res.status, retryable);
        if (!retryable) throw lastError;
        delayHint = retryDelayMs(res, json);
      } catch (err) {
        if (err instanceof GeminiApiError) {
          if (!err.retryable) throw err;
          lastError = err;
        } else {
          if (signal?.aborted) throw err;
          const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          lastError = new GeminiApiError(
            isTimeout ? 'GEMINI_TIMEOUT' : 'GEMINI_NETWORK_ERROR',
            isTimeout ? `Gemini timed out after ${this.timeoutMs} ms` : `Gemini network error: ${err instanceof Error ? err.message : String(err)}`,
            null,
            true,
          );
        }
      }
      if (attempt < this.maxRetries) {
        const backoff = this.retryBaseDelayMs * 2 ** attempt;
        await this.sleep(Math.min(delayHint ?? backoff, this.maxRetryDelayMs));
      }
    }
    throw lastError ?? new GeminiApiError('GEMINI_NETWORK_ERROR', 'Gemini request failed', null, true);
  }
}
