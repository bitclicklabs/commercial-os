/**
 * get_hypothesis (READ): one `commercialHypothesis` with its company, commercial signal and
 * decision maker (Twenty REST with depth 1, a single request). A hypothesis of another tenant
 * is an error (`TWENTY_TENANT_MISMATCH`); a linked signal of another tenant is left out.
 */
import { z } from 'zod';
import {
  TWENTY_OBJECTS,
  currencyToEur,
  type TwentyCommercialHypothesis,
  type TwentyClient,
  type TwentyCommercialHypothesisExpanded,
  type TwentyPerson,
} from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { CompanySummary, RecordId, toCompanySummary, withTwenty, type TwentyToolDeps } from './shared.js';

export const GetHypothesisInput = z.object({ hypothesisId: RecordId });

const EvidenceItem = z.object({ claim: z.string(), sourceUrl: z.string().nullable() });

export const HypothesisDetail = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  need: z.string().nullable(),
  whyNow: z.string().nullable(),
  quantityMin: z.number().nullable(),
  quantityMax: z.number().nullable(),
  budgetMinEur: z.number().nullable(),
  budgetMaxEur: z.number().nullable(),
  recommendedProducts: z.array(z.string()),
  timing: z.string().nullable(),
  confidence: z.number().nullable(),
  evidence: z.array(EvidenceItem),
  companyId: z.string().nullable(),
  commercialSignalId: z.string().nullable(),
  decisionMakerId: z.string().nullable(),
  updatedAt: z.string(),
});
export type HypothesisDetail = z.infer<typeof HypothesisDetail>;

export const SignalDetail = z.object({
  id: z.string(),
  name: z.string(),
  signalType: z.string(),
  description: z.string().nullable(),
  eventDate: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceDomain: z.string().nullable(),
});
export type SignalDetail = z.infer<typeof SignalDetail>;

export const DecisionMakerDetail = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
});
export type DecisionMakerDetail = z.infer<typeof DecisionMakerDetail>;

export const GetHypothesisOutput = z.object({
  found: z.boolean(),
  hypothesis: HypothesisDetail.nullable(),
  company: CompanySummary.nullable(),
  signal: SignalDetail.nullable(),
  decisionMaker: DecisionMakerDetail.nullable(),
});
export type GetHypothesisOutput = z.infer<typeof GetHypothesisOutput>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function evidenceOf(raw: unknown): Array<z.infer<typeof EvidenceItem>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { claim: unknown; sourceUrl?: unknown } => !!e && typeof e === 'object' && 'claim' in e)
    .map((e) => ({ claim: String(e.claim), sourceUrl: text(e.sourceUrl) }))
    .slice(0, 30);
}

function personOf(p: TwentyPerson | null | undefined): DecisionMakerDetail | null {
  if (!p) return null;
  return {
    id: p.id,
    firstName: text(p.name?.firstName),
    lastName: text(p.name?.lastName),
    jobTitle: text(p.jobTitle),
    email: text(p.emails?.primaryEmail),
  };
}

