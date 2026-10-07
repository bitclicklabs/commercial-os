/**
 * Evaluation pipeline: RULEs (and EXACTs) -> LLM judge -> COMPOSITE, per subject and per
 * group (a version of a comparison pools all its subjects; the group composite is the
 * verdict that answers "is v3 at least as good as v1, without hard failures?").
 */
import { CompositeEvaluator, type CompositeResult, type EvaluatorAggregate } from './composite.js';
import { assertDistinctJudge, LlmJudgeEvaluator, type JudgeCall } from './judge.js';
import { RULE_EVALUATORS } from './rules.js';
import type { EvaluationSubject } from './subjects.js';
import { contentHashOf, evaluatorKey, sha256, type CaseEvaluator, type Dimension, type EvaluatorOutcome, type EvaluatorType } from './types.js';

export type CaseResult = { outcome: EvaluatorOutcome } | { notApplicable: true } | { error: string };

export interface EvaluatorRun {
  key: string;
  id: string;
  version: number;
  type: EvaluatorType;
  dimension: Dimension;
  hard: boolean;
  contentHash: string;
  /** Per case id. */
  cases: Map<string, CaseResult>;
  aggregate: EvaluatorAggregate;
  /** Judges only: the per-case results came from earlier persisted rows. */
  cached?: boolean;
}

export interface SubjectEvaluation {
  subject: EvaluationSubject;
  evaluators: EvaluatorRun[];
  composite: CompositeResult;
}

export interface GroupEvaluation {
  group: string;
  subjects: string[];
  cases: number;
  aggregates: EvaluatorAggregate[];
  composite: CompositeResult;
}

export interface JudgeReport {
  model: string | null;
  calls: Array<JudgeCall & { evaluator: string; group: string }>;
  cost_eur: number;
  budget_eur: number | null;
  budget_exceeded: boolean;
  errors: number;
  cached_cases: number;
}

export interface PipelineReport {
  generated_at: string;
  evaluators: Array<{ key: string; type: EvaluatorType; dimension: Dimension | null; hard: boolean; content_hash: string; description: string }>;
  subjects: SubjectEvaluation[];
  groups: GroupEvaluation[];
  judge: JudgeReport;
  composite: { key: string; content_hash: string; weights: Record<string, number>; thresholds: Record<string, number> };
  warnings: string[];
}

/** Judge results already stored, keyed by subject id, then judge key, then case id. */
export type JudgeCache = Map<string, Map<string, Map<string, EvaluatorOutcome>>>;

export interface BudgetState {
  spentEur: number;
  maxEur: number;
  exceeded: boolean;
}

export interface PipelineOptions {
  rules?: readonly CaseEvaluator[];
  judges?: readonly LlmJudgeEvaluator[];
  composite?: CompositeEvaluator;
  /** The guard the judges' provider is wrapped in (to report spent/exceeded). */
  budget?: BudgetState;
  judgeCache?: JudgeCache;
  onProgress?: (msg: string) => void;
  now?: () => Date;
}

function aggregateOf(meta: { key: string; type: EvaluatorType; dimension: Dimension; hard: boolean }, results: Array<[string, CaseResult]>): EvaluatorAggregate {
  const scored = results.filter((r): r is [string, { outcome: EvaluatorOutcome }] => 'outcome' in r[1]);
  const failed = scored.filter(([, r]) => r.outcome.pass === false).map(([id]) => id);
  return {
    key: meta.key,
    type: meta.type,
    dimension: meta.dimension,
    hard: meta.hard,
    score: scored.length ? Math.round((scored.reduce((n, [, r]) => n + r.outcome.score, 0) / scored.length) * 10000) / 10000 : null,
    applicable: scored.length,
    failures: failed.length,
    failedCases: failed,
    errors: results.filter(([, r]) => 'error' in r).length,
  };
}

const metaOf = (e: CaseEvaluator) => ({ key: evaluatorKey(e), id: e.id, version: e.version, type: e.type, dimension: e.dimension, hard: e.hard, contentHash: contentHashOf(e) });

