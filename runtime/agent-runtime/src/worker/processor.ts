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
  type SkillVersionUsed,
} from '../db/schema.js';
import { allowedSources } from '../domain/run-state.js';
import { NOOP_EVENT_PUBLISHER, type EventPublisher } from '../events/event-bus.js';
import {
  executionFinishedEvent,
  executionStartedEvent,
  taskFinishedEvent,
  taskStartedEvent,
  type ExecutionEventContext,
} from '../events/runtime-events.js';
import type { RunStatus } from '../domain/statuses.js';
import type { ProviderFactory } from '../providers/index.js';
import type { RunJob } from '../queue/run-queue.js';
import { resolveSkillRefs, type SkillSet } from '../skills/resolver.js';
import { applyHarness, harnessRecord, resolveHarnessRef, type EffectivePolicies, type ResolvedHarness } from '../harness/index.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor, type ToolRegistry } from '../tools/index.js';
import { EntityLocks } from './entity-locks.js';
import { recoverOrphanRun } from './recovery.js';
import { policyRequiresTwenty, twentyGateFromEnv, type TwentyGate, type TwentyWaitState } from './twenty-gate.js';

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
  /** Twenty wait window of this job from earlier TwentyUnavailableError deferrals. */
  twentyWait?: TwentyWaitState | undefined;
}

/** Thrown to ask the queue to retry (BullMQ re-runs the job with backoff). */
export class RetryableRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRunError';
  }
}

/**
 * Thrown when the task already has `max_concurrency` runs RUNNING. The run stays QUEUED and
 * the BullMQ worker moves the job to `delayed` so it is retried when a slot may be free.
 */
export class ConcurrencyLimitError extends Error {
  constructor(
    readonly taskDefinitionId: string,
    readonly maxConcurrency: number,
  ) {
    super(`task ${taskDefinitionId} reached max_concurrency=${maxConcurrency}`);
    this.name = 'ConcurrencyLimitError';
  }
}

/**
 * Thrown when the agent version needs Twenty and Twenty does not answer `/healthz` yet (e.g.
 * the host just booted). Like ConcurrencyLimitError: the run stays QUEUED and the BullMQ
 * worker parks the job in `delayed` for `delayMs` without consuming an attempt.
 */
