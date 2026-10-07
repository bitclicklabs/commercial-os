import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderRegistry,
  DEFAULT_GEMINI_MODEL,
  GeminiApiError,
  GeminiProvider,
  geminiUsage,
  resolveGeminiPricing,
} from '../../src/providers/index.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const okBody = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'pensando...', thought: true }, { text: '{"ok":' }, { text: 'true}' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 400, thoughtsTokenCount: 100, totalTokenCount: 1500 },
  modelVersion: 'gemini-3.8-flash',
};

function provider(responses: Array<() => Response | Promise<Response>>, extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const p = new GeminiProvider({
    apiKey: 'test-key',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error('no more fake responses');
      return next();
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date('2026-10-06T10:00:00Z'),
    ...extra,
  });
  return { p, calls, sleeps };
}

describe('GeminiProvider', () => {
  const savedModel = process.env.GEMINI_MODEL;
  afterEach(() => {
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
  });

  it('builds the generateContent body: systemInstruction, roles, JSON schema and thinking', () => {
    const { p } = provider([]);
    const body = p.buildBody({
      model: 'gemini-flash-latest',
      system: 'Eres el Prospector',
      messages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: '{}' },
      ],
      maxTokens: 512,
      options: { responseSchema: { type: 'object' }, thinkingLevel: 'low', temperature: 0.2 },
    });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'Eres el Prospector' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hola' }] },
        { role: 'model', parts: [{ text: '{}' }] },
      ],
      generationConfig: {
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        temperature: 0.2,
        thinkingConfig: { thinkingLevel: 'low' },
      },
    });
  });

  it('maps text (without thought parts), usage (thinking billed as output) and cost by modelVersion', async () => {
    const { p, calls } = provider([() => jsonResponse(200, okBody)]);
    const res = await p.complete({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'hola' }] });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    expect(calls[0]!.url).not.toContain('test-key');
    expect(res.text).toBe('{"ok":true}');
    expect(res.model).toBe('gemini-3.8-flash');
    expect(res.provider).toBe('gemini');
    expect(res.stopReason).toBe('STOP');
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cachedTokens: 0 });
    // 1000 * 0.75/1M + 500 * 3.75/1M
    expect(res.cost).toEqual({ modelCost: 0.002625, currency: 'USD' });
  });

  it('retries 429 honouring RetryInfo and 5xx with exponential backoff', async () => {
    const { p, calls, sleeps } = provider([
      () => jsonResponse(429, { error: { code: 429, message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }] } }),
      () => jsonResponse(503, { error: { code: 503, message: 'overloaded' } }),
      () => jsonResponse(200, okBody),
    ]);
    const res = await p.complete({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('{"ok":true}');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]); // RetryInfo 2s, then base 1000 * 2^1
  });

  it('does not retry a 400 and never leaks the key in the error', async () => {
    const { p, calls } = provider([() => jsonResponse(400, { error: { code: 400, message: 'Invalid JSON payload' } })]);
    const err = await p.complete({ model: 'gemini-2.5-flash', messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiApiError);
    expect((err as GeminiApiError).code).toBe('GEMINI_BAD_REQUEST');
    expect((err as GeminiApiError).message).not.toContain('test-key');
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    const { p, calls } = provider(
      Array.from({ length: 3 }, () => () => jsonResponse(500, { error: { message: 'boom' } })),
      { maxRetries: 2 },
    );
    const err = await p.complete({ model: 'gemini-2.5-flash', messages: [] }).catch((e: unknown) => e);
    expect((err as GeminiApiError).code).toBe('GEMINI_SERVER_ERROR');
    expect((err as GeminiApiError).retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('fails fast without API key (an empty key does not fall back to the environment)', async () => {
    const { p, calls } = provider([], { apiKey: '' });
    expect(p.isConfigured()).toBe(false);
    await expect(p.complete({ model: 'gemini-2.5-flash', messages: [] })).rejects.toMatchObject({ code: 'GEMINI_NOT_CONFIGURED' });
    expect(calls).toHaveLength(0);
  });

  it('resolves the model: agent_version.model > GEMINI_MODEL > gemini-flash-latest', () => {
    delete process.env.GEMINI_MODEL;
    expect(new GeminiProvider({ apiKey: 'k' }).resolveModel('stub-model')).toBe(DEFAULT_GEMINI_MODEL);
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';
    const p = new GeminiProvider({ apiKey: 'k' });
    expect(p.resolveModel('')).toBe('gemini-2.5-flash');
    expect(p.resolveModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(new GeminiProvider({ apiKey: 'k', defaultModel: 'gemini-3.5-flash' }).resolveModel(undefined)).toBe('gemini-3.5-flash');
  });

  it('is available from the provider factory without breaking stub/anthropic', () => {
    const factory = createProviderRegistry({ geminiApiKey: 'k', geminiModel: 'gemini-2.5-flash' });
    const g = factory('gemini') as GeminiProvider;
    expect(g.name).toBe('gemini');
    expect(g.defaultModel).toBe('gemini-2.5-flash');
    expect(factory('gemini')).toBe(g);
    expect(factory('stub').name).toBe('stub');
    expect(factory('anthropic').name).toBe('anthropic');
    expect(() => factory('openai')).toThrow(/Unknown model provider/);
  });
});

describe('Gemini pricing table', () => {
  it('prices aliases, versioned ids and date periods', () => {
    expect(resolveGeminiPricing('gemini-flash-latest', new Date('2026-10-06'))).toMatchObject({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    expect(resolveGeminiPricing('models/gemini-2.5-flash')).toMatchObject({ inputPerMTok: 0.3, outputPerMTok: 2.5 });
    expect(resolveGeminiPricing('gemini-3.8-flash', new Date('2027-01-01'))).toMatchObject({ inputPerMTok: 1.5, outputPerMTok: 7.5 });
    expect(resolveGeminiPricing('gemini-unknown')).toBeUndefined();
  });

  it('subtracts cached tokens from input', () => {
    expect(geminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10 })).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      cachedTokens: 40,
    });
  });
});
