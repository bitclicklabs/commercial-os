/**
 * Deterministic unsubscribe ("baja") classifier. No LLM.
 *
 * The message is UNTRUSTED DATA: nothing in it is interpreted as an instruction. The only
 * things taken from it are
 * - the sender address, from the parsed `From` header (never from the body, never from
 *   `Reply-To`), validated and lowercased;
 * - recipient addresses from the headers, to detect mail sent to baja@publiexpe.info;
 * - the subject and the text the sender wrote (quoted text, the reply header block, our own
 *   unsubscribe footer and the signature are cut off), both bounded in length, matched
 *   against fixed, word-bounded patterns.
 *
 * Automated mail (bounces, auto-replies, mailing lists, newsletters with an "unsubscribe"
 * footer) and our own domains are never a baja.
 */
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { RawMessage } from './imap-mailbox.js';

export const SUBJECT_MAX = 300;
/** Characters of authored text scanned for body patterns. */
export const BODY_SCAN_MAX = 4_000;
const HEADER_VALUE_MAX = 2_000;

export interface ParsedInboundMessage {
  uid: number;
  messageId: string | null;
  receivedAt: Date | null;
  /** Lowercased, validated address of the first `From` mailbox; null if missing or invalid. */
  fromEmail: string | null;
  subject: string;
  /** Every address found in To, Cc and the delivery headers (lowercased). */
  recipients: string[];
  /** Non-null when the message is machine generated (reason code). */
  automated: string | null;
  /** Text written by the sender (no quotes, no signature), at most BODY_SCAN_MAX chars. */
  authoredText: string;
  truncatedSource: boolean;
}

export type BajaSignal = 'recipient_baja_address' | 'subject_keyword' | 'body_phrase' | 'body_keyword_only';

export type Classification =
  | { kind: 'BAJA'; email: string; signals: BajaSignal[] }
  | { kind: 'IGNORED'; reason: 'not_unsubscribe' | 'automated' | 'own_domain' | 'invalid_sender'; detail?: string };

export interface ClassifierConfig {
  /** Addresses whose presence as recipient means "unsubscribe" (lowercase). */
  unsubscribeAddresses: string[];
  /** Senders from these domains (and subdomains) are never a baja: they are us. */
  ownDomains: string[];
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  unsubscribeAddresses: ['baja@publiexpe.info'],
  ownDomains: ['publiexpe.info', 'publiexpe.com'],
};

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_IN_TEXT_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}/gi;

/** Lowercased address if it is a plain, valid mailbox (max 254 chars); otherwise null. */
export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.length > 254 || v.includes('..') || v.startsWith('.') || v.split('@')[0]!.endsWith('.')) return null;
  return EMAIL_RE.test(v) ? v : null;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

export function isDomainOrSubdomain(domain: string, of: string): boolean {
  return domain === of || domain.endsWith(`.${of}`);
}

function firstFromAddress(from: AddressObject | undefined): string | null {
  for (const entry of from?.value ?? []) {
    if (entry.address) return normalizeEmail(entry.address);
    // Group syntax: first member.
    for (const member of entry.group ?? []) if (member.address) return normalizeEmail(member.address);
  }
  return null;
}

function addressesOf(objs: AddressObject | AddressObject[] | undefined): string[] {
  const list = objs === undefined ? [] : Array.isArray(objs) ? objs : [objs];
  const out: string[] = [];
  for (const o of list) {
    for (const v of o.value) {
      if (v.address) out.push(v.address);
      for (const m of v.group ?? []) if (m.address) out.push(m.address);
    }
  }
  return out;
}

/** Delivery headers that may carry the original recipient after a redirect. */
const DELIVERY_HEADERS = new Set(['delivered-to', 'x-forwarded-to', 'x-original-to', 'envelope-to', 'x-envelope-to', 'resent-to', 'x-rcpt-to', 'x-delivered-to']);

// ---------------------------------------------------------------------------
// Automated mail
// ---------------------------------------------------------------------------

