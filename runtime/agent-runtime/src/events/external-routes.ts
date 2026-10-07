/**
 * HTTP side of the external event bridge (LLD v0.1 section 20):
 *
 * - POST /events/external              ingestion (bearer token, see external.ts)
 * - POST /event-subscriptions          create an outbound webhook (201; returns the secret
 *                                      once if the runtime generated it)
 * - GET  /event-subscriptions[/:id]    list / read (the secret is never returned)
 * - PATCH /event-subscriptions/:id     change name, URL, types, secret or `enabled`
 *
 * There is no DELETE: `enabled = false` switches a subscription off (section 22).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../api/context.js';
import { conflict, HttpError, IdParams, notFound, parse, tenantOf } from '../api/http.js';
import { eventSubscriptions, type EventSubscription } from '../db/schema.js';
import {
  authenticateExternalRequest,
  DEFAULT_EXTERNAL_EVENT_TYPE_PREFIXES,
  EXTERNAL_BODY_LIMIT_BYTES,
  externalEventBodySchema,
  externalPublishInput,
} from './external.js';
import { generateSubscriptionSecret, isValidEventTypePattern, MAX_EVENT_TYPE_PATTERNS, secretHint } from './subscriptions.js';
import { checkWebhookTarget, MAX_TARGET_URL_LENGTH } from './webhook-target.js';

const EventTypePatterns = z
  .array(
    z.string().refine(isValidEventTypePattern, { message: 'expected an event type (task.completed) or a prefix pattern (task.*)' }),
  )
  .min(1)
  .max(MAX_EVENT_TYPE_PATTERNS)
  .transform((list) => [...new Set(list)]);

const Secret = z.string().min(16).max(512);

export const CreateEventSubscriptionBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    target_url: z.string().min(1).max(MAX_TARGET_URL_LENGTH),
    /** Omitted = the runtime generates one (64 hex chars) and returns it once. */
    secret: Secret.optional(),
    event_types: EventTypePatterns,
    enabled: z.boolean().default(true),
  })
  .strict();

export const PatchEventSubscriptionBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    target_url: z.string().min(1).max(MAX_TARGET_URL_LENGTH),
    secret: Secret,
    /** true = the runtime generates a new secret and returns it once. */
    rotate_secret: z.literal(true),
    event_types: EventTypePatterns,
    enabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' })
  .refine((b) => !(b.secret && b.rotate_secret), { message: 'use either secret or rotate_secret' });

export const ListEventSubscriptionsQuery = z.object({
  enabled: z.enum(['true', 'false']).optional(),
});

