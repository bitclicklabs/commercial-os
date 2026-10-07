/**
 * Webhook authentication and the register:webhook script, without database.
 * Uses the real Twenty 2.45 payload captured in test/fixtures (re-signed with a test secret).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import type { ApiContext } from '../../src/api/context.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { authenticateTwentyWebhook, signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { extractWebhooks, registerWebhook, WEBHOOK_MARKER } from '../../src/integrations/twenty/register-webhook.js';

const SECRET = 'test-secret-0123456789abcdef';
const fixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/twenty-webhook-hypothesis-status.json'), 'utf8'),
) as { headers: Record<string, string>; body: Record<string, unknown> };
const raw = JSON.stringify(fixture.body);

describe('authenticateTwentyWebhook', () => {
  const ts = '1791355184270';
  const now = Number(ts) + 1_000;

  it('accepts a valid Twenty HMAC signature over `${timestamp}:${body}`', () => {
    const headers = { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) };
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw, headers, query: {}, now })).toEqual({ ok: true, method: 'signature' });
  });

  it('rejects a tampered body, a wrong secret and an old timestamp', () => {
    const headers = { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) };
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw.replace('PROPOSED', 'VALIDATED'), headers, query: {}, now }).ok).toBe(false);
    expect(authenticateTwentyWebhook({ secret: `${SECRET}x`, rawBody: raw, headers, query: {}, now }).ok).toBe(false);
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw, headers, query: {}, now: now + 10 * 60_000 })).toEqual({
      ok: false,
      reason: 'signature timestamp outside tolerance',
    });
  });

  it('accepts the shared secret in header or query, and rejects without credentials', () => {
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw, headers: { 'x-pxos-webhook-secret': SECRET }, query: {} }).ok).toBe(true);
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw, headers: {}, query: { secret: SECRET } }).ok).toBe(true);
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw, headers: {}, query: { secret: 'nope' } }).ok).toBe(false);
    expect(authenticateTwentyWebhook({ secret: SECRET, rawBody: raw, headers: {}, query: {} })).toEqual({
      ok: false,
      reason: 'missing signature or shared secret',
    });
  });
});

describe('POST /webhooks/twenty (no database needed for rejections)', () => {
  let app: FastifyInstance;
  let unconfigured: FastifyInstance;
  const ctx = (secret?: string): ApiContext => ({
    db: {} as ApiContext['db'],
    queue: new MemoryRunQueue(),
    config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub', ...(secret ? { twentyWebhookSecret: secret } : {}) },
  });

  beforeAll(async () => {
    app = await buildServer(ctx(SECRET));
    unconfigured = await buildServer(ctx());
  });
  afterAll(async () => {
    await app.close();
    await unconfigured.close();
  });

  const post = (server: FastifyInstance, headers: Record<string, string> = {}, url = '/webhooks/twenty') =>
    server.inject({ method: 'POST', url, payload: raw, headers: { 'content-type': 'application/json', ...headers } });

  it('401 without signature or secret', async () => {
    const res = await post(app);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('401 with a wrong signature or wrong query secret', async () => {
    const ts = String(Date.now());
    expect((await post(app, { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': 'deadbeef' })).statusCode).toBe(401);
    expect((await post(app, {}, '/webhooks/twenty?secret=wrong-secret-value')).statusCode).toBe(401);
  });

  it('503 when TWENTY_WEBHOOK_SECRET is not configured', async () => {
    const ts = String(Date.now());
    const res = await post(unconfigured, { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) });
    expect(res.statusCode).toBe(503);
  });

  it('keeps the default JSON parser for the other routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/evaluations/human', payload: { feedback: 'NOPE' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });
});

describe('registerWebhook (idempotent)', () => {
  function fakeTwenty(initial: Array<Record<string, unknown>>) {
    const hooks = initial.map((h) => ({ ...h }));
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (method === 'GET') return json({ data: hooks, totalCount: hooks.length });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === 'POST') {
        const created = { id: `w${hooks.length + 1}`, ...body };
        hooks.push(created);
        return json(created);
      }
      const id = url.split('/').pop();
      const target = hooks.find((h) => h.id === id);
      Object.assign(target ?? {}, body);
      return json(target);
    }) as typeof fetch;
    return { f, calls, hooks };
  }
  const base = { baseUrl: 'http://twenty', apiKey: 'k', secret: SECRET, targetUrl: 'http://pxos-runtime:4020/webhooks/twenty', operations: ['commercialHypothesis.updated'] };

  it('creates once, then is unchanged, then updates in place (never deletes)', async () => {
    const t = fakeTwenty([{ id: 'other', targetUrl: 'http://x', operations: ['*.*'], description: 'otro' }]);
    const first = await registerWebhook({ ...base, fetch: t.f });
    expect(first.action).toBe('created');
    expect(first.webhook).not.toHaveProperty('secret');
    expect((await registerWebhook({ ...base, fetch: t.f })).action).toBe('unchanged');
    const paused = await registerWebhook({ ...base, operations: [], fetch: t.f });
    expect(paused).toMatchObject({ action: 'updated', webhook: { operations: [] } });
    expect(t.hooks).toHaveLength(2);
    expect(t.hooks.find((h) => String(h.description).includes(WEBHOOK_MARKER))).toMatchObject({ secret: SECRET, targetUrl: base.targetUrl });
    expect(t.calls).not.toContain('DELETE');
  });

  it('reads both metadata list envelopes', () => {
    expect(extractWebhooks({ data: [{ id: 'a' }] })).toHaveLength(1);
    expect(extractWebhooks({ data: { webhooks: [{ id: 'a' }, { id: 'b' }] } })).toHaveLength(2);
    expect(extractWebhooks([])).toEqual([]);
  });
});
