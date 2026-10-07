/**
 * `optimization_runs` in the database (migration 0013). No DELETE (trigger). Every status
 * change is a guarded UPDATE: `WHERE id = ? AND status IN (<valid sources>)`, so two workers
 * (or a worker and a human close) can never both move a run, and an invalid transition writes
 * nothing. `details` is merged (`||`), never replaced, so a later step cannot lose what an
 * earlier one recorded.
 */
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pgErrorCode } from '../api/http.js';
import { optimizationRuns, skills, skillVersions, type ExperimentDecision, type OptimizationRun, type OptimizationRunStatus } from '../db/schema.js';
import { canTransition, OPEN_STATUSES, sourcesOf } from './core.js';

export class OptimizerServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OptimizerServiceError';
  }
}

export interface CreateRunArgs {
  tenantId: string;
  skillName: string;
  baseVersion: number;
  config: Record<string, unknown>;
  createdBy?: string | null;
}

/** New PENDING run. 409 when the skill already has an open run (partial unique index). */
export async function createRun(db: Db, args: CreateRunArgs): Promise<OptimizationRun> {
  try {
    const [row] = await db
      .insert(optimizationRuns)
      .values({ tenantId: args.tenantId, skillName: args.skillName, baseVersion: args.baseVersion, config: args.config, status: 'PENDING', createdBy: args.createdBy ?? null })
      .returning();
    return row!;
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      const open = await listRuns(db, { tenantId: args.tenantId, skillName: args.skillName, statuses: [...OPEN_STATUSES], limit: 1 });
      throw new OptimizerServiceError('conflict', `la skill ${args.skillName} ya tiene un run del optimizador en curso`, { run: open[0] ? { id: open[0].id, status: open[0].status } : null });
    }
    throw err;
  }
}

export async function findRun(db: Db, tenantId: string, id: string): Promise<OptimizationRun | null> {
  const [row] = await db.select().from(optimizationRuns).where(and(eq(optimizationRuns.tenantId, tenantId), eq(optimizationRuns.id, id))).limit(1);
  return row ?? null;
}

export async function requireRun(db: Db, tenantId: string, id: string): Promise<OptimizationRun> {
  const row = await findRun(db, tenantId, id);
  if (!row) throw new OptimizerServiceError('not_found', 'optimization run not found');
  return row;
}

export async function listRuns(db: Db, q: { tenantId: string; skillName?: string | undefined; statuses?: OptimizationRunStatus[] | undefined; limit?: number | undefined }): Promise<OptimizationRun[]> {
  const where: SQL[] = [eq(optimizationRuns.tenantId, q.tenantId)];
  if (q.skillName) where.push(eq(optimizationRuns.skillName, q.skillName));
  if (q.statuses && q.statuses.length > 0) where.push(inArray(optimizationRuns.status, q.statuses));
  return db
    .select()
    .from(optimizationRuns)
    .where(and(...where))
    .orderBy(desc(optimizationRuns.createdAt), desc(optimizationRuns.id))
    .limit(q.limit ?? 50);
}

export interface RunPatch {
  /** Merged into `details` (top-level keys replace, the rest is kept). */
  details?: Record<string, unknown>;
  failureClusters?: Record<string, unknown>[];
  proposedOps?: Record<string, unknown>[];
  candidateVersion?: number;
  experimentId?: string;
  verdict?: ExperimentDecision;
  costEur?: number;
  error?: string;
}

function setOf(patch: RunPatch): Partial<typeof optimizationRuns.$inferInsert> & Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.details) set.details = sql`${optimizationRuns.details} || ${JSON.stringify(patch.details)}::jsonb`;
  if (patch.failureClusters) set.failureClusters = patch.failureClusters;
  if (patch.proposedOps) set.proposedOps = patch.proposedOps;
  if (patch.candidateVersion !== undefined) set.candidateVersion = patch.candidateVersion;
  if (patch.experimentId !== undefined) set.experimentId = patch.experimentId;
  if (patch.verdict !== undefined) set.verdict = patch.verdict;
  if (patch.costEur !== undefined) set.costEur = Math.round(patch.costEur * 1e6) / 1e6;
  if (patch.error !== undefined) set.error = patch.error.slice(0, 4000);
  return set;
}

