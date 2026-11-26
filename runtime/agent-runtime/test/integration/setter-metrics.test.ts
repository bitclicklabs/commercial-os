/**
 * Setter metrics end to end against a real PostgreSQL (no Redis, no LLM): email_sends,
 * inbound_triage and an `opportunity.meeting_detected` mark -> GET /metrics/setter (with the fake
 * Twenty mailbox, and without Twenty: «no disponible») -> seed `setter-weekly-report` -> TaskRun ->
 * RunProcessor -> SetterReportAgent: dry run (nothing written), the note once, then SKIPPED.
 * Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { recordAudit } from '../../src/audit/service.js';
import { SETTER_REPORT_AUDIT_ACTION } from '../../src/agents/setter-report-agent.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, inboundTriage, taskDefinitions, taskRuns } from '../../src/db/schema.js';
import { recordEmailSend } from '../../src/email-ops/sends.js';
import { MEETING_SYNC_AUDIT_ACTION } from '../../src/meetings/meeting-sync.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { SETTER_REPORT_TASK_NAME, seedSetterReport } from '../../src/seed/setter-report-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
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

describe.skipIf(!dbAvailable)('setter metrics: DB + Twenty -> GET /metrics/setter and the weekly note (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  const company = fake.seed('companies', { name: 'Hotel Sol SA', domainName: { primaryLinkUrl: 'sol.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const signal = fake.seed('commercialSignals', { name: 'Feria Hostelco 2026', tenantId: tenant, signalType: 'FAIR', status: 'QUALIFIED' });
  const hyp = fake.seed('commercialHypotheses', { name: 'Merch Hostelco', tenantId: tenant, companyId: company.id, commercialSignalId: signal.id });
  fake.seed('opportunities', { name: 'Hotel Sol', stage: 'MEETING', companyId: company.id });
  fake.seed('tasks', { title: 'Responder a Ana 📬', status: 'TODO', dueAt: '2026-11-19T08:00:00Z', bodyV2: null });
  // The mailbox: our first email (the workflow send, imported as «Sent») and our answer to Ana.
  const mail = (at: string, from: string, to: string, thread: string) => {
    const m = fake.seed('messages', { subject: 'Merchandising', text: 't', receivedAt: at, headerMessageId: `<${randomUUID()}@x>`, messageThreadId: thread });
    fake.seed('messageParticipants', { messageId: m.id, role: 'FROM', handle: from, displayName: null, personId: null, workspaceMemberId: null });
    fake.seed('messageParticipants', { messageId: m.id, role: 'TO', handle: to, displayName: null, personId: null, workspaceMemberId: null });
  };
  mail('2026-11-17T09:02:00Z', 'jesus@publiexpe.info', 'ana@sol.example', 'th1');
  mail('2026-11-18T08:00:00Z', 'ana@sol.example', 'jesus@publiexpe.info', 'th1');
  mail('2026-11-18T11:00:00Z', 'jesus@publiexpe.info', 'ana@sol.example', 'th1');
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    await recordEmailSend(handle.db, { tenantId: tenant, hypothesisId: String(hyp.id), companyId: String(company.id), toEmail: 'ana@sol.example', toDomain: 'sol.example', subject: 'Merchandising', sentAt: new Date('2026-11-17T09:00:00Z'), workspaceMemberId: null });
    await handle.db.insert(inboundTriage).values({
      tenantId: tenant,
      messageKey: `mid:${randomUUID()}`,
      mailbox: 'x@127.0.0.1/INBOX',
      uidValidity: 1,
      uid: 1,
      receivedAt: new Date('2026-11-18T08:00:00Z'),
      fromEmail: 'ana@sol.example',
      fromDomain: 'sol.example',
      class: 'INTERESADO',
      method: 'RULES',
      companyId: String(company.id),
      hypothesisId: String(hyp.id),
      matchBy: 'email',
    });
    await recordAudit(handle.db, {
      tenantId: tenant,
      actor: 'agent',
      action: MEETING_SYNC_AUDIT_ACTION,
      subjectType: 'opportunity',
      subjectId: 'opp-1',
      method: 'AGENT',
      route: 'agent:meeting_sync',
      result: 'ok',
      statusCode: 200,
      occurredAt: new Date('2026-11-19T10:00:00Z'),
      payload: { company_id: String(company.id), starts_at: '2026-11-24T10:00:00.000Z', event_key: 'k' },
    });
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' }, twenty: fake.client({ ownerTenantId: tenant }) });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } });

  it('GET /metrics/setter: funnel, cohort, speed and origin of a week', async () => {
    const res = await get('/metrics/setter?from=2026-11-16&to=2026-11-23');
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m).toMatchObject({
      tenant_id: tenant,
      periodo: { from: '2026-11-16', to: '2026-11-23', dias: 7 },
      // The «Sent» copy of the workflow email (2 minutes later) is the same email.
      primeros_contactos: { total: 1, desde_workflow: 1, desde_buzon: 0, completo: true },
      seguimientos_enviados: 1,
      respuestas: { humanas: 1, por_clase: { INTERESADO: 1 } },
      tasa_respuesta: { valor: 1, cohorte: 1, respondidos: 1 },
      interesados: 1,
      reuniones_detectadas: 1,
      oportunidades_abiertas: { total: 1, por_etapa: { MEETING: 1 } },
      // Wednesday 09:00 -> 12:00 Madrid.
      velocidad_respuesta_comercial: { mediana_horas_laborables: 3, contestadas: 1 },
      tareas_vencidas: { total: 1 },
      coste_llm_eur: 0,
      por_origen: [{ origen: 'Feria Hostelco 2026', primeros_contactos: 1, respuestas_humanas: 1, interesados: 1, reuniones: 1 }],
      no_disponible: {},
    });
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('GET /metrics/setter validates the period and defaults to the last 7 days', async () => {
    expect((await get('/metrics/setter?from=2026-11-23&to=2026-11-16')).statusCode).toBe(400);
    expect((await get('/metrics/setter?from=2026-11-16')).statusCode).toBe(400);
    expect((await get('/metrics/setter?from=2026-01-01&to=2026-11-16')).statusCode).toBe(400);
    const res = await get('/metrics/setter');
    expect(res.statusCode).toBe(200);
    expect(res.json().periodo.dias).toBe(7);
  });

  it('without Twenty the CRM parts are «no disponible», the database ones are counted', async () => {
    const bare = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
    try {
      const m = (await bare.inject({ method: 'GET', url: '/metrics/setter?from=2026-11-16&to=2026-11-23', headers: { 'x-tenant-id': tenant } })).json();
      expect(m).toMatchObject({ primeros_contactos: { total: 1, desde_buzon: null, completo: false }, seguimientos_enviados: null, velocidad_respuesta_comercial: null, oportunidades_abiertas: null, tareas_vencidas: null, por_origen: null, respuestas: { humanas: 1 }, reuniones_detectadas: 1 });
      expect(Object.keys(m.no_disponible)).toEqual(expect.arrayContaining(['seguimientos_enviados', 'velocidad_respuesta_comercial', 'oportunidades_abiertas', 'tareas_vencidas', 'por_origen']));
    } finally {
      await bare.close();
    }
  });

  async function runOnce(input: Record<string, unknown>) {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, SETTER_REPORT_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it:${randomUUID()}`, input });
    const processor = new RunProcessor(handle.db, () => new StubProvider(), undefined, createDefaultToolRegistry({ twenty: fake.client({ ownerTenantId: tenant }) }), null);
    for (const { job } of queue.drain()) await processor.process(job);
    return (await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) }))!;
  }

  it('seeds setter-weekly-report idempotently (CRON Monday 08:45, Europe/Madrid)', async () => {
    expect(await seedSetterReport(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'created', taskAction: 'created' });
    expect(await seedSetterReport(handle.db, { tenantId: tenant })).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged' });
    const t = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, SETTER_REPORT_TASK_NAME)) });
    expect(t).toMatchObject({ schedule: { type: 'CRON', expression: '45 8 * * 1' }, timezone: 'Europe/Madrid', enabled: true });
  });

  it('dry run returns the note without writing; the real run writes it once and marks the week', async () => {
    const dry = await runOnce({ dry_run: true, week_of: '2026-11-18' });
    expect(dry.status).toBe('COMPLETED');
    expect(dry.output).toMatchObject({ outcome: 'SUCCESS', dry_run: true, note: { title: 'Resumen semanal del setter — semana del 16/11 📊', written: false } });
    expect(String(((dry.output as Record<string, unknown>).note as Record<string, unknown>).markdown)).toContain('| Feria Hostelco 2026 | 1 | 1 | 1 | 1 |');
    expect(fake.tables.notes).toHaveLength(0);

    const real = await runOnce({ week_of: '2026-11-18' });
    expect(real.output).toMatchObject({ outcome: 'SUCCESS', note: { created: true, written: true } });
    expect(fake.tables.notes!.map((n) => n.title)).toEqual(['Resumen semanal del setter — semana del 16/11 📊']);
    const marks = await handle.db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenant), eq(auditLog.action, SETTER_REPORT_AUDIT_ACTION)));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ subjectType: 'setter_weekly_report', subjectId: '2026-11-16', actor: 'agent', result: 'ok' });

    const again = await runOnce({ week_of: '2026-11-20' });
    expect(again.output).toMatchObject({ outcome: 'SKIPPED', reason: 'already_reported' });
    expect(fake.tables.notes).toHaveLength(1);
  });
});
