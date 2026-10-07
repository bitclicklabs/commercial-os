/**
 * Evaluation datasets API (LLD v0.1 section 11.4, P5). No DELETE and no PATCH: a version is
 * immutable; re-harvesting creates a new version. The only write on a case is `mark-used`
 * (append-only `used_by`), and serving VALIDATION/TEST leaves out the cases the asking
 * experiment may not use.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { CASE_USE_ROLES, DATASET_SPLITS, DATASET_STATUSES, type EvaluationDataset } from '../../db/schema.js';
import { EXPERIMENT_ID_RE } from '../../datasets/core.js';
import { toCompareInputs } from '../../datasets/fixtures.js';
import {
  activateDataset,
  archiveDataset,
  buildDataset,
  countsOf,
  DATASET_NAME_RE,
  DatasetServiceError,
  HARVESTERS,
  listCases,
  listDatasets,
  markUsed,
  requireDataset,
  type DatasetCounts,
} from '../../datasets/service.js';
import type { ApiContext } from '../context.js';
import { HttpError, IdParams, parse, serialize, tenantOf } from '../http.js';

const Name = z.string().trim().toLowerCase().max(80).regex(DATASET_NAME_RE, 'name must be lower-case (a-z, 0-9, separated by - _ .)');
const Domain = z.string().trim().toLowerCase().max(60).refine((d) => Boolean(HARVESTERS[d]), { message: `domain must be one of: ${Object.keys(HARVESTERS).join(', ')}` });
const Experiment = z.string().trim().regex(EXPERIMENT_ID_RE, 'experiment must be an id like "EXP-003"');

export const CreateDatasetBody = z.object({
  name: Name,
  domain: Domain,
  description: z.string().trim().min(1).max(2000).optional(),
  created_by: z.string().trim().min(1).max(200).optional(),
});

export const BuildDatasetBody = z.object({
  description: z.string().trim().min(1).max(2000).optional(),
  created_by: z.string().trim().min(1).max(200).optional(),
}).default({});

export const ListDatasetsQuery = z.object({
  name: Name.optional(),
  domain: z.string().trim().toLowerCase().max(60).optional(),
  status: z.enum(DATASET_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const Bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const ListCasesQuery = z.object({
  split: z.enum(DATASET_SPLITS).optional(),
  experiment: Experiment.optional(),
  role: z.enum(CASE_USE_ROLES).optional(),
  include_vetoed: Bool.optional(),
  tag: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const MarkUsedBody = z.object({
  case_ids: z.array(z.uuid()).min(1).max(2000),
  experiment: Experiment,
  role: z.enum(CASE_USE_ROLES),
  by: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});

function toHttp(err: unknown): unknown {
  if (!(err instanceof DatasetServiceError)) return err;
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

const out = (d: EvaluationDataset, counts?: DatasetCounts) => ({ ...serialize(d), ...(counts ? { counts } : {}) });

export async function datasetRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.get('/datasets', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListDatasetsQuery, req.query);
    const rows = await listDatasets(db, { tenantId, ...q });
    const counts = await countsOf(db, rows.map((r) => r.id));
    return { items: rows.map((r) => out(r, counts.get(r.id))) };
  });

  /** POST /datasets - new dataset: harvests now and creates v1 (DRAFT). 409 if the name exists. */
  app.post('/datasets', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const b = parse(CreateDatasetBody, req.body);
    const r = await mapped(() => buildDataset(db, { tenantId, name: b.name, domain: b.domain, description: b.description, createdBy: b.created_by, mustBeNew: true }));
    const counts = await countsOf(db, [r.dataset!.id]);
    return reply.status(201).send({ dataset: out(r.dataset!, counts.get(r.dataset!.id)), summary: r.summary, warnings: r.warnings });
  });

  app.get('/datasets/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const d = await mapped(() => requireDataset(db, tenantId, id));
    const counts = await countsOf(db, [d.id]);
    return { dataset: out(d, counts.get(d.id)) };
  });

  /** POST /datasets/:id/build - re-harvest: a NEW version of the same name (DRAFT); never mutates this one. */
  app.post('/datasets/:id/build', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(BuildDatasetBody, req.body ?? {});
    const base = await mapped(() => requireDataset(db, tenantId, id));
    const r = await mapped(() =>
      buildDataset(db, { tenantId, name: base.name, domain: base.domain, description: b.description ?? base.description, createdBy: b.created_by }),
    );
    const counts = await countsOf(db, [r.dataset!.id]);
    return reply.status(201).send({ dataset: out(r.dataset!, counts.get(r.dataset!.id)), parent: { id: base.id, version: base.version }, summary: r.summary, warnings: r.warnings });
  });

  /** GET /datasets/:id/cases?split=&experiment=&role=&include_vetoed=&tag= - P5 applied to VALIDATION/TEST. */
  app.get('/datasets/:id/cases', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const q = parse(ListCasesQuery, req.query);
    const r = await mapped(() =>
      listCases(db, { tenantId, datasetId: id, split: q.split, experiment: q.experiment, role: q.role, includeVetoed: q.include_vetoed, tag: q.tag, limit: q.limit, offset: q.offset }),
    );
    return { items: r.items.map((c) => serialize(c)), vetoed: r.vetoed };
  });

  /** GET /datasets/:id/fixtures?split=... - the served cases as `skill:compare` inputs ({ event, exhibitors[] }, max 50). */
  app.get('/datasets/:id/fixtures', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const q = parse(ListCasesQuery, req.query);
    const r = await mapped(() =>
      listCases(db, { tenantId, datasetId: id, split: q.split, experiment: q.experiment, role: q.role, includeVetoed: false, tag: q.tag, limit: q.limit ?? 2000, offset: q.offset }),
    );
    return { ...toCompareInputs(r.items), vetoed: r.vetoed };
  });

  /** POST /datasets/:id/mark-used - P5 ledger: `{ case_ids, experiment, role }`. All or nothing; 409 when vetoed. */
  app.post('/datasets/:id/mark-used', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const b = parse(MarkUsedBody, req.body);
    return mapped(() => markUsed(db, { tenantId, datasetId: id, caseIds: b.case_ids, experiment: b.experiment, role: b.role, by: b.by, note: b.note }));
  });

  app.post('/datasets/:id/activate', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const r = await mapped(() => activateDataset(db, tenantId, id));
    return { dataset: out(r.dataset), changed: r.changed, archived: r.archived };
  });

  app.post('/datasets/:id/archive', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const r = await mapped(() => archiveDataset(db, tenantId, id));
    return { dataset: out(r.dataset), changed: r.changed };
  });
}
