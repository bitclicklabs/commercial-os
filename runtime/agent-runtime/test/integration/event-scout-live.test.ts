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
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/agents/source-ledger.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agents, taskDefinitions } from '../../src/db/schema.js';
import { TWENTY_OBJECTS, twentyClientFromEnv } from '../../src/integrations/twenty/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createProviderRegistry, GeminiProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { desiredProspectorVersion, SCOUT_DEFAULT_INPUT } from '../../src/seed/prospector-seed.js';
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
const AGENT_NAME = 'Prospector Scout (live test)';
const TASK_NAME = 'event-scouting-live-test';

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
      results: Array<{ name: string; domain: string | null; status: string; confidence?: number; signal_id?: string }>;
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
    const want = desiredProspectorVersion();
    let agent = await handle.db.query.agents.findFirst({ where: and(eq(agents.tenantId, TENANT), eq(agents.name, AGENT_NAME)) });
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
            configuration: { ...want.configuration, scout: { ...(want.configuration.scout as object), task_name: TASK_NAME } },
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

  async function runScout(input: Record<string, unknown>): Promise<{ detail: Record<string, any>; output: ScoutOutput }> {
    const taskId = await ensureTask();
    const runRes = await app.inject({ method: 'POST', url: `/tasks/${taskId}/run`, headers, payload: { input, scheduled_at: new Date().toISOString() } });
    expect(runRes.statusCode).toBe(202);
    for (const { job } of queue.drain()) await processor.process(job);
    const detail = (await app.inject({ method: 'GET', url: `/task-runs/${runRes.json().task_run.id}`, headers })).json();
    const output = detail.task_run.output as ScoutOutput;
    const report = {
      status: detail.task_run.status,
      outcome: output.outcome,
      counters: output.counters,
      search: output.search,
      events: output.events.map((e) => ({ ...e, results: e.results.map((r) => ({ name: r.name, domain: r.domain, status: r.status, confidence: r.confidence })) })),
      discarded_events: output.discarded_events,
      partial_reasons: output.partial_reasons,
      visited: output.sources.visited,
      grounded_domains: output.sources.grounded.map((g) => g.domain),
      cost: output.cost,
      task_run_cost: detail.task_run.cost,
      tokens: { input: detail.task_run.input_tokens, output: detail.task_run.output_tokens },
    };
    console.log('[scout-live] result', JSON.stringify(report, null, 2));

    expect(detail.task_run.status).toBe('COMPLETED');
    expect(['SUCCESS', 'PARTIAL']).toContain(output.outcome);
    expect(output.events.length).toBeLessThanOrEqual(1);
    expect(output.events.flatMap((e) => e.results).length).toBeLessThanOrEqual(5);
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
});
