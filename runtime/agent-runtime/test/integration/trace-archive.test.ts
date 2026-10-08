/**
 * Trace retention without loss, end to end against a real PostgreSQL (no Redis): export of
 * the heavy payloads of old trace_steps to gzip JSONL, verification, lightening to a pointer,
 * reading the trace with the pointer (GET /traces/:id), rehydration on demand, the narrow path
 * of the trigger of migration 0015 (only payload -> its exact pointer; no DELETE) and the
 * controlled cases where a field is NOT lightened (not exactly representable in JavaScript).
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt12_ret.
 * Fresh tenants per run, archive files in a fresh temporary directory, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, traces, traceSteps, type TraceStep } from '../../src/db/schema.js';
import { archiveTraces, isArchivePointer, type ArchivePointer } from '../../src/maintenance/trace-archive.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

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
const BIG_TEXT = 'Catálogo de expositores. '.repeat(400); // ~10 KB
const BIG_NUMBER = '12345678901234567890123'; // not representable exactly as a JS number

describe.skipIf(!dbAvailable)('trace archive (PostgreSQL)', () => {
  const tenant = `it-arc-${randomUUID().slice(0, 8)}`;
  const otherTenant = `it-arc-o-${randomUUID().slice(0, 6)}`;
  const archiveDir = mkdtempSync(path.join(tmpdir(), 'pxos-trace-archive-'));
  let handle: DbHandle;
  let app: FastifyInstance;
  let oldTraceId: string;
  let recentTraceId: string;
  let otherTraceId: string;
  let before: TraceStep[];
  const createdAt = new Date(Date.now() - 120 * DAY);
  const month = createdAt.toISOString().slice(0, 7);

  const stepsOf = (traceId: string) => handle.db.select().from(traceSteps).where(eq(traceSteps.traceId, traceId)).orderBy(asc(traceSteps.sequence));
  const get = (url: string, t = tenant) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': t } });

  async function seedTrace(tenantId: string, at: Date): Promise<string> {
    const db = handle.db;
    const [agent] = await db.insert(agents).values({ tenantId, name: `Archive agent ${randomUUID().slice(0, 4)}` }).returning();
    const [version] = await db.insert(agentVersions).values({ tenantId, agentId: agent!.id, version: 1, model: 'gemini-flash-latest', modelProvider: 'gemini' }).returning();
    const [exec] = await db.insert(agentExecutions).values({ tenantId, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', input: {}, output: { ok: true } }).returning();
    const [trace] = await db
      .insert(traces)
      .values({
        tenantId,
        executionId: exec!.id,
        agentId: agent!.id,
        agentVersionId: version!.id,
        harnessVersion: 'default@1',
        skillVersions: [{ name: 'prospector-event-exhibitors', version: 3, skill_version_id: null, content_hash: 'h3', source: 'db', requested: null }],
        finalOutput: { ok: true },
        createdAt: at,
      })
      .returning();
    const traceId = trace!.id;
    const ts = new Date(at.getTime() + 1_000);
    await db.insert(traceSteps).values([
      // 1. MODEL: small input (stays), heavy output (archived).
      { tenantId, traceId, sequence: 1, timestamp: ts, type: 'MODEL', model: 'gemini-flash-latest', inputTokens: 1200, outputTokens: 300, latencyMs: 900, input: { exhibitor: 'Acme', step: 'decide' }, output: { valid: true, decision: { relevant: true }, raw: BIG_TEXT } },
      // 2. TOOL render_url: small tool_input (stays), heavy tool_output (archived), error kept.
      { tenantId, traceId, sequence: 2, timestamp: ts, type: 'TOOL', tool: 'render_url', latencyMs: 4000, toolInput: { url: 'https://feria.example/expositores' }, toolOutput: { text: BIG_TEXT, jsonResponses: [{ url: 'https://feria.example/api', body: BIG_TEXT.slice(0, 2000) }] }, error: { message: 'timeout parcial' } },
      // 3. TOOL create_hypothesis: everything small (never touched: link-resolver depends on it).
      { tenantId, traceId, sequence: 3, timestamp: ts, type: 'TOOL', tool: 'create_hypothesis', toolInput: { name: 'Acme — Feria' }, toolOutput: { record: { id: randomUUID() }, created: true } },
    ]);
    // 4. MODEL with a heavy input (archived) and a heavy output holding a 23-digit integer that
    //    JavaScript cannot carry exactly (raw SQL so PostgreSQL keeps every digit): kept in the DB.
    await db.execute(sql`
      insert into trace_steps (tenant_id, trace_id, sequence, "timestamp", type, input, output)
      values (${tenantId}, ${traceId}, 4, ${ts}, 'MODEL', ${JSON.stringify({ prompt: BIG_TEXT })}::jsonb,
              ${`{"total": ${BIG_NUMBER}, "pad": "${'p'.repeat(5000)}"}`}::jsonb)`);
    return traceId;
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub', traceArchiveDir: archiveDir } });
    oldTraceId = await seedTrace(tenant, createdAt);
    recentTraceId = await seedTrace(tenant, new Date(Date.now() - 5 * DAY));
    otherTraceId = await seedTrace(otherTenant, createdAt);
    before = await stepsOf(oldTraceId);
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('a dry run reports the candidates and writes nothing', async () => {
    const r = await archiveTraces(handle.db, { olderThanDays: 90, archiveDir, tenantId: tenant, dryRun: true });
    expect(r.candidates).toEqual([{ tenant, month, steps: 3, fields: 4, bytes: expect.any(Number) }]);
    expect(r.files).toEqual([]);
    expect(existsSync(path.join(archiveDir, tenant))).toBe(false);
    expect(await stepsOf(oldTraceId)).toEqual(before);
  });

  it('archives, verifies and only then lightens the heavy payloads of old traces', async () => {
    const r = await archiveTraces(handle.db, { olderThanDays: 90, archiveDir, tenantId: tenant });
    expect(r.files).toHaveLength(1);
    const file = r.files[0]!;
    expect(file).toMatchObject({ file: `${tenant}/${month}.jsonl.gz`, tenant, month, lines: 3, verified: true, steps_lightened: 3, steps_skipped: 0 });
    expect(r).toMatchObject({ steps_lightened: 3, fields_lightened: 3, fields_unrepresentable: 1, steps_skipped: 0 });

    // The file holds exactly the replaced contents, one line per step.
    const content = gunzipSync(readFileSync(path.join(archiveDir, file.file))).toString('utf8');
    const lines = content.trimEnd().split('\n').map((l) => JSON.parse(l) as { step_id: string; fields: Record<string, unknown> });
    expect(lines.map((l) => l.step_id)).toEqual([before[0]!.id, before[1]!.id, before[3]!.id]);
    expect(lines[0]!.fields).toEqual({ output: before[0]!.output });
    expect(lines[1]!.fields).toEqual({ tool_output: before[1]!.toolOutput });
    expect(lines[2]!.fields).toEqual({ input: before[3]!.input });

    const after = await stepsOf(oldTraceId);
    // Pointers where the heavy fields were...
    expect(after[0]!.output).toMatchObject({ archived: true, file: file.file, line: 1, field: 'output', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(after[1]!.toolOutput).toMatchObject({ archived: true, file: file.file, line: 2, field: 'tool_output' });
    expect(after[3]!.input).toMatchObject({ archived: true, line: 3, field: 'input' });
    // ...and everything else exactly as it was: small payloads, type, timestamps, metrics, errors.
    for (const [i, step] of after.entries()) {
      const b = before[i]!;
      expect({ ...step, input: null, output: null, toolInput: null, toolOutput: null }).toEqual({ ...b, input: null, output: null, toolInput: null, toolOutput: null });
    }
    expect(after[0]!.input).toEqual(before[0]!.input);
    expect(after[1]!.toolInput).toEqual(before[1]!.toolInput);
    expect(after[1]!.error).toEqual({ message: 'timeout parcial' });
    expect(after[2]).toEqual(before[2]);
    // The 23-digit integer is still in the database with every digit (never lost, never lightened).
    const [kept] = (await handle.db.execute<{ total: string }>(sql`select output->>'total' as total from trace_steps where id = ${before[3]!.id}`)).rows;
    expect(kept?.total).toBe(BIG_NUMBER);
    // The trace row (versions P4, totals) is untouched.
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.id, oldTraceId) });
    expect(trace?.skillVersions).toEqual([{ name: 'prospector-event-exhibitors', version: 3, skill_version_id: null, content_hash: 'h3', source: 'db', requested: null }]);
    expect(trace?.harnessVersion).toBe('default@1');
  });

  it('leaves recent traces and other tenants alone', async () => {
    expect((await stepsOf(recentTraceId)).some((s) => [s.input, s.output, s.toolInput, s.toolOutput].some(isArchivePointer))).toBe(false);
    expect((await stepsOf(otherTraceId)).some((s) => [s.input, s.output, s.toolInput, s.toolOutput].some(isArchivePointer))).toBe(false);
  });

  it('is idempotent: a second run archives nothing and never touches the existing file', async () => {
    const file = path.join(archiveDir, tenant, `${month}.jsonl.gz`);
    const bytes = readFileSync(file);
    const r = await archiveTraces(handle.db, { olderThanDays: 90, archiveDir, tenantId: tenant });
    expect(r).toMatchObject({ files: [], steps_lightened: 0, fields_unrepresentable: 1 });
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it('GET /traces/:id serves the pointers, and rehydrates them on demand (verified)', async () => {
    const plain = await get(`/traces/${oldTraceId}`);
    expect(plain.statusCode).toBe(200);
    const t = plain.json().trace as { archived_steps: number; steps: Array<Record<string, unknown>> };
    expect(t.archived_steps).toBe(3);
    expect(t.steps.map((s) => s.archived_fields)).toEqual([['output'], ['tool_output'], [], ['input']]);
    expect(isArchivePointer(t.steps[0]!.output)).toBe(true);

    const full = await get(`/traces/${oldTraceId}?rehydrate=true`);
    const steps = (full.json().trace as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps[0]!.output).toEqual(before[0]!.output);
    expect(steps[1]!.tool_output).toEqual(before[1]!.toolOutput);
    expect(steps[3]!.input).toEqual(before[3]!.input);
    expect(steps[0]!.rehydrated).toEqual({ output: { status: 'ok', verified: true, file: `${tenant}/${month}.jsonl.gz`, line: 1 } });
    expect(steps[2]!.rehydrated).toBeUndefined();

    // Other tenants do not see it; the execution view still serves the trace (with pointers).
    expect((await get(`/traces/${oldTraceId}`, otherTenant)).statusCode).toBe(404);
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.id, oldTraceId) });
    const exec = await get(`/executions/${trace!.executionId}`);
    expect(exec.statusCode).toBe(200);
    expect(isArchivePointer(exec.json().trace.steps[0].output)).toBe(true);
  });

  it('a missing archive file never fails the read: the pointer stays and the status says why', async () => {
    const file = path.join(archiveDir, tenant, `${month}.jsonl.gz`);
    const moved = `${file}.moved`;
    renameSync(file, moved); // moved aside (not deleted) and put back below
    try {
      const res = await get(`/traces/${oldTraceId}?rehydrate=1`);
      expect(res.statusCode).toBe(200);
      const step = (res.json().trace as { steps: Array<Record<string, unknown>> }).steps[0]!;
      expect(isArchivePointer(step.output)).toBe(true);
      expect(step.rehydrated).toMatchObject({ output: { status: 'missing_file' } });
    } finally {
      renameSync(moved, file);
    }
  });

  describe('trigger of migration 0015 (narrow path only)', () => {
    /** Runs a statement inside a transaction that is ALWAYS rolled back, expecting the trigger to refuse it. */
    async function refused(text: string, params: unknown[], pattern: RegExp) {
      const client = await handle.pool.connect();
      try {
        await client.query('begin');
        await expect(client.query(text, params)).rejects.toThrow(pattern);
      } finally {
        await client.query('rollback');
        client.release();
      }
    }
    const sha = (v: unknown) => `encode(sha256(convert_to((${v})::text, 'UTF8')), 'hex')`;

    it('rejects changing anything but a payload, and any payload change but its exact pointer', async () => {
      const id = before[2]!.id; // untouched step, small payloads
      await refused(`update trace_steps set type = 'THINK' where id = $1`, [id], /immutable/);
      await refused(`update trace_steps set latency_ms = 1 where id = $1`, [id], /immutable/);
      await refused(`update trace_steps set error = '{"x":1}'::jsonb where id = $1`, [id], /immutable/);
      await refused(`update trace_steps set tool_output = '{"record":{"id":"other"}}'::jsonb where id = $1`, [id], /archive pointer/);
      // A pointer with a sha256 that is not the one of the replaced content.
      await refused(`update trace_steps set tool_output = jsonb_build_object('archived', true, 'file', 'x.jsonl.gz', 'line', 1, 'field', 'tool_output', 'sha256', repeat('0', 64), 'bytes', 1) where id = $1`, [id], /archive pointer/);
      // The right sha256 but the wrong field name, or an extra key.
      await refused(`update trace_steps set tool_output = jsonb_build_object('archived', true, 'file', 'x.jsonl.gz', 'line', 1, 'field', 'output', 'sha256', ${sha('tool_output')}, 'bytes', 1) where id = $1`, [id], /archive pointer/);
      await refused(`update trace_steps set tool_output = jsonb_build_object('archived', true, 'file', 'x.jsonl.gz', 'line', 1, 'field', 'tool_output', 'sha256', ${sha('tool_output')}, 'bytes', 1, 'note', 'x') where id = $1`, [id], /archive pointer/);
    });

    it('a pointer never changes again (no re-pointing, no restoring through UPDATE)', async () => {
      const id = before[0]!.id;
      await refused(`update trace_steps set output = jsonb_set(output, '{line}', '9') where id = $1`, [id], /archive pointer/);
      await refused(`update trace_steps set output = '{"restored": true}'::jsonb where id = $1`, [id], /archive pointer/);
    });

    it('accepts exactly the transition payload -> its pointer (rolled back here)', async () => {
      const id = before[2]!.id;
      const client = await handle.pool.connect();
      try {
        await client.query('begin');
        const res = await client.query(
          `update trace_steps set tool_output = jsonb_build_object('archived', true, 'file', 'x.jsonl.gz', 'line', 1, 'field', 'tool_output', 'sha256', ${sha('tool_output')}, 'bytes', octet_length(tool_output::text)) where id = $1 returning tool_output`,
          [id],
        );
        expect(isArchivePointer((res.rows[0] as { tool_output: ArchivePointer }).tool_output)).toBe(true);
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect((await stepsOf(oldTraceId))[2]).toEqual(before[2]);
    });

    it('traces and trace_steps have no physical DELETE', async () => {
      await refused('delete from trace_steps where id = $1', [before[2]!.id], /no physical DELETE/);
      await refused('delete from traces where id = $1', [recentTraceId], /no physical DELETE/);
    });
  });
});
