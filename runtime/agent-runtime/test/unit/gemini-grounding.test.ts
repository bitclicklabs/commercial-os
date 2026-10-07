import { describe, expect, it } from 'vitest';
import { GeminiProvider, parseGroundingMetadata, priceGrounding, resolveGroundingPricing } from '../../src/providers/index.js';

const groundedBody = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: '{"events":[]}' }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['ferias alimentación España 2027', 'salón gourmets 2027 expositores'],
        searchEntryPoint: { renderedContent: '<div>...</div>' },
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'gourmets.net' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', title: 'Alimentaria 2028 - Expositores', domain: 'www.alimentaria.com' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'dup' } },
          { web: { uri: 'javascript:alert(1)', title: 'x.com' } },
          { retrievedContext: { uri: 'gs://x' } },
        ],
        groundingSupports: [{ segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] }],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 200, toolUsePromptTokenCount: 800, candidatesTokenCount: 300, thoughtsTokenCount: 0 },
  modelVersion: 'gemini-3.8-flash',
};

function provider(body: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const p = new GeminiProvider({
    apiKey: 'test-key',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    now: () => new Date('2026-10-07T10:00:00Z'),
  });
  return { p, calls };
}

describe('Gemini grounding (google_search)', () => {
  it('sends the google_search tool only when grounding: true, never in systemInstruction', () => {
    const { p } = provider(groundedBody);
    const req = { model: 'gemini-flash-latest', system: 'sys', messages: [{ role: 'user' as const, content: 'busca' }] };
    expect(p.buildBody(req)).not.toHaveProperty('tools');
    expect(p.buildBody({ ...req, options: { grounding: false } })).not.toHaveProperty('tools');
    const body = p.buildBody({ ...req, options: { grounding: true } });
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.toolConfig).toEqual({ includeServerSideToolInvocations: true });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
  });

  it('parses groundingMetadata: queries + deduplicated http(s) web sources with domains', () => {
    expect(parseGroundingMetadata(groundedBody.candidates[0]!.groundingMetadata)).toEqual({
      queries: ['ferias alimentación España 2027', 'salón gourmets 2027 expositores'],
      sources: [
        { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'gourmets.net', domain: 'gourmets.net' },
        { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', title: 'Alimentaria 2028 - Expositores', domain: 'alimentaria.com' },
      ],
      diagnostics: { metadata: true, toolCalls: 0, toolResponses: 0 },
    });
    expect(parseGroundingMetadata(undefined)).toEqual({ queries: [], sources: [], diagnostics: { metadata: false, toolCalls: 0, toolResponses: 0 } });
  });

  it('also reads server-side GOOGLE_SEARCH_WEB toolCall / toolResponse parts (no groundingMetadata)', () => {
    const parts = [
      { toolCall: { id: '1', toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['feria alimentación España 2027'] } } },
      {
        toolResponse: {
          id: '1',
          toolType: 'GOOGLE_SEARCH_WEB',
          response: { results: [{ title: 'Anuga Select Ibérica', url: 'https://www.ifema.es/anuga-select-iberica' }, { nested: { link: 'https://www.gourmets.net/' } }, { url: 'ftp://x' }] },
        },
      },
      { toolCall: { toolType: 'URL_CONTEXT', args: { queries: ['ignored'] } } },
      { text: '{"events":[]}' },
    ];
    expect(parseGroundingMetadata(undefined, parts)).toEqual({
      queries: ['feria alimentación España 2027'],
      sources: [
        { uri: 'https://www.ifema.es/anuga-select-iberica', title: 'Anuga Select Ibérica', domain: 'ifema.es' },
        { uri: 'https://www.gourmets.net/', title: null, domain: 'gourmets.net' },
      ],
      diagnostics: { metadata: false, toolCalls: 1, toolResponses: 1 },
    });
  });

  it('prices grounding per search query on Gemini 3.x ($14 / 1,000) and per prompt on 2.5 ($35 / 1,000)', () => {
    expect(resolveGroundingPricing('gemini-3.8-flash')).toEqual({ unit: 'search_query', perThousand: 14 });
    expect(resolveGroundingPricing('gemini-flash-latest')).toEqual({ unit: 'search_query', perThousand: 14 });
    expect(priceGrounding('gemini-3.8-flash', { queries: 2, sources: 5 })).toEqual({ cost: 0.028, units: 2 });
    expect(priceGrounding('gemini-3.8-flash', { queries: 0, sources: 0 })).toEqual({ cost: 0, units: 0 });
    expect(priceGrounding('gemini-2.5-flash', { queries: 3, sources: 5 })).toEqual({ cost: 0.035, units: 1 });
  });

  it('returns grounding with the result and adds the search cost to modelCost', async () => {
    const { p, calls } = provider(groundedBody);
    const r = await p.complete({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'busca' }], options: { grounding: true } });
    expect(calls[0]!.body.tools).toEqual([{ google_search: {} }]);
    expect(r.grounding?.queries).toHaveLength(2);
    expect(r.grounding?.sources).toHaveLength(2);
    // Tokens: 1000 in x 0.75 + 300 out x 3.75 per 1M = 0.001875; search: 2 x 0.014 = 0.028.
    expect(r.cost.groundingCost).toBe(0.028);
    expect(r.cost.groundingUnits).toBe(2);
    expect(r.cost.modelCost).toBeCloseTo(0.001875 + 0.028, 6);
  });

  it('no grounding requested: no grounding field and token-only cost even if metadata is present', async () => {
    const { p } = provider(groundedBody);
    const r = await p.complete({ model: 'gemini-flash-latest', messages: [{ role: 'user', content: 'x' }] });
    expect(r.grounding).toBeUndefined();
    expect(r.cost.groundingCost).toBeUndefined();
    expect(r.cost.modelCost).toBeCloseTo(0.001875, 6);
  });
});
