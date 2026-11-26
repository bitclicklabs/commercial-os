/**
 * Lead follow-up: pure rules of the daily check `lead-followup-check`.
 *
 * Tanda 21: a hypothesis whose first email went out from Twenty (`emailStatus = SENT`, row in
 * `email_sends`) and that, `FOLLOWUP_AFTER_BUSINESS_DAYS` working days later (Monday-Friday in
 * Europe/Madrid, public holidays not modelled), has no reply registered by the inbound triage gets
 * a native Task with a fixed script.
 *
 * Tanda 23, follow-up SEQUENCE: the first email is touch 1; up to `FOLLOWUP_MAX_TOUCHES` (default 2)
 * follow-ups more, each a Task «Seguimiento N — <empresa> 🔔» (N = touch - 1) with a DRAFT to answer
 * in the same thread. Touch 2 is due N working days after the first send; touch 3 (and 4), N working
 * days after the LAST follow-up the commercial really sent (an outbound email Twenty imported from
 * the connected mailbox). A touch counts as sent only if that email exists: an unsent follow-up
 * never makes the next one (no piling up of Tasks), and it is never created twice either.
 *
 * Tanda 23, «retomar conversación»: an OPEN opportunity before the meeting stage whose thread with
 * the client ends in OUR email, at least N working days old, gets a Task «Retomar conversación con
 * <empresa> 🔔» with a draft; at most FOLLOWUP_MAX_TOUCHES consecutive outbound emails without an
 * answer (counting ours).
 *
 * Titles end with their emoji (Twenty draws the icon of a Task with its first character, and an
 * emoji there shows as a broken «?»); the old emoji-first spellings are still recognised.
 *
 * Everything here is deterministic: no LLM, no I/O. The system never sends anything.
 */
import { addBusinessDays } from './reply-task.js';
import { CRM_TASK_TITLE_MAX, legacyEmojiFirstTitle } from '../integrations/twenty/tasks.js';

export const FOLLOWUP_TIMEZONE = 'Europe/Madrid';
export const DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS = 5;
/** Follow-ups after the first email (tanda 23). 0..3; 0 = the check runs but creates nothing. */
export const DEFAULT_FOLLOWUP_MAX_TOUCHES = 2;
export const FOLLOWUP_MAX_TOUCHES_CAP = 3;
/** Fixed cap of tasks created per run (PM, tanda 21): the oldest sends first, the rest on later days. */
export const FOLLOWUP_MAX_TASKS_PER_RUN = 20;
export const FOLLOWUP_TASK_EMOJI = '🔔';
/** Title of tanda 21 (one task per hypothesis, emoji first): still recognised as touch 2. */
export const LEGACY_FOLLOWUP_TASK_PREFIX = '🔔 Seguimiento — ';
export const FOLLOWUP_AUDIT_ACTION = 'lead.followup_task';
export const FOLLOWUP_AUDIT_SUBJECT = 'commercial_hypothesis';
/** «Retomar conversación» marks: subject = the opportunity, detail `kind: 'conversation'`. */
export const CONVERSATION_AUDIT_SUBJECT = 'opportunity';
/**
 * An outbound email this close to a recorded send (email_sends) is that send as imported from the
 * «Sent» folder, not a follow-up.
 */
export const FIRST_SEND_MARGIN_MS = 30 * 60_000;
/** How far back the conversation of an opportunity is read. */
export const CONVERSATION_LOOKBACK_DAYS = 180;

export type FollowUpSkipReason =
  | 'task_exists'
  | 'no_send_record'
  | 'too_recent'
  | 'replied'
  | 'bounced'
  | 'suppressed'
  | 'no_company'
  | 'cap_reached'
  | 'suppression_list_unavailable'
  | 'max_touches_zero'
  | 'touches_exhausted'
  | 'previous_touch_not_sent'
  | 'messages_unavailable';

