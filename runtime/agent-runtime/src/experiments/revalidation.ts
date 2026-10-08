/**
 * Re-validation of PASS_FORM experiments, pure part (no I/O; the unit tests pin every rule).
 *
 * A PASS_FORM experiment measured rules, judge and cost but not accuracy: its split had 0
 * labelled cases. It stored what each arm decided on every case (`metrics.phases.<PHASE>.
 * case_outputs`, or the `informe.json` artifact for experiments older than that field). When a
 * person later labels the same entities (HUMAN verdicts in Twenty, harvested into a newer
 * version of the dataset), the accuracy of each arm can be measured on those stored outputs:
 * no model runs, cost 0.
 *
 * Which labels count (P5):
 * - Only entities the experiment executed (VALIDATION, TEST and the TRAIN form sample).
 * - A label is the latest HUMAN verdict on the entity (`expected_source: human`) in any version
 *   of the experiment's dataset; a held-out case that was already labelled at run time counts
 *   with its own label.
 * - Never a design case of the candidate: an entity with a `design` use by one of the
 *   candidate's optimizer runs (`OPT-*`), or by anyone before the experiment started (design
 *   material that could have shaped the candidate), is excluded. A design use recorded later
 *   by someone else (e.g. the next optimizer run) does not taint this candidate.
 * - A TRAIN form-sample case that was already labelled at run time is excluded too: TRAIN is
 *   design material, its label was visible to whoever designed the candidate.
 *
 * Verdict, with the accuracy criterion of the experiment's own gate (`gate.accuracy.min_delta`):
 * - INSUFFICIENT: fewer usable labels than `min_labels`, or an arm without decisions on them;
 * - CONFIRMED: accuracy(candidate) >= accuracy(baseline) + min_delta;
 * - REFUTED: otherwise.
 */
import { createHash } from 'node:crypto';
import type { CaseUse, Experiment, RevalidationVerdict } from '../db/schema.js';
import { DEFAULT_GATE_CONFIG, type AccuracyMetric } from './gate.js';
import { caseOutputsOf, decisionMatches, isLabeled, pickExpected, type CaseOutput } from './metrics.js';

/** Labels needed for a verdict (the optimizer's `min_labeled_validation` default). */
export const DEFAULT_MIN_REVALIDATION_LABELS = 5;
const EPS = 1e-9;
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export type ExecutedUse = 'validation' | 'test' | 'form_sample';

/** A case the experiment executed, with what the dataset says about it today. */
export interface ExecutedCase {
  case_id: string;
  phase: string;
  use: ExecutedUse;
  entity_key: string;
  exhibitor: string;
  input: Record<string, unknown>;
  /** expected of the executed case (frozen: cases are immutable). */
  expected: Record<string, unknown>;
  source: Record<string, unknown>;
  used_by: readonly CaseUse[];
}

/** A HUMAN-labelled case of the same dataset name (any version) for an executed entity. */
export interface LabelCandidate {
  case_id: string;
  dataset_id: string;
  dataset_version: number;
  entity_key: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  source: Record<string, unknown>;
  used_by: readonly CaseUse[];
}

export interface RevalidationLabel {
  executed_case_id: string;
  label_case_id: string;
  dataset_id: string | null;
  dataset_version: number | null;
  entity_key: string;
  exhibitor: string;
  phase: string;
  use: ExecutedUse;
  /** `later_version`: a newer dataset version labelled the entity; `at_run`: the held-out case already had it. */
  origin: 'later_version' | 'at_run';
  evaluation_id: string | null;
  evaluation_ids: string[];
  evaluated_at: string | null;
  expected: Record<string, unknown>;
  /** The labelled occurrence has the same input the experiment ran (same event and exhibitor data). */
  input_same: boolean;
}

export type ExclusionReason = 'design' | 'train_label_at_run' | 'no_outputs';

export interface ExcludedLabel {
  executed_case_id: string;
  label_case_id: string | null;
  entity_key: string;
  exhibitor: string;
  reason: ExclusionReason;
  detail: string;
}

export interface LabelSelection {
  labels: RevalidationLabel[];
  excluded: ExcludedLabel[];
  /** Executed entities with no label yet. */
  unlabeled: number;
}

