/**
 * Release Gate (LLD v0.1 section 11.6), pure part: from the metrics of baseline and candidate
 * on the same cases to a decision. No I/O, so the unit tests pin every criterion.
 *
 *   validation_score >= baseline + minimum_delta      -> composite_delta
 *   AND critical_failures == 0                        -> hard_failures
 *   AND regression_count <= threshold                 -> seesaw (threshold 0)
 *   AND cost <= max_cost                              -> cost_per_decision (baseline x 1.25)
 *   AND accuracy(candidate) >= accuracy(baseline)     -> accuracy (only with labelled cases)
 *
 * Seesaw (HarnessX): a RULE metric the baseline already solved (score 1.0) cannot drop in the
 * candidate. A drop is a regression of that rule's dimension and makes the gate FAIL, whatever
 * the composite says. A rule the baseline solved that the candidate no longer exercises
 * (0 applicable cases) counts as a regression too by default: losing coverage of a solved
 * task is not an improvement.
 *
 * Modes:
 * - `labeled`: the split has cases with an expected value (human verdict or rule): every
 *   criterion applies and a pass is `PASS`.
 * - `form`: no labelled case (today's reality of prospeccion-v1, see the README). Accuracy
 *   cannot be measured; the rest of the criteria apply to the form of the decisions (RULEs,
 *   judge, cost). A pass is `PASS_FORM`: enough to activate, but recorded so the experiment
 *   is re-validated when labels exist.
 *
 * Decision order: a hard failure is always FAIL; otherwise incomplete data (executor budget
 * exhausted, judge scored some versions and not others, no composite) is INCONCLUSIVE;
 * otherwise any failing criterion is FAIL; otherwise PASS / PASS_FORM.
 *
 * Latency (`latency <= max_latency` in the LLD) is not a criterion yet: skill:compare does not
 * measure it per decision.
 */
import type { ExperimentDecision } from '../db/schema.js';

export interface GateConfig {
  /** composite(candidate) >= composite(baseline) + min_delta. */
  min_delta: number;
  /** Hard failures (cases failing a hard evaluator + dimension thresholds) allowed in the candidate. */
  max_hard_failures: number;
  seesaw: {
    enabled: boolean;
    /** A rule is "solved" by the baseline at this score (1.0 = every applicable case passes). */
    solved_at: number;
    /** How much a solved rule may drop in the candidate (0 = not at all). */
    tolerance: number;
    /** A solved rule with 0 applicable cases in the candidate is a regression. */
    missing_is_regression: boolean;
  };
  /** cost/decision(candidate) <= cost/decision(baseline) x max_cost_ratio. */
  max_cost_ratio: number;
  accuracy: {
    enabled: boolean;
    /** accuracy(candidate) >= accuracy(baseline) + min_delta (0 = not worse). */
    min_delta: number;
  };
}

export const DEFAULT_GATE_CONFIG: Readonly<GateConfig> = Object.freeze({
  min_delta: 0.02,
  max_hard_failures: 0,
  seesaw: Object.freeze({ enabled: true, solved_at: 1, tolerance: 0, missing_is_regression: true }),
  max_cost_ratio: 1.25,
  accuracy: Object.freeze({ enabled: true, min_delta: 0 }),
}) as GateConfig;

