/**
 * Skill `email-reply-draft` v2 (tanda 23): the ACTIVE text plus the sections «Cuándo quiere la
 * reunión el cliente» and «Datos de cualificación» (with the capability markers
 * REPLY_WINDOW_MARKER / REPLY_QUALIFICATION_MARKER that make the InboxAgent ask for and read
 * `ventana_cliente` and `cualificacion` in the same drafting call).
 *
 * Same pattern as the other candidates of the seed (catalog, lead time): ONE new DRAFT version,
 * NEVER activated here; activation is a human decision behind the Release Gate
 * (POST /skills/email-reply-draft/versions/<v>/activate, with an experiment or `{ force, reason }`).
 * While v1 stays ACTIVE the InboxAgent behaves exactly as in tanda 22.
 *
 * Idempotent: a version whose metadata carries `candidate = REPLY_DRAFT_V2_CANDIDATE` is reused,
 * whatever its status. v1 is kept untouched (versions are immutable; nothing is deleted).
 */
import { eq } from 'drizzle-orm';
import { REPLY_DRAFT_SKILL_ID, REPLY_DRAFT_V2_CANDIDATE, REPLY_DRAFT_V2_CHANGELOG, REPLY_QUALIFICATION_MARKER, REPLY_WINDOW_MARKER, withReplyDraftV2 } from '../agents/reply-draft-prompt.js';
import type { Db } from '../db/client.js';
import { skillVersions } from '../db/schema.js';
import { createVersion, findSkill, listVersions } from '../skills/service.js';

export interface ReplyDraftV2SeedResult {
  skill: string;
  action: 'created' | 'unchanged' | 'skipped';
  version: number | null;
  status: string | null;
  base_version?: number;
  reason?: string;
}

export async function seedReplyDraftV2(db: Db, opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void }): Promise<ReplyDraftV2SeedResult> {
  const log = opts.log ?? (() => undefined);
  const skip = (reason: string): ReplyDraftV2SeedResult => {
    log(`skill ${REPLY_DRAFT_SKILL_ID}: v2 candidate skipped (${reason})`);
    return { skill: REPLY_DRAFT_SKILL_ID, action: 'skipped', version: null, status: null, reason };
  };
  const skill = await findSkill(db, opts.tenantId, REPLY_DRAFT_SKILL_ID);
  if (!skill) return skip('skill not found (run the skills seed first)');
  const versions = await listVersions(db, skill.id);
  const existing = versions.find((v) => (v.metadata as Record<string, unknown> | null)?.candidate === REPLY_DRAFT_V2_CANDIDATE);
  if (existing) {
    log(`skill ${REPLY_DRAFT_SKILL_ID}: v2 candidate unchanged (v${existing.version} ${existing.status})`);
    return { skill: REPLY_DRAFT_SKILL_ID, action: 'unchanged', version: existing.version, status: existing.status };
  }
  if (!skill.activeVersionId) return skip('skill has no ACTIVE version to build on');
  const [active] = await db.select().from(skillVersions).where(eq(skillVersions.id, skill.activeVersionId)).limit(1);
  if (!active) return skip('ACTIVE version not found');
  const { version } = await createVersion(db, {
    tenantId: opts.tenantId,
    skillKey: REPLY_DRAFT_SKILL_ID,
    copyFrom: 'active',
    content: {
      instructions: withReplyDraftV2(active.instructions),
      metadata: {
        candidate: REPLY_DRAFT_V2_CANDIDATE,
        changelog: REPLY_DRAFT_V2_CHANGELOG,
        feedback: { type: 'feedback', ref: '2026-11-26', note: 'prueba de punta a punta: «¿podemos hablar la semana que viene?» y el borrador propuso también el viernes de esa semana' },
        base_version: active.version,
        markers: [REPLY_WINDOW_MARKER, REPLY_QUALIFICATION_MARKER],
        activation: 'Release Gate: POST /skills/email-reply-draft/versions/<v>/activate (experimento PASS/PASS_FORM o { force: true, reason })',
      },
    },
    changeReason: REPLY_DRAFT_V2_CHANGELOG,
    createdBy: opts.createdBy ?? 'seed',
  });
  log(`skill ${REPLY_DRAFT_SKILL_ID}: v2 candidate created (v${version.version} DRAFT from v${active.version}, not activated)`);
  return { skill: REPLY_DRAFT_SKILL_ID, action: 'created', version: version.version, status: version.status, base_version: active.version };
}
