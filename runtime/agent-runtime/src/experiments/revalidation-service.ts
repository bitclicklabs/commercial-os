/**
 * Re-validation of PASS_FORM experiments in the database (the rules are in revalidation.ts).
 *
 * `revalidateExperiment` reads the experiment (never writes it: a finished experiment is
 * immutable, trigger 0011), the cases it executed, the HUMAN labels of the same entities in
 * any version of its dataset and the candidate's optimizer design marks; measures each arm's
 * accuracy on the stored per-case outputs (no model, cost 0) and appends one row to
 * `experiment_revalidations` (migration 0016). The same label set returns the existing row.
 *
 * Consequence (only for a NEW row with verdict REFUTED whose version is still ACTIVE or in an
 * ACTIVE canary): a note in Twenty "⚠️ Revalidación fallida — <subject> v<N>" with the numbers
 * and the options (rollback / canary / iterate), and the internal event
 * `experiment.revalidation_failed` (n8n may subscribe). Nothing is deactivated or rolled back:
 * the human decides. The note id and the event id are written once into `consequence`.
 *
 * `pendingRevalidations` lists the PASS_FORM experiments whose winning version is still ACTIVE
 * or in canary, with the usable labels available and how many are fresh (not used by the last
 * re-validation).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { evaluationCases, evaluationDatasets, experimentRevalidations, optimizationRuns, type Experiment, type ExperimentRevalidation } from '../db/schema.js';
import type { EventPublisher } from '../events/event-bus.js';
import { findHarness, listHarnessVersions } from '../harness/service.js';
import { TWENTY_OBJECTS, type TwentyClient, type TwentyNote } from '../integrations/twenty/index.js';
import { runLabel } from '../optimizer/core.js';
import { activeCanaryOf, findSkill, listVersions } from '../skills/service.js';
import { noteTitle } from '../tools/twenty/note-tools.js';
import type { AccuracyMetric } from './gate.js';
import type { CaseOutput } from './metrics.js';
import {
  caseOutputsFromReport,
  executedCaseRefs,
  labelsHash,
  revalidationAccuracy,
  revalidationCriteria,
  revalidationNoteMarkdown,
  revalidationNoteTitle,
  revalidationVerdict,
  selectLabels,
  storedCaseOutputs,
  type ExecutedCase,
  type LabelCandidate,
  type LabelSelection,
  type RevalidationCriteria,
  type VerdictResult,
  type VersionState,
} from './revalidation.js';
import { findExperiment, listExperiments } from './service.js';

/** Repository root: `metrics.artifacts.json` paths are relative to it (docs/experimentos/...). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const REVALIDATION_FAILED_EVENT = 'experiment.revalidation_failed';

export class RevalidationError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_pass_form' | 'outputs_unavailable' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RevalidationError';
  }
}

export interface RevalidationDeps {
  db: Db;
  /** Twenty client for the note (null/unconfigured: no note, recorded as skipped). */
  twenty?: TwentyClient | null | undefined;
  events?: EventPublisher | null | undefined;
  /** Where relative artifact paths resolve (default the repository root). */
  repoRoot?: string;
  /** Base URL of the runtime API for the commands in the note. */
  apiUrl?: string;
}

export interface RevalidateOptions {
  tenantId: string;
  /** Experiment uuid or name (EXP-003). */
  experiment: string;
  minLabels?: number | undefined;
  requestedBy?: string | null | undefined;
  source?: 'api' | 'cli';
  /** CLI only: an `informe.json` to read the outputs from (experiments older than `case_outputs`). */
  reportPath?: string | undefined;
  /** Compute and return, write nothing (no row, no note, no event). */
  dryRun?: boolean;
  /** Leave the Twenty note out (default: write it on a REFUTED of a version in use). */
  note?: boolean;
}

export interface RevalidationComputation {
  experiment: Experiment;
  criteria: RevalidationCriteria;
  selection: LabelSelection;
  outputs: { source: 'metrics' | 'artifact'; artifact: string | null; count: number };
  accuracy: { baseline: AccuracyMetric; candidate: AccuracyMetric };
  verdict: VerdictResult;
  versionState: VersionState;
  labelsHash: string;
  executed: number;
  warnings: string[];
}

