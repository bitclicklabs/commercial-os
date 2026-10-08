/**
 * Harnesses API (MVP-1, LLD v0.1 section 7.1), same shape as the skills API. No DELETE:
 * versions are deprecated. `:id` accepts the harness uuid or its name (e.g.
 * `default-commercial`). Activating a version does not touch attempts in flight: the next
 * attempt of each run resolves it when it starts.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { harnesses, harnessVersions, type HarnessVersion } from '../../db/schema.js';
import { placeholderWarnings, parseStoredHarnessConfig } from '../../harness/config.js';
import {
  activateHarnessVersion,
  createHarness,
  createHarnessVersion,
  deprecateHarnessVersion,
  findHarness,
  HarnessServiceError,
  listHarnessVersions,
} from '../../harness/service.js';
import { checkActivationGate, logGate, ReleaseGateBlockedError } from '../../experiments/release-gate.js';
import type { ApiContext } from '../context.js';
import { HttpError, notFound, parse, serialize, tenantOf } from '../http.js';
import { ActivateVersionBody, CreateHarnessBody, CreateHarnessVersionBody, HarnessParams, HarnessVersionParams, ListHarnessesQuery } from '../schemas.js';

function toHttp(err: unknown): unknown {
  if (err instanceof ReleaseGateBlockedError) return new HttpError(409, err.code, err.message, err.details);
  if (!(err instanceof HarnessServiceError)) return err;
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

const versionOut = (v: HarnessVersion | null | undefined) => serialize(v);
const warningsOf = (v: HarnessVersion) => {
  const config = parseStoredHarnessConfig(v.config);
  return config ? placeholderWarnings(config) : [];
};

export async function harnessRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.get('/harnesses', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListHarnessesQuery, req.query);
    const rows = await db
      .select({ harness: harnesses, activeVersion: harnessVersions.version })
      .from(harnesses)
      .leftJoin(harnessVersions, eq(harnessVersions.id, harnesses.activeVersionId))
      .where(and(eq(harnesses.tenantId, tenantId), q.status ? eq(harnesses.status, q.status) : undefined))
      .orderBy(asc(harnesses.name));
    return { items: rows.map((r) => ({ ...serialize(r.harness), active_version: r.activeVersion ?? null })) };
  });

  app.get('/harnesses/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(HarnessParams, req.params);
    const harness = await findHarness(db, tenantId, id);
    if (!harness) throw notFound('harness');
    const versions = await listHarnessVersions(db, harness.id);
    const active = versions.find((v) => v.id === harness.activeVersionId);
    return { harness: { ...serialize(harness), active_version: active?.version ?? null }, versions: versions.map((v) => versionOut(v)) };
  });

  /** POST /harnesses - creates the harness and its version 1 as DRAFT (activate it to use it). */
  app.post('/harnesses', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(CreateHarnessBody, req.body);
    const result = await mapped(() =>
      createHarness(db, { tenantId, name: body.name, description: body.description, config: body.config, metadata: body.metadata, createdBy: body.created_by }),
    );
    return reply.status(201).send({ harness: serialize(result.harness), version: versionOut(result.version), warnings: warningsOf(result.version) });
  });

  /** POST /harnesses/:id/versions - new DRAFT version from a config or copying the ACTIVE (or a given) version. */
  app.post('/harnesses/:id/versions', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(HarnessParams, req.params);
    const body = parse(CreateHarnessVersionBody, req.body ?? {});
    const result = await mapped(() =>
      createHarnessVersion(db, {
        tenantId,
        harnessKey: id,
        copyFrom: body.copy_from,
        config: body.config,
        metadata: body.metadata,
        changeReason: body.change_reason,
        createdBy: body.created_by,
      }),
    );
    return reply.status(201).send({ harness: serialize(result.harness), version: versionOut(result.version), warnings: warningsOf(result.version) });
  });

  /**
   * ACTIVE the version and DEPRECATED the previous ACTIVE one, in one transaction. Idempotent.
   * Same Release Gate as skills (src/experiments/release-gate.ts): a version that was never
   * ACTIVE needs a COMPLETED harness experiment (`pnpm experiment:run --subject harness:<name>`)
   * with decision PASS or PASS_FORM against the current ACTIVE version, or a human override
   * `{ force: true, reason }`. Blocked: 409 `release_gate_blocked` citing the experiments. A
   * rollback to a former ACTIVE version needs neither.
   */
  app.post('/harnesses/:id/versions/:v/activate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(HarnessVersionParams, req.params);
    const body = parse(ActivateVersionBody, req.body ?? {});
    const r = await mapped(() =>
      activateHarnessVersion(db, {
        tenantId,
        harnessKey: id,
        version: v,
        guard: (tx, g) =>
          checkActivationGate(tx, {
            tenantId,
            subjectType: 'harness',
            subjectName: g.harness.name,
            target: g.target,
            activeVersion: g.active?.version ?? null,
            override: body,
          }),
      }),
    );
    logGate(req, 'harness', id, v, r.gate);
    return { harness: serialize(r.harness), version: versionOut(r.version), changed: r.changed, previous_version: versionOut(r.previous), gate: r.gate ?? null };
  });

  /**
   * DEPRECATED a DRAFT version, or roll back the ACTIVE one: the version active before it
   * becomes ACTIVE again (409 when there is none). Idempotent.
   */
  app.post('/harnesses/:id/versions/:v/deprecate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id, v } = parse(HarnessVersionParams, req.params);
    const r = await mapped(() => deprecateHarnessVersion(db, { tenantId, harnessKey: id, version: v }));
    return { harness: serialize(r.harness), version: versionOut(r.version), changed: r.changed, restored_version: versionOut(r.restored) };
  });
}
