/**
 * LOW_WRITE tools that create the Commercial OS records in Twenty.
 *
 * The App objects have no `idempotencyKey` column (README deviation #14), so each
 * tool derives a natural key (LLD v0.2 section 2.3) and looks for an existing
 * record with it before creating: a retried call returns `created: false` and the
 * existing record instead of a duplicate. Every write carries `tenantId`, and the
 * find-before-create only looks at the records of the run's tenant (a record of another
 * tenant with the same natural key is never returned as "existing").
 */
import { z } from 'zod';
import {
  HYPOTHESIS_STATUSES,
  HYPOTHESIS_TIMINGS,
  RESEARCH_TYPES,
  RUN_OUTCOMES,
  SIGNAL_STATUSES,
  SIGNAL_TYPES,
  TWENTY_OBJECTS,
  eurToCurrency,
  filterValue,
  links,
  normalizeDomain,
  type TwentyAgentRunSummary,
  type TwentyClient,
  type TwentyCommercialHypothesis,
  type TwentyCommercialSignal,
  type TwentyCompany,
  type TwentyResearch,
} from '../../integrations/twenty/index.js';
import { defineTool, type ToolContext } from '../types.js';
import { Confidence, HttpUrl, RecordId, ShortText, errorResult, truncate, withTwenty, type TwentyToolDeps } from './shared.js';

const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true });
const LongText = (max: number) => z.string().trim().min(1).max(max);

async function findFirst<T>(twenty: TwentyClient, plural: string, filter: string, ctx: Pick<ToolContext, 'tenantId' | 'signal'>): Promise<T | null> {
  const { records } = await twenty.list<T>(plural, { filter, limit: 1, tenantId: ctx.tenantId, signal: ctx.signal });
  return records[0] ?? null;
}

async function companyName(twenty: TwentyClient, companyId: string, signal: AbortSignal): Promise<string | null> {
  const company = await twenty.get<TwentyCompany>(TWENTY_OBJECTS.company, companyId, { depth: 0, signal });
  return company?.name ?? null;
}

const eq = (field: string, value: string) => `${field}[eq]:${filterValue(value)}`;

const CreatedRecord = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ created: z.boolean(), idempotencyKey: z.string(), record: z.object({ id: z.string(), ...shape }) });

// ---------------------------------------------------------------------------
// create_signal
// ---------------------------------------------------------------------------

export const CreateSignalInput = z.object({
  /** Omitted for an event-level signal (a fair without a company yet, e.g. no exhibitor list). */
  companyId: RecordId.optional(),
  title: ShortText,
  signalType: z.enum(SIGNAL_TYPES),
  description: LongText(4000).optional(),
  sourceUrl: HttpUrl,
  /** Derived from sourceUrl when omitted. */
  sourceDomain: z.string().trim().max(253).optional(),
  eventDate: IsoDate.optional(),
  detectedAt: IsoDateTime.optional(),
  confidence: Confidence,
  status: z.enum(SIGNAL_STATUSES).default('NEW'),
});

export const CreateSignalOutput = CreatedRecord({
  name: z.string(),
  signalType: z.enum(SIGNAL_TYPES),
  status: z.string(),
  companyId: z.string().nullable(),
  sourceDomain: z.string().nullable(),
  eventDate: z.string().nullable(),
});

