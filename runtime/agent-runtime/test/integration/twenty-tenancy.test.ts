/**
 * Tenancy end to end (tanda 16) against a real PostgreSQL and a FakeTwenty holding records of
 * TWO tenants, as the one Twenty workspace does when test tenants write into it:
 * - the signals-mode daily run (list_event_signals + expire_signal + round-robin) only sees and
 *   only expires its own tenant's fairs;
 * - the inbound triage crosses `email_sends` of its own tenant only;
 * - expire_signal through the ToolExecutor never touches another tenant's signal;
 * - the signed webhook ignores (200) a hypothesis or a signal of another tenant.
 * Fresh tenants per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { emailSends, evaluations, events, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { DrizzleSendLookup } from '../../src/inbound/reply-links.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { PROSPECTOR_TASK_NAME, seedProspector } from '../../src/seed/prospector-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const SECRET = 'it-tenancy-secret-0123456789';

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

const NO_LIST = JSON.stringify({ page_kind: 'event_home', event: null, exhibitors: [], exhibitors_page_url: null, notes: 'sin lista publicada' });
const OWN_URL = 'https://www.feria-propia.com/expositores';
const FOREIGN_URL = 'https://www.feria-ajena.com/expositores';

function fairSignal(fake: FakeTwenty, tenantId: string | null, name: string, status: string, eventDate: string, url: string) {
  return fake.seed('commercialSignals', {
    name,
    signalType: 'FAIR',
    status,
    eventDate,
    sourceUrl: { primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] },
    sourceDomain: new URL(url).hostname.replace(/^www\./, ''),
    companyId: null,
    tenantId,
  });
}

type DailyOutput = {
  outcome: string;
  signal_id?: string;
  reason?: string;
  signals: { open_listed: number; expired: Array<{ id: string }>; selection?: { candidates: Array<{ id: string }> } };
};

describe.skipIf(!dbAvailable)('Twenty tenancy (PostgreSQL + FakeTwenty with two tenants)', () => {
  const run = randomUUID().slice(0, 8);
  const tenant = `it-ten-${run}`;
  const other = `it-oth-${run}`;
  let handle: DbHandle;
  let provider: StubProvider;
  let seq = 0;

  async function dailyRun(tenantId: string, fake: FakeTwenty, web: FakeWeb, responses: string[], ownerTenantId?: string) {
    const processor = new RunProcessor(
      handle.db,
      () => provider,
      { info() {}, warn() {}, error() {} },
      createDefaultToolRegistry({ twenty: fake.client(ownerTenantId ? { ownerTenantId } : {}), web: web.deps(), render: { endpoint: null } }),
      null,
    );
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-tenancy:${tenantId}:${++seq}`, trigger: 'MANUAL' });
    provider = new StubProvider({ responses });
    for (const { job } of queue.drain()) await processor.process(job);
    const row = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    return { run: row!, output: row!.output as unknown as DailyOutput };
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('signals mode: lists, expires and round-robins only the fairs of its tenant', async () => {
    await seedProspector(handle.db, { tenantId: tenant });
    const fake = new FakeTwenty();
    const own = fairSignal(fake, tenant, 'Feria Propia 2027 (feria)', 'QUALIFIED', '2027-03-01', OWN_URL);
    const ownPast = fairSignal(fake, tenant, 'Feria Propia Pasada 2026 (feria)', 'QUALIFIED', '2026-09-01', 'https://www.propia-pasada.com/');
    // Another tenant's garbage: an earlier QUALIFIED fair (would win the round-robin) and a past one (would be expired).
    const foreign = fairSignal(fake, other, 'Feria Ajena 2027 (feria)', 'QUALIFIED', '2027-01-10', FOREIGN_URL);
    const foreignPast = fairSignal(fake, other, 'Feria Ajena Pasada 2026 (feria)', 'QUALIFIED', '2026-08-01', 'https://www.ajena-pasada.com/');
    const web = new FakeWeb().page(OWN_URL, '<title>Feria Propia 2027</title><p>Expositores próximamente.</p>');

    const r = await dailyRun(tenant, fake, web, [NO_LIST]);
    expect(r.run.status).toBe('COMPLETED');
    expect(r.output.signal_id).toBe(own.id);
    expect(r.output.signals.open_listed).toBe(2);
    expect(r.output.signals.expired.map((e) => e.id)).toEqual([ownPast.id]);
    expect(r.output.signals.selection?.candidates.map((c) => c.id)).toEqual([own.id]);
    const status = (id: unknown) => fake.tables.commercialSignals.find((s) => s.id === id)!.status;
    expect([status(foreign.id), status(foreignPast.id)]).toEqual(['QUALIFIED', 'QUALIFIED']);
    // Every signal read carried the tenant filter; no PATCH reached a foreign signal.
    const patched = fake.requests.filter((q) => q.method === 'PATCH').map((q) => q.path.split('/')[3]);
    expect(patched).toEqual([ownPast.id]);
  });

  it('signals mode for the owner tenant: hand-made fairs (empty tenantId) count, other tenants do not', async () => {
    const owner = `it-own-${run}`;
    await seedProspector(handle.db, { tenantId: owner });
    const fake = new FakeTwenty();
    const handmade = fairSignal(fake, '', 'Feria A Mano 2027 (feria)', 'QUALIFIED', '2027-04-01', OWN_URL);
    fairSignal(fake, other, 'Feria Ajena 2027 (feria)', 'QUALIFIED', '2027-01-10', FOREIGN_URL);
    const web = new FakeWeb().page(OWN_URL, '<title>Feria A Mano 2027</title><p>Expositores próximamente.</p>');
    const r = await dailyRun(owner, fake, web, [NO_LIST], owner);
    expect(r.output.signal_id).toBe(handmade.id);
    expect(r.output.signals.open_listed).toBe(1);
  });

  it('only another tenant has QUALIFIED fairs -> SKIPPED, nothing written', async () => {
    const t = `it-skp-${run}`;
    await seedProspector(handle.db, { tenantId: t });
    const fake = new FakeTwenty();
    fairSignal(fake, other, 'Feria Ajena 2027 (feria)', 'QUALIFIED', '2027-01-10', FOREIGN_URL);
    fairSignal(fake, other, 'Feria Ajena Pasada 2026 (feria)', 'NEW', '2026-08-01', 'https://www.ajena-pasada.com/');
    const r = await dailyRun(t, fake, new FakeWeb(), []);
    expect(r.output).toMatchObject({ outcome: 'SKIPPED', reason: '0 señales calificadas', signals: { open_listed: 0, expired: [] } });
    expect(fake.requests.filter((q) => q.method !== 'GET')).toEqual([]);
  });

  it('expire_signal through the ToolExecutor never touches a signal of another tenant', async () => {
    const fake = new FakeTwenty();
    const foreignPast = fairSignal(fake, other, 'Feria Ajena Pasada 2026 (feria)', 'QUALIFIED', '2026-08-01', 'https://www.ajena-pasada.com/');
    const executor = new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } }),
      parseToolPolicy({ tool_policy: ['expire_signal'] }),
      { tenantId: tenant, executionId: `exec-${run}`, agentId: 'agent-1', stage: 'PROSPECTOR' },
      new AbortController().signal,
    );
    const out = await executor.call('expire_signal', { signalId: foreignPast.id, today: '2026-10-12' });
    expect(out.result).toMatchObject({ status: 'error', code: 'TWENTY_TENANT_MISMATCH' });
    expect(fake.count('PATCH', 'commercialSignals')).toBe(0);
    expect(fake.tables.commercialSignals[0]!.status).toBe('QUALIFIED');
  });

  it('inbound triage crosses only the email_sends of its tenant', async () => {
    const sentAt = new Date(Date.now() - 3600_000);
    await handle.db.insert(emailSends).values([
      { tenantId: tenant, hypothesisId: `hyp-own-${run}`, companyId: `co-own-${run}`, toEmail: `ana@propia-${run}.example`, toDomain: `propia-${run}.example`, subject: 'Propio', sentAt },
      { tenantId: other, hypothesisId: `hyp-oth-${run}`, companyId: `co-oth-${run}`, toEmail: `luis@ajena-${run}.example`, toDomain: `ajena-${run}.example`, subject: 'Ajeno', sentAt },
    ]);
    const lookup = new DrizzleSendLookup(handle.db);
    expect(await lookup.find(tenant, `ana@propia-${run}.example`, new Date())).toMatchObject({ hypothesisId: `hyp-own-${run}`, by: 'email' });
    // The other tenant's send (exact address and domain) is invisible to this tenant.
    expect(await lookup.find(tenant, `luis@ajena-${run}.example`, new Date())).toBeNull();
    expect(await lookup.find(tenant, `otra@ajena-${run}.example`, new Date())).toBeNull();
    expect(await lookup.find(other, `luis@ajena-${run}.example`, new Date())).toMatchObject({ hypothesisId: `hyp-oth-${run}` });
  });

  describe('signed webhook', () => {
    let app: FastifyInstance;
    const queue = new MemoryEventQueue();

    beforeAll(async () => {
      app = await buildServer({
        db: handle.db,
        queue: new MemoryRunQueue(),
        config: { defaultTenantId: tenant, defaultModelProvider: 'stub', twentyWebhookSecret: SECRET },
        events: new EventBus(handle.db, queue, { tenantId: tenant }),
      });
    });

    afterAll(async () => {
      await app?.close();
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

    it('a hypothesis of another tenant -> 200 ignored, no evaluation under any tenant', async () => {
      const id = randomUUID();
      const res = await post({
        eventName: 'commercialHypothesis.updated',
        objectMetadata: { id: 'meta-hyp', nameSingular: 'commercialHypothesis' },
        webhookId: 'wh-it',
        eventDate: new Date().toISOString(),
        updatedFields: ['status'],
        record: { id, name: 'Ajena', status: 'VALIDATED', tenantId: other, companyId: null, updatedAt: new Date().toISOString() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ignored', foreign_tenant: other });
      expect(await handle.db.select().from(evaluations).where(eq(evaluations.subjectId, id))).toEqual([]);
    });

    it('a QUALIFIED fair of another tenant -> 200 ignored, no signal.qualified', async () => {
      const id = randomUUID();
      const res = await post({
        eventName: 'commercialSignal.updated',
        objectMetadata: { id: 'meta-signal', nameSingular: 'commercialSignal' },
        webhookId: 'wh-it',
        eventDate: new Date().toISOString(),
        updatedFields: ['status'],
        record: {
          id,
          name: 'Feria Ajena 2027 (feria)',
          signalType: 'FAIR',
          status: 'QUALIFIED',
          sourceUrl: { primaryLinkUrl: FOREIGN_URL, primaryLinkLabel: '', secondaryLinks: [] },
          eventDate: '2027-01-10',
          tenantId: other,
          companyId: null,
          deletedAt: null,
          updatedAt: new Date().toISOString(),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ signal: { status: 'ignored', foreign_tenant: other, signal_id: id } });
      expect(queue.drain()).toEqual([]);
      const rows = await handle.db.select().from(events).where(eq(events.type, 'signal.qualified'));
      expect(rows.filter((e) => (e.payload as { signal_id?: string }).signal_id === id)).toEqual([]);
    });
  });
});
