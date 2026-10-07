/**
 * Idempotent seed of the Prospector agent and its tasks `daily-event-prospecting`
 * (direct mode, fixture input) and `weekly-event-scouting` (scout mode: real fairs).
 *
 * - Agent "Prospector": created with version 1 if missing. If it exists and its
 *   ACTIVE version differs from the desired one (model, provider, prompt,
 *   configuration, skills), a NEW version is added and activated; the previous
 *   ACTIVE version becomes DEPRECATED (versions are immutable, nothing is deleted).
 * - Each TaskDefinition: created with version 1 if missing; if it differs, it is
 *   updated and a new TaskDefinitionVersion snapshot is written.
 * Running it twice in a row changes nothing the second time.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agents,
  agentVersions,
  taskDefinitions,
  taskDefinitionVersions,
  type RetryPolicy,
  type ScheduleSpec,
  type SkillRef,
  type TaskDefinition,
} from '../db/schema.js';
import { PROSPECTOR_TOOLS } from '../agents/prospector-agent.js';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SKILL_VERSION, PROSPECTOR_SYSTEM_PROMPT } from '../agents/prospector-prompt.js';
import { SCOUT_SKILL_ID, SCOUT_SKILL_VERSION } from '../agents/event-scout-prompt.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';

export const PROSPECTOR_AGENT_NAME = 'Prospector';
export const PROSPECTOR_TASK_NAME = 'daily-event-prospecting';
export const SCOUT_TASK_NAME = 'weekly-event-scouting';

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
  scoutTaskId: string;
  scoutTaskVersion: number;
  scoutTaskAction: 'created' | 'updated' | 'unchanged';
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
        // Direct: 50 exhibitors x (upsert + signal + hypothesis, or find) + summary.
        // Scout: 3 fairs x 100 exhibitors x 3 writes + fetches + renders + profiles + event signals + summary.
        // The real limit of a scout run is its time budget (scout.time_budget_ms).
        max_calls_per_execution: 1_500,
        // fetch_url: 18 pages/PDFs + 3 grounding redirects (+1) + 100 profiles + 100 domain checks;
        // render_url: 4 catalog renders (+1 retry, +1 older-renderer retry each) + 100 profiles.
        max_calls_per_tool: { fetch_url: 230, render_url: 115 },
      },
      min_confidence: 0.5,
      usd_to_eur: DEFAULT_USD_TO_EUR,
      max_output_tokens: 4096,
      model_options: { thinking_level: 'low' },
      scout: {
        task_name: SCOUT_TASK_NAME,
        max_events: 3,
        max_exhibitors_per_event: 100,
        max_fetches: 18,
        max_pages_per_event: 3,
        max_renders: 4,
        max_pdfs_per_event: 2,
        max_catalog_pages: 10,
        max_profile_lookups: 60,
        profile_concurrency: 2,
        time_budget_ms: 1_200_000,
        capture_json: true,
        max_redirect_resolutions: 3,
        event_signal_confidence: 0.5,
        verify_unsourced_by_fetch: true,
      },
    } as Record<string, unknown>,
    skillRefs: [
      { skill_id: PROSPECTOR_SKILL_ID, version: PROSPECTOR_SKILL_VERSION },
      { skill_id: SCOUT_SKILL_ID, version: SCOUT_SKILL_VERSION },
    ] as SkillRef[],
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

/** Default input of the weekly scouting task (PubliEXPE's main sector). */
export const SCOUT_DEFAULT_INPUT = { sector: 'alimentación y bebidas', region: 'España', horizon_months: 6 };

