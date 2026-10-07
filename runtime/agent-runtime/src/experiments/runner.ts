/**
 * Experiment runner (LLD v0.1 sections 11.5-11.6, P5): what EXP-001 and EXP-002 did by hand,
 * as one automatic run. `pnpm experiment:run` is the CLI (scripts/experiment-run.ts).
 *
 *  1. Creates EXP-NNN (DRAFT) with an immutable config: subject, baseline (the ACTIVE version)
 *     and candidate (with their content hashes), dataset, budget, repetitions, evaluators and
 *     gate criteria. -> RUNNING.
 *  2. Reserves the cases through the datasets service: the VALIDATION split the experiment may
 *     use, marked `validation` with `markUsed` BEFORE anything runs. A 409 (P5 contamination)
 *     aborts the experiment (FAILED). In form mode (no labelled case) it can add a "form sample":
 *     unburned TRAIN cases, as many as the budget allows, marked `validation` too.
 *  3. Runs baseline and candidate on those cases with the skill:compare machinery (real
 *     provider, a fresh in-memory CRM per run, repetitions alternating the order).
 *  4. Evaluates with the evaluation pipeline (RULEs, LLM judge inside its budget, COMPOSITE)
 *     and stores the evaluations in the `experiments` tenant.
 *  5. Release Gate on VALIDATION. Only a strict PASS (labelled cases) reserves and runs TEST
 *     (marked `test`); the final decision is the weakest of the phases. A PASS_FORM does not
 *     spend TEST unless asked (`testOnForm`): TEST is the last clean data.
 *  6. Writes the report (callback) and completes the experiment: COMPLETED, immutable.
 *
 * It never activates anything and never writes to Twenty: the tools are whatever `makeTools`
 * returns (the CLI injects FakeTwenty).
 */
import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { readConfig } from '../agents/prospector-core.js';
import type { Db } from '../db/client.js';
import { type EvaluationCase, type Experiment, type ExperimentDecision } from '../db/schema.js';
import { toCompareInputs } from '../datasets/fixtures.js';
import { DatasetServiceError, listCases, listDatasets, markUsed, requireDataset } from '../datasets/service.js';
import { evaluationDatasets } from '../db/schema.js';
import { DEFAULT_EXPERIMENTS_TENANT, defaultEvaluators, JudgeBudgetProvider, persistEvaluations, runEvaluationPipeline, subjectsFromComparison, type PipelineReport } from '../evaluators/index.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import { BudgetGuardProvider, COMPARABLE_SKILLS, runSkillComparison, type CompareAgentVersion, type CompareVersion, type ComparisonReport } from '../skills/compare.js';
import { renderSkill } from '../skills/render.js';
import { findSkill, listVersions } from '../skills/service.js';
import type { AgentToolbox } from '../tools/executor.js';
import { combineDecisions, evaluateGate, type GateConfig, type GateResult } from './gate.js';
import { isLabeled, phaseIncomplete, versionPhaseMetrics, type PhaseFixture, type PhaseOutcome, type VersionPhaseMetrics } from './metrics.js';
import { closeExperiment, completeExperiment, createExperiment, recordProgress, startExperiment } from './service.js';

export const RUNNER_VERSION = 1;
/** Executor cost estimate per decision (EXP-002: 0,0021 € v3) used to size the form sample. */
export const DEFAULT_EUR_PER_DECISION = 0.0025;
const MAX_CASES_PER_PHASE = 50;

export type PhaseName = 'VALIDATION' | 'TEST';

export class ExperimentAbortedError extends Error {
  constructor(
    readonly code: 'contamination' | 'no_cases' | 'invalid' | 'cancelled',
    message: string,
    readonly experiment: Experiment | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExperimentAbortedError';
  }
}

