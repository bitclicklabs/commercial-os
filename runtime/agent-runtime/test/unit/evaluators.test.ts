/**
 * Automatic evaluators (LLD §11.1-11.3): every RULE with fixtures, the judge with a
 * scripted provider, the composite with its hard constraints, the pipeline on the real
 * EXP-002 comparison and the rows it would persist. No network, no database.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertDistinctJudge,
  assumptionsMarked,
  budgetDerived,
  COMMERCIAL_RELEVANCE_RUBRIC,
  CompositeEvaluator,
  confidenceCappedByData,
  contentHashOf,
  decisionValid,
  defaultEvaluators,
  discardConfidenceLow,
  evaluationRows,
  EvaluatorRegistry,
  JudgeBudgetProvider,
  LlmJudgeEvaluator,
  makeExactEvaluator,
  NEXT_ACTION_QUALITY_RUBRIC,
  needHasQuantities,
  needUnits,
  quantitySpread,
  quoteFound,
  runEvaluationPipeline,
  sourceUrlsKnown,
  subjectsFromComparison,
  type CaseHypothesis,
  type CaseInput,
  type CaseOutput,
  type EvaluationContext,
  type EvaluatorAggregate,
} from '../../src/evaluators/index.js';
import { StubProvider, type CompletionRequest, type CompletionResult, type ModelProvider, type StreamChunk, type TokenUsage } from '../../src/providers/index.js';
import { UNTRUSTED_OPEN } from '../../src/agents/untrusted.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXP2_PATH = resolve(here, '../../../../docs/experimentos/EXP-002/compare-v1-v3.json');
const EXP2 = JSON.parse(readFileSync(EXP2_PATH, 'utf8')) as Record<string, unknown>;

const EVENT: CaseInput['event'] = { name: 'Gastrónoma 2026', type: 'FAIR', date: '2026-10-26', source_url: 'https://apps.feriavalencia.com/catalog/gastronoma/exhibitors' };
const input = (exhibitor: CaseInput['exhibitor'], dataLevel: CaseInput['dataLevel']): CaseInput => ({ event: EVENT, exhibitor, dataLevel });
const hyp = (over: Partial<CaseHypothesis> = {}): CaseHypothesis => ({
  need: 'Unas 250 bolsas tote de algodón para visitantes y 10 delantales para el personal del stand.',
  why_now: 'Gastrónoma 2026 se celebra el 26 de octubre; el taller propio llega a tiempo.',
  quantity_min: 260,
  quantity_max: 500,
  budget_min_eur: 580,
  budget_max_eur: 1250,
  recommended_products: ['bolsas tote de algodón', 'delantales personalizados'],
  timing: 'IMMEDIATE',
  differentiators: ['TALLER_PROPIO'],
  ...over,
});
const out = (over: Partial<CaseOutput> = {}): CaseOutput => ({
  status: 'hypothesis_created',
  relevant: true,
  confidence: 0.55,
  reason: 'Por el nombre, parece una empresa privada de hostelería; solo tenemos la razón social.',
  hypothesis: hyp(),
  writable: true,
  ...over,
});
const CTX: EvaluationContext = { knownSources: { urls: [EVENT.source_url!], domains: ['mybaos.example'] }, minConfidence: 0.5 };
const NAME = input({ name: 'MYBAOS SL' }, 'name_only');
const SECTOR = input({ name: 'UNOX', sector: 'Equipamiento' }, 'sector');
const RICH = input({ name: 'Conservas', description: 'Conservera con 140 empleados', domain: 'conservas.example' }, 'rich');

const run = async (e: { evaluate: (...a: never[]) => unknown }, i: CaseInput, o: CaseOutput, c = CTX) => (e.evaluate as (i: CaseInput, o: CaseOutput, c: EvaluationContext) => Promise<ReturnType<typeof needHasQuantities.evaluate>>)(i, o, c);

// ---------------------------------------------------------------------------
describe('RULE evaluators', () => {
  it('decision_valid: errors and relevant without hypothesis fail', async () => {
    expect((await run(decisionValid, NAME, out()))?.pass).toBe(true);
    expect((await run(decisionValid, NAME, out({ status: 'llm_invalid', relevant: null, confidence: null, hypothesis: null })))?.pass).toBe(false);
    expect((await run(decisionValid, NAME, out({ hypothesis: null })))?.details.problems).toEqual(['relevante sin hipótesis']);
    expect((await run(decisionValid, NAME, out({ status: 'discarded_irrelevant', relevant: false, confidence: 0.05, hypothesis: null })))?.pass).toBe(true);
  });

  it('need_has_quantities: a number that is not a year; N/A without hypothesis', async () => {
    expect((await run(needHasQuantities, NAME, out()))?.pass).toBe(true);
    expect((await run(needHasQuantities, NAME, out({ hypothesis: hyp({ need: 'Material promocional para Gastrónoma 2026 y textil para el equipo.' }) })))?.pass).toBe(false);
    expect(await run(needHasQuantities, NAME, out({ relevant: false, hypothesis: null }))).toBeNull();
  });

  it('quantity_spread_le_2_5: max/min <= 2,5; min = 0 fails', async () => {
    expect((await run(quantitySpread, NAME, out({ hypothesis: hyp({ quantity_min: 200, quantity_max: 500 }) })))?.pass).toBe(true);
    const wide = await run(quantitySpread, NAME, out({ hypothesis: hyp({ quantity_min: 250, quantity_max: 1000 }) }));
    expect(wide).toMatchObject({ pass: false, score: 0, details: { ratio: 4 } });
    expect((await run(quantitySpread, NAME, out({ hypothesis: hyp({ quantity_min: 0, quantity_max: 10 }) })))?.pass).toBe(false);
  });

  it('discard_confidence_low (hard): discards below 0,2; relevant cases N/A', async () => {
    expect(discardConfidenceLow.hard).toBe(true);
    const ok = await run(discardConfidenceLow, SECTOR, out({ status: 'discarded_irrelevant', relevant: false, confidence: 0.05, hypothesis: null }));
    expect(ok?.pass).toBe(true);
    const bad = await run(discardConfidenceLow, SECTOR, out({ status: 'discarded_irrelevant', relevant: false, confidence: 0.95, hypothesis: null }));
    expect(bad).toMatchObject({ pass: false, dimension: 'COMMERCIAL_RELEVANCE' });
    expect((await run(discardConfidenceLow, SECTOR, out({ relevant: false, confidence: 0.2, hypothesis: null })))?.pass).toBe(false);
    expect(await run(discardConfidenceLow, SECTOR, out())).toBeNull();
  });

  it('assumptions_marked: only name-only cases, with an inference marker', async () => {
    expect((await run(assumptionsMarked, NAME, out()))?.details.marker).toBe('Por el nombre');
    expect((await run(assumptionsMarked, NAME, out({ reason: 'SERHS Projects es una división del Grupo SERHS.' })))?.pass).toBe(false);
    expect(await run(assumptionsMarked, SECTOR, out())).toBeNull();
  });

  it('confidence_capped_by_data: caps by data level, unless notoriety is declared', async () => {
    expect((await run(confidenceCappedByData, NAME, out({ confidence: 0.58 })))?.pass).toBe(true);
    expect((await run(confidenceCappedByData, NAME, out({ confidence: 0.65, reason: 'Empresa privada del sector.' })))?.pass).toBe(false);
    expect((await run(confidenceCappedByData, SECTOR, out({ confidence: 0.85, reason: 'Fabricante líder de hornos, por conocimiento general.' })))?.pass).toBe(true);
    expect((await run(confidenceCappedByData, SECTOR, out({ confidence: 0.8, reason: 'Bodega privada con stand.' })))?.pass).toBe(false);
    expect(await run(confidenceCappedByData, RICH, out({ confidence: 0.9 }))).toBeNull();
    expect(await run(confidenceCappedByData, NAME, out({ relevant: false, confidence: 0.05, hypothesis: null }))).toBeNull();
  });

  it('needUnits: sums enumerated units, skipping years, money, surfaces and decimals', () => {
    expect(needUnits('Unas 250 bolsas tote y 10 delantales para Gastrónoma 2026.')).toBe(260);
    expect(needUnits('Unas 250 libretas, 200 metros de lanyards y 15 polos.')).toBe(465);
    expect(needUnits('1.000 bolígrafos a 0,50 € y un stand de 60 m² con 5 comerciales')).toBe(1005);
    expect(needUnits('Material promocional y textil')).toBeNull();
  });

  it('budget_derived: unit price in band and need units inside the range (0,5 when need lists none)', async () => {
    expect(await run(budgetDerived, NAME, out())).toMatchObject({ score: 1, pass: true, details: { need_units: 260, unit_price_eur: 2.41 } });
    expect(await run(budgetDerived, NAME, out({ hypothesis: hyp({ need: 'Regalo promocional para visitantes.' }) }))).toMatchObject({ score: 0.5, pass: false });
    expect((await run(budgetDerived, NAME, out({ hypothesis: hyp({ need: 'Unas 900 bolsas.' }) })))?.score).toBe(0);
    expect((await run(budgetDerived, NAME, out({ hypothesis: hyp({ budget_min_eur: 20000, budget_max_eur: 40000 }) })))?.details.price_in_band).toBe(false);
  });

  it('source_urls_known (hard): every URL of the case must be in the ledger or the input', async () => {
    expect(sourceUrlsKnown.hard).toBe(true);
    expect(await run(sourceUrlsKnown, NAME, out())).toMatchObject({ pass: true, score: 1, details: { urls: 0 } });
    const known = out({ reason: 'Visto en https://apps.feriavalencia.com/catalog/gastronoma/exhibitors y en www.mybaos.example/quienes.', writtenUrls: ['https://mybaos.example'] });
    expect((await run(sourceUrlsKnown, NAME, known))?.pass).toBe(true);
    const invented = await run(sourceUrlsKnown, NAME, out({ hypothesis: hyp({ why_now: 'Según https://noticias-inventadas.example/mybaos lanzan producto.' }) }));
    expect(invented).toMatchObject({ pass: false, score: 0, details: { unknown: ['https://noticias-inventadas.example/mybaos'] } });
    const written = await run(sourceUrlsKnown, NAME, out({ writtenUrls: ['https://otra.example/x'] }));
    expect(written?.pass).toBe(false);
  });

  it('EXACT: compares one field with the dataset expectation', async () => {
    const e = makeExactEvaluator({ id: 'exact.relevant', version: 1, dimension: 'TASK_SUCCESS', field: 'relevant', expected: { 'MYBAOS SL': true } });
    expect((await run(e, NAME, out()))?.pass).toBe(true);
    expect((await run(e, NAME, out({ relevant: false })))?.pass).toBe(false);
    expect(await run(e, SECTOR, out())).toBeNull();
  });

  it('the rules reproduce the EXP-002 hand metrics on the real comparison', async () => {
    const { subjects, warnings } = subjectsFromComparison(EXP2, 'exp2', { baseDir: dirname(EXP2_PATH) });
    expect(warnings).toEqual([]);
    const report = await runEvaluationPipeline(subjects);
    const metrics = (EXP2.reports as Array<{ report: { metrics: Array<Record<string, unknown>> } }>).flatMap((r) => r.report.metrics);
    const sum = (v: number, f: (m: Record<string, unknown>) => number) => metrics.filter((m) => m.version === v).reduce((n, m) => n + f(m), 0);
    for (const v of [1, 3]) {
      const g = report.groups.find((x) => x.group === `v${v}`)!;
      const agg = (k: string) => g.aggregates.find((a) => a.key === k)!;
      expect(agg('rule.need_has_quantities@1').applicable - agg('rule.need_has_quantities@1').failures).toBe(sum(v, (m) => m.need_with_quantities as number));
      expect(agg('rule.quantity_spread_le_2_5@1').failures).toBe(sum(v, (m) => m.quantity_ratio_over_2_5 as number));
      expect(agg('rule.discard_confidence_low@1').failures).toBe(sum(v, (m) => m.irrelevant_high_confidence as number));
      const flagged = sum(v, (m) => (m.name_only_flagged_inference as { flagged: number }).flagged);
      expect(agg('rule.assumptions_marked@1').applicable - agg('rule.assumptions_marked@1').failures).toBe(flagged);
    }
  });
});

// ---------------------------------------------------------------------------
/** Answers like a judge: reads the untrusted block and scores each case (level 4 if need has units). */
class ScriptedJudge implements ModelProvider {
  readonly name = 'scripted-judge';
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly tweak: (items: Array<Record<string, unknown>>, attempt: number) => Array<Record<string, unknown>> = (x) => x) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const msg = request.messages[0]!.content;
    const json = msg.slice(msg.indexOf('{"casos"'), msg.lastIndexOf('}') + 1);
    const casos = (JSON.parse(json) as { casos: Array<{ id: string; salida: { razon: string; hipotesis?: { necesidad: string } } }> }).casos;
    const items = casos.map((c) => ({
      id: c.id,
      level: /\d/.test(c.salida.hipotesis?.necesidad ?? '') ? 4 : 2,
      justification: 'Desglose de unidades y plazo ligado al evento.',
      quote: c.salida.razon.split(' ').slice(0, 5).join(' '),
    }));
    const attempt = request.messages.filter((m) => m.role === 'assistant').length + 1;
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500, cachedTokens: 0 };
    return { text: JSON.stringify({ items: this.tweak(items, attempt) }), model: 'judge-served', provider: this.name, stopReason: 'stop', usage, cost: this.estimateCost(request.model, usage), latencyMs: 1 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'done', result };
  }
  estimateCost(_m: string, u: TokenUsage) {
    return { modelCost: (u.inputTokens * 2 + u.outputTokens * 12) / 1e6, currency: 'USD' };
  }
}

