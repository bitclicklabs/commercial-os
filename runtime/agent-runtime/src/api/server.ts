import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { sql } from 'drizzle-orm';
import type { ApiContext } from './context.js';
import { installErrorHandler } from './http.js';
import { agentRoutes } from './routes/agents.js';
import { executionRoutes } from './routes/executions.js';
import { taskRoutes } from './routes/tasks.js';
import { schedulerRoutes } from '../scheduler/routes.js';
import { eventRoutes } from '../events/routes.js';
import { externalEventRoutes } from '../events/external-routes.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { metricsRoutes } from './routes/metrics.js';
import { skillRoutes } from './routes/skills.js';
import { harnessRoutes } from './routes/harnesses.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { datasetRoutes } from './routes/datasets.js';
import { experimentRoutes } from './routes/experiments.js';
import { optimizerRoutes } from './routes/optimizer.js';
import { auditRoutes } from './routes/audit.js';
import { traceRoutes } from './routes/traces.js';
import { catalogRoutes } from './routes/catalog.js';
import { contactRoutes } from './routes/contacts.js';
import { installAuditHook } from '../audit/hook.js';

export async function buildServer(
  ctx: ApiContext,
  options: FastifyServerOptions = { logger: false },
): Promise<FastifyInstance> {
  const app = Fastify(options);
  installErrorHandler(app);
  // audit_log of the administrative routes (src/audit/catalog.ts); before any route is registered.
  installAuditHook(app, ctx);

  app.get('/health', async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });

  await agentRoutes(app, ctx);
  await taskRoutes(app, ctx);
  await executionRoutes(app, ctx);
  await schedulerRoutes(app, ctx);
  await eventRoutes(app, ctx);
  await externalEventRoutes(app, ctx);
  await evaluationRoutes(app, ctx);
  await metricsRoutes(app, ctx);
  await skillRoutes(app, ctx);
  await harnessRoutes(app, ctx);
  await knowledgeRoutes(app, ctx);
  await datasetRoutes(app, ctx);
  await experimentRoutes(app, ctx);
  await optimizerRoutes(app, ctx);
  await auditRoutes(app, ctx);
  await traceRoutes(app, ctx);
  await catalogRoutes(app, ctx);
  await contactRoutes(app, ctx);
  return app;
}
