/**
 * Catalog Service end to end against a real PostgreSQL (no Redis, no network): Prospector runs
 * (RunProcessor + StubProvider + FakeTwenty + catalog stub) with the catalog gate, the DRAFT
 * candidate skill pinned in a test agent version, degraded mode with the daily note and event,
 * the disabled catalog, the DRAFT skill that stays inactive, and GET /catalog/health.
 * Fresh tenants per scenario, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt14_catalog.
 * Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_SKILL_MARKER } from '../../src/agents/prospector-catalog.js';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, events, skills, skillVersions, taskDefinitions, taskRuns, traces, traceSteps } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { CatalogError, CatalogService, loadStubCatalogData, StubCatalogClient } from '../../src/integrations/catalog/index.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { CATALOG_SKILL_CANDIDATE, seedCatalogSkillCandidate } from '../../src/seed/catalog-skill-seed.js';
import { desiredProspectorVersion, PROSPECTOR_AGENT_NAME, PROSPECTOR_TASK_NAME, seedProspector, upsertAgent } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { CatalogGate } from '../../src/worker/catalog-gate.js';
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

const INPUT = {
  event: { name: 'Expo Alimentaria Ibérica', type: 'FAIR', date: '2026-11-24', source_url: 'https://expo.example.com/expositores' },
  exhibitors: [{ name: 'Conservas del Norte', domain: 'conservasdelnorte.es', description: 'Fabricante de conservas con stand propio.' }],
};
const DECISION = JSON.stringify({
  relevant: true,
  confidence: 0.82,
  reason: 'Fabricante con stand propio.',
  hypothesis: {
    need: 'Unas 500 bolsas tote para los visitantes del stand.',
    why_now: 'Expone el 24/11.',
    quantity_min: 500,
    quantity_max: 900,
    budget_min_eur: 800,
    budget_max_eur: 2000,
    recommended_products: ['Bolsas tote de algodón', 'Libretas'],
    timing: 'IMMEDIATE',
    differentiators: ['TALLER_PROPIO'],
  },
});
const SELECTION = JSON.stringify({ selected: [{ productId: '10482', sku: '12/BT-ALG-140', reason: 'Bolsa de feria ligera.' }, { productId: '12210', sku: '3/LIB-A5-KRA' }] });

type Result = { status: string; recommended_products?: Array<{ productId: string; sku: string; name: string; priceHint: unknown }>; catalog?: { status: string; code?: string } };

describe.skipIf(!dbAvailable)('Catalog Service (PostgreSQL)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let runSeq = 0;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  /** A tenant with the skills, the DRAFT catalog candidate and the Prospector (optionally pinned to the candidate). */
  async function tenantWith(opts: { pinCandidate: boolean }) {
    const tenantId = `it-cat-${randomUUID().slice(0, 8)}`;
    await seedSkills(handle.db, { tenantId });
    const candidate = await seedCatalogSkillCandidate(handle.db, { tenantId });
    await seedProspector(handle.db, { tenantId, defaultInput: INPUT });
    if (opts.pinCandidate) {
      const want = desiredProspectorVersion();
      // Test-only agent version that PINS the DRAFT version (a pinned ref resolves any status):
      // the skill itself is not activated.
      want.skillRefs = want.skillRefs.map((r) => ('name' in r && r.name === PROSPECTOR_SKILL_ID ? { name: PROSPECTOR_SKILL_ID, version: candidate.version! } : r));
      await upsertAgent(handle.db, { tenantId, createdBy: 'it', name: PROSPECTOR_AGENT_NAME, description: 'it', role: 'prospector', want, log: () => {} });
    }
    return { tenantId, candidate };
  }

  function world(catalog: CatalogService, tenantId: string, responses: string[]) {
    const fake = new FakeTwenty();
    const provider = new StubProvider({ responses });
    const bus = new EventBus(handle.db, new MemoryEventQueue(), { tenantId });
    const processor = new RunProcessor(handle.db, () => provider, { info() {}, warn() {}, error() {} }, createDefaultToolRegistry({ twenty: fake.client(), catalog }), null);
    processor.events = bus;
    processor.catalogGate = new CatalogGate({ catalog, twenty: fake.client(), events: () => bus });
    return { fake, provider, processor };
  }

  async function runTask(processor: RunProcessor, tenantId: string) {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-catalog:${tenantId}:${++runSeq}`, trigger: 'MANUAL' });
    for (const { job } of queue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    const execution = await handle.db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, run!.executionId!) });
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, run!.executionId!) });
    const steps = await handle.db.select().from(traceSteps).where(eq(traceSteps.traceId, trace!.id)).orderBy(traceSteps.sequence);
    return { run: run!, output: execution!.output as Record<string, unknown>, trace: trace!, steps };
  }

  const stubCatalog = () => {
    const api = new StubCatalogClient(loadStubCatalogData());
    return { api, catalog: new CatalogService({ enabled: true, api }) };
  };
  const gateStep = (steps: Array<{ type: string; output: unknown }>) =>
    steps.find((s) => s.type === 'THINK' && (s.output as { catalog?: unknown } | null)?.catalog !== undefined)?.output as { catalog: Record<string, unknown> } | undefined;

  it('the DRAFT candidate skill exists, carries the marker and the changelog, and is NOT active (activation needs the Release Gate)', async () => {
    const { tenantId, candidate } = await tenantWith({ pinCandidate: false });
    expect(candidate).toMatchObject({ action: 'created', status: 'DRAFT', version: 2 });
    const skill = await handle.db.query.skills.findFirst({ where: and(eq(skills.tenantId, tenantId), eq(skills.name, PROSPECTOR_SKILL_ID)) });
    const versions = await handle.db.select().from(skillVersions).where(eq(skillVersions.skillId, skill!.id));
    const draft = versions.find((v) => v.version === 2)!;
    const active = versions.find((v) => v.id === skill!.activeVersionId)!;
    expect(active.version).toBe(1);
    expect(draft.status).toBe('DRAFT');
    expect(draft.instructions).toContain(CATALOG_SKILL_MARKER);
    expect(active.instructions).not.toContain(CATALOG_SKILL_MARKER);
    expect(draft.metadata).toMatchObject({ candidate: CATALOG_SKILL_CANDIDATE, contract_version: '1.1.0', change_reason: expect.stringContaining('v1.1') });
    // Idempotent.
    expect(await seedCatalogSkillCandidate(handle.db, { tenantId })).toMatchObject({ action: 'unchanged', version: 2, status: 'DRAFT' });
    // The Release Gate blocks an activation without an experiment; nothing changes.
    const act = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/2/activate`, headers: { 'x-tenant-id': tenantId } });
    expect(act.statusCode).toBe(409);
    const [after] = await handle.db.select().from(skillVersions).where(eq(skillVersions.id, draft.id));
    expect(after!.status).toBe('DRAFT');
  });

  it('catalog enabled (stub) + candidate skill pinned: the run produces recommended_products and the hypothesis carries them', async () => {
    const { tenantId, candidate } = await tenantWith({ pinCandidate: true });
    const { catalog } = stubCatalog();
    const { fake, provider, processor } = world(catalog, tenantId, [DECISION, SELECTION]);
    const { run, output, trace, steps } = await runTask(processor, tenantId);
    expect(run.status).toBe('COMPLETED');
    expect(output).toMatchObject({ outcome: 'SUCCESS' });
    const r = (output.results as Result[])[0]!;
    expect(r).toMatchObject({ status: 'hypothesis_created', catalog: { status: 'selected' } });
    expect(r.recommended_products!.map((p) => [p.productId, p.sku, p.name])).toEqual([
      ['10482', '12/BT-ALG-140', 'Bolsa tote de algodón 140 g'],
      ['12210', '3/LIB-A5-KRA', 'Libreta A5 de tapa kraft con bolígrafo'],
    ]);
    expect(r.recommended_products![0]!.priceHint).toMatchObject({ fromEur: 1.2, toEur: 1.35, basis: 'INDICATIVE', perUnit: true, includesCustomization: false });
    const hyp = fake.tables.commercialHypotheses[0] as { recommendedProducts: string[]; evidence: Array<{ claim: string }> };
    expect(hyp.recommendedProducts.slice(0, 2)).toEqual(['[STUB] Bolsa tote de algodón 140 g · ref. 12/BT-ALG-140 · id 10482', '[STUB] Libreta A5 de tapa kraft con bolígrafo · ref. 3/LIB-A5-KRA · id 12210']);
    expect(hyp.evidence.some((e) => e.claim.includes('en torno a 1,20-1,35 €/ud antes de personalización'))).toBe(true);
    // The trace records the gate decision and the DRAFT skill version that was injected (pinned).
    expect(gateStep(steps)?.catalog).toMatchObject({ available: true, contract_version: '1.1.0' });
    expect((trace.skillVersions as Array<{ name: string; version: number }>).find((s) => s.name === PROSPECTOR_SKILL_ID)).toMatchObject({ version: candidate.version });
    expect(provider.requests[1]!.system).toContain(CATALOG_SKILL_MARKER);
    expect(steps.filter((s) => s.type === 'TOOL' && s.tool?.startsWith('catalog_')).length).toBeGreaterThanOrEqual(3);
    expect(await handle.db.select().from(events).where(and(eq(events.tenantId, tenantId), eq(events.type, 'catalog.unavailable')))).toHaveLength(0);
  });

  it('catalog enabled but down: degraded run (generic families), one ⚠️ task and one catalog.unavailable event for the day, never an email', async () => {
    const { tenantId } = await tenantWith({ pinCandidate: true });
    const { api, catalog } = stubCatalog();
    api.failure = new CatalogError('CATALOG_UNAVAILABLE', 'UNAVAILABLE: mantenimiento', 503, true);
    const { fake, processor } = world(catalog, tenantId, [DECISION, DECISION]);
    const first = await runTask(processor, tenantId);
    expect(first.run.status).toBe('COMPLETED');
    expect(first.output).toMatchObject({ outcome: 'SUCCESS' });
    expect((first.output.results as Result[])[0]).toMatchObject({ status: 'hypothesis_created', catalog: { status: 'unavailable', code: 'CATALOG_UNAVAILABLE' } });
    expect((fake.tables.commercialHypotheses[0] as { recommendedProducts: string[] }).recommendedProducts).toEqual(['Bolsas tote de algodón', 'Libretas']);
    expect(gateStep(first.steps)?.catalog).toMatchObject({ available: false, reason: 'unhealthy', code: 'CATALOG_UNAVAILABLE', notice: { eventPublished: true, taskCreated: true } });
    // Second run the same day: no new task, no new event.
    const second = await runTask(processor, tenantId);
    expect(second.output).toMatchObject({ outcome: 'SUCCESS' });
    // Tanda 19: a Twenty Task (TODO, due today), never a note.
    expect((fake.tables.notes as Array<{ title: string }>).filter((n) => n.title.startsWith('⚠️ Catálogo no disponible'))).toHaveLength(0);
    const warnings = (fake.tables.tasks as Array<{ title: string; status: string; dueAt: string }>).filter((n) => n.title.startsWith('⚠️ Catálogo no disponible'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.status).toBe('TODO');
    expect(warnings[0]!.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    expect(warnings[0]!.title).toContain(tenantId);
    const evts = await handle.db.select().from(events).where(and(eq(events.tenantId, tenantId), eq(events.type, 'catalog.unavailable')));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.payload).toMatchObject({ reason: 'unhealthy', code: 'CATALOG_UNAVAILABLE', provider: 'stub' });
    expect(await handle.db.select().from(events).where(and(eq(events.tenantId, tenantId), eq(events.type, 'email.sent')))).toHaveLength(0);
  });

  it('catalog disabled (default): no gate, no catalog tool, no note, no event; the ACTIVE skill runs as before', async () => {
    const { tenantId } = await tenantWith({ pinCandidate: false });
    const { fake, provider, processor } = world(new CatalogService({ enabled: false, api: null }), tenantId, [DECISION]);
    const { output, steps } = await runTask(processor, tenantId);
    expect(output).toMatchObject({ outcome: 'SUCCESS' });
    expect((output.results as Result[])[0]!.catalog).toBeUndefined();
    expect(gateStep(steps)).toBeUndefined();
    expect(steps.some((s) => s.tool?.startsWith('catalog_'))).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.system).not.toContain(CATALOG_SKILL_MARKER);
    expect(fake.tables.notes).toHaveLength(0);
    expect(await handle.db.select().from(events).where(and(eq(events.tenantId, tenantId), eq(events.type, 'catalog.unavailable')))).toHaveLength(0);
  });

  it('GET /catalog/health: passthrough of what the gate sees (200 up or disabled, 503 down); never echoes the token', async () => {
    const { api, catalog } = stubCatalog();
    const up = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' }, catalog });
    try {
      const ok = await up.inject({ method: 'GET', url: '/catalog/health' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ enabled: true, provider: 'stub', client_contract_version: '1.1.0', availability: { available: true, health: { contractVersion: '1.1.0' } } });
      api.failure = new CatalogError('CATALOG_UNAUTHENTICATED', 'UNAUTHENTICATED', 401);
      expect((await up.inject({ method: 'GET', url: '/catalog/health' })).statusCode).toBe(200); // cached 60 s
      const down = await up.inject({ method: 'GET', url: '/catalog/health?fresh=true' });
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ availability: { available: false, code: 'CATALOG_UNAUTHENTICATED' } });
      expect(down.body).not.toContain('pxcat_');
    } finally {
      await up.close();
    }
    const off = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' }, catalog: new CatalogService({ enabled: false, api: null }) });
    try {
      const r = await off.inject({ method: 'GET', url: '/catalog/health' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ enabled: false, provider: null, availability: { available: false, reason: 'disabled' } });
    } finally {
      await off.close();
    }
  });
});
