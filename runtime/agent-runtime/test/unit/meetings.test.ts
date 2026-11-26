/**
 * Meetings (tanda 22): configuration, free slots, the calendar availability against a fake Twenty
 * (calendar present, absent, hidden, unreadable) and the event <-> opportunity matching. No
 * database, no LLM. The calendar is only read: no test here may see a write to a calendar object.
 */
import { describe, expect, it } from 'vitest';
import {
  CalendarAvailability,
  computeSlots,
  DEFAULT_MEETING_HOURS,
  LinkAvailability,
  meetingAvailabilityFromEnv,
  meetingConfigFromEnv,
  NULL_AVAILABILITY,
  parseMeetingHours,
  readCalendarEvents,
  zonedIso,
  type CalendarEventView,
  type MeetingConfig,
} from '../../src/meetings/index.js';
import { matchMeetings, type OpenOpportunityView } from '../../src/meetings/match.js';
import { meetingNoteBody, meetingStageOf, meetingTaskBody, meetingTaskTitle, prepDueDay, stageVerdict } from '../../src/meetings/meeting-sync.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const TZ = 'Europe/Madrid';
/** Wednesday 2026-11-25, 15:00 in Madrid (CET, +01:00). */
const NOW = new Date('2026-11-25T14:00:00Z');
const cfg = (env: NodeJS.ProcessEnv = {}): MeetingConfig => meetingConfigFromEnv(env);

function ev(over: Partial<CalendarEventView> & { startsAt: string }): CalendarEventView {
  return { id: over.id ?? `e-${over.startsAt}`, title: 'Algo', endsAt: null, isCanceled: false, isFullDay: false, location: null, conferenceUrl: null, iCalUid: null, participants: [], ...over };
}

describe('meeting configuration', () => {
  it('defaults are safe and invalid values fall back', () => {
    const c = cfg();
    expect(c).toMatchObject({ timezone: TZ, horizonDays: 7, durationMin: 30, bufferMin: 15, bookingUrl: null, videoUrl: null, internalDomains: ['publiexpe.info', 'publiexpe.com'] });
    expect(c.bands).toEqual(parseMeetingHours(DEFAULT_MEETING_HOURS));
    expect(c.bands).toEqual([
      { startMin: 600, endMin: 810 },
      { startMin: 960, endMin: 1080 },
    ]);
    const bad = cfg({ MEETING_HORIZON_DAYS: '0', MEETING_DURATION_MIN: '5', MEETING_HOURS: '18:00-10:00', MEETING_BOOKING_URL: 'javascript:alert(1)', MEETING_VIDEO_URL: 'nada' });
    expect(bad).toMatchObject({ horizonDays: 7, durationMin: 30, bookingUrl: null, videoUrl: null });
    expect(bad.bands).toEqual(c.bands);
    const custom = cfg({ MEETING_HORIZON_DAYS: '10', MEETING_DURATION_MIN: '45', MEETING_HOURS: '16:00-19:00, 09:30-12:00', MEETING_BOOKING_URL: 'https://cal.example/jesus', MEETING_VIDEO_URL: 'https://meet.example/abc', MEETING_INTERNAL_DOMAINS: '@publiexpe.info' });
    expect(custom).toMatchObject({ horizonDays: 10, durationMin: 45, bookingUrl: 'https://cal.example/jesus', videoUrl: 'https://meet.example/abc', internalDomains: ['publiexpe.info'] });
    expect(custom.bands).toEqual([
      { startMin: 570, endMin: 720 },
      { startMin: 960, endMin: 1140 },
    ]);
    expect(parseMeetingHours('10:00-12:00,11:00-13:00')).toBeNull();
  });

  it('formats instants with the Madrid offset (winter and summer)', () => {
    expect(zonedIso(new Date('2026-11-26T09:00:00Z'), TZ)).toBe('2026-11-26T10:00:00+01:00');
    expect(zonedIso(new Date('2026-06-10T08:30:00Z'), TZ)).toBe('2026-06-10T10:30:00+02:00');
  });
});

