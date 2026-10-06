import { describe, expect, it } from 'vitest';
import {
  TwentyApiError,
  TwentyClient,
  eurToCurrency,
  filterValue,
  normalizeDomain,
  twentyClientFromEnv,
} from '../../src/integrations/twenty/index.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler, extra: Partial<ConstructorParameters<typeof TwentyClient>[0]> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const c = new TwentyClient({
    baseUrl: 'http://twenty.test/',
    apiKey: 'secret-key',
    maxRetries: 2,
    retryBaseDelayMs: 100,
    fetch: (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return handler(String(input), init ?? {});
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, calls, sleeps };
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fail = (status: number, messages: string[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ statusCode: status, messages }), { status, headers });

describe('TwentyClient', () => {
  it('lists records with filter/limit and unwraps the data envelope', async () => {
    const { c, calls } = client(() => ok({ data: { companies: [{ id: '1', name: 'A' }] }, totalCount: 1, pageInfo: { hasNextPage: false } }));
    const res = await c.list('companies', { filter: 'name[ilike]:"%a%"', limit: 5, depth: 0 });
    expect(res).toEqual({ records: [{ id: '1', name: 'A' }], totalCount: 1, pageInfo: { hasNextPage: false } });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/rest/companies');
    expect(url.searchParams.get('filter')).toBe('name[ilike]:"%a%"');
    expect(url.searchParams.get('limit')).toBe('5');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('get() returns null on 404 and create() posts JSON', async () => {
    const { c, calls } = client((url, init) =>
      init.method === 'POST' ? ok({ data: { createCompany: { id: 'new' } } }, 201) : fail(404, ['Record not found']),
    );
    expect(await c.get('companies', 'missing')).toBeNull();
    expect(await c.create('companies', { name: 'X' })).toEqual({ id: 'new' });
    expect(calls[1]!.init.body).toBe(JSON.stringify({ name: 'X' }));
  });

  it('retries 429 honouring Retry-After and 5xx with exponential backoff', async () => {
    let n = 0;
    const { c, calls, sleeps } = client(() => {
      n += 1;
      if (n === 1) return fail(429, ['Too many requests'], { 'retry-after': '1' });
      if (n === 2) return fail(503, ['Unavailable']);
      return ok({ data: { companies: [] } });
    });
    await c.list('companies');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 200]);
  });

  it('gives up after maxRetries with a retryable error', async () => {
    const { c, calls } = client(() => fail(502, ['Bad gateway']));
    await expect(c.list('companies')).rejects.toMatchObject({ code: 'TWENTY_SERVER_ERROR', retryable: true, status: 502 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx and classifies duplicates and auth errors', async () => {
    const dup = client(() => fail(400, ['A duplicate entry was detected: unique constraint company.IDX was violated']));
    await expect(dup.c.create('companies', {})).rejects.toMatchObject({ code: 'TWENTY_DUPLICATE', retryable: false });
    expect(dup.calls).toHaveLength(1);
    const auth = client(() => fail(401, ['Token invalid.']));
    await expect(auth.c.list('companies')).rejects.toMatchObject({ code: 'TWENTY_UNAUTHORIZED' });
    const bad = client(() => fail(400, ['Invalid value "fair" for field "signalType"']));
    const err = await bad.c.create('commercialSignals', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwentyApiError);
    expect((err as TwentyApiError).message).toContain('Invalid value "fair"');
    expect((err as TwentyApiError).message).not.toContain('secret-key');
  });

  it('retries network errors on GET but not on POST', async () => {
    const get = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(get.c.list('companies')).rejects.toMatchObject({ code: 'TWENTY_NETWORK_ERROR' });
    expect(get.calls).toHaveLength(3);
    const post = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(post.c.create('companies', {})).rejects.toMatchObject({ code: 'TWENTY_NETWORK_ERROR' });
    expect(post.calls).toHaveLength(1);
  });

  it('times out slow requests', async () => {
    const { c } = client(
      (_url, init) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
      { timeoutMs: 20, maxRetries: 0 },
    );
    await expect(c.list('companies')).rejects.toMatchObject({ code: 'TWENTY_TIMEOUT' });
  });

  it('refuses to call without an API key and exposes no delete', async () => {
    const c = new TwentyClient({ baseUrl: 'http://x', fetch: (async () => ok({})) as typeof fetch });
    expect(c.isConfigured()).toBe(false);
    await expect(c.list('companies')).rejects.toMatchObject({ code: 'TWENTY_NOT_CONFIGURED' });
    expect('delete' in c).toBe(false);
    expect(await c.ping()).toBe(false);
  });

  it('reads its configuration from env', () => {
    const c = twentyClientFromEnv({ TWENTY_BASE_URL: 'http://pxos-twenty:3000/', TWENTY_API_KEY: 'k' });
    expect(c.baseUrl).toBe('http://pxos-twenty:3000');
    expect(c.isConfigured()).toBe(true);
    expect(twentyClientFromEnv({}).baseUrl).toBe('http://localhost:3020');
  });
});

describe('Twenty field helpers', () => {
  it('normalizes domains', () => {
    expect(normalizeDomain('https://www.ACME.com/es/contacto?x=1')).toBe('acme.com');
    expect(normalizeDomain('acme.com.')).toBe('acme.com');
    expect(normalizeDomain('http://shop.acme.co.uk:8080')).toBe('shop.acme.co.uk');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });

  it('converts EUR to CURRENCY micros and sanitizes filter values', () => {
    expect(eurToCurrency(1500.5)).toEqual({ amountMicros: 1_500_500_000, currencyCode: 'EUR' });
    expect(eurToCurrency(0.0431)).toEqual({ amountMicros: 43_100, currencyCode: 'EUR' });
    expect(filterValue('a"b\\c')).toBe('"abc"');
  });
});
