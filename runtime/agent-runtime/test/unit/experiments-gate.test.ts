/**
 * Release Gate (src/experiments/gate.ts) and the pure parts of the experiment runner: every
 * criterion, the seesaw constraint, PASS_FORM, the decision order, accuracy against labels,
 * the form sample and the activation body (force needs a reason).
 */
import { describe, expect, it } from 'vitest';
import { ActivateVersionBody } from '../../src/api/schemas.js';
import type { CaseUse, EvaluationCase } from '../../src/db/schema.js';
import {
  accuracyOf,
  autoFormSampleSize,
  combineDecisions,
  decisionMatches,
  DEFAULT_GATE_CONFIG,
  evaluateGate,
  experimentName,
  gateConfig,
  hardFailureCount,
  pickFormSample,
  seesawRegressions,
  type GateVersionMetrics,
  type RuleMetric,
} from '../../src/experiments/index.js';
import type { ComparisonReport } from '../../src/skills/compare.js';

const rule = (key: string, score: number | null, applicable = 10, extra: Partial<RuleMetric> = {}): RuleMetric => ({
  key,
  dimension: extra.dimension ?? 'FACTUALITY',
  hard: extra.hard ?? false,
  score,
  applicable: score === null ? 0 : applicable,
  failures: score === null ? 0 : Math.round((1 - score) * applicable),
  failed_cases: extra.failed_cases ?? [],
});

const RULES = () => [rule('rule.decision_valid@1', 1, 10, { dimension: 'TASK_SUCCESS' }), rule('rule.need_has_quantities@1', 0.5, 8, { dimension: 'NEXT_ACTION_QUALITY' }), rule('rule.discard_confidence_low@1', 1, 2, { dimension: 'COMMERCIAL_RELEVANCE', hard: true })];

function metrics(version: number, o: Partial<GateVersionMetrics> = {}): GateVersionMetrics {
  return {
    version,
    composite: 0.8,
    hard_failures: [],
    threshold_failures: [],
    rules: RULES(),
    decisions: 20,
    errors: 0,
    cost_eur: 0.04,
    cost_eur_per_decision: 0.002,
    accuracy: { labeled_cases: 0, decisions: 0, correct: 0, value: null, mismatches: [] },
    ...o,
  };
}
const labeledAcc = (correct: number, decisions = 4) => ({ labeled_cases: 2, decisions, correct, value: correct / decisions, mismatches: [] });
const crit = (r: ReturnType<typeof evaluateGate>, id: string) => r.criteria.find((c) => c.id === id)!;

