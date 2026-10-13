/**
 * Native Twenty Tasks for actionable alerts (tanda 19): the helper `createCrmTask`
 * (src/integrations/twenty/tasks.ts) and the tool `create_crm_task` (LOW_WRITE).
 * Shape verified read-only against the live Twenty 2.45 OpenAPI: task {title, bodyV2, dueAt,
 * status TODO|IN_PROGRESS|DONE}, taskTarget {taskId, target<Object>Id} with the App objects.
 */
import { describe, expect, it } from 'vitest';
import { MemoryTwenty } from '../../src/integrations/twenty/memory-twenty.js';
import { addCalendarDays, createCrmTask, crmTaskDueAt, crmTaskTitle, dueInDays } from '../../src/integrations/twenty/tasks.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const NOW = new Date('2026-10-12T10:00:00Z'); // 12:00 Madrid (CEST)
const seedId = (fake: FakeTwenty, plural: string, rec: Record<string, unknown>) => fake.seed(plural, rec) as Record<string, unknown> & { id: string };

describe('createCrmTask', () => {
  it('creates a TODO task with markdown body and due date, and one taskTarget per record', async () => {
    const fake = new FakeTwenty();
    const signal = seedId(fake, 'commercialSignals', { name: 'Feria', signalType: 'FAIR', status: 'QUALIFIED', tenantId: 't' });
    const company = seedId(fake, 'companies', { name: 'Acme' });
    const r = await createCrmTask(fake.client(), { title: 'Revisar "feria"', body: '**hazlo**', dueAt: '2026-10-13', targets: { signalId: signal.id, companyId: company.id } }, { now: NOW });
    expect(r).toMatchObject({ created: true, adopted: false, title: 'Revisar feria', dueAt: '2026-10-13T07:00:00.000Z' });
    expect(fake.tables.tasks).toEqual([expect.objectContaining({ id: r.taskId, title: 'Revisar feria', status: 'TODO', dueAt: '2026-10-13T07:00:00.000Z', bodyV2: { markdown: '**hazlo**', blocknote: '[blocknote]' } })]);
    expect(fake.tables.taskTargets.map((t) => [t.taskId, t.targetCompanyId, t.targetCommercialSignalId])).toEqual([
      [r.taskId, company.id, null],
      [r.taskId, null, signal.id],
    ]);
    expect(r.targetIds).toHaveLength(2);
    expect(fake.tables.notes).toHaveLength(0);
  });

  it('is idempotent by title + local day: same day reused (missing targets added), another day a new task', async () => {
    const fake = new FakeTwenty();
    const a = seedId(fake, 'companies', { name: 'A' });
    const first = await createCrmTask(fake.client(), { title: 'Alerta', body: 'x', targets: { companyId: a.id } });
    const again = await createCrmTask(fake.client(), { title: 'Alerta', body: 'otro cuerpo', targets: { companyId: a.id } });
    expect(again).toMatchObject({ created: false, taskId: first.taskId });
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.taskTargets).toHaveLength(1);
    // Never edited: the body is the first one.
    expect((fake.tables.tasks[0]!.bodyV2 as { markdown: string }).markdown).toBe('x');
    // Same title on ANOTHER record: its own task.
    const b = seedId(fake, 'companies', { name: 'B' });
    expect((await createCrmTask(fake.client(), { title: 'Alerta', body: 'x', targets: { companyId: b.id } })).created).toBe(true);
    expect(fake.tables.tasks).toHaveLength(2);
    // A same-title task created on another (Madrid) day is not reused.
    fake.tables.tasks[0]!.createdAt = '2026-10-01T10:00:00.000Z';
    fake.tables.tasks[1]!.createdAt = '2026-10-01T10:00:00.000Z';
    expect((await createCrmTask(fake.client(), { title: 'Alerta', body: 'x', targets: { companyId: a.id } })).created).toBe(true);
    // ... unless scope 'ever' (one per title, e.g. the promotion proposal of a version).
    const ever = await createCrmTask(fake.client(), { title: 'Alerta', body: 'x', targets: { companyId: a.id }, scope: 'ever' });
    expect(ever.created).toBe(false);
  });

  it('without targets: same title today -> reused; an orphan (died between the two POSTs) is adopted', async () => {
    const fake = new FakeTwenty();
    const t1 = await createCrmTask(fake.client(), { title: '⚠️ Revalidación fallida — s v3', body: 'b' });
    expect((await createCrmTask(fake.client(), { title: '⚠️ Revalidación fallida — s v3', body: 'b' })).taskId).toBe(t1.taskId);
    expect(fake.tables.taskTargets).toHaveLength(0);
    // Orphan with the title and no target: adopted and linked.
    const orphan = fake.seed('tasks', { title: 'Huérfana', status: 'TODO', bodyV2: { markdown: 'b', blocknote: null }, dueAt: null });
    const sig = seedId(fake, 'commercialSignals', { name: 'S', signalType: 'FAIR', status: 'NEW' });
    const r = await createCrmTask(fake.client(), { title: 'Huérfana', body: 'b', targets: { signalId: sig.id } });
    expect(r).toMatchObject({ created: false, adopted: true, taskId: orphan.id });
    expect(fake.tables.taskTargets).toEqual([expect.objectContaining({ taskId: orphan.id, targetCommercialSignalId: sig.id })]);
  });

  it('works on the in-memory CRM of the optimizer experiments too', async () => {
    const crm = new MemoryTwenty();
    const r = await createCrmTask(crm.client(), { title: 'X', body: 'y', dueAt: dueInDays(NOW, 3) }, { now: NOW });
    expect(crm.tables.tasks).toEqual([expect.objectContaining({ id: r.taskId, status: 'TODO', dueAt: '2026-10-15T07:00:00.000Z' })]);
  });

  it('due dates: a plain day is 09:00 Madrid (DST aware), ISO passes through, nothing = no due date', () => {
    expect(crmTaskDueAt('2026-10-13')).toBe('2026-10-13T07:00:00.000Z');
    expect(crmTaskDueAt('2026-12-01')).toBe('2026-12-01T08:00:00.000Z');
    expect(crmTaskDueAt('2026-10-13T15:30:00+02:00')).toBe('2026-10-13T13:30:00.000Z');
    expect(crmTaskDueAt(undefined)).toBeNull();
    expect(() => crmTaskDueAt('mañana')).toThrow(/invalid task due date/);
    expect(dueInDays(NOW, 1)).toBe('2026-10-13T07:00:00.000Z');
    // 23:30 Madrid on the 12th is already the 12th locally (21:30Z), not the 13th.
    expect(dueInDays(new Date('2026-10-12T21:30:00Z'), 0)).toBe('2026-10-12T07:00:00.000Z');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(crmTaskTitle('  a\n"b"\\c  ')).toBe('a bc');
    expect(crmTaskTitle('x'.repeat(300))).toHaveLength(255);
  });
});

