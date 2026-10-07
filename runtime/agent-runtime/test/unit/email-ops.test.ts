/**
 * Email-ops (src/email-ops/): READY guard (suppression list, empty/invalid recipient),
 * warm-up calendar with a fake clock, and the Twenty side over FakeTwenty. No DB, no Redis,
 * nothing is ever sent.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkRecipients, parseRecipients, recipientDomains, suppressionMatch } from '../../src/email-ops/recipients.js';
import { BLOCK_NOTE_TITLES, emailTransitionOf, localDateTime, processEmailStatusChange } from '../../src/email-ops/service.js';
import { loadSuppressionList, upsertAlertNote } from '../../src/email-ops/twenty-io.js';
import { daysBetween, exceedsTarget, ionosHourlyLimit, WARMUP_PHASES, warmupDay, weekdayOf } from '../../src/email-ops/warmup.js';
import type { EventPublisher, PublishEventInput } from '../../src/events/event-bus.js';
import { EMAIL_EVENT_TYPES, EventEnvelopeSchema, schemaVersionFor } from '../../src/events/envelope.js';
import { RESERVED_EVENT_NAMESPACES } from '../../src/events/external.js';
import type { TwentyWebhookPayload } from '../../src/evaluations/human-feedback.js';
import { parseSuppressionList, SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE } from '../../src/inbound/suppression-list.js';
import { createDefaultToolRegistry, parseToolPolicy, revertHypothesisDraftStatus, ToolExecutor, type ToolResult } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const LIST_MD = [
  '- compras@empresa-uno.example — 2026-10-14 — respuesta: no nos interesa',
  '- @empresa-dos.example — 2026-10-15 — baja de toda la empresa',
  '- @ventas.grupo.example — 2026-10-15 — solo el área de ventas',
  '- Info\\@Mayus.example — 2026-10-16 — escapado por Twenty',
].join('\n');
const LIST = parseSuppressionList(LIST_MD);

/** Captures events and mimics the bus idempotency (same key -> same event). */
class CapturingPublisher implements EventPublisher {
  readonly published: PublishEventInput[] = [];
  private readonly keys = new Map<string, string>();
  async publish(input: PublishEventInput) {
    const key = input.idempotencyKey ?? randomUUID();
    const created = !this.keys.has(key);
    if (created) {
      this.keys.set(key, randomUUID());
      this.published.push(input);
    }
    return {
      event: { id: this.keys.get(key)!, type: input.type, schemaVersion: `${input.type}.v1`, tenantId: input.tenantId, occurredAt: new Date().toISOString(), producer: 'agent-runtime' as const, correlationId: input.correlationId, data: input.data },
      created,
      dispatched: true,
    };
  }
  async emit(input: PublishEventInput) {
    return this.publish(input);
  }
}