export interface RunnerDeps {
  db: Db;
  /** Executor provider (Gemini in the CLI); wrapped here in the shared executor budget. */
  executorProvider: ModelProvider;
  /** Judge provider; without it there is no LLM_JUDGE (the composite redistributes its weight). */
  judgeProvider?: ModelProvider | null;
  judgeModel?: string;
  /** A fresh toolbox per run (FakeTwenty in the CLI). */
  makeTools: (runLabel: string) => AgentToolbox;
  agentVersion: CompareAgentVersion;
  /** "Today" the agent sees. */
  now?: () => Date;
  onProgress?: (msg: string) => void;
  /** Tenant of the stored evaluations (default `experiments`, as `pnpm evaluate`). */
  evaluationsTenant?: string;
  /** Store the evaluations (default true). */
  persistEvaluations?: boolean;
  /** Writes the report files before the experiment is closed; returns the paths to record. */
  writeArtifacts?: (report: ExperimentReport) => Promise<Record<string, string>> | Record<string, string>;
  signal?: AbortSignal;
  /** Test seam: runs after a split is listed and before its cases are marked (simulates a concurrent experiment). */
  beforeMark?: (phase: PhaseName, caseIds: string[]) => Promise<void>;
}

export interface RunOptions {
  tenantId: string;
  subjectName: string;
  candidateVersion: number;
  /** Dataset name (latest ACTIVE version, else the latest) or uuid. */
  dataset: string;
  /** Total budget (executor + judge), EUR. */
  budgetEur: number;
  /** Judge share of the budget (default a third of the total). */
  judgeBudgetEur?: number;
  repeat?: number;
  /** TRAIN cases (unburned) added in form mode: a number, 'auto' (what the budget allows) or 0. */
  formSample?: number | 'auto';
  /** Spend TEST after a PASS_FORM too (default false: only after a strict PASS). */
  testOnForm?: boolean;
  gate: GateConfig;
  judge?: boolean;
  createdBy?: string;
  eurPerDecision?: number;
}

export interface PhaseCase {
  id: string;
  entity_key: string;
  exhibitor: string;
  split: string;
  /** `validation`/`test`, and `form_sample` for TRAIN cases added in form mode. */
  use: 'validation' | 'test' | 'form_sample';
  labeled: boolean;
  kind: string;
  difficulty: string | null;
}

export interface PhaseReport {
  phase: PhaseName;
  cases: PhaseCase[];
  skipped_cases: string[];
  mark_used: Array<{ role: string; marked: number; already: number; newly_burned: number; note: string }>;
  fixtures: PhaseFixture[];
  reports: ComparisonReport[];
  pipeline: PipelineReport;
  versions: VersionPhaseMetrics[];
  gate: GateResult;
  executor_cost_eur: number;
  judge_cost_eur: number;
  evaluations: { tenant: string; inserted: number; existing: number; rows: number } | null;
}

