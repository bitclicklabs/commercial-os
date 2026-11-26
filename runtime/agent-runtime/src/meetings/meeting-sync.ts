/**
 * Rules and texts of the meeting detection (tanda 22, task `meeting-sync`). Pure, no I/O.
 *
 * - The stage of an opportunity only moves FORWARD, and only up to the meeting stage: an open
 *   opportunity in a stage BEFORE it moves to it; one already in it, in a later stage, closed, or
 *   in a stage the workspace does not list is never touched.
 * - The meeting stage is read from the workspace's `stage` SELECT at run time: `MEETING` (default
 *   workspace), else the first option that looks like one (`*MEET*`, `*REUNI*`).
 * - One «🧾 Preparar reunión con <empresa>» task, due the working day before the meeting (09:00
 *   Europe/Madrid; today when that day has passed). No task for a meeting that already happened.
 */
import { isClosedStage } from '../crm/opportunities.js';
import { localDay, localMinute } from '../crm/followup.js';
import { httpUrlOrNull } from './config.js';
import { addDaysToDate } from './slots.js';

export const MEETING_SYNC_TIMEZONE = 'Europe/Madrid';
export const MEETING_SYNC_AUDIT_ACTION = 'opportunity.meeting_detected';
export const MEETING_SYNC_AUDIT_SUBJECT = 'opportunity';
export const MEETING_DETECTED_EVENT = 'opportunity.meeting_detected';
/** Calendar window read by every run: from 1 day back to 60 days ahead. */
export const MEETING_SYNC_LOOKBACK_DAYS = 1;
export const MEETING_SYNC_LOOKAHEAD_DAYS = 60;
export const MEETING_SYNC_MAX_PER_RUN = 20;
export const MEETING_NOTE_PREFIX = '📅 Reunión detectada — ';
export const MEETING_TASK_PREFIX = '🧾 Preparar reunión con ';
const TITLE_MAX = 255;

export type StageVerdict = 'advance' | 'at_meeting' | 'past_meeting' | 'closed' | 'unknown_stage' | 'no_meeting_stage';

/** The workspace's meeting stage, or null when it has none. */
export function meetingStageOf(stages: readonly string[]): string | null {
  if (stages.includes('MEETING')) return 'MEETING';
  return stages.find((s) => /MEET|REUNI/i.test(s)) ?? null;
}

/** Where `current` stands relative to the meeting stage (ordered SELECT options). */
export function stageVerdict(current: string | null | undefined, stages: readonly string[]): StageVerdict {
  const meeting = meetingStageOf(stages);
  if (!meeting) return 'no_meeting_stage';
  if (isClosedStage(current)) return 'closed';
  // An opportunity without a stage is at the very beginning of the funnel.
  if (current === null || current === undefined || current === '') return 'advance';
  const at = stages.indexOf(current);
  const target = stages.indexOf(meeting);
  if (at < 0) return 'unknown_stage';
  if (at < target) return 'advance';
  return at === target ? 'at_meeting' : 'past_meeting';
}