describe('Release Gate: criteria', () => {
  it('defaults: min_delta 0,02, 0 hard failures, seesaw on solved rules, cost x 1,25, accuracy not worse', () => {
    expect(DEFAULT_GATE_CONFIG).toMatchObject({ min_delta: 0.02, max_hard_failures: 0, max_cost_ratio: 1.25, seesaw: { enabled: true, solved_at: 1, tolerance: 0, missing_is_regression: true }, accuracy: { enabled: true, min_delta: 0 } });
    expect(gateConfig({ min_delta: 0.05, seesaw: { tolerance: 0.1 } })).toMatchObject({ min_delta: 0.05, seesaw: { enabled: true, tolerance: 0.1 } });
    expect(() => gateConfig({ max_cost_ratio: 0 })).toThrow(/max_cost_ratio/);
  });

  it('composite: candidate >= baseline + min_delta passes (boundary included); less fails', () => {
    expect(crit(evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.82 }), incomplete: [] }), 'composite_delta').status).toBe('pass');
    const r = evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.819 }), incomplete: [] });
    expect(crit(r, 'composite_delta')).toMatchObject({ status: 'fail', baseline: 0.8, candidate: 0.819, threshold: 0.82 });
    expect(r.decision).toBe('FAIL');
    expect(r.summary).toMatch(/composite_delta/);
  });

  it('hard failures of the candidate are FAIL even with incomplete data; the baseline ones do not count', () => {
    const r = evaluateGate({
      baseline: metrics(3, { hard_failures: [{ evaluator: 'rule.discard_confidence_low@1', dimension: 'COMMERCIAL_RELEVANCE', cases: ['a', 'b'] }] }),
      candidate: metrics(4, { composite: 0.95, hard_failures: [{ evaluator: 'rule.source_urls_known@1', dimension: 'SOURCE_QUALITY', cases: ['x'] }] }),
      incomplete: ['presupuesto del ejecutor agotado'],
    });
    expect(r.decision).toBe('FAIL');
    expect(crit(r, 'hard_failures')).toMatchObject({ status: 'fail', baseline: 2, candidate: 1, threshold: 0 });
    // A dimension threshold (CRM_CORRECTNESS < 0,95) is a hard failure too.
    expect(hardFailureCount({ hard_failures: [], threshold_failures: [{ dimension: 'CRM_CORRECTNESS', score: 0.9, threshold: 0.95 }] })).toBe(1);
  });

  it('cost per decision: <= baseline x 1,25 passes, above fails', () => {
    expect(crit(evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.9, cost_eur_per_decision: 0.0025 }), incomplete: [] }), 'cost_per_decision').status).toBe('pass');
    const r = evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.9, cost_eur_per_decision: 0.00251 }), incomplete: [] });
    expect(crit(r, 'cost_per_decision')).toMatchObject({ status: 'fail', threshold: 0.0025 });
    expect(r.decision).toBe('FAIL');
  });

  it('accuracy with labelled cases: worse fails, equal passes and the decision is PASS (not PASS_FORM)', () => {
    const worse = evaluateGate({ baseline: metrics(3, { accuracy: labeledAcc(4) }), candidate: metrics(4, { composite: 0.9, accuracy: labeledAcc(3) }), incomplete: [] });
    expect(worse.mode).toBe('labeled');
    expect(crit(worse, 'accuracy')).toMatchObject({ status: 'fail', baseline: 1, candidate: 0.75 });
    expect(worse.decision).toBe('FAIL');
    const same = evaluateGate({ baseline: metrics(3, { accuracy: labeledAcc(3) }), candidate: metrics(4, { composite: 0.9, accuracy: labeledAcc(3) }), incomplete: [] });
    expect(crit(same, 'accuracy').status).toBe('pass');
    expect(same.decision).toBe('PASS');
  });
});

describe('Release Gate: seesaw', () => {
  it('a rule solved by the baseline (1,0) that drops in the candidate is a regression of its dimension: FAIL despite a better composite', () => {
    const cand = [rule('rule.decision_valid@1', 0.9, 10, { dimension: 'TASK_SUCCESS', failed_cases: ['s#3:ACME'] }), rule('rule.need_has_quantities@1', 1, 8, { dimension: 'NEXT_ACTION_QUALITY' }), rule('rule.discard_confidence_low@1', 1, 2, { dimension: 'COMMERCIAL_RELEVANCE', hard: true })];
    const r = evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.99, rules: cand }), incomplete: [] });
    expect(r.decision).toBe('FAIL');
    expect(crit(r, 'composite_delta').status).toBe('pass');
    expect(crit(r, 'seesaw').status).toBe('fail');
    expect(r.seesaw_regressions).toEqual([{ rule: 'rule.decision_valid@1', dimension: 'TASK_SUCCESS', baseline: 1, candidate: 0.9, failed_cases: ['s#3:ACME'], reason: 'dropped' }]);
  });

  it('a rule the baseline did NOT solve may drop (no seesaw); tolerance relaxes the drop', () => {
    const base = [rule('r.a@1', 0.5)];
    expect(seesawRegressions(base, [rule('r.a@1', 0.2)], DEFAULT_GATE_CONFIG.seesaw)).toEqual([]);
    expect(seesawRegressions([rule('r.b@1', 1)], [rule('r.b@1', 0.95)], { ...DEFAULT_GATE_CONFIG.seesaw, tolerance: 0.05 })).toEqual([]);
    expect(seesawRegressions([rule('r.b@1', 1)], [rule('r.b@1', 0.94)], { ...DEFAULT_GATE_CONFIG.seesaw, tolerance: 0.05 })).toHaveLength(1);
  });

  it('a solved rule that no longer applies in the candidate counts as a regression (configurable)', () => {
    const regress = seesawRegressions([rule('r.c@1', 1)], [rule('r.c@1', null)], DEFAULT_GATE_CONFIG.seesaw);
    expect(regress).toEqual([{ rule: 'r.c@1', dimension: 'FACTUALITY', baseline: 1, candidate: null, failed_cases: [], reason: 'not_applicable' }]);
    expect(seesawRegressions([rule('r.c@1', 1)], [], { ...DEFAULT_GATE_CONFIG.seesaw, missing_is_regression: false })).toEqual([]);
    expect(seesawRegressions([rule('r.c@1', 1)], [rule('r.c@1', 0)], { ...DEFAULT_GATE_CONFIG.seesaw, enabled: false })).toEqual([]);
  });
});

