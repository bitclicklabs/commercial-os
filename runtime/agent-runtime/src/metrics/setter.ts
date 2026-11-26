/**
 * Setter metrics (tanda 24, AI Setter level 1: the system prepares, the salesperson sends): does
 * the funnel convert, and does the salesperson answer fast? For a period [since, until) in
 * Europe/Madrid. Read only: nothing here writes or sends.
 *
 * Sources (what each number is made of):
 * - `primeros_contactos`: the recipients of `email_sends` (first email sent from the Twenty
 *   workflow) in the period, plus the OUTBOUND messages of the mailbox imported by Twenty to an
 *   address with no earlier message (any direction) and no earlier `email_sends`. One per
 *   recipient. A mailbox message to a workflow recipient within 15 minutes of the send is the same
 *   email (the workflow sends through the connected account, which imports it as «Sent»).
 * - `seguimientos_enviados`: the other OUTBOUND messages of the period (to an address that already
 *   had messages), plus workflow sends to a known recipient. Not available without the mailbox.
 * - `respuestas`: `inbound_triage` rows received in the period, by class; human = INTERESADO +
 *   PREGUNTA + NO_INTERESADO + BAJA; AUTO_REPLY and OTRO apart.
 * - `tasa_respuesta`: COHORT rate. Cohort = the first contacts of the period; a contact counts as
 *   answered when a human reply from that address (or tied to that send / hypothesis by the
 *   triage) arrives within 30 days of the contact. Until 30 days after the end of the period the
 *   cohort is still open and the rate can only grow (`cohorte_cerrada: false`).
 * - `interesados`: INTERESADO replies of the period. `reuniones_detectadas`: `audit_log` rows
 *   `opportunity.meeting_detected` of the period (task `meeting-sync`).
 * - `oportunidades_abiertas`: Twenty opportunities not won / lost / closed, by stage (now).
 * - `velocidad_respuesta_comercial`: for the replies that expect an answer (INTERESADO, PREGUNTA)
 *   received in the period, working hours (Mon-Fri 09:00-18:00 Europe/Madrid, no public holidays)
 *   until our next OUTBOUND message to that address in the mailbox (same thread when it can be
 *   told, else the next one to the address); the median. Plus, NOW, the replies of the last 30 days
 *   still unanswered after more than one working day (9 working hours).
 * - `tareas_vencidas`: open system tasks («Responder a…», «Cerrar reunión con…», «Seguimiento N —…»,
 *   «Retomar conversación con…», new and old spelling) past their due date (now).
 * - `coste_llm_eur`: `agent_executions` created in the period (same EUR rule as /metrics/summary).
 * - `por_origen`: email_sends -> hypothesis -> commercialSignal (the fair); else «sin atribuir».
 *
 * Anything that cannot be read (Twenty down, mailbox not synced or hidden) is null and listed in
 * `no_disponible` with the reason: never a false zero.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { InboundTriageClass } from '../db/schema.js';
import { localDay, localMinute } from '../crm/followup.js';
import { addBusinessDays } from '../crm/reply-task.js';
import { normAddress, type MailMessage, type WindowMessage } from '../integrations/twenty/messages.js';
import { MEETING_SYNC_AUDIT_ACTION } from '../meetings/meeting-sync.js';
import { execCostEur, windowWhere } from './queries.js';
import { noDisponible, ok, type Avail, type OriginInfo, type OverdueTask, type SetterCrmReader, type SystemTaskKind } from './setter-crm.js';
import { addDays, localMidnight } from './twenty-sync.js';

export const SETTER_TIMEZONE = 'Europe/Madrid';
export const SETTER_COHORT_DAYS = 30;
export const SETTER_WORKDAY_START_HOUR = 9;
export const SETTER_WORKDAY_END_HOUR = 18;
/** «More than one working day» waiting = more than one working day of hours. */
export const SETTER_UNANSWERED_MIN_HOURS = SETTER_WORKDAY_END_HOUR - SETTER_WORKDAY_START_HOUR;
export const SETTER_UNANSWERED_LOOKBACK_DAYS = 30;
/** A mailbox message this close to a workflow send (same recipient) is that same email. */
export const SAME_EMAIL_TOLERANCE_MS = 15 * 60_000;
export const SETTER_MAX_PERIOD_DAYS = 92;
export const SETTER_DEFAULT_DAYS = 7;
export const UNATTRIBUTED = 'sin atribuir';

