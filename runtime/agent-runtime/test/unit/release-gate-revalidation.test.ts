/**
 * Release Gate on activation + re-validations, without a database: the pure effect of the most
 * recent re-validation (REFUTED blocks, CONFIRMED passes as re-validated, INSUFFICIENT / none
 * changes nothing), `checkActivationGate` over a fake connection (409 reason, force override,
 * rollback untouched, the most recent row decides) and the audit details of the outcome.
 * The real SQL (ORDER BY created_at) and the four HTTP paths are in
 * test/integration/gate-revalidation.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { AUDITED_ROUTES } from '../../src/audit/catalog.js';
import { auditRow } from '../../src/audit/hook.js';
import type { Db } from '../../src/db/client.js';
import { experimentRevalidations, type Experiment, type ExperimentRevalidation } from '../../src/db/schema.js';
import {
  checkActivationGate,
  gateRevalidation,
  refutedOptions,
  ReleaseGateBlockedError,
  revalidationEffect,
  type ActivationGate,
  type GateTarget,
} from '../../src/experiments/release-gate.js';

const TENANT = 'unit-gate';
const TARGET: GateTarget = { id: 'v2-id', version: 2, status: 'DRAFT', activatedAt: null };

function experiment(decision: Experiment['decision'], o: Partial<Experiment> = {}): Experiment {
  return {
    id: o.id ?? 'exp-1',
    tenantId: TENANT,
    number: 3,
    name: o.name ?? 'EXP-003',
    subjectType: 'skill',
    subjectName: 'prospector-event-exhibitors',
    baselineVersion: 1,
    candidateVersion: 2,
    status: 'COMPLETED',
    decision,
    config: { candidate: { version: 2, version_id: 'v2-id' } },
    gateResult: { mode: decision === 'PASS_FORM' ? 'form' : 'labeled', summary: 'unit' },
    costEur: 0,
    finishedAt: new Date('2026-09-01T10:00:00Z'),
    ...o,
  } as Experiment;
}

let seq = 0;
function reval(verdict: ExperimentRevalidation['verdict'], createdAt: string, o: Partial<ExperimentRevalidation> = {}): ExperimentRevalidation {
  seq++;
  return {
    id: `rev-${seq}`,
    tenantId: TENANT,
    experimentId: 'exp-1',
    experimentName: 'EXP-003',
    subjectType: 'skill',
    subjectName: 'prospector-event-exhibitors',
    baselineVersion: 1,
    candidateVersion: 2,
    verdict,
    labelsHash: `hash-${seq}`,
    labelCaseIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
    evaluationIds: [],
    labels: [],
    excluded: [],
    accuracy: {},
    baselineAccuracy: verdict === 'REFUTED' ? 0.8 : 0.6,
    candidateAccuracy: verdict === 'REFUTED' ? 0.4 : 0.8,
    criteria: {},
    summary: `${verdict} unit`,
    versionState: {},
    outputsSource: 'metrics',
    consequence: {},
    costEur: 0,
    source: 'api',
    requestedBy: null,
    createdAt: new Date(createdAt),
    ...o,
  } as ExperimentRevalidation;
}

/**
 * Minimal drizzle stand-in: `select().from(t).where().orderBy()` resolves the experiments given;
 * on experiment_revalidations it orders by created_at desc like the real query and honours limit.
 */
function fakeConn(exps: Experiment[], revals: ExperimentRevalidation[]): Db {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === experimentRevalidations ? [...revals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) : exps;
        const q = {
          where: () => q,
          orderBy: () => q,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, ko),
        };
        return q;
      },
    }),
  } as unknown as Db;
}

const gate = (exps: Experiment[], revals: ExperimentRevalidation[], o: { override?: Record<string, unknown>; target?: GateTarget; subjectType?: 'skill' | 'harness' } = {}) =>
  checkActivationGate(fakeConn(exps, revals), {
    tenantId: TENANT,
    subjectType: o.subjectType ?? 'skill',
    subjectName: o.subjectType === 'harness' ? 'default-commercial' : 'prospector-event-exhibitors',
    target: o.target ?? TARGET,
    activeVersion: 1,
    override: o.override,
  });

async function blockedBy(p: Promise<ActivationGate>): Promise<ReleaseGateBlockedError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ReleaseGateBlockedError);
    return err as ReleaseGateBlockedError;
  }
  throw new Error('expected the gate to block');
}