/** Cases the experiment executed, from its `splits` (case_ids and form_sample_case_ids per phase). */
export function executedCaseRefs(exp: Pick<Experiment, 'splits'>): Array<{ case_id: string; phase: string; use: ExecutedUse }> {
  const out: Array<{ case_id: string; phase: string; use: ExecutedUse }> = [];
  const seen = new Set<string>();
  for (const [phase, raw] of Object.entries(exp.splits ?? {})) {
    const s = (raw ?? {}) as { role?: unknown; case_ids?: unknown; form_sample_case_ids?: unknown };
    const role: ExecutedUse = s.role === 'test' || phase === 'TEST' ? 'test' : 'validation';
    const push = (ids: unknown, use: ExecutedUse) => {
      if (!Array.isArray(ids)) return;
      for (const id of ids) if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id);
        out.push({ case_id: id, phase, use });
      }
    };
    push(s.case_ids, role);
    push(s.form_sample_case_ids, 'form_sample');
  }
  return out;
}

/** Per-case outputs stored in the experiment row (`metrics.phases.*.case_outputs`); null when the experiment predates them. */
export function storedCaseOutputs(exp: Pick<Experiment, 'metrics'>): CaseOutput[] | null {
  const phases = (exp.metrics?.phases ?? {}) as Record<string, { case_outputs?: unknown }>;
  let found = false;
  const out: CaseOutput[] = [];
  for (const p of Object.values(phases)) {
    if (!Array.isArray(p?.case_outputs)) continue;
    found = true;
    for (const o of p.case_outputs as CaseOutput[]) if (o && typeof o.case_id === 'string' && Number.isInteger(o.version)) out.push(o);
  }
  return found ? out : null;
}

/** Per-case outputs from an `informe.json` written by `pnpm experiment:run` (fixtures + reports per phase). */
export function caseOutputsFromReport(json: unknown, experimentId?: string): CaseOutput[] {
  const r = json as { experiment?: { id?: unknown }; phases?: unknown };
  if (!r || typeof r !== 'object' || !Array.isArray(r.phases)) throw new Error('no parece un informe.json de experiment:run (falta "phases")');
  if (experimentId && r.experiment?.id !== undefined && r.experiment.id !== experimentId) throw new Error(`el informe es del experimento ${String(r.experiment.id)}, no de ${experimentId}`);
  const out: CaseOutput[] = [];
  for (const p of r.phases as Array<{ fixtures?: unknown; reports?: unknown }>) {
    if (!Array.isArray(p?.fixtures) || !Array.isArray(p?.reports)) continue;
    out.push(...caseOutputsOf({ fixtures: p.fixtures as Array<{ case_ids: string[] }>, reports: p.reports as Parameters<typeof caseOutputsOf>[0]['reports'] }));
  }
  return out;
}

/** A design use that could have shaped the candidate (see the module comment). */
export function candidateDesignUse(uses: readonly CaseUse[], designExperiments: ReadonlySet<string>, cutoff: Date): CaseUse | null {
  for (const u of uses) {
    if (u.role !== 'design') continue;
    if (designExperiments.has(u.experiment)) return u;
    const at = Date.parse(u.at);
    // An undated design use is treated as prior design (conservative).
    if (!Number.isFinite(at) || at < cutoff.getTime()) return u;
  }
  return null;
}

const isHumanLabel = (c: { expected: Record<string, unknown>; source: Record<string, unknown> }) =>
  isLabeled(c.expected) && c.source.expected_source === 'human' && (typeof c.expected.relevant === 'boolean' || typeof c.expected.writable === 'boolean');

const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

export interface SelectLabelsArgs {
  executed: readonly ExecutedCase[];
  candidates: readonly LabelCandidate[];
  /** `used_by.experiment` ids of the candidate's own design work (its optimizer runs, `OPT-*`). */
  designExperiments: ReadonlySet<string>;
  /** Design uses before this instant count as the candidate's design material (the experiment start). */
  designCutoff: Date;
  /** Case ids with stored outputs; when given, labels without outputs are excluded (`no_outputs`). */
  withOutputs?: ReadonlySet<string>;
}