export const HUMAN_REPLY_CLASSES = ['INTERESADO', 'PREGUNTA', 'NO_INTERESADO', 'BAJA'] as const;
export const EXPECTS_ANSWER_CLASSES = ['INTERESADO', 'PREGUNTA'] as const;
const PER_CLASS = ['INTERESADO', 'PREGUNTA', 'NO_INTERESADO', 'BAJA', 'REBOTE'] as const;
const APART = ['AUTO_REPLY', 'OTRO'] as const;

const DAY = 86_400_000;
const HOUR = 3_600_000;

const isHuman = (c: string) => (HUMAN_REPLY_CLASSES as readonly string[]).includes(c);
const expectsAnswer = (c: string) => (EXPECTS_ANSWER_CLASSES as readonly string[]).includes(c);

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** UTC instant of `hour`:00 local of `day` (DST safe, through `addBusinessDays(…, 0)`). */
function localHour(day: string, hour: number, timeZone: string): number {
  return addBusinessDays(new Date(localMidnight(day, timeZone).getTime() + 12 * HOUR), 0, timeZone, hour).getTime();
}

/**
 * Working hours between `a` and `b`: the overlap with Monday-Friday 09:00-18:00 local time
 * (public holidays are not modelled, like `addBusinessDays`). 0 when `b <= a`.
 */
export function businessHoursBetween(a: Date, b: Date, timeZone = SETTER_TIMEZONE, startHour = SETTER_WORKDAY_START_HOUR, endHour = SETTER_WORKDAY_END_HOUR): number {
  if (b.getTime() <= a.getTime()) return 0;
  let total = 0;
  let day = localDay(a, timeZone);
  const last = localDay(b, timeZone);
  for (let guard = 0; day <= last && guard < 400; guard++, day = addDays(day, 1)) {
    const dow = weekday(day);
    if (dow === 0 || dow === 6) continue;
    const s = localHour(day, startHour, timeZone);
    const e = localHour(day, endHour, timeZone);
    total += Math.max(0, Math.min(e, b.getTime()) - Math.max(s, a.getTime()));
  }
  return total / HOUR;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round = (v: number, digits = 2) => Number(v.toFixed(digits));

export interface SetterPeriod {
  /** Local days, `to` exclusive. */
  from: string;
  to: string;
  since: Date;
  until: Date;
}

export function setterPeriod(from: string, to: string, timeZone = SETTER_TIMEZONE): SetterPeriod {
  return { from, to, since: localMidnight(from, timeZone), until: localMidnight(to, timeZone) };
}

/** The last `days` local days, today included: [today - days + 1, tomorrow). */
export function defaultSetterPeriod(now: Date, days = SETTER_DEFAULT_DAYS, timeZone = SETTER_TIMEZONE): SetterPeriod {
  const to = addDays(localDay(now, timeZone), 1);
  return setterPeriod(addDays(to, -days), to, timeZone);
}

/** Monday (local day) of the week of `day`. */
export function mondayOf(day: string): string {
  return addDays(day, -((weekday(day) + 6) % 7));
}

// ---------------------------------------------------------------------------
// Runtime database
// ---------------------------------------------------------------------------
export interface SetterSendRow {
  id: string;
  hypothesisId: string;
  companyId: string | null;
  recipients: string[];
  sentAt: Date;
}

export interface SetterTriageRow {
  id: string;
  class: InboundTriageClass;
  receivedAt: Date;
  fromEmail: string | null;
  companyId: string | null;
  hypothesisId: string | null;
  sendId: string | null;
}

export interface SetterMeetingRow {
  opportunityId: string | null;
  companyId: string | null;
  occurredAt: Date;
  startsAt: string | null;
}

export interface SetterDbData {
  /** `email_sends` of the period. */
  sends: SetterSendRow[];
  /** Recipients of those sends that already had an `email_sends` before the period. */
  priorSendRecipients: string[];
  /** `inbound_triage` received in [min(since, now - 30 d), until + 30 d). */
  triage: SetterTriageRow[];
  /** `opportunity.meeting_detected` of the period. */
  meetings: SetterMeetingRow[];
  /** Detected meetings that start in [now, now + 7 d). */
  upcomingMeetings: SetterMeetingRow[];
  /** Latest hypothesis sent to each company of the meetings and replies (for the origin). */
  companyHypothesis: Record<string, string>;
  costEur: number;
}

type Row = Record<string, unknown>;
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')));
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const splitRecipients = (v: unknown): string[] =>
  [...new Set(String(v ?? '').split(',').map(normAddress).filter((a): a is string => a !== null))];

async function rows(db: Db, q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(q)).rows as Row[];
}

