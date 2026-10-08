/**
 * Skill Optimizer end to end against a real PostgreSQL, with scripted providers (no network)
 * and an in-memory CRM (nothing reaches Twenty): synthetic production traces and human
 * verdicts -> failure harvest -> clustering -> bounded candidate (DRAFT, never activated) ->
 * new dataset version with the failure entities burned as design (P5) -> experiment -> gate.
 * GATE_PASS (note in the CRM, human activation through the Release Gate, PROMOTED), the burned
 * VALIDATION blocks the next run (BLOCKED_NO_DATA), GATE_FAIL, no failures, ceilings rejected
 * twice (ERROR) and the API (202/409/422/503, list, detail, close, no DELETE).
 * Fresh tenants per scenario, nothing is deleted.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt11_optimizer.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, evaluationCases, evaluationDatasets, evaluations, experiments, optimizationRuns, skillVersions, traces, traceSteps } from '../../src/db/schema.js';
import { entityKeyOf, hashSplit } from '../../src/datasets/core.js';
import { MemoryTwenty } from '../../src/integrations/twenty/memory-twenty.js';
import { createRun, failStaleRuns, MemoryOptimizerQueue, runLabel, runOptimization, type OptimizerDeps } from '../../src/optimizer/index.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../../src/providers/model-provider.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedSkills } from '../../src/seed/skills-seed.js';

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
// Scripted experiment executor (same idea as test/integration/experiments.test.ts)
// ---------------------------------------------------------------------------

const MARKER = 'Regla del optimizador de prueba: un descarte lleva confianza menor que 0,2.';
type Answer = { relevant: boolean; confidence: number; reason: string; hypothesis: Record<string, unknown> | null };
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
const weak = (): Answer => ({ relevant: true, confidence: 0.7, reason: 'Encaje de prueba: empresa del sector con stand.', hypothesis: hyp([250, 1000], [600, 2200], 'Regalo para visitantes del stand.') });
const good = (): Answer => ({ relevant: true, confidence: 0.7, reason: 'Encaje de prueba: por el sector, parece una empresa con stand.', hypothesis: hyp([300, 600], [600, 1500], 'Unas 300 bolsas tote para visitantes y 15 polos bordados para el equipo.') });

class ScriptedExecutor implements ModelProvider {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly candidate: () => Answer, private readonly baseline: () => Answer) {}
  estimateCost(_m: string, _u: TokenUsage): CostBreakdown {
    return { modelCost: 0.002, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const answer = (request.system ?? '').includes(MARKER) ? this.candidate() : this.baseline();
    return { text: JSON.stringify(answer), model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1500, outputTokens: 300, cachedTokens: 0 }, cost: this.estimateCost(request.model, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

// ---------------------------------------------------------------------------

const DATASET = 'it-opt';
function nameIn(split: 'TRAIN' | 'VALIDATION' | 'TEST', prefix: string): string {
  for (let i = 0; i < 1000; i++) if (hashSplit(DATASET, entityKeyOf(`${prefix} ${i}`)) === split) return `${prefix} ${i}`;
  throw new Error('no name');
}
/** Failure entities (design material): one of them lands in VALIDATION on purpose. */
const D1 = nameIn('VALIDATION', 'Descartada');
const D2 = nameIn('TRAIN', 'Editada');
const R1 = nameIn('TRAIN', 'Regla');
/** Fresh labelled data: two ACCEPTED in VALIDATION, one in TEST. */
const V1 = nameIn('VALIDATION', 'Valida A');
const V2 = nameIn('VALIDATION', 'Valida B');
const T1 = nameIn('TEST', 'Test');
const U1 = nameIn('TRAIN', 'Libre');
const EVENT = { name: 'Feria IT Optimizer 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia' };
const CLUSTERS = JSON.stringify({
  clusters: [
    { id: 'C1', title: 'Descartes con confianza alta', pattern: 'F3 descarta con confianza 0,9 y F1 se descartó en el CRM.', skill_gap: 'La escala de confianza no dice qué hacer en un descarte.', failure_ids: ['F1', 'F3'] },
    { id: 'C2', title: 'Horquillas anchas', pattern: 'F2: el comercial bajó quantity_max de 2000 a 600.', skill_gap: 'La skill no limita la amplitud de la horquilla.', failure_ids: ['F2'] },
  ],
});

