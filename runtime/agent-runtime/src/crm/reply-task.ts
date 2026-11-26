/**
 * Native Twenty `Task` «Responder a <persona/empresa> 📬» of the inbound triage (tanda 19):
 * what the commercial has to DO about a reply (the 📬 note stays as the record with the
 * excerpt). Created by the triage for INTERESADO and PREGUNTA replies, linked through
 * `taskTargets` to the opportunity (if any), the company and the person.
 *
 * Tanda 25: built on the generic `createCrmTask` helper (src/integrations/twenty/tasks.ts), the
 * only place that decides whether a Task already exists. Shape verified read-only (GET /rest/open-api/core): Task
 * `{ title, bodyV2: { markdown }, dueAt, status TODO|IN_PROGRESS|DONE, assigneeId }`,
 * TaskTarget `{ taskId, targetCompanyId, targetPersonId, targetOpportunityId, ... }`.
 *
 * Idempotent: an open task (TODO / IN_PROGRESS) with the same title (or its pre-tanda 23
 * spelling, `legacyTitles`) that already targets the
 * same opportunity (or, without one, the same company) is reused and only its missing targets
 * are added. A retried run never duplicates it.
 */
import type { TwentyClient } from '../integrations/twenty/index.js';
import { createCrmTask } from '../integrations/twenty/tasks.js';

/**
 * Tanda 23: TEXT FIRST, emoji at the end. Twenty draws the icon of a Task / note with the first
 * character of its title and an emoji there (a UTF-16 surrogate pair) shows as a broken «?»:
 * «Responder a Adpan Europa S.L. 📬», «Cerrar reunión con X 📅». The tasks created before keep
 * the old title («📬 Responder a …»): `legacyReplyTaskTitle` / `legacyMeetingTaskTitle` give the old spelling, and
 * `upsertReplyTask` reuses an open task with either.
 */
export const REPLY_TASK_PREFIX = 'Responder a ';
export const REPLY_TASK_EMOJI = '📬';
/** Tanda 22: the client accepts or proposes a meeting (`meeting_intent`): the task is to close it. */
export const MEETING_TASK_PREFIX = 'Cerrar reunión con ';
export const MEETING_TASK_EMOJI = '📅';
/** Titles before tanda 23 (emoji first). Only to FIND the tasks created then; never written. */
export const LEGACY_REPLY_TASK_PREFIX = `${REPLY_TASK_EMOJI} ${REPLY_TASK_PREFIX}`;
export const LEGACY_MEETING_TASK_PREFIX = `${MEETING_TASK_EMOJI} ${MEETING_TASK_PREFIX}`;
export const TASK_TITLE_MAX = 255;
export const REPLY_TASK_BUSINESS_DAYS = 2;

/** `Responder a <who> 📬`: no quotes or backslashes (filter values cannot carry them), bounded. */
export function replyTaskTitle(who: string): string {
  return taskTitle(REPLY_TASK_PREFIX, who, 'la respuesta', ` ${REPLY_TASK_EMOJI}`);
}

/** `Cerrar reunión con <empresa> 📅` (same sanitising as the reply task). */
export function meetingTaskTitle(company: string): string {
  return taskTitle(MEETING_TASK_PREFIX, company, 'el cliente', ` ${MEETING_TASK_EMOJI}`);
}

/** The old spelling `📬 Responder a <who>` (to find a task created before tanda 23). */
export function legacyReplyTaskTitle(who: string): string {
  return taskTitle(LEGACY_REPLY_TASK_PREFIX, who, 'la respuesta', '');
}

/** The old spelling `📅 Cerrar reunión con <empresa>`. */
export function legacyMeetingTaskTitle(company: string): string {
  return taskTitle(LEGACY_MEETING_TASK_PREFIX, company, 'el cliente', '');
}

