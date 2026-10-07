/**
 * Experiments API (MVP-2, LLD v0.1 sections 11.5-11.6): read only. Experiments are created and
 * run by `pnpm experiment:run` (src/experiments/runner.ts); the table has no DELETE and a
 * finished experiment is immutable (trigger, migration 0011). `:id` accepts the uuid or the
 * name (EXP-003).
 */
import type { FastifyInstance } from 'fastify';
import { findExperiment, listExperiments } from '../../experiments/service.js';
import type { ApiContext } from '../context.js';
import { notFound, parse, serialize, tenantOf } from '../http.js';
import { ExperimentParams, ListExperimentsQuery } from '../schemas.js';

export async function experimentRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.get('/experiments', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListExperimentsQuery, req.query);
    const rows = await listExperiments(db, {
      tenantId,
      subjectType: q.subject_type,
      subjectName: q.subject_name,
      candidateVersion: q.candidate_version,
      status: q.status,
      limit: q.limit,
    });
    // The list leaves out the bulky jsonb (metrics, splits); GET /experiments/:id has them.
    return { items: rows.map(({ metrics: _m, splits: _s, config: _c, ...rest }) => ({ ...serialize(rest), gate_result: { mode: rest.gateResult.mode ?? null, summary: rest.gateResult.summary ?? null } })) };
  });

  app.get('/experiments/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(ExperimentParams, req.params);
    const row = await findExperiment(db, tenantId, id);
    if (!row) throw notFound('experiment');
    return { experiment: serialize(row) };
  });
}
