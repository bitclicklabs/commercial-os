import { twentyClientFromEnv, type TwentyClient } from '../integrations/twenty/index.js';
import { ToolRegistry } from './registry.js';
import { createFindCompanyTool, createGetCompanyTool, createUpsertCompanyTool } from './twenty/company-tools.js';
import {
  createCreateAgentRunSummaryTool,
  createCreateHypothesisTool,
  createCreateResearchTool,
  createCreateSignalTool,
} from './twenty/record-tools.js';

export * from './types.js';
export * from './registry.js';
export * from './policy.js';
export * from './executor.js';
export * from './twenty/company-tools.js';
export * from './twenty/record-tools.js';

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
  return registry;
}

/**
 * Registry with every MVP-0 tool implemented so far. The Twenty client is read from
 * TWENTY_BASE_URL / TWENTY_API_KEY; without a key the tools are still registered
 * and answer `TWENTY_NOT_CONFIGURED`.
 */
export function createDefaultToolRegistry(opts: { twenty?: TwentyClient } = {}): ToolRegistry {
  return registerTwentyTools(new ToolRegistry(), opts.twenty ?? twentyClientFromEnv());
}
