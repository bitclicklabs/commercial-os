import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTarget, deliverableResponseHeaders, forwardableRequestHeaders } from '../../src/egress.js';
import { Renderer } from '../../src/render.js';
import { FakeWeb } from '../helpers/fake-web.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('egress guard: checkTarget (same rules as fetch_url)', () => {
  const web = new FakeWeb()
    .host('feria.example', '93.184.216.34')
    .host('priv.example', '10.0.0.7')
    .host('meta.example', '169.254.169.254')
    .host('mixed.example', '93.184.216.34', '127.0.0.1')
    .host('mapped.example', '::ffff:192.168.1.1')
    .host('v6.example', '2606:2800:220:1:248:1893:25c8:1946');

  it('accepts public hosts and returns the pinned address', async () => {
    expect(await checkTarget('https://feria.example/expositores', web.deps())).toEqual({ ok: true, address: { address: '93.184.216.34', family: 4 } });
    expect(await checkTarget('https://v6.example/', web.deps())).toMatchObject({ ok: true, address: { family: 6 } });
  });

  it.each([
    ['data:text/html,<h1>hola</h1>', 'URL_NOT_ALLOWED'],
    ['file:///etc/passwd', 'URL_NOT_ALLOWED'],
    ['javascript:alert(1)', 'URL_NOT_ALLOWED'],
    ['ftp://feria.example/', 'URL_NOT_ALLOWED'],
    ['http://localhost:4030/health', 'URL_NOT_ALLOWED'],
    ['http://pxos-runtime:4020/', 'URL_NOT_ALLOWED'],
    ['http://api.internal/', 'URL_NOT_ALLOWED'],
    ['http://127.0.0.1/', 'URL_NOT_ALLOWED'],
    ['http://[::1]/', 'URL_NOT_ALLOWED'],
    ['http://169.254.169.254/latest/meta-data/', 'URL_NOT_ALLOWED'],
    ['http://[::ffff:10.0.0.1]/', 'URL_NOT_ALLOWED'],
    ['http://user:pw@feria.example/', 'URL_NOT_ALLOWED'],
    ['http://feria.example:6379/', 'URL_NOT_ALLOWED'],
    ['https://priv.example/', 'SSRF_BLOCKED'],
    ['https://meta.example/', 'SSRF_BLOCKED'],
    ['https://mixed.example/', 'SSRF_BLOCKED'],
    ['https://mapped.example/', 'SSRF_BLOCKED'],
    ['not a url', 'INVALID_URL'],
  ])('refuses %s (%s)', async (url, code) => {
    expect(await checkTarget(url, web.deps())).toMatchObject({ ok: false, code });
  });

  it('honours the host denylist / allowlist and reports DNS failures', async () => {
    const deny = web.deps({ policy: { allow: [], deny: ['feria.example'], allowedPorts: [443] } });
    expect(await checkTarget('https://www.feria.example/', deny)).toMatchObject({ ok: false, code: 'URL_NOT_ALLOWED' });
    const allow = web.deps({ policy: { allow: ['ifema.es'], deny: [], allowedPorts: [443] } });
    expect(await checkTarget('https://feria.example/', allow)).toMatchObject({ ok: false, code: 'URL_NOT_ALLOWED' });
    const nodns = new FakeWeb();
    nodns.defaultAddress = null;
    expect(await checkTarget('https://nada.example/', nodns.deps())).toMatchObject({ ok: false, code: 'DNS_ERROR' });
  });
});

describe('egress headers', () => {
  it('forwards the page headers (site session included) but never hop-by-hop or proxy credentials', () => {
    const out = forwardableRequestHeaders(
      { Host: 'evil', 'proxy-authorization': 'Basic x', cookie: 'sid=1', authorization: 'Bearer site-token', 'accept-encoding': 'zstd', 'x-name': 'Ñandú', accept: '*/*', ':authority': 'x' },
      'UA/1',
    );
    expect(out).toEqual({ cookie: 'sid=1', authorization: 'Bearer site-token', accept: '*/*', 'user-agent': 'UA/1', 'accept-encoding': 'gzip, deflate, br' });
  });

  it('drops encoding / framing headers of the (already decoded) response', () => {
    expect(deliverableResponseHeaders({ 'content-type': 'text/html', 'content-encoding': 'br', 'content-length': '10', 'set-cookie': 'a=1\nb=2' })).toEqual({ 'content-type': 'text/html', 'set-cookie': 'a=1\nb=2' });
  });
});

describe('Renderer.validate runs BEFORE any browser work', () => {
  it('refuses data: URLs, localhost and private targets without launching Chromium', async () => {
    const web = new FakeWeb().host('priv.example', '192.168.1.10');
    const renderer = new Renderer({ egress: web.deps() });
    for (const [url, code] of [
      ['data:text/html,<script>alert(1)</script>', 'URL_NOT_ALLOWED'],
      ['http://localhost:4030/health', 'URL_NOT_ALLOWED'],
      ['http://127.0.0.1:4030/', 'URL_NOT_ALLOWED'],
      ['https://priv.example/', 'SSRF_BLOCKED'],
    ] as const) {
      await expect(renderer.render({ url })).rejects.toMatchObject({ code, httpStatus: 400 });
    }
    // No browser was launched and no request left.
    expect((renderer as unknown as { browser: unknown }).browser).toBeNull();
    expect(web.requests).toHaveLength(0);
  });
});

describe('ip-guard.ts is an exact copy of the runtime module', () => {
  const runtimeCopy = resolve(here, '../../../../runtime/agent-runtime/src/tools/web/ip-guard.ts');
  it.skipIf(!existsSync(runtimeCopy))('services/renderer/src/ip-guard.ts === runtime/agent-runtime/src/tools/web/ip-guard.ts', () => {
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(resolve(here, '../../src/ip-guard.ts'))).toBe(norm(runtimeCopy));
  });
});