export interface RevalidateResult {
  computation: RevalidationComputation;
  /** null on a dry run. */
  revalidation: ExperimentRevalidation | null;
  /** False when the same label set had already been re-validated (the existing row is returned). */
  created: boolean;
}

// ---------------------------------------------------------------------------

/** State of the experiment's candidate today: ACTIVE, in an ACTIVE canary, or neither. */
export async function candidateVersionState(db: Db, exp: Pick<Experiment, 'tenantId' | 'subjectType' | 'subjectName' | 'candidateVersion' | 'config'>): Promise<VersionState> {
  const wantedId = (exp.config?.candidate as { version_id?: unknown } | undefined)?.version_id;
  const matches = (v: { id: string; version: number }) => v.version === exp.candidateVersion && (typeof wantedId !== 'string' || v.id === wantedId);
  if (exp.subjectType === 'harness') {
    const h = await findHarness(db, exp.tenantId, exp.subjectName);
    const v = h ? (await listHarnessVersions(db, h.id)).find(matches) : undefined;
    if (!v) return { state: 'MISSING', status: null, canary: null, relevant: false };
    return { state: v.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE', status: v.status, canary: null, relevant: v.status === 'ACTIVE' };
  }
  const skill = await findSkill(db, exp.tenantId, exp.subjectName);
  const v = skill ? (await listVersions(db, skill.id)).find(matches) : undefined;
  if (!skill || !v) return { state: 'MISSING', status: null, canary: null, relevant: false };
  if (v.status === 'ACTIVE') return { state: 'ACTIVE', status: v.status, canary: null, relevant: true };
  const canary = await activeCanaryOf(db, skill.id);
  if (canary && canary.canaryVersionId === v.id) return { state: 'CANARY', status: v.status, canary: { id: canary.id, percent: canary.percent, stable_version: canary.stableVersion }, relevant: true };
  return { state: 'INACTIVE', status: v.status, canary: null, relevant: false };
}

function artifactPathOf(exp: Pick<Experiment, 'metrics'>, repoRoot: string): string | null {
  const rel = (exp.metrics?.artifacts as { json?: unknown } | undefined)?.json;
  if (typeof rel !== 'string' || !rel.endsWith('.json')) return null;
  const root = resolve(repoRoot);
  const p = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  // The path comes from the experiment row: it must stay inside the repository.
  if (!p.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return p;
}

/** Where the outputs are, without reading them (for the pending list). */
export function outputsAvailability(exp: Pick<Experiment, 'metrics'>, repoRoot = REPO_ROOT): { source: 'metrics' | 'artifact' | null; caseIds: Set<string> | null } {
  const stored = storedCaseOutputs(exp);
  if (stored) return { source: 'metrics', caseIds: new Set(stored.map((o) => o.case_id)) };
  const p = artifactPathOf(exp, repoRoot);
  return { source: p && existsSync(p) ? 'artifact' : null, caseIds: null };
}

function loadOutputs(exp: Experiment, opts: { reportPath?: string | undefined; repoRoot: string }): { outputs: CaseOutput[]; source: 'metrics' | 'artifact'; artifact: string | null } {
  const stored = storedCaseOutputs(exp);
  if (stored) return { outputs: stored, source: 'metrics', artifact: null };
  const path = opts.reportPath ? resolve(opts.reportPath) : artifactPathOf(exp, opts.repoRoot);
  if (!path || !existsSync(path)) {
    throw new RevalidationError(
      'outputs_unavailable',
      `${exp.name} no guarda las salidas por caso (experimento anterior a metrics.phases.*.case_outputs) y su informe.json no está accesible${path ? ` (${path})` : ''}. Revalídalo con la CLI desde el repositorio: pnpm experiment:revalidate --id ${exp.name} [--report <informe.json>]`,
      { artifact: path },
    );
  }
  try {
    return { outputs: caseOutputsFromReport(JSON.parse(readFileSync(path, 'utf8')) as unknown, exp.id), source: 'artifact', artifact: path };
  } catch (err) {
    throw new RevalidationError('outputs_unavailable', `no se pueden leer las salidas de ${path}: ${err instanceof Error ? err.message : String(err)}`, { artifact: path });
  }
}

async function loadExecuted(db: Db, exp: Experiment, warnings: string[]): Promise<ExecutedCase[]> {
  const refs = executedCaseRefs(exp);
  if (refs.length === 0) return [];
  const rows = await db.select().from(evaluationCases).where(and(eq(evaluationCases.tenantId, exp.tenantId), inArray(evaluationCases.id, refs.map((r) => r.case_id))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ExecutedCase[] = [];
  for (const ref of refs) {
    const r = byId.get(ref.case_id);
    if (!r) {
      warnings.push(`caso ${ref.case_id} del experimento no encontrado en evaluation_cases`);
      continue;
    }
    out.push({
      case_id: r.id,
      phase: ref.phase,
      use: ref.use,
      entity_key: r.entityKey,
      exhibitor: String((r.input.exhibitor as { name?: unknown } | undefined)?.name ?? r.entityKey),
      input: r.input,
      expected: r.expected,
      source: r.source as Record<string, unknown>,
      used_by: r.usedBy,
    });
  }
  return out;
}

async function datasetNameOf(db: Db, exp: Experiment): Promise<string | null> {
  const fromConfig = (exp.config?.dataset as { name?: unknown } | undefined)?.name;
  if (typeof fromConfig === 'string') return fromConfig;
  if (!exp.datasetId) return null;
  const [d] = await db.select({ name: evaluationDatasets.name }).from(evaluationDatasets).where(eq(evaluationDatasets.id, exp.datasetId)).limit(1);
  return d?.name ?? null;
}

async function loadLabelCandidates(db: Db, exp: Experiment, entityKeys: string[]): Promise<LabelCandidate[]> {
  const name = await datasetNameOf(db, exp);
  if (!name || entityKeys.length === 0) return [];
  const rows = await db
    .select({ c: evaluationCases, version: evaluationDatasets.version })
    .from(evaluationCases)
    .innerJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationCases.datasetId))
    .where(
      and(
        eq(evaluationDatasets.tenantId, exp.tenantId),
        eq(evaluationDatasets.name, name),
        inArray(evaluationCases.entityKey, [...new Set(entityKeys)]),
        sql`${evaluationCases.source}->>'expected_source' = 'human'`,
      ),
    );
  return rows.map(({ c, version }) => ({ case_id: c.id, dataset_id: c.datasetId, dataset_version: version, entity_key: c.entityKey, input: c.input, expected: c.expected, source: c.source as Record<string, unknown>, used_by: c.usedBy }));
}

/** `used_by.experiment` ids of the candidate's optimizer runs (its design work, P5). */
async function candidateDesignExperiments(db: Db, exp: Experiment): Promise<Set<string>> {
  if (exp.subjectType !== 'skill') return new Set();
  const rows = await db
    .select({ id: optimizationRuns.id })
    .from(optimizationRuns)
    .where(and(eq(optimizationRuns.tenantId, exp.tenantId), eq(optimizationRuns.skillName, exp.subjectName), or(eq(optimizationRuns.experimentId, exp.id), eq(optimizationRuns.candidateVersion, exp.candidateVersion))));
  return new Set(rows.map((r) => runLabel(r.id)));
}

async function selectionFor(db: Db, exp: Experiment, withOutputs: ReadonlySet<string> | undefined, warnings: string[]): Promise<{ selection: LabelSelection; executed: number }> {
  const executed = await loadExecuted(db, exp, warnings);
  const [candidates, design] = await Promise.all([loadLabelCandidates(db, exp, executed.map((e) => e.entity_key)), candidateDesignExperiments(db, exp)]);
  const selection = selectLabels({ executed, candidates, designExperiments: design, designCutoff: exp.startedAt ?? exp.createdAt, ...(withOutputs ? { withOutputs } : {}) });
  return { selection, executed: executed.length };
}

async function requirePassForm(db: Db, tenantId: string, key: string): Promise<Experiment> {
  const exp = await findExperiment(db, tenantId, key);
  if (!exp) throw new RevalidationError('not_found', 'experiment not found');
  if (exp.status !== 'COMPLETED' || exp.decision !== 'PASS_FORM') {
    throw new RevalidationError('not_pass_form', `${exp.name} es ${exp.status}${exp.decision ? ` ${exp.decision}` : ''}: solo se revalida un experimento COMPLETED con PASS_FORM (los demás ya midieron accuracy o no aprobaron)`, { status: exp.status, decision: exp.decision });
  }
  return exp;
}

export async function computeRevalidation(db: Db, opts: RevalidateOptions & { repoRoot?: string }): Promise<RevalidationComputation> {
  const exp = await requirePassForm(db, opts.tenantId, opts.experiment);
  let criteria: RevalidationCriteria;
  try {
    criteria = revalidationCriteria(exp, opts.minLabels);
  } catch (err) {
    throw new RevalidationError('invalid', err instanceof Error ? err.message : String(err));
  }
  const loaded = loadOutputs(exp, { reportPath: opts.reportPath, repoRoot: opts.repoRoot ?? REPO_ROOT });
  const warnings: string[] = [];
  const withOutputs = new Set(loaded.outputs.map((o) => o.case_id));
  const { selection, executed } = await selectionFor(db, exp, withOutputs, warnings);
  const baseline = revalidationAccuracy(exp.baselineVersion ?? -1, loaded.outputs, selection.labels);
  const candidate = revalidationAccuracy(exp.candidateVersion, loaded.outputs, selection.labels);
  const verdict = revalidationVerdict({ labels: selection.labels.length, criteria, baseline, candidate, baselineVersion: exp.baselineVersion, candidateVersion: exp.candidateVersion });
  const versionState = await candidateVersionState(db, exp);
  const differentInput = selection.labels.filter((l) => !l.input_same).length;
  if (differentInput > 0) warnings.push(`${differentInput} etiqueta(s) vienen de otra ocurrencia de la entidad (entrada distinta a la que ejecutó el experimento): la etiqueta es de la entidad`);
  return {
    experiment: exp,
    criteria,
    selection,
    outputs: { source: loaded.source, artifact: loaded.artifact, count: loaded.outputs.length },
    accuracy: { baseline, candidate },
    verdict,
    versionState,
    labelsHash: labelsHash(selection.labels, criteria),
    executed,
    warnings,
  };
}

async function findByHash(db: Db, tenantId: string, experimentId: string, hash: string): Promise<ExperimentRevalidation | null> {
  const [row] = await db
    .select()
    .from(experimentRevalidations)
    .where(and(eq(experimentRevalidations.tenantId, tenantId), eq(experimentRevalidations.experimentId, experimentId), eq(experimentRevalidations.labelsHash, hash)))
    .limit(1);
  return row ?? null;
}

export async function revalidateExperiment(deps: RevalidationDeps, opts: RevalidateOptions): Promise<RevalidateResult> {
  const { db } = deps;
  const c = await computeRevalidation(db, { ...opts, ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}) });
  if (opts.dryRun) return { computation: c, revalidation: null, created: false };
  const exp = c.experiment;
  const existing = await findByHash(db, exp.tenantId, exp.id, c.labelsHash);
  if (existing) return { computation: c, revalidation: existing, created: false };

  const [inserted] = await db
    .insert(experimentRevalidations)
    .values({
      tenantId: exp.tenantId,
      experimentId: exp.id,
      experimentName: exp.name,
      subjectType: exp.subjectType,
      subjectName: exp.subjectName,
      baselineVersion: exp.baselineVersion,
      candidateVersion: exp.candidateVersion,
      verdict: c.verdict.verdict,
      labelsHash: c.labelsHash,
      labelCaseIds: c.selection.labels.map((l) => l.label_case_id),
      evaluationIds: [...new Set(c.selection.labels.flatMap((l) => (l.evaluation_ids.length ? l.evaluation_ids : l.evaluation_id ? [l.evaluation_id] : [])))],
      labels: c.selection.labels as unknown as Record<string, unknown>[],
      excluded: c.selection.excluded as unknown as Record<string, unknown>[],
      accuracy: { baseline: c.accuracy.baseline, candidate: c.accuracy.candidate },
      baselineAccuracy: c.accuracy.baseline.value,
      candidateAccuracy: c.accuracy.candidate.value,
      criteria: { ...c.criteria, threshold: c.verdict.threshold, missing: c.verdict.missing, executed_cases: c.executed, unlabeled: c.selection.unlabeled, warnings: c.warnings },
      summary: c.verdict.summary,
      versionState: c.versionState as unknown as Record<string, unknown>,
      outputsSource: c.outputs.source,
      costEur: 0,
      source: opts.source ?? 'api',
      requestedBy: opts.requestedBy ?? null,
    })
    .onConflictDoNothing({ target: [experimentRevalidations.tenantId, experimentRevalidations.experimentId, experimentRevalidations.labelsHash] })
    .returning();
  if (!inserted) {
    // A concurrent request with the same labels won the insert.
    const again = await findByHash(db, exp.tenantId, exp.id, c.labelsHash);
    return { computation: c, revalidation: again, created: false };
  }
  let row = inserted;
  if (c.verdict.verdict === 'REFUTED' && c.versionState.relevant) row = await recordConsequence(deps, opts, c, inserted);
  return { computation: c, revalidation: row, created: true };
}