const AUTOMATED_LOCALPART_RE = /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|noreply-.*|bounces?(?:[+-].*)?|notifications?|notify|newsletter|news|marketing|mailer|daemon)$/;

export function headerText(parsed: ParsedMail, key: string): string | null {
  const v = parsed.headers.get(key);
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.slice(0, HEADER_VALUE_MAX);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(String).join(', ').slice(0, HEADER_VALUE_MAX);
  const o = v as { value?: unknown; text?: unknown };
  if (typeof o.value === 'string') return o.value.slice(0, HEADER_VALUE_MAX);
  if (typeof o.text === 'string') return o.text.slice(0, HEADER_VALUE_MAX);
  return String(v).slice(0, HEADER_VALUE_MAX);
}

/**
 * True if the header is present. mailparser folds every `List-*` header into one `list`
 * entry of `headers`, so the raw header lines are checked too.
 */
export function hasHeader(parsed: ParsedMail, key: string): boolean {
  return parsed.headers.has(key) || (parsed.headerLines ?? []).some((l) => l.key.toLowerCase() === key);
}

function automatedReason(parsed: ParsedMail, fromEmail: string | null): string | null {
  const auto = headerText(parsed, 'auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return 'auto_submitted';
  for (const h of ['list-unsubscribe', 'list-id', 'list-post', 'x-autoreply', 'x-autorespond', 'feedback-id']) {
    if (hasHeader(parsed, h)) return h;
  }
  const precedence = headerText(parsed, 'precedence')?.trim().toLowerCase();
  if (precedence && ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return 'precedence';
  const ct = headerText(parsed, 'content-type')?.toLowerCase() ?? '';
  if (ct.startsWith('multipart/report') || ct.startsWith('message/delivery-status') || ct.startsWith('message/disposition-notification')) return 'report';
  if (fromEmail && AUTOMATED_LOCALPART_RE.test(fromEmail.slice(0, fromEmail.lastIndexOf('@')))) return 'automated_sender';
  return null;
}

// ---------------------------------------------------------------------------
// Authored text
// ---------------------------------------------------------------------------

/** Lines that start the quoted original in a reply; everything from them on is dropped. */
const REPLY_MARKERS: RegExp[] = [
  // Gmail / Apple Mail: "El mié, 7 oct 2026 a las 10:00, Jesús <x@y> escribió:" (may wrap once).
  /^[ \t]*(?:El|On|Le|Am|Il|Em)\s[^\n]{0,300}(?:\n[^\n]{0,300})?\s(?:escribi[oó]|wrote|a\s+[ée]crit|schrieb|ha\s+scritto|escreveu)\s*:?[ \t]*$/im,
  /^[ \t]*-{2,}\s*(?:original message|mensaje original|forwarded message|mensaje reenviado|reenviado)\s*-*\s*$/im,
  // Outlook: separator line or a "De: / From:" header block.
  /^[ \t]*_{8,}[ \t]*$/m,
  /^[ \t]*\*?(?:De|From)\s*:\s?\*?[^\n]{1,300}\n(?:[^\n]{0,300}\n){0,2}[ \t]*\*?(?:Enviado(?:\s+el)?|Sent|Fecha|Date|Para|To)\s*:/im,
];

/** Our own unsubscribe footer (email-draft.ts) and generic opt-out footers. */
const FOOTER_LINE_RE = /(?:si no quieres recibir m[aá]s (?:mensajes|correos)|baja@publiexpe\.info)/i;

/**
 * The text the sender wrote: cut at the first reply marker, without `>` quoted lines, our
 * unsubscribe footer or a `-- ` signature, whitespace-collapsed, bounded to BODY_SCAN_MAX.
 */
export function authoredText(text: string): string {
  let t = text.replace(/\r\n?/g, '\n').slice(0, BODY_SCAN_MAX * 4);
  let cut = t.length;
  for (const re of REPLY_MARKERS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  const sig = /^-- ?$/m.exec(t);
  if (sig) t = t.slice(0, sig.index);
  const lines = t
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .filter((l) => !FOOTER_LINE_RE.test(l))
    .map((l) => l.replace(/\s+/g, ' ').trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, BODY_SCAN_MAX);
}

// ---------------------------------------------------------------------------
// Patterns (matched on lowercase text without diacritics)
// ---------------------------------------------------------------------------

/** Lowercase, no diacritics (é -> e, ñ -> n), whitespace collapsed. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const REPLY_PREFIX_RE = /^\s*(?:(?:re|fw|fwd|rv|res|enc|aw|wg|tr|sv|vs|r)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** Subject without Re:/Fwd:/RV: prefixes (any number of them). */
export function bareSubject(subject: string): string {
  return subject.replace(REPLY_PREFIX_RE, '').trim();
}

/** Whole subject (or whole first authored line) equal to one of these is a baja. */
const EXACT_KEYWORDS = new Set([
  'baja',
  'stop',
  'unsubscribe',
  'darme de baja',
  'darse de baja',
  'dar de baja',
  'darnos de baja',
  'solicitud de baja',
  'peticion de baja',
  'baja lista',
  'baja de la lista',
  'no contactar',
  'remove',
  'remove me',
]);

/** Phrases that mean "unsubscribe me" anywhere in the subject or in the authored text. */
const PHRASES: RegExp[] = [
  /\b(?:dar|darme|darnos|darse|darle|darles|dadme|dadnos|deme|denme|denos|dennos)\s+de\s+baja\b/,
  /\b(?:me|nos)\s+(?:\w+\s+)?(?:deis|des|den|de|da|dais|dan|daria|darian|dariais)\s+de\s+baja\b/,
  /\b(?:solicito|solicitamos|pido|pedimos|quiero|queremos|deseo|deseamos|tramitad|tramiten)\s+(?:la|mi|nuestra)\s+baja\b/,
  /\b(?:solicitud|peticion)\s+de\s+baja\b/,
  /\bbaja\s+de\s+(?:la|vuestra|tu|su|esta|sus|vuestras)\s+(?:lista|listas|base de datos|bbdd|mailing|envios)\b/,
  /\bunsubscribe\b/,
  /\b(?:remove|delete|take)\s+(?:me|us|my (?:email|address))\s+(?:from|off)\b/,
  /\bopt[ -]?out\b/,
  /\bno\s+(?:me\s+|nos\s+|le\s+|les\s+)?(?:contactar|contacteis|contacten|contactes|contacte|volvais a (?:contactar|escribir)|vuelvan a (?:contactar|escribir)|vuelvas a (?:contactar|escribir)|vuelva a (?:contactar|escribir))\b/,
  /\bno\s+(?:me|nos)\s+(?:escribais|escriban|escribas|envieis|envien|mandeis|manden)\s+mas\b/,
  /\b(?:quitar|quitarme|quitarnos|quitadme|quitadnos|eliminar|eliminarme|eliminarnos|eliminadme|eliminadnos|borrar|borrarme|borradme|sacar|sacarme|sacadme)\s+de\s+(?:la|vuestra|tu|su|sus|vuestras|esta|estas)\s+(?:lista|listas|base de datos|bbdd|mailing)\b/,
  /\b(?:me|nos)\s+(?:quiteis|quiten|quites|quite|elimineis|eliminen|borreis|borren|saqueis|saquen)\s+de\s+(?:la|vuestra|tu|su|sus|vuestras|esta|estas)\s+(?:lista|listas|base de datos|bbdd|mailing)\b/,
];

/** Subject words, word-bounded, that mark a baja on their own. `stop` only as EXACT. */
const SUBJECT_WORDS = /\b(?:baja|unsubscribe)\b/;

function exact(text: string): boolean {
  return EXACT_KEYWORDS.has(fold(text).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim());
}

export function subjectSignal(subject: string): boolean {
  const s = bareSubject(subject);
  if (s.length === 0) return false;
  if (exact(s)) return true;
  const f = fold(s);
  return SUBJECT_WORDS.test(f) || PHRASES.some((re) => re.test(f));
}

export function bodySignals(text: string): BajaSignal[] {
  const signals: BajaSignal[] = [];
  const f = fold(text);
  if (f.length === 0) return signals;
  if (PHRASES.some((re) => re.test(f))) signals.push('body_phrase');
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  // Reply whose first line is just "BAJA" / "STOP" / "Unsubscribe" (plus greeting/punctuation).
  if (exact(firstLine)) signals.push('body_keyword_only');
  return signals;
}

// ---------------------------------------------------------------------------
// Parse + classify
// ---------------------------------------------------------------------------

export async function parseMessage(raw: RawMessage): Promise<ParsedInboundMessage> {
  return (await parseRawMessage(raw)).message;
}

/**
 * One MIME parse of the source, returning both the bounded view the classifiers use and the
 * full `ParsedMail` (headers, DSN parts) for the general inbound triage. Same limits as
 * `parseMessage`.
 */
export async function parseRawMessage(raw: RawMessage): Promise<{ message: ParsedInboundMessage; parsed: ParsedMail }> {
  const parsed = await simpleParser(raw.source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    maxHtmlLengthToParse: 200_000,
  });
  return { message: toInboundMessage(raw, parsed), parsed };
}

/** Bounded text of the whole message (the `text` part, or the HTML without tags). */
export function messageText(parsed: ParsedMail): string {
  return parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]*>/g, ' ') : '');
}

