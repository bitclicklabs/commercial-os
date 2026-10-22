/**
 * Idempotent seed of the Prospector agent and its tasks `daily-event-prospecting`
 * (v2: signals mode, the fairs QUALIFIED in Twenty; v1 carried a fixture fair) and
 * `weekly-event-scouting` (scout mode, discovery only since tanda 15: real fairs become NEW
 * FAIR signals). It also disables the RETIRED_TASKS (new version, enabled = false).
 *
 * - Agent "Prospector": created with version 1 if missing. If it exists and its
 *   ACTIVE version differs from the desired one (model, provider, prompt,
 *   configuration, skills, harness), a NEW version is added and activated; the previous
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
  type HarnessRef,
  type RetryPolicy,
  type ScheduleSpec,
  type SkillRef,
  type TaskDefinition,
} from '../db/schema.js';
import { PROSPECTOR_TOOLS } from '../agents/prospector-agent.js';
import { PROSPECTOR_SKILL_ID } from '../agents/prospector-prompt.js';
import { SCOUT_EXTRACT_SKILL_ID, SCOUT_SKILL_ID } from '../agents/event-scout-prompt.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import { DEFAULT_COMMERCIAL_HARNESS_NAME } from '../harness/config.js';
import { CATALOG_TOOL_IDS } from '../tools/catalog/catalog-tools.js';
import { MAX_EXPIRATIONS_PER_RUN, MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN, SIGNALS_DEFAULT_INPUT } from '../agents/signal-prospecting.js';

export const PROSPECTOR_AGENT_NAME = 'Prospector';
export const PROSPECTOR_TASK_NAME = 'daily-event-prospecting';
export const SCOUT_TASK_NAME = 'weekly-event-scouting';

export interface SeedOptions {
  tenantId: string;
  /**
   * Default input of the daily task. Omitted: `{ mode: 'signals' }` (v2, the fairs QUALIFIED in
   * Twenty). A direct-mode fixture (`{ event, exhibitors[] }`) is still accepted for demos/tests.
   */
  defaultInput?: Record<string, unknown>;
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
  /** Retired tasks (RETIRED_TASKS): disabled with a new version, never deleted. */
  retiredTasks: Array<{ name: string; action: 'disabled' | 'already_disabled' | 'not_found'; version?: number }>;
}

/**
 * Tasks the seed switches off (enabled = false, new TaskDefinitionVersion). Nothing is deleted.
 * - `event-scouting-live-test-muxyo7gz`: MANUAL task left behind by a live scout test
 *   (test/integration/event-scout-live.test.ts) in tenant `publiexpe`.
 */
export const RETIRED_TASKS = ['event-scouting-live-test-muxyo7gz'] as const;

