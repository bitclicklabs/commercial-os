/**
 * Builders of the runtime events (catalogue in LLD v0.2 section 7.1). Payloads are compact:
 * ids, status, cost and, when the agent output has them, `outcome` and `funnel`. Never the
 * trace or the full output.
 *
 * Every task/execution event carries `taskDefinitionId` (anti-loop guard) and `chainDepth`
 * (depth of the run in an event chain, see src/events/triggers.ts).
 */
import type { AgentExecution, TaskRun } from '../db/schema.js';
import type { EventProducer } from './envelope.js';
import type { PublishEventInput } from './event-bus.js';
import { chainDepthOfRunInput } from './triggers.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** `outcome` / `funnel` of an agent output, if present (Prospector: outcome SUCCESS|PARTIAL|FAILED). */
function outputSummary(output: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!output) return {};
  const out: Record<string, unknown> = {};
  if (typeof output.outcome === 'string') out.outcome = output.outcome;
  if (output.funnel && typeof output.funnel === 'object') out.funnel = output.funnel;
  return out;
}

function compactError(error: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!error) return null;
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'code', 'message']) {
    const v = error[key];
    if (typeof v === 'string') out[key] = v.slice(0, 500);
  }
  return out;
}

type RunLike = Pick<TaskRun, 'id' | 'tenantId' | 'taskDefinitionId' | 'input'>;

export function taskScheduledEvent(
  run: RunLike & Pick<TaskRun, 'scheduledAt' | 'idempotencyKey'>,
  opts: { trigger?: string; producer?: EventProducer } = {},
): PublishEventInput {
  return {
    tenantId: run.tenantId,
    type: 'task.scheduled',
    correlationId: run.id,
    producer: opts.producer ?? 'agent-runtime',
    idempotencyKey: `evt:task.scheduled:${run.id}`,
    data: {
      taskRunId: run.id,
      taskDefinitionId: run.taskDefinitionId,
      scheduledAt: iso(run.scheduledAt),
      ...(opts.trigger ? { trigger: opts.trigger } : {}),
      chainDepth: chainDepthOfRunInput(run.input),
    },
  };
}

export function taskStartedEvent(run: RunLike & Pick<TaskRun, 'startedAt' | 'attempts'>, executionId: string): PublishEventInput {
  return {
    tenantId: run.tenantId,
    type: 'task.started',
    correlationId: run.id,
    idempotencyKey: `evt:task.started:${run.id}:${run.attempts}`,
    data: {
      taskRunId: run.id,
      taskDefinitionId: run.taskDefinitionId,
      executionId,
      attempt: run.attempts,
      startedAt: iso(run.startedAt),
      chainDepth: chainDepthOfRunInput(run.input),
    },
  };
}

/** task.completed for COMPLETED, task.failed for FAILED / TIMED_OUT (terminal only). */
export function taskFinishedEvent(
  run: RunLike & Pick<TaskRun, 'status' | 'output' | 'error' | 'cost' | 'finishedAt' | 'latencyMs' | 'executionId' | 'attempts'>,
): PublishEventInput {
  const completed = run.status === 'COMPLETED';
  const type = completed ? 'task.completed' : 'task.failed';
  const common = {
    taskRunId: run.id,
    taskDefinitionId: run.taskDefinitionId,
    executionId: run.executionId,
    status: run.status,
    attempts: run.attempts,
    finishedAt: iso(run.finishedAt),
    chainDepth: chainDepthOfRunInput(run.input),
  };
  return {
    tenantId: run.tenantId,
    type,
    correlationId: run.id,
    idempotencyKey: `evt:${type}:${run.id}`,
    data: completed
      ? { ...common, costEur: run.cost, latencyMs: run.latencyMs, ...outputSummary(run.output) }
      : { ...common, error: compactError(run.error), latencyMs: run.latencyMs },
  };
}

export interface ExecutionEventContext {
  taskRunId: string | null;
  taskDefinitionId: string | null;
  stage: string | null;
  agentVersion: number | null;
}

function executionBase(execution: Pick<AgentExecution, 'id' | 'agentId' | 'agentVersionId' | 'input'>, ctx: ExecutionEventContext) {
  return {
    executionId: execution.id,
    taskRunId: ctx.taskRunId,
    taskDefinitionId: ctx.taskDefinitionId,
    agentId: execution.agentId,
    agentVersionId: execution.agentVersionId,
    agentVersion: ctx.agentVersion,
    stage: ctx.stage,
    chainDepth: chainDepthOfRunInput(execution.input),
  };
}

export function executionStartedEvent(
  execution: Pick<AgentExecution, 'id' | 'tenantId' | 'agentId' | 'agentVersionId' | 'input'>,
  ctx: ExecutionEventContext,
): PublishEventInput {
  return {
    tenantId: execution.tenantId,
    type: 'agent.execution.started',
    correlationId: ctx.taskRunId ?? execution.id,
    idempotencyKey: `evt:agent.execution.started:${execution.id}`,
    data: executionBase(execution, ctx),
  };
}

/** agent.execution.completed for COMPLETED, agent.execution.failed otherwise. */
export function executionFinishedEvent(
  execution: Pick<AgentExecution, 'id' | 'tenantId' | 'agentId' | 'agentVersionId' | 'input'>,
  ctx: ExecutionEventContext,
  result: {
    status: string;
    output?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
    costEur?: number;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number | null;
  },
): PublishEventInput {
  const completed = result.status === 'COMPLETED';
  const type = completed ? 'agent.execution.completed' : 'agent.execution.failed';
  return {
    tenantId: execution.tenantId,
    type,
    correlationId: ctx.taskRunId ?? execution.id,
    idempotencyKey: `evt:${type}:${execution.id}`,
    data: {
      ...executionBase(execution, ctx),
      status: result.status,
      costEur: result.costEur ?? 0,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      latencyMs: result.latencyMs ?? null,
      ...(completed ? outputSummary(result.output) : { error: compactError(result.error) }),
    },
  };
}
