/**
 * Deterministic first level of the inbound triage (no LLM). Decides, from headers and fixed
 * patterns only, the classes that never need a model:
 *
 *   REBOTE      delivery status notifications (multipart/report; report-type=delivery-status,
 *               message/delivery-status parts, MAILER-DAEMON / postmaster with a bounce subject)
 *   AUTO_REPLY  machine generated mail: out of office / auto replies (Auto-Submitted,
 *               X-Autoreply, X-Autorespond, Precedence auto_reply|bulk|list|junk), read receipts,
 *               mailing lists and newsletters (List-*, Feedback-ID), no-reply senders and, after
 *               the baja check, typical auto-reply subjects ("Respuesta automática:", "Out of
 *               office", "Fuera de la oficina"...)
 *   BAJA        exactly the existing unsubscribe classifier (unsubscribe-classifier.ts)
 *   OTRO        no valid From, our own domains, or nothing written by the sender
 *
 * Everything else is left to the LLM (reply-classifier.ts).
 *
 * The message is UNTRUSTED DATA: it is only matched against fixed patterns. The order keeps
 * BAJA exactly as the BajasAgent decides it: everything checked before it is mail the
 * BajasAgent already treats as "automated / own domain / invalid sender" (never a baja).
 */
import type { ParsedMail } from 'mailparser';
import type { InboundTriageClass } from '../db/schema.js';
import {
  classifyMessage,
  emailDomain,
  fold,
  hasHeader,
  headerText,
  isDomainOrSubdomain,
  messageText,
  normalizeEmail,
  type BajaSignal,
  type ClassifierConfig,
  type ParsedInboundMessage,
} from './unsubscribe-classifier.js';

export type TriageClass = InboundTriageClass;

/** Text of a bounce scanned for DSN fields and failure codes. */
const BOUNCE_SCAN_MAX = 16_000;
const ATTACHMENT_SCAN_MAX = 16_000;

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export interface DsnRecipient {
  email: string;
  action: string | null;
  status: string | null;
  diagnostic: string | null;
}

export interface TriageFeatures {
  autoSubmitted: string | null;
  precedence: string | null;
  /** X-Autoreply / X-Autorespond / X-Autoresponder present. */
  xAutoreply: boolean;
  /** List-Unsubscribe / List-Id / List-Post / Feedback-ID present. */
  bulkHeaders: string[];
  contentType: string;
  reportType: string | null;
  hasDeliveryStatus: boolean;
  hasDispositionNotification: boolean;
  /** Per-recipient fields of the delivery status notification, if any. */
  dsn: DsnRecipient[];
  /** Recipients and subject of the returned message (text/rfc822-headers or message/rfc822). */
  originalTo: string[];
  originalSubject: string | null;
  /** Whole message text (bounded), used only for bounce cues. */
  text: string;
}

function contentTypeOf(parsed: ParsedMail): { value: string; reportType: string | null } {
  const raw = parsed.headers.get('content-type') as { value?: unknown; params?: Record<string, unknown> } | string | undefined;
  if (raw && typeof raw === 'object') {
    const rt = raw.params?.['report-type'];
    return { value: String(raw.value ?? '').toLowerCase(), reportType: typeof rt === 'string' ? rt.toLowerCase() : null };
  }
  const s = String(raw ?? '').toLowerCase();
  const rt = /report-type\s*=\s*"?([a-z-]+)/.exec(s);
  return { value: s.split(';')[0]!.trim(), reportType: rt ? rt[1]! : null };
}

/** RFC 3464 fields, one block per `Final-Recipient` (continuation lines unfolded). */
export function parseDeliveryStatus(text: string): DsnRecipient[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
  const out: DsnRecipient[] = [];
  let cur: DsnRecipient | null = null;
  let pendingOriginal: string | null = null;
  for (const line of lines) {
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim().slice(0, 500);
    if (field === 'original-recipient') {
      pendingOriginal = value;
      continue;
    }
    if (field === 'final-recipient') {
      const email = normalizeEmail(value.replace(/^[^;]*;/, '').replace(/[<>]/g, '').trim()) ?? normalizeEmail(pendingOriginal?.replace(/^[^;]*;/, '').replace(/[<>]/g, '').trim());
      pendingOriginal = null;
      cur = email ? { email, action: null, status: null, diagnostic: null } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (field === 'action') cur.action = value.toLowerCase();
    else if (field === 'status') cur.status = /\d\.\d{1,3}\.\d{1,3}/.exec(value)?.[0] ?? null;
    else if (field === 'diagnostic-code') cur.diagnostic = value.slice(0, 300);
  }
  return out.slice(0, 20);
}

function headerBlockValue(block: string, name: string): string | null {
  const unfolded = block.replace(/\r\n?/g, '\n').replace(/\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im').exec(unfolded);
  return m ? m[1]!.trim().slice(0, 2_000) : null;
}

const EMAIL_IN_TEXT_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;

function emailsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(EMAIL_IN_TEXT_RE)) {
    const e = normalizeEmail(m[0]);
    if (e) out.add(e);
  }
  return [...out];
}

