/**
 * `pnpm cleanup:archive-test-agents` and the ARCHIVED filter of the metrics, against a real
 * PostgreSQL. Default database: agentos_wt5_triggers (own test DB, same server as the dev
 * one), so the shared `agentos` DB is never written. Fresh tenant per run, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { archiveTestAgents, isTestAgentName } from '../../src/maintenance/archive-test-agents.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt5_triggers';

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

describe('isTestAgentName', () => {
  it('matches "[TEST] ..." and "(live test)" agents, never the real ones', () => {
    expect(isTestAgentName('[TEST] pxos-it smoke ead03eb1')).toBe(true);
    expect(isTestAgentName('  [TEST] pxos-feedback smoke 46bec3ed')).toBe(true);
    expect(isTestAgentName('Prospector Scout (live test)')).toBe(true);
    expect(isTestAgentName('Prospector Scout (Live Test)')).toBe(true);
    expect(isTestAgentName('Prospector')).toBe(false);
    expect(isTestAgentName('EmailDrafter')).toBe(false);
    expect(isTestAgentName('Prospector [TEST]')).toBe(false);
    expect(isTestAgentName('Tester')).toBe(false);
  });
});

describe.skipIf(!dbAvailable)('cleanup:archive-test-agents + metrics without ARCHIVED agents (PostgreSQL)', () => {
  const tenant = `ar-${randomUUID().slice(0, 8)}`;
  let handle: DbHandle;
  let app: FastifyInstance;
  const ids: Record<string, string> = {};
  const taskIds: Record<string, string> = {};

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } });

  /** Agent + version + task (+ one completed run with its execution, when `run`). */
  async function seedAgent(name: string, opts: { taskStatus?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'; run?: boolean; costEur?: number } = {}) {
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name, status: 'ACTIVE' }).returning();
    const [version] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenant, agentId: agent!.id, version: 1, status: 'ACTIVE', model: 'stub', modelProvider: 'stub' })
      .returning();
    await handle.db.update(agents).set({ activeVersionId: version!.id }).where(eq(agents.id, agent!.id));
    ids[name] = agent!.id;
    if (opts.taskStatus) {
      const [task] = await handle.db
        .insert(taskDefinitions)
        .values({ tenantId: tenant, name: `task of ${name}`, agentId: agent!.id, status: opts.taskStatus })
        .returning();
      taskIds[name] = task!.id;
      if (opts.run) {
        const createdAt = new Date(Date.now() - 3_600_000);
        const [run] = await handle.db
          .insert(taskRuns)
          .values({
            tenantId: tenant,
            taskDefinitionId: task!.id,
            idempotencyKey: `ar:${randomUUID()}`,
            status: 'COMPLETED',
            attempts: 1,
            scheduledAt: createdAt,
            startedAt: createdAt,
            finishedAt: new Date(createdAt.getTime() + 1000),
            agentVersionId: version!.id,
            agentVersion: 1,
            output: { outcome: 'SUCCESS' },
            createdAt,
          })
          .returning();
        await handle.db.insert(agentExecutions).values({
          tenantId: tenant,
          agentId: agent!.id,
          agentVersionId: version!.id,
          taskRunId: run!.id,
          idempotencyKey: `taskrun-attempt:${run!.id}:1`,
          status: 'COMPLETED',
          output: { outcome: 'SUCCESS', cost: { eur: opts.costEur ?? 0.01 } },
          totalCost: 0,
          latencyMs: 1000,
          createdAt,
          startedAt: createdAt,
          finishedAt: new Date(createdAt.getTime() + 1000),
        });
      }
    }
  }

  const statusOf = async (name: string) => (await handle.db.query.agents.findFirst({ where: eq(agents.id, ids[name]!) }))!.status;
  const taskStatusOf = async (name: string) =>
    (await handle.db.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, taskIds[name]!) }))!.status;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    await seedAgent('Prospector', { taskStatus: 'ACTIVE', run: true, costEur: 0.02 });
    await seedAgent('EmailDrafter', { taskStatus: 'ACTIVE' });
    await seedAgent('[TEST] pxos-it smoke 1', { taskStatus: 'ACTIVE', run: true, costEur: 0.03 });
    await seedAgent('[TEST] pxos-it smoke 2');
    await seedAgent('[TEST] pxos-feedback smoke 3', { taskStatus: 'PAUSED' });
    await seedAgent('Prospector Scout (live test)', { taskStatus: 'ACTIVE', run: true, costEur: 0.05 });
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('before the cleanup every agent with executions shows up in /metrics/agents', async () => {
    const items = (await get('/metrics/agents')).json().items as Array<{ agent_name: string }>;
    expect(items.map((i) => i.agent_name).sort()).toEqual(['Prospector', 'Prospector Scout (live test)', '[TEST] pxos-it smoke 1']);
  });

  it('--dry-run reports the changes and writes nothing', async () => {
    const report = await archiveTestAgents(handle.db, { tenantId: tenant, dryRun: true });
    expect(report).toMatchObject({ tenant, dryRun: true, matched: 4 });
    expect(report.changes.filter((c) => c.kind === 'agent').map((c) => c.name).sort()).toEqual([
      'Prospector Scout (live test)',
      '[TEST] pxos-feedback smoke 3',
      '[TEST] pxos-it smoke 1',
      '[TEST] pxos-it smoke 2',
    ]);
    expect(report.changes.filter((c) => c.kind === 'task').map((c) => [c.agent, c.from]).sort()).toEqual([
      ['Prospector Scout (live test)', 'ACTIVE'],
      ['[TEST] pxos-feedback smoke 3', 'PAUSED'],
      ['[TEST] pxos-it smoke 1', 'ACTIVE'],
    ]);
    expect(await statusOf('[TEST] pxos-it smoke 1')).toBe('ACTIVE');
    expect(await taskStatusOf('[TEST] pxos-it smoke 1')).toBe('ACTIVE');
  });

  it('archives test agents and their live tasks, never the real ones; a second run changes nothing', async () => {
    const first = await archiveTestAgents(handle.db, { tenantId: tenant });
    expect(first.dryRun).toBe(false);
    expect(first.changes).toHaveLength(7); // 4 agents + 3 tasks
    for (const name of ['[TEST] pxos-it smoke 1', '[TEST] pxos-it smoke 2', '[TEST] pxos-feedback smoke 3', 'Prospector Scout (live test)']) {
      expect(await statusOf(name)).toBe('ARCHIVED');
    }
    expect(await taskStatusOf('[TEST] pxos-it smoke 1')).toBe('ARCHIVED');
    expect(await taskStatusOf('[TEST] pxos-feedback smoke 3')).toBe('ARCHIVED');
    expect(await taskStatusOf('Prospector Scout (live test)')).toBe('ARCHIVED');
    expect(await statusOf('Prospector')).toBe('ACTIVE');
    expect(await statusOf('EmailDrafter')).toBe('ACTIVE');
    expect(await taskStatusOf('Prospector')).toBe('ACTIVE');
    expect(await taskStatusOf('EmailDrafter')).toBe('ACTIVE');

    const second = await archiveTestAgents(handle.db, { tenantId: tenant });
    expect(second.changes).toEqual([]);
    expect(second.matched).toBe(4);
    expect(second.alreadyArchived).toHaveLength(4);
    // Nothing deleted: the runs of the archived agents are still there.
    expect(await handle.db.query.taskRuns.findMany({ where: eq(taskRuns.tenantId, tenant) })).toHaveLength(3);
  });

  it('/metrics/agents and /metrics/runs hide ARCHIVED agents unless include_archived=true; summary still counts their runs', async () => {
    const hidden = (await get('/metrics/agents')).json();
    expect(hidden.include_archived).toBe(false);
    expect(hidden.items.map((i: { agent_name: string }) => i.agent_name)).toEqual(['Prospector']);

    const shown = (await get('/metrics/agents?include_archived=true')).json();
    expect(shown.include_archived).toBe(true);
    expect(shown.items.map((i: { agent_name: string }) => i.agent_name).sort()).toEqual([
      'Prospector',
      'Prospector Scout (live test)',
      '[TEST] pxos-it smoke 1',
    ]);
    expect(shown.items.find((i: { agent_name: string }) => i.agent_name === '[TEST] pxos-it smoke 1').agent_status).toBe('ARCHIVED');

    const runs = (await get('/metrics/runs')).json().items as Array<{ agent: string }>;
    expect(runs.map((r) => r.agent)).toEqual(['Prospector']);
    expect((await get('/metrics/runs?include_archived=true')).json().items).toHaveLength(3);

    const summary = (await get('/metrics/summary')).json();
    expect(summary.runs.total).toBe(3);
    expect(summary.cost.total_eur).toBeCloseTo(0.1, 6);

    expect((await get('/metrics/agents?include_archived=maybe')).statusCode).toBe(400);
  });
});
