/**
 * Skill Optimizer API (MVP-3, LLD v0.1 section 18). No DELETE.
 *
 * - `POST /optimizer/skills/:name/run`: creates a PENDING run of the skill's ACTIVE version and
 *   enqueues it (202). One open run per skill (409). The worker does the rest.
 * - `GET /optimizer/runs?skill=&status=&limit=` and `GET /optimizer/runs/:id`.
 * - `POST /optimizer/runs/:id/close`: the human close (PROMOTED after activating the
 *   candidate through the Release Gate, or DISCARDED). The optimizer never activates.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { OPTIMIZATION_RUN_STATUSES, type OptimizationRun } from '../../db/schema.js';
import { OPTIMIZABLE_SKILLS, optimizerConfig, type OptimizerConfig } from '../../optimizer/core.js';
import { closeRun, createRun, findRun, listRuns, OptimizerServiceError, transitionRun } from '../../optimizer/service.js';
import { findSkill, listVersions, SKILL_NAME_RE } from '../../skills/service.js';
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
    const skill = await findSkill(db, tenantId, name);
    if (!skill) throw notFound('skill');
    if (!OPTIMIZABLE_SKILLS[skill.name]) {
      throw new HttpError(422, 'unsupported_skill', `no hay optimizador para la skill "${skill.name}": necesita un runner de experimentos (soportadas: ${Object.keys(OPTIMIZABLE_SKILLS).join(', ')})`);
    }
    const active = (await listVersions(db, skill.id)).find((v) => v.status === 'ACTIVE');
    if (!active) throw new HttpError(409, 'conflict', `la skill ${skill.name} no tiene versión ACTIVE (la base del optimizador)`);
    let config: OptimizerConfig;
    try {
      config = optimizerConfig(skill.name, {
        ...(body.datasetName ?? body.dataset_name ? { datasetName: (body.datasetName ?? body.dataset_name)! } : {}),
        ...(body.budget_eur !== undefined ? { experimentBudgetEur: body.budget_eur } : {}),
        ...(body.llm_budget_eur !== undefined ? { llmBudgetEur: body.llm_budget_eur } : {}),
        ...(body.repeat !== undefined ? { repeat: body.repeat } : {}),
        ...(body.min_labeled_validation !== undefined ? { minLabeledValidation: body.min_labeled_validation } : {}),
        ...(body.min_failures !== undefined ? { minFailures: body.min_failures } : {}),
        ...(body.today !== undefined ? { today: body.today } : {}),
        ...(ctx.config.geminiModel ? { model: ctx.config.geminiModel } : {}),
      });
    } catch (err) {
      throw new HttpError(400, 'invalid', err instanceof Error ? err.message : String(err));
    }
    if (!ctx.optimizerQueue) throw new HttpError(503, 'optimizer_unavailable', 'el optimizador no tiene cola en este proceso (rol api sin Redis)');
    const run = await createRun(db, { tenantId, skillName: skill.name, baseVersion: active.version, config: config as unknown as Record<string, unknown>, createdBy: body.created_by ?? null }).catch(toHttp);
    try {
      await ctx.optimizerQueue.enqueue({ tenantId, runId: run.id });
    } catch (err) {
      const closed = await transitionRun(db, run.id, 'ERROR', { error: `no se pudo encolar: ${err instanceof Error ? err.message : String(err)}` }, 'PENDING');
      throw new HttpError(503, 'queue_unavailable', 'no se pudo encolar el run (¿Redis?): queda en ERROR; repite la petición', { run: view(closed, false) });
    }
    return reply.status(202).send({ run: view(run, false) });
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
