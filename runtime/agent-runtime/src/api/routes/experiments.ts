/**
 * Experiments API (MVP-2, LLD v0.1 sections 11.5-11.6). Experiments are created and run by
 * `pnpm experiment:run` (src/experiments/runner.ts); the table has no DELETE and a finished
 * experiment is immutable (trigger, migration 0011). `:id` accepts the uuid or the name (EXP-003).
 *
 * Re-validation of PASS_FORM experiments (src/experiments/revalidation.ts, migration 0016):
 * - `POST /experiments/:id/revalidate`: measures the accuracy of each arm on the outputs the
 *   experiment stored, against HUMAN labels that arrived later (no model, cost 0), and appends
 *   one `experiment_revalidations` row (201; the same labels return the existing row, 200).
 * - `GET /experiments/:id/revalidations`: its re-validations, newest first.
 * - `GET /experiments/pending-revalidation`: PASS_FORM experiments whose version is still ACTIVE
 *   or in canary, with the usable and fresh labels available.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ExperimentRevalidation } from '../../db/schema.js';
import type { AccuracyMetric } from '../../experiments/gate.js';
import {
  experimentForRevalidations,
  listRevalidations,
  pendingRevalidations,
  revalidateExperiment,
  RevalidationError,
  type RevalidationComputation,
} from '../../experiments/revalidation-service.js';
import { findExperiment, listExperiments } from '../../experiments/service.js';
import type { ApiContext } from '../context.js';
import { HttpError, notFound, parse, serialize, tenantOf } from '../http.js';
import { ExperimentParams, ListExperimentsQuery } from '../schemas.js';

const RevalidateBody = z
  .object({
    min_labels: z.number().int().min(1).max(200).optional(),
    by: z.string().trim().min(1).max(200).optional(),
    dry_run: z.boolean().optional(),
    note: z.boolean().optional(),
  })
  .strict()
  .default({});

const PendingQuery = z.object({ min_labels: z.coerce.number().int().min(1).max(200).optional() });

function toHttp(err: unknown): never {
  if (err instanceof RevalidationError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'not_pass_form' ? 409 : err.code === 'outputs_unavailable' ? 422 : 400;
    throw new HttpError(status, err.code, err.message, err.details);
  }
  throw err;
}

const accuracyView = (a: AccuracyMetric) => ({ value: a.value, correct: a.correct, decisions: a.decisions, labeled_cases: a.labeled_cases });

/** Compact result of a computation (also what a dry run returns). */
function computationView(c: RevalidationComputation) {
  return {
    experiment: { id: c.experiment.id, name: c.experiment.name, subject_type: c.experiment.subjectType, subject_name: c.experiment.subjectName, baseline_version: c.experiment.baselineVersion, candidate_version: c.experiment.candidateVersion },
    verdict: c.verdict.verdict,
    summary: c.verdict.summary,
    accuracy: { baseline: accuracyView(c.accuracy.baseline), candidate: accuracyView(c.accuracy.candidate), threshold: c.verdict.threshold },
    labels: { used: c.selection.labels.length, excluded: c.selection.excluded.length, unlabeled: c.selection.unlabeled, min_required: c.criteria.min_labels, missing: c.verdict.missing, executed_cases: c.executed },
    version_state: c.versionState,
    outputs_source: c.outputs.source,
    cost_eur: 0,
    warnings: c.warnings,
  };
}

const revalidationView = (r: ExperimentRevalidation) => serialize(r);

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

  // Static route: wins over /experiments/:id.
  app.get('/experiments/pending-revalidation', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(PendingQuery, req.query);
    const { items, ready } = await pendingRevalidations(db, { tenantId, minLabels: q.min_labels }).catch(toHttp);
    return { items, ready };
  });

  app.get('/experiments/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(ExperimentParams, req.params);
    const row = await findExperiment(db, tenantId, id);
    if (!row) throw notFound('experiment');
    return { experiment: serialize(row) };
  });

  app.post('/experiments/:id/revalidate', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(ExperimentParams, req.params);
    const body = parse(RevalidateBody, req.body ?? {});
    const result = await revalidateExperiment(
      { db, twenty: ctx.twenty ?? null, events: ctx.events ?? null },
      { tenantId, experiment: id, minLabels: body.min_labels, requestedBy: body.by ?? null, source: 'api', dryRun: body.dry_run === true, ...(body.note !== undefined ? { note: body.note } : {}) },
    ).catch(toHttp);
    const payload = {
      ...computationView(result.computation),
      dry_run: body.dry_run === true,
      created: result.created,
      revalidation: result.revalidation ? revalidationView(result.revalidation) : null,
    };
    return reply.status(result.created ? 201 : 200).send(payload);
  });

  app.get('/experiments/:id/revalidations', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(ExperimentParams, req.params);
    const exp = await experimentForRevalidations(db, tenantId, id).catch(toHttp);
    const rows = await listRevalidations(db, tenantId, exp.id);
    return { experiment: { id: exp.id, name: exp.name, decision: exp.decision }, items: rows.map(revalidationView) };
  });
}
