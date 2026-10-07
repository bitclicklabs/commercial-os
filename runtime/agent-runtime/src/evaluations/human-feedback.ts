/**
 * Evaluador HUMAN `human-v1` (LLD v0.2 section 5.5, decision D14).
 *
 * Pure logic, no I/O: maps a change of a `commercialHypothesis` in Twenty (as delivered by
 * a Twenty webhook) to a human verdict:
 *
 * | Change                                                         | Feedback   | Score |
 * |----------------------------------------------------------------|------------|-------|
 * | PROPOSED -> VALIDATED without content changes                  | ACCEPTED   | 1.0   |
 * | PROPOSED -> VALIDATED after (or together with) content edits   | EDITED     | 0.5   |
 * | business fields edited while PROPOSED                          | EDITED     | 0.5   |
 * | PROPOSED|VALIDATED -> REJECTED                                 | DISCARDED  | 0.0   |
 *
 * Twenty 2.45 webhooks carry only the record AFTER the change plus the NAMES of the
 * updated fields (`updatedFields`), never the previous values. So:
 * - the previous status comes from the last verdict recorded for the subject, and is
 *   assumed PROPOSED when there is none (`from_status_source = 'assumed'`);
 * - the "before" side of a diff is the agent's original proposal (input of the
 *   `create_hypothesis` tool call in the trace) when the origin run is resolved.
 */

export const HUMAN_FEEDBACK_VALUES = ['ACCEPTED', 'EDITED', 'DISCARDED'] as const;
export type HumanFeedback = (typeof HUMAN_FEEDBACK_VALUES)[number];

export const HUMAN_EVALUATOR_ID = 'human-v1';

/** D14: ACCEPTED 1.0, EDITED 0.5, DISCARDED 0.0 (TASK_SUCCESS). */
export const HUMAN_FEEDBACK_SCORES: Record<HumanFeedback, number> = { ACCEPTED: 1, EDITED: 0.5, DISCARDED: 0 };

export function scoreOf(feedback: HumanFeedback): number {
  return HUMAN_FEEDBACK_SCORES[feedback];
}

/** `passed` of the LLD EvaluationResult: DISCARDED is the only failing verdict. */
export function passedOf(feedback: HumanFeedback): boolean {
  return feedback !== 'DISCARDED';
}

/** Business content of a hypothesis: an edit to any of these is a correction of the agent. */
export const HYPOTHESIS_BUSINESS_FIELDS = [
  'need',
  'whyNow',
  'budgetMin',
  'budgetMax',
  'quantityMin',
  'quantityMax',
  'recommendedProducts',
  'timing',
] as const;
export type HypothesisBusinessField = (typeof HYPOTHESIS_BUSINESS_FIELDS)[number];

export type FieldDiff = Partial<Record<HypothesisBusinessField, { before: unknown; after: unknown }>>;

/** Webhook body sent by Twenty 2.45 (`CallWebhookJob`, secret stripped). */
export interface TwentyWebhookPayload {
  targetUrl?: string;
  eventName: string;
  objectMetadata?: { id?: string; nameSingular?: string };
  workspaceId?: string;
  webhookId?: string;
  eventDate?: string;
  userId?: string;
  workspaceMemberId?: string;
  record: Record<string, unknown>;
  updatedFields?: string[];
}

/** Agent proposal, as passed to the `create_hypothesis` tool (budgets in EUR). */
export interface HypothesisProposal {
  need?: unknown;
  whyNow?: unknown;
  quantityMin?: unknown;
  quantityMax?: unknown;
  budgetMinEur?: unknown;
  budgetMaxEur?: unknown;
  recommendedProducts?: unknown;
  timing?: unknown;
}

/** Normalised business value: budgets as EUR numbers, empty values as null. */
export function normaliseRecordField(field: HypothesisBusinessField, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (field === 'budgetMin' || field === 'budgetMax') {
    if (typeof value === 'number') return value;
    if (typeof value === 'object') {
      const micros = (value as { amountMicros?: unknown }).amountMicros;
      if (micros === null || micros === undefined) return null;
      const n = Number(micros);
      return Number.isFinite(n) ? n / 1_000_000 : null;
    }
    return null;
  }
  if (field === 'recommendedProducts') {
    if (!Array.isArray(value)) return null;
    return value.length === 0 ? null : value;
  }
  if (typeof value === 'string') return value.trim();
  return value;
}

