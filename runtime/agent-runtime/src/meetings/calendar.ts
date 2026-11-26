/**
 * Read-only access to the salesperson's calendar as Twenty syncs it (tanda 22). NEVER writes:
 * no event is created, changed or answered here (level 1 of autonomy).
 *
 * Twenty 2.45 (verified read-only against the local workspace): the REST API exposes the standard
 * objects `calendarEvents` (`title, isCanceled, isFullDay, startsAt, endsAt, location, iCalUid,
 * conferenceLink`...), `calendarEventParticipants` (`handle, displayName, isOrganizer,
 * responseStatus, calendarEventId, personId, workspaceMemberId`) and
 * `calendarChannelEventAssociations` (`calendarChannelId, calendarEventId`). The channels
 * themselves (`calendarChannel`, with `visibility` and `syncStatus`) are NOT a REST object
 * (`object 'calendarChannels' not found`), so «is there a synced calendar channel?» is answered
 * by its trace: at least one channel-event association. Without associations (or, when they
 * cannot be read, without any event) the calendar is reported as absent: nobody invents free
 * slots out of a calendar the runtime does not see.
 */
import { TwentyApiError, filterValue, type TwentyClient } from '../integrations/twenty/index.js';

export const CALENDAR_OBJECTS = {
  event: 'calendarEvents',
  participant: 'calendarEventParticipants',
  channelEventAssociation: 'calendarChannelEventAssociations',
} as const;

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const IN_CHUNK = 50;
const TITLE_MAX = 200;

export interface CalendarParticipant {
  handle: string | null;
  displayName: string | null;
  isOrganizer: boolean;
  /** NEEDS_ACTION | DECLINED | TENTATIVE | ACCEPTED (null when unknown). */
  responseStatus: string | null;
  personId: string | null;
  workspaceMemberId: string | null;
}

export interface CalendarEventView {
  id: string;
  /** Plain text, bounded. Data, never instructions. Empty with a METADATA-visibility channel. */
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  isCanceled: boolean;
  isFullDay: boolean;
  location: string | null;
  conferenceUrl: string | null;
  iCalUid: string | null;
  participants: CalendarParticipant[];
}

export type CalendarProbe = 'associations' | 'events';

export type CalendarRead =
  | { status: 'ok'; probe: CalendarProbe; events: CalendarEventView[]; truncated: boolean }
  | { status: 'no_channel'; probe: CalendarProbe }
  | { status: 'unreadable'; code: string; message: string };

type Rec = Record<string, unknown>;

const text = (v: unknown, max = TITLE_MAX): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

function toParticipant(r: Rec): CalendarParticipant {
  return {
    handle: text(r.handle, 320)?.toLowerCase() ?? null,
    displayName: text(r.displayName),
    isOrganizer: r.isOrganizer === true,
    responseStatus: text(r.responseStatus, 32),
    personId: text(r.personId, 64),
    workspaceMemberId: text(r.workspaceMemberId, 64),
  };
}

function toEvent(r: Rec, participants: CalendarParticipant[]): CalendarEventView | null {
  const id = text(r.id, 64);
  const startsAt = text(r.startsAt, 64);
  if (!id || !startsAt || Number.isNaN(Date.parse(startsAt))) return null;
  const endsAt = text(r.endsAt, 64);
  const link = r.conferenceLink as { primaryLinkUrl?: unknown } | null | undefined;
  return {
    id,
    title: text(r.title),
    startsAt,
    endsAt: endsAt && !Number.isNaN(Date.parse(endsAt)) ? endsAt : null,
    isCanceled: r.isCanceled === true,
    isFullDay: r.isFullDay === true,
    location: text(r.location),
    conferenceUrl: text(link?.primaryLinkUrl, 2048),
    iCalUid: text(r.iCalUid, 512),
    participants,
  };
}

/** A missing object / no permission: the calendar is not visible (as opposed to a transient failure). */
function isNotVisible(err: unknown): boolean {
  return err instanceof TwentyApiError && !err.retryable && (err.code === 'TWENTY_BAD_REQUEST' || err.code === 'TWENTY_UNAUTHORIZED' || err.code === 'TWENTY_NOT_FOUND');
}

