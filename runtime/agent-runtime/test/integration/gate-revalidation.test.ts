/**
 * Release Gate + re-validations end to end against a real PostgreSQL (no Redis, no network):
 * the most recent row of `experiment_revalidations` of the activating experiment decides on
 * top of its PASS_FORM, on the four paths that go through the gate:
 * - skill activation and harness activation: REFUTED -> 409 `release_gate_blocked` with
 *   `reason: 'revalidation_refuted'`; a human force still passes and is audited;
 * - canary start and canary promote (no force): REFUTED -> 409 with the same reason;
 * - CONFIRMED -> passes with `revalidated: true`; INSUFFICIENT -> as before;
 * - the most recent row (by created_at, not by insertion order) decides; rollback is free.
 * The experiment rows are never touched. Fresh tenants per run, no DELETE. Run it against its
 * own database: DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt13_gate
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { listAudit } from '../../src/audit/service.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { experimentRevalidations, type Experiment, type ExperimentSubjectType, type RevalidationVerdict } from '../../src/db/schema.js';
import { completeExperiment, createExperiment, findExperiment, startExperiment } from '../../src/experiments/service.js';
import { DEFAULT_COMMERCIAL_HARNESS_NAME } from '../../src/harness/config.js';
import { findHarness, listHarnessVersions } from '../../src/harness/service.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedHarnesses } from '../../src/seed/harness-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { findSkill, listVersions } from '../../src/skills/service.js';

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

type Blocked = { error: string; message: string; details: { reason: string; revalidation?: { id: string; verdict: string; created_at: string; baseline_accuracy: number | null; candidate_accuracy: number | null }; options?: Record<string, string>; experiment?: { name: string } } };

describe.skipIf(!dbAvailable)('Release Gate with re-validations (PostgreSQL)', () => {
  const tenant = `it-grv-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const S = PROSPECTOR_SKILL_ID;
  const H = DEFAULT_COMMERCIAL_HARNESS_NAME;
  let handle: DbHandle;
  let app: FastifyInstance;
  let labelSeq = 0;
  /** EXP of skill v2 vs v1 (first test), re-validated again by the second. */
  let skillExp: Experiment | undefined;

  const post = (url: string, payload?: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });

  async function versionId(subjectType: ExperimentSubjectType, version: number): Promise<string> {
    if (subjectType === 'harness') {
      const h = await findHarness(handle.db, tenant, H);
      return (await listHarnessVersions(handle.db, h!.id)).find((v) => v.version === version)!.id;
    }
    const s = await findSkill(handle.db, tenant, S);
    return (await listVersions(handle.db, s!.id)).find((v) => v.version === version)!.id;
  }

  /** A COMPLETED experiment with this decision (the runner itself is tested in experiments.test.ts). */
  async function experiment(subjectType: ExperimentSubjectType, baseline: number, candidate: number, decision: 'PASS' | 'PASS_FORM'): Promise<Experiment> {
    const e = await createExperiment(handle.db, {
      tenantId: tenant,
      subjectType,
      subjectName: subjectType === 'harness' ? H : S,
      baselineVersion: baseline,
      candidateVersion: candidate,
      config: { candidate: { version: candidate, version_id: await versionId(subjectType, candidate) } },
      createdBy: 'it',
    });
    await startExperiment(handle.db, e.id);
    return completeExperiment(handle.db, e.id, { decision, splits: {}, metrics: {}, gateResult: { decision, mode: decision === 'PASS_FORM' ? 'form' : 'labeled', summary: 'it' }, costEur: 0 });
  }

  /** One re-validation row (append-only) with an explicit created_at. */
  async function revalidation(exp: Experiment, verdict: RevalidationVerdict, createdAt: string) {
    const [row] = await handle.db
      .insert(experimentRevalidations)
      .values({
        tenantId: tenant,
        experimentId: exp.id,
        experimentName: exp.name,
        subjectType: exp.subjectType,
        subjectName: exp.subjectName,
        baselineVersion: exp.baselineVersion,
        candidateVersion: exp.candidateVersion,
        verdict,
        labelsHash: `it-${++labelSeq}`,
        labelCaseIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
        baselineAccuracy: verdict === 'REFUTED' ? 0.8 : 0.6,
        candidateAccuracy: verdict === 'REFUTED' ? 0.4 : 0.8,
        summary: `${verdict} (it)`,
        outputsSource: 'metrics',
        source: 'cli',
        createdAt: new Date(createdAt),
      })
      .returning();
    return row!;
  }

  const audit = async (action: string) => (await listAudit(handle.db, { tenantId: tenant, actions: [action], limit: 1 }))[0];

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    await seedSkills(handle.db, { tenantId: tenant });
    await seedHarnesses(handle.db, { tenantId: tenant });
    for (const n of [2, 3]) expect((await post(`/skills/${S}/versions`, { copy_from: 'active', instructions: `Instrucciones de prueba v${n} del gate con revalidaciones.`, created_by: 'it' })).statusCode).toBe(201);
    expect((await post(`/harnesses/${H}/versions`, { copy_from: 1, config: { context: { max_output_tokens: 1500 } }, change_reason: 'prueba', created_by: 'it' })).statusCode).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('skill: PASS_FORM + REFUTED blocks activation and canary start (409, reason revalidation_refuted); the newest row decides', async () => {
    const exp = await experiment('skill', 1, 2, 'PASS_FORM');
    skillExp = exp;
    // Inserted newest first: the gate orders by created_at, not by insertion.
    const refuted = await revalidation(exp, 'REFUTED', '2026-09-20T10:00:00Z');
    await revalidation(exp, 'CONFIRMED', '2026-09-01T10:00:00Z');

    const act = await post(`/skills/${S}/versions/2/activate`, { by: 'it' });
    expect(act.statusCode).toBe(409);
    const body = act.json() as Blocked;
    expect(body).toMatchObject({
      error: 'release_gate_blocked',
      details: { reason: 'revalidation_refuted', experiment: { name: exp.name }, revalidation: { id: refuted.id, verdict: 'REFUTED', created_at: '2026-09-20T10:00:00.000Z', baseline_accuracy: 0.8, candidate_accuracy: 0.4 } },
    });
    expect(Object.keys(body.details.options!)).toEqual(['force', 'iterate', 'rollback']);
    expect(body.message).toContain(refuted.id);

    const canary = await post(`/skills/${S}/versions/2/canary`, { percent: 20, by: 'it' });
    expect(canary.statusCode).toBe(409);
    const cb = canary.json() as Blocked;
    expect(cb).toMatchObject({ error: 'release_gate_blocked', details: { reason: 'revalidation_refuted', revalidation: { id: refuted.id } } });
    expect(Object.keys(cb.details.options!)).toEqual(['iterate', 'rollback']);
    expect(cb.message).toMatch(/^Release Gate \(canario\): la revalidación más reciente/);
    expect(cb.message).toMatch(/no admite force/);

    // Both rejections are audited with the reason.
    expect(await audit('skill.activate')).toMatchObject({ result: 'rejected', statusCode: 409, errorCode: 'release_gate_blocked', details: { reason: 'revalidation_refuted', revalidation: { id: refuted.id, verdict: 'REFUTED' } } });
    expect(await audit('canary.start')).toMatchObject({ result: 'rejected', statusCode: 409, details: { reason: 'revalidation_refuted' } });

    // The experiment row is untouched (its decision is immutable).
    expect(await findExperiment(handle.db, tenant, exp.id)).toMatchObject({ decision: 'PASS_FORM', status: 'COMPLETED' });
  });

  it('skill: a newer CONFIRMED lets the canary start with revalidated: true; a newer REFUTED blocks the promote; rollback is free', async () => {
    const e = skillExp!;
    const confirmed = await revalidation(e, 'CONFIRMED', '2026-09-25T10:00:00Z');

    const start = await post(`/skills/${S}/versions/2/canary`, { percent: 20, by: 'it' });
    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({ canary: { status: 'ACTIVE', canary_version: 2 }, gate: { mode: 'experiment', revalidate: false, revalidated: true, revalidation: { id: confirmed.id, verdict: 'CONFIRMED' } } });
    expect(await audit('canary.start')).toMatchObject({ result: 'ok', details: { gate_revalidated: true, gate_revalidation: { id: confirmed.id } } });

    const refutedAgain = await revalidation(e, 'REFUTED', '2026-09-28T10:00:00Z');
    const promote = await post(`/skills/${S}/canary/promote`, { by: 'it' });
    expect(promote.statusCode).toBe(409);
    expect(promote.json()).toMatchObject({ error: 'release_gate_blocked', details: { reason: 'revalidation_refuted', revalidation: { id: refutedAgain.id } } });
    expect((promote.json() as Blocked).message).toMatch(/^Release Gate \(promote\)/);
    expect((promote.json() as Blocked).message).toMatch(/canary\/rollback/);
    // The canary is still running (nothing is rolled back by the gate) until a human does it.
    const state = await app.inject({ method: 'GET', url: `/skills/${S}/canary`, headers });
    expect(state.json()).toMatchObject({ active: true, canary: { canary_version: 2 } });
    expect((await post(`/skills/${S}/canary/rollback`, { by: 'it', reason: 'revalidación refutada' })).statusCode).toBe(200);
  });

  it('skill: force with a reason still activates over a REFUTED and is audited as skill.force_activate', async () => {
    const res = await post(`/skills/${S}/versions/2/activate`, { force: true, reason: 'Decisión del PM: aceptamos el riesgo tras revisar los fallos', by: 'PM' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, gate: { mode: 'override', blocked_reason: 'revalidation_refuted', revalidation: { verdict: 'REFUTED' } } });
    expect(await audit('skill.force_activate')).toMatchObject({
      result: 'ok',
      statusCode: 200,
      payload: { force: true, by: 'PM' },
      details: { gate_mode: 'override', gate_blocked_reason: 'revalidation_refuted', gate_revalidation: { verdict: 'REFUTED' } },
    });
  });

  it('skill: INSUFFICIENT as the newest row changes nothing (PASS_FORM, revalidate: true); rollback ignores re-validations', async () => {
    const exp = await experiment('skill', 2, 3, 'PASS_FORM');
    await revalidation(exp, 'REFUTED', '2026-09-02T10:00:00Z');
    await revalidation(exp, 'INSUFFICIENT', '2026-09-03T10:00:00Z');
    const res = await post(`/skills/${S}/versions/3/activate`, { by: 'it' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: true, gate: { mode: 'experiment', revalidate: true, revalidated: false, revalidation: { verdict: 'INSUFFICIENT' }, experiment: { name: exp.name, decision: 'PASS_FORM' } } });

    // v2 was ACTIVE before: going back is a rollback, whatever its experiment's re-validations say.
    const back = await post(`/skills/${S}/versions/2/activate`, { by: 'it' });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ changed: true, gate: { mode: 'rollback' } });
  });

  it('harness: REFUTED blocks the activation; a newer CONFIRMED passes with revalidated: true', async () => {
    const exp = await experiment('harness', 1, 2, 'PASS_FORM');
    const refuted = await revalidation(exp, 'REFUTED', '2026-09-10T10:00:00Z');
    const blocked = await post(`/harnesses/${H}/versions/2/activate`, { by: 'it' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'release_gate_blocked', details: { reason: 'revalidation_refuted', subject_type: 'harness', revalidation: { id: refuted.id }, options: { force: expect.stringContaining(`/harnesses/${H}/versions/2/activate`) } } });
    expect(await audit('harness.activate')).toMatchObject({ result: 'rejected', details: { reason: 'revalidation_refuted' } });

    const confirmed = await revalidation(exp, 'CONFIRMED', '2026-09-11T10:00:00Z');
    const ok = await post(`/harnesses/${H}/versions/2/activate`, { by: 'it' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, gate: { mode: 'experiment', revalidate: false, revalidated: true, revalidation: { id: confirmed.id } } });
    expect(await audit('harness.activate')).toMatchObject({ result: 'ok', details: { gate_revalidated: true } });
  });

  it('a strict PASS without re-validations is not affected', async () => {
    // skill v3 (DEPRECATED after the rollback, but it was ACTIVE): use a fresh v4 instead.
    expect((await post(`/skills/${S}/versions`, { copy_from: 'active', instructions: 'Instrucciones de prueba v4 del gate con revalidaciones.', created_by: 'it' })).statusCode).toBe(201);
    const exp = await experiment('skill', 2, 4, 'PASS');
    const res = await post(`/skills/${S}/versions/4/activate`, { by: 'it' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gate: { mode: 'experiment', revalidate: false, revalidated: false, revalidation: null, experiment: { name: exp.name, decision: 'PASS' } } });
  });
});
