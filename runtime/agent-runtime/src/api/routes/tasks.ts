import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.js';
import {
  agentExecutions,
  agents,
  taskDefinitions,
  taskDefinitionVersions,
  taskRuns,
  traceSteps,
  traces,
  type TaskDefinition,
} from '../../db/schema.js';
import type { TaskDefinitionStatus } from '../../domain/statuses.js';
import { QueueUnavailableError, requestTaskRun } from '../../services/task-runs.js';
import { assertValidSchedule } from '../../scheduler/routes.js';
import type { ApiContext } from '../context.js';
import { conflict, HttpError, IdParams, notFound, parse, serialize, tenantOf } from '../http.js';
import { CreateTaskBody, ListQuery, ListTasksQuery, PatchTaskBody, RunTaskBody } from '../schemas.js';

/** Fields captured in every TaskDefinitionVersion snapshot. */
function snapshot(task: TaskDefinition): Record<string, unknown> {
  return {
    name: task.name,
    description: task.description,
    agent_id: task.agentId,
    input_schema: task.inputSchema,
    output_schema: task.outputSchema,
    default_input: task.defaultInput,
    schedule: task.schedule,
    timezone: task.timezone,
    enabled: task.enabled,
    priority: task.priority,
    max_concurrency: task.maxConcurrency,
    retry_policy: task.retryPolicy,
    timeout_ms: task.timeoutMs,
    approval_policy: task.approvalPolicy,
    environment_id: task.environmentId,
    evaluation_policy: task.evaluationPolicy,
  };
}

async function assertAgentUsable(db: Db, tenantId: string, agentId: string): Promise<void> {
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.tenantId, tenantId), eq(agents.id, agentId)) });
  if (!agent) throw notFound('agent');
  if (agent.status === 'ARCHIVED' || agent.status === 'DEPRECATED') {
    throw conflict(`agent is ${agent.status}`);
  }
}

