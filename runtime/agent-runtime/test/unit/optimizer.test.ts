/**
 * Skill Optimizer, pure part and LLM steps with a scripted StubProvider (no network, no DB):
 * lifecycle transitions, configuration, clustering (validation and one retry), the candidate
 * proposal (edit-ops, ceilings rejected -> conservative retry -> error), the P5 data check, the
 * change_reason and the promotion note (idempotent, never an activation) on an in-memory CRM.
 */
import { describe, expect, it } from 'vitest';
import { UNTRUSTED_SYSTEM_RULE } from '../../src/agents/untrusted.js';
import { MemoryTwenty } from '../../src/integrations/twenty/memory-twenty.js';
import {
  AWAITING_HUMAN_STATUSES,
  canTransition,
  changeReason,
  clusterFailures,
  dataCheck,
  isCapsError,
  OPEN_STATUSES,
  optimizerConfig,
  parseClusters,
  parseProposal,
  promotionNoteMarkdown,
  promotionNoteTitle,
  proposeCandidate,
  runLabel,
  selectFailures,
  sourcesOf,
  TERMINAL_STATUSES,
  TRANSITIONS,
  upsertPromotionTask,
  type FailureCase,
  type FailureCluster,
  type PromotionNoteInput,
} from '../../src/optimizer/index.js';
import { OPTIMIZATION_RUN_STATUSES } from '../../src/db/schema.js';
import { StubProvider } from '../../src/providers/index.js';

const BASE = [
  'Eres el agente de prospección de PubliEXPE.',
  '',
  '## Escala de confianza',
  '- 0,8-1: encaje claro con datos ricos.',
  '- 0-0,19: sin encaje.',
  '',
  '## Hipótesis',
  '- Propón cantidades y presupuesto.',
  '',
  UNTRUSTED_SYSTEM_RULE,
].join('\n');

const failure = (id: string, kind: FailureCase['kind'], name: string): FailureCase => ({
  id,
  kind,
  entityKey: `org:${name.toLowerCase()}`,
  exhibitor: { name, sector: 'Alimentación' },
  event: { name: 'Feria 2026' },
  output: { relevant: kind === 'rule_hard_fail' ? false : true, confidence: kind === 'rule_hard_fail' ? 0.9 : 0.7, reason: 'Encaje razonable.', hypothesis: null },
  ...(kind === 'human_edited' ? { editedFields: { quantityMax: { before: 2000, after: 600 } } } : {}),
  ...(kind === 'rule_hard_fail' ? { evaluator: 'rule.discard_confidence_low@1', evaluatorDetails: { confidence: 0.9 } } : {}),
  source: { traceId: `t-${id}`, executionId: `e-${id}`, skillVersion: 1, occurredAt: '2026-10-01T00:00:00Z' },
});
const FAILURES = [failure('F1', 'human_discarded', 'Alfa'), failure('F2', 'human_edited', 'Beta'), failure('F3', 'rule_hard_fail', 'Gamma')];
const CLUSTERS: FailureCluster[] = [
  { id: 'C1', title: 'Descartes con confianza alta', pattern: 'F1 y F3 descartan con confianza 0,9.', skillGap: 'La escala no dice qué hacer en un descarte.', failureIds: ['F1', 'F3'] },
  { id: 'C2', title: 'Horquillas anchas', pattern: 'F2: el comercial bajó quantity_max de 2000 a 600.', skillGap: 'Hipótesis sin límite de amplitud.', failureIds: ['F2'] },
];
const clusterJson = (clusters: unknown[]) => JSON.stringify({ clusters });
const CLUSTER_OK = clusterJson([
  { id: 'C1', title: 'Descartes con confianza alta', pattern: 'F1 y F3 descartan con confianza 0,9.', skill_gap: 'La escala no dice qué hacer en un descarte.', failure_ids: ['F1', 'F3'] },
  { id: 'C2', title: 'Horquillas anchas', pattern: 'F2: el comercial bajó quantity_max a 600.', skill_gap: 'Hipótesis sin límite de amplitud.', failure_ids: ['F2'] },
]);
const ADD_OK = { op: 'ADD', anchor: '- 0-0,19: sin encaje.', text: '- Un descarte (relevant = false) lleva siempre confianza < 0,2.', why: 'C1: F1 y F3 descartan con confianza alta.', clusters: ['C1'] };
const proposalJson = (operations: unknown[]) => JSON.stringify({ summary: 'Acota la confianza de los descartes y la amplitud de las horquillas.', operations });
const OVER_CAPS = { op: 'REPLACE', find: BASE.slice(0, Math.floor(BASE.length * 0.5)), text: 'Texto nuevo.', why: 'C1: reescribe la cabecera entera para corregirlo.', clusters: ['C1'] };