// ---------------------------------------------------------------------------
// Suppression matching
// ---------------------------------------------------------------------------
describe('suppression matching (exact address and @domain with subdomains)', () => {
  it('blocks an exact address, case-insensitively, and through Name <addr> and mailto:', () => {
    expect(suppressionMatch('compras@empresa-uno.example', LIST)).toEqual({ email: 'compras@empresa-uno.example', by: 'email', entry: 'compras@empresa-uno.example' });
    const c = checkRecipients('Compras <COMPRAS@Empresa-Uno.example>', LIST);
    expect(c).toMatchObject({ ok: false, reason: 'suppressed', matches: [{ by: 'email' }] });
    expect(checkRecipients('mailto:info@mayus.example', LIST)).toMatchObject({ ok: false, reason: 'suppressed' });
  });

  it('does not block another address of the same company when only the address is listed', () => {
    expect(suppressionMatch('ventas@empresa-uno.example', LIST)).toBeNull();
    expect(checkRecipients('ventas@empresa-uno.example', LIST)).toEqual({ ok: true, recipients: ['ventas@empresa-uno.example'] });
  });

  it('@domain covers the domain and every subdomain, never a parent or a look-alike', () => {
    expect(suppressionMatch('ana@empresa-dos.example', LIST)).toMatchObject({ by: 'domain', entry: '@empresa-dos.example' });
    expect(suppressionMatch('ana@madrid.empresa-dos.example', LIST)).toMatchObject({ by: 'domain', entry: '@empresa-dos.example' });
    expect(suppressionMatch('ana@a.b.empresa-dos.example', LIST)).toMatchObject({ by: 'domain', entry: '@empresa-dos.example' });
    // @ventas.grupo.example: its subdomains yes, the parent grupo.example no.
    expect(suppressionMatch('x@eu.ventas.grupo.example', LIST)).toMatchObject({ by: 'domain', entry: '@ventas.grupo.example' });
    expect(suppressionMatch('x@grupo.example', LIST)).toBeNull();
    // Suffix without a dot boundary is another domain.
    expect(suppressionMatch('x@otraempresa-dos.example', LIST)).toBeNull();
  });

  it('any suppressed recipient blocks the whole send', () => {
    const c = checkRecipients('ok@libre.example, ana@empresa-dos.example', LIST);
    expect(c).toMatchObject({ ok: false, reason: 'suppressed', recipients: ['ok@libre.example', 'ana@empresa-dos.example'] });
    if (!c.ok) expect(c.matches.map((m) => m.email)).toEqual(['ana@empresa-dos.example']);
  });

  it('empty recipient -> missing_recipient; garbage -> invalid_recipient; unreadable list -> fail closed', () => {
    for (const empty of ['', '   ', ' , ; ', null, undefined, 42]) expect(checkRecipients(empty, LIST)).toMatchObject({ ok: false, reason: 'missing_recipient' });
    expect(checkRecipients('no-es-un-email', LIST)).toMatchObject({ ok: false, reason: 'invalid_recipient', invalid: ['no-es-un-email'] });
    expect(checkRecipients('ok@libre.example; mal@', LIST)).toMatchObject({ ok: false, reason: 'invalid_recipient' });
    expect(checkRecipients('ok@libre.example', null)).toMatchObject({ ok: false, reason: 'suppression_list_unavailable' });
  });

  it('parseRecipients normalises, dedupes and splits on commas, semicolons and new lines', () => {
    expect(parseRecipients(' A@x.example ,a@x.example;\nB <b@y.example>')).toEqual({ valid: ['a@x.example', 'b@y.example'], invalid: [] });
    expect(recipientDomains(['a@x.example', 'c@x.example', 'b@y.example'])).toEqual(['x.example', 'y.example']);
  });
});

