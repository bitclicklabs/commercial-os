/**
 * External event bridge (n8n), pure parts: bearer auth, ingestion validation and prefixes,
 * signature of outbound webhooks, subscription matching, SSRF guard and one delivery
 * attempt (fake transport). Plus the ingestion route against a fake EventPublisher (no DB).
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import type { EventEnvelope } from '../../src/events/envelope.js';
import type { EventPublisher, PublishEventInput, PublishResult } from '../../src/events/event-bus.js';
import {
  authenticateExternalRequest,
  externalEventBodySchema,
  externalPublishInput,
  MAX_EXTERNAL_DATA_BYTES,
  parseEventTypePrefixes,
} from '../../src/events/external.js';
import {
  isValidEventTypePattern,
  matchesEventType,
  matchesSubscription,
  secretHint,
  signEventBody,
  verifyEventSignature,
} from '../../src/events/subscriptions.js';
import { buildDelivery, deliverOnce, isRetryableStatus, type WebhookRequest } from '../../src/events/webhook-delivery.js';
import { checkWebhookTarget, isAllowlisted, parsePrivateAllowlist, parseTargetUrl, type LookupAll } from '../../src/events/webhook-target.js';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'subscription-secret-0123456789';

describe('authenticateExternalRequest', () => {
  it('503 without configured token, 401 without or with a wrong bearer, ok with the right one', () => {
    expect(authenticateExternalRequest(`Bearer ${TOKEN}`, undefined)).toMatchObject({ ok: false, status: 503 });
    expect(authenticateExternalRequest(undefined, TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateExternalRequest('Basic abc', TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateExternalRequest(`Bearer ${TOKEN}x`, TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateExternalRequest(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateExternalRequest(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
    expect(authenticateExternalRequest(`bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
    expect(authenticateExternalRequest([`Bearer ${TOKEN}`], TOKEN)).toEqual({ ok: true });
  });
});

describe('parseEventTypePrefixes', () => {
  it('defaults to ext. and accepts a comma separated list', () => {
    expect(parseEventTypePrefixes(undefined)).toEqual(['ext.']);
    expect(parseEventTypePrefixes('')).toEqual(['ext.']);
    expect(parseEventTypePrefixes('ext., crm.lead., ext.')).toEqual(['ext.', 'crm.lead.']);
  });

  it('refuses malformed prefixes and prefixes that would cover runtime events', () => {
    expect(() => parseEventTypePrefixes('ext')).toThrow(/invalid/);
    expect(() => parseEventTypePrefixes('Ext.')).not.toThrow(); // lower-cased
    expect(() => parseEventTypePrefixes('ext.*')).toThrow(/invalid/);
    expect(() => parseEventTypePrefixes('task.')).toThrow(/overlaps/);
    expect(() => parseEventTypePrefixes('ext.,agent.execution.')).toThrow(/overlaps/);
    expect(() => parseEventTypePrefixes('evaluation.')).toThrow(/overlaps/);
  });

  it('loadConfig validates EXTERNAL_EVENT_TYPE_PREFIXES and parses the private allowlist', () => {
    const cfg = loadConfig({ EXTERNAL_EVENT_TYPE_PREFIXES: 'ext.,crm.', EXTERNAL_WEBHOOK_ALLOW_PRIVATE: 'host.docker.internal:5678,localhost' }, []);
    expect(cfg.externalEventTypePrefixes).toEqual(['ext.', 'crm.']);
    expect(cfg.externalWebhookAllowPrivate).toEqual([{ host: 'host.docker.internal', port: 5678 }, { host: 'localhost' }]);
    expect(loadConfig({}, []).externalEventTypePrefixes).toEqual(['ext.']);
    expect(() => loadConfig({ EXTERNAL_EVENT_TYPE_PREFIXES: 'task.' }, [])).toThrow(/overlaps/);
    expect(() => loadConfig({ EXTERNAL_EVENTS_TOKEN: 'short' }, [])).toThrow();
  });
});

describe('externalEventBodySchema', () => {
  const schema = externalEventBodySchema(['ext.']);

  it('accepts a minimal body and defaults producer to n8n', () => {
    const body = schema.parse({ type: 'ext.lead.created', data: { email: 'a@b.c' } });
    expect(body.producer).toBe('n8n');
  });

  it('is strict and checks type, prefix, producer, dates and data', () => {
    const bad = (b: unknown) => expect(schema.safeParse(b).success).toBe(false);
    bad({ type: 'ext.lead', data: {}, extra: 1 });
    bad({ type: 'task.completed', data: {} });
    bad({ type: 'ext.', data: {} });
    bad({ type: 'ext', data: {} });
    bad({ type: 'EXT.Lead', data: {} });
    bad({ type: 'ext.lead', data: [] });
    bad({ type: 'ext.lead', data: 'x' });
    bad({ type: 'ext.lead' });
    bad({ type: 'ext.lead', data: {}, producer: 'agent-runtime' });
    bad({ type: 'ext.lead', data: {}, producer: 'scheduler' });
    bad({ type: 'ext.lead', data: {}, occurred_at: 'yesterday' });
    bad({ type: 'ext.lead', data: {}, idempotency_key: '' });
    bad({ type: 'ext.lead', data: {}, id: '00000000-0000-0000-0000-000000000000' });
    bad({ type: 'ext.lead', data: {}, tenant_id: 'other' });
  });

  it('limits data to 64 KB', () => {
    const big = { blob: 'x'.repeat(MAX_EXTERNAL_DATA_BYTES) };
    expect(schema.safeParse({ type: 'ext.lead', data: big }).success).toBe(false);
    const fits = { blob: 'x'.repeat(MAX_EXTERNAL_DATA_BYTES - 20) };
    expect(schema.safeParse({ type: 'ext.lead', data: fits }).success).toBe(true);
  });

  it('honours custom prefixes', () => {
    const custom = externalEventBodySchema(['crm.', 'ext.crm.']);
    expect(custom.safeParse({ type: 'crm.deal.won', data: {} }).success).toBe(true);
    expect(custom.safeParse({ type: 'ext.crm.ping', data: {} }).success).toBe(true);
    expect(custom.safeParse({ type: 'ext.other', data: {} }).success).toBe(false);
  });

  it('builds the publish input: chainDepth 0, producer/source mapping, namespaced idempotency key', () => {
    const body = schema.parse({
      type: 'ext.twenty.company_updated',
      producer: 'twenty',
      data: { chainDepth: 7, companyId: 'c1', taskDefinitionId: 'x' },
      occurred_at: '2026-10-07T10:00:00+02:00',
      correlation_id: 'corr-1',
      idempotency_key: 'evt:task.completed:run-1',
    });
    const input = externalPublishInput(body, { tenantId: 'publiexpe', fallbackCorrelationId: 'fallback' });
    expect(input).toEqual({
      tenantId: 'publiexpe',
      type: 'ext.twenty.company_updated',
      producer: 'twenty-app',
      correlationId: 'corr-1',
      occurredAt: '2026-10-07T10:00:00+02:00',
      idempotencyKey: 'ext:twenty:evt:task.completed:run-1',
      data: { chainDepth: 0, companyId: 'c1', taskDefinitionId: 'x' },
    });
    const minimal = externalPublishInput(schema.parse({ type: 'ext.ping', data: {} }), { tenantId: 't', fallbackCorrelationId: 'fb' });
    expect(minimal).toEqual({ tenantId: 't', type: 'ext.ping', producer: 'n8n', correlationId: 'fb', data: { chainDepth: 0 } });
  });
});

describe('signature', () => {
  it('uses the Twenty scheme: hex HMAC-SHA256 of `timestamp:body`', () => {
    const body = JSON.stringify({ id: 'e1', type: 'task.completed' });
    expect(signEventBody(SECRET, '1791370000000', body)).toBe(signTwentyPayload(SECRET, '1791370000000', body));
    expect(signEventBody(SECRET, '1791370000000', body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies, and rejects tampered bodies, wrong secrets and stale timestamps', () => {
    const now = 1_791_370_000_000;
    const ts = String(now);
    const body = '{"a":1}';
    const sig = signEventBody(SECRET, ts, body);
    expect(verifyEventSignature({ secret: SECRET, rawBody: body, signature: sig, timestamp: ts, now })).toEqual({ ok: true });
    expect(verifyEventSignature({ secret: SECRET, rawBody: body, signature: sig.toUpperCase(), timestamp: ts, now })).toEqual({ ok: true });
    expect(verifyEventSignature({ secret: SECRET, rawBody: '{"a":2}', signature: sig, timestamp: ts, now }).ok).toBe(false);
    expect(verifyEventSignature({ secret: `${SECRET}x`, rawBody: body, signature: sig, timestamp: ts, now }).ok).toBe(false);
    expect(verifyEventSignature({ secret: SECRET, rawBody: body, signature: sig, timestamp: ts, now: now + 6 * 60_000 }).ok).toBe(false);
    expect(verifyEventSignature({ secret: SECRET, rawBody: body, signature: undefined, timestamp: ts, now }).ok).toBe(false);
  });

  it('secret hint never discloses more than 4 characters', () => {
    expect(secretHint(SECRET)).toBe('…6789');
    expect(secretHint('short')).toBe('****');
  });
});

describe('subscription matching', () => {
  it('matches exact types and prefix patterns', () => {
    expect(matchesEventType('task.completed', 'task.completed')).toBe(true);
    expect(matchesEventType('task.completed', 'task.failed')).toBe(false);
    expect(matchesEventType('task.completed', 'task.*')).toBe(true);
    expect(matchesEventType('tasks.completed', 'task.*')).toBe(false);
    expect(matchesEventType('agent.execution.failed', 'agent.*')).toBe(true);
    expect(matchesEventType('agent.execution.failed', 'agent.execution.*')).toBe(true);
    expect(matchesSubscription('evaluation.recorded', ['task.*', 'evaluation.recorded'])).toBe(true);
    expect(matchesSubscription('ext.crm.ping', ['task.*'])).toBe(false);
  });

  it('validates patterns', () => {
    for (const ok of ['task.completed', 'task.*', 'agent.execution.*', 'ext.lead.created']) expect(isValidEventTypePattern(ok)).toBe(true);
    for (const bad of ['*', 'task', 'task.', 'task*', '*.completed', 'Task.completed', 'task.*.x']) expect(isValidEventTypePattern(bad)).toBe(false);
  });
});

describe('SSRF guard', () => {
  const lookupOf =
    (map: Record<string, string[]>): LookupAll =>
    async (host) => {
      const list = map[host];
      if (!list) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
  const lookup = lookupOf({
    'hooks.example.com': ['93.184.216.34'],
    'mixed.example.com': ['93.184.216.34', '10.0.0.7'],
    'host.docker.internal': ['192.168.65.254'],
    localhost: ['127.0.0.1', '::1'],
    'v6.example.com': ['fd00::1'],
  });

  it('accepts only http(s) URLs without credentials', () => {
    expect(parseTargetUrl('https://hooks.example.com/x').ok).toBe(true);
    expect(parseTargetUrl('ftp://hooks.example.com/x').ok).toBe(false);
    expect(parseTargetUrl('file:///etc/passwd').ok).toBe(false);
    expect(parseTargetUrl('javascript:alert(1)').ok).toBe(false);
    expect(parseTargetUrl('https://user:pw@hooks.example.com/').ok).toBe(false);
    expect(parseTargetUrl('not a url').ok).toBe(false);
    expect(parseTargetUrl(`https://hooks.example.com/${'a'.repeat(2100)}`).ok).toBe(false);
  });

  it('public hosts pass; private, loopback, link-local, mixed and unresolvable ones are refused', async () => {
    const check = (url: string, allow = '') => checkWebhookTarget(url, { allowPrivate: parsePrivateAllowlist(allow), lookup });
    expect(await check('https://hooks.example.com/webhook/x')).toMatchObject({ ok: true, allowlisted: false });
    expect((await check('http://mixed.example.com/')).ok).toBe(false);
    expect((await check('http://localhost:5678/')).ok).toBe(false);
    expect((await check('http://127.0.0.1:5678/')).ok).toBe(false);
    expect((await check('http://[::1]:5678/')).ok).toBe(false);
    expect((await check('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
    expect((await check('http://10.1.2.3/')).ok).toBe(false);
    expect((await check('http://[::ffff:10.0.0.1]/')).ok).toBe(false);
    expect((await check('http://v6.example.com/')).ok).toBe(false);
    expect((await check('http://host.docker.internal:5678/webhook/pxos')).ok).toBe(false);
    expect((await check('http://nowhere.example.com/')).ok).toBe(false);
    const refused = await check('http://host.docker.internal:5678/webhook/pxos');
    expect(!refused.ok && refused.reason).toMatch(/EXTERNAL_WEBHOOK_ALLOW_PRIVATE=host\.docker\.internal:5678/);
  });

  it('EXTERNAL_WEBHOOK_ALLOW_PRIVATE opens exactly the listed host (and port)', async () => {
    const allow = 'host.docker.internal:5678, localhost, [::1]:8080, 127.0.0.1:9000';
    const check = (url: string) => checkWebhookTarget(url, { allowPrivate: parsePrivateAllowlist(allow), lookup });
    expect(await check('http://host.docker.internal:5678/webhook/pxos')).toMatchObject({ ok: true, allowlisted: true });
    expect((await check('http://host.docker.internal:5679/')).ok).toBe(false);
    expect((await check('http://localhost:1234/')).ok).toBe(true);
    expect((await check('http://[::1]:8080/')).ok).toBe(true);
    expect((await check('http://[::1]:8081/')).ok).toBe(false);
    expect((await check('http://127.0.0.1:9000/')).ok).toBe(true);
    expect((await check('http://127.0.0.1:9001/')).ok).toBe(false);
    // No subdomain wildcard.
    expect(isAllowlisted(new URL('http://evil.host.docker.internal:5678/'), parsePrivateAllowlist(allow))).toBe(false);
  });

  it('at creation an allowlisted host may be unresolvable (visible only from the scheduler)', async () => {
    const allowPrivate = parsePrivateAllowlist('n8n:5678');
    expect((await checkWebhookTarget('http://n8n:5678/webhook/x', { allowPrivate, lookup })).ok).toBe(false);
    expect((await checkWebhookTarget('http://n8n:5678/webhook/x', { allowPrivate, lookup, requireResolution: false })).ok).toBe(true);
    expect((await checkWebhookTarget('http://other:5678/', { allowPrivate, lookup, requireResolution: false })).ok).toBe(false);
  });

  it('parses the allowlist leniently', () => {
    expect(parsePrivateAllowlist(' a:1 ,b;c:99999 ,, [fe80::1]:80 ::1 ')).toEqual([
      { host: 'a', port: 1 },
      { host: 'b' },
      { host: 'fe80::1', port: 80 },
      { host: '::1' },
    ]);
  });
});

describe('deliverOnce', () => {
  const envelope: EventEnvelope = {
    id: '6f7c2b1e-1d3a-4f5e-9a8b-0c1d2e3f4a5b',
    type: 'task.completed',
    schemaVersion: 'task.completed.v1',
    tenantId: 'publiexpe',
    occurredAt: '2026-10-07T10:00:00.000Z',
    producer: 'agent-runtime',
    correlationId: 'run-1',
    data: { taskRunId: 'run-1', outcome: 'FAILED', chainDepth: 0 },
  };
  const sub = { id: 'sub-1', secret: SECRET, targetUrl: 'https://hooks.example.com/webhook/pxos' };
  const lookup: LookupAll = async () => [{ address: '93.184.216.34', family: 4 }];

  it('POSTs the signed envelope to the pinned public address', async () => {
    const seen: WebhookRequest[] = [];
    const res = await deliverOnce(sub, envelope, {
      allowPrivate: [],
      lookup,
      attempt: 2,
      now: () => 1_791_370_000_000,
      transport: async (req) => {
        seen.push(req);
        return { status: 204, snippet: '' };
      },
    });
    expect(res).toEqual({ ok: true, status: 204 });
    const req = seen[0]!;
    expect(req.address).toEqual({ address: '93.184.216.34', family: 4 });
    expect(JSON.parse(req.body)).toEqual(envelope);
    expect(req.headers['x-pxos-event-timestamp']).toBe('1791370000000');
    expect(req.headers['x-pxos-event-id']).toBe(envelope.id);
    expect(req.headers['x-pxos-delivery-attempt']).toBe('2');
    expect(
      verifyEventSignature({ secret: SECRET, rawBody: req.body, signature: req.headers['x-pxos-event-signature'], timestamp: '1791370000000', now: 1_791_370_000_000 }),
    ).toEqual({ ok: true });
  });

  it('classifies failures: 5xx/408/429/network retryable; 4xx, redirects and refused targets final', async () => {
    const withStatus = (status: number) =>
      deliverOnce(sub, envelope, { allowPrivate: [], lookup, transport: async () => ({ status, snippet: 'boom\nline' }) });
    expect(await withStatus(500)).toMatchObject({ ok: false, retryable: true, status: 500, error: 'HTTP 500: boom line' });
    expect(await withStatus(429)).toMatchObject({ ok: false, retryable: true });
    expect(await withStatus(404)).toMatchObject({ ok: false, retryable: false });
    expect(await withStatus(302)).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('redirects are not followed') });
    const net = await deliverOnce(sub, envelope, {
      allowPrivate: [],
      lookup,
      transport: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });
    expect(net).toMatchObject({ ok: false, retryable: true, error: 'network error: ECONNREFUSED' });
    let called = false;
    const refused = await deliverOnce({ ...sub, targetUrl: 'http://10.0.0.1/hook' }, envelope, {
      allowPrivate: [],
      transport: async () => {
        called = true;
        return { status: 200, snippet: '' };
      },
    });
    expect(refused).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('target refused') });
    expect(called).toBe(false);
    expect([500, 502, 503, 408, 429].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 410, 422].some(isRetryableStatus)).toBe(false);
  });

  it('buildDelivery body is exactly JSON.stringify(envelope) (what receivers must sign)', () => {
    const { body, headers } = buildDelivery({ id: 'sub-1', secret: SECRET }, envelope, { timestamp: '1', attempt: 1 });
    expect(body).toBe(JSON.stringify(envelope));
    expect(headers['x-pxos-event-signature']).toBe(signEventBody(SECRET, '1', body));
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('POST /events/external (fake bus, no DB)', () => {
  class FakePublisher implements EventPublisher {
    readonly inputs: PublishEventInput[] = [];
    async publish(input: PublishEventInput): Promise<PublishResult> {
      this.inputs.push(input);
      const event: EventEnvelope = {
        id: '6f7c2b1e-1d3a-4f5e-9a8b-0c1d2e3f4a5b',
        type: input.type,
        schemaVersion: `${input.type}.v1`,
        tenantId: input.tenantId,
        occurredAt: new Date().toISOString(),
        producer: input.producer ?? 'agent-runtime',
        correlationId: input.correlationId,
        data: input.data,
      };
      return { event, created: this.inputs.length === 1, dispatched: true };
    }
    async emit(input: PublishEventInput) {
      return this.publish(input);
    }
  }

  async function server(token: string | undefined, events?: EventPublisher): Promise<FastifyInstance> {
    return buildServer({
      db: {} as Db,
      queue: {} as never,
      ...(events ? { events } : {}),
      config: {
        defaultTenantId: 'publiexpe',
        defaultModelProvider: 'stub',
        ...(token ? { externalEventsToken: token } : {}),
        externalEventTypePrefixes: ['ext.'],
      },
    });
  }

  const auth = { authorization: `Bearer ${TOKEN}` };

  it('503 when the token is not configured, 401 without or with a wrong token', async () => {
    const off = await server(undefined, new FakePublisher());
    const r503 = await off.inject({ method: 'POST', url: '/events/external', headers: auth, payload: { type: 'ext.ping', data: {} } });
    expect(r503.statusCode).toBe(503);
    expect(r503.json().error).toBe('external_events_not_configured');
    await off.close();

    const app = await server(TOKEN, new FakePublisher());
    const none = await app.inject({ method: 'POST', url: '/events/external', payload: { type: 'ext.ping', data: {} } });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    const wrong = await app.inject({ method: 'POST', url: '/events/external', headers: { authorization: 'Bearer nope' }, payload: { type: 'ext.ping', data: {} } });
    expect(wrong.statusCode).toBe(401);
    // Unauthenticated requests are rejected before the body is parsed (invalid JSON still 401).
    const garbage = await app.inject({
      method: 'POST',
      url: '/events/external',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(garbage.statusCode).toBe(401);
    await app.close();
  });

  it('400 on invalid bodies, 413 above the body limit, 202 + completed envelope when valid', async () => {
    const bus = new FakePublisher();
    const app = await server(TOKEN, bus);
    const post = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: '/events/external', headers: { ...auth, ...headers }, payload: payload as Record<string, unknown> });
    expect((await post({ type: 'task.completed', data: {} })).statusCode).toBe(400);
    expect((await post({ type: 'ext.ping', data: {}, unknown: true })).statusCode).toBe(400);
    expect((await post({ type: 'ext.ping', data: { blob: 'x'.repeat(70 * 1024) } })).statusCode).toBe(400);
    expect((await post({ type: 'ext.ping', data: { blob: 'x'.repeat(200 * 1024) } })).statusCode).toBe(413);
    expect((await post({ type: 'ext.ping', data: {} }, { 'x-tenant-id': 'bad tenant!' })).statusCode).toBe(400);
    expect(bus.inputs).toHaveLength(0);

    const ok = await post({ type: 'ext.lead.created', data: { email: 'x@y.z', chainDepth: 3 }, idempotency_key: 'k1' }, { 'x-tenant-id': 'acme' });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ created: true, dispatched: true, event: { type: 'ext.lead.created', tenantId: 'acme', producer: 'n8n' } });
    expect(bus.inputs[0]).toMatchObject({ tenantId: 'acme', producer: 'n8n', idempotencyKey: 'ext:n8n:k1', data: { email: 'x@y.z', chainDepth: 0 } });
    expect(bus.inputs[0]!.correlationId).toMatch(/^ext-/);
    const dup = await post({ type: 'ext.lead.created', data: {}, idempotency_key: 'k1' });
    expect(dup.statusCode).toBe(200);
    await app.close();
  });

  it('503 when the bus is not wired', async () => {
    const app = await server(TOKEN);
    const res = await app.inject({ method: 'POST', url: '/events/external', headers: auth, payload: { type: 'ext.ping', data: {} } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
