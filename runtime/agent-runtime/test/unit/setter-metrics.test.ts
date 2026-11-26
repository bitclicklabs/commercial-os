/**
 * Setter metrics (tanda 24): working hours, system task titles, the pure computation (first
 * contacts, follow-ups, cohort rate, salesperson speed, origin), the Twenty readers (mailbox
 * window, earlier messages, overdue tasks, opportunities, origins) against the fake Twenty, the
 * weekly note and the SetterReportAgent (dry run, write once, already reported). No database.
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { SETTER_REPORT_AUDIT_ACTION, SETTER_REPORT_IMPLEMENTATION, SetterReportAgent } from '../../src/agents/setter-report-agent.js';
import { resolveAgentImplementation } from '../../src/agents/stub-agent.js';
import type { AuditInsert } from '../../src/audit/service.js';
import { readAddressesWithMessagesBefore, readMailWindow } from '../../src/integrations/twenty/messages.js';
import { businessHoursBetween, computeSetterMetrics, defaultSetterPeriod, median, mondayOf, setterPeriod, type SetterDbData, type SetterSources } from '../../src/metrics/setter.js';
import { noDisponible, ok, systemTaskKind, twentySetterCrm } from '../../src/metrics/setter-crm.js';
import { renderSetterReport, setterReportTitle, trend } from '../../src/metrics/setter-report.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredSetterReportTask, desiredSetterReportVersion, SETTER_REPORT_CRON, SETTER_REPORT_TASK_NAME } from '../../src/seed/setter-report-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const TENANT = 'publiexpe';
const TZ = 'Europe/Madrid';
/** Monday 2026-11-23, 08:45 in Madrid (the CRON time). */
const NOW = new Date('2026-11-23T07:45:00Z');
const OWN = ['publiexpe.info'];
const d = (iso: string) => new Date(iso);

describe('working hours (Mon-Fri 09:00-18:00 Europe/Madrid)', () => {
  it('counts only the overlap with office hours, skipping the weekend', () => {
    // Monday 17:00 -> Tuesday 10:00 (Madrid, UTC+1) = 1 h + 1 h.
    expect(businessHoursBetween(d('2026-11-23T16:00:00Z'), d('2026-11-24T09:00:00Z'), TZ)).toBe(2);
    // Friday 17:00 -> Monday 10:00 = 2 h.
    expect(businessHoursBetween(d('2026-11-20T16:00:00Z'), d('2026-11-23T09:00:00Z'), TZ)).toBe(2);
    // Saturday -> Sunday: 0; reversed: 0.
    expect(businessHoursBetween(d('2026-11-21T09:00:00Z'), d('2026-11-22T18:00:00Z'), TZ)).toBe(0);
    expect(businessHoursBetween(d('2026-11-24T09:00:00Z'), d('2026-11-23T09:00:00Z'), TZ)).toBe(0);
    // A full working week = 45 h.
    expect(businessHoursBetween(d('2026-11-23T00:00:00Z'), d('2026-11-30T00:00:00Z'), TZ)).toBe(45);
  });

  it('is DST aware (summer: UTC+2)', () => {
    // Wednesday 2026-07-01 09:00 -> 18:00 Madrid = 07:00 -> 16:00 UTC.
    expect(businessHoursBetween(d('2026-07-01T07:00:00Z'), d('2026-07-01T16:00:00Z'), TZ)).toBe(9);
    // The week of the change (Sunday 2026-10-25): Friday 17:00 CEST -> Monday 10:00 CET = 2 h.
    expect(businessHoursBetween(d('2026-10-23T15:00:00Z'), d('2026-10-26T09:00:00Z'), TZ)).toBe(2);
  });

  it('median, periods and Mondays', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mondayOf('2026-11-26')).toBe('2026-11-23');
    expect(mondayOf('2026-11-23')).toBe('2026-11-23');
    expect(mondayOf('2026-11-22')).toBe('2026-11-16');
    const p = defaultSetterPeriod(NOW);
    expect(p).toMatchObject({ from: '2026-11-17', to: '2026-11-24' });
    expect(p.since.toISOString()).toBe('2026-11-16T23:00:00.000Z');
  });
});

