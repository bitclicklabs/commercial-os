import { describe, expect, it } from 'vitest';
import { TwentyClient } from '../../src/integrations/twenty/index.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolRegistry, defineTool } from '../../src/tools/index.js';
import { z } from 'zod';
import {
  TwentyGate,
  TwentyHealthCache,
  policyRequiresTwenty,
  twentyGateFromEnv,
  type TwentyHealthProbe,
  type TwentyWaitState,
} from '../../src/worker/twenty-gate.js';

/** Manual clock + scripted health answers. */
function setup(answers: boolean[], opts: { configured?: boolean; maxWaitMs?: number; healthCacheMs?: number } = {}) {
  let t = 1_000_000;
  let calls = 0;
  const probe: TwentyHealthProbe = {
    isConfigured: () => opts.configured ?? true,
    health: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)]!;
      calls += 1;
      return answer;
    },
  };
  const gate = new TwentyGate(probe, {
    maxWaitMs: opts.maxWaitMs ?? 600_000,
    healthCacheMs: opts.healthCacheMs ?? 0,
    jitterMs: 0,
    now: () => t,
  });
  return {
    gate,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
    calls: () => calls,
  };
}

describe('TwentyGate decision', () => {
  it('proceeds without probing when the policy has no Twenty tools', async () => {
    const s = setup([false]);
    expect(await s.gate.check(false)).toEqual({ action: 'proceed', reason: 'not_required' });
    expect(s.calls()).toBe(0);
  });

  it('proceeds without probing when Twenty has no API key (tools answer TWENTY_NOT_CONFIGURED)', async () => {
    const s = setup([false], { configured: false });
    expect(await s.gate.check(true)).toEqual({ action: 'proceed', reason: 'not_configured' });
    expect(s.calls()).toBe(0);
  });

  it('TWENTY_WAIT_MAX_MS=0 disables the gate', async () => {
    const s = setup([false], { maxWaitMs: 0 });
    expect(await s.gate.check(true)).toMatchObject({ action: 'proceed' });
    expect(s.calls()).toBe(0);
  });

  it('healthy Twenty: proceeds', async () => {
    const s = setup([true]);
    expect(await s.gate.check(true)).toEqual({ action: 'proceed', reason: 'healthy' });
  });

  it('Twenty down: defers with growing backoff 5s, 15s, 30s, 60s, 60s...', async () => {
    const s = setup([false]);
    let state: TwentyWaitState | undefined;
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = await s.gate.check(true, state);
      if (d.action !== 'defer') throw new Error(`expected defer, got ${JSON.stringify(d)}`);
      delays.push(d.delayMs);
      state = d.state;
      s.advance(d.delayMs);
    }
    expect(delays).toEqual([5_000, 15_000, 30_000, 60_000, 60_000, 60_000]);
    expect(state).toEqual({ since: 1_000_000, deferrals: 6 });
  });

  it('Twenty down then healthy: defers, then proceeds', async () => {
    const s = setup([false, false, true]);
    const d1 = await s.gate.check(true);
    expect(d1).toMatchObject({ action: 'defer', delayMs: 5_000, waitedMs: 0, state: { deferrals: 1 } });
    s.advance(5_000);
    const d2 = await s.gate.check(true, d1.action === 'defer' ? d1.state : undefined);
    expect(d2).toMatchObject({ action: 'defer', delayMs: 15_000, waitedMs: 5_000, state: { deferrals: 2 } });
    s.advance(15_000);
    expect(await s.gate.check(true, d2.action === 'defer' ? d2.state : undefined)).toEqual({ action: 'proceed', reason: 'healthy' });
  });

  it('wait cap exceeded: proceeds anyway; the last delay never overshoots the cap', async () => {
    const s = setup([false], { maxWaitMs: 40_000 });
    let state: TwentyWaitState | undefined;
    const delays: number[] = [];
    for (;;) {
      const d = await s.gate.check(true, state);
      if (d.action === 'proceed') {
        expect(d).toEqual({ action: 'proceed', reason: 'wait_exceeded', waitedMs: 40_000, deferrals: 3 });
        break;
      }
      delays.push(d.delayMs);
      state = d.state;
      s.advance(d.delayMs);
    }
    // 5s + 15s + (30s clamped to the 20s left) = 40s
    expect(delays).toEqual([5_000, 15_000, 20_000]);
  });

  it('caches the health result so concurrent jobs share one /healthz probe', async () => {
    const s = setup([false, true], { healthCacheMs: 5_000 });
    const results = await Promise.all([s.gate.check(true), s.gate.check(true), s.gate.check(true)]);
    expect(results.every((r) => r.action === 'defer')).toBe(true);
    expect(s.calls()).toBe(1);
    s.advance(4_999);
    expect((await s.gate.check(true)).action).toBe('defer');
    expect(s.calls()).toBe(1);
    s.advance(1);
    expect(await s.gate.check(true)).toEqual({ action: 'proceed', reason: 'healthy' });
    expect(s.calls()).toBe(2);
  });
});

