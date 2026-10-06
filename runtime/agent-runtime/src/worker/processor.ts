import { and, eq, inArray, sql } from 'drizzle-orm';
import { resolveAgentImplementation } from '../agents/stub-agent.js';
import type { AgentResult } from '../agents/agent.js';
import type { Db } from '../db/client.js';
import {
  agentExecutions,
  agents,
  agentVersions,
  taskDefinitions,
  taskRuns,
  traceSteps,
  traces,
  type Agent,
  type AgentExecution,
  type AgentVersion,
} from '../db/schema.js';
import { allowedSources } from '../domain/run-state.js';
import type { RunStatus } from '../domain/statuses.js';
import type { ProviderFactory } from '../providers/index.js';
import type { RunJob } from '../queue/run-queue.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor, type ToolRegistry } from '../tools/index.js';

export interface ProcessorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silentLogger: ProcessorLogger = { info() {}, warn() {}, error() {} };

export interface AttemptInfo {
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
}

/** Thrown to ask the queue to retry (BullMQ re-runs the job with backoff). */
export class RetryableRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRunError';
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Execution timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

interface Outcome {
  status: Extract<RunStatus, 'COMPLETED' | 'FAILED' | 'TIMED_OUT'>;
  result?: AgentResult;
  error?: Record<string, unknown>;
  latencyMs: number;
}

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

