/**
 * Manual promotion to a native Opportunity (tanda 19) against a real PostgreSQL and the
 * FakeTwenty: `POST /opportunities/promote` -> Opportunity at the first stage of the workspace
 * pipeline (with company, fair and the Person of the hypothesis' emailTo), idempotent per company,
 * `opportunity.created` (origin manual) in `events`, `opportunity.promote` in `audit_log` (also
 * for the refused ones). Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, events } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
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

describe.skipIf(!dbAvailable)('POST /opportunities/promote (PostgreSQL + FakeTwenty)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  fake.opportunityStages = ['PROSPECTO', 'REUNION', 'PROPUESTA', 'GANADA', 'PERDIDA'];
  const links = (d: string) => ({ primaryLinkUrl: d, primaryLinkLabel: '', secondaryLinks: [] });
  const acme = fake.seed('companies', { name: 'Acme Conservas', domainName: links('acme-conservas.es') });
  const fair = fake.seed('commercialSignals', { name: 'Alimentaria 2026 — Acme Conservas', signalType: 'FAIR', status: 'QUALIFIED', tenantId: tenant, companyId: acme.id });
  const hyp = fake.seed('commercialHypotheses', { name: 'Acme Conservas — Alimentaria 2026', status: 'VALIDATED', tenantId: tenant, companyId: acme.id, commercialSignalId: fair.id, decisionMakerId: null, emailTo: 'lucia.vera@acme-conservas.es' });
  const proposedNoTraction = fake.seed('commercialHypotheses', { name: 'Otra — Feria', status: 'PROPOSED', tenantId: tenant, companyId: acme.id, decisionMakerId: null });
  const rejected = fake.seed('commercialHypotheses', { name: 'Rechazada', status: 'REJECTED', tenantId: tenant, companyId: acme.id, decisionMakerId: null });
  const foreign = fake.seed('commercialHypotheses', { name: 'Otro tenant', status: 'VALIDATED', tenantId: 'otro-tenant', companyId: acme.id, decisionMakerId: null });
  // A person the ContactFinder already created for that address (dedupe by email).
  const lucia = fake.seed('people', { name: { firstName: 'Lucía', lastName: 'Vera' }, emails: { primaryEmail: 'lucia.vera@acme-conservas.es', additionalEmails: [] }, jobTitle: 'Directora de Marketing', companyId: acme.id });

  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({
      db: handle.db,
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: tenant, defaultModelProvider: 'stub' },
      events: new EventBus(handle.db, new MemoryEventQueue(), { tenantId: tenant }),
      twenty: fake.client(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const promote = (payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/opportunities/promote', headers: { 'x-tenant-id': tenant, 'x-actor': 'comercial-it', ...headers }, payload: payload as object });
  const oppEvents = () => handle.db.query.events.findMany({ where: and(eq(events.tenantId, tenant), eq(events.type, 'opportunity.created')) });

  it('promotes by hand: company, fair, the Person of emailTo, FIRST real stage, no amount; event + audit', async () => {
    // Nothing exists before a person decides: hypotheses are never bulk-copied.
    expect(fake.tables.opportunities).toHaveLength(0);
    const res = await promote({ hypothesis_id: hyp.id });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { opportunity: Record<string, unknown>; contact_from: string; event_id: string };
    expect(body).toMatchObject({
      hypothesis_id: hyp.id,
      contact_from: 'email_to',
      opportunity: { name: 'Acme Conservas — Alimentaria 2026', stage: 'PROSPECTO', created: true, stage_source: 'twenty', fair: 'Alimentaria 2026', company_id: acme.id, point_of_contact_id: lucia.id },
      person: { outcome: 'unchanged', id: lucia.id },
    });
    expect(fake.tables.opportunities).toEqual([expect.objectContaining({ amount: { amountMicros: null, currencyCode: null }, pointOfContactId: lucia.id })]);
    expect(fake.tables.people).toHaveLength(1);
    const evs = await oppEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0]!.id).toBe(body.event_id);
    expect(evs[0]!.payload).toMatchObject({ opportunityId: body.opportunity.id, origin: 'manual', hypothesisId: hyp.id, companyId: acme.id, pointOfContactId: lucia.id, stage: 'PROSPECTO' });
    const audit = await handle.db.query.auditLog.findMany({ where: and(eq(auditLog.tenantId, tenant), eq(auditLog.action, 'opportunity.promote')) });
    expect(audit).toEqual([expect.objectContaining({ subjectType: 'hypothesis', subjectId: hyp.id, result: 'ok', statusCode: 201, actorLabel: 'comercial-it' })]);
  });

  it('is idempotent per company: the open opportunity is reused (200), no second event', async () => {
    const again = await promote({ hypothesis_id: proposedNoTraction.id });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ opportunity: { created: false, stage_source: 'existing' }, event_id: null });
    expect(fake.tables.opportunities).toHaveLength(1);
    expect(await oppEvents()).toHaveLength(1);
  });

  it('refuses REJECTED (409), unknown or another tenant (404), bad body (400); all audited', async () => {
    expect((await promote({ hypothesis_id: rejected.id })).statusCode).toBe(409);
    expect((await promote({ hypothesis_id: foreign.id })).statusCode).toBe(404);
    expect((await promote({ hypothesis_id: randomUUID() })).statusCode).toBe(404);
    expect((await promote({ hypothesis_id: 'nope' })).statusCode).toBe(400);
    expect((await promote({ hypothesis_id: hyp.id, extra: true })).statusCode).toBe(400);
    expect(fake.tables.opportunities).toHaveLength(1);
    const audit = await handle.db.query.auditLog.findMany({ where: and(eq(auditLog.tenantId, tenant), eq(auditLog.action, 'opportunity.promote')) });
    expect(audit.map((a) => a.statusCode).sort()).toEqual([200, 201, 400, 400, 404, 404, 409]);
  });

  it('503 without Twenty', async () => {
    const bare = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    const res = await bare.inject({ method: 'POST', url: '/opportunities/promote', headers: { 'x-tenant-id': tenant }, payload: { hypothesis_id: hyp.id } });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});
