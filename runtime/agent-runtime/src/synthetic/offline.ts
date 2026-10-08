/**
 * Synthetic cases never touch the network: the "exhibitor web" is embedded in the case
 * (`exhibitor.description`) and every domain is `.invalid`. The experiment runner wraps the
 * toolbox of a fixture with synthetic cases in `offlineToolbox`, which refuses the web tools
 * before they run (the direct-mode Prospector does not call them today; this keeps it true if
 * that ever changes). The CRM tools stay: the runner injects an in-memory CRM (FakeTwenty), and
 * the Twenty client refuses `.invalid` domains towards a real CRM anyway.
 */
import type { AgentToolbox, ToolCallOutcome } from '../tools/executor.js';
import type { ToolSpec } from '../tools/types.js';

/** Tools that read the open web. */
export const NETWORK_TOOLS: readonly string[] = ['fetch_url', 'render_url'];

export const SYNTHETIC_OFFLINE_CODE = 'SYNTHETIC_OFFLINE';

export function offlineToolbox(inner: AgentToolbox): AgentToolbox & { refused: string[] } {
  const refused: string[] = [];
  return {
    refused,
    specs: (): ToolSpec[] => inner.specs().filter((s) => !NETWORK_TOOLS.includes(s.name)),
    async call(toolId: string, input: unknown): Promise<ToolCallOutcome> {
      if (!NETWORK_TOOLS.includes(toolId)) return inner.call(toolId, input);
      refused.push(toolId);
      const message = `${toolId} no está disponible en un caso sintético: el contenido del expositor va embebido en el caso`;
      return {
        result: { status: 'error', code: SYNTHETIC_OFFLINE_CODE, message, retryable: false },
        step: { type: 'TOOL', timestamp: new Date(), tool: toolId, toolInput: input, error: { code: SYNTHETIC_OFFLINE_CODE, message }, latencyMs: 0 },
        costEur: 0,
      };
    },
  };
}
