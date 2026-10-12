/**
 * Native Twenty `Person` records (tanda 19): the people the ContactFinder finds published on a
 * company's web and the senders of interested replies get a real Person (timeline, automatic
 * association of emails by address) instead of living only inside Research text or notes.
 *
 * Rules (decisions of the PM):
 * - Only PERSONAL mailboxes create a Person. Generic (`info@`, `contacto@`), function
 *   (`comercial@`, `ventas@`), role (`rrhh@`, `pedidos@`) and never-contact (`noreply@`, `dpo@`)
 *   mailboxes never do: they are not people (`personMailbox`).
 * - Dedupe by email: the address is looked up in `emails.primaryEmail` first (case-insensitive).
 *   An existing Person is only COMPLETED (empty name / jobTitle / company), never overwritten.
 * - Names are split with care (`splitPersonName`); a name that cannot be split goes whole to
 *   `firstName`. Nothing is invented: no name is derived from the address.
 *
 * Person has no `tenantId` (standard object, shared by the workspace): see the README, limits.
 */
import { TWENTY_OBJECTS, TwentyApiError, filterValue, type TwentyClient, type TwentyPerson } from '../integrations/twenty/index.js';
import { fold, localKind, neverReason } from '../contact-finder/classify.js';
import { normalizeEmail } from '../inbound/unsubscribe-classifier.js';

export const PERSON_NAME_MAX = 80;
export const PERSON_JOB_TITLE_MAX = 120;

/** Local parts of automated senders (same family as the inbound classifier's): never a person. */
const AUTOMATED_LOCAL_RE = /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|noreply-.*|bounces?(?:[+-].*)?|notifications?|notify|newsletter|news|mailer|daemon)$/;

export type MailboxKind = 'person' | 'generic' | 'function' | 'role' | 'never' | 'invalid';

/** What kind of mailbox an address is. Only `person` creates a Person. */
export function personMailbox(email: string | null | undefined): MailboxKind {
  const e = normalizeEmail(email ?? null);
  if (!e) return 'invalid';
  if (neverReason(e) || AUTOMATED_LOCAL_RE.test(e.slice(0, e.lastIndexOf('@')))) return 'never';
  const kind = localKind(e).kind;
  if (kind === 'generic') return 'generic';
  if (kind === 'function') return 'function';
  if (kind === 'low') return 'role';
  return 'person';
}

export function isPersonMailbox(email: string | null | undefined): boolean {
  return personMailbox(email) === 'person';
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Folded words that mean the "name" is an organisation or a department, not a person. */
const NOT_A_PERSON = new Set([
  'sa',
  'sl',
  'slu',
  'sau',
  'sll',
  'scoop',
  'coop',
  'cooperativa',
  'ltd',
  'gmbh',
  'inc',
  'llc',
  'grupo',
  'group',
  'departamento',
  'dpto',
  'depto',
  'equipo',
  'team',
  'info',
  'informacion',
  'comercial',
  'ventas',
  'sales',
  'marketing',
  'administracion',
  'atencion',
  'cliente',
  'clientes',
  'soporte',
  'support',
  'oficina',
  'office',
  'contacto',
  'contact',
  'recepcion',
  'empresa',
  'company',
  'publiexpe',
]);

/** Honorifics dropped before splitting (folded, without the final dot). */
const HONORIFICS = new Set(['sr', 'sra', 'srta', 'd', 'dna', 'dña', 'don', 'dona', 'dr', 'dra', 'mr', 'mrs', 'ms', 'miss', 'prof']);

/** Particles of Spanish/Portuguese/Dutch/German surnames (kept lowercase in title case). */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'i', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der']);

/**
 * Compound given names (folded), so "María José López Ruiz" is María José / López Ruiz and
 * "María del Carmen Ruiz" is María del Carmen / Ruiz. Longest match wins.
 */
const COMPOUND_GIVEN = new Set([
  'maria jose',
  'maria jesus',
  'maria luisa',
  'maria teresa',
  'maria angeles',
  'maria carmen',
  'maria isabel',
  'maria pilar',
  'maria elena',
  'maria victoria',
  'maria dolores',
  'maria antonia',
  'maria rosa',
  'maria eugenia',
  'maria belen',
  'maria cristina',
  'maria mercedes',
  'maria paz',
  'maria rosario',
  'maria del carmen',
  'maria de los angeles',
  'maria del mar',
  'maria del pilar',
  'maria del rosario',
  'maria de la paz',
  'maria de las mercedes',
  'maria del sol',
  'ana maria',
  'ana belen',
  'ana isabel',
  'rosa maria',
  'mari carmen',
  'mari luz',
  'mari jose',
  'jose maria',
  'jose luis',
  'jose antonio',
  'jose manuel',
  'jose carlos',
  'jose ignacio',
  'jose javier',
  'jose miguel',
  'jose ramon',
  'jose angel',
  'jose francisco',
  'juan carlos',
  'juan jose',
  'juan antonio',
  'juan manuel',
  'juan luis',
  'juan pablo',
  'juan ignacio',
  'juan francisco',
  'juan miguel',
  'juan ramon',
  'francisco javier',
  'francisco jose',
  'miguel angel',
  'luis miguel',
  'pedro jose',
  'jesus maria',
  'carlos alberto',
  'luis alberto',
]);

const NAME_TOKEN_RE = /^[\p{L}][\p{L}'’.-]*$/u;

function titleCaseToken(token: string, index: number): string {
  const lower = token.toLocaleLowerCase('es');
  if (index > 0 && PARTICLES.has(lower)) return lower;
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, ch: string) => `${sep}${ch.toLocaleUpperCase('es')}`);
}