const clean = (s: string) => s.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
/** Plain text for a markdown body: no markup a record could smuggle in. */
const plain = (s: string) => s.replace(/[`*_[\]()<>|~#\\]/g, '').replace(/\s+/g, ' ').trim();
const bounded = (s: string) => (s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX - 1)}…`);

/** `📅 Reunión detectada — 2026-12-03 10:00` (local time): one note per opportunity and meeting. */
export function meetingNoteTitle(startsAt: Date, timeZone = MEETING_SYNC_TIMEZONE): string {
  return `${MEETING_NOTE_PREFIX}${localMinute(startsAt, timeZone)}`;
}

export function meetingTaskTitle(company: string | null | undefined): string {
  return bounded(`${MEETING_TASK_PREFIX}${clean(company ?? '') || 'la empresa'}`);
}

export interface MeetingTextInput {
  startsAt: Date;
  endsAt: Date | null;
  title: string | null;
  attendees: string[];
  location: string | null;
  conferenceUrl: string | null;
  timezone?: string;
}

/** The conference link only when it is a plain http(s) URL (it comes from a third-party invitation). */
function videoLink(b: MeetingTextInput): string | null {
  const url = httpUrlOrNull(b.conferenceUrl ?? undefined);
  return url && !/[\s()<>[\]`]/.test(url) ? url : null;
}

function when(b: MeetingTextInput): string {
  const tz = b.timezone ?? MEETING_SYNC_TIMEZONE;
  const start = localMinute(b.startsAt, tz);
  const end = b.endsAt ? localMinute(b.endsAt, tz) : null;
  const sameDay = end !== null && end.slice(0, 10) === start.slice(0, 10);
  return `${start}${end ? `–${sameDay ? end.slice(11) : end}` : ''} (${tz})`;
}

/** Body of the 📅 note on the opportunity. */
export function meetingNoteBody(b: MeetingTextInput & { stageFrom: string | null; stageTo: string | null; via: string }): string {
  const title = b.title ? plain(b.title) : '';
  return [
    `📅 Reunión detectada en tu calendario: ${when(b)}, ${title || 'sin título'}`,
    '',
    `- Asistentes: ${b.attendees.length > 0 ? b.attendees.map(plain).join(', ') : 'sin asistentes visibles'}`,
    ...(b.location ? [`- Lugar: ${plain(b.location)}`] : []),
    ...(videoLink(b) ? [`- Videollamada: ${videoLink(b)}`] : []),
    `- Casada por: ${b.via === 'point_of_contact' ? 'el punto de contacto de la oportunidad' : b.via === 'company_person' ? 'una persona de la empresa' : 'el dominio de la empresa'}`,
    b.stageTo && b.stageTo !== b.stageFrom ? `- Etapa: ${b.stageFrom ?? 'sin etapa'} → ${b.stageTo}` : `- Etapa: ${b.stageFrom ?? 'sin etapa'} (sin cambios)`,
    '',
    'El Commercial OS solo LEE tu calendario: no crea eventos ni envía invitaciones.',
  ].join('\n');
}

/** Body of the 🧾 task: date, attendees and links (no LLM). */
export function meetingTaskBody(b: MeetingTextInput & { company: string | null; links: Array<{ label: string; url: string }> }): string {
  const title = b.title ? plain(b.title) : '';
  return [
    `**Reunión con ${plain(b.company ?? '') || 'la empresa'}: ${when(b)}.** Prepárala el día antes.`,
    '',
    `- Reunión: ${title || 'sin título'}`,
    `- Asistentes: ${b.attendees.length > 0 ? b.attendees.map(plain).join(', ') : 'sin asistentes visibles'}`,
    ...(b.location ? [`- Lugar: ${plain(b.location)}`] : []),
    ...(videoLink(b) ? [`- Videollamada: ${videoLink(b)}`] : []),
    '',
    ...(b.links.length > 0 ? ['Para preparar:', '', ...b.links.map((l) => `- ${l.label}: ${l.url}`), ''] : []),
    'Repasa la empresa, la hipótesis (necesidad y por qué ahora) y lleva ideas de producto. El Commercial OS no envía nada ni toca tu calendario.',
  ].join('\n');
}

function isWeekend(ymd: string): boolean {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Due day of the preparation task: the working day (Mon-Fri) before the meeting's local day; never
 * before today (a meeting tomorrow morning detected this evening is due today).
 */
export function prepDueDay(meetingStart: Date, now: Date, timeZone = MEETING_SYNC_TIMEZONE): string {
  let day = addDaysToDate(localDay(meetingStart, timeZone), -1);
  while (isWeekend(day)) day = addDaysToDate(day, -1);
  const today = localDay(now, timeZone);
  return day < today ? today : day;
}
