/**
 * Scheduler, max_concurrency and orphan recovery against real PostgreSQL + Redis (BullMQ).
 * Skipped when either is unreachable (or SKIP_DB_TESTS=1 / SKIP_REDIS_TESTS=1).
 *
 * Isolation: a fresh tenant (`it-xxxxxxxx`) and fresh BullMQ queue names per run, so it
 * never touches other tenants' rows or other queues. The test queues are obliterated at the end.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, taskRuns } from '../../src/db/schema.js';
import { taskRunIdempotencyKey } from '../../src/domain/idempotency.js';
import { createProviderRegistry, type ModelProvider, type ProviderFactory } from '../../src/providers/index.js';
import { BullRunQueue, redisConnectionFromUrl } from '../../src/queue/run-queue.js';
import { BullTaskScheduler, scheduleQueueName } from '../../src/scheduler/task-scheduler.js';
import { startBullWorker } from '../../src/worker/bull-worker.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { OrphanReconciler } from '../../src/worker/recovery.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6391';

async function databaseReachable(url: string): Promise<boolean> {
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

const available =
  process.env.SKIP_DB_TESTS !== '1' &&
  process.env.SKIP_REDIS_TESTS !== '1' &&
  (await databaseReachable(DATABASE_URL)) &&
  (await redisReachable(REDIS_URL));
if (!available) console.warn('[integration] PostgreSQL or Redis not reachable; skipping scheduler tests');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

/** Wraps the real providers so every completion takes `ms` (makes executions overlap). */
function slowProviders(ms: number): ProviderFactory {
  const base = createProviderRegistry();
  return (name) => {
    const p = base(name);
    const wrapped = Object.create(p) as ModelProvider;
    wrapped.complete = async (req) => {
      await sleep(ms);
      return p.complete(req);
    };
    return wrapped;
  };
}

