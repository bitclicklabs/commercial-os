/**
 * Email-ops: operational guard rails of the send-from-Twenty flow (docs/twenty-envio-email.md),
 * driven by the Twenty webhook `commercialHypothesis.updated` when `emailStatus` changes.
 *
 * READY (a person marked the draft as reviewed):
 *   1. re-read the hypothesis (the webhook record can be stale) and stop unless it is still READY;
 *   2. check `emailTo`: empty, invalid, or covered by the suppression list
 *      ("Lista de supresión — NO contactar": exact address or `@domain` incl. subdomains;
 *      if the list cannot be read the check FAILS CLOSED);
 *   3. if blocked: `emailStatus` back to DRAFT (only that field, only if still READY),
 *      a visible "⛔ ..." note on the hypothesis, event `email.blocked_suppressed`.
 *
 * SENT (the workflow, or a person, marked it as sent):
 *   1. row in `email_sends` (dedupe hypothesis + `updatedAt` of the webhook record) and
 *      event `email.sent` (domain only, never the address);
 *   2. warm-up: if today's sends go over the soft cap of the calendar, event
 *      `email.warmup_target_exceeded` (once per local day);
 *   3. late detection: if a recipient is in the suppression list (the READY check lost the
 *      race), alert note + event `email.sent_suppressed`.
 *
 * RACE WINDOW. The READY check is a safety net, not a lock: Twenty delivers the webhook
 * asynchronously (its job queue, then our Twenty round trips). A person who sets Reviewed
 * and clicks "Enviar borrador de email" within ~1-2 s can have the workflow read READY
 * before the runtime writes DRAFT, and the email goes out. The manual check of the
 * suppression list stays in the daily routine of the guide; the SENT step reports the
 * misses (`email.sent_suppressed`).
 *
 * The runtime never sends anything and never touches the Twenty workflow.
 */
import type { Db } from '../db/client.js';
import type { EventPublisher, PublishEventInput } from '../events/event-bus.js';
import type { TwentyWebhookPayload } from '../evaluations/human-feedback.js';
import { tenantOfRecord } from '../evaluations/twenty-webhook.js';
import { sanitizeSubject, SUPPRESSION_NOTE_TITLE } from '../inbound/suppression-list.js';
import { emailDomain } from '../inbound/unsubscribe-classifier.js';
import { TWENTY_OBJECTS, type TwentyClient, type TwentyCommercialHypothesis } from '../integrations/twenty/index.js';
import { revertHypothesisDraftStatus } from '../tools/twenty/hypothesis-tools.js';
import { checkRecipients, parseRecipients, recipientDomains, type BlockReason, type SuppressionMatch } from './recipients.js';
import { countEmailSends, recordEmailSend } from './sends.js';
import { loadSuppressionList, upsertAlertNote } from './twenty-io.js';
import { exceedsTarget, warmupDay, WARMUP_TIMEZONE } from './warmup.js';

export interface EmailOpsLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface EmailOpsOptions {
  defaultTenantId: string;
  twenty?: TwentyClient | undefined;
  events?: EventPublisher | undefined;
  logger?: EmailOpsLogger | undefined;
  timezone?: string;
  now?: () => Date;
}

export const BLOCK_NOTE_TITLES: Record<BlockReason, string> = {
  suppressed: '⛔ Dirección en la lista de supresión — no enviar',
  missing_recipient: '⛔ Falta destinatario — no enviar',
  invalid_recipient: '⛔ Destinatario no válido — no enviar',
  suppression_list_unavailable: '⛔ No se pudo comprobar la lista de supresión — no enviar',
};
export const SENT_SUPPRESSED_NOTE_TITLE = '⛔ Enviado a una dirección de la lista de supresión — revisar';

const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  suppressed: 'dirección en la lista de supresión',
  missing_recipient: 'falta destinatario',
  invalid_recipient: 'destinatario no válido',
  suppression_list_unavailable: 'lista de supresión no disponible',
};

export type EmailOpsOutcome =
  | { check: 'ready'; status: 'passed'; recipients: number; toDomains: string[] }
  | {
      check: 'ready';
      status: 'blocked';
      reason: BlockReason;
      reverted: boolean;
      revertResult: 'reverted' | 'status_changed' | 'not_found';
      noteId: string;
      eventId: string | null;
      toDomains: string[];
    }
  | { check: 'ready' | 'sent'; status: 'skipped'; reason: string }
  | {
      check: 'sent';
      status: 'recorded' | 'deduplicated';
      sendId: string;
      toDomain: string | null;
      sendsToday: number;
      target: number | null;
      targetExceeded: boolean;
      suppressedRecipients: number | null;
    };