/** Note in Twenty + internal event for a REFUTED version still in use. Never throws; written once. */
async function recordConsequence(deps: RevalidationDeps, opts: RevalidateOptions, c: RevalidationComputation, row: ExperimentRevalidation): Promise<ExperimentRevalidation> {
  const exp = c.experiment;
  const title = noteTitle(revalidationNoteTitle(exp.subjectName, exp.candidateVersion));
  let note: Record<string, unknown>;
  if (opts.note === false) note = { skipped: 'disabled' };
  else if (!deps.twenty || !deps.twenty.isConfigured()) note = { skipped: 'twenty_not_configured', title };
  else {
    try {
      const markdown = revalidationNoteMarkdown({
        tenantId: exp.tenantId,
        revalidationId: row.id,
        experimentName: exp.name,
        subjectType: exp.subjectType,
        subjectName: exp.subjectName,
        baselineVersion: exp.baselineVersion,
        candidateVersion: exp.candidateVersion,
        summary: c.verdict.summary,
        baseline: c.accuracy.baseline,
        candidate: c.accuracy.candidate,
        criteria: c.criteria,
        labels: c.selection.labels.length,
        excluded: c.selection.excluded.length,
        versionState: c.versionState,
        ...(deps.apiUrl ? { apiUrl: deps.apiUrl } : {}),
      });
      const created = await deps.twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown } });
      note = { id: created.id, title, created: true };
    } catch (err) {
      note = { error: err instanceof Error ? err.message.slice(0, 500) : String(err), title };
    }
  }
  let event: Record<string, unknown>;
  if (!deps.events) event = { skipped: 'no_event_bus' };
  else {
    const published = await deps.events.emit({
      tenantId: exp.tenantId,
      type: REVALIDATION_FAILED_EVENT,
      correlationId: exp.id,
      idempotencyKey: `evt:${REVALIDATION_FAILED_EVENT}:${row.id}`,
      data: {
        revalidationId: row.id,
        experimentId: exp.id,
        experimentName: exp.name,
        subjectType: exp.subjectType,
        subjectName: exp.subjectName,
        baselineVersion: exp.baselineVersion,
        candidateVersion: exp.candidateVersion,
        verdict: c.verdict.verdict,
        baselineAccuracy: c.accuracy.baseline.value,
        candidateAccuracy: c.accuracy.candidate.value,
        labels: c.selection.labels.length,
        versionState: c.versionState.state,
        noteId: typeof note.id === 'string' ? note.id : null,
      },
    });
    event = published ? { id: published.event.id, type: REVALIDATION_FAILED_EVENT, dispatched: published.dispatched } : { error: 'no se pudo publicar (ver log)', type: REVALIDATION_FAILED_EVENT };
  }
  const consequence = { note, event, at: new Date().toISOString() };
  const [updated] = await deps.db
    .update(experimentRevalidations)
    .set({ consequence })
    .where(and(eq(experimentRevalidations.id, row.id), sql`${experimentRevalidations.consequence} = '{}'::jsonb`))
    .returning();
  return updated ?? row;
}

