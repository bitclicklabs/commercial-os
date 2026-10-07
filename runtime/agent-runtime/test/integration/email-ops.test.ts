/**
 * Email-ops end to end over POST /webhooks/twenty: real PostgreSQL (email_sends, events),
 * FakeTwenty (hypotheses, suppression note) and the REAL Twenty 2.45 webhook payload of
 * test/fixtures (re-signed with a test secret; record, tenant and updatedFields replaced).
 * Skipped when the database is not reachable. Fresh tenant per run. Nothing is sent and
 * nothing is deleted (the only DELETE is the one the anti-DELETE trigger must reject).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { emailSends, events } from '../../src/db/schema.js';
import { BLOCK_NOTE_TITLES, SENT_SUPPRESSED_NOTE_TITLE } from '../../src/email-ops/service.js';
import { emailMetrics } from '../../src/metrics/queries.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

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

const fixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/twenty-webhook-hypothesis-status.json'), 'utf8'),
) as { headers: Record<string, string>; body: Record<string, unknown> };

describe.skipIf(!dbAvailable)('email-ops over the Twenty webhook (PostgreSQL + FakeTwenty + real payload)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  let handle: DbHandle;
  let app: FastifyInstance;
  let company: Record<string, unknown>;

  function hypothesis(emailTo: string, emailStatus: string) {
    return fake.seed('commercialHypotheses', {
      name: `[TEST] email-ops ${randomUUID().slice(0, 6)}`,
      status: 'VALIDATED',
      tenantId: tenant,
      companyId: company.id,
      emailTo,
      emailSubject: '[TEST] Material para vuestro stand',
      emailBody: '[TEST] Hola',
      emailStatus,
    });
  }

  /** A delivery built from the captured fixture, signed like Twenty does. */
  function deliver(record: Record<string, unknown>, updatedAt: string, updatedFields = ['emailStatus']) {
    const body = {
      ...fixture.body,
      record: { ...(fixture.body.record as Record<string, unknown>), ...record, tenantId: tenant, updatedAt },
      updatedFields,
    };
    const raw = JSON.stringify(body);
    const ts = String(Date.now());
    return app.inject({
      method: 'POST',
      url: '/webhooks/twenty',
      payload: raw,
      headers: { ...fixture.headers, 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) },
    });
  }

  const eventsOf = (type: string) =>
    handle.db.select().from(events).where(and(eq(events.tenantId, tenant), eq(events.type, type)));

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    fake.seed('notes', {
      id: SUPPRESSION_NOTE_ID,
      title: SUPPRESSION_NOTE_TITLE,
      bodyV2: { markdown: 'baja@persona.example — 2026-10-14 — x\n\n@empresa-dos.example — 2026-10-15 — toda la empresa\n', blocknote: '[blocknote]' },
    });
    company = fake.seed('companies', { name: '[TEST] Empresa Dos', domainName: { primaryLinkUrl: 'empresa-dos.example', primaryLinkLabel: '', secondaryLinks: [] } });
    app = await buildServer({
      db: handle.db,
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub', twentyWebhookSecret: SECRET, evaluationDedupeWindowMs: 600_000 },
      events: new EventBus(handle.db, new MemoryEventQueue(), { tenantId: tenant }),
      twenty: fake.client(),
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('READY to a suppressed subdomain: back to DRAFT, ⛔ note, email.blocked_suppressed persisted (no address)', async () => {
    const h = hypothesis('compras@madrid.empresa-dos.example', 'READY');
    const res = await deliver({ id: h.id, companyId: company.id, status: 'VALIDATED', emailStatus: 'READY', emailTo: h.emailTo }, new Date().toISOString());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored', email: { check: 'ready', status: 'blocked', reason: 'suppressed', reverted: true } });
    expect(h.emailStatus).toBe('DRAFT');
    const patches = fake.requests.filter((r) => r.method === 'PATCH' && r.path === `/rest/commercialHypotheses/${String(h.id)}`);
    expect(patches.map((p) => p.body)).toEqual([{ emailStatus: 'DRAFT' }]);
    const note = fake.tables.notes.find((n) => n.title === BLOCK_NOTE_TITLES.suppressed)!;
    expect(fake.tables.noteTargets.some((t) => t.noteId === note.id && t.targetCommercialHypothesisId === h.id)).toBe(true);
    const [ev] = await eventsOf('email.blocked_suppressed');
    expect(ev).toMatchObject({ correlationId: h.id, payload: { reason: 'suppressed', matchedDomains: ['@empresa-dos.example'], toDomains: ['madrid.empresa-dos.example'] } });
    expect(JSON.stringify(ev!.payload)).not.toContain('compras@');
  });

  it('READY with empty Email to: blocked with reason missing_recipient', async () => {
    const h = hypothesis('', 'READY');
    const res = await deliver({ id: h.id, emailStatus: 'READY', emailTo: '' }, new Date().toISOString());
    expect(res.json().email).toMatchObject({ status: 'blocked', reason: 'missing_recipient', reverted: true });
    expect(h.emailStatus).toBe('DRAFT');
  });

  it('READY to a free address: passes untouched', async () => {
    const h = hypothesis('ana@libre.example', 'READY');
    const before = fake.count('PATCH', 'commercialHypotheses');
    const res = await deliver({ id: h.id, emailStatus: 'READY' }, new Date().toISOString());
    expect(res.json().email).toMatchObject({ status: 'passed', recipients: 1, toDomains: ['libre.example'] });
    expect(h.emailStatus).toBe('READY');
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(before);
  });

  it('SENT: one email_sends row and one email.sent (domain only); the redelivery is deduplicated', async () => {
    const h = hypothesis('Ana <Ana@Libre.example>', 'SENT');
    const sentAt = '2026-10-07T09:15:00.000Z';
    const record = { id: h.id, companyId: company.id, emailStatus: 'SENT', emailTo: h.emailTo, emailSubject: h.emailSubject, updatedBy: { source: 'WORKFLOW', workspaceMemberId: 'wm-1', name: 'Workflow' } };
    const first = await deliver(record, sentAt);
    expect(first.statusCode).toBe(200);
    expect(first.json().email).toMatchObject({ check: 'sent', status: 'recorded', toDomain: 'libre.example', suppressedRecipients: 0 });
    const again = await deliver(record, sentAt, ['emailStatus', 'updatedAt']);
    expect(again.json().email).toMatchObject({ status: 'deduplicated', sendId: first.json().email.sendId });
    const rows = await handle.db.select().from(emailSends).where(and(eq(emailSends.tenantId, tenant), eq(emailSends.hypothesisId, String(h.id))));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: company.id, toEmail: 'ana@libre.example', toDomain: 'libre.example', subject: '[TEST] Material para vuestro stand', workspaceMemberId: 'wm-1' });
    expect(rows[0]!.sentAt.toISOString()).toBe(sentAt);
    const sent = (await eventsOf('email.sent')).filter((e) => e.correlationId === h.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ hypothesisId: h.id, companyId: company.id, toDomain: 'libre.example', recipients: 1 });
    expect(JSON.stringify(sent[0]!.payload)).not.toContain('ana@');
    // No physical DELETE.
    await expect(handle.db.execute(sql`delete from email_sends where id = ${rows[0]!.id}`)).rejects.toThrow();
  });

  it('warm-up: sends over the day target emit email.warmup_target_exceeded ONCE that day', async () => {
    // Saturday 2026-10-10: rest day, target 0 -> the first send already exceeds it.
    for (const minute of ['10', '20', '30']) {
      const h = hypothesis(`x${minute}@libre.example`, 'SENT');
      const res = await deliver({ id: h.id, emailStatus: 'SENT', emailTo: h.emailTo }, `2026-10-10T09:${minute}:00.000Z`);
      expect(res.json().email).toMatchObject({ status: 'recorded', target: 0, targetExceeded: true });
    }
    const exceeded = (await eventsOf('email.warmup_target_exceeded')).filter((e) => e.payload.date === '2026-10-10');
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.payload).toMatchObject({ date: '2026-10-10', phase: 'week1', restDay: true, target: 0, sendsToday: 1 });

    const m = await emailMetrics(handle.db, { tenantId: tenant, now: new Date('2026-10-10T09:45:00Z'), timezone: 'Europe/Madrid' });
    expect(m.sends).toMatchObject({ today: 3, total: 4, last_hour: 3 });
    // Week Mon 2026-10-05 .. Sun 2026-10-11 includes the send of the 7th.
    expect(m.sends.week).toBe(4);
    expect(m.warmup).toMatchObject({ date: '2026-10-10', stage: 'warmup', phase: { id: 'week1' }, rest_day: true, target_today: 0, status: 'exceeded', exceeded: true, exceeded_event_emitted: true });
    expect(m.ionos_limit).toMatchObject({ per_hour: 50, mailbox_age_days: 5, last_hour: 3, status: 'ok', informative: true });

    const post = await emailMetrics(handle.db, { tenantId: tenant, now: new Date('2026-11-10T09:45:00Z'), timezone: 'Europe/Madrid' });
    expect(post.warmup).toMatchObject({ stage: 'post_warmup', target_today: null, status: 'no_target', exceeded: false });
    expect(post.ionos_limit.per_hour).toBe(500);
  });

  it('SENT to a suppressed address (READY check lost the race): ⛔ alert note and email.sent_suppressed', async () => {
    const h = hypothesis('baja@persona.example', 'SENT');
    const res = await deliver({ id: h.id, companyId: company.id, emailStatus: 'SENT', emailTo: h.emailTo }, '2026-10-07T11:00:00.000Z');
    expect(res.json().email).toMatchObject({ status: 'recorded', suppressedRecipients: 1 });
    expect(fake.tables.notes.some((n) => n.title === SENT_SUPPRESSED_NOTE_TITLE)).toBe(true);
    const [ev] = (await eventsOf('email.sent_suppressed')).filter((e) => e.correlationId === h.id);
    expect(ev!.payload).toMatchObject({ matchedBy: ['email'], toDomains: ['persona.example'] });
  });

  it('/metrics/summary carries the email block and the dashboard renders it', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics/summary', headers: { 'x-tenant-id': tenant } });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toMatchObject({ source: 'twenty_workflow', sends: { total: 5 }, warmup: { start: '2026-10-06', end: '2026-11-02' }, ionos_limit: { informative: true } });
    const page = await app.inject({ method: 'GET', url: '/dashboard', headers: { host: '127.0.0.1:4020' } });
    expect(page.body).toContain('<h2>Email</h2>');
    expect(page.body).toContain('renderEmail(all.email)');
  });

  it('a webhook that is not an emailStatus change keeps the previous response shape', async () => {
    const h = hypothesis('ana@libre.example', 'READY');
    const res = await deliver({ id: h.id, emailStatus: 'READY' }, new Date().toISOString(), ['emailBody']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('email');
  });
});