/** Local `AAAA-MM-DD HH:mm:ss`. */
export function localDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function dateOf(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function workspaceMemberOf(payload: TwentyWebhookPayload): string | null {
  const updatedBy = payload.record.updatedBy as { workspaceMemberId?: unknown } | null | undefined;
  return str(payload.workspaceMemberId) ?? str(updatedBy?.workspaceMemberId);
}

/** Only `commercialHypothesis` updates that change `emailStatus` to READY or SENT matter. */
export function emailTransitionOf(payload: TwentyWebhookPayload): 'READY' | 'SENT' | null {
  const objectName = payload.objectMetadata?.nameSingular ?? payload.eventName.split('.')[0];
  if (objectName !== 'commercialHypothesis') return null;
  if (payload.eventName !== 'commercialHypothesis.updated' && payload.eventName !== 'commercialHypothesis.upserted') return null;
  const fields = Array.isArray(payload.updatedFields) ? payload.updatedFields : [];
  if (!fields.includes('emailStatus')) return null;
  const status = payload.record.emailStatus;
  return status === 'READY' || status === 'SENT' ? status : null;
}

// ---------------------------------------------------------------------------
// Events (compact; domains, never addresses)
// ---------------------------------------------------------------------------
function blockedEvent(
  tenantId: string,
  p: { hypothesisId: string; companyId: string | null; reason: BlockReason; matches: SuppressionMatch[]; toDomains: string[]; reverted: boolean; revertResult: string; noteId: string; changeAt: string },
): PublishEventInput {
  return {
    tenantId,
    type: 'email.blocked_suppressed',
    correlationId: p.hypothesisId,
    idempotencyKey: `evt:email.blocked_suppressed:${p.hypothesisId}:${p.changeAt}`,
    data: {
      hypothesisId: p.hypothesisId,
      companyId: p.companyId,
      reason: p.reason,
      matchedBy: [...new Set(p.matches.map((m) => m.by))],
      matchedDomains: [...new Set(p.matches.filter((m) => m.by === 'domain').map((m) => m.entry))],
      toDomains: p.toDomains,
      reverted: p.reverted,
      revertResult: p.revertResult,
      noteId: p.noteId,
    },
  };
}

// ---------------------------------------------------------------------------
// READY
// ---------------------------------------------------------------------------
function blockNoteBody(reason: BlockReason, ctx: { hypothesisName: string; matches: SuppressionMatch[]; invalid: string[]; historyLine: string }): string {
  const why: Record<BlockReason, string> = {
    suppressed: 'el destinatario está en la nota «Lista de supresión — NO contactar»',
    missing_recipient: '*Email to* está vacío',
    invalid_recipient: '*Email to* contiene algo que no es una dirección de correo válida',
    suppression_list_unavailable: `no se pudo leer la nota «${SUPPRESSION_NOTE_TITLE}» (no existe o cambió de título), y sin ella el envío no es seguro`,
  };
  const lines: string[] = [
    `**No envíes este correo.** El Commercial OS ha devuelto *Email status* a **Draft** porque ${why[reason]}.`,
    '',
    `- Hipótesis: ${ctx.hypothesisName}`,
  ];
  for (const m of ctx.matches) lines.push(`- Bloqueado: \`${m.entry}\` (${m.by === 'email' ? 'dirección exacta' : 'dominio completo, incluye subdominios'})`);
  for (const piece of ctx.invalid.slice(0, 5)) lines.push(`- No válido: \`${piece.replace(/[`\r\n]/g, '').slice(0, 120)}\``);
  const todo: Record<BlockReason, string> = {
    suppressed: 'No vuelvas a escribir a esta dirección. Las bajas no se revierten desde la lista: si crees que es un error, consúltalo con el operador antes de tocar nada.',
    missing_recipient: 'Escribe el destinatario en *Email to* (de rol si no hay decisor), comprueba la lista de supresión y vuelve a poner *Reviewed*.',
    invalid_recipient: 'Corrige *Email to* (direcciones separadas por comas), comprueba la lista de supresión y vuelve a poner *Reviewed*.',
    suppression_list_unavailable: 'Avisa al operador. No envíes hasta que la nota de la lista de supresión vuelva a estar disponible.',
  };
  lines.push('', `Qué hacer: ${todo[reason]}`, '', 'Historial:', '', ctx.historyLine, '');
  return lines.join('\n');
}

