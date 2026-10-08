/**
 * The Release Gate on activation (LLD v0.1 section 19: "ningún agente puede promoverse a
 * producción a sí mismo"). `POST /skills/:id/versions/:v/activate` (and the harness one) runs
 * this check INSIDE the activation transaction, after locking the subject row:
 *
 * - target already ACTIVE: no-op (idempotent call), nothing to check;
 * - target was ACTIVE before (`activated_at` set, now DEPRECATED): rollback, allowed (LLD
 *   section 11.7, rollback must always be possible);
 * - otherwise it needs the latest COMPLETED experiment for (subject, candidate version) whose
 *   baseline is the CURRENT active version to have decision PASS or PASS_FORM. A PASS_FORM is
 *   reported as such (`revalidate: true`);
 * - re-validation (src/experiments/revalidation-service.ts): the MOST RECENT row of
 *   `experiment_revalidations` of that experiment decides on top of it. REFUTED blocks like a
 *   failing experiment (`reason: 'revalidation_refuted'`, citing the re-validation and the
 *   options: force with a reason / iterate / rollback); CONFIRMED passes with
 *   `revalidated: true` (and `revalidate: false`: nothing pending); INSUFFICIENT or no
 *   re-validation changes nothing. The experiment's stored decision is never touched (it is
 *   immutable). Only PASS_FORM experiments can be re-validated today, but the check does not
 *   look at the decision: a PASS with a REFUTED row (inserted by hand) is blocked too;
 * - without it, only `force: true` with a `reason` lets it through: a human override, logged
 *   and returned in the response. The system never forces (no runtime code calls activate).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { experimentRevalidations, experiments, type Experiment, type ExperimentRevalidation, type ExperimentSubjectType } from '../db/schema.js';
import { ACTIVATING_DECISIONS } from './gate.js';
import { experimentSummary } from './service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

export interface ActivationOverride {
  force?: boolean | undefined;
  reason?: string | undefined;
  by?: string | undefined;
}

export interface GateTarget {
  id: string;
  version: number;
  status: string;
  activatedAt: Date | null;
}

/** Why the gate blocks (409 `details.reason`; `blocked_reason` of an override). */
export type GateBlockReason = 'no_experiment' | 'baseline_mismatch' | 'experiment_decision' | 'revalidation_refuted';

/** The re-validation the gate read (the most recent one of the experiment). */
export interface GateRevalidation {
  id: string;
  verdict: ExperimentRevalidation['verdict'];
  created_at: string;
  baseline_accuracy: number | null;
  candidate_accuracy: number | null;
  labels: number;
  labels_hash: string;
  summary: string;
}

export type ActivationGate =
  | { mode: 'noop'; detail: string }
  | { mode: 'rollback'; detail: string }
  | {
      mode: 'experiment';
      experiment: ReturnType<typeof experimentSummary>;
      /** PASS_FORM still waiting for a re-validation that confirms it. */
      revalidate: boolean;
      /** The most recent re-validation CONFIRMED the experiment (informative: its stored decision does not change). */
      revalidated: boolean;
      revalidation: GateRevalidation | null;
      detail: string;
    }
  | {
      mode: 'override';
      override: true;
      reason: string;
      by: string | null;
      blocked: string;
      blocked_reason: GateBlockReason;
      experiment: ReturnType<typeof experimentSummary> | null;
      revalidation: GateRevalidation | null;
      detail: string;
    };

export class ReleaseGateBlockedError extends Error {
  readonly code = 'release_gate_blocked';
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
    /** The bare reason, without advice (the canary guard re-words the message with it). */
    readonly why: string = message,
  ) {
    super(message);
    this.name = 'ReleaseGateBlockedError';
  }
}

export const MIN_OVERRIDE_REASON = 10;

interface GateLogger {
  log: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
}

/** Logs the gate outcome of an activation; an override is a WARN line with reason and author. */
export function logGate(req: GateLogger, subjectType: ExperimentSubjectType, subject: string, version: number, gate: ActivationGate | undefined): void {
  if (!gate || gate.mode === 'noop') return;
  const base = { release_gate: gate.mode, subject_type: subjectType, subject, version };
  if (gate.mode === 'override')
    req.log.warn(
      { ...base, reason: gate.reason, by: gate.by, blocked: gate.blocked, blocked_reason: gate.blocked_reason, experiment: gate.experiment?.name ?? null, revalidation: gate.revalidation?.id ?? null },
      'release gate override (human)',
    );
  else
    req.log.info(
      { ...base, detail: gate.detail, ...(gate.mode === 'experiment' ? { experiment: gate.experiment.name, decision: gate.experiment.decision, revalidated: gate.revalidated, revalidation: gate.revalidation?.id ?? null } : {}) },
      'release gate passed',
    );
}