describe('create_crm_task tool (LOW_WRITE)', () => {
  const call = (fake: FakeTwenty, input: unknown, tenantId = 'publiexpe') =>
    new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } }),
      parseToolPolicy({ tool_policy: { allow: ['create_crm_task'], max_risk_level: 'LOW_WRITE' } }),
      { tenantId, executionId: 'e', agentId: 'a', stage: null },
      new AbortController().signal,
    ).call('create_crm_task', input);

  it('creates the task on a signal of the tenant; idempotent per title and day', async () => {
    const fake = new FakeTwenty();
    const s = fake.seed('commercialSignals', { name: 'F', signalType: 'FAIR', status: 'QUALIFIED', tenantId: 'publiexpe' });
    const input = { title: '⏳ Fuera de ventana (2026-10-12): F', bodyMarkdown: 'cuerpo', dueAt: '2027-01-10', targets: { signalId: s.id } };
    const r1 = await call(fake, input);
    expect(r1.result).toMatchObject({ status: 'ok', output: { created: true, dueAt: '2027-01-10T08:00:00.000Z' } });
    const r2 = await call(fake, input);
    expect(r2.result).toMatchObject({ status: 'ok', output: { created: false } });
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.taskTargets).toHaveLength(1);
    // The signal itself is never modified.
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('refuses a signal of another tenant (nothing written) and a missing one', async () => {
    const fake = new FakeTwenty();
    const other = fake.seed('commercialSignals', { name: 'F', signalType: 'FAIR', status: 'QUALIFIED', tenantId: 'otro' });
    const r = await call(fake, { title: 'x', bodyMarkdown: 'y', targets: { signalId: other.id } });
    expect(r.result).toMatchObject({ status: 'error', code: 'TWENTY_TENANT_MISMATCH' });
    const missing = await call(fake, { title: 'x', bodyMarkdown: 'y', targets: { signalId: '11111111-2222-4333-8444-555555555555' } });
    expect(missing.result).toMatchObject({ status: 'error', code: 'TARGET_NOT_FOUND' });
    expect(fake.tables.tasks).toHaveLength(0);
  });

  it('validates input: bad due date, unknown target key', async () => {
    const fake = new FakeTwenty();
    expect((await call(fake, { title: 'x', bodyMarkdown: 'y', dueAt: 'mañana' })).result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect((await call(fake, { title: 'x', bodyMarkdown: 'y', targets: { researchId: '11111111-2222-4333-8444-555555555555' } })).result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });
});