describe('computeSlots', () => {
  it('empty calendar: one morning slot per working day, from the next working day', () => {
    const slots = computeSlots({ now: NOW, count: 3, config: cfg(), events: [] });
    expect(slots).toEqual([
      { start: '2026-11-26T10:00:00+01:00', end: '2026-11-26T10:30:00+01:00' },
      { start: '2026-11-27T10:00:00+01:00', end: '2026-11-27T10:30:00+01:00' },
      { start: '2026-11-30T10:00:00+01:00', end: '2026-11-30T10:30:00+01:00' },
    ]);
    // A Friday afternoon: Monday, Tuesday, Wednesday (never the weekend).
    const friday = computeSlots({ now: new Date('2026-11-27T16:00:00Z'), count: 3, config: cfg(), events: [] });
    expect(friday.map((s) => s.start.slice(0, 10))).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
  });

  it('keeps 15 minutes around events, skips full-day events, ignores cancelled and declined ones', () => {
    const events = [
      // Thursday 10:00-11:00 -> busy 09:45-11:15 -> first slot 11:30.
      ev({ startsAt: '2026-11-26T09:00:00Z', endsAt: '2026-11-26T10:00:00Z' }),
      // Friday all day.
      ev({ startsAt: '2026-11-27T00:00:00.000Z', endsAt: '2026-11-28T00:00:00.000Z', isFullDay: true }),
      // Monday morning fully busy -> 16:00.
      ev({ startsAt: '2026-11-30T08:00:00Z', endsAt: '2026-11-30T13:00:00Z' }),
      // Cancelled and declined by the team: free.
      ev({ startsAt: '2026-12-01T09:00:00Z', endsAt: '2026-12-01T12:00:00Z', isCanceled: true }),
      ev({
        startsAt: '2026-12-02T09:00:00Z',
        endsAt: '2026-12-02T12:00:00Z',
        participants: [{ handle: 'jesus.abril@publiexpe.info', displayName: 'Jesús', isOrganizer: false, responseStatus: 'DECLINED', personId: null, workspaceMemberId: 'wm1' }],
      }),
    ];
    const slots = computeSlots({ now: NOW, count: 5, config: cfg(), events });
    expect(slots.map((s) => s.start)).toEqual(['2026-11-26T11:30:00+01:00', '2026-11-30T16:00:00+01:00', '2026-12-01T10:00:00+01:00', '2026-12-02T10:00:00+01:00']);
  });

  it('never proposes two slots the same day and stops at the horizon', () => {
    const slots = computeSlots({ now: NOW, count: 10, config: cfg({ MEETING_HORIZON_DAYS: '3' }), events: [] });
    // Thursday, Friday (Saturday 28 is the horizon).
    expect(slots.map((s) => s.start.slice(0, 10))).toEqual(['2026-11-26', '2026-11-27']);
    expect(new Set(slots.map((s) => s.start.slice(0, 10))).size).toBe(slots.length);
    expect(computeSlots({ now: NOW, count: 0, config: cfg(), events: [] })).toEqual([]);
  });

  it('a meeting must end inside the band', () => {
    const c = cfg({ MEETING_HOURS: '10:00-10:45', MEETING_DURATION_MIN: '45' });
    expect(computeSlots({ now: NOW, count: 1, config: c, events: [ev({ startsAt: '2026-11-26T09:20:00Z', endsAt: '2026-11-26T09:25:00Z' })] })[0]!.start).toBe('2026-11-27T10:00:00+01:00');
  });
});

