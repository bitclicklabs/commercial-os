/**
 * Warm-up calendar of the cold-email mailboxes (docs/email-warmup.md, "Calendario de 4
 * semanas"), as data. Pure logic, no I/O: the clock is always passed in.
 *
 * - Volumes are per WORKING day and are the TOTAL of both mailboxes (`jesus.abril@` and
 *   `j.abril@`). Weekends are rest days (target 0).
 * - Weeks 1 and 3 describe a ramp: the per-day figures below interpolate it within the
 *   plan's limits (never more than +30 % from one working day to the next, except where
 *   the plan itself fixes the number, e.g. "15 per mailbox on Tuesday" of week 3).
 *   Weeks 2 and 4 give a range: the target is its upper bound.
 * - The runtime only sees the emails sent from Twenty (`email_sends`); the webmail sends
 *   add on top. The target is a SOFT cap (amber in the dashboard), never a block.
 * - After 2026-11-02 there is no soft cap ("post warm-up").
 *
 * IONOS hard limits (docs/email-warmup.md, "Límites de envío de IONOS"): 50 emails per
 * hour the first 7 days of a mailbox, 500 per hour after 30 days. Between day 8 and day 30
 * IONOS publishes no figure: the runtime keeps 50/hour as the reference, by caution.
 */
import { localDate } from '../inbound/suppression-list.js';

export const WARMUP_TIMEZONE = 'Europe/Madrid';
export const WARMUP_START = '2026-10-06';
export const WARMUP_END = '2026-11-02';
/** The mailboxes started on the same day as the warm-up. */
export const MAILBOX_CREATED = WARMUP_START;
export const WARMUP_MAILBOXES = 2;

export const IONOS_LIMITS = {
  firstWeekPerHour: 50,
  afterMonthPerHour: 500,
} as const;

export interface WarmupPhase {
  id: 'week1' | 'week2' | 'week3' | 'week4';
  label: string;
  from: string;
  to: string;
  /** The plan's wording, for the dashboard. */
  plan: string;
  /** Range of the phase (total, both mailboxes, per working day). */
  min: number;
  max: number;
  /** Target per working day when the plan describes a ramp. Missing days use `max`. */
  daily?: Record<string, number>;
}

export const WARMUP_PHASES: readonly WarmupPhase[] = [
  {
    id: 'week1',
    label: 'Semana 1',
    from: '2026-10-06',
    to: '2026-10-12',
    plan: '10 el primer y segundo día; después, subida gradual hasta 20 (total, ambos buzones)',
    min: 10,
    max: 20,
    daily: { '2026-10-06': 10, '2026-10-07': 10, '2026-10-08': 13, '2026-10-09': 16, '2026-10-12': 20 },
  },
  {
    id: 'week2',
    label: 'Semana 2',
    from: '2026-10-13',
    to: '2026-10-19',
    plan: '15 a 20 al día (total, ambos buzones)',
    min: 15,
    max: 20,
  },
  {
    id: 'week3',
    label: 'Semana 3',
    from: '2026-10-20',
    to: '2026-10-26',
    plan: '15 por buzón el martes y +3 a 5 al día hasta 25-30 por buzón (total 30 a 60)',
    min: 30,
    max: 60,
    daily: { '2026-10-20': 30, '2026-10-21': 38, '2026-10-22': 46, '2026-10-23': 54, '2026-10-26': 60 },
  },
  {
    id: 'week4',
    label: 'Semana 4',
    from: '2026-10-27',
    to: '2026-11-02',
    plan: '30 a 40 por buzón (total 60 a 80)',
    min: 60,
    max: 80,
  },
];

export type WarmupStage = 'before' | 'warmup' | 'post_warmup';

export interface WarmupDay {
  /** Local date (`AAAA-MM-DD`) in `timezone`. */
  date: string;
  timezone: string;
  stage: WarmupStage;
  phase: { id: string; label: string; from: string; to: string; plan: string; min: number; max: number } | null;
  /** Soft cap of the day (total, both mailboxes). null = no cap (before or after the warm-up). */
  target: number | null;
  /** Indicative share per mailbox (`target / 2`, rounded down). */
  targetPerMailbox: number | null;
  restDay: boolean;
  /** 1 on the first day of the mailbox. */
  mailboxAgeDays: number;
}

/** Day of week of a local `AAAA-MM-DD` (0 = Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Whole days from `from` to `to` (both `AAAA-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export function warmupDay(now: Date, timezone: string = WARMUP_TIMEZONE): WarmupDay {
  const date = localDate(now, timezone);
  const weekday = weekdayOf(date);
  const restDay = weekday === 0 || weekday === 6;
  const mailboxAgeDays = daysBetween(MAILBOX_CREATED, date) + 1;
  const base = { date, timezone, restDay, mailboxAgeDays };
  if (date < WARMUP_START) return { ...base, stage: 'before', phase: null, target: null, targetPerMailbox: null };
  if (date > WARMUP_END) return { ...base, stage: 'post_warmup', phase: null, target: null, targetPerMailbox: null };
  const phase = WARMUP_PHASES.find((p) => date >= p.from && date <= p.to)!;
  const target = restDay ? 0 : (phase.daily?.[date] ?? phase.max);
  const { daily: _daily, ...publicPhase } = phase;
  return { ...base, stage: 'warmup', phase: publicPhase, target, targetPerMailbox: Math.floor(target / WARMUP_MAILBOXES) };
}

export interface HourlyLimit {
  perHour: number;
  basis: string;
}

/** IONOS hourly limit that applies to a mailbox of `mailboxAgeDays` days. */
export function ionosHourlyLimit(mailboxAgeDays: number): HourlyLimit {
  if (mailboxAgeDays <= 7) return { perHour: IONOS_LIMITS.firstWeekPerHour, basis: 'primeros 7 días del buzón' };
  if (mailboxAgeDays <= 30) {
    return { perHour: IONOS_LIMITS.firstWeekPerHour, basis: 'días 8 a 30: IONOS no publica cifra; se mantiene 50/hora por prudencia' };
  }
  return { perHour: IONOS_LIMITS.afterMonthPerHour, basis: 'buzón con más de 30 días' };
}

/** True when the sends of the day go over the soft cap (never during before/post warm-up). */
export function exceedsTarget(day: Pick<WarmupDay, 'target'>, sendsToday: number): boolean {
  return day.target !== null && sendsToday > day.target;
}
