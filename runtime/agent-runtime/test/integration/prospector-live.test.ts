/**
 * Prospector end to end, LIVE: seed -> POST /tasks/:id/run -> RunProcessor ->
 * ProspectorAgent -> real Gemini -> real Twenty -> trace in PostgreSQL.
 *
 * Runs only when GEMINI_API_KEY and TWENTY_API_KEY are set and both Twenty and the
 * Agent OS PostgreSQL answer; set SKIP_LLM_TESTS=1 to skip it anyway (it spends real
 * Gemini tokens: ~4 flash calls, well under 0.01 EUR).
 *
 * It uses the demo fixture (test/fixtures/feria-ejemplo.json) in tenant `publiexpe`:
 * these are the project's demo records, NOT test-prefixed. All writes are idempotent
 * (company by domain, signal by company+type+date+source, hypothesis by name), so
 * re-running only adds a new agentRunSummary. Nothing is ever deleted.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { TWENTY_OBJECTS, filterValue, twentyClientFromEnv } from '../../src/integrations/twenty/index.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { loadSeedInput } from '../../src/seed/index.js';
import { seedProspector } from '../../src/seed/prospector-seed.js';
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
if (!live) console.warn(`[integration] Prospector live test skipped: ${reasons.join('; ')}`);

interface Step {
  type: string;
  tool: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  output: Record<string, unknown> | null;
  error: unknown;
}

describe.skipIf(!live)('Prospector live (Gemini + Twenty + PostgreSQL)', () => {
  const tenant = 'publiexpe';
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  let processor: RunProcessor;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    processor = new RunProcessor(
      handle.db,
      createProviderRegistry({ geminiApiKey: geminiKey, geminiModel: process.env.GEMINI_MODEL }),
      undefined,
      createDefaultToolRegistry({ twenty }),
    );
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('seed is idempotent', async () => {
    const defaultInput = loadSeedInput();
    const first = await seedProspector(handle.db, { tenantId: tenant, defaultInput });
    const second = await seedProspector(handle.db, { tenantId: tenant, defaultInput });
    expect(second).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged', agentId: first.agentId, taskId: first.taskId });
    const task = await handle.db.query.taskDefinitions.findFirst({ where: (t, { eq }) => eq(t.id, first.taskId) });
    expect(task).toMatchObject({ name: 'daily-event-prospecting', schedule: { type: 'CRON', expression: '0 8 * * *' }, timezone: 'Europe/Madrid' });
  });

  it(
    'runs daily-event-prospecting with the fixture against real Gemini and real Twenty',
    async () => {
      const seeded = await seedProspector(handle.db, { tenantId: tenant, defaultInput: loadSeedInput() });
      const runRes = await app.inject({
        method: 'POST',
        url: `/tasks/${seeded.taskId}/run`,
        headers: { 'x-tenant-id': tenant },
        payload: { scheduled_at: new Date().toISOString() },
      });
      expect(runRes.statusCode).toBe(202);
      for (const { job } of queue.drain()) await processor.process(job);

      const detail = (await app.inject({ method: 'GET', url: `/task-runs/${runRes.json().task_run.id}`, headers: { 'x-tenant-id': tenant } })).json();
      expect(detail.task_run.status).toBe('COMPLETED');
      const output = detail.task_run.output as {
        outcome: string;
        counters: Record<string, number>;
        cost: { model: number; currency: string; eur: number };
        run_summary_id: string | null;
        results: Array<{ name: string; domain: string; status: string; confidence?: number; reason?: string; company_id?: string; hypothesis?: unknown }>;
      };
      const steps = detail.trace.steps as Step[];
      const modelSteps = steps.filter((s) => s.type === 'MODEL');

      console.log(
        '[prospector-live] result',
        JSON.stringify(
          {
            outcome: output.outcome,
            counters: output.counters,
            cost: output.cost,
            task_run_cost: detail.task_run.cost,
            tokens: { input: detail.task_run.input_tokens, output: detail.task_run.output_tokens },
            models: [...new Set(modelSteps.map((s) => s.model))],
            results: output.results,
          },
          null,
          2,
        ),
      );

      expect(['SUCCESS', 'PARTIAL']).toContain(output.outcome);
      expect(output.counters.llm_calls).toBeGreaterThanOrEqual(3);
      expect(modelSteps.length).toBeGreaterThanOrEqual(3);
      expect(modelSteps.every((s) => s.input_tokens > 0)).toBe(true);
      expect(output.cost.model).toBeGreaterThan(0);
      expect(Number(detail.task_run.cost)).toBeCloseTo(output.cost.model, 6);
      expect(output.run_summary_id).toBeTruthy();

      // Public administration must not become a hypothesis.
      const admin = output.results.find((r) => r.domain === 'promocionagroalimentaria.example')!;
      expect(admin.status).toMatch(/^discarded_/);

      // The clearly relevant exhibitor is in Twenty with signal + hypothesis.
      const relevant = output.results.find((r) => r.domain === 'conservasdelcantabrico.example')!;
      expect(relevant.status).toMatch(/^hypothesis_(created|existing)$/);
      const companyId = relevant.company_id!;
      const signals = await twenty.list<{ signalType: string; status: string; eventDate: string }>(TWENTY_OBJECTS.commercialSignal, {
        filter: `companyId[eq]:${filterValue(companyId)}`,
      });
      expect(signals.records.some((s) => s.signalType === 'FAIR' && s.eventDate === '2026-11-24')).toBe(true);
      const hyps = await twenty.list<{ name: string; status: string }>(TWENTY_OBJECTS.commercialHypothesis, {
        filter: `companyId[eq]:${filterValue(companyId)}`,
      });
      expect(hyps.records.some((h) => h.name.includes('Expo Alimentaria Ibérica 2026'))).toBe(true);
      const summary = await twenty.get<{ outcome: string; agentExecutionId: string; cost: { amountMicros: number } }>(
        TWENTY_OBJECTS.agentRunSummary,
        output.run_summary_id!,
      );
      expect(summary).toMatchObject({ outcome: output.outcome, agentExecutionId: detail.execution.id });
      expect(summary!.cost.amountMicros).toBe(Math.round(output.cost.eur * 1_000_000));
    },
    180_000,
  );
});
