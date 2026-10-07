/**
 * Skill lifecycle (LLD v0.1 section 6.3, MVP-1 without optimizer). Used by the API and the
 * seed. No physical DELETE: versions move DRAFT -> ACTIVE -> DEPRECATED (and DEPRECATED ->
 * ACTIVE to roll back). Every transition runs in one transaction that locks the skill row,
 * so there is never more than one ACTIVE version (also enforced by a partial unique index).
 * Version content is immutable (trigger): changing a skill means creating a new version.
 *
 * Canary (src/skills/canary.ts, 0012): while a skill has an ACTIVE canary, `activateVersion` is
 * rejected (409: promote or roll the canary back first) and deprecating the stable or the canary
 * version closes the canary as ROLLED_BACK in the same transaction (rollback is always allowed).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { skillCanaries, skills, skillVersions, type Skill, type SkillCanary, type SkillVersion, type SkillVersionStatus } from '../db/schema.js';
import { UNTRUSTED_SYSTEM_RULE } from '../agents/untrusted.js';
import { renderSkill, sha256 } from './render.js';

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SkillServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SkillServiceError';
  }
}

export interface SkillVersionContent {
  instructions: string;
  constraints?: string | null | undefined;
  examples?: unknown[] | null | undefined;
  antiPatterns?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

/** Non-blocking checks returned to the caller (the version is created anyway). */
export function contentWarnings(c: SkillVersionContent): string[] {
  const warnings: string[] = [];
  if (!c.instructions.includes(UNTRUSTED_SYSTEM_RULE)) {
    warnings.push('instructions no incluye la regla de contenido web no confiable (UNTRUSTED_SYSTEM_RULE); añádela si la skill recibe contenido externo');
  }
  return warnings;
}

function versionValues(tenantId: string, skillId: string, version: number, c: SkillVersionContent, createdBy: string | null) {
  const text = renderSkill(c);
  return {
    tenantId,
    skillId,
    version,
    status: 'DRAFT' as const,
    instructions: c.instructions,
    constraints: c.constraints ?? null,
    examples: c.examples ?? null,
    antiPatterns: c.antiPatterns ?? null,
    metadata: c.metadata ?? {},
    contentHash: sha256(text),
    createdBy,
  };
}

/** Finds a skill by uuid or by name, in the tenant. */
export async function findSkill(db: Conn, tenantId: string, key: string): Promise<Skill | undefined> {
  const where = UUID_RE.test(key) ? and(eq(skills.tenantId, tenantId), eq(skills.id, key)) : and(eq(skills.tenantId, tenantId), eq(skills.name, key));
  const [row] = await db.select().from(skills).where(where).limit(1);
  return row;
}

/** Finds the skill and locks its row (FOR UPDATE): every lifecycle transition serialises on it. */
export async function lockSkill(tx: Tx, tenantId: string, key: string): Promise<Skill> {
  const found = await findSkill(tx, tenantId, key);
  if (!found) throw new SkillServiceError('not_found', 'skill not found');
  const [locked] = await tx.select().from(skills).where(eq(skills.id, found.id)).for('update');
  return locked!;
}

async function versionOf(tx: Conn, skillId: string, version: number): Promise<SkillVersion> {
  const [row] = await tx
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
    .limit(1);
  if (!row) throw new SkillServiceError('not_found', `skill version ${version} not found`);
  return row;
}

export async function listVersions(db: Conn, skillId: string): Promise<SkillVersion[]> {
  return db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version));
}

export interface CreateSkillArgs {
  tenantId: string;
  name: string;
  description?: string | null | undefined;
  domain?: string | null | undefined;
  content: SkillVersionContent;
  createdBy?: string | null | undefined;
  /** Seed only: v1 is created ACTIVE (the API always creates v1 as DRAFT). */
  activate?: boolean;
}

