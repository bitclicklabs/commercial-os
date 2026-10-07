import { z } from 'zod';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';

const ToolCallSpec = z.object({ tool: z.string().min(1), input: z.unknown().default({}) });
const ToolCallList = z.array(ToolCallSpec).min(1).max(20);
export type SmokeToolCall = z.infer<typeof ToolCallSpec>;

/**
 * Replaces `{ "$ref": "<callIndex>.<path>" }` placeholders with a value taken from
 * the output of an earlier call, e.g. `{ "$ref": "0.company.id" }`.
 */
export function resolveRefs(value: unknown, outputs: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, outputs));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === 'string' && Object.keys(obj).length === 1) {
      const [index, ...path] = obj.$ref.split('.');
      let current: unknown = outputs[Number(index)];
      for (const key of path) {
        current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
      }
      if (current === undefined) throw new Error(`Unresolved $ref: ${obj.$ref}`);
      return current;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, outputs)]));
  }
  return value;
}

/**
 * SmokeAgent (`configuration.implementation = "smoke"`): no LLM. Runs a fixed list of
 * REAL tool calls through the runtime's tool executor (allowlist, schemas, timeouts)
 * so the tool layer can be exercised end to end. The list comes from
 * `input.tool_calls` or, if absent, `configuration.smoke_tool_calls`.
 * Stops at the first failing call; the trace keeps every attempted call.
 */
export class SmokeAgent implements AgentImplementation {
  readonly kind = 'smoke';

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('SmokeAgent requires a tool executor');
    const calls = ToolCallList.parse(ctx.input.tool_calls ?? ctx.version.configuration.smoke_tool_calls);

    const steps: AgentStep[] = [
      {
        type: 'THINK',
        timestamp: new Date(),
        input: { input_keys: Object.keys(ctx.input) },
        output: { plan: calls.map((c) => c.tool), allowed_tools: ctx.tools.specs().map((s) => s.name) },
        latencyMs: 0,
      },
    ];

    const outputs: unknown[] = [];
    const results: Array<{ tool: string; status: string; output?: unknown; error?: unknown }> = [];
    let toolCost = 0;
    let failed = false;
    for (const call of calls) {
      ctx.signal.throwIfAborted();
      let input: unknown;
      try {
        input = resolveRefs(call.input, outputs);
      } catch (err) {
        results.push({ tool: call.tool, status: 'error', error: { code: 'UNRESOLVED_REF', message: (err as Error).message } });
        failed = true;
        break;
      }
      const outcome = await ctx.tools.call(call.tool, input);
      steps.push(outcome.step);
      toolCost += outcome.costEur;
      if (outcome.result.status === 'ok') {
        outputs.push(outcome.result.output);
        results.push({ tool: call.tool, status: 'ok', output: outcome.result.output });
      } else {
        results.push({ tool: call.tool, status: outcome.result.status, error: outcome.result });
        failed = true;
        break;
      }
    }

    const output = {
      status: failed ? 'error' : 'ok',
      agent: ctx.agent.name,
      agent_version: ctx.version.version,
      tool_results: results,
    };
    steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: 0 });
    return { output, steps, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, modelCost: 0, toolCost };
  }
}