export function createCreateSignalTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_signal',
    name: 'Create commercial signal',
    version: '1.0.0',
    description:
      'Record a commercial signal (fair, congress, hiring, expansion...) for a CRM company, or an event-level signal without company. Idempotent: the same company (or none), type, event date and source domain returns the existing signal.',
    inputSchema: CreateSignalInput,
    outputSchema: CreateSignalOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:signals:read', 'twenty:signals:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const sourceDomain = normalizeDomain(input.sourceDomain ?? input.sourceUrl);
        if (!sourceDomain) return errorResult('INVALID_INPUT', 'sourceDomain could not be derived from sourceUrl');
        const idempotencyKey = `publi:signal:create:${input.companyId ?? 'event'}:${input.signalType}:${input.eventDate ?? 'none'}:${sourceDomain}`;
        const filter = `and(${[
          input.companyId ? eq('companyId', input.companyId) : 'companyId[is]:NULL',
          eq('signalType', input.signalType),
          eq('sourceDomain', sourceDomain),
          input.eventDate ? eq('eventDate', input.eventDate) : 'eventDate[is]:NULL',
        ].join(',')})`;
        const toOutput = (s: TwentyCommercialSignal, created: boolean) => ({
          created,
          idempotencyKey,
          record: {
            id: s.id,
            name: s.name,
            signalType: s.signalType,
            status: s.status,
            companyId: s.companyId ?? null,
            sourceDomain: s.sourceDomain || null,
            eventDate: s.eventDate ?? null,
          },
        });
        const existing = await findFirst<TwentyCommercialSignal>(deps.twenty, TWENTY_OBJECTS.commercialSignal, filter, ctx);
        if (existing) return { status: 'ok', output: toOutput(existing, false) };
        const created = await deps.twenty.create<TwentyCommercialSignal>(
          TWENTY_OBJECTS.commercialSignal,
          {
            name: input.title,
            signalType: input.signalType,
            ...(input.description ? { description: input.description } : {}),
            sourceUrl: links(input.sourceUrl),
            sourceDomain,
            ...(input.eventDate ? { eventDate: input.eventDate } : {}),
            detectedAt: input.detectedAt ?? new Date().toISOString(),
            confidence: input.confidence,
            status: input.status,
            tenantId: ctx.tenantId,
            ...(input.companyId ? { companyId: input.companyId } : {}),
          },
          { signal: ctx.signal },
        );
        return { status: 'ok', output: toOutput(created, true) };
      }),
  });
}

// ---------------------------------------------------------------------------
// create_research
// ---------------------------------------------------------------------------

export const CreateResearchInput = z.object({
  companyId: RecordId,
  signalId: RecordId.optional(),
  /** Defaults to `{researchType} — {company.name}`. */
  name: ShortText.optional(),
  researchType: z.enum(RESEARCH_TYPES),
  query: LongText(2000).optional(),
  summary: LongText(20_000),
  structuredResult: z.record(z.string(), z.unknown()).optional(),
  sources: z.array(HttpUrl).min(1).max(50),
  confidence: Confidence,
});

export const CreateResearchOutput = CreatedRecord({
  name: z.string(),
  researchType: z.string().nullable(),
  companyId: z.string().nullable(),
  commercialSignalId: z.string().nullable(),
  agentExecutionId: z.string().nullable(),
});

export function createCreateResearchTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_research',
    name: 'Create research',
    version: '1.0.0',
    description:
      'Store a research result about a CRM company (summary, structured result and source URLs). A new research is a new record; one per execution, company and research type.',
    inputSchema: CreateResearchInput,
    outputSchema: CreateResearchOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:research:read', 'twenty:research:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const idempotencyKey = `publi:research:create:${ctx.executionId}:${input.companyId}:${input.researchType}`;
        const filter = `and(${[
          eq('agentExecutionId', ctx.executionId),
          eq('companyId', input.companyId),
          eq('researchType', input.researchType),
        ].join(',')})`;
        const toOutput = (r: TwentyResearch, created: boolean) => ({
          created,
          idempotencyKey,
          record: {
            id: r.id,
            name: r.name,
            researchType: r.researchType || null,
            companyId: r.companyId ?? null,
            commercialSignalId: r.commercialSignalId ?? null,
            agentExecutionId: r.agentExecutionId || null,
          },
        });
        const existing = await findFirst<TwentyResearch>(deps.twenty, TWENTY_OBJECTS.research, filter, ctx);
        if (existing) return { status: 'ok', output: toOutput(existing, false) };
        const name = input.name ?? `${input.researchType} — ${(await companyName(deps.twenty, input.companyId, ctx.signal)) ?? input.companyId}`;
        const created = await deps.twenty.create<TwentyResearch>(
          TWENTY_OBJECTS.research,
          {
            name: truncate(name, 255),
            researchType: input.researchType,
            ...(input.query ? { query: input.query } : {}),
            summary: input.summary,
            ...(input.structuredResult ? { structuredResult: input.structuredResult } : {}),
            sources: input.sources,
            confidence: input.confidence,
            agentExecutionId: ctx.executionId,
            tenantId: ctx.tenantId,
            companyId: input.companyId,
            ...(input.signalId ? { commercialSignalId: input.signalId } : {}),
          },
          { signal: ctx.signal },
        );
        return { status: 'ok', output: toOutput(created, true) };
      }),
  });
}