describe('Release Gate: modes and decision order', () => {
  it('without labelled cases the gate runs in form mode: accuracy skipped and a pass is PASS_FORM', () => {
    const r = evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.9 }), incomplete: [] });
    expect(r.mode).toBe('form');
    expect(crit(r, 'accuracy')).toMatchObject({ status: 'skipped' });
    expect(crit(r, 'accuracy').detail).toMatch(/modo forma/);
    expect(r.decision).toBe('PASS_FORM');
    expect(r.summary).toMatch(/re-validar/);
  });

  it('incomplete measurement is INCONCLUSIVE (unless a hard failure), also when a soft criterion fails', () => {
    const r = evaluateGate({ baseline: metrics(3), candidate: metrics(4, { composite: 0.7 }), incomplete: ['presupuesto del ejecutor agotado: hay decisiones sin ejecutar'] });
    expect(r.decision).toBe('INCONCLUSIVE');
    expect(evaluateGate({ baseline: metrics(3, { composite: null }), candidate: metrics(4, { composite: 0.9 }), incomplete: [] }).decision).toBe('INCONCLUSIVE');
  });

  it('phases combine to the weakest decision', () => {
    expect(combineDecisions(['PASS', 'PASS'])).toBe('PASS');
    expect(combineDecisions(['PASS', 'PASS_FORM'])).toBe('PASS_FORM');
    expect(combineDecisions(['PASS', 'INCONCLUSIVE'])).toBe('INCONCLUSIVE');
    expect(combineDecisions(['PASS_FORM', 'FAIL'])).toBe('FAIL');
    expect(combineDecisions([])).toBe('INCONCLUSIVE');
  });
});

