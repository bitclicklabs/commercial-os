/**
 * Idempotent seed of the Prospector agent and the `daily-event-prospecting` task.
 *
 * - Agent "Prospector": created with version 1 if missing. If it exists and its
 *   ACTIVE version differs from the desired one (model, provider, prompt,
 *   configuration, skills), a NEW version is added and activated; the previous
 *   ACTIVE version becomes DEPRECATED (versions are immutable, nothing is deleted).
 * - TaskDefinition "daily-event-prospecting": created with version 1 if missing; if
 *   it differs, it is updated and a new TaskDefinitionVersion snapshot is written.
 * Running it twice in a row changes nothing the second time.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, agentVersions, taskDefinitions, taskDefinitionVersions, type SkillRef, type TaskDefinition } from '../db/schema.js';
import { PROSPECTOR_TOOLS } from '../agents/prospector-agent.js';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SKILL_VERSION, PROSPECTOR_SYSTEM_PROMPT } from '../agents/prospector-prompt.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';

export const PROSPECTOR_AGENT_NAME = 'Prospector';
export const PROSPECTOR_TASK_NAME = 'daily-event-prospecting';

export interface SeedOptions {
  tenantId: string;
  /** Default input of the task (the demo fixture). */
  defaultInput: Record<string, unknown>;
  createdBy?: string;
  log?: (msg: string) => void;
}

export interface SeedResult {
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  agentAction: 'created' | 'version_added' | 'unchanged';
  taskId: string;
  taskVersion: number;
  taskAction: 'created' | 'updated' | 'unchanged';
}

export function desiredProspectorVersion() {
  return {
    model: 'gemini-flash-latest',
    modelProvider: 'gemini',
    systemPrompt: PROSPECTOR_SYSTEM_PROMPT,
    configuration: {
      implementation: 'prospector',
      stage: 'PROSPECTOR',
      task_name: PROSPECTOR_TASK_NAME,
      tool_policy: {
        allow: [...PROSPECTOR_TOOLS],
        max_risk_level: 'LOW_WRITE',
        // 50 exhibitors x (upsert + signal + hypothesis, or find) + summary.
        max_calls_per_execution: 210,
      },
      min_confidence: 0.5,
      usd_to_eur: DEFAULT_USD_TO_EUR,
      max_output_tokens: 4096,
      model_options: { thinking_level: 'low' },
    } as Record<string, unknown>,
    skillRefs: [{ skill_id: PROSPECTOR_SKILL_ID, version: PROSPECTOR_SKILL_VERSION }] as SkillRef[],
  };
}

export function desiredTask(defaultInput: Record<string, unknown>) {
  return {
    description:
      'Prospección diaria a partir de los expositores de un evento: el Prospector evalúa cada expositor con el LLM y registra en Twenty empresa, señal e hipótesis (PROPOSED) de los relevantes.',
    defaultInput,
    schedule: { type: 'CRON', expression: '0 8 * * *' },
    timezone: 'Europe/Madrid',
    enabled: true,
    priority: 0,
    maxConcurrency: 1,
    retryPolicy: { max_attempts: 1, backoff_ms: 0 },
    timeoutMs: 900_000,
  };
}

