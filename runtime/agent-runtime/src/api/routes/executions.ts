import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { agentExecutions, agents, agentVersions, taskRuns, traceSteps, traces } from '../../db/schema.js';
import { allowedSources } from '../../domain/run-state.js';
import type { ApiContext } from '../context.js';
import { conflict, HttpError, IdParams, notFound, parse, serialize, tenantOf } from '../http.js';
import { CreateExecutionBody, ListQuery } from '../schemas.js';

export async function executionRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  /** POST /executions - run an agent directly (no TaskDefinition). Idempotent on `idempotency_key`. */
  app.post('/executions', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(CreateExecutionBody, req.body);
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.id, body.agent_id)),
    });
    if (!agent) throw notFound('agent');
    if (agent.status !== 'ACTIVE') throw conflict(`agent is ${agent.status}`);
    const versionId = body.agent_version_id ?? agent.activeVersionId;
    if (!versionId) throw conflict('agent has no active version');
    const version = await db.query.agentVersions.findFirst({
      where: and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, agent.id)),
    });
    if (!version) throw notFound('agent version');

    const idempotencyKey = body.idempotency_key ?? `execution:${randomUUID()}`;
    const [inserted] = await db
      .insert(agentExecutions)
      .values({
        tenantId,
        agentId: agent.id,
        agentVersionId: version.id,
        idempotencyKey,
        status: 'QUEUED',
        input: body.input,
      })
      .onConflictDoNothing({ target: [agentExecutions.tenantId, agentExecutions.idempotencyKey] })
      .returning();
    const execution =
      inserted ??
      (await db.query.agentExecutions.findFirst({
        where: and(eq(agentExecutions.tenantId, tenantId), eq(agentExecutions.idempotencyKey, idempotencyKey)),
      }));
    if (!execution) throw new Error('execution vanished');

    let jobId: string | null = null;
    if (execution.status === 'QUEUED') {
      try {
        jobId = (await ctx.queue.enqueue({ kind: 'execution', tenantId, executionId: execution.id, idempotencyKey })).jobId;
      } catch (err) {
        req.log.error({ err }, 'enqueue failed');
        throw new HttpError(503, 'queue_unavailable', 'execution persisted but could not be enqueued; retry the same request', {
          execution_id: execution.id,
          idempotency_key: idempotencyKey,
        });
      }
    }
    return reply
      .status(inserted ? 202 : 200)
      .send({ execution: serialize(execution), deduplicated: !inserted, job_id: jobId });
  });

  app.get('/executions', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListQuery, req.query);
    const rows = await db.query.agentExecutions.findMany({
      where: and(
        eq(agentExecutions.tenantId, tenantId),
        q.status ? eq(agentExecutions.status, q.status) : undefined,
        q.agent_id ? eq(agentExecutions.agentId, q.agent_id) : undefined,
        q.task_run_id ? eq(agentExecutions.taskRunId, q.task_run_id) : undefined,
      ),
      orderBy: desc(agentExecutions.createdAt),
      limit: q.limit,
    });
    return { items: rows.map((r) => serialize(r)) };
  });

  /** GET /executions/:id - execution with its structured trace (section 17.1). */
  app.get('/executions/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const execution = await db.query.agentExecutions.findFirst({
      where: and(eq(agentExecutions.tenantId, tenantId), eq(agentExecutions.id, id)),
    });
    if (!execution) throw notFound('execution');
    const trace = await db.query.traces.findFirst({ where: eq(traces.executionId, execution.id) });
    const steps = trace
      ? await db.query.traceSteps.findMany({ where: eq(traceSteps.traceId, trace.id), orderBy: asc(traceSteps.sequence) })
      : [];
    return {
      execution: serialize(execution),
      trace: trace ? { ...serialize(trace), steps: steps.map((s) => serialize(s)) } : null,
    };
  });

  /** POST /executions/:id/cancel - QUEUED|RUNNING -> CANCELLED (also cancels the owning TaskRun). */
  app.post('/executions/:id/cancel', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const execution = await db.query.agentExecutions.findFirst({
      where: and(eq(agentExecutions.tenantId, tenantId), eq(agentExecutions.id, id)),
    });
    if (!execution) throw notFound('execution');
    if (execution.status === 'CANCELLED') return { execution: serialize(execution) };

    const now = new Date();
    const [cancelled] = await db
      .update(agentExecutions)
      .set({ status: 'CANCELLED', cancelRequestedAt: now, finishedAt: now, updatedAt: now })
      .where(and(eq(agentExecutions.id, execution.id), inArray(agentExecutions.status, allowedSources('CANCELLED'))))
      .returning();
    if (!cancelled) throw conflict(`cannot cancel execution in status ${execution.status}`);

    if (cancelled.taskRunId) {
      await db
        .update(taskRuns)
        .set({ status: 'CANCELLED', finishedAt: now, updatedAt: now })
        .where(and(eq(taskRuns.id, cancelled.taskRunId), inArray(taskRuns.status, allowedSources('CANCELLED'))));
    }
    return { execution: serialize(cancelled) };
  });

  // pause/resume require a checkpointing harness (section 7); not available in the stub runtime.
  for (const action of ['pause', 'resume'] as const) {
    app.post(`/executions/:id/${action}`, async (_req, reply) =>
      reply.status(501).send({ error: 'not_implemented', message: `POST /executions/:id/${action} is not implemented yet` }),
    );
  }
}