async function handleReady(payload: TwentyWebhookPayload, tenantId: string, opts: EmailOpsOptions): Promise<EmailOpsOutcome> {
  const twenty = opts.twenty;
  if (!twenty?.isConfigured()) {
    opts.logger?.warn({ hypothesisId: payload.record.id }, 'email-ops: READY not checked, Twenty is not configured');
    return { check: 'ready', status: 'skipped', reason: 'twenty_not_configured' };
  }
  const hypothesisId = String(payload.record.id);
  const tz = opts.timezone ?? WARMUP_TIMEZONE;
  const fresh = await twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, hypothesisId, { depth: 0 });
  if (!fresh) return { check: 'ready', status: 'skipped', reason: 'hypothesis_not_found' };
  if (fresh.emailStatus !== 'READY') {
    // DRAFT/empty: a person already changed it. SENDING/SENT: the workflow went first; the
    // SENT step reports a send to a suppressed address.
    return { check: 'ready', status: 'skipped', reason: `email_status_now_${String(fresh.emailStatus ?? 'empty').toLowerCase()}` };
  }

  const pre = checkRecipients(fresh.emailTo, { emails: new Set(), domains: new Set() });
  const loaded = pre.ok ? await loadSuppressionList(twenty) : null;
  const check = pre.ok ? checkRecipients(fresh.emailTo, loaded?.list ?? null) : pre;
  const toDomains = recipientDomains(check.recipients);
  if (check.ok) return { check: 'ready', status: 'passed', recipients: check.recipients.length, toDomains };

  const revert = await revertHypothesisDraftStatus(twenty, hypothesisId, { expectedStatus: 'READY' });
  const changeAt = str(payload.record.updatedAt) ?? str(payload.eventDate) ?? new Date().toISOString();
  const when = localDateTime(dateOf(changeAt) ?? new Date(), tz);
  const historyLine = revert.reverted
    ? `- ${when} — Email status devuelto a Draft (${BLOCK_REASON_TEXT[check.reason]})`
    : `- ${when} — ${BLOCK_REASON_TEXT[check.reason]}; NO se pudo devolver a Draft (estado actual: ${revert.previousStatus ?? 'vacío'}). Revisa la ejecución del workflow.`;
  const companyId = str(fresh.companyId) ?? str(payload.record.companyId);
  const note = await upsertAlertNote(twenty, {
    hypothesisId,
    companyId,
    title: BLOCK_NOTE_TITLES[check.reason],
    bodyMarkdown: blockNoteBody(check.reason, {
      hypothesisName: sanitizeSubject(str(fresh.name) ?? hypothesisId, 120),
      matches: check.matches,
      invalid: check.invalid,
      historyLine,
    }),
    historyLine,
  });
  const published = await opts.events?.emit(
    blockedEvent(tenantId, {
      hypothesisId,
      companyId,
      reason: check.reason,
      matches: check.matches,
      toDomains,
      reverted: revert.reverted,
      revertResult: revert.reason,
      noteId: note.noteId,
      changeAt,
    }),
  );
  opts.logger?.info({ hypothesisId, reason: check.reason, reverted: revert.reverted, noteId: note.noteId }, 'email-ops: READY blocked');
  return {
    check: 'ready',
    status: 'blocked',
    reason: check.reason,
    reverted: revert.reverted,
    revertResult: revert.reason,
    noteId: note.noteId,
    eventId: published?.event.id ?? null,
    toDomains,
  };
}

// ---------------------------------------------------------------------------
// SENT
// ---------------------------------------------------------------------------
async function lateSuppressionCheck(
  payload: TwentyWebhookPayload,
  tenantId: string,
  p: { hypothesisId: string; companyId: string | null; recipients: string[]; sentAt: Date; sentAtIso: string },
  opts: EmailOpsOptions,
): Promise<number | null> {
  const twenty = opts.twenty;
  if (!twenty?.isConfigured() || p.recipients.length === 0) return null;
  try {
    const loaded = await loadSuppressionList(twenty);
    if (!loaded) return null;
    const check = checkRecipients(p.recipients.join(','), loaded.list);
    if (check.ok || check.reason !== 'suppressed') return 0;
    const when = localDateTime(p.sentAt, opts.timezone ?? WARMUP_TIMEZONE);
    const historyLine = `- ${when} — enviado a ${check.matches.map((m) => `\`${m.entry}\``).join(', ')}`;
    const note = await upsertAlertNote(twenty, {
      hypothesisId: p.hypothesisId,
      companyId: p.companyId,
      title: SENT_SUPPRESSED_NOTE_TITLE,
      bodyMarkdown: [
        '**Este correo salió hacia una dirección de la lista de supresión.**',
        '',
        `- Hipótesis: ${sanitizeSubject(str(payload.record.name) ?? p.hypothesisId, 120)}`,
        ...check.matches.map((m) => `- En la lista: \`${m.entry}\` (${m.by === 'email' ? 'dirección exacta' : 'dominio completo'})`),
        '',
        'El chequeo automático al marcar *Reviewed* llegó tarde (se pulsó «Enviar borrador de email» en uno o dos segundos) o la dirección entró en la lista durante el envío.',
        '',
        'Qué hacer: avisa al operador hoy mismo y no vuelvas a escribir a esta dirección.',
        '',
        'Historial:',
        '',
        historyLine,
        '',
      ].join('\n'),
      historyLine,
    });
    await opts.events?.emit({
      tenantId,
      type: 'email.sent_suppressed',
      correlationId: p.hypothesisId,
      idempotencyKey: `evt:email.sent_suppressed:${p.hypothesisId}:${p.sentAtIso}`,
      data: {
        hypothesisId: p.hypothesisId,
        companyId: p.companyId,
        matchedBy: [...new Set(check.matches.map((m) => m.by))],
        toDomains: recipientDomains(check.recipients),
        noteId: note.noteId,
      },
    });
    return check.matches.length;
  } catch (err) {
    opts.logger?.warn({ hypothesisId: p.hypothesisId, err: (err as Error).message }, 'email-ops: late suppression check failed');
    return null;
  }
}

