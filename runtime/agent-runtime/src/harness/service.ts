/**
 * Harness lifecycle (LLD v0.1 section 7.1, MVP-1 without optimizer), same rules as skills
 * (src/skills/service.ts). Used by the API and the seed. No physical DELETE: versions move
 * DRAFT -> ACTIVE -> DEPRECATED (and DEPRECATED -> ACTIVE to roll back). Every transition
 * runs in one transaction that locks the harness row, so there is never more than one ACTIVE
 * version (also enforced by a partial unique index). Version content is immutable
 * (trigger): changing a policy means creating a new version.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { harnesses, harnessVersions, type Harness, type HarnessConfig, type HarnessVersion, type HarnessVersionStatus } from '../db/schema.js';
import { HARNESS_NAME_RE, harnessConfigHash, normalizeHarnessConfig, parseStoredHarnessConfig, type HarnessConfigInput } from './config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HarnessServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HarnessServiceError';
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

function versionValues(tenantId: string, harnessId: string, version: number, config: HarnessConfig, metadata: Record<string, unknown>, createdBy: string | null) {
  return { tenantId, harnessId, version, status: 'DRAFT' as const, config, metadata, contentHash: harnessConfigHash(config), createdBy };
}

/** Finds a harness by uuid or by name, in the tenant. */
export async function findHarness(db: Conn, tenantId: string, key: string): Promise<Harness | undefined> {
  const where = UUID_RE.test(key) ? and(eq(harnesses.tenantId, tenantId), eq(harnesses.id, key)) : and(eq(harnesses.tenantId, tenantId), eq(harnesses.name, key));
  const [row] = await db.select().from(harnesses).where(where).limit(1);
  return row;
}

async function lockHarness(tx: Tx, tenantId: string, key: string): Promise<Harness> {
  const found = await findHarness(tx, tenantId, key);
  if (!found) throw new HarnessServiceError('not_found', 'harness not found');
  const [locked] = await tx.select().from(harnesses).where(eq(harnesses.id, found.id)).for('update');
  return locked!;
}

export async function listHarnessVersions(db: Conn, harnessId: string): Promise<HarnessVersion[]> {
  return db.select().from(harnessVersions).where(eq(harnessVersions.harnessId, harnessId)).orderBy(desc(harnessVersions.version));
}

export interface CreateHarnessArgs {
  tenantId: string;
  name: string;
  description?: string | null | undefined;
  config: HarnessConfigInput;
  metadata?: Record<string, unknown> | undefined;
  createdBy?: string | null | undefined;
  /** Seed only: v1 is created ACTIVE (the API always creates v1 as DRAFT). */
  activate?: boolean;
}

/** Creates the harness and its version 1 (DRAFT, or ACTIVE with `activate`). 409 if the name exists. */
export async function createHarness(db: Db, args: CreateHarnessArgs): Promise<{ harness: Harness; version: HarnessVersion }> {
  if (!HARNESS_NAME_RE.test(args.name)) throw new HarnessServiceError('invalid', 'harness name must be kebab-case (a-z, 0-9, -)');
  const config = normalizeHarnessConfig(args.config);
  return db.transaction(async (tx) => {
    const existing = await findHarness(tx, args.tenantId, args.name);
    if (existing) throw new HarnessServiceError('conflict', `harness "${args.name}" already exists`, { harness_id: existing.id });
    const [harness] = await tx
      .insert(harnesses)
      .values({ tenantId: args.tenantId, name: args.name, description: args.description ?? null, status: 'DRAFT' })
      .returning();
    if (!harness) throw new Error('insert harness failed');
    const [version] = await tx
      .insert(harnessVersions)
      .values(versionValues(args.tenantId, harness.id, 1, config, args.metadata ?? {}, args.createdBy ?? null))
      .returning();
    if (!version) throw new Error('insert harness version failed');
    if (!args.activate) return { harness, version };
    const now = new Date();
    const [active] = await tx.update(harnessVersions).set({ status: 'ACTIVE', activatedAt: now }).where(eq(harnessVersions.id, version.id)).returning();
    const [updated] = await tx.update(harnesses).set({ status: 'ACTIVE', activeVersionId: version.id, updatedAt: now }).where(eq(harnesses.id, harness.id)).returning();
    return { harness: updated!, version: active! };
  });
}

