/**
 * Scheduled Skill Optimizer against a real PostgreSQL (no network, no Redis: in-memory queue,
 * scripted providers): a real fire enqueues a run identical to the manual one (same config, same
 * queue), the worker step ends it as BLOCKED_NO_DATA at no cost (no model call, nothing in the
 * CRM), one `optimizer.scheduled_run` row in audit_log; a second tick in the same window, and a
 * restarted job, do not duplicate; an open run is skipped without ERROR; GET /optimizer/schedule.
 * Fresh tenants, nothing is deleted.
 * Run it against its own database: DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt14_opt
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { listAudit } from '../../src/audit/service.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { optimizationRuns } from '../../src/db/schema.js';
import { MemoryTwenty } from '../../src/integrations/twenty/memory-twenty.js';
import {
  createRun,
  dbScheduleStore,
  MemoryOptimizerQueue,
  OPTIMIZER_SCHEDULE_ACTOR,
  OPTIMIZER_SCHEDULE_AUDIT_ACTION,
  OptimizerScheduleJob,
  optimizerConfig,
  runOptimization,
  type OptimizerScheduleSettings,
} from '../../src/optimizer/index.js';
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

/** A yearly window (1 January 00:00 Madrid) with a catch-up limit that covers the whole year: stable in CI. */
const SETTINGS: OptimizerScheduleSettings = { enabled: true, cron: '0 0 1 1 *', timezone: 'Europe/Madrid', skills: [PROSPECTOR_SKILL_ID], errors: [] };
const CATCH_UP = 400 * 86_400_000;

