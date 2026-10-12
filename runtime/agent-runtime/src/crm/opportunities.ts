/**
 * Native Twenty `Opportunity` records (tanda 19): the funnel (kanban by `stage`) starts being
 * used, but ONLY by promotion, never by bulk copy of hypotheses:
 *
 * - the inbound triage classifies a reply as INTERESADO (src/agents/inbox-agent.ts), or
 * - a person promotes a hypothesis by hand (`POST /opportunities/promote`, src/crm/promote.ts).
 *
 * A hypothesis without traction never becomes an Opportunity, and hypotheses do not change shape.
 *
 * Rules:
 * - Name `«<Empresa> — <feria>»` (the fair only when known), `companyId`, `pointOfContactId`
 *   (a Person, when there is one), `amount` EMPTY (no amount is ever invented).
 * - Stage = the FIRST option of the workspace's `stage` SELECT, read from Twenty at run time
 *   (`GET /rest/open-api/core`; default workspace: NEW). If it cannot be read, the default
 *   order NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER is used and the result says so.
 * - Idempotent per company: when the company already has an OPEN Opportunity (any stage that
 *   is not a closing one: CUSTOMER, WON, LOST, CLOSED...), no second one is created; the new
 *   activity (note, task) is attached to the existing one, and an empty point of contact is filled.
 *
 * Opportunity has no `tenantId` (standard object): see the README, limits.
 */
import type { PublishEventInput } from '../events/event-bus.js';
import { TWENTY_OBJECTS, filterValue, type TwentyClient, type TwentyNoteTarget, type TwentyOpportunity } from '../integrations/twenty/index.js';

/** `opportunity.stage` options of a default Twenty workspace, in order (verified read-only, tanda 19). */
export const DEFAULT_OPPORTUNITY_STAGES = ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER'] as const;

/** Stages that close an opportunity (won or lost). Everything else is open. */
const CLOSED_STAGE_RE = /^(?:CUSTOMER|WON|LOST|CLOSED.*|.*_(?:WON|LOST)|GANAD[AO].*|PERDID[AO].*|CERRAD[AO].*|DESCARTAD[AO].*)$/i;

export function isClosedStage(stage: string | null | undefined): boolean {
  return typeof stage === 'string' && CLOSED_STAGE_RE.test(stage.trim());
}

export const OPPORTUNITY_CREATED_EVENT = 'opportunity.created';
export const OPPORTUNITY_NAME_MAX = 255;
/** `reply`: the inbound triage (INTERESADO); `manual`: POST /opportunities/promote. */
export type OpportunityOrigin = 'reply' | 'manual';

/** The options of `Opportunity.stage` in an OpenAPI document of Twenty, in order; null if absent. */
export function stagesFromOpenApi(doc: unknown): string[] | null {
  const schemas = (doc as { components?: { schemas?: Record<string, unknown> } } | null)?.components?.schemas;
  const opp = schemas?.Opportunity as { properties?: { stage?: { enum?: unknown } } } | undefined;
  const values = opp?.properties?.stage?.enum;
  if (!Array.isArray(values)) return null;
  const list = values.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return list.length > 0 ? list : null;
}

export interface StageList {
  stages: string[];
  /** `twenty`: read from the workspace; `default`: it could not be read. */
  source: 'twenty' | 'default';
}

const STAGE_CACHE_MS = 10 * 60_000;
const stageCache = new WeakMap<TwentyClient, { at: number; stages: string[] }>();

