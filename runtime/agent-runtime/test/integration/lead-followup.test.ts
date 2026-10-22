/**
 * Lead follow-up end to end against a real PostgreSQL (no Redis, no LLM): seed
 * `lead-followup-check` -> TaskRun -> RunProcessor -> FollowUpAgent -> `email_sends`,
 * `inbound_triage` and `audit_log` read by the Drizzle store -> 🔔 task in a fake Twenty ->
 * `lead.followup_task` audit row. Fresh tenant per run, no DELETE. Skipped when the database is
 * not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOLLOWUP_AUDIT_ACTION } from '../../src/crm/followup.js';
import { DrizzleFollowUpStore } from '../../src/crm/followup-store.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, inboundTriage, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { recordEmailSend } from '../../src/email-ops/sends.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { FOLLOWUP_TASK_NAME, seedFollowUp } from '../../src/seed/followup-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
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

const DAY = 86_400_000;

describe.skipIf(!dbAvailable)('lead follow-up: lead-followup-check -> FollowUpAgent -> 🔔 task + audit (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  fake.seed('notes', { id: SUPPRESSION_NOTE_ID, title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: 'nadie@suprimido.example — 2026-10-06 — manual', blocknote: '[bn]' } });
  const quiet = fake.seed('companies', { name: 'Callada SA' });
  const talks = fake.seed('companies', { name: 'Contesta SL' });
  const hyp = (companyId: unknown, emailTo: string) =>
    fake.seed('commercialHypotheses', { name: 'H', status: 'VALIDATED', tenantId: tenant, companyId, emailStatus: 'SENT', emailTo, emailSubject: 'Material', need: 'Bolsas', whyNow: 'Feria' });
  const hQuiet = hyp(quiet.id, 'ana@callada.example');
  const hTalks = hyp(talks.id, 'luis@contesta.example');
  const hRecent = hyp(quiet.id, 'eva@callada.example');
  let handle: DbHandle;
  // Three weeks ago: due whatever today's weekday is.
  const longAgo = new Date(Date.now() - 21 * DAY);

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    const send = (hypothesisId: unknown, companyId: unknown, toEmail: string, sentAt: Date) =>
      recordEmailSend(handle.db, { tenantId: tenant, hypothesisId: String(hypothesisId), companyId: String(companyId), toEmail, toDomain: toEmail.split('@')[1]!, subject: 'Material', sentAt, workspaceMemberId: null });
    await send(hQuiet.id, quiet.id, 'ana@callada.example', longAgo);
    await send(hTalks.id, talks.id, 'luis@contesta.example', longAgo);
    await send(hRecent.id, quiet.id, 'eva@callada.example', new Date(Date.now() - 60_000));
    // The InboxAgent triaged an answer of Contesta SL (linked by the send it answers).
    await handle.db.insert(inboundTriage).values({
      tenantId: tenant,
      messageKey: `mid:${randomUUID()}`,
      mailbox: 'x@127.0.0.1/INBOX',
      uidValidity: 1,
      uid: 1,
      receivedAt: new Date(longAgo.getTime() + DAY),
      fromEmail: 'luis@contesta.example',
      fromDomain: 'contesta.example',
      class: 'NO_INTERESADO',
      method: 'LLM',
      companyId: String(talks.id),
      hypothesisId: String(hTalks.id),
      matchBy: 'email',
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function runOnce() {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, FOLLOWUP_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it:${randomUUID()}` });
    const processor = new RunProcessor(handle.db, () => new StubProvider(), undefined, createDefaultToolRegistry({ twenty: fake.client({ ownerTenantId: tenant }) }), null);
    for (const { job } of queue.drain()) await processor.process(job);
    return (await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) }))!;
  }

  const audited = () =>
    handle.db
      .select({ subjectId: auditLog.subjectId, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant), eq(auditLog.action, FOLLOWUP_AUDIT_ACTION)));

  it('seeds lead-followup-check idempotently (CRON 08:30 Europe/Madrid)', async () => {
    expect(await seedFollowUp(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'created', taskAction: 'created' });
    expect(await seedFollowUp(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged' });
    const t = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, FOLLOWUP_TASK_NAME)) });
    expect(t).toMatchObject({ schedule: { type: 'CRON', expression: '30 8 * * *' }, timezone: 'Europe/Madrid', enabled: true });
  });

  it('creates the task for the silent send only, audits it, and never repeats it', async () => {
    const run = await runOnce();
    expect(run.status).toBe('COMPLETED');
    expect(run.output).toMatchObject({ outcome: 'SUCCESS', sends_email: false, counters: { sent_hypotheses: 3, tasks_created: 1, skipped_by: { replied: 1, too_recent: 1 } } });
    expect(fake.tables.tasks.map((t) => t.title)).toEqual(['🔔 Seguimiento — Callada SA']);
    const targets = fake.tables.taskTargets.filter((t) => t.taskId === fake.tables.tasks[0]!.id);
    expect(targets.map((t) => t.targetCompanyId ?? t.targetCommercialHypothesisId).sort()).toEqual([String(quiet.id), String(hQuiet.id)].sort());
    const rows = await audited();
    expect(rows.map((r) => r.subjectId)).toEqual([hQuiet.id]);
    expect(rows[0]!.payload).toMatchObject({ task_id: fake.tables.tasks[0]!.id, task_created: true });

    // Deleted in Twenty: the audit row still says «done».
    fake.tables.tasks.length = 0;
    const again = await runOnce();
    expect(again.output).toMatchObject({ outcome: 'SUCCESS', counters: { tasks_created: 0, skipped_by: { task_exists: 1 } } });
    expect(fake.tables.tasks).toHaveLength(0);
    expect(await audited()).toHaveLength(1);
  });

  it('the Drizzle store reads the replies linked by company too, and only after the send', async () => {
    const store = new DrizzleFollowUpStore(handle.db);
    expect((await store.replies(tenant, { hypothesisId: 'other', companyIds: [String(talks.id)], since: longAgo })).map((r) => r.class)).toEqual(['NO_INTERESADO']);
    expect(await store.replies(tenant, { hypothesisId: String(hTalks.id), companyIds: [], since: new Date() })).toEqual([]);
    expect((await store.sends(tenant, [String(hQuiet.id)])).map((s) => s.toEmail)).toEqual(['ana@callada.example']);
    expect([...(await store.alreadyFollowedUp(tenant, [String(hQuiet.id), String(hTalks.id)]))]).toEqual([hQuiet.id]);
  });
});