describe.skipIf(!available)('scheduler + concurrency + recovery (PostgreSQL + Redis)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const queueName = `it-runs-${randomUUID().slice(0, 8)}`;
  let handle: DbHandle;
  let app: FastifyInstance;
  let runQueue: BullRunQueue;
  let scheduler: BullTaskScheduler;
  let worker: ReturnType<typeof startBullWorker>;
  let agentId: string;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    runQueue = new BullRunQueue(queueName, REDIS_URL);
    scheduler = new BullTaskScheduler(handle.db, runQueue, {
      queueName: scheduleQueueName(queueName),
      redisUrl: REDIS_URL,
      tenantId: tenant, // syncAll must not register other tenants' tasks in this test queue
    });
    app = await buildServer({
      db: handle.db,
      queue: runQueue,
      scheduler,
      config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' },
    });
    const processor = new RunProcessor(handle.db, slowProviders(400));
    worker = startBullWorker(processor, {
      queueName,
      redisUrl: REDIS_URL,
      concurrency: 4,
      concurrencyDeferMs: 150,
      logger: { info() {}, warn() {}, error() {} },
    });
    scheduler.start({ syncIntervalMs: 60_000 });

    const res = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'Scheduled agent' } });
    expect(res.statusCode).toBe(201);
    agentId = res.json().agent.id;
  });

  afterAll(async () => {
    await worker?.close();
    await scheduler?.close();
    await runQueue?.close();
    await app?.close();
    // Remove only this run's throwaway queues.
    for (const name of [queueName, scheduleQueueName(queueName)]) {
      const q = new Queue(name, { connection: redisConnectionFromUrl(REDIS_URL) });
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
    await handle?.close();
  });

  async function createTask(payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/tasks', headers, payload: { agent_id: agentId, ...payload } });
    expect(res.statusCode).toBe(201);
    return res.json().task as { id: string };
  }

  async function runsOf(taskId: string) {
    const res = await app.inject({ method: 'GET', url: `/tasks/${taskId}/runs?limit=100`, headers });
    return res.json().items as Array<Record<string, any>>;
  }

  it('rejects invalid schedules with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { name: 'bad cron', agent_id: agentId, schedule: { type: 'CRON', expression: 'every monday' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_schedule');
  });

  it('a 1s CRON fires through the /run path, completes, and follows pause/resume/archive', async () => {
    const task = await createTask({ name: 'cron every second', schedule: { type: 'CRON', expression: '* * * * * *', timezone: 'UTC' } });

    const sched = await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers });
    expect(sched.statusCode).toBe(200);
    expect(sched.json()).toMatchObject({ in_sync: true, registered: { kind: 'job_scheduler', pattern: '* * * * * *', tz: 'UTC' } });
    expect(sched.json().next_runs).toHaveLength(5);

    const status = await app.inject({ method: 'GET', url: '/scheduler/status', headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().items.map((i: { task_id: string }) => i.task_id)).toContain(task.id);

    const completed = await waitFor(
      async () => {
        const done = (await runsOf(task.id)).filter((r) => r.status === 'COMPLETED');
        return done.length >= 2 ? done : undefined;
      },
      15_000,
      'two completed scheduled runs',
    );
    for (const run of completed) {
      // scheduled_at is the slot (whole second), and the key is the same one /run would compute.
      expect(new Date(run.scheduled_at).getMilliseconds()).toBe(0);
      expect(run.idempotency_key).toBe(taskRunIdempotencyKey(task.id, run.scheduled_at));
    }
    expect(new Set(completed.map((r) => r.idempotency_key)).size).toBe(completed.length);

    // A duplicated tick for an existing slot never creates a second TaskRun.
    const slot = new Date(completed[0]!.scheduled_at).toISOString();
    const dup = await scheduler.handleTick({ kind: 'schedule_tick', tenantId: tenant, taskDefinitionId: task.id }, slot);
    expect(dup).toMatchObject({ outcome: 'deduplicated', taskRunId: completed[0]!.id });

    // Pause: the scheduler is removed and no new slots are created.
    expect((await app.inject({ method: 'POST', url: `/tasks/${task.id}/pause`, headers })).statusCode).toBe(200);
    const paused = (await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json();
    expect(paused).toMatchObject({ registered: null, in_sync: true, desired: null });
    await sleep(1_200); // let an in-flight tick land
    const countAfterPause = (await runsOf(task.id)).length;
    await sleep(2_500);
    expect((await runsOf(task.id)).length).toBe(countAfterPause);

    // Resume re-registers; archive removes for good.
    expect((await app.inject({ method: 'POST', url: `/tasks/${task.id}/resume`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json().registered).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: `/tasks/${task.id}/archive`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json().registered).toBeNull();
  });

  it('PATCH of the schedule updates the registration idempotently; syncAll is a no-op when in sync', async () => {
    const task = await createTask({ name: 'interval task', schedule: { type: 'INTERVAL', every_seconds: 3600 } });
    let state = (await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json();
    expect(state.registered).toMatchObject({ every_ms: 3_600_000 });

    const patch = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers,
      payload: { schedule: { type: 'CRON', expression: '0 8 * * *' }, change_reason: 'daily at 08:00' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.current_version).toBe(2);
    state = (await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json();
    expect(state).toMatchObject({ in_sync: true, registered: { pattern: '0 8 * * *', tz: 'Europe/Madrid' } });

    const again = await scheduler.syncTask((await handle.db.query.taskDefinitions.findFirst({ where: (t, { eq: e }) => e(t.id, task.id) }))!);
    expect(again.action).toBe('unchanged');

    // A registration lost behind the API's back (e.g. Redis flushed) is healed by syncAll.
    await scheduler.queue.removeJobScheduler(`task__${task.id}`);
    expect((await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json().in_sync).toBe(false);
    const healed = await scheduler.syncAll();
    expect(healed.find((r) => r.taskId === task.id)?.action).toBe('registered');
    expect((await scheduler.syncAll()).find((r) => r.taskId === task.id)?.action).toBe('unchanged');

    // ONCE in the future -> one delayed job; switching to MANUAL removes it.
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    await app.inject({ method: 'PATCH', url: `/tasks/${task.id}`, headers, payload: { schedule: { type: 'ONCE', run_at: runAt } } });
    state = (await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json();
    expect(state).toMatchObject({ in_sync: true, registered: { kind: 'once' } });
    await app.inject({ method: 'PATCH', url: `/tasks/${task.id}`, headers, payload: { schedule: { type: 'MANUAL' } } });
    state = (await app.inject({ method: 'GET', url: `/tasks/${task.id}/schedule`, headers })).json();
    expect(state).toMatchObject({ in_sync: true, registered: null });
  });

  it('max_concurrency=1 serialises runs of the same task (extra runs wait QUEUED)', async () => {
    const task = await createTask({ name: 'serial task', max_concurrency: 1 });
    const slots = ['2026-10-06T08:00:00Z', '2026-10-06T08:00:01Z', '2026-10-06T08:00:02Z'];
    for (const scheduled_at of slots) {
      const res = await app.inject({ method: 'POST', url: `/tasks/${task.id}/run`, headers, payload: { scheduled_at } });
      expect(res.statusCode).toBe(202);
    }
    // While the first one runs, the others are still QUEUED.
    await waitFor(async () => (await runsOf(task.id)).some((r) => r.status === 'RUNNING'), 5_000, 'a running run');
    const snapshot = await runsOf(task.id);
    expect(snapshot.filter((r) => r.status === 'RUNNING')).toHaveLength(1);

    const runs = await waitFor(
      async () => {
        const all = await runsOf(task.id);
        return all.length === 3 && all.every((r) => r.status === 'COMPLETED') ? all : undefined;
      },
      15_000,
      'three completed runs',
    );
    const intervals = runs
      .map((r) => [new Date(r.started_at).getTime(), new Date(r.finished_at).getTime()] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]![0]).toBeGreaterThanOrEqual(intervals[i - 1]![1]);
    }
    expect(runs.every((r) => r.attempts === 1)).toBe(true);
  });

  it('max_concurrency=3 lets runs of the same task overlap', async () => {
    const task = await createTask({ name: 'parallel task', max_concurrency: 3 });
    for (const scheduled_at of ['2026-10-06T09:00:00Z', '2026-10-06T09:00:01Z', '2026-10-06T09:00:02Z']) {
      await app.inject({ method: 'POST', url: `/tasks/${task.id}/run`, headers, payload: { scheduled_at } });
    }
    const runs = await waitFor(
      async () => {
        const all = await runsOf(task.id);
        return all.length === 3 && all.every((r) => r.status === 'COMPLETED') ? all : undefined;
      },
      15_000,
      'three completed runs',
    );
    const starts = runs.map((r) => new Date(r.started_at).getTime());
    const ends = runs.map((r) => new Date(r.finished_at).getTime());
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  });

  it('recovers orphaned runs: requeue (attempts left), fail (exhausted), enqueue (QUEUED without job)', async () => {
    const task = await createTask({ name: 'orphans', max_concurrency: 5, retry_policy: { max_attempts: 2, backoff_ms: 0 } });
    const taskRow = (await handle.db.query.taskDefinitions.findFirst({ where: (t, { eq: e }) => e(t.id, task.id) }))!;
    const old = new Date(Date.now() - 10 * 60_000);

    async function insertRun(slot: string, status: 'QUEUED' | 'RUNNING', attempts: number) {
      const [run] = await handle.db
        .insert(taskRuns)
        .values({
          tenantId: tenant,
          taskDefinitionId: task.id,
          taskDefinitionVersionId: taskRow.currentVersionId,
          idempotencyKey: taskRunIdempotencyKey(task.id, slot),
          status,
          attempts,
          scheduledAt: new Date(slot),
          startedAt: status === 'RUNNING' ? old : null,
          updatedAt: old,
        })
        .returning();
      let executionId: string | null = null;
      if (status === 'RUNNING') {
        const [exec] = await handle.db
          .insert(agentExecutions)
          .values({ tenantId: tenant, agentId, taskRunId: run!.id, status: 'RUNNING', startedAt: old })
          .returning();
        executionId = exec!.id;
        await handle.db.update(taskRuns).set({ executionId, updatedAt: old }).where(eq(taskRuns.id, run!.id));
      }
      return { runId: run!.id, executionId };
    }

    const requeue = await insertRun('2026-10-06T10:00:00Z', 'RUNNING', 1); // dead worker, 1 of 2 attempts used
    const exhausted = await insertRun('2026-10-06T10:00:01Z', 'RUNNING', 2); // 2 of 2 used
    const lost = await insertRun('2026-10-06T10:00:02Z', 'QUEUED', 0); // enqueue lost (Redis down)

    const reconciler = new OrphanReconciler(handle.db, runQueue, { graceMs: 60_000, tenantId: tenant });
    const summary = await reconciler.runOnce();
    expect(summary).toMatchObject({ requeued: 1, failed: 1, enqueued: 1 });

    const get = (id: string) => handle.db.query.taskRuns.findFirst({ where: and(eq(taskRuns.tenantId, tenant), eq(taskRuns.id, id)) });
    const final = await waitFor(
      async () => {
        const [a, c] = await Promise.all([get(requeue.runId), get(lost.runId)]);
        return a?.status === 'COMPLETED' && c?.status === 'COMPLETED' ? { a, c } : undefined;
      },
      15_000,
      'recovered runs to complete',
    );
    expect(final.a.attempts).toBe(2);
    expect(final.c.attempts).toBe(1);
    expect((await get(exhausted.runId))?.status).toBe('FAILED');

    const deadExec = await handle.db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, requeue.executionId!) });
    expect(deadExec?.status).toBe('FAILED');
    expect(deadExec?.error).toMatchObject({ name: 'OrphanedRun' });

    // A second pass finds nothing to do (idempotent).
    expect(await reconciler.runOnce()).toMatchObject({ requeued: 0, failed: 0, enqueued: 0 });
  });

  it('a stalled job re-delivered to the processor recovers its RUNNING run and completes it', async () => {
    const task = await createTask({ name: 'stalled', retry_policy: { max_attempts: 2, backoff_ms: 0 } });
    const taskRow = (await handle.db.query.taskDefinitions.findFirst({ where: (t, { eq: e }) => e(t.id, task.id) }))!;
    const key = taskRunIdempotencyKey(task.id, '2026-10-06T11:00:00Z');
    const [run] = await handle.db
      .insert(taskRuns)
      .values({
        tenantId: tenant,
        taskDefinitionId: task.id,
        taskDefinitionVersionId: taskRow.currentVersionId,
        idempotencyKey: key,
        status: 'RUNNING',
        attempts: 1,
        scheduledAt: new Date('2026-10-06T11:00:00Z'),
      })
      .returning();
    const processor = new RunProcessor(handle.db, createProviderRegistry());
    await processor.process({ kind: 'task_run', tenantId: tenant, taskRunId: run!.id, idempotencyKey: key }, { attempt: 1, maxAttempts: 2 });
    const after = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, run!.id) });
    expect(after).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });
});
