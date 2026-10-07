import { describe, expect, it } from 'vitest';
import { RenderError, Semaphore, type RenderRequest, type RenderResult } from '../../src/render.js';
import { buildServer, type RenderService } from '../../src/server.js';

function fakeService(impl: (req: RenderRequest) => Promise<RenderResult>): RenderService & { calls: RenderRequest[] } {
  const calls: RenderRequest[] = [];
  return {
    calls,
    stats: { active: 0, queued: 0 },
    render: (req) => {
      calls.push(req);
      return impl(req);
    },
  };
}

const OK: RenderResult = { text: 'Conservas Ortiz', title: 'Expositores', links: [], final_url: 'https://feria.example/', status: 200, truncated: false, render_ms: 10, blocked_requests: 0, hydration_ms: 700, hydrated: true };

describe('POST /render', () => {
  it('validates the body and passes wait_ms / max_chars', async () => {
    const svc = fakeService(async () => OK);
    const app = buildServer(svc);
    const ok = await app.inject({ method: 'POST', url: '/render', payload: { url: 'https://feria.example/', wait_ms: 1000, max_chars: 5000 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(OK);
    expect(svc.calls[0]).toEqual({ url: 'https://feria.example/', waitMs: 1000, maxChars: 5000, minTextChars: undefined, waitUntil: undefined });
    const tuned = await app.inject({ method: 'POST', url: '/render', payload: { url: 'https://feria.example/', min_text_chars: 800, wait_until: 'networkidle' } });
    expect(tuned.statusCode).toBe(200);
    expect(svc.calls[1]).toMatchObject({ minTextChars: 800, waitUntil: 'networkidle' });
    for (const payload of [
      {},
      { url: '' },
      { url: 'https://x.example/', wait_ms: 60_000 },
      { url: 'https://x.example/', max_chars: 1_000_000 },
      { url: 'https://x.example/', min_text_chars: 100_000 },
      { url: 'https://x.example/', wait_until: 'commit' },
    ]) {
      const bad = await app.inject({ method: 'POST', url: '/render', payload });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect(svc.calls).toHaveLength(2);
  });

  it('maps RenderError to its HTTP status and code; hides unexpected errors', async () => {
    const app = buildServer(
      fakeService(async (req) => {
        if (req.url.includes('ssrf')) throw new RenderError('SSRF_BLOCKED', 'private', 400);
        if (req.url.includes('slow')) throw new RenderError('RENDER_TIMEOUT', 'too slow', 504);
        throw new Error('boom with internal details');
      }),
    );
    const a = await app.inject({ method: 'POST', url: '/render', payload: { url: 'https://ssrf.example/' } });
    expect([a.statusCode, a.json()]).toEqual([400, { error: { code: 'SSRF_BLOCKED', message: 'private' } }]);
    const b = await app.inject({ method: 'POST', url: '/render', payload: { url: 'https://slow.example/' } });
    expect(b.statusCode).toBe(504);
    const c = await app.inject({ method: 'POST', url: '/render', payload: { url: 'https://x.example/' } });
    expect([c.statusCode, c.json()]).toEqual([500, { error: { code: 'RENDER_FAILED', message: 'unexpected renderer error' } }]);
  });

  it('GET /health', async () => {
    const res = await buildServer(fakeService(async () => OK)).inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok', active: 0, queued: 0 });
  });
});

describe('Semaphore (max 2 renders at a time)', () => {
  it('runs at most N, queues a few, refuses the rest with RENDERER_BUSY', async () => {
    const s = new Semaphore(2, 1);
    const r1 = await s.acquire(1000);
    const r2 = await s.acquire(1000);
    expect(s.stats).toEqual({ active: 2, queued: 0 });
    const third = s.acquire(1000);
    expect(s.stats).toEqual({ active: 2, queued: 1 });
    await expect(s.acquire(1000)).rejects.toMatchObject({ code: 'RENDERER_BUSY', httpStatus: 503 });
    r1();
    const r3 = await third;
    expect(s.stats).toEqual({ active: 2, queued: 0 });
    r2();
    r3();
    expect(s.stats).toEqual({ active: 0, queued: 0 });
  });

  it('a queued request gives up after the queue timeout', async () => {
    const s = new Semaphore(1, 5);
    const r1 = await s.acquire(1000);
    await expect(s.acquire(30)).rejects.toMatchObject({ code: 'RENDERER_BUSY' });
    expect(s.stats.queued).toBe(0);
    r1();
  });
});
