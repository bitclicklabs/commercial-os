/**
 * Native Twenty `Task` «📬 Responder a <persona/empresa>» of the inbound triage (tanda 19):
 * what the commercial has to DO about a reply (the 📬 note stays as the record with the
 * excerpt). Created by the triage for INTERESADO and PREGUNTA replies, linked through
 * `taskTargets` to the opportunity (if any), the company and the person.
 *
 * Direct REST on purpose (agreement with the parallel branch `feat/native-tasks-views`, which
 * adds the generic `createCrmTask` helper in src/integrations/twenty/tasks.ts): the PM unifies
 * both helpers when merging. Shape verified read-only (GET /rest/open-api/core): Task
 * `{ title, bodyV2: { markdown }, dueAt, status TODO|IN_PROGRESS|DONE, assigneeId }`,
 * TaskTarget `{ taskId, targetCompanyId, targetPersonId, targetOpportunityId, ... }`.
 *
 * Idempotent: an open task (TODO / IN_PROGRESS) with the same title that already targets the
 * same opportunity (or, without one, the same company) is reused and only its missing targets
 * are added. A retried run never duplicates it.
 */
import { TWENTY_OBJECTS, filterValue, type TwentyClient, type TwentyTask, type TwentyTaskTarget } from '../integrations/twenty/index.js';

export const REPLY_TASK_PREFIX = '📬 Responder a ';
export const TASK_TITLE_MAX = 255;
export const REPLY_TASK_BUSINESS_DAYS = 2;

/** `📬 Responder a <who>`: no quotes or backslashes (filter values cannot carry them), bounded. */
export function replyTaskTitle(who: string): string {
  const w = who
    .replace(/["\\]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = `${REPLY_TASK_PREFIX}${w || 'la respuesta'}`;
  return title.length <= TASK_TITLE_MAX ? title : `${title.slice(0, TASK_TITLE_MAX - 1)}…`;
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
}

/** Markdown body of the reply task: what to do, the excerpt, where it came from. Plain values only. */
export function replyTaskBody(b: ReplyTaskBodyInput): string {
  const plain = (s: string) => s.replace(/[`*_[\]()<>|~#\\]/g, '').replace(/\s+/g, ' ').trim();
  return [
    b.class === 'INTERESADO'
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
    'El Commercial OS no responde ni envía nada: la respuesta es tuya. Marca la tarea como hecha cuando hayas contestado.',
  ].join('\n');
}

/** Link to a record in the Twenty UI (self-hosted: the UI is served on the API's base URL). */
export function twentyRecordUrl(baseUrl: string, objectSingular: 'note' | 'opportunity' | 'company' | 'person', id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/object/${objectSingular}/${encodeURIComponent(id)}`;
}

export interface ReplyTaskInput {
  title: string;
  bodyMarkdown: string;
  dueAt: string;
  companyId?: string | null;
  opportunityId?: string | null;
  personId?: string | null;
}

export interface ReplyTaskResult {
  created: boolean;
  task: { id: string; title: string; status: string | null; dueAt: string | null };
  targetIds: string[];
}

async function targetsOf(twenty: TwentyClient, taskId: string, signal?: AbortSignal): Promise<TwentyTaskTarget[]> {
  const { records } = await twenty.list<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { filter: `taskId[eq]:${filterValue(taskId)}`, limit: 50, ...(signal ? { signal } : {}) });
  return records;
}

export async function upsertReplyTask(twenty: TwentyClient, input: ReplyTaskInput, signal?: AbortSignal): Promise<ReplyTaskResult> {
  const opts = signal ? { signal } : {};
  const anchor = input.opportunityId ? { key: 'targetOpportunityId' as const, id: input.opportunityId } : input.companyId ? { key: 'targetCompanyId' as const, id: input.companyId } : null;
  const { records: sameTitle } = await twenty.list<TwentyTask>(TWENTY_OBJECTS.task, { filter: `title[eq]:${filterValue(input.title)}`, limit: 20, ...opts });
  let task: TwentyTask | null = null;
  let targets: TwentyTaskTarget[] = [];
  let orphan: TwentyTask | null = null;
  for (const candidate of sameTitle) {
    if (candidate.deletedAt || candidate.status === 'DONE') continue;
    const t = await targetsOf(twenty, candidate.id, signal);
    if (anchor && t.some((x) => x[anchor.key] === anchor.id)) {
      task = candidate;
      targets = t;
      break;
    }
    // A task with that title and no targets at all: a previous call died between the POSTs.
    if (t.length === 0 && !orphan) orphan = candidate;
  }
  if (!task && orphan) task = orphan;
  const created = task === null;
  if (!task) {
    task = await twenty.create<TwentyTask>(TWENTY_OBJECTS.task, { title: input.title, bodyV2: { markdown: input.bodyMarkdown }, dueAt: input.dueAt, status: 'TODO' }, opts);
  }
  const want: Array<[keyof TwentyTaskTarget, string | null | undefined]> = [
    ['targetOpportunityId', input.opportunityId],
    ['targetCompanyId', input.companyId],
    ['targetPersonId', input.personId],
  ];
  for (const [key, id] of want) {
    if (!id || targets.some((t) => t[key] === id)) continue;
    targets.push(await twenty.create<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { taskId: task.id, [key]: id }, opts));
  }
  return { created, task: { id: task.id, title: task.title ?? input.title, status: task.status ?? 'TODO', dueAt: task.dueAt ?? input.dueAt }, targetIds: targets.map((t) => t.id) };
}
