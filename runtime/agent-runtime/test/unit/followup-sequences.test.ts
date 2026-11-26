/**
 * Tanda 23: follow-up SEQUENCE (up to FOLLOWUP_MAX_TOUCHES follow-ups, each with a draft to
 * answer in the same thread), the mailbox trace read from Twenty (messages / messageParticipants),
 * «Retomar conversación» for the open opportunities before the meeting stage (the Adpan case),
 * the dry run, the restricted-field marker of Twenty and the titles with the emoji last.
 * Fake Twenty + in-memory store + scripted provider: no database, no network.
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { FollowUpAgent } from '../../src/agents/followup-agent.js';
import { finalizeFollowUpDraft, followUpFallbackSubject, followUpRuleViolations, parseFollowUpDraft, readableSubject } from '../../src/agents/followup-draft.js';
import { FOLLOWUP_DRAFT_SKILL_ID, FOLLOWUP_DRAFT_SYSTEM_PROMPT } from '../../src/agents/followup-draft-prompt.js';
import { DEFAULT_REPLY_SENDER } from '../../src/agents/reply-draft.js';
import type { AuditInsert } from '../../src/audit/service.js';
import {
  conversationTaskTitle,
  detectFollowUps,
  followUpKind,
  followUpLegacyTitles,
  followUpMaxTouchesFromEnv,
  followUpTaskTitle,
  isBlockingOpportunityTask,
  planConversation,
  planNextTouch,
  TEXT_RESTRICTED_LINE,
  type ConversationMessage,
} from '../../src/crm/followup.js';
import { MemoryFollowUpStore, touchOfPayload } from '../../src/crm/followup-store.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { isRestrictedFieldValue, readableField, readMailMessages } from '../../src/integrations/twenty/messages.js';
import { NULL_AVAILABILITY } from '../../src/meetings/types.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredFollowUpVersion } from '../../src/seed/followup-seed.js';
import { codeSkill } from '../../src/skills/code-skills.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { outOfWindowNote } from '../../src/agents/signal-prospecting.js';
import { revalidationNoteTitle } from '../../src/experiments/revalidation.js';
import { createCrmTask, legacyEmojiFirstTitle } from '../../src/integrations/twenty/tasks.js';
import { catalogUnavailableNoteTitle, legacyCatalogUnavailableNoteTitle } from '../../src/worker/catalog-gate.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const TZ = 'Europe/Madrid';
const TENANT = 'publiexpe';
const ME = 'jesus.abril@publiexpe.info';
const RESTRICTED = 'FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED';

const BODY =
  'Hola:\n\nTe escribo para retomar lo de los regalos para el stand. Se me ha ocurrido que unas bolsas de algodón con vuestro logo funcionan muy bien para que los visitantes se lleven los catálogos de la feria.';
const DRAFT_JSON = JSON.stringify({ cuerpo: BODY });

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('sequence rules (pure)', () => {
  it('FOLLOWUP_MAX_TOUCHES: 0..3, default 2, invalid falls back to 2', () => {
    expect(followUpMaxTouchesFromEnv({})).toBe(2);
    expect(followUpMaxTouchesFromEnv({ FOLLOWUP_MAX_TOUCHES: '0' })).toBe(0);
    expect(followUpMaxTouchesFromEnv({ FOLLOWUP_MAX_TOUCHES: ' 3 ' })).toBe(3);
    for (const bad of ['4', '-1', '1.5', 'dos']) expect(followUpMaxTouchesFromEnv({ FOLLOWUP_MAX_TOUCHES: bad })).toBe(2);
  });

  it('titles put the text first and the emoji last, and know their older spellings', () => {
    expect(followUpTaskTitle('Cliente SA', 2)).toBe('Seguimiento 1 — Cliente SA 🔔');
    expect(followUpTaskTitle('Cliente SA', 3)).toBe('Seguimiento 2 — Cliente SA 🔔');
    expect(followUpLegacyTitles('Cliente SA', 2)).toEqual(['🔔 Seguimiento 1 — Cliente SA', '🔔 Seguimiento — Cliente SA']);
    expect(followUpLegacyTitles('Cliente SA', 3)).toEqual(['🔔 Seguimiento 2 — Cliente SA']);
    expect(conversationTaskTitle('Adpan Europa S.L.')).toBe('Retomar conversación con Adpan Europa S.L. 🔔');
    for (const t of ['Retomar conversación con X 🔔', 'Cerrar reunión con X 📅', '📅 Cerrar reunión con X']) expect(isBlockingOpportunityTask(t)).toBe(true);
    expect(isBlockingOpportunityTask('Responder a X 📬')).toBe(false);
    expect(followUpTaskTitle('x'.repeat(400)).length).toBeLessThanOrEqual(255);
  });

  it('plans the next touch: one per sent follow-up, never two pending, never beyond the max', () => {
    const p = (created: number[], sent: number, maxTouches = 2) => planNextTouch({ created: new Set(created), sent, maxTouches });
    expect(p([], 0)).toEqual({ status: 'next', touch: 2 });
    expect(p([2], 0)).toEqual({ status: 'skip', reason: 'previous_touch_not_sent' });
    expect(p([2], 1)).toEqual({ status: 'next', touch: 3 });
    expect(p([2, 3], 1)).toEqual({ status: 'skip', reason: 'touches_exhausted' });
    expect(p([2, 3], 2)).toEqual({ status: 'skip', reason: 'touches_exhausted' });
    // The commercial sent a follow-up without a task: it still counts.
    expect(p([], 1)).toEqual({ status: 'next', touch: 3 });
    expect(p([2], 0, 1)).toEqual({ status: 'skip', reason: 'touches_exhausted' });
    expect(p([2, 3], 2, 3)).toEqual({ status: 'next', touch: 4 });
    expect([followUpKind(2, 2), followUpKind(3, 2), followUpKind(3, 3), followUpKind(4, 3), followUpKind(2, 1)]).toEqual(['recordatorio', 'cierre', 'recordatorio', 'cierre', 'recordatorio']);
    // Old audit rows without `touch` are touch 2.
    expect([touchOfPayload({}), touchOfPayload({ touch: 3 }), touchOfPayload({ touch: 9 })]).toEqual([2, 3, 2]);
  });

  it('a follow-up is an outbound email after the first send, not the imported copy of a send', () => {
    const sent = new Date('2026-10-12T08:15:00Z');
    const out = [
      { id: 'copy', receivedAt: '2026-10-12T08:16:00.000Z' },
      { id: 'before', receivedAt: '2026-10-10T08:00:00.000Z' },
      { id: 'f1', receivedAt: '2026-10-20T09:00:00.000Z' },
    ];
    expect(detectFollowUps([sent], out).map((m) => m.id)).toEqual(['f1']);
    expect(detectFollowUps([sent, new Date('2026-10-20T08:59:00Z')], out).map((m) => m.id)).toEqual([]);
  });

  it('a conversation is due when its last message is ours, old enough, and below the touch limit', () => {
    const m = (id: string, direction: 'OUTBOUND' | 'INBOUND', at: string, threadId: string | null = 't1'): ConversationMessage => ({ id, direction, receivedAt: at, threadId, subject: 'Merchandising', text: null, from: direction === 'OUTBOUND' ? ME : 'comercial@adpan.es' });
    const now = new Date('2026-11-26T07:30:00Z');
    const adpan = [m('a', 'OUTBOUND', '2026-10-22T05:13:00Z'), m('b', 'INBOUND', '2026-10-22T05:28:00Z'), m('c', 'OUTBOUND', '2026-10-22T07:47:00Z')];
    expect(planConversation(adpan, now, 5, 2)).toMatchObject({ status: 'due', lastOutbound: { id: 'c' }, lastInbound: { id: 'b' }, consecutiveOutbound: 1 });
    expect(planConversation([...adpan, m('d', 'INBOUND', '2026-11-02T08:00:00Z')], now, 5, 2)).toMatchObject({ status: 'skip', reason: 'last_message_inbound' });
    // An answer in another thread also counts: our email after it is the first of a new silence.
    expect(planConversation([...adpan, m('e', 'INBOUND', '2026-11-02T08:00:00Z', 't2'), m('f', 'OUTBOUND', '2026-11-03T08:00:00Z', 't1')], now, 5, 2)).toMatchObject({ status: 'due', consecutiveOutbound: 1, lastInbound: { id: 'e' } });
    expect(planConversation([...adpan, m('e', 'INBOUND', '2026-11-04T08:00:00Z', 't2')], now, 5, 2)).toMatchObject({ status: 'skip', reason: 'last_message_inbound' });
    expect(planConversation([...adpan, m('g', 'OUTBOUND', '2026-11-03T08:00:00Z')], now, 5, 2)).toMatchObject({ status: 'skip', reason: 'touches_exhausted', consecutiveOutbound: 2 });
    expect(planConversation(adpan, new Date('2026-10-27T07:30:00Z'), 5, 2)).toMatchObject({ status: 'skip', reason: 'too_recent' });
    expect(planConversation([], now, 5, 2)).toMatchObject({ status: 'skip', reason: 'no_messages' });
  });

  it('Twenty restricted-field markers are absent values: never a «Re:», a prompt or a task body', () => {
    expect(isRestrictedFieldValue(RESTRICTED)).toBe(true);
    expect(isRestrictedFieldValue('Re: hola')).toBe(false);
    expect(readableField(RESTRICTED)).toBeNull();
    expect(readableSubject(RESTRICTED)).toBeNull();
    expect(readableSubject('  ')).toBeNull();
    expect(readableSubject('Material para el stand')).toBe('Material para el stand');
    const d = finalizeFollowUpDraft({ cuerpo: BODY }, { sender: DEFAULT_REPLY_SENDER, personFirstName: null, companyName: 'Adpan Europa S.L.', threadSubject: RESTRICTED, proposal: { slots: [], bookingUrl: null, videoUrl: null, durationMin: 30, source: 'none' } });
    expect(d.subject).toBe(followUpFallbackSubject('Adpan Europa S.L.'));
    expect(d.subject).toBe('Seguimiento: Adpan Europa S.L.');
    expect(`${d.subject}\n${d.body}`).not.toContain('FIELD_RESTRICTED');
    const ok = finalizeFollowUpDraft({ cuerpo: BODY }, { sender: DEFAULT_REPLY_SENDER, personFirstName: null, companyName: 'X', threadSubject: 'RE: Material', proposal: { slots: [], bookingUrl: null, videoUrl: null, durationMin: 30, source: 'none' } });
    expect(ok.subject).toBe('Re: Material');
    expect(ok.body).toContain('¿Qué día y hora os vendría bien para una llamada de 30 minutos?');
    expect(ok.body).toContain('PubliEXPE');
  });

  it('checks the draft by code: urgency, prices, links, reproaches and length per mode', () => {
    expect(followUpRuleViolations(BODY, 'recordatorio')).toEqual([]);
    expect(followUpRuleViolations('Hola: como no me has contestado te escribo otra vez por lo de las bolsas del stand de la feria.', 'recordatorio').join(' ')).toMatch(/reproche/);
    expect(followUpRuleViolations('Hola: sigo sin noticias tuyas sobre las bolsas para el stand de la feria de marzo, cuéntame.', 'recordatorio').join(' ')).toMatch(/reproche/);
    expect(followUpRuleViolations(`${BODY} Es urgente.`, 'recordatorio').join(' ')).toMatch(/urgente/);
    expect(followUpRuleViolations(`${BODY} Con un 10 % de descuento.`, 'recordatorio').join(' ')).toMatch(/importe/);
    expect(followUpRuleViolations(`${BODY} Mira www.ejemplo.com.`, 'recordatorio').join(' ')).toMatch(/enlace/);
    expect(followUpRuleViolations(`${BODY} ${'palabra '.repeat(60)}`, 'cierre').join(' ')).toMatch(/demasiado largo/);
    expect(parseFollowUpDraft('recordatorio')(DRAFT_JSON)).toEqual({ ok: true, value: { cuerpo: BODY } });
    expect(parseFollowUpDraft('recordatorio')('no es json').ok).toBe(false);
    expect(codeSkill(FOLLOWUP_DRAFT_SKILL_ID)!.text).toBe(FOLLOWUP_DRAFT_SYSTEM_PROMPT);
  });
});

describe('alert titles with the emoji last, old emoji-first tasks still reused', () => {
  it('revalidation, catalog and lead-time titles: new format, and the old one is found by createCrmTask', async () => {
    const reval = revalidationNoteTitle('prospector-event-exhibitors', 4);
    expect(reval).toBe('Revalidación fallida — prospector-event-exhibitors v4 ⚠️');
    expect(legacyEmojiFirstTitle(reval)).toBe('⚠️ Revalidación fallida — prospector-event-exhibitors v4');
    expect(catalogUnavailableNoteTitle('2026-11-26', 'publiexpe')).toBe('Catálogo no disponible — 2026-11-26 (publiexpe) ⚠️');
    expect(legacyCatalogUnavailableNoteTitle('2026-11-26', 'publiexpe')).toBe('⚠️ Catálogo no disponible — 2026-11-26 (publiexpe)');
    const window = { minDays: 30, maxDays: 180 } as Parameters<typeof outOfWindowNote>[0]['window'];
    const far = outOfWindowNote({ signalName: 'Anuga', status: 'too_far', days: 300, eventDate: '2027-09-01', today: '2026-11-26', window });
    const nodate = outOfWindowNote({ signalName: 'Anuga', status: 'no_date', days: null, eventDate: null, today: '2026-11-26', window });
    expect([far.title, nodate.title]).toEqual(['Fuera de ventana (2026-11-26): Anuga ⏳', 'Sin fecha de feria (2026-11-26): Anuga ⏳']);
    expect(legacyEmojiFirstTitle(far.title)).toBe('⏳ Fuera de ventana (2026-11-26): Anuga');

    // A task created before the change (emoji first) is reused, never duplicated.
    const fake = new FakeTwenty();
    const now = new Date('2026-11-26T08:00:00Z');
    const old = await createCrmTask(fake.client(), { title: legacyCatalogUnavailableNoteTitle('2026-11-26', 'publiexpe'), body: 'b', scope: 'ever' }, { now });
    const again = await createCrmTask(fake.client(), { title: catalogUnavailableNoteTitle('2026-11-26', 'publiexpe'), body: 'b', scope: 'ever', legacyTitles: [legacyCatalogUnavailableNoteTitle('2026-11-26', 'publiexpe')] }, { now });
    expect(again).toMatchObject({ created: false, taskId: old.taskId });
    const oldReval = await createCrmTask(fake.client(), { title: legacyEmojiFirstTitle(reval)!, body: 'b' }, { now });
    expect((await createCrmTask(fake.client(), { title: reval, body: 'b', legacyTitles: [legacyEmojiFirstTitle(reval)!] }, { now })).taskId).toBe(oldReval.taskId);
    expect(fake.tables.tasks).toHaveLength(2);
    // New ones are created with the new format.
    const fresh = await createCrmTask(fake.client(), { title: far.title, body: 'b', legacyTitles: [legacyEmojiFirstTitle(far.title)!] }, { now });
    expect(fresh.created).toBe(true);
    expect(fake.tables.tasks.find((t) => t.id === fresh.taskId)!.title).toBe('Fuera de ventana (2026-11-26): Anuga ⏳');
  });
});

// ---------------------------------------------------------------------------
// Mailbox reader
// ---------------------------------------------------------------------------

function mailbox(fake: FakeTwenty) {
  return (id: string, from: string, to: string, at: string, subject: string | null = 'Merchandising para vuestro stand', threadId = 'thread-1', text: string | null = 'texto') => {
    fake.seed('messages', { id, subject, text, receivedAt: at, messageThreadId: threadId, headerMessageId: `<${id}@x>` });
    fake.seed('messageParticipants', { messageId: id, role: 'FROM', handle: from, displayName: null });
    fake.seed('messageParticipants', { messageId: id, role: 'TO', handle: to, displayName: null });
  };
}

describe('readMailMessages (Twenty messages, read only)', () => {
  it('gives each address its messages with their direction; masked fields come as null', async () => {
    const fake = new FakeTwenty();
    const add = mailbox(fake);
    add('m1', ME, 'Comercial@Adpan.es', '2026-10-22T05:13:00.000Z');
    add('m2', 'comercial@adpan.es', ME, '2026-10-22T05:28:00.000Z', RESTRICTED, 'thread-1', RESTRICTED);
    add('m3', ME, 'otra@cliente.example', '2026-10-22T06:00:00.000Z');
    const r = await readMailMessages(fake.client(), { addresses: ['comercial@adpan.es'], since: new Date('2026-10-01T00:00:00Z'), ownDomains: ['publiexpe.info'] });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.byAddress['comercial@adpan.es']!.map((m) => [m.id, m.direction, m.textRestricted])).toEqual([
      ['m1', 'OUTBOUND', false],
      ['m2', 'INBOUND', true],
    ]);
    expect(r.byAddress['comercial@adpan.es']![1]).toMatchObject({ subject: null, text: null });
    expect(fake.requests.every((q) => q.method === 'GET')).toBe(true);
  });

  it('no messages at all -> no_messages; a hidden object -> unreadable', async () => {
    const empty = new FakeTwenty();
    expect(await readMailMessages(empty.client(), { addresses: ['a@b.es'], since: new Date(0), ownDomains: ['publiexpe.info'] })).toEqual({ status: 'no_messages' });
    const hidden = new FakeTwenty();
    hidden.hiddenObjects.add('messages');
    expect(await readMailMessages(hidden.client(), { addresses: ['a@b.es'], since: new Date(0), ownDomains: ['publiexpe.info'] })).toMatchObject({ status: 'unreadable', code: 'TWENTY_BAD_REQUEST' });
  });
});

// ---------------------------------------------------------------------------
// FollowUpAgent
// ---------------------------------------------------------------------------

function setup(opts: { env?: NodeJS.ProcessEnv; responses?: string[]; responseText?: string; now?: string } = {}) {
  const fake = new FakeTwenty();
  fake.seed('notes', { id: SUPPRESSION_NOTE_ID, title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: 'baja@suprimida.example — 2026-10-06 — manual', blocknote: '[bn]' } });
  const store = new MemoryFollowUpStore();
  const audits: AuditInsert[] = [];
  const configuration = desiredFollowUpVersion().configuration;
  const registry = createDefaultToolRegistry({ twenty: fake.client() });
  const provider = new StubProvider({ responseText: opts.responseText ?? DRAFT_JSON, responses: opts.responses ?? [] });
  let now = new Date(opts.now ?? '2026-10-19T06:30:00Z');
  const agent = new FollowUpAgent({
    store,
    audit: async (row) => {
      audits.push(row);
      const p = row.payload as { touch?: number; kind?: string; last_outbound_message_id?: string };
      if (row.subjectType === 'opportunity') store.conversations.push({ tenantId: row.tenantId, opportunityId: String(row.subjectId), messageId: String(p.last_outbound_message_id) });
      else store.followedUp.push({ tenantId: row.tenantId, hypothesisId: String(row.subjectId), ...(p.touch ? { touch: p.touch } : {}) });
    },
    env: opts.env ?? {},
    clock: () => now,
    availability: NULL_AVAILABILITY,
  });
  let n = 0;
  const run = (input: Record<string, unknown> = {}) => {
    const executionId = `exec-${++n}`;
    const tools = new ToolExecutor(registry, parseToolPolicy(configuration), { tenantId: TENANT, executionId, agentId: 'agent-fu', stage: 'FOLLOW_UP', logger: { info() {}, error() {} } }, new AbortController().signal);
    const ctx: AgentContext = {
      tenantId: TENANT,
      executionId,
      agent: { id: 'agent-fu', name: 'FollowUpAgent', role: 'followup' },
      version: { id: 'v2', version: 2, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: '', configuration },
      input,
      provider,
      signal: new AbortController().signal,
      tools,
    };
    return agent.run(ctx);
  };
  const company = (name: string, domain?: string) => fake.seed('companies', { name, ...(domain ? { domainName: { primaryLinkUrl: domain } } : {}) });
  const hypothesis = (rec: Record<string, unknown>) =>
    fake.seed('commercialHypotheses', { name: 'H', status: 'VALIDATED', tenantId: TENANT, emailStatus: 'SENT', need: 'Bolsas para el stand', whyNow: 'Expone en Anuga', emailSubject: 'Material para vuestro stand', ...rec });
  const send = (hypothesisId: string, companyId: string | null, toEmail: string, sentAt: string, subject: string | null = 'Material para vuestro stand') =>
    store.sendRows.push({ tenantId: TENANT, hypothesisId, companyId, toEmail, subject, sentAt: new Date(sentAt) });
  const posts = () => fake.requests.filter((r) => r.method !== 'GET').length;
  return { fake, store, audits, provider, run, company, hypothesis, send, mail: mailbox(fake), posts, setNow: (d: string) => (now = new Date(d)) };
}

const taskBody = (t: Record<string, unknown>) => (t.bodyV2 as { markdown: string }).markdown;
const prompt0 = (s: { provider: StubProvider }) => s.provider.requests[0]!.messages[0]!.content;

describe('FollowUpAgent: follow-up sequence', () => {
  it('touch 2 with a draft; touch 3 only after touch 2 was really sent; nothing after the max', async () => {
    const s = setup();
    const c = s.company('Cliente SA');
    const h = s.hypothesis({ name: 'Cliente SA — Anuga', companyId: c.id, emailTo: 'carmen@cliente.example', emailBody: 'Hola Carmen, os escribo por Anuga.' });
    s.send(String(h.id), String(c.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    // The first send as Twenty imported it from «Sent» (not a follow-up).
    s.mail('first', ME, 'carmen@cliente.example', '2026-10-12T08:15:30.000Z', 'Material para vuestro stand');

    const r1 = await s.run();
    expect(r1.output).toMatchObject({ outcome: 'SUCCESS', mailbox_trace: { status: 'ok' }, counters: { tasks_created: 1, drafts_created: 1 } });
    const t1 = s.fake.tables.tasks.find((t) => t.title === 'Seguimiento 1 — Cliente SA 🔔')!;
    expect(t1).toMatchObject({ status: 'TODO', dueAt: '2026-10-19T07:00:00.000Z' });
    const md1 = taskBody(t1);
    expect(md1).toContain('### Borrador del seguimiento (recordatorio con un ángulo nuevo)');
    expect(md1).toContain('**Asunto:** Re: Material para vuestro stand');
    expect(md1).toContain('**Para:** carmen@cliente.example');
    expect(md1).toContain('- Toque 1 (primer email): 2026-10-12 10:15');
    expect(md1).toContain('expertos en merchandising');
    expect(md1).not.toMatch(/plazo|urgen|prisa/i);
    const prompt1 = s.provider.requests[0]!;
    expect(prompt1.messages[0]!.content).toContain('Modo: recordatorio');
    expect(prompt1.messages[0]!.content).toContain('Hola Carmen, os escribo por Anuga.');
    expect(s.audits[0]).toMatchObject({ action: 'lead.followup_task', subjectType: 'commercial_hypothesis', payload: { touch: 2, kind: 'sequence' } });

    // The commercial did NOT send it: the next days nothing new (its task stays open).
    s.setNow('2026-10-27T06:30:00Z');
    expect((await s.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { previous_touch_not_sent: 1 } });

    // He sends it on Tuesday 2026-10-27 from the webmail: Twenty imports it.
    s.mail('f1', ME, 'carmen@cliente.example', '2026-10-27T09:00:00.000Z', 'Re: Material para vuestro stand');
    s.setNow('2026-10-29T06:30:00Z');
    expect((await s.run()).output.examined).toEqual([expect.objectContaining({ hypothesis_id: h.id, reason: 'too_recent', touch: 3, due_day: '2026-11-03' })]);

    s.setNow('2026-11-03T07:30:00Z');
    const r3 = await s.run();
    expect(r3.output.counters).toMatchObject({ tasks_created: 1 });
    const t2 = s.fake.tables.tasks.find((t) => t.title === 'Seguimiento 2 — Cliente SA 🔔')!;
    expect(t2).toMatchObject({ dueAt: '2026-11-03T08:00:00.000Z' });
    expect(taskBody(t2)).toContain('- Toque 2 (seguimiento enviado): 2026-10-27 10:00');
    expect(taskBody(t2)).toContain('### Borrador del seguimiento (cierre amable)');
    expect(taskBody(t2)).toContain('Es el último seguimiento');
    expect(s.provider.requests[s.provider.requests.length - 1]!.messages[0]!.content).toContain('Modo: cierre');
    expect(s.audits.map((a) => (a.payload as { touch: number }).touch)).toEqual([2, 3]);

    // Touch 3 sent too: the sequence is over.
    s.mail('f2', ME, 'carmen@cliente.example', '2026-11-03T10:00:00.000Z');
    s.setNow('2026-11-20T07:30:00Z');
    expect((await s.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { touches_exhausted: 1 } });
    expect(s.fake.tables.tasks).toHaveLength(2);
    expect(s.fake.count('PATCH', 'commercialHypotheses')).toBe(0);
  });

  it('an answer in the mailbox stops it; a failed draft leaves the fixed script; an old-format task is reused', async () => {
    const s = setup({ responseText: 'no es json' });
    const a = s.company('Contesta SA');
    const b = s.company('Antigua SA');
    const hA = s.hypothesis({ companyId: a.id, emailTo: 'luis@contesta.example' });
    const hB = s.hypothesis({ companyId: b.id, emailTo: 'ana@antigua.example' });
    s.send(String(hA.id), String(a.id), 'luis@contesta.example', '2026-10-09T08:00:00Z');
    s.send(String(hB.id), String(b.id), 'ana@antigua.example', '2026-10-09T09:00:00Z');
    s.mail('ans', 'luis@contesta.example', ME, '2026-10-10T08:00:00.000Z', 'Re: Material');
    // The tanda-21 task of Antigua SA exists (its audit row was lost).
    const old = s.fake.seed('tasks', { title: '🔔 Seguimiento — Antigua SA', status: 'TODO', bodyV2: { markdown: 'x', blocknote: null } });
    s.fake.seed('taskTargets', { taskId: old.id, targetCommercialHypothesisId: hB.id, targetCompanyId: b.id });
    const r = await s.run();
    expect(r.output.counters).toMatchObject({ tasks_created: 0, tasks_reused: 1, drafts_failed: 1, skipped_by: { replied: 1 } });
    expect((r.output.examined as Array<Record<string, unknown>>).find((e) => e.hypothesis_id === hA.id)).toMatchObject({ reason: 'replied', reply_classes: ['MAILBOX'] });
    expect(s.fake.tables.tasks).toHaveLength(1);

    // A new hypothesis whose draft fails: the task carries «borrador no disponible» + the script.
    const c = s.company('Nueva SA');
    const hC = s.hypothesis({ companyId: c.id, emailTo: 'eva@nueva.example' });
    s.send(String(hC.id), String(c.id), 'eva@nueva.example', '2026-10-09T10:00:00Z');
    await s.run();
    const t = s.fake.tables.tasks.find((x) => x.title === 'Seguimiento 1 — Nueva SA 🔔')!;
    expect(taskBody(t)).toContain('Borrador no disponible: la respuesta del modelo no cumplía las reglas');
    expect(taskBody(t)).toContain('Guion sugerido');
  });

  it('FOLLOWUP_MAX_TOUCHES=0: the check runs and creates nothing', async () => {
    const s = setup({ env: { FOLLOWUP_MAX_TOUCHES: '0' } });
    const c = s.company('Cliente SA');
    const h = s.hypothesis({ companyId: c.id, emailTo: 'carmen@cliente.example' });
    s.send(String(h.id), String(c.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    const r = await s.run();
    expect(r.output).toMatchObject({ outcome: 'SKIPPED', reason_code: 'max_touches_zero', max_touches: 0 });
    expect(s.fake.tables.tasks).toHaveLength(0);
  });
});

describe('FollowUpAgent: «retomar conversación» (the Adpan case)', () => {
  function adpan(opts: { stage?: string; responseText?: string; restricted?: boolean } = {}) {
    const s = setup({ now: '2026-11-26T07:30:00Z', ...(opts.responseText ? { responseText: opts.responseText } : {}) });
    const c = s.company('Adpan Europa S.L.', 'adpan.es');
    const p = s.fake.seed('people', { name: { firstName: 'Marta', lastName: 'Gil' }, emails: { primaryEmail: 'comercial@adpan.es', additionalEmails: [] }, companyId: c.id });
    const o = s.fake.seed('opportunities', { name: 'Adpan Europa S.L. — merchandising', stage: opts.stage ?? 'SCREENING', companyId: c.id, pointOfContactId: p.id });
    const subj = opts.restricted ? RESTRICTED : 'Merchandising para vuestro stand';
    const txt = (t: string) => (opts.restricted ? RESTRICTED : t);
    s.mail('m1', ME, 'comercial@adpan.es', '2026-10-22T05:13:00.000Z', subj, 'thread-1', txt('Primer contacto'));
    s.mail('m2', 'comercial@adpan.es', ME, '2026-10-22T05:28:00.000Z', opts.restricted ? RESTRICTED : 'Re: Merchandising para vuestro stand', 'thread-1', txt('Nos interesa, ¿nos mandáis una propuesta?'));
    s.mail('m3', ME, 'comercial@adpan.es', '2026-10-22T07:47:00.000Z', opts.restricted ? RESTRICTED : 'Re: Merchandising para vuestro stand', 'thread-1', txt('Os adjunto la propuesta.'));
    return { ...s, c, p, o };
  }

  it('our proposal in silence for > 5 working days -> ONE task with the draft; never twice for the same email', async () => {
    const s = adpan();
    const r = await s.run();
    expect(r.output).toMatchObject({ outcome: 'SUCCESS', conversations: 'checked', counters: { conversation_tasks: 1, tasks_created: 1 } });
    const t = s.fake.tables.tasks.find((x) => x.title === 'Retomar conversación con Adpan Europa S.L. 🔔')!;
    expect(t).toMatchObject({ status: 'TODO', dueAt: '2026-11-26T08:00:00.000Z' });
    const md = taskBody(t);
    expect(md).toContain('### Borrador del seguimiento (retomar la conversación)');
    expect(md).toContain('**Asunto:** Re: Merchandising para vuestro stand');
    expect(md).toContain('**Para:** comercial@adpan.es');
    expect(prompt0(s)).toContain('"nombre": "Marta Gil"');
    expect(md).toContain('Último mensaje del cliente: 2026-10-22 07:28');
    const targets = s.fake.tables.taskTargets.filter((x) => x.taskId === t.id);
    expect(targets.map((x) => x.targetOpportunityId ?? x.targetCompanyId).sort()).toEqual([String(s.o.id), String(s.c.id)].sort());
    const prompt = s.provider.requests[0]!.messages[0]!.content;
    expect(prompt).toContain('Modo: conversacion');
    expect(prompt).toContain('Nos interesa, ¿nos mandáis una propuesta?');
    expect(prompt).toContain('Os adjunto la propuesta.');
    expect(s.audits).toEqual([expect.objectContaining({ action: 'lead.followup_task', subjectType: 'opportunity', subjectId: s.o.id, payload: expect.objectContaining({ kind: 'conversation', last_outbound_message_id: 'm3' }) })]);

    // Next day: the task is open (and the mark exists): nothing new.
    s.setNow('2026-11-27T07:30:00Z');
    expect((await s.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { already_done: 1 } });
    // Closed in Twenty without sending: the mark still prevents a second one for m3.
    t.status = 'DONE';
    s.setNow('2026-12-01T07:30:00Z');
    expect((await s.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { already_done: 1 } });
    expect(s.fake.tables.tasks).toHaveLength(1);
  });

  it('an answer after our email -> nothing; MEETING stage -> nothing; an open «📅 Cerrar reunión» -> nothing', async () => {
    const a = adpan();
    a.mail('m4', 'comercial@adpan.es', ME, '2026-11-02T08:00:00.000Z', 'Re: Merchandising', 'thread-1', 'Lo vemos la semana que viene');
    expect((await a.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { last_message_inbound: 1 } });

    const m = adpan({ stage: 'MEETING' });
    expect((await m.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { stage_not_before_meeting: 1 } });

    const o = adpan();
    const meet = o.fake.seed('tasks', { title: '📅 Cerrar reunión con Adpan Europa S.L.', status: 'TODO', bodyV2: null });
    o.fake.seed('taskTargets', { taskId: meet.id, targetOpportunityId: o.o.id });
    expect((await o.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { open_task: 1 } });
  });

  it('dry_run with as_of: writes nothing in Twenty nor in audit_log and returns the full draft', async () => {
    const s = adpan();
    s.setNow('2026-12-15T10:00:00Z');
    const r = await s.run({ dry_run: true, as_of: '2026-11-26' });
    expect(r.output).toMatchObject({ dry_run: true, as_of: '2026-11-26', today: '2026-11-26', counters: { tasks_created: 0, would_create: 1 } });
    const e = (r.output.examined as Array<Record<string, unknown>>).find((x) => x.opportunity_id === s.o.id)!;
    expect(e).toMatchObject({ result: 'would_create', would_create: { title: 'Retomar conversación con Adpan Europa S.L. 🔔', due_at: '2026-11-26T08:00:00.000Z' } });
    expect((e.would_create as { body: string }).body).toContain('BORRADOR');
    expect(s.posts()).toBe(0);
    expect(s.audits).toHaveLength(0);
  });

  it('text masked by Twenty (METADATA visibility): silence still detected, no marker anywhere, a hint to fix the visibility', async () => {
    const s = adpan({ restricted: true });
    const r = await s.run();
    expect(r.output.counters).toMatchObject({ tasks_created: 1, threads_text_restricted: 1 });
    const md = taskBody(s.fake.tables.tasks[0]!);
    expect(md).toContain(TEXT_RESTRICTED_LINE);
    expect(md).toContain('**Asunto:** Seguimiento: Adpan Europa S.L.');
    expect(md).toContain('respondiendo al hilo existente');
    expect(md).not.toContain('FIELD_RESTRICTED');
    for (const q of s.provider.requests) expect(q.messages.map((x) => x.content).join('\n')).not.toContain('FIELD_RESTRICTED');
  });

  it('as many consecutive outbound emails as FOLLOWUP_MAX_TOUCHES: no more tasks until the client writes', async () => {
    const s = adpan();
    s.mail('m5', ME, 'comercial@adpan.es', '2026-11-10T08:00:00.000Z', 'Re: Merchandising para vuestro stand');
    expect((await s.run()).output.counters).toMatchObject({ tasks_created: 0, skipped_by: { touches_exhausted: 1 } });
  });

  it('without a mailbox trace the conversations are skipped (messages_unavailable), never guessed', async () => {
    const s = adpan();
    s.fake.hiddenObjects.add('messages');
    const r = await s.run();
    expect(r.output).toMatchObject({ mailbox_trace: { status: 'unreadable', degraded: true }, counters: { tasks_created: 0, skipped_by: { messages_unavailable: 1 } } });
  });
});
