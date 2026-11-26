/**
 * Orphan recovery vs live long runs, against a real PostgreSQL (skipped when unreachable
 * or SKIP_DB_TESTS=1). Reproduces the 2026-10-07 incident: a scout run processed by one
 * process (here: an in-process RunProcessor over a MemoryRunQueue, like the live tests)
 * while a reconciler in ANOTHER process scans the same database but a queue that has no
 * job for the run ("job missing"). Before the heartbeat, every run longer than
 * RECONCILE_GRACE_MS was failed as orphaned at ~created_at + grace + tick, its worker
 * kept going, and the real outcome (cost included) was silently discarded by the guarded
 * `WHERE status = 'RUNNING'` updates.
 *
 * Isolation: fresh tenant per run, reconciler restricted to that tenant. No DELETEs.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, taskRuns, traces } from '../../src/db/schema.js';
import type { ModelProvider } from '../../src/providers/model-provider.js';
import { StubProvider } from '../../src/providers/stub-provider.js';
import { MemoryRunQueue, type RunJob } from '../../src/queue/run-queue.js';
import { RunProcessor, type ProcessorLogger } from '../../src/worker/processor.js';
import { OrphanReconciler, ORPHANED_RUN_ERROR_NAME, recoverOrphanRun } from '../../src/worker/recovery.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

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

const dbAvailable = process.env.SKIP_DB_TESTS === '1' ? false : await databaseReachable(DATABASE_URL);
if (!dbAvailable) console.warn('[integration] PostgreSQL not reachable; skipping recovery tests');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/** The incident's cost: Prospector Scout exhibitor steps, USD. */
const MODEL_COST = 0.1426;

/**
 * Stub provider whose completions block until `release()` — a controllable "long scout
 * run". Each completion reports MODEL_COST so the cost accounting is observable.
 */
function gatedProviders() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inner = new StubProvider({ costPerCall: MODEL_COST, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 } });
  const provider: ModelProvider = {
    name: 'stub',
    estimateCost: (model, usage) => inner.estimateCost(model, usage),
    complete: async (request) => {
      await gate;
      return inner.complete(request);
    },
    stream: (request) => inner.stream(request),
  };
  return { factory: () => provider, release };
}

/** Grace/heartbeat scaled down from prod (120s / 30s) to keep the test fast. */
const GRACE_MS = 400;
const HEARTBEAT_MS = 50;