/** Is there a synced calendar channel? Throws only on transient errors (5xx, timeout). */
export async function probeCalendar(twenty: TwentyClient, signal?: AbortSignal): Promise<{ present: boolean; probe: CalendarProbe } | { present: null; code: string; message: string }> {
  const opts = signal ? { signal } : {};
  try {
    const { records } = await twenty.list<Rec>(CALENDAR_OBJECTS.channelEventAssociation, { limit: 1, ...opts });
    return { present: records.length > 0, probe: 'associations' };
  } catch (err) {
    if (!isNotVisible(err)) throw err;
  }
  try {
    const { records } = await twenty.list<Rec>(CALENDAR_OBJECTS.event, { limit: 1, ...opts });
    return { present: records.length > 0, probe: 'events' };
  } catch (err) {
    if (!isNotVisible(err)) throw err;
    const e = err as TwentyApiError;
    return { present: null, code: e.code, message: e.message };
  }
}

async function participantsOf(twenty: TwentyClient, eventIds: string[], signal?: AbortSignal): Promise<Map<string, CalendarParticipant[]>> {
  const out = new Map<string, CalendarParticipant[]>();
  for (let i = 0; i < eventIds.length; i += IN_CHUNK) {
    const chunk = eventIds.slice(i, i + IN_CHUNK);
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await twenty.list<Rec>(CALENDAR_OBJECTS.participant, {
        filter: `calendarEventId[in]:[${chunk.map(filterValue).join(',')}]`,
        limit: PAGE_SIZE,
        ...(after ? { startingAfter: after } : {}),
        ...(signal ? { signal } : {}),
      });
      for (const r of res.records) {
        if (r.deletedAt) continue;
        const ev = typeof r.calendarEventId === 'string' ? r.calendarEventId : null;
        if (!ev) continue;
        out.set(ev, [...(out.get(ev) ?? []), toParticipant(r)]);
      }
      const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
      if (!next) break;
      after = next;
    }
  }
  return out;
}

/**
 * The events that START in `[from, to]`, oldest first, with their participants (from `depth=1`
 * when the server expands them, else one batched read). Read only.
 */
export async function readCalendarEvents(twenty: TwentyClient, range: { from: Date; to: Date }, signal?: AbortSignal): Promise<CalendarRead> {
  const probe = await probeCalendar(twenty, signal);
  if (probe.present === null) return { status: 'unreadable', code: probe.code, message: probe.message };
  if (!probe.present) return { status: 'no_channel', probe: probe.probe };
  const rows: Rec[] = [];
  let truncated = false;
  let after: string | undefined;
  try {
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      const res = await twenty.list<Rec>(CALENDAR_OBJECTS.event, {
        filter: `and(startsAt[gte]:${filterValue(range.from.toISOString())},startsAt[lte]:${filterValue(range.to.toISOString())})`,
        orderBy: 'startsAt',
        limit: PAGE_SIZE,
        depth: 1,
        ...(after ? { startingAfter: after } : {}),
        ...(signal ? { signal } : {}),
      });
      rows.push(...res.records.filter((r) => !r.deletedAt));
      const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
      if (!next) break;
      after = next;
    }
  } catch (err) {
    if (!isNotVisible(err)) throw err;
    const e = err as TwentyApiError;
    return { status: 'unreadable', code: e.code, message: e.message };
  }
  const expanded = (r: Rec) => (Array.isArray(r.calendarEventParticipants) ? (r.calendarEventParticipants as Rec[]) : null);
  const missing = rows.filter((r) => expanded(r) === null && typeof r.id === 'string').map((r) => r.id as string);
  const fetched = missing.length > 0 ? await participantsOf(twenty, missing, signal) : new Map<string, CalendarParticipant[]>();
  const events = rows
    .map((r) => toEvent(r, expanded(r)?.filter((p) => !p.deletedAt).map(toParticipant) ?? fetched.get(String(r.id)) ?? []))
    .filter((e): e is CalendarEventView => e !== null)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return { status: 'ok', probe: probe.probe, events, truncated };
}