export async function readSetterDb(db: Db, q: { tenantId: string; since: Date; until: Date; now: Date }): Promise<SetterDbData> {
  const t = q.tenantId;
  const sendRows = await rows(
    db,
    sql`select id, hypothesis_id, company_id, to_email, sent_at from email_sends
        where tenant_id = ${t} and sent_at >= ${q.since.toISOString()}::timestamptz and sent_at < ${q.until.toISOString()}::timestamptz
        order by sent_at`,
  );
  const sends: SetterSendRow[] = sendRows.map((r) => ({
    id: String(r.id),
    hypothesisId: String(r.hypothesis_id),
    companyId: strOrNull(r.company_id),
    recipients: splitRecipients(r.to_email),
    sentAt: asDate(r.sent_at),
  }));
  const recipients = [...new Set(sends.flatMap((s) => s.recipients))];
  const prior = recipients.length
    ? await rows(
        db,
        sql`select distinct x.addr from email_sends s, unnest(string_to_array(lower(s.to_email), ',')) as x(addr)
            where s.tenant_id = ${t} and s.sent_at < ${q.since.toISOString()}::timestamptz
              and trim(x.addr) = any(string_to_array(${recipients.join(',')}, ','))`,
      )
    : [];

  const triageSince = new Date(Math.min(q.since.getTime(), q.now.getTime() - SETTER_UNANSWERED_LOOKBACK_DAYS * DAY));
  const triageUntil = new Date(q.until.getTime() + SETTER_COHORT_DAYS * DAY);
  const triageRows = await rows(
    db,
    sql`select id, class, coalesce(received_at, created_at) as at, from_email, company_id, hypothesis_id, send_id from inbound_triage
        where tenant_id = ${t} and coalesce(received_at, created_at) >= ${triageSince.toISOString()}::timestamptz
          and coalesce(received_at, created_at) < ${triageUntil.toISOString()}::timestamptz
        order by at`,
  );
  const triage: SetterTriageRow[] = triageRows.map((r) => ({
    id: String(r.id),
    class: String(r.class) as InboundTriageClass,
    receivedAt: asDate(r.at),
    fromEmail: normAddress(r.from_email),
    companyId: strOrNull(r.company_id),
    hypothesisId: strOrNull(r.hypothesis_id),
    sendId: strOrNull(r.send_id),
  }));

  const meetingRow = (r: Row): SetterMeetingRow => ({
    opportunityId: strOrNull(r.subject_id),
    companyId: strOrNull(r.company_id),
    occurredAt: asDate(r.occurred_at),
    startsAt: strOrNull(r.starts_at),
  });
  const meetings = (
    await rows(
      db,
      sql`select subject_id, payload->>'company_id' as company_id, payload->>'starts_at' as starts_at, occurred_at from audit_log
          where tenant_id = ${t} and action = ${MEETING_SYNC_AUDIT_ACTION} and result = 'ok'
            and occurred_at >= ${q.since.toISOString()}::timestamptz and occurred_at < ${q.until.toISOString()}::timestamptz
          order by occurred_at`,
    )
  ).map(meetingRow);
  const upcomingMeetings = (
    await rows(
      db,
      sql`select subject_id, company_id, starts_at, occurred_at from (
            select subject_id, payload->>'company_id' as company_id, payload->>'starts_at' as starts_at, occurred_at from audit_log
            where tenant_id = ${t} and action = ${MEETING_SYNC_AUDIT_ACTION} and result = 'ok'
              and payload->>'starts_at' ~ '^\\d{4}-\\d{2}-\\d{2}T'
          ) m
          where m.starts_at::timestamptz >= ${q.now.toISOString()}::timestamptz and m.starts_at::timestamptz < ${new Date(q.now.getTime() + 7 * DAY).toISOString()}::timestamptz
          order by m.starts_at`,
    )
  ).map(meetingRow);

  const companies = [...new Set([...meetings, ...upcomingMeetings].map((m) => m.companyId).concat(triage.map((r) => r.companyId)).filter((c): c is string => c !== null))];
  const companyHypothesis: Record<string, string> = {};
  if (companies.length) {
    for (const r of await rows(
      db,
      sql`select distinct on (company_id) company_id, hypothesis_id from email_sends
          where tenant_id = ${t} and company_id = any(string_to_array(${companies.join(',')}, ','))
          order by company_id, sent_at desc`,
    ))
      companyHypothesis[String(r.company_id)] = String(r.hypothesis_id);
  }

  const [cost] = await rows(
    db,
    sql`select coalesce(sum(${execCostEur('e')}), 0) as eur from agent_executions e where ${windowWhere('e', 'created_at', { tenantId: t, since: q.since, until: q.until })}`,
  );
  return {
    sends,
    priorSendRecipients: prior.map((r) => String(r.addr).trim()),
    triage,
    meetings,
    upcomingMeetings,
    companyHypothesis,
    costEur: Number(cost?.eur ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------
export interface SetterSources {
  tenantId: string;
  timezone: string;
  period: SetterPeriod;
  now: Date;
  db: SetterDbData;
  mailWindow: Avail<{ messages: WindowMessage[]; truncated: boolean }>;
  priorMail: Avail<{ addresses: string[]; truncated: boolean }>;
  replyMail: Avail<{ byAddress: Record<string, MailMessage[]>; truncated: boolean }>;
  opportunities: Avail<{ total: number; byStage: Record<string, number>; truncated: boolean }>;
  overdue: Avail<{ tasks: OverdueTask[]; truncated: boolean }>;
  origins: Avail<Record<string, OriginInfo>>;
}

export interface FirstContact {
  address: string;
  at: string;
  source: 'workflow' | 'buzon';
  hypothesisId: string | null;
  sendId: string | null;
  origin: string;
}

export interface UnansweredReply {
  from: string;
  class: string;
  receivedAt: string;
  workingHoursWaiting: number;
  companyId: string | null;
}

export interface OriginRow {
  origen: string;
  signal_id: string | null;
  primeros_contactos: number;
  respuestas_humanas: number;
  interesados: number;
  reuniones: number;
}

export interface SetterMetrics {
  tenant_id: string;
  timezone: string;
  generated_at: string;
  periodo: { from: string; to: string; since: string; until: string; dias: number };
  primeros_contactos: { total: number; desde_workflow: number; desde_buzon: number | null; completo: boolean };
  seguimientos_enviados: number | null;
  respuestas: { total: number; humanas: number; por_clase: Record<(typeof PER_CLASS)[number], number>; aparte: Record<(typeof APART)[number], number> };
  tasa_respuesta: {
    valor: number | null;
    cohorte: number;
    respondidos: number;
    ventana_dias: number;
    cohorte_cerrada: boolean;
    explicacion: string;
  };
  interesados: number;
  reuniones_detectadas: number;
  oportunidades_abiertas: { total: number; por_etapa: Record<string, number>; truncado: boolean } | null;
  velocidad_respuesta_comercial: {
    mediana_horas_laborables: number | null;
    respuestas_que_esperan_contestacion: number;
    contestadas: number;
    sin_contestar_en_periodo: number;
    sin_contestar_mas_1_dia: number;
    sin_contestar: UnansweredReply[];
    horario: string;
  } | null;
  tareas_vencidas: { total: number; por_tipo: Record<SystemTaskKind, number>; tareas: OverdueTask[] } | null;
  coste_llm_eur: number;
  por_origen: OriginRow[] | null;
  /** Metric -> why it could not be computed. Empty when everything was read. */
  no_disponible: Record<string, string>;
  /** Sources read only in part (too many records): the numbers are a floor. */
  truncado: string[];
}

export function computeSetterMetrics(src: SetterSources): SetterMetrics {
  const { period, now } = src;
  const sinceMs = period.since.getTime();
  const untilMs = period.until.getTime();
  const noDisp: Record<string, string> = {};
  const truncated: string[] = [];
  const originOf = (hypothesisId: string | null | undefined): { name: string; signalId: string | null } => {
    if (!hypothesisId || src.origins.status !== 'ok') return { name: UNATTRIBUTED, signalId: null };
    const o = src.origins.value[hypothesisId];
    if (!o?.signalId) return { name: UNATTRIBUTED, signalId: null };
    return { name: o.signalName ?? `señal ${o.signalId.slice(0, 8)}`, signalId: o.signalId };
  };

  // 1. First contacts and follow-ups.
  type Ev = { addr: string; at: number; kind: 'send' | 'out' | 'in'; send?: SetterSendRow };
  const events: Ev[] = [];
  for (const s of src.db.sends) for (const addr of s.recipients) events.push({ addr, at: s.sentAt.getTime(), kind: 'send', send: s });
  const mailOk = src.mailWindow.status === 'ok';
  if (src.mailWindow.status === 'ok') {
    if (src.mailWindow.value.truncated) truncated.push('buzón (ventana del periodo)');
    for (const m of src.mailWindow.value.messages) {
      const at = Date.parse(m.receivedAt);
      for (const addr of m.counterparts) {
        if (m.direction === 'INBOUND') events.push({ addr, at, kind: 'in' });
        else if (!events.some((e) => e.kind === 'send' && e.addr === addr && Math.abs(e.at - at) <= SAME_EMAIL_TOLERANCE_MS)) events.push({ addr, at, kind: 'out' });
      }
    }
  } else {
    noDisp['primeros_contactos.desde_buzon'] = src.mailWindow.reason;
    noDisp.seguimientos_enviados = src.mailWindow.reason;
  }
  const prior = new Set(src.db.priorSendRecipients);
  if (src.priorMail.status === 'ok') {
    for (const a of src.priorMail.value.addresses) prior.add(a);
    if (src.priorMail.value.truncated) truncated.push('buzón (mensajes anteriores)');
  } else if (mailOk) noDisp['primeros_contactos.historial_buzon'] = src.priorMail.reason;
  const rank = { send: 0, out: 1, in: 2 } as const;
  events.sort((a, b) => a.at - b.at || rank[a.kind] - rank[b.kind]);
  const seen = new Set(prior);
  const firsts: FirstContact[] = [];
  let followUps = 0;
  for (const e of events) {
    if (e.kind !== 'in') {
      if (!seen.has(e.addr)) {
        const origin = originOf(e.send?.hypothesisId);
        firsts.push({ address: e.addr, at: new Date(e.at).toISOString(), source: e.kind === 'send' ? 'workflow' : 'buzon', hypothesisId: e.send?.hypothesisId ?? null, sendId: e.send?.id ?? null, origin: origin.name });
      } else followUps += 1;
    }
    seen.add(e.addr);
  }
  const fromWorkflow = firsts.filter((f) => f.source === 'workflow').length;

  // 2. Replies of the period.
  const inPeriod = src.db.triage.filter((r) => r.receivedAt.getTime() >= sinceMs && r.receivedAt.getTime() < untilMs);
  const porClase = Object.fromEntries(PER_CLASS.map((c) => [c, inPeriod.filter((r) => r.class === c).length])) as SetterMetrics['respuestas']['por_clase'];
  const aparte = Object.fromEntries(APART.map((c) => [c, inPeriod.filter((r) => r.class === c).length])) as SetterMetrics['respuestas']['aparte'];
  const humanas = inPeriod.filter((r) => isHuman(r.class)).length;

  // 3. Cohort rate.
  const humanTriage = src.db.triage.filter((r) => isHuman(r.class) && r.receivedAt.getTime() < now.getTime());
  const replyOf = (c: FirstContact): SetterTriageRow | null => {
    const at = Date.parse(c.at);
    return (
      humanTriage.find((r) => {
        const t = r.receivedAt.getTime();
        if (t < at || t >= at + SETTER_COHORT_DAYS * DAY) return false;
        return r.fromEmail === c.address || (c.sendId !== null && r.sendId === c.sendId) || (c.hypothesisId !== null && r.hypothesisId === c.hypothesisId);
      }) ?? null
    );
  };
  const replies = new Map(firsts.map((c) => [c, replyOf(c)] as const));
  const answered = [...replies.values()].filter((r) => r !== null).length;
  const cohortClosed = now.getTime() >= untilMs + SETTER_COHORT_DAYS * DAY;

  // 4. Salesperson speed.
  let velocidad: SetterMetrics['velocidad_respuesta_comercial'] = null;
  if (src.replyMail.status === 'ok') {
    if (src.replyMail.value.truncated) truncated.push('buzón (hilos de las respuestas)');
    const byAddress = src.replyMail.value.byAddress;
    const answerAt = (r: SetterTriageRow): number | null => {
      const msgs = r.fromEmail ? (byAddress[r.fromEmail] ?? []) : [];
      const t = r.receivedAt.getTime();
      const inbound = msgs
        .filter((m) => m.direction === 'INBOUND' && Math.abs(Date.parse(m.receivedAt) - t) <= SAME_EMAIL_TOLERANCE_MS)
        .sort((a, b) => Math.abs(Date.parse(a.receivedAt) - t) - Math.abs(Date.parse(b.receivedAt) - t))[0];
      const outs = msgs.filter((m) => m.direction === 'OUTBOUND' && Date.parse(m.receivedAt) > t && Date.parse(m.receivedAt) <= now.getTime()).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      const sameThread = inbound?.threadId ? outs.find((m) => m.threadId === inbound.threadId) : undefined;
      const out = sameThread ?? outs[0];
      return out ? Date.parse(out.receivedAt) : null;
    };
    const expecting = inPeriod.filter((r) => expectsAnswer(r.class) && r.fromEmail);
    const hours: number[] = [];
    let unansweredInPeriod = 0;
    for (const r of expecting) {
      const a = answerAt(r);
      if (a === null) unansweredInPeriod += 1;
      else hours.push(businessHoursBetween(r.receivedAt, new Date(a), src.timezone));
    }
    const lookback = now.getTime() - SETTER_UNANSWERED_LOOKBACK_DAYS * DAY;
    const waiting: UnansweredReply[] = [];
    for (const r of src.db.triage) {
      const t = r.receivedAt.getTime();
      if (!expectsAnswer(r.class) || !r.fromEmail || t < lookback || t >= now.getTime()) continue;
      if (answerAt(r) !== null) continue;
      const h = businessHoursBetween(r.receivedAt, now, src.timezone);
      if (h > SETTER_UNANSWERED_MIN_HOURS) waiting.push({ from: r.fromEmail, class: r.class, receivedAt: r.receivedAt.toISOString(), workingHoursWaiting: round(h, 1), companyId: r.companyId });
    }
    const med = median(hours);
    velocidad = {
      mediana_horas_laborables: med === null ? null : round(med, 1),
      respuestas_que_esperan_contestacion: expecting.length,
      contestadas: hours.length,
      sin_contestar_en_periodo: unansweredInPeriod,
      sin_contestar_mas_1_dia: waiting.length,
      sin_contestar: waiting,
      horario: `L-V ${SETTER_WORKDAY_START_HOUR}:00-${SETTER_WORKDAY_END_HOUR}:00 ${src.timezone}, sin festivos`,
    };
  } else noDisp.velocidad_respuesta_comercial = src.replyMail.reason;

  // 5. Twenty: opportunities and overdue tasks.
  let oportunidades: SetterMetrics['oportunidades_abiertas'] = null;
  if (src.opportunities.status === 'ok') {
    oportunidades = { total: src.opportunities.value.total, por_etapa: src.opportunities.value.byStage, truncado: src.opportunities.value.truncated };
    if (src.opportunities.value.truncated) truncated.push('oportunidades');
  } else noDisp.oportunidades_abiertas = src.opportunities.reason;
  let tareas: SetterMetrics['tareas_vencidas'] = null;
  if (src.overdue.status === 'ok') {
    const tasks = src.overdue.value.tasks;
    const porTipo: Record<SystemTaskKind, number> = { responder: 0, cerrar_reunion: 0, seguimiento: 0, retomar: 0 };
    for (const t of tasks) porTipo[t.kind] += 1;
    tareas = { total: tasks.length, por_tipo: porTipo, tareas: tasks };
    if (src.overdue.value.truncated) truncated.push('tareas');
  } else noDisp.tareas_vencidas = src.overdue.reason;

  // 6. By origin (fair / signal).
  let porOrigen: OriginRow[] | null = null;
  if (src.origins.status === 'ok') {
    const by = new Map<string, OriginRow>();
    const row = (o: { name: string; signalId: string | null }) => {
      const key = o.signalId ?? o.name;
      let r = by.get(key);
      if (!r) by.set(key, (r = { origen: o.name, signal_id: o.signalId, primeros_contactos: 0, respuestas_humanas: 0, interesados: 0, reuniones: 0 }));
      return r;
    };
    for (const c of firsts) {
      const r = row(originOf(c.hypothesisId));
      r.primeros_contactos += 1;
      const rep = replies.get(c);
      if (rep) {
        r.respuestas_humanas += 1;
        if (rep.class === 'INTERESADO') r.interesados += 1;
      }
    }
    for (const m of src.db.meetings) row(originOf(m.companyId ? src.db.companyHypothesis[m.companyId] : null)).reuniones += 1;
    porOrigen = [...by.values()].sort((a, b) => (a.origen === UNATTRIBUTED ? 1 : 0) - (b.origen === UNATTRIBUTED ? 1 : 0) || b.primeros_contactos - a.primeros_contactos || a.origen.localeCompare(b.origen));
  } else noDisp.por_origen = src.origins.reason;

  return {
    tenant_id: src.tenantId,
    timezone: src.timezone,
    generated_at: now.toISOString(),
    periodo: { from: period.from, to: period.to, since: period.since.toISOString(), until: period.until.toISOString(), dias: Math.round((untilMs - sinceMs) / DAY) },
    primeros_contactos: { total: firsts.length, desde_workflow: fromWorkflow, desde_buzon: mailOk ? firsts.length - fromWorkflow : null, completo: mailOk && src.priorMail.status === 'ok' },
    seguimientos_enviados: mailOk ? followUps : null,
    respuestas: { total: inPeriod.length, humanas, por_clase: porClase, aparte },
    tasa_respuesta: {
      valor: firsts.length > 0 ? round(answered / firsts.length, 4) : null,
      cohorte: firsts.length,
      respondidos: answered,
      ventana_dias: SETTER_COHORT_DAYS,
      cohorte_cerrada: cohortClosed,
      explicacion:
        `Cohorte: los ${firsts.length} primeros contactos enviados entre el ${period.from} y el ${addDays(period.to, -1)}. ` +
        `Cuenta como respondido el contacto con una respuesta humana (interesado, pregunta, no interesado o baja) en los ${SETTER_COHORT_DAYS} días siguientes a su envío. ` +
        (cohortClosed ? 'La cohorte está cerrada: el valor ya no cambia.' : `La cohorte sigue abierta hasta el ${addDays(period.to, SETTER_COHORT_DAYS)}: el valor puede subir.`),
    },
    interesados: porClase.INTERESADO,
    reuniones_detectadas: src.db.meetings.length,
    oportunidades_abiertas: oportunidades,
    velocidad_respuesta_comercial: velocidad,
    tareas_vencidas: tareas,
    coste_llm_eur: round(src.db.costEur, 4),
    por_origen: porOrigen,
    no_disponible: noDisp,
    truncado: truncated,
  };
}

// ---------------------------------------------------------------------------
// Orchestration: database + CRM reader -> metrics
// ---------------------------------------------------------------------------
export type SetterDbReader = (q: { tenantId: string; since: Date; until: Date; now: Date }) => Promise<SetterDbData>;

export interface CollectSetterInput {
  /** The runtime database, or `readDb` (tests, a precomputed read). */
  db?: Db;
  readDb?: SetterDbReader;
  crm: SetterCrmReader;
  tenantId: string;
  period: SetterPeriod;
  now: Date;
  ownDomains: readonly string[];
  timezone?: string;
  /** Pre-read Twenty values that do not depend on the period (shared by two weeks of a report). */
  shared?: { opportunities?: SetterSources['opportunities']; overdue?: SetterSources['overdue'] };
}

export interface CollectedSetter {
  metrics: SetterMetrics;
  sources: SetterSources;
}

export async function collectSetterMetrics(i: CollectSetterInput): Promise<CollectedSetter> {
  const timezone = i.timezone ?? SETTER_TIMEZONE;
  const { since, until } = i.period;
  const reader: SetterDbReader | null = i.readDb ?? (i.db ? (q) => readSetterDb(i.db!, q) : null);
  if (!reader) throw new Error('collectSetterMetrics requires the runtime database');
  const db = await reader({ tenantId: i.tenantId, since, until, now: i.now });
  const ownDomains = i.ownDomains.length > 0 ? i.ownDomains : null;
  const noDomains = 'no hay dominios propios configurados (MEETING_INTERNAL_DOMAINS / IONOS_IMAP_USER): no se puede saber qué mensajes son nuestros';

  const mailWindow = ownDomains ? await i.crm.mailWindow({ since, until: new Date(Math.min(until.getTime(), Math.max(i.now.getTime(), since.getTime() + 1))), ownDomains }) : noDisponible(noDomains);
  let priorMail: SetterSources['priorMail'];
  if (mailWindow.status === 'ok') {
    const addresses = [...new Set([...db.sends.flatMap((s) => s.recipients), ...mailWindow.value.messages.flatMap((m) => m.counterparts)])];
    priorMail = addresses.length ? await i.crm.priorAddresses({ addresses, before: since }) : ok({ addresses: [], truncated: false });
  } else priorMail = noDisponible(mailWindow.reason);

  const lookback = i.now.getTime() - SETTER_UNANSWERED_LOOKBACK_DAYS * DAY;
  const waiting = db.triage.filter((r) => expectsAnswer(r.class) && r.fromEmail && ((r.receivedAt >= since && r.receivedAt < until) || r.receivedAt.getTime() >= lookback));
  let replyMail: SetterSources['replyMail'];
  if (!ownDomains) replyMail = noDisponible(noDomains);
  else if (waiting.length === 0) replyMail = ok({ byAddress: {}, truncated: false });
  else {
    const first = Math.min(...waiting.map((r) => r.receivedAt.getTime()));
    replyMail = await i.crm.mailFor({ addresses: [...new Set(waiting.map((r) => r.fromEmail!))], since: new Date(first - HOUR), ownDomains });
  }

  const opportunities = i.shared?.opportunities ?? (await i.crm.openOpportunities());
  const overdue = i.shared?.overdue ?? (await i.crm.overdueTasks({ now: i.now }));
  const hypothesisIds = [...new Set([...db.sends.map((s) => s.hypothesisId), ...Object.values(db.companyHypothesis)])];
  const origins = hypothesisIds.length ? await i.crm.origins({ hypothesisIds }) : ok({});

  const sources: SetterSources = { tenantId: i.tenantId, timezone, period: i.period, now: i.now, db, mailWindow, priorMail, replyMail, opportunities, overdue, origins };
  return { metrics: computeSetterMetrics(sources), sources };
}

/** Local `DD/MM` of a local day. */
export function ddmm(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** Local `DD/MM HH:mm` of an instant. */
export function ddmmhhmm(iso: string | Date, timeZone = SETTER_TIMEZONE): string {
  const m = localMinute(typeof iso === 'string' ? new Date(iso) : iso, timeZone);
  return `${m.slice(8, 10)}/${m.slice(5, 7)} ${m.slice(11, 16)}`;
}
