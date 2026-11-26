/**
 * Tanda 23: titles now put the emoji at the END (Twenty draws the record icon with the first
 * character of the title, and an emoji first shows as a broken «?»). The records created before
 * the change still have the emoji first: `legacyTitles` lets the idempotent lookups of
 * createCrmTask / create_crm_task / create_note find them, and `legacyEmojiFirstTitle` derives
 * the old spelling from the new one.
 */
import { describe, expect, it } from 'vitest';
import { createCrmTask, legacyEmojiFirstTitle } from '../../src/integrations/twenty/tasks.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { legacyMeetingTaskTitle, legacyReplyTaskTitle, meetingTaskTitle, replyTaskTitle, upsertReplyTask } from '../../src/crm/reply-task.js';
import { bounceNoteTitle, legacyBounceNoteTitle, legacyReplyNoteTitle, replyNoteTitle } from '../../src/inbound/triage-notes.js';
import {
  legacyMeetingNoteTitle,
  legacyMeetingTaskTitle as legacyPrepTaskTitle,
  meetingNoteTitle,
  meetingTaskTitle as prepTaskTitle,
} from '../../src/meetings/meeting-sync.js';

const seedId = (fake: FakeTwenty, plural: string, rec: Record<string, unknown>) => fake.seed(plural, rec) as Record<string, unknown> & { id: string };

describe('legacyEmojiFirstTitle', () => {
  it('moves the trailing emoji to the front, keeping variation selectors', () => {
    expect(legacyEmojiFirstTitle('Responder a Adpan Europa S.L. 📬')).toBe('📬 Responder a Adpan Europa S.L.');
    expect(legacyEmojiFirstTitle('Rebote: el email no existe (2026-11-26 10:00) ⚠️')).toBe('⚠️ Rebote: el email no existe (2026-11-26 10:00)');
    expect(legacyEmojiFirstTitle('Respuesta recibida — Interesado (2026-11-26 10:00) 📬')).toBe('📬 Respuesta recibida — Interesado (2026-11-26 10:00)');
  });
  it('null without a trailing emoji', () => {
    expect(legacyEmojiFirstTitle('Responder a Adpan')).toBeNull();
    expect(legacyEmojiFirstTitle('📬 Responder a Adpan')).toBeNull();
    expect(legacyEmojiFirstTitle('📬')).toBeNull();
  });
});

describe('createCrmTask with legacyTitles', () => {
  it('reuses the same-day task with the old title on the same anchor, and keeps its title', async () => {
    const fake = new FakeTwenty();
    const opp = seedId(fake, 'opportunities', { name: 'O' });
    const old = seedId(fake, 'tasks', { title: '🧾 Preparar reunión con Acme', status: 'TODO', bodyV2: { markdown: 'b', blocknote: null }, dueAt: null });
    fake.seed('taskTargets', { taskId: old.id, targetOpportunityId: opp.id });
    const r = await createCrmTask(fake.client(), {
      title: 'Preparar reunión con Acme 🧾',
      body: 'nuevo',
      targets: { opportunityId: opp.id },
      legacyTitles: [legacyEmojiFirstTitle('Preparar reunión con Acme 🧾')!],
    });
    expect(r).toMatchObject({ created: false, taskId: old.id });
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.tasks[0]!.title).toBe('🧾 Preparar reunión con Acme');
  });

  it('without legacyTitles the old task is not seen (a new one is created)', async () => {
    const fake = new FakeTwenty();
    seedId(fake, 'tasks', { title: '🧾 Preparar reunión con Acme', status: 'TODO', bodyV2: { markdown: 'b', blocknote: null }, dueAt: null });
    const r = await createCrmTask(fake.client(), { title: 'Preparar reunión con Acme 🧾', body: 'x' });
    expect(r.created).toBe(true);
  });

  it('prefers the task with the current title when both exist', async () => {
    const fake = new FakeTwenty();
    const now = await createCrmTask(fake.client(), { title: 'Alerta 🔔', body: 'x' });
    seedId(fake, 'tasks', { title: '🔔 Alerta', status: 'TODO', bodyV2: { markdown: 'b', blocknote: null }, dueAt: null });
    const r = await createCrmTask(fake.client(), { title: 'Alerta 🔔', body: 'x', legacyTitles: ['🔔 Alerta'] });
    expect(r.taskId).toBe(now.taskId);
  });
});