describe('accuracy against labels', () => {
  it('a decision matches relevant, writable and the confidence ceiling of a structural discard; an error never matches', () => {
    const discard = { kind: 'structural_discard', relevant: false, writable: false, confidence_max: 0.19 };
    expect(decisionMatches(discard, { relevant: false, writable: false, confidence: 0.05 })).toBe(true);
    expect(decisionMatches(discard, { relevant: false, writable: false, confidence: 0.95 })).toBe(false);
    expect(decisionMatches(discard, { relevant: true, writable: true, confidence: 0.7 })).toBe(false);
    expect(decisionMatches({ kind: 'human_verdict', relevant: true, writable: true }, { relevant: true, writable: true, confidence: 0.8 })).toBe(true);
    expect(decisionMatches({ kind: 'human_verdict', relevant: true, writable: true }, { relevant: true, writable: false, confidence: 0.4 })).toBe(false);
    expect(decisionMatches({ kind: 'human_verdict', relevant: true }, { relevant: null, writable: false, confidence: null })).toBe(false);
  });

  it('accuracyOf counts only labelled cases of the phase (not the form sample), per repetition', () => {
    const d = (exhibitor: string, relevant: boolean, confidence: number) => ({ exhibitor, relevant, confidence, writable: relevant && confidence >= 0.5 });
    const report = {
      runs: [
        { version: 3, repetition: 1, decisions: [d('Ayto', false, 0.05), d('Acme', true, 0.8), d('Train SL', true, 0.6)] },
        { version: 4, repetition: 1, decisions: [d('Ayto', false, 0.6), d('Acme', true, 0.8), d('Train SL', true, 0.6)] },
      ],
    } as unknown as ComparisonReport;
    const outcome = {
      fixtures: [{ name: 'f', input: { event: {}, exhibitors: [] }, case_ids: ['c-ayto', 'c-acme', 'c-train'] }],
      reports: [report],
      expected: new Map<string, Record<string, unknown>>([
        ['c-ayto', { kind: 'structural_discard', relevant: false, writable: false, confidence_max: 0.19 }],
        ['c-acme', { kind: 'unlabeled' }],
        ['c-train', { kind: 'human_verdict', relevant: false, writable: false }],
      ]),
      accuracyCaseIds: new Set(['c-ayto', 'c-acme']), // c-train is form sample
    };
    expect(accuracyOf(3, outcome)).toMatchObject({ labeled_cases: 1, decisions: 1, correct: 1, value: 1 });
    const v4 = accuracyOf(4, outcome);
    expect(v4).toMatchObject({ labeled_cases: 1, decisions: 1, correct: 0, value: 0 });
    expect(v4.mismatches[0]).toMatchObject({ case_id: 'c-ayto', exhibitor: 'Ayto', got: { relevant: false, confidence: 0.6 } });
  });
});

describe('form sample and naming', () => {
  const tc = (id: string, entityKey: string, usedBy: CaseUse[] = []) => ({ id, entityKey, usedBy }) as unknown as EvaluationCase;

  it('picks only unburned TRAIN cases, deterministically per experiment', () => {
    const burned: CaseUse = { experiment: 'EXP-001', role: 'design', at: '2026-10-07T00:00:00Z', via: 'registry' };
    const train = [tc('1', 'org:a'), tc('2', 'org:b', [burned]), tc('3', 'org:c'), tc('4', 'org:d')];
    const a = pickFormSample(train, 'EXP-003', 2);
    expect(a).toHaveLength(2);
    expect(a.map((c) => c.id)).not.toContain('2');
    expect(pickFormSample(train, 'EXP-003', 2).map((c) => c.id)).toEqual(a.map((c) => c.id));
    expect(pickFormSample(train, 'EXP-003', 10).map((c) => c.id).sort()).toEqual(['1', '3', '4']);
    expect(pickFormSample(train, 'EXP-003', 0)).toEqual([]);
  });

  it('auto form sample size follows the executor budget (20 % margin) and the 50-exhibitor cap', () => {
    // 0,20 € x 0,8 / (0,0025 € x 2 versions x 2 repetitions) = 16 cases, 2 already in VALIDATION.
    expect(autoFormSampleSize(0.2, 0.0025, 2, 2)).toBe(14);
    expect(autoFormSampleSize(10, 0.0025, 1, 2)).toBe(48);
    expect(autoFormSampleSize(0.001, 0.0025, 2, 2)).toBe(0);
  });

  it('EXP-NNN names', () => {
    expect(experimentName(3)).toBe('EXP-003');
    expect(experimentName(42)).toBe('EXP-042');
    expect(experimentName(1234)).toBe('EXP-1234');
  });
});

describe('activation body (override)', () => {
  it('force needs a reason of at least 10 characters; without force the body is optional', () => {
    expect(ActivateVersionBody.safeParse({}).success).toBe(true);
    expect(ActivateVersionBody.safeParse({ force: true }).success).toBe(false);
    expect(ActivateVersionBody.safeParse({ force: true, reason: 'corto' }).success).toBe(false);
    expect(ActivateVersionBody.safeParse({ force: true, reason: 'Decisión del PM tras revisar EXP-003', by: 'PM' }).success).toBe(true);
  });
});
