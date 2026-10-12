/**
 * Knowledge layer + Research end to end against a real PostgreSQL (no Redis, no network):
 * migration 0009 (triggers and CHECKs), the knowledge API (propose, edit, activate only with
 * evidence, supersede, reject, no DELETE), the seed, and Prospector runs (RunProcessor +
 * StubProvider + FakeTwenty) that inject the ACTIVE entries of their domain, record the ids in
 * a MEMORY_READ trace step, and write one `research` per relevant exhibitor linked to company
 * and signal. Fresh tenants per run, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt9_knowledge.
 * Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { knowledgeEntries, taskDefinitions, taskRuns, traces, traceSteps } from '../../src/db/schema.js';
import { KNOWLEDGE_BLOCK_TITLE } from '../../src/knowledge/resolver.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { KNOWLEDGE_SEED, LEAD_TIME_KNOWLEDGE_STATEMENT, seedKnowledge } from '../../src/seed/knowledge-seed.js';
import { PROSPECTOR_TASK_NAME, seedProspector } from '../../src/seed/prospector-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

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

const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const RELEVANT = JSON.stringify({
  relevant: true,
  confidence: 0.85,
  reason: 'Fabricante con stand propio.',
  hypothesis: {
    need: 'Unas 400 bolsas tote y 100 abrebotellas para el stand.',
    why_now: 'Expone el 24/11.',
    quantity_min: 500,
    quantity_max: 900,
    budget_min_eur: 1500,
    budget_max_eur: 2500,
    recommended_products: ['Bolsas tote', 'Abrebotellas'],
    timing: 'IMMEDIATE',
    differentiators: ['TALLER_PROPIO'],
  },
});
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'Sin encaje.', hypothesis: null });

type EntryOut = { id: string; status: string; statement: string; evidence: unknown[]; valid_from: string | null; valid_until: string | null; superseded_by: string | null; activated_at: string | null };

describe.skipIf(!dbAvailable)('knowledge layer and research (PostgreSQL)', () => {
  const tenant = `it-kn-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const fake = new FakeTwenty();
  let handle: DbHandle;
  let app: FastifyInstance;
  let provider: StubProvider;
  let processor: RunProcessor;
  let runSeq = 0;

  const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  async function prospectorRun(tenantId: string, responses: string[]) {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-knowledge:${tenantId}:${++runSeq}`, trigger: 'MANUAL' });
    provider = new StubProvider({ responses });
    for (const { job } of queue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, run!.executionId!) });
    const steps = await handle.db.select().from(traceSteps).where(eq(traceSteps.traceId, trace!.id)).orderBy(traceSteps.sequence);
    return { systems: provider.requests.map((r) => r.system), run: run!, steps };
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    processor = new RunProcessor(handle.db, () => provider, { info() {}, warn() {}, error() {} }, createDefaultToolRegistry({ twenty: fake.client() }), null);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('API: propose -> edit -> activate only with evidence -> immutable; no DELETE route', async () => {
    const created = await post('/knowledge', { domain: 'prospeccion', topic: 'it-prueba', statement: 'Borrador sin evidencia.', confidence: 0.6, source: 'agent_proposal', created_by: 'it' });
    expect(created.statusCode).toBe(201);
    const e = (created.json() as { entry: EntryOut }).entry;
    expect(e).toMatchObject({ status: 'PROPOSED', evidence: [], valid_from: null });

    const noEvidence = await post(`/knowledge/${e.id}/activate`);
    expect(noEvidence.statusCode).toBe(400);
    expect(noEvidence.body).toMatch(/evidence/);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/knowledge/${e.id}`,
      headers,
      payload: { statement: 'Regla de prueba con evidencia.', evidence: [{ type: 'execution', ref: randomUUID(), note: 'traza de prueba' }] },
    });
    expect(patched.statusCode).toBe(200);
    expect((await post(`/knowledge/${e.id}/validate`)).json()).toMatchObject({ changed: true, entry: { status: 'VALIDATED' } });
    const act = await post(`/knowledge/${e.id}/activate`, { reason: 'ok' });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ changed: true, entry: { status: 'ACTIVE', statement: 'Regla de prueba con evidencia.' } });
    expect((act.json() as { entry: EntryOut }).entry.valid_from).not.toBeNull();
    expect((await post(`/knowledge/${e.id}/activate`)).json()).toMatchObject({ changed: false });

    // ACTIVE: content immutable (API 409 and trigger), cannot be rejected, no DELETE.
    expect((await app.inject({ method: 'PATCH', url: `/knowledge/${e.id}`, headers, payload: { statement: 'otra' } })).statusCode).toBe(409);
    expect((await post(`/knowledge/${e.id}/reject`, { reason: 'x' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/knowledge/${e.id}`, headers })).statusCode).toBe(404);
    await expect(handle.pool.query(`update knowledge_entries set statement = 'x' where id = $1`, [e.id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query(`update knowledge_entries set status = 'PROPOSED' where id = $1`, [e.id])).rejects.toThrow(/invalid transition/);
    await expect(handle.pool.query('delete from knowledge_entries where id = $1', [e.id])).rejects.toThrow(/no physical DELETE/);
    // The CHECK forbids an ACTIVE row without evidence even outside the API.
    await expect(
      handle.pool.query(`insert into knowledge_entries (tenant_id, domain, topic, statement, confidence, source, status) values ($1, 'x', 'y', 'z', 0.5, 'human', 'ACTIVE')`, [tenant]),
    ).rejects.toThrow(/knowledge_entries_active_evidence_ck/);

    // Validation and tenant isolation.
    expect((await post('/knowledge', { domain: 'Mal Dominio', topic: 't', statement: 's', confidence: 0.5, source: 'human' })).statusCode).toBe(400);
    expect((await post('/knowledge', { domain: 'email', topic: 't', statement: 'x'.repeat(401), confidence: 0.5, source: 'human' })).statusCode).toBe(400);
    expect((await post('/knowledge', { domain: 'email', topic: 't', statement: 's', confidence: 1.5, source: 'human' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/knowledge/${e.id}`, headers: { 'x-tenant-id': 'otro-tenant' } })).statusCode).toBe(404);
  });

  it('API: supersede with a replacement (activated in the same transaction) and reject a proposal', async () => {
    const mk = async (statement: string) =>
      ((await post('/knowledge', { domain: 'email', topic: 'it-tono', statement, confidence: 0.7, source: 'human', evidence: [{ type: 'feedback', ref: '2026-10-07' }] })).json() as { entry: EntryOut }).entry;
    const old = await mk('Tono cercano.');
    await post(`/knowledge/${old.id}/activate`);
    const replacement = await mk('Tono cercano, sin tutear en el asunto.');
    const sup = await post(`/knowledge/${old.id}/supersede`, { superseded_by: replacement.id, reason: 'matiz del comercial' });
    expect(sup.statusCode).toBe(200);
    expect(sup.json()).toMatchObject({ changed: true, entry: { status: 'SUPERSEDED', superseded_by: replacement.id, status_reason: 'matiz del comercial' }, replacement: { id: replacement.id, status: 'ACTIVE' } });
    expect((sup.json() as { entry: EntryOut }).entry.valid_until).not.toBeNull();
    expect((await post(`/knowledge/${old.id}/supersede`)).json()).toMatchObject({ changed: false });
    expect((await post(`/knowledge/${old.id}/activate`)).statusCode).toBe(409);

    const bad = await mk('Propuesta mala.');
    expect((await post(`/knowledge/${bad.id}/reject`, {})).statusCode).toBe(400); // reason required
    expect((await post(`/knowledge/${bad.id}/reject`, { reason: 'sin evidencia real' })).json()).toMatchObject({ changed: true, entry: { status: 'REJECTED' } });
    expect((await post(`/knowledge/${bad.id}/activate`)).statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/knowledge?domain=email&status=ACTIVE', headers });
    expect((list.json() as { items: EntryOut[] }).items.map((i) => i.id)).toEqual([replacement.id]);
  });

  it('seed: the documented entries are created ACTIVE with their evidence; idempotent', async () => {
    const t = `${tenant}-seed`;
    const first = await seedKnowledge(handle.db, { tenantId: t });
    expect(first.created).toHaveLength(KNOWLEDGE_SEED.length);
    const rows = await handle.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.tenantId, t));
    expect(rows.every((r) => r.status === 'ACTIVE' && r.evidence.length > 0 && r.activatedAt !== null && r.createdBy === 'seed')).toBe(true);
    expect(rows.find((r) => r.topic === 'cantidades-y-presupuesto')!.evidence.map((e) => e.ref)).toContain('EXP-001');
    const second = await seedKnowledge(handle.db, { tenantId: t });
    expect(second.created).toHaveLength(0);
    expect(second.unchanged.map((u) => u.status)).toEqual(KNOWLEDGE_SEED.map(() => 'ACTIVE'));
  });

  it('Prospector run: ACTIVE entries of its domain in the prompt, ids in a MEMORY_READ step; research linked to company and signal', async () => {
    const t = `${tenant}-run`;
    await seedKnowledge(handle.db, { tenantId: t });
    // Noise that must NOT reach the Prospector: another domain, a proposal, a superseded entry.
    const other = await seedKnowledge(handle.db, {
      tenantId: t,
      entries: [{ domain: 'scoring', topic: 'otro', statement: 'No es del Prospector.', evidence: [{ type: 'document', ref: 'x' }], confidence: 0.5, source: 'human' }],
    });
    expect(other.created).toHaveLength(1);
    await handle.db.insert(knowledgeEntries).values({ tenantId: t, domain: 'prospeccion', topic: 'propuesta', statement: 'Propuesta sin validar.', confidence: 0.4, source: 'agent_proposal' });
    await seedProspector(handle.db, { tenantId: t, defaultInput: fixture });

    const r = await prospectorRun(t, [RELEVANT, IRRELEVANT, IRRELEVANT]);
    expect(r.run.status).toBe('COMPLETED');
    expect(r.systems).toHaveLength(3);
    const active = await handle.db
      .select()
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.tenantId, t), eq(knowledgeEntries.domain, 'prospeccion'), eq(knowledgeEntries.status, 'ACTIVE')));
    // Seed entries of the domain: cantidades-y-presupuesto, suposiciones-por-nombre and (tanda 18) lead-time-comercial.
    expect(active).toHaveLength(3);
    expect(active.map((a) => a.topic)).toContain('lead-time-comercial');
    for (const s of r.systems) {
      expect(s).toContain(LEAD_TIME_KNOWLEDGE_STATEMENT);
      expect(s).toContain(`${KNOWLEDGE_BLOCK_TITLE}\n`);
      for (const a of active) expect(s).toContain(a.statement);
      expect(s).not.toContain('No es del Prospector.');
      expect(s).not.toContain('Propuesta sin validar.');
      expect(s).not.toContain('expertos en merchandising para empresas en la misma frase'); // email domain
    }
    const memory = r.steps[0]!;
    expect(memory.type).toBe('MEMORY_READ');
    expect(memory.output).toMatchObject({ resolution: 'ok', injected: true });
    expect(((memory.output as { knowledge_entry_ids: string[] }).knowledge_entry_ids).sort()).toEqual(active.map((a) => a.id).sort());

    // Research in Twenty: one for the relevant exhibitor, linked to its company and signal, with the execution id.
    const researches = fake.tables.researches.filter((x) => x.tenantId === t);
    expect(researches).toHaveLength(1);
    const company = fake.tables.companies.find((c) => c.id === researches[0]!.companyId)!;
    const signal = fake.tables.commercialSignals.find((s) => s.id === researches[0]!.commercialSignalId)!;
    expect(company.name).toBe('Conservas Marineras del Cantábrico');
    expect(signal.companyId).toBe(company.id);
    expect(researches[0]).toMatchObject({ researchType: 'EVENT_EXHIBITORS', agentExecutionId: r.run.executionId, sources: ['https://expoalimentariaiberica.example/expositores'] });
    const output = r.run.output as { counters: Record<string, number> };
    expect(output.counters).toMatchObject({ research_created: 1, research_errors: 0, llm_calls: 3 });
  });

  it('agent without knowledge_domains or a domain with no entries: prompt unchanged, no MEMORY_READ noise', async () => {
    const t = `${tenant}-empty`;
    await seedProspector(handle.db, { tenantId: t, defaultInput: fixture });
    const r = await prospectorRun(t, [IRRELEVANT, IRRELEVANT, IRRELEVANT]);
    expect(r.run.status).toBe('COMPLETED');
    expect(r.systems.every((s) => !(s ?? '').includes(KNOWLEDGE_BLOCK_TITLE))).toBe(true);
    expect(r.steps[0]).toMatchObject({ type: 'MEMORY_READ', output: { resolution: 'empty', knowledge_entry_ids: [], injected: false } });
  });
});