describe('system task titles', () => {
  it('recognises the new and the old spelling, and nothing else', () => {
    expect(systemTaskKind('Responder a Adpan Europa S.L. 📬')).toBe('responder');
    expect(systemTaskKind('📬 Responder a Adpan')).toBe('responder');
    expect(systemTaskKind('Cerrar reunión con Acme 📅')).toBe('cerrar_reunion');
    expect(systemTaskKind('📅 Cerrar reunión con Acme')).toBe('cerrar_reunion');
    expect(systemTaskKind('Seguimiento 2 — Acme 🔔')).toBe('seguimiento');
    expect(systemTaskKind('🔔 Seguimiento — Acme')).toBe('seguimiento');
    expect(systemTaskKind('Retomar conversación con Acme 🔔')).toBe('retomar');
    expect(systemTaskKind('🔔 Retomar conversación con Acme')).toBe('retomar');
    expect(systemTaskKind('Responder a Juan')).toBeNull();
    expect(systemTaskKind('Preparar reunión con Acme 🧾')).toBeNull();
    expect(systemTaskKind(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------
const WEEK = setterPeriod('2026-11-16', '2026-11-23', TZ);
const triage = (id: string, cls: string, at: string, from: string, extra: Partial<SetterDbData['triage'][number]> = {}) => ({
  id,
  class: cls as SetterDbData['triage'][number]['class'],
  receivedAt: d(at),
  fromEmail: from,
  companyId: null,
  hypothesisId: null,
  sendId: null,
  ...extra,
});

function baseDb(): SetterDbData {
  return {
    sends: [
      { id: 's1', hypothesisId: 'h1', companyId: 'c1', recipients: ['ana@a.example'], sentAt: d('2026-11-17T09:00:00Z') },
      { id: 's2', hypothesisId: 'h2', companyId: 'c2', recipients: ['luis@b.example'], sentAt: d('2026-11-18T10:00:00Z') },
      { id: 's3', hypothesisId: 'h3', companyId: 'c3', recipients: ['old@c.example'], sentAt: d('2026-11-18T11:00:00Z') },
    ],
    priorSendRecipients: ['old@c.example'],
    triage: [
      // Wednesday 09:00 Madrid: Ana is interested, answered at 11:00 (2 working hours).
      triage('t1', 'INTERESADO', '2026-11-18T08:00:00Z', 'ana@a.example', { sendId: 's1', hypothesisId: 'h1', companyId: 'c1' }),
      // Wednesday 10:00: a question nobody answered (26 working hours until Monday 08:45).
      triage('t3', 'PREGUNTA', '2026-11-18T09:00:00Z', 'zed@g.example'),
      triage('t4', 'AUTO_REPLY', '2026-11-18T09:30:00Z', 'luis@b.example'),
      // Saturday: the mailbox first contact unsubscribes.
      triage('t5', 'BAJA', '2026-11-21T10:00:00Z', 'new@d.example'),
    ],
    meetings: [{ opportunityId: 'o1', companyId: 'c1', occurredAt: d('2026-11-19T10:00:00Z'), startsAt: '2026-11-25T10:00:00.000Z' }],
    upcomingMeetings: [{ opportunityId: 'o1', companyId: 'c1', occurredAt: d('2026-11-19T10:00:00Z'), startsAt: '2026-11-25T10:00:00.000Z' }],
    companyHypothesis: { c1: 'h1' },
    costEur: 0.4321,
  };
}

const msg = (id: string, direction: 'OUTBOUND' | 'INBOUND', at: string, counterpart: string, threadId: string | null = null) => ({
  id,
  direction,
  receivedAt: d(at).toISOString(),
  threadId,
  from: direction === 'OUTBOUND' ? 'jesus@publiexpe.info' : counterpart,
  counterparts: [counterpart],
});

function sources(over: Partial<SetterSources> = {}): SetterSources {
  return {
    tenantId: TENANT,
    timezone: TZ,
    period: WEEK,
    now: NOW,
    db: baseDb(),
    mailWindow: ok({
      messages: [
        msg('m1', 'OUTBOUND', '2026-11-17T09:05:00Z', 'ana@a.example'), // the workflow send itself
        msg('m4', 'INBOUND', '2026-11-17T08:00:00Z', 'known@e.example'),
        msg('m5', 'OUTBOUND', '2026-11-17T10:00:00Z', 'known@e.example'), // answer to someone who wrote first
        msg('m6', 'OUTBOUND', '2026-11-18T08:00:00Z', 'hist@f.example'), // address with history
        msg('m2', 'OUTBOUND', '2026-11-19T08:00:00Z', 'new@d.example'), // first contact from the webmail
        msg('m3', 'OUTBOUND', '2026-11-20T08:00:00Z', 'new@d.example'), // its follow-up
      ],
      truncated: false,
    }),
    priorMail: ok({ addresses: ['hist@f.example'], truncated: false }),
    replyMail: ok({
      byAddress: {
        'ana@a.example': [
          { id: 'r1', direction: 'INBOUND', subject: null, text: null, receivedAt: '2026-11-18T08:00:30.000Z', threadId: 'th-ana', from: 'ana@a.example', textRestricted: false },
          { id: 'r2', direction: 'OUTBOUND', subject: null, text: null, receivedAt: '2026-11-18T10:00:00.000Z', threadId: 'th-ana', from: 'jesus@publiexpe.info', textRestricted: false },
        ],
        'zed@g.example': [{ id: 'r3', direction: 'INBOUND', subject: null, text: null, receivedAt: '2026-11-18T09:00:00.000Z', threadId: 'th-zed', from: 'zed@g.example', textRestricted: false }],
      },
      truncated: false,
    }),
    opportunities: ok({ total: 3, byStage: { NEW: 1, SCREENING: 1, MEETING: 1 }, truncated: false }),
    overdue: ok({ tasks: [{ id: 'k1', title: 'Responder a Zed 📬', kind: 'responder', dueAt: '2026-11-20T08:00:00.000Z' }], truncated: false }),
    origins: ok({ h1: { signalId: 'sig-1', signalName: 'Feria Hostelco 2026' }, h2: { signalId: null, signalName: null }, h3: { signalId: null, signalName: null } }),
    ...over,
  };
}

describe('computeSetterMetrics', () => {
  it('first contacts deduped by recipient, follow-ups, replies, cohort, speed and origin', () => {
    const m = computeSetterMetrics(sources());
    expect(m.periodo).toMatchObject({ from: '2026-11-16', to: '2026-11-23', dias: 7 });
    // Ana and Luis (workflow), new@d (webmail). old@c had an earlier send; hist@f earlier mail; known@e wrote first.
    expect(m.primeros_contactos).toEqual({ total: 3, desde_workflow: 2, desde_buzon: 1, completo: true });
    // s3 (old@c), m5 (known@e), m6 (hist@f), m3 (new@d second email). m1 is the workflow send itself.
    expect(m.seguimientos_enviados).toBe(4);
    expect(m.respuestas).toEqual({ total: 4, humanas: 3, por_clase: { INTERESADO: 1, PREGUNTA: 1, NO_INTERESADO: 0, BAJA: 1, REBOTE: 0 }, aparte: { AUTO_REPLY: 1, OTRO: 0 } });
    // Ana (INTERESADO) and new@d (BAJA) answered; Luis only an auto-reply.
    expect(m.tasa_respuesta).toMatchObject({ valor: 0.6667, cohorte: 3, respondidos: 2, ventana_dias: 30, cohorte_cerrada: false });
    expect(m.tasa_respuesta.explicacion).toContain('30 días');
    expect(m.interesados).toBe(1);
    expect(m.reuniones_detectadas).toBe(1);
    expect(m.velocidad_respuesta_comercial).toMatchObject({ mediana_horas_laborables: 2, respuestas_que_esperan_contestacion: 2, contestadas: 1, sin_contestar_en_periodo: 1, sin_contestar_mas_1_dia: 1 });
    expect(m.velocidad_respuesta_comercial!.sin_contestar).toEqual([{ from: 'zed@g.example', class: 'PREGUNTA', receivedAt: '2026-11-18T09:00:00.000Z', workingHoursWaiting: 26, companyId: null }]);
    expect(m.oportunidades_abiertas).toEqual({ total: 3, por_etapa: { NEW: 1, SCREENING: 1, MEETING: 1 }, truncado: false });
    expect(m.tareas_vencidas).toMatchObject({ total: 1, por_tipo: { responder: 1, cerrar_reunion: 0, seguimiento: 0, retomar: 0 } });
    expect(m.coste_llm_eur).toBe(0.4321);
    expect(m.por_origen).toEqual([
      { origen: 'Feria Hostelco 2026', signal_id: 'sig-1', primeros_contactos: 1, respuestas_humanas: 1, interesados: 1, reuniones: 1 },
      { origen: 'sin atribuir', signal_id: null, primeros_contactos: 2, respuestas_humanas: 1, interesados: 0, reuniones: 0 },
    ]);
    expect(m.no_disponible).toEqual({});
  });

  it('a reply in another thread still answers it; a closed cohort says so', () => {
    const s = sources({ now: new Date('2027-01-10T10:00:00Z') });
    s.replyMail = ok({
      byAddress: { 'ana@a.example': [{ id: 'r2', direction: 'OUTBOUND', subject: null, text: null, receivedAt: '2026-11-19T08:00:00.000Z', threadId: 'other', from: 'jesus@publiexpe.info', textRestricted: false }] },
      truncated: false,
    });
    const m = computeSetterMetrics(s);
    // Wednesday 09:00 -> Thursday 09:00 = 9 working hours.
    expect(m.velocidad_respuesta_comercial!.mediana_horas_laborables).toBe(9);
    expect(m.tasa_respuesta.cohorte_cerrada).toBe(true);
    expect(m.tasa_respuesta.explicacion).toContain('cerrada');
  });

  it('without the mailbox: the workflow contacts only, the rest NOT AVAILABLE (null), never zero', () => {
    const reason = 'buzón sin mensajes importados en Twenty';
    const m = computeSetterMetrics(sources({ mailWindow: noDisponible(reason), priorMail: noDisponible(reason), replyMail: noDisponible(reason), opportunities: noDisponible('Twenty caído'), overdue: noDisponible('Twenty caído'), origins: noDisponible('Twenty caído') }));
    expect(m.primeros_contactos).toEqual({ total: 2, desde_workflow: 2, desde_buzon: null, completo: false });
    expect(m.seguimientos_enviados).toBeNull();
    expect(m.velocidad_respuesta_comercial).toBeNull();
    expect(m.oportunidades_abiertas).toBeNull();
    expect(m.tareas_vencidas).toBeNull();
    expect(m.por_origen).toBeNull();
    expect(Object.keys(m.no_disponible).sort()).toEqual(['oportunidades_abiertas', 'por_origen', 'primeros_contactos.desde_buzon', 'seguimientos_enviados', 'tareas_vencidas', 'velocidad_respuesta_comercial']);
    // What the database holds is still counted.
    expect(m.respuestas.humanas).toBe(3);
    expect(m.tasa_respuesta).toMatchObject({ cohorte: 2, respondidos: 1 });
  });

  it('no first contacts: no rate (null), not 0 %', () => {
    const db = baseDb();
    db.sends = [];
    const m = computeSetterMetrics(sources({ db, mailWindow: ok({ messages: [], truncated: false }) }));
    expect(m.primeros_contactos.total).toBe(0);
    expect(m.tasa_respuesta.valor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Twenty readers (fake Twenty)
// ---------------------------------------------------------------------------
function mailbox(fake: FakeTwenty, at: string, from: string, to: string[], threadId = 'th1') {
  const m = fake.seed('messages', { subject: 'Hola', text: 'texto', receivedAt: at, headerMessageId: `<${Math.random()}@x>`, messageThreadId: threadId });
  fake.seed('messageParticipants', { messageId: m.id, role: 'FROM', handle: from, displayName: null, personId: null, workspaceMemberId: null });
  for (const h of to) fake.seed('messageParticipants', { messageId: m.id, role: 'TO', handle: h, displayName: null, personId: null, workspaceMemberId: null });
  return m;
}

describe('Twenty readers', () => {
  it('mailbox window: direction and the other party; earlier messages by address', async () => {
    const fake = new FakeTwenty();
    const twenty = fake.client();
    expect(await readMailWindow(twenty, { since: WEEK.since, until: WEEK.until, ownDomains: OWN })).toEqual({ status: 'no_messages' });
    mailbox(fake, '2026-11-10T10:00:00Z', 'jesus@publiexpe.info', ['hist@f.example']);
    mailbox(fake, '2026-11-18T10:00:00Z', 'Jesus@PubliExpe.info', ['hist@f.example', 'colega@publiexpe.info']);
    mailbox(fake, '2026-11-19T10:00:00Z', 'ana@a.example', ['jesus@publiexpe.info']);
    const w = await readMailWindow(twenty, { since: WEEK.since, until: WEEK.until, ownDomains: OWN });
    expect(w.status).toBe('ok');
    if (w.status !== 'ok') return;
    expect(w.messages.map((m) => [m.direction, m.counterparts])).toEqual([
      ['OUTBOUND', ['hist@f.example']],
      ['INBOUND', ['ana@a.example']],
    ]);
    expect(await readAddressesWithMessagesBefore(twenty, { addresses: ['hist@f.example', 'ana@a.example'], before: WEEK.since })).toEqual({ status: 'ok', addresses: ['hist@f.example'], truncated: false });
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('overdue system tasks, open opportunities by stage, origins; Twenty down is «no disponible»', async () => {
    const fake = new FakeTwenty();
    fake.seed('tasks', { title: 'Responder a Ana 📬', status: 'TODO', dueAt: '2026-11-20T08:00:00Z', bodyV2: null });
    fake.seed('tasks', { title: '🔔 Seguimiento — Acme', status: 'IN_PROGRESS', dueAt: '2026-11-19T08:00:00Z', bodyV2: null });
    fake.seed('tasks', { title: 'Retomar conversación con Beta 🔔', status: 'DONE', dueAt: '2026-11-19T08:00:00Z', bodyV2: null });
    fake.seed('tasks', { title: 'Cerrar reunión con Gamma 📅', status: 'TODO', dueAt: '2026-11-30T08:00:00Z', bodyV2: null });
    fake.seed('tasks', { title: 'Llamar al gestor', status: 'TODO', dueAt: '2026-11-10T08:00:00Z', bodyV2: null });
    fake.seed('opportunities', { name: 'A', stage: 'NEW' });
    fake.seed('opportunities', { name: 'B', stage: 'MEETING' });
    fake.seed('opportunities', { name: 'C', stage: 'CUSTOMER' });
    const sig = fake.seed('commercialSignals', { name: 'Feria Hostelco 2026', tenantId: TENANT, signalType: 'FAIR', status: 'QUALIFIED' });
    const h1 = fake.seed('commercialHypotheses', { name: 'H1', tenantId: TENANT, commercialSignalId: sig.id });
    const h2 = fake.seed('commercialHypotheses', { name: 'H2', tenantId: TENANT, commercialSignalId: null });
    const crm = twentySetterCrm(fake.client(), { tenantId: TENANT });
    const tasks = await crm.overdueTasks({ now: NOW });
    expect(tasks.status === 'ok' && tasks.value.tasks.map((t) => [t.kind, t.title])).toEqual([
      ['seguimiento', '🔔 Seguimiento — Acme'],
      ['responder', 'Responder a Ana 📬'],
    ]);
    expect(await crm.openOpportunities()).toEqual({ status: 'ok', value: { total: 2, byStage: { NEW: 1, MEETING: 1 }, truncated: false } });
    expect(await crm.origins({ hypothesisIds: [String(h1.id), String(h2.id)] })).toEqual({
      status: 'ok',
      value: { [String(h1.id)]: { signalId: sig.id, signalName: 'Feria Hostelco 2026' }, [String(h2.id)]: { signalId: null, signalName: null } },
    });

    // The client keeps the fetch it was built with: a Twenty that answers 502 to everything.
    fake.fetch = async () => new Response('bad gateway', { status: 502 });
    const down = twentySetterCrm(fake.client(), { tenantId: TENANT });
    const r = await down.openOpportunities();
    expect(r.status).toBe('no_disponible');
    const unconfigured = twentySetterCrm(new FakeTwenty().client({ apiKey: undefined }), { tenantId: TENANT });
    expect(await unconfigured.overdueTasks({ now: NOW })).toMatchObject({ status: 'no_disponible', reason: expect.stringContaining('no está configurado') });
  });
});

// ---------------------------------------------------------------------------
// Weekly note
// ---------------------------------------------------------------------------
describe('weekly note', () => {
  it('title text first, emoji last; arrows; n/d; «Para esta semana»', () => {
    expect(setterReportTitle('2026-11-16')).toBe('Resumen semanal del setter — semana del 16/11 📊');
    expect(trend(5, 3)).toBe('↑ +2');
    expect(trend(1, 4)).toBe('↓ -3');
    expect(trend(2, 2)).toBe('= 0');
    expect(trend(null, 2)).toBe('—');
    const current = computeSetterMetrics(sources());
    const previous = computeSetterMetrics(sources({ period: setterPeriod('2026-11-09', '2026-11-16', TZ), db: { ...baseDb(), sends: [], triage: [], meetings: [], costEur: 0 }, mailWindow: noDisponible('buzón no legible'), priorMail: noDisponible('buzón no legible') }));
    const { title, markdown } = renderSetterReport({ monday: '2026-11-16', current, previous, now: NOW, upcoming: [{ startsAt: '2026-11-25T10:00:00.000Z', company: 'Acme | SL' }] });
    expect(title).toBe('Resumen semanal del setter — semana del 16/11 📊');
    expect(markdown).toContain('| Primeros contactos | 3 | 0 | ↑ +3 |');
    expect(markdown).toContain('| Seguimientos enviados | 4 | n/d | — |');
    expect(markdown).toContain('| Feria Hostelco 2026 | 1 | 1 | 1 | 1 |');
    expect(markdown).toContain('| Sin atribuir | 2 | 1 | 0 | 0 |');
    expect(markdown).toContain('### Para esta semana');
    expect(markdown).toContain('zed@g.example (pregunta), recibida el 18/11 10:00: 26,0 h laborables esperando.');
    expect(markdown).toContain('Responder a Zed 📬 (vencía el 20/11 09:00).');
    expect(markdown).toContain('25/11 11:00: Acme SL.');
    expect(markdown).toContain('No disponible (n/d): primeros_contactos.desde_buzon: buzón no legible');
    expect(markdown).toContain('sin LLM');
  });
});

// ---------------------------------------------------------------------------
// SetterReportAgent
// ---------------------------------------------------------------------------
describe('SetterReportAgent', () => {
  function setup() {
    const fake = new FakeTwenty();
    const registry = createDefaultToolRegistry({ twenty: fake.client() });
    const configuration = desiredSetterReportVersion().configuration;
    const audits: AuditInsert[] = [];
    const reads: Array<{ since: string; until: string }> = [];
    const agent = new SetterReportAgent({
      readDb: async (q) => {
        reads.push({ since: q.since.toISOString(), until: q.until.toISOString() });
        return q.since.getTime() === WEEK.since.getTime() ? baseDb() : { ...baseDb(), sends: [], triage: [], meetings: [], upcomingMeetings: [], costEur: 0 };
      },
      alreadyReported: async (_t, monday) => (audits.some((a) => a.subjectId === monday) ? { noteId: 'n' } : null),
      audit: async (row) => void audits.push(row),
      env: {},
      clock: () => NOW,
    });
    let n = 0;
    const run = (input: Record<string, unknown> = {}) => {
      const executionId = `exec-${++n}`;
      const tools = new ToolExecutor(registry, parseToolPolicy(configuration), { tenantId: TENANT, executionId, agentId: 'agent-sr', stage: 'SETTER_REPORT', logger: { info() {}, error() {} } }, new AbortController().signal);
      const ctx: AgentContext = {
        tenantId: TENANT,
        executionId,
        agent: { id: 'agent-sr', name: 'SetterReportAgent', role: 'setter_report' },
        version: { id: 'v1', version: 1, model: 'none', modelProvider: 'stub', systemPrompt: '', configuration },
        input,
        provider: new StubProvider(),
        signal: new AbortController().signal,
        tools,
      };
      return agent.run(ctx);
    };
    return { fake, audits, reads, run };
  }

  it('dry run: the note in the output, nothing written', async () => {
    const { fake, audits, reads, run } = setup();
    const r = await run({ dry_run: true, week_of: '2026-11-18' });
    expect(r.output).toMatchObject({ outcome: 'SUCCESS', dry_run: true, week: { from: '2026-11-16', to: '2026-11-23' }, note: { title: 'Resumen semanal del setter — semana del 16/11 📊', written: false }, cost: { eur: 0 } });
    expect(String((r.output.note as Record<string, unknown>).markdown)).toContain('### Para esta semana');
    expect(reads).toEqual([
      { since: '2026-11-15T23:00:00.000Z', until: '2026-11-22T23:00:00.000Z' },
      { since: '2026-11-08T23:00:00.000Z', until: '2026-11-15T23:00:00.000Z' },
    ]);
    expect(fake.requests.filter((q) => q.method !== 'GET')).toEqual([]);
    expect(audits).toEqual([]);
    expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(r.steps.filter((s) => s.type === 'TOOL').every((s) => s.tool === 'read_setter_crm')).toBe(true);
  });

  it('writes the note of the previous week once, marks it, then SKIPPED already_reported', async () => {
    const { fake, audits, run } = setup();
    const r = await run();
    expect(r.output).toMatchObject({ outcome: 'SUCCESS', dry_run: false, week: { from: '2026-11-16' }, note: { created: true, written: true } });
    expect(fake.tables.notes!.map((x) => x.title)).toEqual(['Resumen semanal del setter — semana del 16/11 📊']);
    expect(fake.tables.noteTargets).toHaveLength(0);
    expect(audits).toHaveLength(1);
    // The fake Twenty has no mailbox: only the two workflow first contacts (old@c had an earlier send).
    expect(audits[0]).toMatchObject({ action: SETTER_REPORT_AUDIT_ACTION, subjectId: '2026-11-16', actor: 'agent', result: 'ok', payload: { primeros_contactos: 2 } });
    const again = await run();
    expect(again.output).toMatchObject({ outcome: 'SKIPPED', reason: 'already_reported' });
    expect(fake.tables.notes).toHaveLength(1);
  });

  it('the note is reused by title when the mark was lost', async () => {
    const { fake, audits, run } = setup();
    await run();
    audits.length = 0;
    const r = await run();
    expect(r.output).toMatchObject({ outcome: 'SUCCESS', note: { created: false } });
    expect(fake.tables.notes).toHaveLength(1);
  });

  it('invalid input fails without reading', async () => {
    const { reads, run } = setup();
    const r = await run({ week_of: '23/11/2026' });
    expect(r.output).toMatchObject({ outcome: 'FAILED', error: { code: 'INVALID_INPUT' } });
    expect(reads).toEqual([]);
  });

  it('is resolved from the configuration and seeded as a Monday 08:45 CRON', () => {
    expect(resolveAgentImplementation({ implementation: SETTER_REPORT_IMPLEMENTATION }).kind).toBe(SETTER_REPORT_IMPLEMENTATION);
    expect(SETTER_REPORT_TASK_NAME).toBe('setter-weekly-report');
    expect(desiredSetterReportTask()).toMatchObject({ schedule: { type: 'CRON', expression: SETTER_REPORT_CRON }, timezone: TZ, enabled: true });
    expect(SETTER_REPORT_CRON).toBe('45 8 * * 1');
    expect(desiredSetterReportVersion()).toMatchObject({ modelProvider: 'stub', configuration: { tool_policy: { allow: ['read_setter_crm', 'create_report_note'], max_risk_level: 'LOW_WRITE' } } });
  });
});
