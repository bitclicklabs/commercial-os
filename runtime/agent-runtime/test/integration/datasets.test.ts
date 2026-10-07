/**
 * Evaluation datasets end to end against a real PostgreSQL (no Redis, no network): migration
 * 0010 (triggers), the harvest of synthetic Prospector traces (direct and scout mode) and
 * human verdicts, the API (create, build a new version, cases by split, fixtures, mark-used,
 * activate; no DELETE) and P5 (vetoed cases are not served, uses are inherited by new versions).
 * Fresh tenant per run, nothing is deleted.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt10_datasets.
 * Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProspectorInput } from '../../src/agents/prospector-core.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, evaluations, traces, traceSteps } from '../../src/db/schema.js';
import { entityKeyOf, hashSplit } from '../../src/datasets/core.js';
import { buildDataset } from '../../src/datasets/service.js';
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

const DATASET = 'it-prospeccion';
/** A name whose entity hashes to `split` for this dataset (the test does not depend on luck). */
function nameIn(split: 'TRAIN' | 'VALIDATION' | 'TEST', prefix: string): string {
  for (let i = 0; i < 1000; i++) if (hashSplit(DATASET, entityKeyOf(`${prefix} ${i}`)) === split) return `${prefix} ${i}`;
  throw new Error('no name');
}

const A = nameIn('TEST', 'Aceptada');
const C = nameIn('VALIDATION', 'Editada');
const D = nameIn('VALIDATION', 'Libre Val');
const E = nameIn('TEST', 'Libre Test');
const F = nameIn('TRAIN', 'Scout Sector');
const G = nameIn('TEST', 'Scout Nombre');
const PUBLIC = 'AYUNTAMIENTO DE VILLAPRUEBA';

const EVENT = { name: 'Feria IT 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia', source_url: 'https://feria-it.example/expositores' };

type CaseOut = { id: string; split: string; entity_key: string; input: { event: Record<string, unknown>; exhibitor: Record<string, unknown> }; expected: Record<string, unknown>; source: Record<string, unknown>; context: Record<string, unknown>; tags: string[]; used_by: Array<Record<string, unknown>>; content_hash: string; vetoed: string | null };
type DatasetOut = { id: string; version: number; status: string; name: string; counts: { total: number; by_split: Record<string, number>; labeled_by_split: Record<string, number>; burned_by_split: Record<string, number> } };

