import type { AgentStep } from '../agents/agent.js';
import type { ToolRegistry } from './registry.js';
import { riskRank, toToolSpec, type AgentToolPolicy, type AnyTool, type ToolContext, type ToolLogger, type ToolResult, type ToolSpec } from './types.js';

export interface ToolExecutionScope {
  tenantId: string;
  executionId: string;
  agentId: string;
  stage: string | null;
  logger?: ToolLogger;
}

export interface ToolCallOutcome {
  result: ToolResult<unknown>;
  /** TOOL trace step, ready to be appended to the agent's steps. */
  step: AgentStep;
  costEur: number;
}

/** What an agent sees: call a tool by id and list the tools its policy allows. */
export interface AgentToolbox {
  call(toolId: string, input: unknown): Promise<ToolCallOutcome>;
  specs(): ToolSpec[];
}

class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`Tool timed out after ${ms} ms`);
    this.name = 'ToolTimeoutError';
  }
}

const noopLogger: ToolLogger = { info() {}, error() {} };

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Per-execution tool executor (the TOOL POLICY + EXECUTOR phases of the harness,
 * LLD v0.2 section 5.4). Enforces, in order:
 *
 * 1. allowlist (`TOOL_NOT_ALLOWED`), registration (`TOOL_NOT_FOUND`), `enabled` (`TOOL_DISABLED`),
 *    risk ceiling and the DESTRUCTIVE ban (`TOOL_NOT_ALLOWED`);
 * 2. call limits per execution and per tool (`TOOL_CALL_LIMIT`);
 * 3. input validation against `inputSchema` (`INVALID_INPUT`);
 * 4. timeout (`TOOL_TIMEOUT`) combined with the execution's AbortSignal;
 * 5. output validation against `outputSchema` (`INVALID_OUTPUT`).
 *
 * Every call, including rejections, yields a TOOL trace step.
 */
export class ToolExecutor implements AgentToolbox {
  private totalCalls = 0;
  private readonly callsPerTool = new Map<string, number>();
  private readonly logger: ToolLogger;

  constructor(
    private readonly registry: ToolRegistry,
    readonly policy: AgentToolPolicy,
    private readonly scope: ToolExecutionScope,
    private readonly signal: AbortSignal,
  ) {
    this.logger = scope.logger ?? noopLogger;
  }

  specs(): ToolSpec[] {
    return this.registry.resolve(this.policy).map(toToolSpec);
  }

  get callCount(): number {
    return this.totalCalls;
  }

  async call(toolId: string, input: unknown): Promise<ToolCallOutcome> {
    this.signal.throwIfAborted();
    const startedAt = Date.now();
    const timestamp = new Date();
    const tool = this.registry.get(toolId);

    const rejection = this.checkPolicy(toolId, tool);
    if (rejection) return this.finish(toolId, tool, input, rejection, timestamp, startedAt, null);

    // Past this point `tool` is defined (checkPolicy rejects otherwise).
    const t = tool as AnyTool;
    const perTool = this.callsPerTool.get(toolId) ?? 0;
    this.totalCalls += 1;
    this.callsPerTool.set(toolId, perTool + 1);
    const idempotencyKey = `tool:${this.scope.executionId}:${toolId}:${this.totalCalls}`;

    const parsedInput = t.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return this.finish(toolId, t, input, { status: 'error', code: 'INVALID_INPUT', message: zodIssues(parsedInput.error), retryable: false }, timestamp, startedAt, idempotencyKey);
    }

