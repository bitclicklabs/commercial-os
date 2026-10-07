/**
 * Experiments + Release Gate end to end against a real PostgreSQL, with scripted providers
 * (no network): the runner reserves cases with P5 (markUsed, contamination aborts), runs
 * baseline and candidate, evaluates, applies the gate (form mode -> PASS_FORM; labelled ->
 * PASS with TEST, or FAIL without touching TEST), stores an immutable experiment, and the
 * activation endpoint enforces the gate (blocked, PASS/PASS_FORM, stale baseline, human
 * override, rollback). Fresh tenants per run, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt10_experiments.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { markUsed } from '../../src/datasets/service.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { evaluationCases, evaluationDatasets, evaluations, experiments } from '../../src/db/schema.js';
import { ExperimentAbortedError, gateConfig, renderExperimentMarkdown, runExperiment, type RunnerDeps } from '../../src/experiments/index.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../../src/providers/model-provider.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { createVersion } from '../../src/skills/service.js';
import { caseContentHash } from '../../src/datasets/core.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
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

// ---------------------------------------------------------------------------
// Scripted providers
// ---------------------------------------------------------------------------

type Answer = { relevant: boolean; confidence: number; reason: string; hypothesis: Record<string, unknown> | null };
type Script = (version: 'base' | 'cand', exhibitor: string) => Answer;

const hyp = (q: [number, number], b: [number, number], need: string) => ({
  need,
  why_now: 'La feria es el 20/11/2026: el taller propio llega a tiempo.',
  quantity_min: q[0],
  quantity_max: q[1],
  budget_min_eur: b[0],
  budget_max_eur: b[1],
  recommended_products: ['bolsas tote', 'polos bordados'],
  timing: 'THIS_QUARTER',
  differentiators: ['TALLER_PROPIO'],
});
/** v1-like answer: no quantities in need, template range (F1), confident with name only (F2), no assumption marker (F3). */
const weak = (): Answer => ({ relevant: true, confidence: 0.7, reason: 'Encaje de prueba: empresa del sector con stand.', hypothesis: hyp([250, 1000], [600, 2200], 'Regalo para visitantes del stand.') });
/** v3-like answer: quantities, bounded range, derived budget, marked assumption, capped confidence. */
const good = (): Answer => ({ relevant: true, confidence: 0.55, reason: 'Encaje de prueba: por el nombre, parece una empresa del sector con stand.', hypothesis: hyp([300, 600], [600, 1500], 'Unas 300 bolsas tote para visitantes y 15 polos bordados para el equipo.') });
const discard = (): Answer => ({ relevant: false, confidence: 0.05, reason: 'Encaje de prueba: organismo público, compra por licitación.', hypothesis: null });

