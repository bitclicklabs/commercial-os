/**
 * Tanda 23: the meeting slots respect the client's window (categories from the model, dates by
 * code) and the qualification data of a reply (literal quotes only) go to the Opportunity.
 * No database, no LLM.
 */
import { describe, expect, it } from 'vitest';
import { literalQuote, numbersIn, qualificationNoteTitle, validateQualification, type Cualificacion } from '../../src/crm/qualification.js';
import { meetingParagraph } from '../../src/inbound/meeting-paragraph.js';
import { CalendarAvailability, computeSlots, meetingConfigFromEnv, resolveClientWindow, slotSearchLastDay, validYmd} from '../../src/meetings/index.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const TZ = 'Europe/Madrid';
/** Thursday 2026-11-26, 12:00 in Madrid (the day of the end-to-end test). */
const THU = new Date('2026-11-26T11:00:00Z');
const cfg = meetingConfigFromEnv({});
const days = (slots: Array<{ start: string }>) => slots.map((s) => s.start.slice(0, 10));
const hours = (slots: Array<{ start: string }>) => slots.map((s) => s.start.slice(11, 16));

describe('client window: categories -> dates by code', () => {
  it('«la semana que viene» on a Thursday is Monday to Friday of the next week', () => {
    expect(resolveClientWindow({ tipo: 'semana_que_viene' }, THU, TZ).window).toEqual({ notBefore: '2026-11-30', notAfter: '2026-12-04' });
    // On a Sunday: the week that starts tomorrow.
    expect(resolveClientWindow({ tipo: 'semana_que_viene' }, new Date('2026-11-29T10:00:00Z'), TZ).window).toEqual({ notBefore: '2026-11-30', notAfter: '2026-12-04' });
  });
  it('esta semana, mañana, a partir de, antes de, franja', () => {
    expect(resolveClientWindow({ tipo: 'esta_semana' }, THU, TZ).window).toEqual({ notBefore: '2026-11-26', notAfter: '2026-11-27' });
    expect(resolveClientWindow({ tipo: 'manana', franja: 'manana' }, THU, TZ).window).toEqual({ notBefore: '2026-11-27', notAfter: '2026-11-27', partOfDay: 'morning' });
    expect(resolveClientWindow({ tipo: 'a_partir_de', fecha: '2026-12-10' }, THU, TZ).window).toEqual({ notBefore: '2026-12-10' });
    expect(resolveClientWindow({ tipo: 'antes_de', fecha: '2026-12-10' }, THU, TZ).window).toEqual({ notAfter: '2026-12-09' });
    expect(resolveClientWindow({ tipo: 'ninguna', franja: 'tarde' }, THU, TZ).window).toEqual({ partOfDay: 'afternoon' });
    expect(resolveClientWindow({ tipo: 'ninguna' }, THU, TZ).window).toBeNull();
    expect(resolveClientWindow(null, THU, TZ).window).toBeNull();
  });
  it('the only free date of the model is validated: invalid, past or too far -> ignored', () => {
    expect(resolveClientWindow({ tipo: 'a_partir_de', fecha: '2026-02-30' }, THU, TZ)).toEqual({ window: null, tipo: 'a_partir_de', ignored: 'fecha_invalida' });
    expect(resolveClientWindow({ tipo: 'a_partir_de', fecha: '2026-11-10' }, THU, TZ)).toMatchObject({ window: null, ignored: 'fecha_pasada' });
    expect(resolveClientWindow({ tipo: 'antes_de', fecha: '2027-06-01', franja: 'tarde' }, THU, TZ)).toEqual({ window: { partOfDay: 'afternoon' }, tipo: 'antes_de', ignored: 'fecha_lejana' });
    expect(resolveClientWindow({ tipo: 'a_partir_de', fecha: null }, THU, TZ)).toMatchObject({ window: null, ignored: 'sin_fecha' });
    expect(validYmd('2026-12-31')).toBe('2026-12-31');
    expect(validYmd('31/12/2026')).toBeNull();
  });
});

