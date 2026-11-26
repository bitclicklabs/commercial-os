/**
 * MeetingAvailability over the salesperson's calendar synced in Twenty (tanda 22). Read only:
 * it never creates an event nor sends an invitation (level 1: the system proposes, the person
 * books).
 *
 * `source`:
 * - `calendar`: a synced calendar channel exists (src/meetings/calendar.ts) and its events were
 *   read: the slots are the free ones (src/meetings/slots.ts).
 * - `link`: the calendar is absent or unreadable (or has no free slot in the horizon) and
 *   MEETING_BOOKING_URL is set: no slots, the booking page instead.
 * - `none`: neither. The draft asks the recipient for a time.
 *
 * Never throws: a Twenty failure degrades to `link` / `none` (the drafter must keep working).
 * The busy calendar is cached for a few minutes per instance (a batch of drafts reads it once).
 */
import { TwentyApiError, type TwentyClient } from '../integrations/twenty/index.js';
import { readCalendarEvents, type CalendarRead } from './calendar.js';
import type { MeetingConfig } from './config.js';
import { localDay } from '../crm/followup.js';
import { computeSlots, slotSearchSpanDays } from './slots.js';
import type { MeetingAvailability, MeetingProposal, MeetingWindow } from './types.js';

const CACHE_MS = 5 * 60_000;
const DAY = 86_400_000;

export interface CalendarAvailabilityDiagnostics {
  calendar: CalendarRead['status'] | 'error' | 'not_configured';
  detail?: string;
}

export class CalendarAvailability implements MeetingAvailability {
  private cache: { at: number; key: string; read: CalendarRead } | null = null;
  /** What the last `propose` saw (for traces and tests). */
  lastDiagnostics: CalendarAvailabilityDiagnostics | null = null;

  constructor(
    private readonly twenty: TwentyClient,
    private readonly config: MeetingConfig,
    private readonly opts: { signal?: AbortSignal } = {},
  ) {}

  private fallback(): MeetingProposal {
    const base = { slots: [], bookingUrl: this.config.bookingUrl, videoUrl: this.config.videoUrl, durationMin: this.config.durationMin };
    return { ...base, source: this.config.bookingUrl ? 'link' : 'none' };
  }

  private async read(now: Date, spanDays: number): Promise<CalendarRead> {
    // From yesterday (an event that started before today can still run into tomorrow morning) to
    // one day past the horizon (or past the client's window, tanda 23).
    const from = new Date(now.getTime() - DAY);
    const to = new Date(now.getTime() + (spanDays + 1) * DAY);
    const key = `${from.toISOString().slice(0, 13)}:${spanDays}`;
    if (this.cache && this.cache.key === key && now.getTime() - this.cache.at < CACHE_MS) return this.cache.read;
    const read = await readCalendarEvents(this.twenty, { from, to }, this.opts.signal);
    this.cache = { at: now.getTime(), key, read };
    return read;
  }

  async propose(opts: { now: Date; count: number; window?: MeetingWindow }): Promise<MeetingProposal> {
    if (!this.twenty.isConfigured()) {
      this.lastDiagnostics = { calendar: 'not_configured' };
      return this.fallback();
    }
    const today = localDay(opts.now, this.config.timezone);
    // Read enough for the window AND the normal horizon (the relaxed proposal needs it).
    const span = Math.max(this.config.horizonDays, slotSearchSpanDays(today, this.config.horizonDays, opts.window));
    let read: CalendarRead;
    try {
      read = await this.read(opts.now, span);
    } catch (err) {
      this.lastDiagnostics = { calendar: 'error', detail: err instanceof TwentyApiError ? err.code : 'unexpected' };
      return this.fallback();
    }
    this.lastDiagnostics = { calendar: read.status, ...(read.status === 'unreadable' ? { detail: read.code } : {}) };
    // A readable but EMPTY synced calendar looks like «no channel» through the REST API; the
    // operator's MEETING_CALENDAR_SYNCED says it is an agenda with every slot free.
    const events = read.status === 'ok' ? read.events : read.status === 'no_channel' && this.config.calendarSynced ? [] : null;
    if (events === null) return this.fallback();
    const base = { now: opts.now, count: opts.count, config: this.config, events };
    let slots = computeSlots({ ...base, window: opts.window });
    // Tanda 23: a window with no free slot falls back to the normal horizon, and says so.
    let windowRelaxed = false;
    if (slots.length === 0 && opts.window) {
      slots = computeSlots(base);
      windowRelaxed = slots.length > 0;
    }
    if (slots.length === 0) return this.fallback();
    return {
      slots,
      bookingUrl: this.config.bookingUrl,
      videoUrl: this.config.videoUrl,
      durationMin: this.config.durationMin,
      source: 'calendar',
      ...(windowRelaxed ? { windowRelaxed: true } : {}),
    };
  }
}

/** Without a readable calendar: the booking link if there is one, else nothing. */
export class LinkAvailability implements MeetingAvailability {
  constructor(private readonly config: MeetingConfig) {}

  async propose(): Promise<MeetingProposal> {
    return {
      slots: [],
      bookingUrl: this.config.bookingUrl,
      videoUrl: this.config.videoUrl,
      durationMin: this.config.durationMin,
      source: this.config.bookingUrl ? 'link' : 'none',
    };
  }
}