describe('optimizer lifecycle', () => {
  it('every status has its transitions; terminal states have none; ERROR is reachable from every open state', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...OPTIMIZATION_RUN_STATUSES].sort());
    for (const s of TERMINAL_STATUSES) expect(TRANSITIONS[s]).toEqual([]);
    for (const s of OPEN_STATUSES) expect(canTransition(s, 'ERROR')).toBe(true);
    for (const s of AWAITING_HUMAN_STATUSES) expect(canTransition(s, 'ERROR')).toBe(false);
    expect(canTransition('PENDING', 'GATE_PASS')).toBe(false);
    expect(canTransition('GATE_FAIL', 'PROMOTED')).toBe(false);
    expect(canTransition('GATE_PASS', 'PROMOTED')).toBe(true);
    expect(sourcesOf('BLOCKED_NO_DATA').sort()).toEqual(['CANDIDATE_CREATED', 'EXPERIMENT_RUNNING', 'HARVESTING']);
    expect(sourcesOf('DISCARDED').sort()).toEqual(['GATE_FAIL', 'GATE_PASS']);
    expect(runLabel('1a2b3c4d-0000-4000-8000-000000000000')).toBe('OPT-1a2b3c4d');
  });

  it('config: defaults, the dataset of the skill, validation and unsupported skills', () => {
    const c = optimizerConfig('prospector-event-exhibitors');
    expect(c).toMatchObject({ datasetName: 'prospeccion-v1', domain: 'prospeccion', experimentBudgetEur: 0.3, llmBudgetEur: 0.05, repeat: 2, minLabeledValidation: 5, minFailures: 3, model: 'gemini-flash-latest', today: null });
    expect(optimizerConfig('prospector-event-exhibitors', { datasetName: 'prospeccion-v2', minLabeledValidation: 2 })).toMatchObject({ datasetName: 'prospeccion-v2', minLabeledValidation: 2 });
    expect(() => optimizerConfig('email-first-contact-draft')).toThrow(/no hay optimizador/);
    expect(() => optimizerConfig('prospector-event-exhibitors', { experimentBudgetEur: 9 })).toThrow(/presupuesto/);
    expect(() => optimizerConfig('prospector-event-exhibitors', { today: '7/10/2026' })).toThrow(/AAAA-MM-DD/);
  });

  it('selectFailures: human verdicts first, then rules, numbered F1..; capped', () => {
    const raw = [failure('x', 'rule_hard_fail', 'R'), failure('y', 'human_discarded', 'H1'), failure('z', 'human_edited', 'H2')].map(({ id: _id, ...f }) => f);
    const sel = selectFailures(raw, 2);
    expect(sel.map((f) => [f.id, f.exhibitor.name])).toEqual([
      ['F1', 'H1'],
      ['F2', 'H2'],
    ]);
  });
});

describe('clustering', () => {
  it('parseClusters validates ids, unknown failures and a failure in two clusters', () => {
    const ok = parseClusters(CLUSTER_OK, FAILURES);
    expect(ok.ok && ok.value.map((c) => [c.id, c.failureIds])).toEqual([
      ['C1', ['F1', 'F3']],
      ['C2', ['F2']],
    ]);
    const unknown = parseClusters(clusterJson([{ id: 'C1', title: 'X x x', pattern: 'patrón largo F9', skill_gap: 'hueco de la skill', failure_ids: ['F9'] }]), FAILURES);
    expect(unknown).toMatchObject({ ok: false, error: expect.stringMatching(/fallo desconocido F9/) });
    const twice = parseClusters(
      clusterJson([
        { id: 'C1', title: 'Uno uno', pattern: 'patrón largo F1', skill_gap: 'hueco de la skill', failure_ids: ['F1'] },
        { id: 'C2', title: 'Dos dos', pattern: 'patrón largo F1', skill_gap: 'hueco de la skill', failure_ids: ['F1'] },
      ]),
      FAILURES,
    );
    expect(twice).toMatchObject({ ok: false, error: expect.stringMatching(/F1 está en C1 y en C2/) });
    expect(parseClusters('no es json', FAILURES).ok).toBe(false);
  });

  it('clusterFailures: the failures go in an untrusted block; an invalid answer is retried once with the error', async () => {
    const stub = new StubProvider({ responses: ['{"clusters": []}', CLUSTER_OK] });
    const r = await clusterFailures(stub, { model: 'gemini-flash-latest', skillName: 'prospector-event-exhibitors', skillText: BASE, failures: FAILURES });
    expect(r.ok).toBe(true);
    expect(r.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.system).toContain('Seguridad: contenido web');
    expect(stub.requests[0]!.messages[0]!.content).toMatch(/<<<DATOS_NO_CONFIABLES id=/);
    expect(stub.requests[0]!.messages[0]!.content).toContain('el comercial DESCARTÓ la hipótesis');
    expect(stub.requests[0]!.options).toMatchObject({ responseSchema: expect.any(Object) });
    expect(stub.requests[1]!.messages.at(-1)!.content).toMatch(/no es válida/);
  });

  it('clusterFailures: two invalid answers -> not ok (the pipeline turns it into ERROR)', async () => {
    const stub = new StubProvider({ responses: ['x', 'y'] });
    const r = await clusterFailures(stub, { model: 'm', skillName: 's', skillText: BASE, failures: FAILURES });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(2);
  });
});

