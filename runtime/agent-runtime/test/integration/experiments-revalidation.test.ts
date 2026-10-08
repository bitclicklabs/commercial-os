/**
 * Re-validation of PASS_FORM experiments end to end against a real PostgreSQL, with scripted
 * providers (no network), an in-memory CRM and an in-memory event queue:
 * - a PASS_FORM experiment stores its per-case outputs; with 0 labels the re-validation is
 *   INSUFFICIENT (and the same request returns the same row);
 * - labels harvested later into a newer dataset version -> CONFIRMED, without design cases (P5);
 * - a worse candidate -> REFUTED: no note while the version is not in use, note in Twenty +
 *   `experiment.revalidation_failed` once it is in canary; nothing is deactivated;
 * - the experiment row stays untouched (and immutable), the re-validation is append-only;
 * - the endpoints (revalidate, revalidations, pending-revalidation) and the artifact fallback.
 * Fresh tenants per run, no DELETE. Run it against its own database:
 *   DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt12_reval
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { caseContentHash } from '../../src/datasets/core.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { evaluationCases, evaluationDatasets, events, experimentRevalidations, experiments, optimizationRuns, skillVersions, type CaseUse } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { completeExperiment, createExperiment, gateConfig, revalidateExperiment, RevalidationError, runExperiment, startExperiment, type RunnerDeps } from '../../src/experiments/index.js';
import { MemoryTwenty } from '../../src/integrations/twenty/memory-twenty.js';
import { runLabel } from '../../src/optimizer/core.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../../src/providers/model-provider.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { startCanary } from '../../src/skills/canary.js';
import { createVersion, findSkill } from '../../src/skills/service.js';
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
// Scripted providers (same contract as test/integration/experiments.test.ts)
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
const weak = (): Answer => ({ relevant: true, confidence: 0.7, reason: 'Encaje de prueba: empresa del sector con stand.', hypothesis: hyp([250, 1000], [600, 2200], 'Regalo para visitantes del stand.') });
const good = (): Answer => ({ relevant: true, confidence: 0.55, reason: 'Encaje de prueba: por el nombre, parece una empresa del sector con stand.', hypothesis: hyp([300, 600], [600, 1500], 'Unas 300 bolsas tote para visitantes y 15 polos bordados para el equipo.') });

class ScriptedExecutor implements ModelProvider {
  readonly name = 'scripted';
  calls = 0;
  constructor(
    private readonly candidateMarker: string,
    private readonly script: Script,
  ) {}
  estimateCost(_m: string, _u: TokenUsage): CostBreakdown {
    return { modelCost: 0.002, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const version = (request.system ?? '').includes(this.candidateMarker) ? 'cand' : 'base';
    const names = [...request.messages.map((m) => m.content).join('\n').matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]!);
    const answer = this.script(version, names.at(-1) ?? '');
    return { text: JSON.stringify(answer), model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1500, outputTokens: 300, cachedTokens: 0 }, cost: this.estimateCost(request.model, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

class ScriptedJudge implements ModelProvider {
  readonly name = 'scripted-judge';
  estimateCost(): CostBreakdown {
    return { modelCost: 0.001, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
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
type CaseSpec = { split: 'TRAIN' | 'VALIDATION' | 'TEST'; name: string; expected?: Record<string, unknown>; source?: Record<string, unknown>; usedBy?: CaseUse[] };
const accepted = { kind: 'human_verdict', feedback: 'ACCEPTED', score: 1, relevant: true, writable: true };

type RevalBody = {
  verdict: string;
  created: boolean;
  dry_run: boolean;
  summary: string;
  accuracy: { baseline: { value: number | null; correct: number; decisions: number }; candidate: { value: number | null; correct: number; decisions: number }; threshold: number | null };
  labels: { used: number; excluded: number; unlabeled: number; min_required: number; missing: number; executed_cases: number };
  version_state: { state: string; relevant: boolean };
  outputs_source: string;
  cost_eur: number;
  revalidation: { id: string; verdict: string; label_case_ids: string[]; evaluation_ids: string[]; excluded: Array<{ exhibitor: string; reason: string }>; consequence: Record<string, unknown>; cost_eur: number } | null;
};
type PendingBody = { ready: number; items: Array<{ experiment: { name: string; candidate_version: number }; version_state: { state: string }; labels: { usable: number; fresh: number; min_required: number; excluded: number }; outputs_source: string | null; ready: boolean; last_revalidation: { verdict: string } | null }> };

describe.skipIf(!dbAvailable)('re-validation of PASS_FORM experiments (PostgreSQL)', () => {
  const tenant = `it-reval-${randomUUID().slice(0, 8)}`;
  const evTenant = `it-reval-ev-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  const crm = new MemoryTwenty();
  const eventQueue = new MemoryEventQueue();
  const MARK = { 2: '## Prueba v2 (forma)', 3: '## Prueba v3 (peor en etiquetas)' } as const;

  async function makeDataset(name: string, version: number, specs: CaseSpec[]): Promise<{ id: string; ids: Map<string, string> }> {
    const [ds] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name, domain: 'prospeccion', version, status: 'DRAFT', createdBy: 'it' }).returning();
    const ids = new Map<string, string>();
    for (const s of specs) {
      const input = { event: EVENT, exhibitor: { name: s.name } };
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
          source: (s.source ?? { origin: 'synthetic', expected_source: s.expected ? 'human' : 'none' }) as never,
          difficulty: 'hard',
          contentHash: caseContentHash(input, expected),
          usedBy: (s.usedBy ?? []) as never,
        })
        .returning();
      ids.set(s.name, row!.id);
    }
    return { id: ds!.id, ids };
  }
  /** A HUMAN label of a later harvest (expected_source human, with its evaluation). */
  const humanLabel = (name: string, over: Partial<CaseSpec> = {}): CaseSpec => ({
    split: 'TRAIN',
    name,
    expected: accepted,
    source: { origin: 'harvested', expected_source: 'human', evaluation_id: randomUUID(), evaluated_at: new Date(Date.now() + 60_000).toISOString() },
    ...over,
  });

  function deps(script: Script, marker: string): RunnerDeps {
    const agentVersion = desiredProspectorVersion();
    const policy = parseToolPolicy(agentVersion.configuration);
    return {
      db: handle.db,
      executorProvider: new ScriptedExecutor(marker, script),
      judgeProvider: new ScriptedJudge(),
      makeTools: (label) => new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), policy, { tenantId: tenant, executionId: label, agentId: 'it-reval', stage: 'PROSPECTOR' }, new AbortController().signal),
      agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
      now: () => new Date('2026-10-07T08:00:00Z'),
      evaluationsTenant: evTenant,
    };
  }
  const opts = (candidate: number, dataset: string) => ({ tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: candidate, dataset, budgetEur: 0.3, repeat: 1, gate: gateConfig(), formSample: 'auto' as const, createdBy: 'it' });
  const revalidate = (exp: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/experiments/${exp}/revalidate`, headers, payload });
  const pending = async () => (await app.inject({ method: 'GET', url: '/experiments/pending-revalidation', headers })).json() as PendingBody;
  const experimentRow = async (id: string) => (await handle.db.select().from(experiments).where(eq(experiments.id, id)))[0]!;

  async function activeText(): Promise<string> {
    const r = await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}`, headers });
    return (r.json() as { versions: Array<{ version: number; instructions: string }> }).versions.find((v) => v.version === 1)!.instructions;
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    const bus = new EventBus(handle.db, eventQueue);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' }, events: bus, twenty: crm.client() });
    await seedSkills(handle.db, { tenantId: tenant });
    const text = await activeText();
    for (const v of [2, 3] as const) await createVersion(handle.db, { tenantId: tenant, skillKey: PROSPECTOR_SKILL_ID, copyFrom: 'active', content: { instructions: `${text}\n\n${MARK[v]}` }, createdBy: 'it' });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  let expA: { id: string; name: string };
  const A_VALIDATION = ['ALFA FOODS', 'BETA CAFES', 'GAMMA HORNOS'];
  const A_TRAIN = ['DELTA VINOS', 'EPSILON QUESOS', 'ZETA ACEITES', 'ETA CONSERVAS', 'THETA DULCES'];

  it('PASS_FORM stores the per-case outputs; with 0 labels the re-validation is INSUFFICIENT (cost 0) and is not duplicated', async () => {
    await makeDataset('it-reval', 1, [...A_VALIDATION.map((name) => ({ split: 'VALIDATION' as const, name })), ...A_TRAIN.map((name) => ({ split: 'TRAIN' as const, name })), { split: 'TEST', name: 'OMEGA TEST' }]);
    const { experiment, report } = await runExperiment(deps((v) => (v === 'cand' ? good() : weak()), MARK[2]), opts(2, 'it-reval'));
    expect(experiment).toMatchObject({ name: 'EXP-003', status: 'COMPLETED', decision: 'PASS_FORM' });
    expect(report.phases[0]!.cases).toHaveLength(8);
    expA = { id: experiment.id, name: experiment.name };
    const outputs = (experiment.metrics.phases as { VALIDATION: { case_outputs: Array<{ case_id: string; version: number }> } }).VALIDATION.case_outputs;
    expect(outputs).toHaveLength(16); // 8 cases x 2 versions x 1 repetition
    expect(new Set(outputs.map((o) => o.version))).toEqual(new Set([1, 2]));

    const res = await revalidate('EXP-003', { by: 'PM' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as RevalBody;
    expect(body).toMatchObject({ verdict: 'INSUFFICIENT', created: true, cost_eur: 0, outputs_source: 'metrics', labels: { used: 0, excluded: 0, unlabeled: 8, min_required: 5, missing: 5, executed_cases: 8 }, version_state: { state: 'INACTIVE', relevant: false } });
    expect(body.accuracy.baseline.value).toBeNull();
    expect(body.revalidation).toMatchObject({ verdict: 'INSUFFICIENT', label_case_ids: [], cost_eur: 0, consequence: {} });
    // Same labels -> same row (200).
    const again = await revalidate('exp-003');
    expect(again.statusCode).toBe(200);
    expect((again.json() as RevalBody).revalidation!.id).toBe(body.revalidation!.id);
    expect((again.json() as RevalBody).created).toBe(false);
    // Dry run: computes, writes nothing.
    const dry = await revalidate('EXP-003', { dry_run: true, min_labels: 3 });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dry_run: true, created: false, revalidation: null, verdict: 'INSUFFICIENT', labels: { min_required: 3 } });
    expect(await handle.db.select().from(experimentRevalidations).where(eq(experimentRevalidations.experimentId, experiment.id))).toHaveLength(1);
  });

  it('pending-revalidation lists only PASS_FORM experiments whose version is ACTIVE or in canary', async () => {
    expect((await pending()).items).toEqual([]); // v2 is DRAFT
    const act = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/2/activate`, headers });
    expect(act.json()).toMatchObject({ changed: true, gate: { revalidate: true, experiment: { name: 'EXP-003' } } });
    const p = await pending();
    expect(p.ready).toBe(0);
    expect(p.items).toMatchObject([{ experiment: { name: 'EXP-003', candidate_version: 2 }, version_state: { state: 'ACTIVE' }, labels: { usable: 0, fresh: 0, min_required: 5 }, outputs_source: 'metrics', ready: false, last_revalidation: { verdict: 'INSUFFICIENT' } }]);
  });

  it('labels harvested later -> CONFIRMED on the stored outputs; design cases of the candidate are left out (P5); the experiment is untouched', async () => {
    const before = await experimentRow(expA.id);
    const afterStart = new Date((before.startedAt ?? new Date()).getTime() + 60_000).toISOString();
    // The candidate's optimizer run marked ZETA as design (after the experiment started: still its design).
    const [run] = await handle.db.insert(optimizationRuns).values({ tenantId: tenant, skillName: PROSPECTOR_SKILL_ID, baseVersion: 1, status: 'GATE_PASS', candidateVersion: 2, experimentId: expA.id, createdBy: 'it' }).returning();
    const inherited = (experiment: string, role: CaseUse['role'], at: string): CaseUse => ({ experiment, role, at, via: 'inherited', from_version: 1 });
    const v2 = await makeDataset('it-reval', 2, [
      ...['ALFA FOODS', 'BETA CAFES', 'GAMMA HORNOS', 'DELTA VINOS', 'EPSILON QUESOS'].map((n) => humanLabel(n, { usedBy: [inherited('EXP-003', 'validation', before.startedAt!.toISOString())] })),
      humanLabel('ZETA ACEITES', { usedBy: [{ experiment: runLabel(run!.id), role: 'design', at: afterStart, via: 'mark_used' }] }),
      humanLabel('ETA CONSERVAS', { usedBy: [inherited('EXP-001', 'design', '2026-10-01T00:00:00Z')] }),
      // A later design use by ANOTHER optimizer run does not taint this candidate.
      humanLabel('THETA DULCES', { usedBy: [{ experiment: 'OPT-0000ffff', role: 'design', at: new Date(Date.now() + 120_000).toISOString(), via: 'mark_used' }] }),
      { split: 'TRAIN', name: 'NUEVA SIN EJECUTAR', expected: accepted, source: { origin: 'harvested', expected_source: 'human', evaluation_id: randomUUID(), evaluated_at: new Date().toISOString() } },
    ]);

    const p = await pending();
    expect(p.ready).toBe(1);
    expect(p.items[0]).toMatchObject({ labels: { usable: 6, fresh: 6, excluded: 2 }, ready: true });

    const res = await revalidate('EXP-003', { by: 'PM' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as RevalBody;
    // Both arms said relevant + writable on every case, as the commercial did: 6/6 each.
    expect(body).toMatchObject({ verdict: 'CONFIRMED', created: true, labels: { used: 6, excluded: 2, unlabeled: 0 }, accuracy: { baseline: { value: 1, correct: 6, decisions: 6 }, candidate: { value: 1, correct: 6, decisions: 6 }, threshold: 1 }, version_state: { state: 'ACTIVE', relevant: true } });
    expect(body.revalidation!.excluded.map((x) => [x.exhibitor, x.reason]).sort()).toEqual([
      ['ETA CONSERVAS', 'design'],
      ['ZETA ACEITES', 'design'],
    ]);
    expect(new Set(body.revalidation!.label_case_ids)).toEqual(new Set(['ALFA FOODS', 'BETA CAFES', 'GAMMA HORNOS', 'DELTA VINOS', 'EPSILON QUESOS', 'THETA DULCES'].map((n) => v2.ids.get(n)!)));
    expect(body.revalidation!.evaluation_ids).toHaveLength(6);
    expect(body.revalidation!.label_case_ids).not.toContain(v2.ids.get('NUEVA SIN EJECUTAR'));
    // CONFIRMED: no note, no event.
    expect(body.revalidation!.consequence).toEqual({});
    expect(crm.tables.notes).toHaveLength(0);

    // The experiment row is exactly as it was, and still immutable.
    const after = await experimentRow(expA.id);
    expect(after).toEqual(before);
    await expect(handle.pool.query(`update experiments set gate_result = '{}'::jsonb where id = $1`, [expA.id])).rejects.toThrow(/immutable/);

    // Nothing fresh any more.
    expect((await pending()).items[0]).toMatchObject({ labels: { usable: 6, fresh: 0 }, ready: false, last_revalidation: { verdict: 'CONFIRMED' } });
    const list = await app.inject({ method: 'GET', url: '/experiments/EXP-003/revalidations', headers });
    expect((list.json() as { items: Array<{ verdict: string }> }).items.map((i) => i.verdict)).toEqual(['CONFIRMED', 'INSUFFICIENT']);
  });

  it('REFUTED: no note while the version is not in use; once it is in canary, a note in Twenty and the event, and nothing is changed', async () => {
    const B = ['IOTA PAN', 'KAPPA CAFES', 'LAMBDA VINOS', 'MU QUESOS', 'NU ACEITES', 'XI DULCES'];
    await makeDataset('it-reval-b', 1, B.map((name) => ({ split: 'VALIDATION' as const, name })));
    // Candidate v3: better form, but a confidence under the agent threshold: nothing writable.
    const { experiment } = await runExperiment(deps((v) => (v === 'cand' ? { ...good(), confidence: 0.45 } : weak()), MARK[3]), opts(3, 'it-reval-b'));
    expect(experiment).toMatchObject({ name: 'EXP-004', decision: 'PASS_FORM', baselineVersion: 2, candidateVersion: 3 });

    await makeDataset('it-reval-b', 2, B.slice(0, 5).map((n) => humanLabel(n)));
    const r1 = await revalidate('EXP-004');
    expect(r1.statusCode).toBe(201);
    const b1 = r1.json() as RevalBody;
    expect(b1).toMatchObject({ verdict: 'REFUTED', accuracy: { baseline: { value: 1 }, candidate: { value: 0, correct: 0, decisions: 5 } }, version_state: { state: 'INACTIVE', relevant: false } });
    expect(b1.summary).toMatch(/REFUTED/);
    expect(b1.revalidation!.consequence).toEqual({});
    expect(crm.tables.notes).toHaveLength(0);

    // Since tanda 13 the Release Gate reads the most recent re-validation: the REFUTED blocks a canary of v3.
    const canary = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/3/canary`, headers, payload: { percent: 10, by: 'PM' } });
    expect(canary.statusCode).toBe(409);
    expect(canary.json()).toMatchObject({ error: 'release_gate_blocked', details: { reason: 'revalidation_refuted', revalidation: { id: b1.revalidation!.id } } });
    // A canary started before that re-validation existed (same service, the gate of the time
    // let the PASS_FORM through); then one more label arrives.
    const started = await startCanary(handle.db, {
      tenantId: tenant,
      skillKey: PROSPECTOR_SKILL_ID,
      version: 3,
      percent: 10,
      by: 'PM',
      guard: async () => ({ experimentId: experiment.id, record: { mode: 'experiment', note: 'it: canario anterior a la revalidación' } }),
    });
    expect(started.changed).toBe(true);
    await makeDataset('it-reval-b', 3, B.map((n) => humanLabel(n)));
    const r2 = await revalidate('EXP-004', { by: 'PM' });
    expect(r2.statusCode).toBe(201);
    const b2 = r2.json() as RevalBody;
    expect(b2).toMatchObject({ verdict: 'REFUTED', labels: { used: 6 }, version_state: { state: 'CANARY', relevant: true } });
    const cons = b2.revalidation!.consequence as { note: { id: string; title: string; created: boolean }; event: { id: string; type: string } };
    expect(cons.note).toMatchObject({ created: true, title: `⚠️ Revalidación fallida — ${PROSPECTOR_SKILL_ID} v3` });
    expect(crm.tables.notes).toHaveLength(1);
    const md = (crm.tables.notes![0]!.bodyV2 as { markdown: string }).markdown;
    expect(md).toMatch(/EXP-004/);
    expect(md).toMatch(/canary\/rollback/);
    expect(md).toMatch(/0,000 \| 0\/6/);

    // The internal event, for n8n.
    expect(cons.event).toMatchObject({ type: 'experiment.revalidation_failed' });
    const [ev] = await handle.db.select().from(events).where(and(eq(events.tenantId, tenant), eq(events.type, 'experiment.revalidation_failed')));
    expect(ev!.payload).toMatchObject({ experimentName: 'EXP-004', candidateVersion: 3, verdict: 'REFUTED', baselineAccuracy: 1, candidateAccuracy: 0, versionState: 'CANARY', noteId: cons.note.id });
    expect(eventQueue.jobs.size).toBeGreaterThan(0);

    // Nothing was deactivated or rolled back: v2 ACTIVE, v3 DRAFT with its canary still ACTIVE.
    const skill = (await findSkill(handle.db, tenant, PROSPECTOR_SKILL_ID))!;
    const versions = await handle.db.select().from(skillVersions).where(eq(skillVersions.skillId, skill.id));
    expect(Object.fromEntries(versions.map((v) => [v.version, v.status]))).toMatchObject({ 2: 'ACTIVE', 3: 'DRAFT' });
    const can = await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}/canary`, headers });
    expect(JSON.stringify(can.json())).toMatch(/"status":"ACTIVE"/);

    // Repeating the same request returns the same row: no second note.
    const r3 = await revalidate('EXP-004');
    expect(r3.statusCode).toBe(200);
    expect(crm.tables.notes).toHaveLength(1);

    // Append-only: no DELETE, no edit of the verdict, consequence written once.
    const id = b2.revalidation!.id;
    await expect(handle.pool.query('delete from experiment_revalidations where id = $1', [id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query(`update experiment_revalidations set verdict = 'CONFIRMED' where id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query(`update experiment_revalidations set consequence = '{"x":1}'::jsonb where id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query(`insert into experiment_revalidations (tenant_id, experiment_id, experiment_name, subject_type, subject_name, candidate_version, verdict, labels_hash, summary, outputs_source, cost_eur) values ($1, $2, 'EXP-004', 'skill', 'x', 3, 'CONFIRMED', 'h', 's', 'metrics', 0.5)`, [tenant, experiment.id])).rejects.toThrow(/cost_ck/);
  });

  it('only a COMPLETED PASS_FORM can be re-validated; unknown -> 404; strict body', async () => {
    const draft = await createExperiment(handle.db, { tenantId: tenant, subjectType: 'skill', subjectName: PROSPECTOR_SKILL_ID, baselineVersion: 2, candidateVersion: 3, config: {}, createdBy: 'it' });
    const res = await revalidate(draft.name);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_pass_form' });
    expect((await revalidate('EXP-999')).statusCode).toBe(404);
    expect((await revalidate('EXP-003', { force: true })).statusCode).toBe(400);
    expect((await revalidate('EXP-003', { min_labels: 0 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/experiments/EXP-003/revalidations', headers })).statusCode).toBe(404);
  });

  it('an experiment older than case_outputs re-validates from its informe.json artifact, or says it cannot (422)', async () => {
    const exp = await createExperiment(handle.db, { tenantId: tenant, subjectType: 'skill', subjectName: PROSPECTOR_SKILL_ID, baselineVersion: 2, candidateVersion: 3, config: { dataset: { name: 'it-reval-b' }, gate: gateConfig() }, createdBy: 'it' });
    await startExperiment(handle.db, exp.id);
    const ds = await handle.db.select().from(evaluationCases).innerJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationCases.datasetId)).where(and(eq(evaluationDatasets.tenantId, tenant), eq(evaluationDatasets.name, 'it-reval-b'), eq(evaluationDatasets.version, 1)));
    const caseIds = ds.map((r) => r.evaluation_cases.id);
    const done = await completeExperiment(handle.db, exp.id, { decision: 'PASS_FORM', splits: { VALIDATION: { role: 'validation', case_ids: caseIds, form_sample_case_ids: [] } }, metrics: { phases: { VALIDATION: {} }, artifacts: { json: 'docs/experimentos/EXP-OLD-auto/informe.json' } }, gateResult: { decision: 'PASS_FORM', mode: 'form' }, costEur: 0 });

    const root = mkdtempSync(join(tmpdir(), 'pxos-reval-'));
    const missing = await revalidateExperiment({ db: handle.db, repoRoot: root }, { tenantId: tenant, experiment: done.name, dryRun: true }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(RevalidationError);
    expect((missing as RevalidationError).code).toBe('outputs_unavailable');
    expect((await revalidate(done.name)).statusCode).toBe(422);

    // The artifact: v2 (baseline) right on every case, v3 wrong.
    const decision = (relevant: boolean, confidence: number) => ({ exhibitor: 'x', relevant, writable: relevant && confidence >= 0.5, confidence, status: 'ok' });
    const report = { experiment: { id: done.id }, phases: [{ fixtures: [{ case_ids: caseIds }], reports: [{ runs: [{ version: 2, repetition: 1, decisions: caseIds.map(() => decision(true, 0.7)) }, { version: 3, repetition: 1, decisions: caseIds.map(() => decision(false, 0.05)) }] }] }] };
    mkdirSync(join(root, 'docs/experimentos/EXP-OLD-auto'), { recursive: true });
    writeFileSync(join(root, 'docs/experimentos/EXP-OLD-auto/informe.json'), JSON.stringify(report));
    const r = await revalidateExperiment({ db: handle.db, repoRoot: root }, { tenantId: tenant, experiment: done.name, source: 'cli', note: false });
    expect(r.created).toBe(true);
    expect(r.computation.outputs.source).toBe('artifact');
    expect(r.revalidation).toMatchObject({ verdict: 'REFUTED', outputsSource: 'artifact', baselineAccuracy: 1, candidateAccuracy: 0, source: 'cli' });
    // v3 is in canary: the consequence is recorded, the note was switched off.
    expect(r.revalidation!.consequence).toMatchObject({ note: { skipped: 'disabled' } });
  });
});
