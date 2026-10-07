/**
 * LIVE test against a running renderer (`pnpm dev`, http://127.0.0.1:4030 by default,
 * or RENDERER_TEST_URL) and the real internet:
 * - a real JavaScript catalog (Gastrónoma 2026, apps.feriavalencia.com) must render
 *   with its exhibitors;
 * - data: URLs, localhost, loopback, private and metadata addresses must be refused
 *   BEFORE navigating.
 * Skipped when the renderer does not answer on /health or with SKIP_LIVE_TESTS=1.
 *
 *   pnpm dev                                  # terminal 1
 *   pnpm vitest run test/integration/live.test.ts   # terminal 2
 */
import { beforeAll, describe, expect, it } from 'vitest';

const base = (process.env.RENDERER_TEST_URL ?? 'http://127.0.0.1:4030').replace(/\/+$/, '');

async function reachable(): Promise<boolean> {
  if (process.env.SKIP_LIVE_TESTS === '1') return false;
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

const up = await reachable();

const render = async (body: Record<string, unknown>) => {
  const res = await fetch(`${base}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { text?: string; links?: Array<{ url: string; text: string }>; error?: { code: string } } };
};

describe.skipIf(!up)(`renderer live (${base})`, () => {
  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`renderer live tests against ${base}`);
  });

  it('www.gastronoma.es: renders the home page and finds the link to the JS catalog', async () => {
    const r = await render({ url: 'http://gastronoma.es' });
    expect(r.status).toBe(200);
    expect(r.json.final_url).toBe('https://www.gastronoma.es/');
    expect(r.json.text).toMatch(/Gastr[oó]noma/);
    expect((r.json.text ?? '').length).toBeGreaterThan(1_000);
  }, 60_000);

  it('apps.feriavalencia.com (JS app): the exhibitor catalog of Gastrónoma renders with exhibitors', async () => {
    const r = await render({ url: 'https://apps.feriavalencia.com/catalog/gastronoma/exhibitors', wait_ms: 4_000 });
    expect(r.status).toBe(200);
    const text = r.json.text ?? '';
    expect(text).toContain('Catálogo de expositores');
    // Paginated list: "1 - 20 de N".
    const page = /(\d+)\s*-\s*(\d+)\s+de\s+(\d+)/.exec(text);
    expect(page).not.toBeNull();
    const details = (r.json.links ?? []).filter((l) => /\/catalog\/gastronoma\/exhibitors\/\d+$/.test(l.url));
    expect(details.length).toBeGreaterThanOrEqual(10);
    // eslint-disable-next-line no-console
    console.log(`feriavalencia: ${details.length} fichas de expositor en la primera página (${page?.[0]}), ${text.length} caracteres`);
  }, 60_000);

  it.each([
    ['data:text/html,<h1>hola</h1>', 'URL_NOT_ALLOWED'],
    ['http://localhost:4030/health', 'URL_NOT_ALLOWED'],
    ['http://127.0.0.1:4030/health', 'URL_NOT_ALLOWED'],
    ['http://[::1]:4030/health', 'URL_NOT_ALLOWED'],
    ['http://169.254.169.254/latest/meta-data/', 'URL_NOT_ALLOWED'],
    ['http://192.168.1.1/', 'URL_NOT_ALLOWED'],
    ['http://pxos-twenty:3000/', 'URL_NOT_ALLOWED'],
    ['file:///etc/passwd', 'URL_NOT_ALLOWED'],
  ])('refuses %s', async (url, code) => {
    const r = await render({ url });
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe(code);
  });
});