// ---------------------------------------------------------------------------
// Warm-up calendar (fake clock)
// ---------------------------------------------------------------------------
describe('warm-up calendar', () => {
  const at = (iso: string) => warmupDay(new Date(iso));

  it('maps every date of the 4 weeks to its phase, using the Europe/Madrid day', () => {
    expect(at('2026-10-06T08:00:00Z')).toMatchObject({ date: '2026-10-06', stage: 'warmup', phase: { id: 'week1' }, target: 10, targetPerMailbox: 5, mailboxAgeDays: 1 });
    // 22:30Z on the 6th is already the 7th in Madrid (UTC+2).
    expect(at('2026-10-06T22:30:00Z')).toMatchObject({ date: '2026-10-07', target: 10, mailboxAgeDays: 2 });
    expect(at('2026-10-08T10:00:00Z')).toMatchObject({ phase: { id: 'week1' }, target: 13 });
    expect(at('2026-10-12T10:00:00Z')).toMatchObject({ phase: { id: 'week1' }, target: 20 });
    expect(at('2026-10-14T10:00:00Z')).toMatchObject({ phase: { id: 'week2', min: 15, max: 20 }, target: 20 });
    expect(at('2026-10-20T10:00:00Z')).toMatchObject({ phase: { id: 'week3' }, target: 30, targetPerMailbox: 15 });
    expect(at('2026-10-26T10:00:00Z')).toMatchObject({ phase: { id: 'week3' }, target: 60 });
    expect(at('2026-10-28T10:00:00Z')).toMatchObject({ phase: { id: 'week4', min: 60, max: 80 }, target: 80, targetPerMailbox: 40 });
    expect(at('2026-11-02T21:59:00Z')).toMatchObject({ date: '2026-11-02', stage: 'warmup', phase: { id: 'week4' } });
  });

  it('weekends are rest days with target 0', () => {
    expect(weekdayOf('2026-10-10')).toBe(6);
    expect(at('2026-10-10T10:00:00Z')).toMatchObject({ restDay: true, target: 0, phase: { id: 'week1' } });
    expect(at('2026-10-25T10:00:00Z')).toMatchObject({ restDay: true, target: 0, phase: { id: 'week3' } });
  });

  it('before the start and after 2026-11-02 there is no soft cap', () => {
    expect(at('2026-10-05T10:00:00Z')).toMatchObject({ stage: 'before', target: null, phase: null });
    // 2026-11-02T23:30Z is already the 3rd in Madrid (UTC+1 after the DST change).
    expect(at('2026-11-02T23:30:00Z')).toMatchObject({ date: '2026-11-03', stage: 'post_warmup', target: null, phase: null });
    expect(exceedsTarget(at('2026-12-01T10:00:00Z'), 500)).toBe(false);
  });

  it('phases are contiguous and no working-day step of a ramp rises more than the plan allows', () => {
    for (let i = 1; i < WARMUP_PHASES.length; i++) expect(daysBetween(WARMUP_PHASES[i - 1]!.to, WARMUP_PHASES[i]!.from)).toBe(1);
    for (const p of WARMUP_PHASES) {
      const values = Object.values(p.daily ?? {});
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(p.min);
        expect(v).toBeLessThanOrEqual(p.max);
      }
      for (let i = 1; i < values.length; i++) expect(values[i]! / values[i - 1]!).toBeLessThanOrEqual(1.3);
    }
  });

  it('exceeded only strictly above the target', () => {
    const day = at('2026-10-07T10:00:00Z');
    expect(exceedsTarget(day, 10)).toBe(false);
    expect(exceedsTarget(day, 11)).toBe(true);
  });

  it('IONOS hourly limit: 50 the first week (and by caution until day 30), then 500', () => {
    expect(ionosHourlyLimit(1)).toMatchObject({ perHour: 50 });
    expect(ionosHourlyLimit(7)).toMatchObject({ perHour: 50, basis: 'primeros 7 días del buzón' });
    expect(ionosHourlyLimit(8).perHour).toBe(50);
    expect(ionosHourlyLimit(31).perHour).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Webhook payload -> transition
// ---------------------------------------------------------------------------
function payload(record: Record<string, unknown>, updatedFields = ['emailStatus'], eventName = 'commercialHypothesis.updated'): TwentyWebhookPayload {
  return {
    eventName,
    objectMetadata: { nameSingular: 'commercialHypothesis' },
    webhookId: 'wh-1',
    eventDate: '2026-10-07T10:00:00.000Z',
    record: { tenantId: 'publiexpe', updatedAt: '2026-10-07T10:00:00.000Z', ...record },
    updatedFields,
  };
}

describe('emailTransitionOf', () => {
  it('only emailStatus changes to READY or SENT of a hypothesis', () => {
    expect(emailTransitionOf(payload({ emailStatus: 'READY' }))).toBe('READY');
    expect(emailTransitionOf(payload({ emailStatus: 'SENT' }, ['emailStatus', 'updatedAt']))).toBe('SENT');
    expect(emailTransitionOf(payload({ emailStatus: 'READY' }, ['emailBody']))).toBeNull();
    expect(emailTransitionOf(payload({ emailStatus: 'SENDING' }))).toBeNull();
    expect(emailTransitionOf(payload({ emailStatus: 'DRAFT' }))).toBeNull();
    expect(emailTransitionOf(payload({ emailStatus: 'READY' }, ['emailStatus'], 'commercialHypothesis.created'))).toBeNull();
    expect(emailTransitionOf({ ...payload({ emailStatus: 'READY' }), objectMetadata: { nameSingular: 'note' }, eventName: 'note.updated' })).toBeNull();
  });

  it('email.* is a reserved namespace for external events', () => {
    expect(RESERVED_EVENT_NAMESPACES).toContain('email.');
  });

  it('every email.* type (with underscores) is a valid envelope', () => {
    for (const type of EMAIL_EVENT_TYPES) {
      const envelope = { id: randomUUID(), type, schemaVersion: schemaVersionFor(type), tenantId: 't', occurredAt: new Date().toISOString(), producer: 'agent-runtime', correlationId: 'c', data: {} };
      expect(EventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Twenty side (FakeTwenty)
// ---------------------------------------------------------------------------
function world(emailTo: string, emailStatus = 'READY') {
  const fake = new FakeTwenty();
  fake.seed('notes', { id: SUPPRESSION_NOTE_ID, title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: LIST_MD, blocknote: '[blocknote]' } });
  const company = fake.seed('companies', { name: 'Empresa Dos', domainName: { primaryLinkUrl: 'empresa-dos.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const hyp = fake.seed('commercialHypotheses', {
    name: 'Empresa Dos — Feria 2026',
    status: 'VALIDATED',
    companyId: company.id,
    tenantId: 'publiexpe',
    emailTo,
    emailSubject: 'Material para vuestro stand',
    emailBody: 'Hola:\n\nTexto.',
    emailStatus,
  });
  return { fake, company, hyp };
}

describe('revert_hypothesis_draft_status (LOW_WRITE, surgical)', () => {
  it('PATCHes ONLY emailStatus = DRAFT, and only while the draft is READY', async () => {
    const { fake, hyp } = world('ana@empresa-dos.example');
    const out = await revertHypothesisDraftStatus(fake.client(), hyp.id as string);
    expect(out).toEqual({ reverted: true, reason: 'reverted', previousStatus: 'READY' });
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toEqual([{ method: 'PATCH', path: `/rest/commercialHypotheses/${String(hyp.id)}`, body: { emailStatus: 'DRAFT' } }]);
    expect(hyp).toMatchObject({ emailStatus: 'DRAFT', emailTo: 'ana@empresa-dos.example', emailSubject: 'Material para vuestro stand', emailBody: 'Hola:\n\nTexto.' });
  });

  it('never touches a draft that is already SENDING or SENT (the workflow won)', async () => {
    for (const status of ['SENDING', 'SENT', 'DRAFT']) {
      const { fake, hyp } = world('ana@empresa-dos.example', status);
      expect(await revertHypothesisDraftStatus(fake.client(), hyp.id as string)).toEqual({ reverted: false, reason: 'status_changed', previousStatus: status });
      expect(fake.count('PATCH', 'commercialHypotheses')).toBe(0);
    }
    expect((await revertHypothesisDraftStatus(new FakeTwenty().client(), randomUUID())).reason).toBe('not_found');
  });

  it('is registered as a tool (LOW_WRITE) usable through the executor', async () => {
    const { fake, hyp } = world('ana@empresa-dos.example');
    const ex = new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client() }),
      parseToolPolicy({ tool_policy: { allow: ['revert_hypothesis_draft_status'], max_risk_level: 'LOW_WRITE' } }),
      { tenantId: 'publiexpe', executionId: 'exec-1', agentId: 'agent-1', stage: null },
      new AbortController().signal,
    );
    const res = (await ex.call('revert_hypothesis_draft_status', { hypothesisId: hyp.id })).result as ToolResult<{ reverted: boolean }>;
    expect(res).toMatchObject({ status: 'ok', output: { reverted: true } });
  });
});

describe('loadSuppressionList / upsertAlertNote', () => {
  it('reads the list by id; fails closed (null) when the note is gone or renamed', async () => {
    const { fake } = world('x@y.example');
    const loaded = await loadSuppressionList(fake.client());
    expect(loaded?.noteIds).toEqual([SUPPRESSION_NOTE_ID]);
    expect([...loaded!.list.domains].sort()).toEqual(['empresa-dos.example', 'ventas.grupo.example']);
    fake.tables.notes[0]!.title = 'Otra nota';
    expect(await loadSuppressionList(fake.client())).toBeNull();
  });

  it('a copy of the note with the exact title also counts', async () => {
    const fake = new FakeTwenty();
    fake.seed('notes', { title: SUPPRESSION_NOTE_TITLE, bodyV2: { markdown: '@copia.example — 2026-10-16 — x' } });
    expect([...(await loadSuppressionList(fake.client()))!.list.domains]).toEqual(['copia.example']);
  });

  it('one note per hypothesis and title; later occurrences only append their history line, once', async () => {
    const { fake, company, hyp } = world('x@y.example');
    const input = { hypothesisId: hyp.id as string, companyId: company.id as string, title: 'T ⛔', bodyMarkdown: 'Cuerpo\n\nHistorial:\n\n- l1\n', historyLine: '- l1' };
    const first = await upsertAlertNote(fake.client(), input);
    expect(first).toMatchObject({ created: true });
    const targets = fake.tables.noteTargets.filter((t) => t.noteId === first.noteId);
    expect(targets.map((t) => t.targetCommercialHypothesisId ?? t.targetCompanyId).sort()).toEqual([company.id, hyp.id].sort());
    expect(await upsertAlertNote(fake.client(), input)).toEqual({ noteId: first.noteId, created: false, appended: false });
    expect(await upsertAlertNote(fake.client(), { ...input, historyLine: '- l2' })).toEqual({ noteId: first.noteId, created: false, appended: true });
    const note = fake.tables.notes.find((n) => n.id === first.noteId)!;
    expect((note.bodyV2 as { markdown: string }).markdown).toBe('Cuerpo\n\nHistorial:\n\n- l1\n- l2\n');
    // Another hypothesis of the same company gets its own note.
    const other = fake.seed('commercialHypotheses', { name: 'Otra', status: 'VALIDATED', companyId: company.id });
    expect((await upsertAlertNote(fake.client(), { ...input, hypothesisId: other.id as string })).created).toBe(true);
    expect(fake.count('DELETE', 'notes')).toBe(0);
  });
});

describe('processEmailStatusChange: READY guard (FakeTwenty, no DB)', () => {
  const noDb = undefined as never;

  it('suppressed by @domain (subdomain): back to DRAFT, ⛔ note on the hypothesis, email.blocked_suppressed without the address', async () => {
    const { fake, company, hyp } = world('Ana <ana@madrid.empresa-dos.example>');
    const events = new CapturingPublisher();
    const out = await processEmailStatusChange(noDb, payload({ id: hyp.id, companyId: company.id, emailStatus: 'READY', emailTo: 'stale@ok.example' }), {
      defaultTenantId: 'publiexpe',
      twenty: fake.client(),
      events,
    });
    expect(out).toMatchObject({ check: 'ready', status: 'blocked', reason: 'suppressed', reverted: true, revertResult: 'reverted', toDomains: ['madrid.empresa-dos.example'] });
    expect(hyp.emailStatus).toBe('DRAFT');
    const note = fake.tables.notes.find((n) => n.title === BLOCK_NOTE_TITLES.suppressed)!;
    expect(note).toBeDefined();
    expect(BLOCK_NOTE_TITLES.suppressed).toBe('⛔ Dirección en la lista de supresión — no enviar');
    const md = (note.bodyV2 as { markdown: string }).markdown;
    expect(md).toContain('**No envíes este correo.**');
    expect(md).toContain('`@empresa-dos.example`');
    expect(md).toContain(`- ${localDateTime(new Date('2026-10-07T10:00:00.000Z'), 'Europe/Madrid')} — Email status devuelto a Draft (dirección en la lista de supresión)`);
    expect(fake.tables.noteTargets.some((t) => t.noteId === note.id && t.targetCommercialHypothesisId === hyp.id)).toBe(true);
    expect(events.published).toHaveLength(1);
    const ev = events.published[0]!;
    expect(ev).toMatchObject({
      type: 'email.blocked_suppressed',
      tenantId: 'publiexpe',
      correlationId: hyp.id,
      data: { hypothesisId: hyp.id, companyId: company.id, reason: 'suppressed', matchedBy: ['domain'], matchedDomains: ['@empresa-dos.example'], reverted: true, noteId: note.id },
    });
    expect(JSON.stringify(ev.data)).not.toMatch(/ana@/);
  });

  it('uses the FRESH emailTo from Twenty, not the (stale) webhook copy', async () => {
    const { fake, hyp } = world('libre@ok.example');
    const out = await processEmailStatusChange(noDb, payload({ id: hyp.id, emailStatus: 'READY', emailTo: 'compras@empresa-uno.example' }), { defaultTenantId: 'publiexpe', twenty: fake.client() });
    expect(out).toMatchObject({ check: 'ready', status: 'passed', recipients: 1 });
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(0);
    expect(fake.count('POST', 'notes')).toBe(0);
  });

  it('empty emailTo: same treatment with reason missing_recipient (the list is not even read)', async () => {
    const { fake, hyp } = world('  ');
    const events = new CapturingPublisher();
    const out = await processEmailStatusChange(noDb, payload({ id: hyp.id, emailStatus: 'READY' }), { defaultTenantId: 'publiexpe', twenty: fake.client(), events });
    expect(out).toMatchObject({ status: 'blocked', reason: 'missing_recipient', reverted: true });
    expect(hyp.emailStatus).toBe('DRAFT');
    expect(fake.tables.notes.some((n) => n.title === '⛔ Falta destinatario — no enviar')).toBe(true);
    expect(events.published[0]).toMatchObject({ type: 'email.blocked_suppressed', data: { reason: 'missing_recipient', toDomains: [] } });
    expect(fake.requests.some((r) => r.method === 'GET' && r.path === `/rest/notes/${SUPPRESSION_NOTE_ID}`)).toBe(false);
  });

  it('suppression note missing: fails closed (blocked, suppression_list_unavailable)', async () => {
    const { fake, hyp } = world('libre@ok.example');
    fake.tables.notes[0]!.title = 'Renombrada';
    const out = await processEmailStatusChange(noDb, payload({ id: hyp.id, emailStatus: 'READY' }), { defaultTenantId: 'publiexpe', twenty: fake.client() });
    expect(out).toMatchObject({ status: 'blocked', reason: 'suppression_list_unavailable', reverted: true });
  });

  it('race lost: the draft is already SENDING when the webhook arrives -> nothing written', async () => {
    const { fake, hyp } = world('ana@empresa-dos.example', 'SENDING');
    const out = await processEmailStatusChange(noDb, payload({ id: hyp.id, emailStatus: 'READY' }), { defaultTenantId: 'publiexpe', twenty: fake.client() });
    expect(out).toEqual({ check: 'ready', status: 'skipped', reason: 'email_status_now_sending' });
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(0);
    expect(fake.count('POST', 'notes')).toBe(0);
  });

  it('redelivered webhook after a second READY with the same change: one note, one event', async () => {
    const { fake, hyp } = world('ana@empresa-dos.example');
    const events = new CapturingPublisher();
    const p = payload({ id: hyp.id, emailStatus: 'READY' });
    const opts = { defaultTenantId: 'publiexpe', twenty: fake.client(), events };
    await processEmailStatusChange(noDb, p, opts);
    hyp.emailStatus = 'READY';
    const again = await processEmailStatusChange(noDb, p, opts);
    expect(again).toMatchObject({ status: 'blocked', reverted: true });
    expect(fake.tables.notes.filter((n) => n.title === BLOCK_NOTE_TITLES.suppressed)).toHaveLength(1);
    expect(events.published).toHaveLength(1);
  });

  it('without a Twenty client the READY check is skipped (and says so)', async () => {
    const out = await processEmailStatusChange(noDb, payload({ id: randomUUID(), emailStatus: 'READY' }), { defaultTenantId: 'publiexpe' });
    expect(out).toEqual({ check: 'ready', status: 'skipped', reason: 'twenty_not_configured' });
    expect(await processEmailStatusChange(noDb, payload({ id: randomUUID(), emailStatus: 'READY' }, ['emailBody']), { defaultTenantId: 'publiexpe' })).toBeNull();
  });
});
