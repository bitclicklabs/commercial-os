/**
 * Catalog API (read only, for the runbook; docs/catalog-service.md):
 * - GET /catalog/health[?fresh=true] - what the runtime sees of the catalog connector: whether it
 *   is enabled, the provider (stub | http), and the gate's last /health answer (cached 60 s;
 *   `fresh=true` probes again). 200 when available or disabled, 503 when enabled but unavailable.
 *   The token is never echoed. No mutating route exists for the catalog.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATALOG_CONTRACT_VERSION, defaultCatalogService } from '../../integrations/catalog/index.js';
import type { ApiContext } from '../context.js';
import { parse } from '../http.js';

const HealthQuery = z.object({ fresh: z.stringbool().default(false) });

export async function catalogRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get('/catalog/health', async (req, reply) => {
    const q = parse(HealthQuery, req.query);
    const catalog = ctx.catalog ?? defaultCatalogService();
    if (q.fresh) catalog.resetHealth();
    const availability = await catalog.availability();
    const body = {
      enabled: catalog.enabled,
      provider: catalog.provider,
      client_contract_version: CATALOG_CONTRACT_VERSION,
      availability,
    };
    return reply.status(catalog.enabled && !availability.available ? 503 : 200).send(body);
  });
}
