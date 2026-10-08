/**
 * Skill canary (minimal deployment after the Release Gate, migration 0012_skill_canaries).
 *
 * - Start: `POST /skills/:id/versions/:v/canary { percent }`. Needs the SAME gate as the
 *   activation (a COMPLETED experiment PASS or PASS_FORM of that version against the current
 *   ACTIVE one) and never accepts `force`: a canary without an experiment has nothing to
 *   compare against. At most one ACTIVE canary per skill.
 * - Routing (the resolver, src/skills/resolver.ts): a ref that follows the ACTIVE version
 *   (`{ name }`, no pinned version) gets the canary version when
 *   `bucket = sha256(canary_id ":" routing_key)[0..8] mod 10000 < percent * 100`. The routing
 *   key is the task_run id (every attempt of a run gets the same arm) or the execution id of
 *   a direct execution. Nothing random: the same id always gets the same version, and the
 *   trace records the arm, the bucket and the key (P4), so attribution is exact.
 * - Compare: `GET /skills/:id/canary` reads the traces routed by THIS canary (metrics/queries.ts).
 * - Decide (always a human; no scheduled task promotes): `POST /skills/:id/canary/promote`
 *   re-checks the gate and makes the canary version ACTIVE; `POST /skills/:id/canary/rollback`
 *   closes it and every run goes back to the stable version (always allowed).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { skillCanaries, type Skill, type SkillCanary, type SkillCanaryRouting, type SkillVersion } from '../db/schema.js';
import { activeCanaryOf, applyPlan, closeCanary, listVersions, lockSkill, planActivate, SkillServiceError, type Tx } from './service.js';

/** Buckets of the hash: `percent` maps to `percent * 100` of them (room for fractional percents later). */
export const CANARY_BUCKETS = 10_000;

/** Deterministic bucket (0..9999) of a routing key within one canary. */
export function canaryBucket(canaryId: string, routingKey: string): number {
  const h = createHash('sha256').update(`${canaryId}:${routingKey}`, 'utf8').digest('hex');
  return Number.parseInt(h.slice(0, 8), 16) % CANARY_BUCKETS;
}

export function canaryArm(canaryId: string, percent: number, routingKey: string | null | undefined): { arm: 'canary' | 'stable'; bucket: number | null } {
  if (!routingKey) return { arm: 'stable', bucket: null };
  const bucket = canaryBucket(canaryId, routingKey);
  return { arm: bucket < Math.round(percent * (CANARY_BUCKETS / 100)) ? 'canary' : 'stable', bucket };
}

/** Routing record of one run (stored in `skill_versions[].canary`). */
export function canaryRouting(canary: Pick<SkillCanary, 'id' | 'percent' | 'stableVersion' | 'canaryVersion'>, routingKey: string | null | undefined): SkillCanaryRouting {
  const { arm, bucket } = canaryArm(canary.id, canary.percent, routingKey);
  return { canary_id: canary.id, arm, percent: canary.percent, bucket, routing_key: routingKey ?? null, stable_version: canary.stableVersion, canary_version: canary.canaryVersion };
}

/** Gate check run inside the canary transaction (the route passes the Release Gate). Throwing aborts. */
export type CanaryGuard<G> = (tx: Tx, ctx: { skill: Skill; versions: SkillVersion[]; target: SkillVersion; active: SkillVersion }) => Promise<G>;

export interface StartCanaryResult<G> {
  skill: Skill;
  canary: SkillCanary;
  /** false: the same canary (version and percent) was already ACTIVE (idempotent call). */
  changed: boolean;
  gate?: G;
}

/**
 * Starts the canary of `version` at `percent` %. The guard must return the experiment that lets
 * it through (`experimentId`). 409 when the version is the ACTIVE one, when there is no ACTIVE
 * version, or when another canary (another version or percent) is ACTIVE.
 */
