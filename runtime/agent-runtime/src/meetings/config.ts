/**
 * Meeting configuration from the environment (tanda 22). Every variable has a safe default and an
 * invalid value falls back to it (never throws: a typo must not stop the drafter or the sync).
 *
 * - MEETING_HORIZON_DAYS (7): calendar days after today in which slots are proposed (1-30).
 * - MEETING_HOURS (`10:00-13:30,16:00-18:00`): local bands (Europe/Madrid), comma-separated
 *   `HH:MM-HH:MM`. The first band counts as the morning (preferred).
 * - MEETING_DURATION_MIN (30): length of a proposed meeting (15-240).
 * - MEETING_BOOKING_URL (empty): booking page (Calendly, Google appointment page...). Used when
 *   the calendar cannot be read. Only http(s).
 * - MEETING_VIDEO_URL (empty): fixed video room (Meet / Teams / Zoom). Only http(s).
 * - MEETING_INTERNAL_DOMAINS (`publiexpe.info,publiexpe.com`): domains of the salesperson's own
 *   team; their participants never match a client opportunity.
 */
import { DEFAULT_MEETING_DURATION_MIN } from './types.js';

export const MEETING_TIMEZONE = 'Europe/Madrid';
export const DEFAULT_MEETING_HORIZON_DAYS = 7;
export const DEFAULT_MEETING_HOURS = '10:00-13:30,16:00-18:00';
/** Margin kept free before and after every existing event. */
export const MEETING_BUFFER_MIN = 15;
/** Grid of the proposed starts (on the hour and half hour). */
export const MEETING_STEP_MIN = 30;
export const DEFAULT_MEETING_INTERNAL_DOMAINS = ['publiexpe.info', 'publiexpe.com'];

/** A local band in minutes after midnight, `[startMin, endMin)`. */
export interface MeetingBand {
  startMin: number;
  endMin: number;
}

export interface MeetingConfig {
  timezone: string;
  horizonDays: number;
  bands: MeetingBand[];
  durationMin: number;
  bufferMin: number;
  stepMin: number;
  bookingUrl: string | null;
  videoUrl: string | null;
  internalDomains: string[];
}

const intIn = (raw: string | undefined, min: number, max: number, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function minutes(s: string): number | null {
  const m = HHMM.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** `10:00-13:30,16:00-18:00` -> bands, sorted and non-overlapping; null when anything is invalid. */
export function parseMeetingHours(raw: string): MeetingBand[] | null {
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const bands: MeetingBand[] = [];
  for (const p of parts) {
    const [a, b, ...rest] = p.split('-');
    if (a === undefined || b === undefined || rest.length > 0) return null;
    const startMin = minutes(a);
    const endMin = minutes(b);
    if (startMin === null || endMin === null || endMin <= startMin) return null;
    bands.push({ startMin, endMin });
  }
  bands.sort((x, y) => x.startMin - y.startMin);
  for (let i = 1; i < bands.length; i++) if (bands[i]!.startMin < bands[i - 1]!.endMin) return null;
  return bands;
}

/** An http(s) URL, or null. */
export function httpUrlOrNull(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function meetingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MeetingConfig {
  const domains = (env.MEETING_INTERNAL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  return {
    timezone: MEETING_TIMEZONE,
    horizonDays: intIn(env.MEETING_HORIZON_DAYS, 1, 30, DEFAULT_MEETING_HORIZON_DAYS),
    bands: parseMeetingHours(env.MEETING_HOURS ?? '') ?? (parseMeetingHours(DEFAULT_MEETING_HOURS) as MeetingBand[]),
    durationMin: intIn(env.MEETING_DURATION_MIN, 15, 240, DEFAULT_MEETING_DURATION_MIN),
    bufferMin: MEETING_BUFFER_MIN,
    stepMin: MEETING_STEP_MIN,
    bookingUrl: httpUrlOrNull(env.MEETING_BOOKING_URL),
    videoUrl: httpUrlOrNull(env.MEETING_VIDEO_URL),
    internalDomains: domains.length > 0 ? domains : [...DEFAULT_MEETING_INTERNAL_DOMAINS],
  };
}
