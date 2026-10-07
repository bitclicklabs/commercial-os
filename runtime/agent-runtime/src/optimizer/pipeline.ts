/**
 * Skill Optimizer pipeline (MVP-3, LLD v0.1 section 18): one optimization run end to end.
 *
 *   PENDING -> HARVESTING   failures of the ACTIVE version in production (human verdicts +
 *                           hard RULEs) and a dry-run of the dataset: enough fresh labelled
 *                           VALIDATION cases? (else BLOCKED_NO_DATA, nothing written)
 *           -> CLUSTERED    the executor model groups the failures by pattern
 *           -> CANDIDATE_CREATED  the model proposes edit-ops on the ACTIVE text; edit-ops
 *                           applies them with the 35 % / 50 % ceilings (one retry, asking to be
 *                           more conservative); the DRAFT version is created through the skills
 *                           service with a change_reason citing the clusters
 *           -> EXPERIMENT_RUNNING  new dataset version (re-harvest), P5: the failure entities
 *                           are marked `design` BEFORE the experiment, then the experiment runner
 *                           (same path as `pnpm experiment:run`) ACTIVE vs candidate
 *           -> GATE_PASS (+ note "Propuesta de promoción" in Twenty) | GATE_FAIL
 *
 * Never activates the candidate. Never writes to Twenty except that note (the experiment runs
 * on an in-memory CRM). Any unexpected error -> ERROR with the detail; the DRAFT version and
 * the P5 marks already written stay (append-only).
 */
import type { Db } from '../db/client.js';
import type { OptimizationRun } from '../db/schema.js';
import { buildDataset, listCases, markUsed } from '../datasets/service.js';
import { ExperimentAbortedError, gateConfig, runExperiment, type ExperimentReport, type RunnerDeps } from '../experiments/index.js';
import type { TwentyClient } from '../integrations/twenty/index.js';
import { MemoryTwenty } from '../integrations/twenty/memory-twenty.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import type { ChatMessage, ModelProvider } from '../providers/model-provider.js';
import { desiredProspectorVersion } from '../seed/prospector-seed.js';
import { BudgetGuardProvider, type CompareAgentVersion } from '../skills/compare.js';
import { renderSkill, sha256 } from '../skills/render.js';
import { createVersion, findSkill, listVersions } from '../skills/service.js';
import type { AgentToolbox } from '../tools/executor.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../tools/index.js';
import {
  changeReason,
  CLUSTER_JSON_SCHEMA,
  CLUSTER_SYSTEM_PROMPT,
  clusterUserMessage,
  dataCheck,
  optimizerConfig,
  parseClusters,
  parseProposal,
  PROPOSAL_JSON_SCHEMA,
  PROPOSAL_SYSTEM_PROMPT,
  proposalRetryMessage,
  proposalUserMessage,
  runLabel,
  type CandidateProposal,
  type FailureCase,
  type FailureCluster,
  type OptimizerConfig,
  type ProposalFailure,
} from './core.js';
import { harvestFailures, selectFailures } from './harvest-failures.js';
import { upsertPromotionNote } from './promotion-note.js';
import { recordRun, requireRun, transitionRun } from './service.js';

export const OPTIMIZER_VERSION = 1;

export interface OptimizerDeps {
  db: Db;
  /** Model of the optimizer's own calls (clustering and proposal): the executor model (Gemini Flash). */
  llmProvider: ModelProvider;
  /** Experiment executor (Gemini in production, scripted in the tests). */
  executorProvider: ModelProvider;
  /** Experiment judge; without it the composite redistributes the judge weight. */
  judgeProvider?: ModelProvider | null;
  judgeModel?: string;
  /** A fresh toolbox per experiment run. Default: an in-memory CRM (MemoryTwenty): nothing reaches Twenty. */
  makeTools?: (runLabel: string) => AgentToolbox;
  /** Agent configuration of the experiment. Default: the seed's Prospector (desiredProspectorVersion()). */
  agentVersion?: CompareAgentVersion;
  /** Client for the promotion note; null/undefined = no note (recorded in the run). */
  twenty?: TwentyClient | null;
  /** Base URL of the runtime API written in the note's commands. */
  apiUrl?: string;
  now?: () => Date;
  onProgress?: (msg: string) => void;
  evaluationsTenant?: string;
  persistEvaluations?: boolean;
  signal?: AbortSignal;
}

class BlockedError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

class OptimizerStepError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OptimizerStepError';
  }
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const MAX_TOKENS = 16_000;