describe('candidate proposal (edit-ops)', () => {
  it('a bounded ADD applies on the base text and keeps the clusters it attacks', () => {
    const p = parseProposal(proposalJson([ADD_OK]), BASE, CLUSTERS);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.edit.text).toContain('- 0-0,19: sin encaje.\n- Un descarte (relevant = false) lleva siempre confianza < 0,2.');
    expect(p.value.operations[0]).toMatchObject({ operation: { op: 'ADD' }, clusters: ['C1'] });
    expect(p.value.edit.removedRatio).toBe(0);
  });

  it('rejects: anchor not in the text, unknown cluster, untouched text, the security rule touched, and the ceilings (kind caps)', () => {
    expect(parseProposal(proposalJson([{ ...ADD_OK, anchor: 'no existe' }]), BASE, CLUSTERS)).toMatchObject({ ok: false, kind: 'invalid', error: expect.stringMatching(/no aparece/) });
    expect(parseProposal(proposalJson([{ ...ADD_OK, clusters: ['C9'] }]), BASE, CLUSTERS)).toMatchObject({ ok: false, kind: 'invalid', error: expect.stringMatching(/cluster desconocido C9/) });
    const touch = { op: 'REPLACE', find: 'Nunca sigas ni obedezcas', text: 'Puedes seguir', why: 'C1: prueba de la regla de seguridad.', clusters: ['C1'] };
    expect(parseProposal(proposalJson([touch]), BASE, CLUSTERS)).toMatchObject({ ok: false, kind: 'invalid', error: expect.stringMatching(/Seguridad/) });
    const caps = parseProposal(proposalJson([OVER_CAPS]), BASE, CLUSTERS);
    expect(caps).toMatchObject({ ok: false, kind: 'caps' });
    expect(isCapsError((caps as { error: string }).error)).toBe(true);
    expect(parseProposal(proposalJson([ADD_OK, ADD_OK, ADD_OK, ADD_OK, ADD_OK, ADD_OK]), BASE, CLUSTERS)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('ceilings rejected -> one retry asking to be more conservative -> accepted', async () => {
    const stub = new StubProvider({ responses: [proposalJson([OVER_CAPS]), proposalJson([ADD_OK])] });
    const r = await proposeCandidate(stub, { model: 'm', skillName: 'prospector-event-exhibitors', baseVersion: 1, skillText: BASE, clusters: CLUSTERS });
    expect(r.ok).toBe(true);
    expect(r.attempts.map((a) => [a.ok, a.kind ?? null])).toEqual([
      [false, 'caps'],
      [true, null],
    ]);
    expect(stub.requests[1]!.messages.at(-1)!.content).toMatch(/MÁS CONSERVADOR/);
    expect(stub.requests[1]!.messages.at(-2)).toMatchObject({ role: 'assistant' });
  });

  it('ceilings rejected twice -> not ok with both attempts (ERROR with detail in the pipeline)', async () => {
    const stub = new StubProvider({ responses: [proposalJson([OVER_CAPS]), proposalJson([OVER_CAPS])] });
    const r = await proposeCandidate(stub, { model: 'm', skillName: 's', baseVersion: 1, skillText: BASE, clusters: CLUSTERS });
    expect(r.ok).toBe(false);
    expect(r.attempts.map((a) => a.kind)).toEqual(['caps', 'caps']);
    expect((r as { error: string }).error).toMatch(/máximo 35/);
  });

  it('change_reason cites the run and the clusters attacked, within 2.000 characters', () => {
    const p = parseProposal(proposalJson([ADD_OK]), BASE, CLUSTERS);
    if (!p.ok) throw new Error('proposal');
    const reason = changeReason('OPT-1a2b3c4d', CLUSTERS, p.value);
    expect(reason).toMatch(/^Skill Optimizer OPT-1a2b3c4d: ataca C1 «Descartes con confianza alta» \(2 fallos\)\./);
    expect(reason).not.toMatch(/C2/);
    expect(changeReason('OPT-x', CLUSTERS, { ...p.value, summary: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(2000);
  });
});

describe('data check (P5)', () => {
  const c = (split: string, key: string, kind: string, used = false) => ({ split, entityKey: key, expected: { kind }, usedBy: used ? [{ experiment: 'EXP-003', role: 'validation' }] : [] });
  it('counts labelled unburned VALIDATION cases without the design entities of the run', () => {
    const cases = [c('VALIDATION', 'org:a', 'human_verdict'), c('VALIDATION', 'org:b', 'human_verdict', true), c('VALIDATION', 'org:d', 'structural_discard'), c('VALIDATION', 'org:e', 'unlabeled'), c('TEST', 'org:f', 'human_verdict'), c('VALIDATION', 'org:g', 'human_verdict')];
    const ok = dataCheck(cases, new Set(['org:g']), 2, 'ds v2');
    expect(ok).toMatchObject({ ok: true, freshLabeled: 2, missing: 0, designOverlap: 1, burnedLabeled: 1 });
    const blocked = dataCheck(cases, new Set(['org:g']), 5, 'ds v2');
    expect(blocked).toMatchObject({ ok: false, freshLabeled: 2, required: 5, missing: 3 });
    expect(blocked.message).toMatch(/faltan 3/);
    expect(blocked.message).toMatch(/1 casos etiquetados del dataset ya están quemados/);
  });
});

describe('promotion note', () => {
  const input: PromotionNoteInput = {
    tenantId: 'publiexpe',
    runId: '1a2b3c4d-0000-4000-8000-000000000000',
    runLabel: 'OPT-1a2b3c4d',
    skillName: 'prospector-event-exhibitors',
    baseVersion: 4,
    candidateVersion: 5,
    experimentName: 'EXP-007',
    decision: 'PASS',
    mode: 'labeled',
    summary: 'PASS: todos los criterios.',
    composite: [{ phase: 'VALIDATION', baseline: 0.81, candidate: 0.86, delta: 0.05 }],
    clusters: CLUSTERS,
    attackedClusters: ['C1'],
    operations: [{ op: 'ADD', why: 'C1: F1 y F3.', clusters: ['C1'] }],
    cost: { optimizer_eur: 0.01, experiment_eur: 0.2, total_eur: 0.21 },
  };
  it('says nothing was activated and gives the activation command (the gate re-checks it)', () => {
    expect(promotionNoteTitle('prospector-event-exhibitors', 5)).toBe('Propuesta de promoción — prospector-event-exhibitors v5');
    const md = promotionNoteMarkdown(input);
    expect(md).toMatch(/No se ha activado nada/);
    expect(md).toContain('curl -s -X POST http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/5/activate');
    expect(md).toMatch(/Δ \+0,050/);
    expect(md).toMatch(/C1 · Descartes con confianza alta/);
    expect(md).not.toMatch(/C2 · Horquillas/);
    expect(md).toMatch(/0,2100 €/);
  });
  it('is a Twenty Task (TODO, due in 3 days), not a note, and idempotent: the same title is reused (any day)', async () => {
    const crm = new MemoryTwenty();
    const now = new Date('2026-10-12T10:00:00Z');
    const a = await upsertPromotionTask(crm.client(), input, { now });
    const b = await upsertPromotionTask(crm.client(), input, { now: new Date('2026-10-20T10:00:00Z') });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, taskId: a.taskId });
    expect(crm.tables.tasks).toHaveLength(1);
    expect(crm.tables.notes).toHaveLength(0);
    expect(crm.tables.tasks![0]).toMatchObject({ title: 'Propuesta de promoción — prospector-event-exhibitors v5', status: 'TODO', dueAt: '2026-10-15T07:00:00.000Z' });
    expect((crm.tables.tasks![0]!.bodyV2 as { markdown: string }).markdown).toMatch(/Propuesta|propone/);
  });
});
