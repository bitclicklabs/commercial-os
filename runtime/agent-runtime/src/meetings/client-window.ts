/**
 * When the client wants the meeting (tanda 23). The reply-draft model reads the client's email and
 * returns, in the SAME call as the draft, `ventana_cliente` with CLOSED categories only
 * (`semana_que_viene`, `esta_semana`, `a_partir_de`, `antes_de`, `manana`, `ninguna`, plus an
 * optional part of the day). The dates are computed HERE, by code, from `now` in Europe/Madrid:
 * the model never hands a free date to the calendar. The only date it may give (`fecha`, for
 * `a_partir_de` / `antes_de`) is validated: a real `YYYY-MM-DD`, not in the past, at most 60 days
 * ahead; anything else is ignored (that category becomes «no window»).
 *
 * Pure: no I/O. The result feeds `MeetingAvailability.propose({ window })` (src/meetings/types.ts).
 */
import { z } from 'zod';
import { localDay } from '../crm/followup.js';
import { addDaysToDate } from './slots.js';
import type { MeetingWindow } from './types.js';

export const CLIENT_WINDOW_TYPES = ['semana_que_viene', 'esta_semana', 'a_partir_de', 'antes_de', 'manana', 'ninguna'] as const;
export type ClientWindowType = (typeof CLIENT_WINDOW_TYPES)[number];
export const CLIENT_WINDOW_PARTS = ['manana', 'tarde'] as const;
/** A `fecha` further than this from today is not believed. */
export const CLIENT_WINDOW_MAX_AHEAD_DAYS = 60;

/**
 * `ventana_cliente` as the model returns it. Lenient on purpose: an unknown value becomes absent
 * (a bad window must never cost the draft), the code decides what it means.
 */
export const VentanaCliente = z.object({
  tipo: z.enum(CLIENT_WINDOW_TYPES).catch('ninguna'),
  fecha: z.string().trim().nullable().optional().catch(null),
  franja: z.enum(CLIENT_WINDOW_PARTS).nullable().optional().catch(null),
});
export type VentanaCliente = z.infer<typeof VentanaCliente>;

/** ISO weekday of a `YYYY-MM-DD`: Monday 1 ... Sunday 7. */
function isoDow(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** A real calendar date `YYYY-MM-DD` (rejects 2026-02-30), else null. */
export function validYmd(s: string | null | undefined): string | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? s : null;
}

export interface ResolvedClientWindow {
  /** What goes to `propose`; null = no window (normal horizon). */
  window: MeetingWindow | null;
  /** The category as understood (for traces), and why a `fecha` was ignored. */
  tipo: ClientWindowType;
  ignored?: 'fecha_invalida' | 'fecha_pasada' | 'fecha_lejana' | 'sin_fecha';
}

/**
 * The window in local dates (both ends inclusive):
 * - `semana_que_viene`: Monday to Friday of the next week (on a weekend, the week starting next Monday);
 * - `esta_semana`: today to Friday of this week (on a weekend it is empty: the caller relaxes it);
 * - `a_partir_de` + fecha: from that day; `antes_de` + fecha: up to the day before;
 * - `manana`: tomorrow only;
 * - `ninguna`: no dates (the part of the day may still apply).
 */
export function resolveClientWindow(v: VentanaCliente | null | undefined, now: Date, timeZone = 'Europe/Madrid'): ResolvedClientWindow {
  if (!v) return { window: null, tipo: 'ninguna' };
  const today = localDay(now, timeZone);
  const partOfDay = v.franja === 'manana' ? 'morning' : v.franja === 'tarde' ? 'afternoon' : undefined;
  const withPart = (w: MeetingWindow): MeetingWindow | null => {
    const out: MeetingWindow = { ...w, ...(partOfDay ? { partOfDay } : {}) };
    return Object.keys(out).length > 0 ? out : null;
  };
  const dow = isoDow(today);
  switch (v.tipo) {
    case 'semana_que_viene': {
      const monday = addDaysToDate(today, 8 - dow);
      return { window: withPart({ notBefore: monday, notAfter: addDaysToDate(monday, 4) }), tipo: v.tipo };
    }
    case 'esta_semana':
      return { window: withPart({ notBefore: today, notAfter: addDaysToDate(today, 5 - dow) }), tipo: v.tipo };
    case 'manana': {
      const tomorrow = addDaysToDate(today, 1);
      return { window: withPart({ notBefore: tomorrow, notAfter: tomorrow }), tipo: v.tipo };
    }
    case 'a_partir_de':
    case 'antes_de': {
      const raw = v.fecha ?? null;
      const ymd = validYmd(raw);
      const ignored = raw === null || raw === '' ? 'sin_fecha' : ymd === null ? 'fecha_invalida' : ymd < today ? 'fecha_pasada' : ymd > addDaysToDate(today, CLIENT_WINDOW_MAX_AHEAD_DAYS) ? 'fecha_lejana' : null;
      if (ignored) return { window: withPart({}), tipo: v.tipo, ignored };
      return { window: withPart(v.tipo === 'a_partir_de' ? { notBefore: ymd! } : { notAfter: addDaysToDate(ymd!, -1) }), tipo: v.tipo };
    }
    default:
      return { window: withPart({}), tipo: 'ninguna' };
  }
}
