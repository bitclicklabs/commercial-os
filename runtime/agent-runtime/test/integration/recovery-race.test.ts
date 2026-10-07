/**
 * Orphan reconciler vs. live attempts (PostgreSQL only; no Redis).
 *
 * Regression of the scout runs marked FAILED ("orphaned RUNNING run (job missing)") while
 * they were still running and later finished fine: the reconciler used `task_runs.updated_at`
 * as its liveness signal, but nothing refreshed it during an attempt, so any run longer than
 * RECONCILE_GRACE_MS whose job was not in the reconciler's queue (processed in-process by a
 * test or script on the same database, or lost by BullMQ after a stall) was sentenced. The
 * worker's COMPLETED write then lost against the guarded UPDATE and the run stayed FAILED.
 *
 * Fix under test: the processor heartbeats `updated_at` while an attempt runs, and the
 * reconciler's UPDATE re-checks the staleness (and the attempt) it decided on.
 *
 * Isolation: a fresh tenant (`it-xxxxxxxx`); no DELETE.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, taskRuns, traces } from '../../src/db/schema.js';
import { taskRunIdempotencyKey } from '../../src/domain/idempotency.js';
import { createProviderRegistry, type ModelProvider, type ProviderFactory } from '../../src/providers/index.js';
import { MemoryRunQueue, type EnqueueResult, type QueueJobState, type RunQueue } from '../../src/queue/run-queue.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { OrphanReconciler } from '../../src/worker/recovery.js';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wraps the real providers so every completion takes `ms` (a long attempt). */
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

/**
 * A queue that never owns the job (like the in-process MemoryRunQueue of the live tests seen
 * from the deployed runtime) and runs `onGetJobState` between the reconciler's SELECT and its
 * UPDATE, to inject what a worker does in that window.
 */
class ForeignQueue implements RunQueue {
  onGetJobState: (() => Promise<void>) | null = null;
  readonly requeued: string[] = [];
  async enqueue(): Promise<EnqueueResult> {
    return { jobId: 'x', created: true };
  }
  async requeue(job: { idempotencyKey: string }): Promise<EnqueueResult> {
    this.requeued.push(job.idempotencyKey);
    return { jobId: job.idempotencyKey, created: true };
  }
  async getJobState(): Promise<QueueJobState | null> {
    const hook = this.onGetJobState;
    this.onGetJobState = null;
    if (hook) await hook();
    return null;
  }
  async close(): Promise<void> {}
}

