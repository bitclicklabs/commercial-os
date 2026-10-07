import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRenderUrlTool, DEFAULT_RENDERER_URL, renderPublicUrl, rendererUrlFromEnv, ToolExecutor, ToolRegistry } from '../../src/tools/index.js';
import { FakeRenderer } from '../helpers/fake-renderer.js';

const signal = () => new AbortController().signal;
const OPEN = { allow: [], deny: [], allowedPorts: [80, 443, 8080, 8443] };

describe('render_url: configuration', () => {
  it('RENDERER_URL: unset -> pxos-renderer, empty/off -> not configured', () => {
    expect(rendererUrlFromEnv({})).toBe(DEFAULT_RENDERER_URL);
    expect(DEFAULT_RENDERER_URL).toBe('http://pxos-renderer:3000');
    expect(rendererUrlFromEnv({ RENDERER_URL: 'http://127.0.0.1:4030/' })).toBe('http://127.0.0.1:4030');
    for (const off of ['', ' ', 'off', 'none', 'disabled', 'ftp://x', 'not a url']) expect(rendererUrlFromEnv({ RENDERER_URL: off })).toBeNull();
  });

  it('not configured -> RENDERER_NOT_CONFIGURED without any request', async () => {
    const fake = new FakeRenderer();
    const r = await renderPublicUrl('https://feria.example/', { ...fake.deps(), endpoint: null }, signal());
    expect(r).toMatchObject({ status: 'error', code: 'RENDERER_NOT_CONFIGURED', retryable: false });
    expect(fake.requests).toHaveLength(0);
  });

  it('renderer unreachable -> RENDERER_NOT_CONFIGURED (the scout carries on)', async () => {
    const refused = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    const r = await renderPublicUrl('https://feria.example/', { endpoint: 'http://pxos-renderer:3000', fetch: refused as typeof fetch, policy: OPEN }, signal());
    expect(r).toMatchObject({ status: 'error', code: 'RENDERER_NOT_CONFIGURED' });
    if (r.status === 'error') expect(r.message).toContain('ECONNREFUSED');
  });
});