export function desiredScoutTask() {
  return {
    description:
      'Exploración semanal de ferias reales: el Prospector (modo scout) busca con Google (grounding de Gemini) ferias próximas del sector, descarga su página de expositores, extrae los expositores del texto y registra en Twenty empresa, señal e hipótesis (PROPOSED) de los relevantes; sin lista de expositores, registra la feria como señal FAIR.',
    defaultInput: { ...SCOUT_DEFAULT_INPUT },
    schedule: { type: 'CRON', expression: '30 7 * * 1' },
    timezone: 'Europe/Madrid',
    enabled: true,
    priority: 0,
    maxConcurrency: 1,
    retryPolicy: { max_attempts: 1, backoff_ms: 0 },
    timeoutMs: 1_800_000,
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
  const agentState = await upsertAgent(db, {
    tenantId,
    createdBy,
    name: PROSPECTOR_AGENT_NAME,
    description: 'Evalúa expositores de eventos y propone hipótesis de merchandising para PubliEXPE.',
    role: 'prospector',
    want,
    log,
  });
  log(`agent ${PROSPECTOR_AGENT_NAME}: ${agentState.action} (id ${agentState.agentId}, version ${agentState.version})`);

  // ---------------------------------------------------------------- tasks
  const daily = await upsertTask(db, { tenantId, createdBy, agentId: agentState.agentId, name: PROSPECTOR_TASK_NAME, want: desiredTask(opts.defaultInput) });
  log(`task ${PROSPECTOR_TASK_NAME}: ${daily.action} (id ${daily.taskId}, version ${daily.version})`);
  const scout = await upsertTask(db, { tenantId, createdBy, agentId: agentState.agentId, name: SCOUT_TASK_NAME, want: desiredScoutTask() });
  log(`task ${SCOUT_TASK_NAME}: ${scout.action} (id ${scout.taskId}, version ${scout.version})`);

  return {
    agentId: agentState.agentId,
    agentVersionId: agentState.versionId,
    agentVersion: agentState.version,
    agentAction: agentState.action,
    taskId: daily.taskId,
    taskVersion: daily.version,
    taskAction: daily.action,
    scoutTaskId: scout.taskId,
    scoutTaskVersion: scout.version,
    scoutTaskAction: scout.action,
  };
}

export interface AgentVersionSpec {
  model: string;
  modelProvider: string;
  systemPrompt: string;
  configuration: Record<string, unknown>;
  skillRefs: SkillRef[];
}

export interface UpsertAgentResult {
  agentId: string;
  versionId: string;
  version: number;
  action: 'created' | 'version_added' | 'unchanged';
}

/**
 * Creates the agent with version 1 if missing; if its ACTIVE version differs from `want`,
 * adds a new ACTIVE version and deprecates the previous one (versions are immutable).
 */
export async function upsertAgent(
  db: Db,
  args: { tenantId: string; createdBy: string; name: string; description: string; role: string; want: AgentVersionSpec; log: (msg: string) => void },
): Promise<UpsertAgentResult> {
  const { tenantId, createdBy, name, description, role, want, log } = args;
  return db.transaction(async (tx) => {
    const existing = await tx.query.agents.findFirst({ where: and(eq(agents.tenantId, tenantId), eq(agents.name, name)) });
    if (!existing) {
      const [agent] = await tx
        .insert(agents)
        .values({
          tenantId,
          name,
          description,
          role,
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

    if (existing.status === 'ARCHIVED') throw new Error(`agent "${name}" is ARCHIVED in tenant ${tenantId}; archived agents are immutable`);
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
    if (existing.status === 'PAUSED') log(`agent "${name}" is PAUSED: the new version is active but the agent stays paused`);
    return { agentId: existing.id, versionId: version.id, version: nextVersion, action: 'version_added' as const };
  });
}

export interface TaskSpec {
  description: string;
  defaultInput: Record<string, unknown>;
  schedule: ScheduleSpec;
  timezone: string;
  enabled: boolean;
  priority: number;
  maxConcurrency: number;
  retryPolicy: RetryPolicy;
  timeoutMs: number;
}

/** Creates or updates one TaskDefinition (with a TaskDefinitionVersion snapshot per change). */
export async function upsertTask(
  db: Db,
  args: { tenantId: string; createdBy: string; agentId: string; name: string; want: TaskSpec },
): Promise<{ taskId: string; version: number; action: 'created' | 'updated' | 'unchanged' }> {
  const { tenantId, createdBy, agentId, name, want } = args;
  return db.transaction(async (tx) => {
    const existing = await tx.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, name), ne(taskDefinitions.status, 'ARCHIVED')),
    });
    if (!existing) {
      const [created] = await tx
        .insert(taskDefinitions)
        .values({ tenantId, name, agentId, ...want, currentVersion: 1, createdBy, updatedBy: createdBy })
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
    if (existing.agentId === agentId && same(current, want)) {
      return { taskId: existing.id, version: existing.currentVersion, action: 'unchanged' as const };
    }
    const nextVersion = existing.currentVersion + 1;
    const [updated] = await tx
      .update(taskDefinitions)
      .set({ ...want, agentId, currentVersion: nextVersion, updatedBy: createdBy, updatedAt: new Date() })
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
}
