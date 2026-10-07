/**
 * Idempotent seed of the skills that were code constants in MVP-0 (`CODE_SKILLS`): each one
 * is created, if missing, with its version 1 ACTIVE holding the EXACT text of the constant.
 * From then on the database is the source of truth: an existing skill is never modified
 * (new versions go through the API). If its ACTIVE version no longer matches the code
 * constant, the seed only logs it (the constant is just the fallback).
 * Runs before the agent seeds, whose versions reference these skills by name.
 */
import type { Db } from '../db/client.js';
import { skillVersions } from '../db/schema.js';
import { CODE_SKILLS } from '../skills/code-skills.js';
import { sha256 } from '../skills/render.js';
import { createSkill, findSkill } from '../skills/service.js';
import { eq } from 'drizzle-orm';

export interface SkillSeedItem {
  name: string;
  skillId: string;
  activeVersion: number | null;
  action: 'created' | 'unchanged';
  /** The ACTIVE version renders to the code constant (false once a new version is active). */
  matchesCode: boolean;
}

export async function seedSkills(db: Db, opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void }): Promise<SkillSeedItem[]> {
  const log = opts.log ?? (() => {});
  const createdBy = opts.createdBy ?? 'seed';
  const out: SkillSeedItem[] = [];
  for (const cs of CODE_SKILLS) {
    const existing = await findSkill(db, opts.tenantId, cs.name);
    if (!existing) {
      const { skill, version } = await createSkill(db, {
        tenantId: opts.tenantId,
        name: cs.name,
        description: cs.description,
        domain: cs.domain,
        content: { instructions: cs.text, metadata: { migrated_from: cs.source, change_reason: 'migrada desde la constante de código (MVP-0)' } },
        createdBy,
        activate: true,
      });
      log(`skill ${cs.name}: created (v${version.version} ACTIVE)`);
      out.push({ name: cs.name, skillId: skill.id, activeVersion: version.version, action: 'created', matchesCode: true });
      continue;
    }
    const [active] = existing.activeVersionId
      ? await db.select().from(skillVersions).where(eq(skillVersions.id, existing.activeVersionId)).limit(1)
      : [];
    const matchesCode = active?.contentHash === sha256(cs.text);
    if (!matchesCode) {
      log(`skill ${cs.name}: unchanged; ACTIVE ${active ? `v${active.version}` : '(ninguna)'} differs from the code fallback (the database is the source of truth)`);
    } else {
      log(`skill ${cs.name}: unchanged (v${active!.version} ACTIVE)`);
    }
    out.push({ name: cs.name, skillId: existing.id, activeVersion: active?.version ?? null, action: 'unchanged', matchesCode });
  }
  return out;
}