async function handleSent(db: Db, payload: TwentyWebhookPayload, tenantId: string, opts: EmailOpsOptions): Promise<EmailOpsOutcome> {
  const record = payload.record;
  const hypothesisId = String(record.id);
  const tz = opts.timezone ?? WARMUP_TIMEZONE;
  const sentAt = dateOf(record.updatedAt) ?? dateOf(payload.eventDate) ?? (opts.now ?? (() => new Date()))();
  const sentAtIso = sentAt.toISOString();
  const { valid, invalid } = parseRecipients(record.emailTo);
  const toDomain = valid[0] ? emailDomain(valid[0]) : null;
  const companyId = str(record.companyId);
  const { send, created } = await recordEmailSend(db, {
    tenantId,
    hypothesisId,
    companyId,
    toEmail: [...valid, ...invalid].join(', '),
    toDomain,
    subject: str(record.emailSubject),
    sentAt,
    workspaceMemberId: workspaceMemberOf(payload),
  });
  await opts.events?.emit({
    tenantId,
    type: 'email.sent',
    correlationId: hypothesisId,
    occurredAt: sentAt,
    idempotencyKey: `evt:email.sent:${hypothesisId}:${sentAtIso}`,
    data: { hypothesisId, companyId, toDomain, recipients: valid.length, sendId: send.id, sentAt: sentAtIso },
  });

  // Warm-up soft cap of the local day of the send (once per day: idempotency key by date).
  const day = warmupDay(sentAt, tz);
  const counts = await countEmailSends(db, { tenantId, now: sentAt, timezone: tz });
  const exceeded = exceedsTarget(day, counts.today);
  if (exceeded) {
    await opts.events?.emit({
      tenantId,
      type: 'email.warmup_target_exceeded',
      correlationId: `warmup:${day.date}`,
      idempotencyKey: `evt:email.warmup_target_exceeded:${day.date}`,
      data: {
        date: day.date,
        timezone: tz,
        phase: day.phase?.id ?? null,
        restDay: day.restDay,
        target: day.target,
        sendsToday: counts.today,
        countedSource: 'twenty_workflow',
      },
    });
  }
  const suppressedRecipients = created ? await lateSuppressionCheck(payload, tenantId, { hypothesisId, companyId, recipients: valid, sentAt, sentAtIso }, opts) : null;
  opts.logger?.info({ hypothesisId, sendId: send.id, created, sendsToday: counts.today, target: day.target }, 'email-ops: SENT recorded');
  return {
    check: 'sent',
    status: created ? 'recorded' : 'deduplicated',
    sendId: send.id,
    toDomain,
    sendsToday: counts.today,
    target: day.target,
    targetExceeded: exceeded,
    suppressedRecipients,
  };
}

/**
 * Entry point from POST /webhooks/twenty. Returns null when the payload is not an
 * `emailStatus` change to READY or SENT. Throws on Twenty/DB errors (the route answers 502).
 */
export async function processEmailStatusChange(db: Db, payload: TwentyWebhookPayload, opts: EmailOpsOptions): Promise<EmailOpsOutcome | null> {
  const transition = emailTransitionOf(payload);
  if (!transition) return null;
  if (typeof payload.record.id !== 'string') return { check: transition === 'READY' ? 'ready' : 'sent', status: 'skipped', reason: 'record has no id' };
  const tenantId = tenantOfRecord(payload.record) ?? opts.defaultTenantId;
  return transition === 'READY' ? handleReady(payload, tenantId, opts) : handleSent(db, payload, tenantId, opts);
}