export async function runEvaluationPipeline(subjects: EvaluationSubject[], opts: PipelineOptions = {}): Promise<PipelineReport> {
  const rules = opts.rules ?? RULE_EVALUATORS;
  const judges = opts.judges ?? [];
  const composite = opts.composite ?? new CompositeEvaluator();
  const warnings: string[] = [];
  for (const j of judges) assertDistinctJudge(j.model, [...new Set(subjects.map((s) => s.executorModel))]);

  // 1. RULE / EXACT: deterministic, every case of every subject.
  const runs = new Map<string, EvaluatorRun[]>();
  for (const s of subjects) {
    const list: EvaluatorRun[] = [];
    for (const r of rules) {
      const cases = new Map<string, CaseResult>();
      for (const c of s.cases) {
        try {
          const o = await r.evaluate(c.input, c.output, s.context);
          cases.set(c.id, o ? { outcome: o } : { notApplicable: true });
        } catch (err) {
          cases.set(c.id, { error: String((err as Error).message ?? err) });
        }
      }
      const m = metaOf(r);
      list.push({ ...m, cases, aggregate: aggregateOf(m, [...cases]) });
    }
    runs.set(s.subjectId, list);
  }
  opts.onProgress?.(`reglas: ${rules.length} evaluadores × ${subjects.reduce((n, s) => n + s.cases.length, 0)} casos`);

  // 2. LLM_JUDGE: one dimension per call. The cases of every group go into the same batches,
  // in a deterministic pseudo-random order (no version label, no adjacent pairs), so a
  // budget cut or a failed call hits every group alike and the judge cannot tell versions.
  const judgeCalls: JudgeReport['calls'] = [];
  let judgeErrors = 0;
  let cachedCases = 0;
  const groups = [...new Set(subjects.map((s) => s.group))];
  for (const j of judges) {
    const m = metaOf(j);
    const perSubject = new Map<string, Map<string, CaseResult>>();
    for (const s of subjects) perSubject.set(s.subjectId, new Map(s.cases.map((c) => [c.id, j.applies(c.output) && s.judgeEligible ? ({ error: 'pendiente' } as CaseResult) : ({ notApplicable: true } as CaseResult)])));
    const todo: Array<{ order: string; subject: EvaluationSubject; caseId: string; input: EvaluationSubject['cases'][number]['input']; output: EvaluationSubject['cases'][number]['output'] }> = [];
    for (const s of subjects.filter((x) => x.judgeEligible)) {
      const cache = opts.judgeCache?.get(s.subjectId)?.get(m.key);
      for (const c of s.cases) {
        if (!j.applies(c.output)) continue;
        const hit = cache?.get(c.id);
        if (hit) {
          perSubject.get(s.subjectId)!.set(c.id, { outcome: hit });
          cachedCases++;
          continue;
        }
        todo.push({ order: sha256(`${m.key}|${s.subjectId}|${c.id}`), subject: s, caseId: c.id, input: c.input, output: c.output });
      }
    }
    todo.sort((a, b) => a.order.localeCompare(b.order));
    for (let i = 0; i < todo.length; i += j.maxItemsPerCall) {
      const chunk = todo.slice(i, i + j.maxItemsPerCall).map((t, k) => ({ ...t, short: `c${k + 1}` }));
      if (opts.budget?.exceeded) {
        for (const t of chunk) perSubject.get(t.subject.subjectId)!.set(t.caseId, { error: 'presupuesto del juez agotado' });
        judgeErrors += chunk.length;
        continue;
      }
      const label = [...new Set(chunk.map((t) => t.subject.group))].join('+');
      opts.onProgress?.(`juez ${m.key} · ${chunk.length} casos (${label})`);
      const r = await j.evaluateBatch(chunk.map((t) => ({ id: t.short, input: t.input, output: t.output })));
      for (const c of r.calls) judgeCalls.push({ ...c, evaluator: m.key, group: label });
      for (const t of chunk) {
        const o = r.outcomes.get(t.short);
        const e = r.errors.get(t.short);
        perSubject.get(t.subject.subjectId)!.set(t.caseId, o ? { outcome: o } : { error: e ?? 'sin respuesta del juez' });
        if (!o) judgeErrors++;
      }
    }
    for (const s of subjects) {
      const cases = perSubject.get(s.subjectId)!;
      const cached = [...cases.values()].length > 0 && opts.judgeCache?.get(s.subjectId)?.has(m.key) === true;
      runs.get(s.subjectId)!.push({ ...m, cases, aggregate: aggregateOf(m, [...cases]), ...(cached ? { cached } : {}) });
    }
  }

  // 3. COMPOSITE per subject and per group (pooled cases).
  const subjectEvals: SubjectEvaluation[] = subjects.map((s) => {
    const evs = runs.get(s.subjectId)!;
    return { subject: s, evaluators: evs, composite: composite.combine(evs.map((e) => e.aggregate)) };
  });
  const groupEvals: GroupEvaluation[] = groups.map((g) => {
    const mine = subjectEvals.filter((x) => x.subject.group === g);
    const keys = mine[0]?.evaluators.map((e) => e.key) ?? [];
    const aggregates = keys.map((key) => {
      const first = mine[0]!.evaluators.find((e) => e.key === key)!;
      const results = mine.flatMap((x) => [...(x.evaluators.find((e) => e.key === key)?.cases ?? new Map<string, CaseResult>())].map(([id, r]) => [`${x.subject.subjectId}#${id}`, r] as [string, CaseResult]));
      return aggregateOf(first, results);
    });
    return { group: g, subjects: mine.map((x) => x.subject.subjectId), cases: mine.reduce((n, x) => n + x.subject.cases.length, 0), aggregates, composite: composite.combine(aggregates) };
  });

  const missingJudge = judges.filter((j) => groupEvals.some((g) => g.aggregates.find((a) => a.key === evaluatorKey(j))?.score === null) && groupEvals.some((g) => g.aggregates.find((a) => a.key === evaluatorKey(j))?.score !== null));
  for (const j of missingJudge) warnings.push(`el juez ${evaluatorKey(j)} puntuó unos grupos y otros no: los composites de grupo no son comparables en ${j.dimension}`);

  const catalog: PipelineReport['evaluators'] = [...rules, ...judges].map((e) => ({ key: evaluatorKey(e), type: e.type, dimension: e.dimension, hard: e.hard, content_hash: contentHashOf(e), description: e.description }));
  catalog.push({ key: evaluatorKey(composite), type: composite.type, dimension: null, hard: false, content_hash: contentHashOf(composite), description: composite.description });
  return {
    generated_at: (opts.now ?? (() => new Date()))().toISOString(),
    evaluators: catalog,
    subjects: subjectEvals,
    groups: groupEvals,
    judge: {
      model: judges[0]?.model ?? null,
      calls: judgeCalls,
      cost_eur: Math.round(judgeCalls.reduce((n, c) => n + c.costEur, 0) * 1e6) / 1e6,
      budget_eur: opts.budget?.maxEur ?? null,
      budget_exceeded: opts.budget?.exceeded ?? false,
      errors: judgeErrors,
      cached_cases: cachedCases,
    },
    composite: { key: evaluatorKey(composite), content_hash: contentHashOf(composite), weights: composite.config.weights as Record<string, number>, thresholds: composite.config.thresholds as Record<string, number> },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Report (Spanish markdown)
// ---------------------------------------------------------------------------

const num = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderEvaluationMarkdown(r: PipelineReport, title = 'Evaluación automática'): string {
  const L: string[] = [];
  const groups = r.groups;
  L.push(`### ${title}`, '');
  L.push(`- Generado: ${r.generated_at}. Composite: \`${r.composite.key}\` (\`${r.composite.content_hash.slice(0, 12)}\`).`);
  L.push(`- Juez: ${r.judge.model ?? 'sin juez'} · ${r.judge.calls.length} llamadas · ${num(r.judge.cost_eur, 4)} €${r.judge.budget_eur !== null ? ` de ${num(r.judge.budget_eur, 2)} €` : ''}${r.judge.budget_exceeded ? ' (**presupuesto agotado**)' : ''} · ${r.judge.errors} casos sin nota del juez${r.judge.cached_cases ? ` · ${r.judge.cached_cases} casos reutilizados de evaluaciones guardadas` : ''}.`);
  for (const w of r.warnings) L.push(`- Aviso: ${w}`);
  L.push('');
  L.push(`| | ${groups.map((g) => g.group).join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`);
  L.push(`| **Veredicto** | ${groups.map((g) => `**${g.composite.verdict}**`).join(' | ')} |`);
  L.push(`| **Score compuesto** | ${groups.map((g) => `**${num(g.composite.score, 3)}**`).join(' | ')} |`);
  L.push(`| Restricciones duras incumplidas | ${groups.map((g) => (g.composite.hard_failures.length ? g.composite.hard_failures.map((h) => `${h.evaluator} (${h.cases.length})`).join(', ') : 'ninguna')).join(' | ')} |`);
  L.push(`| Casos | ${groups.map((g) => g.cases).join(' | ')} |`);
  const dims = [...new Set(groups.flatMap((g) => Object.keys(g.composite.dimensions)))] as Dimension[];
  for (const d of dims) L.push(`| ${d} (peso efectivo) | ${groups.map((g) => (g.composite.dimensions[d] ? `${num(g.composite.dimensions[d]!.score, 3)} (${num(g.composite.dimensions[d]!.effective_weight, 3)})` : '—')).join(' | ')} |`);
  const missing = [...new Set(groups.flatMap((g) => g.composite.missing))];
  if (missing.length) L.push(`| Sin evaluar (peso redistribuido) | ${groups.map((g) => g.composite.missing.join(', ') || '—').join(' | ')} |`);
  L.push('', '#### Por evaluador', '');
  L.push(`| Evaluador | Tipo | Dimensión | Dura | ${groups.map((g) => `${g.group}: score · fallos/aplicables`).join(' | ')} |`, `|---|---|---|---|${groups.map(() => '---').join('|')}|`);
  const keys = groups[0]?.aggregates.map((a) => a.key) ?? [];
  for (const k of keys) {
    const a0 = groups[0]!.aggregates.find((a) => a.key === k)!;
    L.push(
      `| \`${k}\` | ${a0.type} | ${a0.dimension} | ${a0.hard ? 'sí' : 'no'} | ${groups
        .map((g) => {
          const a = g.aggregates.find((x) => x.key === k)!;
          return a.applicable === 0 ? `— (${a.errors ? `${a.errors} errores` : 'no aplica'})` : `${num(a.score, 3)} · ${a.failures}/${a.applicable}${a.errors ? ` (+${a.errors} sin nota)` : ''}`;
        })
        .join(' | ')} |`,
    );
  }
  L.push('', '#### Por sujeto', '');
  L.push('| Sujeto | Veredicto | Score | Duras incumplidas |', '|---|---|---|---|');
  for (const s of r.subjects) L.push(`| ${cell(s.subject.label)} | ${s.composite.verdict} | ${num(s.composite.score, 3)} | ${s.composite.hard_failures.map((h) => h.evaluator).join(', ') || '—'} |`);
  const judgeRuns = r.subjects.flatMap((s) => s.evaluators.filter((e) => e.type === 'LLM_JUDGE').flatMap((e) => [...e.cases].filter(([, c]) => 'outcome' in c).map(([id, c]) => ({ s, e, id, o: (c as { outcome: EvaluatorOutcome }).outcome }))));
  if (judgeRuns.length) {
    L.push('', '#### Notas del juez', '');
    L.push('| Sujeto | Caso | Dimensión | Nivel | Justificación | Cita |', '|---|---|---|---|---|---|');
    for (const j of judgeRuns) L.push(`| ${cell(j.s.subject.label)} | ${cell(j.id.replace(/^\d+:/, ''))} | ${j.e.dimension} | ${String(j.o.details.level)} | ${cell(String(j.o.details.justification))} | «${cell(String(j.o.details.quote))}» |`);
  }
  if (r.judge.calls.length) {
    L.push('', '#### Llamadas al juez', '');
    L.push('| Evaluador | Grupo | Modelo servido | Casos | Intentos | Tokens entrada / salida | Coste |', '|---|---|---|---|---|---|---|');
    for (const c of r.judge.calls) L.push(`| \`${c.evaluator}\` | ${c.group} | ${c.servedModel} | ${c.items} | ${c.attempts} | ${c.usage.inputTokens} / ${c.usage.outputTokens} | ${num(c.costEur, 4)} €${c.error ? ` (error: ${cell(c.error).slice(0, 120)})` : ''} |`);
  }
  return L.join('\n');
}
