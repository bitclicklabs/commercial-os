/**
 * Scheduled trace archive, one real pass against PostgreSQL (no Redis): the job runs the same
 * archiveTraces() as the CLI on an old trace with heavy payloads, lightens it, writes ONE
 * audit_log row `traces.archive` (actor system, method JOB) with the counts and the file; a
 * second pass finds nothing and writes no audit row; a tick during a running pass is skipped.
 * Restricted to a fresh tenant (other suites may seed old traces in the same database) and a
 * fresh temporary archive directory. No DELETE. Run it against its own database:
 *   DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt13_gate
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '../../src/audit/service.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, traces, traceSteps } from '../../src/db/schema.js';
import { TraceArchiveJob } from '../../src/maintenance/trace-archive-job.js';
import { isArchivePointer } from '../../src/maintenance/trace-archive.js';

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

const DAY = 86_400_000;
const BIG_TEXT = 'Expositores de la feria con su stand y su web. '.repeat(250); // ~12 KB

describe.skipIf(!dbAvailable)('scheduled trace archive (PostgreSQL)', () => {
  const tenant = `it-arcjob-${randomUUID().slice(0, 8)}`;
  const archiveDir = mkdtempSync(path.join(tmpdir(), 'pxos-trace-archive-job-'));
  const createdAt = new Date(Date.now() - 120 * DAY);
  const month = createdAt.toISOString().slice(0, 7);
  const logs: Array<{ level: string; msg: string | undefined }> = [];
  const logger = {
    info: (_o: object, msg?: string) => void logs.push({ level: 'info', msg }),
    warn: (_o: object, msg?: string) => void logs.push({ level: 'warn', msg }),
    error: (_o: object, msg?: string) => void logs.push({ level: 'error', msg }),
  };
  let handle: DbHandle;
  let traceId: string;

  const audits = () => listAudit(handle.db, { tenantId: tenant, actions: ['traces.archive'] });
  const job = () => new TraceArchiveJob(handle.db, { olderThanDays: 90, archiveDir, tenantId: tenant, auditTenantId: 'publiexpe', logger });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    const db = handle.db;
    const [agent] = await db.insert(agents).values({ tenantId: tenant, name: `Archive job agent ${randomUUID().slice(0, 4)}` }).returning();
    const [version] = await db.insert(agentVersions).values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'gemini-flash-latest', modelProvider: 'gemini' }).returning();
    const [exec] = await db.insert(agentExecutions).values({ tenantId: tenant, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', input: {}, output: { ok: true } }).returning();
    const [trace] = await db.insert(traces).values({ tenantId: tenant, executionId: exec!.id, agentId: agent!.id, agentVersionId: version!.id, harnessVersion: 'default@1', finalOutput: { ok: true }, createdAt }).returning();
    traceId = trace!.id;
    const ts = new Date(createdAt.getTime() + 1_000);
    await db.insert(traceSteps).values([
      { tenantId: tenant, traceId, sequence: 1, timestamp: ts, type: 'MODEL', model: 'gemini-flash-latest', input: { exhibitor: 'Acme' }, output: { raw: BIG_TEXT } },
      { tenantId: tenant, traceId, sequence: 2, timestamp: ts, type: 'TOOL', tool: 'render_url', toolInput: { url: 'https://feria.example' }, toolOutput: { text: BIG_TEXT } },
    ]);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('a pass with work lightens the old steps and writes one audit row traces.archive', async () => {
    const r = await job().runOnce();
    expect(r).toMatchObject({ status: 'done', audited: true, report: { steps_lightened: 2, fields_lightened: 2 } });
    const file = `${tenant}/${month}.jsonl.gz`;
    expect(existsSync(path.join(archiveDir, file))).toBe(true);

    const steps = await handle.db.select().from(traceSteps).where(eq(traceSteps.traceId, traceId)).orderBy(asc(traceSteps.sequence));
    expect(isArchivePointer(steps[0]!.output)).toBe(true);
    expect(isArchivePointer(steps[1]!.toolOutput)).toBe(true);
    expect(steps[0]!.input).toEqual({ exhibitor: 'Acme' }); // small payloads stay

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: tenant,
      actor: 'system',
      actorLabel: 'trace-archive',
      action: 'traces.archive',
      subjectType: 'traces',
      subjectId: tenant,
      method: 'JOB',
      route: 'job:trace-archive',
      requestId: (r as { pass_id: string }).pass_id,
      result: 'ok',
      statusCode: 200,
      payload: { older_than_days: 90, steps_lightened: 2, fields_lightened: 2, tenants: [tenant], files: [{ file, lines: 2, steps_lightened: 2 }] },
    });
  });

  it('a pass with nothing left to archive writes no audit row (log only)', async () => {
    const r = await job().runOnce();
    expect(r).toMatchObject({ status: 'done', audited: false, report: { steps_lightened: 0, files: [] } });
    expect(await audits()).toHaveLength(1);
    expect(logs.at(-1)).toEqual({ level: 'info', msg: 'trace archive: nothing to archive' });
  });

  it('a tick while the pass runs is skipped', async () => {
    const j = job();
    const first = j.runOnce();
    expect(await j.runOnce()).toEqual({ status: 'skipped', reason: 'overlap' });
    expect(await first).toMatchObject({ status: 'done' });
    expect(logs.some((l) => l.level === 'warn' && /still running/.test(l.msg ?? ''))).toBe(true);
  });
});
