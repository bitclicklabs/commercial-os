/**
 * Versioned harness end to end against a real PostgreSQL (no Redis, no network): seed of
 * `default-commercial` v1 ACTIVE, the harnesses API (v2 with another timeout, activate,
 * deprecate = rollback), and task runs (RunProcessor + slow stub provider) that apply the
 * resolved version, honour its precedence over the task and the env, and record it in the
 * task run and the trace. Fresh tenants per run, no DELETE.
 *
 * Uses its OWN database (never the shared `agentos`):
 *   docker exec pxos-postgres psql -U agentos -d postgres -c "create database agentos_wt9_harness"   # once
 *   HARNESS_DATABASE_URL=postgres://.../otra_bd pnpm vitest run test/integration/harness.test.ts      # optional override
 * Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { harnesses, harnessVersions, taskRuns, traces, type HarnessUsed } from '../../src/db/schema.js';
import { DEFAULT_COMMERCIAL_CONFIG, DEFAULT_COMMERCIAL_HARNESS_NAME, harnessConfigHash } from '../../src/harness/config.js';
import { StubProvider, type CompletionRequest, type CompletionResult } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedHarnesses } from '../../src/seed/harness-seed.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { TwentyGate } from '../../src/worker/twenty-gate.js';

const DATABASE_URL = process.env.HARNESS_DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt9_harness';

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
if (!dbAvailable) console.warn(`[integration] PostgreSQL not reachable at ${DATABASE_URL}; skipping harness tests`);

/** StubProvider that takes `delayMs` to answer (to exercise the run timeout). */
class SlowProvider extends StubProvider {
  delayMs = 0;
  override async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return super.complete(request);
  }
}

