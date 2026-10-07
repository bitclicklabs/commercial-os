/**
 * Evaluation datasets, pure rules (no database): content hash, entity key, deterministic
 * 50/25/25 split, P5 veto (markUsed semantics), the EXP-001/EXP-002 exclusion registry, the
 * public-body rule and the harvest -> cases plan.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProspectorInput } from '../../src/agents/prospector-core.js';
import type { CaseUse } from '../../src/db/schema.js';
import {
  assignSplit,
  canonicalJson,
  caseContentHash,
  entityKeyOf,
  foldEntityName,
  hashSplit,
  mergeUses,
  splitBucket,
  vetoReason,
} from '../../src/datasets/core.js';
import {
  EXCLUSION_RULES,
  FERIA_EJEMPLO_NAMES,
  GASTRONOMA_HOLDOUT_1_NAMES,
  GASTRONOMA_HOLDOUT_2_NAMES,
  matchExclusions,
  ORGANISMOS_SINTETICOS_NAMES,
} from '../../src/datasets/exclusions.js';
import { toCompareInputs } from '../../src/datasets/fixtures.js';
import type { DecisionOccurrence, HarvestResult, HumanVerdict } from '../../src/datasets/harvest-prospeccion.js';
import { humanExpected, planCases } from '../../src/datasets/plan.js';
import { matchPublicBody } from '../../src/datasets/rules.js';

const use = (experiment: string, role: CaseUse['role']): CaseUse => ({ experiment, role, at: '2026-10-07', via: 'mark_used' });

describe('content hash and entity key', () => {
  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    const a = caseContentHash({ event: { name: 'F', type: 'FAIR' }, exhibitor: { name: 'X', sector: 'S' } }, { kind: 'unlabeled' });
    const b = caseContentHash({ exhibitor: { sector: 'S', name: 'X' }, event: { type: 'FAIR', name: 'F' } }, { kind: 'unlabeled' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(caseContentHash({ exhibitor: { name: 'X' } }, { kind: 'unlabeled' })).not.toBe(caseContentHash({ exhibitor: { name: 'X' } }, { kind: 'human_verdict' }));
  });

  it('folds accents, punctuation and legal forms', () => {
    expect(foldEntityName('STEEL-INOX S.L.')).toBe('steel inox');
    expect(entityKeyOf('Steel Inox')).toBe(entityKeyOf('STEEL-INOX S.L.'));
    expect(entityKeyOf('VICENTE GANDIA PLA S.A.')).toBe(entityKeyOf('Vicente Gandía Pla'));
    expect(entityKeyOf('TEMPLO CAFÉS')).toBe('org:templo cafes');
    expect(entityKeyOf('ZERO,O MIXERS')).toBe('org:zero o mixers');
    expect(entityKeyOf('PRODUCTOS CHURRUCA, S.A.')).toBe('org:productos churruca');
    expect(entityKeyOf('S.L.')).toBe('org:s l'); // nothing left after stripping: keep the base
  });
});

describe('deterministic split (50/25/25 by entity hash)', () => {
  it('is stable between runs and depends on the salt (dataset name), not on the version', () => {
    const k = entityKeyOf('UNOX');
    expect(hashSplit('prospeccion-v1', k)).toBe(hashSplit('prospeccion-v1', k));
    expect(splitBucket('prospeccion-v1', k)).toBeGreaterThanOrEqual(0);
    expect(splitBucket('prospeccion-v1', k)).toBeLessThan(1);
    // Over many keys, some change split with another salt (the salt is really part of the hash).
    const keys = Array.from({ length: 200 }, (_, i) => `org:empresa ${i}`);
    const moved = keys.filter((x) => hashSplit('prospeccion-v1', x) !== hashSplit('otro-dataset', x)).length;
    expect(moved).toBeGreaterThan(50);
  });

  it('approximates 50/25/25 on a large sample', () => {
    const n = 8000;
    const counts = { TRAIN: 0, VALIDATION: 0, TEST: 0 };
    for (let i = 0; i < n; i++) counts[hashSplit('prospeccion-v1', `org:empresa ${i}`)] += 1;
    expect(counts.TRAIN / n).toBeGreaterThan(0.47);
    expect(counts.TRAIN / n).toBeLessThan(0.53);
    expect(counts.VALIDATION / n).toBeGreaterThan(0.22);
    expect(counts.VALIDATION / n).toBeLessThan(0.28);
    expect(counts.TEST / n).toBeGreaterThan(0.22);
    expect(counts.TEST / n).toBeLessThan(0.28);
  });

  it('a case with any recorded use is forced to TRAIN', () => {
    const salt = 'prospeccion-v1';
    const held = Array.from({ length: 50 }, (_, i) => `org:x${i}`).find((k) => hashSplit(salt, k) === 'TEST')!;
    expect(assignSplit(salt, held, [])).toEqual({ split: 'TEST', hashSplit: 'TEST', forcedTrain: false });
    expect(assignSplit(salt, held, [use('EXP-001', 'design')])).toEqual({ split: 'TRAIN', hashSplit: 'TEST', forcedTrain: true });
    expect(assignSplit(salt, held, [use('EXP-002', 'validation')]).split).toBe('TRAIN');
  });
});

describe('P5 veto (markUsed / serving)', () => {
  it('design is always allowed; validation/test only for the same experiment and role', () => {
    expect(vetoReason([], 'EXP-003', 'validation')).toBeNull();
    expect(vetoReason([], null, 'test')).toBeNull();
    expect(vetoReason([use('EXP-001', 'design')], 'EXP-003', 'design')).toBeNull();
    expect(vetoReason([use('EXP-001', 'design')], 'EXP-003', 'validation')).toMatch(/design by EXP-001/);
    expect(vetoReason([use('EXP-003', 'design')], 'EXP-003', 'validation')).toMatch(/design by EXP-003/);
    expect(vetoReason([use('EXP-002', 'validation')], 'EXP-003', 'validation')).toMatch(/validation by EXP-002/);
    expect(vetoReason([use('EXP-003', 'validation')], 'EXP-003', 'validation')).toBeNull(); // re-run of the same comparison
    expect(vetoReason([use('EXP-003', 'validation')], 'EXP-003', 'test')).toMatch(/cannot be validation and test/);
    expect(vetoReason([use('EXP-003', 'validation')], null, 'validation')).toMatch(/already used/); // a new experiment
  });

  it('mergeUses keeps one entry per (experiment, role), first wins', () => {
    const a = { ...use('EXP-001', 'design'), via: 'registry' as const };
    const merged = mergeUses([a], [use('EXP-001', 'design'), use('EXP-002', 'validation')]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.via).toBe('registry');
  });
});

describe('exclusion registry (EXP-001 / EXP-002)', () => {
  const occ = (traceId: string, executionId: string, position: number, name: string) => ({ traceId, executionId, position, name });

  it('whole design traces, positions 1-60 of the full Gastrónoma run, and burned entities by name', () => {
    expect(matchExclusions(occ('ed8e30bf-9255-40d1-a8f1-13425d8f1ef4', 'x', 55, 'CUALQUIERA')).map((r) => r.id)).toEqual(['exp-001-design-traces']);
    expect(matchExclusions(occ('y', '44e35e27-b991-467e-988a-6f0c591669cb', 1, 'CUALQUIERA')).map((r) => r.id)).toEqual(['exp-001-design-traces']);
    const full = '9d934b83-9a32-4812-aefe-7e115c2957d9';
    expect(matchExclusions(occ(full, 'x', 60, 'CUALQUIERA'))).toHaveLength(1);
    expect(matchExclusions(occ(full, 'x', 61, 'MisterRestaurant'))).toHaveLength(0); // free position
    expect(matchExclusions(occ(full, 'x', 90, 'XUNTA DE GALICIA')).map((r) => r.id)).toEqual(['exp-001-holdout', 'exp-002-design-holdout-1']);
    expect(matchExclusions(occ(full, 'x', 91, 'Zero,o Mixers')).map((r) => r.id)).toEqual(['exp-002-validation']);
    // Name rules apply in any trace (another fair, another run).
    expect(matchExclusions(occ('otra', 'otra', 1, 'Steel Inox')).map((r) => r.experiment)).toEqual(['EXP-001', 'EXP-002']);
    expect(matchExclusions(occ('otra', 'otra', 1, 'Conservas Marineras del Cantábrico')).map((r) => r.id)).toEqual(['exp-001-feria-ejemplo', 'exp-002-design-holdout-1']);
  });

  it('the names in the registry are exactly the fixture files', () => {
    const names = (f: string) => (JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8')) as { exhibitors: Array<{ name: string }> }).exhibitors.map((e) => e.name);
    expect([...FERIA_EJEMPLO_NAMES]).toEqual(names('feria-ejemplo.json'));
    expect([...GASTRONOMA_HOLDOUT_1_NAMES]).toEqual(names('gastronoma-holdout.json'));
    expect([...GASTRONOMA_HOLDOUT_2_NAMES]).toEqual(names('gastronoma-holdout-2.json'));
    expect([...ORGANISMOS_SINTETICOS_NAMES]).toEqual(names('organismos-publicos-sinteticos.json'));
    expect(new Set(EXCLUSION_RULES.map((r) => r.id)).size).toBe(EXCLUSION_RULES.length);
  });
});

describe('public-body rule (structural discards)', () => {
  it('matches governments, universities, regulatory councils and public companies', () => {
    expect(matchPublicBody({ name: 'XUNTA DE GALICIA' })).toMatchObject({ pattern: 'government', field: 'name' });
    expect(matchPublicBody({ name: 'DIPUTACIÓN PROVINCIAL DE MONTEALTO' })).toMatchObject({ pattern: 'government' });
    expect(matchPublicBody({ name: 'GRADO CIENCIAS GASTRONÓMICAS - UNIVERSIDAD DE VALENCIA' })).toMatchObject({ pattern: 'university' });
    expect(matchPublicBody({ name: 'DENOMINACIÓN DE ORIGEN UTIEL-REQUENA' })).toMatchObject({ pattern: 'regulatory_council' });
    expect(matchPublicBody({ name: 'IGP CASTELLÓ' })).toMatchObject({ pattern: 'regulatory_council' });
    expect(
      matchPublicBody({ name: 'Mercamontealto, Unidad Alimentaria de Montealto S.A.', description: 'Sociedad mercantil de capital íntegramente público que gestiona la unidad alimentaria.' }),
    ).toMatchObject({ pattern: 'public_company', field: 'description' });
    expect(matchPublicBody({ name: 'Instituto Regional', sector: 'Administración pública' })).toMatchObject({ field: 'sector' });
  });

  it('does not match private companies nor the mixed "public institutions, associations" category', () => {
    expect(matchPublicBody({ name: 'GREMIO DE MAESTROS CONFITEROS', sector: 'Organismos públicos,asociaciones / Public institutions, associations' })).toBeNull();
    expect(matchPublicBody({ name: 'UNOX', sector: 'Maquinaria y mobiliario' })).toBeNull();
    expect(matchPublicBody({ name: 'DOMINIOS DE MGP - PROYECTO ORIGEN' })).toBeNull();
    expect(matchPublicBody({ name: 'Conservas Marineras del Cantábrico', description: 'Fabricante de conservas con 140 empleados.' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plan: harvest -> cases
// ---------------------------------------------------------------------------
const EVENT = { name: 'Feria Uno 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia', source_url: 'https://feria-uno.example/expositores' };
let seq = 0;
function occurrence(traceId: string, position: number, exhibitor: DecisionOccurrence['exhibitor'], over: Partial<DecisionOccurrence> = {}): DecisionOccurrence {
  return {
    traceId,
    executionId: `exec-${traceId}`,
    stepId: `step-${++seq}`,
    sequence: position * 2,
    position,
    createdAt: new Date('2026-10-07T10:00:00Z'),
    mode: 'direct',
    agent: { name: 'Prospector', version: 5, model: 'gemini-flash-latest' },
    skillVersions: [{ name: 'prospector-event-exhibitors', version: 1, content_hash: 'abc' }],
    event: EVENT,
    exhibitor,
    fidelity: 'execution_input',
    ...over,
  };
}
function verdict(over: Partial<HumanVerdict>): HumanVerdict {
  return {
    evaluationId: 'ev-1',
    evaluationIds: ['ev-1'],
    hypothesisId: 'hyp-1',
    hypothesisName: 'X — Feria Uno 2026',
    feedback: 'ACCEPTED',
    score: 1,
    occurredAt: new Date('2026-10-07T11:00:00Z'),
    executionId: 'exec-t1',
    traceId: 't1',
    exhibitorName: null,
    editedFields: {},
    proposal: { need: 'Unas 300 bolsas.', whyNow: 'Expone el 20/11.', quantityMin: 300, quantityMax: 500, budgetMinEur: 600, budgetMaxEur: 1000, recommendedProducts: ['Bolsas'], timing: 'IMMEDIATE' },
    ...over,
  };
}
function harvest(occurrences: DecisionOccurrence[], verdicts: HumanVerdict[] = []): HarvestResult {
  return { harvester: 'test', tenantId: 't', occurrences, verdicts, stats: { traces: 0, decisions: occurrences.length, human_evaluations: verdicts.length, human_verdicts: verdicts.length, skipped_evaluations: [] }, warnings: [] };
}

describe('planCases', () => {
  const salt = 'it-plan';
  /** Names whose entity hashes to the wanted split (so the test does not depend on luck). */
  const nameIn = (split: 'TRAIN' | 'VALIDATION' | 'TEST', prefix: string) => {
    for (let i = 0; i < 500; i++) if (hashSplit(salt, entityKeyOf(`${prefix} ${i}`)) === split) return `${prefix} ${i}`;
    throw new Error('no name');
  };

  it('human verdicts, public bodies and unlabelled inputs; one case per entity; registry burns', () => {
    const testName = nameIn('TEST', 'Empresa Prueba');
    const designTrace = 'ed8e30bf-9255-40d1-a8f1-13425d8f1ef4'; // EXP-001 design trace
    const h = harvest(
      [
        occurrence('t1', 1, { name: testName, sector: 'Alimentación' }),
        occurrence('t2', 1, { name: testName }), // same entity, less data: not the representative
        occurrence('t1', 2, { name: 'XUNTA DE GALICIA', sector: 'Organismos públicos' }),
        occurrence(designTrace, 1, { name: 'Accepted Co', sector: 'Bebidas' }, { executionId: '44e35e27-b991-467e-988a-6f0c591669cb' }),
        occurrence('t1', 3, { name: 'Edited Co' }),
      ],
      [
        verdict({ exhibitorName: 'Accepted Co', traceId: designTrace, executionId: '44e35e27-b991-467e-988a-6f0c591669cb' }),
        verdict({
          evaluationId: 'ev-2',
          evaluationIds: ['ev-0', 'ev-2'],
          hypothesisId: 'hyp-2',
          exhibitorName: 'Edited Co',
          feedback: 'EDITED',
          score: 0.5,
          editedFields: { quantityMax: { before: 500, after: 800 }, timing: { before: 'IMMEDIATE', after: 'SOON' } },
        }),
        verdict({ evaluationId: 'ev-9', hypothesisId: 'hyp-9', exhibitorName: 'Nadie', traceId: 't1' }), // no decision: skipped
      ],
    );
    const { cases, summary, warnings } = planCases(h, { salt });
    expect(warnings.some((w) => w.includes('ev-9'))).toBe(true);
    expect(summary.total).toBe(4);
    expect(summary.by_kind).toEqual({ human_verdict: 2, structural_discard: 1, unlabeled: 1 });

    const accepted = cases.find((c) => c.entityKey === entityKeyOf('Accepted Co'))!;
    expect(accepted.split).toBe('TRAIN'); // design trace of EXP-001
    expect(accepted.tags).toEqual(expect.arrayContaining(['burned', 'exp-001:design', 'kind:human_verdict', 'feedback:accepted', 'data:sector']));
    expect(accepted.expected).toMatchObject({ kind: 'human_verdict', relevant: true, writable: true, feedback: 'ACCEPTED', reference_hypothesis: { quantity_max: 500 } });
    expect(accepted.source).toMatchObject({ origin: 'harvested', expected_source: 'human', evaluation_id: 'ev-1', hypothesis_id: 'hyp-1', trace_id: designTrace });

    const edited = cases.find((c) => c.entityKey === entityKeyOf('Edited Co'))!;
    expect(edited.expected).toMatchObject({ feedback: 'EDITED', reference_hypothesis: { quantity_max: 800, timing: 'SOON', quantity_min: 300 }, edited_fields: { quantityMax: { after: 800 } } });
    expect(edited.source.evaluation_ids).toEqual(['ev-0', 'ev-2']);
    expect(edited.difficulty).toBe('hard'); // name only

    const xunta = cases.find((c) => c.entityKey === entityKeyOf('XUNTA DE GALICIA'))!;
    expect(xunta.expected).toMatchObject({ kind: 'structural_discard', relevant: false, confidence_max: 0.19, rule: 'public_body' });
    expect(xunta.source.expected_source).toBe('rule');
    expect(xunta.split).toBe('TRAIN'); // burned by name (EXP-001 holdout)

    const free = cases.find((c) => c.entityKey === entityKeyOf(testName))!;
    expect(free).toMatchObject({ split: 'TEST', forcedTrain: false, usedBy: [] });
    expect(free.input).toEqual({ event: EVENT, exhibitor: { name: testName, sector: 'Alimentación' } }); // richest occurrence
    expect(free.source.occurrence_count).toBe(2);
    expect(free.expected).toEqual({ kind: 'unlabeled' });
  });

  it('uses of older versions are inherited and force TRAIN; the split of an entity is stable across builds', () => {
    const name = nameIn('VALIDATION', 'Otra Empresa');
    const h = harvest([occurrence('t1', 1, { name })]);
    const first = planCases(h, { salt });
    expect(first.cases[0]!.split).toBe('VALIDATION');
    expect(planCases(h, { salt }).cases[0]).toEqual(first.cases[0]); // deterministic
    const prior = new Map([[entityKeyOf(name), [{ ...use('EXP-010', 'design'), via: 'inherited' as const, from_version: 1 }]]]);
    const second = planCases(h, { salt, priorUses: prior });
    expect(second.cases[0]).toMatchObject({ split: 'TRAIN', hashSplit: 'VALIDATION', forcedTrain: true });
    expect(second.cases[0]!.tags).toContain('exp-010:design');
    expect(second.cases[0]!.contentHash).toBe(first.cases[0]!.contentHash); // same input and expected
  });

  it('DISCARDED expects no writable hypothesis and keeps no reference', () => {
    expect(humanExpected(verdict({ feedback: 'DISCARDED', score: 0 }))).toMatchObject({ relevant: false, writable: false, reference_hypothesis: null, edited_fields: {} });
  });
});

describe('toCompareInputs (skill:compare input)', () => {
  it('groups by event, keeps order, chunks by 50 and parses as ProspectorInput', () => {
    const other = { ...EVENT, name: 'Feria Dos 2026' };
    const cases = [
      ...Array.from({ length: 52 }, (_, i) => ({ id: `c${i}`, input: { event: EVENT, exhibitor: { name: `E${i}` } } })),
      { id: 'd1', input: { event: other, exhibitor: { name: 'D1', sector: 'S' } } },
      { id: 'bad', input: { event: null, exhibitor: { name: 'X' } } },
    ];
    const { fixtures, skipped } = toCompareInputs(cases);
    expect(skipped).toEqual(['bad']);
    expect(fixtures.map((f) => f.exhibitors.length)).toEqual([50, 2, 1]);
    expect(fixtures[1]!.case_ids).toEqual(['c50', 'c51']);
    for (const f of fixtures) expect(() => ProspectorInput.parse({ event: f.event, exhibitors: f.exhibitors })).not.toThrow();
  });
});
