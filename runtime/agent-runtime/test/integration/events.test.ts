/**
 * Event bus + EVENT triggers against real PostgreSQL + Redis (BullMQ).
 * Skipped when either is unreachable (or SKIP_DB_TESTS=1 / SKIP_REDIS_TESTS=1).
 *
 * Isolation: a fresh tenant (`ev-xxxxxxxx`), fresh BullMQ queue names and a re-publisher
 * scoped to that tenant, so it never dispatches other tenants' events. The test queues and
 * the test trigger registry key are removed at the end; `events` rows are append-only.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { events } from '../../src/db/schema.js';
import { EventEnvelopeSchema, type EventEnvelope } from '../../src/events/envelope.js';
import { BullEventQueue, EventBus, eventsQueueName, MemoryEventQueue } from '../../src/events/event-bus.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { BullRunQueue, redisConnectionFromUrl } from '../../src/queue/run-queue.js';
import { EventTriggerConsumer, triggerRegistryKey } from '../../src/scheduler/event-triggers.js';
import { BullTaskScheduler, scheduleQueueName } from '../../src/scheduler/task-scheduler.js';
import { startBullWorker } from '../../src/worker/bull-worker.js';
import { RunProcessor } from '../../src/worker/processor.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6391';

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

function redisReachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port || 6379) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.once('data', (d) => done(d.toString().startsWith('+PONG')));
  });
}

const available =
  process.env.SKIP_DB_TESTS !== '1' &&
  process.env.SKIP_REDIS_TESTS !== '1' &&
  (await databaseReachable(DATABASE_URL)) &&
  (await redisReachable(REDIS_URL));
if (!available) console.warn('[integration] PostgreSQL or Redis not reachable; skipping event bus tests');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

type ApiEvent = EventEnvelope & { source: string; dispatched_at: string | null; dispatch_attempts: number };

describe.skipIf(!available)('event bus + EVENT triggers (PostgreSQL + Redis)', () => {
  const tenant = `ev-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const queueName = `it-ev-runs-${randomUUID().slice(0, 8)}`;
  const evQueueName = eventsQueueName(queueName);
  let handle: DbHandle;
  let app: FastifyInstance;
  let runQueue: BullRunQueue;
  let eventQueue: BullEventQueue;
  let bus: EventBus;
  let scheduler: BullTaskScheduler;
  let consumer: EventTriggerConsumer;
  let worker: ReturnType<typeof startBullWorker>;
  let agentId: string;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    runQueue = new BullRunQueue(queueName, REDIS_URL);
    eventQueue = new BullEventQueue(evQueueName, REDIS_URL);
    await eventQueue.queue.waitUntilReady();
    bus = new EventBus(handle.db, eventQueue, { tenantId: tenant, republishGraceMs: 0 });
    scheduler = new BullTaskScheduler(handle.db, runQueue, {
      queueName: scheduleQueueName(queueName),
      redisUrl: REDIS_URL,
      tenantId: tenant,
      eventsQueueName: evQueueName,
      events: bus,
    });
    await scheduler.queue.waitUntilReady();
    app = await buildServer({
      db: handle.db,
      queue: runQueue,
      scheduler,
      events: bus,
      config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' },
    });
    const processor = new RunProcessor(handle.db, createProviderRegistry());
    processor.events = bus;
    worker = startBullWorker(processor, { queueName, redisUrl: REDIS_URL, concurrency: 4, logger: { info() {}, warn() {}, error() {} } });
    consumer = new EventTriggerConsumer(handle.db, runQueue, scheduler, { queueName: evQueueName, redisUrl: REDIS_URL, events: bus, maxChainDepth: 5 });
    consumer.start();

    const res = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name: 'Event agent' } });
    expect(res.statusCode).toBe(201);
    agentId = res.json().agent.id;
  });

  afterAll(async () => {
    await consumer?.close();
    await worker?.close();
    const registryQueue = scheduler?.queue;
    if (registryQueue) await (await registryQueue.getBackend().client).del(triggerRegistryKey(evQueueName)).catch(() => undefined);
    await scheduler?.close();
    await bus?.close();
    await runQueue?.close();
    await app?.close();
    for (const name of [queueName, scheduleQueueName(queueName), evQueueName]) {
      const q = new Queue(name, { connection: redisConnectionFromUrl(REDIS_URL) });
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
    await handle?.close();
  });

  async function createTask(payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/tasks', headers, payload: { agent_id: agentId, ...payload } });
    expect(res.statusCode).toBe(201);
    return res.json().task as { id: string };
  }

  async function runTask(taskId: string, scheduledAt?: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${taskId}/run`,
      headers,
      payload: scheduledAt ? { scheduled_at: scheduledAt } : {},
    });
    expect(res.statusCode).toBe(202);
    return res.json().task_run as { id: string };
  }

  async function runsOf(taskId: string) {
    const res = await app.inject({ method: 'GET', url: `/tasks/${taskId}/runs?limit=100`, headers });
    return res.json().items as Array<Record<string, any>>;
  }

  async function listEvents(query: string): Promise<ApiEvent[]> {
    const res = await app.inject({ method: 'GET', url: `/events?${query}`, headers });
    expect(res.statusCode).toBe(200);
    return res.json().items as ApiEvent[];
  }

  async function completedEventOf(runId: string): Promise<ApiEvent> {
    return waitFor(
      async () => (await listEvents(`type=task.completed&correlation_id=${runId}`))[0],
      15_000,
      `task.completed of ${runId}`,
    );
  }

  /** Waits until the consumer has processed the event's job and returns its outcomes. */
  async function consumed(eventId: string) {
    return waitFor(
      async () => {
        const job = await eventQueue.queue.getJob(eventId);
        return job && (await job.getState()) === 'completed' ? (job.returnvalue as Array<Record<string, unknown>>) : undefined;
      },
      15_000,
      `consumption of ${eventId}`,
    );
  }

  it('a completed run publishes task.scheduled/started/completed and agent.execution.started/completed', async () => {
    const task = await createTask({ name: 'emits events' });
    const run = await runTask(task.id);
    const completed = await completedEventOf(run.id);

    const { source, dispatched_at, dispatch_attempts, ...envelope } = completed;
    expect(EventEnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(completed).toMatchObject({
      type: 'task.completed',
      schemaVersion: 'task.completed.v1',
      tenantId: tenant,
      producer: 'agent-runtime',
      correlationId: run.id,
      idempotencyKey: `evt:task.completed:${run.id}`,
      data: { taskRunId: run.id, taskDefinitionId: task.id, status: 'COMPLETED', chainDepth: 0 },
    });
    expect(typeof completed.data.costEur).toBe('number');
    expect(source).toBe('runtime');
    expect(dispatched_at).not.toBeNull();
    expect(dispatch_attempts).toBe(1);
    // The job is on the events queue under the event id.
    expect(await eventQueue.queue.getJob(completed.id)).toBeTruthy();

    const all = await waitFor(
      async () => {
        const items = await listEvents(`correlation_id=${run.id}&order=asc`);
        return items.length >= 5 ? items : undefined;
      },
      10_000,
      'all run events',
    );
    expect(all.map((e) => e.type).sort()).toEqual(
      ['agent.execution.completed', 'agent.execution.started', 'task.completed', 'task.scheduled', 'task.started'].sort(),
    );
    expect(all[0]!.type).toBe('task.scheduled');
    expect(all.find((e) => e.type === 'task.scheduled')!.data).toMatchObject({ trigger: 'MANUAL', taskRunId: run.id });
    const exec = all.find((e) => e.type === 'agent.execution.completed')!;
    expect(exec.data).toMatchObject({ taskRunId: run.id, taskDefinitionId: task.id, status: 'COMPLETED' });
    expect(JSON.stringify(exec.data).length).toBeLessThan(2000); // compact: never the trace

    // Filters: type prefix, since, limit.
    expect((await listEvents('type=task.*&limit=200')).every((e) => e.type.startsWith('task.'))).toBe(true);
    expect(await listEvents(`since=${new Date(Date.now() + 60_000).toISOString()}`)).toHaveLength(0);
    expect(await listEvents('limit=2')).toHaveLength(2);
    // Other tenants see nothing of this one.
    const foreign = await app.inject({ method: 'GET', url: `/events?correlation_id=${run.id}`, headers: { 'x-tenant-id': `${tenant}-x` } });
    expect(foreign.json().items).toHaveLength(0);
  });

  it('rejects malformed EVENT schedules with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { name: 'bad event', agent_id: agentId, schedule: { type: 'EVENT' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_schedule');
  });

  it('an EVENT task fires once per matching event, never on a republish, and pause unregisters it', async () => {
    const source = await createTask({ name: 'source task' });
    const follower = await createTask({
      name: 'follower task',
      default_input: { mode: 'follow-up' },
      schedule: { type: 'EVENT', event_type: 'task.completed', filter: { taskDefinitionId: source.id, status: 'COMPLETED' } },
    });

    const sched = (await app.inject({ method: 'GET', url: `/tasks/${follower.id}/schedule`, headers })).json();
    expect(sched).toMatchObject({
      in_sync: true,
      registered: null,
      event_trigger: { desired: { eventType: 'task.completed' }, registered: { task_id: follower.id, event_type: 'task.completed' } },
    });
    const status = (await app.inject({ method: 'GET', url: '/scheduler/status', headers })).json();
    expect(status.items).toContainEqual(expect.objectContaining({ kind: 'event', task_id: follower.id, event_type: 'task.completed' }));

    const sourceRun = await runTask(source.id);
    const trigger = await completedEventOf(sourceRun.id);
    const outcomes = await consumed(trigger.id);
    expect(outcomes).toContainEqual(expect.objectContaining({ taskId: follower.id, outcome: 'created' }));

    const [followerRun] = await waitFor(
      async () => {
        const runs = await runsOf(follower.id);
        return runs.length === 1 && runs[0]!.status === 'COMPLETED' ? runs : undefined;
      },
      15_000,
      'follower run completed',
    );
    expect(followerRun!.idempotency_key).toBe(`taskrun:${follower.id}:event:${trigger.id}`);
    expect(followerRun!.input).toMatchObject({ mode: 'follow-up', event: { id: trigger.id, type: 'task.completed', data: { taskRunId: sourceRun.id } } });

    // The follower's own events carry chainDepth 1 and the EVENT origin.
    const followerScheduled = (await listEvents(`type=task.scheduled&correlation_id=${followerRun!.id}`))[0]!;
    expect(followerScheduled).toMatchObject({ producer: 'scheduler', data: { trigger: 'EVENT', chainDepth: 1 } });
    const followerDone = await completedEventOf(followerRun!.id);
    expect(followerDone.data.chainDepth).toBe(1);

    // Republishing the same event never creates a second TaskRun:
    // (1) direct redelivery to the consumer,
    const { source: _s, dispatched_at: _d, dispatch_attempts: _a, ...envelope } = trigger;
    const again = await consumer.handleEvent(envelope);
    expect(again).toContainEqual({ taskId: follower.id, outcome: 'deduplicated', taskRunId: followerRun!.id });
    // (2) a second queue job with the same envelope (as if the first one had been removed),
    await eventQueue.queue.add(envelope.type, envelope as EventEnvelope, { jobId: `${envelope.id}-redelivery` });
    await waitFor(
      async () => {
        const job = await eventQueue.queue.getJob(`${envelope.id}-redelivery`);
        return job && (await job.getState()) === 'completed';
      },
      15_000,
      'redelivery consumed',
    );
    // (3) a publish with the same idempotency key returns the existing row.
    const republished = await bus.publish({
      tenantId: tenant,
      type: 'task.completed',
      correlationId: sourceRun.id,
      idempotencyKey: trigger.idempotencyKey!,
      data: trigger.data,
    });
    expect(republished).toMatchObject({ created: false, dispatched: true, event: { id: trigger.id } });
    expect(await runsOf(follower.id)).toHaveLength(1);

    // A non-matching event fires nothing.
    const other = await consumer.handleEvent({ ...envelope, id: randomUUID(), data: { ...envelope.data, taskDefinitionId: randomUUID() } });
    expect(other).toContainEqual({ taskId: follower.id, outcome: 'filter_mismatch' });

    // Pause unregisters; a new matching event does not fire the follower.
    expect((await app.inject({ method: 'POST', url: `/tasks/${follower.id}/pause`, headers })).statusCode).toBe(200);
    const paused = (await app.inject({ method: 'GET', url: `/tasks/${follower.id}/schedule`, headers })).json();
    expect(paused).toMatchObject({ in_sync: true, event_trigger: { desired: null, registered: null } });
    const secondRun = await runTask(source.id, new Date(Date.now() - 3_600_000).toISOString());
    const secondEvent = await completedEventOf(secondRun.id);
    const secondOutcomes = await consumed(secondEvent.id);
    expect(secondOutcomes.find((o) => o.taskId === follower.id)).toBeUndefined();
    expect(await runsOf(follower.id)).toHaveLength(1);

    // Resume registers again; archive removes it for good.
    expect((await app.inject({ method: 'POST', url: `/tasks/${follower.id}/resume`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/tasks/${follower.id}/schedule`, headers })).json().event_trigger.registered).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: `/tasks/${follower.id}/archive`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/tasks/${follower.id}/schedule`, headers })).json().event_trigger.registered).toBeNull();
  });

  it('anti-loop guard: a task ignores its own events and chains stop at max depth', async () => {
    const catchAll = await createTask({ name: 'catch-all', schedule: { type: 'EVENT', event_type: 'agent.execution.failed' } });
    const base = {
      type: 'agent.execution.failed',
      schemaVersion: 'agent.execution.failed.v1',
      tenantId: tenant,
      occurredAt: new Date().toISOString(),
      producer: 'n8n' as const,
      correlationId: randomUUID(),
    };
    const own = await consumer.handleEvent({ ...base, id: randomUUID(), data: { taskDefinitionId: catchAll.id } });
    expect(own).toEqual([{ taskId: catchAll.id, outcome: 'self_event' }]);
    const deep = await consumer.handleEvent({ ...base, id: randomUUID(), data: { taskDefinitionId: randomUUID(), chainDepth: 5 } });
    expect(deep).toEqual([{ taskId: catchAll.id, outcome: 'chain_depth_exceeded' }]);

    // depth 4 still fires (the new run is depth 5) - published through the bus as an n8n event.
    const published = await bus.publish({ ...base, data: { taskDefinitionId: randomUUID(), chainDepth: 4 } });
    const outcomes = await consumed(published.event.id);
    expect(outcomes).toContainEqual(expect.objectContaining({ taskId: catchAll.id, outcome: 'created' }));
    const row = await handle.db.query.events.findFirst({ where: eq(events.id, published.event.id) });
    expect(row?.source).toBe('n8n');
    const [run] = await waitFor(async () => {
      const runs = await runsOf(catchAll.id);
      return runs.length === 1 ? runs : undefined;
    }, 10_000, 'catch-all run');
    const scheduled = (await listEvents(`type=task.scheduled&correlation_id=${run!.id}`))[0]!;
    expect(scheduled.data.chainDepth).toBe(5);
    await app.inject({ method: 'POST', url: `/tasks/${catchAll.id}/archive`, headers });
  });

  it('publish is best-effort: with Redis down the row stays and the re-publisher dispatches it', async () => {
    const memory = new MemoryEventQueue();
    memory.failing = true;
    const offline = new EventBus(handle.db, memory, { tenantId: tenant, republishGraceMs: 0 });
    const res = await offline.publish({ tenantId: tenant, type: 'signal.detected', correlationId: randomUUID(), producer: 'twenty-app', data: { signalId: 's1' } });
    expect(res).toMatchObject({ created: true, dispatched: false });
    let row = await handle.db.query.events.findFirst({ where: eq(events.id, res.event.id) });
    expect(row).toMatchObject({ dispatchedAt: null, dispatchAttempts: 1, source: 'twenty' });

    // Still down: the pass stops at the first failure.
    expect(await offline.republishPending()).toMatchObject({ dispatched: 0, failed: 1 });
    memory.failing = false;
    const pass = await offline.republishPending();
    expect(pass.dispatched).toBeGreaterThanOrEqual(1);
    row = await handle.db.query.events.findFirst({ where: eq(events.id, res.event.id) });
    expect(row?.dispatchedAt).not.toBeNull();
    expect(memory.jobs.get(res.event.id)?.data).toEqual({ signalId: 's1' });
    // Dispatched rows are not picked again.
    expect((await offline.republishPending()).scanned).toBe(0);

    // The log is append-only.
    await expect(handle.db.execute(sql`delete from events where id = ${res.event.id}`)).rejects.toThrow();
  });
});
