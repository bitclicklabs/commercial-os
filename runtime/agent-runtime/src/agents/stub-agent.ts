import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';
import { ProspectorAgent } from './prospector-agent.js';
import { SmokeAgent } from './smoke-agent.js';

/**
 * StubAgent: no LLM reasoning. Emits a fixed THINK -> TOOL -> FINAL trace and a
 * fixed result. The FINAL step goes through the configured ModelProvider so the
 * provider plumbing (tokens / cost accounting) is exercised end to end; with the
 * StubProvider everything is zero.
 */
export class StubAgent implements AgentImplementation {
  readonly kind = 'stub';

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    const steps: AgentStep[] = [];

    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      input: { input_keys: Object.keys(ctx.input) },
      output: { plan: ['lookup_context', 'compose_answer'] },
      latencyMs: 0,
    });

    const toolInput = { query: String(ctx.input.query ?? ctx.agent.name) };
    steps.push({
      type: 'TOOL',
      timestamp: new Date(),
      tool: 'stub.lookup',
      toolInput,
      toolOutput: { hits: 0, source_content: 'untrusted', note: 'simulated tool call' },
      latencyMs: 0,
    });

    ctx.signal.throwIfAborted();
    const completion = await ctx.provider.complete({
      model: ctx.version.model,
      system: ctx.version.systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(ctx.input) }],
      signal: ctx.signal,
    });

    const output = {
      status: 'ok',
      agent: ctx.agent.name,
      agent_version: ctx.version.version,
      summary: completion.text,
      echo: ctx.input,
    };

    steps.push({
      type: 'FINAL',
      timestamp: new Date(),
      model: completion.model,
      usage: completion.usage,
      output,
      latencyMs: completion.latencyMs,
    });

    return {
      output,
      steps,
      usage: completion.usage,
      modelCost: completion.cost.modelCost,
      toolCost: 0,
    };
  }
}

export function resolveAgentImplementation(configuration: Record<string, unknown>): AgentImplementation {
  const kind = typeof configuration.implementation === 'string' ? configuration.implementation : 'stub';
  switch (kind) {
    case 'stub':
      return new StubAgent();
    case 'smoke':
      return new SmokeAgent();
    case 'prospector':
      return new ProspectorAgent();
    default:
      throw new Error(`Unknown agent implementation: ${kind}`);
  }
}
