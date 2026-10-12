/**
 * Qualified signal end to end against a real PostgreSQL (no Redis, no network):
 * signed Twenty webhook (commercialSignal -> QUALIFIED) -> `signal.qualified` persisted by the
 * EventBus -> EVENT trigger of the seeded `prospect-on-qualified` task -> TaskRun QUEUED with the
 * targeted scout input + audit row `prospect.on_qualified`. Replays and requalifications within
 * 24 h create nothing; past the window concurrent deliveries create exactly one event.
 * Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { auditLog, events, taskRuns } from '../../src/db/schema.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { EventTriggerConsumer, type EventTriggerRegistry, type RegisteredTrigger } from '../../src/scheduler/event-triggers.js';
import { loadSeedInput } from '../../src/seed/index.js';
import { PROSPECT_ON_QUALIFIED_TASK_NAME, seedProspectOnQualified } from '../../src/seed/prospect-on-qualified-seed.js';
import { seedProspector } from '../../src/seed/prospector-seed.js';
import { processSignalQualification, SIGNAL_REFIRE_WINDOW_MS } from '../../src/signals/qualified.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const SECRET = 'it-signal-secret-0123456789';

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

describe.skipIf(!dbAvailable)('qualified signal: Twenty webhook -> signal.qualified -> prospect-on-qualified (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const signalId = randomUUID();
  const eventQueue = new MemoryEventQueue();
  const runQueue = new MemoryRunQueue();
  let handle: DbHandle;
  let bus: EventBus;
  let app: FastifyInstance;
  let consumer: EventTriggerConsumer;
  let taskId: string;

  const record = (extra: Record<string, unknown> = {}) => ({
    id: signalId,
    name: 'Expo Foods Madrid 2026 (feria)',
    signalType: 'FAIR',
    status: 'QUALIFIED',
    sourceUrl: { primaryLinkUrl: 'https://expofoods.example/expositores', primaryLinkLabel: '', secondaryLinks: [] },
    eventDate: '2026-11-24',
    tenantId: tenant,
    companyId: null,
    deletedAt: null,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  const payload = (rec: Record<string, unknown>, updatedFields: string[] | null = ['status'], eventName = 'commercialSignal.updated') => ({
    eventName,
    objectMetadata: { id: 'meta-signal', nameSingular: 'commercialSignal' },
    workspaceId: 'ws-it',
    webhookId: 'wh-it',
    eventDate: new Date().toISOString(),
    record: rec,
    ...(updatedFields ? { updatedFields } : {}),
  });
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
  const signalEvents = () =>
    handle.db.query.events.findMany({ where: and(eq(events.tenantId, tenant), eq(events.type, 'signal.qualified')), orderBy: events.createdAt });
  const runsOfTask = () => handle.db.query.taskRuns.findMany({ where: and(eq(taskRuns.tenantId, tenant), eq(taskRuns.taskDefinitionId, taskId)) });
  const auditRows = () => handle.db.query.auditLog.findMany({ where: and(eq(auditLog.tenantId, tenant), eq(auditLog.action, 'prospect.on_qualified')) });

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    bus = new EventBus(handle.db, eventQueue, { tenantId: tenant });
    await seedProspector(handle.db, { tenantId: tenant, defaultInput: loadSeedInput() });
    const seeded = await seedProspectOnQualified(handle.db, { tenantId: tenant });
    expect(seeded.taskAction).toBe('created');
    expect((await seedProspectOnQualified(handle.db, { tenantId: tenant })).taskAction).toBe('unchanged');
    taskId = seeded.taskId!;
    // Registry stub (no Redis): what BullTaskScheduler.syncTask registers for this EVENT task.
    const registered: RegisteredTrigger = { task_id: taskId, tenant_id: tenant, event_type: 'signal.qualified', filter: {}, registered_at: new Date().toISOString() };
    const registry = { list: async () => [registered], remove: async () => true } as unknown as EventTriggerRegistry;
    consumer = new EventTriggerConsumer(handle.db, runQueue, { triggers: registry, sync: async () => undefined }, { queueName: 'unused', redisUrl: 'redis://unused', events: bus });
    app = await buildServer({
      db: handle.db,
      queue: runQueue,
      config: { defaultTenantId: tenant, defaultModelProvider: 'stub', twentyWebhookSecret: SECRET },
      events: bus,
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('seed: the task hangs from the Prospector and the seed without the agent is skipped', async () => {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: (t, { eq: e }) => e(t.id, taskId) });
    expect(task).toMatchObject({ name: PROSPECT_ON_QUALIFIED_TASK_NAME, status: 'ACTIVE', enabled: true, defaultInput: { mode: 'scout', max_events: 1 } });
    expect(task!.schedule).toMatchObject({ type: 'EVENT', event_type: 'signal.qualified', input_from_event: { event_url: 'event_url', event_name: 'name', signal_id: 'signal_id' } });
    expect((await seedProspectOnQualified(handle.db, { tenantId: `${tenant}-none` })).taskAction).toBe('skipped_no_agent');
  });

  it('a per-exhibitor signal (with company) is ignored: no event, no run', async () => {
    const res = await post(payload(record({ id: randomUUID(), companyId: randomUUID(), name: 'Expo Foods — Acme' })));
    expect(res.statusCode).toBe(200);
    expect(res.json().signal).toMatchObject({ status: 'ignored', reason: 'per-exhibitor signal (has companyId)' });
    expect(await signalEvents()).toHaveLength(0);
  });

  it('signed webhook -> signal.qualified -> TaskRun with the scout input and the audit row', async () => {
    const res = await post(payload(record()));
    expect(res.statusCode).toBe(202);
    const signal = res.json().signal as { status: string; event_id: string; dispatched: boolean };
    expect(signal).toMatchObject({ status: 'emitted', signal_id: signalId, dispatched: true });

    const [row] = await signalEvents();
    expect(row).toMatchObject({ id: signal.event_id, idempotencyKey: `evt:signal.qualified:${signalId}:first`, schemaVersion: 'signal.qualified.v1' });
    expect(row!.payload).toMatchObject({
      signal_id: signalId,
      name: 'Expo Foods Madrid 2026',
      event_url: 'https://expofoods.example/expositores',
      event_date: '2026-11-24',
      chainDepth: 0,
    });

    const [envelope] = eventQueue.drain().filter((e) => e.type === 'signal.qualified');
    expect(envelope!.id).toBe(signal.event_id);
    const outcomes = await consumer.handleEvent(envelope);
    expect(outcomes).toEqual([{ taskId, outcome: 'created', taskRunId: expect.any(String) }]);
    const runId = (outcomes[0] as { taskRunId: string }).taskRunId;

    const [run] = await runsOfTask();
    expect(run).toMatchObject({ id: runId, status: 'QUEUED', idempotencyKey: `taskrun:${taskId}:event:${envelope!.id}` });
    expect(run!.input).toMatchObject({
      mode: 'scout',
      max_events: 1,
      event_url: 'https://expofoods.example/expositores',
      event_name: 'Expo Foods Madrid 2026',
      signal_id: signalId,
      event: { id: envelope!.id, type: 'signal.qualified' },
    });
    expect(runQueue.jobs.size).toBe(1);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: 'system',
      action: 'prospect.on_qualified',
      subjectType: 'commercial_signal',
      subjectId: signalId,
      method: 'EVENT',
      route: 'event:signal.qualified',
      result: 'ok',
      payload: { signal_id: signalId, run_id: runId, event_id: envelope!.id, task_id: taskId },
    });
  });

  it('the same webhook again, or the same event delivered twice, does not duplicate anything', async () => {
    const res = await post(payload(record()));
    expect(res.statusCode).toBe(200);
    expect(res.json().signal).toMatchObject({ status: 'within_window', signal_id: signalId });
    // Only task.scheduled (from the run created above) is on the queue: no new signal.qualified.
    expect(eventQueue.drain().filter((e) => e.type === 'signal.qualified')).toHaveLength(0);

    const [row] = await signalEvents();
    const envelope = {
      id: row!.id,
      type: row!.type,
      schemaVersion: row!.schemaVersion,
      tenantId: row!.tenantId,
      occurredAt: row!.occurredAt.toISOString(),
      producer: row!.producer,
      correlationId: row!.correlationId,
      idempotencyKey: row!.idempotencyKey!,
      data: row!.payload,
    };
    expect(await consumer.handleEvent(envelope)).toEqual([{ taskId, outcome: 'deduplicated', taskRunId: expect.any(String) }]);
    expect(await signalEvents()).toHaveLength(1);
    expect(await runsOfTask()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('qualify -> unqualify -> requalify (or created already QUALIFIED) within 24 h does not relaunch', async () => {
    expect((await post(payload(record({ status: 'DISCARDED' })))).json().signal).toMatchObject({ status: 'ignored' });
    expect((await post(payload(record()))).json().signal).toMatchObject({ status: 'within_window' });
    expect((await post(payload(record(), null, 'commercialSignal.created'))).json().signal).toMatchObject({ status: 'within_window' });
    expect(await signalEvents()).toHaveLength(1);
    expect(await runsOfTask()).toHaveLength(1);
  });

  it('past 24 h a requalification fires once, even with concurrent deliveries (chained key)', async () => {
    // A signal whose last firing is 25 h old (row written with that creation time).
    const oldSignal = randomUUID();
    const previousId = randomUUID();
    const old = new Date(Date.now() - SIGNAL_REFIRE_WINDOW_MS - 3600_000);
    await handle.db.insert(events).values({
      id: previousId,
      tenantId: tenant,
      type: 'signal.qualified',
      schemaVersion: 'signal.qualified.v1',
      occurredAt: old,
      createdAt: old,
      dispatchedAt: old,
      payload: { signal_id: oldSignal, name: 'Feria antigua', event_url: 'https://old.example/', chainDepth: 0 },
      source: 'runtime',
      producer: 'agent-runtime',
      correlationId: `signal:${oldSignal}`,
      idempotencyKey: `evt:signal.qualified:${oldSignal}:first`,
    });
    eventQueue.drain();
    const body = payload(record({ id: oldSignal, name: 'Feria antigua (feria)', sourceUrl: { primaryLinkUrl: 'https://old.example/' } }));
    const outcomes = await Promise.all([
      processSignalQualification(handle.db, body, { defaultTenantId: tenant, events: bus }),
      processSignalQualification(handle.db, body, { defaultTenantId: tenant, events: bus }),
    ]);
    // The loser either computed the same chained key (deduplicated) or already saw the new event (window).
    expect(outcomes.filter((o) => o.status === 'emitted')).toHaveLength(1);
    expect(outcomes.every((o) => ['emitted', 'deduplicated', 'within_window'].includes(o.status))).toBe(true);
    const mine = (await signalEvents()).filter((e) => e.payload.signal_id === oldSignal);
    expect(mine).toHaveLength(2);
    expect(mine[1]!.idempotencyKey).toBe(`evt:signal.qualified:${oldSignal}:${previousId}`);

    const queued = eventQueue.drain().filter((e) => e.type === 'signal.qualified');
    expect(queued).toHaveLength(1);
    expect(await consumer.handleEvent(queued[0])).toEqual([{ taskId, outcome: 'created', taskRunId: expect.any(String) }]);
    expect(await runsOfTask()).toHaveLength(2);
    expect((await auditRows()).map((r) => r.subjectId).sort()).toEqual([oldSignal, signalId].sort());
  });
});