/** JSON comparison independent of key order (jsonb does not preserve it). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

function taskSnapshot(task: TaskDefinition): Record<string, unknown> {
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

export async function seedProspector(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? (() => {});
  const { tenantId } = opts;
  const createdBy = opts.createdBy ?? 'seed';
  const want = desiredProspectorVersion();

  // ---------------------------------------------------------------- agent
  const agentState = await db.transaction(async (tx) => {
    const existing = await tx.query.agents.findFirst({ where: and(eq(agents.tenantId, tenantId), eq(agents.name, PROSPECTOR_AGENT_NAME)) });
    if (!existing) {
      const [agent] = await tx
        .insert(agents)
        .values({
          tenantId,
          name: PROSPECTOR_AGENT_NAME,
          description: 'Evalúa expositores de eventos y propone hipótesis de merchandising para PubliEXPE.',
          role: 'prospector',
          riskLevel: 'LOW',
          owner: createdBy,
          status: 'ACTIVE',
        })
        .returning();
      if (!agent) throw new Error('insert agent failed');
      const [version] = await tx
        .insert(agentVersions)
        .values({ tenantId, agentId: agent.id, version: 1, status: 'ACTIVE', ...want, createdBy })
        .returning();
      if (!version) throw new Error('insert agent version failed');
      await tx.update(agents).set({ activeVersionId: version.id, updatedAt: new Date() }).where(eq(agents.id, agent.id));
      return { agentId: agent.id, versionId: version.id, version: 1, action: 'created' as const };
    }

    if (existing.status === 'ARCHIVED') throw new Error(`agent "${PROSPECTOR_AGENT_NAME}" is ARCHIVED in tenant ${tenantId}; archived agents are immutable`);
    const active = existing.activeVersionId
      ? await tx.query.agentVersions.findFirst({ where: eq(agentVersions.id, existing.activeVersionId) })
      : undefined;
    const upToDate =
      active &&
      active.model === want.model &&
      active.modelProvider === want.modelProvider &&
      active.systemPrompt === want.systemPrompt &&
      same(active.configuration, want.configuration) &&
      same(active.skillRefs, want.skillRefs);
    if (active && upToDate) {
      if (existing.status === 'DRAFT') await tx.update(agents).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(agents.id, existing.id));
      return { agentId: existing.id, versionId: active.id, version: active.version, action: 'unchanged' as const };
    }

    const [last] = await tx.query.agentVersions.findMany({
      where: eq(agentVersions.agentId, existing.id),
      orderBy: desc(agentVersions.version),
      limit: 1,
    });
    const nextVersion = (last?.version ?? 0) + 1;
    const [version] = await tx
      .insert(agentVersions)
      .values({ tenantId, agentId: existing.id, version: nextVersion, status: 'ACTIVE', ...want, createdBy })
      .returning();
    if (!version) throw new Error('insert agent version failed');
    await tx
      .update(agentVersions)
      .set({ status: 'DEPRECATED' })
      .where(and(eq(agentVersions.agentId, existing.id), eq(agentVersions.status, 'ACTIVE'), ne(agentVersions.id, version.id)));
    await tx
      .update(agents)
      .set({
        activeVersionId: version.id,
        ...(existing.status === 'DRAFT' ? { status: 'ACTIVE' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, existing.id));
    if (existing.status === 'PAUSED') log(`agent "${PROSPECTOR_AGENT_NAME}" is PAUSED: the new version is active but the agent stays paused`);
    return { agentId: existing.id, versionId: version.id, version: nextVersion, action: 'version_added' as const };
  });
  log(`agent ${PROSPECTOR_AGENT_NAME}: ${agentState.action} (id ${agentState.agentId}, version ${agentState.version})`);

  // ----------------------------------------------------------------- task
  const wantTask = desiredTask(opts.defaultInput);
  const taskState = await db.transaction(async (tx) => {
    const existing = await tx.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME), ne(taskDefinitions.status, 'ARCHIVED')),
    });
    if (!existing) {
      const [created] = await tx
        .insert(taskDefinitions)
        .values({ tenantId, name: PROSPECTOR_TASK_NAME, agentId: agentState.agentId, ...wantTask, currentVersion: 1, createdBy, updatedBy: createdBy })
        .returning();
      if (!created) throw new Error('insert task failed');
      const [version] = await tx
        .insert(taskDefinitionVersions)
        .values({ tenantId, taskDefinitionId: created.id, version: 1, agentId: created.agentId, definition: taskSnapshot(created), changeReason: 'created by seed', createdBy })
        .returning();
      if (!version) throw new Error('insert task version failed');
      await tx.update(taskDefinitions).set({ currentVersionId: version.id }).where(eq(taskDefinitions.id, created.id));
      return { taskId: created.id, version: 1, action: 'created' as const };
    }

    const current = {
      description: existing.description,
      defaultInput: existing.defaultInput,
      schedule: existing.schedule,
      timezone: existing.timezone,
      enabled: existing.enabled,
      priority: existing.priority,
      maxConcurrency: existing.maxConcurrency,
      retryPolicy: existing.retryPolicy,
      timeoutMs: existing.timeoutMs,
    };
    if (existing.agentId === agentState.agentId && same(current, wantTask)) {
      return { taskId: existing.id, version: existing.currentVersion, action: 'unchanged' as const };
    }
    const nextVersion = existing.currentVersion + 1;
    const [updated] = await tx
      .update(taskDefinitions)
      .set({ ...wantTask, agentId: agentState.agentId, currentVersion: nextVersion, updatedBy: createdBy, updatedAt: new Date() })
      .where(eq(taskDefinitions.id, existing.id))
      .returning();
    if (!updated) throw new Error('update task failed');
    const [version] = await tx
      .insert(taskDefinitionVersions)
      .values({ tenantId, taskDefinitionId: updated.id, version: nextVersion, agentId: updated.agentId, definition: taskSnapshot(updated), changeReason: 'updated by seed', createdBy })
      .returning();
    if (!version) throw new Error('insert task version failed');
    await tx.update(taskDefinitions).set({ currentVersionId: version.id }).where(eq(taskDefinitions.id, updated.id));
    return { taskId: updated.id, version: nextVersion, action: 'updated' as const };
  });
  log(`task ${PROSPECTOR_TASK_NAME}: ${taskState.action} (id ${taskState.taskId}, version ${taskState.version})`);

  return {
    agentId: agentState.agentId,
    agentVersionId: agentState.versionId,
    agentVersion: agentState.version,
    agentAction: agentState.action,
    taskId: taskState.taskId,
    taskVersion: taskState.version,
    taskAction: taskState.action,
  };
}
