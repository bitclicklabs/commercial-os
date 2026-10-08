/**
 * From what one experiment phase produced (the skill:compare reports of its fixtures and the
 * evaluation pipeline over them) to the metrics the Release Gate reads, per version. Pure.
 */
import type { CompositeResult, EvaluatorAggregate } from '../evaluators/composite.js';
import type { PipelineReport } from '../evaluators/pipeline.js';
import type { CaseDecision, ComparisonReport } from '../skills/compare.js';
import type { AccuracyMetric, GateVersionMetrics, RuleMetric } from './gate.js';

/** One fixture of a phase: the skill:compare input plus the dataset case behind each exhibitor. */
export interface PhaseFixture {
  name: string;
  input: { event: Record<string, unknown>; exhibitors: Array<Record<string, unknown>> };
  case_ids: string[];
}

export interface PhaseOutcome {
  fixtures: PhaseFixture[];
  /** Same order as `fixtures` (a fixture the budget did not reach has no report). */
  reports: ComparisonReport[];
  pipeline: PipelineReport;
  /** expected of every case of the phase, by case id. */
  expected: ReadonlyMap<string, Record<string, unknown>>;
  /** Cases whose label counts for accuracy (VALIDATION / TEST, not the TRAIN form sample). */
  accuracyCaseIds: ReadonlySet<string>;
  executorBudgetExceeded: boolean;
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * The only `expected.kind` values that are labels for the Release Gate accuracy: a human verdict
 * and a declared rule of the skill. An allow-list on purpose: any other kind (`unlabeled`, the
 * `synthetic` ground truth of src/synthetic/, or one added later) is never a label unless it is
 * added here deliberately. Synthetic cases feed the rules, the seesaw and the form comparison
 * (`synth.*` evaluators), never the accuracy (decision of the PM, MVP-4).
 */
export const ACCURACY_LABEL_KINDS: readonly string[] = ['human_verdict', 'structural_discard'];

export function isLabeled(expected: Record<string, unknown> | undefined): boolean {
  return !!expected && typeof expected.kind === 'string' && ACCURACY_LABEL_KINDS.includes(expected.kind);
}

/**
 * A decision is correct for a labelled case when it matches every field the label fixes:
 * `relevant`, `writable` and, for a structural discard, `confidence <= confidence_max`.
 * A decision without confidence (model error) is never correct.
 */
export function decisionMatches(expected: Record<string, unknown>, d: Pick<CaseDecision, 'relevant' | 'writable' | 'confidence'>): boolean {
  if (d.confidence === null || d.relevant === null) return false;
  if (typeof expected.relevant === 'boolean' && d.relevant !== expected.relevant) return false;
  if (typeof expected.writable === 'boolean' && d.writable !== expected.writable) return false;
  if (typeof expected.confidence_max === 'number' && d.confidence > expected.confidence_max) return false;
  return true;
}

export function accuracyOf(version: number, outcome: Pick<PhaseOutcome, 'fixtures' | 'reports' | 'expected' | 'accuracyCaseIds'>): AccuracyMetric {
  const labeledIds = new Set([...outcome.accuracyCaseIds].filter((id) => isLabeled(outcome.expected.get(id))));
  const acc: AccuracyMetric = { labeled_cases: labeledIds.size, decisions: 0, correct: 0, value: null, mismatches: [] };
  outcome.reports.forEach((report, fi) => {
    const fixture = outcome.fixtures[fi];
    if (!fixture) return;
    for (const run of report.runs.filter((r) => r.version === version)) {
      run.decisions.forEach((d, i) => {
        const caseId = fixture.case_ids[i];
        if (!caseId || !labeledIds.has(caseId)) return;
        const expected = outcome.expected.get(caseId)!;
        acc.decisions++;
        if (decisionMatches(expected, d)) acc.correct++;
        else acc.mismatches.push({ case_id: caseId, exhibitor: d.exhibitor, repetition: run.repetition, expected: pickExpected(expected), got: { relevant: d.relevant, writable: d.writable, confidence: d.confidence } });
      });
    }
  });
  acc.value = acc.decisions > 0 ? round(acc.correct / acc.decisions, 4) : null;
  return acc;
}

/**
 * What one version decided on one dataset case in one repetition: the part of a decision the
 * accuracy reads. The runner stores them in `metrics.phases.<PHASE>.case_outputs` so a
 * PASS_FORM experiment can be re-validated later against fresh labels without running any
 * model again (src/experiments/revalidation.ts).
 */
export interface CaseOutput {
  case_id: string;
  version: number;
  repetition: number;
  relevant: boolean | null;
  writable: boolean;
  confidence: number | null;
  status: string;
}

/** Per-case outputs of a phase: fixture `case_ids[i]` is the case behind decision `i` of every run. */
export function caseOutputsOf(outcome: { fixtures: ReadonlyArray<Pick<PhaseFixture, 'case_ids'>>; reports: ReadonlyArray<Pick<ComparisonReport, 'runs'>> }): CaseOutput[] {
  const out: CaseOutput[] = [];
  outcome.reports.forEach((report, fi) => {
    const fixture = outcome.fixtures[fi];
    if (!fixture) return;
    for (const run of report.runs) {
      run.decisions.forEach((d, i) => {
        const caseId = fixture.case_ids[i];
        if (!caseId) return;
        out.push({ case_id: caseId, version: run.version, repetition: run.repetition, relevant: d.relevant, writable: d.writable, confidence: d.confidence, status: String(d.status) });
      });
    }
  });
  return out;
}

export function pickExpected(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: e.kind };
  for (const k of ['relevant', 'writable', 'confidence_max', 'feedback']) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

const ruleOf = (a: EvaluatorAggregate): RuleMetric => ({ key: a.key, dimension: a.dimension, hard: a.hard, score: a.score, applicable: a.applicable, failures: a.failures, failed_cases: a.failedCases });

export interface VersionPhaseMetrics extends GateVersionMetrics {
  composite_verdict: CompositeResult['verdict'] | null;
  dimensions: Record<string, number>;
  missing_dimensions: string[];
  /** LLM_JUDGE aggregates (informative; the composite already includes them). */
  judges: RuleMetric[];
  relevant: number;
  writable: number;
  confidence_mean: number | null;
  irrelevant_high_confidence: number;
  input_tokens: number;
  output_tokens: number;
}

export function versionPhaseMetrics(version: number, outcome: PhaseOutcome): VersionPhaseMetrics {
  const group = outcome.pipeline.groups.find((g) => g.group === `v${version}`);
  const ms = outcome.reports.map((r) => r.metrics.find((m) => m.version === version)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const decisions = ms.reduce((n, m) => n + m.decisions, 0);
  const cost = round(ms.reduce((n, m) => n + m.cost_eur, 0));
  const confs = outcome.reports.flatMap((r) => r.runs.filter((x) => x.version === version).flatMap((x) => x.decisions.map((d) => d.confidence))).filter((c): c is number => c !== null);
  const composite = group?.composite;
  return {
    version,
    composite: composite?.score ?? null,
    composite_verdict: composite?.verdict ?? null,
    hard_failures: composite?.hard_failures.map((h) => ({ evaluator: h.evaluator, dimension: h.dimension, cases: h.cases })) ?? [],
    threshold_failures: composite?.threshold_failures.map((t) => ({ dimension: t.dimension, score: t.score, threshold: t.threshold })) ?? [],
    dimensions: Object.fromEntries(Object.entries(composite?.dimensions ?? {}).map(([d, v]) => [d, v!.score])),
    missing_dimensions: composite?.missing ?? [],
    rules: (group?.aggregates ?? []).filter((a) => a.type === 'RULE' || a.type === 'EXACT').map(ruleOf),
    judges: (group?.aggregates ?? []).filter((a) => a.type === 'LLM_JUDGE').map(ruleOf),
    decisions,
    errors: ms.reduce((n, m) => n + m.errors, 0),
    relevant: ms.reduce((n, m) => n + m.relevant, 0),
    writable: ms.reduce((n, m) => n + m.writable, 0),
    confidence_mean: confs.length ? round(confs.reduce((a, b) => a + b, 0) / confs.length, 4) : null,
    irrelevant_high_confidence: ms.reduce((n, m) => n + m.irrelevant_high_confidence, 0),
    input_tokens: ms.reduce((n, m) => n + m.input_tokens, 0),
    output_tokens: ms.reduce((n, m) => n + m.output_tokens, 0),
    cost_eur: cost,
    cost_eur_per_decision: decisions > 0 ? round(cost / decisions) : null,
    accuracy: accuracyOf(version, outcome),
  };
}

/** Why a phase measurement is not complete enough to decide (empty = complete). */
export function phaseIncomplete(outcome: PhaseOutcome, versions: readonly number[]): string[] {
  const out: string[] = [];
  if (outcome.executorBudgetExceeded) out.push('presupuesto del ejecutor agotado: hay decisiones sin ejecutar');
  if (outcome.reports.length < outcome.fixtures.length) out.push(`${outcome.fixtures.length - outcome.reports.length} fixture(s) sin ejecutar`);
  const runsPer = (v: number) => outcome.reports.reduce((n, r) => n + r.runs.filter((x) => x.version === v).length, 0);
  if (versions.length === 2 && runsPer(versions[0]!) !== runsPer(versions[1]!)) out.push('las dos versiones no tienen el mismo número de ejecuciones');
  // A judge that scored one version and not the other makes the composites incomparable.
  for (const w of outcome.pipeline.warnings) if (/no son comparables/.test(w)) out.push(w);
  return out;
}