describe('tools with legacyTitles', () => {
  const executor = (fake: FakeTwenty, allow: string[]) =>
    new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } }),
      parseToolPolicy({ tool_policy: { allow, max_risk_level: 'LOW_WRITE' } }),
      { tenantId: 'publiexpe', executionId: 'e', agentId: 'a', stage: null },
      new AbortController().signal,
    );

  it('create_note reuses the note with the old title on the company', async () => {
    const fake = new FakeTwenty();
    const company = seedId(fake, 'companies', { name: 'Acme' });
    const note = seedId(fake, 'notes', { title: '📬 Respuesta recibida — Interesado (2026-11-26 10:00)', bodyV2: { markdown: 'b', blocknote: null } });
    fake.seed('noteTargets', { noteId: note.id, targetCompanyId: company.id });
    const tools = executor(fake, ['create_note']);
    const res = await tools.call('create_note', {
      companyId: company.id,
      title: 'Respuesta recibida — Interesado (2026-11-26 10:00) 📬',
      bodyMarkdown: 'nuevo',
      legacyTitles: ['📬 Respuesta recibida — Interesado (2026-11-26 10:00)'],
    });
    expect(res.result.status).toBe('ok');
    expect((res.result as { output: { created: boolean; record: { id: string } } }).output).toMatchObject({ created: false, record: { id: note.id } });
    expect(fake.tables.notes).toHaveLength(1);
  });

  it('create_crm_task passes legacyTitles through', async () => {
    const fake = new FakeTwenty();
    const company = seedId(fake, 'companies', { name: 'Acme' });
    const old = seedId(fake, 'tasks', { title: '🔔 Alerta', status: 'TODO', bodyV2: { markdown: 'b', blocknote: null }, dueAt: null });
    fake.seed('taskTargets', { taskId: old.id, targetCompanyId: company.id });
    const tools = executor(fake, ['create_crm_task']);
    const res = await tools.call('create_crm_task', { title: 'Alerta 🔔', bodyMarkdown: 'x', targets: { companyId: company.id }, legacyTitles: ['🔔 Alerta'] });
    expect(res.result.status).toBe('ok');
    expect((res.result as { output: { created: boolean; taskId: string } }).output).toMatchObject({ created: false, taskId: old.id });
  });
});