// ---------------------------------------------------------------------------
// create_hypothesis
// ---------------------------------------------------------------------------

export const CreateHypothesisInput = z
  .object({
    companyId: RecordId,
    signalId: RecordId.optional(),
    decisionMakerId: RecordId.optional(),
    /** Defaults to `{company.name} — {need}`, truncated to 120 characters. */
    name: ShortText.optional(),
    need: LongText(2000),
    whyNow: LongText(2000),
    quantityMin: z.number().int().nonnegative().optional(),
    quantityMax: z.number().int().nonnegative().optional(),
    budgetMinEur: z.number().nonnegative().optional(),
    budgetMaxEur: z.number().nonnegative().optional(),
    /** Catalog Service references (productId or SKU). */
    recommendedProducts: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    timing: z.enum(HYPOTHESIS_TIMINGS).default('UNKNOWN'),
    confidence: Confidence,
    evidence: z
      .array(z.object({ claim: LongText(1000), sourceUrl: HttpUrl.optional(), quote: LongText(1000).optional() }))
      .min(1)
      .max(30),
    status: z.enum(HYPOTHESIS_STATUSES).default('PROPOSED'),
  })
  .refine((v) => v.quantityMin === undefined || v.quantityMax === undefined || v.quantityMax >= v.quantityMin, {
    message: 'quantityMax must be >= quantityMin',
    path: ['quantityMax'],
  })
  .refine((v) => v.budgetMinEur === undefined || v.budgetMaxEur === undefined || v.budgetMaxEur >= v.budgetMinEur, {
    message: 'budgetMaxEur must be >= budgetMinEur',
    path: ['budgetMaxEur'],
  });

export const CreateHypothesisOutput = CreatedRecord({
  name: z.string(),
  status: z.string(),
  companyId: z.string().nullable(),
  commercialSignalId: z.string().nullable(),
});

export function createCreateHypothesisTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_hypothesis',
    name: 'Create commercial hypothesis',
    version: '1.0.0',
    description:
      'Store a commercial hypothesis (need, why now, quantities, EUR budget, recommended products, evidence) for a CRM company. Idempotent per company and hypothesis name.',
    inputSchema: CreateHypothesisInput,
    outputSchema: CreateHypothesisOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:hypotheses:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const name = truncate(
          input.name ?? `${(await companyName(deps.twenty, input.companyId, ctx.signal)) ?? input.companyId} — ${input.need}`,
          120,
        );
        const idempotencyKey = `publi:hypothesis:create:${input.companyId}:${name}`;
        const toOutput = (h: TwentyCommercialHypothesis, created: boolean) => ({
          created,
          idempotencyKey,
          record: { id: h.id, name: h.name, status: h.status, companyId: h.companyId ?? null, commercialSignalId: h.commercialSignalId ?? null },
        });
        const existing = await findFirst<TwentyCommercialHypothesis>(
          deps.twenty,
          TWENTY_OBJECTS.commercialHypothesis,
          `and(${eq('companyId', input.companyId)},${eq('name', name)})`,
          ctx,
        );
        if (existing) return { status: 'ok', output: toOutput(existing, false) };
        const created = await deps.twenty.create<TwentyCommercialHypothesis>(
          TWENTY_OBJECTS.commercialHypothesis,
          {
            name,
            need: input.need,
            whyNow: input.whyNow,
            ...(input.quantityMin !== undefined ? { quantityMin: input.quantityMin } : {}),
            ...(input.quantityMax !== undefined ? { quantityMax: input.quantityMax } : {}),
            ...(input.budgetMinEur !== undefined ? { budgetMin: eurToCurrency(input.budgetMinEur) } : {}),
            ...(input.budgetMaxEur !== undefined ? { budgetMax: eurToCurrency(input.budgetMaxEur) } : {}),
            ...(input.recommendedProducts ? { recommendedProducts: input.recommendedProducts } : {}),
            timing: input.timing,
            confidence: input.confidence,
            evidence: input.evidence,
            status: input.status,
            tenantId: ctx.tenantId,
            companyId: input.companyId,
            ...(input.signalId ? { commercialSignalId: input.signalId } : {}),
            ...(input.decisionMakerId ? { decisionMakerId: input.decisionMakerId } : {}),
          },
          { signal: ctx.signal },
        );
        return { status: 'ok', output: toOutput(created, true) };
      }),
  });
}