/** Public view of a subscription: never the secret, only a hint. */
export function serializeSubscription(row: EventSubscription, extra: { secret?: string } = {}): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    name: row.name,
    target_url: row.targetUrl,
    event_types: row.eventTypes,
    enabled: row.enabled,
    secret_hint: secretHint(row.secret),
    ...(extra.secret ? { secret: extra.secret } : {}),
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    last_error: row.lastError,
    last_error_at: row.lastErrorAt?.toISOString() ?? null,
    consecutive_failures: row.consecutiveFailures,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function externalEventRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;
  const prefixes = ctx.config.externalEventTypePrefixes ?? [...DEFAULT_EXTERNAL_EVENT_TYPE_PREFIXES];
  const bodySchema = externalEventBodySchema(prefixes);
  const allowPrivate = ctx.config.externalWebhookAllowPrivate ?? [];

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------
  app.post(
    '/events/external',
    {
      bodyLimit: EXTERNAL_BODY_LIMIT_BYTES,
      // Before the body is parsed: an unauthenticated request never reaches the parser.
      onRequest: async (req, reply) => {
        const auth = authenticateExternalRequest(req.headers.authorization, ctx.config.externalEventsToken);
        if (auth.ok) return;
        if (auth.status === 503) {
          reply.code(503).send({ error: 'external_events_not_configured', message: auth.reason });
        } else {
          req.log.warn({ reason: auth.reason }, 'external event rejected');
          reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: 'invalid or missing bearer token' });
        }
        return reply;
      },
    },
    async (req, reply) => {
      if (!ctx.events) throw new HttpError(503, 'event_bus_not_configured', 'the event bus is not wired in this process');
      const tenantId = tenantOf(req, ctx.config.defaultTenantId);
      const body = parse(bodySchema, req.body);
      const result = await ctx.events.publish(externalPublishInput(body, { tenantId, fallbackCorrelationId: `ext-${randomUUID()}` }));
      req.log.info({ eventId: result.event.id, type: result.event.type, producer: result.event.producer, created: result.created }, 'external event accepted');
      return reply.status(result.created ? 202 : 200).send({ event: result.event, created: result.created, dispatched: result.dispatched });
    },
  );

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------
  async function loadSubscription(tenantId: string, id: string): Promise<EventSubscription> {
    const row = await db.query.eventSubscriptions.findFirst({
      where: and(eq(eventSubscriptions.tenantId, tenantId), eq(eventSubscriptions.id, id)),
    });
    if (!row) throw notFound('event subscription');
    return row;
  }

  async function assertTarget(url: string): Promise<void> {
    const verdict = await checkWebhookTarget(url, { allowPrivate, requireResolution: false });
    if (!verdict.ok) throw new HttpError(400, 'invalid_target_url', verdict.reason);
  }

  async function assertNameFree(tenantId: string, name: string, exceptId?: string): Promise<void> {
    const existing = await db.query.eventSubscriptions.findFirst({
      where: and(eq(eventSubscriptions.tenantId, tenantId), eq(eventSubscriptions.name, name)),
    });
    if (existing && existing.id !== exceptId) throw conflict(`event subscription "${name}" already exists`, { subscription_id: existing.id });
  }

  app.post('/event-subscriptions', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(CreateEventSubscriptionBody, req.body);
    await assertTarget(body.target_url);
    await assertNameFree(tenantId, body.name);
    const generated = body.secret ? undefined : generateSubscriptionSecret();
    const [row] = await db
      .insert(eventSubscriptions)
      .values({
        tenantId,
        name: body.name,
        targetUrl: body.target_url,
        secret: body.secret ?? generated!,
        eventTypes: body.event_types,
        enabled: body.enabled,
      })
      .returning();
    if (!row) throw new Error('insert event subscription failed');
    return reply.status(201).send({ subscription: serializeSubscription(row, generated ? { secret: generated } : {}) });
  });

  app.get('/event-subscriptions', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListEventSubscriptionsQuery, req.query);
    const rows = await db
      .select()
      .from(eventSubscriptions)
      .where(and(eq(eventSubscriptions.tenantId, tenantId), q.enabled ? eq(eventSubscriptions.enabled, q.enabled === 'true') : undefined))
      .orderBy(asc(eventSubscriptions.createdAt));
    return { items: rows.map((r) => serializeSubscription(r)) };
  });

  app.get('/event-subscriptions/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    return { subscription: serializeSubscription(await loadSubscription(tenantId, id)) };
  });

  app.patch('/event-subscriptions/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const body = parse(PatchEventSubscriptionBody, req.body);
    const current = await loadSubscription(tenantId, id);
    if (body.target_url !== undefined && body.target_url !== current.targetUrl) await assertTarget(body.target_url);
    if (body.name !== undefined && body.name !== current.name) await assertNameFree(tenantId, body.name, id);
    const generated = body.rotate_secret ? generateSubscriptionSecret() : undefined;
    const [row] = await db
      .update(eventSubscriptions)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.target_url !== undefined ? { targetUrl: body.target_url } : {}),
        ...(body.secret !== undefined ? { secret: body.secret } : {}),
        ...(generated ? { secret: generated } : {}),
        ...(body.event_types !== undefined ? { eventTypes: body.event_types } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(eventSubscriptions.tenantId, tenantId), eq(eventSubscriptions.id, id)))
      .returning();
    if (!row) throw notFound('event subscription');
    return { subscription: serializeSubscription(row, generated ? { secret: generated } : {}) };
  });
}