export async function listRevalidations(db: Db, tenantId: string, experimentId: string, limit = 50): Promise<ExperimentRevalidation[]> {
  return db
    .select()
    .from(experimentRevalidations)
    .where(and(eq(experimentRevalidations.tenantId, tenantId), eq(experimentRevalidations.experimentId, experimentId)))
    .orderBy(desc(experimentRevalidations.createdAt))
    .limit(limit);
}

export async function experimentForRevalidations(db: Db, tenantId: string, key: string): Promise<Experiment> {
  const exp = await findExperiment(db, tenantId, key);
  if (!exp) throw new RevalidationError('not_found', 'experiment not found');
  return exp;
}

// ---------------------------------------------------------------------------
// Pending re-validations
// ---------------------------------------------------------------------------

export interface PendingRevalidation {
  experiment: { id: string; name: string; subject_type: string; subject_name: string; baseline_version: number | null; candidate_version: number; decision: string | null; finished_at: Date | null };
  version_state: VersionState;
  labels: { usable: number; fresh: number; min_required: number; missing: number; excluded: number; unlabeled: number };
  outputs_source: 'metrics' | 'artifact' | null;
  /** Outputs available, enough labels and some not used by the last re-validation. */
  ready: boolean;
  last_revalidation: { id: string; verdict: string; created_at: Date; labels: number } | null;
  revalidate: string;
}