function proposalValue(proposal: HypothesisProposal, field: HypothesisBusinessField): unknown {
  switch (field) {
    case 'budgetMin':
      return normaliseRecordField('budgetMin', proposal.budgetMinEur);
    case 'budgetMax':
      return normaliseRecordField('budgetMax', proposal.budgetMaxEur);
    default:
      return normaliseRecordField(field, proposal[field]);
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff of the business fields. With a proposal, compares every business field against it
 * (before = what the agent proposed). Without one, lists only the fields Twenty reports as
 * updated, with `before: null` (unknown).
 */
export function diffBusinessFields(
  record: Record<string, unknown>,
  proposal: HypothesisProposal | null,
  updatedFields: readonly string[],
): { diff: FieldDiff; beforeKnown: boolean } {
  const diff: FieldDiff = {};
  if (proposal) {
    for (const field of HYPOTHESIS_BUSINESS_FIELDS) {
      const before = proposalValue(proposal, field);
      const after = normaliseRecordField(field, record[field]);
      if (!sameValue(before, after)) diff[field] = { before, after };
    }
    return { diff, beforeKnown: true };
  }
  for (const field of HYPOTHESIS_BUSINESS_FIELDS) {
    if (updatedFields.includes(field)) diff[field] = { before: null, after: normaliseRecordField(field, record[field]) };
  }
  return { diff, beforeKnown: false };
}

export interface ClassifyInput {
  eventName: string;
  record: Record<string, unknown>;
  updatedFields: readonly string[];
  /** Target status of the last verdict recorded for this subject, if any. */
  lastKnownStatus: string | null;
  /** True when an EDITED verdict was recorded while the hypothesis was PROPOSED (and not superseded). */
  editedWhileProposed: boolean;
  /** Agent's original proposal, when the origin run is resolved. */
  proposal: HypothesisProposal | null;
}

export type Classification =
  | {
      action: 'record';
      feedback: HumanFeedback;
      fromStatus: string;
      toStatus: string;
      fromStatusSource: 'last_evaluation' | 'assumed' | 'unchanged';
      diff: FieldDiff;
      diffBeforeKnown: boolean;
      updatedFields: string[];
    }
  | { action: 'ignore'; reason: string };

const HANDLED_EVENTS = new Set(['commercialHypothesis.updated', 'commercialHypothesis.upserted']);

export function classifyHypothesisChange(input: ClassifyInput): Classification {
  if (!HANDLED_EVENTS.has(input.eventName)) return { action: 'ignore', reason: `event ${input.eventName} is not a hypothesis update` };
  const toStatus = typeof input.record.status === 'string' ? input.record.status : null;
  if (!toStatus) return { action: 'ignore', reason: 'record has no status' };

  const updatedFields = [...input.updatedFields];
  const statusChanged = updatedFields.includes('status');
  const businessChanged = HYPOTHESIS_BUSINESS_FIELDS.filter((f) => updatedFields.includes(f));
  const { diff, beforeKnown } = diffBusinessFields(input.record, input.proposal, updatedFields);
  const hasEdits = beforeKnown ? Object.keys(diff).length > 0 : businessChanged.length > 0 || input.editedWhileProposed;

  const base = { toStatus, diff, diffBeforeKnown: beforeKnown, updatedFields };

  if (statusChanged) {
    // A stale or missing record of the previous status falls back to the creation status.
    const known = input.lastKnownStatus !== null && input.lastKnownStatus !== toStatus;
    const fromStatus = known ? (input.lastKnownStatus as string) : 'PROPOSED';
    const fromStatusSource = known ? 'last_evaluation' : 'assumed';
    if (fromStatus === toStatus) return { action: 'ignore', reason: `status unchanged (${toStatus})` };
    if (toStatus === 'VALIDATED') {
      if (fromStatus === 'EXPIRED') return { action: 'ignore', reason: 'EXPIRED -> VALIDATED is not a verdict on the proposal' };
      return { action: 'record', feedback: hasEdits ? 'EDITED' : 'ACCEPTED', fromStatus, fromStatusSource, ...base };
    }
    if (toStatus === 'REJECTED') {
      if (fromStatus === 'EXPIRED') return { action: 'ignore', reason: 'EXPIRED -> REJECTED is not a verdict on the proposal' };
      return { action: 'record', feedback: 'DISCARDED', fromStatus, fromStatusSource, ...base };
    }
    return { action: 'ignore', reason: `transition to ${toStatus} is not a human verdict` };
  }

  if (businessChanged.length > 0) {
    if (toStatus !== 'PROPOSED') return { action: 'ignore', reason: `content edited while ${toStatus}` };
    // Only the edited fields matter for an in-place edit; keep the full diff vs. the proposal.
    if (beforeKnown && Object.keys(diff).length === 0) return { action: 'ignore', reason: 'content back to the original proposal' };
    return { action: 'record', feedback: 'EDITED', fromStatus: toStatus, fromStatusSource: 'unchanged', ...base };
  }

  return { action: 'ignore', reason: 'no status or business field change' };
}
