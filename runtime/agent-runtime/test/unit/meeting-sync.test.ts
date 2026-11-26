/**
 * MeetingSyncAgent (tanda 22) against a fake Twenty and an in-memory store (no database, no LLM):
 * no calendar channel -> SKIPPED at cost zero; a meeting with a prospect moves its open
 * Opportunity to MEETING (only forward) with a 📅 note, a 🧾 task and an audit mark; idempotent;
 * never touches later or closed opportunities; never writes a calendar object.
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { MEETING_SYNC_IMPLEMENTATION, MEETING_SYNC_TOOLS, MeetingSyncAgent } from '../../src/agents/meeting-sync-agent.js';
import { resolveAgentImplementation } from '../../src/agents/stub-agent.js';
import type { AuditInsert } from '../../src/audit/service.js';
import type { PublishEventInput } from '../../src/events/event-bus.js';
import { EventEnvelopeSchema, OPPORTUNITY_EVENT_TYPES } from '../../src/events/envelope.js';
import { MemoryMeetingSyncStore } from '../../src/meetings/meeting-store.js';
import { MEETING_SYNC_AUDIT_ACTION } from '../../src/meetings/meeting-sync.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredMeetingSyncTask, desiredMeetingSyncVersion, MEETING_SYNC_CRON, MEETING_SYNC_TASK_NAME } from '../../src/seed/meeting-sync-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const TENANT = 'publiexpe';
/** Wednesday 2026-11-25, 15:00 in Madrid. */
const NOW = new Date('2026-11-25T14:00:00Z');
const CALENDAR = ['calendarEvents', 'calendarEventParticipants', 'calendarChannelEventAssociations'];

function setup(opts: { expand?: boolean } = {}) {
  const fake = new FakeTwenty();
  fake.expandRelations = opts.expand ?? false;
  const store = new MemoryMeetingSyncStore();
  const audits: AuditInsert[] = [];
  const events: PublishEventInput[] = [];
  const configuration = desiredMeetingSyncVersion().configuration;
  const registry = createDefaultToolRegistry({ twenty: fake.client() });
  let now = NOW;
  const agent = new MeetingSyncAgent({
    store,
    audit: async (row) => {
      audits.push(row);
      store.rows.push({ tenantId: row.tenantId, opportunityId: String(row.subjectId), eventKey: String((row.payload as Record<string, unknown>).event_key) });
    },
    events: {
      publish: async () => {
        throw new Error('not used');
      },
      emit: async (e) => {
        events.push(e);
        return null;
      },
    },
    env: {},
    clock: () => now,
    twentyBaseUrl: 'http://twenty.test',
  });
  let n = 0;
  const run = () => {
    const executionId = `exec-${++n}`;
    const tools = new ToolExecutor(registry, parseToolPolicy(configuration), { tenantId: TENANT, executionId, agentId: 'agent-ms', stage: 'MEETING_SYNC', logger: { info() {}, error() {} } }, new AbortController().signal);
    const ctx: AgentContext = {
      tenantId: TENANT,
      executionId,
      agent: { id: 'agent-ms', name: 'MeetingSyncAgent', role: 'meeting_sync' },
      version: { id: 'v1', version: 1, model: 'none', modelProvider: 'stub', systemPrompt: '', configuration },
      input: {},
      provider: new StubProvider(),
      signal: new AbortController().signal,
      tools,
    };
    return agent.run(ctx);
  };
  const company = (name: string, domain: string) => fake.seed('companies', { name, domainName: { primaryLinkUrl: domain, primaryLinkLabel: '', secondaryLinks: [] } });
  const person = (companyId: unknown, email: string, first = 'Ana') => fake.seed('people', { name: { firstName: first, lastName: '' }, emails: { primaryEmail: email, additionalEmails: [] }, companyId });
  const opportunity = (rec: Record<string, unknown>) => fake.seed('opportunities', { name: 'Op', stage: 'NEW', amount: null, closeDate: null, pointOfContactId: null, ...rec });
  const meeting = (startsAt: string, endsAt: string, handles: Array<string | [string, Record<string, unknown>]>, over: Record<string, unknown> = {}) => {
    const e = fake.seed('calendarEvents', { title: 'Reunión merchandising', startsAt, endsAt, isCanceled: false, isFullDay: false, location: null, iCalUid: null, conferenceLink: null, ...over });
    fake.seed('calendarChannelEventAssociations', { calendarChannelId: 'ch1', calendarEventId: e.id });
    fake.seed('calendarEventParticipants', { calendarEventId: e.id, handle: 'jesus.abril@publiexpe.info', displayName: 'Jesús', isOrganizer: true, responseStatus: 'ACCEPTED', personId: null, workspaceMemberId: 'wm1' });
    for (const h of handles) {
      const [handle, extra] = typeof h === 'string' ? [h, {}] : h;
      fake.seed('calendarEventParticipants', { calendarEventId: e.id, handle, displayName: null, isOrganizer: false, responseStatus: 'ACCEPTED', personId: null, workspaceMemberId: null, ...extra });
    }
    return e;
  };
  const calendarWrites = () => fake.requests.filter((r) => r.method !== 'GET' && CALENDAR.some((c) => r.path.startsWith(`/rest/${c}`)));
  return { fake, store, audits, events, run, company, person, opportunity, meeting, calendarWrites, setNow: (d: string) => (now = new Date(d)) };
}