// ---------------------------------------------------------------------------
// create_agent_run_summary
// ---------------------------------------------------------------------------

export const CreateAgentRunSummaryInput = z.object({
  /** Defaults to `{task} · {agentName} v{agentVersion} · {YYYY-MM-DD}`. */
  name: ShortText.optional(),
  task: ShortText,
  agentName: ShortText,
  agentVersion: z.union([z.string().trim().min(1).max(40), z.number().int().nonnegative()]).transform(String),
  outcome: z.enum(RUN_OUTCOMES),
  resultSummary: LongText(4000).optional(),
  costEur: z.number().nonnegative().optional(),
  traceUrl: HttpUrl.optional(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.optional(),
  companyId: RecordId.optional(),
  /** Defaults to the current execution id. */
  agentExecutionId: z.string().trim().min(1).max(120).optional(),
});

export const CreateAgentRunSummaryOutput = CreatedRecord({
  name: z.string(),
  outcome: z.string(),
  agentExecutionId: z.string().nullable(),
  companyId: z.string().nullable(),
});

export function createCreateAgentRunSummaryTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_agent_run_summary',
    name: 'Create agent run summary',
    version: '1.0.0',
    description:
      'Publish the commercial-facing summary of an agent execution (outcome, result, cost, trace link) to the CRM. One per execution.',
    inputSchema: CreateAgentRunSummaryInput,
    outputSchema: CreateAgentRunSummaryOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:agent_runs:read', 'twenty:agent_runs:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx: ToolContext) =>
      withTwenty(deps, async () => {
        const agentExecutionId = input.agentExecutionId ?? ctx.executionId;
        const idempotencyKey = `publi:agentrun:create:${agentExecutionId}`;
        const toOutput = (r: TwentyAgentRunSummary, created: boolean) => ({
          created,
          idempotencyKey,
          record: { id: r.id, name: r.name, outcome: r.outcome, agentExecutionId: r.agentExecutionId || null, companyId: r.companyId ?? null },
        });
        const existing = await findFirst<TwentyAgentRunSummary>(
          deps.twenty,
          TWENTY_OBJECTS.agentRunSummary,
          eq('agentExecutionId', agentExecutionId),
          ctx,
        );
        if (existing) return { status: 'ok', output: toOutput(existing, false) };
        const name = input.name ?? `${input.task} · ${input.agentName} v${input.agentVersion} · ${input.startedAt.slice(0, 10)}`;
        const created = await deps.twenty.create<TwentyAgentRunSummary>(
          TWENTY_OBJECTS.agentRunSummary,
          {
            name: truncate(name, 255),
            task: input.task,
            agentName: input.agentName,
            agentVersion: input.agentVersion,
            outcome: input.outcome,
            ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
            ...(input.costEur !== undefined ? { cost: eurToCurrency(input.costEur) } : {}),
            ...(input.traceUrl ? { traceUrl: links(input.traceUrl, 'Trace') } : {}),
            agentExecutionId,
            startedAt: input.startedAt,
            ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
            tenantId: ctx.tenantId,
            ...(input.companyId ? { companyId: input.companyId } : {}),
          },
          { signal: ctx.signal },
        );
        return { status: 'ok', output: toOutput(created, true) };
      }),
  });
}