/** Per-dimension merge: keys sent in `patch` override `base` (null included: it unsets). */
export function mergeHarnessConfig(base: HarnessConfig, patch: HarnessConfigInput): HarnessConfig {
  const defined = (o: object | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
  return normalizeHarnessConfig({
    execution: { ...base.execution, ...defined(patch.execution) },
    tools: { ...base.tools, ...defined(patch.tools) },
    context: { ...base.context, ...defined(patch.context) },
    safety: { ...base.safety, ...defined(patch.safety) },
  } as HarnessConfigInput);
}

export interface CreateHarnessVersionArgs {
  tenantId: string;
  harnessKey: string;
  /** Copy the config of the ACTIVE version or of a given version; dimensions in `config` override it. */
  copyFrom?: 'active' | number | undefined;
  config?: HarnessConfigInput | undefined;
  changeReason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdBy?: string | null | undefined;
}

/** New DRAFT version (max + 1) from a config, or copying the active (or a given) version. */
export async function createHarnessVersion(db: Db, args: CreateHarnessVersionArgs): Promise<{ harness: Harness; version: HarnessVersion }> {
  return db.transaction(async (tx) => {
    const harness = await lockHarness(tx, args.tenantId, args.harnessKey);
    if (harness.status === 'DEPRECATED') throw new HarnessServiceError('conflict', 'harness is DEPRECATED');
    let base: HarnessVersion | undefined;
    if (args.copyFrom === 'active') {
      if (!harness.activeVersionId) throw new HarnessServiceError('conflict', 'harness has no ACTIVE version to copy');
      [base] = await tx.select().from(harnessVersions).where(eq(harnessVersions.id, harness.activeVersionId)).limit(1);
    } else if (typeof args.copyFrom === 'number') {
      [base] = await tx
        .select()
        .from(harnessVersions)
        .where(and(eq(harnessVersions.harnessId, harness.id), eq(harnessVersions.version, args.copyFrom)))
        .limit(1);
      if (!base) throw new HarnessServiceError('not_found', `harness version ${args.copyFrom} not found`);
    }
    if (!base && args.config === undefined) throw new HarnessServiceError('invalid', 'config is required (or copy_from)');
    const baseConfig = base ? parseStoredHarnessConfig(base.config) : null;
    if (base && !baseConfig) throw new HarnessServiceError('conflict', `harness version ${base.version} has an invalid config; send a full config instead of copy_from`);
    const config = baseConfig ? mergeHarnessConfig(baseConfig, args.config ?? {}) : normalizeHarnessConfig(args.config ?? {});
    const metadata: Record<string, unknown> = {
      ...(args.metadata ?? {}),
      ...(base ? { copied_from: { version: base.version, harness_version_id: base.id } } : {}),
      ...(args.changeReason ? { change_reason: args.changeReason } : {}),
    };
    const [last] = await tx
      .select({ version: harnessVersions.version })
      .from(harnessVersions)
      .where(eq(harnessVersions.harnessId, harness.id))
      .orderBy(desc(harnessVersions.version))
      .limit(1);
    const [version] = await tx
      .insert(harnessVersions)
      .values(versionValues(args.tenantId, harness.id, (last?.version ?? 0) + 1, config, metadata, args.createdBy ?? null))
      .returning();
    if (!version) throw new Error('insert harness version failed');
    return { harness, version };
  });
}

export interface HarnessTransitionResult {
  harness: Harness;
  version: HarnessVersion;
  /** false when the version already was in the requested state (idempotent call). */
  changed: boolean;
  /** activate: the version that was ACTIVE before and is now DEPRECATED. */
  previous?: HarnessVersion | null;
  /** deprecate of the ACTIVE version: the version restored as ACTIVE. */
  restored?: HarnessVersion | null;
}

/** What a transition needs to know about each version. */
export interface HarnessVersionState {
  id: string;
  version: number;
  status: HarnessVersionStatus;
  activatedAt: Date | null;
}

export interface HarnessTransitionPlan {
  changed: boolean;
  deprecate: string[];
  activate: string | null;
  /** New `harnesses.active_version_id` (undefined: unchanged). */
  activeVersionId?: string;
}

function target(versions: readonly HarnessVersionState[], version: number): HarnessVersionState {
  const t = versions.find((v) => v.version === version);
  if (!t) throw new HarnessServiceError('not_found', `harness version ${version} not found`);
  return t;
}

/** activate: DRAFT or DEPRECATED (rollback) -> ACTIVE; the current ACTIVE -> DEPRECATED. Idempotent. */
export function planHarnessActivate(versions: readonly HarnessVersionState[], version: number): HarnessTransitionPlan {
  const t = target(versions, version);
  if (t.status === 'ACTIVE') return { changed: false, deprecate: [], activate: null };
  return { changed: true, deprecate: versions.filter((v) => v.status === 'ACTIVE').map((v) => v.id), activate: t.id, activeVersionId: t.id };
}

/**
 * deprecate: DRAFT -> DEPRECATED (discarded draft). ACTIVE -> DEPRECATED is a rollback: the
 * most recently activated EARLIER version becomes ACTIVE again; with none it is rejected
 * (409), so a harness never loses its ACTIVE version by accident. Idempotent.
 */
export function planHarnessDeprecate(versions: readonly HarnessVersionState[], version: number): HarnessTransitionPlan & { restore: HarnessVersionState | null } {
  const t = target(versions, version);
  if (t.status === 'DEPRECATED') return { changed: false, deprecate: [], activate: null, restore: null };
  if (t.status === 'DRAFT') return { changed: true, deprecate: [t.id], activate: null, restore: null };
  const restore =
    versions
      .filter((v) => v.version < t.version && v.activatedAt !== null)
      .sort((a, b) => b.activatedAt!.getTime() - a.activatedAt!.getTime() || b.version - a.version)[0] ?? null;
  if (!restore) {
    throw new HarnessServiceError('conflict', 'the ACTIVE version has no earlier version to restore; activate another version instead', { active_version: t.version });
  }
  return { changed: true, deprecate: [t.id], activate: restore.id, activeVersionId: restore.id, restore };
}

async function applyPlan(tx: Tx, harness: Harness, plan: HarnessTransitionPlan): Promise<{ harness: Harness; byId: Map<string, HarnessVersion> }> {
  const now = new Date();
  const byId = new Map<string, HarnessVersion>();
  // Deprecate first: the partial unique index allows one ACTIVE row per harness at any time.
  for (const id of plan.deprecate) {
    const [row] = await tx.update(harnessVersions).set({ status: 'DEPRECATED', deprecatedAt: now }).where(eq(harnessVersions.id, id)).returning();
    if (row) byId.set(id, row);
  }
  if (plan.activate) {
    const [row] = await tx.update(harnessVersions).set({ status: 'ACTIVE', activatedAt: now, deprecatedAt: null }).where(eq(harnessVersions.id, plan.activate)).returning();
    if (row) byId.set(row.id, row);
  }
  if (plan.activeVersionId === undefined) return { harness, byId };
  const [updated] = await tx
    .update(harnesses)
    .set({ status: 'ACTIVE', activeVersionId: plan.activeVersionId, updatedAt: now })
    .where(eq(harnesses.id, harness.id))
    .returning();
  return { harness: updated ?? harness, byId };
}

/** Makes `version` the ACTIVE one; running attempts are not touched, the next attempt resolves it. */
export async function activateHarnessVersion(db: Db, args: { tenantId: string; harnessKey: string; version: number }): Promise<HarnessTransitionResult> {
  return db.transaction(async (tx) => {
    const harness = await lockHarness(tx, args.tenantId, args.harnessKey);
    if (harness.status === 'DEPRECATED') throw new HarnessServiceError('conflict', 'harness is DEPRECATED');
    const versions = await listHarnessVersions(tx, harness.id);
    const plan = planHarnessActivate(versions, args.version);
    const t = versions.find((v) => v.version === args.version)!;
    if (!plan.changed) return { harness, version: t, changed: false, previous: null };
    const applied = await applyPlan(tx, harness, plan);
    const previous = plan.deprecate[0] ? (applied.byId.get(plan.deprecate[0]) ?? null) : null;
    return { harness: applied.harness, version: applied.byId.get(t.id)!, changed: true, previous };
  });
}

/** See `planHarnessDeprecate`. */
export async function deprecateHarnessVersion(db: Db, args: { tenantId: string; harnessKey: string; version: number }): Promise<HarnessTransitionResult> {
  return db.transaction(async (tx) => {
    const harness = await lockHarness(tx, args.tenantId, args.harnessKey);
    const versions = await listHarnessVersions(tx, harness.id);
    const plan = planHarnessDeprecate(versions, args.version);
    const t = versions.find((v) => v.version === args.version)!;
    if (!plan.changed) return { harness, version: t, changed: false, restored: null };
    const applied = await applyPlan(tx, harness, plan);
    const restored = plan.restore ? (applied.byId.get(plan.restore.id) ?? null) : null;
    return { harness: applied.harness, version: applied.byId.get(t.id)!, changed: true, restored };
  });
}
