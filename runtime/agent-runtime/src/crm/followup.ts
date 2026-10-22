/**
 * Lead follow-up (tanda 21): pure rules of the daily check `lead-followup-check`.
 *
 * A hypothesis whose first email went out from Twenty (`emailStatus = SENT`, row in
 * `email_sends`) and that, `FOLLOWUP_AFTER_BUSINESS_DAYS` working days later (Monday-Friday in
 * Europe/Madrid, public holidays not modelled), has no reply registered by the inbound triage
 * gets ONE native Task «🔔 Seguimiento — <empresa>» with a fixed script. The system never writes
 * a second email: the commercial writes it from Twenty (v1; a per-hypothesis email thread is v2).
 *
 * Everything here is deterministic: no LLM, no I/O.
 */
import { addBusinessDays } from './reply-task.js';
import { CRM_TASK_TITLE_MAX } from '../integrations/twenty/tasks.js';

export const FOLLOWUP_TIMEZONE = 'Europe/Madrid';
export const DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS = 5;
/** Fixed cap of tasks created per run (PM, tanda 21): the oldest sends first, the rest on later days. */
export const FOLLOWUP_MAX_TASKS_PER_RUN = 20;
export const FOLLOWUP_TASK_PREFIX = '🔔 Seguimiento — ';
export const FOLLOWUP_AUDIT_ACTION = 'lead.followup_task';
export const FOLLOWUP_AUDIT_SUBJECT = 'commercial_hypothesis';

export type FollowUpSkipReason = 'task_exists' | 'no_send_record' | 'too_recent' | 'replied' | 'bounced' | 'suppressed' | 'no_company' | 'cap_reached' | 'suppression_list_unavailable';

/**
 * `FOLLOWUP_AFTER_BUSINESS_DAYS`: integer 0..60, default 5. `0` disables the check. Anything
 * else (typo, negative, decimal) falls back to the default, so a typo never disables it.
 */
export function followUpAfterBusinessDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FOLLOWUP_AFTER_BUSINESS_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function localDay(date: Date, timeZone = FOLLOWUP_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Local `AAAA-MM-DD HH:mm`. */
export function localMinute(date: Date, timeZone = FOLLOWUP_TIMEZONE): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

/**
 * Local day on which the follow-up becomes due: `days` working days after the local day of the
 * send (a Monday send with 5 days is due the next Monday; a Saturday send, the Friday after).
 */
export function followUpDueDay(sentAt: Date, days: number, timeZone = FOLLOWUP_TIMEZONE): string {
  return localDay(addBusinessDays(sentAt, days, timeZone), timeZone);
}

/** Working days (Mon-Fri) after the local day of `sentAt` up to and including the local day of `now`. */
export function businessDaysSince(sentAt: Date, now: Date, timeZone = FOLLOWUP_TIMEZONE): number {
  const day = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  const from = day(localDay(sentAt, timeZone));
  const to = day(localDay(now, timeZone));
  let n = 0;
  for (let t = from + 86_400_000; t <= to; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

/** True when `now` (local day) has reached the due day of a send at `sentAt`. */
export function isFollowUpDue(sentAt: Date, now: Date, days: number, timeZone = FOLLOWUP_TIMEZONE): boolean {
  return followUpDueDay(sentAt, days, timeZone) <= localDay(now, timeZone);
}

const plain = (s: string) =>
  s
    .replace(/[`*_[\]()<>|~#\\]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** `🔔 Seguimiento — <empresa>`: no quotes or backslashes (filter values cannot carry them), bounded. */
export function followUpTaskTitle(company: string): string {
  const c = plain(company).replace(/["\\]/g, '');
  const title = `${FOLLOWUP_TASK_PREFIX}${c || 'empresa sin nombre'}`;
  return title.length <= CRM_TASK_TITLE_MAX ? title : `${title.slice(0, CRM_TASK_TITLE_MAX - 1)}…`;
}

/**
 * Fixed script of the follow-up (PM rule: no urgency, never "plazos cortos"). Same for every
 * task; the angle of the hypothesis (need / why now) is what makes it specific.
 */
export const FOLLOWUP_SCRIPT: readonly string[] = [
  'Retoma tu primer email en una línea y sin reproches («Os escribí hace unos días sobre…»).',
  'Aporta algo útil y concreto: una idea de producto o un ejemplo para su caso, ligado a la necesidad de arriba.',
  'Cierra con una pregunta abierta y fácil de contestar; sin presionar: si ahora no es buen momento, ofrécete para más adelante.',
];

export interface FollowUpBodyInput {
  company: string;
  hypothesisName: string;
  sentLocal: string;
  timezone: string;
  subject: string | null;
  recipient: string;
  businessDays: number;
  need: string | null;
  whyNow: string | null;
}

const MAX_ANGLE = 600;
const bounded = (s: string) => (s.length <= MAX_ANGLE ? s : `${s.slice(0, MAX_ANGLE - 1).trimEnd()}…`);

/** Markdown body of the follow-up task. Plain values only (no markdown from the records). */
export function followUpTaskBody(b: FollowUpBodyInput): string {
  const need = b.need ? bounded(plain(b.need)) : null;
  const whyNow = b.whyNow ? bounded(plain(b.whyNow)) : null;
  return [
    `**Seguimiento del primer email a ${plain(b.company) || 'la empresa'}.** Han pasado ${b.businessDays} días laborables sin respuesta registrada en el buzón.`,
    '',
    `- Primer envío: ${b.sentLocal} (${b.timezone})`,
    `- Asunto: ${b.subject ? `«${plain(b.subject)}»` : 'sin asunto registrado'}`,
    `- Destinatario: ${plain(b.recipient) || 'sin destinatario registrado'}`,
    `- Hipótesis: ${plain(b.hypothesisName)}`,
    '',
    'Ángulo de la hipótesis:',
    '',
    `- Necesidad: ${need ?? 'sin dato'}`,
    `- Por qué ahora: ${whyNow ?? 'sin dato'}`,
    '',
    'Guion sugerido (escríbelo tú, con tus palabras, respondiendo al hilo del primer email):',
    '',
    ...FOLLOWUP_SCRIPT.map((l) => `- ${l}`),
    '',
    'El Commercial OS no envía nada: el seguimiento lo escribes y lo envías tú. Si ya habéis hablado por otra vía, marca la tarea como hecha. No se creará otra tarea de seguimiento para esta hipótesis.',
  ].join('\n');
}