describe('render_url: guards and answer validation', () => {
  it('refuses private, internal and non-http targets before calling the renderer', async () => {
    const fake = new FakeRenderer();
    for (const url of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'https://pxos-renderer/', 'https://intranet.corp/', 'https://feria.example:22/']) {
      expect(await renderPublicUrl(url, fake.deps(), signal()), url).toMatchObject({ status: 'error', code: 'URL_NOT_ALLOWED' });
    }
    expect(await renderPublicUrl('not a url', fake.deps(), signal())).toMatchObject({ code: 'INVALID_URL' });
    expect(fake.requests).toHaveLength(0);
  });

  it('honours the FETCH_URL host denylist', async () => {
    const fake = new FakeRenderer();
    const r = await renderPublicUrl('https://www.evil.example/', fake.deps({ policy: { ...OPEN, deny: ['evil.example'] } }), signal());
    expect(r).toMatchObject({ code: 'URL_NOT_ALLOWED' });
    expect(fake.requests).toHaveLength(0);
  });

  it('returns the rendered text (content_kind = "rendered"), capped, with clean links', async () => {
    const fake = new FakeRenderer().page('https://catalogo.example/app', {
      text: `  Expositores\n${'x'.repeat(50_000)}`,
      title: '  Catálogo   2027 ',
      links: [
        { url: 'https://www.conservasortiz.com/#stand', text: '  Conservas   Ortiz ' },
        { url: 'https://www.conservasortiz.com/', text: 'dup' },
        { url: 'javascript:alert(1)', text: 'x' },
        { url: 'mailto:a@b.example', text: 'mail' },
        { url: 'no-url', text: 'x' },
      ],
      final_url: 'https://catalogo.example/app#/home',
    });
    const r = await renderPublicUrl('https://catalogo.example/app', fake.deps(), signal(), { maxChars: 1_000, waitMs: 500, minTextChars: 300, waitUntil: 'networkidle' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.output).toMatchObject({ content_kind: 'rendered', finalUrl: 'https://catalogo.example/app', title: 'Catálogo 2027', truncated: true, redirects: [] });
    expect(r.output.text.length).toBe(1_000);
    expect(r.output.text.startsWith('Expositores')).toBe(true);
    expect(r.output.links).toEqual([{ url: 'https://www.conservasortiz.com/', text: 'Conservas Ortiz' }]);
    expect(fake.requests[0]).toEqual({ url: 'https://catalogo.example/app', max_chars: 1_000, wait_ms: 500, min_text_chars: 300, wait_until: 'networkidle' });
  });

  it('maps renderer errors and refuses answers that break the contract', async () => {
    const fake = new FakeRenderer()
      .error('https://a.example/', 400, 'SSRF_BLOCKED', 'a.example resolves to a non-public address')
      .error('https://b.example/', 504, 'RENDER_TIMEOUT', 'navigation exceeded 25000 ms')
      .error('https://c.example/', 503, 'RENDERER_BUSY', 'queue full')
      .raw('https://d.example/', 200, { hello: 'world' })
      .page('https://e.example/', { text: 'x', final_url: 'http://192.168.1.1/admin' })
      .raw('https://f.example/', 500, 'not json');
    expect(await renderPublicUrl('https://a.example/', fake.deps(), signal())).toMatchObject({ code: 'SSRF_BLOCKED', retryable: false });
    expect(await renderPublicUrl('https://b.example/', fake.deps(), signal())).toMatchObject({ code: 'RENDER_TIMEOUT', retryable: true });
    expect(await renderPublicUrl('https://c.example/', fake.deps(), signal())).toMatchObject({ code: 'RENDERER_BUSY', retryable: true });
    expect(await renderPublicUrl('https://d.example/', fake.deps(), signal())).toMatchObject({ code: 'RENDERER_BAD_RESPONSE' });
    expect(await renderPublicUrl('https://e.example/', fake.deps(), signal())).toMatchObject({ code: 'REDIRECT_NOT_ALLOWED' });
    expect(await renderPublicUrl('https://f.example/', fake.deps(), signal())).toMatchObject({ code: 'RENDERER_BAD_RESPONSE' });
  });

  it('times out with RENDER_TIMEOUT', async () => {
    const slow = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const r = await renderPublicUrl('https://slow.example/', { endpoint: 'http://r.test', fetch: slow as typeof fetch, policy: OPEN, timeoutMs: 50 }, signal());
    expect(r).toMatchObject({ code: 'RENDER_TIMEOUT', retryable: true });
  });

  it('is a READ tool with untrusted output, run through the executor', async () => {
    const fake = new FakeRenderer().page('https://catalogo.example/', { text: 'Conservas Ortiz', final_url: 'https://catalogo.example/' });
    const registry = new ToolRegistry();
    registry.register(createRenderUrlTool(fake.deps()));
    const exec = new ToolExecutor(registry, { allow: ['render_url'], maxCallsPerExecution: 5, maxRiskLevel: 'READ' }, { tenantId: 't', executionId: 'e', agentId: 'a', stage: null }, signal());
    const ok = await exec.call('render_url', { url: 'https://catalogo.example/' });
    expect(ok.result).toMatchObject({ status: 'ok', output: { text: 'Conservas Ortiz' } });
    expect(ok.step.output).toMatchObject({ riskLevel: 'READ', sourceTrust: 'untrusted' });
    expect((await exec.call('render_url', { url: 'data:text/html,<h1>x</h1>' })).result).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('render_url against a real HTTP renderer stub', () => {
  let server: Server;
  let endpoint: string;
  const bodies: unknown[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: JSON.parse(raw) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'Bodegas Torres', title: 'Lista', links: [], final_url: 'https://feria.example/lista', status: 200, render_ms: 1234.4 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('POSTs JSON to {RENDERER_URL}/render (the renderer endpoint itself is trusted configuration)', async () => {
    const r = await renderPublicUrl('https://feria.example/lista', { endpoint, policy: OPEN }, signal());
    expect(r).toMatchObject({ status: 'ok', output: { text: 'Bodegas Torres', status: 200, renderMs: 1234 } });
    expect(bodies[0]).toEqual({ method: 'POST', path: '/render', type: 'application/json', body: { url: 'https://feria.example/lista', max_chars: 40_000 } });
  });
});