describe.skipIf(!dbAvailable)('skill optimizer (PostgreSQL)', () => {
  const suffix = randomUUID().slice(0, 8);
  const evTenant = `it-opt-ev-${suffix}`;
  let handle: DbHandle;
  let queue: MemoryOptimizerQueue;
  let app: FastifyInstance;
  let appNoQueue: FastifyInstance;

  /** A tenant with the seeded skills, real-looking Prospector runs of v1 and human verdicts. */
  async function setupTenant(tenant: string): Promise<{ baseText: string }> {
    const db = handle.db;
    await seedSkills(db, { tenantId: tenant });
    const [agent] = await db.insert(agents).values({ tenantId: tenant, name: 'Prospector' }).returning();
    const [version] = await db.insert(agentVersions).values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'gemini-flash-latest', modelProvider: 'gemini' }).returning();
    const ex = (name: string) => ({ name, sector: 'Alimentación' });
    const hypIds = { D1: randomUUID(), D2: randomUUID(), V1: randomUUID(), V2: randomUUID(), T1: randomUUID() };
    const result = (name: string, hypothesisId: string | null, out: Partial<Answer> & { status?: string } = {}) => ({ name, status: 'written', relevant: true, confidence: 0.7, reason: 'Encaje razonable.', hypothesis: hyp([500, 2000], [800, 3000], 'Regalos'), ...(hypothesisId ? { hypothesis_id: hypothesisId } : {}), ...out });
    const finalOutput = {
      results: [
        result(D1, hypIds.D1),
        result(D2, hypIds.D2),
        result(V1, hypIds.V1),
        result(V2, hypIds.V2),
        result(T1, hypIds.T1),
        result(R1, null, { status: 'discarded', relevant: false, confidence: 0.9, hypothesis: null }),
        result(U1, null, { status: 'discarded', relevant: false, confidence: 0.05, hypothesis: null }),
      ],
    };
    const names = [D1, D2, V1, V2, T1, R1, U1];
    const [exec] = await db.insert(agentExecutions).values({ tenantId: tenant, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', input: { event: EVENT, exhibitors: names.map(ex) }, output: finalOutput }).returning();
    const skill = await db.query.skills.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.tenantId, tenant), e(x.name, PROSPECTOR_SKILL_ID)) });
    const prospector = (await db.query.skillVersions.findFirst({ where: (x, { eq: e }) => e(x.id, skill!.activeVersionId!) }))!;
    const [trace] = await db
      .insert(traces)
      .values({ tenantId: tenant, executionId: exec!.id, agentId: agent!.id, agentVersionId: version!.id, finalOutput, skillVersions: [{ name: PROSPECTOR_SKILL_ID, version: 1, skill_version_id: prospector.id, content_hash: prospector.contentHash, source: 'db', requested: { name: PROSPECTOR_SKILL_ID } }] })
      .returning();
    let sequence = 0;
    for (const n of names) {
      await db.insert(traceSteps).values({ tenantId: tenant, traceId: trace!.id, sequence: ++sequence, type: 'MODEL', input: { exhibitor: n, attempt: 1 }, output: { valid: true, decision: { relevant: true, confidence: 0.7 } } } as typeof traceSteps.$inferInsert);
    }
    const human = { actor: { human: true, source: 'MANUAL', name: 'Comercial' } };
    const verdict = (key: keyof typeof hypIds, name: string, feedback: 'ACCEPTED' | 'EDITED' | 'DISCARDED', extra: Record<string, unknown> = {}) => ({
      tenantId: tenant,
      subjectType: 'hypothesis',
      subjectId: hypIds[key],
      agentExecutionId: exec!.id,
      feedback,
      score: feedback === 'ACCEPTED' ? 1 : feedback === 'EDITED' ? 0.5 : 0,
      source: 'twenty_webhook',
      details: { ...human, hypothesis_name: `${name} — ${EVENT.name}`, edited_fields: {}, ...extra },
    });
    await db.insert(evaluations).values([
      verdict('D1', D1, 'DISCARDED'),
      verdict('D2', D2, 'EDITED', { edited_fields: { quantityMax: { before: 2000, after: 600 } } }),
      verdict('V1', V1, 'ACCEPTED'),
      verdict('V2', V2, 'ACCEPTED'),
      verdict('T1', T1, 'ACCEPTED'),
    ]);
    return { baseText: prospector.instructions };
  }

  /** An ADD anchored on a line that appears exactly once in the base text. */
  function proposal(baseText: string, extra: Record<string, unknown> = {}): string {
    const anchor = baseText.split('\n').find((l) => l.trim().length > 20 && baseText.split(l).length === 2)!;
    return JSON.stringify({
      summary: 'Fija la confianza de los descartes por debajo de 0,2 y acota las horquillas.',
      operations: [{ op: 'ADD', anchor, text: `- ${MARKER}`, why: 'C1: F1 y F3 descartan con confianza alta.', clusters: ['C1'], ...extra }],
    });
  }

  function deps(llm: ModelProvider, executor: ModelProvider, crm: MemoryTwenty | null = new MemoryTwenty()): OptimizerDeps {
    return { db: handle.db, llmProvider: llm, executorProvider: executor, judgeProvider: null, twenty: crm ? crm.client() : null, now: () => new Date('2026-10-07T08:00:00Z'), evaluationsTenant: evTenant };
  }
  const config = (extra: Record<string, unknown> = {}) => ({ datasetName: DATASET, domain: 'prospeccion', experimentBudgetEur: 0.3, llmBudgetEur: 0.05, repeat: 1, minLabeledValidation: 2, minFailures: 2, maxFailures: 40, maxTraces: 100, model: 'gemini-flash-latest', today: '2026-10-07', ...extra });
  const newRun = (tenant: string, extra: Record<string, unknown> = {}) => createRun(handle.db, { tenantId: tenant, skillName: PROSPECTOR_SKILL_ID, baseVersion: 1, config: config(extra), createdBy: 'it' });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryOptimizerQueue();
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), optimizerQueue: queue, config: { defaultTenantId: `it-opt-api-${suffix}`, defaultModelProvider: 'stub' } });
    appNoQueue = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: `it-opt-api-${suffix}`, defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await appNoQueue?.close();
    await handle?.close();
  });

  it('GATE_PASS: failures -> clusters -> DRAFT candidate -> P5 design marks -> experiment PASS -> note; never activated; then the human promotes it', async () => {
    const tenant = `it-opt-a-${suffix}`;
    const { baseText } = await setupTenant(tenant);
    const llm = new StubProvider({ responses: [CLUSTERS, proposal(baseText)] });
    const executor = new ScriptedExecutor(good, weak);
    const crm = new MemoryTwenty();
    const run = await newRun(tenant);
    expect(run.status).toBe('PENDING');
    const done = await runOptimization(deps(llm, executor, crm), tenant, run.id);

    expect(done).toMatchObject({ status: 'GATE_PASS', verdict: 'PASS', baseVersion: 1, candidateVersion: 2 });
    expect(done.error).toBeNull();
    // Harvest: 2 human failures (DISCARDED, EDITED; the ACCEPTED are not failures) + 1 hard rule (discard with 0.9).
    const details = done.details as Record<string, any>;
    expect(details.harvest).toMatchObject({ human_verdicts: 5, human_failures: 2, rule_failures: 1, traces_checked: 1, selected: 3 });
    expect(details.failures.map((f: { kind: string; exhibitor: { name: string } }) => [f.kind, f.exhibitor.name])).toEqual([
      [expect.stringMatching(/^human_/), expect.any(String)],
      [expect.stringMatching(/^human_/), expect.any(String)],
      ['rule_hard_fail', R1],
    ]);
    expect(details.failures.find((f: { kind: string }) => f.kind === 'human_edited').editedFields).toEqual({ quantityMax: { before: 2000, after: 600 } });
    expect(new Set(details.design_entities)).toEqual(new Set([D1, D2, R1].map(entityKeyOf)));
    expect(details.data_check).toMatchObject({ ok: true, freshLabeled: 2, designOverlap: 1 });
    // Clusters stored with their failures; ops with sizes; the LLM got 2 calls.
    expect(done.failureClusters.map((c) => [c.id, (c.failure_ids as string[]).length])).toEqual([
      ['C1', 2],
      ['C2', 1],
    ]);
    expect(done.proposedOps).toEqual([expect.objectContaining({ op: 'ADD', clusters: ['C1'], removed_chars: 0 })]);
    expect(llm.requests).toHaveLength(2);

    // The candidate: DRAFT, change_reason citing the clusters, metadata with the run and the design data. v1 still ACTIVE.
    const versions = await handle.db.select().from(skillVersions).where(eq(skillVersions.tenantId, tenant));
    const prospector = versions.filter((v) => v.skillId === versions.find((x) => x.version === 2)!.skillId);
    expect(prospector.map((v) => [v.version, v.status]).sort()).toEqual([
      [1, 'ACTIVE'],
      [2, 'DRAFT'],
    ]);
    const v2 = prospector.find((v) => v.version === 2)!;
    expect(v2.instructions).toContain(MARKER);
    expect(v2.metadata).toMatchObject({ change_reason: expect.stringMatching(new RegExp(`^Skill Optimizer ${runLabel(run.id)}: ataca C1 «Descartes con confianza alta» \\(2 fallos\\)`)), optimizer: { run_id: run.id }, base_version: 1, copied_from: { version: 1 } });
    expect(v2.createdBy).toBe(`skill-optimizer:${runLabel(run.id)}`);

    // P5: new dataset version; the failure entities burned as design BEFORE the experiment, which never used them.
    const ds = details.dataset as { id: string; version: number; design_cases: number };
    expect(ds).toMatchObject({ version: 1, design_cases: 3, ok: true });
    const cases = await handle.db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, ds.id));
    const uses = Object.fromEntries(cases.map((c) => [(c.input.exhibitor as { name: string }).name, c.usedBy.map((u) => `${u.experiment}:${u.role}`)]));
    const label = runLabel(run.id);
    expect(uses[D1]).toEqual([`${label}:design`]);
    expect(uses[D2]).toEqual([`${label}:design`]);
    expect(uses[R1]).toEqual([`${label}:design`]);

    // The experiment (same runner as pnpm experiment:run): baseline v1 vs v2 on V1, V2 (+ TEST T1 after a PASS).
    const [exp] = await handle.db.select().from(experiments).where(eq(experiments.id, done.experimentId!));
    expect(exp).toMatchObject({ status: 'COMPLETED', decision: 'PASS', baselineVersion: 1, candidateVersion: 2, datasetId: ds.id, createdBy: `skill-optimizer:${label}` });
    expect(uses[V1]).toEqual([`${exp!.name}:validation`]);
    expect(uses[V2]).toEqual([`${exp!.name}:validation`]);
    expect(uses[T1]).toEqual([`${exp!.name}:test`]);
    expect(executor.calls).toBe(6); // (2 VALIDATION + 1 TEST) x 2 versions x 1 repetition
    expect(Number(done.costEur)).toBeCloseTo(Number(exp!.costEur), 6);
    expect(details.experiment).toMatchObject({ name: exp!.name, decision: 'PASS', mode: 'labeled' });
    expect(details.experiment.composite[0].delta).toBeGreaterThanOrEqual(0.02);

    // The note for the human, in the (in-memory) CRM. Nothing else was written to it.
    expect(details.note).toMatchObject({ created: true, title: `Propuesta de promoción — ${PROSPECTOR_SKILL_ID} v2` });
    expect(crm.tables.notes).toHaveLength(1);
    expect(crm.writes()).toBe(1);
    const md = (crm.tables.notes![0]!.bodyV2 as { markdown: string }).markdown;
    expect(md).toContain(`/skills/${PROSPECTOR_SKILL_ID}/versions/2/activate`);
    expect(md).toMatch(/No se ha activado nada/);

    // A redelivered job does nothing.
    expect((await runOptimization(deps(new StubProvider(), executor, crm), tenant, run.id)).updatedAt).toEqual(done.updatedAt);

    // Human close: PROMOTED needs v2 ACTIVE; the activation goes through the Release Gate (experiment PASS vs v1).
    const headers = { 'x-tenant-id': tenant };
    const early = await app.inject({ method: 'POST', url: `/optimizer/runs/${run.id}/close`, headers, payload: { outcome: 'PROMOTED', by: 'PM' } });
    expect(early.statusCode).toBe(409);
    expect(JSON.stringify(early.json())).toMatch(/actívala primero/);
    const act = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/2/activate`, headers });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ changed: true, gate: { mode: 'experiment', experiment: { name: exp!.name, decision: 'PASS' } } });
    const closed = await app.inject({ method: 'POST', url: `/optimizer/runs/${run.id}/close`, headers, payload: { outcome: 'PROMOTED', by: 'PM', reason: 'Gate PASS revisado' } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ run: { status: 'PROMOTED', details: { human_close: { outcome: 'PROMOTED', by: 'PM' } } } });
    expect((await app.inject({ method: 'POST', url: `/optimizer/runs/${run.id}/close`, headers, payload: { outcome: 'DISCARDED' } })).statusCode).toBe(409);
  });

  it('the next run is BLOCKED_NO_DATA: the VALIDATION it would need is burned (P5) and no model is called', async () => {
    const tenant = `it-opt-b-${suffix}`;
    await setupTenant(tenant);
    const first = await newRun(tenant);
    const crm = new MemoryTwenty();
    const firstDone = await runOptimization(deps(new StubProvider({ responses: [CLUSTERS, proposal(await currentProspectorText(tenant))] }), new ScriptedExecutor(weak, good), crm), tenant, first.id);
    // Worse candidate: GATE_FAIL, no note, the candidate stays DRAFT.
    expect(firstDone).toMatchObject({ status: 'GATE_FAIL', verdict: 'FAIL', candidateVersion: 2 });
    expect(crm.tables.notes).toHaveLength(0);
    expect((firstDone.details as Record<string, unknown>).note).toBeUndefined();

    const llm = new StubProvider({ responses: [CLUSTERS] });
    const second = await newRun(tenant);
    const blocked = await runOptimization(deps(llm, new ScriptedExecutor(good, weak)), tenant, second.id);
    expect(blocked.status).toBe('BLOCKED_NO_DATA');
    expect(blocked.error).toMatch(/hay 0 casos etiquetados frescos en VALIDATION y hacen falta 2: faltan 2/);
    expect(blocked.error).toMatch(/4 casos etiquetados del dataset ya están quemados por experimentos anteriores/); // V1, V2 (validation of the FAIL; TEST untouched) + D1, D2 (design)
    expect(llm.requests).toHaveLength(0);
    expect(blocked.candidateVersion).toBeNull();
    // Nothing written by the blocked run: still one dataset version and no new skill version.
    expect(await handle.db.select().from(evaluationDatasets).where(eq(evaluationDatasets.tenantId, tenant))).toHaveLength(1);

    // DISCARDED closes the GATE_FAIL run; PROMOTED is not a valid close for it.
    const headers = { 'x-tenant-id': tenant };
    expect((await app.inject({ method: 'POST', url: `/optimizer/runs/${first.id}/close`, headers, payload: { outcome: 'PROMOTED' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/optimizer/runs/${first.id}/close`, headers, payload: { outcome: 'DISCARDED', by: 'PM' } })).json()).toMatchObject({ run: { status: 'DISCARDED' } });
  });

  async function currentProspectorText(tenant: string): Promise<string> {
    const s = await handle.db.query.skills.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.tenantId, tenant), e(x.name, PROSPECTOR_SKILL_ID)) });
    const v = await handle.db.query.skillVersions.findFirst({ where: (x, { eq: e }) => e(x.id, s!.activeVersionId!) });
    return v!.instructions;
  }

  it('without failures of the ACTIVE version: BLOCKED_NO_DATA before any model call', async () => {
    const tenant = `it-opt-c-${suffix}`;
    await seedSkills(handle.db, { tenantId: tenant });
    const llm = new StubProvider();
    const done = await runOptimization(deps(llm, new ScriptedExecutor(good, weak)), tenant, (await newRun(tenant)).id);
    expect(done.status).toBe('BLOCKED_NO_DATA');
    expect(done.error).toMatch(/hay 0 fallo\(s\) de prospector-event-exhibitors v1 en producción y hacen falta 2: faltan 2/);
    expect(done.details).toMatchObject({ data_check: { kind: 'failures', found: 0, required: 2, missing: 2 } });
    expect(llm.requests).toHaveLength(0);
  });

  it('API: 202 + queue, 409 open run, ceilings rejected twice -> ERROR (no version), 422/404/503, list and detail, no DELETE', async () => {
    const tenant = `it-opt-d-${suffix}`;
    const { baseText } = await setupTenant(tenant);
    const headers = { 'x-tenant-id': tenant };
    const body = { datasetName: DATASET, min_labeled_validation: 2, min_failures: 2, repeat: 1, today: '2026-10-07', created_by: 'it' };
    const res = await app.inject({ method: 'POST', url: `/optimizer/skills/${PROSPECTOR_SKILL_ID}/run`, headers, payload: body });
    expect(res.statusCode).toBe(202);
    const run = (res.json() as { run: { id: string; status: string; base_version: number; config: Record<string, unknown> } }).run;
    expect(run).toMatchObject({ status: 'PENDING', base_version: 1, config: { datasetName: DATASET, minLabeledValidation: 2, repeat: 1 } });
    expect(queue.jobs.get(run.id)).toEqual({ tenantId: tenant, runId: run.id });
    const again = await app.inject({ method: 'POST', url: `/optimizer/skills/${PROSPECTOR_SKILL_ID}/run`, headers, payload: body });
    expect(again.statusCode).toBe(409);
    expect(JSON.stringify(again.json())).toMatch(/ya tiene un run del optimizador en curso/);

    // The worker processes the job: the model's edits exceed the ceilings twice -> ERROR with both attempts.
    const huge = { op: 'REPLACE', find: baseText.slice(0, Math.floor(baseText.length * 0.6)), text: 'Nuevo texto.', why: 'C1: reescribir la cabecera completa.', clusters: ['C1'] };
    const llm = new StubProvider({ responses: [CLUSTERS, JSON.stringify({ summary: 'Reescribe la skill entera.', operations: [huge] }), JSON.stringify({ summary: 'Reescribe la skill entera.', operations: [huge] })] });
    const [job] = queue.drain();
    const failed = await runOptimization(deps(llm, new ScriptedExecutor(good, weak)), job!.tenantId, job!.runId);
    expect(failed.status).toBe('ERROR');
    expect(failed.error).toMatch(/la propuesta de candidata no es válida tras 2 intentos: .*máximo 35/);
    expect((failed.details as { proposal_attempts: Array<{ kind: string }> }).proposal_attempts.map((a) => a.kind)).toEqual(['caps', 'caps']);
    expect(llm.requests[2]!.messages.at(-1)!.content).toMatch(/MÁS CONSERVADOR/);
    expect(failed.candidateVersion).toBeNull();
    expect((await handle.db.select().from(skillVersions).where(eq(skillVersions.tenantId, tenant))).filter((v) => v.version > 1)).toHaveLength(0);
    expect(failed.failureClusters).toHaveLength(2);

    // List and detail (the list leaves out details.failures).
    const list = await app.inject({ method: 'GET', url: `/optimizer/runs?skill=${PROSPECTOR_SKILL_ID}`, headers });
    const items = (list.json() as { items: Array<{ id: string; status: string; details: Record<string, unknown> }> }).items;
    expect(items.map((i) => [i.id, i.status])).toEqual([[run.id, 'ERROR']]);
    expect(items[0]!.details.failures).toBeUndefined();
    const one = await app.inject({ method: 'GET', url: `/optimizer/runs/${run.id}`, headers });
    expect((one.json() as { run: { details: { failures: unknown[] } } }).run.details.failures).toHaveLength(3);
    expect((await app.inject({ method: 'GET', url: `/optimizer/runs/${randomUUID()}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/optimizer/runs?status=ERROR`, headers: { 'x-tenant-id': 'otro-tenant' } })).json()).toEqual({ items: [] });

    // Validation of the request.
    expect((await app.inject({ method: 'POST', url: '/optimizer/skills/email-first-contact-draft/run', headers })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/optimizer/skills/no-existe/run', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/optimizer/skills/${PROSPECTOR_SKILL_ID}/run`, headers, payload: { budget_eur: 50 } })).statusCode).toBe(400);
    expect((await appNoQueue.inject({ method: 'POST', url: `/optimizer/skills/${PROSPECTOR_SKILL_ID}/run`, headers })).statusCode).toBe(503);
    // Redis down while enqueuing: 503 and the run is closed as ERROR (it does not block the skill).
    queue.failNext = true;
    const down = await app.inject({ method: 'POST', url: `/optimizer/skills/${PROSPECTOR_SKILL_ID}/run`, headers, payload: body });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ error: 'queue_unavailable', details: { run: { status: 'ERROR' } } });

    // No DELETE: neither route nor SQL.
    expect((await app.inject({ method: 'DELETE', url: `/optimizer/runs/${run.id}`, headers })).statusCode).toBe(404);
    await expect(handle.pool.query('delete from optimization_runs where id = $1', [run.id])).rejects.toThrow(/no physical DELETE/);
  });

  it('stale open runs (worker died) are closed as ERROR so the skill can be optimized again', async () => {
    const tenant = `it-opt-e-${suffix}`;
    await seedSkills(handle.db, { tenantId: tenant });
    const run = await newRun(tenant);
    await handle.db.update(optimizationRuns).set({ status: 'CLUSTERED', updatedAt: new Date('2020-01-01T00:00:00Z') }).where(eq(optimizationRuns.id, run.id));
    expect(await failStaleRuns(handle.db, 365 * 24 * 3600 * 1000)).toContain(run.id);
    const [row] = await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.id, run.id));
    expect(row).toMatchObject({ status: 'ERROR', error: expect.stringMatching(/interrumpido/) });
    expect((await newRun(tenant)).status).toBe('PENDING');
  });
});
