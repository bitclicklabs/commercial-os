/**
 * Metrics endpoints against a real PostgreSQL with seeded data (two tenants, two versions).
 * Default database: agentos_wt4_metrics (own test DB, same server as the dev one), so the
 * shared `agentos` DB is never written. Fresh tenants per run, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, evaluations, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt4_metrics';

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!dbAvailable)('metrics (PostgreSQL, seeded)', () => {
  const tenantA = `mt-${randomUUID().slice(0, 8)}`;
  const tenantB = `mt-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  let handle: DbHandle;
  let app: FastifyInstance;
  let v1Id = '';
  let v2Id = '';

  const get = (url: string, tenant: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } });

  interface ExecSeed {
    status: 'COMPLETED' | 'FAILED';
    output?: Record<string, unknown> | null;
    totalCost?: number;
    latencyMs?: number;
  }

  /** One TaskRun with its executions (attempts); returns the execution ids. */
  async function seedRun(
    tenant: string,
    agentId: string,
    taskId: string,
    version: { id: string; version: number },
    run: { status: 'COMPLETED' | 'FAILED'; createdAt: Date; durationMs: number; output: Record<string, unknown> | null; executions: ExecSeed[] },
  ): Promise<string[]> {
    const startedAt = new Date(run.createdAt.getTime() + 1000);
    const [row] = await handle.db
      .insert(taskRuns)
      .values({
        tenantId: tenant,
        taskDefinitionId: taskId,
        idempotencyKey: `mt:${randomUUID()}`,
        status: run.status,
        attempts: run.executions.length,
        scheduledAt: run.createdAt,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + run.durationMs),
        agentVersionId: version.id,
        agentVersion: version.version,
        output: run.output,
        createdAt: run.createdAt,
      })
      .returning();
    const ids: string[] = [];
    for (const [i, e] of run.executions.entries()) {
      const [ex] = await handle.db
        .insert(agentExecutions)
        .values({
          tenantId: tenant,
          agentId,
          agentVersionId: version.id,
          taskRunId: row!.id,
          idempotencyKey: `taskrun-attempt:${row!.id}:${i + 1}`,
          status: e.status,
          output: e.output ?? null,
          totalCost: e.totalCost ?? 0,
          latencyMs: e.latencyMs ?? 1000,
          createdAt: run.createdAt,
          startedAt,
          finishedAt: new Date(startedAt.getTime() + run.durationMs),
        })
        .returning();
      ids.push(ex!.id);
    }
    await handle.db.update(taskRuns).set({ executionId: ids.at(-1)! }).where(eq(taskRuns.id, row!.id));
    return ids;
  }

  async function verdict(tenant: string, subjectId: string, executionId: string | null, feedback: 'ACCEPTED' | 'EDITED' | 'DISCARDED', at: Date) {
    await handle.db.insert(evaluations).values({
      tenantId: tenant,
      subjectType: 'hypothesis',
      subjectId,
      agentExecutionId: executionId,
      feedback,
      score: feedback === 'ACCEPTED' ? 1 : feedback === 'EDITED' ? 0.5 : 0,
      occurredAt: at,
    });
  }

  const out = (outcome: string, eur: number, counters: Record<string, number>) => ({ outcome, cost: { eur, currency: 'USD', usd_to_eur: 0.86 }, counters });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);

    // ---- tenant A: Prospector v1 (2 runs, one retried) and v2 (2 runs, one failed)
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenantA, name: 'Prospector', status: 'ACTIVE' }).returning();
    const [v1] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenantA, agentId: agent!.id, version: 1, status: 'DEPRECATED', model: 'stub', modelProvider: 'stub' })
      .returning();
    const [v2] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenantA, agentId: agent!.id, version: 2, status: 'ACTIVE', model: 'stub', modelProvider: 'stub' })
      .returning();
    v1Id = v1!.id;
    v2Id = v2!.id;
    const [task] = await handle.db.insert(taskDefinitions).values({ tenantId: tenantA, name: 'daily-event-prospecting', agentId: agent!.id }).returning();
    const V1 = { id: v1!.id, version: 1 };
    const V2 = { id: v2!.id, version: 2 };

    // run1 (10 days ago, v1): 0.01 EUR, 10 s
    const [e1] = await seedRun(tenantA, agent!.id, task!.id, V1, {
      status: 'COMPLETED',
      createdAt: new Date(now - 10 * DAY),
      durationMs: 10_000,
      output: out('SUCCESS', 0.01, { evaluated: 3, relevant: 2, hypotheses_created: 1 }),
      executions: [{ status: 'COMPLETED', output: out('SUCCESS', 0.01, {}), totalCost: 0.0116 }],
    });
    // run2 (v1): attempt 1 FAILED (0.005 USD -> 0.0043 EUR), attempt 2 PARTIAL 0.02 EUR; 20 s
    const [, e3] = await seedRun(tenantA, agent!.id, task!.id, V1, {
      status: 'COMPLETED',
      createdAt: new Date(now - 3 * HOUR),
      durationMs: 20_000,
      output: out('PARTIAL', 0.02, { evaluated: 2, relevant: 1, hypotheses_created: 0 }),
      executions: [
        { status: 'FAILED', output: null, totalCost: 0.005 },
        { status: 'COMPLETED', output: out('PARTIAL', 0.02, {}), totalCost: 0.0233 },
      ],
    });
    // run3 (v2): 0.03 EUR, 30 s
    const [e4] = await seedRun(tenantA, agent!.id, task!.id, V2, {
      status: 'COMPLETED',
      createdAt: new Date(now - 2 * HOUR),
      durationMs: 30_000,
      output: out('SUCCESS', 0.03, { evaluated: 4, relevant: 3, hypotheses_created: 2 }),
      executions: [{ status: 'COMPLETED', output: out('SUCCESS', 0.03, {}), totalCost: 0.0349 }],
    });
    // run4 (v2): FAILED, no output, 5 s
    await seedRun(tenantA, agent!.id, task!.id, V2, {
      status: 'FAILED',
      createdAt: new Date(now - 1 * HOUR),
      durationMs: 5_000,
      output: null,
      executions: [{ status: 'FAILED', output: null, totalCost: 0 }],
    });

    // Verdicts. v1: h1 ACCEPTED; h2 EDITED then DISCARDED (latest wins). v2: ACCEPTED, ACCEPTED, EDITED.
    await verdict(tenantA, 'h1', e1!, 'ACCEPTED', new Date('2026-10-01T09:00:00Z'));
    await verdict(tenantA, 'h2', e3!, 'EDITED', new Date('2026-10-01T10:00:00Z'));
    await verdict(tenantA, 'h2', e3!, 'DISCARDED', new Date('2026-10-02T10:00:00Z'));
    await verdict(tenantA, 'h3', e4!, 'ACCEPTED', new Date('2026-10-02T11:00:00Z'));
    await verdict(tenantA, 'h4', e4!, 'ACCEPTED', new Date('2026-10-02T12:00:00Z'));
    await verdict(tenantA, 'h5', e4!, 'EDITED', new Date('2026-10-02T23:30:00Z')); // 2026-10-03 in Madrid
    await verdict(tenantA, 'h6', null, 'ACCEPTED', new Date('2026-10-03T08:00:00Z')); // unlinked

    // ---- tenant B: same agent name, expensive and all discarded. Must never leak into A.
    const [agentB] = await handle.db.insert(agents).values({ tenantId: tenantB, name: 'Prospector', status: 'ACTIVE' }).returning();
    const [vB] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenantB, agentId: agentB!.id, version: 1, status: 'ACTIVE', model: 'stub', modelProvider: 'stub' })
      .returning();
    const [taskB] = await handle.db.insert(taskDefinitions).values({ tenantId: tenantB, name: 'daily-event-prospecting', agentId: agentB!.id }).returning();
    const [eB] = await seedRun(tenantB, agentB!.id, taskB!.id, { id: vB!.id, version: 1 }, {
      status: 'COMPLETED',
      createdAt: new Date(now - 1 * HOUR),
      durationMs: 3_600_000,
      output: out('SUCCESS', 5, { evaluated: 100, relevant: 50, hypotheses_created: 40 }),
      executions: [{ status: 'COMPLETED', output: out('SUCCESS', 5, {}), totalCost: 5.8 }],
    });
    await verdict(tenantB, 'hb1', eB!, 'DISCARDED', new Date('2026-10-02T10:00:00Z'));
    await verdict(tenantB, 'hb2', eB!, 'DISCARDED', new Date('2026-10-02T10:00:00Z'));

    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('summary: runs, cost as the sum of executions, latency, outcome and funnel', async () => {
    const res = await get('/metrics/summary', tenantA);
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.runs).toMatchObject({ total: 4, executions: 5, by_status: { COMPLETED: 3, FAILED: 1 }, by_outcome: { SUCCESS: 2, PARTIAL: 1, NONE: 1 } });
    // 0.01 + (0.005 * 0.86 + 0.02) + 0.03 + 0 = 0.0643
    expect(s.cost.total_eur).toBeCloseTo(0.0643, 6);
    expect(s.cost.avg_per_run_eur).toBeCloseTo(0.0643 / 4, 6);
    expect(s.cost.max_per_run_eur).toBeCloseTo(0.03, 6);
    expect(s.latency_ms).toMatchObject({ runs_measured: 4, avg: 16250, p95: 28500, max: 30000 });
    expect(s.funnel).toMatchObject({ runs_with_counters: 3, evaluated: 9, relevant: 6, hypotheses_created: 3 });
    expect(s.acceptance.ac15_cost_per_run.runs_over).toBe(0);
    expect(s.acceptance.ac17_cost_per_new_hypothesis_eur).toBeCloseTo(0.0643 / 3, 6);
    expect(s.runs.by_task).toHaveLength(1);
    expect(s.runs.by_task[0]).toMatchObject({ name: 'daily-event-prospecting', runs: 4, completed: 3, failed: 1 });
    // Latest verdict per subject: h1 A, h2 D, h3 A, h4 A, h5 E, h6 A (unlinked counts here).
    expect(s.human_feedback).toMatchObject({ subjects_reviewed: 6, verdicts: 7, accepted: 4, edited: 1, discarded: 1 });
    expect(s.human_feedback.acceptance_rate).toBeCloseTo(4 / 6, 4);
    expect(s.last_run.status).toBe('FAILED');
    expect(s.last_run.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('summary: since/until window on task_runs.created_at', async () => {
    const since = new Date(now - 7 * DAY).toISOString();
    const s = (await get(`/metrics/summary?since=${encodeURIComponent(since)}`, tenantA)).json();
    expect(s.runs.total).toBe(3);
    expect(s.cost.total_eur).toBeCloseTo(0.0543, 6);
    const until = new Date(now - 7 * DAY).toISOString();
    const old = (await get(`/metrics/summary?until=${encodeURIComponent(until)}`, tenantA)).json();
    expect(old.runs.total).toBe(1);
    const bad = await get(`/metrics/summary?since=${encodeURIComponent(since)}&until=${encodeURIComponent(new Date(now - 8 * DAY).toISOString())}`, tenantA);
    expect(bad.statusCode).toBe(400);
  });

  it('agents: acceptance rate and average cost per version (v1 vs v2 comparable)', async () => {
    const res = await get('/metrics/agents', tenantA);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, any>>;
    expect(items.map((i) => i.version_label)).toEqual(['v1', 'v2']);
    const [a1, a2] = items;

    expect(a1).toMatchObject({ agent_name: 'Prospector', agent_version_id: v1Id, version: 1, runs: 3 });
    expect(a1!.by_status).toEqual({ completed: 2, failed: 1, cancelled: 0 });
    expect(a1!.avg_cost_eur).toBeCloseTo((0.01 + 0.0043 + 0.02) / 3, 6);
    expect(a1!.outcome).toMatchObject({ success: 1, partial: 1, failed: 0, none: 1, success_rate: 0.5 });
    // h1 ACCEPTED, h2 EDITED -> DISCARDED (latest): 1/2 accepted, 3 verdict rows.
    expect(a1!.human_feedback).toMatchObject({ verdicts: 3, subjects_reviewed: 2, accepted: 1, edited: 0, discarded: 1, acceptance_rate: 0.5, useful_rate: 0.5, avg_score: 0.5 });

    expect(a2).toMatchObject({ agent_version_id: v2Id, version: 2, runs: 2 });
    expect(a2!.avg_cost_eur).toBeCloseTo(0.015, 6);
    expect(a2!.human_feedback).toMatchObject({ verdicts: 3, subjects_reviewed: 3, accepted: 2, edited: 1, discarded: 0, useful_rate: 1 });
    expect(a2!.human_feedback.acceptance_rate).toBeCloseTo(2 / 3, 4);
    expect(a2!.human_feedback.avg_score).toBeCloseTo(2.5 / 3, 4);
  });

  it('evaluations: series per day (time zone aware) and per subject', async () => {
    const res = await get('/metrics/evaluations?tz=Europe/Madrid', tenantA);
    expect(res.statusCode).toBe(200);
    const e = res.json();
    expect(e.totals).toMatchObject({ verdicts: 7, subjects: 6, linked_to_execution: 6, by_feedback: { ACCEPTED: 4, EDITED: 2, DISCARDED: 1 } });
    expect(e.by_day).toEqual([
      { day: '2026-10-01', verdicts: 2, ACCEPTED: 1, EDITED: 1, DISCARDED: 0, avg_score: 0.75 },
      { day: '2026-10-02', verdicts: 3, ACCEPTED: 2, EDITED: 0, DISCARDED: 1, avg_score: 0.6667 },
      { day: '2026-10-03', verdicts: 2, ACCEPTED: 1, EDITED: 1, DISCARDED: 0, avg_score: 0.75 },
    ]);
    const h2 = e.subjects.find((s: { subject_id: string }) => s.subject_id === 'h2');
    expect(h2).toMatchObject({ verdicts: 2, latest_feedback: 'DISCARDED', history: ['EDITED', 'DISCARDED'] });
    const utc = (await get('/metrics/evaluations?tz=UTC', tenantA)).json();
    expect(utc.by_day.map((d: { day: string }) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(utc.by_day[1].verdicts).toBe(4); // h5 at 23:30Z stays on 10-02 in UTC
    expect((await get('/metrics/evaluations?tz=Mars/Olympus', tenantA)).statusCode).toBe(400);
  });

  it('tenant isolation: a tenant never sees another tenant data', async () => {
    const a = (await get('/metrics/summary', tenantA)).json();
    expect(a.cost.max_per_run_eur).toBeLessThan(1);
    expect(a.funnel.evaluated).toBe(9);
    const b = (await get('/metrics/summary', tenantB)).json();
    expect(b.runs.total).toBe(1);
    expect(b.cost.total_eur).toBeCloseTo(5, 6);
    expect(b.acceptance.ac15_cost_per_run.runs_over).toBe(1);
    expect(b.acceptance.ac16_duration.runs_over).toBe(1);
    expect(b.human_feedback).toMatchObject({ subjects_reviewed: 2, discarded: 2, acceptance_rate: 0 });

    const agentsB = (await get('/metrics/agents', tenantB)).json().items;
    expect(agentsB).toHaveLength(1);
    expect(agentsB[0].human_feedback.verdicts).toBe(2);
    const agentsA = (await get('/metrics/agents', tenantA)).json().items;
    expect(agentsA.reduce((n: number, i: { human_feedback: { verdicts: number } }) => n + i.human_feedback.verdicts, 0)).toBe(6);

    const evB = (await get('/metrics/evaluations', tenantB)).json();
    expect(evB.totals.verdicts).toBe(2);
    expect(evB.subjects.map((s: { subject_id: string }) => s.subject_id).sort()).toEqual(['hb1', 'hb2']);
    const runsB = (await get('/metrics/runs', tenantB)).json().items;
    expect(runsB).toHaveLength(1);
  });

  it('runs: latest first, with cost and a relative trace link that resolves', async () => {
    const res = await get('/metrics/runs?limit=2', tenantA);
    const items = res.json().items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ status: 'FAILED', version: 2, task: 'daily-event-prospecting', agent: 'Prospector' });
    expect(items[1].cost_eur).toBeCloseTo(0.03, 6);
    const trace = await get(items[1].trace_url, tenantA);
    expect(trace.statusCode).toBe(200);
    expect(trace.json().task_run.id).toBe(items[1].id);
  });

  it('dashboard: HTML served to local requests, fetching relative paths only', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: { host: '127.0.0.1:4020' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const html = res.body;
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('prefers-color-scheme: dark');
    const fetched = [...html.matchAll(/(?<![.\w])get\('([^']+)'/g)].map((m) => m[1]!);
    expect(fetched.length).toBeGreaterThanOrEqual(5);
    for (const path of fetched) expect(path).toMatch(/^metrics\//);
    expect(html).toContain("'task-runs/'");
    expect(html).not.toMatch(/https?:\/\//); // no CDN, no absolute URLs
    expect(html).not.toMatch(/<script[^>]+src=/i);

    const remote = await app.inject({ method: 'GET', url: '/dashboard', headers: { host: '127.0.0.1:4020' }, remoteAddress: '203.0.113.7' });
    expect(remote.statusCode).toBe(403);
    const rebinding = await app.inject({ method: 'GET', url: '/dashboard', headers: { host: 'evil.example:4020' } });
    expect(rebinding.statusCode).toBe(403);
  });
});