/** Creates the skill and its version 1 (DRAFT, or ACTIVE with `activate`). 409 if the name exists. */
export async function createSkill(db: Db, args: CreateSkillArgs): Promise<{ skill: Skill; version: SkillVersion }> {
  if (!SKILL_NAME_RE.test(args.name)) throw new SkillServiceError('invalid', 'skill name must be kebab-case (a-z, 0-9, -)');
  return db.transaction(async (tx) => {
    const existing = await findSkill(tx, args.tenantId, args.name);
    if (existing) throw new SkillServiceError('conflict', `skill "${args.name}" already exists`, { skill_id: existing.id });
    const [skill] = await tx
      .insert(skills)
      .values({ tenantId: args.tenantId, name: args.name, description: args.description ?? null, domain: args.domain ?? null, status: 'DRAFT' })
      .returning();
    if (!skill) throw new Error('insert skill failed');
    const [version] = await tx
      .insert(skillVersions)
      .values(versionValues(args.tenantId, skill.id, 1, args.content, args.createdBy ?? null))
      .returning();
    if (!version) throw new Error('insert skill version failed');
    if (!args.activate) return { skill, version };
    const now = new Date();
    const [active] = await tx.update(skillVersions).set({ status: 'ACTIVE', activatedAt: now }).where(eq(skillVersions.id, version.id)).returning();
    const [updated] = await tx.update(skills).set({ status: 'ACTIVE', activeVersionId: version.id, updatedAt: now }).where(eq(skills.id, skill.id)).returning();
    return { skill: updated!, version: active! };
  });
}

export interface CreateVersionArgs {
  tenantId: string;
  skillKey: string;
  /** Copy the content of the ACTIVE version or of a given version; fields in `content` override it. */
  copyFrom?: 'active' | number | undefined;
  content: Partial<SkillVersionContent>;
  changeReason?: string | undefined;
  createdBy?: string | null | undefined;
}

/** New DRAFT version (max + 1) from text or copying the active (or a given) version. */
export async function createVersion(db: Db, args: CreateVersionArgs): Promise<{ skill: Skill; version: SkillVersion }> {
  return db.transaction(async (tx) => {
    const skill = await lockSkill(tx, args.tenantId, args.skillKey);
    if (skill.status === 'DEPRECATED') throw new SkillServiceError('conflict', 'skill is DEPRECATED');
    let base: SkillVersion | undefined;
    if (args.copyFrom === 'active') {
      if (!skill.activeVersionId) throw new SkillServiceError('conflict', 'skill has no ACTIVE version to copy');
      [base] = await tx.select().from(skillVersions).where(eq(skillVersions.id, skill.activeVersionId)).limit(1);
    } else if (typeof args.copyFrom === 'number') {
      base = await versionOf(tx, skill.id, args.copyFrom);
    }
    const instructions = args.content.instructions ?? base?.instructions;
    if (instructions === undefined || instructions.length === 0) throw new SkillServiceError('invalid', 'instructions is required (or copy_from)');
    const pick = <K extends 'constraints' | 'examples' | 'antiPatterns'>(k: K) =>
      args.content[k] !== undefined ? args.content[k] : (base?.[k] ?? null);
    const metadata: Record<string, unknown> = {
      ...(args.content.metadata ?? {}),
      ...(base ? { copied_from: { version: base.version, skill_version_id: base.id } } : {}),
      ...(args.changeReason ? { change_reason: args.changeReason } : {}),
    };
    const [last] = await tx.select({ version: skillVersions.version }).from(skillVersions).where(eq(skillVersions.skillId, skill.id)).orderBy(desc(skillVersions.version)).limit(1);
    const content: SkillVersionContent = {
      instructions,
      constraints: pick('constraints') as string | null,
      examples: pick('examples') as unknown[] | null,
      antiPatterns: pick('antiPatterns') as string | null,
      metadata,
    };
    const [version] = await tx
      .insert(skillVersions)
      .values(versionValues(args.tenantId, skill.id, (last?.version ?? 0) + 1, content, args.createdBy ?? null))
      .returning();
    if (!version) throw new Error('insert skill version failed');
    return { skill, version };
  });
}

export interface TransitionResult {
  skill: Skill;
  version: SkillVersion;
  /** false when the version already was in the requested state (idempotent call). */
  changed: boolean;
  /** activate: the version that was ACTIVE before and is now DEPRECATED. */
  previous?: SkillVersion | null;
  /** deprecate of the ACTIVE version: the version restored as ACTIVE. */
  restored?: SkillVersion | null;
}

