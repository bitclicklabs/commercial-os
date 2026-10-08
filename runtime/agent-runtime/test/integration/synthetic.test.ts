/**
 * Synthetic environments end to end against a real PostgreSQL (migration 0017), with scripted
 * providers (no network): `synth:build` creates a DRAFT dataset of origin SYNTHETIC whose cases
 * are split SYNTH with a curriculum level; the database keeps them apart from human labels and
 * from P5; an experiment runs on a synthetic (and a mixed) dataset with no change for the
 * operator, the gate never measures accuracy with a synthetic truth, the synth.* rules and the
 * seesaw see them, and nothing is burned. Fresh tenants per run, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt13_envs.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { caseContentHash } from '../../src/datasets/core.js';
import { buildDataset, countsOf, listCases, markUsed } from '../../src/datasets/service.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { evaluationCases, evaluationDatasets } from '../../src/db/schema.js';
import { gateConfig, renderExperimentMarkdown, runExperiment, type RunnerDeps } from '../../src/experiments/index.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../../src/providers/model-provider.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { createVersion } from '../../src/skills/service.js';
import { generateSyntheticCases } from '../../src/synthetic/generate.js';
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
// Scripted executor: reads the exhibitor block of the prompt and answers like the skill would
// ("good"), like v1 did before EXP-001 ("weak"), or like "good" but obeying injected text.
// ---------------------------------------------------------------------------

type Style = 'good' | 'weak' | 'obeys';
type Answer = { relevant: boolean; confidence: number; reason: string; hypothesis: Record<string, unknown> | null };

const hypothesis = (q: [number, number], need: string, products = ['bolsas tote de algodón', 'polos bordados']) => ({
  need,
  why_now: 'La feria es en 2027: el taller propio llega a tiempo.',
  quantity_min: q[0],
  quantity_max: q[1],
  budget_min_eur: q[0] * 2,
  budget_max_eur: q[1] * 3,
  recommended_products: products,
  timing: 'LATER',
  differentiators: ['TALLER_PROPIO'],
});

function answer(style: Style, block: string): Answer {
  const name = /"name":\s*"([^"]+)"/.exec(block)?.[1] ?? '';
  const hasDescription = /"description":/.test(block);
  const hasSector = /"sector":/.test(block);
  if (style === 'weak') return { relevant: true, confidence: 0.7, reason: 'Empresa que expone en la feria.', hypothesis: hypothesis([250, 1000], 'Regalo para visitantes del stand.') };
  if (/Ayuntamiento|Diputación|Consejería|capital íntegramente público|negocio principal es la venta de merchandising/.test(block)) return { relevant: false, confidence: 0.05, reason: 'Organismo público o competidor: sin encaje comercial.', hypothesis: null };
  if (!hasDescription && !hasSector) {
    if (/^(Grupo|Inversiones)|Holding|Global/.test(name)) return { relevant: false, confidence: 0.05, reason: 'Datos insuficientes para identificar actividad comercial.', hypothesis: null };
    return { relevant: true, confidence: 0.55, reason: 'Por el nombre, parece un productor del sector; sin más datos.', hypothesis: hypothesis([200, 400], 'Unas 300 bolsas tote (estimación) y 15 polos.') };
  }
  if (!hasDescription) return { relevant: true, confidence: 0.7, reason: 'Empresa del sector con stand; faltan datos de tamaño.', hypothesis: hypothesis([200, 400], 'Unas 300 bolsas tote (estimación) y 15 polos.') };
  const units = /(?:necesita|presupuesto para) (\d+) unidades/.exec(block)?.[1];
  const token = /ZX-[0-9A-F]{8}/.exec(block)?.[0];
  const products = style === 'obeys' && token ? ['bolsas tote de algodón', `Pack ${token}`] : undefined;
  const q: [number, number] = units ? [Number(units), Math.round(Number(units) * 1.2)] : [200, 400];
  return { relevant: true, confidence: 0.85, reason: 'Fabricante con lanzamiento y presencia en la feria; tamaño estimado.', hypothesis: hypothesis(q, `Unas ${q[0]} unidades con logotipo (estimación orientativa).`, products) };
}

class ScriptedExecutor implements ModelProvider {
  readonly name = 'scripted';
  calls = 0;
  prompts: string[] = [];
  constructor(private readonly styleOf: (system: string) => Style) {}
  estimateCost(_m: string, _u: TokenUsage): CostBreakdown {
    return { modelCost: 0.002, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const content = request.messages.map((m) => m.content).join('\n');
    this.prompts.push(`${request.system ?? ''}\n${content}`);
    const block = content.slice(content.indexOf('<expositor>'), content.indexOf('</expositor>'));
    const text = JSON.stringify(answer(this.styleOf(request.system ?? ''), block));
    return { text, model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1500, outputTokens: 300, cachedTokens: 0 }, cost: this.estimateCost(request.model, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

describe.skipIf(!dbAvailable)('synthetic environments (PostgreSQL)', () => {
  const tenant = `it-synth-${randomUUID().slice(0, 8)}`;
  const evTenant = `it-synth-ev-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  const MARK = { 2: '## Prueba sintética v2 (cumple la skill)', 3: '## Prueba sintética v3 (obedece inyecciones)' } as const;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    await seedSkills(handle.db, { tenantId: tenant });
    const r = await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}`, headers });
    const base = (r.json() as { versions: Array<{ version: number; instructions: string }> }).versions.find((v) => v.version === 1)!.instructions;
    for (const v of [2, 3] as const) await createVersion(handle.db, { tenantId: tenant, skillKey: PROSPECTOR_SKILL_ID, copyFrom: 'active', content: { instructions: `${base}\n\n${MARK[v]}` }, createdBy: 'it' });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  function deps(executor: ScriptedExecutor, extra: Partial<RunnerDeps> = {}): RunnerDeps {
    const agentVersion = desiredProspectorVersion();
    const policy = parseToolPolicy(agentVersion.configuration);
    return {
      db: handle.db,
      executorProvider: executor,
      judgeProvider: null,
      makeTools: (label) => new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), policy, { tenantId: tenant, executionId: label, agentId: 'it-synth', stage: 'PROSPECTOR' }, new AbortController().signal),
      agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
      now: () => new Date('2026-10-08T08:00:00Z'),
      evaluationsTenant: evTenant,
      ...extra,
    };
  }
  const styleBy = (cand: Style, base: Style) => (system: string) => (system.includes(MARK[2]) ? 'good' : system.includes(MARK[3]) ? cand : base);

  it('synth:build creates a DRAFT dataset of origin SYNTHETIC: split SYNTH, curriculum level, reproducible from the seed, nothing labelled', async () => {
    const r = await buildDataset(handle.db, { tenantId: tenant, name: 'it-synth', domain: 'prospeccion', createdBy: 'it', synthetic: { seed: 7, perTemplate: 2 } });
    expect(r.dataset).toMatchObject({ status: 'DRAFT', origin: 'SYNTHETIC', version: 1 });
    expect(r.synthetic).toMatchObject({ seed: 7, total: 24, by_curriculum_level: { '1': 6, '2': 10, '3': 8 } });
    const rows = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, r.dataset!.id));
    expect(rows).toHaveLength(24);
    expect(rows.every((c) => c.split === 'SYNTH' && c.usedBy.length === 0 && [1, 2, 3].includes(c.curriculumLevel!) && ['easy', 'medium', 'hard'].includes(c.difficulty!))).toBe(true);
    expect((r.dataset!.buildInfo as { origin: string; synthetic: { seed: number } }).synthetic.seed).toBe(7);
    const counts = (await countsOf(handle.db, [r.dataset!.id])).get(r.dataset!.id)!;
    expect(counts).toMatchObject({ total: 24, by_split: { SYNTH: 24, TRAIN: 0, VALIDATION: 0, TEST: 0 }, labeled_by_split: { SYNTH: 0 } });
    // Same seed elsewhere -> the same cases byte for byte.
    const again = await buildDataset(handle.db, { tenantId: tenant, name: 'it-synth-copy', domain: 'prospeccion', synthetic: { seed: 7, perTemplate: 2 } });
    const hashes = (id: string) => handle.db.select({ h: evaluationCases.contentHash, input: evaluationCases.input, expected: evaluationCases.expected }).from(evaluationCases).where(eq(evaluationCases.datasetId, id));
    const [a, b] = [await hashes(r.dataset!.id), await hashes(again.dataset!.id)];
    expect(a.map((x) => x.h).sort()).toEqual(b.map((x) => x.h).sort());
    expect(a.every((x) => x.h === caseContentHash(x.input, x.expected))).toBe(true);
    // Curriculum filter.
    const hard = await buildDataset(handle.db, { tenantId: tenant, name: 'it-synth-hard', domain: 'prospeccion', synthetic: { seed: 7, perTemplate: 2, levels: [3] } });
    expect(hard.cases.every((c) => c.curriculumLevel === 3)).toBe(true);
    expect(hard.cases).toHaveLength(8);
    // A new version of a synthetic dataset is v2; a re-harvest of it (POST /datasets/:id/build) is refused: the origin is fixed.
    const v2 = await buildDataset(handle.db, { tenantId: tenant, name: 'it-synth', domain: 'prospeccion', synthetic: { seed: 8 } });
    expect(v2.dataset).toMatchObject({ version: 2, origin: 'SYNTHETIC' });
    const reharvest = await app.inject({ method: 'POST', url: `/datasets/${r.dataset!.id}/build`, headers });
    expect(reharvest.statusCode).toBe(409);
    expect(reharvest.body).toMatch(/SYNTHETIC/);
    // API: origin is served, SYNTH can be filtered, the catalog is readable.
    const listed = await app.inject({ method: 'GET', url: `/datasets/${r.dataset!.id}/cases?split=SYNTH&limit=3`, headers });
    expect((listed.json() as { items: Array<{ split: string; curriculum_level: number }> }).items.every((c) => c.split === 'SYNTH' && c.curriculum_level >= 1)).toBe(true);
    const cat = await app.inject({ method: 'GET', url: '/synthetic/templates', headers });
    expect((cat.json() as { items: unknown[] }).items).toHaveLength(12);
  });

  /** The PostgreSQL message behind a failed query (drizzle wraps it in `cause`). */
  const pgError = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (err) {
      const e = err as { message?: string; cause?: { message?: string } };
      return e.cause?.message ?? e.message ?? String(err);
    }
    return 'no error';
  };

  it('the database keeps synthetic truth apart from labels and from P5', async () => {
    const [harvested] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name: 'it-synth-guard', domain: 'prospeccion', version: 1, createdBy: 'it' }).returning();
    const g = generateSyntheticCases({ seed: 1, perTemplate: 1, templates: ['public_body'] }).cases[0]!;
    const row = { datasetId: harvested!.id, tenantId: tenant, split: g.split, entityKey: g.entityKey, input: g.input, context: g.context, expected: g.expected, source: g.source, difficulty: g.difficulty, curriculumLevel: g.curriculumLevel, tags: g.tags, contentHash: g.contentHash };
    // A SYNTH case cannot enter a HARVESTED dataset.
    expect(await pgError(handle.db.insert(evaluationCases).values(row))).toMatch(/SYNTH case only goes into a SYNTHETIC or MIXED dataset/);
    // A synthetic truth cannot be disguised as a VALIDATION case of any dataset.
    expect(await pgError(handle.db.insert(evaluationCases).values({ ...row, split: 'VALIDATION', curriculumLevel: null }))).toMatch(/evaluation_cases_synth_ck/);
    // Nor a human label as a SYNTH case, nor a SYNTH case without curriculum level.
    const [mixed] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name: 'it-synth-guard-mix', domain: 'prospeccion', version: 1, origin: 'MIXED', createdBy: 'it' }).returning();
    expect(await pgError(handle.db.insert(evaluationCases).values({ ...row, datasetId: mixed!.id, expected: { kind: 'human_verdict', relevant: false } }))).toMatch(/evaluation_cases_synth_ck/);
    expect(await pgError(handle.db.insert(evaluationCases).values({ ...row, datasetId: mixed!.id, curriculumLevel: null }))).toMatch(/evaluation_cases_curriculum_ck/);
    const [ok] = await handle.db.insert(evaluationCases).values({ ...row, datasetId: mixed!.id }).returning();
    // used_by of a SYNTH case cannot grow, the curriculum level cannot change, the origin is immutable.
    await expect(handle.pool.query(`update evaluation_cases set used_by = '[{"experiment":"EXP-001","role":"validation","at":"2026-10-08","via":"mark_used"}]'::jsonb where id = $1`, [ok!.id])).rejects.toThrow(/evaluation_cases_synth_ck/);
    await expect(handle.pool.query('update evaluation_cases set curriculum_level = 3 where id = $1', [ok!.id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query(`update evaluation_datasets set origin = 'HARVESTED' where id = $1`, [mixed!.id])).rejects.toThrow(/immutable/);
    // markUsed skips them (reported, not written).
    const m = await markUsed(handle.db, { tenantId: tenant, datasetId: mixed!.id, caseIds: [ok!.id], experiment: 'EXP-990', role: 'validation' });
    expect(m).toMatchObject({ marked: [], newly_burned: [], synthetic: [ok!.id] });
    const [after] = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.id, ok!.id));
    expect(after!.usedBy).toEqual([]);
    // A SYNTHETIC dataset only holds SYNTH cases.
    const [synthOnly] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name: 'it-synth-guard-only', domain: 'prospeccion', version: 1, origin: 'SYNTHETIC', createdBy: 'it' }).returning();
    const plain = { kind: 'unlabeled' };
    expect(await pgError(handle.db.insert(evaluationCases).values({ datasetId: synthOnly!.id, tenantId: tenant, split: 'TRAIN', entityKey: 'org:x', input: { event: {}, exhibitor: { name: 'X' } }, expected: plain, source: { origin: 'manual', expected_source: 'none' }, contentHash: caseContentHash({}, plain) }))).toMatch(/SYNTHETIC dataset only holds SYNTH cases/);
  });

  it('an experiment on a synthetic dataset runs offline, feeds the synth.* rules, never measures accuracy and burns nothing', async () => {
    const executor = new ScriptedExecutor(styleBy('good', 'weak'));
    const { experiment, report } = await runExperiment(deps(executor), { tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: 2, dataset: 'it-synth', budgetEur: 1, repeat: 1, gate: gateConfig(), judge: false, createdBy: 'it' });
    const val = report.phases[0]!;
    expect(val.cases.length).toBeGreaterThan(0);
    expect(val.cases.every((c) => c.use === 'synthetic' && c.split === 'SYNTH' && !c.labeled && c.kind === 'synthetic' && typeof c.template === 'string')).toBe(true);
    // Stratified: every template of v2 (seed 8) is in the sample.
    expect(new Set(val.cases.map((c) => c.template)).size).toBe(12);
    // Accuracy: never with a synthetic truth.
    for (const v of val.versions) expect(v.accuracy).toMatchObject({ labeled_cases: 0, decisions: 0, value: null });
    expect(val.gate.mode).toBe('form');
    expect(val.gate.criteria.find((c) => c.id === 'accuracy')!.status).toBe('skipped');
    // The synth.* rules applied (and the weak baseline fails them, the candidate does not).
    const rule = (v: number, key: string) => val.versions.find((x) => x.version === v)!.rules.find((r) => r.key === key)!;
    expect(rule(1, 'synth.decision@1').applicable).toBeGreaterThan(0);
    expect(rule(2, 'synth.decision@1').score).toBe(1);
    expect(rule(1, 'synth.decision@1').score!).toBeLessThan(1);
    expect(experiment).toMatchObject({ status: 'COMPLETED', decision: 'PASS_FORM' });
    expect(report.test_skipped).toMatch(/PASS_FORM/);
    // Curriculum breakdown in the report.
    expect(val.synthetic!.by_level.map((r) => r.curriculum_level)).toEqual([1, 2, 3]);
    expect(val.synthetic!.by_level.every((r) => r.versions.find((x) => x.version === 2)!.rate === 1)).toBe(true);
    const md = renderExperimentMarkdown(report);
    expect(md).toMatch(/Casos sintéticos \(ground truth por construcción\)/);
    expect(md).toMatch(/Por nivel de curriculum/);
    expect(md).toMatch(/Solo casos sintéticos/);
    // No ground truth reached the model, and nothing was burned.
    expect(executor.prompts.some((p) => /ground_truth|curriculum|synth\./.test(p))).toBe(false);
    const ds = (await handle.db.select().from(evaluationDatasets).where(and(eq(evaluationDatasets.tenantId, tenant), eq(evaluationDatasets.name, 'it-synth'), eq(evaluationDatasets.version, 2))))[0]!;
    const rows = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, ds.id));
    expect(rows.every((r) => r.usedBy.length === 0)).toBe(true);
    expect((experiment.splits.VALIDATION as { synthetic_case_ids: string[]; case_ids: string[] }).synthetic_case_ids.length).toBe(val.cases.length);
    expect((experiment.splits.VALIDATION as { case_ids: string[] }).case_ids).toEqual([]);
  });

  it('the same synthetic cases catch a candidate that obeys injected instructions (POLICY_COMPLIANCE) - reusable because nothing burned', async () => {
    const executor = new ScriptedExecutor(styleBy('obeys', 'good'));
    const { experiment, report } = await runExperiment(deps(executor), { tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: 3, dataset: 'it-synth', budgetEur: 1, repeat: 1, gate: gateConfig(), judge: false, createdBy: 'it' });
    const val = report.phases[0]!;
    const cand = val.versions.find((v) => v.version === 3)!;
    expect(cand.rules.find((r) => r.key === 'synth.injection@1')!.failures).toBeGreaterThan(0);
    expect(cand.threshold_failures.map((t) => t.dimension)).toContain('POLICY_COMPLIANCE');
    expect(val.gate.criteria.find((c) => c.id === 'hard_failures')!.status).toBe('fail');
    expect(experiment.decision).toBe('FAIL');
  });

  it('a mixed dataset: accuracy only on the human labels, markUsed only on the real cases, synthetic cases ride along', async () => {
    const [ds] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name: 'it-synth-mixed', domain: 'prospeccion', version: 1, origin: 'MIXED', createdBy: 'it' }).returning();
    const event = { name: 'Feria Real 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia' };
    const human = { kind: 'human_verdict', feedback: 'ACCEPTED', relevant: true, writable: true };
    const humanInput = { event, exhibitor: { name: 'CONSERVAS REALES', sector: 'Conservas', description: 'Fabricante de conservas con 80 empleados que presenta una línea nueva y ocupa un stand de 40 m².' } };
    const [real] = await handle.db
      .insert(evaluationCases)
      .values({ datasetId: ds!.id, tenantId: tenant, split: 'VALIDATION', entityKey: 'org:conservas reales', input: humanInput, expected: human, source: { origin: 'harvested', expected_source: 'human' }, difficulty: 'easy', contentHash: caseContentHash(humanInput, human) })
      .returning();
    for (const g of generateSyntheticCases({ seed: 21, perTemplate: 1 }).cases) {
      await handle.db.insert(evaluationCases).values({ datasetId: ds!.id, tenantId: tenant, split: 'SYNTH', entityKey: g.entityKey, input: g.input, context: g.context, expected: g.expected, source: g.source, difficulty: g.difficulty, curriculumLevel: g.curriculumLevel, tags: g.tags, contentHash: g.contentHash });
    }
    const executor = new ScriptedExecutor(styleBy('good', 'weak'));
    const { experiment, report } = await runExperiment(deps(executor), { tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: 2, dataset: ds!.id, budgetEur: 1, repeat: 1, gate: gateConfig(), judge: false, createdBy: 'it' });
    const val = report.phases[0]!;
    expect(val.cases.filter((c) => c.use === 'validation').map((c) => c.id)).toEqual([real!.id]);
    expect(val.cases.filter((c) => c.use === 'synthetic')).toHaveLength(12);
    for (const v of val.versions) expect(v.accuracy.labeled_cases).toBe(1);
    expect(val.gate.mode).toBe('labeled');
    expect(val.gate.criteria.find((c) => c.id === 'accuracy')!.status).not.toBe('skipped');
    expect(val.mark_used.reduce((n, m) => n + m.marked, 0)).toBe(1);
    const rows = await listCases(handle.db, { tenantId: tenant, datasetId: ds!.id, includeVetoed: true });
    const burned = rows.items.filter((r) => r.usedBy.length > 0).map((r) => r.id);
    expect(burned).toEqual([real!.id]);
    expect(experiment.status).toBe('COMPLETED');
  });
});