export async function taskRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  async function loadTask(tenantId: string, id: string): Promise<TaskDefinition> {
    const task = await db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.id, id)),
    });
    if (!task) throw notFound('task');
    return task;
  }

  app.post('/tasks', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(CreateTaskBody, req.body);
    assertValidSchedule(body.schedule, body.timezone);
    await assertAgentUsable(db, tenantId, body.agent_id);

    const task = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(taskDefinitions)
        .values({
          tenantId,
          name: body.name,
          description: body.description ?? null,
          agentId: body.agent_id,
          inputSchema: body.input_schema ?? null,
          outputSchema: body.output_schema ?? null,
          defaultInput: body.default_input,
          schedule: body.schedule,
          timezone: body.timezone,
          enabled: body.enabled,
          priority: body.priority,
          maxConcurrency: body.max_concurrency,
          retryPolicy: body.retry_policy,
          timeoutMs: body.timeout_ms,
          approvalPolicy: body.approval_policy ?? null,
          environmentId: body.environment_id ?? null,
          evaluationPolicy: body.evaluation_policy ?? null,
          createdBy: body.created_by ?? null,
          updatedBy: body.created_by ?? null,
          currentVersion: 1,
        })
        .returning();
      if (!created) throw new Error('insert task failed');
      const [version] = await tx
        .insert(taskDefinitionVersions)
        .values({
          tenantId,
          taskDefinitionId: created.id,
          version: 1,
          agentId: created.agentId,
          definition: snapshot(created),
          changeReason: 'created',
          createdBy: body.created_by ?? null,
        })
        .returning();
      if (!version) throw new Error('insert task version failed');
      const [withVersion] = await tx
        .update(taskDefinitions)
        .set({ currentVersionId: version.id })
        .where(eq(taskDefinitions.id, created.id))
        .returning();
      return withVersion ?? created;
    });
    await ctx.scheduler?.sync(task);
    return reply.status(201).send({ task: serialize(task) });
  });

  app.get('/tasks', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListTasksQuery, req.query);
    const rows = await db.query.taskDefinitions.findMany({
      where: and(
        eq(taskDefinitions.tenantId, tenantId),
        q.status ? eq(taskDefinitions.status, q.status) : undefined,
        q.agent_id ? eq(taskDefinitions.agentId, q.agent_id) : undefined,
      ),
      orderBy: desc(taskDefinitions.createdAt),
    });
    return { items: rows.map((r) => serialize(r)) };
  });

  app.get('/tasks/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const task = await loadTask(tenantId, id);
    const versions = await db.query.taskDefinitionVersions.findMany({
      where: eq(taskDefinitionVersions.taskDefinitionId, task.id),
      orderBy: desc(taskDefinitionVersions.version),
    });
    return { task: serialize(task), versions: versions.map((v) => serialize(v)) };
  });

  /** PATCH /tasks/:id - every change produces a new immutable TaskDefinitionVersion. */
  app.patch('/tasks/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const body = parse(PatchTaskBody, req.body ?? {});
    const task = await loadTask(tenantId, id);
    if (task.status === 'ARCHIVED') throw conflict('archived tasks are immutable');
    if (body.agent_id) await assertAgentUsable(db, tenantId, body.agent_id);
    if (body.schedule !== undefined || body.timezone !== undefined) {
      assertValidSchedule(body.schedule ?? task.schedule, body.timezone ?? task.timezone);
    }

    const updated = await db.transaction(async (tx) => {
      const nextVersion = task.currentVersion + 1;
      const [row] = await tx
        .update(taskDefinitions)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.agent_id !== undefined ? { agentId: body.agent_id } : {}),
          ...(body.input_schema !== undefined ? { inputSchema: body.input_schema } : {}),
          ...(body.output_schema !== undefined ? { outputSchema: body.output_schema } : {}),
          ...(body.default_input !== undefined ? { defaultInput: body.default_input } : {}),
          ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.max_concurrency !== undefined ? { maxConcurrency: body.max_concurrency } : {}),
          ...(body.retry_policy !== undefined ? { retryPolicy: body.retry_policy } : {}),
          ...(body.timeout_ms !== undefined ? { timeoutMs: body.timeout_ms } : {}),
          ...(body.approval_policy !== undefined ? { approvalPolicy: body.approval_policy } : {}),
          ...(body.environment_id !== undefined ? { environmentId: body.environment_id } : {}),
          ...(body.evaluation_policy !== undefined ? { evaluationPolicy: body.evaluation_policy } : {}),
          updatedBy: body.updated_by ?? null,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        })
        // Optimistic lock on the version number: concurrent PATCHes cannot fork history.
        .where(and(eq(taskDefinitions.id, task.id), eq(taskDefinitions.currentVersion, task.currentVersion)))
        .returning();
      if (!row) throw conflict('task was modified concurrently; retry');
      const [version] = await tx
        .insert(taskDefinitionVersions)
        .values({
          tenantId,
          taskDefinitionId: row.id,
          version: nextVersion,
          agentId: row.agentId,
          definition: snapshot(row),
          changeReason: body.change_reason ?? null,
          createdBy: body.updated_by ?? null,
        })
        .returning();
      if (!version) throw new Error('insert task version failed');
      const [final] = await tx
        .update(taskDefinitions)
        .set({ currentVersionId: version.id })
        .where(eq(taskDefinitions.id, row.id))
        .returning();
      return final ?? row;
    });
    await ctx.scheduler?.sync(updated);
    return { task: serialize(updated) };
  });

  async function setStatus(tenantId: string, id: string, to: TaskDefinitionStatus, allowedFrom: TaskDefinitionStatus[]) {
    const task = await loadTask(tenantId, id);
    if (task.status === to) {
      await ctx.scheduler?.sync(task); // idempotent: also heals a missed registration
      return task;
    }
    if (!allowedFrom.includes(task.status)) throw conflict(`cannot move task from ${task.status} to ${to}`);
    const [row] = await db
      .update(taskDefinitions)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(taskDefinitions.id, task.id), eq(taskDefinitions.status, task.status)))
      .returning();
    if (!row) throw conflict('task status changed concurrently; retry');
    await ctx.scheduler?.sync(row);
    return row;
  }

  app.post('/tasks/:id/pause', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { task: serialize(await setStatus(tenantOf(req, ctx.config.defaultTenantId), id, 'PAUSED', ['ACTIVE'])) };
  });

  app.post('/tasks/:id/resume', async (req) => {
    const { id } = parse(IdParams, req.params);
    return { task: serialize(await setStatus(tenantOf(req, ctx.config.defaultTenantId), id, 'ACTIVE', ['PAUSED'])) };
  });

  /** Logical delete (section 22): ACTIVE|PAUSED -> ARCHIVED. There is no DELETE route. */
  app.post('/tasks/:id/archive', async (req) => {
    const { id } = parse(IdParams, req.params);
    return {
      task: serialize(await setStatus(tenantOf(req, ctx.config.defaultTenantId), id, 'ARCHIVED', ['ACTIVE', 'PAUSED'])),
    };
  });

  /** POST /tasks/:id/run - idempotent on `taskrun:{task_id}:{scheduled_at}`. */
  app.post('/tasks/:id/run', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const body = parse(RunTaskBody, req.body ?? {});
    const task = await loadTask(tenantId, id);
    if (task.status !== 'ACTIVE') throw conflict(`task is ${task.status}`);
    if (!task.enabled) throw conflict('task is disabled');
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, task.agentId) });
    if (!agent || agent.status !== 'ACTIVE' || !agent.activeVersionId) {
      throw conflict('task agent is not ACTIVE or has no active version');
    }

    try {
      const result = await requestTaskRun(
        db,
        ctx.queue,
        task,
        {
          ...(body.scheduled_at ? { scheduledAt: body.scheduled_at } : {}),
          ...(body.input ? { input: body.input } : {}),
          trigger: 'MANUAL',
        },
        ctx.events ? { events: ctx.events } : {},
      );
      return reply.status(result.deduplicated ? 200 : 202).send({
        task_run: serialize(result.taskRun),
        deduplicated: result.deduplicated,
        job_id: result.enqueue?.jobId ?? null,
      });
    } catch (err) {
      if (err instanceof QueueUnavailableError) {
        req.log.error({ err: err.cause }, 'enqueue failed');
        throw new HttpError(503, 'queue_unavailable', 'task run persisted but could not be enqueued; retry the same request', {
          task_run_id: err.taskRun.id,
          idempotency_key: err.taskRun.idempotencyKey,
        });
      }
      throw err;
    }
  });

  app.get('/tasks/:id/runs', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const q = parse(ListQuery, req.query);
    const task = await loadTask(tenantId, id);
    const rows = await db.query.taskRuns.findMany({
      where: and(eq(taskRuns.taskDefinitionId, task.id), q.status ? eq(taskRuns.status, q.status) : undefined),
      orderBy: desc(taskRuns.scheduledAt),
      limit: q.limit,
    });
    return { items: rows.map((r) => serialize(r)) };
  });

  /** GET /task-runs/:id - TaskRun with its latest execution, trace and trace steps. */
  app.get('/task-runs/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const run = await db.query.taskRuns.findFirst({ where: and(eq(taskRuns.tenantId, tenantId), eq(taskRuns.id, id)) });
    if (!run) throw notFound('task run');
    const execution = run.executionId
      ? await db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, run.executionId) })
      : undefined;
    const trace = execution
      ? await db.query.traces.findFirst({ where: eq(traces.executionId, execution.id) })
      : undefined;
    const steps = trace
      ? await db.query.traceSteps.findMany({ where: eq(traceSteps.traceId, trace.id), orderBy: asc(traceSteps.sequence) })
      : [];
    return {
      task_run: serialize(run),
      execution: serialize(execution),
      trace: trace ? { ...serialize(trace), steps: steps.map((s) => serialize(s)) } : null,
    };
  });
}