describe('CalendarAvailability (fake Twenty, read only)', () => {
  const withCalendar = () => {
    const fake = new FakeTwenty();
    const event = fake.seed('calendarEvents', { title: 'Comité', startsAt: '2026-11-26T09:00:00.000Z', endsAt: '2026-11-26T10:00:00.000Z', isCanceled: false, isFullDay: false });
    fake.seed('calendarChannelEventAssociations', { calendarChannelId: 'ch1', calendarEventId: event.id });
    return fake;
  };
  const noWrites = (fake: FakeTwenty) => expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);

  it('source calendar: slots around the events actually read', async () => {
    const fake = withCalendar();
    const a = new CalendarAvailability(fake.client(), cfg({ MEETING_VIDEO_URL: 'https://meet.example/sala' }));
    const p = await a.propose({ now: NOW, count: 3 });
    expect(p).toMatchObject({ source: 'calendar', durationMin: 30, bookingUrl: null, videoUrl: 'https://meet.example/sala' });
    expect(p.slots.map((s) => s.start)).toEqual(['2026-11-26T11:30:00+01:00', '2026-11-27T10:00:00+01:00', '2026-11-30T10:00:00+01:00']);
    // Cached: a second proposal does not read the calendar again.
    const before = fake.requests.length;
    await a.propose({ now: NOW, count: 2 });
    expect(fake.requests.length).toBe(before);
    noWrites(fake);
  });

  it('no synced channel: no slots invented; the booking link if there is one', async () => {
    const fake = new FakeTwenty();
    fake.seed('calendarEvents', { title: 'Suelto', startsAt: '2026-11-26T09:00:00.000Z', endsAt: '2026-11-26T10:00:00.000Z' });
    expect(await new CalendarAvailability(fake.client(), cfg()).propose({ now: NOW, count: 3 })).toEqual({ slots: [], bookingUrl: null, videoUrl: null, durationMin: 30, source: 'none' });
    const link = new CalendarAvailability(fake.client(), cfg({ MEETING_BOOKING_URL: 'https://cal.example/jesus' }));
    expect(await link.propose({ now: NOW, count: 3 })).toMatchObject({ slots: [], bookingUrl: 'https://cal.example/jesus', source: 'link' });
    expect(link.lastDiagnostics).toEqual({ calendar: 'no_channel' });
    noWrites(fake);
  });

  it('associations hidden from the role: falls back to the events themselves; nothing readable -> link/none', async () => {
    const fake = withCalendar();
    fake.hiddenObjects.add('calendarChannelEventAssociations');
    const read = await readCalendarEvents(fake.client(), { from: new Date('2026-11-24T00:00:00Z'), to: new Date('2026-12-05T00:00:00Z') });
    expect(read).toMatchObject({ status: 'ok', probe: 'events' });
    fake.hiddenObjects.add('calendarEvents');
    const a = new CalendarAvailability(fake.client(), cfg({ MEETING_BOOKING_URL: 'https://cal.example/jesus' }));
    expect(await a.propose({ now: NOW, count: 3 })).toMatchObject({ slots: [], source: 'link' });
    expect(a.lastDiagnostics).toEqual({ calendar: 'unreadable', detail: 'TWENTY_BAD_REQUEST' });
  });

  it('participants come from depth=1 or from one batched read', async () => {
    for (const expand of [false, true]) {
      const fake = withCalendar();
      fake.expandRelations = expand;
      const e = fake.tables.calendarEvents[0]!;
      fake.seed('calendarEventParticipants', { calendarEventId: e.id, handle: 'Ana@Cliente.example', displayName: 'Ana', isOrganizer: false, responseStatus: 'ACCEPTED', personId: null, workspaceMemberId: null });
      const read = await readCalendarEvents(fake.client(), { from: new Date('2026-11-24T00:00:00Z'), to: new Date('2026-12-05T00:00:00Z') });
      expect(read.status).toBe('ok');
      if (read.status === 'ok') expect(read.events[0]!.participants).toEqual([{ handle: 'ana@cliente.example', displayName: 'Ana', isOrganizer: false, responseStatus: 'ACCEPTED', personId: null, workspaceMemberId: null }]);
      expect(fake.count('GET', 'calendarEventParticipants')).toBe(expand ? 0 : 1);
    }
  });

  it('meetingAvailabilityFromEnv: without an API key, the link (or nothing); NULL_AVAILABILITY proposes nothing', async () => {
    const a = meetingAvailabilityFromEnv({ TWENTY_API_KEY: '', MEETING_BOOKING_URL: 'https://cal.example/jesus' });
    expect(a).toBeInstanceOf(LinkAvailability);
    expect(await a.propose({ now: NOW, count: 3 })).toMatchObject({ source: 'link', slots: [] });
    expect(meetingAvailabilityFromEnv({}, { twenty: withCalendar().client() })).toBeInstanceOf(CalendarAvailability);
    expect(await NULL_AVAILABILITY.propose({ now: NOW, count: 3 })).toMatchObject({ slots: [], source: 'none' });
  });
});