describe.skipIf(!dbAvailable)('versioned harness (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const warns: Array<{ obj: object; msg?: string | undefined }> = [];
  const provider = new SlowProvider({ responseText: 'ok' });
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  let processor: RunProcessor;
  let runSeq = 0;

  /** Agent (stub implementation) + MANUAL task with timeout 300 s and no retries. */
  async function agentWithTask(name: string, harnessRef: unknown) {
    const agent = await app.inject({
      method: 'POST',
      url: '/agents',
      headers,
      payload: { name, version: { model_provider: 'stub', model: 'stub-1', configuration: {}, ...(harnessRef !== undefined ? { harness_ref: harnessRef } : {}) } },
    });
    expect(agent.statusCode).toBe(201);
    const agentId = (agent.json() as { agent: { id: string } }).agent.id;
    const task = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { name: `${name}-task`, agent_id: agentId, timeout_ms: 300_000, retry_policy: { max_attempts: 1, backoff_ms: 0 } },
    });
    expect(task.statusCode).toBe(201);
    return { agentId, taskId: (task.json() as { task: { id: string } }).task.id };
  }

  /** One task run through the API queue; returns the run, its trace and the enqueue options. */
  async function run(taskId: string, delayMs = 0) {
    const scheduledAt = new Date(Date.UTC(2026, 0, 1, 0, ++runSeq)).toISOString();
    const res = await app.inject({ method: 'POST', url: `/tasks/${taskId}/run`, headers, payload: { scheduled_at: scheduledAt } });
    expect(res.statusCode).toBe(202);
    const runId = (res.json() as { task_run: { id: string } }).task_run.id;
    provider.delayMs = delayMs;
    const jobs = queue.drain();
    expect(jobs).toHaveLength(1);
    for (const { job, options } of jobs) await processor.process(job, { attempt: 1, maxAttempts: options.attempts ?? 1 });
    const taskRun = (await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, runId) }))!;
    const trace = (await handle.db.query.traces.findFirst({ where: eq(traces.executionId, taskRun.executionId!) }))!;
    return { taskRun, trace, harness: trace.harness as HarnessUsed, options: jobs[0]!.options };
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    // Env-like gate: TWENTY_WAIT_MAX_MS=1234 and Twenty not configured (the gate never waits).
    const gate = new TwentyGate({ isConfigured: () => false, health: async () => false }, { maxWaitMs: 1234 });
    processor = new RunProcessor(handle.db, () => provider, { info() {}, warn: (obj, msg) => warns.push({ obj, msg }), error() {} }, undefined, gate);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('seed creates default-commercial v1 ACTIVE with today\'s values, and is idempotent', async () => {
    const first = await seedHarnesses(handle.db, { tenantId: tenant });
    expect(first).toMatchObject({ name: DEFAULT_COMMERCIAL_HARNESS_NAME, action: 'created', activeVersion: 1, matchesCode: true });
    const [v1] = await handle.db.select().from(harnessVersions).where(eq(harnessVersions.harnessId, first.harnessId));
    expect(v1).toMatchObject({ version: 1, status: 'ACTIVE', config: DEFAULT_COMMERCIAL_CONFIG, contentHash: harnessConfigHash(DEFAULT_COMMERCIAL_CONFIG), createdBy: 'seed' });
    const second = await seedHarnesses(handle.db, { tenantId: tenant });
    expect(second).toMatchObject({ action: 'unchanged', activeVersion: 1, matchesCode: true });
  });

  it('no physical DELETE and immutable version content (triggers)', async () => {
    const [h] = await handle.db.select().from(harnesses).where(eq(harnesses.tenantId, tenant));
    await expect(handle.pool.query('delete from harness_versions where harness_id = $1', [h!.id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query('delete from harnesses where id = $1', [h!.id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query(`update harness_versions set config = '{}'::jsonb where harness_id = $1`, [h!.id])).rejects.toThrow(/immutable/);
  });

  it('GET /harnesses and GET /harnesses/:id (by name or uuid); POST validates the config', async () => {
    const list = await app.inject({ method: 'GET', url: '/harnesses', headers });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toEqual([expect.objectContaining({ name: DEFAULT_COMMERCIAL_HARNESS_NAME, status: 'ACTIVE', active_version: 1 })]);
    const byName = await app.inject({ method: 'GET', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}`, headers });
    const body = byName.json() as { harness: { id: string; active_version: number }; versions: Array<{ version: number }> };
    expect(body.harness.active_version).toBe(1);
    const byId = await app.inject({ method: 'GET', url: `/harnesses/${body.harness.id}`, headers });
    expect(byId.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/harnesses/no-existe', headers })).statusCode).toBe(404);

    const typo = await app.inject({ method: 'POST', url: '/harnesses', headers, payload: { name: 'typo', config: { execution: { timeout_secs: 5 } } } });
    expect(typo.statusCode).toBe(400);
    const destructive = await app.inject({ method: 'POST', url: '/harnesses', headers, payload: { name: 'bad', config: { tools: { max_risk_level: 'DESTRUCTIVE' } } } });
    expect(destructive.statusCode).toBe(400);
    const dup = await app.inject({ method: 'POST', url: '/harnesses', headers, payload: { name: DEFAULT_COMMERCIAL_HARNESS_NAME, config: {} } });
    expect(dup.statusCode).toBe(409);
    const placeholder = await app.inject({ method: 'POST', url: '/harnesses', headers, payload: { name: 'con-placeholder', config: { execution: { max_turns: 12 } } } });
    expect(placeholder.statusCode).toBe(201);
    const created = placeholder.json() as { harness: { status: string }; version: { status: string; version: number }; warnings: string[] };
    expect(created.harness.status).toBe('DRAFT');
    expect(created.version).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(created.warnings).toEqual([expect.stringMatching(/max_turns es un placeholder/)]);
  });

  it('a run with the harness: v1 applied (precedence over env), recorded in task run and trace', async () => {
    const { taskId } = await agentWithTask('HarnessAgent', { name: DEFAULT_COMMERCIAL_HARNESS_NAME });
    const r = await run(taskId);
    expect(r.taskRun.status).toBe('COMPLETED');
    expect(r.taskRun.harnessVersion).toBe('default-commercial@1');
    expect(r.trace.harnessVersion).toBe('default-commercial@1');
    // The tenant has other harnesses (con-placeholder): pick default-commercial v1 explicitly (row order is not guaranteed).
    const [v1] = await handle.db
      .select()
      .from(harnessVersions)
      .innerJoin(harnesses, eq(harnesses.id, harnessVersions.harnessId))
      .where(and(eq(harnesses.tenantId, tenant), eq(harnesses.name, DEFAULT_COMMERCIAL_HARNESS_NAME), eq(harnessVersions.version, 1)));
    expect(r.harness).toMatchObject({
      name: DEFAULT_COMMERCIAL_HARNESS_NAME,
      version: 1,
      source: 'db',
      harness_version_id: v1!.harness_versions.id,
      content_hash: harnessConfigHash(DEFAULT_COMMERCIAL_CONFIG),
      requested: { name: DEFAULT_COMMERCIAL_HARNESS_NAME },
      // Task values inherited (timeout, retry); the harness wins over env TWENTY_WAIT_MAX_MS=1234.
      effective: { timeout_ms: 300_000, retry: { max_attempts: 1, backoff_ms: 0 }, twenty_wait_max_ms: 600_000, max_risk_level: 'LOW_WRITE', max_calls_per_execution: 60, max_output_tokens: null },
      overrides: ['safety.twenty_wait_max_ms'],
    });
    expect(r.harness.fallback_reason).toBeUndefined();
    expect(r.options).toMatchObject({ attempts: 1, backoffMs: 0 });
    expect(warns).toEqual([]);
  });

  it('v2 by API with another timeout -> activate -> the next run uses it and the trace records it; deprecate -> back to v1', async () => {
    const tasks = await handle.db.query.taskDefinitions.findMany();
    const taskId = tasks.find((t) => t.tenantId === tenant && t.name === 'HarnessAgent-task')!.id;

    const v2 = await app.inject({
      method: 'POST',
      url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}/versions`,
      headers,
      payload: { copy_from: 'active', config: { execution: { timeout_seconds: 1, retry: { max_attempts: 3, backoff_ms: 10 } } }, change_reason: 'prueba: timeout de 1 s' },
    });
    expect(v2.statusCode).toBe(201);
    const v2Body = v2.json() as { version: { version: number; status: string; config: typeof DEFAULT_COMMERCIAL_CONFIG; metadata: Record<string, unknown> }; warnings: string[] };
    expect(v2Body.version).toMatchObject({ version: 2, status: 'DRAFT' });
    // copy_from keeps the dimensions not sent.
    expect(v2Body.version.config.safety.twenty_wait_max_ms).toBe(600_000);
    expect(v2Body.version.config.execution.timeout_seconds).toBe(1);
    expect(v2Body.version.metadata).toMatchObject({ copied_from: { version: 1 }, change_reason: 'prueba: timeout de 1 s' });
    expect(v2Body.warnings).toEqual([]);

    // DRAFT: runs keep v1.
    expect((await run(taskId)).taskRun.harnessVersion).toBe('default-commercial@1');

    // Release Gate: no experiment runner for harnesses yet -> blocked without a human override.
    expect((await app.inject({ method: 'POST', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}/versions/2/activate`, headers })).statusCode).toBe(409);
    const act = await app.inject({ method: 'POST', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}/versions/2/activate`, headers, payload: { force: true, reason: 'prueba de integración del harness', by: 'it' } });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, previous_version: { version: 1, status: 'DEPRECATED' } });
    const again = await app.inject({ method: 'POST', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}/versions/2/activate`, headers });
    expect(again.json()).toMatchObject({ changed: false });

    // The provider takes 1.5 s: v2 (1 s) times the run out; the task's 300 s would not.
    const slow = await run(taskId, 1_500);
    expect(slow.taskRun.status).toBe('TIMED_OUT');
    expect(slow.taskRun.harnessVersion).toBe('default-commercial@2');
    expect(slow.trace.harnessVersion).toBe('default-commercial@2');
    expect(slow.harness).toMatchObject({ version: 2, source: 'db', effective: { timeout_ms: 1_000, retry: { max_attempts: 3, backoff_ms: 10 } } });
    expect(slow.harness.overrides).toEqual(expect.arrayContaining(['execution.timeout_seconds', 'execution.retry']));
    // Retry: the harness wins over the task's retry_policy at enqueue.
    expect(slow.options).toMatchObject({ attempts: 3, backoffMs: 10 });

    // Rollback: deprecating the ACTIVE v2 restores v1; the same slow run now completes.
    const dep = await app.inject({ method: 'POST', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}/versions/2/deprecate`, headers });
    expect(dep.statusCode).toBe(200);
    expect(dep.json()).toMatchObject({ changed: true, version: { version: 2, status: 'DEPRECATED' }, restored_version: { version: 1, status: 'ACTIVE' } });
    const back = await run(taskId, 1_500);
    expect(back.taskRun.status).toBe('COMPLETED');
    expect(back.taskRun.harnessVersion).toBe('default-commercial@1');
    expect(back.harness).toMatchObject({ version: 1, effective: { timeout_ms: 300_000 } });
    expect(back.options).toMatchObject({ attempts: 1 });

    // v1 has no earlier version to restore: deprecating it is refused (the harness never loses its ACTIVE version).
    const refuse = await app.inject({ method: 'POST', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}/versions/1/deprecate`, headers });
    expect(refuse.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/harnesses/${DEFAULT_COMMERCIAL_HARNESS_NAME}`, headers })).statusCode).toBe(404);
  });

  it('a version pin ({name, version}) ignores the ACTIVE version', async () => {
    const { taskId } = await agentWithTask('PinnedAgent', { name: DEFAULT_COMMERCIAL_HARNESS_NAME, version: 2 });
    const r = await run(taskId);
    // v2 is DEPRECATED but pinned: 1 s timeout, the fast run completes.
    expect(r.taskRun.status).toBe('COMPLETED');
    expect(r.taskRun.harnessVersion).toBe('default-commercial@2');
    expect(r.harness).toMatchObject({ version: 2, requested: { name: DEFAULT_COMMERCIAL_HARNESS_NAME, version: 2 }, effective: { timeout_ms: 1_000 } });
  });

  it('fallback: no harness, or a harness that does not resolve, keeps today\'s policies and nothing fails', async () => {
    const none = await agentWithTask('NoHarnessAgent', undefined);
    const a = await run(none.taskId);
    expect(a.taskRun.status).toBe('COMPLETED');
    expect(a.taskRun.harnessVersion).toBeNull();
    expect(a.harness).toMatchObject({ source: 'none', fallback_reason: 'no_ref', requested: null, overrides: [] });
    // Without harness the env value applies.
    expect(a.harness.effective).toMatchObject({ timeout_ms: 300_000, twenty_wait_max_ms: 1234 });

    warns.length = 0;
    const missing = await agentWithTask('MissingHarnessAgent', { name: 'no-existe' });
    const b = await run(missing.taskId);
    expect(b.taskRun.status).toBe('COMPLETED');
    expect(b.taskRun.harnessVersion).toBeNull();
    expect(b.harness).toMatchObject({ source: 'none', fallback_reason: 'harness_not_found', requested: { name: 'no-existe' }, effective: { twenty_wait_max_ms: 1234 } });
    expect(warns.some((w) => /harness not found/.test(w.msg ?? ''))).toBe(true);

    const badVersion = await agentWithTask('BadVersionAgent', { name: DEFAULT_COMMERCIAL_HARNESS_NAME, version: 99 });
    const c = await run(badVersion.taskId);
    expect(c.taskRun.status).toBe('COMPLETED');
    expect(c.harness).toMatchObject({ source: 'none', fallback_reason: 'version_not_found' });
  });

  it('a direct execution (POST /executions) also resolves the harness', async () => {
    const [agent] = await handle.db.query.agents.findMany({ where: (a, { and: all, eq: is }) => all(is(a.tenantId, tenant), is(a.name, 'HarnessAgent')) });
    const res = await app.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agent!.id, input: { query: 'x' } } });
    expect(res.statusCode).toBeLessThan(300);
    for (const { job } of queue.drain()) await processor.process(job);
    const executionId = (res.json() as { execution: { id: string } }).execution.id;
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, executionId) });
    expect(trace!.harnessVersion).toBe('default-commercial@1');
    expect(trace!.harness).toMatchObject({ version: 1, effective: { timeout_ms: 300_000 } });
  });
});
