import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { StubAgent } from '../../src/agents/stub-agent.js';
import { AnthropicProvider, createProviderRegistry, priceUsage, StubProvider } from '../../src/providers/index.js';

function ctx(provider = new StubProvider()) {
  return {
    tenantId: 't1',
    executionId: 'e1',
    agent: { id: 'a1', name: 'Prospector', role: 'prospecting' },
    version: { id: 'v1', version: 1, model: 'stub-model', modelProvider: 'stub', systemPrompt: '', configuration: {} },
    input: { query: 'ferias 2027' },
    provider,
    signal: new AbortController().signal,
  };
}

describe('StubAgent', () => {
  it('returns a fixed result with THINK -> TOOL -> FINAL steps and zero usage', async () => {
    const result = await new StubAgent().run(ctx());
    expect(result.steps.map((s) => s.type)).toEqual(['THINK', 'TOOL', 'FINAL']);
    expect(result.steps[1]?.tool).toBe('stub.lookup');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(result.modelCost + result.toolCost).toBe(0);
    expect(result.output).toMatchObject({ status: 'ok', agent: 'Prospector', summary: 'stub-response' });
  });

  it('honours cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new StubAgent().run({ ...ctx(), signal: controller.signal })).rejects.toThrow();
  });
});

describe('StubProvider', () => {
  it('streams text and finishes with a zero-cost result', async () => {
    const chunks: string[] = [];
    let done = false;
    for await (const c of new StubProvider({ responseText: 'hola mundo' }).stream({ model: 'm', messages: [] })) {
      if (c.type === 'text') chunks.push(c.text);
      else {
        done = true;
        expect(c.result.cost.modelCost).toBe(0);
      }
    }
    expect(chunks.join('')).toBe('hola mundo');
    expect(done).toBe(true);
  });
});

describe('AnthropicProvider (no network)', () => {
  it('prices usage from the pricing table', () => {
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const cost = p.estimateCost('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 });
    expect(cost).toEqual({ modelCost: 6, currency: 'USD' });
    expect(p.estimateCost('unknown-model', { inputTokens: 10, outputTokens: 10, cachedTokens: 0 }).modelCost).toBe(0);
  });

  it('maps an SDK response into a CompletionResult using an injected client', async () => {
    let sentParams: Record<string, unknown> | undefined;
    const fakeClient = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            sentParams = params;
            return {
              model: 'claude-opus-5-5',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            };
          },
        },
      },
    } as unknown as Anthropic;
    const p = new AnthropicProvider({ client: fakeClient });
    const res = await p.complete({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], options: { effort: 'low' } });
    expect(res.text).toBe('ok');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedTokens: 0 });
    expect(res.cost.modelCost).toBeCloseTo(0.0014, 6);
    expect(sentParams).toMatchObject({ output_config: { effort: 'low' }, fallbacks: 'default' });
  });
});

describe('provider registry', () => {
  it('builds known providers lazily and rejects unknown ones', () => {
    const get = createProviderRegistry();
    expect(get('stub')).toBe(get('stub'));
    expect(() => get('nope')).toThrow(/Unknown model provider/);
  });

  it('priceUsage is zero without pricing', () => {
    expect(priceUsage(undefined, { inputTokens: 5, outputTokens: 5, cachedTokens: 5 })).toBe(0);
  });
});
