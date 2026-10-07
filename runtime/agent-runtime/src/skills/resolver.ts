/**
 * Skill loader of the runtime (MVP-1). Resolves the `skill_refs` of an agent version
 * against the database before the run and hands the agent a `SkillSet`:
 *
 * - `{ name, version }`  -> that exact `skill_versions.version` (any status).
 * - `{ name }`           -> the skill's ACTIVE version (`skills.active_version_id`), read
 *                           when the run starts: activating a version never touches agents
 *                           in flight, the next run picks it up.
 * - `{ skill_id, version }` (MVP-0 legacy ref to a code constant) -> never read from the
 *                           database (its `version` is a code version, not a db version).
 *
 * Canary (src/skills/canary.ts): when the skill has an ACTIVE canary and the ref follows the
 * ACTIVE version (`{ name }`), the run gets the canary version if the deterministic hash of
 * `routingKey` falls in its percent, the stable (ACTIVE) one otherwise. The record carries
 * `canary` (arm, bucket, key). A pinned ref (`{ name, version }`) never takes part.
 *
 * Compatibility: when a ref cannot be resolved (skill or version missing, no ACTIVE
 * version, database error, legacy ref) the agent keeps its MVP-0 behaviour (its
 * `system_prompt` or the code constant) and a warning is logged. Nothing fails because of
 * a missing skill.
 *
 * Immutability (LLD P4): the set records exactly what the agent injected: for database
 * skills the `skill_version_id`, version and content hash; for fallbacks the exact code text
 * and its hash. The processor stores these records in `traces.skill_versions`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { skillCanaries, skills, skillVersions, type DbSkillRef, type LegacySkillRef, type Skill, type SkillCanary, type SkillRef, type SkillVersion, type SkillVersionUsed } from '../db/schema.js';
import { canaryRouting } from './canary.js';
import { codeSkill } from './code-skills.js';
import { renderSkill, sha256 } from './render.js';

export interface SkillLogger {
  warn(obj: object, msg?: string): void;
  info?(obj: object, msg?: string): void;
}

export function isLegacyRef(ref: SkillRef): ref is LegacySkillRef {
  return typeof (ref as LegacySkillRef).skill_id === 'string' && typeof (ref as DbSkillRef).name !== 'string';
}

export function refName(ref: SkillRef): string {
  return isLegacyRef(ref) ? ref.skill_id : ref.name;
}

/** Skills resolved for one execution. Agents read them through `useSkill`. */
export class SkillSet {
  private readonly texts = new Map<string, string>();
  private readonly list: SkillVersionUsed[] = [];

  /** Internal: built by `resolveSkillRefs` (and tests). */
  constructor(entries: Array<{ record: SkillVersionUsed; text?: string | undefined }> = []) {
    for (const e of entries) {
      this.list.push(e.record);
      if (e.record.source === 'db' && e.text !== undefined && !this.texts.has(e.record.name)) this.texts.set(e.record.name, e.text);
    }
  }

  static empty(): SkillSet {
    return new SkillSet();
  }

  /** Text resolved from the database for `name`, if the agent version references it. */
  dbText(name: string): string | undefined {
    return this.texts.get(name);
  }

  /** Database texts in ref order (generic agents append them to their system prompt). */
  dbTexts(): string[] {
    return [...this.texts.values()];
  }

  /**
   * The text the agent must inject for `name`: the database version when it resolved,
   * otherwise `fallback` (the MVP-0 code path), which is recorded with its exact text.
   */
  use(name: string, fallback: string): string {
    const db = this.texts.get(name);
    if (db !== undefined) return db;
    const hash = sha256(fallback);
    if (this.list.some((r) => r.name === name && r.source === 'code' && r.content_hash === hash)) return fallback;
    const pending = this.list.find((r) => r.name === name && r.source === 'none');
    const code = codeSkill(name);
    // A legacy ref carries the code version; otherwise it is known only if the text is the constant.
    const version =
      pending?.requested && isLegacyRef(pending.requested) ? pending.version : code && code.text === fallback ? code.source.legacy_version : null;
    const record: SkillVersionUsed = {
      name,
      version,
      skill_version_id: null,
      content_hash: hash,
      source: 'code',
      requested: pending?.requested ?? null,
      fallback_reason: pending?.fallback_reason ?? 'not_referenced',
      text: fallback,
    };
    if (pending) Object.assign(pending, record);
    else this.list.push(record);
    return fallback;
  }

  /** Records for `traces.skill_versions` (code fallbacks carry their exact text). */
  traceRecords(): SkillVersionUsed[] {
    return this.list.map((r) => ({ ...r }));
  }

  /** Records for `task_runs.skill_versions` (no text). */
  runRecords(): SkillVersionUsed[] {
    return this.list.map(({ text: _text, ...r }) => r);
  }
}

/** Text for `name`: database skill if resolved for this run, else `fallback`. */
export function useSkill(ctx: { skills?: SkillSet | undefined }, name: string, fallback: string): string {
  return ctx.skills ? ctx.skills.use(name, fallback) : fallback;
}