describe.skipIf(!dbAvailable)('scheduled skill optimizer (PostgreSQL)', () => {
  const suffix = randomUUID().slice(0, 8);
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const newJob = (tenant: string, queue: MemoryOptimizerQueue) =>
    new OptimizerScheduleJob({ settings: SETTINGS, tenantId: tenant, store: dbScheduleStore(handle.db, queue), logger: silent, catchUpMs: CATCH_UP });

  it('a real fire: enqueues the manual run, BLOCKED_NO_DATA at no cost, one audit row; no duplicate in the window nor after a restart', async () => {
    const tenant = `it-optsched-a-${suffix}`;
    await seedSkills(handle.db, { tenantId: tenant });
    const queue = new MemoryOptimizerQueue();
    const job = newJob(tenant, queue);

    const tick = await job.tick();
    expect(tick).toMatchObject({ status: 'checked', skills: [{ skill: PROSPECTOR_SKILL_ID, outcome: 'fired', audited: true }] });
    const runId = tick.status === 'checked' && tick.skills[0]!.outcome === 'fired' ? tick.skills[0]!.runId : '';
    expect([...queue.jobs.values()]).toEqual([{ tenantId: tenant, runId }]);

    // Identical to the manual run: PENDING, ACTIVE base, the default config of optimizerConfig.
    const [row] = await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.id, runId));
    expect(row).toMatchObject({ tenantId: tenant, skillName: PROSPECTOR_SKILL_ID, status: 'PENDING', baseVersion: 1, createdBy: OPTIMIZER_SCHEDULE_ACTOR });
    expect(row!.config).toEqual(JSON.parse(JSON.stringify(optimizerConfig(PROSPECTOR_SKILL_ID))));

    // Second tick in the same window: nothing (memory), and a restarted job asks the database.
    expect((await job.tick()).status).toBe('idle');
    const restarted = newJob(tenant, queue);
    expect(await restarted.tick()).toMatchObject({ status: 'checked', skills: [{ outcome: 'already_fired', runId, open: true }] });

    // The worker step: no failures of the ACTIVE version -> BLOCKED_NO_DATA before any model call.
    const llm = new StubProvider();
    const executor = new StubProvider();
    const crm = new MemoryTwenty();
    const job0 = queue.drain()[0]!;
    const done = await runOptimization({ db: handle.db, llmProvider: llm, executorProvider: executor, judgeProvider: null, twenty: crm.client(), evaluationsTenant: tenant }, job0.tenantId, job0.runId);
    expect(done.status).toBe('BLOCKED_NO_DATA');
    expect(done.costEur).toBe(0);
    expect(llm.requests).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
    expect(done.candidateVersion).toBeNull();

    // A closed run created in the window still counts: another restart does not fire.
    const again = newJob(tenant, queue);
    expect(await again.tick()).toMatchObject({ skills: [{ outcome: 'already_fired', runId, status: 'BLOCKED_NO_DATA', open: false }] });
    expect(queue.jobs.size).toBe(0);
    const runs = await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.tenantId, tenant));
    expect(runs).toHaveLength(1);

    const audit = await listAudit(handle.db, { tenantId: tenant, actions: [OPTIMIZER_SCHEDULE_AUDIT_ACTION] });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'system',
      action: 'optimizer.scheduled_run',
      method: 'JOB',
      route: 'job:optimizer-schedule',
      subjectType: 'skill',
      subjectId: PROSPECTOR_SKILL_ID,
      subjectVersion: 1,
      result: 'ok',
      statusCode: 202,
      payload: { skill: PROSPECTOR_SKILL_ID, run_id: runId, base_version: 1, cron: '0 0 1 1 *', timezone: 'Europe/Madrid' },
    });
    // Nothing else was audited by the job.
    expect(await listAudit(handle.db, { tenantId: tenant })).toHaveLength(1);
  });

  it('an open run (manual, in progress): skipped, no new run, no ERROR, no audit', async () => {
    const tenant = `it-optsched-b-${suffix}`;
    await seedSkills(handle.db, { tenantId: tenant });
    // Created "before the window" does not matter: it is open.
    const manual = await createRun(handle.db, { tenantId: tenant, skillName: PROSPECTOR_SKILL_ID, baseVersion: 1, config: {}, createdBy: 'it-human' });
    const queue = new MemoryOptimizerQueue();
    expect(await newJob(tenant, queue).tick()).toMatchObject({ skills: [{ outcome: 'already_fired', runId: manual.id, status: 'PENDING', open: true }] });
    expect(queue.jobs.size).toBe(0);
    const runs = await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.tenantId, tenant));
    expect(runs.map((r) => r.status)).toEqual(['PENDING']);
    expect(await listAudit(handle.db, { tenantId: tenant })).toHaveLength(0);
  });

  it('a skill that does not exist in the tenant: not launched, logged, nothing written', async () => {
    const tenant = `it-optsched-c-${suffix}`;
    const queue = new MemoryOptimizerQueue();
    const warns: unknown[] = [];
    const job = new OptimizerScheduleJob({ settings: SETTINGS, tenantId: tenant, store: dbScheduleStore(handle.db, queue), logger: { ...silent, warn: (o) => warns.push(o) }, catchUpMs: CATCH_UP });
    expect(await job.tick()).toMatchObject({ skills: [{ outcome: 'not_launched', code: 'skill_not_found' }] });
    expect(warns).toHaveLength(1);
    expect(await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.tenantId, tenant))).toHaveLength(0);
    expect(await listAudit(handle.db, { tenantId: tenant })).toHaveLength(0);
  });

  it('GET /optimizer/schedule: read only, enabled, cron, timezone, skills, last and next fire', async () => {
    const tenant = `it-optsched-d-${suffix}`;
    await seedSkills(handle.db, { tenantId: tenant });
    const queue = new MemoryOptimizerQueue();
    let app: FastifyInstance | undefined;
    let appOff: FastifyInstance | undefined;
    try {
      app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), optimizerQueue: queue, optimizerSchedule: SETTINGS, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
      const empty = await app.inject({ method: 'GET', url: '/optimizer/schedule' });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().schedule).toMatchObject({ enabled: true, cron: '0 0 1 1 *', timezone: 'Europe/Madrid', skills: [PROSPECTOR_SKILL_ID], errors: [], last_fire: null, by_skill: [{ skill: PROSPECTOR_SKILL_ID, last_fire: null }] });
      const next = new Date(empty.json().schedule.next_fire as string);
      expect(next.getTime()).toBeGreaterThan(Date.now());

      // A manual run is not a scheduled fire; the scheduled one is.
      const manual = await app.inject({ method: 'POST', url: `/optimizer/skills/${PROSPECTOR_SKILL_ID}/run`, payload: { created_by: 'it-human' } });
      expect(manual.statusCode).toBe(202);
      await handle.db.update(optimizationRuns).set({ status: 'ERROR', error: 'cerrado por el test' }).where(and(eq(optimizationRuns.tenantId, tenant), eq(optimizationRuns.status, 'PENDING')));
      // The manual run was created in the window: the job counts it as fired.
      expect(await newJob(tenant, queue).tick()).toMatchObject({ skills: [{ outcome: 'already_fired', open: false }] });
      expect((await app.inject({ method: 'GET', url: '/optimizer/schedule' })).json().schedule.last_fire).toBeNull();

      const other = `it-optsched-e-${suffix}`;
      await seedSkills(handle.db, { tenantId: other });
      const fired = await newJob(other, queue).tick();
      const runId = fired.status === 'checked' && fired.skills[0]!.outcome === 'fired' ? fired.skills[0]!.runId : '';
      expect(runId).not.toBe('');
      const status = (await app.inject({ method: 'GET', url: '/optimizer/schedule', headers: { 'x-tenant-id': other } })).json().schedule;
      expect(status.last_fire).toMatchObject({ run_id: runId, skill: PROSPECTOR_SKILL_ID, status: 'PENDING', cost_eur: 0 });
      expect(status.by_skill).toEqual([{ skill: PROSPECTOR_SKILL_ID, last_fire: status.last_fire }]);
      // The manual run and the scheduled one have the same config (one shared launch path).
      const rows = await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.tenantId, other));
      const [manualRow] = await handle.db.select().from(optimizationRuns).where(eq(optimizationRuns.id, manual.json().run.id as string));
      expect(rows[0]!.config).toEqual(manualRow!.config);

      // Disabled (the default): next_fire null; GET is never audited.
      appOff = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), optimizerSchedule: { ...SETTINGS, enabled: false }, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
      const off = (await appOff.inject({ method: 'GET', url: '/optimizer/schedule' })).json().schedule;
      expect(off).toMatchObject({ enabled: false, next_fire: null });
      expect((await listAudit(handle.db, { tenantId: tenant })).map((a) => a.action)).toEqual(['optimizer.run']);
      expect((await app.inject({ method: 'POST', url: '/optimizer/schedule' })).statusCode).toBe(404);
    } finally {
      await app?.close();
      await appOff?.close();
    }
  });
});