function toInboundMessage(raw: RawMessage, parsed: ParsedMail): ParsedInboundMessage {
  const fromEmail = firstFromAddress(parsed.from);
  const recipients = new Set<string>();
  for (const a of [...addressesOf(parsed.to), ...addressesOf(parsed.cc)]) {
    const n = normalizeEmail(a);
    if (n) recipients.add(n);
  }
  for (const line of parsed.headerLines ?? []) {
    if (!DELIVERY_HEADERS.has(line.key.toLowerCase())) continue;
    for (const m of line.line.slice(0, HEADER_VALUE_MAX).slice(line.key.length + 1).matchAll(EMAIL_IN_TEXT_RE)) {
      const n = normalizeEmail(m[0]);
      if (n) recipients.add(n);
    }
  }
  const text = messageText(parsed);
  return {
    uid: raw.uid,
    messageId: parsed.messageId ? parsed.messageId.slice(0, 300) : null,
    receivedAt: raw.internalDate,
    fromEmail,
    subject: (parsed.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX),
    recipients: [...recipients].slice(0, 100),
    automated: automatedReason(parsed, fromEmail),
    authoredText: authoredText(text),
    truncatedSource: raw.truncated,
  };
}

export function classifyMessage(msg: ParsedInboundMessage, cfg: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG): Classification {
  if (!msg.fromEmail) return { kind: 'IGNORED', reason: 'invalid_sender' };
  const domain = emailDomain(msg.fromEmail);
  if (cfg.ownDomains.some((d) => isDomainOrSubdomain(domain, d.toLowerCase()))) return { kind: 'IGNORED', reason: 'own_domain' };
  if (msg.automated) return { kind: 'IGNORED', reason: 'automated', detail: msg.automated };

  const signals: BajaSignal[] = [];
  const wanted = new Set(cfg.unsubscribeAddresses.map((a) => a.toLowerCase()));
  if (msg.recipients.some((r) => wanted.has(r))) signals.push('recipient_baja_address');
  if (subjectSignal(msg.subject)) signals.push('subject_keyword');
  signals.push(...bodySignals(msg.authoredText));
  return signals.length > 0 ? { kind: 'BAJA', email: msg.fromEmail, signals } : { kind: 'IGNORED', reason: 'not_unsubscribe' };
}