export function extractTriageFeatures(parsed: ParsedMail): TriageFeatures {
  const ct = contentTypeOf(parsed);
  const atts = parsed.attachments ?? [];
  const attText = (a: { content: Buffer }) => a.content.subarray(0, ATTACHMENT_SCAN_MAX).toString('utf8');
  const dsnParts = atts.filter((a) => /^message\/(?:global-)?delivery-status$/i.test(a.contentType));
  const originalParts = atts.filter((a) => /^(?:text\/rfc822-headers|message\/rfc822|message\/global|message\/global-headers)$/i.test(a.contentType));
  const text = messageText(parsed).slice(0, BOUNCE_SCAN_MAX);
  // mailparser merges a message/delivery-status part into `text`; separate parts are attachments.
  const dsn = parseDeliveryStatus([text, ...dsnParts.map(attText)].join('\n'));
  const original = originalParts.length > 0 ? attText(originalParts[0]!) : '';
  const bulkHeaders = ['list-unsubscribe', 'list-id', 'list-post', 'feedback-id'].filter((h) => hasHeader(parsed, h));
  return {
    autoSubmitted: headerText(parsed, 'auto-submitted')?.trim().toLowerCase() ?? null,
    precedence: headerText(parsed, 'precedence')?.trim().toLowerCase() ?? null,
    xAutoreply: ['x-autoreply', 'x-autorespond', 'x-autoresponder'].some((h) => hasHeader(parsed, h)),
    bulkHeaders,
    contentType: ct.value,
    reportType: ct.reportType,
    hasDeliveryStatus: dsnParts.length > 0 || ct.reportType === 'delivery-status' || ct.value.startsWith('message/delivery-status'),
    hasDispositionNotification:
      ct.reportType === 'disposition-notification' ||
      ct.value.startsWith('message/disposition-notification') ||
      atts.some((a) => /^message\/disposition-notification$/i.test(a.contentType)),
    dsn,
    originalTo: original ? emailsIn(headerBlockValue(original, 'To') ?? '').slice(0, 10) : [],
    originalSubject: original ? headerBlockValue(original, 'Subject') : null,
    text,
  };
}

// ---------------------------------------------------------------------------
// Patterns (on folded text: lowercase, no diacritics)
// ---------------------------------------------------------------------------

const DAEMON_LOCALPART_RE = /^(?:mailer-daemon|mailerdaemon|mail-daemon|postmaster|mail-delivery-system|microsoftexchange[0-9a-f]*)$/;

/** Bounce subjects (Postfix, Exim/IONOS, Gmail, Exchange, Spanish servers). */
const BOUNCE_SUBJECT_RE =
  /\b(?:undeliver(?:ed|able)|returned mail|returned to sender|mail delivery (?:failed|failure|system)|delivery (?:status notification|failure|has failed|failed)|failure notice|non[- ]?delivery|mensaje no entregado|no se (?:ha podido|puede|pudo) entregar|error (?:de|en la) entrega|notificacion de estado de (?:la )?entrega|devuelto al remitente|unzustellbar|non remis|non recapitabile)\b/;

/** Auto-reply subjects; checked only AFTER the baja check (a person may write "baja" there). */
const AUTO_REPLY_SUBJECT_RE =
  /^(?:respuesta automatica|automatic reply|auto(?:matic)?[ -]?reply|autoreply|auto[ -]?response|autorespuesta|out of (?:the )?office|fuera de (?:la )?oficina|reponse automatique|risposta automatica|resposta automatica|abwesenheitsnotiz|abwesend|(?:ausencia|ausente|vacaciones|absence|abwesenheit)\s*:|auto\s*:)/;
const AUTO_REPLY_SUBJECT_ANYWHERE_RE = /\bis out of (?:the )?office\b|\(fuera de (?:la )?oficina\)|\(out of office\)/;

const HARD_TEXT_RE =
  /\b(?:5\.[0-7]\.\d{1,3}|55[0-4])\b|user unknown|unknown user|no such (?:user|recipient|mailbox)|does ?n[o']t exist|address (?:couldn'?t|could not) be found|mailbox (?:unavailable|not found)|recipient address rejected|invalid recipient|usuario desconocido|no existe|direccion (?:no valida|incorrecta)/;
const SOFT_TEXT_RE = /\b4\.\d\.\d{1,3}\b|\b4[25]\d\b|mailbox (?:is )?full|over quota|quota exceeded|temporar|delayed|will (?:retry|keep trying)|buzon lleno/;

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface BounceInfo {
  /** Failed recipient(s) of OUR message (never our own domains). */
  recipients: string[];
  hard: boolean;
  status: string | null;
  originalSubject: string | null;
}

export type RuleDecision =
  | { decided: true; class: TriageClass; signals: string[]; bajaSignals?: BajaSignal[]; email?: string; bounce?: BounceInfo }
  | { decided: false; signals: string[] };

function own(email: string, cfg: ClassifierConfig): boolean {
  const d = emailDomain(email);
  return cfg.ownDomains.some((o) => isDomainOrSubdomain(d, o.toLowerCase()));
}