function oddCase(token: string, index: number): boolean {
  const lower = token.toLocaleLowerCase('es');
  if (index > 0 && PARTICLES.has(lower)) return token !== lower;
  const first = token.charAt(0);
  if (first !== first.toLocaleUpperCase('es')) return true;
  return token.length > 1 && token === token.toLocaleUpperCase('es');
}

/**
 * The person name of a display string, cleaned: no quotes, no address, no "| Empresa" or
 * "(Cargo)" tail, no honorific, single spaces, title case when it was ALL CAPS. Null when it
 * does not read as a person name (digits, an organisation or department word, too long).
 */
export function cleanPersonName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>"“”«»]/g, ' ')
    .replace(/\S+@\S+/g, ' ');
  // Tails: "María López | Acme", "María López - Marketing", "María López (Acme)", "María López / Acme".
  t = t.split(/\s[|–—/-]\s|\s*\(|\s*\[|\s*\|/)[0] ?? '';
  t = t.replace(/\s+/g, ' ').trim();
  // "López García, María" -> "María López García" (one comma, both sides look like names).
  const comma = t.split(',').map((s) => s.trim());
  if (comma.length === 2 && comma[0] && comma[1]) t = `${comma[1]} ${comma[0]}`;
  else if (comma.length > 1) return null;
  let tokens = t.split(' ').filter((x) => x.length > 0);
  while (tokens.length > 1 && HONORIFICS.has(fold(tokens[0]!).replace(/\.$/, ''))) tokens = tokens.slice(1);
  if (tokens.length === 0 || tokens.length > 6) return null;
  if (!tokens.every((x) => NAME_TOKEN_RE.test(x))) return null;
  if (tokens.some((x) => NOT_A_PERSON.has(fold(x).replace(/\./g, '')))) return null;
  const joined = tokens.join(' ');
  if (joined.length > PERSON_NAME_MAX) return null;
  // Odd capitalisation ("MARÍA LÓPEZ", "maría", "mARÍA") is normalised token by token; a
  // token already written as a name ("María", "McKay", "O'Neill") is kept as is.
  return tokens.map((x, i) => (oddCase(x, i) ? titleCaseToken(x, i) : x)).join(' ');
}

export interface SplitName {
  firstName: string;
  lastName: string;
}

/**
 * Splits a person name into given name(s) and surname(s). Compound given names ("María José",
 * "José Luis", "María del Carmen") stay together; one word (or a whole compound given name)
 * goes to `firstName` with an empty `lastName`. Null when it is not a person name.
 */
export function splitPersonName(raw: string | null | undefined): SplitName | null {
  const name = cleanPersonName(raw);
  if (!name) return null;
  const tokens = name.split(' ');
  const folded = tokens.map((x) => fold(x));
  for (let n = Math.min(4, tokens.length); n >= 2; n--) {
    if (COMPOUND_GIVEN.has(folded.slice(0, n).join(' '))) {
      return { firstName: tokens.slice(0, n).join(' '), lastName: tokens.slice(n).join(' ') };
    }
  }
  if (tokens.length === 1) return { firstName: tokens[0]!, lastName: '' };
  return { firstName: tokens[0]!, lastName: tokens.slice(1).join(' ') };
}

/** Job title as stored: one line, no angle brackets, bounded. Null when empty. */
export function cleanJobTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length === 0) return null;
  return t.length > PERSON_JOB_TITLE_MAX ? `${t.slice(0, PERSON_JOB_TITLE_MAX - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export interface PersonSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  companyId: string | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

export function toPersonSummary(p: TwentyPerson): PersonSummary {
  return {
    id: p.id,
    firstName: text(p.name?.firstName),
    lastName: text(p.name?.lastName),
    jobTitle: text(p.jobTitle),
    email: text(p.emails?.primaryEmail)?.toLowerCase() ?? null,
    companyId: text(p.companyId),
  };
}

/** "María López" / "María" / null. */
export function personDisplayName(p: Pick<PersonSummary, 'firstName' | 'lastName'>): string | null {
  const n = [p.firstName, p.lastName].filter((x): x is string => !!x).join(' ').trim();
  return n.length > 0 ? n : null;
}

/** The Person whose primary email is `email` (case-insensitive exact match), or null. */
export async function findPersonByEmail(twenty: TwentyClient, email: string, signal?: AbortSignal): Promise<TwentyPerson | null> {
  const wanted = email.toLowerCase();
  // ilike without wildcards is a case-insensitive equality, except for `_`: re-checked here.
  const { records } = await twenty.list<TwentyPerson>(TWENTY_OBJECTS.person, {
    filter: `emails.primaryEmail[ilike]:${filterValue(wanted)}`,
    limit: 10,
    ...(signal ? { signal } : {}),
  });
  const same = records.filter((p) => (p.emails?.primaryEmail ?? '').trim().toLowerCase() === wanted && !p.deletedAt);
  // Oldest first: the record the commercial has been working with.
  return same.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

export interface UpsertPersonInput {
  email: string;
  /** Display name as published (web, From header). Split with `splitPersonName`. */
  fullName?: string | null;
  jobTitle?: string | null;
  companyId?: string | null;
}

export type UpsertPersonResult =
  | { outcome: 'skipped'; reason: Exclude<MailboxKind, 'person'>; email: string; person: null; filled: [] }
  | { outcome: 'created' | 'updated' | 'unchanged'; reason: null; email: string; person: PersonSummary; filled: string[] };

/**
 * Creates or completes the Person of `email`. Generic/function/role/never mailboxes are skipped
 * (no request at all). An existing Person (same primary email) gets only its EMPTY fields
 * filled: name, jobTitle, companyId. A concurrent create (Twenty's unique primary email) is
 * resolved by reading the winner and completing it.
 */
export async function upsertPerson(twenty: TwentyClient, input: UpsertPersonInput, signal?: AbortSignal): Promise<UpsertPersonResult> {
  const kind = personMailbox(input.email);
  const email = normalizeEmail(input.email) ?? input.email.trim().toLowerCase();
  if (kind !== 'person') return { outcome: 'skipped', reason: kind, email, person: null, filled: [] };
  const name = splitPersonName(input.fullName);
  const jobTitle = cleanJobTitle(input.jobTitle);
  const companyId = input.companyId ?? null;

  const complete = async (existing: TwentyPerson): Promise<UpsertPersonResult> => {
    const cur = toPersonSummary(existing);
    const patch: Record<string, unknown> = {};
    const filled: string[] = [];
    if (name && !cur.firstName && !cur.lastName) {
      patch.name = { firstName: name.firstName, lastName: name.lastName };
      filled.push('name');
    }
    if (jobTitle && !cur.jobTitle) {
      patch.jobTitle = jobTitle;
      filled.push('jobTitle');
    }
    if (companyId && !cur.companyId) {
      patch.companyId = companyId;
      filled.push('companyId');
    }
    if (filled.length === 0) return { outcome: 'unchanged', reason: null, email, person: cur, filled: [] };
    const updated = await twenty.update<TwentyPerson>(TWENTY_OBJECTS.person, existing.id, patch, signal ? { signal } : {});
    return { outcome: 'updated', reason: null, email, person: toPersonSummary({ ...existing, ...updated }), filled };
  };

  const existing = await findPersonByEmail(twenty, email, signal);
  if (existing) return complete(existing);
  try {
    const created = await twenty.create<TwentyPerson>(
      TWENTY_OBJECTS.person,
      {
        name: { firstName: name?.firstName ?? '', lastName: name?.lastName ?? '' },
        emails: { primaryEmail: email, additionalEmails: [] },
        ...(jobTitle ? { jobTitle } : {}),
        ...(companyId ? { companyId } : {}),
      },
      signal ? { signal } : {},
    );
    return { outcome: 'created', reason: null, email, person: toPersonSummary(created), filled: [] };
  } catch (err) {
    if (err instanceof TwentyApiError && err.code === 'TWENTY_DUPLICATE') {
      const winner = await findPersonByEmail(twenty, email, signal);
      if (winner) return complete(winner);
    }
    throw err;
  }
}
