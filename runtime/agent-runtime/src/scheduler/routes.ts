import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { taskDefinitions } from '../db/schema.js';
import type { ApiContext } from '../api/context.js';
import { HttpError, IdParams, notFound, parse, tenantOf } from '../api/http.js';
import type { ScheduleSpec } from '../db/schema.js';
import { parseSchedule, ScheduleValidationError } from './schedule.js';

const schedulerUnavailable = () =>
  new HttpError(503, 'scheduler_unavailable', 'scheduler is not configured in this process');

/** Rejects malformed time-based schedules with 400 (used by POST/PATCH /tasks). */
export function assertValidSchedule(schedule: ScheduleSpec | undefined, timezone: string | undefined): void {
  if (!schedule) return;
  try {
    parseSchedule(schedule, timezone);
  } catch (err) {
    if (err instanceof ScheduleValidationError) throw new HttpError(400, 'invalid_schedule', err.message);
    throw err;
  }
}

export async function schedulerRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /** GET /tasks/:id/schedule - desired vs registered schedule and the next fire times. */
  app.get('/tasks/:id/schedule', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const task = await ctx.db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.id, id)),
    });
    if (!task) throw notFound('task');
    if (!ctx.scheduler) throw schedulerUnavailable();
    return ctx.scheduler.describeTask(task);
  });

  /** GET /scheduler/status - registered job schedulers / one-shot jobs of the tenant. */
  app.get('/scheduler/status', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    if (!ctx.scheduler) throw schedulerUnavailable();
    return { tenant_id: tenantId, ...(await ctx.scheduler.status(tenantId)) };
  });
}