export function selectLabels(args: SelectLabelsArgs): LabelSelection {
  const byEntity = new Map<string, LabelCandidate[]>();
  for (const c of args.candidates) {
    if (!isHumanLabel(c)) continue;
    const list = byEntity.get(c.entity_key) ?? [];
    list.push(c);
    byEntity.set(c.entity_key, list);
  }
  const out: LabelSelection = { labels: [], excluded: [], unlabeled: 0 };
  const seenEntities = new Set<string>();
  for (const e of args.executed) {
    if (seenEntities.has(e.entity_key)) continue;
    seenEntities.add(e.entity_key);
    const cands = (byEntity.get(e.entity_key) ?? []).slice().sort((a, b) => String(b.source.evaluated_at ?? '').localeCompare(String(a.source.evaluated_at ?? '')) || b.dataset_version - a.dataset_version);
    const labeledAtRun = isLabeled(e.expected);
    const best = cands[0] ?? null;
    if (!labeledAtRun && !best) {
      out.unlabeled++;
      continue;
    }
    const exclude = (reason: ExclusionReason, detail: string, labelCaseId: string | null) =>
      out.excluded.push({ executed_case_id: e.case_id, label_case_id: labelCaseId, entity_key: e.entity_key, exhibitor: e.exhibitor, reason, detail });
    const design = candidateDesignUse([...e.used_by, ...cands.flatMap((c) => c.used_by)], args.designExperiments, args.designCutoff);
    if (design) {
      exclude('design', `caso de diseño: ${design.experiment} ${design.role} (${design.at})`, best?.case_id ?? null);
      continue;
    }
    if (labeledAtRun && e.use === 'form_sample') {
      exclude('train_label_at_run', 'la etiqueta ya estaba en TRAIN al ejecutar el experimento (material de diseño)', e.case_id);
      continue;
    }
    if (args.withOutputs && !args.withOutputs.has(e.case_id)) {
      exclude('no_outputs', 'el experimento no guardó decisiones de este caso (presupuesto o entrada no utilizable)', best?.case_id ?? (labeledAtRun ? e.case_id : null));
      continue;
    }
    if (labeledAtRun) {
      out.labels.push({
        executed_case_id: e.case_id,
        label_case_id: e.case_id,
        dataset_id: null,
        dataset_version: null,
        entity_key: e.entity_key,
        exhibitor: e.exhibitor,
        phase: e.phase,
        use: e.use,
        origin: 'at_run',
        evaluation_id: typeof e.source.evaluation_id === 'string' ? e.source.evaluation_id : null,
        evaluation_ids: Array.isArray(e.source.evaluation_ids) ? (e.source.evaluation_ids as unknown[]).map(String) : typeof e.source.evaluation_id === 'string' ? [e.source.evaluation_id] : [],
        evaluated_at: typeof e.source.evaluated_at === 'string' ? e.source.evaluated_at : null,
        expected: pickExpected(e.expected),
        input_same: true,
      });
      continue;
    }
    const b = best!;
    out.labels.push({
      executed_case_id: e.case_id,
      label_case_id: b.case_id,
      dataset_id: b.dataset_id,
      dataset_version: b.dataset_version,
      entity_key: e.entity_key,
      exhibitor: e.exhibitor,
      phase: e.phase,
      use: e.use,
      origin: 'later_version',
      evaluation_id: typeof b.source.evaluation_id === 'string' ? b.source.evaluation_id : null,
      evaluation_ids: Array.isArray(b.source.evaluation_ids) ? (b.source.evaluation_ids as unknown[]).map(String) : typeof b.source.evaluation_id === 'string' ? [b.source.evaluation_id] : [],
      evaluated_at: typeof b.source.evaluated_at === 'string' ? b.source.evaluated_at : null,
      expected: pickExpected(b.expected),
      input_same: stable(b.input) === stable(e.input),
    });
  }
  return out;
}

/** Accuracy of one arm on the stored outputs (same matching rule as the gate: `decisionMatches`). */
export function revalidationAccuracy(version: number, outputs: readonly CaseOutput[], labels: readonly RevalidationLabel[]): AccuracyMetric {
  const byCase = new Map(labels.map((l) => [l.executed_case_id, l]));
  const acc: AccuracyMetric = { labeled_cases: 0, decisions: 0, correct: 0, value: null, mismatches: [] };
  const casesWithDecisions = new Set<string>();
  for (const o of outputs) {
    if (o.version !== version) continue;
    const l = byCase.get(o.case_id);
    if (!l) continue;
    casesWithDecisions.add(o.case_id);
    acc.decisions++;
    if (decisionMatches(l.expected, o)) acc.correct++;
    else acc.mismatches.push({ case_id: o.case_id, exhibitor: l.exhibitor, repetition: o.repetition, expected: l.expected, got: { relevant: o.relevant, writable: o.writable, confidence: o.confidence } });
  }
  acc.labeled_cases = casesWithDecisions.size;
  acc.value = acc.decisions > 0 ? round(acc.correct / acc.decisions) : null;
  return acc;
}