export function gateConfig(overrides: Partial<{ min_delta: number; max_hard_failures: number; max_cost_ratio: number; seesaw: Partial<GateConfig['seesaw']>; accuracy: Partial<GateConfig['accuracy']> }> = {}): GateConfig {
  const c: GateConfig = {
    min_delta: overrides.min_delta ?? DEFAULT_GATE_CONFIG.min_delta,
    max_hard_failures: overrides.max_hard_failures ?? DEFAULT_GATE_CONFIG.max_hard_failures,
    seesaw: { ...DEFAULT_GATE_CONFIG.seesaw, ...(overrides.seesaw ?? {}) },
    max_cost_ratio: overrides.max_cost_ratio ?? DEFAULT_GATE_CONFIG.max_cost_ratio,
    accuracy: { ...DEFAULT_GATE_CONFIG.accuracy, ...(overrides.accuracy ?? {}) },
  };
  if (!Number.isFinite(c.min_delta)) throw new Error('min_delta no válido');
  if (!(c.max_hard_failures >= 0)) throw new Error('max_hard_failures no válido');
  if (!(c.max_cost_ratio > 0)) throw new Error('max_cost_ratio debe ser > 0');
  if (!(c.seesaw.tolerance >= 0)) throw new Error('seesaw.tolerance no válido');
  return c;
}

/** One RULE (or EXACT) evaluator aggregated over the cases of one version. */
export interface RuleMetric {
  key: string;
  dimension: string;
  hard: boolean;
  /** Mean over applicable cases; null when no case applied. */
  score: number | null;
  applicable: number;
  failures: number;
  failed_cases: string[];
}

export interface AccuracyMetric {
  /** Labelled cases of the phase (distinct cases, not decisions). */
  labeled_cases: number;
  /** Decisions on labelled cases (cases x repetitions). */
  decisions: number;
  correct: number;
  /** correct / decisions; null without labelled decisions. */
  value: number | null;
  mismatches: Array<{ case_id: string; exhibitor: string; repetition: number; expected: Record<string, unknown>; got: { relevant: boolean | null; writable: boolean; confidence: number | null } }>;
}

/** What the gate reads of one version in one phase. */
export interface GateVersionMetrics {
  version: number;
  composite: number | null;
  hard_failures: Array<{ evaluator: string; dimension: string; cases: string[] }>;
  threshold_failures: Array<{ dimension: string; score: number; threshold: number }>;
  rules: RuleMetric[];
  decisions: number;
  errors: number;
  cost_eur: number;
  cost_eur_per_decision: number | null;
  accuracy: AccuracyMetric;
}

export interface GateInput {
  baseline: GateVersionMetrics;
  candidate: GateVersionMetrics;
  /** Why the measurement is incomplete (empty = complete). */
  incomplete: string[];
}

export type CriterionStatus = 'pass' | 'fail' | 'skipped';

export interface GateCriterion {
  id: 'composite_delta' | 'hard_failures' | 'seesaw' | 'cost_per_decision' | 'accuracy';
  label: string;
  status: CriterionStatus;
  baseline: number | null;
  candidate: number | null;
  /** The bar the candidate had to clear (absolute value). */
  threshold: number | null;
  detail: string;
}

export interface SeesawRegression {
  rule: string;
  dimension: string;
  baseline: number;
  candidate: number | null;
  /** Cases that fail in the candidate (none when the rule no longer applies). */
  failed_cases: string[];
  reason: 'dropped' | 'not_applicable';
}

