/**
 * Inbound de bajas end to end against a real PostgreSQL (no Redis, no real mailbox):
 * migration 0004 -> seed `process-unsubscribes` -> TaskRun -> RunProcessor -> BajasAgent ->
 * real imapflow against the in-process fake IMAP server -> append to the suppression note in a
 * fake Twenty -> cursor in `inbound_state` -> trace with counters.
 * Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { inboundState, taskDefinitions, taskRuns, traces, traceSteps } from '../../src/db/schema.js';
import { DrizzleInboundStateStore } from '../../src/inbound/inbound-state.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { BAJAS_TASK_NAME, seedBajas } from '../../src/seed/bajas-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeImapServer } from '../helpers/fake-imap.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

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

const IMAP_KEYS = ['IONOS_IMAP_HOST', 'IONOS_IMAP_PORT', 'IONOS_IMAP_USER', 'IONOS_IMAP_PASSWORD', 'IONOS_IMAP_TLS', 'IONOS_IMAP_MAILBOX'] as const;

/** Runs `fn` with the IMAP env replaced (never touches the real mailbox from .env). */
async function withImapEnv<T>(values: Partial<Record<(typeof IMAP_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(IMAP_KEYS.map((k) => [k, process.env[k]]));
  for (const k of IMAP_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of IMAP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const mail = (from: string, to: string, subject: string, body: string) =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

describe.skipIf(!dbAvailable)('inbound de bajas: process-unsubscribes -> BajasAgent -> suppression note (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  const note = fake.seed('notes', { id: SUPPRESSION_NOTE_ID, title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: 'ya@estaba.example — 2026-10-06 — manual', blocknote: '[bn]' } });
  const imap = new FakeImapServer();
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    imap.messages = [
      { uid: 21, source: mail('Luis <luis@cliente.example>', 'baja@publiexpe.info', 'Baja', 'Gracias'), internalDate: new Date('2026-10-07T08:00:00Z') },
      { uid: 22, source: mail('carmen@cliente2.example', 'jesus.abril@publiexpe.info', 'Re: Propuesta', 'Nos interesa, llámame.'), internalDate: new Date('2026-10-07T09:00:00Z') },
      { uid: 23, source: mail('ya@estaba.example', 'jesus.abril@publiexpe.info', 'Re: Propuesta', 'Dadme de baja, por favor.'), internalDate: new Date('2026-10-07T09:30:00Z') },
    ];
    await imap.start();
  });

  afterAll(async () => {
    await imap.stop();
    await handle?.close();
  });

  it('inbound_state store: upsert, monotonic under the same UIDVALIDITY, reset on a new one', async () => {
    const store = new DrizzleInboundStateStore(handle.db);
    const key = { tenantId: tenant, consumer: 'bajas-store-test', mailbox: 'u@h/INBOX' };
    expect(await store.get(key)).toBeNull();
    await store.save(key, { uidValidity: 5, lastUid: 10, summary: { a: 1 } });
    await store.save(key, { uidValidity: 5, lastUid: 7, summary: {} });
    expect(await store.get(key)).toMatchObject({ uidValidity: 5, lastUid: 10 });
    await store.save(key, { uidValidity: 6, lastUid: 2, summary: {} });
    expect(await store.get(key)).toMatchObject({ uidValidity: 6, lastUid: 2 });
  });

  it('seed is idempotent and registers the CRON task every 2 hours (Europe/Madrid)', async () => {
    const first = await seedBajas(handle.db, { tenantId: tenant });
    expect(first).toMatchObject({ agentAction: 'created', taskAction: 'created' });
    expect(await seedBajas(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged' });
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, BAJAS_TASK_NAME)) });
    expect(task).toMatchObject({ schedule: { type: 'CRON', expression: '0 */2 * * *' }, timezone: 'Europe/Madrid', maxConcurrency: 1 });
  });

  async function runOnce(env: Partial<Record<(typeof IMAP_KEYS)[number], string>>) {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, BAJAS_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it:${randomUUID()}` });
    const processor = new RunProcessor(handle.db, createProviderRegistry(), undefined, createDefaultToolRegistry({ twenty: fake.client() }), null);
    await withImapEnv(env, async () => {
      for (const { job } of queue.drain()) await processor.process(job);
    });
    return (await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) }))!;
  }

  it('without IMAP credentials the run completes as SKIPPED with the reason', async () => {
    const run = await runOnce({});
    expect(run.status).toBe('COMPLETED');
    expect(run.output).toMatchObject({ outcome: 'SKIPPED', sends_email: false });
    expect(String((run.output as { reason: string }).reason)).toMatch(/IONOS_IMAP_USER, IONOS_IMAP_PASSWORD/);
  });

  it('reads the fake mailbox read-only, appends the new baja, dedupes the old one and stores the cursor', async () => {
    const env = {
      IONOS_IMAP_HOST: '127.0.0.1',
      IONOS_IMAP_PORT: String(imap.port),
      IONOS_IMAP_TLS: 'false',
      IONOS_IMAP_USER: imap.user,
      IONOS_IMAP_PASSWORD: imap.password,
    };
    imap.commands.length = 0;
    const run = await runOnce(env);
    expect(run.status).toBe('COMPLETED');
    expect(run.output).toMatchObject({
      outcome: 'SUCCESS',
      new_entries: ['luis@cliente.example'],
      duplicates: ['ya@estaba.example'],
      counters: { messages_reviewed: 3, bajas_detected: 2, new_entries: 1, duplicates: 1, ignored_not_unsubscribe: 1 },
      cursor: { uid_validity: 1000, from_uid: 0, to_uid: 23, reset: false },
    });
    const md = (fake.tables.notes!.find((n) => n.id === note.id)!.bodyV2 as { markdown: string }).markdown;
    expect(md).toBe('ya@estaba.example — 2026-10-06 — manual\n\nluis@cliente.example — 2026-10-07 — baja solicitada (asunto: "Baja")\n');
    const state = await handle.db.query.inboundState.findFirst({ where: and(eq(inboundState.tenantId, tenant), eq(inboundState.consumer, 'bajas')) });
    expect(state).toMatchObject({ mailbox: `${imap.user}@127.0.0.1/INBOX`, uidValidity: 1000, lastUid: 23 });
    // Read-only on the wire.
    const verbs = imap.verbs().join('\n');
    expect(verbs).toMatch(/^EXAMINE /m);
    expect(verbs).not.toMatch(/\b(?:STORE|EXPUNGE|CLOSE|MOVE|COPY|DELETE|APPEND|SELECT)\b/i);

    // Trace: imap.fetch + get_note + update_note, counters in the final output.
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.taskRunId, run.id) });
    const steps = await handle.db.query.traceSteps.findMany({ where: eq(traceSteps.traceId, trace!.id), orderBy: traceSteps.sequence });
    expect(steps.map((s) => s.tool ?? s.type)).toEqual(['THINK', 'imap.fetch', 'get_note', 'update_note', 'FINAL']);

    // Next run: nothing new, nothing written.
    const patches = fake.count('PATCH', 'notes');
    const again = await runOnce(env);
    expect(again.output).toMatchObject({ outcome: 'SUCCESS', counters: { messages_reviewed: 0 }, cursor: { from_uid: 23, to_uid: 23 } });
    expect(fake.count('PATCH', 'notes')).toBe(patches);
  });
});