export function desiredProspectorVersion() {
  return {
    model: 'gemini-flash-latest',
    modelProvider: 'gemini',
    // MVP-1: the prompts are database skills (skillRefs, ACTIVE version); empty here so the
    // version has one source of truth. Fallback without the skills: the code constants.
    systemPrompt: '',
    configuration: {
      implementation: 'prospector',
      stage: 'PROSPECTOR',
      task_name: PROSPECTOR_TASK_NAME,
      tool_policy: {
        // Catalog tools (READ, contract v1.1): exposed only with CATALOG_ENABLED=true and used only
        // when the resolved skill asks for real products (src/agents/prospector-catalog.ts); the
        // ACTIVE skill does not, so behaviour is unchanged until a catalog skill is activated.
        allow: [...PROSPECTOR_TOOLS, ...CATALOG_TOOL_IDS],
        max_risk_level: 'LOW_WRITE',
        // Direct: 50 exhibitors x (upsert + signal + research + hypothesis, or find) + summary.
        // Scout: 3 fairs x 100 exhibitors x 4 writes + fetches + renders + profiles + event signals + summary.
        // The real limit of a scout run is its time budget (scout.time_budget_ms).
        // + catalog: up to 3 searches + 3 sheets per written hypothesis (capped per tool below).
        // + signals mode: 1 listing + up to 50 expirations before the directed scout.
        // + lead time (tanda 18): 1 hypothesis listing + up to 50 hypothesis expirations + 1 signal note.
        // + domain resolver (tanda 20): 1 find_company per relevant exhibitor without a domain (up to 300)
        //   + up to 50 searches x 4 page reads (fetch_url / render_url).
        max_calls_per_execution: 3_012,
        // fetch_url: 18 pages/PDFs + 3 grounding redirects (+1) + 100 profiles + 100 domain checks
        //   + domain resolver: DOMAIN_RESOLVER_MAX_PER_RUN_CAP (50) x DOMAIN_RESOLVER_PAGES_PER_LOOKUP (4);
        // render_url: 4 catalog renders (+1 retry, +1 older-renderer retry each) + 100 profiles.
        max_calls_per_tool: {
          fetch_url: 430,
          render_url: 115,
          catalog_search_products: 300,
          catalog_get_product: 300,
          catalog_estimate_customization: 20,
          catalog_list_families: 5,
          catalog_describe: 5,
          list_event_signals: 2,
          expire_signal: MAX_EXPIRATIONS_PER_RUN,
          list_hypotheses_for_expiry: 2,
          expire_hypothesis: MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN,
          create_crm_task: 2,
          // Tanda 21: one note per qualified company signal without a verified website.
          create_signal_note: 2,
        },
      },
      // Knowledge layer (LLD 6.4): ACTIVE entries of these domains go into the per-exhibitor decision prompt.
      knowledge_domains: ['prospeccion'],
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
        max_profile_lookups: 100,
        profile_concurrency: 2,
        time_budget_ms: 1_200_000,
        capture_json: true,
        max_redirect_resolutions: 3,
        event_signal_confidence: 0.5,
        verify_unsourced_by_fetch: true,
        // Tanda 21: company signals (news of openings, funding rounds, anniversaries) per sector and run.
        max_company_signals_per_sector: 3,
      },
    } as Record<string, unknown>,
    skillRefs: [{ name: PROSPECTOR_SKILL_ID }, { name: SCOUT_SKILL_ID }, { name: SCOUT_EXTRACT_SKILL_ID }] as SkillRef[],
  };
}

/**
 * Daily task v2 (tanda 15): signals mode. No fair inside the input: the Prospector works the fairs
 * QUALIFIED in Twenty (src/agents/signal-prospecting.ts). Same timeout as the weekly scouting: the
 * directed scout keeps its time budget (scout.time_budget_ms, 20 min) plus the writes.
 */
export function desiredTask(defaultInput: Record<string, unknown> = { ...SIGNALS_DEFAULT_INPUT }) {
  return {
    description:
      'Prospección diaria de las ferias calificadas en Twenty: el Prospector (modo señales) caduca (EXPIRED) las señales de feria con fecha pasada y las hipótesis PROPOSED de ferias a menos de LEADTIME_MIN_DAYS días, elige la señal QUALIFIED dentro de la ventana de lead time (45–210 días por defecto) trabajada hace más tiempo y peina su catálogo de expositores (scout dirigido: empresa, señal, research e hipótesis PROPOSED de los relevantes); sin ninguna calificada, termina SKIPPED.',
    defaultInput,
    schedule: { type: 'CRON', expression: '0 8 * * *' },
    timezone: 'Europe/Madrid',
    enabled: true,
    priority: 0,
    maxConcurrency: 1,
    retryPolicy: { max_attempts: 1, backoff_ms: 0 },
    timeoutMs: 1_800_000,
  };
}

/** Sector of the weekly scouting (PubliEXPE's main sector); also the input of the live scout tests. */
export const SCOUT_DEFAULT_INPUT = { sector: 'alimentación y bebidas', region: 'España', horizon_months: 6 };

/**
 * Weekly scouting v2 (tanda 15): discovery only. It records each verified fair as a NEW FAIR signal
 * (URL and date) and never combs exhibitors: a person qualifies first, then the daily run or the
 * trigger on qualification comb the list.
 */
/**
 * Sectors of the weekly scouting (tanda 21, PM decision v1). Editable without code: it is the task's
 * default input (a change through the seed is a new TaskDefinitionVersion; by hand, the task API).
 * Without `sectors` the scout falls back to `sector`.
 */
export const SCOUT_SECTORS = [
  'alimentación y bebidas',
  'horeca y food service',
  'farmacia y salud',
  'cosmética y belleza',
  'franquicias y retail',
  'industria y packaging',
] as const;