    const controller = new AbortController();
    const onParentAbort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', onParentAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let result: ToolResult<unknown>;
    try {
      const ctx: ToolContext = {
        tenantId: this.scope.tenantId,
        executionId: this.scope.executionId,
        agentId: this.scope.agentId,
        stage: this.scope.stage,
        idempotencyKey,
        signal: controller.signal,
        logger: this.logger,
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Reject before aborting so the timeout wins the race against a tool that settles on abort.
          reject(new ToolTimeoutError(t.timeoutMs));
          controller.abort();
        }, t.timeoutMs);
      });
      result = await Promise.race([t.execute(parsedInput.data, ctx), timeout]);
    } catch (err) {
      // The execution itself was cancelled / timed out: propagate.
      if (this.signal.aborted) throw err;
      result =
        err instanceof ToolTimeoutError
          ? { status: 'error', code: 'TOOL_TIMEOUT', message: err.message, retryable: true }
          : { status: 'error', code: 'TOOL_ERROR', message: err instanceof Error ? err.message : String(err), retryable: false };
    } finally {
      if (timer) clearTimeout(timer);
      this.signal.removeEventListener('abort', onParentAbort);
    }

    if (result.status === 'ok') {
      const parsedOutput = t.outputSchema.safeParse(result.output);
      if (!parsedOutput.success) {
        result = { status: 'error', code: 'INVALID_OUTPUT', message: zodIssues(parsedOutput.error), retryable: false };
      } else {
        result = { ...result, output: parsedOutput.data };
      }
    }
    if (result.status === 'error') this.logger.error('tool call failed', { tool: toolId, code: result.code });
    return this.finish(toolId, t, parsedInput.data, result, timestamp, startedAt, idempotencyKey);
  }

  private checkPolicy(toolId: string, tool: AnyTool | undefined): ToolResult<never> | null {
    const deny = (code: string, message: string): ToolResult<never> => ({ status: 'error', code, message, retryable: false });
    if (!this.policy.allow.includes(toolId)) return deny('TOOL_NOT_ALLOWED', `Tool ${toolId} is not in the agent allowlist`);
    if (!tool) return deny('TOOL_NOT_FOUND', `Tool ${toolId} is not registered`);
    if (tool.riskLevel === 'DESTRUCTIVE') return deny('TOOL_NOT_ALLOWED', `DESTRUCTIVE tool ${toolId} is never executed autonomously`);
    if (!tool.enabled) return deny('TOOL_DISABLED', `Tool ${toolId} is disabled`);
    if (riskRank(tool.riskLevel) > riskRank(this.policy.maxRiskLevel)) {
      return deny('TOOL_NOT_ALLOWED', `Tool ${toolId} (${tool.riskLevel}) exceeds the agent risk ceiling ${this.policy.maxRiskLevel}`);
    }
    if (this.totalCalls >= this.policy.maxCallsPerExecution) {
      return deny('TOOL_CALL_LIMIT', `maxCallsPerExecution (${this.policy.maxCallsPerExecution}) reached`);
    }
    const perToolLimit = this.policy.maxCallsPerTool?.[toolId];
    if (perToolLimit !== undefined && (this.callsPerTool.get(toolId) ?? 0) >= perToolLimit) {
      return deny('TOOL_CALL_LIMIT', `maxCallsPerTool for ${toolId} (${perToolLimit}) reached`);
    }
    return null;
  }

  private finish(
    toolId: string,
    tool: AnyTool | undefined,
    input: unknown,
    result: ToolResult<unknown>,
    timestamp: Date,
    startedAt: number,
    idempotencyKey: string | null,
  ): ToolCallOutcome {
    const costEur = result.status === 'ok' ? (result.costEur ?? 0) : 0;
    const step: AgentStep = {
      type: 'TOOL',
      timestamp,
      tool: toolId,
      toolInput: input,
      toolOutput: result.status === 'ok' ? result.output : result.status === 'approval_required' ? result : null,
      output: {
        status: result.status,
        riskLevel: tool?.riskLevel ?? null,
        sourceTrust: tool?.outputTrust ?? null,
        toolVersion: tool?.version ?? null,
        idempotencyKey,
      },
      latencyMs: Date.now() - startedAt,
      ...(result.status === 'error'
        ? { error: { code: result.code, message: result.message, retryable: result.retryable } }
        : {}),
    };
    return { result, step, costEur };
  }
}
