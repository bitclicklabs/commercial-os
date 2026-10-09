/**
 * Launch of one Skill Optimizer run: the single path shared by `POST /optimizer/skills/:name/run`
 * (manual) and the scheduled job (src/optimizer/schedule-job.ts), so a scheduled run is
 * identical to a manual one: same checks, same default budgets (optimizerConfig), same queue.
 *
 *   skill exists -> has an experiment runner -> has an ACTIVE version (the base) -> config
 *   -> queue present -> PENDING run (one open run per skill: conflict) -> enqueue
 *
 * A run that cannot be enqueued goes to ERROR at once (a PENDING run nobody processes would
 * block the skill until the stale check) and the error carries it.
 */
import type { Db } from '../db/client.js';
import type { OptimizationRun } from '../db/schema.js';
import { findSkill, listVersions } from '../skills/service.js';
import { OPTIMIZABLE_SKILLS, optimizerConfig, type OptimizerConfig } from './core.js';
import type { OptimizerQueue } from './queue.js';
import { createRun, transitionRun } from './service.js';

export type OptimizerLaunchErrorCode = 'skill_not_found' | 'unsupported_skill' | 'no_active_version' | 'invalid_config' | 'no_queue' | 'queue_unavailable';

export class OptimizerLaunchError extends Error {
  constructor(
    readonly code: OptimizerLaunchErrorCode,
    message: string,
    /** `queue_unavailable`: the run, already closed as ERROR. */
    readonly run?: OptimizationRun,
  ) {
    super(message);
    this.name = 'OptimizerLaunchError';
  }
}

export interface LaunchRunArgs {
  tenantId: string;
  /** Name (or id) of the skill. */
  skill: string;
  /** Overrides of the defaults (the scheduled job passes none). */
  overrides?: Partial<OptimizerConfig>;
  createdBy?: string | null;
}

/**
 * Creates the PENDING run and enqueues it. Throws OptimizerLaunchError (or the
 * OptimizerServiceError `conflict` of createRun when the skill already has an open run).
 */
export async function launchOptimizationRun(db: Db, queue: OptimizerQueue | undefined, args: LaunchRunArgs): Promise<OptimizationRun> {
  const skill = await findSkill(db, args.tenantId, args.skill);
  if (!skill) throw new OptimizerLaunchError('skill_not_found', 'skill not found');
  if (!OPTIMIZABLE_SKILLS[skill.name]) {
    throw new OptimizerLaunchError('unsupported_skill', `no hay optimizador para la skill "${skill.name}": necesita un runner de experimentos (soportadas: ${Object.keys(OPTIMIZABLE_SKILLS).join(', ')})`);
  }
  const active = (await listVersions(db, skill.id)).find((v) => v.status === 'ACTIVE');
  if (!active) throw new OptimizerLaunchError('no_active_version', `la skill ${skill.name} no tiene versión ACTIVE (la base del optimizador)`);
  let config: OptimizerConfig;
  try {
    // model: role `optimizer` of the model router (MODEL_ROUTE_OPTIMIZER > GEMINI_MODEL > code table).
    config = optimizerConfig(skill.name, args.overrides ?? {});
  } catch (err) {
    throw new OptimizerLaunchError('invalid_config', err instanceof Error ? err.message : String(err));
  }
  if (!queue) throw new OptimizerLaunchError('no_queue', 'el optimizador no tiene cola en este proceso (rol api sin Redis)');
  const run = await createRun(db, { tenantId: args.tenantId, skillName: skill.name, baseVersion: active.version, config: config as unknown as Record<string, unknown>, createdBy: args.createdBy ?? null });
  try {
    await queue.enqueue({ tenantId: args.tenantId, runId: run.id });
  } catch (err) {
    const closed = await transitionRun(db, run.id, 'ERROR', { error: `no se pudo encolar: ${err instanceof Error ? err.message : String(err)}` }, 'PENDING');
    throw new OptimizerLaunchError('queue_unavailable', 'no se pudo encolar el run (¿Redis?): queda en ERROR; repite la petición', closed);
  }
  return run;
}