export class TwentyUnavailableError extends Error {
  constructor(
    readonly delayMs: number,
    readonly state: TwentyWaitState,
  ) {
    super(`Twenty not healthy; run deferred ${delayMs} ms (deferral ${state.deferrals})`);
    this.name = 'TwentyUnavailableError';
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

/** Harness of one attempt: what was resolved and the effective policies after precedence. */
interface AttemptHarness {
  resolved: ResolvedHarness;
  policies: EffectivePolicies;
}

/** Today's policies of a direct execution (POST /executions): 300 s, no retries. */
const DIRECT_EXECUTION_BASE = { timeoutMs: 300_000, retry: { max_attempts: 1, backoff_ms: 0 } };

function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

export class RunProcessor {
  readonly locks: EntityLocks;
  /** Domain events (task.*, agent.execution.*). Best-effort: emission never fails a run. */
  events: EventPublisher = NOOP_EVENT_PUBLISHER;

  constructor(
    private readonly db: Db,
    private readonly providers: ProviderFactory,
    private readonly logger: ProcessorLogger = silentLogger,
    /** Tool registry; defaults to the MVP-0 tools with the Twenty client from env. */
    private readonly tools: ToolRegistry = createDefaultToolRegistry(),
    /** Holds runs that need Twenty until it is healthy; null disables it. Defaults to env. */
    private readonly twentyGate: TwentyGate | null = twentyGateFromEnv(),
  ) {
    this.locks = new EntityLocks(db);
  }

  async process(job: RunJob, attempt: AttemptInfo = { attempt: 1, maxAttempts: 1 }): Promise<void> {
    if (job.kind === 'task_run') await this.processTaskRun(job.tenantId, job.taskRunId, attempt);
    else await this.processExecution(job.tenantId, job.executionId);
  }

  // -------------------------------------------------------------------------
  // TaskRun: QUEUED -> RUNNING -> COMPLETED | FAILED | TIMED_OUT (| QUEUED on retry)
  // -------------------------------------------------------------------------
  async processTaskRun(tenantId: string, taskRunId: string, attempt: AttemptInfo): Promise<void> {
    const findRun = () =>
      this.db.query.taskRuns.findFirst({ where: and(eq(taskRuns.tenantId, tenantId), eq(taskRuns.id, taskRunId)) });
    let run = await findRun();
    if (!run) {
      this.logger.warn({ tenantId, taskRunId }, 'task run not found; dropping job');
      return;
    }
    const task = await this.db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.id, run.taskDefinitionId)),
    });
    const maxAttempts = task?.retryPolicy.max_attempts ?? attempt.maxAttempts;

    if (run.status === 'RUNNING') {
      // The job id is unique per run and every other path leaves the run QUEUED before the
      // job is delivered again, so a RUNNING run here means BullMQ re-delivered a stalled job:
      // the previous attempt died. Recover it (RUNNING -> QUEUED | FAILED) and go on.
      const outcome = await recoverOrphanRun(this.db, run, maxAttempts, 'stalled job re-delivered');
      this.logger.warn({ taskRunId, outcome }, 'recovered stalled task run');
      if (outcome !== 'requeued') return;
      run = await findRun();
      if (!run) return;
    }
    if (run.status !== 'QUEUED') {
      this.logger.info({ taskRunId, status: run.status }, 'task run not in QUEUED; skipping');
      return;
    }
    const resolved = task ? await this.resolveActiveVersion(tenantId, task.agentId) : null;
    const queuedRun = run;
    // The harness is resolved once per attempt, when it starts (before the Twenty gate, which
    // uses its wait cap): a version activated later only affects later attempts.
    const harness = resolved && task ? await this.resolveHarness(tenantId, resolved.version, { timeoutMs: task.timeoutMs, retry: task.retryPolicy }) : null;
    if (resolved) await this.gateOnTwenty(taskRunId, resolved.version, attempt.twentyWait, harness);
    // Skills are resolved once per attempt, when it starts: a version activated later only
    // affects later runs.
    const skills = resolved ? await this.resolveSkills(tenantId, resolved.version) : null;

    // max_concurrency gate + guarded QUEUED -> RUNNING, serialised per task by a transaction-
    // scoped advisory lock so two workers cannot both see a free slot.
    const started = await this.db.transaction(async (tx) => {
      if (task) {
        const lockKey = `task-concurrency:${task.id}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [row] = await tx
          .select({ running: sql<number>`count(*)::int` })
          .from(taskRuns)
          .where(and(eq(taskRuns.taskDefinitionId, task.id), eq(taskRuns.status, 'RUNNING')));
        if ((row?.running ?? 0) >= task.maxConcurrency) return 'deferred' as const;
      }
      // Guarded: loses gracefully against a concurrent cancel.
      const [updated] = await tx
        .update(taskRuns)
        .set({
          status: 'RUNNING',
          startedAt: queuedRun.startedAt ?? new Date(),
          attempts: sql`${taskRuns.attempts} + 1`,
          agentVersionId: resolved?.version.id ?? null,
          agentVersion: resolved?.version.version ?? null,
          harnessVersion: harness?.resolved.label ?? resolved?.version.harnessVersionId ?? null,
          skillVersions: skills?.runRecords() ?? resolved?.version.skillRefs ?? [],
          environmentVersion: task?.environmentId ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(taskRuns.id, queuedRun.id), inArray(taskRuns.status, allowedSources('RUNNING'))))
        .returning();
      return updated ?? null;
    });
    if (started === 'deferred') throw new ConcurrencyLimitError(task!.id, task!.maxConcurrency);
    if (!started) return;

    if (!task || !resolved || !skills || !harness) {
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
    await this.events.emit(taskStartedEvent(started, execution.id));
    await this.events.emit(executionStartedEvent(execution, this.eventContext(resolved.agent, resolved.version, run.id, task.id)));

    let outcome: Outcome;
    try {
      outcome = await this.runAgent(execution, resolved.agent, resolved.version, harness.policies, skills);
      await this.persistOutcome(execution, resolved.agent, resolved.version, outcome, {
        taskRunId: run.id,
        taskDefinitionId: task.id,
      }, skills, harness);
    } finally {
      await this.releaseLocks(execution.id);
    }

    if (outcome.status === 'COMPLETED' && outcome.result) {
      const r = outcome.result;
      await this.finishTaskRun(run.id, 'COMPLETED', {
        skillVersions: skills.runRecords(),
        output: r.output,
        cost: r.modelCost + r.toolCost,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        cachedTokens: r.usage.cachedTokens,
        latencyMs: outcome.latencyMs,
      });
      return;
    }

    // Retry only while both the queue and the run have attempts left (a stalled attempt
    // consumes a run attempt without consuming a BullMQ attempt).
    if (outcome.status === 'FAILED' && attempt.attempt < attempt.maxAttempts && started.attempts < harness.policies.retry.max_attempts) {
      // RUNNING -> QUEUED, then let the queue retry the job.
      await this.db
        .update(taskRuns)
        .set({ status: 'QUEUED', error: outcome.error ?? null, updatedAt: new Date() })
        .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'RUNNING')));
      throw new RetryableRunError(String(outcome.error?.message ?? 'execution failed'));
    }

    await this.finishTaskRun(run.id, outcome.status, { skillVersions: skills.runRecords(), error: outcome.error ?? null, latencyMs: outcome.latencyMs });
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
      const error = { message: 'agent or agent version not found' };
      await this.finishExecution(execution.id, 'FAILED', { error });
      const ctx: ExecutionEventContext = { taskRunId: null, taskDefinitionId: null, stage: null, agentVersion: null };
      await this.events.emit(executionFinishedEvent(execution, ctx, { status: 'FAILED', error }));
      return;
    }
    await this.events.emit(executionStartedEvent(execution, this.eventContext(agent, version, null, null)));
    const skills = await this.resolveSkills(tenantId, version);
    const harness = await this.resolveHarness(tenantId, version, DIRECT_EXECUTION_BASE);
    try {
      const outcome = await this.runAgent(execution, agent, version, harness.policies, skills);
      await this.persistOutcome(execution, agent, version, outcome, {}, skills, harness);
    } finally {
      await this.releaseLocks(execution.id);
    }
  }

  /**
   * Twenty health gate before QUEUED -> RUNNING. Throws TwentyUnavailableError to defer the
   * job; past TWENTY_WAIT_MAX_MS it lets the run go (tools fail, agent reports PARTIAL).
   */
  private async gateOnTwenty(taskRunId: string, version: AgentVersion, state: TwentyWaitState | undefined, harness: AttemptHarness | null): Promise<void> {
    if (!this.twentyGate) return;
    const requires = policyRequiresTwenty(this.tools, harness?.policies.toolPolicy ?? parseToolPolicy(version.configuration));
    const maxWaitMs = harness?.policies.twentyWaitMaxMs ?? this.twentyGate.maxWaitMs;
    const decision = await this.twentyGate.check(requires, state, maxWaitMs);
    if (decision.action === 'defer') {
      this.logger.warn(
        { taskRunId, deferral: decision.state.deferrals, delayMs: decision.delayMs, waitedMs: decision.waitedMs, maxWaitMs },
        'Twenty not healthy; deferring task run',
      );
      throw new TwentyUnavailableError(decision.delayMs, decision.state);
    }
    if (decision.reason === 'wait_exceeded') {
      this.logger.warn(
        { taskRunId, waitedMs: decision.waitedMs, deferrals: decision.deferrals, maxWaitMs },
        'Twenty still not healthy after TWENTY_WAIT_MAX_MS; running anyway',
      );
    } else if (state) {
      this.logger.info({ taskRunId, waitedMs: Date.now() - state.since, deferrals: state.deferrals }, 'Twenty healthy again; starting deferred task run');
    }
  }

  /** Entity locks never outlive the attempt that took them (TTL covers a crashed worker). */
  private async releaseLocks(executionId: string): Promise<void> {
    try {
      const released = await this.locks.releaseAll(executionId);
      if (released > 0) this.logger.info({ executionId, released }, 'released entity locks');
    } catch (err) {
      this.logger.error({ executionId, err: errorPayload(err) }, 'failed to release entity locks');
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  private eventContext(agent: Agent, version: AgentVersion, taskRunId: string | null, taskDefinitionId: string | null): ExecutionEventContext {
    return { taskRunId, taskDefinitionId, stage: this.stageOf(agent, version), agentVersion: version.version };
  }

  private stageOf(agent: Agent, version: AgentVersion): string | null {
    return typeof version.configuration.stage === 'string' ? version.configuration.stage : (agent.role?.toUpperCase() ?? null);
  }

  async resolveActiveVersion(tenantId: string, agentId: string): Promise<{ agent: Agent; version: AgentVersion } | null> {
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.id, agentId)),
    });
    if (!agent || agent.status !== 'ACTIVE' || !agent.activeVersionId) return null;
    const version = await this.db.query.agentVersions.findFirst({ where: eq(agentVersions.id, agent.activeVersionId) });
    return version ? { agent, version } : null;
  }

  /** Skill refs of the version against the database; never throws (falls back to code). */
  private resolveSkills(tenantId: string, version: AgentVersion): Promise<SkillSet> {
    return resolveSkillRefs(this.db, tenantId, version.skillRefs, {
      warn: (obj, msg) => this.logger.warn({ tenantId, agentVersionId: version.id, ...obj }, msg),
    });
  }

  /**
   * Harness ref of the version against the database, plus the effective policies of the
   * attempt (harness over task/env; ceiling over the version's own policy). Never throws:
   * without a harness (or if it does not resolve) the policies are exactly today's.
   */
  private async resolveHarness(
    tenantId: string,
    version: AgentVersion,
    base: { timeoutMs: number; retry: { max_attempts: number; backoff_ms: number } },
  ): Promise<AttemptHarness> {
    const resolved = await resolveHarnessRef(this.db, tenantId, version.harnessRef, {
      warn: (obj, msg) => this.logger.warn({ tenantId, agentVersionId: version.id, ...obj }, msg),
    });
    const policies = applyHarness(resolved.config, {
      timeoutMs: base.timeoutMs,
      retry: base.retry,
      twentyWaitMaxMs: this.twentyGate ? this.twentyGate.maxWaitMs : null,
      toolPolicy: parseToolPolicy(version.configuration),
      configuration: version.configuration,
    });
    return { resolved, policies };
  }

  private async runAgent(execution: AgentExecution, agent: Agent, version: AgentVersion, policies: EffectivePolicies, skills: SkillSet): Promise<Outcome> {
    const timeoutMs = policies.timeoutMs;
    const startedAt = Date.now();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const impl = resolveAgentImplementation(version.configuration, { db: this.db });
      const provider = this.providers(version.modelProvider);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
      });
      // Per-execution executor: enforces the version's tool_policy allowlist (capped by the harness).
      const toolLogger = {
        info: (msg: string, meta?: object) => this.logger.info({ executionId: execution.id, ...meta }, msg),
        error: (msg: string, meta?: object) => this.logger.error({ executionId: execution.id, ...meta }, msg),
      };
      const tools = new ToolExecutor(
        this.tools,
        policies.toolPolicy,
        {
          tenantId: execution.tenantId,
          executionId: execution.id,
          agentId: agent.id,
          stage: this.stageOf(agent, version),
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
            configuration: policies.configuration,
          },
          input: execution.input,
          provider,
          signal: controller.signal,
          tools,
          skills,
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
    skills: SkillSet,
    harness: AttemptHarness,
  ): Promise<void> {
    const r = outcome.result;
    const toolSteps = r?.steps.filter((s) => s.type === 'TOOL') ?? [];
    const totalCost = (r?.modelCost ?? 0) + (r?.toolCost ?? 0);
    const closed = await this.db.transaction(async (tx) => {
      const [trace] = await tx
        .insert(traces)
        .values({
          tenantId: execution.tenantId,
          executionId: execution.id,
          taskRunId: link.taskRunId ?? null,
          taskDefinitionId: link.taskDefinitionId ?? null,
          agentId: agent.id,
          agentVersionId: version.id,
          harnessVersion: harness.resolved.label ?? version.harnessVersionId,
          harness: harnessRecord(harness.resolved, harness.policies),
          skillVersions: skills.traceRecords(),
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
      const [row] = await tx
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
        .where(and(eq(agentExecutions.id, execution.id), eq(agentExecutions.status, 'RUNNING')))
        .returning({ id: agentExecutions.id });
      return Boolean(row);
    });
    if (!closed) return;
    await this.events.emit(
      executionFinishedEvent(execution, this.eventContext(agent, version, link.taskRunId ?? null, link.taskDefinitionId ?? null), {
        status: outcome.status,
        output: r?.output ?? null,
        error: outcome.error ?? null,
        costEur: totalCost,
        inputTokens: r?.usage.inputTokens ?? 0,
        outputTokens: r?.usage.outputTokens ?? 0,
        latencyMs: outcome.latencyMs,
      }),
    );
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
      skillVersions: SkillVersionUsed[];
      output: Record<string, unknown>;
      error: Record<string, unknown> | null;
      cost: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      latencyMs: number;
    }>,
  ): Promise<void> {
    const [row] = await this.db
      .update(taskRuns)
      .set({ ...patch, status, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(taskRuns.id, id), inArray(taskRuns.status, allowedSources(status))))
      .returning();
    if (row) await this.events.emit(taskFinishedEvent(row));
  }
}
