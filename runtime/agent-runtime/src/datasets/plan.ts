/**
 * From a harvest to the cases of one dataset version (pure, no I/O). Rules, in order:
 *
 * 1. Labelled by a human: one case per hypothesis with a human verdict (latest verdict wins),
 *    input = the occurrence of that exhibitor in the run that wrote the hypothesis.
 *    expected = { relevant, writable, feedback, score, reference_hypothesis, edited_fields }.
 * 2. Labelled by a rule: one case per remaining entity whose input matches a public-body
 *    pattern (rules.ts): relevant = false, confidence <= 0,19, no hypothesis.
 * 3. Unlabelled: one case per remaining entity, input only (what `skill:compare` needs to
 *    compare two versions on data nobody has looked at, as EXP-001/EXP-002 did by hand).
 *
 * Per entity (folded exhibitor name), the representative occurrence is the one with the most
 * data (rich > sector > name only), then the most faithful input, then the oldest.
 * `used_by` = registry exclusions matched by ANY occurrence of the entity + the uses of the
 * entity in older versions of the dataset. Split = hash of the entity (50/25/25), forced to
 * TRAIN when `used_by` is not empty.
 */
import { dataLevel, type DataLevel } from '../skills/compare.js';
import type { CaseSource, CaseUse, DatasetSplit } from '../db/schema.js';
import { assignSplit, caseContentHash, entityKeyOf, mergeUses, useTag } from './core.js';
import { EXCLUSION_RULES, matchExclusions, type ExclusionRule } from './exclusions.js';
import { madridDate, type DecisionOccurrence, type HarvestResult, type HumanVerdict, type InputFidelity } from './harvest-prospeccion.js';
import { matchPublicBody, publicBodyExpected } from './rules.js';

export type CaseKind = 'human_verdict' | 'structural_discard' | 'unlabeled';

export interface PlannedCase {
  entityKey: string;
  kind: CaseKind;
  split: DatasetSplit;
  hashSplit: DatasetSplit;
  forcedTrain: boolean;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  expected: Record<string, unknown>;
  source: CaseSource;
  difficulty: string;
  tags: string[];
  contentHash: string;
  usedBy: CaseUse[];
}

export interface PlanSummary {
  total: number;
  entities: number;
  by_split: Record<DatasetSplit, number>;
  by_kind: Record<CaseKind, number>;
  /** Cases with an expected value (human or rule), per split. */
  labeled_by_split: Record<DatasetSplit, number>;
  burned: number;
  forced_train: number;
  by_data_level: Record<DataLevel, number>;
}

export interface PlanOptions {
  /** Salt of the split hash: the dataset NAME (not the version), so an entity keeps its split across versions. */
  salt: string;
  /** Uses of each entity in older versions of the dataset (P5 ledger carried forward). */
  priorUses?: ReadonlyMap<string, readonly CaseUse[]>;
  rules?: readonly ExclusionRule[];
}

const LEVEL_RANK: Record<DataLevel, number> = { rich: 0, sector: 1, name_only: 2 };
const FIDELITY_RANK: Record<InputFidelity, number> = { execution_input: 0, catalog_json: 1, llm_extraction: 2, name_only_fallback: 3 };
export const DIFFICULTY_BY_LEVEL: Record<DataLevel, string> = { rich: 'easy', sector: 'medium', name_only: 'hard' };
const MAX_OCCURRENCES_IN_SOURCE = 50;

function levelOf(o: DecisionOccurrence): DataLevel {
  return dataLevel(o.exhibitor);
}

function better(a: DecisionOccurrence, b: DecisionOccurrence): DecisionOccurrence {
  const la = LEVEL_RANK[levelOf(a)];
  const lb = LEVEL_RANK[levelOf(b)];
  if (la !== lb) return la < lb ? a : b;
  const fa = FIDELITY_RANK[a.fidelity];
  const fb = FIDELITY_RANK[b.fidelity];
  if (fa !== fb) return fa < fb ? a : b;
  return a.createdAt.getTime() <= b.createdAt.getTime() ? a : b;
}

function registryUses(occ: DecisionOccurrence, rules: readonly ExclusionRule[]): CaseUse[] {
  return matchExclusions({ traceId: occ.traceId, executionId: occ.executionId, position: occ.position, name: occ.exhibitor.name }, rules).map((r) => ({
    experiment: r.experiment,
    role: r.role,
    at: r.at,
    via: 'registry' as const,
    note: `${r.id} (${r.doc})`,
  }));
}

