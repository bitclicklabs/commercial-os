/**
 * Skills API (MVP-1, LLD v0.1 section 6.3). No DELETE: versions are deprecated.
 * `:id` accepts the skill uuid or its name (e.g. `prospector-event-exhibitors`).
 * Activating a version does not touch running agents: new runs resolve it when they start.
 *
 * Canary (src/skills/canary.ts): `POST /skills/:id/versions/:v/canary`, `GET /skills/:id/canary`,
 * `POST /skills/:id/canary/promote` and `POST /skills/:id/canary/rollback`. A human decides
 * every step; nothing promotes itself.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { skills, skillVersions, type SkillCanary, type SkillVersion } from '../../db/schema.js';
import { canaryArmMetrics } from '../../metrics/queries.js';
import { latestCanary, listCanaries, promoteCanary, rollbackCanary, startCanary, type CanaryGuard } from '../../skills/canary.js';
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
import { checkActivationGate, logGate, refutedOptions, ReleaseGateBlockedError, type ActivationGate } from '../../experiments/release-gate.js';
import type { ApiContext } from '../context.js';
import { HttpError, notFound, parse, serialize, tenantOf } from '../http.js';
import { ActivateVersionBody, CreateSkillBody, CreateSkillVersionBody, FinishCanaryBody, ListSkillsQuery, SkillParams, SkillVersionParams, StartCanaryBody } from '../schemas.js';

function toHttp(err: unknown): unknown {
  if (err instanceof ReleaseGateBlockedError) return new HttpError(409, err.code, err.message, err.details);
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
const canaryOut = (c: SkillCanary | null | undefined) => serialize(c);

type CanaryGate = { experimentId: string; record: Record<string, unknown>; gate: Extract<ActivationGate, { mode: 'experiment' }> };

/**
 * Release Gate of a canary (start and promote): the activation gate WITHOUT override. It must
 * be an experiment PASS / PASS_FORM of the canary version against the current ACTIVE version
 * (a rollback-mode pass is not enough: a canary compares a candidate with an experiment).
 */