/**
 * Moves the run to `to` if (and only if) it is in a state from which `to` is valid. Returns the
 * updated row; throws `conflict` (nothing written) otherwise.
 */
export async function transitionRun(db: Db, id: string, to: OptimizationRunStatus, patch: RunPatch = {}, from?: OptimizationRunStatus): Promise<OptimizationRun> {
  if (from && !canTransition(from, to)) throw new OptimizerServiceError('invalid', `transición no válida ${from} -> ${to}`);
  const sources = from ? [from] : sourcesOf(to);
  const [row] = await db
    .update(optimizationRuns)
    .set({ ...setOf(patch), status: to })
    .where(and(eq(optimizationRuns.id, id), inArray(optimizationRuns.status, sources)))
    .returning();
  if (row) return row;
  const [current] = await db.select({ status: optimizationRuns.status }).from(optimizationRuns).where(eq(optimizationRuns.id, id)).limit(1);
  if (!current) throw new OptimizerServiceError('not_found', 'optimization run not found');
  throw new OptimizerServiceError('conflict', `el run está ${current.status}: no puede pasar a ${to}`, { status: current.status, to });
}

/** Records progress without changing the status (only while the run is still `status`). */
export async function recordRun(db: Db, id: string, status: OptimizationRunStatus, patch: RunPatch): Promise<OptimizationRun> {
  const [row] = await db
    .update(optimizationRuns)
    .set(setOf(patch))
    .where(and(eq(optimizationRuns.id, id), eq(optimizationRuns.status, status)))
    .returning();
  if (!row) throw new OptimizerServiceError('conflict', `el run ya no está ${status}`);
  return row;
}

export interface CloseRunArgs {
  tenantId: string;
  id: string;
  outcome: Extract<OptimizationRunStatus, 'PROMOTED' | 'DISCARDED'>;
  by?: string | null | undefined;
  reason?: string | null | undefined;
}

/**
 * Human close of a run that waits for a decision. PROMOTED only when the candidate IS the
 * ACTIVE version now (a human activated it through the Release Gate); the optimizer never
 * activates. DISCARDED leaves the DRAFT version as is (deprecate it with the skills API).
 */
export async function closeRun(db: Db, args: CloseRunArgs): Promise<OptimizationRun> {
  const run = await requireRun(db, args.tenantId, args.id);
  if (!canTransition(run.status, args.outcome)) throw new OptimizerServiceError('conflict', `el run está ${run.status}: no se puede cerrar como ${args.outcome}`, { status: run.status });
  if (args.outcome === 'PROMOTED') {
    const [active] = await db
      .select({ version: skillVersions.version })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.id, skills.activeVersionId))
      .where(and(eq(skills.tenantId, args.tenantId), eq(skills.name, run.skillName)))
      .limit(1);
    if (!active || active.version !== run.candidateVersion) {
      throw new OptimizerServiceError('conflict', `v${run.candidateVersion ?? '—'} no es la versión ACTIVE de ${run.skillName} (activa: v${active?.version ?? '—'}): actívala primero con POST /skills/${run.skillName}/versions/${run.candidateVersion ?? '<v>'}/activate (pasa por el Release Gate)`, {
        active_version: active?.version ?? null,
        candidate_version: run.candidateVersion,
      });
    }
  }
  return transitionRun(db, run.id, args.outcome, { details: { human_close: { outcome: args.outcome, by: args.by ?? null, reason: args.reason ?? null, at: new Date().toISOString() } } }, run.status);
}

/**
 * Open runs not updated for `olderThanMs` belong to a worker that died: they go to ERROR so the
 * skill can be optimized again (the open-run index would block it forever). Returns the ids.
 */
export async function failStaleRuns(db: Db, olderThanMs: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(optimizationRuns)
    .set({ status: 'ERROR', error: `interrumpido: sin progreso desde ${cutoff.toISOString()} (el worker se detuvo)`, updatedAt: new Date() })
    .where(and(inArray(optimizationRuns.status, [...OPEN_STATUSES]), lt(optimizationRuns.updatedAt, cutoff)))
    .returning({ id: optimizationRuns.id });
  return rows.map((r) => r.id);
}
