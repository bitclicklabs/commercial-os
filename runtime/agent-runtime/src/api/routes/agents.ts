import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { agents, agentVersions } from '../../db/schema.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../../providers/anthropic-provider.js';
import { DEFAULT_GEMINI_MODEL } from '../../providers/gemini-provider.js';
import type { ApiContext } from '../context.js';
import { conflict, IdParams, notFound, parse, serialize, tenantOf } from '../http.js';
import { CreateAgentBody, ListAgentsQuery, PatchAgentBody } from '../schemas.js';

export async function agentRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  async function loadAgent(tenantId: string, id: string) {
    const agent = await db.query.agents.findFirst({ where: and(eq(agents.tenantId, tenantId), eq(agents.id, id)) });
    if (!agent) throw notFound('agent');
    return agent;
  }

  /** POST /agents - creates the agent and its version 1 (ACTIVE when the agent is ACTIVE). */
  app.post('/agents', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const body = parse(CreateAgentBody, req.body);
    const provider = body.version.model_provider ?? ctx.config.defaultModelProvider;
    const model =
      body.version.model ??
      (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : provider === 'gemini' ? (ctx.config.geminiModel ?? DEFAULT_GEMINI_MODEL) : 'stub-model');

    const existing = await db.query.agents.findFirst({
      where: and(eq(agents.tenantId, tenantId), eq(agents.name, body.name)),
    });
    if (existing) throw conflict(`agent "${body.name}" already exists`, { agent_id: existing.id });

    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          tenantId,
          name: body.name,
          description: body.description ?? null,
          role: body.role ?? null,
          riskLevel: body.risk_level,
          owner: body.owner ?? null,
          status: body.status,
        })
        .returning();
      if (!agent) throw new Error('insert agent failed');
      const [version] = await tx
        .insert(agentVersions)
        .values({
          tenantId,
          agentId: agent.id,
          version: 1,
          status: body.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
          model,
          modelProvider: provider,
          systemPrompt: body.version.system_prompt,
          configuration: body.version.configuration,
          skillRefs: body.version.skill_refs,
          harnessVersionId: body.version.harness_version_id ?? null,
          harnessRef: body.version.harness_ref ?? null,
          routerVersionId: body.version.router_version_id ?? null,
          toolPolicyId: body.version.tool_policy_id ?? null,
          memoryPolicyId: body.version.memory_policy_id ?? null,
          evaluationPolicyId: body.version.evaluation_policy_id ?? null,
          createdBy: body.created_by ?? null,
        })
        .returning();
      if (!version) throw new Error('insert agent version failed');
      const [updated] = await tx
        .update(agents)
        .set({ activeVersionId: body.status === 'ACTIVE' ? version.id : null })
        .where(eq(agents.id, agent.id))
        .returning();
      return { agent: updated ?? agent, version };
    });

    return reply.status(201).send({ agent: serialize(result.agent), version: serialize(result.version) });
  });

  app.get('/agents', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListAgentsQuery, req.query);
    const rows = await db.query.agents.findMany({
      where: and(eq(agents.tenantId, tenantId), q.status ? eq(agents.status, q.status) : undefined),
      orderBy: desc(agents.createdAt),
    });
    return { items: rows.map((r) => serialize(r)) };
  });

  app.get('/agents/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const agent = await loadAgent(tenantId, id);
    const versions = await db.query.agentVersions.findMany({
      where: eq(agentVersions.agentId, agent.id),
      orderBy: desc(agentVersions.version),
    });
    return { agent: serialize(agent), versions: versions.map((v) => serialize(v)) };
  });

  /** PATCH /agents/:id - metadata and lifecycle status. Versions are changed via promote/rollback (pending). */
  app.patch('/agents/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const body = parse(PatchAgentBody, req.body ?? {});
    const agent = await loadAgent(tenantId, id);
    if (agent.status === 'ARCHIVED') throw conflict('archived agents are immutable');
    if (body.status === 'ACTIVE' && !agent.activeVersionId) throw conflict('agent has no active version');

    const [updated] = await db
      .update(agents)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.risk_level !== undefined ? { riskLevel: body.risk_level } : {}),
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        ...(body.default_schedule_id !== undefined ? { defaultScheduleId: body.default_schedule_id } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id))
      .returning();
    return { agent: serialize(updated ?? agent) };
  });

  app.post('/agents/:id/pause', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const agent = await loadAgent(tenantId, id);
    if (agent.status === 'PAUSED') return { agent: serialize(agent) };
    if (agent.status !== 'ACTIVE') throw conflict(`cannot pause agent in status ${agent.status}`);
    const [updated] = await db
      .update(agents)
      .set({ status: 'PAUSED', updatedAt: new Date() })
      .where(and(eq(agents.id, agent.id), eq(agents.status, 'ACTIVE')))
      .returning();
    return { agent: serialize(updated ?? agent) };
  });

  // LLD section 8 endpoints that depend on the Evaluation Engine / Release Gate (MVP-2).
  for (const action of ['evaluate', 'promote', 'rollback'] as const) {
    app.post(`/agents/:id/${action}`, async (_req, reply) =>
      reply.status(501).send({ error: 'not_implemented', message: `POST /agents/:id/${action} is not implemented yet` }),
    );
  }
}
