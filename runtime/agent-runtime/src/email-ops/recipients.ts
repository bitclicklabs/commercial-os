/**
 * Recipient checks of the send-from-Twenty flow. Pure logic, no I/O.
 *
 * `emailTo` is a TEXT field typed by a person: one or more addresses separated by commas
 * or semicolons, optionally as `Nombre <a@b.com>`. Every address must be valid and none may
 * be in the suppression list (exact address, or `@domain` covering it or a parent domain:
 * `@empresa.example` also suppresses `ventas.empresa.example`).
 */
import { isSuppressed, type SuppressionList } from '../inbound/suppression-list.js';
import { emailDomain, normalizeEmail } from '../inbound/unsubscribe-classifier.js';

export interface ParsedRecipients {
  /** Valid addresses, normalised (lower case), without duplicates, in order. */
  valid: string[];
  /** Pieces that are not a valid address (as typed, trimmed). */
  invalid: string[];
}

export function parseRecipients(emailTo: unknown): ParsedRecipients {
  const valid: string[] = [];
  const invalid: string[] = [];
  if (typeof emailTo !== 'string') return { valid, invalid };
  for (const raw of emailTo.split(/[,;\n]+/)) {
    const piece = raw.trim();
    if (piece.length === 0) continue;
    const angle = /<([^<>]+)>\s*$/.exec(piece);
    const candidate = (angle ? angle[1]! : piece).replace(/^mailto:/i, '');
    const email = normalizeEmail(candidate);
    if (!email) invalid.push(piece);
    else if (!valid.includes(email)) valid.push(email);
  }
  return { valid, invalid };
}

export type SuppressionMatch = { email: string; by: 'email' | 'domain'; entry: string };

/** Which suppression entry covers `email` (exact address first, then the closest `@domain`). */
export function suppressionMatch(email: string, list: SuppressionList): SuppressionMatch | null {
  if (list.emails.has(email)) return { email, by: 'email', entry: email };
  if (!isSuppressed(email, list)) return null;
  const labels = emailDomain(email).split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = labels.slice(i).join('.');
    if (list.domains.has(domain)) return { email, by: 'domain', entry: `@${domain}` };
  }
  return null;
}

export type BlockReason = 'suppressed' | 'missing_recipient' | 'invalid_recipient' | 'suppression_list_unavailable';

export type RecipientCheck =
  | { ok: true; recipients: string[] }
  | { ok: false; reason: BlockReason; recipients: string[]; invalid: string[]; matches: SuppressionMatch[] };

/**
 * Decision for an `emailTo` about to be sent. `list === null` means the suppression list
 * could not be read: the check FAILS CLOSED (`suppression_list_unavailable`).
 */
export function checkRecipients(emailTo: unknown, list: SuppressionList | null): RecipientCheck {
  const { valid, invalid } = parseRecipients(emailTo);
  const fail = (reason: BlockReason, matches: SuppressionMatch[] = []): RecipientCheck => ({ ok: false, reason, recipients: valid, invalid, matches });
  if (valid.length === 0 && invalid.length === 0) return fail('missing_recipient');
  if (invalid.length > 0) return fail('invalid_recipient');
  if (!list) return fail('suppression_list_unavailable');
  const matches = valid.map((e) => suppressionMatch(e, list)).filter((m): m is SuppressionMatch => m !== null);
  if (matches.length > 0) return fail('suppressed', matches);
  return { ok: true, recipients: valid };
}

/** Distinct domains of the recipients (what events may carry instead of addresses). */
export function recipientDomains(recipients: readonly string[]): string[] {
  return [...new Set(recipients.map(emailDomain))];
}
