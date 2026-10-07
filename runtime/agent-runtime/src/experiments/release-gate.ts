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
 * - without it, only `force: true` with a `reason` lets it through: a human override, logged
 *   and returned in the response. The system never forces (no runtime code calls activate).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { experiments, type Experiment, type ExperimentSubjectType } from '../db/schema.js';
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

export type ActivationGate =
  | { mode: 'noop'; detail: string }
  | { mode: 'rollback'; detail: string }
  | { mode: 'experiment'; experiment: ReturnType<typeof experimentSummary>; revalidate: boolean; detail: string }
  | { mode: 'override'; override: true; reason: string; by: string | null; blocked: string; experiment: ReturnType<typeof experimentSummary> | null; detail: string };

export class ReleaseGateBlockedError extends Error {
  readonly code = 'release_gate_blocked';
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
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
  if (gate.mode === 'override') req.log.warn({ ...base, reason: gate.reason, by: gate.by, blocked: gate.blocked, experiment: gate.experiment?.name ?? null }, 'release gate override (human)');
  else req.log.info({ ...base, detail: gate.detail, ...(gate.mode === 'experiment' ? { experiment: gate.experiment.name, decision: gate.experiment.decision } : {}) }, 'release gate passed');
}

function candidateIdOf(e: Experiment): string | null {
  const c = (e.config as { candidate?: { version_id?: unknown } }).candidate;
  return typeof c?.version_id === 'string' ? c.version_id : null;
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

  if (latest && latest.decision && ACTIVATING_DECISIONS.includes(latest.decision)) {
    const revalidate = latest.decision === 'PASS_FORM';
    return {
      mode: 'experiment',
      experiment: experimentSummary(latest),
      revalidate,
      detail: `${latest.name} ${latest.decision} frente a v${latest.baselineVersion ?? '—'}${revalidate ? ' (modo forma: re-validar cuando haya casos etiquetados)' : ''}`,
    };
  }

  const blocked = latest
    ? `el último experimento de v${target.version} frente a la v${args.activeVersion ?? '—'} activa (${latest.name}) decidió ${latest.decision}`
    : sameCandidate.length > 0
      ? `los experimentos de v${target.version} (${sameCandidate.map((e) => `${e.name} vs v${e.baselineVersion ?? '—'}`).join(', ')}) no se hicieron contra la versión activa (v${args.activeVersion ?? '—'})`
      : `no hay ningún experimento COMPLETED de ${args.subjectType} ${args.subjectName} v${target.version}`;

  const o = args.override;
  if (o?.force === true && typeof o.reason === 'string' && o.reason.trim().length >= MIN_OVERRIDE_REASON) {
    return { mode: 'override', override: true, reason: o.reason.trim(), by: o.by?.trim() || null, blocked, experiment: latest ? experimentSummary(latest) : null, detail: `override humano: ${blocked}` };
  }
  throw new ReleaseGateBlockedError(`Release Gate: ${blocked}. Ejecuta un experimento (pnpm experiment:run) o fuerza con { "force": true, "reason": "…" } (decisión humana).`, {
    subject_type: args.subjectType,
    subject_name: args.subjectName,
    candidate_version: target.version,
    active_version: args.activeVersion,
    required: `experimento COMPLETED con decision ${ACTIVATING_DECISIONS.join(' o ')} y baseline = versión activa`,
    experiments: done.map(experimentSummary),
    override: `{ "force": true, "reason": "mínimo ${MIN_OVERRIDE_REASON} caracteres", "by": "quién" }`,
  });
}