describe('tanda 23 titles of the reply / meeting records (text first, emoji last)', () => {
  const signal = () => new AbortController().signal;
  const tools = (fake: FakeTwenty) =>
    new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } }),
      parseToolPolicy({ tool_policy: { allow: ['create_reply_task'], max_risk_level: 'LOW_WRITE' } }),
      { tenantId: 'publiexpe', executionId: 'e', agentId: 'a', stage: null },
      signal(),
    );

  it('new titles end with the emoji and never start with one', () => {
    const titles = [
      replyTaskTitle('Adpan Europa S.L.'),
      meetingTaskTitle('Adpan Europa S.L.'),
      replyNoteTitle('INTERESADO', '2026-11-26 10:00'),
      bounceNoteTitle('2026-11-26 10:00'),
      meetingNoteTitle(new Date('2026-12-03T09:00:00Z')),
      prepTaskTitle('Adpan Europa S.L.'),
    ];
    expect(titles).toEqual([
      'Responder a Adpan Europa S.L. 📬',
      'Cerrar reunión con Adpan Europa S.L. 📅',
      'Respuesta recibida — Interesado (2026-11-26 10:00) 📬',
      'Rebote: el email no existe (2026-11-26 10:00) ⚠️',
      'Reunión detectada — 2026-12-03 10:00 📅',
      'Preparar reunión con Adpan Europa S.L. 🧾',
    ]);
    for (const t of titles) expect(/^[\p{L}\p{N}]/u.test(t)).toBe(true);
    // The legacy helpers give exactly the pre-tanda 23 spelling.
    expect(legacyReplyTaskTitle('Adpan Europa S.L.')).toBe('📬 Responder a Adpan Europa S.L.');
    expect(legacyMeetingTaskTitle('Adpan Europa S.L.')).toBe('📅 Cerrar reunión con Adpan Europa S.L.');
    expect(legacyReplyNoteTitle('INTERESADO', '2026-11-26 10:00')).toBe('📬 Respuesta recibida — Interesado (2026-11-26 10:00)');
    expect(legacyBounceNoteTitle('2026-11-26 10:00')).toBe('⚠️ Rebote: el email no existe (2026-11-26 10:00)');
    expect(legacyMeetingNoteTitle(new Date('2026-12-03T09:00:00Z'))).toBe('📅 Reunión detectada — 2026-12-03 10:00');
    expect(legacyPrepTaskTitle('Adpan Europa S.L.')).toBe('🧾 Preparar reunión con Adpan Europa S.L.');
    for (const t of titles) expect(legacyEmojiFirstTitle(t)).not.toBeNull();
    expect(legacyEmojiFirstTitle(replyTaskTitle('Adpan Europa S.L.'))).toBe(legacyReplyTaskTitle('Adpan Europa S.L.'));
  });

  it('a long name is cut but the emoji stays at the end (255 max)', () => {
    const t = replyTaskTitle('x'.repeat(400));
    expect(t.length).toBeLessThanOrEqual(255);
    expect(t.endsWith('… 📬')).toBe(true);
    expect(prepTaskTitle('y'.repeat(400)).endsWith('… 🧾')).toBe(true);
  });

  it('create_reply_task reuses the open task with the OLD title («📬 Responder a Adpan Europa S.L.»)', async () => {
    const fake = new FakeTwenty();
    const company = seedId(fake, 'companies', { name: 'Adpan Europa S.L.' });
    const old = seedId(fake, 'tasks', { title: '📬 Responder a Adpan Europa S.L.', status: 'TODO', bodyV2: { markdown: 'cuerpo viejo', blocknote: null }, dueAt: null });
    fake.seed('taskTargets', { taskId: old.id, targetCompanyId: company.id });
    const r = await tools(fake).call('create_reply_task', {
      who: 'Adpan Europa S.L.',
      bodyMarkdown: 'Responder',
      dueAt: '2026-11-30T08:00:00.000Z',
      companyId: company.id,
      appendOnReuse: { marker: '### Borrador X', markdown: '### Borrador X\n\nnuevo' },
    });
    expect(r.result.status).toBe('ok');
    expect((r.result as { output: { created: boolean; appended: boolean; task: { id: string; title: string } } }).output).toMatchObject({ created: false, appended: true, task: { id: old.id, title: '📬 Responder a Adpan Europa S.L.' } });
    expect(fake.tables.tasks).toHaveLength(1);
    // New format: created with the new title, and found again by it.
    const company2 = seedId(fake, 'companies', { name: 'Nueva SA' });
    const a = await tools(fake).call('create_reply_task', { who: 'Nueva SA', kind: 'meeting', bodyMarkdown: 'x', dueAt: '2026-11-30T08:00:00.000Z', companyId: company2.id });
    const b = await tools(fake).call('create_reply_task', { who: 'Nueva SA', kind: 'meeting', bodyMarkdown: 'x', dueAt: '2026-11-30T08:00:00.000Z', companyId: company2.id });
    const out = (x: typeof a) => (x.result as { output: { created: boolean; task: { id: string; title: string } } }).output;
    expect(out(a)).toMatchObject({ created: true, task: { title: 'Cerrar reunión con Nueva SA 📅' } });
    expect(out(b)).toMatchObject({ created: false, task: { id: out(a).task.id } });
  });

  it('upsertReplyTask: the old meeting-task title is reused through legacyTitles; a DONE old one is not', async () => {
    const fake = new FakeTwenty();
    const old = seedId(fake, 'tasks', { title: '📅 Cerrar reunión con Acme', status: 'DONE', bodyV2: null, dueAt: null });
    fake.seed('taskTargets', { taskId: old.id, targetCompanyId: 'c1' });
    const input = { title: meetingTaskTitle('Acme'), legacyTitles: [legacyMeetingTaskTitle('Acme')], bodyMarkdown: 'x', dueAt: '2026-11-30T08:00:00.000Z', companyId: 'c1' };
    expect(await upsertReplyTask(fake.client(), input, signal())).toMatchObject({ created: true, task: { title: 'Cerrar reunión con Acme 📅' } });
    fake.tables.tasks[0]!.status = 'TODO';
    // Two open ones now (old reopened + new): the current title wins.
    const again = await upsertReplyTask(fake.client(), input, signal());
    expect(again.task.title).toBe('Cerrar reunión con Acme 📅');
  });
});