describe.skipIf(!dbAvailable)('evaluation datasets (PostgreSQL)', () => {
  const tenant = `it-ds-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  let v1: DatasetOut;

  const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  const get = (url: string, h: Record<string, string> = headers) => app.inject({ method: 'GET', url, headers: h });
  const casesOf = async (id: string, query = '') => (await get(`/datasets/${id}/cases${query}`)).json() as { items: CaseOut[]; vetoed: number };
  const byName = (items: CaseOut[], name: string) => items.find((c) => c.entity_key === entityKeyOf(name));

  async function seedTraces(): Promise<void> {
    const db = handle.db;
    const [agent] = await db.insert(agents).values({ tenantId: tenant, name: 'Prospector' }).returning();
    const [version] = await db.insert(agentVersions).values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'gemini-flash-latest', modelProvider: 'gemini' }).returning();
    const [stubAgent] = await db.insert(agents).values({ tenantId: tenant, name: 'Prospector stub' }).returning();
    const [stubVersion] = await db.insert(agentVersions).values({ tenantId: tenant, agentId: stubAgent!.id, version: 1, model: 'stub', modelProvider: 'stub' }).returning();

    const run = async (opts: { agentId: string; versionId: string; input: Record<string, unknown>; finalOutput: Record<string, unknown>; steps: Array<Partial<typeof traceSteps.$inferInsert>> }) => {
      const [exec] = await db.insert(agentExecutions).values({ tenantId: tenant, agentId: opts.agentId, agentVersionId: opts.versionId, status: 'COMPLETED', input: opts.input, output: opts.finalOutput }).returning();
      const [trace] = await db
        .insert(traces)
        .values({ tenantId: tenant, executionId: exec!.id, agentId: opts.agentId, agentVersionId: opts.versionId, finalOutput: opts.finalOutput, skillVersions: [{ name: 'prospector-event-exhibitors', version: 1, skill_version_id: null, content_hash: 'h1', source: 'db', requested: null }] })
        .returning();
      let sequence = 0;
      for (const s of opts.steps) await db.insert(traceSteps).values({ tenantId: tenant, traceId: trace!.id, sequence: ++sequence, type: 'MODEL', ...s } as typeof traceSteps.$inferInsert);
      return { executionId: exec!.id, traceId: trace!.id };
    };
    const decision = (name: string, attempt = 1) => ({ type: 'MODEL' as const, input: { exhibitor: name, attempt }, output: { valid: true, decision: { relevant: true, confidence: 0.8 } } });
    const hypothesis = (id: string, name: string) => ({ type: 'TOOL' as const, tool: 'create_hypothesis', toolInput: { name: `${name} — ${EVENT.name}`, need: 'Unas 300 bolsas tote.', whyNow: 'Expone el 20/11.', quantityMin: 300, quantityMax: 500, budgetMinEur: 600, budgetMaxEur: 1000, recommendedProducts: ['Bolsas tote'], timing: 'IMMEDIATE' }, toolOutput: { record: { id, name: `${name} — ${EVENT.name}` }, created: true } });

    const hypA = randomUUID();
    const hypC = randomUUID();
    const direct = await run({
      agentId: agent!.id,
      versionId: version!.id,
      input: { event: EVENT, exhibitors: [{ name: A, sector: 'Alimentación', domain: 'aceptada.example' }, { name: PUBLIC, sector: 'Organismos públicos' }, { name: C }, { name: D }, { name: E, description: 'Fabricante con 40 empleados.' }] },
      finalOutput: { results: [{ name: A, hypothesis_id: hypA }, { name: C, hypothesis_id: hypC }] },
      steps: [decision(A), hypothesis(hypA, A), decision(PUBLIC), decision(C), decision(C, 2), hypothesis(hypC, C), decision(D), decision(E)],
    });
    await run({
      agentId: agent!.id,
      versionId: version!.id,
      input: { event_url: 'https://feria-scout.example' },
      finalOutput: { events: [{ name: 'Feria Scout 2026', date: '2026-12-01', location: 'Madrid', source_url: 'https://feria-scout.example/expositores', results: [{ name: F }, { name: G }] }] },
      steps: [
        { type: 'MODEL', input: { step: 'scout_extract', url: 'https://feria-scout.example/expositores', attempt: 1 }, output: { valid: true, decision: { exhibitors: [{ name: F, sector: 'Bebidas', domain: null, description: null }, { name: G, sector: null }] } } },
        decision(F),
        decision(G),
      ],
    });
    // Stub runs are not real data: never harvested.
    await run({ agentId: stubAgent!.id, versionId: stubVersion!.id, input: { event: EVENT, exhibitors: [{ name: 'Solo Stub SL' }] }, finalOutput: {}, steps: [decision('Solo Stub SL')] });

    const human = { actor: { human: true, source: 'MANUAL', name: 'Comercial' } };
    await db.insert(evaluations).values([
      { tenantId: tenant, subjectType: 'hypothesis', subjectId: hypA, agentExecutionId: direct.executionId, feedback: 'ACCEPTED', score: 1, source: 'twenty_webhook', details: { ...human, hypothesis_name: `${A} — ${EVENT.name}`, edited_fields: {} } },
      { tenantId: tenant, subjectType: 'hypothesis', subjectId: hypC, agentExecutionId: direct.executionId, feedback: 'EDITED', score: 0.5, source: 'twenty_webhook', details: { ...human, hypothesis_name: `${C} — ${EVENT.name}`, edited_fields: { quantityMax: { before: 500, after: 900 } } } },
      // Not harvested: a non-human verdict and a [TEST] record.
      { tenantId: tenant, subjectType: 'hypothesis', subjectId: hypA, agentExecutionId: direct.executionId, feedback: 'DISCARDED', score: 0, source: 'twenty_webhook', details: { actor: { human: false, source: 'API' }, hypothesis_name: `${A} — ${EVENT.name}` } },
      { tenantId: tenant, subjectType: 'hypothesis', subjectId: randomUUID(), agentExecutionId: direct.executionId, feedback: 'ACCEPTED', score: 1, source: 'twenty_webhook', details: { ...human, hypothesis_name: '[TEST] pxos-it algo' } },
    ]);
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    await seedTraces();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('dry run writes nothing; POST /datasets harvests v1 with the documented rules and splits', async () => {
    const dry = await buildDataset(handle.db, { tenantId: tenant, name: DATASET, domain: 'prospeccion', dryRun: true });
    expect(dry.dataset).toBeNull();
    expect((await get('/datasets')).json()).toEqual({ items: [] });

    const res = await post('/datasets', { name: DATASET, domain: 'prospeccion', description: 'IT', created_by: 'it' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { dataset: DatasetOut; summary: { by_kind: Record<string, number> } };
    v1 = body.dataset;
    expect(v1).toMatchObject({ version: 1, status: 'DRAFT', name: DATASET });
    expect(body.summary.by_kind).toEqual({ human_verdict: 2, structural_discard: 1, unlabeled: 4 });
    expect(v1.counts.total).toBe(7);
    expect(v1.counts.by_split).toEqual({ TRAIN: 1 + Number(hashSplit(DATASET, entityKeyOf(PUBLIC)) === 'TRAIN'), VALIDATION: 2 + Number(hashSplit(DATASET, entityKeyOf(PUBLIC)) === 'VALIDATION'), TEST: 3 + Number(hashSplit(DATASET, entityKeyOf(PUBLIC)) === 'TEST') });

    const all = (await casesOf(v1.id)).items;
    expect(all.map((c) => c.input.exhibitor.name).sort()).toEqual([A, C, D, E, F, G, PUBLIC].sort()); // no stub run
    for (const c of all) expect(c.split).toBe(hashSplit(DATASET, c.entity_key)); // nothing burned here

    const a = byName(all, A)!;
    expect(a.input).toEqual({ event: EVENT, exhibitor: { name: A, sector: 'Alimentación', domain: 'aceptada.example' } });
    expect(a.expected).toMatchObject({ kind: 'human_verdict', feedback: 'ACCEPTED', relevant: true, reference_hypothesis: { quantity_min: 300, quantity_max: 500 } });
    expect(a.source).toMatchObject({ origin: 'harvested', expected_source: 'human', input_fidelity: 'execution_input', position: 1 });
    expect(a.context).toMatchObject({ mode: 'direct', data_level: 'rich', agent: { name: 'Prospector', model: 'gemini-flash-latest' } });
    const c = byName(all, C)!;
    expect(c.expected).toMatchObject({ feedback: 'EDITED', reference_hypothesis: { quantity_max: 900 } });
    expect(c.source).toMatchObject({ position: 3 }); // the repair attempt does not count as a position
    expect(byName(all, PUBLIC)!.expected).toMatchObject({ kind: 'structural_discard', relevant: false, confidence_max: 0.19 });
    const f = byName(all, F)!;
    expect(f.input).toEqual({ event: { name: 'Feria Scout 2026', type: 'FAIR', date: '2026-12-01', location: 'Madrid', source_url: 'https://feria-scout.example/expositores' }, exhibitor: { name: F, sector: 'Bebidas' } });
    expect(f.source).toMatchObject({ input_fidelity: 'llm_extraction' });
    expect(f.context).toMatchObject({ mode: 'scout', data_level: 'sector' });
    expect(new Set(all.map((x) => x.content_hash)).size).toBe(7);

    const one = (await get(`/datasets/${v1.id}`)).json() as { dataset: DatasetOut };
    expect(one.dataset.counts).toEqual(v1.counts);
    expect(Object.values(one.dataset.counts.labeled_by_split).reduce((x, y) => x + y, 0)).toBe(3);
    expect((await casesOf(v1.id, '?split=TEST')).items.map((x) => x.input.exhibitor.name).sort()).toEqual([A, E, G, ...(hashSplit(DATASET, entityKeyOf(PUBLIC)) === 'TEST' ? [PUBLIC] : [])].sort());

    // Same name again: 409 (a new version goes through /build). Validation and tenant isolation.
    expect((await post('/datasets', { name: DATASET, domain: 'prospeccion' })).statusCode).toBe(409);
    expect((await post('/datasets', { name: 'Mal Nombre', domain: 'prospeccion' })).statusCode).toBe(400);
    expect((await post('/datasets', { name: 'x', domain: 'email' })).statusCode).toBe(400);
    expect((await get(`/datasets/${v1.id}`, { 'x-tenant-id': 'otro-tenant' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/datasets/${v1.id}`, headers })).statusCode).toBe(404);
  });

  it('triggers: cases immutable except used_by (append-only), no DELETE, no new cases once ACTIVE', async () => {
    const all = (await casesOf(v1.id)).items;
    const id = byName(all, F)!.id; // a TRAIN case: the direct SQL use below does not affect the P5 test
    await expect(handle.pool.query(`update evaluation_cases set input = '{}'::jsonb where id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query(`update evaluation_cases set split = 'TEST' where id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query('delete from evaluation_cases where id = $1', [id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query('delete from evaluation_datasets where id = $1', [v1.id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query(`update evaluation_datasets set description = 'otra' where id = $1`, [v1.id])).rejects.toThrow(/immutable/);
    // used_by grows (direct SQL here) but never shrinks.
    await handle.pool.query(`update evaluation_cases set used_by = used_by || '[{"experiment":"EXP-SQL","role":"design","at":"2026-10-07","via":"mark_used"}]'::jsonb where id = $1`, [id]);
    await expect(handle.pool.query(`update evaluation_cases set used_by = '[]'::jsonb where id = $1`, [id])).rejects.toThrow(/append-only/);

    const act = await post(`/datasets/${v1.id}/activate`);
    expect(act.json()).toMatchObject({ changed: true, dataset: { status: 'ACTIVE' } });
    expect((await post(`/datasets/${v1.id}/activate`)).json()).toMatchObject({ changed: false });
    await expect(
      handle.pool.query(`insert into evaluation_cases (dataset_id, tenant_id, split, entity_key, input, source, content_hash) values ($1, $2, 'TRAIN', 'org:x', '{}', '{"origin":"manual","expected_source":"none"}', 'h')`, [v1.id, tenant]),
    ).rejects.toThrow(/only added while DRAFT/);
    await expect(handle.pool.query(`update evaluation_datasets set status = 'DRAFT' where id = $1`, [v1.id])).rejects.toThrow(/invalid transition/);
  });

  it('mark-used (P5): design burns a held-out case; validation is exclusive to one experiment and role', async () => {
    const all = (await casesOf(v1.id)).items;
    const d = byName(all, D)!;
    const c = byName(all, C)!;
    expect([d.split, c.split]).toEqual(['VALIDATION', 'VALIDATION']);

    const design = await post(`/datasets/${v1.id}/mark-used`, { case_ids: [d.id], experiment: 'EXP-IT-1', role: 'design', by: 'it' });
    expect(design.statusCode).toBe(200);
    expect(design.json()).toEqual({ marked: [d.id], already: [], newly_burned: [d.id] });
    const val = await casesOf(v1.id, '?split=VALIDATION');
    expect(val.items.map((x) => x.id)).not.toContain(d.id);
    expect(val.vetoed).toBeGreaterThanOrEqual(1);
    const withVetoed = await casesOf(v1.id, '?split=VALIDATION&include_vetoed=true');
    expect(withVetoed.items.find((x) => x.id === d.id)!.vetoed).toMatch(/design by EXP-IT-1/);
    // Vetoed: nothing is written (all or nothing).
    const refused = await post(`/datasets/${v1.id}/mark-used`, { case_ids: [c.id, d.id], experiment: 'EXP-IT-2', role: 'validation' });
    expect(refused.statusCode).toBe(409);
    expect((await casesOf(v1.id, '?split=VALIDATION&include_vetoed=true')).items.find((x) => x.id === c.id)!.used_by).toEqual([]);

    expect((await post(`/datasets/${v1.id}/mark-used`, { case_ids: [c.id], experiment: 'EXP-IT-2', role: 'validation' })).json()).toMatchObject({ marked: [c.id] });
    expect((await post(`/datasets/${v1.id}/mark-used`, { case_ids: [c.id], experiment: 'EXP-IT-2', role: 'validation' })).json()).toMatchObject({ marked: [], already: [c.id] });
    expect((await post(`/datasets/${v1.id}/mark-used`, { case_ids: [c.id], experiment: 'EXP-IT-2', role: 'test' })).statusCode).toBe(409);
    expect((await post(`/datasets/${v1.id}/mark-used`, { case_ids: [c.id], experiment: 'EXP-IT-3', role: 'validation' })).statusCode).toBe(409);
    // The experiment that validated with it still gets it (re-run); a new experiment does not.
    expect((await casesOf(v1.id, '?split=VALIDATION&experiment=EXP-IT-2')).items.map((x) => x.id)).toContain(c.id);
    expect((await casesOf(v1.id, '?split=VALIDATION')).items.map((x) => x.id)).not.toContain(c.id);

    expect((await post(`/datasets/${v1.id}/mark-used`, { case_ids: [randomUUID()], experiment: 'EXP-IT-2', role: 'design' })).statusCode).toBe(404);
    expect((await post(`/datasets/${v1.id}/mark-used`, { case_ids: [c.id], experiment: 'mal id con espacios', role: 'design' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/datasets/${v1.id}/mark-used`, headers: { 'x-tenant-id': 'otro-tenant' }, payload: { case_ids: [c.id], experiment: 'EXP-X', role: 'design' } })).statusCode).toBe(404);
  });

  it('POST /datasets/:id/build: a new version; v1 untouched; splits stable; uses inherited and forced to TRAIN', async () => {
    const before = (await casesOf(v1.id)).items;
    const res = await post(`/datasets/${v1.id}/build`, { created_by: 'it' });
    expect(res.statusCode).toBe(201);
    const v2 = (res.json() as { dataset: DatasetOut; parent: { version: number } }).dataset;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT' });
    expect((res.json() as { parent: { version: number } }).parent.version).toBe(1);

    const after = (await casesOf(v1.id)).items;
    expect(after.map((x) => [x.id, x.split, x.content_hash])).toEqual(before.map((x) => [x.id, x.split, x.content_hash]));
    expect(((await get(`/datasets/${v1.id}`)).json() as { dataset: DatasetOut }).dataset.status).toBe('ACTIVE');

    const cases2 = (await casesOf(v2.id)).items;
    expect(cases2).toHaveLength(7);
    const d2 = byName(cases2, D)!;
    const c2 = byName(cases2, C)!;
    expect(d2.split).toBe('TRAIN');
    expect(d2.tags).toEqual(expect.arrayContaining(['burned', 'exp-it-1:design']));
    expect(d2.used_by[0]).toMatchObject({ experiment: 'EXP-IT-1', role: 'design', via: 'inherited', from_version: 1 });
    expect(c2.split).toBe('TRAIN');
    for (const name of [A, E, G]) expect(byName(cases2, name)!.split).toBe('TEST'); // same entity, same split
    expect(byName(cases2, A)!.content_hash).toBe(byName(before, A)!.content_hash);

    // Fixtures for skill:compare: the TEST split as `{ event, exhibitors[] }`.
    const fx = (await get(`/datasets/${v2.id}/fixtures?split=TEST`)).json() as { fixtures: Array<{ event: unknown; exhibitors: unknown[]; case_ids: string[] }> };
    expect(fx.fixtures.flatMap((x) => x.case_ids).sort()).toEqual(cases2.filter((x) => x.split === 'TEST').map((x) => x.id).sort());
    for (const x of fx.fixtures) expect(() => ProspectorInput.parse({ event: x.event, exhibitors: x.exhibitors })).not.toThrow();

    // Activating v2 archives v1.
    expect((await post(`/datasets/${v2.id}/activate`)).json()).toMatchObject({ changed: true, archived: [v1.id] });
    const list = (await get(`/datasets?name=${DATASET}`)).json() as { items: DatasetOut[] };
    expect(list.items.map((x) => [x.version, x.status])).toEqual([
      [2, 'ACTIVE'],
      [1, 'ARCHIVED'],
    ]);
    expect((await post(`/datasets/${v1.id}/activate`)).statusCode).toBe(409);
  });
});
