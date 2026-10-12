/**
 * Tanda 16 (incident 2026-10-12) against real PostgreSQL + Redis: the scheduler only registers
 * and fires tasks of SCHEDULER_TENANTS, a late tick obeys the catch-up cap, and
 * `cleanup:archive-test-tenants` archives test tenants while respecting the protected ones.
 *
 * Own database by default (agentos_wt16_sched, same server as the dev one): the shared
 * `agentos` is refused by the guard of test/setup-env.ts anyway. Fresh tenants and a fresh
 * BullMQ queue per run; the queue is obliterated at the end. No DELETE.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agents, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { archiveTestTenants } from '../../src/maintenance/archive-test-tenants.js';
import { MemoryRunQueue, redisConnectionFromUrl } from '../../src/queue/run-queue.js';
import { normalizeScheduledAt } from '../../src/domain/idempotency.js';
import { BullTaskScheduler, scheduleQueueName } from '../../src/scheduler/task-scheduler.js';
import { allTenants, onlyTenants } from '../../src/scheduler/tenant-allowlist.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt16_sched';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6391';

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

function redisReachable(url: string): Promise<boolean> {
  if (process.env.SKIP_REDIS_TESTS === '1') return Promise.resolve(false);
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port || 6379) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.once('data', (d) => done(d.toString().startsWith('+PONG')));
  });
}

const dbAvailable = await databaseReachable(DATABASE_URL);
const available = dbAvailable && (await redisReachable(REDIS_URL));
if (!available) console.warn('[integration] PostgreSQL or Redis not reachable; skipping scheduler hardening tests');

const H = 3600_000;

function spyLogger() {
  const warns: Array<Record<string, any>> = [];
  const infos: Array<{ obj: Record<string, any>; msg?: string }> = [];
  return {
    warns,
    infos,
    logger: { info: (obj: object, msg?: string) => infos.push({ obj: obj as Record<string, any>, msg }), warn: (obj: object) => warns.push(obj as Record<string, any>), error() {} },
  };
}

describe.skipIf(!available)('scheduler allowlist + catch-up cap (PostgreSQL + Redis)', () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantA = `it-hard-a-${suffix}`; // allowed
  const tenantB = `it-hard-b-${suffix}`; // not allowed
  const queueName = `it-hard-${suffix}`;
  const spy = spyLogger();
  let handle: DbHandle;
  let app: FastifyInstance;
  let scheduler: BullTaskScheduler;
  const others: BullTaskScheduler[] = [];
  const agentOf: Record<string, string> = {};

  const headers = (tenant: string) => ({ 'x-tenant-id': tenant });
  const taskRow = async (id: string) => (await handle.db.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, id) }))!;
  const runsOf = (tenant: string, taskId: string) =>
    handle.db.query.taskRuns.findMany({ where: and(eq(taskRuns.tenantId, tenant), eq(taskRuns.taskDefinitionId, taskId)) });
  const extra = (opts: Partial<ConstructorParameters<typeof BullTaskScheduler>[2]>) => {
    const s = new BullTaskScheduler(handle.db, new MemoryRunQueue(), { queueName: scheduleQueueName(queueName), redisUrl: REDIS_URL, ...opts });
    others.push(s);
    return s;
  };

  async function createTask(tenant: string, payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/tasks', headers: headers(tenant), payload: { agent_id: agentOf[tenant], ...payload } });
    expect(res.statusCode).toBe(201);
    return res.json().task as { id: string };
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    scheduler = new BullTaskScheduler(handle.db, new MemoryRunQueue(), {
      queueName: scheduleQueueName(queueName),
      redisUrl: REDIS_URL,
      logger: spy.logger,
      tenants: onlyTenants([tenantA]),
    });
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), scheduler, config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
    for (const tenant of [tenantA, tenantB]) {
      const res = await app.inject({ method: 'POST', url: '/agents', headers: headers(tenant), payload: { name: 'Hardening agent' } });
      expect(res.statusCode).toBe(201);
      agentOf[tenant] = res.json().agent.id;
    }
  });

  afterAll(async () => {
    for (const s of others) await s.close().catch(() => undefined);
    await scheduler?.close();
    await app?.close();
    const q = new Queue(scheduleQueueName(queueName), { connection: redisConnectionFromUrl(REDIS_URL) });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
    await handle?.close();
  });

  it('with two tenants only the allowed one is registered; the other is ignored with ONE aggregated WARN per pass', async () => {
    const a = await createTask(tenantA, { name: 'hourly A', schedule: { type: 'CRON', expression: '0 * * * *', timezone: 'UTC' } });
    const b = await createTask(tenantB, { name: 'hourly B', schedule: { type: 'CRON', expression: '0 * * * *', timezone: 'UTC' } });

    // API hook (syncTask): A registered, B never.
    expect(await scheduler.queue.getJobScheduler(`task__${a.id}`)).toBeTruthy();
    expect(await scheduler.queue.getJobScheduler(`task__${b.id}`)).toBeFalsy();
    const stateB = (await app.inject({ method: 'GET', url: `/tasks/${b.id}/schedule`, headers: headers(tenantB) })).json();
    expect(stateB).toMatchObject({ tenant_allowed: false, desired: null, registered: null, in_sync: true });
    expect((await app.inject({ method: 'GET', url: `/tasks/${a.id}/schedule`, headers: headers(tenantA) })).json()).toMatchObject({ tenant_allowed: true, in_sync: true });

    // A registration made before the upgrade (multi-tenant scheduler) ...
    expect((await extra({ tenants: allTenants() }).syncTask(await taskRow(b.id))).action).toBe('registered');
    expect(await scheduler.queue.getJobScheduler(`task__${b.id}`)).toBeTruthy();

    // ... is removed by the next syncAll of the restricted scheduler, which logs ONE WARN.
    spy.warns.length = 0;
    const results = await scheduler.syncAll();
    expect(results.find((r) => r.taskId === b.id)).toMatchObject({ action: 'removed' });
    expect(results.find((r) => r.taskId === a.id)).toMatchObject({ action: 'unchanged' });
    expect(await scheduler.queue.getJobScheduler(`task__${b.id}`)).toBeFalsy();
    expect(spy.warns).toHaveLength(1);
    expect(spy.warns[0]).toMatchObject({ scheduler_tenants: tenantA });
    expect(spy.warns[0]!.ignored_tasks).toBeGreaterThanOrEqual(1);

    // Scoped to B (tests' `tenantId`), the WARN names exactly B and its one task.
    const scoped = spyLogger();
    await extra({ tenantId: tenantB, tenants: onlyTenants([tenantA]), logger: scoped.logger }).syncAll();
    expect(scoped.warns).toEqual([expect.objectContaining({ ignored_tasks: 1, tasks_by_tenant: { [tenantB]: 1 } })]);

    // syncTask of B through the restricted scheduler says why nothing is registered.
    expect(await scheduler.syncTask(await taskRow(b.id))).toMatchObject({ ignored: 'tenant_not_allowed', desired: null });
  });

  it('a tick of a tenant outside the allowlist runs nothing; it is summed into the next WARN', async () => {
    const b = await createTask(tenantB, { name: 'tick B', schedule: { type: 'CRON', expression: '0 * * * *', timezone: 'UTC' } });
    const slot = normalizeScheduledAt(new Date(Math.floor(Date.now() / H) * H));
    const out = await scheduler.handleTick({ kind: 'schedule_tick', tenantId: tenantB, taskDefinitionId: b.id }, slot);
    expect(out).toEqual({ outcome: 'skipped_tenant', scheduledAt: slot });
    expect(await runsOf(tenantB, b.id)).toHaveLength(0);

    spy.warns.length = 0;
    await scheduler.syncAll();
    expect(spy.warns).toHaveLength(1);
    expect(spy.warns[0]).toMatchObject({ ignored_ticks: 1, ticks_by_tenant: { [tenantB]: 1 } });
  });

  it('the API does not change: a manual POST /tasks/:id/run of another tenant still works', async () => {
    const b = await createTask(tenantB, { name: 'manual B' });
    const res = await app.inject({ method: 'POST', url: `/tasks/${b.id}/run`, headers: headers(tenantB), payload: { scheduled_at: '2026-10-12T08:00:00Z' } });
    expect(res.statusCode).toBe(202);
    expect(await runsOf(tenantB, b.id)).toHaveLength(1);
  });

  it('catch-up: a 50 h late tick recovers ONE slot (the most recent), CATCHUP_MAX_SLOTS raises it, older slots are skipped', async () => {
    const a = await createTask(tenantA, { name: 'catch-up A', schedule: { type: 'CRON', expression: '0 * * * *', timezone: 'UTC' } });
    const now = new Date();
    const hour = Math.floor(now.getTime() / H) * H;
    const iso = (ms: number) => normalizeScheduledAt(new Date(ms));
    const lateSlot = iso(hour - 50 * H);
    const tick = { kind: 'schedule_tick' as const, tenantId: tenantA, taskDefinitionId: a.id };

    spy.infos.length = 0;
    const one = await scheduler.handleTick(tick, lateSlot, now);
    expect(one).toMatchObject({ outcome: 'created', scheduledAt: iso(hour), catchUp: { kind: 'catch_up', tick_slot: lateSlot } });
    expect(spy.infos.some((i) => i.msg === 'schedule catch-up after a stop')).toBe(true);
    expect((await runsOf(tenantA, a.id)).map((r) => normalizeScheduledAt(r.scheduledAt!))).toEqual([iso(hour)]);

    const three = await extra({ tenants: onlyTenants([tenantA]), catchUp: { maxSlots: 3 } }).handleTick(tick, lateSlot, now);
    expect(three.catchUp?.runs.map((r) => [r.scheduledAt, r.outcome])).toEqual([
      [iso(hour - 2 * H), 'created'],
      [iso(hour - H), 'created'],
      [iso(hour), 'deduplicated'],
    ]);
    expect(await runsOf(tenantA, a.id)).toHaveLength(3);

    // Weekly INTERVAL whose only missed slot is 3 days old: nothing runs (CATCHUP_MAX_AGE_MS = 48 h).
    const weekly = await createTask(tenantA, { name: 'weekly A', schedule: { type: 'INTERVAL', every_seconds: 7 * 24 * 3600 } });
    spy.infos.length = 0;
    const stale = await scheduler.handleTick({ ...tick, taskDefinitionId: weekly.id }, iso(now.getTime() - 72 * H), now);
    expect(stale).toMatchObject({ outcome: 'skipped_stale', catchUp: { kind: 'stale', runs: [] } });
    expect(spy.infos.some((i) => i.msg?.startsWith('missed slot older than CATCHUP_MAX_AGE_MS'))).toBe(true);
    expect(await runsOf(tenantA, weekly.id)).toHaveLength(0);

    // ONCE ticks are never capped (their slot is the planned instant).
    const once = await scheduler.handleTick({ ...tick, taskDefinitionId: a.id, slot: iso(hour - 72 * H) }, iso(hour - 72 * H), now);
    expect(once).toMatchObject({ outcome: 'created', scheduledAt: iso(hour - 72 * H) });
  });
});

describe.skipIf(!dbAvailable)('cleanup:archive-test-tenants (PostgreSQL)', () => {
  const suffix = randomUUID().slice(0, 8);
  const testTenant = `it-clean-${suffix}`;
  const protectedTenant = `it-keep-${suffix}`; // matches the pattern but is in the allowlist
  const realTenant = `acme${suffix}`; // not a test tenant
  const scope = [testTenant, protectedTenant, realTenant];
  let handle: DbHandle;

  async function seed(tenant: string) {
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name: 'Prospector', status: 'ACTIVE' }).returning();
    for (const status of ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const) {
      await handle.db
        .insert(taskDefinitions)
        .values({ tenantId: tenant, name: `task ${status}`, agentId: agent!.id, status, schedule: { type: 'CRON', expression: '0 9 * * *' } });
    }
  }
  const statuses = async (tenant: string) => ({
    agents: (await handle.db.query.agents.findMany({ where: eq(agents.tenantId, tenant) })).map((a) => a.status),
    tasks: (await handle.db.query.taskDefinitions.findMany({ where: eq(taskDefinitions.tenantId, tenant) })).map((t) => t.status).sort(),
  });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    for (const t of scope) await seed(t);
  });

  afterAll(async () => {
    // The non-test tenant is outside every cleanup pattern: archive its fixtures here (no DELETE)
    // so no ACTIVE CRON task survives this suite.
    if (handle) {
      await handle.db
        .update(taskDefinitions)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(and(eq(taskDefinitions.tenantId, realTenant), inArray(taskDefinitions.status, ['ACTIVE', 'PAUSED'])));
      await handle.db.update(agents).set({ status: 'ARCHIVED', updatedAt: new Date() }).where(eq(agents.tenantId, realTenant));
    }
    await handle?.close();
  });

  it('--dry-run reports without writing; the real run archives the test tenant only; a second run is a no-op', async () => {
    const opts = { protectedTenants: [protectedTenant], onlyTenants: scope };
    const dry = await archiveTestTenants(handle.db, { ...opts, dryRun: true });
    expect(dry).toMatchObject({
      dryRun: true,
      matched: 1,
      changes: [{ tenant: testTenant, tasks: { ACTIVE: 1, PAUSED: 1 }, agents: 1 }],
      totals: { tasks: 2, agents: 1 },
      skippedProtected: [protectedTenant],
    });
    expect(dry.protected).toEqual(expect.arrayContaining(['publiexpe', protectedTenant]));
    expect(await statuses(testTenant)).toEqual({ agents: ['ACTIVE'], tasks: ['ACTIVE', 'ARCHIVED', 'PAUSED'] });

    const real = await archiveTestTenants(handle.db, opts);
    expect(real).toMatchObject({ dryRun: false, changes: dry.changes, totals: dry.totals });
    expect(await statuses(testTenant)).toEqual({ agents: ['ARCHIVED'], tasks: ['ARCHIVED', 'ARCHIVED', 'ARCHIVED'] });
    // Protected (allowlist) and non-test tenants are untouched, whatever the agent is called.
    for (const t of [protectedTenant, realTenant]) {
      expect(await statuses(t)).toEqual({ agents: ['ACTIVE'], tasks: ['ACTIVE', 'ARCHIVED', 'PAUSED'] });
    }
    const archived = await handle.db.query.taskDefinitions.findMany({ where: and(eq(taskDefinitions.tenantId, testTenant), eq(taskDefinitions.updatedBy, 'cleanup:archive-test-tenants')) });
    expect(archived).toHaveLength(2);

    const again = await archiveTestTenants(handle.db, opts);
    expect(again).toMatchObject({ matched: 1, changes: [], totals: { tasks: 0, agents: 0 } });
  });

  it('publiexpe is always protected, even if passed in the scope', async () => {
    const r = await archiveTestTenants(handle.db, { onlyTenants: ['publiexpe'], dryRun: true });
    expect(r).toMatchObject({ matched: 0, changes: [] });
    expect(r.protected).toContain('publiexpe');
  });
});
