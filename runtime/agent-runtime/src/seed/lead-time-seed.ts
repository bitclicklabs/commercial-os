/**
 * Lead-time candidates of the Prospector and the EmailDrafter (tanda 18, feedback of
 * 2026-10-12; src/skills/lead-time-candidates.ts).
 *
 * Creates, through the skill service, ONE new DRAFT version of each skill: its ACTIVE text plus
 * the bounded edit operations, with the changelog, the operations and the activation path in
 * the metadata. NEVER activated here: activation is a human decision behind the Release Gate.
 *
 * Idempotent: a version whose metadata carries `candidate = LEAD_TIME_CANDIDATE` is reused,
 * whatever its status. Nothing is deleted or edited (versions are immutable). When the ACTIVE
 * text no longer has an anchor of the operations, the skill is skipped with the reason (the
 * rest of the seed goes on): rebase the operations on the new ACTIVE text.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { skillVersions } from '../db/schema.js';
import { EditOperationError } from '../skills/edit-ops.js';
import { buildLeadTimeCandidate, LEAD_TIME_CANDIDATE, LEAD_TIME_CANDIDATES, LEAD_TIME_FEEDBACK_DATE, type LeadTimeCandidateSpec } from '../skills/lead-time-candidates.js';
import { createVersion, findSkill, listVersions } from '../skills/service.js';

export interface LeadTimeSeedItem {
  skill: string;
  action: 'created' | 'unchanged' | 'skipped';
  version: number | null;
  status: string | null;
  base_version?: number;
  reason?: string;
}

async function seedOne(db: Db, tenantId: string, spec: LeadTimeCandidateSpec, createdBy: string, log: (m: string) => void): Promise<LeadTimeSeedItem> {
  const skip = (reason: string): LeadTimeSeedItem => {
    log(`skill ${spec.skill}: lead-time candidate skipped (${reason})`);
    return { skill: spec.skill, action: 'skipped', version: null, status: null, reason };
  };
  const skill = await findSkill(db, tenantId, spec.skill);
  if (!skill) return skip('skill not found (run the skills seed first)');
  const versions = await listVersions(db, skill.id);
  const existing = versions.find((v) => (v.metadata as Record<string, unknown> | null)?.candidate === LEAD_TIME_CANDIDATE);
  if (existing) {
    log(`skill ${spec.skill}: lead-time candidate unchanged (v${existing.version} ${existing.status})`);
    return { skill: spec.skill, action: 'unchanged', version: existing.version, status: existing.status };
  }
  if (!skill.activeVersionId) return skip('skill has no ACTIVE version to build on');
  const [active] = await db.select().from(skillVersions).where(eq(skillVersions.id, skill.activeVersionId)).limit(1);
  if (!active) return skip('ACTIVE version not found');
  let edited;
  try {
    edited = buildLeadTimeCandidate(spec, active.instructions);
  } catch (err) {
    if (err instanceof EditOperationError) return skip(`the ACTIVE v${active.version} does not take the operations: ${err.message}`);
    throw err;
  }
  const { version } = await createVersion(db, {
    tenantId,
    skillKey: spec.skill,
    copyFrom: 'active',
    content: {
      instructions: edited.text,
      metadata: {
        candidate: LEAD_TIME_CANDIDATE,
        changelog: spec.changelog,
        feedback: { type: 'feedback', ref: LEAD_TIME_FEEDBACK_DATE, note: '6 borradores de Gastrónoma rechazados (feria a 14 días): ángulo de plazos cortos' },
        base_version: active.version,
        removed_ratio: edited.removedRatio,
        added_ratio: edited.addedRatio,
        operations: spec.operations.map((op, i) => ({ ...op, removed_chars: edited.applied[i]!.removed, added_chars: edited.applied[i]!.added })),
        activation: spec.activation,
      },
    },
    changeReason: spec.changelog,
    createdBy,
  });
  log(`skill ${spec.skill}: lead-time candidate created (v${version.version} DRAFT from v${active.version}, not activated)`);
  return { skill: spec.skill, action: 'created', version: version.version, status: version.status, base_version: active.version };
}

export async function seedLeadTimeCandidates(db: Db, opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void }): Promise<LeadTimeSeedItem[]> {
  const log = opts.log ?? (() => undefined);
  const out: LeadTimeSeedItem[] = [];
  for (const spec of LEAD_TIME_CANDIDATES) out.push(await seedOne(db, opts.tenantId, spec, opts.createdBy ?? 'seed', log));
  return out;
}