function taskTitle(prefix: string, who: string, empty: string, suffix: string): string {
  const w = who
    .replace(/["\\]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const room = TASK_TITLE_MAX - prefix.length - suffix.length;
  const body = w || empty;
  // The emoji stays at the end even when the name is cut.
  return `${prefix}${body.length <= room ? body : `${body.slice(0, room - 1)}…`}${suffix}`;
}

function localParts(date: Date, timeZone: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hh: Number(parts.hour) % 24, mm: Number(parts.minute) };
}

/** The UTC instant of local `y-m-d hh:00` in `timeZone` (DST-safe: offset recomputed once). */
function zonedInstant(y: number, m: number, d: number, hh: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, 0, 0);
  const at = (t: number) => {
    const p = localParts(new Date(t), timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - t;
  };
  const first = guess - at(guess);
  return new Date(guess - at(first));
}

/**
 * `from` plus `days` working days (Monday-Friday) in `timeZone`, at `hour`:00 local. A reply
 * received on a Friday is due on Tuesday; on a Saturday or Sunday, on Tuesday too. Public
 * holidays are not modelled.
 */
export function addBusinessDays(from: Date, days: number, timeZone: string, hour = 9): Date {
  const p = localParts(from, timeZone);
  const cursor = new Date(Date.UTC(p.y, p.m - 1, p.d));
  let left = days;
  while (left > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return zonedInstant(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), hour, timeZone);
}

export interface ReplyTaskBodyInput {
  class: 'INTERESADO' | 'PREGUNTA';
  fromEmail: string;
  subject: string;
  /** Already sanitised excerpt (src/inbound/triage-notes.ts `sanitizeExcerpt`). */
  excerpt: string;
  receivedLocal: string;
  timezone: string;
  /** The send it answers, when known. */
  sendSubject: string | null;
  /** Tanda 22: the client accepts or proposes a meeting (the task is «Cerrar reunión con … 📅»). */
  meetingIntent?: boolean;
  /** Tanda 22: the «Borrador de respuesta» section (src/agents/reply-draft.ts), already markdown. */
  draftSection?: string | null;
}

/** Markdown body of the reply task: what to do, the excerpt, where it came from. Plain values only. */
export function replyTaskBody(b: ReplyTaskBodyInput): string {
  const plain = (s: string) => s.replace(/[`*_[\]()<>|~#\\]/g, '').replace(/\s+/g, ' ').trim();
  return [
    b.meetingIntent
      ? `**${plain(b.fromEmail)} quiere reunirse.** Cierra tú la fecha: revisa el borrador de respuesta, comprueba tu agenda y envíalo desde tu bandeja.`
      : b.class === 'INTERESADO'
        ? `**Respuesta interesada de ${plain(b.fromEmail)}.** Respóndela tú hoy o mañana: pide lo que falte (cantidades, fechas, logo) y prepara la propuesta.`
        : `**Pregunta de ${plain(b.fromEmail)}.** Contéstala tú desde tu bandeja.`,
    '',
    `- Recibido: ${b.receivedLocal} (${b.timezone})`,
    `- Asunto: ${plain(b.subject) || 'sin asunto'}`,
    ...(b.sendSubject ? [`- Responde a nuestro envío «${plain(b.sendSubject)}»`] : []),
    '',
    'Extracto (texto plano, sin el mensaje citado):',
    '',
    `> ${b.excerpt.length > 0 ? b.excerpt : '(sin texto)'}`,
    '',
    ...(b.draftSection ? [b.draftSection, ''] : []),
    'El Commercial OS no responde ni envía nada: la respuesta es tuya. Marca la tarea como hecha cuando hayas contestado.',
  ].join('\n');
}

/**
 * Base URL of the Twenty UI as the salesperson's browser sees it. Inside Docker the runtime talks to
 * Twenty on an internal host (`http://pxos-twenty:3000`) that does not resolve in the browser, so
 * links written into Tasks and notes use `TWENTY_PUBLIC_URL` when it is set.
 */
export function twentyPublicBaseUrl(apiBaseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const pub = env.TWENTY_PUBLIC_URL?.trim();
  return (pub || apiBaseUrl).replace(/\/+$/, '');
}

/** Link to a record in the Twenty UI. */
export function twentyRecordUrl(baseUrl: string, objectSingular: 'note' | 'opportunity' | 'company' | 'person' | 'commercialHypothesis', id: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${twentyPublicBaseUrl(baseUrl, env)}/object/${objectSingular}/${encodeURIComponent(id)}`;
}

export interface ReplyTaskInput {
  title: string;
  /**
   * Tanda 23: older spellings of `title` (emoji first) that also identify the task: an open task
   * created before the change is reused (and keeps its title).
   */
  legacyTitles?: readonly string[];
  bodyMarkdown: string;
  dueAt: string;
  companyId?: string | null;
  opportunityId?: string | null;
  personId?: string | null;
  /**
   * Tanda 22: markdown appended to the body when an OPEN task is reused (another reply of the
   * same contact), so its new reply draft is there too. Append-only (what a person wrote in the
   * task stays) and idempotent: skipped when the body already contains `marker`.
   */
  appendOnReuse?: { markdown: string; marker: string } | null;
}

export interface ReplyTaskResult {
  created: boolean;
  /** Tanda 22: the reused task got `appendOnReuse` appended to its body. */
  appended?: boolean;
  task: { id: string; title: string; status: string | null; dueAt: string | null };
  targetIds: string[];
}

/**
 * Tanda 25: built on `createCrmTask` (src/integrations/twenty/tasks.ts), the single place that
 * decides whether a Task already exists, with the semantics this task always had: any day, only
 * an OPEN task (`scope: 'open'`), anchored on the opportunity, else the company (else only an
 * orphan is adopted: `anchor: 'none'`), same targets (opportunity, company, person) and the
 * idempotent append (`appendOnReuse`).
 */
export async function upsertReplyTask(twenty: TwentyClient, input: ReplyTaskInput, signal?: AbortSignal): Promise<ReplyTaskResult> {
  const r = await createCrmTask(
    twenty,
    {
      title: input.title,
      legacyTitles: input.legacyTitles,
      body: input.bodyMarkdown,
      dueAt: input.dueAt,
      status: 'TODO',
      scope: 'open',
      anchor: input.opportunityId ? 'opportunityId' : input.companyId ? 'companyId' : 'none',
      targets: {
        opportunityId: input.opportunityId ?? undefined,
        companyId: input.companyId ?? undefined,
        personId: input.personId ?? undefined,
      },
      appendOnReuse: input.appendOnReuse ?? null,
    },
    signal ? { signal } : {},
  );
  const task = r.task;
  return {
    created: r.created,
    ...(input.appendOnReuse ? { appended: r.appended ?? false } : {}),
    task: { id: task.id, title: task.title ?? r.title, status: task.status ?? 'TODO', dueAt: task.dueAt ?? r.dueAt ?? input.dueAt },
    targetIds: r.targetIds,
  };
}
