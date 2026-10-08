/**
 * audit_log end to end against a real PostgreSQL (no Redis): the hook of src/audit/hook.ts on
 * the administrative routes (activate blocked by the Release Gate, force with reason, canary,
 * optimizer close, knowledge), GET /audit with filters, nothing for GETs, and the append-only
 * triggers of migration 0015 (no UPDATE, DELETE or TRUNCATE).
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt12_ret.
 * Fresh tenants per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, optimizationRuns } from '../../src/db/schema.js';
import { createRun } from '../../src/optimizer/service.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

async function databaseReachable(url: string): Promise<boolean> {
  if (process.env.SKIP_DB_TESTS === '1') return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
const dbAvailable = await databaseReachable(DATABASE_URL);

type AuditOut = {
  id: string;
  tenant_id: string;
  action: string;
  actor: string;
  actor_ip: string | null;
  actor_label: string | null;
  subject_type: string;
  subject_id: string | null;
  subject_version: number | null;
  route: string;
  method: string;
  payload: Record<string, unknown>;
  result: string;
  status_code: number;
  error_code: string | null;
  details: Record<string, unknown>;
  occurred_at: string;
};

describe.skipIf(!dbAvailable)('audit_log (PostgreSQL)', () => {
  const tenant = `it-aud-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const skill = `aud-skill-${randomUUID().slice(0, 6)}`;
  let handle: DbHandle;
  let app: FastifyInstance;

  const post = (url: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, ...(payload !== undefined ? { payload } : {}) });
  const audit = async (query = ''): Promise<AuditOut[]> => {
    const res = await app.inject({ method: 'GET', url: `/audit${query}`, headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: AuditOut[] }).items;
  };
  /** Newest row of an action (the hook writes before the reply leaves: no wait needed). */
  const lastOf = async (action: string) => (await audit(`?action=${action}&limit=1`))[0];

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('a creation is audited with a summary of the body, never the full content', async () => {
    const instructions = `Instrucciones largas. ${'Detalle '.repeat(200)}`;
    const res = await post('/skills', { name: skill, instructions, created_by: 'it-audit' });
    expect(res.statusCode).toBe(201);
    const row = await lastOf('skill.create');
    expect(row).toMatchObject({
      tenant_id: tenant,
      actor: 'api',
      actor_label: 'it-audit',
      subject_type: 'skill',
      subject_id: skill,
      subject_version: 1,
      method: 'POST',
      route: '/skills',
      result: 'ok',
      status_code: 201,
      error_code: null,
    });
    expect(row!.payload.instructions).toMatchObject({ length: instructions.length, excerpt: instructions.slice(0, 120) });
    expect(JSON.stringify(row!.payload)).not.toContain(instructions);
    expect(row!.actor_ip).toBeTruthy();
  });

  it('an activation blocked by the Release Gate (409) is audited as rejected', async () => {
    const res = await post(`/skills/${skill}/versions/1/activate`, {});
    expect(res.statusCode).toBe(409);
    const row = await lastOf('skill.activate');
    expect(row).toMatchObject({ subject_id: skill, subject_version: 1, result: 'rejected', status_code: 409, error_code: 'release_gate_blocked' });
    expect(String(row!.details.message)).toContain('Release Gate');
  });

  it('a force without a valid reason (400) is still audited as skill.force_activate', async () => {
    const res = await post(`/skills/${skill}/versions/1/activate`, { force: true, reason: 'corto' });
    expect(res.statusCode).toBe(400);
    const row = await lastOf('skill.force_activate');
    expect(row).toMatchObject({ result: 'rejected', status_code: 400, error_code: 'validation_error', payload: { force: true, reason: 'corto' } });
  });

  it('a force with a reason is ALWAYS audited: who, why, the gate it overrode', async () => {
    const reason = 'Validado a mano con el equipo comercial: sin dataset aún';
    const res = await post(`/skills/${skill}/versions/1/activate`, { force: true, reason, by: 'jesus' }, { 'x-actor': 'jesus@publiexpe' });
    expect(res.statusCode).toBe(200);
    expect(res.json().gate).toMatchObject({ mode: 'override' });
    const row = await lastOf('skill.force_activate');
    expect(row).toMatchObject({
      actor_label: 'jesus@publiexpe',
      subject_type: 'skill',
      subject_id: skill,
      subject_version: 1,
      result: 'ok',
      status_code: 200,
      payload: { force: true, reason, by: 'jesus' },
      details: { changed: true, gate_mode: 'override' },
    });
  });

  it('canary steps are audited, also when the gate refuses them', async () => {
    const v2 = await post(`/skills/${skill}/versions`, { copy_from: 'active', instructions: 'Versión 2 de prueba.' });
    expect(v2.statusCode).toBe(201);
    const start = await post(`/skills/${skill}/versions/2/canary`, { percent: 10, by: 'it' });
    expect(start.statusCode).toBe(409);
    expect(await lastOf('canary.start')).toMatchObject({ subject_id: skill, subject_version: 2, result: 'rejected', status_code: 409, error_code: 'release_gate_blocked', payload: { percent: 10 } });
    const rollback = await post(`/skills/${skill}/canary/rollback`, { by: 'it', reason: 'no hay canario' });
    expect(await lastOf('canary.rollback')).toMatchObject({ subject_id: skill, status_code: rollback.statusCode, payload: { reason: 'no hay canario' } });
    expect(await lastOf('skill.version_create')).toMatchObject({ subject_version: 2, result: 'ok' });
  });

  it('optimizer close is audited (409 and ok)', async () => {
    const open = await createRun(handle.db, { tenantId: tenant, skillName: skill, baseVersion: 1, config: {} });
    const refused = await post(`/optimizer/runs/${open.id}/close`, { outcome: 'DISCARDED', by: 'it' });
    expect(refused.statusCode).toBe(409);
    expect(await lastOf('optimizer.close')).toMatchObject({ subject_type: 'optimization_run', subject_id: open.id, result: 'rejected', status_code: 409 });

    await handle.db.update(optimizationRuns).set({ status: 'GATE_FAIL' }).where(eq(optimizationRuns.id, open.id));
    const closed = await post(`/optimizer/runs/${open.id}/close`, { outcome: 'DISCARDED', by: 'it', reason: 'la candidata no mejora' });
    expect(closed.statusCode).toBe(200);
    expect(await lastOf('optimizer.close')).toMatchObject({ subject_id: open.id, result: 'ok', status_code: 200, actor_label: 'it', payload: { outcome: 'DISCARDED', reason: 'la candidata no mejora' } });
  });

  it('knowledge mutations are audited; GETs never are', async () => {
    const proposed = await post('/knowledge', { domain: 'prospeccion', topic: 'ferias', statement: 'Las ferias B2B convierten mejor en otoño.', confidence: 0.6, source: 'human' });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().entry.id as string;
    expect(await lastOf('knowledge.propose')).toMatchObject({ subject_type: 'knowledge_entry', subject_id: id, result: 'ok' });
    const rejected = await post(`/knowledge/${id}/reject`, { reason: 'sin evidencia' });
    expect(rejected.statusCode).toBe(200);
    expect(await lastOf('knowledge.reject')).toMatchObject({ subject_id: id, payload: { reason: 'sin evidencia' } });

    const before = (await audit('?limit=500')).length;
    await app.inject({ method: 'GET', url: `/knowledge/${id}`, headers });
    await app.inject({ method: 'GET', url: `/skills/${skill}`, headers });
    expect((await audit('?limit=500')).length).toBe(before);
  });

  it('GET /audit filters by action list, result, subject and time range, and isolates tenants', async () => {
    const forced = await audit('?action=skill.force_activate,harness.force_activate');
    expect(forced.length).toBe(2);
    expect(forced.every((r) => r.action === 'skill.force_activate')).toBe(true);
    // Newest first.
    expect(forced[0]!.result).toBe('ok');
    expect((await audit('?result=rejected')).every((r) => r.result === 'rejected')).toBe(true);
    expect((await audit(`?subject_type=skill&subject_id=${skill}`)).length).toBeGreaterThanOrEqual(6);
    expect(await audit(`?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual([]);
    expect((await audit(`?to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&limit=1`)).length).toBe(1);
    const other = await app.inject({ method: 'GET', url: '/audit', headers: { 'x-tenant-id': `it-aud-other-${randomUUID().slice(0, 6)}` } });
    expect(other.json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/audit?result=maybe', headers })).statusCode).toBe(400);
  });

  it('audit_log is append-only: UPDATE, DELETE and TRUNCATE are rejected by triggers', async () => {
    const [row] = await handle.db.select().from(auditLog).where(eq(auditLog.tenantId, tenant)).limit(1);
    expect(row).toBeDefined();
    // Each attempt runs inside a transaction that is always rolled back: even without the
    // trigger, this test could never change or remove a row.
    const rejectedInRollback = async (text: string, params: unknown[] = []) => {
      const client = await handle.pool.connect();
      try {
        await client.query('begin');
        await expect(client.query(text, params)).rejects.toThrow(/append-only/);
      } finally {
        await client.query('rollback');
        client.release();
      }
    };
    await rejectedInRollback(`update audit_log set action = 'tampered' where id = $1`, [row!.id]);
    await rejectedInRollback('delete from audit_log where id = $1', [row!.id]);
    await rejectedInRollback('truncate audit_log');
    const [still] = await handle.db.select().from(auditLog).where(eq(auditLog.id, row!.id));
    expect(still).toEqual(row);
  });
});
