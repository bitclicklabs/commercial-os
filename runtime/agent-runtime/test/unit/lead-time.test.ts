/**
 * Lead-time window (tanda 18, PM rule NEXT_QUARTER): pure rules, the daily round-robin, the
 * trigger on qualification, the discovery scout, the hypothesis expiry and the HUMAN evaluator.
 * Dates are fixed: today is 2026-10-12 in Europe/Madrid (the day the Gastrónoma drafts were rejected).
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import {
  hypothesisEventName,
  isQualifiedTriggerInput,
  MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN,
  MemorySignalHistory,
  outOfWindowNote,
  partitionByLeadTime,
  planHypothesisExpiry,
} from '../../src/agents/signal-prospecting.js';
import { classifyHypothesisChange, EXPIRY_NOT_A_VERDICT } from '../../src/evaluations/human-feedback.js';
import { mergeLastKnownStatus } from '../../src/evaluations/twenty-webhook.js';
import { RESERVED_EVENT_NAMESPACES } from '../../src/events/external.js';
import { StubProvider, type StubResponse } from '../../src/providers/index.js';
import { desiredProspectorVersion, SCOUT_DEFAULT_INPUT } from '../../src/seed/prospector-seed.js';
import { classifyLeadTime, daysUntil, DEFAULT_LEADTIME_WINDOW, leadTimeWindowFromEnv, madridToday } from '../../src/signals/lead-time.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

/** 08:00 in Madrid on 2026-10-12 (CEST, UTC+2). */
const NOW = new Date('2026-10-12T06:00:00Z');
const TODAY = '2026-10-12';
const W = DEFAULT_LEADTIME_WINDOW;

const addDays = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const NO_LIST = JSON.stringify({ page_kind: 'event_home', event: null, exhibitors: [], exhibitors_page_url: null, notes: 'sin lista publicada' });

function fair(fake: FakeTwenty, name: string, status: string, eventDate: string | null, url: string) {
  return fake.seed('commercialSignals', {
    name,
    signalType: 'FAIR',
    status,
    eventDate,
    sourceUrl: { primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] },
    sourceDomain: new URL(url).hostname.replace(/^www\./, ''),
    companyId: null,
    tenantId: 'publiexpe',
  });
}

function setup(responses: Array<string | StubResponse>, opts: { input?: Record<string, unknown>; web?: FakeWeb; fake?: FakeTwenty; now?: Date } = {}) {
  const fake = opts.fake ?? new FakeTwenty();
  const web = opts.web ?? new FakeWeb();
  const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
  const version = desiredProspectorVersion();
  const tools = new ToolExecutor(
    createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: { endpoint: null } }),
    parseToolPolicy(version.configuration),
    { tenantId: 'publiexpe', executionId: 'exec-lt', agentId: 'agent-1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const ctx: AgentContext = {
    tenantId: 'publiexpe',
    executionId: 'exec-lt',
    agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
    version: { id: 'v9', version: 9, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
    input: opts.input ?? { mode: 'signals' },
    provider,
    signal: new AbortController().signal,
    tools,
  };
  const now = opts.now ?? NOW;
  const agent = new ProspectorAgent(() => now, { history: new MemorySignalHistory(), leadTime: { ...W } });
  return { fake, web, provider, ctx, agent };
}

