/**
 * LIVE email-ops check against the REAL local Twenty and PostgreSQL. Opt-in: runs only with
 * EMAIL_OPS_LIVE=1 (and TWENTY_API_KEY / a reachable Twenty). It NEVER sends an email and
 * never touches the Twenty workflow:
 *
 * - Appends ONE documented test line to the real note "Lista de supresión — NO contactar":
 *   `suprimido-test@ejemplo-supresion.example` (reserved `.example` TLD, cannot receive
 *   mail). Append-only and idempotent; the line is never removed (lines are never deleted).
 * - Uses two clearly labelled hypotheses ("[TEST] pxos-emailops ..."), status PROPOSED (the
 *   send workflow only sends VALIDATED ones) and tenant `it-emailops`, created once and reused.
 * - Simulates the Twenty webhook (real fixture payload, re-signed) against an in-process
 *   runtime: real DB, own tenant, in-memory queues (no Redis, no BullMQ jobs).
 *
 * READY -> suppressed: the hypothesis goes back to DRAFT and gets its ⛔ note.
 * SENT (transition simulated in the payload only): one email_sends row and email.sent.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { emailSends, events } from '../../src/db/schema.js';
import { BLOCK_NOTE_TITLES } from '../../src/email-ops/service.js';
import { titleMatches } from '../../src/email-ops/twenty-io.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { TWENTY_OBJECTS, filterValue, twentyClientFromEnv, type TwentyCommercialHypothesis, type TwentyNote, type TwentyNoteTarget } from '../../src/integrations/twenty/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';
const SECRET = 'live-secret-0123456789abcdef';
const TENANT = 'it-emailops';
const LIVE_SUPPRESSED_EMAIL = 'suprimido-test@ejemplo-supresion.example';
const LIVE_SUPPRESSION_LINE = `${LIVE_SUPPRESSED_EMAIL} — 2026-10-07 — PRUEBA de email-ops: dirección ficticia (.example), no es una baja real. No borrar.`;
const READY_NAME = '[TEST] pxos-emailops READY a dirección suprimida';
const SENT_NAME = '[TEST] pxos-emailops SENT simulado';

const twenty = twentyClientFromEnv();
const live = process.env.EMAIL_OPS_LIVE === '1' && twenty.isConfigured() && (await twenty.ping());
if (process.env.EMAIL_OPS_LIVE === '1' && !live) console.warn('[live] Twenty not configured or not reachable; skipping');

const fixture = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/twenty-webhook-hypothesis-status.json'), 'utf8'),
) as { headers: Record<string, string>; body: Record<string, unknown> };

async function testHypothesis(name: string, fields: Record<string, unknown>): Promise<TwentyCommercialHypothesis> {
  const { records } = await twenty.list<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, { filter: `name[eq]:${filterValue(name)}`, limit: 5 });
  const existing = records[0];
  if (existing) return twenty.update<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, existing.id, fields);
  return twenty.create<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, { name, status: 'PROPOSED', tenantId: TENANT, ...fields });
}

describe.skipIf(!live)('email-ops LIVE (real Twenty, simulated webhook, nothing sent)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  function deliver(record: Record<string, unknown>) {
    const raw = JSON.stringify({ ...fixture.body, eventDate: new Date().toISOString(), record, updatedFields: ['emailStatus'] });
    const ts = String(Date.now());
    return app.inject({
      method: 'POST',
      url: '/webhooks/twenty',
      payload: raw,
      headers: { ...fixture.headers, 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) },
    });
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({
      db: handle.db,
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: TENANT, defaultModelProvider: 'stub', twentyWebhookSecret: SECRET, evaluationDedupeWindowMs: 600_000 },
      events: new EventBus(handle.db, new MemoryEventQueue(), { tenantId: TENANT }),
      twenty,
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('READY to the suppressed test address: back to DRAFT with its ⛔ note', { timeout: 60_000 }, async () => {
    // 1. Test line in the REAL suppression list (append-only, idempotent).
    const tools = new ToolExecutor(
      createDefaultToolRegistry({ twenty }),
      parseToolPolicy({ tool_policy: ['update_note'] }),
      { tenantId: TENANT, executionId: `live-${randomUUID()}`, agentId: 'live', stage: null },
      new AbortController().signal,
    );
    // The real note's title is stored with U+FFFD characters, so update_note's exact
    // `expectedTitle` check would refuse it: verify it with the tolerant check instead.
    const real = (await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, SUPPRESSION_NOTE_ID))!;
    expect(titleMatches(real.title ?? '', SUPPRESSION_NOTE_TITLE)).toBe(true);
    const appended = await tools.call('update_note', { noteId: SUPPRESSION_NOTE_ID, appendLines: [LIVE_SUPPRESSION_LINE] });
    expect(appended.result.status).toBe('ok');
    console.log(`[live] suppression note: ${JSON.stringify((appended.result as { output: unknown }).output)}`);

    // 2. Test hypothesis marked READY (PROPOSED: the workflow would refuse it anyway).
    const h = await testHypothesis(READY_NAME, {
      emailTo: `Prueba <${LIVE_SUPPRESSED_EMAIL}>`,
      emailSubject: '[TEST] no enviar',
      emailBody: '[TEST] Prueba del chequeo de supresión de email-ops. No enviar.',
      emailStatus: 'READY',
    });
    const record = (await twenty.get<Record<string, unknown>>(TWENTY_OBJECTS.commercialHypothesis, h.id, { depth: 0 }))!;
    expect(record.emailStatus).toBe('READY');

    // 3. Simulated webhook with the real record.
    const res = await deliver(record);
    console.log(`[live] READY webhook -> ${res.statusCode} ${res.body}`);
    expect(res.json().email).toMatchObject({ check: 'ready', status: 'blocked', reason: 'suppressed', reverted: true });

    // 4. Twenty: DRAFT, text untouched, ⛔ note linked to the hypothesis.
    const after = (await twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, h.id, { depth: 0 }))!;
    expect(after).toMatchObject({ emailStatus: 'DRAFT', emailTo: `Prueba <${LIVE_SUPPRESSED_EMAIL}>`, emailSubject: '[TEST] no enviar', status: 'PROPOSED' });
    const noteId = res.json().email.noteId as string;
    const note = (await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, noteId))!;
    expect(note.title).toBe(BLOCK_NOTE_TITLES.suppressed);
    const { records: targets } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `noteId[eq]:${filterValue(noteId)}`, limit: 10 });
    expect(targets.some((t) => t.targetCommercialHypothesisId === h.id)).toBe(true);
    console.log(`[live] hypothesis ${h.id} emailStatus=${String(after.emailStatus)} note=${noteId} markdown=${JSON.stringify(note.bodyV2?.markdown)}`);

    const [ev] = await handle.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, TENANT), eq(events.type, 'email.blocked_suppressed'), eq(events.correlationId, h.id)));
    expect(ev?.payload).toMatchObject({ reason: 'suppressed', matchedBy: ['email'], toDomains: ['ejemplo-supresion.example'], reverted: true });
  });

  it('SENT (simulated transition): one email_sends row and email.sent with the domain only', { timeout: 60_000 }, async () => {
    const h = await testHypothesis(SENT_NAME, {
      emailTo: 'destinatario-test@ejemplo-envio.example',
      emailSubject: '[TEST] envío simulado',
      emailBody: '[TEST] Transición a SENT simulada en el webhook; no se envía nada.',
      emailStatus: 'DRAFT',
    });
    const record = (await twenty.get<Record<string, unknown>>(TWENTY_OBJECTS.commercialHypothesis, h.id, { depth: 0 }))!;
    const sentAt = new Date().toISOString();
    const res = await deliver({ ...record, emailStatus: 'SENT', updatedAt: sentAt });
    console.log(`[live] SENT webhook -> ${res.statusCode} ${res.body}`);
    expect(res.json().email).toMatchObject({ check: 'sent', status: 'recorded', toDomain: 'ejemplo-envio.example', suppressedRecipients: 0 });
    const rows = await handle.db.select().from(emailSends).where(and(eq(emailSends.tenantId, TENANT), eq(emailSends.hypothesisId, h.id), eq(emailSends.sentAt, new Date(sentAt))));
    expect(rows).toHaveLength(1);
    const again = await deliver({ ...record, emailStatus: 'SENT', updatedAt: sentAt });
    expect(again.json().email).toMatchObject({ status: 'deduplicated' });
    // Twenty itself was not moved to SENT: the transition only exists in the payload.
    expect((await twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, h.id))!.emailStatus).toBe('DRAFT');
    const summary = await app.inject({ method: 'GET', url: '/metrics/summary', headers: { 'x-tenant-id': TENANT } });
    console.log(`[live] email block: ${JSON.stringify(summary.json().email)}`);
  });
});
