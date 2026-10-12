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
  /** Standard Twenty objects. */
  person: 'people',
  note: 'notes',
  noteTarget: 'noteTargets',
  /** Standard Twenty objects used since tanda 19 (no `tenantId` field: shared by the workspace). */
  opportunity: 'opportunities',
  task: 'tasks',
  taskTarget: 'taskTargets',
} as const;

/**
 * Objects that carry a `tenantId` field (LLD C6): the five objects of the Twenty App
 * (apps/twenty-app/src/objects). The standard objects (companies, people, notes, noteTargets)
 * have no such field and are shared by every tenant of the workspace (README, limitations).
 */
export const TENANT_SCOPED_OBJECTS: ReadonlySet<string> = new Set([
  TWENTY_OBJECTS.commercialSignal,
  TWENTY_OBJECTS.research,
  TWENTY_OBJECTS.commercialHypothesis,
  TWENTY_OBJECTS.agentRunSummary,
  'agentOsDailyMetrics',
]);

export function isTenantScopedObject(objectPlural: string): boolean {
  return TENANT_SCOPED_OBJECTS.has(objectPlural);
}

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
  /**
   * Email draft fields (Twenty App, send-from-Twenty flow). Optional: they only exist once
   * the App version that declares them is synced (docs/twenty-envio-email.md).
   */
  emailTo?: string | null;
  emailSubject?: string | null;
  emailBody?: string | null;
  emailStatus?: 'DRAFT' | 'READY' | 'SENDING' | 'SENT' | null;
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

/**
 * Standard `person` (decision maker of a hypothesis; since tanda 19 also the contacts the
 * ContactFinder publishes and the senders of interested replies). Only the fields the runtime
 * reads. Twenty stores an unfilled text as '' (`jobTitle: ''`, `name.lastName: ''`). No `tenantId`.
 */
export interface TwentyPerson extends TwentySystemFields {
  name: { firstName: string | null; lastName: string | null } | null;
  jobTitle?: string | null;
  emails?: { primaryEmail: string | null; additionalEmails?: string[] | null } | null;
  companyId?: string | null;
}

/** `commercialHypothesis` read with depth 1 (relations expanded). */
export interface TwentyCommercialHypothesisExpanded extends TwentyCommercialHypothesis {
  company?: TwentyCompany | null;
  commercialSignal?: TwentyCommercialSignal | null;
  decisionMaker?: TwentyPerson | null;
}

/**
 * Standard `note` (Twenty 2.45). The body is the RICH_TEXT_V2 composite `bodyV2`
 * `{ markdown, blocknote }`: writing only `markdown` is enough, the server derives the
 * BlockNote JSON from it (`transformRichTextValue`).
 */
export interface TwentyNote extends TwentySystemFields {
  title: string | null;
  bodyV2: { markdown: string | null; blocknote: string | null } | null;
  noteTargets?: TwentyNoteTarget[];
}

/**
 * Standard `noteTarget`: join row between a note and ONE record. Each target object has
 * its own nullable join column (`targetCompanyId`, `targetPersonId`, `targetOpportunityId`
 * and, for the App objects, `targetCommercialHypothesisId`, `targetCommercialSignalId`,
 * `targetResearchId`, `targetAgentRunSummaryId`). A note on N records has N rows.
 */
export interface TwentyNoteTarget extends TwentySystemFields {
  noteId: string | null;
  targetCompanyId: string | null;
  targetPersonId?: string | null;
  targetOpportunityId?: string | null;
  targetCommercialHypothesisId?: string | null;
  targetCommercialSignalId?: string | null;
  targetResearchId?: string | null;
  targetAgentRunSummaryId?: string | null;
}

/**
 * Standard `opportunity` (Twenty 2.45, verified read-only against GET /rest/open-api/core):
 * `stage` is a SELECT whose options, in order, are NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER
 * (the runtime reads them at run time: src/crm/opportunities.ts); `amount` is CURRENCY;
 * `pointOfContactId` points to a person. No `tenantId`.
 */
export interface TwentyOpportunity extends TwentySystemFields {
  name: string | null;
  amount?: TwentyCurrency | null;
  closeDate?: string | null;
  stage: string | null;
  companyId: string | null;
  pointOfContactId: string | null;
  ownerId?: string | null;
}

/** Standard `task.status` values (Twenty 2.45, verified in GET /rest/open-api/core). */
export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Standard `task` (Twenty 2.45, verified read-only against GET /rest/open-api/core):
 * `{ title, bodyV2: { markdown, blocknote }, dueAt (DATE_TIME), status, assigneeId, position }`.
 * Like notes, it has NO `tenantId` (standard object, shared by every tenant of the workspace).
 */
export interface TwentyTask extends TwentySystemFields {
  title: string | null;
  bodyV2: { markdown: string | null; blocknote: string | null } | null;
  dueAt: string | null;
  status: TaskStatus | null;
  assigneeId?: string | null;
}

/**
 * Standard `taskTarget`: join row between a task and ONE record, one nullable column per
 * target object. Verified in the live OpenAPI: `targetCompanyId`, `targetPersonId`,
 * `targetOpportunityId` and, for the App objects, `targetCommercialSignalId`,
 * `targetCommercialHypothesisId`, `targetResearchId`, `targetAgentRunSummaryId`,
 * `targetAgentOsDailyMetricId` (custom objects are task-targetable).
 */
export interface TwentyTaskTarget extends TwentySystemFields {
  taskId: string | null;
  targetCompanyId?: string | null;
  targetPersonId?: string | null;
  targetOpportunityId?: string | null;
  targetCommercialSignalId?: string | null;
  targetCommercialHypothesisId?: string | null;
  targetResearchId?: string | null;
  targetAgentRunSummaryId?: string | null;

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