function inputOf(o: DecisionOccurrence): Record<string, unknown> {
  return { event: o.event, exhibitor: o.exhibitor };
}

function contextOf(o: DecisionOccurrence): Record<string, unknown> {
  return {
    today: madridDate(o.createdAt),
    mode: o.mode,
    agent: o.agent,
    skill_versions: o.skillVersions,
    data_level: levelOf(o),
    position: o.position,
  };
}

/** Business fields of a `create_hypothesis` input, in the Prospector decision vocabulary. */
function proposalHypothesis(p: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!p) return null;
  const pick: Record<string, unknown> = {
    need: p.need ?? null,
    why_now: p.whyNow ?? null,
    quantity_min: p.quantityMin ?? null,
    quantity_max: p.quantityMax ?? null,
    budget_min_eur: p.budgetMinEur ?? null,
    budget_max_eur: p.budgetMaxEur ?? null,
    recommended_products: p.recommendedProducts ?? null,
    timing: p.timing ?? null,
  };
  return pick;
}

const EDIT_TO_DECISION: Record<string, string> = {
  need: 'need',
  whyNow: 'why_now',
  quantityMin: 'quantity_min',
  quantityMax: 'quantity_max',
  budgetMin: 'budget_min_eur',
  budgetMax: 'budget_max_eur',
  recommendedProducts: 'recommended_products',
  timing: 'timing',
};

