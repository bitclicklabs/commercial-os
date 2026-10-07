/**
 * Twenty object names, enums and composite-field helpers, mirrored from
 * apps/twenty-app/src/objects/*.ts and verified against the live REST API (Twenty 2.45).
 *
 * Field shapes confirmed against the API:
 * - LINKS:    { primaryLinkUrl, primaryLinkLabel, secondaryLinks: [] }. For Company.domainName
 *             Twenty strips the scheme on write ("https://acme.com" is stored as "acme.com")
 *             and enforces a unique index on it.
 * - CURRENCY: { amountMicros: integer, currencyCode: 'EUR' } (1 EUR = 1_000_000 micros).
 * - SELECT:   UPPER_SNAKE_CASE values; anything else is a 400.
 * - DATE:     'YYYY-MM-DD'. DATE_TIME: ISO 8601.
 * - ARRAY:    string[]. RAW_JSON: any JSON value.
 * - RELATION (MANY_TO_ONE): written through the join column (`companyId`,
 *             `commercialSignalId`, `decisionMakerId`).
 */

export const TWENTY_OBJECTS = {
  company: 'companies',
  commercialSignal: 'commercialSignals',
  research: 'researches',
  commercialHypothesis: 'commercialHypotheses',
  agentRunSummary: 'agentRunSummaries',
} as const;

export const SIGNAL_TYPES = [
  'FAIR',
  'CONGRESS',
  'EVENT',
  'NEW_PRODUCT',
  'HIRING',
  'EXPANSION',
  'REBRANDING',
  'SPONSORSHIP',
  'CAMPAIGN',
  'ANNIVERSARY',
  'OTHER',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** App values (README deviation #8); differ from the LLD v0.2 proposal. */
export const SIGNAL_STATUSES = ['NEW', 'REVIEWING', 'QUALIFIED', 'DISCARDED', 'EXPIRED'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const HYPOTHESIS_STATUSES = ['PROPOSED', 'VALIDATED', 'REJECTED', 'EXPIRED'] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export const RUN_OUTCOMES = ['SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * `research.researchType` and `commercialHypothesis.timing` are TEXT in the App
 * (README deviation #9); the runtime still closes them to the LLD v0.2 enums.
 */
export const RESEARCH_TYPES = ['COMPANY_PROFILE', 'EVENT_EXHIBITORS', 'SIGNAL_VERIFICATION', 'CONTACT_DISCOVERY', 'OTHER'] as const;
export type ResearchType = (typeof RESEARCH_TYPES)[number];

export const HYPOTHESIS_TIMINGS = ['IMMEDIATE', 'THIS_QUARTER', 'NEXT_QUARTER', 'LATER', 'UNKNOWN'] as const;
export type HypothesisTiming = (typeof HYPOTHESIS_TIMINGS)[number];

export interface TwentyLinks {
  primaryLinkUrl: string;
  primaryLinkLabel: string;
  secondaryLinks: Array<{ url: string; label: string }> | null;
}

export interface TwentyCurrency {
  amountMicros: number | null;
  currencyCode: string | null;
}

interface TwentySystemFields {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TwentyCompany extends TwentySystemFields {
  name: string;
  domainName: TwentyLinks | null;
  linkedinLink?: TwentyLinks | null;
  address?: Record<string, unknown> | null;
  commercialSignals?: TwentyCommercialSignal[];
  researches?: TwentyResearch[];
  commercialHypotheses?: TwentyCommercialHypothesis[];
  agentRunSummaries?: TwentyAgentRunSummary[];
}

export interface TwentyCommercialSignal extends TwentySystemFields {
  name: string;
  description: string | null;
  signalType: SignalType;
  sourceUrl: TwentyLinks | null;
  sourceDomain: string | null;
  detectedAt: string | null;
  eventDate: string | null;
  confidence: number | null;
  status: SignalStatus;
  tenantId: string | null;
  companyId: string | null;
}

export interface TwentyResearch extends TwentySystemFields {
  name: string;
  researchType: string | null;
  query: string | null;
  summary: string | null;
  structuredResult: unknown;
  sources: string[] | null;
  confidence: number | null;
  agentExecutionId: string | null;
  tenantId: string | null;
  companyId: string | null;
  commercialSignalId: string | null;
}

export interface TwentyCommercialHypothesis extends TwentySystemFields {
  name: string;
  need: string | null;
  whyNow: string | null;
  quantityMin: number | null;
  quantityMax: number | null;
  budgetMin: TwentyCurrency | null;
  budgetMax: TwentyCurrency | null;
  recommendedProducts: string[] | null;
  timing: string | null;
  confidence: number | null;
  evidence: unknown;
  status: HypothesisStatus;
  tenantId: string | null;
  companyId: string | null;
  commercialSignalId: string | null;
  decisionMakerId: string | null;
}

export interface TwentyAgentRunSummary extends TwentySystemFields {
  name: string;
  task: string | null;
  agentName: string | null;
  agentVersion: string | null;
  outcome: RunOutcome;
  resultSummary: string | null;
  cost: TwentyCurrency | null;
  traceUrl: TwentyLinks | null;
  agentExecutionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  tenantId: string | null;
  companyId: string | null;
}

export function links(url: string, label = ''): TwentyLinks {
  return { primaryLinkUrl: url, primaryLinkLabel: label, secondaryLinks: [] };
}

export function eurToCurrency(amountEur: number): TwentyCurrency {
  return { amountMicros: Math.round(amountEur * 1_000_000), currencyCode: 'EUR' };
}

export function currencyToEur(value: TwentyCurrency | null | undefined): number | null {
  if (!value || value.amountMicros === null || value.amountMicros === undefined) return null;
  return value.amountMicros / 1_000_000;
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Normalises a domain or URL to the bare host used as the Company idempotency key:
 * lowercase, no scheme, no `www.`, no port, path, query or trailing dot.
 * Returns null if the result is not a valid hostname.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (host.length === 0) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.replace(/^[^@/]*@/, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = host.replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return DOMAIN_RE.test(host) ? host : null;
}

/** Normalised domain of a Company record (from `domainName.primaryLinkUrl`). */
export function companyDomain(company: Pick<TwentyCompany, 'domainName'>): string | null {
  return normalizeDomain(company.domainName?.primaryLinkUrl);
}