export interface RevalidationCriteria {
  min_labels: number;
  /** accuracy(candidate) >= accuracy(baseline) + min_delta: the experiment's own gate. */
  min_delta: number;
  /** Whether the experiment's gate had the accuracy criterion on (it is measured either way). */
  gate_accuracy_enabled: boolean;
}

export function revalidationCriteria(exp: Pick<Experiment, 'config'>, minLabels?: number): RevalidationCriteria {
  const gate = (exp.config?.gate ?? {}) as { accuracy?: { enabled?: unknown; min_delta?: unknown } };
  const minDelta = typeof gate.accuracy?.min_delta === 'number' && Number.isFinite(gate.accuracy.min_delta) ? gate.accuracy.min_delta : DEFAULT_GATE_CONFIG.accuracy.min_delta;
  const n = minLabels ?? DEFAULT_MIN_REVALIDATION_LABELS;
  if (!Number.isInteger(n) || n < 1) throw new Error('min_labels debe ser un entero ≥ 1');
  return { min_labels: n, min_delta: minDelta, gate_accuracy_enabled: gate.accuracy?.enabled !== false };
}

export interface VerdictResult {
  verdict: RevalidationVerdict;
  /** The bar the candidate had to clear (null when INSUFFICIENT). */
  threshold: number | null;
  /** Labels still missing to reach `min_labels` (0 when enough). */
  missing: number;
  summary: string;
}

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));

export function revalidationVerdict(a: { labels: number; criteria: RevalidationCriteria; baseline: AccuracyMetric; candidate: AccuracyMetric; baselineVersion: number | null; candidateVersion: number }): VerdictResult {
  const missing = Math.max(0, a.criteria.min_labels - a.labels);
  if (missing > 0) return { verdict: 'INSUFFICIENT', threshold: null, missing, summary: `INSUFFICIENT: ${a.labels} etiqueta(s) utilizable(s) de ${a.criteria.min_labels} necesarias (faltan ${missing}).` };
  if (a.baseline.value === null || a.candidate.value === null) return { verdict: 'INSUFFICIENT', threshold: null, missing: 0, summary: 'INSUFFICIENT: alguna versión no tiene decisiones guardadas sobre los casos etiquetados.' };
  const threshold = round(a.baseline.value + a.criteria.min_delta);
  const ok = a.candidate.value >= threshold - EPS;
  const nums = `v${a.candidateVersion} ${fmt(a.candidate.value)} (${a.candidate.correct}/${a.candidate.decisions}) frente a v${a.baselineVersion ?? '—'} ${fmt(a.baseline.value)} (${a.baseline.correct}/${a.baseline.decisions}) sobre ${a.labels} caso(s) etiquetado(s)`;
  return ok
    ? { verdict: 'CONFIRMED', threshold, missing: 0, summary: `CONFIRMED: la candidata iguala o supera a la baseline en accuracy: ${nums}.` }
    : { verdict: 'REFUTED', threshold, missing: 0, summary: `REFUTED: la candidata queda por debajo de la baseline en accuracy: ${nums} (umbral ${fmt(threshold)}).` };
}

/** Identity of a re-validation: the labels used and the criteria (same labels -> same record). */
export function labelsHash(labels: readonly RevalidationLabel[], criteria: RevalidationCriteria): string {
  const key = labels.map((l) => `${l.executed_case_id}|${l.label_case_id}|${l.evaluation_id ?? ''}`).sort();
  return createHash('sha256').update(JSON.stringify({ labels: key, min_labels: criteria.min_labels, min_delta: criteria.min_delta })).digest('hex');
}

// ---------------------------------------------------------------------------
// The note a REFUTED re-validation of a version still in use leaves in Twenty.
// ---------------------------------------------------------------------------

export interface VersionState {
  /** ACTIVE: the version serves every run; CANARY: an ACTIVE canary routes runs to it; INACTIVE otherwise. */
  state: 'ACTIVE' | 'CANARY' | 'INACTIVE' | 'MISSING';
  /** Status of the version row today. */
  status: string | null;
  canary: { id: string; percent: number; stable_version: number } | null;
  /** ACTIVE or CANARY: a REFUTED here deserves a human decision. */
  relevant: boolean;
}

export function revalidationNoteTitle(subjectName: string, version: number): string {
  return `⚠️ Revalidación fallida — ${subjectName} v${version}`;
}

