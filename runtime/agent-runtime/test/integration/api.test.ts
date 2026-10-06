/**
 * API + worker integration against a real PostgreSQL.
 * Skipped cleanly when the database is not reachable (DATABASE_URL or the 127.0.0.1:5440 default).
 * Uses an in-memory queue and runs the RunProcessor inline, so Redis is not required.
 * Each run uses a fresh tenant id, so no cleanup (and no DELETE) is needed.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { RunProcessor } from '../../src/worker/processor.js';

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
if (!dbAvailable) console.warn(`[integration] PostgreSQL not reachable at ${DATABASE_URL}; skipping`);

describe.skipIf(!dbAvailable)('runtime API (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  let processor: RunProcessor;

  async function drainAndProcess() {
    for (const { job, options } of queue.drain()) {
      await processor.process(job, { attempt: 1, maxAttempts: options.attempts ?? 1 });
    }
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    processor = new RunProcessor(handle.db, createProviderRegistry());
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('health reports db ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('agent -> task -> run -> worker -> TaskRun + Trace, idempotently', async () => {
    const agentRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers,
      payload: { name: 'Prospector', role: 'prospecting', version: { system_prompt: 'stub' } },
    });
    expect(agentRes.statusCode).toBe(201);
    const { agent, version } = agentRes.json();
    expect(agent.status).toBe('ACTIVE');
    expect(agent.active_version_id).toBe(version.id);
    expect(agent.tenant_id).toBe(tenant);

    const dup = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'Prospector' } });
    expect(dup.statusCode).toBe(409);

    const taskRes = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { name: 'Daily prospecting', agent_id: agent.id, default_input: { query: 'ferias' }, schedule: { type: 'CRON', expression: '0 8 * * *' } },
    });
    expect(taskRes.statusCode).toBe(201);
    const { task } = taskRes.json();
    expect(task.current_version).toBe(1);

    const scheduled_at = '2026-10-06T08:00:00Z';
    const run1 = await app.inject({ method: 'POST', url: `/tasks/${task.id}/run`, headers, payload: { scheduled_at } });
    expect(run1.statusCode).toBe(202);
    const r1 = run1.json();
    expect(r1.task_run.idempotency_key).toBe(`taskrun:${task.id}:${scheduled_at}`);
    expect(r1.deduplicated).toBe(false);

    // Same slot, different representation: must not create a second TaskRun nor a second job.
    const run2 = await app.inject({
      method: 'POST',
      url: `/tasks/${task.id}/run`,
      headers,
      payload: { scheduled_at: '2026-10-06T10:00:00.000+02:00' },
    });
    expect(run2.statusCode).toBe(200);
    expect(run2.json().deduplicated).toBe(true);
    expect(run2.json().task_run.id).toBe(r1.task_run.id);
    expect(queue.jobs.size).toBe(1);

    await drainAndProcess();

    const detail = await app.inject({ method: 'GET', url: `/task-runs/${r1.task_run.id}`, headers });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.task_run.status).toBe('COMPLETED');
    expect(d.task_run.agent_version_id).toBe(version.id);
    expect(d.task_run.attempts).toBe(1);
    expect(d.task_run.cost).toBe(0);
    expect(d.task_run.output).toMatchObject({ status: 'ok', echo: { query: 'ferias' } });
    expect(d.execution.status).toBe('COMPLETED');
    expect(d.trace.steps.map((s: { type: string }) => s.type)).toEqual(['THINK', 'TOOL', 'FINAL']);
    expect(d.trace.total_cost).toBe(0);
    expect(d.trace.input_tokens + d.trace.output_tokens).toBe(0);

    // Re-delivery of the same job after completion is a no-op.
    await processor.process({ kind: 'task_run', tenantId: tenant, taskRunId: r1.task_run.id, idempotencyKey: r1.task_run.idempotency_key });
    const runs = await app.inject({ method: 'GET', url: `/tasks/${task.id}/runs`, headers });
    expect(runs.json().items).toHaveLength(1);
    const execs = await app.inject({ method: 'GET', url: `/executions?task_run_id=${r1.task_run.id}`, headers });
    expect(execs.json().items).toHaveLength(1);

    const exec = await app.inject({ method: 'GET', url: `/executions/${d.execution.id}`, headers });
    expect(exec.json().trace.steps).toHaveLength(3);

    // Cancelling a completed execution is rejected (immutability).
    const cancel = await app.inject({ method: 'POST', url: `/executions/${d.execution.id}/cancel`, headers });
    expect(cancel.statusCode).toBe(409);

    // Tenant isolation.
    const other = await app.inject({ method: 'GET', url: `/task-runs/${r1.task_run.id}`, headers: { 'x-tenant-id': `${tenant}-other` } });
    expect(other.statusCode).toBe(404);
  });

  it('versions tasks on PATCH and archives instead of deleting', async () => {
    const { agent } = (
      await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'Researcher' } })
    ).json();
    const { task } = (
      await app.inject({ method: 'POST', url: '/tasks', headers, payload: { name: 'Research', agent_id: agent.id } })
    ).json();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers,
      payload: { priority: 5, change_reason: 'bump priority' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().task.current_version).toBe(2);
    const full = (await app.inject({ method: 'GET', url: `/tasks/${task.id}`, headers })).json();
    expect(full.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    expect((await app.inject({ method: 'POST', url: `/tasks/${task.id}/pause`, headers })).json().task.status).toBe('PAUSED');
    expect((await app.inject({ method: 'POST', url: `/tasks/${task.id}/run`, headers })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/tasks/${task.id}/archive`, headers })).json().task.status).toBe('ARCHIVED');
    expect((await app.inject({ method: 'PATCH', url: `/tasks/${task.id}`, headers, payload: { priority: 1 } })).statusCode).toBe(409);
  });

  it('runs and cancels direct executions; paused agents cannot run', async () => {
    const { agent } = (await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'Qualifier' } })).json();

    const queued = await app.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agent.id, idempotency_key: 'k1' } });
    expect(queued.statusCode).toBe(202);
    const again = await app.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agent.id, idempotency_key: 'k1' } });
    expect(again.statusCode).toBe(200);
    expect(again.json().execution.id).toBe(queued.json().execution.id);
    await drainAndProcess();
    const done = (await app.inject({ method: 'GET', url: `/executions/${queued.json().execution.id}`, headers })).json();
    expect(done.execution.status).toBe('COMPLETED');
    expect(done.trace.steps).toHaveLength(3);

    const toCancel = (await app.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agent.id } })).json();
    const cancelled = await app.inject({ method: 'POST', url: `/executions/${toCancel.execution.id}/cancel`, headers });
    expect(cancelled.json().execution.status).toBe('CANCELLED');
    await drainAndProcess(); // worker must skip the cancelled execution
    const after = (await app.inject({ method: 'GET', url: `/executions/${toCancel.execution.id}`, headers })).json();
    expect(after.execution.status).toBe('CANCELLED');
    expect(after.trace).toBeNull();

    expect((await app.inject({ method: 'POST', url: `/agents/${agent.id}/pause`, headers })).json().agent.status).toBe('PAUSED');
    expect((await app.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agent.id } })).statusCode).toBe(409);
    const patched = await app.inject({ method: 'PATCH', url: `/agents/${agent.id}`, headers, payload: { status: 'ACTIVE', owner: 'jesus' } });
    expect(patched.json().agent).toMatchObject({ status: 'ACTIVE', owner: 'jesus' });
  });
});
