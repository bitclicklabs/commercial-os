/**
 * Meeting sync end to end against a real PostgreSQL (no Redis, no LLM): seed `meeting-sync` ->
 * TaskRun -> RunProcessor -> MeetingSyncAgent -> fake Twenty calendar -> MEETING stage, 📅 note,
 * 🧾 task -> `opportunity.meeting_detected` audit row read back by the Drizzle store. Fresh tenant
 * per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { DrizzleMeetingSyncStore, detectionKey } from '../../src/meetings/meeting-store.js';
import { MEETING_SYNC_AUDIT_ACTION } from '../../src/meetings/meeting-sync.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { MEETING_SYNC_TASK_NAME, seedMeetingSync } from '../../src/seed/meeting-sync-seed.js';
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

describe.skipIf(!dbAvailable)('meeting sync: meeting-sync -> MeetingSyncAgent -> MEETING + 📅 + 🧾 + audit (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  const company = fake.seed('companies', { name: 'Reunión SA', domainName: { primaryLinkUrl: 'reunion.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const opp = fake.seed('opportunities', { name: 'Reunión SA', stage: 'SCREENING', companyId: company.id, pointOfContactId: null });
  // In ten days (always a future meeting, whatever today is).
  const start = new Date(Date.now() + 10 * DAY);
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function runOnce() {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, MEETING_SYNC_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it:${randomUUID()}` });
    const processor = new RunProcessor(handle.db, () => new StubProvider(), undefined, createDefaultToolRegistry({ twenty: fake.client({ ownerTenantId: tenant }) }), null);
    for (const { job } of queue.drain()) await processor.process(job);
    return (await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) }))!;
  }

  it('seeds meeting-sync idempotently (CRON every 30 minutes, Europe/Madrid)', async () => {
    expect(await seedMeetingSync(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'created', taskAction: 'created' });
    expect(await seedMeetingSync(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged' });
    const t = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, MEETING_SYNC_TASK_NAME)) });
    expect(t).toMatchObject({ schedule: { type: 'CRON', expression: '*/30 * * * *' }, timezone: 'Europe/Madrid', enabled: true });
  });

  it('without a calendar channel the run is SKIPPED (no_calendar_channel) and writes nothing', async () => {
    const run = await runOnce();
    expect(run.status).toBe('COMPLETED');
    expect(run.output).toMatchObject({ outcome: 'SKIPPED', reason: 'no_calendar_channel', cost: { eur: 0 } });
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('detects the meeting once, audits it and never repeats it', async () => {
    const e = fake.seed('calendarEvents', { title: 'Merch para la feria', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3_600_000).toISOString(), isCanceled: false, isFullDay: false, iCalUid: 'uid-it' });
    fake.seed('calendarChannelEventAssociations', { calendarChannelId: 'ch', calendarEventId: e.id });
    fake.seed('calendarEventParticipants', { calendarEventId: e.id, handle: 'luis@reunion.example', displayName: 'Luis', isOrganizer: false, responseStatus: 'ACCEPTED', personId: null, workspaceMemberId: null });
    const run = await runOnce();
    expect(run.status).toBe('COMPLETED');
    expect(run.output).toMatchObject({ outcome: 'SUCCESS', counters: { detected: 1, stage_moved: 1, tasks_created: 1 } });
    expect(opp.stage).toBe('MEETING');
    expect(fake.tables.tasks.map((t) => t.title)).toEqual(['🧾 Preparar reunión con Reunión SA']);
    const rows = await handle.db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenant), eq(auditLog.action, MEETING_SYNC_AUDIT_ACTION)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: 'opportunity', subjectId: opp.id, actor: 'agent', result: 'ok', payload: { event_key: 'ical:uid-it', stage_from: 'SCREENING', stage_to: 'MEETING' } });
    expect([...(await new DrizzleMeetingSyncStore(handle.db).alreadyDetected(tenant, [String(opp.id), 'other']))]).toEqual([detectionKey(String(opp.id), 'ical:uid-it')]);

    // Moved back and the task deleted by hand: the audit mark stops a second detection.
    opp.stage = 'NEW';
    fake.tables.tasks.length = 0;
    const again = await runOnce();
    expect(again.output).toMatchObject({ outcome: 'SUCCESS', counters: { detected: 0, skipped_by: { already_detected: 1 } } });
    expect(opp.stage).toBe('NEW');
    expect(fake.tables.tasks).toHaveLength(0);
    expect(fake.requests.filter((r) => r.method !== 'GET' && r.path.startsWith('/rest/calendar'))).toEqual([]);
  });
});
