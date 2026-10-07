/**
 * Metrics sync to Twenty against a real PostgreSQL (same test DB as metrics.test.ts, fresh
 * tenant per run, no DELETE) and the in-memory FakeTwenty: the agentOsDailyMetric records
 * carry the same numbers as GET /metrics/summary for that local day.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, emailSends, evaluations, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { metricsSummary } from '../../src/metrics/queries.js';
import { DAILY_METRICS_OBJECT, localDayWindow, TwentyMetricsSync } from '../../src/metrics/twenty-sync.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

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

describe.skipIf(!dbAvailable)('metrics sync to Twenty (PostgreSQL)', () => {
  const tenant = `ms-${randomUUID().slice(0, 8)}`;
  // A fixed Wednesday of the warm-up, 12:00 in Madrid; "yesterday" is Tuesday 2026-10-06.
  const now = new Date('2026-10-07T10:00:00Z');
  let handle: DbHandle;

  async function seedRun(agentId: string, taskId: string, versionId: string, createdAt: Date, status: 'COMPLETED' | 'FAILED', outcome: string, eur: number) {
    const [run] = await handle.db
      .insert(taskRuns)
      .values({
        tenantId: tenant,
        taskDefinitionId: taskId,
        idempotencyKey: `ms:${randomUUID()}`,
        status,
        attempts: 1,
        scheduledAt: createdAt,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 5000),
        agentVersionId: versionId,
        agentVersion: 1,
        output: { outcome, counters: { hypotheses_created: 1 } },
        createdAt,
      })
      .returning();
    const [ex] = await handle.db
      .insert(agentExecutions)
      .values({
        tenantId: tenant,
        agentId,
        agentVersionId: versionId,
        taskRunId: run!.id,
        idempotencyKey: `taskrun-attempt:${run!.id}:1`,
        status,
        output: { cost: { eur, currency: 'EUR' } },
        totalCost: eur,
        latencyMs: 5000,
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 5000),
      })
      .returning();
    await handle.db.update(taskRuns).set({ executionId: ex!.id }).where(eq(taskRuns.id, run!.id));
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name: 'Prospector', status: 'ACTIVE' }).returning();
    const [v1] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenant, agentId: agent!.id, version: 1, status: 'ACTIVE', model: 'stub', modelProvider: 'stub' })
      .returning();
    const [task] = await handle.db.insert(taskDefinitions).values({ tenantId: tenant, name: 'daily-event-prospecting', agentId: agent!.id }).returning();
    // Yesterday (local): one success. Today (local): one success and one failure.
    // 2026-10-06T22:30Z is already 2026-10-07 00:30 in Madrid: it must count for today.
    await seedRun(agent!.id, task!.id, v1!.id, new Date('2026-10-06T09:00:00Z'), 'COMPLETED', 'SUCCESS', 0.01);
    await seedRun(agent!.id, task!.id, v1!.id, new Date('2026-10-06T22:30:00Z'), 'COMPLETED', 'SUCCESS', 0.02);
    await seedRun(agent!.id, task!.id, v1!.id, new Date('2026-10-07T08:00:00Z'), 'FAILED', 'FAILED', 0.005);
    // Verdicts: yesterday ACCEPTED, today DISCARDED (other subject) -> cumulative 50 % today.
    await handle.db.insert(evaluations).values([
      { tenantId: tenant, subjectType: 'hypothesis', subjectId: randomUUID(), feedback: 'ACCEPTED', score: 1, occurredAt: new Date('2026-10-06T10:00:00Z') },
      { tenantId: tenant, subjectType: 'hypothesis', subjectId: randomUUID(), feedback: 'DISCARDED', score: 0, occurredAt: new Date('2026-10-07T09:00:00Z') },
    ]);
    // Two sends today, none yesterday.
    for (const at of ['2026-10-07T07:00:00Z', '2026-10-07T08:00:00Z']) {
      await handle.db.insert(emailSends).values({
        tenantId: tenant,
        hypothesisId: randomUUID(),
        companyId: null,
        toEmail: 'buyer@example.com',
        toDomain: 'example.com',
        subject: 'Hola',
        sentAt: new Date(at),
        workspaceMemberId: null,
      });
    }
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('writes yesterday and today with the numbers of /metrics/summary for each local day', async () => {
    const fake = new FakeTwenty();
    fake.tables[DAILY_METRICS_OBJECT] = [];
    const sync = new TwentyMetricsSync(handle.db, fake.client(), { tenantId: tenant, now: () => now });
    const r = await sync.syncOnce();
    expect(r).toEqual({ ok: true, days: [{ date: '2026-10-06', result: 'created' }, { date: '2026-10-07', result: 'created' }] });

    const rows = fake.tables[DAILY_METRICS_OBJECT]!;
    const byDay = Object.fromEntries(rows.map((row) => [row.day as string, row]));
    expect(byDay['2026-10-06']).toMatchObject({
      dayKey: `${tenant}:2026-10-06`,
      runs: 1,
      runsSucceeded: 1,
      runsFailed: 0,
      cost: { amountMicros: 10_000, currencyCode: 'EUR' },
      hypothesesCreated: 1,
      emailSends: 0,
      humanReviewed: 1,
      humanAccepted: 1,
      acceptanceRate: 100,
      warmupStage: 'WARMUP',
    });
    expect(byDay['2026-10-07']).toMatchObject({
      runs: 2,
      runsSucceeded: 1,
      runsFailed: 1,
      cost: { amountMicros: 25_000, currencyCode: 'EUR' },
      emailSends: 2,
      humanReviewed: 1,
      humanAccepted: 0,
      acceptanceRate: 50,
    });

    // Cross-check with the endpoint query for today's window.
    const { since, until } = localDayWindow('2026-10-07', 'Europe/Madrid');
    const summary = await metricsSummary(handle.db, { tenantId: tenant, since, until });
    expect(byDay['2026-10-07']!.runs).toBe(summary.runs.total);
    expect((byDay['2026-10-07']!.cost as { amountMicros: number }).amountMicros).toBe(Math.round(summary.cost.total_eur! * 1e6));

    // A second pass updates in place.
    const again = await sync.syncOnce();
    expect(again.days.map((d) => d.result)).toEqual(['updated', 'updated']);
    expect(fake.tables[DAILY_METRICS_OBJECT]).toHaveLength(2);
  });
});