describe('matchMeetings', () => {
  const opp = (over: Partial<OpenOpportunityView> & { id: string }): OpenOpportunityView => ({
    name: null,
    stage: 'NEW',
    createdAt: '2026-11-01T00:00:00Z',
    companyId: `c-${over.id}`,
    companyName: 'Cliente SA',
    companyDomain: 'cliente.example',
    pointOfContactId: null,
    pointOfContactName: null,
    pointOfContactEmails: [],
    companyPeople: [],
    hypotheses: [],
    ...over,
  });
  const p = (handle: string, over: Record<string, unknown> = {}) => ({ handle, displayName: null, isOrganizer: false, responseStatus: 'ACCEPTED', personId: null, workspaceMemberId: null, ...over });
  const INTERNAL = ['publiexpe.info'];

  it('point of contact > person of the company > domain; free-mail and own team never match', () => {
    const opps = [
      opp({ id: 'o1', pointOfContactId: 'p1', pointOfContactEmails: ['ana@cliente.example'] }),
      opp({ id: 'o2', companyDomain: 'otra.example', companyPeople: [{ id: 'p2', emails: ['luis@gmail.com'] }] }),
      opp({ id: 'o3', companyDomain: 'tercera.example' }),
      opp({ id: 'o4', companyDomain: 'gmail.com' }),
    ];
    const events = [
      ev({ id: 'a', startsAt: '2026-11-27T09:00:00Z', iCalUid: 'uid-a', participants: [p('jesus.abril@publiexpe.info'), p('ana@cliente.example')] }),
      ev({ id: 'b', startsAt: '2026-11-28T09:00:00Z', participants: [p('luis@gmail.com')] }),
      ev({ id: 'c', startsAt: '2026-11-29T09:00:00Z', participants: [p('marta@ventas.tercera.example')] }),
      ev({ id: 'd', startsAt: '2026-11-30T09:00:00Z', participants: [p('otro@gmail.com')] }),
      ev({ id: 'e', startsAt: '2026-12-01T09:00:00Z', participants: [p('ana@cliente.example', { responseStatus: 'DECLINED' })] }),
      ev({ id: 'f', startsAt: '2026-12-02T09:00:00Z', isCanceled: true, participants: [p('ana@cliente.example')] }),
      ev({ id: 'g', startsAt: '2026-12-03T09:00:00Z', participants: [p('x@publiexpe.info'), p('y@cliente.example', { workspaceMemberId: 'wm' })] }),
    ];
    const m = matchMeetings(events, opps, INTERNAL);
    expect(m.map((x) => [x.eventId, x.opportunityId, x.via, x.eventKey])).toEqual([
      ['a', 'o1', 'point_of_contact', 'ical:uid-a'],
      ['b', 'o2', 'company_person', 'event:b'],
      ['c', 'o3', 'domain', 'event:c'],
    ]);
    expect(m[0]!.matchedHandles).toEqual(['ana@cliente.example']);
  });

  it('several open opportunities of one company: the point-of-contact one, else the oldest', () => {
    const shared = { companyId: 'c1', companyDomain: 'cliente.example' };
    const opps = [opp({ id: 'new', ...shared, createdAt: '2026-11-10T00:00:00Z' }), opp({ id: 'old', ...shared, createdAt: '2026-10-01T00:00:00Z' }), opp({ id: 'poc', ...shared, createdAt: '2026-11-20T00:00:00Z', pointOfContactId: 'pp' })];
    expect(matchMeetings([ev({ id: 'a', startsAt: '2026-11-27T09:00:00Z', participants: [p('z@cliente.example')] })], opps, []).map((x) => x.opportunityId)).toEqual(['old']);
    expect(matchMeetings([ev({ id: 'a', startsAt: '2026-11-27T09:00:00Z', participants: [p('z@cliente.example', { personId: 'pp' })] })], opps, []).map((x) => x.opportunityId)).toEqual(['poc']);
  });
});

