/**
 * Free meeting slots out of the busy calendar (tanda 22). Pure: no I/O, `now` injected.
 *
 * Rules (PM decisions):
 * - Working days Monday-Friday in Europe/Madrid (no public holidays, like the follow-up), from the
 *   NEXT working day up to `horizonDays` calendar days after today.
 * - Local bands (MEETING_HOURS, default 10:00-13:30 and 16:00-18:00); starts on a 30-minute grid
 *   from the start of the band; the meeting must END inside the band.
 * - 15 minutes of margin around every existing event; a full-day event blocks the whole day.
 *   Cancelled events do not count, nor do the events every internal participant declined.
 * - `count` slots on DIFFERENT days (never three on the same day), the earliest days first; inside
 *   a day the morning band is preferred. With fewer free days than `count`, fewer slots.
 */
import { addBusinessDays } from '../crm/reply-task.js';
import { localDay } from '../crm/followup.js';
import { emailDomain } from '../inbound/unsubscribe-classifier.js';
import type { CalendarEventView } from './calendar.js';
import type { MeetingConfig } from './config.js';
import type { MeetingSlot } from './types.js';

const MIN = 60_000;
/** Duration assumed for an event without an end. */
const DEFAULT_EVENT_MIN = 60;

export interface BusyInterval {
  start: number;
  end: number;
}

/** `YYYY-MM-DD` plus `n` calendar days. */
export function addDaysToDate(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO 8601 with the local offset of `timeZone` (`2026-11-27T10:00:00+01:00`). */
export function zonedIso(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const offset = String(parts.timeZoneName ?? 'GMT').replace(/^GMT/, '') || '+00:00';
  const hour = String(Number(parts.hour) % 24).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

function declinedByTeam(e: CalendarEventView, internalDomains: readonly string[]): boolean {
  const team = e.participants.filter((p) => p.workspaceMemberId !== null || (p.handle !== null && p.handle.includes('@') && internalDomains.includes(emailDomain(p.handle))));
  return team.length > 0 && team.every((p) => p.responseStatus === 'DECLINED');
}

/** Busy intervals (with the margin) and fully blocked local days of the calendar. */
export function busyFromEvents(events: readonly CalendarEventView[], cfg: Pick<MeetingConfig, 'bufferMin' | 'internalDomains'>): { intervals: BusyInterval[]; blockedDays: Set<string> } {
  const intervals: BusyInterval[] = [];
  const blockedDays = new Set<string>();
  for (const e of events) {
    if (e.isCanceled || declinedByTeam(e, cfg.internalDomains)) continue;
    const start = Date.parse(e.startsAt);
    const endParsed = e.endsAt ? Date.parse(e.endsAt) : Number.NaN;
    const end = Number.isFinite(endParsed) && endParsed > start ? endParsed : start + DEFAULT_EVENT_MIN * MIN;
    if (e.isFullDay) {
      // All-day dates are stored at UTC midnight: the UTC date is the calendar date.
      const first = new Date(start).toISOString().slice(0, 10);
      const last = new Date(Math.max(start, end - 1)).toISOString().slice(0, 10);
      for (let d = first, i = 0; d <= last && i < 62; d = addDaysToDate(d, 1), i++) blockedDays.add(d);
      continue;
    }
    intervals.push({ start: start - cfg.bufferMin * MIN, end: end + cfg.bufferMin * MIN });
  }
  return { intervals, blockedDays };
}

export interface SlotQuery {
  now: Date;
  count: number;
  config: MeetingConfig;
  events: readonly CalendarEventView[];
}

export function computeSlots(q: SlotQuery): MeetingSlot[] {
  const { config: cfg } = q;
  const count = Math.max(0, Math.min(Math.floor(q.count), 10));
  if (count === 0) return [];
  const tz = cfg.timezone;
  const today = localDay(q.now, tz);
  const lastDay = addDaysToDate(today, cfg.horizonDays);
  const { intervals, blockedDays } = busyFromEvents(q.events, cfg);
  const free = (start: number, end: number) => !intervals.some((b) => b.start < end && start < b.end);
  const slots: MeetingSlot[] = [];
  for (let k = 1; slots.length < count && k <= cfg.horizonDays + 1; k++) {
    const midnight = addBusinessDays(q.now, k, tz, 0);
    const day = localDay(midnight, tz);
    if (day > lastDay) break;
    if (blockedDays.has(day)) continue;
    let picked: MeetingSlot | null = null;
    for (const band of cfg.bands) {
      for (let t = band.startMin; !picked && t + cfg.durationMin <= band.endMin; t += cfg.stepMin) {
        // The local hour comes from the DST-safe helper; the minutes are added on top (no DST
        // change ever happens inside the working bands).
        const start = addBusinessDays(q.now, k, tz, Math.floor(t / 60)).getTime() + (t % 60) * MIN;
        const end = start + cfg.durationMin * MIN;
        if (start > q.now.getTime() && free(start, end)) picked = { start: zonedIso(new Date(start), tz), end: zonedIso(new Date(end), tz) };
      }
      if (picked) break;
    }
    if (picked) slots.push(picked);
  }
  return slots;
}
