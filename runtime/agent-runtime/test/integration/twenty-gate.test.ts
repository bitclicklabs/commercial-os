/**
 * Twenty health gate end to end (PostgreSQL + Redis/BullMQ), reproducing the 2026-10-07 boot
 * race: the worker gets a run while Twenty is still down. Twenty is simulated by a closed
 * local port; "Twenty comes up" = a tiny HTTP server starts answering /healthz on that port.
 * The agent is the stub (it does not call tools): the test is about when the run starts.
 *
 * Isolation as in scheduler.test.ts: fresh tenant and throwaway queue, obliterated at the end.
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { toQueueJobId } from '../../src/domain/idempotency.js';
import { TwentyClient } from '../../src/integrations/twenty/index.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { BullRunQueue, redisConnectionFromUrl } from '../../src/queue/run-queue.js';
import { startBullWorker } from '../../src/worker/bull-worker.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { TwentyGate } from '../../src/worker/twenty-gate.js';

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
if (!available) console.warn('[integration] PostgreSQL or Redis not reachable; skipping Twenty gate tests');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** A free port nobody listens on (yet). */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** Fake Twenty that only answers /healthz. */
function startFakeTwenty(port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

describe.skipIf(!available)('Twenty health gate (PostgreSQL + Redis)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const queueName = `it-runs-${randomUUID().slice(0, 8)}`;
  const MAX_WAIT_MS = 2_500;
  const warnings: Array<{ obj: object; msg?: string }> = [];
  let handle: DbHandle;
  let app: FastifyInstance;
  let runQueue: BullRunQueue;
  let inspect: Queue;
  let worker: ReturnType<typeof startBullWorker>;
  let port: number;
  let fakeTwenty: http.Server | undefined;
  let twentyAgentId: string;
  let plainAgentId: string;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    runQueue = new BullRunQueue(queueName, REDIS_URL);
    inspect = new Queue(queueName, { connection: redisConnectionFromUrl(REDIS_URL) });
    app = await buildServer({ db: handle.db, queue: runQueue, config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });

    port = await closedPort();
    const twenty = new TwentyClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'it-not-a-real-key' });
    const gate = new TwentyGate(
      { isConfigured: () => twenty.isConfigured(), health: () => twenty.health(500) },
      { maxWaitMs: MAX_WAIT_MS, stepsMs: [200, 400], healthCacheMs: 0, jitterMs: 0 },
    );
    const logger = {
      info() {},
      warn: (obj: object, msg?: string) => void warnings.push({ obj, msg }),
      error() {},
    };
    const processor = new RunProcessor(handle.db, createProviderRegistry(), logger, undefined, gate);
    worker = startBullWorker(processor, { queueName, redisUrl: REDIS_URL, concurrency: 2, logger });

    const mk = async (name: string, configuration: Record<string, unknown>) => {
      const res = await app.inject({ method: 'POST', url: '/agents', headers, payload: { name, version: { system_prompt: 'gate', configuration } } });
      expect(res.statusCode).toBe(201);
      return res.json().agent.id as string;
    };
    twentyAgentId = await mk('Twenty agent', { tool_policy: ['find_company', 'create_signal'] });
    plainAgentId = await mk('No-tools agent', {});
  });

  afterAll(async () => {
    await worker?.close();
    await runQueue?.close();
    await inspect?.obliterate({ force: true }).catch(() => undefined);
    await inspect?.close();
    await app?.close();
    await new Promise<void>((r) => (fakeTwenty ? fakeTwenty.close(() => r()) : r()));
    await handle?.close();
  });

  async function runTask(agentId: string, name: string) {
    const task = await app.inject({ method: 'POST', url: '/tasks', headers, payload: { agent_id: agentId, name } });
    expect(task.statusCode).toBe(201);
    const taskId = task.json().task.id as string;
    const res = await app.inject({ method: 'POST', url: `/tasks/${taskId}/run`, headers, payload: { scheduled_at: '2026-10-07T08:00:00+02:00' } });
    expect(res.statusCode).toBe(202);
    return taskId;
  }

  async function onlyRun(taskId: string) {
    const res = await app.inject({ method: 'GET', url: `/tasks/${taskId}/runs?limit=10`, headers });
    return (res.json().items as Array<Record<string, any>>)[0]!;
  }

  it('an agent without Twenty tools is not held while Twenty is down', async () => {
    const taskId = await runTask(plainAgentId, 'no twenty');
    const run = await waitFor(async () => {
      const r = await onlyRun(taskId);
      return r.status === 'COMPLETED' ? r : undefined;
    }, 5_000, 'plain run completed');
    expect(run.attempts).toBe(1);
  });

  it('Twenty down: the run stays QUEUED in a delayed job without consuming attempts; Twenty up: it runs', async () => {
    const taskId = await runTask(twentyAgentId, 'down then up');
    const queued = await onlyRun(taskId);
    const jobId = toQueueJobId(queued.idempotency_key);

    // Deferred at least twice while the port is closed.
    const job = await waitFor(async () => {
      const j = await inspect.getJob(jobId);
      return j && (j.data as { twentyWait?: { deferrals: number } }).twentyWait?.deferrals! >= 2 ? j : undefined;
    }, 5_000, 'two deferrals');
    expect(job.attemptsMade).toBe(0);
    expect(await job.getState()).toBe('delayed');
    const meanwhile = await onlyRun(taskId);
    expect(meanwhile).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(warnings.some((w) => w.msg === 'Twenty not healthy; deferring task run')).toBe(true);

    fakeTwenty = await startFakeTwenty(port);
    const done = await waitFor(async () => {
      const r = await onlyRun(taskId);
      return r.status === 'COMPLETED' ? r : undefined;
    }, 5_000, 'run completed once Twenty is up');
    expect(done.attempts).toBe(1);
    expect((await inspect.getJob(jobId))?.attemptsMade).toBe(1);

    await new Promise<void>((r) => fakeTwenty!.close(() => r()));
    fakeTwenty = undefined;
  });

  it('past TWENTY_WAIT_MAX_MS the run proceeds anyway', async () => {
    const started = Date.now();
    const taskId = await runTask(twentyAgentId, 'cap exceeded');
    const done = await waitFor(async () => {
      const r = await onlyRun(taskId);
      return r.status === 'COMPLETED' ? r : undefined;
    }, MAX_WAIT_MS + 5_000, 'run completed after the cap');
    expect(Date.now() - started).toBeGreaterThanOrEqual(MAX_WAIT_MS - 100);
    expect(done.attempts).toBe(1);
    expect(warnings.some((w) => w.msg === 'Twenty still not healthy after TWENTY_WAIT_MAX_MS; running anyway')).toBe(true);
  });
});