type Entry = { id: string; name: string; event_date: string | null; days: number | null };
type LeadTimeBlock = {
  window: { min_days: number; max_days: number; today: string; timezone: string };
  in_window: number;
  too_close: Entry[];
  too_far: Entry[];
  no_date: Entry[];
  chosen?: Entry;
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('lead-time window: pure rules', () => {
  it('limits are inclusive: 45 and 210 days are in the window; 44 too close, 211 too far', () => {
    expect(classifyLeadTime(addDays(44), TODAY, W)).toEqual({ status: 'too_close', days: 44 });
    expect(classifyLeadTime(addDays(45), TODAY, W)).toEqual({ status: 'in_window', days: 45 });
    expect(classifyLeadTime(addDays(120), TODAY, W)).toEqual({ status: 'in_window', days: 120 });
    expect(classifyLeadTime(addDays(210), TODAY, W)).toEqual({ status: 'in_window', days: 210 });
    expect(classifyLeadTime(addDays(211), TODAY, W)).toEqual({ status: 'too_far', days: 211 });
    expect(classifyLeadTime(addDays(0), TODAY, W)).toEqual({ status: 'too_close', days: 0 });
    expect(classifyLeadTime(addDays(-1), TODAY, W)).toEqual({ status: 'past', days: -1 });
    expect(classifyLeadTime(null, TODAY, W)).toEqual({ status: 'no_date', days: null });
    expect(classifyLeadTime('no es fecha', TODAY, W)).toEqual({ status: 'no_date', days: null });
    // A DATE_TIME value counts by its date.
    expect(daysUntil('2026-12-01T00:00:00Z', TODAY)).toBe(50);
  });

  it('days are counted from the Madrid calendar day (the day changes at midnight Madrid, not UTC)', () => {
    // 21:59 UTC = 23:59 CEST on the 12th; 22:01 UTC = 00:01 CEST on the 13th.
    expect(madridToday(new Date('2026-10-12T21:59:00Z'))).toBe('2026-10-12');
    expect(madridToday(new Date('2026-10-12T22:01:00Z'))).toBe('2026-10-13');
    // Winter time (CET, UTC+1).
    expect(madridToday(new Date('2026-12-31T22:59:00Z'))).toBe('2026-12-31');
    expect(madridToday(new Date('2026-12-31T23:01:00Z'))).toBe('2027-01-01');
    const fairDate = addDays(45);
    expect(classifyLeadTime(fairDate, madridToday(new Date('2026-10-12T21:59:00Z')), W).status).toBe('in_window');
    expect(classifyLeadTime(fairDate, madridToday(new Date('2026-10-12T22:01:00Z')), W)).toEqual({ status: 'too_close', days: 44 });
  });

  it('LEADTIME_MIN_DAYS / LEADTIME_MAX_DAYS from the environment; invalid values fall back to 45 / 210', () => {
    expect(leadTimeWindowFromEnv({})).toEqual({ minDays: 45, maxDays: 210 });
    expect(leadTimeWindowFromEnv({ LEADTIME_MIN_DAYS: '60', LEADTIME_MAX_DAYS: '180' })).toEqual({ minDays: 60, maxDays: 180 });
    expect(leadTimeWindowFromEnv({ LEADTIME_MIN_DAYS: 'x', LEADTIME_MAX_DAYS: '-3' })).toEqual({ minDays: 45, maxDays: 210 });
    expect(leadTimeWindowFromEnv({ LEADTIME_MIN_DAYS: '300', LEADTIME_MAX_DAYS: '100' })).toEqual({ minDays: 45, maxDays: 210 });
  });

  it('partition: only in-window signals are candidates; too close, too far and undated are listed with their days', () => {
    const s = (id: string, eventDate: string | null) => ({ id, name: id, eventDate });
    const p = partitionByLeadTime([s('in', addDays(100)), s('close', addDays(10)), s('far', addDays(300)), s('nodate', null)], TODAY, W);
    expect(p.inWindow.map((x) => [x.id, x.days])).toEqual([['in', 100]]);
    expect(p.tooClose).toEqual([{ id: 'close', name: 'close', event_date: addDays(10), days: 10 }]);
    expect(p.tooFar).toEqual([{ id: 'far', name: 'far', event_date: addDays(300), days: 300 }]);
    expect(p.noDate).toEqual([{ id: 'nodate', name: 'nodate', event_date: null, days: null }]);
  });

  it('hypothesis fair name from its signal ("<feria> — <empresa>") or its own name ("<empresa> — <feria>")', () => {
    expect(hypothesisEventName({ name: 'Conservas X — Gastrónoma 2026', signalName: 'Gastrónoma 2026 — Conservas X' })).toBe('Gastrónoma 2026');
    expect(hypothesisEventName({ name: 'Conservas X — Gastrónoma 2026', signalName: null })).toBe('Gastrónoma 2026');
    expect(hypothesisEventName({ name: 'Sin feria', signalName: null })).toBeNull();
  });

  it('expiry plan: PROPOSED of fairs closer than the minimum (or past) expire; VALIDATED only warned; in window untouched', () => {
    const h = (id: string, status: string, signalEventDate: string | null, name = `Empresa ${id} — Feria ${id}`) => ({
      id,
      name,
      status,
      companyId: null,
      commercialSignalId: null,
      signalName: null,
      signalEventDate,
    });
    const plan = planHypothesisExpiry(
      [
        h('close', 'PROPOSED', addDays(7)),
        h('past', 'PROPOSED', addDays(-3)),
        h('ok', 'PROPOSED', addDays(100)),
        h('validated', 'VALIDATED', addDays(7)),
        h('byname', 'PROPOSED', null, 'Conservas Y — Gastrónoma 2026'),
        h('unknown', 'PROPOSED', null, 'Sin feria'),
      ],
      [{ name: 'Gastrónoma 2026 (feria)', eventDate: addDays(8) }],
      TODAY,
      W,
    );
    expect(plan.expire.map((c) => [c.id, c.days, c.date_source])).toEqual([
      ['past', -3, 'signal'],
      ['close', 7, 'signal'],
      ['byname', 8, 'event_name'],
    ]);
    expect(plan.validatedWarnings.map((c) => c.id)).toEqual(['validated']);
    expect(plan.unresolvedDate).toBe(1);
  });

  it('notes: too close, too far (with the day it enters the window) and undated', () => {
    const close = outOfWindowNote({ signalName: 'Gastrónoma 2026', status: 'too_close', days: 7, eventDate: addDays(7), today: TODAY, window: W });
    expect(close.title).toBe('⏳ Fuera de ventana (2026-10-12): Gastrónoma 2026');
    expect(close.body).toContain('⏳ Fuera de ventana: la feria es en 7 días');
    expect(close.body).toContain('sigue QUALIFIED');
    const far = outOfWindowNote({ signalName: 'Feria Lejana', status: 'too_far', days: 300, eventDate: addDays(300), today: TODAY, window: W });
    expect(far.body).toContain('demasiado lejana');
    expect(far.body).toContain(`a partir del ${addDays(90)}`);
    const nodate = outOfWindowNote({ signalName: 'Feria X', status: 'no_date', days: null, eventDate: null, today: TODAY, window: W });
    expect(nodate.body).toContain('⏳ Sin fecha de feria: añade la fecha a la señal para que entre al reparto');
  });

  it('the gate applies to a scout input that names a signal_id (the trigger on qualification)', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    expect(isQualifiedTriggerInput({ mode: 'scout', event_url: 'https://x.example/', signal_id: sid })).toBe(true);
    expect(isQualifiedTriggerInput({ mode: 'scout', event_url: 'https://x.example/' })).toBe(false);
    expect(isQualifiedTriggerInput({ mode: 'signals', signal_id: sid })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Daily round-robin
// ---------------------------------------------------------------------------

describe('daily round-robin with the lead-time window', () => {
  const IN_URL = 'https://www.feria-en-ventana.com/expositores';

  it('skips too close, too far and undated QUALIFIED signals; chooses the one in the window; output and summary carry the days', async () => {
    const fake = new FakeTwenty();
    const close = fair(fake, 'Gastrónoma 2026 (feria)', 'QUALIFIED', addDays(7), 'https://www.gastronoma.net/');
    const far = fair(fake, 'Feria Lejana 2027 (feria)', 'QUALIFIED', addDays(300), 'https://www.feria-lejana.com/');
    const nodate = fair(fake, 'Feria Sin Fecha (feria)', 'QUALIFIED', null, 'https://www.feria-sin-fecha.com/');
    const inside = fair(fake, 'Feria En Ventana 2027 (feria)', 'QUALIFIED', addDays(100), IN_URL);
    const web = new FakeWeb().page(IN_URL, '<title>Feria En Ventana 2027</title><p>Expositores próximamente.</p>');
    const { ctx, agent } = setup([NO_LIST], { fake, web });
    const out = (await agent.run(ctx)).output as { signal_id: string; lead_time: LeadTimeBlock; signals: { qualified_current: number; qualified_in_window: number } };

    expect(out.signal_id).toBe(inside.id);
    expect(out.lead_time.window).toEqual({ min_days: 45, max_days: 210, today: TODAY, timezone: 'Europe/Madrid' });
    expect(out.lead_time.chosen).toMatchObject({ id: inside.id, days: 100 });
    expect(out.lead_time.too_close).toEqual([{ id: close.id, name: 'Gastrónoma 2026 (feria)', event_date: addDays(7), days: 7 }]);
    expect(out.lead_time.too_far.map((e) => [e.id, e.days])).toEqual([[far.id, 300]]);
    expect(out.lead_time.no_date.map((e) => e.id)).toEqual([nodate.id]);
    expect(out.signals).toMatchObject({ qualified_current: 4, qualified_in_window: 1 });
    // Only the chosen fair was fetched.
    expect(web.requests.map((r) => r.url.toString())).toEqual([IN_URL]);
    // The window filters, the calendar expires: nothing changed status.
    expect(fake.tables.commercialSignals.filter((s) => [close.id, far.id, nodate.id].includes(s.id)).map((s) => s.status)).toEqual(['QUALIFIED', 'QUALIFIED', 'QUALIFIED']);
    const summary = String(fake.tables.agentRunSummaries[0]!.resultSummary);
    expect(summary).toContain('Ventana de lead time: 45–210 días');
    expect(summary).toContain(`(${addDays(100)}, a 100 días)`);
    expect(summary).toContain('Gastrónoma 2026 (feria) (a 7 días)');
  });

  it('nothing QUALIFIED in the window -> SKIPPED with the breakdown, no model call, no fetch', async () => {
    const fake = new FakeTwenty();
    fair(fake, 'Gastrónoma 2026 (feria)', 'QUALIFIED', addDays(7), 'https://www.gastronoma.net/');
    fair(fake, 'Feria Lejana 2027 (feria)', 'QUALIFIED', addDays(211), 'https://www.feria-lejana.com/');
    const { provider, web, ctx, agent } = setup([], { fake });
    const out = (await agent.run(ctx)).output as { outcome: string; reason: string; lead_time: LeadTimeBlock; run_summary_id: string | null };
    expect(out).toMatchObject({ outcome: 'SKIPPED', reason: '0 señales calificadas en ventana de lead time', run_summary_id: null });
    expect(out.lead_time.in_window).toBe(0);
    expect(out.lead_time.too_close.map((e) => e.days)).toEqual([7]);
    expect(out.lead_time.too_far.map((e) => e.days)).toEqual([211]);
    expect(provider.requests).toHaveLength(0);
    expect(web.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hypothesis expiry
// ---------------------------------------------------------------------------

describe('hypothesis expiry by lead time (daily run)', () => {
  it('expires PROPOSED hypotheses of a fair next week, at most 50 per run; VALIDATED and in-window ones untouched', async () => {
    const fake = new FakeTwenty();
    const company = fake.seed('companies', { name: 'Conservas X', domainName: { primaryLinkUrl: 'conservasx.com', primaryLinkLabel: '', secondaryLinks: [] } });
    const sig = (fairName: string, date: string) =>
      fake.seed('commercialSignals', { name: `${fairName} — Conservas X`, signalType: 'FAIR', status: 'NEW', eventDate: date, companyId: company.id, tenantId: 'publiexpe' });
    const gastronoma = sig('Gastrónoma 2026', addDays(7));
    const later = sig('Feria En Ventana 2027', addDays(100));
    const hyp = (name: string, status: string, signalId: unknown) =>
      fake.seed('commercialHypotheses', { name, status, companyId: company.id, commercialSignalId: signalId, tenantId: 'publiexpe' });
    const proposed = Array.from({ length: 55 }, (_, i) => hyp(`Empresa ${i} — Gastrónoma 2026`, 'PROPOSED', gastronoma.id));
    const validated = hyp('Empresa V — Gastrónoma 2026', 'VALIDATED', gastronoma.id);
    const inWindow = hyp('Empresa W — Feria En Ventana 2027', 'PROPOSED', later.id);

    const { ctx, agent } = setup([], { fake });
    const out = (await agent.run(ctx)).output as {
      outcome: string;
      hypothesis_expiry: { expired: Entry[]; deferred: number; due: number; validated_warnings: Entry[]; max_per_run: number };
    };
    expect(out.outcome).toBe('SKIPPED');
    expect(out.hypothesis_expiry.due).toBe(55);
    expect(out.hypothesis_expiry.expired).toHaveLength(MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN);
    expect(out.hypothesis_expiry.deferred).toBe(5);
    expect(out.hypothesis_expiry.max_per_run).toBe(50);
    expect(out.hypothesis_expiry.expired[0]).toMatchObject({ event_date: addDays(7), days: 7 });
    expect(out.hypothesis_expiry.validated_warnings.map((w) => w.id)).toEqual([validated.id]);

    const status = (id: unknown) => fake.tables.commercialHypotheses.find((h) => h.id === id)!.status;
    expect(proposed.filter((h) => status(h.id) === 'EXPIRED')).toHaveLength(50);
    expect(status(validated.id)).toBe('VALIDATED');
    expect(status(inWindow.id)).toBe('PROPOSED');
    // Every PATCH is a hypothesis expiry that carries only the status.
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(50);
    for (const p of patches) {
      expect(p.path.startsWith('/rest/commercialHypotheses/')).toBe(true);
      expect(p.body).toEqual({ status: 'EXPIRED' });
    }

    // Next run: the 5 left expire; nothing else changes.
    const again = setup([], { fake });
    const out2 = (await again.agent.run(again.ctx)).output as typeof out;
    expect(out2.hypothesis_expiry.expired).toHaveLength(5);
    expect(proposed.every((h) => status(h.id) === 'EXPIRED')).toBe(true);
    expect(status(validated.id)).toBe('VALIDATED');
  });

  it('expire_hypothesis refuses VALIDATED and in-window hypotheses (the record wins over the caller)', async () => {
    const fake = new FakeTwenty();
    const s = fake.seed('commercialSignals', { name: 'F — X', signalType: 'FAIR', status: 'NEW', eventDate: addDays(100), companyId: null, tenantId: 't' });
    const validated = fake.seed('commercialHypotheses', { name: 'X — F', status: 'VALIDATED', commercialSignalId: s.id, tenantId: 't' });
    const proposed = fake.seed('commercialHypotheses', { name: 'Y — F', status: 'PROPOSED', commercialSignalId: s.id, tenantId: 't' });
    const tool = createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } }).get('expire_hypothesis')!;
    const tctx = { tenantId: 't', executionId: 'e', agentId: 'a', stage: null, idempotencyKey: 'k', signal: new AbortController().signal, logger: { info() {}, error() {} } };
    // The caller claims the fair is next week: the signal of the record says 100 days.
    const r1 = await tool.execute({ hypothesisId: validated.id, eventDate: addDays(7), today: TODAY, minDays: 45 }, tctx);
    const r2 = await tool.execute({ hypothesisId: proposed.id, eventDate: addDays(7), today: TODAY, minDays: 45 }, tctx);
    expect(r1).toMatchObject({ status: 'ok', output: { expired: false, reason: 'status_not_proposed' } });
    expect(r2).toMatchObject({ status: 'ok', output: { expired: false, reason: 'event_in_lead_time', days: 100 } });
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger on qualification
// ---------------------------------------------------------------------------

describe('trigger on qualification (prospect-on-qualified) with the lead-time window', () => {
  const triggerInput = (signal: Record<string, unknown>, eventDate: string | null) => ({
    mode: 'scout',
    max_events: 1,
    event_url: (signal.sourceUrl as { primaryLinkUrl: string }).primaryLinkUrl,
    event_name: String(signal.name).replace(/ \(feria\)$/, ''),
    ...(eventDate ? { event_date: eventDate } : {}),
    signal_id: signal.id,
    event: { type: 'signal.qualified' },
  });

  it('fair next week -> SKIPPED, no prospecting, a note on the signal; the signal keeps QUALIFIED; idempotent per day', async () => {
    const fake = new FakeTwenty();
    const s = fair(fake, 'Gastrónoma 2026 (feria)', 'QUALIFIED', addDays(7), 'https://www.gastronoma.net/');
    const { provider, web, ctx, agent } = setup([], { fake, input: triggerInput(s, addDays(7)) });
    const out = (await agent.run(ctx)).output as Record<string, unknown> & { lead_time: { status: string; days: number }; note: { created: boolean; noteId: string } };
    expect(out).toMatchObject({ outcome: 'SKIPPED', status: 'ok', signal_id: s.id, run_summary_id: null, cost: { model: 0 } });
    expect(String(out.reason)).toContain('demasiado cercana (a 7 días; mínimo 45)');
    expect(out.lead_time).toMatchObject({ status: 'too_close', days: 7, event_date: addDays(7) });
    expect(provider.requests).toHaveLength(0);
    expect(web.requests).toHaveLength(0);
    expect(fake.tables.commercialSignals[0]!.status).toBe('QUALIFIED');
    expect(fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    expect(fake.tables.notes).toHaveLength(1);
    expect(fake.tables.notes[0]).toMatchObject({ title: '⏳ Fuera de ventana (2026-10-12): Gastrónoma 2026' });
    expect(String((fake.tables.notes[0]!.bodyV2 as { markdown: string }).markdown)).toContain('⏳ Fuera de ventana: la feria es en 7 días');
    expect(fake.tables.noteTargets).toEqual([expect.objectContaining({ noteId: out.note.noteId, targetCommercialSignalId: s.id })]);
    expect(out.note.created).toBe(true);

    // A replay the same day: same note, nothing new.
    const again = setup([], { fake, input: triggerInput(s, addDays(7)) });
    const out2 = (await again.agent.run(again.ctx)).output as typeof out;
    expect(out2.note).toMatchObject({ created: false, noteId: out.note.noteId });
    expect(fake.tables.notes).toHaveLength(1);
    expect(fake.tables.noteTargets).toHaveLength(1);
  });

  it('fair too far -> SKIPPED with a "demasiado lejana" note; undated fair -> SKIPPED with the "Sin fecha" note', async () => {
    const fake = new FakeTwenty();
    const far = fair(fake, 'Feria Lejana 2027 (feria)', 'QUALIFIED', addDays(300), 'https://www.feria-lejana.com/');
    const nodate = fair(fake, 'Feria Sin Fecha (feria)', 'QUALIFIED', null, 'https://www.feria-sin-fecha.com/');
    const a = setup([], { fake, input: triggerInput(far, addDays(300)) });
    const outFar = (await a.agent.run(a.ctx)).output as Record<string, unknown>;
    expect(outFar).toMatchObject({ outcome: 'SKIPPED', lead_time: { status: 'too_far', days: 300 } });
    const b = setup([], { fake, input: triggerInput(nodate, null) });
    const outNoDate = (await b.agent.run(b.ctx)).output as Record<string, unknown>;
    expect(outNoDate).toMatchObject({ outcome: 'SKIPPED', lead_time: { status: 'no_date', days: null } });
    const bodies = fake.tables.notes.map((n) => String((n.bodyV2 as { markdown: string }).markdown));
    expect(bodies[0]).toContain('demasiado lejana');
    expect(bodies[1]).toContain('⏳ Sin fecha de feria: añade la fecha a la señal para que entre al reparto');
    expect(fake.tables.commercialSignals.map((s) => s.status)).toEqual(['QUALIFIED', 'QUALIFIED']);
  });

  it('fair in the window -> the directed scout runs as before, with the lead-time block in the output', async () => {
    const fake = new FakeTwenty();
    const url = 'https://www.feria-en-ventana.com/expositores';
    const s = fair(fake, 'Feria En Ventana 2027 (feria)', 'QUALIFIED', addDays(60), url);
    const web = new FakeWeb().page(url, '<title>Feria En Ventana 2027</title><p>Expositores próximamente.</p>');
    const { ctx, agent } = setup([NO_LIST], { fake, web, input: triggerInput(s, addDays(60)) });
    const out = (await agent.run(ctx)).output as Record<string, unknown>;
    expect(out).toMatchObject({ mode: 'scout', lead_time: { status: 'in_window', days: 60 } });
    expect(web.requests.map((r) => r.url.toString())).toEqual([url]);
    expect(fake.tables.notes).toHaveLength(0);
    expect(String(fake.tables.agentRunSummaries[0]!.resultSummary)).toContain('la feria es en 60 días');
  });
});

// ---------------------------------------------------------------------------
// Discovery scout
// ---------------------------------------------------------------------------

describe('discovery scout (discover_only) with the lead-time window', () => {
  const SOURCE = (domain: string) => ({ uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${domain}`, title: domain, domain });
  const ev = (name: string, start: string | null, host: string) => ({
    name,
    start_date: start,
    end_date: null,
    city: 'Madrid',
    website_url: `https://www.${host}/`,
    exhibitors_url: null,
    why_relevant: 'alimentación',
  });

  it('fairs outside the window create no signal and are counted; an undated one is still recorded with the fact noted', async () => {
    const answer: StubResponse = {
      text: JSON.stringify({
        events: [ev('Gastrónoma 2026', addDays(7), 'gastronoma.net'), ev('Feria En Ventana 2027', addDays(100), 'feria-en-ventana.com'), ev('Feria Sin Fecha', null, 'feria-sin-fecha.com')],
      }),
      grounding: { queries: ['ferias alimentación'], sources: [SOURCE('gastronoma.net'), SOURCE('feria-en-ventana.com'), SOURCE('feria-sin-fecha.com')] },
      cost: 0.03,
    };
    const web = new FakeWeb()
      .page('https://www.gastronoma.net/', '<title>Gastrónoma 2026</title>')
      .page('https://www.feria-en-ventana.com/', '<title>Feria En Ventana 2027</title>')
      .page('https://www.feria-sin-fecha.com/', '<title>Feria Sin Fecha</title>');
    const { fake, ctx, agent } = setup([answer], { web, input: { ...SCOUT_DEFAULT_INPUT, discover_only: true } });
    const out = (await agent.run(ctx)).output as {
      counters: Record<string, number>;
      discarded_events: Array<{ name: string; reason: string; days?: number }>;
      lead_time: { discarded_out_of_window: number };
    };
    expect(out.counters.discarded_out_of_window).toBe(1);
    expect(out.lead_time.discarded_out_of_window).toBe(1);
    expect(out.discarded_events).toContainEqual(expect.objectContaining({ name: 'Gastrónoma 2026', reason: 'fuera_de_ventana_lead_time_cercana', days: 7 }));
    expect(fake.tables.commercialSignals.map((s) => s.name).sort()).toEqual(['Feria En Ventana 2027 (feria)', 'Feria Sin Fecha (feria)']);
    const undated = fake.tables.commercialSignals.find((s) => s.name === 'Feria Sin Fecha (feria)')!;
    expect(String(undated.description)).toContain('no se puede juzgar la ventana de lead time');
    expect(web.requests.map((r) => r.url.toString())).not.toContain('https://www.gastronoma.net/');
    expect(String(fake.tables.agentRunSummaries[0]!.resultSummary)).toContain('ferias propuestas fuera de ventana (sin señal): 1');
  });
});

// ---------------------------------------------------------------------------
// HUMAN evaluator: EXPIRED is never a verdict
// ---------------------------------------------------------------------------

describe('HUMAN evaluator: expiry is not a verdict', () => {
  const base = { eventName: 'commercialHypothesis.updated', editedWhileProposed: false, proposal: null };
  it('a transition to EXPIRED is ignored (from PROPOSED or VALIDATED, with or without edits)', () => {
    for (const last of [null, 'PROPOSED', 'VALIDATED']) {
      expect(classifyHypothesisChange({ ...base, record: { status: 'EXPIRED' }, updatedFields: ['status'], lastKnownStatus: last })).toEqual({ action: 'ignore', reason: EXPIRY_NOT_A_VERDICT });
    }
    expect(classifyHypothesisChange({ ...base, record: { status: 'EXPIRED', need: 'x' }, updatedFields: ['status', 'need'], lastKnownStatus: null })).toEqual({ action: 'ignore', reason: EXPIRY_NOT_A_VERDICT });
  });

  it('the previous status comes from the newest of the last verdict and the last non-verdict marker', () => {
    const t = (iso: string) => new Date(iso);
    expect(mergeLastKnownStatus({ lastKnownStatus: 'VALIDATED', lastOccurredAt: t('2026-10-01T00:00:00Z') }, null)).toBe('VALIDATED');
    expect(mergeLastKnownStatus({ lastKnownStatus: null, lastOccurredAt: null }, { toStatus: 'EXPIRED', occurredAt: t('2026-10-12T00:00:00Z') })).toBe('EXPIRED');
    expect(mergeLastKnownStatus({ lastKnownStatus: 'VALIDATED', lastOccurredAt: t('2026-10-01T00:00:00Z') }, { toStatus: 'EXPIRED', occurredAt: t('2026-10-12T00:00:00Z') })).toBe('EXPIRED');
    expect(mergeLastKnownStatus({ lastKnownStatus: 'REJECTED', lastOccurredAt: t('2026-10-13T00:00:00Z') }, { toStatus: 'EXPIRED', occurredAt: t('2026-10-12T00:00:00Z') })).toBe('REJECTED');
    // EXPIRED -> REJECTED / VALIDATED (by a person cleaning up) is then not scored.
    expect(classifyHypothesisChange({ ...base, record: { status: 'REJECTED' }, updatedFields: ['status'], lastKnownStatus: 'EXPIRED' })).toMatchObject({ action: 'ignore' });
    expect(classifyHypothesisChange({ ...base, record: { status: 'VALIDATED' }, updatedFields: ['status'], lastKnownStatus: 'EXPIRED' })).toMatchObject({ action: 'ignore' });
  });

  it('the hypothesis.* namespace is reserved: an external event cannot forge a status marker', () => {
    expect(RESERVED_EVENT_NAMESPACES).toContain('hypothesis.');
  });
});
