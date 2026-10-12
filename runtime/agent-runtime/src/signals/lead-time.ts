/**
 * Lead-time window (tanda 18, PM rule NEXT_QUARTER): merchandising needs production time, so a
 * fair is only worth prospecting when it is between `LEADTIME_MIN_DAYS` (default 45) and
 * `LEADTIME_MAX_DAYS` (default 210) days away. Incident 2026-10-12: the six Gastrónoma drafts
 * were rejected because the fair was the following week ("imposible de vender o hacer pedido").
 *
 * Days are counted between calendar dates in Europe/Madrid (the commercial's day), so a run at
 * 23:30 UTC already counts from the next Madrid day. Pure functions: every caller passes `now`
 * or `today`.
 *
 * | Days to the fair (Madrid)  | Status      | Meaning                                              |
 * |----------------------------|-------------|------------------------------------------------------|
 * | no date                    | `no_date`   | cannot be judged: allowed, with the fact noted        |
 * | < 0                        | `past`      | the fair is over (the calendar expires it)            |
 * | 0 .. MIN-1                 | `too_close` | no time to produce: never prospected                  |
 * | MIN .. MAX                 | `in_window` | prospectable                                          |
 * | > MAX                      | `too_far`   | too early: waits until it enters the window           |
 */

export const DEFAULT_LEADTIME_MIN_DAYS = 45;
export const DEFAULT_LEADTIME_MAX_DAYS = 210;
export const LEADTIME_TIMEZONE = 'Europe/Madrid';

export interface LeadTimeWindow {
  minDays: number;
  maxDays: number;
}

export const DEFAULT_LEADTIME_WINDOW: LeadTimeWindow = { minDays: DEFAULT_LEADTIME_MIN_DAYS, maxDays: DEFAULT_LEADTIME_MAX_DAYS };

export type LeadTimeStatus = 'in_window' | 'too_close' | 'too_far' | 'past' | 'no_date';

export interface LeadTimeVerdict {
  status: LeadTimeStatus;
  /** Days from `today` to the event date (null without a date). */
  days: number | null;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
}

/**
 * `LEADTIME_MIN_DAYS` / `LEADTIME_MAX_DAYS`. Invalid or inconsistent values (not integers in
 * 0..3650, or min > max) fall back to the defaults, so a typo never disables the rule.
 */
export function leadTimeWindowFromEnv(env: NodeJS.ProcessEnv = process.env): LeadTimeWindow {
  const min = intOrNull(env.LEADTIME_MIN_DAYS) ?? DEFAULT_LEADTIME_MIN_DAYS;
  const max = intOrNull(env.LEADTIME_MAX_DAYS) ?? DEFAULT_LEADTIME_MAX_DAYS;
  return min <= max ? { minDays: min, maxDays: max } : { ...DEFAULT_LEADTIME_WINDOW };
}

/** Calendar date (YYYY-MM-DD) of `now` in Europe/Madrid. */
export function madridToday(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: LEADTIME_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function utcDay(date: string): number | null {
  const m = ISO_DATE_RE.exec(date.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

/** Whole days from `today` to `eventDate` (both YYYY-MM-DD; a longer ISO value is cut to its date). Null if unparseable. */
export function daysUntil(eventDate: string | null | undefined, today: string): number | null {
  if (!eventDate) return null;
  const e = utcDay(eventDate);
  const t = utcDay(today);
  if (e === null || t === null) return null;
  return Math.round((e - t) / 86_400_000);
}

export function classifyLeadTime(eventDate: string | null | undefined, today: string, window: LeadTimeWindow): LeadTimeVerdict {
  const days = daysUntil(eventDate, today);
  if (days === null) return { status: 'no_date', days: null };
  if (days < 0) return { status: 'past', days };
  if (days < window.minDays) return { status: 'too_close', days };
  if (days > window.maxDays) return { status: 'too_far', days };
  return { status: 'in_window', days };
}

/** True when the fair is closer than the window minimum or already past (nothing can be produced in time). */
export function isDeadForLeadTime(v: LeadTimeVerdict): boolean {
  return v.status === 'too_close' || v.status === 'past';
}

/** "45–210 días" */
export function windowLabel(window: LeadTimeWindow): string {
  return `${window.minDays}–${window.maxDays} días`;
}

/** Output block every run carries: the window applied and the Madrid day it was measured from. */
export function windowInfo(window: LeadTimeWindow, today: string): { min_days: number; max_days: number; today: string; timezone: string } {
  return { min_days: window.minDays, max_days: window.maxDays, today, timezone: LEADTIME_TIMEZONE };
}