export type ConversationSkipReason =
  | 'stage_not_before_meeting'
  | 'no_contacts'
  | 'no_messages'
  | 'last_message_inbound'
  | 'too_recent'
  | 'touches_exhausted'
  | 'already_done'
  | 'open_task'
  | 'suppressed'
  | 'cap_reached'
  | 'suppression_list_unavailable'
  | 'max_touches_zero'
  | 'messages_unavailable';

const intEnv = (raw: string | undefined, min: number, max: number, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/**
 * `FOLLOWUP_AFTER_BUSINESS_DAYS`: integer 0..60, default 5. `0` disables the check. Anything
 * else (typo, negative, decimal) falls back to the default, so a typo never disables it.
 */
export function followUpAfterBusinessDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.FOLLOWUP_AFTER_BUSINESS_DAYS, 0, 60, DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS);
}

/**
 * `FOLLOWUP_MAX_TOUCHES` (tanda 23): follow-ups after the first email, integer 0..3, default 2.
 * `0` = the check runs and creates nothing (`max_touches_zero`). Invalid -> 2.
 */
export function followUpMaxTouchesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.FOLLOWUP_MAX_TOUCHES, 0, FOLLOWUP_MAX_TOUCHES_CAP, DEFAULT_FOLLOWUP_MAX_TOUCHES);
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

