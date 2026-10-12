/**
 * Contacts API (tanda 17, ContactFinder):
 * - POST /contacts/backfill `{ limit?, force?, dry_run? }` - queues one ContactFinder run per
 *   VALIDATED hypothesis of the tenant (`x-tenant-id`) whose `emailTo` is empty
 *   (src/contact-finder/backfill.ts). 202 with what was queued and what was skipped and why.
 *   Audited (`contact.backfill`, src/audit/catalog.ts). Same as `pnpm contacts:backfill`.
 *   503 when Twenty is not configured; 409 when the task `find-contact` is not seeded or is off.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BACKFILL_DEFAULT_LIMIT, BACKFILL_MAX_LIMIT, BackfillError, runContactBackfill } from '../../contact-finder/backfill.js';
import type { ApiContext } from '../context.js';
import { HttpError, parse, tenantOf } from '../http.js';

const BackfillBody = z
  .object({
    limit: z.number().int().min(1).max(BACKFILL_MAX_LIMIT).default(BACKFILL_DEFAULT_LIMIT),
    force: z.boolean().default(false),
    dry_run: z.boolean().default(false),
  })
  .strict();

export async function contactRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.post('/contacts/backfill', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(BackfillBody, req.body ?? {});
    if (!ctx.twenty || !ctx.twenty.isConfigured()) throw new HttpError(503, 'twenty_not_configured', 'Twenty no está configurado: no se pueden leer las hipótesis');
    try {
      const result = await runContactBackfill(
        { db: ctx.db, queue: ctx.queue, twenty: ctx.twenty, ...(ctx.events ? { events: ctx.events } : {}) },
        { tenantId, limit: body.limit, force: body.force, dryRun: body.dry_run },
      );
      return reply.status(body.dry_run ? 200 : 202).send({ backfill: result });
    } catch (err) {
      if (err instanceof BackfillError) {
        throw new HttpError(err.code === 'TWENTY_NOT_CONFIGURED' ? 503 : 409, err.code.toLowerCase(), err.message);
      }
      throw err;
    }
  });
}
