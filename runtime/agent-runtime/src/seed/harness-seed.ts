/**
 * Idempotent seed of the harness `default-commercial`: created, if missing, with its
 * version 1 ACTIVE holding TODAY's real values (DEFAULT_COMMERCIAL_CONFIG, see
 * src/harness/config.ts), so the agents that reference it behave exactly as before.
 * From then on the database is the source of truth: an existing harness is never modified
 * (new versions go through the API). If its ACTIVE version differs from the code constant,
 * the seed only logs it. Runs before the agent seeds, whose versions reference it by name.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { harnessVersions } from '../db/schema.js';
import { DEFAULT_COMMERCIAL_CONFIG, DEFAULT_COMMERCIAL_HARNESS_NAME, harnessConfigHash } from '../harness/config.js';
import { createHarness, findHarness } from '../harness/service.js';

export interface HarnessSeedResult {
  name: string;
  harnessId: string;
  activeVersion: number | null;
  action: 'created' | 'unchanged';
  /** The ACTIVE version has the seed config (false once a new version is active). */
  matchesCode: boolean;
}

export async function seedHarnesses(db: Db, opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void }): Promise<HarnessSeedResult> {
  const log = opts.log ?? (() => {});
  const name = DEFAULT_COMMERCIAL_HARNESS_NAME;
  const existing = await findHarness(db, opts.tenantId, name);
  if (!existing) {
    const { harness, version } = await createHarness(db, {
      tenantId: opts.tenantId,
      name,
      description: 'Harness por defecto de los agentes comerciales: políticas de ejecución, tools, contexto y seguridad (v1 = valores vigentes al crearlo).',
      config: DEFAULT_COMMERCIAL_CONFIG,
      metadata: { change_reason: 'v1 con los valores vigentes de env, tareas y código (comportamiento idéntico)' },
      createdBy: opts.createdBy ?? 'seed',
      activate: true,
    });
    log(`harness ${name}: created (v${version.version} ACTIVE)`);
    return { name, harnessId: harness.id, activeVersion: version.version, action: 'created', matchesCode: true };
  }
  const [active] = existing.activeVersionId ? await db.select().from(harnessVersions).where(eq(harnessVersions.id, existing.activeVersionId)).limit(1) : [];
  const matchesCode = active?.contentHash === harnessConfigHash(DEFAULT_COMMERCIAL_CONFIG);
  log(
    matchesCode
      ? `harness ${name}: unchanged (v${active!.version} ACTIVE)`
      : `harness ${name}: unchanged; ACTIVE ${active ? `v${active.version}` : '(ninguna)'} differs from the seed config (the database is the source of truth)`,
  );
  return { name, harnessId: existing.id, activeVersion: active?.version ?? null, action: 'unchanged', matchesCode };
}
