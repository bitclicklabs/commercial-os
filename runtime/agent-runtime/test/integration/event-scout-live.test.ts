/**
 * Prospector scout mode, LIVE: real Gemini WITH Google Search grounding, real web
 * (fetch_url), real Twenty, trace in PostgreSQL.
 *
 * Runs only when GEMINI_API_KEY and TWENTY_API_KEY are set and both Twenty and the
 * Agent OS PostgreSQL answer; SKIP_LLM_TESTS=1 skips it. It spends real money: ONE
 * grounded call (Gemini 3.x bills each Google search it runs, $14 / 1,000) plus a few
 * flash calls; limited to 1 fair and at most 5 exhibitors.
 *
 * To avoid scheduling anything in the shared environment it does NOT run the seed:
 * it uses its own agent ("Prospector Scout (live test)") and a MANUAL task
 * ("event-scouting-live-test") in tenant `publiexpe`, created once and reused. Writes
 * to Twenty are idempotent (company by domain, signal by company+type+date+source,
 * hypothesis by name); every run adds an agentRunSummary. Nothing is ever deleted.
 *
 * The live agent is brought to the current seed configuration (a new version is added
 * when it changed, as the seed does), so a run uses the current limits and tool policy.
 *
 * Exhibitor domains (pagination + profiles): SCOUT_LIVE_DOMAINS=1 with
 * SCOUT_LIVE_EVENT_URL=https://www.gastronoma.es (and RENDERER_URL pointing to a renderer
 * with `max_pages`): `-t "exhibitor domains"`. Up to 60 exhibitors: ~0.2 EUR.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/agents/source-ledger.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agents, taskDefinitions, traces } from '../../src/db/schema.js';
import { TWENTY_OBJECTS, twentyClientFromEnv } from '../../src/integrations/twenty/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createProviderRegistry, GeminiProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { desiredProspectorVersion, SCOUT_DEFAULT_INPUT, upsertAgent } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const geminiKey = process.env.GEMINI_API_KEY ?? '';
const twenty = twentyClientFromEnv();

async function databaseReachable(url: string): Promise<boolean> {
  if (process.env.SKIP_DB_TESTS === '1') return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const reasons: string[] = [];
if (process.env.SKIP_LLM_TESTS === '1') reasons.push('SKIP_LLM_TESTS=1');
if (!geminiKey) reasons.push('GEMINI_API_KEY not set');
const twentyOk = reasons.length === 0 && twenty.isConfigured() && (await twenty.ping());
if (reasons.length === 0 && !twentyOk) reasons.push(`Twenty not available at ${twenty.baseUrl}`);
const dbOk = reasons.length === 0 && (await databaseReachable(DATABASE_URL));
if (reasons.length === 0 && !dbOk) reasons.push('Agent OS PostgreSQL not reachable');
const live = reasons.length === 0;
if (!live) console.warn(`[integration] Scout live test skipped: ${reasons.join('; ')}`);

const TENANT = 'publiexpe';
// Overridable: an archived agent is immutable, so a new pair of names gives a fresh agent + MANUAL task.
const AGENT_NAME = process.env.SCOUT_LIVE_AGENT_NAME ?? 'Prospector Scout (live test)';
const TASK_NAME = process.env.SCOUT_LIVE_TASK_NAME ?? 'event-scouting-live-test';

describe.skipIf(!live)('Prospector scout live (Gemini grounding + web + Twenty + PostgreSQL)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  let processor: RunProcessor;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    // Gemini with a fetch wrapper that keeps the raw grounded response in tmp/ (gitignored) for diagnosis.
    const base = createProviderRegistry({ geminiApiKey: geminiKey, geminiModel: process.env.GEMINI_MODEL });
    const dumpingGemini = new GeminiProvider({
      apiKey: geminiKey,
      defaultModel: process.env.GEMINI_MODEL,
      fetch: (async (url: string, init: RequestInit) => {
        const res = await fetch(url, init);
        const text = await res.text();
        if (String(init.body ?? '').includes('google_search')) {
          mkdirSync(new URL('../../tmp/', import.meta.url), { recursive: true });
          writeFileSync(new URL('../../tmp/scout-live-grounding.json', import.meta.url), text);
        }
        return new Response(text, { status: res.status, headers: res.headers });
      }) as unknown as typeof fetch,
    });
    processor = new RunProcessor(
      handle.db,
      (name) => (name === 'gemini' ? dumpingGemini : base(name)),
      undefined,
      createDefaultToolRegistry({ twenty }),
    );
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: TENANT, defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  interface ScoutOutput {
    outcome: string;
    counters: Record<string, number>;
    search?: { queries: string[]; sources: number; proposed: number; verification: string };
    events: Array<{
      name: string;
      date: string | null;
      location: string | null;
      status: string;
      verification: string;
      source_url: string | null;
      reason?: string;
      pages: unknown[];
      signal_id?: string;
      results: Array<{ name: string; domain: string | null; status: string; confidence?: number; signal_id?: string; company_id?: string; company_created?: boolean; hypothesis_id?: string; profile?: Record<string, unknown> }>;
    }>;
    discarded_events: unknown[];
    partial_reasons: string[];
    sources: { visited: string[]; grounded: Array<{ uri: string; domain: string | null }> };
    cost: { model: number; currency: string; eur: number; grounding?: number; grounding_units?: number };
    run_summary_id: string | null;
  }

  const headers = { 'x-tenant-id': TENANT };

  /** Own agent + MANUAL task (never scheduled), created once and reused. */
  async function ensureTask(): Promise<string> {
    const base = desiredProspectorVersion();
    const want = { ...base, configuration: { ...base.configuration, scout: { ...(base.configuration.scout as object), task_name: TASK_NAME } } };
    let agent = await handle.db.query.agents.findFirst({ where: and(eq(agents.tenantId, TENANT), eq(agents.name, AGENT_NAME)) });
    if (agent) {
      // Same as the seed: a new ACTIVE version when the configuration changed (versions are immutable).
      const up = await upsertAgent(handle.db, { tenantId: TENANT, createdBy: 'scout-live-test', name: AGENT_NAME, description: agent.description ?? '', role: agent.role ?? 'prospector', want, log: console.log });
      console.log(`[scout-live] agent version ${up.version} (${up.action})`);
    }
    if (!agent) {
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        headers,
        payload: {
          name: AGENT_NAME,
          role: 'prospector',
          description: 'Agente de prueba en vivo del modo scout (tarea MANUAL, nunca programada).',
          version: {
            model: want.model,
            model_provider: want.modelProvider,
            system_prompt: want.systemPrompt,
            configuration: want.configuration,
            skill_refs: want.skillRefs,
          },
        },
      });
      expect(res.statusCode).toBe(201);
      agent = res.json().agent;
    }
    let task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, TENANT), eq(taskDefinitions.name, TASK_NAME)) });
    if (!task) {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers,
        payload: { name: TASK_NAME, agent_id: agent!.id, default_input: SCOUT_DEFAULT_INPUT, schedule: { type: 'MANUAL' }, timeout_ms: 1_200_000 },
      });
      expect(res.statusCode).toBe(201);
      task = res.json().task;
    }
    return task!.id;
  }

  async function runScout(input: Record<string, unknown>, limits = { exhibitors: 5 }): Promise<{ detail: Record<string, any>; output: ScoutOutput }> {
    const taskId = await ensureTask();
    const runRes = await app.inject({ method: 'POST', url: `/tasks/${taskId}/run`, headers, payload: { input, scheduled_at: new Date().toISOString() } });
    expect(runRes.statusCode).toBe(202);
    for (const { job } of queue.drain()) await processor.process(job);
    const detail = (await app.inject({ method: 'GET', url: `/task-runs/${runRes.json().task_run.id}`, headers })).json();
    // A runtime deployed on the same database (pxos-runtime in Docker) may mark this in-process run as
    // "orphaned" (its job is not in BullMQ) while it is still running: the agent finishes and writes to
    // Twenty, but the task run ends FAILED without output. The agent output is still in the trace.
    let output = detail.task_run.output as ScoutOutput | null;
    const orphaned = !output && detail.task_run.error?.name === 'OrphanedRun' && detail.task_run.execution_id;
    if (orphaned) {
      const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, detail.task_run.execution_id) });
      output = ((trace?.finalOutput as { output?: ScoutOutput } | null)?.output ?? (trace?.finalOutput as ScoutOutput | null)) ?? null;
      console.warn('[scout-live] task run marked OrphanedRun by another runtime on the same database: reading the agent output from its trace');
    }
    if (!output) throw new Error(`task run without output: ${JSON.stringify(detail.task_run.error)}`);
    const report = {
      status: detail.task_run.status,
      outcome: output.outcome,
      counters: output.counters,
      search: output.search,
      events: output.events.map((e) => ({ ...e, results: e.results.map((r) => ({ name: r.name, domain: r.domain, status: r.status, confidence: r.confidence, profile: r.profile })) })),
      discarded_events: output.discarded_events,
      partial_reasons: output.partial_reasons,
      visited: output.sources.visited,
      grounded_domains: output.sources.grounded.map((g) => g.domain),
      cost: output.cost,
      task_run_cost: detail.task_run.cost,
      tokens: { input: detail.task_run.input_tokens, output: detail.task_run.output_tokens },
    };
    console.log('[scout-live] result', JSON.stringify(report, null, 2));

    if (!orphaned) expect(detail.task_run.status).toBe('COMPLETED');
    expect(['SUCCESS', 'PARTIAL']).toContain(output.outcome);
    expect(output.events.length).toBeLessThanOrEqual(1);
    expect(output.events.flatMap((e) => e.results).length).toBeLessThanOrEqual(limits.exhibitors);
    expect(output.cost.model).toBeGreaterThan(0);
    expect(output.run_summary_id).toBeTruthy();
    // Every signal written cites a URL the run really visited.
    const signalIds = output.events.flatMap((e) => [e.signal_id, ...e.results.map((r) => r.signal_id)]).filter((id): id is string => Boolean(id));
    for (const id of signalIds) {
      const sig = await twenty.get<{ sourceUrl: { primaryLinkUrl: string } }>(TWENTY_OBJECTS.commercialSignal, id);
      expect(output.sources.visited).toContain(normalizeUrl(sig!.sourceUrl.primaryLinkUrl));
    }
    return { detail, output };
  }

  it(
    'sector search with grounding: 1 real fair, max 5 exhibitors, only verified sources written to Twenty',
    async () => {
      const { output } = await runScout({ ...SCOUT_DEFAULT_INPUT, max_events: 1, max_exhibitors: 5 });
      expect(output.counters.grounding_calls).toBe(1);
    },
    600_000,
  );

  // No grounding cost: SCOUT_LIVE_EVENT_URL=https://... pnpm vitest run test/integration/event-scout-live.test.ts -t event_url
  it.skipIf(!process.env.SCOUT_LIVE_EVENT_URL)(
    'event_url mode (no grounding): reads the given fair page, max 5 exhibitors',
    async () => {
      const { output } = await runScout({ event_url: process.env.SCOUT_LIVE_EVENT_URL, ...(process.env.SCOUT_LIVE_EVENT_NAME ? { event_name: process.env.SCOUT_LIVE_EVENT_NAME } : {}), max_exhibitors: 5 });
      expect(output.counters.grounding_calls).toBe(0);
    },
    600_000,
  );

  // Paginated JS catalog + exhibitor profiles (tanda 5): SCOUT_LIVE_DOMAINS=1 SCOUT_LIVE_EVENT_URL=https://www.gastronoma.es
  it.skipIf(!process.env.SCOUT_LIVE_DOMAINS || !process.env.SCOUT_LIVE_EVENT_URL)(
    'exhibitor domains: paginated catalog, profiles of the relevant exhibitors, >= 5 real companies with domain, FAIR signal and PROPOSED hypothesis',
    async () => {
      const { output } = await runScout({ event_url: process.env.SCOUT_LIVE_EVENT_URL }, { exhibitors: 100 });
      expect(output.counters.grounding_calls).toBe(0);
      expect(output.counters.catalog_pages).toBeGreaterThanOrEqual(2);
      expect(output.counters.profile_lookups).toBeGreaterThan(0);
      const written = output.events.flatMap((e) => e.results).filter((r) => r.status === 'hypothesis_created' || r.status === 'hypothesis_existing');
      const withDomain = written.filter((r) => r.domain && (r.profile as { status?: string } | undefined)?.status === 'domain_resolved');
      const created: Array<{ name: string; domain: string; companyCreated: boolean }> = [];
      for (const r of withDomain) {
        const company = await twenty.get<{ name: string; domainName: { primaryLinkUrl: string } }>(TWENTY_OBJECTS.company, r.company_id!);
        const signal = await twenty.get<{ signalType: string; companyId: string }>(TWENTY_OBJECTS.commercialSignal, r.signal_id!);
        const hyp = await twenty.get<{ status: string; companyId: string }>(TWENTY_OBJECTS.commercialHypothesis, r.hypothesis_id!);
        expect(company!.domainName.primaryLinkUrl).toContain(r.domain!);
        expect(signal).toMatchObject({ signalType: 'FAIR', companyId: r.company_id });
        expect(hyp).toMatchObject({ status: 'PROPOSED', companyId: r.company_id });
        created.push({ name: company!.name, domain: r.domain!, companyCreated: r.company_created === true });
      }
      console.log('[scout-live] companies with domain from their profile', JSON.stringify(created, null, 2));
      expect(created.length).toBeGreaterThanOrEqual(5);
    },
    1_500_000,
  );
});