describe('revalidationEffect (pure)', () => {
  const exp = experiment('PASS_FORM');

  it('REFUTED blocks citing the re-validation (id, date, accuracies)', () => {
    const r = gateRevalidation(reval('REFUTED', '2026-09-10T08:00:00Z'));
    const e = revalidationEffect(exp, r);
    expect(e.effect).toBe('block');
    if (e.effect !== 'block') return;
    expect(e.blocked).toContain('EXP-003');
    expect(e.blocked).toContain(r.id);
    expect(e.blocked).toContain('2026-09-10T08:00:00.000Z');
    expect(e.blocked).toMatch(/REFUTÓ con 5 etiqueta\(s\)/);
    expect(e.blocked).toMatch(/v2 40 % frente a 80 % de v1/);
  });

  it('CONFIRMED passes as re-validated (nothing pending); the stored decision is not touched', () => {
    expect(revalidationEffect(exp, gateRevalidation(reval('CONFIRMED', '2026-09-10T08:00:00Z')))).toMatchObject({ effect: 'pass', revalidated: true, revalidate: false });
    expect(exp.decision).toBe('PASS_FORM');
  });

  it('INSUFFICIENT or no re-validation: behaviour as before (PASS_FORM pending, PASS not)', () => {
    expect(revalidationEffect(exp, gateRevalidation(reval('INSUFFICIENT', '2026-09-10T08:00:00Z')))).toMatchObject({ effect: 'pass', revalidated: false, revalidate: true });
    expect(revalidationEffect(exp, null)).toMatchObject({ effect: 'pass', revalidated: false, revalidate: true });
    expect(revalidationEffect(experiment('PASS'), null)).toMatchObject({ effect: 'pass', revalidated: false, revalidate: false, note: '' });
  });

  it('options: force only outside a canary; iterate and rollback always', () => {
    expect(Object.keys(refutedOptions('skill', 's', 2, false))).toEqual(['force', 'iterate', 'rollback']);
    expect(Object.keys(refutedOptions('skill', 's', 2, true))).toEqual(['iterate', 'rollback']);
    expect(refutedOptions('skill', 's', 2, true).rollback).toContain('POST /skills/s/canary/rollback');
    expect(refutedOptions('harness', 'h', 3, false).force).toContain('POST /harnesses/h/versions/3/activate');
  });
});

describe('checkActivationGate with re-validations', () => {
  it('PASS_FORM + REFUTED -> 409 release_gate_blocked with reason revalidation_refuted, the re-validation and the options', async () => {
    const r = reval('REFUTED', '2026-09-10T08:00:00Z');
    const err = await blockedBy(gate([experiment('PASS_FORM')], [r]));
    expect(err.code).toBe('release_gate_blocked');
    expect(err.message).toMatch(/^Release Gate: la revalidación más reciente de EXP-003/);
    expect(err.message).toMatch(/fuerza con .*itera.*rollback/);
    expect(err.why).not.toMatch(/Opciones/);
    expect(err.details).toMatchObject({
      reason: 'revalidation_refuted',
      candidate_version: 2,
      active_version: 1,
      experiment: { name: 'EXP-003', decision: 'PASS_FORM' },
      revalidation: { id: r.id, verdict: 'REFUTED', created_at: '2026-09-10T08:00:00.000Z', baseline_accuracy: 0.8, candidate_accuracy: 0.4, labels: 5 },
      options: { force: expect.any(String), iterate: expect.any(String), rollback: expect.any(String) },
    });
  });

  it('the same for a harness', async () => {
    const err = await blockedBy(gate([experiment('PASS_FORM', { subjectType: 'harness', subjectName: 'default-commercial' })], [reval('REFUTED', '2026-09-10T08:00:00Z')], { subjectType: 'harness' }));
    expect(err.details).toMatchObject({ reason: 'revalidation_refuted', subject_type: 'harness', options: { force: expect.stringContaining('/harnesses/default-commercial/') } });
  });

  it('force with a reason still overrides a REFUTED, reporting what it overrode', async () => {
    const r = reval('REFUTED', '2026-09-10T08:00:00Z');
    const g = await gate([experiment('PASS_FORM')], [r], { override: { force: true, reason: 'Decisión del PM tras revisar los fallos', by: 'PM' } });
    expect(g).toMatchObject({ mode: 'override', override: true, by: 'PM', blocked_reason: 'revalidation_refuted', experiment: { name: 'EXP-003' }, revalidation: { id: r.id, verdict: 'REFUTED' } });
    // A force without a valid reason does not.
    expect((await blockedBy(gate([experiment('PASS_FORM')], [r], { override: { force: true, reason: 'corto' } }))).details.reason).toBe('revalidation_refuted');
  });

  it('CONFIRMED passes with revalidated: true', async () => {
    const r = reval('CONFIRMED', '2026-09-10T08:00:00Z');
    const g = await gate([experiment('PASS_FORM')], [r]);
    expect(g).toMatchObject({ mode: 'experiment', revalidate: false, revalidated: true, revalidation: { id: r.id, verdict: 'CONFIRMED' }, experiment: { decision: 'PASS_FORM' } });
    expect(g.detail).toMatch(/revalidado: CONFIRMED/);
  });

  it('INSUFFICIENT or none: unchanged (experiment, revalidate true, revalidated false)', async () => {
    for (const revals of [[], [reval('INSUFFICIENT', '2026-09-10T08:00:00Z')]]) {
      const g = await gate([experiment('PASS_FORM')], revals);
      expect(g).toMatchObject({ mode: 'experiment', revalidate: true, revalidated: false });
      expect(g.detail).toMatch(/modo forma/);
    }
  });

  it('the most recent re-validation decides', async () => {
    const older = reval('REFUTED', '2026-09-01T08:00:00Z');
    const newer = reval('CONFIRMED', '2026-09-20T08:00:00Z');
    expect(await gate([experiment('PASS_FORM')], [older, newer])).toMatchObject({ mode: 'experiment', revalidated: true, revalidation: { id: newer.id } });
    const confirmedFirst = reval('CONFIRMED', '2026-09-01T08:00:00Z');
    const refutedLater = reval('REFUTED', '2026-09-20T08:00:00Z');
    expect((await blockedBy(gate([experiment('PASS_FORM')], [confirmedFirst, refutedLater]))).details).toMatchObject({ reason: 'revalidation_refuted', revalidation: { id: refutedLater.id } });
    const insufficientLater = reval('INSUFFICIENT', '2026-09-30T08:00:00Z');
    expect(await gate([experiment('PASS_FORM')], [refutedLater, insufficientLater])).toMatchObject({ mode: 'experiment', revalidate: true, revalidated: false, revalidation: { verdict: 'INSUFFICIENT' } });
  });

  it('a strict PASS is not affected, unless a REFUTED row exists for it (then it is blocked too)', async () => {
    expect(await gate([experiment('PASS')], [])).toMatchObject({ mode: 'experiment', revalidate: false, revalidated: false, revalidation: null });
    expect((await blockedBy(gate([experiment('PASS')], [reval('REFUTED', '2026-09-10T08:00:00Z')]))).details.reason).toBe('revalidation_refuted');
  });

  it('rollback mode never looks at re-validations', async () => {
    const g = await gate([experiment('PASS_FORM')], [reval('REFUTED', '2026-09-10T08:00:00Z')], { target: { ...TARGET, status: 'DEPRECATED', activatedAt: new Date('2026-08-01T00:00:00Z') } });
    expect(g.mode).toBe('rollback');
  });

  it('other blocks carry their own reason', async () => {
    expect((await blockedBy(gate([], []))).details.reason).toBe('no_experiment');
    expect((await blockedBy(gate([experiment('FAIL')], []))).details.reason).toBe('experiment_decision');
    expect((await blockedBy(gate([experiment('PASS', { baselineVersion: 7 })], []))).details.reason).toBe('baseline_mismatch');
  });
});