export interface GateResult {
  mode: 'labeled' | 'form';
  decision: ExperimentDecision;
  criteria: GateCriterion[];
  seesaw_regressions: SeesawRegression[];
  incomplete: string[];
  /** One line in Spanish explaining the decision. */
  summary: string;
  config: GateConfig;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const fmt = (n: number | null, d = 3) => (n === null ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
const EPS = 1e-9;

export function hardFailureCount(m: Pick<GateVersionMetrics, 'hard_failures' | 'threshold_failures'>): number {
  return m.hard_failures.reduce((n, h) => n + Math.max(1, h.cases.length), 0) + m.threshold_failures.length;
}

export function seesawRegressions(baseline: RuleMetric[], candidate: RuleMetric[], cfg: GateConfig['seesaw']): SeesawRegression[] {
  if (!cfg.enabled) return [];
  const out: SeesawRegression[] = [];
  for (const b of baseline) {
    if (b.score === null || b.applicable === 0 || b.score < cfg.solved_at - EPS) continue;
    const c = candidate.find((x) => x.key === b.key);
    if (!c || c.score === null || c.applicable === 0) {
      if (cfg.missing_is_regression) out.push({ rule: b.key, dimension: b.dimension, baseline: b.score, candidate: null, failed_cases: [], reason: 'not_applicable' });
      continue;
    }
    if (c.score < b.score - cfg.tolerance - EPS) out.push({ rule: b.key, dimension: b.dimension, baseline: b.score, candidate: c.score, failed_cases: c.failed_cases, reason: 'dropped' });
  }
  return out;
}

/** The Release Gate. See the module comment for the criteria and the decision order. */
export function evaluateGate(input: GateInput, config: GateConfig = DEFAULT_GATE_CONFIG): GateResult {
  const { baseline: b, candidate: c } = input;
  const labeled = b.accuracy.labeled_cases > 0 || c.accuracy.labeled_cases > 0;
  const mode: GateResult['mode'] = labeled ? 'labeled' : 'form';
  const criteria: GateCriterion[] = [];

  // 1. composite(candidate) >= composite(baseline) + min_delta
  const bar = b.composite === null ? null : round(b.composite + config.min_delta);
  criteria.push({
    id: 'composite_delta',
    label: `Composite ≥ baseline + ${fmt(config.min_delta, 2)}`,
    status: b.composite === null || c.composite === null ? 'skipped' : c.composite >= bar! - EPS ? 'pass' : 'fail',
    baseline: b.composite,
    candidate: c.composite,
    threshold: bar,
    detail:
      b.composite === null || c.composite === null
        ? 'sin composite en alguna versión (ningún evaluador con peso aplicó)'
        : `Δ = ${fmt(round(c.composite - b.composite))} (mínimo ${fmt(config.min_delta, 2)})`,
  });

  // 2. hard failures of the candidate
  const hf = hardFailureCount(c);
  criteria.push({
    id: 'hard_failures',
    label: `Fallos duros de la candidata ≤ ${config.max_hard_failures}`,
    status: hf <= config.max_hard_failures ? 'pass' : 'fail',
    baseline: hardFailureCount(b),
    candidate: hf,
    threshold: config.max_hard_failures,
    detail:
      hf === 0
        ? 'ningún evaluador duro falla y se cumplen los umbrales por dimensión'
        : [
            ...c.hard_failures.map((h) => `${h.evaluator} (${h.dimension}): ${h.cases.length} caso(s)`),
            ...c.threshold_failures.map((t) => `${t.dimension} ${fmt(t.score)} < ${fmt(t.threshold, 2)}`),
          ].join('; '),
  });

  // 3. seesaw
  const regressions = seesawRegressions(b.rules, c.rules, config.seesaw);
  const solved = b.rules.filter((r) => r.score !== null && r.applicable > 0 && r.score >= config.seesaw.solved_at - EPS).length;
  criteria.push({
    id: 'seesaw',
    label: 'Seesaw: ninguna regla resuelta por la baseline cae',
    status: !config.seesaw.enabled ? 'skipped' : regressions.length === 0 ? 'pass' : 'fail',
    baseline: solved,
    candidate: regressions.length,
    threshold: 0,
    detail: !config.seesaw.enabled
      ? 'desactivado en la configuración'
      : regressions.length === 0
        ? `${solved} regla(s) con ${fmt(config.seesaw.solved_at, 1)} en la baseline; ninguna cae`
        : regressions.map((r) => `${r.rule} (${r.dimension}): ${fmt(r.baseline)} → ${r.candidate === null ? 'no aplica' : fmt(r.candidate)}`).join('; '),
  });

  // 4. cost per decision
  const costBar = b.cost_eur_per_decision === null ? null : round(b.cost_eur_per_decision * config.max_cost_ratio, 6);
  criteria.push({
    id: 'cost_per_decision',
    label: `Coste/decisión ≤ baseline × ${fmt(config.max_cost_ratio, 2)}`,
    status: costBar === null || c.cost_eur_per_decision === null ? 'skipped' : c.cost_eur_per_decision <= costBar + EPS ? 'pass' : 'fail',
    baseline: b.cost_eur_per_decision,
    candidate: c.cost_eur_per_decision,
    threshold: costBar,
    detail:
      costBar === null || c.cost_eur_per_decision === null
        ? 'sin decisiones con coste en alguna versión'
        : b.cost_eur_per_decision! > 0
          ? `${c.cost_eur_per_decision >= b.cost_eur_per_decision! ? '+' : ''}${fmt(round(((c.cost_eur_per_decision - b.cost_eur_per_decision!) / b.cost_eur_per_decision!) * 100, 1), 1)} % por decisión`
          : 'coste de la baseline 0',
  });

  // 5. accuracy (only with labelled cases)
  const accOn = config.accuracy.enabled && labeled && b.accuracy.value !== null && c.accuracy.value !== null;
  const accBar = b.accuracy.value === null ? null : round(b.accuracy.value + config.accuracy.min_delta);
  criteria.push({
    id: 'accuracy',
    label: 'Accuracy (casos etiquetados) ≥ baseline',
    status: !accOn ? 'skipped' : c.accuracy.value! >= accBar! - EPS ? 'pass' : 'fail',
    baseline: b.accuracy.value,
    candidate: c.accuracy.value,
    threshold: accOn ? accBar : null,
    detail: !config.accuracy.enabled
      ? 'desactivado en la configuración'
      : !labeled
        ? 'modo forma: 0 casos etiquetados en el split; la accuracy no se puede medir'
        : `${c.accuracy.correct}/${c.accuracy.decisions} frente a ${b.accuracy.correct}/${b.accuracy.decisions} decisiones correctas sobre ${Math.max(b.accuracy.labeled_cases, c.accuracy.labeled_cases)} caso(s) etiquetado(s)`,
  });

  const failing = criteria.filter((x) => x.status === 'fail');
  const incomplete = [...input.incomplete];
  if (b.composite === null || c.composite === null) incomplete.push('sin composite en alguna versión');
  let decision: ExperimentDecision;
  let summary: string;
  if (hf > config.max_hard_failures) {
    decision = 'FAIL';
    summary = `FAIL: la candidata incumple restricciones duras (${hf}).`;
  } else if (incomplete.length > 0) {
    decision = 'INCONCLUSIVE';
    summary = `INCONCLUSIVE: medición incompleta (${incomplete.join('; ')}).`;
  } else if (failing.length > 0) {
    decision = 'FAIL';
    summary = `FAIL: no cumple ${failing.map((f) => f.id).join(', ')}.`;
  } else if (mode === 'form') {
    decision = 'PASS_FORM';
    summary = 'PASS_FORM: cumple todos los criterios evaluables, pero sin casos etiquetados (accuracy sin medir): hay que re-validar cuando existan etiquetas.';
  } else {
    decision = 'PASS';
    summary = 'PASS: cumple todos los criterios, accuracy incluida.';
  }
  return { mode, decision, criteria, seesaw_regressions: regressions, incomplete, summary, config };
}

const STRENGTH: Record<ExperimentDecision, number> = { FAIL: 0, INCONCLUSIVE: 1, PASS_FORM: 2, PASS: 3 };

/** Final decision of several phases (VALIDATION, then TEST): the weakest one. */
export function combineDecisions(decisions: readonly ExperimentDecision[]): ExperimentDecision {
  if (decisions.length === 0) return 'INCONCLUSIVE';
  return decisions.reduce((a, d) => (STRENGTH[d] < STRENGTH[a] ? d : a));
}

/** Decisions that let the activation through (`POST .../activate` without `force`). */
export const ACTIVATING_DECISIONS: readonly ExperimentDecision[] = ['PASS', 'PASS_FORM'];
