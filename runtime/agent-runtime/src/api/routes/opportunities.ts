/**
 * Opportunities API (tanda 19, native Twenty Opportunity):
 * - POST /opportunities/promote `{ hypothesis_id, by? }` - a person promotes a hypothesis of the
 *   tenant (`x-tenant-id`) to an Opportunity in Twenty: company of the hypothesis, point of
 *   contact = its decision maker or the Person of its `emailTo` (only a personal mailbox; a
 *   generic one gives no point of contact), first stage of the pipeline, no amount. Idempotent
 *   per company: an OPEN opportunity of the company is reused (200), a new one is 201 and emits
 *   `opportunity.created` (`origin: 'manual'`). Audited as `opportunity.promote`.
 *   404 unknown hypothesis, 409 REJECTED / without company, 503 Twenty not configured,
 *   502 Twenty error.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { opportunityCreatedEvent } from '../../crm/opportunities.js';
import { PromotionError, promoteHypothesis } from '../../crm/promote.js';
import { TwentyApiError } from '../../integrations/twenty/index.js';
import type { ApiContext } from '../context.js';
import { HttpError, parse, tenantOf } from '../http.js';

const PromoteBody = z
  .object({
    hypothesis_id: z.guid(),
    /** Free label of who promotes (audit `actor_label`), not authenticated. */
    by: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const PROMOTION_STATUS: Record<PromotionError['code'], number> = {
  HYPOTHESIS_NOT_FOUND: 404,
  HYPOTHESIS_REJECTED: 409,
  HYPOTHESIS_WITHOUT_COMPANY: 409,
  COMPANY_NOT_FOUND: 409,
};

export async function opportunityRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.post('/opportunities/promote', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(PromoteBody, req.body ?? {});
    if (!ctx.twenty || !ctx.twenty.isConfigured()) throw new HttpError(503, 'twenty_not_configured', 'Twenty no está configurado: no se puede crear la oportunidad');
    let result;
    try {
      result = await promoteHypothesis(ctx.twenty, { tenantId, hypothesisId: body.hypothesis_id });
    } catch (err) {
      if (err instanceof PromotionError) throw new HttpError(PROMOTION_STATUS[err.code], err.code.toLowerCase(), err.message);
      if (err instanceof TwentyApiError) {
        if (err.code === 'TWENTY_TENANT_MISMATCH') throw new HttpError(404, 'hypothesis_not_found', `hypothesis ${body.hypothesis_id} does not exist`);
        throw new HttpError(502, 'twenty_error', `${err.code}: ${err.message}`);
      }
      throw err;
    }
    let eventId: string | null = null;
    if (result.created && ctx.events) {
      const published = await ctx.events.emit(
        opportunityCreatedEvent({ tenantId, opportunity: result.opportunity, origin: 'manual', hypothesisId: result.hypothesisId, personId: result.pointOfContactId }),
      );
      eventId = published?.event.id ?? null;
    }
    return reply.status(result.created ? 201 : 200).send({
      opportunity: {
        id: result.opportunity.id,
        name: result.opportunity.name,
        stage: result.opportunity.stage,
        created: result.created,
        stage_source: result.stageSource,
        fair: result.fair,
        company_id: result.opportunity.companyId,
        point_of_contact_id: result.opportunity.pointOfContactId,
        filled: result.filled,
      },
      hypothesis_id: result.hypothesisId,
      contact_from: result.contactFrom,
      person: result.person ? { outcome: result.person.outcome, reason: result.person.reason, id: result.person.person?.id ?? null } : null,
      event_id: eventId,
    });
  });
}
