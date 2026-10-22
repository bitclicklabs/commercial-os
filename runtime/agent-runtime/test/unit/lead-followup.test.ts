/**
 * Lead follow-up (tanda 21): rules (working days, env, title, fixed script), the hypothesis
 * anchor of createCrmTask, the tool `list_sent_hypotheses` and the FollowUpAgent against a fake
 * Twenty and an in-memory store (no database, no LLM).
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { FOLLOWUP_IMPLEMENTATION, FOLLOWUP_TOOLS, FollowUpAgent } from '../../src/agents/followup-agent.js';
import { resolveAgentImplementation } from '../../src/agents/stub-agent.js';
import type { AuditInsert } from '../../src/audit/service.js';
import {
  businessDaysSince,
  DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS,
  FOLLOWUP_AUDIT_ACTION,
  FOLLOWUP_MAX_TASKS_PER_RUN,
  followUpAfterBusinessDaysFromEnv,
  followUpDueDay,
  followUpTaskBody,
  followUpTaskTitle,
  isFollowUpDue,
} from '../../src/crm/followup.js';
import { MemoryFollowUpStore } from '../../src/crm/followup-store.js';
import { SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { createCrmTask } from '../../src/integrations/twenty/tasks.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredFollowUpTask, desiredFollowUpVersion, FOLLOWUP_TASK_NAME } from '../../src/seed/followup-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const TZ = 'Europe/Madrid';
const TENANT = 'publiexpe';

describe('follow-up rules', () => {
  it('counts working days Monday-Friday in Europe/Madrid (no holidays)', () => {
    // Monday 2026-10-12 10:15 Madrid -> due the next Monday (5 working days).
    const sent = new Date('2026-10-12T08:15:00Z');
    expect(followUpDueDay(sent, 5, TZ)).toBe('2026-10-19');
    expect(isFollowUpDue(sent, new Date('2026-10-16T22:00:00Z'), 5, TZ)).toBe(false); // Saturday 00:00 Madrid
    expect(isFollowUpDue(sent, new Date('2026-10-19T06:30:00Z'), 5, TZ)).toBe(true); // Monday 08:30 Madrid (the cron)
    expect(businessDaysSince(sent, new Date('2026-10-19T06:30:00Z'), TZ)).toBe(5);
    expect(businessDaysSince(sent, new Date('2026-10-22T06:30:00Z'), TZ)).toBe(8);
    // Friday send -> next Friday; a Saturday send counts from the Monday.
    expect(followUpDueDay(new Date('2026-10-16T15:00:00Z'), 5, TZ)).toBe('2026-10-23');
    expect(followUpDueDay(new Date('2026-10-17T10:00:00Z'), 5, TZ)).toBe('2026-10-23');
    // A send at 23:30 Madrid on Monday is a Monday send (local day, not UTC).
    expect(followUpDueDay(new Date('2026-10-12T21:30:00Z'), 1, TZ)).toBe('2026-10-13');
  });

  it('reads FOLLOWUP_AFTER_BUSINESS_DAYS: default 5, 0 disables, invalid falls back', () => {
    expect(followUpAfterBusinessDaysFromEnv({})).toBe(DEFAULT_FOLLOWUP_AFTER_BUSINESS_DAYS);
    expect(followUpAfterBusinessDaysFromEnv({ FOLLOWUP_AFTER_BUSINESS_DAYS: '0' })).toBe(0);
    expect(followUpAfterBusinessDaysFromEnv({ FOLLOWUP_AFTER_BUSINESS_DAYS: ' 7 ' })).toBe(7);
    for (const bad of ['-1', '2.5', 'cinco', '999']) expect(followUpAfterBusinessDaysFromEnv({ FOLLOWUP_AFTER_BUSINESS_DAYS: bad })).toBe(5);
  });

  it('builds the title and a fixed, calm script with the angle of the hypothesis', () => {
    expect(followUpTaskTitle('Cliente "SA"')).toBe('🔔 Seguimiento — Cliente SA');
    expect(followUpTaskTitle('')).toBe('🔔 Seguimiento — empresa sin nombre');
    const body = followUpTaskBody({
      company: 'Cliente SA',
      hypothesisName: 'Cliente SA — Anuga',
      sentLocal: '2026-10-12 10:15',
      timezone: TZ,
      subject: 'Material para vuestro stand',
      recipient: 'carmen@cliente.example',
      businessDays: 5,
      need: 'Bolsas **personalizadas** para el stand',
      whyNow: 'Expone en Anuga en marzo',
    });
    expect(body).toContain('- Primer envío: 2026-10-12 10:15 (Europe/Madrid)');
    expect(body).toContain('- Asunto: «Material para vuestro stand»');
    expect(body).toContain('- Destinatario: carmen@cliente.example');
    expect(body).toContain('- Necesidad: Bolsas personalizadas para el stand');
    expect(body).toContain('- Por qué ahora: Expone en Anuga en marzo');
    expect(body.match(/^- /gm)?.length).toBe(4 + 2 + 3);
    // House rule: no urgency, never "plazos cortos".
    expect(body).not.toMatch(/plazo|urgen|últim|prisa|cuanto antes|oferta limitada/i);
    expect(body).toContain('no envía nada');
  });
});

describe('createCrmTask anchored on the hypothesis (scope ever)', () => {
  it('one task per hypothesis forever, even for two hypotheses of the same company, even when DONE', async () => {
    const fake = new FakeTwenty();
    const twenty = fake.client();
    const input = (hypothesisId: string) => ({ title: '🔔 Seguimiento — Cliente SA', body: 'x', dueAt: '2026-10-19', targets: { companyId: 'c1', hypothesisId }, scope: 'ever' as const, anchor: 'hypothesisId' as const });
    const a = await createCrmTask(twenty, input('h1'), { now: new Date('2026-10-19T06:30:00Z') });
    const b = await createCrmTask(twenty, input('h2'), { now: new Date('2026-10-19T06:30:00Z') });
    expect([a.created, b.created]).toEqual([true, true]);
    expect(a.taskId).not.toBe(b.taskId);
    fake.tables.tasks.find((t) => t.id === a.taskId)!.status = 'DONE';
    const again = await createCrmTask(twenty, input('h1'), { now: new Date('2026-11-02T06:30:00Z') });
    expect(again).toMatchObject({ created: false, taskId: a.taskId });
    expect(fake.tables.tasks).toHaveLength(2);
    expect(fake.tables.taskTargets).toHaveLength(4);
    expect(a.dueAt).toBe('2026-10-19T07:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// FollowUpAgent
// ---------------------------------------------------------------------------

function setup(opts: { suppression?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  const fake = new FakeTwenty();
  if (opts.suppression !== null) {
    fake.seed('notes', { id: SUPPRESSION_NOTE_ID, title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: opts.suppression ?? 'baja@suprimida.example — 2026-10-06 — manual', blocknote: '[bn]' } });
  }
  const store = new MemoryFollowUpStore();
  const audits: AuditInsert[] = [];
  const configuration = desiredFollowUpVersion().configuration;
  const registry = createDefaultToolRegistry({ twenty: fake.client() });
  let now = new Date('2026-10-19T06:30:00Z');
  const agent = new FollowUpAgent({
    store,
    audit: async (row) => {
      audits.push(row);
      store.followedUp.push({ tenantId: row.tenantId, hypothesisId: String(row.subjectId) });
    },
    env: opts.env ?? {},
    clock: () => now,
  });
  let n = 0;
  const run = () => {
    const executionId = `exec-${++n}`;
    const tools = new ToolExecutor(registry, parseToolPolicy(configuration), { tenantId: TENANT, executionId, agentId: 'agent-fu', stage: 'FOLLOW_UP', logger: { info() {}, error() {} } }, new AbortController().signal);
    const ctx: AgentContext = {
      tenantId: TENANT,
      executionId,
      agent: { id: 'agent-fu', name: 'FollowUpAgent', role: 'followup' },
      version: { id: 'v1', version: 1, model: 'none', modelProvider: 'stub', systemPrompt: '', configuration },
      input: {},
      provider: new StubProvider(),
      signal: new AbortController().signal,
      tools,
    };
    return agent.run(ctx);
  };
  const company = (name: string) => fake.seed('companies', { name });
  const hypothesis = (rec: Record<string, unknown>) =>
    fake.seed('commercialHypotheses', { name: 'H', status: 'VALIDATED', tenantId: TENANT, emailStatus: 'SENT', need: 'Bolsas para el stand', whyNow: 'Expone en Anuga', emailSubject: 'Material para vuestro stand', ...rec });
  const send = (hypothesisId: string, companyId: string | null, toEmail: string, sentAt: string, subject = 'Material para vuestro stand') =>
    store.sendRows.push({ tenantId: TENANT, hypothesisId, companyId, toEmail, subject, sentAt: new Date(sentAt) });
  return { fake, store, audits, run, company, hypothesis, send, setNow: (d: string) => (now = new Date(d)) };
}

describe('FollowUpAgent', () => {
  it('creates ONE 🔔 task per unanswered send and reports every skipped SENT hypothesis with its reason', async () => {
    const s = setup();
    const due = s.company('Cliente SA');
    const recent = s.company('Reciente SL');
    const replied = s.company('Contesta SA');
    const bounced = s.company('Rebota SA');
    const auto = s.company('Vacaciones SA');
    const supp = s.company('Suprimida SA');
    const hDue = s.hypothesis({ name: 'Cliente SA — Anuga', companyId: due.id, emailTo: 'carmen@cliente.example' });
    const hRecent = s.hypothesis({ companyId: recent.id, emailTo: 'a@reciente.example' });
    const hReplied = s.hypothesis({ companyId: replied.id, emailTo: 'b@contesta.example' });
    const hBounced = s.hypothesis({ companyId: bounced.id, emailTo: 'c@rebota.example' });
    const hAuto = s.hypothesis({ companyId: auto.id, emailTo: 'd@vacaciones.example' });
    const hSupp = s.hypothesis({ companyId: supp.id, emailTo: 'baja@suprimida.example' });
    const hNoSend = s.hypothesis({ companyId: due.id, emailTo: 'e@cliente.example' });
    // Not SENT: never looked at.
    s.hypothesis({ companyId: due.id, emailStatus: 'READY' });
    s.send(String(hDue.id), String(due.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    s.send(String(hRecent.id), String(recent.id), 'a@reciente.example', '2026-10-14T08:00:00Z');
    s.send(String(hReplied.id), String(replied.id), 'b@contesta.example', '2026-10-09T08:00:00Z');
    s.send(String(hBounced.id), String(bounced.id), 'c@rebota.example', '2026-10-09T09:00:00Z');
    s.send(String(hAuto.id), String(auto.id), 'd@vacaciones.example', '2026-10-09T10:00:00Z');
    s.send(String(hSupp.id), String(supp.id), 'baja@suprimida.example', '2026-10-09T11:00:00Z');
    // Triage rows: a reply linked by the company only (colleague), a bounce, an out-of-office, and
    // an old reply (before the send) that does not count.
    s.store.replyRows.push(
      { tenantId: TENANT, class: 'PREGUNTA', receivedAt: new Date('2026-10-10T08:00:00Z'), createdAt: new Date(), hypothesisId: null, companyId: String(replied.id) },
      { tenantId: TENANT, class: 'REBOTE', receivedAt: new Date('2026-10-09T09:05:00Z'), createdAt: new Date(), hypothesisId: String(hBounced.id), companyId: String(bounced.id) },
      { tenantId: TENANT, class: 'AUTO_REPLY', receivedAt: new Date('2026-10-09T10:05:00Z'), createdAt: new Date(), hypothesisId: String(hAuto.id), companyId: String(auto.id) },
      { tenantId: TENANT, class: 'INTERESADO', receivedAt: new Date('2026-09-01T10:05:00Z'), createdAt: new Date(), hypothesisId: null, companyId: String(due.id) },
    );

    const r = await s.run();
    expect(r.output).toMatchObject({ outcome: 'SUCCESS', sends_email: false, writes_hypotheses: false, after_business_days: 5, today: '2026-10-19' });
    expect(r.output.counters).toMatchObject({ sent_hypotheses: 7, tasks_created: 2, tasks_reused: 0, skipped: 5, skipped_by: { too_recent: 1, replied: 1, bounced: 1, suppressed: 1, no_send_record: 1 } });
    const examined = r.output.examined as Array<Record<string, unknown>>;
    const by = (id: unknown) => examined.find((e) => e.hypothesis_id === id)!;
    expect(by(hDue.id)).toMatchObject({ result: 'created', business_days: 5, due_day: '2026-10-19', sent_at: '2026-10-12T08:15:00.000Z' });
    expect(by(hRecent.id)).toMatchObject({ result: 'skipped', reason: 'too_recent', due_day: '2026-10-21' });
    expect(by(hReplied.id)).toMatchObject({ reason: 'replied', reply_classes: ['PREGUNTA'] });
    expect(by(hBounced.id)).toMatchObject({ reason: 'bounced' });
    expect(by(hAuto.id)).toMatchObject({ result: 'created' }); // an out-of-office is not an answer
    expect(by(hSupp.id)).toMatchObject({ reason: 'suppressed' });
    expect(by(hNoSend.id)).toMatchObject({ reason: 'no_send_record', hypothesis_updated_at: expect.any(String) });
    // Oldest send first.
    expect(examined.map((e) => e.hypothesis_id)[0]).toBe(hReplied.id);

    // The task: title, due today 09:00 Madrid, targets company + hypothesis, fixed script.
    const task = s.fake.tables.tasks.find((t) => t.title === '🔔 Seguimiento — Cliente SA')!;
    expect(task).toMatchObject({ status: 'TODO', dueAt: '2026-10-19T07:00:00.000Z' });
    const md = (task.bodyV2 as { markdown: string }).markdown;
    expect(md).toContain('- Primer envío: 2026-10-12 10:15 (Europe/Madrid)');
    expect(md).toContain('- Asunto: «Material para vuestro stand»');
    expect(md).toContain('- Destinatario: carmen@cliente.example');
    expect(md).toContain('- Necesidad: Bolsas para el stand');
    const targets = s.fake.tables.taskTargets.filter((t) => t.taskId === task.id);
    expect(targets.map((t) => t.targetCompanyId ?? t.targetCommercialHypothesisId).sort()).toEqual([String(due.id), String(hDue.id)].sort());
    // Nothing written on any hypothesis.
    expect(s.fake.count('PATCH', 'commercialHypotheses')).toBe(0);
    // One audit row per task created.
    expect(s.audits.map((a) => [a.action, a.subjectId])).toEqual(
      expect.arrayContaining([
        [FOLLOWUP_AUDIT_ACTION, hDue.id],
        [FOLLOWUP_AUDIT_ACTION, hAuto.id],
      ]),
    );
    expect(s.audits).toHaveLength(2);
    expect(s.audits[0]).toMatchObject({ actor: 'agent', subjectType: 'commercial_hypothesis', result: 'ok', method: 'AGENT', payload: { task_created: true } });

    // Next day: task_exists, nothing new.
    s.setNow('2026-10-20T06:30:00Z');
    const again = await s.run();
    expect(again.output.counters).toMatchObject({ tasks_created: 0, skipped_by: { task_exists: 2 } });
    expect(s.fake.tables.tasks).toHaveLength(2);
  });

  it('never recreates the task once audited, even if the human deleted it in Twenty', async () => {
    const s = setup();
    const c = s.company('Cliente SA');
    const h = s.hypothesis({ companyId: c.id, emailTo: 'carmen@cliente.example' });
    s.send(String(h.id), String(c.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    await s.run();
    expect(s.fake.tables.tasks).toHaveLength(1);
    s.fake.tables.tasks[0]!.deletedAt = new Date().toISOString();
    s.fake.tables.tasks.length = 0; // gone from the REST listing
    const again = await s.run();
    expect(again.output.counters).toMatchObject({ tasks_created: 0, skipped_by: { task_exists: 1 } });
    expect(s.fake.tables.tasks).toHaveLength(0);
  });

  it('a retried run after a lost audit reuses the task (no duplicate) and audits it', async () => {
    const s = setup();
    const c = s.company('Cliente SA');
    const h = s.hypothesis({ companyId: c.id, emailTo: 'carmen@cliente.example' });
    s.send(String(h.id), String(c.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    await s.run();
    s.store.followedUp.length = 0;
    s.audits.length = 0;
    const again = await s.run();
    expect(again.output.counters).toMatchObject({ tasks_created: 0, tasks_reused: 1 });
    expect(s.fake.tables.tasks).toHaveLength(1);
    expect(s.audits).toHaveLength(1);
  });

  it(`creates at most ${FOLLOWUP_MAX_TASKS_PER_RUN} tasks per run, oldest sends first`, async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < FOLLOWUP_MAX_TASKS_PER_RUN + 3; i++) {
      const c = s.company(`Empresa ${i}`);
      const h = s.hypothesis({ companyId: c.id, emailTo: `x${i}@e${i}.example` });
      ids.push(String(h.id));
      // Newest first in insertion order: the oldest send is the last one.
      s.send(String(h.id), String(c.id), `x${i}@e${i}.example`, new Date(Date.parse('2026-10-09T08:00:00Z') - i * 60_000).toISOString());
    }
    const r = await s.run();
    expect(r.output.counters).toMatchObject({ tasks_created: FOLLOWUP_MAX_TASKS_PER_RUN, skipped_by: { cap_reached: 3 } });
    const capped = (r.output.examined as Array<Record<string, unknown>>).filter((e) => e.reason === 'cap_reached').map((e) => e.hypothesis_id);
    expect(capped.sort()).toEqual(ids.slice(0, 3).sort());
    const next = await s.run();
    expect(next.output.counters).toMatchObject({ tasks_created: 3 });
  });

  it('fails closed without the suppression list, and is disabled with FOLLOWUP_AFTER_BUSINESS_DAYS=0', async () => {
    const s = setup({ suppression: null });
    const c = s.company('Cliente SA');
    const h = s.hypothesis({ companyId: c.id, emailTo: 'carmen@cliente.example' });
    s.send(String(h.id), String(c.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    const r = await s.run();
    expect(r.output).toMatchObject({ outcome: 'FAILED', error: { code: 'SUPPRESSION_LIST_UNAVAILABLE' }, counters: { tasks_created: 0, skipped_by: { suppression_list_unavailable: 1 } } });
    expect(s.fake.tables.tasks).toHaveLength(0);

    const off = setup({ env: { FOLLOWUP_AFTER_BUSINESS_DAYS: '0' } });
    const r0 = await off.run();
    expect(r0.output).toMatchObject({ outcome: 'SKIPPED', after_business_days: 0 });
    expect(off.fake.requests).toHaveLength(0);
  });

  it('a domain-level entry of the suppression list also suppresses', async () => {
    const s = setup({ suppression: '@cliente.example — 2026-10-06 — baja de empresa' });
    const c = s.company('Cliente SA');
    const h = s.hypothesis({ companyId: c.id, emailTo: 'carmen@cliente.example' });
    s.send(String(h.id), String(c.id), 'carmen@cliente.example', '2026-10-12T08:15:00Z');
    const r = await s.run();
    expect(r.output.counters).toMatchObject({ tasks_created: 0, skipped_by: { suppressed: 1 } });
  });
});

describe('follow-up seed and wiring', () => {
  it('lead-followup-check: CRON 08:30 Europe/Madrid, stub model, three tools', () => {
    expect(FOLLOWUP_TASK_NAME).toBe('lead-followup-check');
    expect(desiredFollowUpTask()).toMatchObject({ schedule: { type: 'CRON', expression: '30 8 * * *' }, timezone: 'Europe/Madrid', enabled: true, maxConcurrency: 1 });
    const v = desiredFollowUpVersion();
    expect(v).toMatchObject({ modelProvider: 'stub', configuration: { implementation: FOLLOWUP_IMPLEMENTATION } });
    const policy = parseToolPolicy(v.configuration);
    expect(policy.allow).toEqual([...FOLLOWUP_TOOLS]);
    expect(policy.maxRiskLevel).toBe('LOW_WRITE');
    expect(policy.maxCallsPerTool).toMatchObject({ list_sent_hypotheses: 1, get_note: 1, create_crm_task: FOLLOWUP_MAX_TASKS_PER_RUN });
    expect(resolveAgentImplementation({ implementation: FOLLOWUP_IMPLEMENTATION }).kind).toBe(FOLLOWUP_IMPLEMENTATION);
  });
});