/** Stage options of the workspace (cached 10 min per client). Never throws on a read failure. */
export async function readOpportunityStages(twenty: TwentyClient, signal?: AbortSignal, now: () => number = Date.now): Promise<StageList> {
  const hit = stageCache.get(twenty);
  if (hit && now() - hit.at < STAGE_CACHE_MS) return { stages: hit.stages, source: 'twenty' };
  try {
    const stages = stagesFromOpenApi(await twenty.getOpenApiCore(signal ? { signal } : {}));
    if (stages) {
      stageCache.set(twenty, { at: now(), stages });
      return { stages, source: 'twenty' };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return { stages: [...DEFAULT_OPPORTUNITY_STAGES], source: 'default' };
}

/** Name without quotes or backslashes (filter values cannot carry them), bounded. */
function clean(text: string): string {
  return text.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `«<Empresa> — <feria>»`, or just the company when the fair is not known. */
export function opportunityName(companyName: string, fair: string | null | undefined): string {
  const company = clean(companyName) || 'Empresa sin nombre';
  const f = fair ? clean(fair) : '';
  const name = f && f.toLowerCase() !== company.toLowerCase() ? `${company} — ${f}` : company;
  return name.length <= OPPORTUNITY_NAME_MAX ? name : `${name.slice(0, OPPORTUNITY_NAME_MAX - 1)}…`;
}

const NAME_SEP = ' — ';

/**
 * Fair of a hypothesis: the per-exhibitor signal is named "<feria> — <empresa>" and the
 * hypothesis "<empresa> — <feria>" (same rule as `hypothesisEventName` in
 * src/agents/signal-prospecting.ts, kept here to avoid importing the agents from the CRM layer).
 */
export function fairOfHypothesis(h: { name: string | null | undefined; signalName?: string | null }): string | null {
  if (h.signalName && h.signalName.includes(NAME_SEP)) {
    const fair = h.signalName.slice(0, h.signalName.indexOf(NAME_SEP)).trim();
    if (fair) return fair;
  }
  if (h.name && h.name.includes(NAME_SEP)) {
    const fair = h.name.slice(h.name.lastIndexOf(NAME_SEP) + NAME_SEP.length).trim();
    if (fair) return fair;
  }
  return null;
}

/** The OPEN Opportunity of a company (oldest first), or null. */
export async function findOpenOpportunity(twenty: TwentyClient, companyId: string, signal?: AbortSignal): Promise<TwentyOpportunity | null> {
  const { records } = await twenty.list<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, {
    filter: `companyId[eq]:${filterValue(companyId)}`,
    limit: 60,
    ...(signal ? { signal } : {}),
  });
  const open = records.filter((o) => o.companyId === companyId && !o.deletedAt && !isClosedStage(o.stage));
  return open.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

export interface OpportunitySummary {
  id: string;
  name: string | null;
  stage: string | null;
  companyId: string | null;
  pointOfContactId: string | null;
}

export function toOpportunitySummary(o: TwentyOpportunity): OpportunitySummary {
  return { id: o.id, name: o.name ?? null, stage: o.stage ?? null, companyId: o.companyId ?? null, pointOfContactId: o.pointOfContactId ?? null };
}

export interface UpsertOpportunityInput {
  companyId: string;
  name: string;
  pointOfContactId?: string | null;
}

export interface UpsertOpportunityResult {
  created: boolean;
  opportunity: OpportunitySummary;
  /** Fields of an existing opportunity that were empty and got filled (`pointOfContactId`). */
  filled: string[];
  stageSource: StageList['source'] | 'existing';
}

/** Creates the company's Opportunity at the first stage, or reuses its open one. */
export async function upsertOpenOpportunity(twenty: TwentyClient, input: UpsertOpportunityInput, signal?: AbortSignal): Promise<UpsertOpportunityResult> {
  const opts = signal ? { signal } : {};
  const existing = await findOpenOpportunity(twenty, input.companyId, signal);
  if (existing) {
    const filled: string[] = [];
    let current = existing;
    if (input.pointOfContactId && !existing.pointOfContactId) {
      current = { ...existing, ...(await twenty.update<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, existing.id, { pointOfContactId: input.pointOfContactId }, opts)) };
      filled.push('pointOfContactId');
    }
    return { created: false, opportunity: toOpportunitySummary(current), filled, stageSource: 'existing' };
  }
  const { stages, source } = await readOpportunityStages(twenty, signal);
  const created = await twenty.create<TwentyOpportunity>(
    TWENTY_OBJECTS.opportunity,
    {
      name: input.name,
      stage: stages[0],
      companyId: input.companyId,
      ...(input.pointOfContactId ? { pointOfContactId: input.pointOfContactId } : {}),
    },
    opts,
  );
  return { created: true, opportunity: toOpportunitySummary(created), filled: [], stageSource: source };
}

/**
 * Attaches an existing note to the opportunity (and to the person) through `noteTargets`, so the
 * activity shows in their timelines. Only the missing targets are created (idempotent).
 */
export async function linkNoteToOpportunity(
  twenty: TwentyClient,
  noteId: string,
  targets: { opportunityId: string; personId?: string | null },
  signal?: AbortSignal,
): Promise<string[]> {
  const opts = signal ? { signal } : {};
  const { records } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `noteId[eq]:${filterValue(noteId)}`, limit: 50, ...opts });
  const added: string[] = [];
  if (!records.some((t) => t.targetOpportunityId === targets.opportunityId)) {
    added.push((await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId, targetOpportunityId: targets.opportunityId }, opts)).id);
  }
  if (targets.personId && !records.some((t) => t.targetPersonId === targets.personId)) {
    added.push((await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId, targetPersonId: targets.personId }, opts)).id);
  }
  return added;
}

/**
 * `opportunity.created` (for n8n): ids only, never an address. Idempotent per opportunity.
 */
export function opportunityCreatedEvent(args: {
  tenantId: string;
  opportunity: OpportunitySummary;
  origin: OpportunityOrigin;
  hypothesisId: string | null;
  personId: string | null;
  taskId?: string | null;
  occurredAt?: Date;
}): PublishEventInput {
  return {
    tenantId: args.tenantId,
    type: OPPORTUNITY_CREATED_EVENT,
    correlationId: args.hypothesisId ?? args.opportunity.companyId ?? args.opportunity.id,
    ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
    idempotencyKey: `evt:${OPPORTUNITY_CREATED_EVENT}:${args.opportunity.id}`,
    data: {
      opportunityId: args.opportunity.id,
      name: args.opportunity.name,
      stage: args.opportunity.stage,
      companyId: args.opportunity.companyId,
      pointOfContactId: args.personId,
      hypothesisId: args.hypothesisId,
      taskId: args.taskId ?? null,
      origin: args.origin,
    },
  };
}