export function bounceInfo(f: TriageFeatures, msg: ParsedInboundMessage, cfg: ClassifierConfig): BounceInfo {
  const notOurs = (e: string) => !own(e, cfg) && e !== msg.fromEmail;
  const failed = f.dsn.filter((r) => r.action === null || r.action === 'failed' || r.action === 'delayed');
  let recipients = [...new Set(failed.map((r) => r.email))].filter(notOurs);
  if (recipients.length === 0) recipients = f.originalTo.filter(notOurs);
  if (recipients.length === 0) {
    // Plain-text bounce: only an unambiguous single address in the text counts.
    const inText = emailsIn(f.text).filter(notOurs);
    if (inText.length === 1) recipients = inText;
  }
  const statuses = failed.map((r) => r.status).filter((s): s is string => s !== null);
  const status = statuses[0] ?? null;
  let hard: boolean;
  if (failed.some((r) => r.action === 'failed' && r.status?.startsWith('5'))) hard = true;
  else if (statuses.some((s) => s.startsWith('4')) || failed.some((r) => r.action === 'delayed')) hard = false;
  else {
    const t = fold(`${msg.subject}\n${f.text}`);
    hard = HARD_TEXT_RE.test(t) && !SOFT_TEXT_RE.test(t);
  }
  return { recipients: recipients.slice(0, 5), hard, status, originalSubject: f.originalSubject };
}

/**
 * Deterministic decision. `decided: false` means "ask the LLM"; its signals (e.g.
 * `is_reply`) are context for the trace only.
 */
export function classifyByRules(msg: ParsedInboundMessage, f: TriageFeatures, cfg: ClassifierConfig): RuleDecision {
  const subject = fold(msg.subject);
  const local = msg.fromEmail ? msg.fromEmail.slice(0, msg.fromEmail.lastIndexOf('@')) : '';
  const daemon = DAEMON_LOCALPART_RE.test(local);
  const bounceSubject = BOUNCE_SUBJECT_RE.test(subject);
  const autoSubmitted = f.autoSubmitted !== null && f.autoSubmitted !== 'no';

  // 1. Bounces (before the sender checks: a DSN may come without a usable From).
  const bounceSignals: string[] = [];
  if (f.hasDeliveryStatus) bounceSignals.push('dsn_report');
  if (daemon) bounceSignals.push('daemon_sender');
  if (bounceSubject) bounceSignals.push('bounce_subject');
  if (f.hasDeliveryStatus || (bounceSubject && (daemon || autoSubmitted))) {
    const bounce = bounceInfo(f, msg, cfg);
    return { decided: true, class: 'REBOTE', signals: [...bounceSignals, bounce.hard ? 'hard_bounce' : 'soft_or_unknown_bounce'], bounce };
  }
  // 2. Read receipts (MDN).
  if (f.hasDispositionNotification) return { decided: true, class: 'AUTO_REPLY', signals: ['read_receipt'] };
  // 3-4. Senders that are never a reply from a prospect.
  if (!msg.fromEmail) return { decided: true, class: 'OTRO', signals: ['invalid_sender'] };
  if (own(msg.fromEmail, cfg)) return { decided: true, class: 'OTRO', signals: ['own_domain'] };
  // 5. Machine generated (same predicate as the BajasAgent's "automated").
  if (msg.automated) {
    const s: string[] = [];
    if (autoSubmitted) s.push('auto_submitted');
    if (f.xAutoreply) s.push('x_autoreply');
    if (f.precedence === 'auto_reply') s.push('precedence_auto_reply');
    else if (f.precedence && ['bulk', 'list', 'junk'].includes(f.precedence)) s.push('precedence_bulk');
    if (f.bulkHeaders.length > 0) s.push('bulk_list');
    if (daemon) s.push('daemon_sender');
    if (s.length === 0) s.push(msg.automated === 'automated_sender' ? 'automated_sender' : msg.automated.replace(/-/g, '_'));
    return { decided: true, class: 'AUTO_REPLY', signals: s };
  }
  // 6. Bajas: the existing classifier, unchanged.
  const baja = classifyMessage(msg, cfg);
  if (baja.kind === 'BAJA') return { decided: true, class: 'BAJA', signals: [...baja.signals], bajaSignals: baja.signals, email: baja.email };
  // 7. Auto-reply subjects without the headers.
  if (AUTO_REPLY_SUBJECT_RE.test(subject) || AUTO_REPLY_SUBJECT_ANYWHERE_RE.test(subject)) return { decided: true, class: 'AUTO_REPLY', signals: ['auto_reply_subject'] };
  // 8. Nothing written by the sender (only the quoted original, or an empty body).
  const context = /^(?:re|rv|res|aw|sv|vs|r)\s*:/i.test(msg.subject.trim()) ? ['is_reply'] : [];
  if (msg.authoredText.trim().length === 0) return { decided: true, class: 'OTRO', signals: [...context, 'empty_text'] };
  return { decided: false, signals: context };
}
