import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { sql } from 'drizzle-orm';
import type { ApiContext } from './context.js';
import { installErrorHandler } from './http.js';
import { agentRoutes } from './routes/agents.js';
import { executionRoutes } from './routes/executions.js';
import { taskRoutes } from './routes/tasks.js';
import { schedulerRoutes } from '../scheduler/routes.js';

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
  return app;
}
