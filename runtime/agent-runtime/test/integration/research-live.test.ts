/**
 * Research (LLD 5.2) + knowledge injection, LIVE: the Prospector in scout mode over one fair
 * URL (real web, renderer, Gemini, real Twenty) with at most 3 exhibitors, then checks that
 * each relevant exhibitor written to Twenty got a `research` record linked to its company and
 * signal, citing only visited URLs, and that the trace has the MEMORY_READ step.
 *
 * Opt-in: runs ONLY with RESEARCH_LIVE=1 (plus GEMINI_API_KEY, TWENTY_API_KEY, Twenty and
 * PostgreSQL reachable). Research adds no LLM call: the cost is the scout's own (no grounding
 * with `event_url`; one extraction at most and <= 3 decisions, ~0.01 EUR); the test fails
 * above RESEARCH_LIVE_MAX_EUR (0.05).
 *
 * Use its own database (DATABASE_URL=.../agentos_wt9_knowledge): the migration 0009 and the
 * knowledge seed are applied there, never to a shared database by surprise. Twenty writes are
 * idempotent (company by domain, signal by company+type+date+source, hypothesis by name); a
 * research is one per execution, company and type (a new run = new research, LLD 5.2). Nothing
 * is ever deleted. Own agent + MANUAL task (never scheduled).
 *
 *   RESEARCH_LIVE=1 RESEARCH_LIVE_EVENT_URL=https://www.gastronoma.es pnpm vitest run test/integration/research-live.test.ts
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/agents/source-ledger.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agents, traceSteps, traces } from '../../src/db/schema.js';
import { TWENTY_OBJECTS, twentyClientFromEnv, type TwentyResearch } from '../../src/integrations/twenty/index.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedKnowledge } from '../../src/seed/knowledge-seed.js';
import { desiredProspectorVersion, SCOUT_DEFAULT_INPUT } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const EVENT_URL = process.env.RESEARCH_LIVE_EVENT_URL ?? 'https://www.gastronoma.es';
const MAX_EUR = Number(process.env.RESEARCH_LIVE_MAX_EUR ?? '0.05');
const geminiKey = process.env.GEMINI_API_KEY ?? '';
const twenty = twentyClientFromEnv();

async function databaseReachable(url: string): Promise<boolean> {
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
if (process.env.RESEARCH_LIVE !== '1') reasons.push('RESEARCH_LIVE != 1');
if (!geminiKey) reasons.push('GEMINI_API_KEY not set');
if (reasons.length === 0 && !(twenty.isConfigured() && (await twenty.ping()))) reasons.push(`Twenty not available at ${twenty.baseUrl}`);
if (reasons.length === 0 && !(await databaseReachable(DATABASE_URL))) reasons.push('PostgreSQL not reachable');
const live = reasons.length === 0;
if (!live) console.warn(`[integration] Research live test skipped: ${reasons.join('; ')}`);

const TENANT = 'publiexpe';
const SUFFIX = Date.now().toString(36);
const AGENT_NAME = `Prospector Research (live test ${SUFFIX})`;
const TASK_NAME = `research-live-test-${SUFFIX}`;

describe.skipIf(!live)('Prospector scout writes research to Twenty (live)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  let processor: RunProcessor;
  const headers = { 'x-tenant-id': TENANT };

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    await seedKnowledge(handle.db, { tenantId: TENANT, createdBy: 'research-live-test' });
    queue = new MemoryRunQueue();
    processor = new RunProcessor(handle.db, createProviderRegistry({ geminiApiKey: geminiKey, geminiModel: process.env.GEMINI_MODEL }), undefined, createDefaultToolRegistry({ twenty }));
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: TENANT, defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it(
    `event_url ${EVENT_URL}: <= 3 exhibitors, one research per relevant exhibitor written, linked to company and signal`,
    async () => {
      const want = desiredProspectorVersion();
      const configuration = { ...want.configuration, scout: { ...(want.configuration.scout as object), task_name: TASK_NAME } };
      const agentRes = await app.inject({
        method: 'POST',
        url: '/agents',
        headers,
        payload: {
          name: AGENT_NAME,
          role: 'prospector',
          description: 'Agente de prueba en vivo de research + knowledge (tarea MANUAL, nunca programada).',
          version: { model: want.model, model_provider: want.modelProvider, system_prompt: want.systemPrompt, configuration, skill_refs: want.skillRefs },
        },
      });
      expect(agentRes.statusCode).toBe(201);
      const agentId = agentRes.json().agent.id as string;
      const taskRes = await app.inject({
        method: 'POST',
        url: '/tasks',
        headers,
        payload: { name: TASK_NAME, agent_id: agentId, default_input: SCOUT_DEFAULT_INPUT, schedule: { type: 'MANUAL' }, timeout_ms: 900_000 },
      });
      expect(taskRes.statusCode).toBe(201);
      const input = { event_url: EVENT_URL, max_exhibitors: 3, max_catalog_pages: 1, max_profile_lookups: 3, scout_time_budget_ms: 600_000 };
      const runRes = await app.inject({ method: 'POST', url: `/tasks/${taskRes.json().task.id}/run`, headers, payload: { input, scheduled_at: new Date().toISOString() } });
      expect(runRes.statusCode).toBe(202);
      for (const { job } of queue.drain()) await processor.process(job);

      const agent = await handle.db.query.agents.findFirst({ where: and(eq(agents.tenantId, TENANT), eq(agents.id, agentId)) });
      expect(agent).toBeDefined();
      const detail = (await app.inject({ method: 'GET', url: `/task-runs/${runRes.json().task_run.id}`, headers })).json() as { task_run: { execution_id: string; status: string; output: any } };
      const executionId = detail.task_run.execution_id;
      const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, executionId) });
      const steps = await handle.db.select().from(traceSteps).where(eq(traceSteps.traceId, trace!.id)).orderBy(traceSteps.sequence);
      const output = (detail.task_run.output ?? trace!.finalOutput) as any;
      const results = (output.events ?? []).flatMap((e: any) => e.results) as Array<Record<string, any>>;
      console.log(`[research-live] status=${detail.task_run.status} outcome=${output.outcome} cost=${JSON.stringify(output.cost)} counters=${JSON.stringify(output.counters)}`);
      console.log(`[research-live] results=${JSON.stringify(results.map((r) => ({ name: r.name, status: r.status, domain: r.domain, company_id: r.company_id, signal_id: r.signal_id, research_id: r.research_id, research_created: r.research_created, research_error: r.research_error })))}`);
      console.log(`[research-live] memory_read=${JSON.stringify(steps[0]?.output)}`);

      // Knowledge: the ACTIVE "prospeccion" entries were read and injected in the decisions.
      expect(steps[0]!.type).toBe('MEMORY_READ');
      if ((output.counters?.evaluated ?? 0) > 0) expect(steps[0]!.output).toMatchObject({ resolution: 'ok', injected: true });

      // Cost: the scout's own calls only (research adds none).
      expect(output.cost.eur).toBeLessThan(MAX_EUR);
      const llmCalls = steps.filter((s) => s.type === 'MODEL').length;
      expect(llmCalls).toBe(output.counters.llm_calls + steps.filter((s) => s.type === 'MODEL' && s.error).length);

      // Research: one per exhibitor that reached the signal step.
      const written = results.filter((r) => r.signal_id);
      expect(written.length).toBeGreaterThan(0);
      for (const r of written) {
        expect(r.research_error).toBeUndefined();
        const rec = await twenty.get<TwentyResearch>(TWENTY_OBJECTS.research, r.research_id, { depth: 0 });
        console.log(`[research-live] research ${r.name}: ${JSON.stringify(rec)}`);
        expect(rec).toMatchObject({ companyId: r.company_id, commercialSignalId: r.signal_id, agentExecutionId: executionId, researchType: 'COMPANY_PROFILE', tenantId: TENANT });
        const visited = new Set((output.sources?.visited ?? []) as string[]);
        for (const u of (rec as unknown as { sources: string[] }).sources) expect(visited.has(normalizeUrl(u) ?? u)).toBe(true);
      }
      expect(output.counters.research_created).toBe(written.length);
    },
    900_000,
  );
});