describe('MeetingSyncAgent', () => {
  it('without a synced calendar channel: SKIPPED no_calendar_channel, one read, nothing else', async () => {
    const s = setup();
    const c = s.company('Cliente SA', 'cliente.example');
    s.opportunity({ companyId: c.id });
    const r = await s.run();
    expect(r.output).toMatchObject({ outcome: 'SKIPPED', reason: 'no_calendar_channel', cost: { model: 0, eur: 0, llm_calls: 0 }, writes_calendar: false });
    expect(r.modelCost).toBe(0);
    expect(s.fake.requests.every((q) => q.method === 'GET' && q.path.startsWith('/rest/calendar'))).toBe(true);
    expect(s.fake.count('GET', 'opportunities')).toBe(0);
  });

  it('calendar objects hidden from the role: SKIPPED calendar_unreadable', async () => {
    const s = setup();
    s.fake.hiddenObjects.add('calendarChannelEventAssociations');
    s.fake.hiddenObjects.add('calendarEvents');
    expect((await s.run()).output).toMatchObject({ outcome: 'SKIPPED', reason: 'calendar_unreadable', code: 'TWENTY_BAD_REQUEST' });
  });

  for (const expand of [false, true]) {
    it(`detects the meeting: NEW -> MEETING, 📅 note, 🧾 task due the working day before, audit + event (depth expansion ${expand})`, async () => {
      const s = setup({ expand });
      const c = s.company('Cliente SA', 'cliente.example');
      const ana = s.person(c.id, 'ana@cliente.example');
      const h = s.fake.seed('commercialHypotheses', { name: 'Cliente SA — Anuga', status: 'VALIDATED', tenantId: TENANT, companyId: c.id });
      s.fake.seed('commercialHypotheses', { name: 'De otro tenant', status: 'VALIDATED', tenantId: 'otro', companyId: c.id });
      const o = s.opportunity({ companyId: c.id, pointOfContactId: ana.id, name: 'Cliente SA — Anuga' });
      // Monday 30 at 10:00 Madrid.
      const e = s.meeting('2026-11-30T09:00:00.000Z', '2026-11-30T09:45:00.000Z', [['Ana@Cliente.example', { displayName: 'Ana' }]], { iCalUid: 'uid-1', conferenceLink: { primaryLinkUrl: 'https://meet.example/abc', primaryLinkLabel: '', secondaryLinks: [] } });

      const r = await s.run();
      expect(r.output).toMatchObject({ outcome: 'SUCCESS', counters: { events: 1, opportunities: 1, matches: 1, detected: 1, stage_moved: 1, tasks_created: 1 } });
      expect(o.stage).toBe('MEETING');
      const note = s.fake.tables.notes[0]!;
      expect(note.title).toBe('Reunión detectada — 2026-11-30 10:00 📅');
      expect((note.bodyV2 as { markdown: string }).markdown).toContain('📅 Reunión detectada en tu calendario: 2026-11-30 10:00–10:45 (Europe/Madrid), Reunión merchandising');
      expect(s.fake.tables.noteTargets.map((t) => t.targetOpportunityId ?? t.targetCompanyId).sort()).toEqual([o.id, c.id].sort());
      const task = s.fake.tables.tasks[0]!;
      expect(task.title).toBe('Preparar reunión con Cliente SA 🧾');
      // Friday 27, 09:00 Madrid.
      expect(task.dueAt).toBe('2026-11-27T08:00:00.000Z');
      const body = (task.bodyV2 as { markdown: string }).markdown;
      expect(body).toContain('- Asistentes: Ana ana@cliente.example');
      expect(body).toContain(`http://twenty.test/object/company/${String(c.id)}`);
      expect(body).toContain(`http://twenty.test/object/opportunity/${String(o.id)}`);
      expect(body).toContain(`http://twenty.test/object/commercialHypothesis/${String(h.id)}`);
      expect(body).not.toContain('De otro tenant');
      expect(s.fake.tables.taskTargets.map((t) => t.targetOpportunityId ?? t.targetCompanyId).sort()).toEqual([o.id, c.id].sort());
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({ action: MEETING_SYNC_AUDIT_ACTION, subjectType: 'opportunity', subjectId: o.id, payload: { event_key: 'ical:uid-1', event_id: e.id, stage_from: 'NEW', stage_to: 'MEETING', via: 'point_of_contact' } });
      expect(s.events).toHaveLength(1);
      expect(s.events[0]).toMatchObject({ type: 'opportunity.meeting_detected', idempotencyKey: `evt:opportunity.meeting_detected:${String(o.id)}:ical:uid-1`, data: { opportunityId: o.id, stageFrom: 'NEW', stageTo: 'MEETING' } });
      expect(JSON.stringify(s.events[0]!.data)).not.toContain('@');
      expect(s.calendarWrites()).toEqual([]);

      // Second run: nothing new. Deleted by hand and moved back: still nothing (audit mark).
      const again = await s.run();
      expect(again.output).toMatchObject({ outcome: 'SUCCESS', counters: { detected: 0, skipped_by: { already_detected: 1 } } });
      s.fake.tables.notes.length = 0;
      s.fake.tables.tasks.length = 0;
      o.stage = 'SCREENING';
      await s.run();
      expect(o.stage).toBe('SCREENING');
      expect(s.fake.tables.notes).toHaveLength(0);
      expect(s.fake.tables.tasks).toHaveLength(0);
      expect(s.audits).toHaveLength(1);
    });
  }

  it('never touches later, MEETING (without our note) or closed opportunities; free-mail domains never match', async () => {
    const s = setup();
    const later = s.company('Avanzada SL', 'avanzada.example');
    const atMeeting = s.company('Reunida SL', 'reunida.example');
    const closed = s.company('Cerrada SL', 'cerrada.example');
    const free = s.company('Gmail Fan SL', 'gmail.com');
    const oLater = s.opportunity({ companyId: later.id, stage: 'PROPOSAL' });
    const oAt = s.opportunity({ companyId: atMeeting.id, stage: 'MEETING' });
    const oClosed = s.opportunity({ companyId: closed.id, stage: 'CUSTOMER' });
    const oFree = s.opportunity({ companyId: free.id, stage: 'NEW' });
    s.meeting('2026-11-30T09:00:00.000Z', '2026-11-30T10:00:00.000Z', ['x@avanzada.example', 'y@reunida.example', 'z@cerrada.example', 'w@gmail.com']);
    const r = await s.run();
    expect(r.output).toMatchObject({ outcome: 'SUCCESS', counters: { matches: 2, detected: 0, skipped_by: { past_meeting: 1, at_meeting: 1 } } });
    expect([oLater.stage, oAt.stage, oClosed.stage, oFree.stage]).toEqual(['PROPOSAL', 'MEETING', 'CUSTOMER', 'NEW']);
    expect(s.fake.requests.filter((q) => q.method !== 'GET')).toEqual([]);
    expect(s.audits).toEqual([]);
  });

  it('a meeting that already happened (yesterday) moves the stage and leaves the note, but no task', async () => {
    const s = setup();
    const c = s.company('Ayer SA', 'ayer.example');
    const o = s.opportunity({ companyId: c.id, stage: 'SCREENING' });
    s.meeting('2026-11-24T16:00:00.000Z', '2026-11-24T16:30:00.000Z', ['pepe@ayer.example']);
    const r = await s.run();
    expect(r.output).toMatchObject({ counters: { detected: 1, tasks_created: 0 } });
    expect(o.stage).toBe('MEETING');
    expect(s.fake.tables.notes).toHaveLength(1);
    expect(s.fake.tables.tasks).toHaveLength(0);
    expect(s.audits[0]!.payload).toMatchObject({ via: 'domain', task_id: null });
  });

  it('one meeting per opportunity and run: the next one to come', async () => {
    const s = setup();
    const c = s.company('Dos SA', 'dos.example');
    const p = s.person(c.id, 'eva@dos.example', 'Eva');
    s.opportunity({ companyId: c.id });
    s.meeting('2026-12-10T09:00:00.000Z', '2026-12-10T10:00:00.000Z', ['eva@dos.example']);
    s.meeting('2026-12-01T09:00:00.000Z', '2026-12-01T10:00:00.000Z', [['otra@dos.example', { personId: p.id }]]);
    const r = await s.run();
    expect(r.output).toMatchObject({ counters: { matches: 2, detected: 1, skipped_by: { other_meeting_this_run: 1 } } });
    expect(s.fake.tables.notes[0]!.title).toBe('Reunión detectada — 2026-12-01 10:00 📅');
  });

  it('resumes a run that stopped after the stage move: the task is still created', async () => {
    const s = setup();
    const c = s.company('Resume SA', 'resume.example');
    const o = s.opportunity({ companyId: c.id, stage: 'MEETING' });
    s.meeting('2026-12-01T09:00:00.000Z', '2026-12-01T10:00:00.000Z', ['ana@resume.example']);
    // A note with the pre-tanda 23 title (emoji first) is found too.
    const note = s.fake.seed('notes', { title: '📅 Reunión detectada — 2026-12-01 10:00', bodyV2: { markdown: 'x', blocknote: null } });
    s.fake.seed('noteTargets', { noteId: note.id, targetOpportunityId: o.id, targetCompanyId: null });
    const r = await s.run();
    expect(r.output).toMatchObject({ counters: { detected: 1, stage_moved: 0, tasks_created: 1 } });
    expect(s.fake.tables.notes).toHaveLength(1);
    expect(s.audits).toHaveLength(1);
  });

  it('seed spec: no LLM, CRON every 30 minutes in Madrid, only the meeting tools', () => {
    const v = desiredMeetingSyncVersion();
    expect(v).toMatchObject({ modelProvider: 'stub', configuration: { implementation: MEETING_SYNC_IMPLEMENTATION } });
    expect((v.configuration.tool_policy as { allow: string[] }).allow).toEqual([...MEETING_SYNC_TOOLS]);
    expect(desiredMeetingSyncTask()).toMatchObject({ schedule: { type: 'CRON', expression: MEETING_SYNC_CRON }, timezone: 'Europe/Madrid', enabled: true, maxConcurrency: 1 });
    expect(MEETING_SYNC_CRON).toBe('*/30 * * * *');
    expect(MEETING_SYNC_TASK_NAME).toBe('meeting-sync');
    expect(resolveAgentImplementation({ implementation: MEETING_SYNC_IMPLEMENTATION }).kind).toBe(MEETING_SYNC_IMPLEMENTATION);
    expect(OPPORTUNITY_EVENT_TYPES).toContain('opportunity.meeting_detected');
    expect(
      EventEnvelopeSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000000',
        type: 'opportunity.meeting_detected',
        schemaVersion: 'opportunity.meeting_detected.v1',
        tenantId: TENANT,
        occurredAt: NOW.toISOString(),
        producer: 'agent-runtime',
        correlationId: 'x',
        data: {},
      }).success,
    ).toBe(true);
  });
});
