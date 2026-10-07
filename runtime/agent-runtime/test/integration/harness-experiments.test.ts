/**
 * Harness experiments end to end against a real PostgreSQL, with a scripted ModelProvider (no
 * network): the runner compares the ACTIVE harness version with a DRAFT one on the same cases,
 * with the ACTIVE skill version fixed, and the activation of a harness version goes through
 * the same Release Gate as a skill (409 release_gate_blocked without a PASS / PASS_FORM
 * experiment; rollback to a former ACTIVE version always allowed). Fresh tenants, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt11_harness.
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
import { evaluationCases, evaluationDatasets, evaluations, experiments, type HarnessVersion } from '../../src/db/schema.js';
import { caseContentHash } from '../../src/datasets/core.js';
import { gateConfig, renderExperimentMarkdown, runExperiment, type RunnerDeps } from '../../src/experiments/index.js';
import { DEFAULT_COMMERCIAL_HARNESS_NAME } from '../../src/harness/config.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../../src/providers/model-provider.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedHarnesses } from '../../src/seed/harness-seed.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor, type AgentToolPolicy } from '../../src/tools/index.js';
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
const good = (): Answer => ({ relevant: true, confidence: 0.55, reason: 'Encaje de prueba: por el nombre, parece una empresa del sector con stand.', hypothesis: hyp([300, 600], [600, 1500], 'Unas 300 bolsas tote para visitantes y 15 polos bordados para el equipo.') });

/** Executor: the same skill text in both arms, so it answers by the max_output_tokens the harness made effective. */
class TokensScriptedExecutor implements ModelProvider {
  readonly name = 'scripted';
  readonly seen: Array<{ maxTokens: number | undefined; system: string }> = [];
  constructor(private readonly byMaxTokens: (maxTokens: number | undefined) => Answer) {}
  estimateCost(_m: string, _u: TokenUsage): CostBreakdown {
    return { modelCost: 0.002, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.seen.push({ maxTokens: request.maxTokens, system: request.system ?? '' });
    return { text: JSON.stringify(this.byMaxTokens(request.maxTokens)), model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1500, outputTokens: 300, cachedTokens: 0 }, cost: this.estimateCost(request.model, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), latencyMs: 0 };
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

const EVENT = { name: 'Feria Prueba 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia' };
const H = DEFAULT_COMMERCIAL_HARNESS_NAME;

describe.skipIf(!dbAvailable)('harness experiments and release gate (PostgreSQL)', () => {
  const tenant = `it-hexp-${randomUUID().slice(0, 8)}`;
  const evTenant = `it-hexp-ev-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  const policies: AgentToolPolicy[] = [];

  async function makeDataset(name: string, specs: Array<{ split: 'TRAIN' | 'VALIDATION' | 'TEST'; name: string }>): Promise<string> {
    const [ds] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name, domain: 'prospeccion', version: 1, status: 'DRAFT', createdBy: 'it' }).returning();
    for (const s of specs) {
      const input = { event: EVENT, exhibitor: { name: s.name } };
      const expected = { kind: 'unlabeled' };
      await handle.db.insert(evaluationCases).values({
        datasetId: ds!.id,
        tenantId: tenant,
        split: s.split,
        entityKey: `org:${s.name.toLowerCase()}`,
        input,
        expected,
        source: { origin: 'synthetic', expected_source: 'none' },
        difficulty: 'hard',
        contentHash: caseContentHash(input, expected),
      });
    }
    return ds!.id;
  }

  function deps(byMaxTokens: (m: number | undefined) => Answer): RunnerDeps & { executor: TokensScriptedExecutor } {
    const executor = new TokensScriptedExecutor(byMaxTokens);
    const agentVersion = desiredProspectorVersion();
    const base = parseToolPolicy(agentVersion.configuration);
    return {
      db: handle.db,
      executorProvider: executor,
      judgeProvider: new ScriptedJudge(),
      makeTools: (label, toolPolicy) => {
        policies.push(toolPolicy ?? base);
        return new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), toolPolicy ?? base, { tenantId: tenant, executionId: label, agentId: 'it-hexp', stage: 'PROSPECTOR' }, new AbortController().signal);
      },
      agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
      now: () => new Date('2026-10-07T08:00:00Z'),
      evaluationsTenant: evTenant,
      executor,
    };
  }
  const opts = (candidate: number, dataset: string, extra: Record<string, unknown> = {}) => ({
    tenantId: tenant,
    subjectType: 'harness' as const,
    subjectName: H,
    candidateVersion: candidate,
    dataset,
    budgetEur: 0.3,
    repeat: 1,
    gate: gateConfig(),
    createdBy: 'it',
    ...extra,
  });
  const activate = (v: number, payload?: Record<string, unknown>) => app.inject({ method: 'POST', url: `/harnesses/${H}/versions/${v}/activate`, headers, ...(payload ? { payload } : {}) });
  const newVersion = async (maxOutputTokens: number): Promise<HarnessVersion> => {
    const res = await app.inject({ method: 'POST', url: `/harnesses/${H}/versions`, headers, payload: { copy_from: 1, config: { context: { max_output_tokens: maxOutputTokens } }, change_reason: 'prueba', created_by: 'it' } });
    expect(res.statusCode).toBe(201);
    return (res.json() as { version: HarnessVersion }).version;
  };

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    await seedSkills(handle.db, { tenantId: tenant });
    await seedHarnesses(handle.db, { tenantId: tenant });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('activating a DRAFT harness version without an experiment is blocked (409 release_gate_blocked)', async () => {
    await newVersion(1500); // v2
    const res = await activate(2);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; message: string; details: { subject_type: string; experiments: unknown[] } };
    expect(body.error).toBe('release_gate_blocked');
    expect(body.message).toMatch(/no hay ningún experimento COMPLETED de harness default-commercial v2/);
    expect(body.details).toMatchObject({ subject_type: 'harness', experiments: [] });
  });

  it('harness experiment: ACTIVE v1 vs DRAFT v2 with the ACTIVE skill fixed -> PASS_FORM; then activation passes without force', async () => {
    await makeDataset('it-hforma', [
      { split: 'VALIDATION', name: 'ALFA FOODS' },
      { split: 'VALIDATION', name: 'BETA CAFES' },
      { split: 'TRAIN', name: 'GAMMA HORNOS' },
      { split: 'TEST', name: 'OMEGA TEST' },
    ]);
    // The candidate harness caps max_output_tokens at 1500 (the agent declares 4096): better answers there.
    const d = deps((m) => (m === 1500 ? good() : weak()));
    const { experiment, report } = await runExperiment(d, opts(2, 'it-hforma', { formSample: 'auto' }));
    expect(experiment).toMatchObject({ name: 'EXP-003', subjectType: 'harness', subjectName: H, status: 'COMPLETED', decision: 'PASS_FORM', baselineVersion: 1, candidateVersion: 2 });

    const [v1, v2] = await Promise.all([1, 2].map(async (n) => (await app.inject({ method: 'GET', url: `/harnesses/${H}`, headers })).json().versions.find((v: { version: number }) => v.version === n) as { id: string; content_hash: string }));
    expect(experiment.config).toMatchObject({
      subject: { type: 'harness', name: H },
      baseline: { version: 1, version_id: v1!.id, content_hash: v1!.content_hash, status: 'ACTIVE' },
      candidate: { version: 2, version_id: v2!.id, status: 'DRAFT', overrides: expect.arrayContaining(['context.max_output_tokens']), effective: { max_output_tokens: 1500 } },
      fixed_skill: { name: PROSPECTOR_SKILL_ID, version: 1 },
    });
    // Both arms injected the ACTIVE skill v1 (same system prompt); only the harness changed the request.
    const runs = report.phases[0]!.reports.flatMap((r) => r.runs);
    expect(new Set(runs.map((r) => r.harness?.label))).toEqual(new Set([`${H}@1`, `${H}@2`]));
    expect(runs.every((r) => r.skillRecords[0]!.version === 1 && r.skillRecords[0]!.source === 'db')).toBe(true);
    expect(new Set(d.executor.seen.map((s) => s.maxTokens))).toEqual(new Set([4096, 1500]));
    expect(new Set(d.executor.seen.map((s) => s.system)).size).toBe(1);
    // Every toolbox got the agent policy capped by its harness (LOW_WRITE ceiling of default-commercial).
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.every((p) => p.maxRiskLevel === 'LOW_WRITE')).toBe(true);
    // Evaluations of harness arms never collide with the skill ones.
    const evs = await handle.db.select().from(evaluations).where(eq(evaluations.tenantId, evTenant));
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.subjectType !== 'comparison_case' || e.subjectId.includes(`~${H}@h`))).toBe(true);
    const md = renderExperimentMarkdown(report);
    expect(md).toMatch(/harness default-commercial/);
    expect(md).toMatch(/\/harnesses\/default-commercial\/versions\/2\/activate/);

    const ok = await activate(2);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, gate: { mode: 'experiment', revalidate: true, experiment: { name: 'EXP-003', decision: 'PASS_FORM' } } });
  });

  it('a worse harness candidate -> FAIL; its activation is blocked citing the experiment; rollback to v1 is free; force stays a human override', async () => {
    await makeDataset('it-hpeor', [
      { split: 'VALIDATION', name: 'DELTA VINOS' },
      { split: 'VALIDATION', name: 'EPSILON SA' },
    ]);
    await newVersion(1000); // v3, worse answers
    const d = deps((m) => (m === 1000 ? weak() : good()));
    const { experiment } = await runExperiment(d, opts(3, 'it-hpeor', { judge: false, formSample: 0 }));
    expect(experiment).toMatchObject({ name: 'EXP-004', subjectType: 'harness', baselineVersion: 2, candidateVersion: 3, status: 'COMPLETED', decision: 'FAIL' });

    const blocked = await activate(3);
    expect(blocked.statusCode).toBe(409);
    expect(JSON.stringify(blocked.json())).toMatch(/release_gate_blocked/);
    expect(JSON.stringify(blocked.json())).toMatch(/EXP-004\) decidió FAIL/);

    const back = await activate(1);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ changed: true, version: { version: 1, status: 'ACTIVE' }, gate: { mode: 'rollback' } });

    const forced = await activate(3, { force: true, reason: 'Decisión del PM: probar el techo de 1000 tokens', by: 'PM' });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ gate: { mode: 'override', by: 'PM' } });

    const list = await app.inject({ method: 'GET', url: '/experiments?subject_type=harness', headers });
    expect((list.json() as { items: Array<{ name: string }> }).items.map((i) => i.name)).toEqual(['EXP-004', 'EXP-003']);
    expect(await handle.db.select().from(experiments).where(eq(experiments.tenantId, tenant))).toHaveLength(2);
  });
});