/** Read side of the resolver (the database; an in-memory one in unit tests). */
export interface SkillStore {
  /** Skills of the tenant with these names, all their versions and their ACTIVE canaries (if any). */
  load(tenantId: string, names: string[]): Promise<{ skills: Skill[]; versions: SkillVersion[]; canaries?: SkillCanary[] }>;
}

export interface ResolveOptions {
  /** Canary routing key: the task_run id, or the execution id of a direct execution. Without it, never the canary. */
  routingKey?: string | null | undefined;
}

export function dbSkillStore(db: Db): SkillStore {
  return {
    async load(tenantId, names) {
      const rows = await db.select().from(skills).where(and(eq(skills.tenantId, tenantId), inArray(skills.name, names)));
      if (rows.length === 0) return { skills: [], versions: [] };
      const ids = rows.map((r) => r.id);
      const versions = await db.select().from(skillVersions).where(and(eq(skillVersions.tenantId, tenantId), inArray(skillVersions.skillId, ids)));
      const canaries = await db.select().from(skillCanaries).where(and(eq(skillCanaries.tenantId, tenantId), inArray(skillCanaries.skillId, ids), eq(skillCanaries.status, 'ACTIVE')));
      return { skills: rows, versions, canaries };
    },
  };
}

/** Resolves the refs of an agent version. Never throws. */
export async function resolveSkillRefs(
  source: Db | SkillStore,
  tenantId: string,
  refs: readonly SkillRef[] | null | undefined,
  logger?: SkillLogger,
  options: ResolveOptions = {},
): Promise<SkillSet> {
  const store: SkillStore = 'load' in source && typeof source.load === 'function' ? source : dbSkillStore(source as Db);
  const list = Array.isArray(refs) ? refs.filter((r): r is SkillRef => Boolean(r) && typeof r === 'object') : [];
  if (list.length === 0) return SkillSet.empty();

  const pending = (ref: SkillRef, reason: NonNullable<SkillVersionUsed['fallback_reason']>): { record: SkillVersionUsed } => ({
    record: {
      name: refName(ref),
      version: isLegacyRef(ref) ? ref.version : (ref.version ?? null),
      skill_version_id: null,
      content_hash: null,
      source: 'none',
      requested: ref,
      fallback_reason: reason,
    },
  });

  const dbRefs = list.filter((r): r is DbSkillRef => !isLegacyRef(r) && typeof r.name === 'string');
  let byName = new Map<string, Skill>();
  let versionsById = new Map<string, SkillVersion>();
  let canaryBySkill = new Map<string, SkillCanary>();
  let failed: unknown = null;
  if (dbRefs.length > 0) {
    try {
      const loaded = await store.load(tenantId, [...new Set(dbRefs.map((r) => r.name))]);
      byName = new Map(loaded.skills.map((r) => [r.name, r]));
      versionsById = new Map(loaded.versions.map((v) => [v.id, v]));
      canaryBySkill = new Map((loaded.canaries ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.skillId, c]));
    } catch (err) {
      failed = err;
    }
  }

  const entries: Array<{ record: SkillVersionUsed; text?: string }> = [];
  for (const ref of list) {
    if (isLegacyRef(ref)) {
      entries.push(pending(ref, 'legacy_ref'));
      continue;
    }
    if (typeof ref.name !== 'string') continue;
    if (failed) {
      logger?.warn({ skill: ref.name, err: failed instanceof Error ? failed.message : String(failed) }, 'skill resolution failed (database error); falling back to the code constant');
      entries.push(pending(ref, 'db_error'));
      continue;
    }
    const skill = byName.get(ref.name);
    if (!skill) {
      logger?.warn({ skill: ref.name, tenantId }, 'skill not found in the database; falling back to the code constant');
      entries.push(pending(ref, 'skill_not_found'));
      continue;
    }
    let version =
      ref.version !== undefined
        ? [...versionsById.values()].find((v) => v.skillId === skill.id && v.version === ref.version)
        : skill.activeVersionId
          ? versionsById.get(skill.activeVersionId)
          : undefined;
    // Canary: only for refs that follow the ACTIVE version, and only while it is the canary's stable one.
    const canary = ref.version === undefined ? canaryBySkill.get(skill.id) : undefined;
    const routing = canary && version && canary.stableVersionId === version.id && versionsById.has(canary.canaryVersionId) ? canaryRouting(canary, options.routingKey) : undefined;
    if (routing?.arm === 'canary') version = versionsById.get(canary!.canaryVersionId);
    if (!version) {
      const reason = ref.version !== undefined ? 'version_not_found' : 'no_active_version';
      logger?.warn({ skill: ref.name, version: ref.version ?? null, tenantId, reason }, 'skill version not resolved; falling back to the code constant');
      entries.push(pending(ref, reason));
      continue;
    }
    const text = renderSkill(version);
    entries.push({
      record: {
        name: skill.name,
        version: version.version,
        skill_version_id: version.id,
        content_hash: sha256(text),
        source: 'db',
        requested: ref,
        ...(routing ? { canary: routing } : {}),
      },
      text,
    });
  }
  return new SkillSet(entries);
}
