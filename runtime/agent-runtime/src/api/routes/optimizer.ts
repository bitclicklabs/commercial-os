/**
 * Skill Optimizer API (MVP-3, LLD v0.1 section 18). No DELETE.
 *
 * - `POST /optimizer/skills/:name/run`: creates a PENDING run of the skill's ACTIVE version and
 *   enqueues it (202). One open run per skill (409). The worker does the rest.
 * - `GET /optimizer/runs?skill=&status=&limit=` and `GET /optimizer/runs/:id`.
 * - `POST /optimizer/runs/:id/close`: the human close (PROMOTED after activating the
 *   candidate through the Release Gate, or DISCARDED). The optimizer never activates.
 * - `GET /optimizer/schedule`: the scheduled optimizer (src/optimizer/schedule-job.ts), read
 *   only: enabled, cron, timezone, skills, last and next fire.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { OPTIMIZATION_RUN_STATUSES, type OptimizationRun } from '../../db/schema.js';
import type { OptimizerConfig } from '../../optimizer/core.js';
import { launchOptimizationRun, OptimizerLaunchError } from '../../optimizer/launch.js';
import { optimizerScheduleSettingsFromEnv, optimizerScheduleStatus } from '../../optimizer/schedule-job.js';
import { closeRun, findRun, listRuns, OptimizerServiceError } from '../../optimizer/service.js';
import { SKILL_NAME_RE } from '../../skills/service.js';
import { DATASET_NAME_RE } from '../../datasets/service.js';
import type { ApiContext } from '../context.js';
import { HttpError, IdParams, notFound, parse, serialize, tenantOf } from '../http.js';

const SkillParams = z.object({ name: z.string().trim().min(1).max(120).regex(SKILL_NAME_RE, 'skill name must be kebab-case') });
const DatasetName = z.string().trim().toLowerCase().max(80).regex(DATASET_NAME_RE, 'dataset name must be lower-case (a-z, 0-9, separated by - _ .)');

export const OptimizerRunBody = z
  .object({
    datasetName: DatasetName.optional(),
    dataset_name: DatasetName.optional(),
    budget_eur: z.number().positive().max(5).optional(),
    llm_budget_eur: z.number().positive().max(1).optional(),
    repeat: z.number().int().min(1).max(5).optional(),
    min_labeled_validation: z.number().int().min(1).max(200).optional(),
    min_failures: z.number().int().min(1).max(200).optional(),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    created_by: z.string().trim().min(1).max(200).optional(),
  })
  .default({});

const ListRunsQuery = z.object({
  skill: z.string().trim().min(1).max(120).optional(),
  status: z.enum(OPTIMIZATION_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const CloseBody = z.object({
  outcome: z.enum(['PROMOTED', 'DISCARDED']),
  by: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(2000).optional(),
});

function toHttp(err: unknown): never {
  if (err instanceof OptimizerServiceError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
    throw new HttpError(status, err.code, err.message, err.details);
  }
  throw err;
}

/** Same answers as before the shared launch path (src/optimizer/launch.ts). */
function launchToHttp(err: unknown): never {
  if (err instanceof OptimizerLaunchError) {
    switch (err.code) {
      case 'skill_not_found':
        throw notFound('skill');
      case 'unsupported_skill':
        throw new HttpError(422, 'unsupported_skill', err.message);
      case 'no_active_version':
        throw new HttpError(409, 'conflict', err.message);
      case 'invalid_config':
        throw new HttpError(400, 'invalid', err.message);
      case 'no_queue':
        throw new HttpError(503, 'optimizer_unavailable', err.message);
      case 'queue_unavailable':
        throw new HttpError(503, 'queue_unavailable', err.message, err.run ? { run: view(err.run, false) } : undefined);
    }
  }
  return toHttp(err);
}

/** The run as served: snake_case; the list leaves out the bulky `details.failures`. */
function view(run: OptimizationRun, full: boolean): Record<string, unknown> {
  const { failures: _f, ...light } = run.details as { failures?: unknown };
  return serialize({ ...run, details: full ? run.details : light });
}

export async function optimizerRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.post('/optimizer/skills/:name/run', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { name } = parse(SkillParams, req.params);
    const body = parse(OptimizerRunBody, req.body ?? {});
    const overrides: Partial<OptimizerConfig> = {
      ...(body.datasetName ?? body.dataset_name ? { datasetName: (body.datasetName ?? body.dataset_name)! } : {}),
      ...(body.budget_eur !== undefined ? { experimentBudgetEur: body.budget_eur } : {}),
      ...(body.llm_budget_eur !== undefined ? { llmBudgetEur: body.llm_budget_eur } : {}),
      ...(body.repeat !== undefined ? { repeat: body.repeat } : {}),
      ...(body.min_labeled_validation !== undefined ? { minLabeledValidation: body.min_labeled_validation } : {}),
      ...(body.min_failures !== undefined ? { minFailures: body.min_failures } : {}),
      ...(body.today !== undefined ? { today: body.today } : {}),
    };
    // Same path as the scheduled job (src/optimizer/launch.ts).
    const run = await launchOptimizationRun(db, ctx.optimizerQueue, { tenantId, skill: name, overrides, createdBy: body.created_by ?? null }).catch(launchToHttp);
    return reply.status(202).send({ run: view(run, false) });
  });

  app.get('/optimizer/schedule', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const settings = ctx.optimizerSchedule ?? optimizerScheduleSettingsFromEnv();
    return { schedule: await optimizerScheduleStatus(db, tenantId, settings) };
  });

  app.get('/optimizer/runs', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListRunsQuery, req.query);
    const rows = await listRuns(db, { tenantId, skillName: q.skill, statuses: q.status ? [q.status] : undefined, limit: q.limit });
    return { items: rows.map((r) => view(r, false)) };
  });

  app.get('/optimizer/runs/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const run = await findRun(db, tenantId, id);
    if (!run) throw notFound('optimization run');
    return { run: view(run, true) };
  });

  app.post('/optimizer/runs/:id/close', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const body = parse(CloseBody, req.body ?? {});
    const run = await closeRun(db, { tenantId, id, outcome: body.outcome, by: body.by, reason: body.reason }).catch(toHttp);
    return { run: view(run, false) };
  });
}
