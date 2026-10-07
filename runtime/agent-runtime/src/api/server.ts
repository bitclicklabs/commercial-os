import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { sql } from 'drizzle-orm';
import type { ApiContext } from './context.js';
import { installErrorHandler } from './http.js';
import { agentRoutes } from './routes/agents.js';
import { executionRoutes } from './routes/executions.js';
import { taskRoutes } from './routes/tasks.js';
import { schedulerRoutes } from '../scheduler/routes.js';
import { eventRoutes } from '../events/routes.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { metricsRoutes } from './routes/metrics.js';
import { skillRoutes } from './routes/skills.js';

export async function buildServer(
  ctx: ApiContext,
  options: FastifyServerOptions = { logger: false },
): Promise<FastifyInstance> {
  const app = Fastify(options);
  installErrorHandler(app);

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
  await evaluationRoutes(app, ctx);
  await metricsRoutes(app, ctx);
  await skillRoutes(app, ctx);
  return app;
}