/** Executor: picks the answer by the injected skill text (marker) and the exhibitor in the prompt. */
class ScriptedExecutor implements ModelProvider {
  readonly name = 'scripted';
  calls = 0;
  constructor(
    private readonly candidateMarker: string,
    private readonly script: Script,
    private readonly costPerCall = 0.002,
  ) {}
  estimateCost(_m: string, _u: TokenUsage): CostBreakdown {
    return { modelCost: this.costPerCall, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const version = (request.system ?? '').includes(this.candidateMarker) ? 'cand' : 'base';
    const content = request.messages.map((m) => m.content).join('\n');
    const exhibitor = /"name":\s*"([^"]+)"/g;
    const names = [...content.matchAll(exhibitor)].map((m) => m[1]!);
    const answer = this.script(version, names.at(-1) ?? '');
    return { text: JSON.stringify(answer), model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1500, outputTokens: 300, cachedTokens: 0 }, cost: this.estimateCost(request.model, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

/** Judge: level 3 for every case, quoting the phrase every scripted reason contains. */
class ScriptedJudge implements ModelProvider {
  readonly name = 'scripted-judge';
  calls = 0;
  estimateCost(): CostBreakdown {
    return { modelCost: 0.001, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const ids = [...new Set([...request.messages.map((m) => m.content).join('\n').matchAll(/"id":\s*"(c\d+)"/g)].map((m) => m[1]!))];
    const items = ids.map((id) => ({ id, level: 3, justification: 'Accionable con datos coherentes.', quote: 'Encaje de prueba' }));
    return { text: JSON.stringify({ items }), model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 2000, outputTokens: 200, cachedTokens: 0 }, cost: this.estimateCost(), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

// ---------------------------------------------------------------------------

const EVENT = { name: 'Feria Prueba 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia' };
type CaseSpec = { split: 'TRAIN' | 'VALIDATION' | 'TEST'; name: string; sector?: string; expected?: Record<string, unknown>; usedBy?: unknown[] };

describe.skipIf(!dbAvailable)('experiments and release gate (PostgreSQL)', () => {
  const tenant = `it-exp-${randomUUID().slice(0, 8)}`;
  const evTenant = `it-exp-ev-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  const MARK = { 2: '## Prueba v2 (forma)', 3: '## Prueba v3 (etiquetas)', 4: '## Prueba v4 (peor)', 5: '## Prueba v5 (contaminación)' } as const;

  async function makeDataset(name: string, specs: CaseSpec[]): Promise<{ id: string; ids: Map<string, string> }> {
    const [ds] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name, domain: 'prospeccion', version: 1, status: 'DRAFT', createdBy: 'it' }).returning();
    const ids = new Map<string, string>();
    for (const s of specs) {
      const input = { event: EVENT, exhibitor: { name: s.name, ...(s.sector ? { sector: s.sector } : {}) } };
      const expected = s.expected ?? { kind: 'unlabeled' };
      const [row] = await handle.db
        .insert(evaluationCases)
        .values({
          datasetId: ds!.id,
          tenantId: tenant,
          split: s.split,
          entityKey: `org:${s.name.toLowerCase()}`,
          input,
          expected,
          source: { origin: 'synthetic', expected_source: s.expected ? 'rule' : 'none' },
          difficulty: s.sector ? 'medium' : 'hard',
          contentHash: caseContentHash(input, expected),
          usedBy: (s.usedBy ?? []) as never,
        })
        .returning();
      ids.set(s.name, row!.id);
    }
    return { id: ds!.id, ids };
  }

  function deps(script: Script, marker: string, extra: Partial<RunnerDeps> = {}): RunnerDeps & { executor: ScriptedExecutor; judge: ScriptedJudge } {
    const executor = new ScriptedExecutor(marker, script);
    const judge = new ScriptedJudge();
    const agentVersion = desiredProspectorVersion();
    const policy = parseToolPolicy(agentVersion.configuration);
    return {
      db: handle.db,
      executorProvider: executor,
      judgeProvider: judge,
      makeTools: (label) => new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), policy, { tenantId: tenant, executionId: label, agentId: 'it-exp', stage: 'PROSPECTOR' }, new AbortController().signal),
      agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
      now: () => new Date('2026-10-07T08:00:00Z'),
      evaluationsTenant: evTenant,
      executor,
      judge,
      ...extra,
    };
  }
  const opts = (candidate: number, dataset: string, extra: Record<string, unknown> = {}) => ({ tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: candidate, dataset, budgetEur: 0.3, repeat: 1, gate: gateConfig(), createdBy: 'it', ...extra });
  const activate = (v: number, payload?: Record<string, unknown>) => app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/${v}/activate`, headers, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    await seedSkills(handle.db, { tenantId: tenant });
    for (const v of [2, 3, 4, 5] as const) {
      await createVersion(handle.db, { tenantId: tenant, skillKey: PROSPECTOR_SKILL_ID, copyFrom: 'active', content: { instructions: `${(await activeText())}\n\n${MARK[v]}` }, createdBy: 'it' });
    }
  });
  async function activeText(): Promise<string> {
    const r = await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}`, headers });
    return (r.json() as { versions: Array<{ version: number; instructions: string }> }).versions.find((v) => v.version === 1)!.instructions;
  }

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('activation of a version that was never ACTIVE is blocked without an experiment (409 release_gate_blocked)', async () => {
    const res = await activate(2);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; message: string; details: { experiments: unknown[]; active_version: number } } } & Record<string, unknown>;
    expect(JSON.stringify(body)).toMatch(/release_gate_blocked/);
    expect(JSON.stringify(body)).toMatch(/no hay ningún experimento COMPLETED/);
    // force without a reason is a 400, not an override.
    expect((await activate(2, { force: true })).statusCode).toBe(400);
  });

  it('form mode: VALIDATION without labels + TRAIN form sample -> PASS_FORM; P5 marks, evaluations, immutable row, TEST untouched', async () => {
    const ds = await makeDataset('it-forma', [
      { split: 'VALIDATION', name: 'ALFA FOODS' },
      { split: 'VALIDATION', name: 'BETA CAFES' },
      { split: 'TRAIN', name: 'GAMMA HORNOS' },
      { split: 'TRAIN', name: 'DELTA VINOS' },
      { split: 'TRAIN', name: 'QUEMADA SL', usedBy: [{ experiment: 'EXP-001', role: 'design', at: '2026-10-01T00:00:00Z', via: 'registry' }] },
      { split: 'TEST', name: 'OMEGA TEST' },
    ]);
    const d = deps((v) => (v === 'cand' ? good() : weak()), MARK[2]);
    const { experiment, report } = await runExperiment(d, opts(2, 'it-forma', { formSample: 'auto' }));
    expect(experiment).toMatchObject({ name: 'EXP-003', number: 3, status: 'COMPLETED', decision: 'PASS_FORM', baselineVersion: 1, candidateVersion: 2, datasetId: ds.id });
    expect(report.mode).toBe('form');
    expect(report.test_skipped).toMatch(/PASS_FORM/);
    const val = report.phases[0]!;
    expect(val.cases.map((c) => [c.exhibitor, c.use]).sort()).toEqual([
      ['ALFA FOODS', 'validation'],
      ['BETA CAFES', 'validation'],
      ['DELTA VINOS', 'form_sample'],
      ['GAMMA HORNOS', 'form_sample'],
    ]);
    expect(val.gate.criteria.find((c) => c.id === 'accuracy')!.status).toBe('skipped');
    expect(val.versions[1]!.composite!).toBeGreaterThan(val.versions[0]!.composite! + 0.02);
    // 4 exhibitors x 2 versions x 1 repetition; the judge scored (2 dimensions, one call each).
    expect(d.executor.calls).toBe(8);
    expect(d.judge.calls).toBe(2);
    expect(experiment.costEur).toBeCloseTo(0.016 + 0.002, 6);

    // P5 ledger: VALIDATION and the form sample marked as validation by EXP-003; TEST and the burned TRAIN case untouched.
    const rows = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, ds.id));
    const uses = Object.fromEntries(rows.map((r) => [(r.input.exhibitor as { name: string }).name, r.usedBy.map((u) => `${u.experiment}:${u.role}`)]));
    expect(uses).toEqual({ 'ALFA FOODS': ['EXP-003:validation'], 'BETA CAFES': ['EXP-003:validation'], 'GAMMA HORNOS': ['EXP-003:validation'], 'DELTA VINOS': ['EXP-003:validation'], 'QUEMADA SL': ['EXP-001:design'], 'OMEGA TEST': [] });

    // Stored row: splits, metrics per version, every gate criterion, and evaluations in their tenant.
    const [row] = await handle.db.select().from(experiments).where(eq(experiments.id, experiment.id));
    expect((row!.splits.VALIDATION as { case_ids: string[]; form_sample_case_ids: string[] }).case_ids).toHaveLength(2);
    expect((row!.splits.VALIDATION as { form_sample_case_ids: string[] }).form_sample_case_ids).toHaveLength(2);
    expect(Object.keys((row!.metrics.phases as { VALIDATION: { versions: object } }).VALIDATION.versions)).toEqual(['v1', 'v2']);
    expect(((row!.gateResult.phases as { VALIDATION: { criteria: Array<{ id: string }> } }).VALIDATION.criteria).map((c) => c.id)).toEqual(['composite_delta', 'hard_failures', 'seesaw', 'cost_per_decision', 'accuracy']);
    expect(row!.config).toMatchObject({ baseline: { version: 1 }, candidate: { version: 2 }, dataset: { name: 'it-forma' }, gate: { min_delta: 0.02 }, evaluations_tenant: evTenant });
    const evs = await handle.db.select().from(evaluations).where(eq(evaluations.tenantId, evTenant));
    expect(evs.length).toBeGreaterThan(0);
    expect(await handle.db.select().from(evaluations).where(eq(evaluations.tenantId, tenant))).toHaveLength(0);

    const md = renderExperimentMarkdown(report);
    expect(md).toMatch(/EXP-003/);
    expect(md).toMatch(/PASS_FORM/);
    expect(md).toMatch(/re-validar/);

    // Immutable once COMPLETED; no DELETE.
    await expect(handle.pool.query(`update experiments set metrics = '{}'::jsonb where id = $1`, [experiment.id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query('delete from experiments where id = $1', [experiment.id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query(`insert into experiments (tenant_id, name, number, subject_type, subject_name, candidate_version, status, decision, finished_at) values ($1, 'EXP-099', 99, 'skill', 'x', 2, 'COMPLETED', 'PASS', now())`, [tenant])).rejects.toThrow(/DRAFT or RUNNING/);
  });

  it('a P5 conflict while reserving aborts the experiment (FAILED, nothing marked by it)', async () => {
    const ds = await makeDataset('it-contaminado', [
      { split: 'VALIDATION', name: 'EPSILON SA' },
      { split: 'VALIDATION', name: 'ZETA SL' },
    ]);
    // A concurrent experiment takes one of the cases between the listing and the mark.
    const d = deps(() => good(), MARK[5], {
      beforeMark: async (_phase, caseIds) => {
        await markUsed(handle.db, { tenantId: tenant, datasetId: ds.id, caseIds: [caseIds[0]!], experiment: 'EXP-RIVAL', role: 'validation' });
      },
    });
    const err = await runExperiment(d, opts(5, 'it-contaminado')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExperimentAbortedError);
    expect((err as ExperimentAbortedError).code).toBe('contamination');
    expect((err as ExperimentAbortedError).experiment).toMatchObject({ name: 'EXP-004', status: 'FAILED' });
    expect((err as ExperimentAbortedError).experiment!.error).toMatch(/P5/);
    expect(d.executor.calls).toBe(0);
    const rows = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, ds.id));
    expect(rows.flatMap((r) => r.usedBy.map((u) => u.experiment))).toEqual(['EXP-RIVAL']);
  });

  it('labelled VALIDATION: same accuracy and better form -> PASS, then TEST is reserved and run -> final PASS', async () => {
    const ds = await makeDataset('it-etiquetas', [
      { split: 'VALIDATION', name: 'AYUNTAMIENTO DE PRUEBA', sector: 'Organismos públicos', expected: { kind: 'structural_discard', relevant: false, writable: false, hypothesis: null, confidence_max: 0.19 } },
      { split: 'VALIDATION', name: 'CONSERVAS PRUEBA', sector: 'Conservas', expected: { kind: 'human_verdict', relevant: true, writable: true, feedback: 'ACCEPTED' } },
      { split: 'VALIDATION', name: 'ETA BOLLERIA' },
      { split: 'TEST', name: 'DIPUTACION DE PRUEBA', sector: 'Organismos públicos', expected: { kind: 'structural_discard', relevant: false, writable: false, hypothesis: null, confidence_max: 0.19 } },
      { split: 'TEST', name: 'THETA QUESOS' },
      { split: 'TRAIN', name: 'IOTA TRAIN' },
    ]);
    const script: Script = (v, ex) => (/AYUNTAMIENTO|DIPUTACION/.test(ex) ? discard() : v === 'cand' ? { ...good(), confidence: 0.7 } : { ...weak(), confidence: 0.7 });
    const d = deps(script, MARK[3]);
    const { experiment, report } = await runExperiment(d, opts(3, 'it-etiquetas'));
    expect(report.phases.map((p) => [p.phase, p.gate.mode, p.gate.decision])).toEqual([
      ['VALIDATION', 'labeled', 'PASS'],
      ['TEST', 'labeled', 'PASS'],
    ]);
    expect(experiment).toMatchObject({ name: 'EXP-005', status: 'COMPLETED', decision: 'PASS' });
    const val = report.phases[0]!;
    expect(val.cases.some((c) => c.use === 'form_sample')).toBe(false); // labels present: no form sample
    expect(val.versions.map((v) => v.accuracy.value)).toEqual([1, 1]);
    const rows = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, ds.id));
    const uses = Object.fromEntries(rows.map((r) => [(r.input.exhibitor as { name: string }).name, r.usedBy.map((u) => `${u.experiment}:${u.role}`)]));
    expect(uses).toMatchObject({ 'DIPUTACION DE PRUEBA': ['EXP-005:test'], 'THETA QUESOS': ['EXP-005:test'], 'AYUNTAMIENTO DE PRUEBA': ['EXP-005:validation'], 'IOTA TRAIN': [] });
  });

  it('labelled VALIDATION with a worse candidate (wrong discard) -> FAIL on accuracy; TEST is not touched', async () => {
    const ds = await makeDataset('it-peor', [
      { split: 'VALIDATION', name: 'CONCELLO DE PRUEBA', sector: 'Organismos públicos', expected: { kind: 'structural_discard', relevant: false, writable: false, hypothesis: null, confidence_max: 0.19 } },
      { split: 'VALIDATION', name: 'KAPPA CAFES' },
      { split: 'TEST', name: 'LAMBDA TEST' },
    ]);
    const script: Script = (v, ex) => (/CONCELLO/.test(ex) ? (v === 'cand' ? good() : discard()) : v === 'cand' ? good() : weak());
    const { experiment, report } = await runExperiment(deps(script, MARK[4]), opts(4, 'it-peor', { judge: false }));
    expect(experiment).toMatchObject({ name: 'EXP-006', status: 'COMPLETED', decision: 'FAIL' });
    const g = report.phases[0]!.gate;
    expect(g.criteria.find((c) => c.id === 'accuracy')).toMatchObject({ status: 'fail', baseline: 1, candidate: 0 });
    expect(report.phases).toHaveLength(1);
    expect(report.test_skipped).toMatch(/FAIL/);
    const [test] = await handle.db.select().from(evaluationCases).where(and(eq(evaluationCases.datasetId, ds.id), eq(evaluationCases.split, 'TEST')));
    expect(test!.usedBy).toEqual([]);
  });

  it('activation honours the gate: PASS_FORM lets v2 through (revalidate), a stale baseline blocks v3, a human override forces it, rollback is free', async () => {
    // v2: EXP-003 PASS_FORM vs v1 (the ACTIVE one).
    const ok = await activate(2);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, gate: { mode: 'experiment', revalidate: true, experiment: { name: 'EXP-003', decision: 'PASS_FORM' } } });
    // Idempotent call: nothing to check.
    expect((await activate(2)).json()).toMatchObject({ changed: false, gate: { mode: 'noop' } });

    // v3: EXP-005 PASS, but against v1; the ACTIVE version is now v2 -> blocked.
    const stale = await activate(3);
    expect(stale.statusCode).toBe(409);
    expect(JSON.stringify(stale.json())).toMatch(/no se hicieron contra la versión activa/);
    // v4: EXP-006 FAIL -> blocked too.
    expect(JSON.stringify((await activate(4)).json())).toMatch(/release_gate_blocked/);

    // Human override with a reason: allowed, reported as such.
    const forced = await activate(3, { force: true, reason: 'Decisión del PM: EXP-005 PASS contra v1, se acepta sin repetir', by: 'PM' });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ changed: true, version: { version: 3, status: 'ACTIVE' }, gate: { mode: 'override', override: true, by: 'PM', reason: expect.stringMatching(/Decisión del PM/) } });

    // Rollback to a version that was ACTIVE before needs no experiment.
    const back = await activate(2);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, gate: { mode: 'rollback' } });
  });

  it('GET /experiments and GET /experiments/:id (by name), read only', async () => {
    const list = await app.inject({ method: 'GET', url: `/experiments?subject_name=${PROSPECTOR_SKILL_ID}`, headers });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ name: string; status: string; decision: string | null }> }).items;
    expect(items.map((i) => [i.name, i.status, i.decision])).toEqual([
      ['EXP-006', 'COMPLETED', 'FAIL'],
      ['EXP-005', 'COMPLETED', 'PASS'],
      ['EXP-004', 'FAILED', null],
      ['EXP-003', 'COMPLETED', 'PASS_FORM'],
    ]);
    const one = await app.inject({ method: 'GET', url: '/experiments/exp-003', headers });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { experiment: { gate_result: { decision: string } } }).experiment.gate_result.decision).toBe('PASS_FORM');
    expect((await app.inject({ method: 'GET', url: '/experiments/EXP-999', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/experiments/EXP-003', headers })).statusCode).toBe(404);
  });
});