describe('LLM_JUDGE', () => {
  const cases = [
    { id: 'c1', input: NAME, output: out() },
    { id: 'c2', input: SECTOR, output: out({ reason: 'Fabricante líder de hornos profesionales.', hypothesis: hyp({ need: 'Material promocional para el stand.' }) }) },
  ];

  it('scores one dimension per call, from a closed rubric, with the content as untrusted data', async () => {
    const p = new ScriptedJudge();
    const j = new LlmJudgeEvaluator({ provider: p, rubric: NEXT_ACTION_QUALITY_RUBRIC });
    const r = await j.evaluateBatch(cases);
    expect(p.requests).toHaveLength(1);
    expect(r.outcomes.get('c1')).toMatchObject({ dimension: 'NEXT_ACTION_QUALITY', score: 1, details: { level: 4 } });
    expect(r.outcomes.get('c2')?.score).toBe(0.5);
    const req = p.requests[0]!;
    expect(req.model).toBe('gemini-pro-latest');
    expect(req.system).toContain('NEXT_ACTION_QUALITY');
    expect(req.system).toContain('Nivel 4');
    expect(req.system).not.toContain('MYBAOS');
    expect(req.messages[0]!.content).toContain(`<<<${UNTRUSTED_OPEN}`);
    expect(req.messages[0]!.content).not.toMatch(/\bv[13]\b/);
    expect(req.options).toMatchObject({ temperature: 0, thinkingLevel: 'low' });
    expect(r.calls[0]).toMatchObject({ attempts: 1, items: 2, servedModel: 'judge-served' });
    expect(r.calls[0]!.costEur).toBeCloseTo(((1000 * 2 + 500 * 12) / 1e6) * 0.86, 6);
  });

  it('retries once when a quote is not literal or a justification is too long, then gives up (no score)', async () => {
    const fixOnRetry = new ScriptedJudge((items, attempt) => (attempt === 1 ? items.map((i) => ({ ...i, quote: 'texto que no está en la salida' })) : items));
    const r1 = await new LlmJudgeEvaluator({ provider: fixOnRetry, rubric: NEXT_ACTION_QUALITY_RUBRIC }).evaluateBatch(cases);
    expect(fixOnRetry.requests).toHaveLength(2);
    expect(fixOnRetry.requests[1]!.messages.at(-1)!.content).toContain('no aparece literalmente');
    expect(r1.outcomes.size).toBe(2);
    expect(r1.calls[0]!.attempts).toBe(2);

    const neverOk = new ScriptedJudge((items) => items.map((i) => ({ ...i, justification: 'palabra '.repeat(51) })));
    const r2 = await new LlmJudgeEvaluator({ provider: neverOk, rubric: COMMERCIAL_RELEVANCE_RUBRIC }).evaluateBatch(cases);
    expect(neverOk.requests).toHaveLength(2);
    expect(r2.outcomes.size).toBe(0);
    expect(r2.errors.get('c1')).toContain('50 palabras');
  });

  it('rejects missing or invented ids and non-JSON answers', () => {
    const j = new LlmJudgeEvaluator({ provider: new StubProvider(), rubric: NEXT_ACTION_QUALITY_RUBRIC });
    expect(j.validate('no es json', cases)).toMatchObject({ ok: false });
    const v = j.validate(JSON.stringify({ items: [{ id: 'c9', level: 3, justification: 'x', quote: 'Por el nombre, parece' }] }), cases);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/id desconocido c9.*falta el id c1/);
    expect(j.validate(JSON.stringify({ items: [{ id: 'c1', level: 5, justification: 'x', quote: 'Por el nombre' }] }), cases).ok).toBe(false);
  });

  it('quotes: literal modulo case, quotes, whitespace and ellipses', () => {
    const o = out();
    expect(quoteFound('«por el nombre,  parece una empresa»', o)).toBe(true);
    expect(quoteFound('Unas 250 bolsas tote … personal del stand', o)).toBe(true);
    expect(quoteFound('Unas 300 bolsas', o)).toBe(false);
  });

  it('the judge must be a different model from the executor (aliases resolved)', () => {
    expect(() => assertDistinctJudge('gemini-pro-latest', ['gemini-flash-latest'])).not.toThrow();
    expect(() => assertDistinctJudge('gemini-flash-latest', ['gemini-3.8-flash'])).toThrow(/mismo modelo/);
  });

  it('JudgeBudgetProvider refuses a call whose projected cost would exceed the budget', async () => {
    const inner = new ScriptedJudge();
    const budget = new JudgeBudgetProvider(inner, 0.008, 0.86, 500);
    const j = new LlmJudgeEvaluator({ provider: budget, rubric: NEXT_ACTION_QUALITY_RUBRIC, maxItemsPerCall: 1 });
    const r = await j.evaluateBatch(cases);
    expect(r.outcomes.size).toBe(1);
    expect(r.errors.get('c2')).toContain('presupuesto del juez');
    expect(budget.exceeded).toBe(true);
    expect(budget.spentEur).toBeLessThanOrEqual(0.008);
  });
});