function defaultMakeTools(agentVersion: CompareAgentVersion, tenantId: string, signal?: AbortSignal) {
  const policy = parseToolPolicy(agentVersion.configuration);
  return (label: string): AgentToolbox =>
    new ToolExecutor(createDefaultToolRegistry({ twenty: new MemoryTwenty().client() }), policy, { tenantId, executionId: label, agentId: 'skill-optimizer', stage: 'PROSPECTOR' }, signal ?? new AbortController().signal);
}

/** One JSON call with up to one retry carrying the validation error. */
async function callValidated<T>(
  provider: ModelProvider,
  req: { model: string; system: string; user: string; schema: Record<string, unknown>; signal?: AbortSignal | undefined },
  validate: (text: string) => { ok: true; value: T } | ({ ok: false; error: string } & Record<string, unknown>),
  retryMessage: (failure: { ok: false; error: string } & Record<string, unknown>) => string,
): Promise<{ ok: true; value: T; attempts: Array<Record<string, unknown>> } | { ok: false; error: string; attempts: Array<Record<string, unknown>> }> {
  const messages: ChatMessage[] = [{ role: 'user', content: req.user }];
  const attempts: Array<Record<string, unknown>> = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await provider.complete({ model: req.model, system: req.system, messages, maxTokens: MAX_TOKENS, options: { responseSchema: req.schema, temperature: 0.2 }, ...(req.signal ? { signal: req.signal } : {}) });
    const v = validate(r.text);
    attempts.push({ attempt, model: r.model, input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, ok: v.ok, ...(v.ok ? {} : { error: v.error, ...(typeof v.kind === 'string' ? { kind: v.kind } : {}) }) });
    if (v.ok) return { ok: true, value: v.value, attempts };
    if (attempt === 2) return { ok: false, error: v.error, attempts };
    messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: retryMessage(v) });
  }
  return { ok: false, error: 'sin respuesta', attempts };
}

export async function clusterFailures(provider: ModelProvider, args: { model: string; skillName: string; skillText: string; failures: FailureCase[]; signal?: AbortSignal }) {
  return callValidated<FailureCluster[]>(
    provider,
    { model: args.model, system: CLUSTER_SYSTEM_PROMPT, user: clusterUserMessage(args.skillName, args.skillText, args.failures), schema: CLUSTER_JSON_SCHEMA, signal: args.signal },
    (text) => parseClusters(text, args.failures),
    (f) => `La respuesta anterior no es válida: ${f.error}. Corrígela y responde de nuevo con el JSON completo.`,
  );
}

export async function proposeCandidate(provider: ModelProvider, args: { model: string; skillName: string; baseVersion: number; skillText: string; clusters: FailureCluster[]; signal?: AbortSignal }) {
  return callValidated<CandidateProposal>(
    provider,
    { model: args.model, system: PROPOSAL_SYSTEM_PROMPT, user: proposalUserMessage(args.skillName, args.baseVersion, args.skillText, args.clusters), schema: PROPOSAL_JSON_SCHEMA, signal: args.signal },
    (text) => parseProposal(text, args.skillText, args.clusters),
    (f) => proposalRetryMessage({ kind: f.kind === 'caps' ? 'caps' : 'invalid', error: f.error } as ProposalFailure),
  );
}

function compositeRows(report: ExperimentReport) {
  return report.phases.map((p) => {
    const [b, c] = p.versions;
    const baseline = b?.composite ?? null;
    const candidate = c?.composite ?? null;
    return { phase: p.phase, baseline, candidate, delta: baseline === null || candidate === null ? null : round(candidate - baseline, 4) };
  });
}

/**
 * Runs one PENDING optimization run to its gate verdict (or BLOCKED_NO_DATA / ERROR). A run that
 * is not PENDING is returned untouched (a redelivered job does nothing).
 */