function candidateIdOf(e: Experiment): string | null {
  const c = (e.config as { candidate?: { version_id?: unknown } }).candidate;
  return typeof c?.version_id === 'string' ? c.version_id : null;
}

export function gateRevalidation(r: ExperimentRevalidation): GateRevalidation {
  return {
    id: r.id,
    verdict: r.verdict,
    created_at: r.createdAt.toISOString(),
    baseline_accuracy: r.baselineAccuracy,
    candidate_accuracy: r.candidateAccuracy,
    labels: r.labelCaseIds.length,
    labels_hash: r.labelsHash,
    summary: r.summary,
  };
}

/**
 * The most recent re-validation of an experiment (null without any). Rows are append-only, one
 * per label set; a tie on `created_at` (same transaction) falls back to the id: stable.
 */
export async function latestRevalidation(conn: Conn, tenantId: string, experimentId: string): Promise<ExperimentRevalidation | null> {
  const [row] = await conn
    .select()
    .from(experimentRevalidations)
    .where(and(eq(experimentRevalidations.tenantId, tenantId), eq(experimentRevalidations.experimentId, experimentId)))
    .orderBy(desc(experimentRevalidations.createdAt), desc(experimentRevalidations.id))
    .limit(1);
  return row ?? null;
}

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`);

export type RevalidationEffect = { effect: 'block'; blocked: string } | { effect: 'pass'; revalidated: boolean; revalidate: boolean; note: string };

/**
 * What the most recent re-validation does to an activating experiment (pure, unit tested):
 * REFUTED blocks, CONFIRMED passes as re-validated, INSUFFICIENT or none leaves it as it was.
 */
export function revalidationEffect(exp: Pick<Experiment, 'name' | 'decision' | 'candidateVersion' | 'baselineVersion'>, reval: GateRevalidation | null): RevalidationEffect {
  const form = exp.decision === 'PASS_FORM';
  if (reval?.verdict === 'REFUTED') {
    return {
      effect: 'block',
      blocked:
        `la revalidación más reciente de ${exp.name} (${reval.id}, ${reval.created_at}) la REFUTÓ con ${reval.labels} etiqueta(s): ` +
        `accuracy de v${exp.candidateVersion} ${pct(reval.candidate_accuracy)} frente a ${pct(reval.baseline_accuracy)} de v${exp.baselineVersion ?? '—'}`,
    };
  }
  if (reval?.verdict === 'CONFIRMED') {
    return { effect: 'pass', revalidated: true, revalidate: false, note: ` (revalidado: CONFIRMED ${reval.created_at}, accuracy ${pct(reval.candidate_accuracy)} frente a ${pct(reval.baseline_accuracy)})` };
  }
  return { effect: 'pass', revalidated: false, revalidate: form, note: form ? ' (modo forma: re-validar cuando haya casos etiquetados)' : '' };
}

/** What a human can do when the re-validation refuted the experiment (409 `details.options`). A canary has no force. */
export function refutedOptions(subjectType: ExperimentSubjectType, subjectName: string, version: number, canary: boolean): Record<string, string> {
  const base = `/${subjectType === 'harness' ? 'harnesses' : 'skills'}/${subjectName}`;
  return {
    ...(canary ? {} : { force: `POST ${base}/versions/${version}/activate { "force": true, "reason": "mínimo ${MIN_OVERRIDE_REASON} caracteres", "by": "quién" } (decisión humana, auditada como ${subjectType}.force_activate)` }),
    iterate: `crea una versión nueva (POST ${base}/versions${subjectType === 'skill' ? ' o el Skill Optimizer' : ''}) y ejecuta un experimento contra la versión activa`,
    rollback:
      subjectType === 'skill'
        ? `quédate en la versión estable: no actives v${version}; si está en canario, POST ${base}/canary/rollback`
        : `quédate en la versión estable: no actives v${version}`,
  };
}

export async function checkActivationGate(
  conn: Conn,
  args: { tenantId: string; subjectType: ExperimentSubjectType; subjectName: string; target: GateTarget; activeVersion: number | null; override?: ActivationOverride | undefined },
): Promise<ActivationGate> {
  const { target } = args;
  if (target.status === 'ACTIVE') return { mode: 'noop', detail: `v${target.version} ya está ACTIVE` };
  if (target.activatedAt !== null) return { mode: 'rollback', detail: `v${target.version} estuvo ACTIVE (${target.activatedAt.toISOString()}): rollback sin experimento` };

  const done = await conn
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.tenantId, args.tenantId),
        eq(experiments.subjectType, args.subjectType),
        eq(experiments.subjectName, args.subjectName),
        eq(experiments.candidateVersion, target.version),
        eq(experiments.status, 'COMPLETED'),
      ),
    )
    .orderBy(desc(experiments.number));
  const sameCandidate = done.filter((e) => candidateIdOf(e) === null || candidateIdOf(e) === target.id);
  const current = sameCandidate.filter((e) => e.baselineVersion === args.activeVersion);
  const latest = current[0] ?? null;

  let refuted: { blocked: string; revalidation: GateRevalidation } | null = null;
  if (latest && latest.decision && ACTIVATING_DECISIONS.includes(latest.decision)) {
    const row = await latestRevalidation(conn, args.tenantId, latest.id);
    const revalidation = row ? gateRevalidation(row) : null;
    const effect = revalidationEffect(latest, revalidation);
    if (effect.effect === 'pass') {
      return {
        mode: 'experiment',
        experiment: experimentSummary(latest),
        revalidate: effect.revalidate,
        revalidated: effect.revalidated,
        revalidation,
        detail: `${latest.name} ${latest.decision} frente a v${latest.baselineVersion ?? '—'}${effect.note}`,
      };
    }
    refuted = { blocked: effect.blocked, revalidation: revalidation! };
  }

  const reason: GateBlockReason = refuted ? 'revalidation_refuted' : latest ? 'experiment_decision' : sameCandidate.length > 0 ? 'baseline_mismatch' : 'no_experiment';
  const blocked = refuted
    ? refuted.blocked
    : latest
      ? `el último experimento de v${target.version} frente a la v${args.activeVersion ?? '—'} activa (${latest.name}) decidió ${latest.decision}`
      : sameCandidate.length > 0
        ? `los experimentos de v${target.version} (${sameCandidate.map((e) => `${e.name} vs v${e.baselineVersion ?? '—'}`).join(', ')}) no se hicieron contra la versión activa (v${args.activeVersion ?? '—'})`
        : `no hay ningún experimento COMPLETED de ${args.subjectType} ${args.subjectName} v${target.version}`;

  const o = args.override;
  if (o?.force === true && typeof o.reason === 'string' && o.reason.trim().length >= MIN_OVERRIDE_REASON) {
    return {
      mode: 'override',
      override: true,
      reason: o.reason.trim(),
      by: o.by?.trim() || null,
      blocked,
      blocked_reason: reason,
      experiment: latest ? experimentSummary(latest) : null,
      revalidation: refuted?.revalidation ?? null,
      detail: `override humano: ${blocked}`,
    };
  }
  const advice = refuted
    ? 'Opciones: fuerza con { "force": true, "reason": "…" } (decisión humana), itera (versión nueva + experimento) o quédate en la versión estable (rollback).'
    : 'Ejecuta un experimento (pnpm experiment:run) o fuerza con { "force": true, "reason": "…" } (decisión humana).';
  throw new ReleaseGateBlockedError(
    `Release Gate: ${blocked}. ${advice}`,
    {
      reason,
      subject_type: args.subjectType,
      subject_name: args.subjectName,
      candidate_version: target.version,
      active_version: args.activeVersion,
      required: refuted
        ? `experimento COMPLETED con decision ${ACTIVATING_DECISIONS.join(' o ')}, baseline = versión activa y cuya revalidación más reciente no sea REFUTED`
        : `experimento COMPLETED con decision ${ACTIVATING_DECISIONS.join(' o ')} y baseline = versión activa`,
      ...(refuted ? { experiment: experimentSummary(latest!), revalidation: refuted.revalidation, options: refutedOptions(args.subjectType, args.subjectName, target.version, false) } : {}),
      experiments: done.map(experimentSummary),
      override: `{ "force": true, "reason": "mínimo ${MIN_OVERRIDE_REASON} caracteres", "by": "quién" }`,
    },
    blocked,
  );
}
