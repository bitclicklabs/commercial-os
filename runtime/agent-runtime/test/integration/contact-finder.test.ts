/**
 * ContactFinder end to end against a real PostgreSQL (no Redis, no network: FakeTwenty +
 * FakeWeb + MX mock + stub enrichment):
 * 1. POST /evaluations/human (ACCEPTED) -> evaluation.recorded -> draft-email-on-validated ->
 *    EmailDrafter: contact FIRST (find_contact on the company's web -> emailTo filled ->
 *    Research "Contacto — …" with the source), THEN the draft (set_hypothesis_draft keeps
 *    the recipient) and the note.
 * 2. POST /contacts/backfill (audited) -> one ContactFinder run per VALIDATED hypothesis of
 *    the tenant with an empty emailTo: phase 2 (stub enrichment) when the web publishes
 *    nothing, "Sin contacto público" when nobody knows; manual / sent / other-tenant
 *    hypotheses untouched; a second call queues nothing (idempotent).
 * Fresh tenant per run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { DailyLookupBudget, EnrichService, StubEnrichProvider } from '../../src/contact-finder/enrich/index.js';
import type { ContactFinderDeps } from '../../src/contact-finder/finder.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, auditLog, taskDefinitions, taskRuns, traces, traceSteps } from '../../src/db/schema.js';
import { EventBus, MemoryEventQueue } from '../../src/events/event-bus.js';
import { evaluateTrigger, eventTaskRunIdempotencyKey, eventTriggeredInput, parseEventTrigger } from '../../src/events/triggers.js';
import { SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { seedContactFinder } from '../../src/seed/contact-finder-seed.js';
import { EMAIL_DRAFT_TASK_NAME, seedEmailDrafter } from '../../src/seed/email-drafter-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

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

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/contact-finder');
const html = (name: string) => readFileSync(path.join(FIX, name), 'utf8');

const DRAFT = JSON.stringify({
  asunto: 'Material para vuestro stand en Gastrónoma',
  cuerpo:
    'Hola:\n\nSoy Jesús Abril, de PubliEXPE. He visto que estaréis en Gastrónoma y quería ofreceros ayuda con el material del stand.\n\nPodemos prepararos bolsas tote y delantales bordados en nuestro taller propio, con plazos cortos.\n\n¿Te encaja que te mande dos o tres propuestas?\n\nUn saludo,',
});

const links = (domain: string) => ({ primaryLinkUrl: domain, primaryLinkLabel: '', secondaryLinks: [] });

describe.skipIf(!dbAvailable)('ContactFinder: drafter contact step and backfill (PostgreSQL + FakeTwenty)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const fake = new FakeTwenty();
  fake.seed('notes', { title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: '- @competidor.es — 2026-09-01 — no contactar', blocknote: null } });

  // Web of the companies (nothing leaves the process).
  const web = new FakeWeb();
  web.page('https://conservas-cantabrico.es/', html('home.html'));
  web.page('https://conservas-cantabrico.es/contacta-con-nosotros/', html('contacto.html'));
  web.page('https://conservas-cantabrico.es/nuestro-equipo/', html('equipo.html'));
  web.page('https://conservas-ejemplo.example/', html('vacia.html'));
  web.page('https://bodegas-sin-correo.example/', html('vacia.html'));
  const stub = new StubEnrichProvider();
  const contacts: ContactFinderDeps = {
    web: web.deps(),
    render: { endpoint: null },
    mx: async () => 'ok',
    enrich: new EnrichService(stub, new DailyLookupBudget(25)),
    allowReservedDomains: true,
  };
  const registry = () => createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: { endpoint: null }, contacts });

  // 1. Hypothesis validated by the commercial (drafter path).
  const cantabrico = fake.seed('companies', { name: 'Conservas del Cantábrico', domainName: links('conservas-cantabrico.es') });
  const signal = fake.seed('commercialSignals', { name: 'Gastrónoma 2026 — Conservas del Cantábrico', signalType: 'FAIR', eventDate: '2026-11-17', companyId: cantabrico.id });
  const hDraft = fake.seed('commercialHypotheses', {
    name: 'Conservas del Cantábrico — Gastrónoma 2026',
    status: 'PROPOSED',
    need: 'Material para el stand',
    whyNow: 'Feria en noviembre',
    recommendedProducts: ['Bolsas tote'],
    evidence: [{ claim: 'Expositor de Gastrónoma' }],
    companyId: cantabrico.id,
    commercialSignalId: signal.id,
    decisionMakerId: null,
    tenantId: tenant,
  });

  // 2. Backfill world: validated hypotheses drafted before the ContactFinder existed.
  const ejemplo = fake.seed('companies', { name: 'Conservas Ejemplo', domainName: links('conservas-ejemplo.example') });
  const sinCorreo = fake.seed('companies', { name: 'Bodegas Sin Correo', domainName: links('bodegas-sin-correo.example') });
  const base = { status: 'VALIDATED', need: 'n', whyNow: 'w', evidence: [{ claim: 'c' }], commercialSignalId: null, decisionMakerId: null, emailSubject: 'Asunto', emailBody: 'Cuerpo' };
  const hEnrich = fake.seed('commercialHypotheses', { ...base, name: 'Conservas Ejemplo — Gastrónoma', companyId: ejemplo.id, emailTo: '', emailStatus: 'DRAFT', tenantId: tenant });
  const hNothing = fake.seed('commercialHypotheses', { ...base, name: 'Bodegas Sin Correo — Gastrónoma', companyId: sinCorreo.id, emailTo: null, emailStatus: 'DRAFT', tenantId: tenant });
  const hManual = fake.seed('commercialHypotheses', { ...base, name: 'Manual', companyId: ejemplo.id, emailTo: 'ana@cliente.es', emailStatus: 'DRAFT', tenantId: tenant });
  const hSent = fake.seed('commercialHypotheses', { ...base, name: 'Enviada', companyId: ejemplo.id, emailTo: '', emailStatus: 'SENT', tenantId: tenant });
  const hOther = fake.seed('commercialHypotheses', { ...base, name: 'Otro tenant', companyId: ejemplo.id, emailTo: '', emailStatus: 'DRAFT', tenantId: 'otro-tenant' });

  const queue = new MemoryEventQueue();
  let handle: DbHandle;
  let app: FastifyInstance;
  let runQueue: MemoryRunQueue;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    const bus = new EventBus(handle.db, queue, { tenantId: tenant });
    // Origin run of the hypothesis (the link resolver recovers companyId from it).
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name: `it-prospector-${randomUUID().slice(0, 6)}` }).returning();
    const [version] = await handle.db.insert(agentVersions).values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'stub', modelProvider: 'stub' }).returning();
    const [execution] = await handle.db.insert(agentExecutions).values({ tenantId: tenant, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', output: { ok: true } }).returning();
    const [trace] = await handle.db.insert(traces).values({ tenantId: tenant, executionId: execution!.id, agentId: agent!.id }).returning();
    await handle.db.insert(traceSteps).values({
      tenantId: tenant,
      traceId: trace!.id,
      sequence: 1,
      timestamp: new Date(),
      type: 'TOOL',
      tool: 'create_hypothesis',
      toolInput: { companyId: cantabrico.id, need: 'Material para el stand' },
      toolOutput: { created: true, record: { id: hDraft.id, status: 'PROPOSED' } },
    });
    runQueue = new MemoryRunQueue();
    app = await buildServer({
      db: handle.db,
      queue: runQueue,
      config: { defaultTenantId: tenant, defaultModelProvider: 'stub', evaluationDedupeWindowMs: 600_000 },
      events: bus,
      twenty: fake.client(),
    });
    await seedEmailDrafter(handle.db, { tenantId: tenant });
    await seedContactFinder(handle.db, { tenantId: tenant });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('validated hypothesis -> contact FIRST (emailTo + Research with the source) -> draft after, in the same run', async () => {
    const res = await app.inject({ method: 'POST', url: '/evaluations/human', headers: { 'x-tenant-id': tenant }, payload: { hypothesisId: hDraft.id, feedback: 'ACCEPTED' } });
    expect(res.statusCode).toBe(201);
    hDraft.status = 'VALIDATED'; // what the commercial did in Twenty
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.name, EMAIL_DRAFT_TASK_NAME)) });
    const [envelope] = queue.drain();
    expect(evaluateTrigger(task!, parseEventTrigger(task!.schedule)!, envelope!)).toEqual({ fire: true, depth: 1 });
    const drafterRuns = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, drafterRuns, task!, { idempotencyKey: eventTaskRunIdempotencyKey(task!.id, envelope!.id), input: eventTriggeredInput(envelope!), trigger: 'EVENT' });
    const provider = new StubProvider({ responses: [DRAFT], usage: { inputTokens: 800, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
    const processor = new RunProcessor(handle.db, () => provider, undefined, registry(), null);
    for (const { job } of drafterRuns.drain()) await processor.process(job);

    const done = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    expect(done).toMatchObject({ status: 'COMPLETED' });
    expect(done!.output).toMatchObject({
      outcome: 'SUCCESS',
      sends_email: false,
      contact: { status: 'done', found: true, email: 'maria.gomez@conservas-cantabrico.es', emailTo: 'written', sourceUrl: 'https://conservas-cantabrico.es/nuestro-equipo/' },
      hypothesis_draft: { written: true },
    });
    // emailTo filled by the contact step and kept by the draft.
    expect(hDraft).toMatchObject({ emailTo: 'maria.gomez@conservas-cantabrico.es', emailStatus: 'DRAFT' });
    expect(String(hDraft.emailBody)).toContain('Jesús Abril');
    // Research with the exact source.
    const research = fake.tables.researches.find((r) => r.companyId === cantabrico.id)!;
    expect(research).toMatchObject({ name: 'Contacto — Conservas del Cantábrico', researchType: 'CONTACT_DISCOVERY', tenantId: tenant, commercialSignalId: signal.id });
    expect(String(research.summary)).toContain('Contacto elegido: maria.gomez@conservas-cantabrico.es (María Gómez Ruiz, Directora de Marketing)');
    expect(String(research.summary)).toContain('Fuente: https://conservas-cantabrico.es/nuestro-equipo/ (protección Cloudflare)');
    expect(research.sources).toContain('https://conservas-cantabrico.es/nuestro-equipo/');
    // Tanda 19: the draft lives in the hypothesis fields (no duplicate «Borrador email» note); the
    // Research above tells the commercial where the address comes from.
    expect(fake.tables.notes.find((n) => String(n.title).startsWith('Borrador email'))).toBeUndefined();
    expect(done!.output).toMatchObject({ note_created: false, note_skipped: 'draft_in_hypothesis_fields' });
    // Order in the trace: contact first, draft after.
    const exec = await handle.db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, done!.executionId!) });
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, exec!.id) });
    const tools = (await handle.db.query.traceSteps.findMany({ where: eq(traceSteps.traceId, trace!.id), orderBy: asc(traceSteps.sequence) }))
      .filter((s) => s.type === 'TOOL')
      .map((s) => s.tool);
    // Tandas 19 combinadas: upsert_person entra y la nota-borrador ya no se crea (campos OK).
    expect(tools).toEqual(['get_hypothesis', 'find_contact', 'set_hypothesis_recipient', 'upsert_person', 'create_research', 'set_hypothesis_draft']);
    // Tanda 19: the chosen person is a native Person linked to the company; the Research references it.
    const maria = fake.tables.people.filter((p) => (p.emails as { primaryEmail: string }).primaryEmail === 'maria.gomez@conservas-cantabrico.es');
    expect(maria).toEqual([expect.objectContaining({ name: { firstName: 'María', lastName: 'Gómez Ruiz' }, jobTitle: 'Directora de Marketing', companyId: cantabrico.id })]);
    expect(research.structuredResult).toMatchObject({ chosen: { person_id: maria[0]!.id }, people: [{ email: 'maria.gomez@conservas-cantabrico.es', person_id: maria[0]!.id, outcome: 'created', chosen: true }] });
    expect(String(research.summary)).toContain(`Persona en Twenty: ${maria[0]!.id} (creada)`);
    // Generic / function mailboxes of the same page never become people.
    expect(fake.tables.people.some((p) => /^(info|comercial)@/.test((p.emails as { primaryEmail: string }).primaryEmail))).toBe(false);
    expect(stub.calls).toEqual([]); // the web had the answer: no enrichment
  });

  it('backfill (audited): phase 2 stub when the web has nothing, "Sin contacto público" when nobody knows, the rest untouched', async () => {
    const dry = await app.inject({ method: 'POST', url: '/contacts/backfill', headers: { 'x-tenant-id': tenant, 'x-actor': 'it' }, payload: { dry_run: true } });
    expect(dry.statusCode).toBe(200);
    expect((dry.json() as { backfill: { queued: unknown[] } }).backfill.queued).toHaveLength(2);
    expect(runQueue.jobs.size).toBe(0);

    const res = await app.inject({ method: 'POST', url: '/contacts/backfill', headers: { 'x-tenant-id': tenant, 'x-actor': 'it' }, payload: { limit: 10 } });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { backfill: { scanned: number; queued: Array<{ hypothesis_id: string; task_run_id: string }>; skipped: Array<{ hypothesis_id: string; reason: string }> } };
    // hDraft now has emailTo; hManual too; hSent is a person's; hOther is another tenant.
    expect(body.backfill.queued.map((q) => q.hypothesis_id).sort()).toEqual([hEnrich.id, hNothing.id].sort());
    expect(body.backfill.skipped).toEqual([expect.objectContaining({ hypothesis_id: hSent.id, reason: expect.stringContaining('SENT') })]);
    expect(body.backfill.scanned).toBe(5); // VALIDATED of this tenant only (hOther filtered by tenantId)

    const provider = new StubProvider({ responses: [] });
    const processor = new RunProcessor(handle.db, () => provider, undefined, registry(), null);
    for (const { job } of runQueue.drain()) await processor.process(job);

    for (const q of body.backfill.queued) {
      const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, q.task_run_id) });
      expect(run).toMatchObject({ status: 'COMPLETED' });
    }
    // Phase 2 (stub fixture, confidence 0.91 >= 0.7): filled; the 0.52 one only listed.
    expect(hEnrich.emailTo).toBe('laura.marin@conservas-ejemplo.example');
    const rEnrich = fake.tables.researches.find((r) => r.companyId === ejemplo.id)!;
    expect(rEnrich.name).toBe('Contacto — Conservas Ejemplo');
    expect(String(rEnrich.summary)).toContain('proveedor stub, confianza 0.91');
    expect(String(rEnrich.summary)).toContain('j.soto@conservas-ejemplo.example — prioridad 4');
    expect(String(rEnrich.summary)).toContain('confianza < 0,70: no se escribe en Email to');
    expect(String(rEnrich.query)).toContain(hEnrich.id);
    // Phase 2 person with name + title and confidence >= 0.70 -> native Person; the 0.52 one, no.
    const laura = fake.tables.people.find((p) => (p.emails as { primaryEmail: string }).primaryEmail === 'laura.marin@conservas-ejemplo.example');
    expect(laura).toMatchObject({ name: { firstName: 'Laura', lastName: 'Marín' }, jobTitle: 'Responsable de Marketing', companyId: ejemplo.id });
    expect(fake.tables.people.some((p) => (p.emails as { primaryEmail: string }).primaryEmail === 'j.soto@conservas-ejemplo.example')).toBe(false);
    expect(rEnrich.structuredResult).toMatchObject({ chosen: { person_id: laura!.id } });
    // Nobody knows: nothing invented.
    expect(hNothing.emailTo).toBeNull();
    const rNothing = fake.tables.researches.find((r) => r.companyId === sinCorreo.id)!;
    expect(rNothing.name).toBe('Sin contacto público — Bodegas Sin Correo');
    expect(stub.calls).toEqual(['conservas-ejemplo.example', 'bodegas-sin-correo.example']);
    // Untouched.
    expect(hManual.emailTo).toBe('ana@cliente.es');
    expect(hSent.emailTo).toBe('');
    expect(hOther.emailTo).toBe('');

    // Idempotent: a second call queues nothing (filled, or already searched).
    const again = await app.inject({ method: 'POST', url: '/contacts/backfill', headers: { 'x-tenant-id': tenant }, payload: {} });
    const againBody = again.json() as { backfill: { queued: unknown[]; skipped: Array<{ hypothesis_id: string; reason: string }> } };
    expect(againBody.backfill.queued).toEqual([]);
    expect(againBody.backfill.skipped).toContainEqual(expect.objectContaining({ hypothesis_id: hNothing.id, reason: expect.stringContaining('ya buscado') }));
    expect(fake.tables.researches.filter((r) => r.companyId === sinCorreo.id)).toHaveLength(1);

    const audits = await handle.db.query.auditLog.findMany({ where: and(eq(auditLog.tenantId, tenant), eq(auditLog.route, '/contacts/backfill')) });
    expect(audits.map((a) => a.action).sort()).toEqual(['contact.backfill', 'contact.backfill', 'contact.backfill_dry_run']);
    expect(audits.every((a) => a.subjectType === 'tenant' && a.subjectId === tenant)).toBe(true);
  });
});