export function createGetHypothesisTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'get_hypothesis',
    name: 'Get commercial hypothesis',
    version: '1.0.0',
    description:
      'Fetch a commercial hypothesis by id with its company, its commercial signal (the event) and its decision maker, if any.',
    inputSchema: GetHypothesisInput,
    outputSchema: GetHypothesisOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:companies:read', 'twenty:signals:read', 'twenty:people:read'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const h = await deps.twenty.get<TwentyCommercialHypothesisExpanded>(TWENTY_OBJECTS.commercialHypothesis, input.hypothesisId, {
          depth: 1,
          tenantId: ctx.tenantId,
          signal: ctx.signal,
        });
        if (!h) return { status: 'ok', output: { found: false, hypothesis: null, company: null, signal: null, decisionMaker: null } };
        const linked = h.commercialSignal ?? null;
        const s = linked && deps.twenty.belongsTo(linked, ctx.tenantId) ? linked : null;
        return {
          status: 'ok',
          output: {
            found: true,
            hypothesis: {
              id: h.id,
              name: h.name,
              status: h.status,
              need: text(h.need),
              whyNow: text(h.whyNow),
              quantityMin: num(h.quantityMin),
              quantityMax: num(h.quantityMax),
              budgetMinEur: currencyToEur(h.budgetMin),
              budgetMaxEur: currencyToEur(h.budgetMax),
              recommendedProducts: Array.isArray(h.recommendedProducts) ? h.recommendedProducts.map(String) : [],
              timing: text(h.timing),
              confidence: num(h.confidence),
              evidence: evidenceOf(h.evidence),
              companyId: h.companyId ?? null,
              commercialSignalId: h.commercialSignalId ?? null,
              decisionMakerId: h.decisionMakerId ?? null,
              updatedAt: h.updatedAt,
            },
            company: h.company ? toCompanySummary(h.company) : null,
            signal: s
              ? {
                  id: s.id,
                  name: s.name,
                  signalType: s.signalType,
                  description: text(s.description),
                  eventDate: s.eventDate ?? null,
                  sourceUrl: text(s.sourceUrl?.primaryLinkUrl),
                  sourceDomain: text(s.sourceDomain),
                }
              : null,
            decisionMaker: personOf(h.decisionMaker),
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// set_hypothesis_draft (LOW_WRITE)
// ---------------------------------------------------------------------------

/**
 * Statuses of the email draft that belong to a person: the draft was reviewed (READY), is
 * going out (SENDING) or went out (SENT). The runtime never overwrites them.
 */
export const HUMAN_OWNED_DRAFT_STATUSES = ['READY', 'SENDING', 'SENT'] as const;

export const SetHypothesisDraftInput = z.object({
  hypothesisId: RecordId,
  /** Recipient(s), comma separated; '' when the CRM has no address (the person adds it). */
  to: z.string().trim().max(500),
  subject: z.string().trim().min(1).max(255),
  /** Plain text, final body (signature and unsubscribe line already added by code). */
  body: z.string().trim().min(1).max(20_000),
});

export const SetHypothesisDraftOutput = z.object({
  written: z.boolean(),
  /** Why nothing was written: a person owns the draft, or a draft is already there. */
  reason: z.enum(['written', 'human_owned', 'draft_exists', 'not_found']),
  emailStatus: z.string().nullable(),
});

/**
 * Writes the email draft into the hypothesis fields `emailTo`, `emailSubject`, `emailBody`
 * and sets `emailStatus = DRAFT`, so a person can review it, edit it in place and send it
 * from Twenty with the manual workflow "Commercial OS · Enviar borrador de email".
 *
 * This tool sends nothing and cannot send: it only PATCHes four fields. It writes only when
 * there is no draft yet (`emailStatus` empty): a DRAFT already there may carry edits of the
 * commercial, and READY / SENDING / SENT belong to a person. A redelivered event therefore
 * changes nothing (same rule as the idempotent `create_note`).
 */
export function createSetHypothesisDraftTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'set_hypothesis_draft',
    name: 'Set hypothesis draft fields',
    version: '1.0.0',
    description:
      'Store the first-contact draft (recipient, subject, plain-text body) in the draft fields of a commercial hypothesis, with draft status DRAFT, only if the hypothesis has no draft yet. Never sends anything: a person reviews and sends it from the CRM.',
    inputSchema: SetHypothesisDraftInput,
    outputSchema: SetHypothesisDraftOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:hypotheses:write'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        // With tenantId: a hypothesis of another tenant throws TWENTY_TENANT_MISMATCH here, before any PATCH.
        const h = await deps.twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, input.hypothesisId, {
          depth: 0,
          tenantId: ctx.tenantId,
          signal: ctx.signal,
        });
        if (!h) return { status: 'ok', output: { written: false, reason: 'not_found', emailStatus: null } };
        const current = typeof h.emailStatus === 'string' && h.emailStatus.length > 0 ? h.emailStatus : null;
        if (current && (HUMAN_OWNED_DRAFT_STATUSES as readonly string[]).includes(current)) {
          return { status: 'ok', output: { written: false, reason: 'human_owned', emailStatus: current } };
        }
        if (current === 'DRAFT') return { status: 'ok', output: { written: false, reason: 'draft_exists', emailStatus: current } };
        await deps.twenty.update(
          TWENTY_OBJECTS.commercialHypothesis,
          input.hypothesisId,
          { emailTo: input.to, emailSubject: input.subject, emailBody: input.body, emailStatus: 'DRAFT' },
          { signal: ctx.signal },
        );
        ctx.logger.info('hypothesis draft fields written', { hypothesisId: input.hypothesisId });
        return { status: 'ok', output: { written: true, reason: 'written', emailStatus: 'DRAFT' } };
      }),
  });
}