function canaryGuard(tenantId: string, step: 'start' | 'promote'): CanaryGuard<CanaryGate> {
  return async (tx, g) => {
    const blocked = (why: string, details: Record<string, unknown> = {}) => {
      const refuted = details.reason === 'revalidation_refuted';
      const advice = refuted
        ? `Un canario no admite force: itera (versión nueva + experimento frente a la v${g.active.version} activa) o haz rollback del canario (POST /skills/${g.skill.name}/canary/rollback).`
        : `Un canario no admite force: ejecuta un experimento (pnpm experiment:run) de v${g.target.version} frente a la v${g.active.version} activa.`;
      return new ReleaseGateBlockedError(
        `Release Gate (${step === 'start' ? 'canario' : 'promote'}): ${why}. ${advice}`,
        {
          subject_type: 'skill',
          subject_name: g.skill.name,
          candidate_version: g.target.version,
          active_version: g.active.version,
          required: `experimento COMPLETED con decision PASS o PASS_FORM y baseline = versión activa${refuted ? ', cuya revalidación más reciente no sea REFUTED' : ''} (sin override)`,
          ...details,
          ...(refuted ? { options: refutedOptions('skill', g.skill.name, g.target.version, true) } : {}),
        },
        why,
      );
    };
    let gate: ActivationGate;
    try {
      gate = await checkActivationGate(tx, { tenantId, subjectType: 'skill', subjectName: g.skill.name, target: g.target, activeVersion: g.active.version });
    } catch (err) {
      if (err instanceof ReleaseGateBlockedError) {
        const { reason, experiment, revalidation, experiments } = err.details;
        throw blocked(err.why, { reason, ...(experiment ? { experiment } : {}), ...(revalidation ? { revalidation } : {}), experiments });
      }
      throw err;
    }
    if (gate.mode !== 'experiment') throw blocked(gate.detail, { gate_mode: gate.mode });
    return { experimentId: gate.experiment.id, record: { ...gate, step, checked_at: new Date().toISOString() }, gate };
  };
}

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

  /**
   * ACTIVE the version and DEPRECATED the previous ACTIVE one, in one transaction. Idempotent.
   * Release Gate (LLD v0.1 section 19): a version that was never ACTIVE needs a COMPLETED
   * experiment with decision PASS or PASS_FORM against the current ACTIVE version, or a human
   * override `{ force: true, reason }`. Blocked: 409 `release_gate_blocked`.
   */
  app.post('/skills/:id/versions/:v/activate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(SkillVersionParams, req.params);
    const body = parse(ActivateVersionBody, req.body ?? {});
    const r = await mapped(() =>
      activateVersion(db, {
        tenantId,
        skillKey: id,
        version: v,
        guard: (tx, g) =>
          checkActivationGate(tx, {
            tenantId,
            subjectType: 'skill',
            subjectName: g.skill.name,
            target: g.target,
            activeVersion: g.active?.version ?? null,
            override: body,
          }),
      }),
    );
    logGate(req, 'skill', id, v, r.gate);
    return { skill: serialize(r.skill), version: versionOut(r.version), changed: r.changed, previous_version: versionOut(r.previous), gate: r.gate ?? null };
  });

  /**
   * DEPRECATED a DRAFT version, or roll back the ACTIVE one: the version active before it
   * becomes ACTIVE again (409 when there is none). Idempotent.
   */
  app.post('/skills/:id/versions/:v/deprecate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(SkillVersionParams, req.params);
    const r = await mapped(() => deprecateVersion(db, { tenantId, skillKey: id, version: v }));
    return { skill: serialize(r.skill), version: versionOut(r.version), changed: r.changed, restored_version: versionOut(r.restored), canary_rolled_back: canaryOut(r.canary ?? null) };
  });

  /**
   * POST /skills/:id/versions/:v/canary { percent } - sends `percent` % of the runs that follow
   * the ACTIVE version to v (deterministic hash of the run id). Same gate as the activation, no
   * force. One canary per skill (409 otherwise). Idempotent for the same version and percent.
   */
  app.post('/skills/:id/versions/:v/canary', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(SkillVersionParams, req.params);
    const body = parse(StartCanaryBody, req.body ?? {});
    const r = await mapped(() => startCanary(db, { tenantId, skillKey: id, version: v, percent: body.percent, by: body.by, guard: canaryGuard(tenantId, 'start') }));
    if (r.changed) req.log.info({ canary: r.canary.id, skill: id, version: v, percent: body.percent, experiment: r.gate?.gate.experiment.name, revalidated: r.gate?.gate.revalidated ?? false, by: body.by ?? null }, 'skill canary started (human)');
    return reply.status(r.changed ? 201 : 200).send({ skill: serialize(r.skill), canary: canaryOut(r.canary), changed: r.changed, gate: r.gate?.gate ?? null });
  });

  /** GET /skills/:id/canary - the ACTIVE canary (or the latest one), its history and canary-vs-stable metrics. */
  app.get('/skills/:id/canary', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(SkillParams, req.params);
    const skill = await findSkill(db, tenantId, id);
    if (!skill) throw notFound('skill');
    const current = await latestCanary(db, skill.id);
    if (!current) throw new HttpError(404, 'not_found', `skill ${skill.name} has no canary`);
    const history = await listCanaries(db, tenantId, skill.id);
    const metrics = await canaryArmMetrics(db, { tenantId, skillName: skill.name, canaryId: current.id });
    return { skill: { id: skill.id, name: skill.name, active_version_id: skill.activeVersionId }, canary: canaryOut(current), active: current.status === 'ACTIVE', metrics, history: history.map((c) => canaryOut(c)) };
  });

  /** POST /skills/:id/canary/promote - human decision: re-checks the gate and makes the canary version ACTIVE. */
  app.post('/skills/:id/canary/promote', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(SkillParams, req.params);
    const body = parse(FinishCanaryBody, req.body ?? {});
    const r = await mapped(() => promoteCanary(db, { tenantId, skillKey: id, by: body.by, guard: canaryGuard(tenantId, 'promote') }));
    req.log.info({ canary: r.canary.id, skill: id, version: r.canary.canaryVersion, revalidated: r.gate?.gate.revalidated ?? false, by: body.by ?? null }, 'skill canary promoted (human)');
    return { skill: serialize(r.skill), canary: canaryOut(r.canary), changed: r.changed, version: versionOut(r.version), previous_version: versionOut(r.previous), gate: r.gate?.gate ?? null };
  });

  /** POST /skills/:id/canary/rollback - every run goes back to the stable version. Always allowed, idempotent. */
  app.post('/skills/:id/canary/rollback', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(SkillParams, req.params);
    const body = parse(FinishCanaryBody, req.body ?? {});
    const r = await mapped(() => rollbackCanary(db, { tenantId, skillKey: id, by: body.by, reason: body.reason }));
    if (r.changed) req.log.warn({ canary: r.canary?.id, skill: id, by: body.by ?? null, reason: body.reason ?? null }, 'skill canary rolled back (human)');
    return { skill: serialize(r.skill), canary: canaryOut(r.canary), changed: r.changed };
  });
}
