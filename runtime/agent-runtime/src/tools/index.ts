import { twentyClientFromEnv, type TwentyClient } from '../integrations/twenty/index.js';
import { ToolRegistry } from './registry.js';
import { createFindCompanyTool, createGetCompanyTool, createUpsertCompanyTool } from './twenty/company-tools.js';
import { createGetHypothesisTool } from './twenty/hypothesis-tools.js';
import { createCreateNoteTool, createGetNoteTool, createUpdateNoteTool } from './twenty/note-tools.js';
import {
  createCreateAgentRunSummaryTool,
  createCreateHypothesisTool,
  createCreateResearchTool,
  createCreateSignalTool,
} from './twenty/record-tools.js';
import { createFetchUrlTool, type FetchUrlDeps } from './web/fetch-url.js';
import { createRenderUrlTool, type RenderUrlDeps } from './web/render-url.js';

export * from './types.js';
export * from './registry.js';
export * from './policy.js';
export * from './executor.js';
export * from './twenty/company-tools.js';
export * from './twenty/record-tools.js';
export * from './twenty/hypothesis-tools.js';
export * from './twenty/note-tools.js';
export * from './web/fetch-url.js';
export * from './web/ip-guard.js';
export * from './web/html-text.js';
export * from './web/pdf-text.js';
export * from './web/render-url.js';

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
  registry.register(createCreateNoteTool(deps));
  registry.register(createGetNoteTool(deps));
  registry.register(createUpdateNoteTool(deps));
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
 * Registry with every MVP-0 tool implemented so far. The Twenty client is read from
 * TWENTY_BASE_URL / TWENTY_API_KEY; without a key the tools are still registered
 * and answer `TWENTY_NOT_CONFIGURED`. Agents only get the tools their `tool_policy`
 * allows (fetch_url / render_url are in no policy unless listed explicitly).
 */
export function createDefaultToolRegistry(opts: { twenty?: TwentyClient; web?: FetchUrlDeps; render?: RenderUrlDeps } = {}): ToolRegistry {
  return registerWebTools(registerTwentyTools(new ToolRegistry(), opts.twenty ?? twentyClientFromEnv()), opts.web, opts.render);
}