export interface ExperimentReport {
  experiment: Pick<Experiment, 'id' | 'name' | 'tenantId' | 'subjectType' | 'subjectName' | 'baselineVersion' | 'candidateVersion' | 'createdBy'>;
  config: Record<string, unknown>;
  phases: PhaseReport[];
  /** TEST not run and why. */
  test_skipped: string | null;
  decision: ExperimentDecision;
  mode: 'labeled' | 'form';
  summary: string;
  cost: { executor_eur: number; judge_eur: number; total_eur: number; budget_eur: number };
  started_at: string;
  finished_at: string;
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveDataset(db: Db, tenantId: string, key: string) {
  if (UUID_RE.test(key)) return requireDataset(db, tenantId, key);
  const all = await listDatasets(db, { tenantId, name: key });
  const pick = all.find((d) => d.status === 'ACTIVE') ?? all.filter((d) => d.status !== 'ARCHIVED')[0] ?? null;
  if (!pick) throw new ExperimentAbortedError('invalid', `no hay dataset "${key}" (ni ACTIVE ni DRAFT) en el tenant ${tenantId}`, null);
  return pick;
}

async function resolveVersions(db: Db, tenantId: string, skillName: string, candidate: number): Promise<{ baseline: CompareVersion; candidate: CompareVersion }> {
  if (!(COMPARABLE_SKILLS as readonly string[]).includes(skillName)) throw new ExperimentAbortedError('invalid', `no hay runner para la skill "${skillName}" (soportadas: ${COMPARABLE_SKILLS.join(', ')})`, null);
  const skill = await findSkill(db, tenantId, skillName);
  if (!skill) throw new ExperimentAbortedError('invalid', `la skill ${skillName} no existe en el tenant ${tenantId}`, null);
  const versions = await listVersions(db, skill.id);
  const active = versions.find((v) => v.status === 'ACTIVE');
  if (!active) throw new ExperimentAbortedError('invalid', `la skill ${skillName} no tiene versión ACTIVE (la baseline del experimento)`, null);
  const cand = versions.find((v) => v.version === candidate);
  if (!cand) throw new ExperimentAbortedError('invalid', `la skill ${skillName} no tiene versión ${candidate} (hay: ${versions.map((v) => v.version).join(', ')})`, null);
  if (cand.id === active.id) throw new ExperimentAbortedError('invalid', `v${candidate} ya es la versión ACTIVE: no hay nada que decidir`, null);
  const toCompare = (v: typeof cand): CompareVersion => ({
    version: v.version,
    status: v.status,
    skillVersionId: v.id,
    text: renderSkill({ instructions: v.instructions, constraints: v.constraints, examples: v.examples, antiPatterns: v.antiPatterns }),
    contentHash: v.contentHash,
  });
  return { baseline: toCompare(active), candidate: toCompare(cand) };
}

function phaseCase(c: EvaluationCase, use: PhaseCase['use']): PhaseCase {
  const ex = (c.input.exhibitor ?? {}) as { name?: string };
  return { id: c.id, entity_key: c.entityKey, exhibitor: String(ex.name ?? c.entityKey), split: c.split, use, labeled: isLabeled(c.expected), kind: String(c.expected.kind ?? 'unlabeled'), difficulty: c.difficulty };
}

/** Deterministic, unbiased pick of TRAIN cases nobody has used (order by hash of experiment + entity). */
export function pickFormSample(train: readonly EvaluationCase[], experiment: string, n: number): EvaluationCase[] {
  if (n <= 0) return [];
  return train
    .filter((c) => c.usedBy.length === 0)
    .map((c) => ({ c, k: sha(`${experiment}\u0000${c.entityKey}`) }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .slice(0, n)
    .map((x) => x.c);
}

/** Form sample size the executor budget allows (keeps 20 % of it as margin). */
export function autoFormSampleSize(executorBudgetEur: number, eurPerDecision: number, repeat: number, alreadyCases: number): number {
  const total = Math.floor((executorBudgetEur * 0.8) / (eurPerDecision * 2 * repeat));
  return Math.max(0, Math.min(total, MAX_CASES_PER_PHASE) - alreadyCases);
}

export async function runExperiment(deps: RunnerDeps, opts: RunOptions): Promise<{ experiment: Experiment; report: ExperimentReport }> {
  const { db } = deps;
  const log = deps.onProgress ?? (() => undefined);
  const repeat = Math.max(1, Math.min(5, Math.floor(opts.repeat ?? 2)));
  if (!(opts.budgetEur > 0)) throw new ExperimentAbortedError('invalid', 'el presupuesto debe ser > 0', null);
  const useJudge = opts.judge !== false && !!deps.judgeProvider;
  const judgeBudgetEur = useJudge ? round(opts.judgeBudgetEur ?? opts.budgetEur / 3, 4) : 0;
  const executorBudgetEur = round(opts.budgetEur - judgeBudgetEur, 4);
  if (!(executorBudgetEur > 0)) throw new ExperimentAbortedError('invalid', 'el presupuesto del juez no deja nada al ejecutor', null);
  const evaluationsTenant = deps.evaluationsTenant ?? DEFAULT_EXPERIMENTS_TENANT;
  const cfg = readConfig(deps.agentVersion.configuration);
  const now = deps.now ?? (() => new Date());

  const versions = await resolveVersions(db, opts.tenantId, opts.subjectName, opts.candidateVersion);
  const dataset = await resolveDataset(db, opts.tenantId, opts.dataset);
  const guard = new BudgetGuardProvider(deps.executorProvider, executorBudgetEur, cfg.usdToEur);
  const judgeBudget = useJudge ? new JudgeBudgetProvider(deps.judgeProvider!, judgeBudgetEur, DEFAULT_USD_TO_EUR) : null;
  const ev = defaultEvaluators({ ...(judgeBudget ? { judgeProvider: judgeBudget } : {}), ...(deps.judgeModel ? { judgeModel: deps.judgeModel } : {}) });

  const config: Record<string, unknown> = {
    runner_version: RUNNER_VERSION,
    subject: { type: 'skill', name: opts.subjectName },
    baseline: { version: versions.baseline.version, version_id: versions.baseline.skillVersionId, content_hash: versions.baseline.contentHash, status: versions.baseline.status },
    candidate: { version: versions.candidate.version, version_id: versions.candidate.skillVersionId, content_hash: versions.candidate.contentHash, status: versions.candidate.status },
    dataset: { id: dataset.id, name: dataset.name, version: dataset.version, status: dataset.status },
    budget_eur: opts.budgetEur,
    executor_budget_eur: executorBudgetEur,
    judge_budget_eur: judgeBudgetEur,
    repeat,
    form_sample: opts.formSample ?? 'auto',
    test_on_form: opts.testOnForm ?? false,
    eur_per_decision_estimate: opts.eurPerDecision ?? DEFAULT_EUR_PER_DECISION,
    today: now().toISOString().slice(0, 10),
    executor: { model: deps.agentVersion.model, provider: deps.executorProvider.name, min_confidence: cfg.minConfidence },
    judge: useJudge ? { model: ev.judges[0]?.model ?? null, provider: deps.judgeProvider!.name } : null,
    evaluators: ev.registry.catalog().map((e) => ({ key: e.key, type: e.type, dimension: e.dimension, hard: e.hard, content_hash: e.content_hash })),
    gate: opts.gate,
    evaluations_tenant: evaluationsTenant,
  };

  let exp = await createExperiment(db, {
    tenantId: opts.tenantId,
    subjectType: 'skill',
    subjectName: opts.subjectName,
    baselineVersion: versions.baseline.version,
    candidateVersion: versions.candidate.version,
    datasetId: dataset.id,
    config,
    createdBy: opts.createdBy ?? 'experiment:run',
  });
  log(`${exp.name}: ${opts.subjectName} v${versions.baseline.version} (ACTIVE) vs v${versions.candidate.version} · dataset ${dataset.name} v${dataset.version} · presupuesto ${opts.budgetEur} € (ejecutor ${executorBudgetEur} €, juez ${judgeBudgetEur} €)`);
  exp = await startExperiment(db, exp.id);
  const startedAt = new Date();
  const splits: Record<string, unknown> = {};
  const phases: PhaseReport[] = [];
  const costs = () => ({ executor_eur: round(guard.spentEur), judge_eur: round(judgeBudget?.spentEur ?? 0), total_eur: round(guard.spentEur + (judgeBudget?.spentEur ?? 0)), budget_eur: opts.budgetEur });
  const checkCancel = () => {
    if (deps.signal?.aborted) throw new ExperimentAbortedError('cancelled', 'experimento cancelado', exp);
  };

  /** Reserves (markUsed) the cases of one phase. Throws ExperimentAbortedError('contamination') on a 409. */
  const reserve = async (phase: PhaseName): Promise<{ cases: EvaluationCase[]; meta: PhaseCase[]; marks: PhaseReport['mark_used'] }> => {
    const role = phase === 'VALIDATION' ? 'validation' : 'test';
    const { items } = await listCases(db, { tenantId: opts.tenantId, datasetId: dataset.id, split: phase, experiment: exp.name, role });
    const held = items.slice(0, MAX_CASES_PER_PHASE);
    const marks: PhaseReport['mark_used'] = [];
    if (deps.beforeMark && held.length > 0) await deps.beforeMark(phase, held.map((c) => c.id));
    const mark = async (cases: EvaluationCase[], note: string) => {
      if (cases.length === 0) return;
      try {
        const r = await markUsed(db, { tenantId: opts.tenantId, datasetId: dataset.id, caseIds: cases.map((c) => c.id), experiment: exp.name, role, by: opts.createdBy ?? 'experiment:run', note });
        marks.push({ role, marked: r.marked.length, already: r.already.length, newly_burned: r.newly_burned.length, note });
      } catch (err) {
        if (err instanceof DatasetServiceError && err.code === 'conflict') throw new ExperimentAbortedError('contamination', `P5: ${err.message}`, exp, err.details);
        throw err;
      }
    };
    await mark(held, `${exp.name} ${phase}: v${versions.baseline.version} vs v${versions.candidate.version}`);
    const meta = held.map((c) => phaseCase(c, role));
    let cases: EvaluationCase[] = [...held];
    const labeled = held.filter((c) => isLabeled(c.expected)).length;
    if (phase === 'VALIDATION' && labeled === 0 && opts.formSample !== 0) {
      const n = opts.formSample === 'auto' || opts.formSample === undefined ? autoFormSampleSize(executorBudgetEur, opts.eurPerDecision ?? DEFAULT_EUR_PER_DECISION, repeat, held.length) : Math.min(opts.formSample, MAX_CASES_PER_PHASE - held.length);
      if (n > 0) {
        const train = await listCases(db, { tenantId: opts.tenantId, datasetId: dataset.id, split: 'TRAIN', experiment: exp.name, role: 'validation', includeVetoed: true });
        const sample = pickFormSample(train.items, exp.name, n);
        await mark(sample, `${exp.name} muestra de forma (TRAIN sin quemar; el gate no la usa para accuracy)`);
        cases = [...cases, ...sample];
        meta.push(...sample.map((c) => phaseCase(c, 'form_sample')));
      }
    }
    return { cases, meta, marks };
  };

  const runPhase = async (phase: PhaseName, reserved: Awaited<ReturnType<typeof reserve>>): Promise<PhaseReport> => {
    const { fixtures: raw, skipped } = toCompareInputs(reserved.cases.map((c) => ({ id: c.id, input: c.input })));
    const fixtures: PhaseFixture[] = raw.map((f, i) => ({ name: `${exp.name}/${phase.toLowerCase()}-${i + 1}`, input: { event: f.event, exhibitors: f.exhibitors }, case_ids: f.case_ids }));
    const executorBefore = guard.spentEur;
    const judgeBefore = judgeBudget?.spentEur ?? 0;
    const reports: ComparisonReport[] = [];
    for (const f of fixtures) {
      checkCancel();
      if (guard.exceeded) break;
      reports.push(
        await runSkillComparison({
          skillName: opts.subjectName,
          versions: [versions.baseline, versions.candidate],
          input: f.input,
          provider: deps.executorProvider,
          budget: guard,
          makeTools: deps.makeTools,
          agentVersion: deps.agentVersion,
          repeat,
          now,
          tenantId: opts.tenantId,
          onProgress: (m) => log(`${phase} ${f.name}: ${m}`),
        }),
      );
    }
    checkCancel();
    const saved = { skill: opts.subjectName, reports: reports.map((report, i) => ({ fixture: fixtures[i]!.name, report })) };
    const loaded = subjectsFromComparison(saved, `${exp.name}:${phase}`, { minConfidence: cfg.minConfidence, fixtureInputs: Object.fromEntries(fixtures.map((f) => [f.name, f.input])) });
    const pipeline = await runEvaluationPipeline(loaded.subjects, { rules: ev.rules, judges: ev.judges, composite: ev.composite, ...(judgeBudget ? { budget: judgeBudget } : {}), onProgress: (m) => log(`${phase} evaluación: ${m}`) });
    pipeline.warnings.unshift(...loaded.warnings);
    let evaluations: PhaseReport['evaluations'] = null;
    if (deps.persistEvaluations !== false && loaded.subjects.length > 0) {
      const p = await persistEvaluations(db, pipeline, evaluationsTenant);
      evaluations = { tenant: evaluationsTenant, ...p };
    }
    const outcome: PhaseOutcome = {
      fixtures,
      reports,
      pipeline,
      expected: new Map(reserved.cases.map((c) => [c.id, c.expected])),
      accuracyCaseIds: new Set(reserved.meta.filter((m) => m.use !== 'form_sample').map((m) => m.id)),
      executorBudgetExceeded: guard.exceeded,
    };
    const vb = versionPhaseMetrics(versions.baseline.version, outcome);
    const vc = versionPhaseMetrics(versions.candidate.version, outcome);
    const gate = evaluateGate({ baseline: vb, candidate: vc, incomplete: phaseIncomplete(outcome, [versions.baseline.version, versions.candidate.version]) }, opts.gate);
    log(`${phase}: composite v${vb.version} ${vb.composite ?? '—'} / v${vc.version} ${vc.composite ?? '—'} · gate ${gate.decision} (${gate.mode})`);
    return {
      phase,
      cases: reserved.meta,
      skipped_cases: skipped,
      mark_used: reserved.marks,
      fixtures,
      reports,
      pipeline,
      versions: [vb, vc],
      gate,
      executor_cost_eur: round(guard.spentEur - executorBefore),
      judge_cost_eur: round((judgeBudget?.spentEur ?? 0) - judgeBefore),
      evaluations,
    };
  };

  const phaseMetrics = (p: PhaseReport) => ({
    cases: p.cases.length,
    labeled: p.cases.filter((c) => c.labeled && c.use !== 'form_sample').length,
    form_sample: p.cases.filter((c) => c.use === 'form_sample').length,
    fixtures: p.fixtures.map((f) => ({ name: f.name, exhibitors: f.input.exhibitors.length })),
    executor_cost_eur: p.executor_cost_eur,
    judge: { model: p.pipeline.judge.model, calls: p.pipeline.judge.calls.length, cost_eur: p.judge_cost_eur, errors: p.pipeline.judge.errors, budget_exceeded: p.pipeline.judge.budget_exceeded },
    versions: Object.fromEntries(p.versions.map((v) => [`v${v.version}`, v])),
    warnings: p.pipeline.warnings,
    evaluations: p.evaluations,
  });
  const splitsOf = (p: PhaseReport) => ({
    role: p.phase === 'VALIDATION' ? 'validation' : 'test',
    case_ids: p.cases.filter((c) => c.use !== 'form_sample').map((c) => c.id),
    form_sample_case_ids: p.cases.filter((c) => c.use === 'form_sample').map((c) => c.id),
    labeled: p.cases.filter((c) => c.labeled && c.use !== 'form_sample').length,
    mark_used: p.mark_used,
  });

  try {
    // VALIDATION
    const valRes = await reserve('VALIDATION');
    splits.VALIDATION = { role: 'validation', case_ids: valRes.meta.filter((m) => m.use !== 'form_sample').map((m) => m.id), form_sample_case_ids: valRes.meta.filter((m) => m.use === 'form_sample').map((m) => m.id), mark_used: valRes.marks };
    exp = await recordProgress(db, exp.id, { splits });
    if (valRes.cases.length === 0) throw new ExperimentAbortedError('no_cases', `el split VALIDATION de ${dataset.name} v${dataset.version} no tiene casos utilizables por ${exp.name} (todos vetados por P5 o vacío)`, exp);
    log(`VALIDATION: ${valRes.meta.filter((m) => m.use !== 'form_sample').length} caso(s) del split (${valRes.meta.filter((m) => m.labeled && m.use !== 'form_sample').length} etiquetados) + ${valRes.meta.filter((m) => m.use === 'form_sample').length} de muestra de forma (TRAIN)`);
    const val = await runPhase('VALIDATION', valRes);
    phases.push(val);
    splits.VALIDATION = splitsOf(val);
    exp = await recordProgress(db, exp.id, { splits, metrics: { phases: { VALIDATION: phaseMetrics(val) }, cost: costs() }, costEur: costs().total_eur });

    // TEST only after a strict PASS (or a PASS_FORM when asked).
    let testSkipped: string | null = null;
    let testBlocked = false;
    if ((val.gate.decision === 'PASS' || (val.gate.decision === 'PASS_FORM' && opts.testOnForm)) && guard.exceeded) {
      testSkipped = 'presupuesto del ejecutor agotado antes de TEST: la decisión no queda confirmada (INCONCLUSIVE); TEST no se ha reservado';
      testBlocked = true;
    } else if (val.gate.decision === 'PASS' || (val.gate.decision === 'PASS_FORM' && opts.testOnForm)) {
      checkCancel();
      const testRes = await reserve('TEST');
      if (testRes.cases.length === 0) testSkipped = 'el split TEST no tiene casos utilizables (vacío o vetado)';
      else {
        const test = await runPhase('TEST', testRes);
        phases.push(test);
        splits.TEST = splitsOf(test);
      }
    } else {
      testSkipped =
        val.gate.decision === 'PASS_FORM'
          ? 'decisión preliminar PASS_FORM: TEST no se gasta sin casos etiquetados (usa --test-on-form para forzarlo)'
          : `decisión preliminar ${val.gate.decision}: TEST no se toca`;
    }

    const decision = combineDecisions([...phases.map((p) => p.gate.decision), ...(testBlocked ? (['INCONCLUSIVE'] as const) : [])]);
    const mode: ExperimentReport['mode'] = phases.some((p) => p.gate.mode === 'form') ? 'form' : 'labeled';
    const summary = testBlocked
      ? `INCONCLUSIVE: VALIDATION ${val.gate.decision}, pero ${testSkipped}.`
      : phases.length === 1
        ? val.gate.summary
        : `${decision}: ${phases.map((p) => `${p.phase} ${p.gate.decision}`).join(', ')} (decide la fase más débil).`;
    const finishedAt = new Date();
    const report: ExperimentReport = {
      experiment: { id: exp.id, name: exp.name, tenantId: exp.tenantId, subjectType: exp.subjectType, subjectName: exp.subjectName, baselineVersion: exp.baselineVersion, candidateVersion: exp.candidateVersion, createdBy: exp.createdBy },
      config,
      phases,
      test_skipped: testSkipped,
      decision,
      mode,
      summary,
      cost: costs(),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
    };
    const artifacts = deps.writeArtifacts ? await deps.writeArtifacts(report) : {};
    const metrics = { phases: Object.fromEntries(phases.map((p) => [p.phase, phaseMetrics(p)])), cost: report.cost, test_skipped: testSkipped, artifacts };
    const gateResult = { decision, mode, summary, phases: Object.fromEntries(phases.map((p) => [p.phase, p.gate])), test_skipped: testSkipped };
    exp = await completeExperiment(db, exp.id, { decision, splits, metrics, gateResult, costEur: report.cost.total_eur });
    log(`${exp.name} COMPLETED · ${decision} · ${report.cost.total_eur.toFixed(4)} €`);
    return { experiment: exp, report };
  } catch (err) {
    const status = err instanceof ExperimentAbortedError && err.code === 'cancelled' ? 'CANCELLED' : 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    const partial = { phases: Object.fromEntries(phases.map((p) => [p.phase, phaseMetrics(p)])), cost: costs(), ...(err instanceof ExperimentAbortedError && err.details ? { abort: { code: err.code, details: err.details } } : {}) };
    try {
      exp = await closeExperiment(db, exp.id, status, message, { splits, metrics: partial, costEur: costs().total_eur });
    } catch {
      /* already closed */
    }
    if (err instanceof ExperimentAbortedError) throw new ExperimentAbortedError(err.code, err.message, exp, err.details);
    throw err;
  }
}

/** Datasets a tenant can run an experiment on (for the CLI help). */
export async function datasetNames(db: Db, tenantId: string): Promise<string[]> {
  const rows = await db.select({ name: evaluationDatasets.name }).from(evaluationDatasets).where(eq(evaluationDatasets.tenantId, tenantId)).orderBy(asc(evaluationDatasets.name));
  return [...new Set(rows.map((r) => r.name))];
}