// ---------------------------------------------------------------------------
const agg = (key: string, dimension: EvaluatorAggregate['dimension'], score: number | null, over: Partial<EvaluatorAggregate> = {}): EvaluatorAggregate => ({
  key,
  type: 'RULE',
  dimension,
  hard: false,
  score,
  applicable: score === null ? 0 : 10,
  failures: 0,
  failedCases: [],
  errors: 0,
  ...over,
});

describe('COMPOSITE', () => {
  it('uses the LLD weights and redistributes the dimensions nobody evaluated', () => {
    const c = new CompositeEvaluator();
    const all = c.combine([
      agg('a', 'TASK_SUCCESS', 1),
      agg('b', 'FACTUALITY', 0.5),
      agg('c', 'SOURCE_QUALITY', 1),
      agg('d', 'CRM_CORRECTNESS', 1),
      agg('e', 'COMMERCIAL_RELEVANCE', 0),
      agg('f', 'NEXT_ACTION_QUALITY', 1),
    ]);
    expect(all.score).toBeCloseTo(0.3 + 0.1 + 0.15 + 0.15 + 0 + 0.1, 6);
    expect(all.verdict).toBe('PASS');
    const partial = c.combine([agg('a', 'TASK_SUCCESS', 1), agg('b', 'FACTUALITY', 0)]);
    expect(partial.score).toBeCloseTo(0.3 / 0.5, 6);
    expect(partial.missing).toEqual(['SOURCE_QUALITY', 'CRM_CORRECTNESS', 'COMMERCIAL_RELEVANCE', 'NEXT_ACTION_QUALITY']);
    expect(partial.thresholds_not_evaluated).toEqual(['CRM_CORRECTNESS', 'POLICY_COMPLIANCE']);
  });

  it('averages the evaluators of one dimension', () => {
    const r = new CompositeEvaluator().combine([agg('a', 'NEXT_ACTION_QUALITY', 1), agg('b', 'NEXT_ACTION_QUALITY', 0.5), agg('c', 'NEXT_ACTION_QUALITY', null)]);
    expect(r.dimensions.NEXT_ACTION_QUALITY).toMatchObject({ score: 0.75, evaluators: ['a', 'b'] });
  });

  it('a failing hard evaluator makes it FAIL whatever the score', () => {
    const r = new CompositeEvaluator().combine([
      agg('a', 'TASK_SUCCESS', 1),
      agg('b', 'FACTUALITY', 1),
      agg('rule.discard_confidence_low@1', 'COMMERCIAL_RELEVANCE', 0.9, { hard: true, failures: 1, failedCases: ['v3#DIPUTACIÓN'] }),
    ]);
    expect(r.score).toBeGreaterThan(0.95);
    expect(r).toMatchObject({ verdict: 'FAIL', passed: false, hard_failures: [{ evaluator: 'rule.discard_confidence_low@1', cases: ['v3#DIPUTACIÓN'] }] });
  });

  it('LLD dimension thresholds (CRM_CORRECTNESS >= 0,95) and an optional minimum score', () => {
    const c = new CompositeEvaluator();
    expect(c.combine([agg('a', 'TASK_SUCCESS', 1), agg('crm', 'CRM_CORRECTNESS', 0.9)]).threshold_failures).toEqual([{ dimension: 'CRM_CORRECTNESS', score: 0.9, threshold: 0.95 }]);
    const strict = new CompositeEvaluator({ minScore: 0.8 });
    expect(strict.combine([agg('a', 'TASK_SUCCESS', 0.7)])).toMatchObject({ verdict: 'FAIL', below_min_score: true });
    expect(() => new CompositeEvaluator({ weights: { TASK_SUCCESS: -1 } })).toThrow(/peso/);
  });
});