describe('TwentyHealthCache', () => {
  it('treats a throwing probe as unhealthy', async () => {
    const cache = new TwentyHealthCache(async () => {
      throw new Error('boom');
    }, 0);
    expect(await cache.healthy()).toBe(false);
  });
});

describe('policyRequiresTwenty', () => {
  const registry = createDefaultToolRegistry({ twenty: new TwentyClient({ baseUrl: 'http://twenty.test', apiKey: 'k' }) });

  it('is true when an allowed, enabled tool is a Twenty tool', () => {
    expect(policyRequiresTwenty(registry, parseToolPolicy({ tool_policy: ['find_company'] }))).toBe(true);
    expect(policyRequiresTwenty(registry, parseToolPolicy({ tool_policy: { allow: ['create_signal'] } }))).toBe(true);
  });

  it('is false for no policy, unknown tools, or tools above the risk ceiling', () => {
    expect(policyRequiresTwenty(registry, parseToolPolicy({}))).toBe(false);
    expect(policyRequiresTwenty(registry, parseToolPolicy({ tool_policy: ['search_web'] }))).toBe(false);
    const other = new ToolRegistry();
    other.register(
      defineTool({
        id: 'local_tool',
        name: 'Local',
        version: '1.0.0',
        description: 'no Twenty',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        riskLevel: 'READ',
        sideEffects: false,
        approvalPolicy: { mode: 'NONE' },
        permissions: ['local:read'],
        timeoutMs: 1_000,
        outputTrust: 'trusted',
        enabled: true,
        execute: async () => ({ status: 'ok', output: {} }),
      }),
    );
    expect(policyRequiresTwenty(other, parseToolPolicy({ tool_policy: ['local_tool'] }))).toBe(false);
  });
});

describe('TwentyClient.health()', () => {
  function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new TwentyClient({
      baseUrl: 'http://twenty.test/',
      apiKey: 'secret-key',
      fetch: (async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return handler(String(input), init ?? {});
      }) as typeof fetch,
    });
    return { c, calls };
  }

  it('GETs /healthz once, without the API key, and is true on 2xx', async () => {
    const { c, calls } = client(() => new Response('{"status":"ok"}', { status: 200 }));
    expect(await c.health()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://twenty.test/healthz');
    expect(JSON.stringify(calls[0]!.init.headers ?? {})).not.toContain('secret-key');
  });

  it('is false on 503 and on network errors, with no retries', async () => {
    const down = client(() => new Response('{"status":"error"}', { status: 503 }));
    expect(await down.c.health()).toBe(false);
    expect(down.calls).toHaveLength(1);
    const refused = client(() => {
      throw new TypeError('fetch failed');
    });
    expect(await refused.c.health()).toBe(false);
    expect(refused.calls).toHaveLength(1);
  });

  it('times out quickly against a server that never answers', async () => {
    const { c } = client((_url, init) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const started = Date.now();
    expect(await c.health(100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('twentyGateFromEnv', () => {
  it('reads TWENTY_WAIT_MAX_MS (default 10 min, 0 allowed, garbage ignored)', () => {
    expect(twentyGateFromEnv({}).maxWaitMs).toBe(600_000);
    expect(twentyGateFromEnv({ TWENTY_WAIT_MAX_MS: '30000' }).maxWaitMs).toBe(30_000);
    expect(twentyGateFromEnv({ TWENTY_WAIT_MAX_MS: '0' }).maxWaitMs).toBe(0);
    expect(twentyGateFromEnv({ TWENTY_WAIT_MAX_MS: 'soon' }).maxWaitMs).toBe(600_000);
  });
});