/** What a transition needs to know about each version of the skill. */
export interface VersionState {
  id: string;
  version: number;
  status: SkillVersionStatus;
  activatedAt: Date | null;
}

/** Status changes of one transition, applied in this order (deprecations first). */
export interface TransitionPlan {
  changed: boolean;
  deprecate: string[];
  activate: string | null;
  /** New `skills.active_version_id` (undefined: unchanged). */
  activeVersionId?: string;
}

function target(versions: readonly VersionState[], version: number): VersionState {
  const t = versions.find((v) => v.version === version);
  if (!t) throw new SkillServiceError('not_found', `skill version ${version} not found`);
  return t;
}

/**
 * activate: DRAFT or DEPRECATED (rollback) -> ACTIVE; the current ACTIVE -> DEPRECATED.
 * Already ACTIVE: no change (idempotent).
 */
export function planActivate(versions: readonly VersionState[], version: number): TransitionPlan {
  const t = target(versions, version);
  if (t.status === 'ACTIVE') return { changed: false, deprecate: [], activate: null };
  return {
    changed: true,
    deprecate: versions.filter((v) => v.status === 'ACTIVE').map((v) => v.id),
    activate: t.id,
    activeVersionId: t.id,
  };
}

/**
 * deprecate: DRAFT -> DEPRECATED (discarded draft). ACTIVE -> DEPRECATED is a rollback: the
 * most recently activated EARLIER version (lower number, activated at some point) becomes
 * ACTIVE again; with none it is rejected (409), so a skill never loses its ACTIVE version
 * by accident. Already DEPRECATED: no change (idempotent).
 */
export function planDeprecate(versions: readonly VersionState[], version: number): TransitionPlan & { restore: VersionState | null } {
  const t = target(versions, version);
  if (t.status === 'DEPRECATED') return { changed: false, deprecate: [], activate: null, restore: null };
  if (t.status === 'DRAFT') return { changed: true, deprecate: [t.id], activate: null, restore: null };
  const restore =
    versions
      .filter((v) => v.version < t.version && v.activatedAt !== null)
      .sort((a, b) => b.activatedAt!.getTime() - a.activatedAt!.getTime() || b.version - a.version)[0] ?? null;
  if (!restore) {
    throw new SkillServiceError('conflict', 'the ACTIVE version has no earlier version to restore; activate another version instead', {
      active_version: t.version,
    });
  }
  return { changed: true, deprecate: [t.id], activate: restore.id, activeVersionId: restore.id, restore };
}

export async function applyPlan(tx: Tx, skill: Skill, plan: TransitionPlan): Promise<{ skill: Skill; byId: Map<string, SkillVersion> }> {
  const now = new Date();
  const byId = new Map<string, SkillVersion>();
  // Deprecate first: the partial unique index allows one ACTIVE row per skill at any time.
  for (const id of plan.deprecate) {
    const [row] = await tx.update(skillVersions).set({ status: 'DEPRECATED', deprecatedAt: now }).where(eq(skillVersions.id, id)).returning();
    if (row) byId.set(id, row);
  }
  if (plan.activate) {
    const [row] = await tx.update(skillVersions).set({ status: 'ACTIVE', activatedAt: now, deprecatedAt: null }).where(eq(skillVersions.id, plan.activate)).returning();
    if (row) byId.set(row.id, row);
  }
  if (plan.activeVersionId === undefined) return { skill, byId };
  const [updated] = await tx
    .update(skills)
    .set({ status: 'ACTIVE', activeVersionId: plan.activeVersionId, updatedAt: now })
    .where(eq(skills.id, skill.id))
    .returning();
  return { skill: updated ?? skill, byId };
}

/** The ACTIVE canary of a skill (at most one: partial unique index), or null. */
export async function activeCanaryOf(conn: Conn, skillId: string): Promise<SkillCanary | null> {
  const [row] = await conn.select().from(skillCanaries).where(and(eq(skillCanaries.skillId, skillId), eq(skillCanaries.status, 'ACTIVE'))).limit(1);
  return row ?? null;
}

