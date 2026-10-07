/**
 * Knowledge API (LLD v0.1 section 6.4, semantic memory). No DELETE: entries are superseded or
 * rejected. Proposals (PROPOSED) can be edited while PROPOSED or VALIDATED; then they are
 * activated (only with evidence), superseded or rejected. Activating an entry does not touch
 * running agents: new runs read it when they start.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { KNOWLEDGE_SOURCES, KNOWLEDGE_STATUSES, type KnowledgeEntry } from '../../db/schema.js';
import {
  activateEntry,
  findEntry,
  KNOWLEDGE_DOMAIN_RE,
  KnowledgeServiceError,
  listEntries,
  proposeEntry,
  rejectEntry,
  STATEMENT_MAX_CHARS,
  supersedeEntry,
  updateEntry,
  validateEntry,
} from '../../knowledge/service.js';
import type { ApiContext } from '../context.js';
import { HttpError, IdParams, notFound, parse, serialize, tenantOf } from '../http.js';

const Evidence = z.object({
  type: z.enum(['execution', 'evaluation', 'experiment', 'feedback', 'skill_version', 'document']),
  ref: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).optional(),
  doc: z.string().trim().max(500).optional(),
});

const Domain = z.string().trim().toLowerCase().regex(KNOWLEDGE_DOMAIN_RE, 'domain must be lower-case (a-z, 0-9, - or _)').max(60);
const DateTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const ContentFields = {
  domain: Domain,
  topic: z.string().trim().min(1).max(120),
  statement: z.string().trim().min(1).max(STATEMENT_MAX_CHARS),
  evidence: z.array(Evidence).max(50).default([]),
  confidence: z.number().min(0).max(1),
  valid_from: DateTime.nullable().optional(),
  valid_until: DateTime.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const ProposeKnowledgeBody = z.object({
  ...ContentFields,
  source: z.enum(KNOWLEDGE_SOURCES),
  created_by: z.string().trim().min(1).max(200).optional(),
});

export const UpdateKnowledgeBody = z
  .object({
    domain: ContentFields.domain.optional(),
    topic: ContentFields.topic.optional(),
    statement: ContentFields.statement.optional(),
    evidence: z.array(Evidence).max(50).optional(),
    confidence: ContentFields.confidence.optional(),
    valid_from: ContentFields.valid_from,
    valid_until: ContentFields.valid_until,
    metadata: ContentFields.metadata,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

export const ListKnowledgeQuery = z.object({
  domain: Domain.optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  topic: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const ReasonBody = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).default({});
const RejectBody = z.object({ reason: z.string().trim().min(1).max(2000) });
const SupersedeBody = z.object({ superseded_by: z.uuid().optional(), reason: z.string().trim().min(1).max(2000).optional() }).default({});

function toHttp(err: unknown): unknown {
  if (!(err instanceof KnowledgeServiceError)) return err;
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

const out = (e: KnowledgeEntry | null | undefined) => serialize(e);

export async function knowledgeRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.get('/knowledge', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListKnowledgeQuery, req.query);
    const rows = await listEntries(db, { tenantId, ...q });
    return { items: rows.map((r) => out(r)) };
  });

  app.get('/knowledge/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const entry = await findEntry(db, tenantId, id);
    if (!entry) throw notFound('knowledge entry');
    return { entry: out(entry) };
  });

  /** POST /knowledge - a new proposal (always PROPOSED). */
  app.post('/knowledge', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const b = parse(ProposeKnowledgeBody, req.body);
    const entry = await mapped(() =>
      proposeEntry(db, {
        tenantId,
        domain: b.domain,
        topic: b.topic,
        statement: b.statement,
        evidence: b.evidence,
        confidence: b.confidence,
        source: b.source,
        validFrom: b.valid_from,
        validUntil: b.valid_until,
        metadata: b.metadata,
        createdBy: b.created_by,
      }),
    );
    return reply.status(201).send({ entry: out(entry) });
  });

  /** PATCH /knowledge/:id - edits a PROPOSED or VALIDATED entry (409 once ACTIVE). */
  app.patch('/knowledge/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(UpdateKnowledgeBody, req.body);
    const entry = await mapped(() =>
      updateEntry(db, tenantId, id, {
        ...(b.domain !== undefined ? { domain: b.domain } : {}),
        ...(b.topic !== undefined ? { topic: b.topic } : {}),
        ...(b.statement !== undefined ? { statement: b.statement } : {}),
        ...(b.evidence !== undefined ? { evidence: b.evidence } : {}),
        ...(b.confidence !== undefined ? { confidence: b.confidence } : {}),
        ...(b.valid_from !== undefined ? { validFrom: b.valid_from } : {}),
        ...(b.valid_until !== undefined ? { validUntil: b.valid_until } : {}),
        ...(b.metadata !== undefined ? { metadata: b.metadata } : {}),
      }),
    );
    return { entry: out(entry) };
  });

  app.post('/knowledge/:id/validate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(ReasonBody, req.body ?? {});
    const r = await mapped(() => validateEntry(db, { tenantId, id, reason: b.reason }));
    return { entry: out(r.entry), changed: r.changed };
  });

  /** ACTIVE: only with evidence (400 otherwise). Idempotent. */
  app.post('/knowledge/:id/activate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(ReasonBody, req.body ?? {});
    const r = await mapped(() => activateEntry(db, { tenantId, id, reason: b.reason }));
    return { entry: out(r.entry), changed: r.changed };
  });

  /** ACTIVE -> SUPERSEDED; with `superseded_by` the replacement is activated in the same transaction. */
  app.post('/knowledge/:id/supersede', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(SupersedeBody, req.body ?? {});
    const r = await mapped(() => supersedeEntry(db, { tenantId, id, supersededBy: b.superseded_by, reason: b.reason }));
    return { entry: out(r.entry), changed: r.changed, replacement: out(r.replacement) };
  });

  app.post('/knowledge/:id/reject', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(RejectBody, req.body);
    const r = await mapped(() => rejectEntry(db, { tenantId, id, reason: b.reason }));
    return { entry: out(r.entry), changed: r.changed };
  });
}
