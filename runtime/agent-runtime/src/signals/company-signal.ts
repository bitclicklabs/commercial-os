/**
 * Company signals (tanda 21): something a COMPANY did, not a fair. Three kinds in v1:
 *
 * | kind (`CompanySignalKind`) | What happened                          | Name suffix        | `signalType` written |
 * |----------------------------|----------------------------------------|--------------------|----------------------|
 * | `apertura`                 | new store / factory / headquarters     | `— apertura`       | EXPANSION            |
 * | `financiacion`             | funding round                          | `— financiación`   | OTHER                |
 * | `aniversario`              | company anniversary                    | `— aniversario`    | ANNIVERSARY          |
 *
 * PM decision (tanda 21): the TYPE IS THE NAME SUFFIX. No field is added to the Twenty App schema;
 * `signalType` gets the closest existing enum value only as a hint for a person (the App has no
 * funding value), and the code NEVER decides by it: `isCompanySignal` reads the name. Convention
 * of the name written by the weekly scout:
 *
 *     "<empresa>: <qué pasó> — <tipo>"     e.g. "Conservas Ortiz: abre una nueva fábrica en Ondarroa — apertura"
 *
 * The part before the first `": "` is the company (read back when the signal is qualified).
 * Detection is tolerant: em dash, en dash or hyphen before the type, any case, with or without
 * accent (`financiacion`), and the parenthesised form `(apertura)` a person may type by hand.
 * Fair-like types (FAIR / CONGRESS / EVENT) are never company signals, whatever their name.
 *
 * Dates: `eventDate` of a company signal is the date of the NEWS. Rules (PM, closed):
 * - created only when the news is at most COMPANY_SIGNAL_FRESH_DAYS (60) days old;
 * - it expires (EXPIRED, daily run) once the news is more than COMPANY_SIGNAL_EXPIRY_DAYS (120)
 *   days old, and its PROPOSED hypotheses with it. No special rule for future openings in v1.
 * The fairs keep their own rules (lead time 45-210 days, expiry on the fair date).
 *
 * Pure module: no I/O.
 */
import { daysUntil } from './lead-time.js';

export const COMPANY_SIGNAL_KINDS = ['apertura', 'financiacion', 'aniversario'] as const;
export type CompanySignalKind = (typeof COMPANY_SIGNAL_KINDS)[number];

/** Closest existing Twenty `signalType` (a hint only: the name suffix is the type). */
export const COMPANY_SIGNAL_TYPE: Record<CompanySignalKind, 'EXPANSION' | 'OTHER' | 'ANNIVERSARY'> = {
  apertura: 'EXPANSION',
  financiacion: 'OTHER',
  aniversario: 'ANNIVERSARY',
};

/** Suffix word of the signal name. */
export const COMPANY_SIGNAL_SUFFIX: Record<CompanySignalKind, string> = {
  apertura: 'apertura',
  financiacion: 'financiación',
  aniversario: 'aniversario',
};

export const COMPANY_SIGNAL_LABEL_ES: Record<CompanySignalKind, string> = {
  apertura: 'apertura',
  financiacion: 'ronda de financiación',
  aniversario: 'aniversario',
};

/** A company signal is created only if its news is at most this many days old. */
export const COMPANY_SIGNAL_FRESH_DAYS = 60;
/** A company signal (and its PROPOSED hypotheses) expires once its news is older than this many days. */
export const COMPANY_SIGNAL_EXPIRY_DAYS = 120;

const FAIR_LIKE_TYPES = new Set(['FAIR', 'CONGRESS', 'EVENT']);
/** `— apertura`, `– financiacion`, `- Aniversario`, `(apertura)` at the end of the name. */
const SUFFIX_RE = /(?:\s+[—–-]\s*(apertura|financiaci[oó]n|aniversario)|\s*\(\s*(apertura|financiaci[oó]n|aniversario)\s*\))\s*$/i;

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Kind written in the name suffix, or null. */
export function companySignalKindOfName(name: string | null | undefined): CompanySignalKind | null {
  const m = SUFFIX_RE.exec(name ?? '');
  if (!m) return null;
  const k = fold(m[1] ?? m[2]!);
  return k === 'apertura' ? 'apertura' : k === 'aniversario' ? 'aniversario' : 'financiacion';
}

