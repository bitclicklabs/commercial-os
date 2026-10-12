/**
 * Deterministic classification and priority of a contact candidate (pure, unit tested).
 *
 * Priority tiers (lower is better), decision of the PM for the ContactFinder (tanda 17):
 *   1. a PERSON with a relevant job title (management, sales, marketing, purchasing);
 *   2. a useful FUNCTION mailbox (`comercial@`, `ventas@`, `marketing@`, `export@`...);
 *   3. a GENERIC mailbox (`info@`, `contacto@`, `hola@`...);
 *   4. anything else on the company domain (a person without a relevant title, `rrhh@`...).
 * NEVER (discarded, not even listed as an option): `noreply@`, `privacy@`, `dpo@`, `rgpd@`,
 * `baja@` and their variants. An address outside the company domain (a published gmail)
 * is kept as a low-priority candidate (tier 5) and is never written into `emailTo`.
 */

export type ContactTier = 1 | 2 | 3 | 4 | 5;

/** Kinds of relevant job titles, in tie-break order (the merchandising budget usually sits in marketing). */
export const ROLE_KINDS = ['marketing', 'gerencia', 'comercial', 'compras'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const TIER_LABELS: Record<ContactTier, string> = {
  1: 'persona con cargo relevante',
  2: 'buzón de función',
  3: 'buzón genérico',
  4: 'otra dirección del dominio',
  5: 'fuera del dominio de la empresa',
};

/** Lowercase, no accents, single spaces. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Job-title keywords per kind (folded text, word-bounded). */
const ROLE_PATTERNS: Record<RoleKind, RegExp> = {
  marketing: /\b(marketing|mkt|brand manager|trade marketing|responsable de marca|jefe de marca|comunicacion|communications?|eventos|events manager)\b/,
  gerencia: /\b(gerente|gerencia|director(a)? general|ceo|consejer[oa] delegad[oa]|managing director|general manager|propietari[oa]|fundador(a)?|founder|co-?founder|owner|president[ea]?|socio director|direccion general)\b/,
  comercial: /\b(comercial|ventas|sales|export(acion|ation)?|key account|area manager|business development|desarrollo de negocio|account manager|director(a)? de negocio)\b/,
  compras: /\b(compras|purchasing|buyer|procurement|aprovisionamiento)\b/,
};

/** Relevant kind of a job title (first match in `ROLE_KINDS` order), or null. */
export function roleKindOf(jobTitle: string | null | undefined): RoleKind | null {
  if (!jobTitle) return null;
  const t = fold(jobTitle);
  for (const kind of ROLE_KINDS) if (ROLE_PATTERNS[kind].test(t)) return kind;
  return null;
}

/**
 * Local parts that are never proposed (opt-out, privacy, robots). PREFIX: matched on the folded
 * local part without separators (`no-reply2` -> `noreply2`). TOKEN: matched on any piece
 * of the local part split by `. _ - +` (`dpo.grupo@` yes, `bajamonde@` no).
 */
const NEVER_PREFIX = ['noreply', 'donotreply', 'nonrespondere', 'privacy', 'privacidad', 'protecciondedatos', 'protecciondatos', 'dataprotection', 'rgpd', 'gdpr', 'lopd', 'unsubscribe', 'mailerdaemon', 'bounce'];
const NEVER_TOKEN = ['dpo', 'baja', 'bajas', 'abuse', 'postmaster', 'hostmaster', 'noreply'];

/** Function mailboxes (tier 2), in tie-break order. */
export const FUNCTION_LOCALS = [
  'marketing',
  'mkt',
  'comercial',
  'comerciales',
  'ventas',
  'sales',
  'export',
  'exportacion',
  'exportaciones',
  'exports',
  'compras',
  'purchasing',
  'eventos',
  'ferias',
  'comunicacion',
  'trade',
];

/** Generic mailboxes (tier 3), in tie-break order. */
export const GENERIC_LOCALS = ['info', 'informacion', 'contacto', 'contact', 'contacta', 'hola', 'hello', 'general', 'oficina', 'office', 'atencionalcliente', 'clientes', 'customer', 'correo', 'mail', 'email'];

/** Tier-4 mailboxes that are rarely the right first contact (ranked last inside tier 4). Exact match. */
const LOW_LOCALS = [
  'rrhh',
  'empleo',
  'jobs',
  'cv',
  'trabaja',
  'trabajaconnosotros',
  'talento',
  'seleccion',
  'facturacion',
  'factura',
  'facturas',
  'invoices',
  'admin',
  'administracion',
  'contabilidad',
  'soporte',
  'support',
  'tecnico',
  'sat',
  'pedidos',
  'orders',
  'prensa',
  'press',
  'legal',
  'web',
  'webmaster',
  'calidad',
];

/** Folded local part without separators, digits kept (`no-reply` -> `noreply`). */
export function localKey(email: string): string {
  const local = email.slice(0, email.lastIndexOf('@'));
  return fold(local.split('+')[0]!).replace(/[._-]/g, '');
}

function neverText(n: string): string {
  if (n.includes('reply') || n === 'nonrespondere') return 'buzón que no admite respuestas (noreply)';
  if (['baja', 'bajas', 'unsubscribe'].includes(n)) return 'buzón de bajas';
  if (['abuse', 'postmaster', 'hostmaster', 'mailerdaemon', 'bounce'].includes(n)) return 'buzón técnico del servidor de correo';
  return 'buzón de privacidad / protección de datos';
}

/** Why an address must never be proposed, or null. */
export function neverReason(email: string): string | null {
  const key = localKey(email);
  const prefix = NEVER_PREFIX.find((n) => key.startsWith(n));
  if (prefix) return neverText(prefix);
  const local = fold(email.slice(0, email.lastIndexOf('@')).split('+')[0]!);
  const token = local.split(/[._-]+/).find((t) => NEVER_TOKEN.includes(t));
  return token ? neverText(token) : null;
}

export type LocalKind = 'function' | 'generic' | 'low' | 'other';

export function localKind(email: string): { kind: LocalKind; rank: number } {
  const key = localKey(email);
  const f = FUNCTION_LOCALS.findIndex((l) => key === l || (key.startsWith(l) && key.length - l.length <= 4));
  if (f >= 0) return { kind: 'function', rank: f };
  const g = GENERIC_LOCALS.indexOf(key);
  if (g >= 0) return { kind: 'generic', rank: g };
  const lo = LOW_LOCALS.indexOf(key);
  if (lo >= 0) return { kind: 'low', rank: lo };
  return { kind: 'other', rank: 0 };
}

/** The local part looks like a person (`maria.lopez`, `jgarcia`, `m.lopez`), not a role. */
export function looksPersonal(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase();
  if (localKind(email).kind !== 'other') return false;
  if (/\d{3,}/.test(local)) return false;
  return /^[a-z]{1,20}([._-][a-z]{1,20}){0,2}$/.test(local);
}

export interface Classification {
  tier: ContactTier;
  /** Order inside the tier (lower first). */
  subrank: number;
  /** Short Spanish label for the Research. */
  label: string;
  roleKind: RoleKind | null;
}

/**
 * Tier of an address. `onDomain`: the address belongs to the company domain (or a
 * subdomain). `jobTitle`: the title published next to it, if any. `hasName`: a person
 * name was published next to it.
 */
export function classifyCandidate(email: string, opts: { onDomain: boolean; jobTitle?: string | null; hasName?: boolean }): Classification {
  const kind = localKind(email);
  const role = roleKindOf(opts.jobTitle);
  if (!opts.onDomain) return { tier: 5, subrank: 0, label: TIER_LABELS[5], roleKind: role };
  if (kind.kind === 'function') return { tier: 2, subrank: kind.rank, label: `${TIER_LABELS[2]} (${email.slice(0, email.indexOf('@') + 1)})`, roleKind: role };
  if (kind.kind === 'generic') return { tier: 3, subrank: kind.rank, label: `${TIER_LABELS[3]} (${email.slice(0, email.indexOf('@') + 1)})`, roleKind: role };
  if (kind.kind === 'other' && role && (opts.hasName || looksPersonal(email))) {
    return { tier: 1, subrank: ROLE_KINDS.indexOf(role), label: `${TIER_LABELS[1]} (${role})`, roleKind: role };
  }
  // Tier 4: a person without a relevant title first, then other addresses, then the low ones.
  const subrank = kind.kind === 'low' ? 2 : opts.hasName || looksPersonal(email) ? 0 : 1;
  return { tier: 4, subrank, label: TIER_LABELS[4], roleKind: role };
}