export async function startCanary<G extends { experimentId: string; record: Record<string, unknown> }>(
  db: Db,
  args: { tenantId: string; skillKey: string; version: number; percent: number; by?: string | null | undefined; guard: CanaryGuard<G> },
): Promise<StartCanaryResult<G>> {
  if (!Number.isInteger(args.percent) || args.percent < 1 || args.percent > 99) throw new SkillServiceError('invalid', 'percent must be an integer between 1 and 99');
  return db.transaction(async (tx) => {
    const skill = await lockSkill(tx, args.tenantId, args.skillKey);
    if (skill.status === 'DEPRECATED') throw new SkillServiceError('conflict', 'skill is DEPRECATED');
    const versions = await listVersions(tx, skill.id);
    const target = versions.find((v) => v.version === args.version);
    if (!target) throw new SkillServiceError('not_found', `skill version ${args.version} not found`);
    const active = versions.find((v) => v.status === 'ACTIVE');
    if (!active) throw new SkillServiceError('conflict', 'skill has no ACTIVE version: a canary needs a stable version to compare with; activate one first');
    if (target.id === active.id) throw new SkillServiceError('conflict', `v${target.version} is already the ACTIVE version`);
    if (target.status === 'DEPRECATED' && target.activatedAt === null) throw new SkillServiceError('conflict', `v${target.version} is a discarded DRAFT (DEPRECATED)`);
    const open = await activeCanaryOf(tx, skill.id);
    if (open) {
      if (open.canaryVersionId === target.id && open.percent === args.percent) return { skill, canary: open, changed: false };
      throw new SkillServiceError('conflict', `skill already has an ACTIVE canary (v${open.canaryVersion} at ${open.percent} %): promote it or roll it back first (one canary per skill)`, {
        canary_id: open.id,
        canary_version: open.canaryVersion,
        percent: open.percent,
      });
    }
    const gate = await args.guard(tx, { skill, versions, target, active });
    const [canary] = await tx
      .insert(skillCanaries)
      .values({
        tenantId: args.tenantId,
        skillId: skill.id,
        canaryVersionId: target.id,
        canaryVersion: target.version,
        stableVersionId: active.id,
        stableVersion: active.version,
        percent: args.percent,
        experimentId: gate.experimentId,
        gate: gate.record,
        startedBy: args.by ?? null,
      })
      .returning();
    return { skill, canary: canary!, changed: true, gate };
  });
}

export interface FinishCanaryResult<G> {
  skill: Skill;
  canary: SkillCanary;
  changed: boolean;
  /** promote: the version now ACTIVE and the one DEPRECATED. */
  version?: SkillVersion | null;
  previous?: SkillVersion | null;
  gate?: G;
}

/**
 * Promote: the gate is re-checked (the guard, against the current ACTIVE version), the canary
 * version becomes ACTIVE (the stable one DEPRECATED, as an activation) and the canary PROMOTED.
 * 409 without an ACTIVE canary.
 */
export async function promoteCanary<G extends { record: Record<string, unknown> }>(
  db: Db,
  args: { tenantId: string; skillKey: string; by?: string | null | undefined; guard: CanaryGuard<G> },
): Promise<FinishCanaryResult<G>> {
  return db.transaction(async (tx) => {
    const skill = await lockSkill(tx, args.tenantId, args.skillKey);
    if (skill.status === 'DEPRECATED') throw new SkillServiceError('conflict', 'skill is DEPRECATED');
    const open = await activeCanaryOf(tx, skill.id);
    if (!open) throw new SkillServiceError('conflict', 'skill has no ACTIVE canary to promote');
    const versions = await listVersions(tx, skill.id);
    const target = versions.find((v) => v.id === open.canaryVersionId)!;
    const active = versions.find((v) => v.status === 'ACTIVE');
    if (!active || active.id !== open.stableVersionId) {
      throw new SkillServiceError('conflict', `the ACTIVE version is no longer the canary's stable v${open.stableVersion}: roll the canary back`, { canary_id: open.id });
    }
    const gate = await args.guard(tx, { skill, versions, target, active });
    const plan = planActivate(versions, target.version);
    const applied = await applyPlan(tx, skill, plan);
    const canary = await closeCanary(tx, open, 'PROMOTED', { by: args.by, reason: `v${open.canaryVersion} promovida a ACTIVE (decisión humana)`, gate: gate.record });
    return { skill: applied.skill, canary, changed: true, version: applied.byId.get(target.id) ?? null, previous: applied.byId.get(active.id) ?? null, gate };
  });
}

/** Rollback: closes the ACTIVE canary (ROLLED_BACK); every run follows the stable version again. Idempotent, always allowed. */
export async function rollbackCanary(db: Db, args: { tenantId: string; skillKey: string; by?: string | null | undefined; reason?: string | null | undefined }): Promise<{ skill: Skill; canary: SkillCanary | null; changed: boolean }> {
  return db.transaction(async (tx) => {
    const skill = await lockSkill(tx, args.tenantId, args.skillKey);
    const open = await activeCanaryOf(tx, skill.id);
    if (!open) return { skill, canary: await latestCanary(tx, skill.id), changed: false };
    const canary = await closeCanary(tx, open, 'ROLLED_BACK', { by: args.by, reason: args.reason?.trim() || 'rollback manual: todo vuelve a la versión estable' });
    return { skill, canary, changed: true };
  });
}

/** The latest canary of a skill (ACTIVE or finished), or null. */
export async function latestCanary(conn: Db | Tx, skillId: string): Promise<SkillCanary | null> {
  const [row] = await conn.select().from(skillCanaries).where(eq(skillCanaries.skillId, skillId)).orderBy(desc(skillCanaries.startedAt)).limit(1);
  return row ?? null;
}

/** Canaries of a skill, newest first (history: rows are never deleted). */
export async function listCanaries(conn: Db | Tx, tenantId: string, skillId: string, limit = 20): Promise<SkillCanary[]> {
  return conn
    .select()
    .from(skillCanaries)
    .where(and(eq(skillCanaries.tenantId, tenantId), eq(skillCanaries.skillId, skillId)))
    .orderBy(desc(skillCanaries.startedAt))
    .limit(limit);
}