describe('meeting sync rules', () => {
  const STAGES = ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER'];

  it('only moves forward, up to MEETING; never from later, closed or unknown stages', () => {
    expect(meetingStageOf(STAGES)).toBe('MEETING');
    expect(meetingStageOf(['NUEVA', 'REUNION_AGENDADA', 'PROPUESTA'])).toBe('REUNION_AGENDADA');
    expect(meetingStageOf(['A', 'B'])).toBeNull();
    expect(stageVerdict('NEW', STAGES)).toBe('advance');
    expect(stageVerdict('SCREENING', STAGES)).toBe('advance');
    expect(stageVerdict(null, STAGES)).toBe('advance');
    expect(stageVerdict('MEETING', STAGES)).toBe('at_meeting');
    expect(stageVerdict('PROPOSAL', STAGES)).toBe('past_meeting');
    expect(stageVerdict('CUSTOMER', STAGES)).toBe('closed');
    expect(stageVerdict('LOST', [...STAGES, 'LOST'])).toBe('closed');
    expect(stageVerdict('RARA', STAGES)).toBe('unknown_stage');
    expect(stageVerdict('NEW', ['NEW', 'PROPOSAL'])).toBe('no_meeting_stage');
  });

  it('the task is due the working day before the meeting, never before today', () => {
    // Monday 30 at 10:00 -> Friday 27.
    expect(prepDueDay(new Date('2026-11-30T09:00:00Z'), NOW)).toBe('2026-11-27');
    // Thursday 26 at 10:00 -> Wednesday 25 (today).
    expect(prepDueDay(new Date('2026-11-26T09:00:00Z'), NOW)).toBe('2026-11-25');
    // Today at 18:00 -> today.
    expect(prepDueDay(new Date('2026-11-25T17:00:00Z'), NOW)).toBe('2026-11-25');
  });

  it('texts: title, note and task body with plain values and no promise to send anything', () => {
    expect(meetingTaskTitle('Cliente "SA"')).toBe('Preparar reunión con Cliente SA 🧾');
    expect(meetingTaskTitle(null)).toBe('Preparar reunión con la empresa 🧾');
    const base = { startsAt: new Date('2026-11-30T09:00:00Z'), endsAt: new Date('2026-11-30T09:30:00Z'), title: 'Demo **merch** [x](http://evil)', attendees: ['Ana <ana@cliente.example>'], location: null, conferenceUrl: 'https://meet.example/x' };
    const note = meetingNoteBody({ ...base, stageFrom: 'NEW', stageTo: 'MEETING', via: 'point_of_contact' });
    expect(note).toContain('📅 Reunión detectada en tu calendario: 2026-11-30 10:00–10:30 (Europe/Madrid), Demo merch xhttp://evil');
    expect(note).toContain('- Videollamada: https://meet.example/x');
    expect(meetingNoteBody({ ...base, conferenceUrl: 'javascript:alert(1)', stageFrom: 'NEW', stageTo: 'MEETING', via: 'domain' })).not.toContain('Videollamada');
    expect(note).toContain('- Etapa: NEW → MEETING');
    expect(note).toContain('no crea eventos ni envía invitaciones');
    const task = meetingTaskBody({ ...base, company: 'Cliente SA', links: [{ label: 'Empresa', url: 'http://twenty.test/object/company/c1' }] });
    expect(task).toContain('**Reunión con Cliente SA: 2026-11-30 10:00–10:30 (Europe/Madrid).**');
    expect(task).toContain('- Asistentes: Ana ana@cliente.example');
    expect(task).toContain('- Empresa: http://twenty.test/object/company/c1');
  });
});
