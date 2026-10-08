/**
 * Re-validation of PASS_FORM experiments, pure rules (src/experiments/revalidation.ts): which
 * executed cases and which labels count (P5: never a design case of the candidate), accuracy on
 * the stored outputs, verdict with the gate's accuracy criterion, identity of a label set, the
 * note, and the passive counter of the metrics sync. No database, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CaseUse } from '../../src/db/schema.js';
import {
  candidateDesignUse,
  caseOutputsFromReport,
  caseOutputsOf,
  executedCaseRefs,
  labelsHash,
  revalidationAccuracy,
  revalidationCriteria,
  revalidationNoteMarkdown,
  revalidationNoteTitle,
  revalidationVerdict,
  selectLabels,
  storedCaseOutputs,
  type CaseOutput,
  type ExecutedCase,
  type LabelCandidate,
} from '../../src/experiments/index.js';
import { TwentyMetricsSync, type SummarySlice } from '../../src/metrics/twenty-sync.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const START = new Date('2026-10-07T08:00:00Z');
const EVENT = { name: 'Feria Prueba 2026' };
const use = (experiment: string, role: CaseUse['role'], at: string): CaseUse => ({ experiment, role, at, via: 'mark_used' });

function executed(name: string, over: Partial<ExecutedCase> = {}): ExecutedCase {
  return {
    case_id: `run-${name}`,
    phase: 'VALIDATION',
    use: 'validation',
    entity_key: `org:${name}`,
    exhibitor: name,
    input: { event: EVENT, exhibitor: { name } },
    expected: { kind: 'unlabeled' },
    source: { origin: 'harvested', expected_source: 'none' },
    used_by: [use('EXP-003', 'validation', '2026-10-07T08:00:01Z')],
    ...over,
  };
}

function label(name: string, relevant: boolean, over: Partial<LabelCandidate> & { evaluated_at?: string; evaluation_id?: string } = {}): LabelCandidate {
  const { evaluated_at, evaluation_id, ...rest } = over;
  return {
    case_id: `lbl-${name}-${evaluated_at ?? 'x'}`,
    dataset_id: 'ds-2',
    dataset_version: 2,
    entity_key: `org:${name}`,
    input: { event: EVENT, exhibitor: { name } },
    expected: { kind: 'human_verdict', feedback: relevant ? 'ACCEPTED' : 'DISCARDED', relevant, writable: relevant },
    source: { origin: 'harvested', expected_source: 'human', evaluation_id: evaluation_id ?? `ev-${name}`, evaluation_ids: [evaluation_id ?? `ev-${name}`], evaluated_at: evaluated_at ?? '2026-10-10T10:00:00Z' },
    used_by: [{ ...use('EXP-003', 'validation', '2026-10-07T08:00:01Z'), via: 'inherited' }],
    ...rest,
  };
}

const out = (caseId: string, version: number, relevant: boolean, confidence = relevant ? 0.6 : 0.05, repetition = 1): CaseOutput => ({ case_id: caseId, version, repetition, relevant, writable: relevant && confidence >= 0.5, confidence, status: 'ok' });

describe('executed cases and stored outputs', () => {
  it('reads the executed cases from splits: VALIDATION, the TRAIN form sample and TEST, once each', () => {
    const refs = executedCaseRefs({
      splits: {
        VALIDATION: { role: 'validation', case_ids: ['a', 'b'], form_sample_case_ids: ['c'] },
        TEST: { role: 'test', case_ids: ['d', 'a'], form_sample_case_ids: [] },
      },
    });
    expect(refs).toEqual([
      { case_id: 'a', phase: 'VALIDATION', use: 'validation' },
      { case_id: 'b', phase: 'VALIDATION', use: 'validation' },
      { case_id: 'c', phase: 'VALIDATION', use: 'form_sample' },
      { case_id: 'd', phase: 'TEST', use: 'test' },
    ]);
  });

  it('per-case outputs: from metrics (null when the experiment predates them) or from the informe.json', () => {
    expect(storedCaseOutputs({ metrics: { phases: { VALIDATION: { versions: {} } } } })).toBeNull();
    const fixtures = [{ case_ids: ['c1', 'c2'] }];
    const reports = [
      {
        runs: [
          { version: 1, repetition: 1, decisions: [{ relevant: true, writable: true, confidence: 0.7, status: 'ok' }, { relevant: false, writable: false, confidence: 0.1, status: 'ok' }] },
          { version: 2, repetition: 1, decisions: [{ relevant: true, writable: false, confidence: 0.4, status: 'ok' }, { relevant: null, writable: false, confidence: null, status: 'model_error' }] },
        ],
      },
    ] as never;
    const outputs = caseOutputsOf({ fixtures, reports });
    expect(outputs).toHaveLength(4);
    expect(outputs[3]).toEqual({ case_id: 'c2', version: 2, repetition: 1, relevant: null, writable: false, confidence: null, status: 'model_error' });
    expect(storedCaseOutputs({ metrics: { phases: { VALIDATION: { case_outputs: outputs } } } })).toEqual(outputs);
    expect(caseOutputsFromReport({ experiment: { id: 'e1' }, phases: [{ fixtures, reports }] }, 'e1')).toEqual(outputs);
    expect(() => caseOutputsFromReport({ experiment: { id: 'otro' }, phases: [] }, 'e1')).toThrow(/no de e1/);
    expect(() => caseOutputsFromReport({ nada: true })).toThrow(/phases/);
  });
});

describe('selectLabels (P5)', () => {
  const OPT = new Set(['OPT-1a2b3c4d']);
  const base = { designExperiments: OPT, designCutoff: START };

  it('no label yet: nothing usable, the entity counts as unlabeled', () => {
    const s = selectLabels({ ...base, executed: [executed('ALFA'), executed('BETA')], candidates: [] });
    expect(s).toEqual({ labels: [], excluded: [], unlabeled: 2 });
  });

  it('takes the latest HUMAN verdict of the entity in any later version; rule labels do not count', () => {
    const older = label('ALFA', true, { evaluated_at: '2026-10-09T10:00:00Z', evaluation_id: 'ev-old', dataset_version: 2 });
    const newer = label('ALFA', false, { evaluated_at: '2026-10-11T10:00:00Z', evaluation_id: 'ev-new', dataset_version: 3, dataset_id: 'ds-3' });
    const rule: LabelCandidate = { ...label('BETA', false), source: { origin: 'harvested', expected_source: 'rule' }, expected: { kind: 'structural_discard', relevant: false, writable: false, confidence_max: 0.19 } };
    const s = selectLabels({ ...base, executed: [executed('ALFA'), executed('BETA')], candidates: [older, newer, rule] });
    expect(s.unlabeled).toBe(1);
    expect(s.labels).toHaveLength(1);
    expect(s.labels[0]).toMatchObject({ executed_case_id: 'run-ALFA', label_case_id: newer.case_id, dataset_version: 3, origin: 'later_version', evaluation_id: 'ev-new', expected: { kind: 'human_verdict', relevant: false, writable: false }, input_same: true });
  });

  it('a design case of the candidate never re-validates: its optimizer run (OPT-*), or any design use before the experiment', () => {
    const optMarked = label('ALFA', true, { used_by: [use('OPT-1a2b3c4d', 'design', '2026-10-07T08:30:00Z')] });
    const priorDesign = label('BETA', true, { used_by: [use('EXP-001', 'design', '2026-10-01T00:00:00Z')] });
    // A design use recorded after the experiment by someone else (the next optimizer run) does not taint this candidate.
    const laterOther = label('GAMMA', true, { used_by: [use('OPT-99999999', 'design', '2026-10-12T00:00:00Z')] });
    const s = selectLabels({ ...base, executed: [executed('ALFA'), executed('BETA'), executed('GAMMA')], candidates: [optMarked, priorDesign, laterOther] });
    expect(s.excluded.map((x) => [x.exhibitor, x.reason])).toEqual([
      ['ALFA', 'design'],
      ['BETA', 'design'],
    ]);
    expect(s.labels.map((l) => l.exhibitor)).toEqual(['GAMMA']);
    expect(candidateDesignUse([use('X', 'design', 'no-date')], new Set(), START)).not.toBeNull();
    expect(candidateDesignUse([use('X', 'validation', '2026-01-01T00:00:00Z')], new Set(), START)).toBeNull();
  });

  it('a TRAIN form-sample case labelled at run time is design material; a held-out one counts with its own label', () => {
    const trainLabeled = executed('DELTA', { use: 'form_sample', expected: { kind: 'human_verdict', relevant: true, writable: true }, source: { expected_source: 'human', evaluation_id: 'ev-d' } });
    const testLabeled = executed('OMEGA', { phase: 'TEST', use: 'test', expected: { kind: 'human_verdict', relevant: false, writable: false }, source: { expected_source: 'human', evaluation_id: 'ev-o', evaluated_at: '2026-10-05T00:00:00Z' } });
    const s = selectLabels({ ...base, executed: [trainLabeled, testLabeled], candidates: [] });
    expect(s.excluded).toMatchObject([{ exhibitor: 'DELTA', reason: 'train_label_at_run' }]);
    expect(s.labels).toMatchObject([{ exhibitor: 'OMEGA', origin: 'at_run', label_case_id: 'run-OMEGA', evaluation_ids: ['ev-o'] }]);
  });

  it('a label on a case without stored outputs is left out (no_outputs); a different input is flagged', () => {
    const other = label('ALFA', true, { input: { event: EVENT, exhibitor: { name: 'ALFA', sector: 'Alimentación' } } });
    const s = selectLabels({ ...base, executed: [executed('ALFA'), executed('BETA')], candidates: [other, label('BETA', true)], withOutputs: new Set(['run-ALFA']) });
    expect(s.labels).toMatchObject([{ exhibitor: 'ALFA', input_same: false }]);
    expect(s.excluded).toMatchObject([{ exhibitor: 'BETA', reason: 'no_outputs' }]);
  });
});

describe('accuracy and verdict', () => {
  const labels = selectLabels({
    designExperiments: new Set(),
    designCutoff: START,
    executed: ['A', 'B', 'C', 'D', 'E'].map((n) => executed(n)),
    candidates: [label('A', true), label('B', true), label('C', false), label('D', false), label('E', true)],
  }).labels;
  const truth: Record<string, boolean> = { A: true, B: true, C: false, D: false, E: true };
  const right = (v: number) => Object.entries(truth).map(([n, r]) => out(`run-${n}`, v, r));
  const criteria = revalidationCriteria({ config: { gate: { accuracy: { enabled: true, min_delta: 0 } } } });

  it('the gate criterion of the experiment: equal accuracy confirms, lower refutes', () => {
    const b = revalidationAccuracy(1, [...right(1), ...right(2)], labels);
    const c = revalidationAccuracy(2, [...right(1), ...right(2)], labels);
    expect([b.value, c.value, b.labeled_cases]).toEqual([1, 1, 5]);
    expect(revalidationVerdict({ labels: labels.length, criteria, baseline: b, candidate: c, baselineVersion: 1, candidateVersion: 2 })).toMatchObject({ verdict: 'CONFIRMED', threshold: 1, missing: 0 });

    // The candidate writes C and D (discarded by the commercial): 3/5.
    const worse = [...right(1), ...right(2).map((o) => (o.case_id === 'run-C' || o.case_id === 'run-D' ? out(o.case_id, 2, true) : o))];
    const c2 = revalidationAccuracy(2, worse, labels);
    expect(c2).toMatchObject({ value: 0.6, correct: 3, decisions: 5 });
    expect(c2.mismatches.map((m) => m.exhibitor)).toEqual(['C', 'D']);
    const v = revalidationVerdict({ labels: labels.length, criteria, baseline: revalidationAccuracy(1, worse, labels), candidate: c2, baselineVersion: 1, candidateVersion: 2 });
    expect(v.verdict).toBe('REFUTED');
    expect(v.summary).toMatch(/REFUTED.*v2 0,600 \(3\/5\).*v1 1,000 \(5\/5\)/);
  });

  it('min_delta comes from the experiment gate; a model error never counts as correct', () => {
    const strict = revalidationCriteria({ config: { gate: { accuracy: { min_delta: 0.1 } } } });
    expect(strict).toEqual({ min_labels: 5, min_delta: 0.1, gate_accuracy_enabled: true });
    const b = revalidationAccuracy(1, right(1), labels);
    const c = revalidationAccuracy(2, right(2), labels);
    expect(revalidationVerdict({ labels: 5, criteria: strict, baseline: b, candidate: c, baselineVersion: 1, candidateVersion: 2 }).verdict).toBe('REFUTED');
    const err = revalidationAccuracy(2, [{ ...out('run-A', 2, true), relevant: null, confidence: null }], labels);
    expect(err).toMatchObject({ decisions: 1, correct: 0 });
    expect(() => revalidationCriteria({ config: {} }, 0)).toThrow(/min_labels/);
  });

  it('INSUFFICIENT: too few labels (says how many are missing) or an arm without decisions', () => {
    const b = revalidationAccuracy(1, right(1), labels.slice(0, 2));
    const c = revalidationAccuracy(2, right(2), labels.slice(0, 2));
    expect(revalidationVerdict({ labels: 2, criteria, baseline: b, candidate: c, baselineVersion: 1, candidateVersion: 2 })).toMatchObject({ verdict: 'INSUFFICIENT', missing: 3, threshold: null });
    const none = revalidationAccuracy(2, [], labels);
    expect(none.value).toBeNull();
    expect(revalidationVerdict({ labels: 5, criteria, baseline: b, candidate: none, baselineVersion: 1, candidateVersion: 2 }).verdict).toBe('INSUFFICIENT');
    expect(revalidationVerdict({ labels: 0, criteria, baseline: none, candidate: none, baselineVersion: 1, candidateVersion: 2 }).summary).toMatch(/0 etiqueta\(s\).*faltan 5/);
  });

  it('identity of a re-validation: the same labels in any order give the same hash; other criteria, another', () => {
    expect(labelsHash([...labels].reverse(), criteria)).toBe(labelsHash(labels, criteria));
    expect(labelsHash(labels, { ...criteria, min_labels: 3 })).not.toBe(labelsHash(labels, criteria));
    expect(labelsHash(labels.slice(1), criteria)).not.toBe(labelsHash(labels, criteria));
  });
});

describe('the note of a REFUTED version in use', () => {
  const acc = (value: number, correct: number) => ({ labeled_cases: 5, decisions: 5, correct, value, mismatches: [] });
  const input = {
    tenantId: 'publiexpe',
    revalidationId: 'r-1',
    experimentName: 'EXP-007',
    subjectType: 'skill' as const,
    subjectName: 'prospector-event-exhibitors',
    baselineVersion: 3,
    candidateVersion: 4,
    summary: 'REFUTED: …',
    baseline: acc(1, 5),
    candidate: acc(0.6, 3),
    criteria: { min_labels: 5, min_delta: 0, gate_accuracy_enabled: true },
    labels: 5,
    excluded: 1,
  };

  it('ACTIVE: numbers and the three options; it proposes, it changes nothing', () => {
    expect(revalidationNoteTitle('prospector-event-exhibitors', 4)).toBe('⚠️ Revalidación fallida — prospector-event-exhibitors v4');
    const md = revalidationNoteMarkdown({ ...input, versionState: { state: 'ACTIVE', status: 'ACTIVE', canary: null, relevant: true } });
    expect(md).toMatch(/No se ha cambiado nada/);
    expect(md).toMatch(/\| v4 \(candidata\) \| 0,600 \| 3\/5 \| 5 \|/);
    expect(md).toMatch(/Rollback.*\/skills\/prospector-event-exhibitors\/versions\/3\/activate/);
    expect(md).toMatch(/Canario.*\/versions\/4\/canary/);
    expect(md).toMatch(/Iterar.*\/optimizer\/skills\/prospector-event-exhibitors\/run/);
    expect(md).not.toMatch(/versions\/4\/activate/);
  });

  it('CANARY: the rollback is the canary rollback; a harness has no canary', () => {
    const md = revalidationNoteMarkdown({ ...input, versionState: { state: 'CANARY', status: 'DRAFT', canary: { id: 'c', percent: 10, stable_version: 3 }, relevant: true } });
    expect(md).toMatch(/en canario \(10 %/);
    expect(md).toMatch(/\/skills\/prospector-event-exhibitors\/canary\/rollback/);
    const h = revalidationNoteMarkdown({ ...input, subjectType: 'harness', subjectName: 'default-commercial', versionState: { state: 'ACTIVE', status: 'ACTIVE', canary: null, relevant: true } });
    expect(h).toMatch(/\/harnesses\/default-commercial\/versions\/3\/activate/);
    expect(h).toMatch(/no hay canario de harness/);
  });
});

describe('passive counter in the metrics sync', () => {
  const slice = (): SummarySlice => ({ runs: { total: 0, by_status: {}, by_outcome: {} }, cost: { total_eur: 0 }, funnel: { hypotheses_created: 0 }, human_feedback: { subjects_reviewed: 0, accepted: 0, acceptance_rate: null }, email: { sends: { in_window: 0 } } });

  it('counts the ready re-validations on each tick and logs only when the number changes; a failure never breaks the tick', async () => {
    const fake = new FakeTwenty();
    fake.tables.agentOsDailyMetrics = [];
    const info = vi.fn();
    const warn = vi.fn();
    let n = 0;
    let broken = false;
    const sync = new TwentyMetricsSync(undefined, fake.client(), {
      tenantId: 't',
      summary: async () => slice(),
      now: () => new Date('2026-10-07T10:00:00Z'),
      logger: { info, warn },
      revalidations: async () => {
        if (broken) throw new Error('db down');
        return n;
      },
    });
    expect((await sync.syncOnce()).revalidations_ready).toBe(0);
    expect(info).not.toHaveBeenCalled();
    n = 2;
    const r = await sync.syncOnce();
    expect(r).toMatchObject({ ok: true, revalidations_ready: 2 });
    expect(info).toHaveBeenCalledWith({ revalidations_ready: 2 }, expect.stringMatching(/revalidaciones disponibles: 2/));
    await sync.syncOnce();
    expect(info).toHaveBeenCalledTimes(1);
    broken = true;
    expect(await sync.syncOnce()).toMatchObject({ ok: true, revalidations_ready: null });
    expect(warn).toHaveBeenCalledWith({ err: 'db down' }, 'revalidation counter failed');
    // Twenty is not touched by the counter: only the daily metric records.
    expect(Object.keys(fake.tables).filter((k) => (fake.tables[k] as unknown[]).length > 0)).toEqual(['agentOsDailyMetrics']);
  });
});
