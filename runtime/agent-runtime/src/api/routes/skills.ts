/**
 * Skills API (MVP-1, LLD v0.1 section 6.3). No DELETE: versions are deprecated.
 * `:id` accepts the skill uuid or its name (e.g. `prospector-event-exhibitors`).
 * Activating a version does not touch running agents: new runs resolve it when they start.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { skills, skillVersions, type SkillVersion } from '../../db/schema.js';
import {
  activateVersion,
  contentWarnings,
  createSkill,
  createVersion,
  deprecateVersion,
  findSkill,
  listVersions,
  SkillServiceError,
} from '../../skills/service.js';
import type { ApiContext } from '../context.js';
import { HttpError, notFound, parse, serialize, tenantOf } from '../http.js';
import { CreateSkillBody, CreateSkillVersionBody, ListSkillsQuery, SkillParams, SkillVersionParams } from '../schemas.js';

function toHttp(err: unknown): unknown {
  if (!(err instanceof SkillServiceError)) return err;
  if (err.code === 'not_found') return new HttpError(404, 'not_found', err.message, err.details);
  if (err.code === 'conflict') return new HttpError(409, 'conflict', err.message, err.details);
  return new HttpError(400, 'invalid', err.message, err.details);
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

const versionOut = (v: SkillVersion | null | undefined) => serialize(v);

export async function skillRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.get('/skills', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListSkillsQuery, req.query);
    const rows = await db
      .select({ skill: skills, activeVersion: skillVersions.version })
      .from(skills)
      .leftJoin(skillVersions, eq(skillVersions.id, skills.activeVersionId))
      .where(and(eq(skills.tenantId, tenantId), q.status ? eq(skills.status, q.status) : undefined))
      .orderBy(asc(skills.name));
    return { items: rows.map((r) => ({ ...serialize(r.skill), active_version: r.activeVersion ?? null })) };
  });

  app.get('/skills/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(SkillParams, req.params);
    const skill = await findSkill(db, tenantId, id);
    if (!skill) throw notFound('skill');
    const versions = await listVersions(db, skill.id);
    const active = versions.find((v) => v.id === skill.activeVersionId);
    return { skill: { ...serialize(skill), active_version: active?.version ?? null }, versions: versions.map((v) => versionOut(v)) };
  });

  /** POST /skills - creates the skill and its version 1 as DRAFT (activate it to use it). */
  app.post('/skills', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(CreateSkillBody, req.body);
    const content = {
      instructions: body.instructions,
      constraints: body.constraints,
      examples: body.examples,
      antiPatterns: body.anti_patterns,
      metadata: body.metadata,
    };
    const result = await mapped(() =>
      createSkill(db, { tenantId, name: body.name, description: body.description, domain: body.domain, content, createdBy: body.created_by }),
    );
    return reply.status(201).send({ skill: serialize(result.skill), version: versionOut(result.version), warnings: contentWarnings(content) });
  });

  /** POST /skills/:id/versions - new DRAFT version from text or copying the ACTIVE (or a given) version. */
  app.post('/skills/:id/versions', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(SkillParams, req.params);
    const body = parse(CreateSkillVersionBody, req.body ?? {});
    const result = await mapped(() =>
      createVersion(db, {
        tenantId,
        skillKey: id,
        copyFrom: body.copy_from,
        content: {
          ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
          ...(body.constraints !== undefined ? { constraints: body.constraints } : {}),
          ...(body.examples !== undefined ? { examples: body.examples } : {}),
          ...(body.anti_patterns !== undefined ? { antiPatterns: body.anti_patterns } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        },
        changeReason: body.change_reason,
        createdBy: body.created_by,
      }),
    );
    return reply.status(201).send({ skill: serialize(result.skill), version: versionOut(result.version), warnings: contentWarnings(result.version) });
  });

  /** ACTIVE the version and DEPRECATED the previous ACTIVE one, in one transaction. Idempotent. */
  app.post('/skills/:id/versions/:v/activate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(SkillVersionParams, req.params);
    const r = await mapped(() => activateVersion(db, { tenantId, skillKey: id, version: v }));
    return { skill: serialize(r.skill), version: versionOut(r.version), changed: r.changed, previous_version: versionOut(r.previous) };
  });

  /**
   * DEPRECATED a DRAFT version, or roll back the ACTIVE one: the version active before it
   * becomes ACTIVE again (409 when there is none). Idempotent.
   */
  app.post('/skills/:id/versions/:v/deprecate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(SkillVersionParams, req.params);
    const r = await mapped(() => deprecateVersion(db, { tenantId, skillKey: id, version: v }));
    return { skill: serialize(r.skill), version: versionOut(r.version), changed: r.changed, restored_version: versionOut(r.restored) };
  });
}
