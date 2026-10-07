import { and, asc, desc, eq, gte, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { events } from '../db/schema.js';
import type { ApiContext } from '../api/context.js';
import { parse, tenantOf } from '../api/http.js';
import { envelopeFromRow } from './envelope.js';

export const ListEventsQuery = z.object({
  /** Exact type (`task.completed`) or prefix with a trailing wildcard (`task.*`). */
  type: z
    .string()
    .regex(/^[a-z_.]+(\.\*)?$/)
    .optional(),
  /** occurred_at >= since. */
  since: z.iso.datetime({ offset: true }).optional(),
  correlation_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  /** desc (default, newest first) or asc (polling with `since`). */
  order: z.enum(['asc', 'desc']).default('desc'),
});

function typeCondition(type: string | undefined) {
  if (!type) return undefined;
  if (type.endsWith('.*')) {
    const prefix = type.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`);
    return like(events.type, `${prefix}%`);
  }
  return eq(events.type, type);
}

export async function eventRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /** GET /events - domain events of the tenant (inspection). No write or delete routes. */
  app.get('/events', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListEventsQuery, req.query);
    const rows = await ctx.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          typeCondition(q.type),
          q.since ? gte(events.occurredAt, new Date(q.since)) : undefined,
          q.correlation_id ? eq(events.correlationId, q.correlation_id) : undefined,
        ),
      )
      .orderBy(q.order === 'asc' ? asc(events.occurredAt) : desc(events.occurredAt), q.order === 'asc' ? asc(events.createdAt) : desc(events.createdAt))
      .limit(q.limit);
    return {
      items: rows.map((r) => ({
        ...envelopeFromRow(r),
        source: r.source,
        dispatched_at: r.dispatchedAt?.toISOString() ?? null,
        dispatch_attempts: r.dispatchAttempts,
      })),
    };
  });
}