/**
 * Is this signal a company signal? By its NAME suffix only; a fair-like type never is. The caller
 * checks it is event-level (no `companyId`): per-exhibitor signals never fire anything.
 */
export function isCompanySignal(s: { signalType?: string | null | undefined; name: string | null | undefined }): boolean {
  if (FAIR_LIKE_TYPES.has((s.signalType ?? '').toUpperCase())) return false;
  return companySignalKindOfName(s.name) !== null;
}

/** `"<empresa>: <qué pasó> — <tipo>"`, cut to 255 characters keeping the suffix. */
export function companySignalTitle(company: string, what: string, kind: CompanySignalKind): string {
  const suffix = ` — ${COMPANY_SIGNAL_SUFFIX[kind]}`;
  const head = `${company.trim()}: ${what.trim().replace(/[.\s]+$/, '')}`;
  return `${head.slice(0, 255 - suffix.length).trimEnd()}${suffix}`;
}

/** Name without the company suffix. */
export function stripCompanySuffix(name: string): string {
  return name.replace(SUFFIX_RE, '').trim();
}

/** Company and headline read back from a signal name (`"<empresa>: <qué pasó> — <tipo>"`). */
export function parseCompanySignalName(name: string): { company: string | null; headline: string } {
  const bare = stripCompanySuffix(name);
  const i = bare.indexOf(': ');
  if (i <= 0) return { company: null, headline: bare };
  const company = bare.slice(0, i).trim();
  const headline = bare.slice(i + 2).trim();
  return { company: company.length > 0 && company.length <= 255 ? company : null, headline: headline || bare };
}

export type FreshnessVerdict =
  | { fresh: true; age_days: number }
  | { fresh: false; age_days: number | null; reason: 'no_news_date' | 'news_in_future' | 'stale_news' };

/** Freshness gate at creation (Madrid day `today`): the news is at most COMPANY_SIGNAL_FRESH_DAYS old. */
export function companySignalFreshness(newsDate: string | null | undefined, today: string): FreshnessVerdict {
  const until = daysUntil(newsDate ?? null, today);
  if (until === null) return { fresh: false, age_days: null, reason: 'no_news_date' };
  const age = -until;
  // One day of slack: a news dated "tomorrow" in another time zone.
  if (age < -1) return { fresh: false, age_days: age, reason: 'news_in_future' };
  if (age > COMPANY_SIGNAL_FRESH_DAYS) return { fresh: false, age_days: age, reason: 'stale_news' };
  return { fresh: true, age_days: Math.max(0, age) };
}

/** Age in days of the news (today - newsDate), or null. */
export function newsAgeDays(newsDate: string | null | undefined, today: string): number | null {
  const until = daysUntil(newsDate ?? null, today);
  return until === null ? null : -until;
}

/** True when the news of a company signal is older than COMPANY_SIGNAL_EXPIRY_DAYS (it must expire). No date: never. */
export function isExpiredCompanySignal(newsDate: string | null | undefined, today: string): boolean {
  const age = newsAgeDays(newsDate, today);
  return age !== null && age > COMPANY_SIGNAL_EXPIRY_DAYS;
}

/** Last day (YYYY-MM-DD) the company signal is alive: news date + COMPANY_SIGNAL_EXPIRY_DAYS. Null without a date. */
export function companySignalDeadline(newsDate: string | null | undefined): string | null {
  if (!newsDate) return null;
  const t = Date.parse(`${newsDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t + COMPANY_SIGNAL_EXPIRY_DAYS * 86_400_000).toISOString().slice(0, 10);
}
