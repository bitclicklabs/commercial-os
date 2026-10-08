/**
 * Inbound triage end to end against a real PostgreSQL (no Redis, no real mailbox, no real LLM):
 * migration 0014 -> seed `process-inbox` (and `process-unsubscribes` disabled) -> TaskRun ->
 * RunProcessor -> InboxAgent -> real imapflow against the in-process fake IMAP server ->
 * StubProvider for the LLM level -> suppression note + reply/bounce notes in a fake Twenty ->
 * `inbound_triage` rows, `email.reply_received` events in `events`, cursor in `inbound_state`.
 * Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, events, inboundState, inboundTriage, taskDefinitions, taskRuns, traces, traceSteps } from '../../src/db/schema.js';
import { recordEmailSend } from '../../src/email-ops/sends.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { DrizzleSendLookup } from '../../src/inbound/reply-links.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { DrizzleInboundTriageStore } from '../../src/inbound/triage-store.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { BAJAS_TASK_NAME, seedBajas } from '../../src/seed/bajas-seed.js';
import { INBOX_TASK_NAME, seedInbox } from '../../src/seed/inbox-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeImapServer } from '../helpers/fake-imap.js';
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

const IMAP_KEYS = ['IONOS_IMAP_HOST', 'IONOS_IMAP_PORT', 'IONOS_IMAP_USER', 'IONOS_IMAP_PASSWORD', 'IONOS_IMAP_TLS', 'IONOS_IMAP_MAILBOX'] as const;

/** Runs `fn` with the IMAP env replaced (never touches the real mailbox from .env). */
async function withImapEnv<T>(values: Partial<Record<(typeof IMAP_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(IMAP_KEYS.map((k) => [k, process.env[k]]));
  for (const k of IMAP_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of IMAP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const mail = (h: Record<string, string>, body: string) =>
  `${Object.entries({ To: 'jesus.abril@publiexpe.info', 'Message-ID': `<${randomUUID()}@example.test>`, 'Content-Type': 'text/plain; charset=utf-8', ...h })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`;

const QUOTED = '\r\nEl mié, 7 oct 2026 a las 10:15, Jesús Abril <jesus.abril@publiexpe.info> escribió:\r\n> Hola, os escribo por la feria.';

describe.skipIf(!dbAvailable)('inbound triage: process-inbox -> InboxAgent -> notes, suppression, events (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  const supp = fake.seed('notes', { id: SUPPRESSION_NOTE_ID, title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: 'ya@estaba.example — 2026-10-06 — manual', blocknote: '[bn]' } });
  const company = fake.seed('companies', { name: 'Cliente SA', domainName: { primaryLinkUrl: 'cliente.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const hypothesisId = randomUUID();
  const imap = new FakeImapServer();
  let stub = new StubProvider();
  const queueEvents = new MemoryEventQueue();
  let handle: DbHandle;
  const interestedSource = mail({ From: 'Carmen <carmen@cliente.example>', Subject: 'Re: Material para vuestro stand' }, `Sí, nos interesa. ¿Precios de 500 bolsas?${QUOTED}`);

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    await recordEmailSend(handle.db, {
      tenantId: tenant,
      hypothesisId,
      companyId: company.id as string,
      toEmail: 'carmen@cliente.example',
      toDomain: 'cliente.example',
      subject: 'Material para vuestro stand',
      sentAt: new Date('2026-10-07T08:15:00Z'),
      workspaceMemberId: null,
    });
    await recordEmailSend(handle.db, {
      tenantId: tenant,
      hypothesisId,
      companyId: company.id as string,
      toEmail: 'noexiste@cliente.example',
      toDomain: 'cliente.example',
      subject: 'Material para vuestro stand',
      sentAt: new Date('2026-10-07T08:16:00Z'),
      workspaceMemberId: null,
    });
    const at = (h: number) => new Date(`2026-10-08T${String(h).padStart(2, '0')}:00:00Z`);
    imap.messages = [
      { uid: 31, source: mail({ From: 'Luis <luis@baja.example>', To: 'baja@publiexpe.info', Subject: 'Baja' }, 'Gracias'), internalDate: at(7) },
      { uid: 32, source: interestedSource, internalDate: at(8) },
      { uid: 33, source: mail({ From: 'marta@cliente2.example', Subject: 'Re: Material' }, 'No nos interesa, gracias.'), internalDate: at(9) },
      { uid: 34, source: mail({ From: 'ana@cliente.example', Subject: 'Respuesta automática: Material', 'Auto-Submitted': 'auto-generated' }, 'Estoy fuera de la oficina.'), internalDate: at(9) },
      {
        uid: 35,
        source: mail(
          { From: 'Mail Delivery System <MAILER-DAEMON@mout.kundenserver.de>', Subject: 'Mail delivery failed: returning message to sender', 'Auto-Submitted': 'auto-replied', 'Content-Type': 'multipart/report; report-type=delivery-status; boundary="BX"' },
          '--BX\nContent-Type: text/plain\n\nA message that you sent could not be delivered.\n--BX\nContent-Type: message/delivery-status\n\nReporting-MTA: dns; mout.kundenserver.de\n\nFinal-Recipient: rfc822; noexiste@cliente.example\nAction: failed\nStatus: 5.1.1\n--BX--\n',
        ),
        internalDate: at(10),
      },
      // Second copy of the interested reply (same Message-ID): triaged once.
      { uid: 36, source: interestedSource, internalDate: at(8) },
    ];
    await imap.start();
  });

  afterAll(async () => {
    await imap.stop();
    await handle?.close();
  });

  const env = () => ({
    IONOS_IMAP_HOST: '127.0.0.1',
    IONOS_IMAP_PORT: String(imap.port),
    IONOS_IMAP_TLS: 'false',
    IONOS_IMAP_USER: imap.user,
    IONOS_IMAP_PASSWORD: imap.password,
  });

  async function runOnce() {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, INBOX_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it:${randomUUID()}` });
    // The seeded version uses Gemini: the test answers with the StubProvider instead.
    const processor = new RunProcessor(handle.db, () => stub, undefined, createDefaultToolRegistry({ twenty: fake.client() }), null);
    processor.events = new EventBus(handle.db, queueEvents, { tenantId: tenant });
    await withImapEnv(env(), async () => {
      for (const { job } of queue.drain()) await processor.process(job);
    });
    return (await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) }))!;
  }

  const replyEvents = () => handle.db.query.events.findMany({ where: and(eq(events.tenantId, tenant), eq(events.type, 'email.reply_received')) });
  const rows = () => handle.db.query.inboundTriage.findMany({ where: eq(inboundTriage.tenantId, tenant), orderBy: inboundTriage.uid });

  it('seeds process-inbox on the 2-hour cadence and disables process-unsubscribes (one reader)', async () => {
    await seedBajas(handle.db, { tenantId: tenant });
    expect(await seedInbox(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'created', taskAction: 'created' });
    expect(await seedInbox(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged' });
    const inbox = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, INBOX_TASK_NAME)) });
    const bajas = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, BAJAS_TASK_NAME)) });
    expect(inbox).toMatchObject({ schedule: { type: 'CRON', expression: '0 */2 * * *' }, timezone: 'Europe/Madrid', enabled: true, maxConcurrency: 1 });
    expect(bajas).toMatchObject({ enabled: false });
  });

  it('triages the mailbox read-only: baja and no-interesado suppressed, notes for the commercial, events, rows', async () => {
    stub = new StubProvider({
      responses: [JSON.stringify({ clase: 'INTERESADO', confianza: 0.93, motivo: 'pide precios' }), JSON.stringify({ clase: 'NO_INTERESADO', confianza: 0.96, motivo: 'rechazo explícito' })],
    });
    imap.commands.length = 0;
    const run = await runOnce();
    expect(run.status).toBe('COMPLETED');
    expect(run.output).toMatchObject({
      outcome: 'SUCCESS',
      sends_email: false,
      new_entries: ['luis@baja.example', 'marta@cliente2.example'],
      counters: { messages_reviewed: 6, already_triaged: 1, bajas_detected: 1, interesados: 1, no_interesados: 1, auto_replies: 1, rebotes: 1, rebotes_duros: 1, llm_calls: 2, notes_created: 2, unmatched: 1 },
      cursor: { uid_validity: 1000, from_uid: 0, to_uid: 36, reset: false },
    });
    expect(stub.requests).toHaveLength(2);

    // Suppression note: append-only, two new lines.
    const md = (fake.tables.notes!.find((n) => n.id === supp.id)!.bodyV2 as { markdown: string }).markdown;
    expect(md).toBe(
      'ya@estaba.example — 2026-10-06 — manual\n\nluis@baja.example — 2026-10-08 — baja solicitada (asunto: "Baja")\n\nmarta@cliente2.example — 2026-10-08 — no interesado (respuesta) (asunto: "Re: Material")\n',
    );
    // Notes: the interested reply and the hard bounce, on the company + hypothesis of the send.
    const notes = fake.tables.notes!.filter((n) => n.id !== supp.id);
    expect(notes.map((n) => n.title).sort()).toEqual(['⚠️ Rebote: el email no existe (2026-10-08 12:00)', '📬 Respuesta recibida — Interesado (2026-10-08 10:00)']);
    for (const n of notes) {
      const targets = fake.tables.noteTargets!.filter((t) => t.noteId === n.id);
      expect(targets.map((t) => t.targetCompanyId ?? t.targetCommercialHypothesisId).sort()).toEqual([company.id, hypothesisId].sort());
    }

    // inbound_triage (append-only), linked to the email_sends rows.
    const r = await rows();
    expect(r.map((x) => [x.uid, x.class, x.method, x.matchBy])).toEqual([
      [31, 'BAJA', 'RULES', null],
      [32, 'INTERESADO', 'LLM', 'email'],
      [33, 'NO_INTERESADO', 'LLM', null],
      [34, 'AUTO_REPLY', 'RULES', 'domain'],
      [35, 'REBOTE', 'RULES', 'email'],
    ]);
    expect(r[1]).toMatchObject({ confidence: 0.93, hypothesisId, companyId: company.id, suppressionAdded: false, mailbox: `${imap.user}@127.0.0.1/INBOX`, uidValidity: 1000 });
    expect(r[1]!.noteId).toBeTruthy();
    expect(r[2]).toMatchObject({ suppressionAdded: true, signals: expect.arrayContaining(['no_company_match']) });
    expect(r[1]!.eventId).toBeTruthy();

    // One email.reply_received per triaged message, with the class, domains only.
    const evs = await replyEvents();
    expect(evs.map((e) => e.payload.class).sort()).toEqual(['AUTO_REPLY', 'BAJA', 'INTERESADO', 'NO_INTERESADO', 'REBOTE']);
    expect(JSON.stringify(evs.map((e) => e.payload))).not.toMatch(/carmen@|marta@|luis@|noexiste@/);
    expect(evs.find((e) => e.payload.class === 'INTERESADO')).toMatchObject({ correlationId: hypothesisId, payload: { fromDomain: 'cliente.example', matchBy: 'email', noteId: r[1]!.noteId } });

    // PM (tanda 12): every new suppression entry is audited as `suppression.add`.
    const audited = await handle.db
      .select({ subjectId: auditLog.subjectId, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant), eq(auditLog.action, 'suppression.add')));
    expect(audited.map((a) => a.subjectId).sort()).toEqual(['luis@baja.example', 'marta@cliente2.example']);
    expect(audited.map((a) => (a.payload as { class: string }).class).sort()).toEqual(['BAJA', 'NO_INTERESADO']);

    // Cursor of the new consumer, and read-only on the wire.
    const state = await handle.db.query.inboundState.findFirst({ where: and(eq(inboundState.tenantId, tenant), eq(inboundState.consumer, 'inbox')) });
    expect(state).toMatchObject({ uidValidity: 1000, lastUid: 36 });
    const verbs = imap.verbs().join('\n');
    expect(verbs).toMatch(/^EXAMINE /m);
    expect(verbs).not.toMatch(/\b(?:STORE|EXPUNGE|CLOSE|MOVE|COPY|DELETE|APPEND|SELECT)\b/i);

    // Trace: the two MODEL calls and the tool calls.
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.taskRunId, run.id) });
    const steps = await handle.db.query.traceSteps.findMany({ where: eq(traceSteps.traceId, trace!.id), orderBy: traceSteps.sequence });
    expect(steps.filter((s) => s.type === 'MODEL')).toHaveLength(2);
    expect(steps.map((s) => s.tool).filter(Boolean)).toEqual(['imap.fetch', 'get_note', 'update_note', 'create_note', 'find_company', 'create_note']);
  });

  it('is idempotent: a second run and a UIDVALIDITY reset change nothing (no LLM, no notes, no events)', async () => {
    const notesBefore = fake.tables.notes!.length;
    const patches = fake.count('PATCH', 'notes');
    const again = await runOnce();
    expect(again.output).toMatchObject({ outcome: 'SUCCESS', counters: { messages_reviewed: 0 }, cursor: { from_uid: 36, to_uid: 36 } });
    imap.uidValidity = 1001;
    const reset = await runOnce();
    expect(reset.output).toMatchObject({ outcome: 'SUCCESS', counters: { messages_reviewed: 6, already_triaged: 6, llm_calls: 0 }, cursor: { reset: true, uid_validity: 1001, to_uid: 36 } });
    expect(stub.requests).toHaveLength(2);
    expect(fake.tables.notes!.length).toBe(notesBefore);
    expect(fake.count('PATCH', 'notes')).toBe(patches);
    expect(await replyEvents()).toHaveLength(5);
    expect(await rows()).toHaveLength(5);
  });

  it('inbound_triage is append-only (UPDATE rejected by trigger, DELETE trigger installed)', async () => {
    const [first] = await rows();
    await expect(handle.db.update(inboundTriage).set({ class: 'OTRO' }).where(eq(inboundTriage.id, first!.id))).rejects.toThrow();
    const triggers = await handle.db.execute(sql`select tgname from pg_trigger where tgrelid = 'inbound_triage'::regclass and not tgisinternal order by tgname`);
    expect(triggers.rows.map((t) => (t as { tgname: string }).tgname)).toEqual(['inbound_triage_no_delete', 'inbound_triage_no_update']);
    // Stores against the real tables.
    const store = new DrizzleInboundTriageStore(handle.db);
    expect([...(await store.existingKeys(tenant, [first!.messageKey, 'mid:nope']))]).toEqual([first!.messageKey]);
    expect(await store.insert({ ...first!, id: undefined } as never)).toEqual({ created: false });
    expect(await new DrizzleSendLookup(handle.db).find(tenant, 'CARMEN@cliente.example'.toLowerCase(), new Date('2026-10-08T10:00:00Z'))).toMatchObject({ by: 'email', hypothesisId });
  });
});