const bound = (title: string) => (title.length <= CRM_TASK_TITLE_MAX ? title : `${title.slice(0, CRM_TASK_TITLE_MAX - 3)}… ${FOLLOWUP_TASK_EMOJI}`);
const companyLabel = (company: string) => plain(company).replace(/["\\]/g, '') || 'empresa sin nombre';

/**
 * «Seguimiento N — <empresa> 🔔», N = touch - 1 (touch 1 is the first email): text first, emoji
 * last; no quotes or backslashes (filter values cannot carry them), bounded.
 */
export function followUpTaskTitle(company: string, touch = 2): string {
  return bound(`Seguimiento ${Math.max(1, touch - 1)} — ${companyLabel(company).slice(0, 200)} ${FOLLOWUP_TASK_EMOJI}`);
}

/** Older spellings of the same task: emoji first; for touch 2, also the tanda-21 «🔔 Seguimiento — X». */
export function followUpLegacyTitles(company: string, touch = 2): string[] {
  const title = followUpTaskTitle(company, touch);
  const out = [legacyEmojiFirstTitle(title)];
  if (touch === 2) {
    const old = `${LEGACY_FOLLOWUP_TASK_PREFIX}${companyLabel(company)}`;
    out.push(old.length <= CRM_TASK_TITLE_MAX ? old : `${old.slice(0, CRM_TASK_TITLE_MAX - 1)}…`);
  }
  return [...new Set(out.filter((t): t is string => typeof t === 'string' && t !== title))];
}

/** «Retomar conversación con <empresa> 🔔». */
export function conversationTaskTitle(company: string): string {
  return bound(`Retomar conversación con ${companyLabel(company).slice(0, 200)} ${FOLLOWUP_TASK_EMOJI}`);
}

/** An open task with one of these texts already asks the commercial to act on the opportunity. */
const BLOCKING_TASK_RE = /(retomar conversación con|cerrar reunión con)/i;
export function isBlockingOpportunityTask(title: string): boolean {
  return BLOCKING_TASK_RE.test(title);
}

// ---------------------------------------------------------------------------
// Sequence of a hypothesis
// ---------------------------------------------------------------------------

/**
 * Outbound emails that are follow-ups of the sends: after the first send (plus the margin) and not
 * the imported copy of any recorded send. Oldest first.
 */
export function detectFollowUps<T extends { receivedAt: string }>(sends: readonly Date[], outbound: readonly T[], margin = FIRST_SEND_MARGIN_MS): T[] {
  if (sends.length === 0) return [];
  const first = Math.min(...sends.map((d) => d.getTime()));
  return outbound
    .filter((m) => {
      const t = Date.parse(m.receivedAt);
      return t > first + margin && sends.every((s) => Math.abs(s.getTime() - t) > margin);
    })
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

export type TouchPlan = { status: 'next'; touch: number } | { status: 'skip'; reason: 'touches_exhausted' | 'previous_touch_not_sent' };

/**
 * Next touch of a hypothesis. `created`: touches whose Task already exists (audit marks); `sent`:
 * follow-ups really sent (outbound emails detected). The next touch is the one after the highest of
 * both; touch T >= 3 needs touch T-1 SENT (otherwise its Task stays open and nothing new is made).
 */
export function planNextTouch(a: { created: ReadonlySet<number>; sent: number; maxTouches: number }): TouchPlan {
  const maxCreated = Math.max(1, ...a.created);
  const next = Math.max(maxCreated, 1 + a.sent) + 1;
  if (next > 1 + a.maxTouches) return { status: 'skip', reason: 'touches_exhausted' };
  if (next >= 3 && a.sent < next - 2) return { status: 'skip', reason: 'previous_touch_not_sent' };
  return { status: 'next', touch: next };
}

export type FollowUpKind = 'recordatorio' | 'cierre';

/** Touch 2 is a reminder; the LAST allowed touch from 3 on is the friendly close. */
export function followUpKind(touch: number, maxTouches: number): FollowUpKind {
  return touch >= 3 && touch >= 1 + maxTouches ? 'cierre' : 'recordatorio';
}

// ---------------------------------------------------------------------------
// «Retomar conversación» of an opportunity
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  receivedAt: string;
  threadId: string | null;
  subject: string | null;
  text: string | null;
  from: string;
  textRestricted?: boolean;
}

export type ConversationPlan =
  | {
      status: 'due';
      lastOutbound: ConversationMessage;
      lastInbound: ConversationMessage | null;
      consecutiveOutbound: number;
      businessDays: number;
      thread: ConversationMessage[];
    }
  | { status: 'skip'; reason: 'no_messages' | 'last_message_inbound' | 'too_recent' | 'touches_exhausted'; lastOutbound?: ConversationMessage; consecutiveOutbound?: number; businessDays?: number };

/**
 * The thread is the one of the most recent message (all the messages when Twenty gives no thread).
 * Due when its LAST message is ours, at least `days` working days old, and the consecutive outbound
 * emails at its end are fewer than `maxTouches` (the task leads to one more).
 */
export function planConversation(messages: readonly ConversationMessage[], now: Date, days: number, maxTouches: number, timeZone = FOLLOWUP_TIMEZONE): ConversationPlan {
  const sorted = [...new Map(messages.map((m) => [m.id, m])).values()].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const last = sorted[sorted.length - 1];
  if (!last) return { status: 'skip', reason: 'no_messages' };
  const thread = last.threadId ? sorted.filter((m) => m.threadId === last.threadId) : sorted;
  if (last.direction !== 'OUTBOUND') return { status: 'skip', reason: 'last_message_inbound' };
  // The silence is counted over ALL the messages with the contact: an answer of the client in
  // another thread is an answer too.
  let consecutive = 0;
  for (let i = sorted.length - 1; i >= 0 && sorted[i]!.direction === 'OUTBOUND'; i--) consecutive += 1;
  const lastInbound = [...sorted].reverse().find((m) => m.direction === 'INBOUND') ?? null;
  const at = new Date(last.receivedAt);
  const businessDays = businessDaysSince(at, now, timeZone);
  if (consecutive >= maxTouches) return { status: 'skip', reason: 'touches_exhausted', lastOutbound: last, consecutiveOutbound: consecutive, businessDays };
  if (!isFollowUpDue(at, now, days, timeZone)) return { status: 'skip', reason: 'too_recent', lastOutbound: last, consecutiveOutbound: consecutive, businessDays };
  return { status: 'due', lastOutbound: last, lastInbound, consecutiveOutbound: consecutive, businessDays, thread };
}

// ---------------------------------------------------------------------------
// Task bodies
// ---------------------------------------------------------------------------

/**
 * Fixed script of the follow-up (PM rule: no urgency, never "plazos cortos"): the fallback when
 * the draft is not available. The angle of the hypothesis (need / why now) makes it specific.
 */
export const FOLLOWUP_SCRIPT: readonly string[] = [
  'Retoma tu primer email en una línea y sin reproches («Os escribí hace unos días sobre…»).',
  'Aporta algo útil y concreto: una idea de producto o un ejemplo para su caso, ligado a la necesidad de arriba.',
  'Cierra con una pregunta abierta y fácil de contestar; sin presionar: si ahora no es buen momento, ofrécete para más adelante.',
];

export const CONVERSATION_SCRIPT: readonly string[] = [
  'Retoma la conversación donde se quedó, en una línea y sin reproches («Te escribo para retomar lo que hablamos sobre…»).',
  'Aporta algo útil: una idea, un ejemplo o una respuesta a lo que preguntó el cliente.',
  'Cierra con una pregunta abierta y fácil de contestar, o propón una llamada corta.',
];

export interface FollowUpHistoryItem {
  touch: number;
  at: string;
  subject: string | null;
}

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
  /** Tanda 23: the touch this task is (2 = first follow-up). */
  touch?: number;
  maxTouches?: number;
  /** Follow-ups detected in the mailbox (local times). */
  history?: readonly FollowUpHistoryItem[];
  /** Mailbox trace not available: only the first send was counted. */
  degraded?: string | null;
  /** «Borrador» section (markdown) or null for the fixed script only. */
  draftSection?: string | null;
  /** Twenty masks the text of the emails (channel visibility below «Share everything»). */
  textRestricted?: boolean;
}

/** Line of a Task whose thread text Twenty does not let the runtime read. */
export const TEXT_RESTRICTED_LINE =
  '_El sistema no puede leer el texto de tus correos: en Twenty, pon la visibilidad del correo en Share everything (Settings → Accounts → tu cuenta → correo)._';
/** Line of a Task whose draft has no readable subject to answer with «Re: …». */
export const NO_SUBJECT_LINE = '_No hay un asunto legible del hilo: envía el borrador respondiendo al hilo existente (no como un correo nuevo), para que el cliente lo vea en la misma conversación._';

const MAX_ANGLE = 600;
const bounded = (s: string) => (s.length <= MAX_ANGLE ? s : `${s.slice(0, MAX_ANGLE - 1).trimEnd()}…`);

/** Markdown body of the follow-up task. Plain values only (no markdown from the records). */
export function followUpTaskBody(b: FollowUpBodyInput): string {
  const need = b.need ? bounded(plain(b.need)) : null;
  const whyNow = b.whyNow ? bounded(plain(b.whyNow)) : null;
  const touch = b.touch ?? 2;
  const max = b.maxTouches ?? DEFAULT_FOLLOWUP_MAX_TOUCHES;
  const history = b.history ?? [];
  const lastLine =
    touch >= 1 + max
      ? 'Es el último seguimiento de la secuencia: si no contesta, no se creará ninguna tarea más para esta hipótesis.'
      : `Si no contesta, cuando envíes este seguimiento se creará el siguiente (hasta ${max} seguimientos). Si no lo envías, no se creará ninguno más.`;
  return [
    `**Seguimiento ${touch - 1} del primer email a ${plain(b.company) || 'la empresa'}.** Han pasado ${b.businessDays} días laborables sin respuesta registrada en el buzón.`,
    '',
    `- Primer envío: ${b.sentLocal} (${b.timezone})`,
    `- Asunto: ${b.subject ? `«${plain(b.subject)}»` : 'sin asunto registrado'}`,
    `- Destinatario: ${plain(b.recipient) || 'sin destinatario registrado'}`,
    `- Hipótesis: ${plain(b.hypothesisName)}`,
    '',
    'Toques de la secuencia:',
    '',
    `- Toque 1 (primer email): ${b.sentLocal}`,
    ...history.map((h) => `- Toque ${h.touch} (seguimiento enviado): ${h.at}${h.subject ? ` — «${plain(h.subject)}»` : ''}`),
    `- Toque ${touch}: esta tarea`,
    ...(b.degraded ? ['', `_Sin rastro del buzón en el CRM (${plain(b.degraded)}): solo se ha contado el primer envío._`] : []),
    ...(b.textRestricted ? ['', TEXT_RESTRICTED_LINE] : []),
    ...(!b.subject ? ['', NO_SUBJECT_LINE] : []),
    '',
    'Ángulo de la hipótesis:',
    '',
    `- Necesidad: ${need ?? 'sin dato'}`,
    `- Por qué ahora: ${whyNow ?? 'sin dato'}`,
    '',
    ...(b.draftSection ? [b.draftSection, ''] : []),
    'Guion sugerido (si prefieres escribirlo tú, respondiendo al hilo del primer email):',
    '',
    ...FOLLOWUP_SCRIPT.map((l) => `- ${l}`),
    '',
    `El Commercial OS no envía nada: el seguimiento lo revisas y lo envías tú. Si ya habéis hablado por otra vía, marca la tarea como hecha. ${lastLine}`,
  ].join('\n');
}

export interface ConversationBodyInput {
  company: string;
  opportunityName: string | null;
  stage: string | null;
  contact: string;
  timezone: string;
  businessDays: number;
  consecutiveOutbound: number;
  maxTouches: number;
  lastOutbound: { at: string; subject: string | null };
  lastInbound: { at: string; subject: string | null; excerpt: string | null } | null;
  draftSection?: string | null;
  textRestricted?: boolean;
  /** The thread has a readable subject (else the draft says «Seguimiento: …»). */
  hasSubject?: boolean;
}

/** Markdown body of the «Retomar conversación» task. */
export function conversationTaskBody(b: ConversationBodyInput): string {
  const excerpt = b.lastInbound?.excerpt ? bounded(plain(b.lastInbound.excerpt)) : null;
  return [
    `**Retomar la conversación con ${plain(b.company) || 'la empresa'}.** Nuestro último email lleva ${b.businessDays} días laborables sin respuesta.`,
    '',
    `- Oportunidad: ${plain(b.opportunityName ?? '') || 'sin nombre'} (etapa ${plain(b.stage ?? '') || 'sin etapa'})`,
    `- Contacto: ${plain(b.contact)}`,
    `- Nuestro último email: ${b.lastOutbound.at} (${b.timezone})${b.lastOutbound.subject ? ` — «${plain(b.lastOutbound.subject)}»` : ''}`,
    `- Último mensaje del cliente: ${b.lastInbound ? `${b.lastInbound.at}${b.lastInbound.subject ? ` — «${plain(b.lastInbound.subject)}»` : ''}` : 'no consta en el hilo'}`,
    ...(excerpt ? [`- Extracto del cliente: «${excerpt}»`] : []),
    `- Emails nuestros seguidos sin respuesta: ${b.consecutiveOutbound} (como mucho ${b.maxTouches}; con este serían ${b.consecutiveOutbound + 1})`,
    ...(b.textRestricted ? ['', TEXT_RESTRICTED_LINE] : []),
    ...(b.hasSubject === false ? ['', NO_SUBJECT_LINE] : []),
    '',
    ...(b.draftSection ? [b.draftSection, ''] : []),
    'Guion sugerido (si prefieres escribirlo tú, respondiendo en el mismo hilo):',
    '',
    ...CONVERSATION_SCRIPT.map((l) => `- ${l}`),
    '',
    'El Commercial OS no envía nada: el email lo revisas y lo envías tú. Si ya habéis hablado por otra vía, marca la tarea como hecha. Si el cliente contesta, no se creará ninguna tarea más hasta que vuelva a quedarse en silencio.',
  ].join('\n');
}