/**
 * Weekly scouting v3 (tanda 21): the six sectors in series (the start rotates every week) and, per
 * sector, company signals (openings, funding rounds, anniversaries) besides the fairs. Discovery only.
 */
export const SCOUT_WEEKLY_INPUT = { sectors: [...SCOUT_SECTORS], region: 'España', horizon_months: 6, discover_only: true, company_signals: true };

export function desiredScoutTask() {
  return {
    description:
      'Descubrimiento semanal de ferias reales y señales de empresa: el Prospector (modo scout, solo descubrimiento) recorre en serie la lista de sectores de la entrada (sectors; el inicio rota cada semana; si se agota el presupuesto de tiempo, los sectores restantes quedan sin correr y se cuentan), busca con Google (grounding de Gemini) ferias próximas de cada sector, verifica una página de cada una y la registra en Twenty como señal FAIR (NEW) con su URL y fecha, sin peinar expositores; por sector, además, busca noticias de los últimos 60 días de aperturas, rondas de financiación y aniversarios de empresas y crea señales NEW «<empresa>: <qué pasó> — apertura|financiación|aniversario» con la noticia verificada por descarga. Al calificarse, la feria se peina y la empresa se evalúa directamente.',
    defaultInput: { ...SCOUT_WEEKLY_INPUT },
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
  const retiredTasks: SeedResult['retiredTasks'] = [];
  for (const name of RETIRED_TASKS) {
    const r = await disableTask(db, { tenantId, createdBy, name, reason: 'retired by seed (tanda 15): orphan live-test task' });
    retiredTasks.push({ name, ...r });
    log(`task ${name}: ${r.action}${r.version ? ` (version ${r.version})` : ''}`);
  }

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
    retiredTasks,
  };
}

/**
 * Switches a task off (`enabled = false`) with a new TaskDefinitionVersion snapshot. Idempotent:
 * an already disabled or missing task is left as it is. Never deletes or archives anything.
 */
export async function disableTask(
  db: Db,
  args: { tenantId: string; createdBy: string; name: string; reason: string },
): Promise<{ action: 'disabled' | 'already_disabled' | 'not_found'; version?: number }> {
  const { tenantId, createdBy, name, reason } = args;
  return db.transaction(async (tx) => {
    const existing = await tx.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, name), ne(taskDefinitions.status, 'ARCHIVED')),
    });
    if (!existing) return { action: 'not_found' as const };
    if (!existing.enabled) return { action: 'already_disabled' as const, version: existing.currentVersion };
    const nextVersion = existing.currentVersion + 1;
    const [updated] = await tx
      .update(taskDefinitions)
      .set({ enabled: false, currentVersion: nextVersion, updatedBy: createdBy, updatedAt: new Date() })
      .where(eq(taskDefinitions.id, existing.id))
      .returning();
    if (!updated) throw new Error('disable task failed');
    const [version] = await tx
      .insert(taskDefinitionVersions)
      .values({ tenantId, taskDefinitionId: updated.id, version: nextVersion, agentId: updated.agentId, definition: taskSnapshot(updated), changeReason: reason, createdBy })
      .returning();
    if (!version) throw new Error('insert task version failed');
    await tx.update(taskDefinitions).set({ currentVersionId: version.id }).where(eq(taskDefinitions.id, updated.id));
    return { action: 'disabled' as const, version: nextVersion };
  });
}

export interface AgentVersionSpec {
  model: string;
  modelProvider: string;
  systemPrompt: string;
  configuration: Record<string, unknown>;
  skillRefs: SkillRef[];
  /** Harness of the version; omitted = the seed default (`default-commercial`, ACTIVE version); null = none. */
  harnessRef?: HarnessRef | null;
}

/** Harness the seeded agent versions reference (no version: they follow its ACTIVE one). */
export const SEED_HARNESS_REF: HarnessRef = { name: DEFAULT_COMMERCIAL_HARNESS_NAME };

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
  const { tenantId, createdBy, name, description, role, log } = args;
  const want = { ...args.want, harnessRef: args.want.harnessRef === undefined ? SEED_HARNESS_REF : args.want.harnessRef };
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
      same(active.skillRefs, want.skillRefs) &&
      same(active.harnessRef ?? null, want.harnessRef);
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
