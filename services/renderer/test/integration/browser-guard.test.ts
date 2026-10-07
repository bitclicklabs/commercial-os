/**
 * Real Chromium (Playwright), fake internet. The "public" site is served by FakeWeb
 * through the egress guard; a REAL HTTP/WebSocket server on 127.0.0.1 plays the
 * internal service the page tries to reach. It must never receive a single connection.
 *
 * Needs Chromium: `pnpm browsers` (npx playwright install chromium). Skipped with
 * SKIP_BROWSER_TESTS=1 or when Chromium is not installed.
 */
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Renderer } from '../../src/render.js';
import { FakeWeb } from '../helpers/fake-web.js';

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const skip = process.env.SKIP_BROWSER_TESTS === '1' || !hasChromium;

describe.skipIf(skip)('renderer with a real browser: egress guard', () => {
  let internal: Server;
  let port = 0;
  const hits: string[] = [];
  let web: FakeWeb;
  let renderer: Renderer;

  beforeAll(async () => {
    internal = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.end('SECRETO_INTERNO');
    });
    internal.on('upgrade', (req, socket) => {
      hits.push(`UPGRADE ${req.url}`);
      socket.destroy();
    });
    internal.on('connection', () => hits.push('TCP'));
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve));
    port = (internal.address() as AddressInfo).port;

    const probe = (name: string, url: string) => `
      fetch(${JSON.stringify(url)}).then(r => r.text()).then(t => mark(${JSON.stringify(name)}, 'LEAK:' + t)).catch(() => mark(${JSON.stringify(name)}, 'bloqueado'));`;
    const page = `<!doctype html><html><head><title>Catálogo de prueba</title></head><body>
      <h1>Expositores</h1><ul id="list"></ul><div id="res"></div>
      <div hidden>OCULTO_HIDDEN</div><div aria-hidden="true">OCULTO_ARIA</div><div style="display:none">OCULTO_CSS</div>
      <iframe src="http://public.example:8080/frame"></iframe>
      <img src="http://169.254.169.254/latest/meta-data/">
      <script>
        function mark(k, v) { const p = document.createElement('p'); p.textContent = k + '=' + v; document.getElementById('res').appendChild(p); }
        fetch('/api/exhibitors.json').then(r => r.json()).then(list => {
          for (const e of list) { const li = document.createElement('li'); li.textContent = e; document.getElementById('list').appendChild(li); }
        });
        ${probe('loopback', `http://127.0.0.1:${port}/secret`)}
        ${probe('loopback_name', `http://localhost:${port}/secret`)}
        ${probe('private_dns', 'http://internal.example:8080/secret')}
        ${probe('mixed_dns', 'http://rebind.example:8080/secret')}
        ${probe('metadata', 'http://169.254.169.254/latest/meta-data/')}
        ${probe('file', 'file:///etc/passwd')}
        try { const ws = new WebSocket('ws://127.0.0.1:${port}/ws'); ws.onopen = () => mark('ws', 'LEAK'); ws.onerror = ws.onclose = () => mark('ws', 'bloqueado'); } catch (e) { mark('ws', 'bloqueado'); }
        try { navigator.sendBeacon('http://127.0.0.1:${port}/beacon', 'x'); } catch (e) {}
        try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] }); pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)); } catch (e) {}
      </script></body></html>`;

    web = new FakeWeb()
      .host('public.example', '93.184.216.34')
      .host('internal.example', '10.1.2.3')
      .host('rebind.example', '93.184.216.34', '127.0.0.1')
      .page('http://public.example:8080/', page)
      .page('http://public.example:8080/api/exhibitors.json', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(['Conservas Ortiz', 'Bodegas Torres']) })
      .page('http://public.example:8080/frame', '<p>Texto del iframe: Cafés Baqué</p>')
      .redirect('http://public.example:8080/to-internal', `http://127.0.0.1:${port}/admin`)
      .redirect('http://public.example:8080/old', 'http://www.public.example:8080/nuevo/', 301)
      .page('http://www.public.example:8080/nuevo/', '<title>Nuevo</title><p>Página tras redirección</p><a href="lista">Lista</a><iframe src="http://public.example:8080/to-internal"></iframe><script>fetch("http://public.example:8080/to-internal").then(r => r.text()).then(t => document.body.append("LEAK:" + t)).catch(() => document.body.append("sub_redirect=bloqueado"));</script>')
      .page('http://public.example:8080/jsnav', `<p>antes</p><script>setTimeout(() => { location.href = 'http://127.0.0.1:${port}/admin'; }, 50);</script>`)
      // Catalog that paints its header at once and its list 4 s later (anonymous login + list call).
      .page('http://public.example:8080/late', `<title>Catálogo tardío</title><div id="app"><h1>Catálogo de expositores</h1><p>Filtros</p></div>
        <script>setTimeout(() => { const ul = document.createElement('ul'); for (let i = 0; i < 20; i++) { const li = document.createElement('li'); li.textContent = 'EXPOSITOR TARDIO ' + i + ' S.L. - España'; ul.appendChild(li); } document.getElementById('app').appendChild(ul); }, 4000);</script>`)
      // Framework that hides the whole app from screen readers while a cookie dialog is open.
      .page('http://public.example:8080/modal', `<title>Modal</title><div id="app" aria-hidden="true"><h1>Lista</h1><ul>${Array.from({ length: 20 }, (_, i) => `<li>EMPRESA VISIBLE ${i}</li>`).join('')}</ul><span aria-hidden="true">INYECCION_PEQUENA</span></div><div role="dialog">Esta web utiliza cookies. De acuerdo</div>`)
      .page('http://public.example:8080/loop', '<title>Bucle</title><script>while (true) {}</script>')
      .page('http://public.example:8080/doc.pdf', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="doc.pdf"' }, body: '%PDF-1.4' });
    renderer = new Renderer({ egress: web.deps(), jsTimeoutMs: 8_000 });
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
    await new Promise<void>((resolve) => internal.close(() => resolve()));
  });

  it('renders the JS content of a public page and blocks every internal destination', async () => {
    const r = await renderer.render({ url: 'http://public.example:8080/', waitMs: 1_500 });
    expect(r.title).toBe('Catálogo de prueba');
    expect(r.text).toContain('Conservas Ortiz');
    expect(r.text).toContain('Bodegas Torres');
    expect(r.text).toContain('Cafés Baqué');
    for (const k of ['loopback', 'loopback_name', 'private_dns', 'mixed_dns', 'metadata', 'file']) expect(r.text).toContain(`${k}=bloqueado`);
    expect(r.text).not.toContain('LEAK');
    expect(r.text).not.toContain('SECRETO_INTERNO');
    for (const hidden of ['OCULTO_HIDDEN', 'OCULTO_ARIA', 'OCULTO_CSS']) expect(r.text).not.toContain(hidden);
    expect(r.blocked_requests).toBeGreaterThanOrEqual(4);
    expect(r.links).toContainEqual({ url: 'http://public.example:8080/frame', text: '(iframe)' });
    // The internal server never got a connection: not from fetch, WebSocket, beacon, WebRTC nor the proxy fallback.
    expect(hits).toEqual([]);
    // Every request that did go out went through the guard to public.example.
    expect(new Set(web.requests.map((q) => q.url.hostname))).toEqual(new Set(['public.example']));
  }, 40_000);

  it('waits for late hydration (visible text below min_text_chars, then until it stops growing)', async () => {
    const r = await renderer.render({ url: 'http://public.example:8080/late', waitMs: 0, minTextChars: 300 });
    expect(r.text).toContain('EXPOSITOR TARDIO 19 S.L.');
    expect(r.hydrated).toBe(true);
    expect(r.hydration_ms).toBeGreaterThan(2_000);
    // Without the hydration wait, the list is not there yet.
    const early = await renderer.render({ url: 'http://public.example:8080/late', waitMs: 0, minTextChars: 0 });
    expect(early.text).not.toContain('EXPOSITOR TARDIO');
    expect(early.hydration_ms).toBe(0);
  }, 40_000);

  it('keeps an app container marked aria-hidden by a modal, drops small aria-hidden snippets', async () => {
    const r = await renderer.render({ url: 'http://public.example:8080/modal', waitMs: 0 });
    expect(r.text).toContain('EMPRESA VISIBLE 19');
    expect(r.text).not.toContain('INYECCION_PEQUENA');
  }, 40_000);

  it('a redirect to an internal address blocks the navigation', async () => {
    await expect(renderer.render({ url: 'http://public.example:8080/to-internal' })).rejects.toMatchObject({ code: 'NAVIGATION_BLOCKED' });
    expect(hits).toEqual([]);
  }, 40_000);

  it('public redirects are followed through the guard (final_url is the real one); redirected subresources to internal hosts are refused', async () => {
    const r = await renderer.render({ url: 'http://public.example:8080/old', waitMs: 800 });
    expect(r.final_url).toBe('http://www.public.example:8080/nuevo/');
    expect(r.text).toContain('Página tras redirección');
    expect(r.text).toContain('sub_redirect=bloqueado');
    expect(r.text).not.toContain('LEAK');
    expect(r.links).toContainEqual({ url: 'http://www.public.example:8080/nuevo/lista', text: 'Lista' });
    expect(hits).toEqual([]);
  }, 40_000);

  it('a JavaScript navigation to an internal address goes nowhere', async () => {
    await renderer.render({ url: 'http://public.example:8080/jsnav', waitMs: 800 }).catch(() => undefined);
    expect(hits).toEqual([]);
  }, 40_000);

  it('downloads are refused', async () => {
    await expect(renderer.render({ url: 'http://public.example:8080/doc.pdf' })).rejects.toMatchObject({ code: expect.stringMatching(/DOWNLOAD_BLOCKED|NAVIGATION_FAILED/) });
  }, 40_000);

  it('a page that never stops running JS hits the time budget', async () => {
    const started = Date.now();
    await expect(renderer.render({ url: 'http://public.example:8080/loop' })).rejects.toMatchObject({ code: 'RENDER_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(20_000);
    // The renderer is still usable afterwards (fresh context per request).
    const ok = await renderer.render({ url: 'http://public.example:8080/frame', waitMs: 0 });
    expect(ok.text).toContain('Cafés Baqué');
  }, 60_000);
});