export class RunProcessor {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderFactory,
    private readonly logger: ProcessorLogger = silentLogger,
    /** Tool registry; defaults to the MVP-0 tools with the Twenty client from env. */
    private readonly tools: ToolRegistry = createDefaultToolRegistry(),
  ) {}

  async process(job: RunJob, attempt: AttemptInfo = { attempt: 1, maxAttempts: 1 }): Promise<void> {
    if (job.kind === 'task_run') await this.processTaskRun(job.tenantId, job.taskRunId, attempt);
    else await this.processExecution(job.tenantId, job.executionId);
  }

  // -------------------------------------------------------------------------
  // TaskRun: QUEUED -> RUNNING -> COMPLETED | FAILED | TIMED_OUT (| QUEUED on retry)
  // -------------------------------------------------------------------------
  async processTaskRun(tenantId: string, taskRunId: string, attempt: AttemptInfo): Promise<void> {
    const run = await this.db.query.taskRuns.findFirst({
      where: and(eq(taskRuns.tenantId, tenantId), eq(taskRuns.id, taskRunId)),
    });
    if (!run) {
      this.logger.warn({ tenantId, taskRunId }, 'task run not found; dropping job');
      return;
    }
    if (run.status !== 'QUEUED') {
      this.logger.info({ taskRunId, status: run.status }, 'task run not in QUEUED; skipping');
      return;
    }
    const task = await this.db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.id, run.taskDefinitionId)),
    });
    const resolved = task ? await this.resolveActiveVersion(tenantId, task.agentId) : null;

    // Guarded QUEUED -> RUNNING: loses gracefully against a concurrent cancel.
    const [started] = await this.db
      .update(taskRuns)
      .set({
        status: 'RUNNING',
        startedAt: run.startedAt ?? new Date(),
        attempts: sql`${taskRuns.attempts} + 1`,
        agentVersionId: resolved?.version.id ?? null,
        agentVersion: resolved?.version.version ?? null,
        harnessVersion: resolved?.version.harnessVersionId ?? null,
        skillVersions: resolved?.version.skillRefs ?? [],
        environmentVersion: task?.environmentId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(taskRuns.id, run.id), inArray(taskRuns.status, allowedSources('RUNNING'))))
      .returning();
    if (!started) return;

    if (!task || !resolved) {
      await this.finishTaskRun(run.id, 'FAILED', {
        error: { message: !task ? 'task definition not found' : 'agent has no ACTIVE version or is not ACTIVE' },
      });
      return;
    }

    const [execution] = await this.db
      .insert(agentExecutions)
      .values({
        tenantId,
        agentId: resolved.agent.id,
        agentVersionId: resolved.version.id,
        taskRunId: run.id,
        idempotencyKey: `taskrun-attempt:${run.id}:${started.attempts}`,
        status: 'RUNNING',
        input: run.input,
        startedAt: new Date(),
      })
      .returning();
    if (!execution) throw new Error('failed to create agent execution');
    await this.db.update(taskRuns).set({ executionId: execution.id }).where(eq(taskRuns.id, run.id));

    const outcome = await this.runAgent(execution, resolved.agent, resolved.version, task.timeoutMs);
    await this.persistOutcome(execution, resolved.agent, resolved.version, outcome, {
      taskRunId: run.id,
      taskDefinitionId: task.id,
    });

    if (outcome.status === 'COMPLETED' && outcome.result) {
      const r = outcome.result;
      await this.finishTaskRun(run.id, 'COMPLETED', {
        output: r.output,
        cost: r.modelCost + r.toolCost,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cachedTokens: r.usage.cachedTokens,
        latencyMs: outcome.latencyMs,
      });
      return;
    }

    if (outcome.status === 'FAILED' && attempt.attempt < attempt.maxAttempts) {
      // RUNNING -> QUEUED, then let the queue retry the job.
      await this.db
        .update(taskRuns)
        .set({ status: 'QUEUED', error: outcome.error ?? null, updatedAt: new Date() })
        .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'RUNNING')));
      throw new RetryableRunError(String(outcome.error?.message ?? 'execution failed'));
    }

    await this.finishTaskRun(run.id, outcome.status, { error: outcome.error ?? null, latencyMs: outcome.latencyMs });
  }

  // -------------------------------------------------------------------------
  // Direct execution (POST /executions)
  // -------------------------------------------------------------------------
  async processExecution(tenantId: string, executionId: string): Promise<void> {
    const [execution] = await this.db
      .update(agentExecutions)
      .set({ status: 'RUNNING', startedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentExecutions.tenantId, tenantId),
          eq(agentExecutions.id, executionId),
          eq(agentExecutions.status, 'QUEUED'),
        ),
      )
      .returning();
    if (!execution) {
      this.logger.info({ executionId }, 'execution not in QUEUED; skipping');
      return;
    }
    const agent = await this.db.query.agents.findFirst({ where: eq(agents.id, execution.agentId) });
    const version = execution.agentVersionId
      ? await this.db.query.agentVersions.findFirst({ where: eq(agentVersions.id, execution.agentVersionId) })
      : undefined;
    if (!agent || !version) {
      await this.finishExecution(execution.id, 'FAILED', { error: { message: 'agent or agent version not found' } });
      return;
    }
    const outcome = await this.runAgent(execution, agent, version, 300_000);
    await this.persistOutcome(execution, agent, version, outcome, {});
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  async resolveActiveVersion(tenantId: string, agentId: string): Promise<{ agent: Agent; version: AgentVersion } | null> {
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.id, agentId)),
    });
    if (!agent || agent.status !== 'ACTIVE' || !agent.activeVersionId) return null;
    const version = await this.db.query.agentVersions.findFirst({ where: eq(agentVersions.id, agent.activeVersionId) });
    return version ? { agent, version } : null;
  }

  private async runAgent(execution: AgentExecution, agent: Agent, version: AgentVersion, timeoutMs: number): Promise<Outcome> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const impl = resolveAgentImplementation(version.configuration);
      const provider = this.providers(version.modelProvider);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
      });
      // Per-execution executor: enforces the version's tool_policy allowlist.
      const toolLogger = {
        info: (msg: string, meta?: object) => this.logger.info({ executionId: execution.id, ...meta }, msg),
        error: (msg: string, meta?: object) => this.logger.error({ executionId: execution.id, ...meta }, msg),
      };
      const tools = new ToolExecutor(
        this.tools,
        parseToolPolicy(version.configuration),
        {
          tenantId: execution.tenantId,
          executionId: execution.id,
          agentId: agent.id,
          stage: typeof version.configuration.stage === 'string' ? version.configuration.stage : (agent.role?.toUpperCase() ?? null),
          logger: toolLogger,
        },
        controller.signal,
      );
      const result = await Promise.race([
        impl.run({
          tenantId: execution.tenantId,
          executionId: execution.id,
          agent: { id: agent.id, name: agent.name, role: agent.role },
          version: {
            id: version.id,
            version: version.version,
            model: version.model,
            modelProvider: version.modelProvider,
            systemPrompt: version.systemPrompt,
            configuration: version.configuration,
          },
          input: execution.input,
          provider,
          signal: controller.signal,
          tools,
        }),
        timeout,
      ]);
      return { status: 'COMPLETED', result, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const status = err instanceof TimeoutError ? 'TIMED_OUT' : 'FAILED';
      this.logger.error({ executionId: execution.id, err: errorPayload(err) }, 'agent execution failed');
      return { status, error: errorPayload(err), latencyMs: Date.now() - startedAt };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Writes Trace + TraceSteps and closes the execution, in one transaction. */
  private async persistOutcome(
    execution: AgentExecution,
    agent: Agent,
    version: AgentVersion,
    outcome: Outcome,
    link: { taskRunId?: string; taskDefinitionId?: string },
  ): Promise<void> {
    const r = outcome.result;
    const toolSteps = r?.steps.filter((s) => s.type === 'TOOL') ?? [];
    const totalCost = (r?.modelCost ?? 0) + (r?.toolCost ?? 0);
    await this.db.transaction(async (tx) => {
      const [trace] = await tx
        .insert(traces)
        .values({
          tenantId: execution.tenantId,
          executionId: execution.id,
          taskRunId: link.taskRunId ?? null,
          taskDefinitionId: link.taskDefinitionId ?? null,
          agentId: agent.id,
          agentVersionId: version.id,
          harnessVersion: version.harnessVersionId,
          toolCalls: toolSteps.map((s) => ({ tool: s.tool, input: s.toolInput, output: s.toolOutput })),
          errors: outcome.error ? [outcome.error] : [],
          finalOutput: r?.output ?? null,
          inputTokens: r?.usage.inputTokens ?? 0,
          outputTokens: r?.usage.outputTokens ?? 0,
          cachedTokens: r?.usage.cachedTokens ?? 0,
          toolCallCount: toolSteps.length,
          toolCost: r?.toolCost ?? 0,
          modelCost: r?.modelCost ?? 0,
          totalCost,
        })
        .returning({ id: traces.id });
      if (!trace) throw new Error('failed to insert trace');
      if (r && r.steps.length > 0) {
        await tx.insert(traceSteps).values(
          r.steps.map((s, i) => ({
            tenantId: execution.tenantId,
            traceId: trace.id,
            sequence: i + 1,
            timestamp: s.timestamp,
            type: s.type,
            input: s.input ?? null,
            output: s.output ?? null,
            model: s.model ?? null,
            inputTokens: s.usage?.inputTokens ?? 0,
            outputTokens: s.usage?.outputTokens ?? 0,
            tool: s.tool ?? null,
            toolInput: s.toolInput ?? null,
            toolOutput: s.toolOutput ?? null,
            latencyMs: s.latencyMs ?? null,
            error: s.error ?? null,
            reward: s.reward ?? null,
          })),
        );
      }
      await tx
        .update(agentExecutions)
        .set({
          status: outcome.status,
          output: r?.output ?? null,
          error: outcome.error ?? null,
          inputTokens: r?.usage.inputTokens ?? 0,
          outputTokens: r?.usage.outputTokens ?? 0,
          cachedTokens: r?.usage.cachedTokens ?? 0,
          toolCalls: toolSteps.length,
          toolCost: r?.toolCost ?? 0,
          modelCost: r?.modelCost ?? 0,
          totalCost,
          latencyMs: outcome.latencyMs,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        // Guarded: a concurrent cancel (RUNNING -> CANCELLED) wins.
        .where(and(eq(agentExecutions.id, execution.id), eq(agentExecutions.status, 'RUNNING')));
    });
  }

  private async finishExecution(id: string, status: RunStatus, patch: { error?: Record<string, unknown> }) {
    await this.db
      .update(agentExecutions)
      .set({ status, error: patch.error ?? null, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentExecutions.id, id), inArray(agentExecutions.status, allowedSources(status))));
  }

  private async finishTaskRun(
    id: string,
    status: Extract<RunStatus, 'COMPLETED' | 'FAILED' | 'TIMED_OUT'>,
    patch: Partial<{
      output: Record<string, unknown>;
      error: Record<string, unknown> | null;
      cost: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      latencyMs: number;
    }>,
  ): Promise<void> {
    await this.db
      .update(taskRuns)
      .set({ ...patch, status, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(taskRuns.id, id), inArray(taskRuns.status, allowedSources(status))));
  }
}