// ---------------------------------------------------------------------------
// revert_hypothesis_draft_status (LOW_WRITE)
// ---------------------------------------------------------------------------

export const RevertHypothesisDraftStatusInput = z.object({
  hypothesisId: RecordId,
  /** Only reverts when the draft is still in this status (compare-and-set). */
  expectedStatus: z.enum(['READY']).default('READY'),
});

export const RevertHypothesisDraftStatusOutput = z.object({
  reverted: z.boolean(),
  reason: z.enum(['reverted', 'status_changed', 'not_found']),
  /** emailStatus read just before the write (or the current one when nothing was written). */
  previousStatus: z.string().nullable(),
});
export type RevertHypothesisDraftStatusResult = z.infer<typeof RevertHypothesisDraftStatusOutput>;

/**
 * Puts `emailStatus` back to DRAFT if it is still `expectedStatus` (READY). Surgical: the
 * PATCH carries ONLY `emailStatus`; recipient, subject and body stay as the person left
 * them. Re-reads the record right before writing, so a draft that already moved on
 * (SENDING / SENT: the send workflow won the race, or a person changed it) is not touched.
 * Twenty has no conditional update, so a change between the read and the PATCH is still
 * possible; the window is one REST round trip.
 *
 * With `tenantId` (the tool), a hypothesis of another tenant is refused before the PATCH. The
 * email-ops READY guard calls it WITHOUT tenant on purpose: it protects the workspace mailbox,
 * shared by every tenant, and can only make a send less likely.
 */
export async function revertHypothesisDraftStatus(
  twenty: TwentyClient,
  hypothesisId: string,
  opts: { expectedStatus?: 'READY'; signal?: AbortSignal; tenantId?: string } = {},
): Promise<RevertHypothesisDraftStatusResult> {
  const expected = opts.expectedStatus ?? 'READY';
  const h = await twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, hypothesisId, {
    depth: 0,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
  });
  if (!h) return { reverted: false, reason: 'not_found', previousStatus: null };
  const current = typeof h.emailStatus === 'string' && h.emailStatus.length > 0 ? h.emailStatus : null;
  if (current !== expected) return { reverted: false, reason: 'status_changed', previousStatus: current };
  await twenty.update(TWENTY_OBJECTS.commercialHypothesis, hypothesisId, { emailStatus: 'DRAFT' }, opts.signal ? { signal: opts.signal } : {});
  return { reverted: true, reason: 'reverted', previousStatus: current };
}

/**
 * revert_hypothesis_draft_status (LOW_WRITE): the email-ops guard of the send-from-Twenty
 * flow. Returns a reviewed draft (READY) to DRAFT so the manual send workflow stops at its
 * filter. It can only make sending LESS likely: it never sets READY, SENDING or SENT and
 * never touches the draft text.
 */
export function createRevertHypothesisDraftStatusTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'revert_hypothesis_draft_status',
    name: 'Revert hypothesis draft status',
    version: '1.0.0',
    description:
      'Set the draft status of a commercial hypothesis back from READY to DRAFT (only that field, only if it is still READY), so the draft cannot be sent until a person reviews it again.',
    inputSchema: RevertHypothesisDraftStatusInput,
    outputSchema: RevertHypothesisDraftStatusOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:hypotheses:write'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const out = await revertHypothesisDraftStatus(deps.twenty, input.hypothesisId, { expectedStatus: input.expectedStatus, signal: ctx.signal, tenantId: ctx.tenantId });
        if (out.reverted) ctx.logger.info('hypothesis draft status reverted to DRAFT', { hypothesisId: input.hypothesisId });
        return { status: 'ok', output: out };
      }),
  });
}
