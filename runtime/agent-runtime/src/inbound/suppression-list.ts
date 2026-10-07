/**
 * The suppression list lives in ONE Twenty note, "Lista de supresión — NO contactar"
 * (docs/email-warmup.md, "Gestión de bajas"). One entry per line:
 *
 *     email — AAAA-MM-DD — motivo
 *     @dominio.example — AAAA-MM-DD — motivo      (whole-company opt-out)
 *
 * The runtime only APPENDS lines (tool `update_note`); existing lines are never edited.
 */
import { emailDomain, normalizeEmail } from './unsubscribe-classifier.js';

export const SUPPRESSION_NOTE_ID = '6658e882-60f9-427f-808d-dc5c255570dc';
export const SUPPRESSION_NOTE_TITLE = 'Lista de supresión — NO contactar';
/** Characters of the subject kept in the motive. */
export const MOTIVE_SUBJECT_MAX = 80;

export interface SuppressionList {
  emails: Set<string>;
  domains: Set<string>;
}

/** Twenty serialises BlockNote to markdown and may escape punctuation (`\_`, `\.`). */
function unescapeMarkdown(line: string): string {
  return line.replace(/\\([\\`*_{}[\]()#+\-.!|<>~@])/g, '$1');
}

const LEADING_EMAIL_RE = /^[<[(]?([^\s<>()[\]"'—–,;]+@[^\s<>()[\]"'—–,;]+)/;
const LEADING_DOMAIN_RE = /^@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\b/i;

/**
 * Entries of the note: the address (or `@domain`) that STARTS each line, after removing list
 * markers and markdown escapes. Mailto links (`[a@b](mailto:a@b)`) are understood.
 */
export function parseSuppressionList(markdown: string): SuppressionList {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const raw of markdown.split(/\r?\n/)) {
    const line = unescapeMarkdown(raw)
      .trim()
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\*\*|^__/, '')
      .replace(/^\[([^\]]*)\]\(mailto:[^)]*\)/i, '$1')
      .trim();
    if (line.length === 0) continue;
    const domain = LEADING_DOMAIN_RE.exec(line);
    if (domain) {
      domains.add(domain[1]!.toLowerCase());
      continue;
    }
    const m = LEADING_EMAIL_RE.exec(line);
    const email = normalizeEmail(m?.[1]?.replace(/^mailto:/i, '').replace(/[.,;:]+$/, ''));
    if (email) emails.add(email);
  }
  return { emails, domains };
}

/** True if the address, or its domain (or a parent domain) as `@domain`, is in the list. */
export function isSuppressed(email: string, list: SuppressionList): boolean {
  if (list.emails.has(email)) return true;
  const labels = emailDomain(email).split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.domains.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * Subject reduced to plain, safe text for the note: no control characters, no markdown or
 * HTML syntax, no quotes or `@` (so the line can never look like another entry), bounded.
 */
export function sanitizeSubject(subject: string, max = MOTIVE_SUBJECT_MAX): string {
  const clean = subject
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} .,;:!?¿¡()'/&%€$+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** `AAAA-MM-DD` of `date` in `timeZone`. */
export function localDate(date: Date, timeZone = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** `email — AAAA-MM-DD — baja solicitada (asunto: "...")`. */
export function suppressionLine(email: string, date: string, subject: string): string {
  const s = sanitizeSubject(subject);
  return `${email} — ${date} — baja solicitada (asunto: "${s.length > 0 ? s : 'sin asunto'}")`;
}