export interface RevalidationNoteInput {
  tenantId: string;
  revalidationId: string;
  experimentName: string;
  subjectType: 'skill' | 'harness';
  subjectName: string;
  baselineVersion: number | null;
  candidateVersion: number;
  summary: string;
  baseline: AccuracyMetric;
  candidate: AccuracyMetric;
  criteria: RevalidationCriteria;
  labels: number;
  excluded: number;
  versionState: VersionState;
  apiUrl?: string;
}

export function revalidationNoteMarkdown(i: RevalidationNoteInput): string {
  const api = (i.apiUrl ?? 'http://127.0.0.1:4020').replace(/\/$/, '');
  const route = i.subjectType === 'harness' ? 'harnesses' : 'skills';
  const h = `-H 'x-tenant-id: ${i.tenantId}'`;
  const where = i.versionState.state === 'CANARY' ? `en canario (${i.versionState.canary?.percent ?? '?'} % de las ejecuciones, estable v${i.versionState.canary?.stable_version ?? '?'})` : 'ACTIVE (todas las ejecuciones)';
  const row = (label: string, a: AccuracyMetric) => `| ${label} | ${fmt(a.value)} | ${a.correct}/${a.decisions} | ${a.labeled_cases} |`;
  const mism = i.candidate.mismatches.slice(0, 10).map((m) => `- ${m.exhibitor} (r${m.repetition}): esperado ${JSON.stringify(m.expected)}, la candidata dio ${JSON.stringify(m.got)}`);
  const rollback =
    i.versionState.state === 'CANARY'
      ? `\`curl -s -X POST ${api}/skills/${i.subjectName}/canary/rollback ${h} -H 'content-type: application/json' -d '{"by":"<quién>","reason":"revalidación ${i.experimentName} REFUTED"}'\``
      : `\`curl -s -X POST ${api}/${route}/${i.subjectName}/versions/${i.baselineVersion ?? '<anterior>'}/activate ${h}\` (rollback a la v${i.baselineVersion ?? '—'}: siempre permitido)`;
  const lines = [
    `La revalidación del experimento **${i.experimentName}** (PASS_FORM, sin etiquetas cuando se ejecutó) con veredictos humanos posteriores **refuta** la mejora de **${i.subjectName} v${i.candidateVersion}**, que hoy está ${where}. **No se ha cambiado nada**: decidir es humano.`,
    '',
    `## Resultado`,
    '',
    i.summary,
    '',
    '| Versión | Accuracy | Correctas/decisiones | Casos etiquetados |',
    '|---|---|---|---|',
    row(`v${i.baselineVersion ?? '—'} (baseline)`, i.baseline),
    row(`v${i.candidateVersion} (candidata)`, i.candidate),
    '',
    `- Etiquetas usadas: ${i.labels} (mínimo ${i.criteria.min_labels}); excluidas por P5 u otras causas: ${i.excluded}.`,
    `- Criterio del gate del experimento: accuracy(candidata) ≥ accuracy(baseline) + ${i.criteria.min_delta}. Coste de la revalidación: 0 € (sin llamadas a modelos).`,
    ...(mism.length ? ['', '### Decisiones de la candidata que no coinciden con la etiqueta', '', ...mism] : []),
    '',
    '## Opciones',
    '',
    `1. **Rollback**: ${rollback}.`,
    i.subjectType === 'skill'
      ? `2. **Canario**: ${i.versionState.state === 'CANARY' ? 'mantener el canario con un porcentaje menor (rollback y canario nuevo, `POST /skills/:id/versions/:v/canary`) para seguir midiendo con poca exposición' : `volver a la v${i.baselineVersion ?? '—'} y enviar solo un % a la v${i.candidateVersion} (\`POST ${api}/skills/${i.subjectName}/versions/${i.candidateVersion}/canary\`, \`{"percent":10}\`) para seguir midiendo con poca exposición`}.`
      : '2. **Canario**: no hay canario de harness; la alternativa es el rollback.',
    `3. **Iterar**: una candidata nueva que corrija los fallos de arriba (\`POST ${api}/optimizer/skills/${i.subjectType === 'skill' ? i.subjectName : '<skill>'}/run\`, o a mano) y un experimento nuevo: con estas etiquetas ya no será modo forma.`,
    '',
    `Detalle: \`GET ${api}/experiments/${i.experimentName}/revalidations\` (revalidación \`${i.revalidationId}\`).`,
  ];
  return lines.join('\n');
}