describe('computeSlots with a window', () => {
  it('«la semana que viene» on a Thursday: only Monday-Friday of the next week (never this Friday)', () => {
    const w = resolveClientWindow({ tipo: 'semana_que_viene' }, THU, TZ).window!;
    const normal = computeSlots({ now: THU, count: 3, config: cfg, events: [] });
    expect(days(normal)).toEqual(['2026-11-27', '2026-11-30', '2026-12-01']);
    const slots = computeSlots({ now: THU, count: 5, config: cfg, events: [], window: w });
    expect(days(slots)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']);
  });
  it('«por las tardes»: only afternoon slots', () => {
    const slots = computeSlots({ now: THU, count: 3, config: cfg, events: [], window: { partOfDay: 'afternoon' } });
    expect(hours(slots)).toEqual(['16:00', '16:00', '16:00']);
    expect(hours(computeSlots({ now: THU, count: 2, config: cfg, events: [], window: { partOfDay: 'morning' } }))).toEqual(['10:00', '10:00']);
  });
  it('«a partir del 10»: from the 10th, past the normal 7-day horizon', () => {
    const w = resolveClientWindow({ tipo: 'a_partir_de', fecha: '2026-12-10' }, THU, TZ).window!;
    const slots = computeSlots({ now: THU, count: 3, config: cfg, events: [], window: w });
    expect(days(slots)).toEqual(['2026-12-10', '2026-12-11', '2026-12-14']);
    expect(slotSearchLastDay('2026-11-26', 7, w)).toBe('2026-12-17');
    // Never further than 30 days from today.
    expect(slotSearchLastDay('2026-11-26', 7, { notBefore: '2027-01-20' })).toBe('2026-12-26');
  });
  it('a window with fewer free days than `count` returns what there is', () => {
    const slots = computeSlots({ now: THU, count: 3, config: cfg, events: [], window: { notBefore: '2026-11-30', notAfter: '2026-11-30' } });
    expect(days(slots)).toEqual(['2026-11-30']);
  });
});

describe('CalendarAvailability with a window', () => {
  const calendar = (events: Array<Record<string, unknown>> = []) => {
    const fake = new FakeTwenty();
    const anchor = fake.seed('calendarEvents', { title: 'Comité', startsAt: '2026-11-27T09:00:00.000Z', endsAt: '2026-11-27T10:00:00.000Z', isCanceled: false, isFullDay: false });
    fake.seed('calendarChannelEventAssociations', { calendarChannelId: 'ch1', calendarEventId: anchor.id });
    for (const e of events) {
      const ev = fake.seed('calendarEvents', e);
      fake.seed('calendarChannelEventAssociations', { calendarChannelId: 'ch1', calendarEventId: ev.id });
    }
    return fake;
  };

  it('slots inside the window, not relaxed', async () => {
    const a = new CalendarAvailability(calendar().client(), cfg);
    const p = await a.propose({ now: THU, count: 3, window: { notBefore: '2026-11-30', notAfter: '2026-12-04', partOfDay: 'afternoon' } });
    expect(p.source).toBe('calendar');
    expect(p.windowRelaxed).toBeUndefined();
    expect(p.slots.map((s) => s.start)).toEqual(['2026-11-30T16:00:00+01:00', '2026-12-01T16:00:00+01:00', '2026-12-02T16:00:00+01:00']);
  });

  it('an impossible window (the whole next week at a fair) falls back to the normal horizon and says so', async () => {
    const fair = ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'].map((d) => ({ title: 'Feria', startsAt: `${d}T00:00:00.000Z`, endsAt: `${d}T23:59:00.000Z`, isCanceled: false, isFullDay: true }));
    const a = new CalendarAvailability(calendar(fair).client(), cfg);
    const p = await a.propose({ now: THU, count: 3, window: { notBefore: '2026-11-30', notAfter: '2026-12-04' } });
    expect(p).toMatchObject({ source: 'calendar', windowRelaxed: true });
    expect(days(p.slots)).toEqual(['2026-11-27']);
    // The paragraph says it naturally.
    expect(meetingParagraph(p).lines[0]).toBe('En las fechas que comentáis no me queda ningún hueco libre, pero si os encaja, lo vemos en una llamada de 30 minutos en alguno de estos:');
    // Without window: as in tanda 22.
    expect((await a.propose({ now: THU, count: 3 })).windowRelaxed).toBeUndefined();
  });
});

describe('qualification: only data with a literal quote of the client', () => {
  const TEXT = 'Hola, serían unas 500 tazas. Tenemos un presupuesto de “unos 2.500 €”.\nLo necesitamos para el 15 de enero; decide nuestro gerente.';
  const TODAY = '2026-11-26';

  it('literal quotes (whitespace, case and quote marks normalised) and numbers written in them', () => {
    expect(literalQuote('Serían unas 500 TAZAS', TEXT)).not.toBeNull();
    expect(literalQuote('presupuesto de "unos 2.500 €"', TEXT)).not.toBeNull();
    expect(literalQuote('serían unas 600 tazas', TEXT)).toBeNull();
    expect(literalQuote('ab', TEXT)).toBeNull();
    expect(numbersIn('entre 2.000 y 3.000 €')).toEqual([2000, 3000]);
    expect(numbersIn('unos 2,5 mil euros, 1500 uds o 3k')).toEqual([2500, 1500, 3000]);
  });

  it('keeps the justified data, drops the invented ones; a range keeps both ends (lower = amount)', () => {
    const c: Cualificacion = {
      cantidad_aprox: { valor: 500, cita: 'unas 500 tazas' },
      presupuesto_aprox_eur: { valor: 2500, valor_max: null, cita: 'presupuesto de “unos 2.500 €”' },
      fecha_necesaria: { valor: '2027-01-15', cita: 'Lo necesitamos para el 15 de enero' },
      decisor: { valor: 'el gerente', cita: 'decide nuestro gerente' },
      productos_interes: [
        { valor: 'tazas', cita: '500 tazas' },
        { valor: 'bolígrafos', cita: 'y bolígrafos' },
      ],
    };
    const q = validateQualification(c, TEXT, TODAY);
    expect(q).toMatchObject({
      quantity: { value: 500 },
      budget: { min: 2500, max: null },
      neededBy: { date: '2027-01-15' },
      decisionMaker: { value: 'el gerente' },
      products: [{ value: 'tazas' }],
      discarded: ['productos_interes'],
    });
    // The number must be in the quote; the quote must be in the text; dates not in the past.
    const bad = validateQualification(
      {
        cantidad_aprox: { valor: 5000, cita: 'unas 500 tazas' },
        presupuesto_aprox_eur: { valor: 2000, valor_max: 3000, cita: 'entre 2.000 y 3.000 €' },
        fecha_necesaria: { valor: '2026-01-15', cita: 'Lo necesitamos para el 15 de enero' },
        decisor: null,
        productos_interes: [],
      },
      TEXT,
      TODAY,
    );
    expect(bad).toMatchObject({ quantity: null, budget: null, neededBy: null, discarded: ['cantidad_aprox', 'presupuesto_aprox_eur', 'fecha_necesaria'] });
    const range = validateQualification(
      { cantidad_aprox: null, presupuesto_aprox_eur: { valor: 3000, valor_max: 2000, cita: 'entre 2.000 y 3.000 €' }, fecha_necesaria: null, decisor: null, productos_interes: [] },
      'Nos movemos entre 2.000 y 3.000 € más o menos.',
      TODAY,
    );
    expect(range.budget).toMatchObject({ min: 2000, max: 3000 });
  });

  it('note title: text first, emoji last', () => {
    expect(qualificationNoteTitle('Adpan "Europa" S.L.')).toBe('Cualificación — Adpan Europa S.L. 🧾');
  });
});

describe('record_opportunity_qualification tool', () => {
  const call = (fake: FakeTwenty, input: unknown) =>
    new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } }),
      parseToolPolicy({ tool_policy: { allow: ['record_opportunity_qualification'], max_risk_level: 'LOW_WRITE' } }),
      { tenantId: 'publiexpe', executionId: 'e', agentId: 'a', stage: null },
      new AbortController().signal,
    ).call('record_opportunity_qualification', input);
  const data = {
    quantity: { value: 500, quote: 'unas 500 tazas' },
    budget: { min: 2000, max: 3000, quote: 'entre 2.000 y 3.000 €' },
    neededBy: { date: '2027-01-15', quote: 'para el 15 de enero' },
    decisionMaker: null,
    products: [],
  };
  const out = (r: Awaited<ReturnType<typeof call>>) => (r.result as { status: string; output: Record<string, unknown> }).output;

  it('creates the note, fills the empty fields; a retry of the same reply changes nothing', async () => {
    const fake = new FakeTwenty();
    const company = fake.seed('companies', { name: 'Acme' });
    const opp = fake.seed('opportunities', { name: 'Acme', stage: 'NEW', companyId: company.id, pointOfContactId: null, amount: null, closeDate: null });
    const input = { opportunityId: opp.id, companyId: company.id, companyName: 'Acme', receivedLocal: '2026-11-26 10:00', data };
    const first = await call(fake, input);
    expect(out(first)).toMatchObject({ found: true, noteCreated: true, sectionAppended: true, amount: 'set', closeDate: 'set' });
    expect(fake.tables.opportunities![0]).toMatchObject({ amount: { amountMicros: 2_000_000_000, currencyCode: 'EUR' }, closeDate: '2027-01-15T12:00:00.000Z' });
    const again = await call(fake, input);
    expect(out(again)).toMatchObject({ noteCreated: false, sectionAppended: false, amount: 'kept', closeDate: 'kept' });
    expect(fake.tables.notes).toHaveLength(1);
    expect((fake.tables.notes![0]!.bodyV2 as { markdown: string }).markdown.match(/### Respuesta del/g)).toHaveLength(1);
  });

  it('never overwrites a value put by a person; unknown opportunity -> found false, nothing written', async () => {
    const fake = new FakeTwenty();
    const opp = fake.seed('opportunities', { name: 'Acme', stage: 'NEW', companyId: null, pointOfContactId: null, amount: { amountMicros: 1_000_000, currencyCode: 'EUR' }, closeDate: '2027-03-01T00:00:00.000Z' });
    const r = await call(fake, { opportunityId: opp.id, companyName: 'Acme', receivedLocal: '2026-11-26 10:00', data });
    expect(out(r)).toMatchObject({ amount: 'kept', closeDate: 'kept' });
    expect(fake.tables.opportunities![0]).toMatchObject({ amount: { amountMicros: 1_000_000 }, closeDate: '2027-03-01T00:00:00.000Z' });
    expect(fake.count('PATCH', 'opportunities')).toBe(0);
    const none = await call(fake, { opportunityId: '33333333-3333-4333-8333-333333333333', companyName: 'X', receivedLocal: '2026-11-26 10:00', data });
    expect(out(none)).toMatchObject({ found: false, noteId: null });
  });
});