describe.skipIf(!dbAvailable)('orphan reconciler vs. live attempts (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  let agentId: string;
  let slot = 0;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
    const res = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'Recovery race agent' } });
    expect(res.statusCode).toBe(201);
    agentId = res.json().agent.id;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  async function createTask(name: string, maxAttempts = 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { agent_id: agentId, name, max_concurrency: 5, retry_policy: { max_attempts: maxAttempts, backoff_ms: 0 } },
    });
    expect(res.statusCode).toBe(201);
    return (await handle.db.query.taskDefinitions.findFirst({ where: (t, { eq: e }) => e(t.id, res.json().task.id) }))!;
  }

  /** A RUNNING run (and its RUNNING execution) last touched 10 minutes ago. */
  async function insertStaleRunning(taskName: string, attempts = 1, maxAttempts = 1) {
    const task = await createTask(taskName, maxAttempts);
    const old = new Date(Date.now() - 10 * 60_000);
    const scheduledAt = new Date(Date.UTC(2026, 9, 6, 12, 0, slot++));
    const [run] = await handle.db
      .insert(taskRuns)
      .values({
        tenantId: tenant,
        taskDefinitionId: task.id,
        taskDefinitionVersionId: task.currentVersionId,
        idempotencyKey: taskRunIdempotencyKey(task.id, scheduledAt),
        status: 'RUNNING',
        attempts,
        scheduledAt,
        startedAt: old,
        updatedAt: old,
      })
      .returning();
    const [exec] = await handle.db
      .insert(agentExecutions)
      .values({ tenantId: tenant, agentId, taskRunId: run!.id, status: 'RUNNING', startedAt: old })
      .returning();
    await handle.db.update(taskRuns).set({ executionId: exec!.id, updatedAt: old }).where(eq(taskRuns.id, run!.id));
    return { runId: run!.id, executionId: exec!.id };
  }

  const getRun = (id: string) => handle.db.query.taskRuns.findFirst({ where: and(eq(taskRuns.tenantId, tenant), eq(taskRuns.id, id)) });
  const getExec = (id: string) => handle.db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, id) });

  it('a live attempt longer than the grace period is not sentenced by a reconciler that does not own its job', async () => {
    const task = await createTask('long scout');
    const queue = new MemoryRunQueue();
    const local = await buildServer({ db: handle.db, queue, config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
    try {
      const runRes = await local.inject({ method: 'POST', url: `/tasks/${task.id}/run`, headers, payload: { scheduled_at: '2026-10-06T13:00:00Z' } });
      expect(runRes.statusCode).toBe(202);
      const runId = runRes.json().task_run.id as string;

      // The attempt takes ~1.5 s; the reconciler's grace is 400 ms and it never sees the job.
      const processor = new RunProcessor(handle.db, slowProviders(1_500));
      processor.heartbeatMs = 100;
      const jobs = queue.drain();
      expect(jobs).toHaveLength(1);
      const processing = processor.process(jobs[0]!.job);

      const reconciler = new OrphanReconciler(handle.db, new ForeignQueue(), { graceMs: 400, tenantId: tenant });
      await sleep(800); // past the grace period since QUEUED -> RUNNING
      expect((await getRun(runId))?.status).toBe('RUNNING');
      expect(await reconciler.runOnce()).toMatchObject({ requeued: 0, failed: 0 });
      await sleep(400);
      expect(await reconciler.runOnce()).toMatchObject({ requeued: 0, failed: 0 });

      await processing;
      const after = await getRun(runId);
      expect(after).toMatchObject({ status: 'COMPLETED', attempts: 1, error: null });
      expect((await getExec(after!.executionId!))?.status).toBe('COMPLETED');
      // The heartbeat stops with the attempt: nothing keeps touching a finished run.
      const finishedUpdatedAt = after!.updatedAt.getTime();
      await sleep(250);
      expect((await getRun(runId))!.updatedAt.getTime()).toBe(finishedUpdatedAt);
    } finally {
      await local.close();
    }
  });

  it('a heartbeat landing between the reconciler read and its write wins (run stays RUNNING)', async () => {
    const { runId, executionId } = await insertStaleRunning('heartbeat race');
    const queue = new ForeignQueue();
    queue.onGetJobState = async () => {
      await handle.db.update(taskRuns).set({ updatedAt: new Date() }).where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'RUNNING')));
    };
    const reconciler = new OrphanReconciler(handle.db, queue, { graceMs: 60_000, tenantId: tenant });
    expect(await reconciler.runOnce()).toMatchObject({ scanned: 1, requeued: 0, failed: 0 });
    expect((await getRun(runId))?.status).toBe('RUNNING');
    expect((await getExec(executionId))?.status).toBe('RUNNING');
    expect(queue.requeued).toEqual([]);
  });

  it('a run that turns terminal between the reconciler read and its write stays terminal', async () => {
    const { runId, executionId } = await insertStaleRunning('finished race');
    const queue = new ForeignQueue();
    queue.onGetJobState = async () => {
      // What the worker does when the agent ends: close the execution, then the run (guarded).
      await handle.db.update(agentExecutions).set({ status: 'COMPLETED', finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentExecutions.id, executionId));
      await handle.db
        .update(taskRuns)
        .set({ status: 'COMPLETED', output: { outcome: 'SUCCESS' }, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'RUNNING')));
    };
    const reconciler = new OrphanReconciler(handle.db, queue, { graceMs: 60_000, tenantId: tenant });
    expect(await reconciler.runOnce()).toMatchObject({ scanned: 1, requeued: 0, failed: 0 });
    expect(await getRun(runId)).toMatchObject({ status: 'COMPLETED', error: null, output: { outcome: 'SUCCESS' } });
    expect((await getExec(executionId))?.status).toBe('COMPLETED');
  });

  it('a new attempt started between the reconciler read and its write is not touched (no ABA)', async () => {
    // Attempt 1 of 2 looks dead; before the write a retry has already put attempt 2 RUNNING.
    const { runId, executionId } = await insertStaleRunning('retry race', 1, 2);
    const queue = new ForeignQueue();
    let secondExec = '';
    queue.onGetJobState = async () => {
      const [exec] = await handle.db
        .insert(agentExecutions)
        .values({ tenantId: tenant, agentId, taskRunId: runId, status: 'RUNNING', startedAt: new Date() })
        .returning();
      secondExec = exec!.id;
      await handle.db
        .update(taskRuns)
        .set({ attempts: sql`${taskRuns.attempts} + 1`, executionId: secondExec, updatedAt: new Date() })
        .where(eq(taskRuns.id, runId));
    };
    const reconciler = new OrphanReconciler(handle.db, queue, { graceMs: 60_000, tenantId: tenant });
    expect(await reconciler.runOnce()).toMatchObject({ scanned: 1, requeued: 0, failed: 0 });
    expect(await getRun(runId)).toMatchObject({ status: 'RUNNING', attempts: 2, executionId: secondExec });
    expect((await getExec(secondExec))?.status).toBe('RUNNING');
    expect((await getExec(executionId))?.status).toBe('RUNNING');
    expect(queue.requeued).toEqual([]);
  });

  it('a genuinely dead attempt is still recovered (stale, same attempt)', async () => {
    const { runId, executionId } = await insertStaleRunning('genuinely dead');
    const reconciler = new OrphanReconciler(handle.db, new ForeignQueue(), { graceMs: 60_000, tenantId: tenant });
    expect(await reconciler.runOnce()).toMatchObject({ scanned: 1, failed: 1 });
    expect(await getRun(runId)).toMatchObject({ status: 'FAILED', error: { name: 'OrphanedRun' } });
    expect((await getExec(executionId))?.status).toBe('FAILED');
    // No trace was written for the dead attempt (sanity: the table is reachable).
    expect(await handle.db.query.traces.findFirst({ where: eq(traces.executionId, executionId) })).toBeUndefined();
  });
});
