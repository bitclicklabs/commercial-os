import { defaultCatalogService, type CatalogService } from '../integrations/catalog/index.js';
import { twentyClientFromEnv, type TwentyClient } from '../integrations/twenty/index.js';
import { createCatalogTools } from './catalog/catalog-tools.js';
import { ToolRegistry } from './registry.js';
import { createFindCompanyTool, createGetCompanyTool, createUpsertCompanyTool } from './twenty/company-tools.js';
import { createGetHypothesisTool, createRevertHypothesisDraftStatusTool, createSetHypothesisDraftTool } from './twenty/hypothesis-tools.js';
import { createCreateNoteTool, createGetNoteTool, createUpdateNoteTool } from './twenty/note-tools.js';
import { createCreateReplyTaskTool, createUpsertOpportunityTool, createUpsertPersonTool } from './twenty/crm-tools.js';
import { createCreateSignalNoteTool, createExpireSignalTool, createListEventSignalsTool } from './twenty/signal-tools.js';
import { createExpireHypothesisTool, createListHypothesesForExpiryTool } from './twenty/hypothesis-expiry-tools.js';
import { createCreateCrmTaskTool } from './twenty/task-tools.js';
import { createListSentHypothesesTool } from './twenty/followup-tools.js';
import {
  createCreateAgentRunSummaryTool,
  createCreateHypothesisTool,
  createCreateResearchTool,
  createCreateSignalTool,
} from './twenty/record-tools.js';
import { createFetchUrlTool, type FetchUrlDeps } from './web/fetch-url.js';
import { createRenderUrlTool, type RenderUrlDeps } from './web/render-url.js';
import { createFindContactTool, createSetHypothesisRecipientTool } from '../contact-finder/tools.js';
import { defaultEnrichService } from '../contact-finder/enrich/index.js';
import type { ContactFinderDeps } from '../contact-finder/finder.js';

export * from './types.js';
export * from './registry.js';
export * from './policy.js';
export * from './executor.js';
export * from './twenty/company-tools.js';
export * from './twenty/record-tools.js';
export * from './twenty/hypothesis-tools.js';
export * from './twenty/note-tools.js';
export * from './twenty/signal-tools.js';
export * from './twenty/hypothesis-expiry-tools.js';
export * from './twenty/task-tools.js';
export * from './twenty/crm-tools.js';
export * from './twenty/followup-tools.js';
export * from './web/fetch-url.js';
export * from './web/ip-guard.js';
export * from './web/html-text.js';
export * from './web/pdf-text.js';
export * from './web/render-url.js';
export * from './catalog/catalog-tools.js';

/** Registers the Twenty-backed MVP-0 tools on `registry`. */
export function registerTwentyTools(registry: ToolRegistry, twenty: TwentyClient): ToolRegistry {
  const deps = { twenty };
  registry.register(createFindCompanyTool(deps));
  registry.register(createGetCompanyTool(deps));
  registry.register(createUpsertCompanyTool(deps));
  registry.register(createCreateSignalTool(deps));
  registry.register(createCreateResearchTool(deps));
  registry.register(createCreateHypothesisTool(deps));
  registry.register(createCreateAgentRunSummaryTool(deps));
  registry.register(createGetHypothesisTool(deps));
  registry.register(createSetHypothesisDraftTool(deps));
  registry.register(createRevertHypothesisDraftStatusTool(deps));
  registry.register(createCreateNoteTool(deps));
  registry.register(createGetNoteTool(deps));
  registry.register(createUpdateNoteTool(deps));
  registry.register(createListEventSignalsTool(deps));
  registry.register(createExpireSignalTool(deps));
  // Lead-time window (tanda 18): note on a signal, hypothesis expiry.
  registry.register(createCreateSignalNoteTool(deps));
  registry.register(createListHypothesesForExpiryTool(deps));
  registry.register(createExpireHypothesisTool(deps));
  // Native tasks for actionable alerts + Person / Opportunity (tanda 19).
  registry.register(createCreateCrmTaskTool(deps));
  registry.register(createUpsertPersonTool(deps));
  registry.register(createUpsertOpportunityTool(deps));
  registry.register(createCreateReplyTaskTool(deps));
  // Lead follow-up (tanda 21): the SENT hypotheses, read only.
  registry.register(createListSentHypothesesTool(deps));
  return registry;
}

/**
 * Registers the web tools (`fetch_url`, `render_url`). Host allow/deny lists come from
 * FETCH_URL_* env vars; the renderer service from RENDERER_URL.
 */
export function registerWebTools(registry: ToolRegistry, deps: FetchUrlDeps = {}, render: RenderUrlDeps = {}): ToolRegistry {
  registry.register(createFetchUrlTool(deps));
  registry.register(createRenderUrlTool({ ...(deps.policy ? { policy: deps.policy } : {}), ...render }));
  return registry;
}

/**
 * Registers the five catalog tools (READ, contract v1.1). They are registered always but carry
 * `enabled = CATALOG_ENABLED`: with the catalog off the registry never resolves them for an agent.
 */
export function registerCatalogTools(registry: ToolRegistry, catalog: CatalogService): ToolRegistry {
  for (const tool of createCatalogTools({ catalog })) registry.register(tool);
  return registry;
}

/**
 * Registers the ContactFinder tools (`find_contact` READ, `set_hypothesis_recipient`
 * LOW_WRITE). The finder reuses the egress deps of `fetch_url` / `render_url`; the
 * enrichment service defaults to the process-wide one (ENRICH_* env, stub by default).
 */
export function registerContactTools(registry: ToolRegistry, twenty: TwentyClient, finder: ContactFinderDeps = {}): ToolRegistry {
  registry.register(createFindContactTool({ twenty, finder }));
  registry.register(createSetHypothesisRecipientTool({ twenty }));
  return registry;
}

/**
 * Registry with every MVP-0 tool implemented so far. The Twenty client is read from
 * TWENTY_BASE_URL / TWENTY_API_KEY; without a key the tools are still registered
 * and answer `TWENTY_NOT_CONFIGURED`. Agents only get the tools their `tool_policy`
 * allows (fetch_url / render_url are in no policy unless listed explicitly). The catalog
 * tools use the process-wide CatalogService (CATALOG_* env) unless one is injected.
 */
export function createDefaultToolRegistry(opts: { twenty?: TwentyClient; web?: FetchUrlDeps; render?: RenderUrlDeps; catalog?: CatalogService; contacts?: ContactFinderDeps } = {}): ToolRegistry {
  const registry = registerWebTools(registerTwentyTools(new ToolRegistry(), opts.twenty ?? twentyClientFromEnv()), opts.web, opts.render);
  // ContactFinder (tanda 17): same Twenty config and egress deps; enrichment = process-wide service.
  const contactDeps: ContactFinderDeps = { ...(opts.web ? { web: opts.web } : {}), ...(opts.render ? { render: opts.render } : {}), enrich: defaultEnrichService(), ...(opts.contacts ?? {}) };
  registerContactTools(registry, opts.twenty ?? twentyClientFromEnv(), contactDeps);
  return registerCatalogTools(registry, opts.catalog ?? defaultCatalogService());
}