/** expected of a human verdict (rule 1). */
export function humanExpected(v: HumanVerdict): Record<string, unknown> {
  const proposal = proposalHypothesis(v.proposal);
  let reference: Record<string, unknown> | null = null;
  if (v.feedback !== 'DISCARDED' && proposal) {
    reference = { ...proposal };
    if (v.feedback === 'EDITED') for (const [field, d] of Object.entries(v.editedFields)) {
      const k = EDIT_TO_DECISION[field];
      if (k) reference[k] = d?.after ?? null;
    }
  }
  return {
    kind: 'human_verdict',
    feedback: v.feedback,
    score: v.score,
    // DISCARDED: the commercial rejected the proposal; the case expects no writable hypothesis.
    relevant: v.feedback !== 'DISCARDED',
    writable: v.feedback !== 'DISCARDED',
    reference_hypothesis: reference,
    edited_fields: v.feedback === 'EDITED' ? v.editedFields : {},
  };
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export function planCases(h: HarvestResult, opts: PlanOptions): { cases: PlannedCase[]; summary: PlanSummary; warnings: string[] } {
  const rules = opts.rules ?? EXCLUSION_RULES;
  const warnings: string[] = [];
  const byEntity = new Map<string, DecisionOccurrence[]>();
  for (const o of h.occurrences) {
    const k = entityKeyOf(o.exhibitor.name);
    const list = byEntity.get(k) ?? [];
    list.push(o);
    byEntity.set(k, list);
  }
  const usesOf = new Map<string, CaseUse[]>();
  for (const [k, occs] of byEntity) {
    usesOf.set(k, mergeUses(...occs.map((o) => registryUses(o, rules)), opts.priorUses?.get(k) ?? []));
  }
  const entityUses = (k: string, extra?: DecisionOccurrence) =>
    usesOf.get(k) ?? mergeUses(extra ? registryUses(extra, rules) : [], opts.priorUses?.get(k) ?? []);

  const cases: PlannedCase[] = [];
  const hashes = new Set<string>();
  const push = (c: Omit<PlannedCase, 'split' | 'hashSplit' | 'forcedTrain' | 'contentHash' | 'tags'> & { tags: string[] }) => {
    const contentHash = caseContentHash(c.input, c.expected);
    if (hashes.has(contentHash)) return;
    hashes.add(contentHash);
    const s = assignSplit(opts.salt, c.entityKey, c.usedBy);
    const tags = [...new Set([...c.tags, ...c.usedBy.map(useTag), ...(c.usedBy.length > 0 ? ['burned'] : [])])].sort();
    cases.push({ ...c, split: s.split, hashSplit: s.hashSplit, forcedTrain: s.forcedTrain, contentHash, tags });
  };
  const occurrencesSource = (k: string) => {
    const occs = byEntity.get(k) ?? [];
    return {
      occurrence_count: occs.length,
      occurrences: occs.slice(0, MAX_OCCURRENCES_IN_SOURCE).map((o) => ({ trace_id: o.traceId, execution_id: o.executionId, position: o.position })),
    };
  };
  const baseTags = (o: DecisionOccurrence, kind: CaseKind) => [`kind:${kind}`, `data:${levelOf(o)}`, `mode:${o.mode}`, `fidelity:${o.fidelity}`];

  // 1. Human verdicts.
  const labelled = new Set<string>();
  for (const v of h.verdicts) {
    const name = v.exhibitorName;
    const occ = name ? h.occurrences.find((o) => o.traceId === v.traceId && entityKeyOf(o.exhibitor.name) === entityKeyOf(name)) : undefined;
    if (!name || !occ) {
      warnings.push(`human verdict ${v.evaluationId} (hypothesis ${v.hypothesisId}): no decision of "${name ?? '?'}" in trace ${v.traceId ?? '?'}; skipped`);
      continue;
    }
    const k = entityKeyOf(occ.exhibitor.name);
    labelled.add(k);
    const level = levelOf(occ);
    push({
      entityKey: k,
      kind: 'human_verdict',
      input: inputOf(occ),
      context: contextOf(occ),
      expected: humanExpected(v),
      source: {
        origin: 'harvested',
        expected_source: 'human',
        trace_id: occ.traceId,
        execution_id: occ.executionId,
        evaluation_id: v.evaluationId,
        evaluation_ids: v.evaluationIds,
        hypothesis_id: v.hypothesisId,
        evaluated_at: v.occurredAt.toISOString(),
        step_id: occ.stepId,
        sequence: occ.sequence,
        position: occ.position,
        input_fidelity: occ.fidelity,
        ...occurrencesSource(k),
      },
      difficulty: DIFFICULTY_BY_LEVEL[level],
      tags: [...baseTags(occ, 'human_verdict'), `feedback:${v.feedback.toLowerCase()}`],
      usedBy: entityUses(k, occ),
    });
    if (matchPublicBody(occ.exhibitor)) warnings.push(`"${occ.exhibitor.name}": human verdict ${v.feedback} on an entity that matches the public-body rule (the human verdict wins)`);
  }

  // 2 and 3. One case per remaining entity.
  for (const [k, occs] of byEntity) {
    if (labelled.has(k)) continue;
    const rep = occs.reduce(better);
    const level = levelOf(rep);
    const match = matchPublicBody(rep.exhibitor);
    const kind: CaseKind = match ? 'structural_discard' : 'unlabeled';
    push({
      entityKey: k,
      kind,
      input: inputOf(rep),
      context: contextOf(rep),
      expected: match ? publicBodyExpected(match) : { kind: 'unlabeled' },
      source: {
        origin: 'harvested',
        expected_source: match ? 'rule' : 'none',
        trace_id: rep.traceId,
        execution_id: rep.executionId,
        step_id: rep.stepId,
        sequence: rep.sequence,
        position: rep.position,
        input_fidelity: rep.fidelity,
        ...(match ? { rule_match: match } : {}),
        ...occurrencesSource(k),
      },
      difficulty: DIFFICULTY_BY_LEVEL[level],
      tags: [...baseTags(rep, kind), ...(match ? [`rule:${match.rule}`, `rule:${match.rule}:${match.pattern}`] : [])],
      usedBy: entityUses(k),
    });
  }

  cases.sort((a, b) => a.entityKey.localeCompare(b.entityKey) || a.kind.localeCompare(b.kind) || a.contentHash.localeCompare(b.contentHash));
  return { cases, summary: summarise(cases), warnings };
}

export function summarise(cases: readonly PlannedCase[]): PlanSummary {
  const splits = ['TRAIN', 'VALIDATION', 'TEST'] as const;
  const s: PlanSummary = {
    total: cases.length,
    entities: new Set(cases.map((c) => c.entityKey)).size,
    by_split: emptyCounts(splits),
    by_kind: emptyCounts(['human_verdict', 'structural_discard', 'unlabeled'] as const),
    labeled_by_split: emptyCounts(splits),
    burned: 0,
    forced_train: 0,
    by_data_level: emptyCounts(['rich', 'sector', 'name_only'] as const),
  };
  for (const c of cases) {
    s.by_split[c.split] += 1;
    s.by_kind[c.kind] += 1;
    if (c.kind !== 'unlabeled') s.labeled_by_split[c.split] += 1;
    if (c.usedBy.length > 0) s.burned += 1;
    if (c.forcedTrain) s.forced_train += 1;
    s.by_data_level[(c.context.data_level as DataLevel) ?? 'name_only'] += 1;
  }
  return s;
}
