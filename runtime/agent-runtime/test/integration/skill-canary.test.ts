/**
 * Skill canary end to end against a real PostgreSQL (no Redis, no network): the canary needs
 * the Release Gate (experiment PASS / PASS_FORM, no force), only one per skill, the worker routes
 * each task run by a deterministic hash of its id and records the arm in the trace, GET
 * /skills/:id/canary compares the arms from traces and evaluations, and a human promotes (gate
 * re-checked) or rolls back (always). Fresh tenants per run, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt11_harness.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { evaluations, skillCanaries, taskDefinitions, taskRuns, traces, type SkillVersionUsed } from '../../src/db/schema.js';
import { completeExperiment, createExperiment, startExperiment } from '../../src/experiments/service.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedHarnesses } from '../../src/seed/harness-seed.js';
import { PROSPECTOR_TASK_NAME, seedProspector } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { canaryArm } from '../../src/skills/canary.js';
import { findSkill, listVersions } from '../../src/skills/service.js';
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
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'Sin encaje.', hypothesis: null });
const V2_TEXT = `${PROSPECTOR_SYSTEM_PROMPT}\n\n## Canario v2\nPrioriza expositores con lanzamientos de producto.`;
const V3_TEXT = `${PROSPECTOR_SYSTEM_PROMPT}\n\n## Canario v3\nOtra prueba.`;
type CanaryBody = { canary: { id: string; status: string; percent: number; canary_version: number; stable_version: number; finish_gate: unknown; finished_by: string | null }; changed: boolean };

describe.skipIf(!dbAvailable)('skill canary (PostgreSQL)', () => {
  const tenant = `it-can-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const fake = new FakeTwenty();
  let handle: DbHandle;
  let app: FastifyInstance;
  let provider: StubProvider;
  let processor: RunProcessor;
  let runSeq = 0;
  const S = PROSPECTOR_SKILL_ID;

  async function prospectorRun() {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-canary:${tenant}:${++runSeq}`, trigger: 'MANUAL' });
    provider = new StubProvider({ responseText: IRRELEVANT });
    for (const { job } of queue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, run!.executionId!) });
    const record = (trace!.skillVersions as SkillVersionUsed[]).find((r) => r.name === S)!;
    return { systems: provider.requests.map((r) => r.system), run: run!, trace: trace!, record };
  }

  /** A COMPLETED experiment with this decision (the runner itself is tested in experiments.test.ts). */
  async function experiment(baseline: number, candidate: number, decision: 'PASS' | 'PASS_FORM' | 'FAIL') {
    const skill = await findSkill(handle.db, tenant, S);
    const cand = (await listVersions(handle.db, skill!.id)).find((v) => v.version === candidate)!;
    const e = await createExperiment(handle.db, { tenantId: tenant, subjectType: 'skill', subjectName: S, baselineVersion: baseline, candidateVersion: candidate, config: { candidate: { version: candidate, version_id: cand.id } }, createdBy: 'it' });
    await startExperiment(handle.db, e.id);
    return completeExperiment(handle.db, e.id, { decision, splits: {}, metrics: {}, gateResult: { decision, mode: decision === 'PASS_FORM' ? 'form' : 'labeled', summary: 'it' }, costEur: 0 });
  }
  const post = (url: string, payload?: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    processor = new RunProcessor(handle.db, () => provider, { info() {}, warn() {}, error() {} }, createDefaultToolRegistry({ twenty: fake.client() }), null);
    await seedHarnesses(handle.db, { tenantId: tenant });
    await seedSkills(handle.db, { tenantId: tenant });
    await seedProspector(handle.db, { tenantId: tenant, defaultInput: fixture });
    for (const text of [V2_TEXT, V3_TEXT]) expect((await post(`/skills/${S}/versions`, { copy_from: 'active', instructions: text, created_by: 'it' })).statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('a canary needs the Release Gate (no experiment -> 409 release_gate_blocked) and never accepts force', async () => {
    const res = await post(`/skills/${S}/versions/2/canary`, { percent: 50 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'release_gate_blocked', details: { candidate_version: 2, active_version: 1 } });
    expect((res.json() as { message: string }).message).toMatch(/no admite force/);
    expect((await post(`/skills/${S}/versions/2/canary`, { percent: 50, force: true, reason: 'quiero saltarme el gate' })).statusCode).toBe(400);
    expect((await post(`/skills/${S}/versions/2/canary`, { percent: 0 })).statusCode).toBe(400);
    expect((await post(`/skills/${S}/versions/2/canary`, { percent: 100 })).statusCode).toBe(400);
    expect((await post(`/skills/${S}/versions/1/canary`, { percent: 10 })).statusCode).toBe(409); // already ACTIVE
    await experiment(1, 2, 'FAIL');
    expect(JSON.stringify((await post(`/skills/${S}/versions/2/canary`, { percent: 50 })).json())).toMatch(/decidió FAIL/);
    expect((await app.inject({ method: 'GET', url: `/skills/${S}/canary`, headers })).statusCode).toBe(404);
  });

  it('after a PASS: canary at 50 %, one per skill, idempotent; activation is blocked while it runs', async () => {
    const exp = await experiment(1, 2, 'PASS');
    const res = await post(`/skills/${S}/versions/2/canary`, { percent: 50, by: 'PM' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as CanaryBody & { gate: { mode: string; experiment: { name: string } } };
    expect(body).toMatchObject({ changed: true, canary: { status: 'ACTIVE', percent: 50, canary_version: 2, stable_version: 1 }, gate: { mode: 'experiment', experiment: { name: exp.name } } });

    expect((await post(`/skills/${S}/versions/2/canary`, { percent: 50 })).json()).toMatchObject({ changed: false, canary: { id: body.canary.id } });
    expect((await post(`/skills/${S}/versions/2/canary`, { percent: 20 })).statusCode).toBe(409);
    await experiment(1, 3, 'PASS');
    const second = await post(`/skills/${S}/versions/3/canary`, { percent: 10 });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { message: string }).message).toMatch(/one canary per skill/);
    // Database guard too: a second ACTIVE canary violates the partial unique index.
    const skill = await findSkill(handle.db, tenant, S);
    const versions = await listVersions(handle.db, skill!.id);
    await expect(
      handle.pool.query(`insert into skill_canaries (tenant_id, skill_id, canary_version_id, canary_version, stable_version_id, stable_version, percent, experiment_id) values ($1, $2, $3, 3, $4, 1, 10, $5)`, [
        tenant,
        skill!.id,
        versions.find((v) => v.version === 3)!.id,
        versions.find((v) => v.version === 1)!.id,
        exp.id,
      ]),
    ).rejects.toThrow(/skill_canaries_one_active_uq/);

    const act = await post(`/skills/${S}/versions/2/activate`);
    expect(act.statusCode).toBe(409);
    expect((act.json() as { message: string }).message).toMatch(/ACTIVE canary/);
  });

  it('the worker routes each run by a deterministic hash of its id; the trace records the arm; GET /canary compares the arms', async () => {
    const [canary] = await handle.db.select().from(skillCanaries).where(and(eq(skillCanaries.tenantId, tenant), eq(skillCanaries.status, 'ACTIVE')));
    const runs = [];
    for (let i = 0; i < 16; i++) runs.push(await prospectorRun());
    for (const r of runs) {
      expect(r.run.status).toBe('COMPLETED');
      const expected = canaryArm(canary!.id, 50, r.run.id).arm;
      expect(r.record).toMatchObject({ source: 'db', version: expected === 'canary' ? 2 : 1, canary: { canary_id: canary!.id, arm: expected, routing_key: r.run.id, percent: 50 } });
      expect(r.systems.every((s) => s === (expected === 'canary' ? V2_TEXT : PROSPECTOR_SYSTEM_PROMPT))).toBe(true);
      // task_runs keeps the same record (without text).
      expect((r.run.skillVersions as SkillVersionUsed[]).find((x) => x.name === S)).toMatchObject({ version: r.record.version, canary: { arm: expected } });
    }
    const canaryRuns = runs.filter((r) => r.record.canary!.arm === 'canary');
    expect(canaryRuns.length).toBeGreaterThan(0);
    expect(canaryRuns.length).toBeLessThan(16);

    // Verdicts: one human verdict and one automatic score on a canary execution.
    const ex = canaryRuns[0]!.run.executionId!;
    await handle.db.insert(evaluations).values({ tenantId: tenant, subjectType: 'hypothesis', subjectId: randomUUID(), agentExecutionId: ex, feedback: 'ACCEPTED', score: 1, source: 'it' });
    await handle.db.insert(evaluations).values({ tenantId: tenant, kind: 'COMPOSITE', evaluatorId: 'composite-v1', subjectType: 'execution_output', subjectId: randomUUID(), agentExecutionId: ex, feedback: 'PASS', score: 0.8, source: 'it' });

    const res = await app.inject({ method: 'GET', url: `/skills/${S}/canary`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      active: boolean;
      canary: { id: string };
      metrics: { arms: Record<'canary' | 'stable', { runs: number; version: number; by_status: { completed: number }; human_feedback: { accepted: number }; automatic_evaluations: Array<{ evaluator_id: string; avg_score: number }> }>; observed_canary_share: number; delta_canary_minus_stable: Record<string, unknown> };
      history: unknown[];
    };
    expect(body.active).toBe(true);
    expect(body.canary.id).toBe(canary!.id);
    expect(body.metrics.arms.canary).toMatchObject({ runs: canaryRuns.length, version: 2, by_status: { completed: canaryRuns.length }, human_feedback: { accepted: 1 }, automatic_evaluations: [{ evaluator_id: 'composite-v1', avg_score: 0.8 }] });
    expect(body.metrics.arms.stable).toMatchObject({ runs: 16 - canaryRuns.length, version: 1, human_feedback: { accepted: 0 } });
    expect(body.metrics.observed_canary_share).toBeCloseTo(canaryRuns.length / 16, 4);
    expect(body.metrics.delta_canary_minus_stable).toHaveProperty('success_rate');
    expect(body.history).toHaveLength(1);
  });

  it('rollback: always allowed and idempotent; every run back to the stable version; a finished canary is immutable and never deleted', async () => {
    const rb = await post(`/skills/${S}/canary/rollback`, { by: 'PM', reason: 'prueba de rollback' });
    expect(rb.statusCode).toBe(200);
    const body = rb.json() as CanaryBody;
    expect(body).toMatchObject({ changed: true, canary: { status: 'ROLLED_BACK', finished_by: 'PM' } });
    expect((await post(`/skills/${S}/canary/rollback`)).json()).toMatchObject({ changed: false, canary: { id: body.canary.id, status: 'ROLLED_BACK' } });
    const after = await prospectorRun();
    expect(after.record).toMatchObject({ version: 1 });
    expect(after.record.canary).toBeUndefined();
    expect((await post(`/skills/${S}/canary/promote`)).statusCode).toBe(409); // nothing to promote
    await expect(handle.pool.query(`update skill_canaries set percent = 99 where id = $1`, [body.canary.id])).rejects.toThrow(/immutable/);
    await expect(handle.pool.query(`delete from skill_canaries where id = $1`, [body.canary.id])).rejects.toThrow(/no physical DELETE/);
  });

  it('promote: a human decision, the gate is re-checked, the canary version becomes ACTIVE and the canary PROMOTED', async () => {
    expect((await post(`/skills/${S}/versions/2/canary`, { percent: 20, by: 'PM' })).statusCode).toBe(201);
    const pr = await post(`/skills/${S}/canary/promote`, { by: 'PM' });
    expect(pr.statusCode).toBe(200);
    expect(pr.json()).toMatchObject({ changed: true, canary: { status: 'PROMOTED', finished_by: 'PM' }, version: { version: 2, status: 'ACTIVE' }, previous_version: { version: 1, status: 'DEPRECATED' }, gate: { mode: 'experiment' } });
    expect((pr.json() as CanaryBody).canary.finish_gate).toMatchObject({ mode: 'experiment', step: 'promote' });
    const after = await prospectorRun();
    expect(after.record).toMatchObject({ version: 2 });
    expect(after.record.canary).toBeUndefined();
    const hist = (await app.inject({ method: 'GET', url: `/skills/${S}/canary`, headers })).json() as { active: boolean; history: Array<{ status: string }> };
    expect(hist.active).toBe(false);
    expect(hist.history.map((h) => h.status)).toEqual(['PROMOTED', 'ROLLED_BACK']);
  });

  it('deprecating the canary version closes the canary (ROLLED_BACK); promote re-checks the gate against the current ACTIVE version', async () => {
    // v3: PASS against v1, but the ACTIVE version is now v2 -> no canary.
    expect((await post(`/skills/${S}/versions/3/canary`, { percent: 10 })).statusCode).toBe(409);
    await experiment(2, 3, 'PASS_FORM');
    const start = await post(`/skills/${S}/versions/3/canary`, { percent: 10 });
    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({ gate: { revalidate: true } });
    const dep = await post(`/skills/${S}/versions/3/deprecate`);
    expect(dep.statusCode).toBe(200);
    expect(dep.json()).toMatchObject({ changed: true, version: { version: 3, status: 'DEPRECATED' }, canary_rolled_back: { status: 'ROLLED_BACK', canary_version: 3 } });
    const all = await handle.db.select().from(skillCanaries).where(eq(skillCanaries.tenantId, tenant));
    expect(all.map((c) => c.status).sort()).toEqual(['PROMOTED', 'ROLLED_BACK', 'ROLLED_BACK']);
  });
});
