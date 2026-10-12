/**
 * Lead-time window (tanda 18) end to end against a real PostgreSQL (no Redis, no network):
 * three QUALIFIED fairs (in the window / 10 days away / 300 days away) and a PROPOSED hypothesis
 * of a fair next week.
 *  - Daily run (RunProcessor + FakeTwenty + FakeWeb): the in-window fair is the one combed; the
 *    other two are listed with their days; the hypothesis goes to EXPIRED.
 *  - The webhook Twenty sends back for that PATCH (actor API) is NOT a human verdict: no
 *    evaluation; a person rejecting the expired hypothesis afterwards is not scored either; a
 *    person expiring another one by hand neither. Reopening (EXPIRED -> PROPOSED) makes the next
 *    verdict count again.
 *  - Qualifying the 10-day fair: signal.qualified is emitted, the triggered run ends SKIPPED,
 *    leaves a note on the signal and the signal keeps QUALIFIED.
 * Dates are relative to today (Europe/Madrid). Fresh tenant, no DELETE. Skipped without database.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { evaluations, events, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { HYPOTHESIS_STATUS_CHANGED_EVENT, signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { EventTriggerConsumer, type EventTriggerRegistry, type RegisteredTrigger } from '../../src/scheduler/event-triggers.js';
import { seedProspectOnQualified } from '../../src/seed/prospect-on-qualified-seed.js';
import { PROSPECTOR_TASK_NAME, seedProspector } from '../../src/seed/prospector-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { madridToday } from '../../src/signals/lead-time.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const SECRET = 'it-leadtime-secret-0123456789';

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

const TODAY = madridToday(new Date());
const addDays = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const NO_LIST = JSON.stringify({ page_kind: 'event_home', event: null, exhibitors: [], exhibitors_page_url: null, notes: 'sin lista publicada' });
const IN_URL = 'https://www.feria-en-ventana.com/expositores';

describe.skipIf(!dbAvailable)('lead-time window: daily run, hypothesis expiry without HUMAN verdicts, trigger out of window (PostgreSQL)', () => {
  const tenant = `it-lt-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  const web = new FakeWeb().page(IN_URL, '<title>Feria En Ventana 2027</title><p>Expositores próximamente.</p>');
  const eventQueue = new MemoryEventQueue();
  const runQueue = new MemoryRunQueue();
  let handle: DbHandle;
  let bus: EventBus;
  let app: FastifyInstance;
  let consumer: EventTriggerConsumer;
  let processor: RunProcessor;
  let provider = new StubProvider({ responses: [] });
  let onQualifiedTaskId = '';

  const fair = (name: string, eventDate: string, url: string) =>
    fake.seed('commercialSignals', {
      name,
      signalType: 'FAIR',
      status: 'QUALIFIED',
      eventDate,
      sourceUrl: { primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] },
      sourceDomain: new URL(url).hostname.replace(/^www\./, ''),
      companyId: null,
      tenantId: tenant,
    });
  const inWindow = fair('Feria En Ventana 2027 (feria)', addDays(100), IN_URL);
  const close = fair('Gastrónoma 2026 (feria)', addDays(10), 'https://www.gastronoma.net/');
  const far = fair('Feria Lejana 2027 (feria)', addDays(300), 'https://www.feria-lejana.com/');
  const company = fake.seed('companies', { name: 'Conservas X', domainName: { primaryLinkUrl: 'conservasx.com', primaryLinkLabel: '', secondaryLinks: [] } });
  const exhibitorSignal = fake.seed('commercialSignals', {
    name: 'Salón Próximo 2026 — Conservas X',
    signalType: 'FAIR',
    status: 'NEW',
    eventDate: addDays(7),
    companyId: company.id,
    tenantId: tenant,
  });
  const nextWeek = fake.seed('commercialHypotheses', { name: 'Conservas X — Salón Próximo 2026', status: 'PROPOSED', companyId: company.id, commercialSignalId: exhibitorSignal.id, tenantId: tenant });

  const post = (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    return app.inject({
      method: 'POST',
      url: '/webhooks/twenty',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) },
    });
  };
  /** commercialHypothesis.updated as Twenty sends it (record after the change + names of the changed fields). */
  const hypothesisWebhook = (rec: Record<string, unknown>, actor: 'api' | 'person', updatedAt = new Date().toISOString()) => ({
    eventName: 'commercialHypothesis.updated',
    objectMetadata: { id: 'meta-h', nameSingular: 'commercialHypothesis' },
    workspaceId: 'ws-it',
    webhookId: 'wh-it',
    eventDate: updatedAt,
    ...(actor === 'person' ? { workspaceMemberId: 'member-1' } : {}),
    record: {
      ...rec,
      tenantId: tenant,
      updatedAt,
      updatedBy: actor === 'api' ? { source: 'API', workspaceMemberId: null, name: 'agent-runtime' } : { source: 'MANUAL', workspaceMemberId: 'member-1', name: 'Comercial' },
    },
    updatedFields: ['status'],
  });
  const evaluationsOf = (id: string) => handle.db.query.evaluations.findMany({ where: and(eq(evaluations.tenantId, tenant), eq(evaluations.subjectId, id)) });
  const markersOf = async (id: string) =>
    (await handle.db.query.events.findMany({ where: and(eq(events.tenantId, tenant), eq(events.type, HYPOTHESIS_STATUS_CHANGED_EVENT)) })).filter((e) => e.payload.hypothesis_id === id);

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    bus = new EventBus(handle.db, eventQueue, { tenantId: tenant });
    await seedProspector(handle.db, { tenantId: tenant });
    const seeded = await seedProspectOnQualified(handle.db, { tenantId: tenant });
    onQualifiedTaskId = seeded.taskId!;
    const registered: RegisteredTrigger = { task_id: onQualifiedTaskId, tenant_id: tenant, event_type: 'signal.qualified', filter: {}, registered_at: new Date().toISOString() };
    const registry = { list: async () => [registered], remove: async () => true } as unknown as EventTriggerRegistry;
    consumer = new EventTriggerConsumer(handle.db, runQueue, { triggers: registry, sync: async () => undefined }, { queueName: 'unused', redisUrl: 'redis://unused', events: bus });
    processor = new RunProcessor(handle.db, () => provider, { info() {}, warn() {}, error() {} }, createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: { endpoint: null } }), null);
    app = await buildServer({
      db: handle.db,
      queue: runQueue,
      config: { defaultTenantId: tenant, defaultModelProvider: 'stub', twentyWebhookSecret: SECRET, evaluationDedupeWindowMs: 600_000 },
      events: bus,
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('daily run: combs only the in-window fair, lists the other two with their days, expires the PROPOSED hypothesis of next week', async () => {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-lt:${tenant}:daily`, trigger: 'MANUAL' });
    provider = new StubProvider({ responses: [NO_LIST] });
    for (const { job } of queue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    expect(run!.status).toBe('COMPLETED');
    const out = run!.output as Record<string, unknown> & {
      lead_time: { in_window: number; too_close: Array<{ id: string; days: number }>; too_far: Array<{ id: string; days: number }>; chosen: { id: string; days: number } };
      hypothesis_expiry: { expired: Array<{ id: string; days: number }> };
    };
    expect(out.signal_id).toBe(inWindow.id);
    expect(out.lead_time.chosen).toMatchObject({ id: inWindow.id, days: 100 });
    expect(out.lead_time.too_close).toEqual([expect.objectContaining({ id: close.id, days: 10 })]);
    expect(out.lead_time.too_far).toEqual([expect.objectContaining({ id: far.id, days: 300 })]);
    expect(out.hypothesis_expiry.expired).toEqual([expect.objectContaining({ id: nextWeek.id, days: 7 })]);
    expect(fake.tables.commercialHypotheses.find((h) => h.id === nextWeek.id)!.status).toBe('EXPIRED');
    expect([close, far].map((s) => fake.tables.commercialSignals.find((r) => r.id === s.id)!.status)).toEqual(['QUALIFIED', 'QUALIFIED']);
    expect(web.requests.map((r) => r.url.toString())).toEqual([IN_URL]);
    expect(String(fake.tables.agentRunSummaries.at(-1)!.resultSummary)).toContain('Ventana de lead time');
  });

  it('the webhook of that PATCH (actor API) is not a human verdict; nor is a person rejecting the expired hypothesis afterwards', async () => {
    const id = nextWeek.id as string;
    const expiredAt = new Date(Date.now() - 2_000).toISOString();
    const res = await post(hypothesisWebhook({ id, name: nextWeek.name, status: 'EXPIRED', companyId: company.id }, 'api', expiredAt));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored', reason: 'transition to EXPIRED is an expiry, not a human verdict', expiry: true, status_marker: 'recorded' });
    // A replay of the same delivery: same marker, still no verdict.
    expect((await post(hypothesisWebhook({ id, name: nextWeek.name, status: 'EXPIRED', companyId: company.id }, 'api', expiredAt))).json()).toMatchObject({ status_marker: 'deduplicated' });
    expect(await markersOf(id)).toHaveLength(1);

    const rejected = await post(hypothesisWebhook({ id, name: nextWeek.name, status: 'REJECTED', companyId: company.id }, 'person'));
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'ignored', reason: 'EXPIRED -> REJECTED is not a verdict on the proposal' });
    expect(await evaluationsOf(id)).toHaveLength(0);
  });

  it('a person expiring a hypothesis by hand is not a verdict either; reopening it makes the next verdict count', async () => {
    const id = randomUUID();
    const t0 = Date.now() - 10_000;
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const manual = await post(hypothesisWebhook({ id, name: 'Empresa Y — Feria Z', status: 'EXPIRED', companyId: company.id }, 'person', at(0)));
    expect(manual.json()).toMatchObject({ status: 'ignored', expiry: true, status_marker: 'recorded' });
    expect(await evaluationsOf(id)).toHaveLength(0);

    const reopened = await post(hypothesisWebhook({ id, name: 'Empresa Y — Feria Z', status: 'PROPOSED', companyId: company.id }, 'person', at(1_000)));
    expect(reopened.json()).toMatchObject({ status: 'ignored', status_marker: 'recorded' });
    const validated = await post(hypothesisWebhook({ id, name: 'Empresa Y — Feria Z', status: 'VALIDATED', companyId: company.id }, 'person', at(2_000)));
    expect(validated.statusCode).toBe(201);
    expect(validated.json()).toMatchObject({ status: 'recorded', feedback: 'ACCEPTED' });
    const evals = await evaluationsOf(id);
    expect(evals).toHaveLength(1);
    expect(evals[0]!.details).toMatchObject({ from_status: 'PROPOSED', to_status: 'VALIDATED' });
  });

  it('qualifying the 10-day fair: signal.qualified is emitted, the run ends SKIPPED with a note on the signal, the signal keeps QUALIFIED', async () => {
    const res = await post({
      eventName: 'commercialSignal.updated',
      objectMetadata: { id: 'meta-s', nameSingular: 'commercialSignal' },
      workspaceId: 'ws-it',
      webhookId: 'wh-it',
      eventDate: new Date().toISOString(),
      record: { ...close, sourceUrl: { primaryLinkUrl: 'https://www.gastronoma.net/', primaryLinkLabel: '', secondaryLinks: [] }, updatedAt: new Date().toISOString() },
      updatedFields: ['status'],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().signal).toMatchObject({ status: 'emitted', signal_id: close.id });

    const [envelope] = eventQueue.drain().filter((e) => e.type === 'signal.qualified');
    const outcomes = await consumer.handleEvent(envelope!);
    expect(outcomes).toEqual([{ taskId: onQualifiedTaskId, outcome: 'created', taskRunId: expect.any(String) }]);
    const runId = (outcomes[0] as { taskRunId: string }).taskRunId;
    provider = new StubProvider({ responses: [] });
    const fetchesBefore = web.requests.length;
    for (const { job } of runQueue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, runId) });
    expect(run!.status).toBe('COMPLETED');
    expect(run!.output).toMatchObject({ outcome: 'SKIPPED', signal_id: close.id, lead_time: { status: 'too_close', days: 10 }, note: { created: true } });
    expect(provider.requests).toHaveLength(0);
    expect(web.requests.length).toBe(fetchesBefore);
    expect(fake.tables.commercialSignals.find((s) => s.id === close.id)!.status).toBe('QUALIFIED');
    const target = fake.tables.noteTargets.find((t) => t.targetCommercialSignalId === close.id);
    expect(target).toBeDefined();
    const note = fake.tables.notes.find((n) => n.id === target!.noteId)!;
    expect(String((note.bodyV2 as { markdown: string }).markdown)).toContain('⏳ Fuera de ventana: la feria es en 10 días');
  });
});