describe.skipIf(!dbAvailable)('orphan recovery vs live long runs (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  const warnings: Array<{ obj: object; msg?: string }> = [];
  const logger: ProcessorLogger = {
    info() {},
    warn: (obj, msg) => void warnings.push({ obj, msg }),
    error() {},
  };

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  function makeProcessor() {
    const { factory, release } = gatedProviders();
    const processor = new RunProcessor(handle.db, factory, logger, undefined, null, {
      heartbeatIntervalMs: HEARTBEAT_MS,
      orphanGraceMs: GRACE_MS,
    });
    return { processor, release };
  }

  /** Agent + task (stub implementation) + one queued run; returns ids and the drained job. */
  async function queuedRun(name: string, maxAttempts = 1): Promise<{ taskId: string; runId: string; job: RunJob }> {
    const agentRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers,
      payload: { name, version: { system_prompt: 'recovery it', configuration: {} } },
    });
    expect(agentRes.statusCode).toBe(201);
    const task = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { agent_id: agentRes.json().agent.id, name, retry_policy: { max_attempts: maxAttempts, backoff_ms: 0 } },
    });
    expect(task.statusCode).toBe(201);
    const taskId = task.json().task.id as string;
    const res = await app.inject({ method: 'POST', url: `/tasks/${taskId}/run`, headers, payload: { scheduled_at: '2026-10-07T08:00:00Z' } });
    expect(res.statusCode).toBe(202);
    const jobs = queue.drain();
    expect(jobs).toHaveLength(1);
    const runs = await app.inject({ method: 'GET', url: `/tasks/${taskId}/runs?limit=1`, headers });
    const runId = (runs.json().items as Array<{ id: string }>)[0]!.id;
    return { taskId, runId, job: jobs[0]!.job };
  }

  const getRun = (runId: string) => handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, runId) });
  const getExecution = (id: string) => handle.db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, id) });
  const waitRunning = (runId: string) =>
    waitFor(async () => {
      const r = await getRun(runId);
      return r?.status === 'RUNNING' && r.executionId ? r : undefined;
    }, 5_000, 'run RUNNING with execution');

  it('the heartbeat keeps a long RUNNING run out of a foreign reconciler ("job missing")', async () => {
    const { processor, release } = makeProcessor();
    const { runId, job } = await queuedRun('heartbeat long run');
    const processing = processor.process(job);
    const running = await waitRunning(runId);

    // Run "long" past the grace window; the heartbeat must keep updated_at fresh.
    await sleep(GRACE_MS + 300);
    const beating = await getRun(runId);
    expect(beating?.status).toBe('RUNNING');
    expect(Date.now() - beating!.updatedAt.getTime()).toBeLessThan(GRACE_MS);
    expect(beating!.updatedAt.getTime()).toBeGreaterThan(running.updatedAt.getTime() - 1);

    // The incident's reconciler: same database, a queue with no job for this run.
    const reconciler = new OrphanReconciler(handle.db, new MemoryRunQueue(), { graceMs: GRACE_MS, tenantId: tenant });
    const summary = await reconciler.runOnce();
    expect(summary).toEqual({ scanned: 0, enqueued: 0, requeued: 0, failed: 0 });
    expect((await getRun(runId))?.status).toBe('RUNNING');

    release();
    await processing;
    const done = await getRun(runId);
    expect(done?.status).toBe('COMPLETED');
    expect(Number(done?.cost)).toBeCloseTo(MODEL_COST, 6);
  });

  it('a finished worker reclaims a run falsely FAILED as orphaned: real status and cost are recorded', async () => {
    const { processor, release } = makeProcessor();
    const { runId, job } = await queuedRun('late result reclaim');
    const processing = processor.process(job);
    const running = await waitRunning(runId);

    // A reconciler in another process wins the race (as on 2026-10-07): max_attempts
    // exhausted -> run and execution FAILED with OrphanedRun, cost 0.
    const outcome = await recoverOrphanRun(handle.db, running, 1, 'orphaned RUNNING run (job missing)');
    expect(outcome).toBe('failed');
    const orphaned = await getRun(runId);
    expect(orphaned?.status).toBe('FAILED');
    expect(orphaned?.error?.name).toBe(ORPHANED_RUN_ERROR_NAME);
    expect((await getExecution(running.executionId!))?.status).toBe('FAILED');

    // The worker was alive all along and now finishes: the false FAILED is replaced by
    // the real outcome, and /metrics sees the cost (it sums agent_executions.total_cost).
    release();
    await processing;
    const execution = await getExecution(running.executionId!);
    expect(execution?.status).toBe('COMPLETED');
    expect(Number(execution?.totalCost)).toBeCloseTo(MODEL_COST, 6);
    expect(execution?.error).toBeNull();
    const run = await getRun(runId);
    expect(run?.status).toBe('COMPLETED');
    expect(run?.error).toBeNull();
    expect(Number(run?.cost)).toBeCloseTo(MODEL_COST, 6);
    const [trace] = await handle.db.select().from(traces).where(eq(traces.executionId, running.executionId!));
    expect(Number(trace?.totalCost)).toBeCloseTo(MODEL_COST, 6);
  });

  it('a late finisher reclaims only its execution when the orphaned run was requeued', async () => {
    const { processor, release } = makeProcessor();
    const { runId, job } = await queuedRun('requeued orphan', 2);
    const processing = processor.process(job);
    const running = await waitRunning(runId);

    // Attempts remain -> the reconciler requeues (RUNNING -> QUEUED); the queue now owns
    // the run again and may hand it to a new attempt at any moment.
    expect(await recoverOrphanRun(handle.db, running, 2, 'orphaned RUNNING run (job missing)')).toBe('requeued');
    expect((await getRun(runId))?.status).toBe('QUEUED');

    release();
    await processing;
    // The dead-declared attempt records its own result (cost!) on its execution row...
    const execution = await getExecution(running.executionId!);
    expect(execution?.status).toBe('COMPLETED');
    expect(Number(execution?.totalCost)).toBeCloseTo(MODEL_COST, 6);
    // ...but leaves the run to the queue: still QUEUED, no smuggled-in completion.
    const run = await getRun(runId);
    expect(run?.status).toBe('QUEUED');
    expect(run?.output).toBeNull();
  });

  it('a stalled job re-delivered while the attempt still beats is dropped, not recovered', async () => {
    const { processor, release } = makeProcessor();
    const { runId, job } = await queuedRun('stalled re-delivery');
    const processing = processor.process(job);
    await waitRunning(runId);

    // BullMQ re-delivers after a lock lapse although the worker never died.
    warnings.length = 0;
    await processor.process(job);
    expect(warnings.some((w) => w.msg === 'stalled job re-delivered but attempt is alive; dropping job')).toBe(true);
    const run = await getRun(runId);
    expect(run?.status).toBe('RUNNING');
    expect(run?.attempts).toBe(1);

    release();
    await processing;
    const done = await getRun(runId);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.attempts).toBe(1);
    expect(await handle.db.$count(agentExecutions, eq(agentExecutions.taskRunId, runId))).toBe(1);
  });

  it('a genuinely dead run (stale heartbeat, no job) is still failed by the reconciler', async () => {
    const { runId } = await queuedRun('genuine orphan');
    // Simulate a worker that died mid-run: RUNNING, last heartbeat long ago.
    await handle.db
      .update(taskRuns)
      .set({ status: 'RUNNING', attempts: 1, updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(taskRuns.id, runId));

    const reconciler = new OrphanReconciler(handle.db, new MemoryRunQueue(), { graceMs: GRACE_MS, tenantId: tenant });
    const summary = await reconciler.runOnce();
    expect(summary.failed).toBe(1);
    const run = await getRun(runId);
    expect(run?.status).toBe('FAILED');
    expect(run?.error?.name).toBe(ORPHANED_RUN_ERROR_NAME);
  });
});