export async function pendingRevalidations(db: Db, opts: { tenantId: string; minLabels?: number | undefined; repoRoot?: string; limit?: number }): Promise<{ items: PendingRevalidation[]; ready: number }> {
  const exps = (await listExperiments(db, { tenantId: opts.tenantId, status: 'COMPLETED', limit: opts.limit ?? 200 })).filter((e) => e.decision === 'PASS_FORM');
  const items: PendingRevalidation[] = [];
  for (const exp of exps) {
    const versionState = await candidateVersionState(db, exp);
    if (!versionState.relevant) continue;
    const criteria = revalidationCriteria(exp, opts.minLabels);
    const outputs = outputsAvailability(exp, opts.repoRoot ?? REPO_ROOT);
    const { selection } = await selectionFor(db, exp, outputs.caseIds ?? undefined, []);
    const [last] = await listRevalidations(db, exp.tenantId, exp.id, 1);
    const used = new Set(last?.labelCaseIds ?? []);
    const fresh = selection.labels.filter((l) => !used.has(l.label_case_id)).length;
    const usable = selection.labels.length;
    items.push({
      experiment: { id: exp.id, name: exp.name, subject_type: exp.subjectType, subject_name: exp.subjectName, baseline_version: exp.baselineVersion, candidate_version: exp.candidateVersion, decision: exp.decision, finished_at: exp.finishedAt },
      version_state: versionState,
      labels: { usable, fresh, min_required: criteria.min_labels, missing: Math.max(0, criteria.min_labels - usable), excluded: selection.excluded.length, unlabeled: selection.unlabeled },
      outputs_source: outputs.source,
      ready: outputs.source !== null && usable >= criteria.min_labels && fresh > 0,
      last_revalidation: last ? { id: last.id, verdict: last.verdict, created_at: last.createdAt, labels: last.labelCaseIds.length } : null,
      revalidate: `POST /experiments/${exp.name}/revalidate`,
    });
  }
  return { items, ready: items.filter((i) => i.ready).length };
}

/** Number of re-validations ready to run (the passive counter of the metrics sync). */
export async function countReadyRevalidations(db: Db, tenantId: string): Promise<number> {
  return (await pendingRevalidations(db, { tenantId })).ready;
}