describe('audit details of the gate outcome', () => {
  const spec = AUDITED_ROUTES['POST /skills/:id/versions/:v/activate']!;
  const req = (body: Record<string, unknown>) => ({ params: { id: 'skill-a', v: '2' }, body, headers: {}, method: 'POST', ip: '10.0.0.7', id: 'req-1' }) as unknown as FastifyRequest;

  it('a 409 by a REFUTED re-validation keeps the reason and the re-validation id', () => {
    const row = auditRow(req({}), spec, '/skills/:id/versions/:v/activate', 409, { error: 'release_gate_blocked', message: 'Release Gate: …', details: { reason: 'revalidation_refuted', required: 'x', revalidation: { id: 'rev-9', verdict: 'REFUTED' } } }, 'publiexpe');
    expect(row).toMatchObject({ action: 'skill.activate', result: 'rejected', errorCode: 'release_gate_blocked', details: { reason: 'revalidation_refuted', revalidation: { id: 'rev-9', verdict: 'REFUTED' } } });
  });

  it('a force over a REFUTED is skill.force_activate with the reason it overrode', () => {
    const row = auditRow(req({ force: true, reason: 'Decisión del PM tras revisar' }), spec, '/skills/:id/versions/:v/activate', 200, { changed: true, gate: { mode: 'override', blocked_reason: 'revalidation_refuted', revalidation: { id: 'rev-9', verdict: 'REFUTED' } } }, 'publiexpe');
    expect(row).toMatchObject({ action: 'skill.force_activate', details: { gate_mode: 'override', gate_blocked_reason: 'revalidation_refuted', gate_revalidation: { id: 'rev-9', verdict: 'REFUTED' } } });
  });

  it('a pass after CONFIRMED records gate_revalidated', () => {
    const row = auditRow(req({}), spec, '/skills/:id/versions/:v/activate', 200, { changed: true, gate: { mode: 'experiment', revalidated: true, experiment: { name: 'EXP-003' }, revalidation: { id: 'rev-1', verdict: 'CONFIRMED' } } }, 'publiexpe');
    expect(row.details).toMatchObject({ gate_mode: 'experiment', gate_experiment: 'EXP-003', gate_revalidated: true, gate_revalidation: { id: 'rev-1', verdict: 'CONFIRMED' } });
  });
});