// ---------------------------------------------------------------------------
describe('pipeline on the EXP-002 comparison (scripted judge)', () => {
  it('reproduces the verdict: v3 >= v1, both without hard failures; the judge only sees repetition 1', async () => {
    const { subjects } = subjectsFromComparison(EXP2, 'exp2', { baseDir: dirname(EXP2_PATH) });
    const judge = new ScriptedJudge();
    const ev = defaultEvaluators({ judgeProvider: judge });
    const report = await runEvaluationPipeline(subjects, { rules: ev.rules, judges: ev.judges, composite: ev.composite });
    const [v1, v3] = ['v1', 'v3'].map((g) => report.groups.find((x) => x.group === g)!);
    expect(v1!.composite.hard_failures).toEqual([]);
    expect(v3!.composite.hard_failures).toEqual([]);
    expect(v3!.composite.verdict).toBe('PASS');
    expect(v3!.composite.score!).toBeGreaterThan(v1!.composite.score!);
    expect(v1!.composite.missing).toEqual(['CRM_CORRECTNESS']);
    // 10 hypotheses per version in repetition 1, two dimensions, one batch of 20 per dimension.
    expect(judge.requests).toHaveLength(2);
    expect(report.judge.calls.map((c) => c.items)).toEqual([20, 20]);
    const naq = v3!.aggregates.find((a) => a.key === 'judge.next_action_quality@1')!;
    expect(naq).toMatchObject({ applicable: 10, errors: 0, score: 1 });
  });

  it('a discard with confidence 0,95 (the v2 regression) makes that version FAIL', async () => {
    const tampered = JSON.parse(JSON.stringify(EXP2)) as { reports: Array<{ report: { runs: Array<{ version: number; decisions: Array<{ relevant: boolean; confidence: number }> }> } }> };
    const d = tampered.reports[0]!.report.runs.find((r) => r.version === 3)!.decisions.find((x) => x.relevant === false)!;
    d.confidence = 0.95;
    const { subjects } = subjectsFromComparison(tampered, 'tampered', { baseDir: dirname(EXP2_PATH) });
    const report = await runEvaluationPipeline(subjects);
    const v3 = report.groups.find((g) => g.group === 'v3')!;
    expect(v3.composite.verdict).toBe('FAIL');
    expect(v3.composite.hard_failures[0]!.evaluator).toBe('rule.discard_confidence_low@1');
    expect(report.groups.find((g) => g.group === 'v1')!.composite.verdict).toBe('PASS');
  });

  it('builds idempotent rows: same output -> same keys; kinds, feedback and no row for an incomplete judge', async () => {
    const { subjects } = subjectsFromComparison(EXP2, 'exp2', { baseDir: dirname(EXP2_PATH) });
    const ev = defaultEvaluators({ judgeProvider: new ScriptedJudge() });
    const a = evaluationRows(await runEvaluationPipeline(subjects, { ...ev }), 'experiments');
    const b = evaluationRows(await runEvaluationPipeline(subjects, { ...ev }), 'experiments');
    expect(a.map((r) => r.idempotencyKey)).toEqual(b.map((r) => r.idempotencyKey));
    expect(new Set(a.map((r) => r.idempotencyKey)).size).toBe(a.length);
    expect(new Set(a.map((r) => r.kind))).toEqual(new Set(['RULE', 'LLM_JUDGE', 'COMPOSITE']));
    expect(a.filter((r) => r.details?.scope === 'group')).toHaveLength(2);
    expect(a.every((r) => r.tenantId === 'experiments' && r.source === 'auto')).toBe(true);
    expect(a.filter((r) => r.kind === 'LLM_JUDGE').every((r) => r.feedback === 'SCORED')).toBe(true);
    expect(a.find((r) => r.evaluatorId === 'rule.need_has_quantities@1' && String(r.subjectId).includes('@v1:'))?.feedback).toBe('FAIL');

    const broken = defaultEvaluators({ judgeProvider: new ScriptedJudge((items) => items.map((i) => ({ ...i, quote: 'inventada del todo' }))) });
    const c = evaluationRows(await runEvaluationPipeline(subjects, { ...broken }), 'experiments');
    expect(c.some((r) => r.kind === 'LLM_JUDGE')).toBe(false);
    // r1 subjects with hypotheses lost their judge notes: no composite; the r1 subject with only discards keeps it.
    const withHyp = subjects.filter((s) => s.judgeEligible && s.cases.some((x) => x.output.hypothesis)).map((s) => s.subjectId);
    expect(withHyp).toHaveLength(4);
    expect(c.filter((r) => r.kind === 'COMPOSITE' && withHyp.includes(String(r.subjectId)))).toHaveLength(0);
    expect(c.filter((r) => r.kind === 'COMPOSITE' && String(r.subjectId).endsWith(':r1'))).toHaveLength(2);
    expect(c.filter((r) => r.kind === 'COMPOSITE' && String(r.subjectId).endsWith(':r2')).length).toBe(6);
  });

  it('refuses a judge that is the executor model', async () => {
    const { subjects } = subjectsFromComparison(EXP2, 'exp2', { baseDir: dirname(EXP2_PATH) });
    const ev = defaultEvaluators({ judgeProvider: new ScriptedJudge(), judgeModel: 'gemini-flash-latest' });
    await expect(runEvaluationPipeline(subjects, { ...ev })).rejects.toThrow(/mismo modelo/);
  });
});

describe('registry and versions', () => {
  it('registers by id@version, rejects duplicates and hashes the definition', () => {
    const { registry } = defaultEvaluators({ judgeProvider: new ScriptedJudge() });
    expect(registry.list()).toHaveLength(11);
    expect(registry.catalog().filter((e) => e.hard).map((e) => e.key)).toEqual(['rule.discard_confidence_low@1', 'rule.source_urls_known@1']);
    expect(() => new EvaluatorRegistry().register(needHasQuantities).register(needHasQuantities)).toThrow(/duplicado/);
    const changed = { ...quantitySpread, definition: { max_ratio: 3 } };
    expect(contentHashOf(changed)).not.toBe(contentHashOf(quantitySpread));
    const otherModel = new LlmJudgeEvaluator({ provider: new StubProvider(), rubric: NEXT_ACTION_QUALITY_RUBRIC, model: 'gemini-2.5-pro' });
    expect(contentHashOf(otherModel)).not.toBe(contentHashOf(new LlmJudgeEvaluator({ provider: new StubProvider(), rubric: NEXT_ACTION_QUALITY_RUBRIC })));
  });
});
