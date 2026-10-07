/**
 * Harness loader of the runtime (MVP-1), same contract as the skill resolver:
 *
 * - `{ name, version }` -> that exact `harness_versions.version` (any status).
 * - `{ name }`          -> the harness's ACTIVE version (`harnesses.active_version_id`), read
 *                          when the attempt starts: activating a version never touches runs
 *                          in flight, the next attempt picks it up.
 * - null / no ref       -> no harness: the run keeps today's policies (task, env, agent).
 *
 * Compatibility: when the ref cannot be resolved (harness or version missing, no ACTIVE
 * version, invalid stored config, database error) the run keeps today's policies and a
 * warning is logged. Nothing fails because of a harness.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { harnesses, harnessVersions, type Harness, type HarnessConfig, type HarnessRef, type HarnessUsed, type HarnessVersion } from '../db/schema.js';
import { effectiveRecord, HARNESS_NAME_RE, parseStoredHarnessConfig, type EffectivePolicies } from './config.js';

export interface HarnessLogger {
  warn(obj: object, msg?: string): void;
}

/** Harness resolved for one attempt (or the reason it was not). */
export interface ResolvedHarness {
  /** Config to apply; null = no harness (fallback to today's policies). */
  config: HarnessConfig | null;
  /** `name@version` for `task_runs.harness_version` / `traces.harness_version`; null without harness. */
  label: string | null;
  /** Record without the effective values (see `harnessRecord`). */
  used: Omit<HarnessUsed, 'effective' | 'overrides'>;
}

/** Read side of the resolver (the database; an in-memory one in unit tests). */
export interface HarnessStore {
  /** The harness of the tenant with this name and all its versions (null when missing). */
  load(tenantId: string, name: string): Promise<{ harness: Harness; versions: HarnessVersion[] } | null>;
}

export function dbHarnessStore(db: Db): HarnessStore {
  return {
    async load(tenantId, name) {
      const [harness] = await db.select().from(harnesses).where(and(eq(harnesses.tenantId, tenantId), eq(harnesses.name, name))).limit(1);
      if (!harness) return null;
      const versions = await db.select().from(harnessVersions).where(and(eq(harnessVersions.tenantId, tenantId), eq(harnessVersions.harnessId, harness.id)));
      return { harness, versions };
    },
  };
}

/** Validates a stored `agent_versions.harness_ref` (jsonb: anything may be there). */
export function parseHarnessRef(raw: unknown): HarnessRef | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !HARNESS_NAME_RE.test(r.name)) return 'invalid';
  if (r.version === undefined || r.version === null) return { name: r.name };
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version <= 0) return 'invalid';
  return { name: r.name, version: r.version };
}

const NONE = (requested: HarnessRef | null, reason: NonNullable<HarnessUsed['fallback_reason']>, name: string | null = requested?.name ?? null): ResolvedHarness => ({
  config: null,
  label: null,
  used: { name, version: requested?.version ?? null, harness_version_id: null, content_hash: null, source: 'none', requested, fallback_reason: reason },
});

/** Resolves the harness ref of an agent version. Never throws. */
export async function resolveHarnessRef(source: Db | HarnessStore, tenantId: string, rawRef: unknown, logger?: HarnessLogger): Promise<ResolvedHarness> {
  const ref = parseHarnessRef(rawRef);
  if (ref === null) return NONE(null, 'no_ref');
  if (ref === 'invalid') {
    logger?.warn({ harnessRef: rawRef, tenantId }, 'invalid harness_ref; running without harness (current policies)');
    return NONE(null, 'invalid_ref', null);
  }
  const store: HarnessStore = 'load' in source && typeof (source as HarnessStore).load === 'function' ? (source as HarnessStore) : dbHarnessStore(source as Db);
  let loaded: Awaited<ReturnType<HarnessStore['load']>>;
  try {
    loaded = await store.load(tenantId, ref.name);
  } catch (err) {
    logger?.warn({ harness: ref.name, tenantId, err: err instanceof Error ? err.message : String(err) }, 'harness resolution failed (database error); running without harness (current policies)');
    return NONE(ref, 'db_error');
  }
  if (!loaded) {
    logger?.warn({ harness: ref.name, tenantId }, 'harness not found in the database; running without harness (current policies)');
    return NONE(ref, 'harness_not_found');
  }
  const { harness, versions } = loaded;
  const version =
    ref.version !== undefined
      ? versions.find((v) => v.version === ref.version)
      : harness.activeVersionId
        ? versions.find((v) => v.id === harness.activeVersionId)
        : undefined;
  if (!version) {
    const reason = ref.version !== undefined ? 'version_not_found' : 'no_active_version';
    logger?.warn({ harness: ref.name, version: ref.version ?? null, tenantId, reason }, 'harness version not resolved; running without harness (current policies)');
    return NONE(ref, reason);
  }
  const config = parseStoredHarnessConfig(version.config);
  if (!config) {
    logger?.warn({ harness: ref.name, version: version.version, tenantId }, 'stored harness config is invalid; running without harness (current policies)');
    return NONE(ref, 'invalid_config');
  }
  return {
    config,
    label: `${harness.name}@${version.version}`,
    used: { name: harness.name, version: version.version, harness_version_id: version.id, content_hash: version.contentHash, source: 'db', requested: ref },
  };
}

/** Full record for `traces.harness`: what was resolved plus the effective values of the run. */
export function harnessRecord(resolved: ResolvedHarness, policies: EffectivePolicies): HarnessUsed {
  return { ...resolved.used, effective: effectiveRecord(policies), overrides: [...policies.overrides] };
}
