/**
 * Email drafts end to end against a real PostgreSQL (no Redis, no network):
 * POST /evaluations/human (ACCEPTED) -> `evaluation.recorded` persisted by the EventBus ->
 * EVENT trigger of the seeded `draft-email-on-validated` task -> TaskRun -> RunProcessor ->
 * EmailDrafterAgent (StubProvider) -> Note in a fake Twenty.
 * Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, events, taskDefinitions, taskRuns, traces, traceSteps } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { evaluateTrigger, eventTaskRunIdempotencyKey, eventTriggeredInput, parseEventTrigger } from '../../src/events/triggers.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { EMAIL_DRAFT_TASK_NAME, seedEmailDrafter } from '../../src/seed/email-drafter-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
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

const DRAFT = JSON.stringify({
  asunto: 'Material para vuestro stand en la feria',
  cuerpo:
    'Hola, equipo de Acme:\n\nSoy Jesús Abril, de PubliEXPE. He visto que estaréis en la feria de noviembre y quería ofreceros ayuda con el material del stand.\n\nPodemos prepararos bolsas tote y polos bordados en nuestro taller propio, con plazos cortos.\n\n¿Te encaja que te mande dos o tres propuestas?\n\nUn saludo,',
});

describe.skipIf(!dbAvailable)('email drafts: evaluation.recorded -> EmailDrafter -> Twenty note (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  const company = fake.seed('companies', { name: 'Acme Conservas', domainName: { primaryLinkUrl: 'acme.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const signal = fake.seed('commercialSignals', { name: 'Feria — Acme', signalType: 'FAIR', eventDate: '2026-11-24', companyId: company.id, tenantId: tenant });
  const hypothesis = fake.seed('commercialHypotheses', {
    name: 'Acme Conservas — Feria 2026',
    status: 'PROPOSED',
    tenantId: tenant,
    need: 'Regalos para el stand',
    whyNow: 'Feria en noviembre',
    recommendedProducts: ['Bolsas tote'],
    evidence: [{ claim: 'Expositor' }],
    companyId: company.id,
    commercialSignalId: signal.id,
    decisionMakerId: null,
  });
  const queue = new MemoryEventQueue();
  let handle: DbHandle;
  let bus: EventBus;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    bus = new EventBus(handle.db, queue, { tenantId: tenant });
    // Origin run of the hypothesis: the link resolver recovers companyId from this trace.
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name: `it-prospector-${randomUUID().slice(0, 6)}` }).returning();
    const [version] = await handle.db.insert(agentVersions).values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'stub', modelProvider: 'stub' }).returning();
    const [execution] = await handle.db
      .insert(agentExecutions)
      .values({ tenantId: tenant, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', output: { ok: true } })
      .returning();
    const [trace] = await handle.db.insert(traces).values({ tenantId: tenant, executionId: execution!.id, agentId: agent!.id }).returning();
    await handle.db.insert(traceSteps).values({
      tenantId: tenant,
      traceId: trace!.id,
      sequence: 1,
      timestamp: new Date(),
      type: 'TOOL',
      tool: 'create_hypothesis',
      toolInput: { companyId: company.id, need: 'Regalos para el stand' },
      toolOutput: { created: true, record: { id: hypothesis.id, status: 'PROPOSED' } },
    });
    app = await buildServer({
      db: handle.db,
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: tenant, defaultModelProvider: 'stub', evaluationDedupeWindowMs: 600_000 },
      events: bus,
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('ACCEPTED verdict emits evaluation.recorded once (replays reuse it), with the company resolved', async () => {
    const res = await app.inject({ method: 'POST', url: '/evaluations/human', headers: { 'x-tenant-id': tenant }, payload: { hypothesisId: hypothesis.id, feedback: 'ACCEPTED' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { event_id: string; evaluation: { id: string } };
    expect(body.event_id).toEqual(expect.any(String));

    const row = await handle.db.query.events.findFirst({ where: and(eq(events.tenantId, tenant), eq(events.id, body.event_id)) });
    expect(row).toMatchObject({ type: 'evaluation.recorded', schemaVersion: 'evaluation.recorded.v1', idempotencyKey: `evt:evaluation.recorded:${body.evaluation.id}` });
    expect(row!.payload).toMatchObject({ evaluationId: body.evaluation.id, subjectType: 'hypothesis', subjectId: hypothesis.id, feedback: 'ACCEPTED', score: 1, companyId: company.id });
    expect(row!.dispatchedAt).not.toBeNull();
    expect([...queue.jobs.keys()]).toEqual([body.event_id]);

    // Window dedupe: same verdict again -> same evaluation, same event, nothing new queued.
    const again = await app.inject({ method: 'POST', url: '/evaluations/human', headers: { 'x-tenant-id': tenant }, payload: { hypothesisId: hypothesis.id, feedback: 'ACCEPTED' } });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { event_id: string }).event_id).toBe(body.event_id);
    const all = await handle.db.query.events.findMany({ where: and(eq(events.tenantId, tenant), eq(events.type, 'evaluation.recorded')) });
    expect(all).toHaveLength(1);
  });

  it('the event fires draft-email-on-validated and the run leaves the draft as a note', async () => {
    const seeded = await seedEmailDrafter(handle.db, { tenantId: tenant });
    expect((await seedEmailDrafter(handle.db, { tenantId: tenant })).taskAction).toBe('unchanged');
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, EMAIL_DRAFT_TASK_NAME)) });
    expect(task!.id).toBe(seeded.taskId);

    const [envelope] = queue.drain();
    const decision = evaluateTrigger(task!, parseEventTrigger(task!.schedule)!, envelope!);
    expect(decision).toEqual({ fire: true, depth: 1 });

    const runQueue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, runQueue, task!, {
      idempotencyKey: eventTaskRunIdempotencyKey(task!.id, envelope!.id),
      input: eventTriggeredInput(envelope!),
      trigger: 'EVENT',
    });
    const provider = new StubProvider({ responses: [DRAFT], usage: { inputTokens: 800, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
    const processor = new RunProcessor(handle.db, () => provider, undefined, createDefaultToolRegistry({ twenty: fake.client() }), null);
    for (const { job } of runQueue.drain()) await processor.process(job);

    const done = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    expect(done).toMatchObject({ status: 'COMPLETED' });
    expect(done!.output).toMatchObject({ outcome: 'SUCCESS', note_created: true, sends_email: false, company_id: company.id });
    expect(fake.tables.notes).toHaveLength(1);
    const md = (fake.tables.notes[0] as { bodyV2: { markdown: string } }).bodyV2.markdown;
    expect(md).toMatch(/^> \*\*BORRADOR — revísalo y envíalo desde tu correo; el sistema no envía nada\.\*\*/);
    expect(md).toContain('Si no quieres recibir más mensajes, respóndeme o escribe a baja@publiexpe.info');
    expect(fake.tables.noteTargets.map((t) => t.targetCompanyId ?? t.targetCommercialHypothesisId)).toEqual([company.id, hypothesis.id]);
  });
});
