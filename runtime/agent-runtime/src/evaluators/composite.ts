/**
 * COMPOSITE evaluator (LLD v0.1 §11.3): "nunca un único score ciego".
 *
 *   commercial_score = 0.30 task_success + 0.20 factuality + 0.15 source_quality
 *                    + 0.15 crm_correctness + 0.10 commercial_relevance + 0.10 next_action_quality
 *
 * - Dimension score = mean of the scores of the evaluators of that dimension (each
 *   evaluator's score = mean over its applicable cases).
 * - A dimension nobody evaluated is NOT scored as 0 or 1: its weight is redistributed
 *   proportionally among the evaluated ones, and the result lists it in `missing`.
 * - HARD constraints, independent of the score:
 *   - an evaluator marked `hard` that fails on ANY case -> FAIL;
 *   - a dimension threshold (LLD: CRM_CORRECTNESS < 0.95, POLICY_COMPLIANCE < 1.00) that
 *     is not reached -> FAIL. A threshold whose dimension was not evaluated does not apply
 *     (it is reported as not evaluated, never as passed).
 * - Optional `minScore`: below it the composite is FAIL too (null by default: the LLD sets
 *   the bar in the Release Gate, against the baseline, not as an absolute number).
 */
import type { Dimension, EvaluatorMeta, EvaluatorType } from './types.js';

export const LLD_DEFAULT_WEIGHTS: Readonly<Partial<Record<Dimension, number>>> = {
  TASK_SUCCESS: 0.3,
  FACTUALITY: 0.2,
  SOURCE_QUALITY: 0.15,
  CRM_CORRECTNESS: 0.15,
  COMMERCIAL_RELEVANCE: 0.1,
  NEXT_ACTION_QUALITY: 0.1,
};

export const LLD_DIMENSION_THRESHOLDS: Readonly<Partial<Record<Dimension, number>>> = {
  CRM_CORRECTNESS: 0.95,
  POLICY_COMPLIANCE: 1,
};

export interface CompositeConfig {
  weights: Partial<Record<Dimension, number>>;
  thresholds: Partial<Record<Dimension, number>>;
  minScore: number | null;
}

/** One evaluator aggregated over the cases of a subject. */
export interface EvaluatorAggregate {
  key: string;
  type: EvaluatorType;
  dimension: Dimension;
  hard: boolean;
  /** Mean score over applicable cases; null when no case applied. */
  score: number | null;
  applicable: number;
  failures: number;
  failedCases: string[];
  errors: number;
}

export interface CompositeResult {
  score: number | null;
  passed: boolean;
  verdict: 'PASS' | 'FAIL';
  hard_failures: Array<{ evaluator: string; dimension: Dimension; cases: string[] }>;
  threshold_failures: Array<{ dimension: Dimension; score: number; threshold: number }>;
  thresholds_not_evaluated: Dimension[];
  below_min_score: boolean;
  dimensions: Partial<Record<Dimension, { score: number; weight: number; effective_weight: number; evaluators: string[] }>>;
  /** Dimensions with weight > 0 that no evaluator scored (weight redistributed). */
  missing: Dimension[];
  /** Dimensions scored but without weight in the formula (informative). */
  unweighted: Dimension[];
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export class CompositeEvaluator implements EvaluatorMeta {
  readonly id = 'composite.commercial_score';
  readonly type = 'COMPOSITE' as const;
  readonly dimension = null;
  readonly hard = false;
  readonly version: number;
  readonly description = 'Score comercial compuesto del LLD §11.3 con restricciones duras (evaluadores hard y umbrales por dimensión).';
  readonly config: CompositeConfig;
  readonly definition: Record<string, unknown>;

  constructor(config: Partial<CompositeConfig> = {}, version = 1) {
    this.version = version;
    this.config = {
      weights: { ...(config.weights ?? LLD_DEFAULT_WEIGHTS) },
      thresholds: { ...(config.thresholds ?? LLD_DIMENSION_THRESHOLDS) },
      minScore: config.minScore ?? null,
    };
    for (const [d, w] of Object.entries(this.config.weights)) if (!(w >= 0)) throw new Error(`peso no válido para ${d}: ${w}`);
    this.definition = { ...this.config, redistribute_missing: 'proportional', hard: 'any failing case of a hard evaluator' };
  }

  combine(aggregates: EvaluatorAggregate[]): CompositeResult {
    const byDim = new Map<Dimension, EvaluatorAggregate[]>();
    for (const a of aggregates) {
      if (a.score === null) continue;
      byDim.set(a.dimension, [...(byDim.get(a.dimension) ?? []), a]);
    }
    const dimScore = new Map<Dimension, number>();
    for (const [d, list] of byDim) dimScore.set(d, list.reduce((n, a) => n + a.score!, 0) / list.length);

    const weights = this.config.weights;
    const weighted = [...dimScore.keys()].filter((d) => (weights[d] ?? 0) > 0);
    const totalWeight = weighted.reduce((n, d) => n + weights[d]!, 0);
    const dimensions: CompositeResult['dimensions'] = {};
    for (const [d, s] of dimScore) {
      const w = weights[d] ?? 0;
      dimensions[d] = { score: round(s), weight: w, effective_weight: totalWeight > 0 && w > 0 ? round(w / totalWeight) : 0, evaluators: byDim.get(d)!.map((a) => a.key) };
    }
    const score = totalWeight > 0 ? round(weighted.reduce((n, d) => n + weights[d]! * dimScore.get(d)!, 0) / totalWeight) : null;

    const hard_failures = aggregates.filter((a) => a.hard && a.failures > 0).map((a) => ({ evaluator: a.key, dimension: a.dimension, cases: a.failedCases }));
    const threshold_failures: CompositeResult['threshold_failures'] = [];
    const thresholds_not_evaluated: Dimension[] = [];
    for (const [d, t] of Object.entries(this.config.thresholds) as Array<[Dimension, number]>) {
      const s = dimScore.get(d);
      if (s === undefined) thresholds_not_evaluated.push(d);
      else if (s < t) threshold_failures.push({ dimension: d, score: round(s), threshold: t });
    }
    const below_min_score = this.config.minScore !== null && (score === null || score < this.config.minScore);
    const passed = hard_failures.length === 0 && threshold_failures.length === 0 && !below_min_score && score !== null;
    return {
      score,
      passed,
      verdict: passed ? 'PASS' : 'FAIL',
      hard_failures,
      threshold_failures,
      thresholds_not_evaluated,
      below_min_score,
      dimensions,
      missing: (Object.keys(weights) as Dimension[]).filter((d) => (weights[d] ?? 0) > 0 && !dimScore.has(d)),
      unweighted: [...dimScore.keys()].filter((d) => !((weights[d] ?? 0) > 0)),
    };
  }
}
