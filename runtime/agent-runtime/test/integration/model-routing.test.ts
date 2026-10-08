/**
 * Model routing end to end against a real PostgreSQL (no network): the RunProcessor resolves
 * each execution's (provider, model) through the router and records the route in the trace;
 * an experiment with scripted providers runs on the routed executor and judge models and
 * refuses a judge equal to the executor before creating anything; `models:costs`
 * (modelCostProjection + GET /metrics/model-costs) projects the window's volume to 2027 prices.
 * Fresh tenants per run, no DELETE. Run it against its own database:
 *   DATABASE_URL=postgres://.../agentos_wt13_routing
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { caseContentHash } from '../../src/datasets/core.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, evaluationCases, evaluationDatasets, experiments, traces, type HarnessUsed } from '../../src/db/schema.js';
import { ExperimentAbortedError, gateConfig, runExperiment, type RunnerDeps } from '../../src/experiments/index.js';
import { modelCostProjection, renderModelCosts } from '../../src/metrics/model-costs.js';
import { experimentRoutes, ModelRouteError, ModelRouter, StubProvider, type CompletionRequest, type CompletionResult, type CostBreakdown, type ModelProvider, type StreamChunk } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { createVersion } from '../../src/skills/service.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

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
const dbAvailable = await databaseReachable(DATABASE_URL);
const NOW = () => new Date('2026-10-08T10:00:00Z');

/** Scripted provider that records the model of every request. */
class Recording implements ModelProvider {
  calls: string[] = [];
  constructor(
    readonly name: string,
    private readonly answer: (req: CompletionRequest) => string,
  ) {}
  estimateCost(): CostBreakdown {
    return { modelCost: 0.001, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request.model);
    return { text: this.answer(request), model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, cost: this.estimateCost(), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

const executorAnswer = () =>
  JSON.stringify({
    relevant: true,
    confidence: 0.55,
    reason: 'Encaje de prueba: por el nombre, parece una empresa del sector con stand.',
    hypothesis: {
      need: 'Unas 300 bolsas tote para visitantes.',
      why_now: 'La feria es el 20/11/2026.',
      quantity_min: 300,
      quantity_max: 600,
      budget_min_eur: 600,
      budget_max_eur: 1500,
      recommended_products: ['bolsas tote'],
      timing: 'THIS_QUARTER',
      differentiators: ['TALLER_PROPIO'],
    },
  });
const judgeAnswer = (req: CompletionRequest) => {
  const ids = [...new Set([...req.messages.map((m) => m.content).join('\n').matchAll(/"id":\s*"(c\d+)"/g)].map((m) => m[1]!))];
  return JSON.stringify({ items: ids.map((id) => ({ id, level: 3, justification: 'Accionable.', quote: 'Encaje de prueba' })) });
};

describe.skipIf(!dbAvailable)('model routing (PostgreSQL)', () => {
  const tenant = `it-route-${randomUUID().slice(0, 8)}`;
  const evTenant = `it-route-ev-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  const requested: string[] = [];
  const stub = new StubProvider({ responseText: 'ok' });
  let processor: RunProcessor;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    processor = new RunProcessor(
      handle.db,
      (name) => {
        requested.push(name);
        return stub;
      },
      undefined,
      undefined,
      null,
    );
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  async function execute(agentName: string, version: Record<string, unknown>) {
    let res = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: agentName, status: 'ACTIVE', version } });
    expect(res.statusCode).toBe(201);
    const agentId = (res.json() as { agent: { id: string } }).agent.id;
    res = await app.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agentId, input: { query: 'x' } } });
    expect(res.statusCode).toBeLessThan(300);
    for (const { job } of queue.drain()) await processor.process(job);
    const executionId = (res.json() as { execution: { id: string } }).execution.id;
    const trace = (await handle.db.query.traces.findFirst({ where: eq(traces.executionId, executionId), with: undefined }))!;
    const steps = await handle.db.query.traceSteps.findMany({ where: (s, { eq: is }) => is(s.traceId, trace.id) });
    return { trace, harness: trace.harness as HarnessUsed, models: steps.map((s) => s.model).filter(Boolean) };
  }

  it('runtime: without env the version model is used (pinned); MODEL_ROUTE_<ROL> re-routes; the trace records the role', async () => {
    processor.router = new ModelRouter({ env: {} });
    requested.length = 0;
    const pinned = await execute('RouteGemini', { model_provider: 'gemini', model: 'gemini-flash-latest', configuration: {} });
    expect(requested).toEqual(['gemini']);
    expect(pinned.harness.model_route).toEqual({ role: 'executor_cheap', provider: 'gemini', model: 'gemini-flash-latest', source: 'pinned' });

    // Same kind of version, executor_cheap moved by env (to the offline stub, so no network).
    processor.router = new ModelRouter({ env: { MODEL_ROUTE_EXECUTOR_CHEAP: 'stub:stub-routed' } });
    requested.length = 0;
    const routed = await execute('RouteGemini2', { model_provider: 'gemini', model: 'gemini-flash-latest', configuration: {} });
    expect(requested).toEqual(['stub']);
    expect(routed.models).toEqual(['stub-routed']);
    expect(routed.harness.model_route).toEqual({ role: 'executor_cheap', provider: 'stub', model: 'stub-routed', source: 'env', env: 'MODEL_ROUTE_EXECUTOR_CHEAP' });

    // A stub version is a fixture: never re-routed, even with the override.
    const fixture = await execute('RouteStub', { model_provider: 'stub', model: 'stub-1', configuration: {} });
    expect(fixture.models).toEqual(['stub-1']);
    expect(fixture.harness.model_route).toMatchObject({ provider: 'stub', model: 'stub-1', source: 'pinned' });
  });

  describe('experiments', () => {
    async function dataset(name: string) {
      const [ds] = await handle.db.insert(evaluationDatasets).values({ tenantId: tenant, name, domain: 'prospeccion', version: 1, status: 'DRAFT', createdBy: 'it' }).returning();
      for (const n of ['ALFA FOODS', 'BETA CAFES']) {
        const input = { event: { name: 'Feria Prueba 2026', type: 'FAIR', date: '2026-11-20', location: 'Valencia' }, exhibitor: { name: n } };
        const expected = { kind: 'unlabeled' };
        await handle.db.insert(evaluationCases).values({
          datasetId: ds!.id,
          tenantId: tenant,
          split: 'VALIDATION',
          entityKey: `org:${n.toLowerCase()}`,
          input,
          expected,
          source: { origin: 'synthetic', expected_source: 'none' },
          difficulty: 'hard',
          contentHash: caseContentHash(input, expected),
          usedBy: [] as never,
        });
      }
    }

    function deps(executorModel: string, judgeModel: string, extra: Partial<RunnerDeps> = {}) {
      const executor = new Recording('stub', executorAnswer);
      const judge = new Recording('stub', judgeAnswer);
      const agentVersion = desiredProspectorVersion();
      const policy = parseToolPolicy(agentVersion.configuration);
      const d: RunnerDeps = {
        db: handle.db,
        executorProvider: executor,
        judgeProvider: judge,
        judgeModel,
        makeTools: (label) => new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), policy, { tenantId: tenant, executionId: label, agentId: 'it-route', stage: 'PROSPECTOR' }, new AbortController().signal),
        agentVersion: { model: executorModel, configuration: agentVersion.configuration },
        now: NOW,
        evaluationsTenant: evTenant,
        ...extra,
      };
      return { d, executor, judge };
    }

    beforeAll(async () => {
      await seedSkills(handle.db, { tenantId: tenant });
      await createVersion(handle.db, { tenantId: tenant, skillKey: PROSPECTOR_SKILL_ID, copyFrom: 'active', content: { instructions: 'Instrucciones candidatas de prueba (routing).' }, createdBy: 'it' });
      await dataset('it-routing');
    });

    it('an experiment with stub providers runs on the routed executor and judge models', async () => {
      const router = new ModelRouter({ env: { MODEL_ROUTE_EXECUTOR_REASONER: 'stub:stub-exec', MODEL_ROUTE_JUDGE: 'stub:stub-judge' } });
      const routes = experimentRoutes(router, desiredProspectorVersion());
      expect(routes.executor).toMatchObject({ role: 'executor_reasoner', provider: 'stub', model: 'stub-exec', source: 'env' });
      const { d, executor, judge } = deps(routes.executor.model, routes.judge.model, { routes });
      const { experiment } = await runExperiment(d, { tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: 2, dataset: 'it-routing', budgetEur: 0.3, repeat: 1, formSample: 0, gate: gateConfig(), createdBy: 'it' });
      expect(experiment.status).toBe('COMPLETED');
      expect(executor.calls.length).toBeGreaterThan(0);
      expect(new Set(executor.calls)).toEqual(new Set(['stub-exec']));
      expect(judge.calls.length).toBeGreaterThan(0);
      expect(new Set(judge.calls)).toEqual(new Set(['stub-judge']));
      expect(experiment.config).toMatchObject({
        executor: { model: 'stub-exec', role: 'executor_reasoner', route_source: 'env' },
        judge: { model: 'stub-judge', role: 'judge', route_source: 'env' },
      });
    });

    it('a judge equal to the executor is refused at start: router error, and the runner aborts before creating anything', async () => {
      expect(() => experimentRoutes(new ModelRouter({ env: { MODEL_ROUTE_JUDGE: 'gemini:gemini-3.8-flash' } }), desiredProspectorVersion())).toThrow(ModelRouteError);
      const before = (await handle.db.select().from(experiments).where(eq(experiments.tenantId, tenant))).length;
      const { d, executor, judge } = deps('gemini-flash-latest', 'gemini-3.8-flash');
      const err = await runExperiment(d, { tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: 2, dataset: 'it-routing', budgetEur: 0.3, repeat: 1, formSample: 0, gate: gateConfig(), createdBy: 'it' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExperimentAbortedError);
      expect(err).toMatchObject({ code: 'invalid', experiment: null });
      expect((err as Error).message).toMatch(/mismo modelo/);
      expect(executor.calls).toHaveLength(0);
      expect(judge.calls).toHaveLength(0);
      expect(await handle.db.select().from(experiments).where(eq(experiments.tenantId, tenant))).toHaveLength(before);
    });
  });

  it('models:costs projects the window volume with the current routing to 2027 prices', async () => {
    const res = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'CostProspector', status: 'ACTIVE', version: { model_provider: 'gemini', model: 'gemini-flash-latest', configuration: { implementation: 'prospector' } } } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { agent: { id: string }; version: { id: string } };
    const versionId = body.version?.id ?? (await handle.db.query.agentVersions.findFirst({ where: (v, { eq: is }) => is(v.agentId, body.agent.id) }))!.id;
    await handle.db.insert(agentExecutions).values({
      tenantId: tenant,
      agentId: body.agent.id,
      agentVersionId: versionId,
      status: 'COMPLETED',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 0,
      modelCost: 4.5,
      totalCost: 4.5,
      output: { cost: { eur: 3.87 } },
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });
    const window = { tenantId: tenant, since: new Date('2026-09-08T00:00:00Z'), until: new Date('2026-10-08T00:00:00Z'), today: NOW() };

    const current = await modelCostProjection(handle.db, { ...window, router: new ModelRouter({ env: {} }) });
    expect(current.prices).toMatchObject({ today: '2026-10-08', at: '2027-01-01', usd_to_eur: 0.86 });
    const roleFlash = current.roles.find((r) => r.role === 'executor_reasoner')!;
    expect(roleFlash).toMatchObject({ route: 'gemini:gemini-flash-latest', source: 'default', change: 1 });
    expect(roleFlash.price_today).toEqual({ input_per_mtok: 0.75, output_per_mtok: 3.75, cached_per_mtok: 0.075 });
    expect(roleFlash.price_at).toEqual({ input_per_mtok: 1.5, output_per_mtok: 7.5, cached_per_mtok: 0.15 });
    expect(current.roles.find((r) => r.role === 'judge')).toMatchObject({ route: 'gemini:gemini-pro-latest', change: 0 });
    const row = current.volume.find((v) => v.source === 'agent_executions' && v.label === 'CostProspector')!;
    // 1M in + 1M out: (0.75 + 3.75) USD today, (1.5 + 7.5) USD from 2027-01-01, at 0.86 EUR/USD.
    expect(row).toMatchObject({ role: 'executor_reasoner', served: 'gemini:gemini-flash-latest', route: 'gemini:gemini-flash-latest', route_source: 'pinned', count: 1, actual_eur: 3.87, method: 'tokens' });
    expect(row.projected_today_eur).toBeCloseTo(3.87, 6);
    expect(row.projected_at_eur).toBeCloseTo(7.74, 6);
    expect(current.totals.by_role.executor_reasoner.delta_eur).toBeCloseTo(3.87, 6);
    expect(renderModelCosts(current)).toMatch(/executor_reasoner .*gemini:gemini-flash-latest/);

    // What-if: move the Prospector's role to flash-lite (no 2027 change).
    const whatIf = await modelCostProjection(handle.db, { ...window, router: new ModelRouter({ env: { MODEL_ROUTE_EXECUTOR_REASONER: 'gemini:gemini-3.5-flash-lite' } }) });
    const moved = whatIf.volume.find((v) => v.label === 'CostProspector')!;
    expect(moved).toMatchObject({ route: 'gemini:gemini-3.5-flash-lite', route_source: 'env' });
    expect(moved.projected_today_eur).toBeCloseTo((0.3 + 2.5) * 0.86, 6);
    expect(moved.projected_at_eur).toBeCloseTo((0.3 + 2.5) * 0.86, 6);

    // Same data over HTTP (read-only GET).
    const http = await app.inject({ method: 'GET', url: '/metrics/model-costs?since=2026-09-08T00:00:00Z&until=2026-10-08T00:00:00Z', headers });
    expect(http.statusCode).toBe(200);
    const json = http.json() as { prices: { at: string }; roles: unknown[]; volume: Array<{ label: string }> };
    expect(json.prices.at).toBe('2027-01-01');
    expect(json.roles).toHaveLength(5);
    expect(json.volume.some((v) => v.label === 'CostProspector')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/metrics/model-costs?at=2027-13-45', headers })).statusCode).toBe(400);
  });
});