/** ACTIVE -> PROMOTED | ROLLED_BACK (the row is immutable afterwards, trigger). */
export async function closeCanary(
  tx: Tx,
  canary: SkillCanary,
  status: 'PROMOTED' | 'ROLLED_BACK',
  args: { by?: string | null | undefined; reason: string; gate?: Record<string, unknown> | null | undefined },
): Promise<SkillCanary> {
  const [row] = await tx
    .update(skillCanaries)
    .set({ status, finishedAt: new Date(), finishedBy: args.by ?? null, finishReason: args.reason, finishGate: args.gate ?? null })
    .where(and(eq(skillCanaries.id, canary.id), eq(skillCanaries.status, 'ACTIVE')))
    .returning();
  return row ?? canary;
}

/**
 * Check run inside the activation transaction, after the skill row is locked and before any
 * change (the Release Gate, src/experiments/release-gate.ts). Throwing aborts the activation;
 * the returned value travels back in `TransitionResult.gate`.
 */
export type ActivationGuard<G> = (tx: Tx, ctx: { skill: Skill; versions: SkillVersion[]; target: SkillVersion; active: SkillVersion | null }) => Promise<G>;

/**
 * Makes `version` the ACTIVE one and deprecates the previous ACTIVE one, in one transaction.
 * Running agents are not touched: new runs resolve the new version when they start.
 */
export async function activateVersion<G = undefined>(db: Db, args: { tenantId: string; skillKey: string; version: number; guard?: ActivationGuard<G> }): Promise<TransitionResult & { gate?: G }> {
  return db.transaction(async (tx) => {
    const skill = await lockSkill(tx, args.tenantId, args.skillKey);
    if (skill.status === 'DEPRECATED') throw new SkillServiceError('conflict', 'skill is DEPRECATED');
    const versions = await listVersions(tx, skill.id);
    const plan = planActivate(versions, args.version);
    const t = versions.find((v) => v.version === args.version)!;
    const canary = plan.changed ? await activeCanaryOf(tx, skill.id) : null;
    if (canary) {
      throw new SkillServiceError('conflict', `skill has an ACTIVE canary (v${canary.canaryVersion} at ${canary.percent} % over v${canary.stableVersion}): promote it or roll it back first`, {
        canary_id: canary.id,
        canary_version: canary.canaryVersion,
        stable_version: canary.stableVersion,
        percent: canary.percent,
      });
    }
    const gate = args.guard ? await args.guard(tx, { skill, versions, target: t, active: versions.find((v) => v.status === 'ACTIVE') ?? null }) : undefined;
    const withGate = gate === undefined ? {} : { gate };
    if (!plan.changed) return { skill, version: t, changed: false, previous: null, ...withGate };
    const applied = await applyPlan(tx, skill, plan);
    const previous = plan.deprecate[0] ? (applied.byId.get(plan.deprecate[0]) ?? null) : null;
    return { skill: applied.skill, version: applied.byId.get(t.id)!, changed: true, previous, ...withGate };
  });
}

/** See `planDeprecate`. Deprecating the stable or the canary version of an ACTIVE canary rolls the canary back. */
export async function deprecateVersion(db: Db, args: { tenantId: string; skillKey: string; version: number }): Promise<TransitionResult & { canary?: SkillCanary | null }> {
  return db.transaction(async (tx) => {
    const skill = await lockSkill(tx, args.tenantId, args.skillKey);
    const versions = await listVersions(tx, skill.id);
    const plan = planDeprecate(versions, args.version);
    const t = versions.find((v) => v.version === args.version)!;
    if (!plan.changed) return { skill, version: t, changed: false, restored: null };
    const open = await activeCanaryOf(tx, skill.id);
    const canary =
      open && (open.canaryVersionId === t.id || open.stableVersionId === t.id)
        ? await closeCanary(tx, open, 'ROLLED_BACK', { reason: `v${t.version} (${open.canaryVersionId === t.id ? 'canaria' : 'estable'}) deprecada: el canario vuelve a la estable` })
        : null;
    const applied = await applyPlan(tx, skill, plan);
    const restored = plan.restore ? (applied.byId.get(plan.restore.id) ?? null) : null;
    return { skill: applied.skill, version: applied.byId.get(t.id)!, changed: true, restored, ...(canary ? { canary } : {}) };
  });
}
