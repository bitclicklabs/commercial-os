/**
 * HUMAN evaluator against a real PostgreSQL, fed with the REAL Twenty 2.45 webhook payloads
 * captured in test/fixtures (re-signed with a test secret, record id and tenant replaced).
 * Skipped when the database is not reachable. Fresh tenant per run, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, traces, traceSteps } from '../../src/db/schema.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const SECRET = 'it-secret-0123456789abcdef';

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

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const loadFixture = (name: string) =>
  JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8')) as { headers: Record<string, string>; body: Record<string, unknown> };

describe.skipIf(!dbAvailable)('HUMAN evaluator (PostgreSQL + real Twenty payloads)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const linkedId = randomUUID();
  const unlinkedId = randomUUID();
  const companyId = randomUUID();
  let handle: DbHandle;
  let app: FastifyInstance;
  let originExecutionId = '';
  let rerunExecutionId = '';

  /** Builds a webhook delivery from a captured fixture, as Twenty would sign it. */
  function delivery(fixture: string, record: Record<string, unknown>, updatedFields?: string[]) {
    const f = loadFixture(fixture);
    const body = {
      ...f.body,
      record: { ...(f.body.record as Record<string, unknown>), tenantId: tenant, companyId, ...record, updatedAt: new Date().toISOString() },
      ...(updatedFields ? { updatedFields } : {}),
    };
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    return app.inject({
      method: 'POST',
      url: '/webhooks/twenty',
      payload: raw,
      headers: { ...f.headers, 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) },
    });
  }

  async function seedRun(created: boolean, hypothesisId: string, at: Date): Promise<string> {
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name: `it-agent-${randomUUID().slice(0, 6)}` }).returning();
    const [version] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'stub', modelProvider: 'stub' })
      .returning();
    const [execution] = await handle.db
      .insert(agentExecutions)
      .values({ tenantId: tenant, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', output: { ok: true } })
      .returning();
    const [trace] = await handle.db.insert(traces).values({ tenantId: tenant, executionId: execution!.id, agentId: agent!.id }).returning();
    await handle.db.insert(traceSteps).values({
      tenantId: tenant,
      traceId: trace!.id,
      sequence: 1,
      timestamp: at,
      type: 'TOOL',
      tool: 'create_hypothesis',
      toolInput: {
        companyId,
        need: '[TEST] 200 lanyards',
        whyNow: 'Captura de payload',
        quantityMin: 100,
        quantityMax: 200,
        budgetMinEur: 500,
        recommendedProducts: ['SKU-TEST-1'],
        timing: 'THIS_QUARTER',
      },
      toolOutput: { created, idempotencyKey: `publi:hypothesis:create:${companyId}:x`, record: { id: hypothesisId, status: 'PROPOSED' } },
    });
    return execution!.id;
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    // Origin run (created=true) and an idempotent re-run (created=false) that must lose.
    originExecutionId = await seedRun(true, linkedId, new Date(Date.now() - 60_000));
    rerunExecutionId = await seedRun(false, linkedId, new Date(Date.now() - 30_000));
    app = await buildServer({
      db: handle.db,
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: tenant, defaultModelProvider: 'stub', twentyWebhookSecret: SECRET, evaluationDedupeWindowMs: 600_000 },
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('EDITED while PROPOSED (real edit payload): diff against the agent proposal, linked to the origin run', async () => {
    const res = await delivery('twenty-webhook-hypothesis-edit.json', { id: linkedId, status: 'PROPOSED' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'recorded', feedback: 'EDITED', score: 0.5, agentExecutionId: originExecutionId, linkResolved: true });
    const list = await app.inject({ method: 'GET', url: `/evaluations?subject_id=${linkedId}`, headers: { 'x-tenant-id': tenant } });
    const [e] = list.json().items;
    expect(e).toMatchObject({ kind: 'HUMAN', subject_type: 'hypothesis', feedback: 'EDITED', score: 0.5, source: 'twenty_webhook' });
    expect(e.details).toMatchObject({
      from_status: 'PROPOSED',
      to_status: 'PROPOSED',
      edited_fields_before_source: 'agent_proposal',
      edited_fields: {
        need: { before: '[TEST] 200 lanyards', after: '[TEST] 300 lanyards impresos' },
        quantityMax: { before: 200, after: 250 },
        budgetMin: { before: 500, after: 600 },
        budgetMax: { before: null, after: 900 },
      },
      link: { resolved: true, method: 'trace_output', candidates: 2 },
      actor: { source: 'API', name: 'agent-runtime', human: false },
    });
    expect(e.agent_execution_id).not.toBe(rerunExecutionId);
  });

  it('VALIDATED after editing is EDITED (to VALIDATED); a replay is deduplicated', async () => {
    const first = await delivery('twenty-webhook-hypothesis-status.json', { id: linkedId, status: 'VALIDATED', need: '[TEST] 300 lanyards impresos' });
    expect(first.json()).toMatchObject({ status: 'recorded', feedback: 'EDITED', agentExecutionId: originExecutionId });
    const again = await delivery('twenty-webhook-hypothesis-status.json', { id: linkedId, status: 'VALIDATED', need: '[TEST] 300 lanyards impresos' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'deduplicated', evaluationId: first.json().evaluationId });
  });

  it('PROPOSED -> VALIDATED on an unlinked hypothesis is ACCEPTED and stored without link', async () => {
    const res = await delivery('twenty-webhook-hypothesis-status.json', { id: unlinkedId, status: 'VALIDATED', name: 'Sin traza — nada' });
    expect(res.json()).toMatchObject({ status: 'recorded', feedback: 'ACCEPTED', score: 1, agentExecutionId: null, linkResolved: false });
    const list = await app.inject({ method: 'GET', url: `/evaluations?subject_id=${unlinkedId}`, headers: { 'x-tenant-id': tenant } });
    expect(list.json().items[0].details).toMatchObject({ from_status: 'PROPOSED', from_status_source: 'assumed', link: { resolved: false } });
  });

  it('VALIDATED -> REJECTED is DISCARDED, using the last known status', async () => {
    const res = await delivery('twenty-webhook-hypothesis-status.json', { id: unlinkedId, status: 'REJECTED' });
    expect(res.json()).toMatchObject({ status: 'recorded', feedback: 'DISCARDED', score: 0 });
    const list = await app.inject({ method: 'GET', url: `/evaluations?subject_id=${unlinkedId}&feedback=DISCARDED`, headers: { 'x-tenant-id': tenant } });
    expect(list.json().items[0].details).toMatchObject({ from_status: 'VALIDATED', from_status_source: 'last_evaluation', to_status: 'REJECTED' });
  });

  it('ignores non-verdict changes with 200', async () => {
    const res = await delivery('twenty-webhook-hypothesis-status.json', { id: unlinkedId, status: 'REJECTED' }, ['confidence']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored' });
  });

  it('POST /evaluations/human (LLD shape) resolves the link, is idempotent and dedupes with the webhook', async () => {
    const manualId = randomUUID();
    const execId = await seedRun(true, manualId, new Date());
    const body = { hypothesisId: manualId, feedback: 'ACCEPTED', reviewerId: 'twenty-user-1', note: 'ok' };
    const res = await app.inject({ method: 'POST', url: '/evaluations/human', payload: body, headers: { 'x-tenant-id': tenant, 'idempotency-key': `k-${manualId}` } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ evaluatorId: 'human-v1', executionId: execId, scores: { TASK_SUCCESS: 1 }, passed: true, deduplicated: false });
    expect(res.json().evaluation).toMatchObject({ evaluated_by: 'twenty-user-1', details: { note: 'ok', to_status: 'VALIDATED', link: { resolved: true } } });

    const replay = await app.inject({ method: 'POST', url: '/evaluations/human', payload: body, headers: { 'x-tenant-id': tenant, 'idempotency-key': `k-${manualId}` } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ deduplicated: true });

    // The logic function and the webhook reporting the same verdict count once.
    const hook = await delivery('twenty-webhook-hypothesis-status.json', {
      id: manualId,
      status: 'VALIDATED',
      need: '[TEST] 200 lanyards',
      quantityMax: 200,
      budgetMin: { amountMicros: 500_000_000, currencyCode: 'EUR' },
      budgetMax: { amountMicros: null, currencyCode: 'EUR' },
    });
    expect(hook.json()).toMatchObject({ status: 'deduplicated', feedback: 'ACCEPTED' });
  });

  it('POST /evaluations/human (runtime shape) validates the execution and GET filters by since', async () => {
    const subject = randomUUID();
    const missing = await app.inject({
      method: 'POST',
      url: '/evaluations/human',
      payload: { subject_type: 'hypothesis', subject_id: subject, feedback: 'DISCARDED', agent_execution_id: randomUUID() },
      headers: { 'x-tenant-id': tenant },
    });
    expect(missing.statusCode).toBe(404);
    const ok = await app.inject({
      method: 'POST',
      url: '/evaluations/human',
      payload: { subject_type: 'hypothesis', subject_id: subject, feedback: 'DISCARDED', agent_execution_id: originExecutionId, details: { reason: 'no encaja' } },
      headers: { 'x-tenant-id': tenant },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ scores: { TASK_SUCCESS: 0 }, passed: false, executionId: originExecutionId });

    const future = new Date(Date.now() + 60_000).toISOString();
    const none = await app.inject({ method: 'GET', url: `/evaluations?since=${encodeURIComponent(future)}`, headers: { 'x-tenant-id': tenant } });
    expect(none.json().items).toHaveLength(0);
    const byExec = await app.inject({ method: 'GET', url: `/evaluations?agent_execution_id=${originExecutionId}`, headers: { 'x-tenant-id': tenant } });
    expect(byExec.json().items.length).toBeGreaterThanOrEqual(3);
    const otherTenant = await app.inject({ method: 'GET', url: `/evaluations?subject_id=${subject}`, headers: { 'x-tenant-id': 'someone-else' } });
    expect(otherTenant.json().items).toHaveLength(0);
  });
});
