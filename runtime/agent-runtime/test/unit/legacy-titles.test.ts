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
