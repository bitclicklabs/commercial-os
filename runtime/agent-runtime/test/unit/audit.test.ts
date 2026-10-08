/**
 * audit_log without a database: payload summary, the row built for one request, and the
 * classification of every mutating route (audited or exempted with a reason).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { AUDITED_ROUTES, NOT_AUDITED } from '../../src/audit/catalog.js';
import { auditRow, unclassifiedMutatingRoutes } from '../../src/audit/hook.js';
import { resultOf } from '../../src/audit/service.js';
import { EXCERPT, sha256Hex, summarizePayload } from '../../src/audit/summary.js';
import type { Db } from '../../src/db/client.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

function fakeReq(p: { params?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; method?: string }): FastifyRequest {
  return { params: p.params ?? {}, body: p.body, headers: p.headers ?? {}, method: p.method ?? 'POST', ip: '10.0.0.7', id: 'req-1' } as unknown as FastifyRequest;
}

describe('summarizePayload', () => {
  it('keeps flags, numbers, short strings and short id lists as they are', () => {
    const s = summarizePayload({ force: true, percent: 10, by: 'jesus', case_ids: ['a', 'b'], note: null });
    expect(s).toEqual({ force: true, percent: 10, by: 'jesus', case_ids: ['a', 'b'], note: null });
  });

  it('digests long texts and objects instead of copying them', () => {
    const instructions = 'x'.repeat(5_000);
    const s = summarizePayload({ instructions, config: { execution: { timeout_seconds: 30 } }, evidence: [{ trace_id: 't1' }] });
    expect(s.instructions).toEqual({ sha256: sha256Hex(instructions), length: 5_000, excerpt: 'x'.repeat(EXCERPT) });
    // One level of nesting is kept; deeper objects are digested.
    expect(s.config).toMatchObject({ execution: { type: 'object', keys: 1 } });
    expect(s.evidence).toMatchObject({ type: 'array', items: 1 });
    expect(JSON.stringify(s)).not.toContain('x'.repeat(EXCERPT + 1));
  });

  it('keeps the full reason of a human decision (force override)', () => {
    const reason = 'r'.repeat(1_500);
    expect(summarizePayload({ force: true, reason }).reason).toBe(reason);
  });

  it('handles empty and non-object bodies', () => {
    expect(summarizePayload(undefined)).toEqual({});
    expect(summarizePayload('raw')).toEqual({ _body: 'raw' });
  });
});

describe('auditRow', () => {
  const spec = AUDITED_ROUTES['POST /skills/:id/versions/:v/activate']!;

  it('names a forced activation skill.force_activate and keeps who and why', () => {
    const req = fakeReq({ params: { id: 'prospector-event-exhibitors', v: '3' }, body: { force: true, reason: 'urgencia comercial validada', by: 'jesus' }, headers: { 'x-tenant-id': 'acme' } });
    const row = auditRow(req, spec, '/skills/:id/versions/:v/activate', 200, { changed: true, gate: { mode: 'override' } }, 'publiexpe');
    expect(row).toMatchObject({
      tenantId: 'acme',
      actor: 'api',
      actorIp: '10.0.0.7',
      actorLabel: 'jesus',
      action: 'skill.force_activate',
      subjectType: 'skill',
      subjectId: 'prospector-event-exhibitors',
      subjectVersion: 3,
      result: 'ok',
      statusCode: 200,
      errorCode: null,
      details: { changed: true, gate_mode: 'override' },
    });
    expect(row.payload).toMatchObject({ force: true, reason: 'urgencia comercial validada' });
  });

  it('records a 409 of the Release Gate as rejected with its error code', () => {
    const req = fakeReq({ params: { id: 'skill-a', v: '2' }, body: {}, headers: { 'x-actor': 'operador' } });
    const row = auditRow(req, spec, '/skills/:id/versions/:v/activate', 409, { error: 'release_gate_blocked', message: 'Release Gate: sin experimento', details: { required: 'experimento PASS' } }, 'publiexpe');
    expect(row).toMatchObject({ action: 'skill.activate', result: 'rejected', errorCode: 'release_gate_blocked', actorLabel: 'operador', tenantId: 'publiexpe' });
    expect(row.details).toMatchObject({ message: 'Release Gate: sin experimento', required: 'experimento PASS' });
  });

  it('falls back to the default tenant and flags an invalid tenant header', () => {
    const req = fakeReq({ params: { id: 'x', v: '1' }, headers: { 'x-tenant-id': 'bad tenant!' } });
    const row = auditRow(req, spec, '/skills/:id/versions/:v/activate', 400, { error: 'invalid_tenant' }, 'publiexpe');
    expect(row.tenantId).toBe('publiexpe');
    expect(row.details).toMatchObject({ invalid_tenant_header: 'bad tenant!' });
  });

  it('maps status codes to results', () => {
    expect(resultOf(201)).toBe('ok');
    expect(resultOf(409)).toBe('rejected');
    expect(resultOf(503)).toBe('error');
  });
});

describe('route classification', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const unreachableDb = new Proxy({} as Db, {
      get() {
        throw new Error('database must not be touched in this test');
      },
    });
    app = await buildServer({ db: unreachableDb, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('every mutating route is either audited or exempted with a reason', () => {
    expect(unclassifiedMutatingRoutes(app)).toEqual([]);
  });

  it('the catalog only names routes that exist (no stale entries)', () => {
    for (const key of [...Object.keys(AUDITED_ROUTES), ...Object.keys(NOT_AUDITED)]) {
      const [method, url] = key.split(' ') as [string, string];
      expect(app.hasRoute({ method: method as 'POST', url }), key).toBe(true);
    }
  });

  it('an audit failure never changes the reply (the action is already decided)', async () => {
    // The fake database throws on any access: the 400 is still a 400.
    const res = await app.inject({ method: 'POST', url: '/skills/s/versions/1/activate', payload: { force: true } });
    expect(res.statusCode).toBe(400);
  });
});