export async function runOptimization(deps: OptimizerDeps, tenantId: string, runId: string): Promise<OptimizationRun> {
  const { db } = deps;
  const log = deps.onProgress ?? (() => undefined);
  let run = await requireRun(db, tenantId, runId);
  if (run.status !== 'PENDING') return run;
  const label = runLabel(run.id);
  let llm: BudgetGuardProvider | null = null;
  let experimentCost = 0;
  const cost = () => round((llm?.spentEur ?? 0) + experimentCost);

  try {
    const cfg: OptimizerConfig = optimizerConfig(run.skillName, run.config as Partial<OptimizerConfig>);
    llm = new BudgetGuardProvider(deps.llmProvider, cfg.llmBudgetEur, DEFAULT_USD_TO_EUR);
    run = await transitionRun(db, run.id, 'HARVESTING', { details: { optimizer_version: OPTIMIZER_VERSION, label, started_at: new Date().toISOString() } }, 'PENDING');
    log(`${label}: ${run.skillName} v${run.baseVersion} · cosechando fallos`);

    // --- 1. Base version and failures -------------------------------------------------
    const skill = await findSkill(db, tenantId, run.skillName);
    if (!skill) throw new OptimizerStepError(`la skill ${run.skillName} no existe en el tenant ${tenantId}`, {});
    const versions = await listVersions(db, skill.id);
    const active = versions.find((v) => v.status === 'ACTIVE');
    if (!active) throw new OptimizerStepError(`la skill ${run.skillName} no tiene versión ACTIVE`, {});
    if (active.version !== run.baseVersion) throw new OptimizerStepError(`la versión activa cambió desde que se pidió el run (v${run.baseVersion} → v${active.version}): lanza un run nuevo`, { active_version: active.version });
    const baseText = active.instructions;

    const harvest = await harvestFailures(db, { tenantId, skillName: run.skillName, version: active.version, maxTraces: cfg.maxTraces });
    const failures = selectFailures(harvest.failures, cfg.maxFailures);
    const designEntities = new Set(failures.map((f) => f.entityKey));
    run = await recordRun(db, run.id, 'HARVESTING', { details: { harvest: { ...harvest.stats, total_failures: harvest.failures.length, selected: failures.length }, failures, design_entities: [...designEntities] } });
    log(`${label}: ${harvest.failures.length} fallo(s) (${harvest.stats.human_failures} humanos, ${harvest.stats.rule_failures} de reglas duras en ${harvest.stats.traces_checked} trazas); se usan ${failures.length}`);
    if (failures.length < cfg.minFailures) {
      throw new BlockedError(`hay ${failures.length} fallo(s) de ${run.skillName} v${active.version} en producción y hacen falta ${cfg.minFailures}: faltan ${cfg.minFailures - failures.length}. El optimizador no mejora a ciegas: espera a más veredictos humanos o ejecuciones.`, {
        data_check: { kind: 'failures', found: failures.length, required: cfg.minFailures, missing: cfg.minFailures - failures.length },
      });
    }

    // --- 2. Enough fresh labelled data to validate? (dry run: writes nothing) ----------
    const dry = await buildDataset(db, { tenantId, name: cfg.datasetName, domain: cfg.domain, dryRun: true });
    const pre = dataCheck(dry.cases, designEntities, cfg.minLabeledValidation, `${cfg.datasetName} v${dry.version} (simulación)`);
    run = await recordRun(db, run.id, 'HARVESTING', { details: { data_check: { kind: 'dataset_dry_run', dataset: cfg.datasetName, version: dry.version, ...pre } } });
    log(`${label}: ${pre.message}`);
    if (!pre.ok) throw new BlockedError(pre.message, {});

    // --- 3. Clustering -------------------------------------------------------------------
    const clustered = await clusterFailures(llm, { model: cfg.model, skillName: run.skillName, skillText: baseText, failures, ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!clustered.ok) throw new OptimizerStepError(`el clustering no devolvió una respuesta válida tras 2 intentos: ${clustered.error}`, { clustering_attempts: clustered.attempts });
    const clusters = clustered.value;
    const byId = new Map(failures.map((f) => [f.id, f]));
    const stored = clusters.map((c) => ({
      id: c.id,
      title: c.title,
      pattern: c.pattern,
      skill_gap: c.skillGap,
      failure_ids: c.failureIds,
      failures: c.failureIds.map((id) => ({ id, kind: byId.get(id)!.kind, exhibitor: byId.get(id)!.exhibitor.name, entity_key: byId.get(id)!.entityKey, trace_id: byId.get(id)!.source.traceId })),
    }));
    run = await transitionRun(db, run.id, 'CLUSTERED', { failureClusters: stored, costEur: cost(), details: { clustering_attempts: clustered.attempts } }, 'HARVESTING');
    log(`${label}: ${clusters.length} cluster(s): ${clusters.map((c) => `${c.id} ${c.title} (${c.failureIds.length})`).join(' · ')}`);

    // --- 4. Candidate (edit-ops on the ACTIVE text) -------------------------------------
    const proposed = await proposeCandidate(llm, { model: cfg.model, skillName: run.skillName, baseVersion: active.version, skillText: baseText, clusters, ...(deps.signal ? { signal: deps.signal } : {}) });
    if (!proposed.ok) {
      await recordRun(db, run.id, 'CLUSTERED', { costEur: cost(), details: { proposal_attempts: proposed.attempts } });
      throw new OptimizerStepError(`la propuesta de candidata no es válida tras 2 intentos: ${proposed.error}`, { proposal_attempts: proposed.attempts });
    }
    const proposal = proposed.value;
    const candidateText = renderSkill({ instructions: proposal.edit.text, constraints: active.constraints, examples: active.examples, antiPatterns: active.antiPatterns });
    const duplicate = versions.find((v) => v.contentHash === sha256(candidateText));
    if (duplicate) throw new OptimizerStepError(`la candidata es idéntica a la v${duplicate.version} existente`, { proposal_attempts: proposed.attempts, duplicate_of: duplicate.version });
    const operations = proposal.operations.map((o, i) => ({ ...o.operation, clusters: o.clusters, removed_chars: proposal.edit.applied[i]!.removed, added_chars: proposal.edit.applied[i]!.added }));
    const attacked = [...new Set(proposal.operations.flatMap((o) => o.clusters))];
    const { version: created } = await createVersion(db, {
      tenantId,
      skillKey: run.skillName,
      copyFrom: active.version,
      content: {
        instructions: proposal.edit.text,
        metadata: {
          experiment: null,
          optimizer: { run_id: run.id, label, version: OPTIMIZER_VERSION, model: cfg.model, summary: proposal.summary, clusters: clusters.filter((c) => attacked.includes(c.id)).map((c) => ({ id: c.id, title: c.title, failures: c.failureIds.length })) },
          base_version: active.version,
          removed_ratio: proposal.edit.removedRatio,
          added_ratio: proposal.edit.addedRatio,
          operations,
          design_data: { source: 'optimizer harvest', failures: failures.map((f) => ({ id: f.id, kind: f.kind, entity_key: f.entityKey, trace_id: f.source.traceId, evaluation_id: f.source.evaluationId ?? null })) },
        },
      },
      changeReason: changeReason(label, clusters, proposal),
      createdBy: `skill-optimizer:${label}`,
    });
    run = await transitionRun(db, run.id, 'CANDIDATE_CREATED', { candidateVersion: created.version, proposedOps: operations, costEur: cost(), details: { proposal: { summary: proposal.summary, attempts: proposed.attempts, removed_ratio: proposal.edit.removedRatio, added_ratio: proposal.edit.addedRatio, attacked_clusters: attacked } } }, 'CLUSTERED');
    log(`${label}: candidata v${created.version} (DRAFT) · ${operations.length} operación(es) · borra ${(proposal.edit.removedRatio * 100).toFixed(1)} %, añade ${(proposal.edit.addedRatio * 100).toFixed(1)} %`);

    // --- 5. Dataset for the experiment, P5 design marks, re-check -------------------------
    const built = await buildDataset(db, { tenantId, name: cfg.datasetName, domain: cfg.domain, createdBy: `skill-optimizer:${label}`, description: `Re-cosecha del Skill Optimizer ${label} (${run.skillName} v${active.version} vs v${created.version})` });
    const datasetId = built.dataset!.id;
    const all = await listCases(db, { tenantId, datasetId, includeVetoed: true, limit: 100_000 });
    const design = all.items.filter((c) => designEntities.has(c.entityKey));
    let designMark: Record<string, unknown> = { marked: 0 };
    if (design.length > 0) {
      const r = await markUsed(db, { tenantId, datasetId, caseIds: design.map((c) => c.id), experiment: label, role: 'design', by: 'skill-optimizer', note: `${label}: fallos de producción usados para diseñar v${created.version}` });
      designMark = { marked: r.marked.length, already: r.already.length, newly_burned: r.newly_burned.length };
    }
    const val = await listCases(db, { tenantId, datasetId, split: 'VALIDATION', role: 'validation' });
    const post = dataCheck(val.items, designEntities, cfg.minLabeledValidation, `${cfg.datasetName} v${built.dataset!.version}`);
    run = await recordRun(db, run.id, 'CANDIDATE_CREATED', { details: { dataset: { id: datasetId, name: cfg.datasetName, version: built.dataset!.version, design_cases: design.length, design_mark: designMark, ...post } } });
    if (!post.ok) throw new BlockedError(post.message, {});

    // --- 6. Experiment (same path as pnpm experiment:run) ---------------------------------
    run = await transitionRun(db, run.id, 'EXPERIMENT_RUNNING', {}, 'CANDIDATE_CREATED');
    const agentVersion = deps.agentVersion ?? (() => {
      const v = desiredProspectorVersion();
      return { model: v.model, configuration: v.configuration };
    })();
    const now = cfg.today ? () => new Date(`${cfg.today}T08:00:00Z`) : (deps.now ?? (() => new Date()));
    const runnerDeps: RunnerDeps = {
      db,
      executorProvider: deps.executorProvider,
      judgeProvider: deps.judgeProvider ?? null,
      ...(deps.judgeModel ? { judgeModel: deps.judgeModel } : {}),
      makeTools: deps.makeTools ?? defaultMakeTools(agentVersion, tenantId, deps.signal),
      agentVersion,
      now,
      onProgress: (m) => log(`${label} experimento: ${m}`),
      ...(deps.evaluationsTenant ? { evaluationsTenant: deps.evaluationsTenant } : {}),
      ...(deps.persistEvaluations !== undefined ? { persistEvaluations: deps.persistEvaluations } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    };
    let result: Awaited<ReturnType<typeof runExperiment>>;
    try {
      result = await runExperiment(runnerDeps, {
        tenantId,
        subjectName: run.skillName,
        candidateVersion: created.version,
        dataset: datasetId,
        budgetEur: cfg.experimentBudgetEur,
        repeat: cfg.repeat,
        formSample: 0,
        testOnForm: false,
        gate: gateConfig(),
        judge: !!deps.judgeProvider,
        createdBy: `skill-optimizer:${label}`,
      });
    } catch (err) {
      if (err instanceof ExperimentAbortedError) {
        experimentCost = Number(err.experiment?.costEur ?? 0);
        const patch = { ...(err.experiment ? { experimentId: err.experiment.id } : {}), costEur: cost(), details: { experiment: { name: err.experiment?.name ?? null, status: err.experiment?.status ?? null, abort: err.code } } };
        if (err.code === 'no_cases') {
          await transitionRun(db, run.id, 'BLOCKED_NO_DATA', { ...patch, error: err.message }, 'EXPERIMENT_RUNNING');
          return requireRun(db, tenantId, run.id);
        }
        await recordRun(db, run.id, 'EXPERIMENT_RUNNING', patch);
      }
      throw err;
    }
    const { experiment, report } = result;
    experimentCost = report.cost.total_eur;
    const decision = experiment.decision!;
    const composite = compositeRows(report);
    const expDetails = { name: experiment.name, status: experiment.status, decision, mode: report.mode, summary: report.summary, composite, cost: report.cost, test_skipped: report.test_skipped };
    log(`${label}: ${experiment.name} ${decision} (${report.mode}) · ${report.summary}`);

    if (decision !== 'PASS' && decision !== 'PASS_FORM') {
      return await transitionRun(db, run.id, 'GATE_FAIL', { experimentId: experiment.id, verdict: decision, costEur: cost(), details: { experiment: expDetails } }, 'EXPERIMENT_RUNNING');
    }
    run = await transitionRun(db, run.id, 'GATE_PASS', { experimentId: experiment.id, verdict: decision, costEur: cost(), details: { experiment: expDetails } }, 'EXPERIMENT_RUNNING');

    // --- 7. Promotion proposal for the human (never an activation) ------------------------
    let note: Record<string, unknown>;
    if (!deps.twenty) note = { skipped: 'sin cliente de Twenty' };
    else {
      try {
        const n = await upsertPromotionNote(deps.twenty, {
          tenantId,
          runId: run.id,
          runLabel: label,
          skillName: run.skillName,
          baseVersion: active.version,
          candidateVersion: created.version,
          experimentName: experiment.name,
          decision,
          mode: report.mode,
          summary: report.summary,
          composite,
          clusters,
          attackedClusters: attacked,
          operations: proposal.operations.map((o) => ({ op: o.operation.op, why: o.operation.why, clusters: o.clusters })),
          cost: { optimizer_eur: round(llm.spentEur), experiment_eur: round(experimentCost), total_eur: cost() },
          ...(deps.apiUrl ? { apiUrl: deps.apiUrl } : {}),
        });
        note = { id: n.noteId, created: n.created, title: n.title };
      } catch (err) {
        // The gate passed: a CRM failure does not undo that; the run says the note is missing.
        note = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    log(`${label}: GATE_PASS · nota en Twenty: ${JSON.stringify(note)}`);
    return await recordRun(db, run.id, 'GATE_PASS', { details: { note } });
  } catch (err) {
    const current = await requireRun(db, tenantId, run.id);
    if (current.status !== 'PENDING' && !['HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING'].includes(current.status)) throw err;
    if (err instanceof BlockedError) {
      log(`${label}: BLOCKED_NO_DATA · ${err.message}`);
      return transitionRun(db, run.id, 'BLOCKED_NO_DATA', { error: err.message, costEur: cost(), details: err.details });
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: ERROR · ${message}`);
    return transitionRun(db, run.id, 'ERROR', { error: message, costEur: cost(), details: err instanceof OptimizerStepError ? err.details : { error_name: err instanceof Error ? err.name : typeof err } });
  }
}
