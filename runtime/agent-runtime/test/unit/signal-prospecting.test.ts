import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { isScoutInput, ScoutInput } from '../../src/agents/event-scout.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import {
  eventNameOf,
  isFairLevelSignal,
  isPastEvent,
  isSignalsInput,
  MemorySignalHistory,
  pickNextSignal,
  type SignalHistory,
} from '../../src/agents/signal-prospecting.js';
import { StubProvider, type StubResponse } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

const TODAY = new Date('2026-10-09T06:00:00Z');

const relevant = JSON.stringify({
  relevant: true,
  confidence: 0.8,
  reason: 'Bodega con stand propio.',
  hypothesis: {
    need: 'Regalo para visitantes del stand',
    why_now: 'Expone en febrero de 2027; el taller propio llega a tiempo.',
    quantity_min: 300,
    quantity_max: 800,
    budget_min_eur: 900,
    budget_max_eur: 3000,
    recommended_products: ['Bolsas tote'],
    timing: 'NEXT_QUARTER',
    differentiators: ['TALLER_PROPIO'],
  },
});
const extract = (o: Record<string, unknown>) => JSON.stringify({ page_kind: 'exhibitor_list', event: null, exhibitors: [], exhibitors_page_url: null, notes: 'página de prueba', ...o });

const BWW_URL = 'https://www.barcelonawineweek.com/expositores';
const ANUGA_URL = 'https://www.anugaselect-iberica.com/expositores';
const BWW_HTML = `<html><head><title>Expositores - Barcelona Wine Week 2027</title></head><body>
  <h1>Expositores</h1>
  <ul><li><a href="https://www.bodegasejemplares.com/">Bodegas Ejemplares</a> — vinos, Penedès</li></ul>
</body></html>`;

/** Signals as the commercial leaves them in Twenty (fair-level and the historical per-exhibitor ones). */
function seedSignals(fake: FakeTwenty) {
  const fair = (name: string, status: string, eventDate: string | null, url: string | null, extra: Record<string, unknown> = {}) =>
    fake.seed('commercialSignals', {
      name,
      signalType: 'FAIR',
      status,
      eventDate,
      sourceUrl: url ? { primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] } : null,
      sourceDomain: url ? new URL(url).hostname.replace(/^www\./, '') : null,
      companyId: null,
      tenantId: 'publiexpe',
      ...extra,
    });
  const company = fake.seed('companies', { name: 'Conservas Gastrónomas', domainName: { primaryLinkUrl: 'conservasgastronomas.com', primaryLinkLabel: '', secondaryLinks: [] } });
  return {
    anuga: fair('Anuga Select Ibérica 2027 (1ª edición) (feria)', 'QUALIFIED', '2027-01-20', ANUGA_URL),
    bww: fair('Barcelona Wine Week 2027 (feria)', 'QUALIFIED', '2027-02-10', BWW_URL),
    // Per-exhibitor signal (historical): has a company, never listed, never expired, never prospected.
    perExhibitor: fair('Gastrónoma 2026 — Conservas Gastrónomas', 'QUALIFIED', '2026-10-01', 'https://www.gastronoma.net/expositores', { companyId: company.id }),
    pastNew: fair('Fruit Attraction 2026 (feria)', 'NEW', '2026-10-01', 'https://www.ifema.es/fruit-attraction'),
    pastQualified: fair('Alimentaria Lisboa 2026 (feria)', 'QUALIFIED', '2026-09-20', 'https://www.alimentaria-lisboa.pt/'),
    pastDiscarded: fair('Feria Descartada 2026 (feria)', 'DISCARDED', '2026-09-01', 'https://www.feria-descartada.com/'),
    undatedReviewing: fair('Congreso Sin Fecha (feria)', 'REVIEWING', null, 'https://www.congreso-sin-fecha.com/'),
    noUrl: fair('Feria Sin URL (feria)', 'QUALIFIED', '2027-03-01', null),
    notFairType: fair('Contratación en Bodegas X', 'QUALIFIED', '2027-03-01', 'https://www.bodegasx.com/empleo', { signalType: 'HIRING' }),
  };
}

function setup(responses: Array<string | StubResponse>, opts: { input?: Record<string, unknown>; web?: FakeWeb; history?: SignalHistory; fake?: FakeTwenty } = {}) {
  const fake = opts.fake ?? new FakeTwenty();
  const web = opts.web ?? new FakeWeb();
  const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
  const version = desiredProspectorVersion();
  const tools = new ToolExecutor(
    createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: { endpoint: null } }),
    parseToolPolicy(version.configuration),
    { tenantId: 'publiexpe', executionId: 'exec-daily', agentId: 'agent-1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const ctx: AgentContext = {
    tenantId: 'publiexpe',
    executionId: 'exec-daily',
    agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
    version: { id: 'v9', version: 9, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
    input: opts.input ?? { mode: 'signals' },
    provider,
    signal: new AbortController().signal,
    tools,
  };
  const agent = new ProspectorAgent(() => TODAY, opts.history ? { history: opts.history } : {});
  return { fake, web, provider, ctx, agent };
}

type SignalsOut = {
  outcome: string;
  mode: string;
  signal_id?: string;
  signal_name?: string;
  event_name?: string;
  event_url?: string;
  input?: Record<string, unknown>;
  reason?: string;
  signals: {
    fair_level: number;
    qualified_current: number;
    ignored_not_fair_level: number;
    expired: Array<{ id: string; name: string; event_date: string | null; previous_status: string | null }>;
    selection?: { strategy: string; candidates: Array<{ id: string; last_worked_at: string | null }> };
  };
  events?: Array<{ status: string; name: string; results: Array<{ name: string; status: string }> }>;
  cost: { model: number; eur: number };
  run_summary_id: string | null;
};

describe('signals mode: pure rules', () => {
  it('is additive: the scout and direct inputs keep their meaning', () => {
    expect(isSignalsInput({ mode: 'signals' })).toBe(true);
    expect(isScoutInput({ mode: 'signals' })).toBe(false);
    expect(isSignalsInput({ event_url: 'https://x.example' })).toBe(false);
    expect(isScoutInput({ event_url: 'https://x.example', event_name: 'X', max_events: 1 })).toBe(true);
    expect(isScoutInput({ event: {}, exhibitors: [] })).toBe(false);
    // The directed scout input (also used by the trigger on qualification) still parses as before.
    const parsed = ScoutInput.parse({ event_url: BWW_URL, event_name: 'Barcelona Wine Week 2027', max_events: 1, signal_id: 'ignored-extra-key' });
    expect(parsed).toMatchObject({ event_url: BWW_URL, event_name: 'Barcelona Wine Week 2027', max_events: 1, region: 'España', horizon_months: 6 });
    expect(parsed.discover_only).toBeUndefined();
    expect(parsed.event_date).toBeUndefined();
  });

  it('fair-level signals: fair-like type and an http(s) event URL', () => {
    expect(isFairLevelSignal({ signalType: 'FAIR', sourceUrl: BWW_URL })).toBe(true);
    expect(isFairLevelSignal({ signalType: 'CONGRESS', sourceUrl: 'http://congreso.es/' })).toBe(true);
    expect(isFairLevelSignal({ signalType: 'HIRING', sourceUrl: BWW_URL })).toBe(false);
    expect(isFairLevelSignal({ signalType: 'FAIR', sourceUrl: null })).toBe(false);
    expect(isFairLevelSignal({ signalType: 'FAIR', sourceUrl: 'ftp://x.example/' })).toBe(false);
  });

  it('event name without the "(feria)" suffix; past only strictly before today', () => {
    expect(eventNameOf('Barcelona Wine Week 2027 (feria)')).toBe('Barcelona Wine Week 2027');
    expect(eventNameOf('Anuga Select Ibérica 2027 (1ª edición) (feria)')).toBe('Anuga Select Ibérica 2027 (1ª edición)');
    expect(eventNameOf('Salón X')).toBe('Salón X');
    expect(isPastEvent({ eventDate: '2026-10-08' }, '2026-10-09')).toBe(true);
    expect(isPastEvent({ eventDate: '2026-10-09' }, '2026-10-09')).toBe(false);
    expect(isPastEvent({ eventDate: null }, '2026-10-09')).toBe(false);
  });

  it('round-robin: never worked first, then the one worked longest ago; ties by nearest date', () => {
    const a = { id: 'a', name: 'A', eventDate: '2027-01-20' };
    const b = { id: 'b', name: 'B', eventDate: '2027-02-10' };
    const c = { id: 'c', name: 'C', eventDate: null };
    expect(pickNextSignal([b, c, a], new Map())?.id).toBe('a');
    expect(pickNextSignal([a, b, c], new Map([['a', new Date('2026-10-08')]]))?.id).toBe('b');
    const all = new Map([
      ['a', new Date('2026-10-08')],
      ['b', new Date('2026-10-07')],
      ['c', new Date('2026-10-06')],
    ]);
    expect(pickNextSignal([a, b, c], all)?.id).toBe('c');
    expect(pickNextSignal([], all)).toBeNull();
  });
});

describe('ProspectorAgent signals mode', () => {
  it('expires past fair signals first, then scouts the least recently worked QUALIFIED fair (directed scout)', async () => {
    const fake = new FakeTwenty();
    const s = seedSignals(fake);
    const web = new FakeWeb().page(BWW_URL, BWW_HTML);
    // Anuga was worked yesterday: today it is Barcelona Wine Week's turn.
    const history = new MemorySignalHistory(new Map([[s.anuga.id as string, new Date('2026-10-08T06:00:00Z')]]));
    const { provider, ctx, agent } = setup(
      [extract({ exhibitors: [{ name: 'Bodegas Ejemplares', domain: 'bodegasejemplares.com', description: 'Vinos del Penedès', sector: 'Vino' }] }), relevant],
      { fake, web, history },
    );
    const result = await agent.run(ctx);
    const out = result.output as unknown as SignalsOut;

    expect(out).toMatchObject({ outcome: 'SUCCESS', mode: 'signals', signal_id: s.bww.id, signal_name: 'Barcelona Wine Week 2027 (feria)', event_name: 'Barcelona Wine Week 2027', event_url: BWW_URL });
    // The directed scout ran with the same input a manual run uses (+ the known date).
    expect(out.input).toMatchObject({ event_url: BWW_URL, event_name: 'Barcelona Wine Week 2027', event_date: '2027-02-10', max_events: 1 });
    expect(provider.requests.some((r) => (r.options as { grounding?: boolean }).grounding === true)).toBe(false);
    expect(web.requests.map((r) => r.url.toString())).toEqual([BWW_URL]);
    expect(out.events?.[0]?.results.map((r) => [r.name, r.status])).toEqual([['Bodegas Ejemplares', 'hypothesis_created']]);

    // Ageing: only fair-level, open, past signals; per-exhibitor, discarded and undated ones untouched.
    expect(out.signals.expired.map((e) => e.id).sort()).toEqual([s.pastNew.id, s.pastQualified.id].sort());
    const status = (rec: Record<string, unknown>) => fake.tables.commercialSignals.find((r) => r.id === rec.id)!.status;
    expect(status(s.pastNew)).toBe('EXPIRED');
    expect(status(s.pastQualified)).toBe('EXPIRED');
    expect(status(s.perExhibitor)).toBe('QUALIFIED');
    expect(status(s.pastDiscarded)).toBe('DISCARDED');
    expect(status(s.undatedReviewing)).toBe('REVIEWING');
    expect(status(s.bww)).toBe('QUALIFIED');
    expect(status(s.anuga)).toBe('QUALIFIED');
    // The only PATCHes are the two expirations, and they carry only the status.
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(2);
    for (const p of patches) expect(p.body).toEqual({ status: 'EXPIRED' });

    // Candidates: the two current QUALIFIED fairs (no per-exhibitor, no URL-less, no HIRING).
    expect(out.signals.qualified_current).toBe(2);
    expect(out.signals.selection?.strategy).toBe('least_recently_worked');
    expect(out.signals.selection?.candidates.map((c) => c.id).sort()).toEqual([s.anuga.id, s.bww.id].sort());
    expect(out.signals.ignored_not_fair_level).toBe(2);

    // The per-exhibitor signal of the new exhibitor is created; the qualified fair itself is not duplicated.
    const created = fake.tables.commercialSignals.filter((r) => r.companyId && r.companyId !== s.perExhibitor.companyId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'Barcelona Wine Week 2027 — Bodegas Ejemplares', status: 'NEW' });
    expect(fake.tables.agentRunSummaries[0]).toMatchObject({ task: 'daily-event-prospecting', outcome: 'SUCCESS' });
    expect(String(fake.tables.agentRunSummaries[0]!.resultSummary)).toContain('Barcelona Wine Week 2027 (feria)');
    expect(String(fake.tables.agentRunSummaries[0]!.resultSummary)).toContain('Señales caducadas');
  });

  it('a fair without a readable list keeps its qualified signal (same date and domain: no duplicate)', async () => {
    const fake = new FakeTwenty();
    const s = seedSignals(fake);
    const web = new FakeWeb().page(ANUGA_URL, '<title>Anuga Select Ibérica</title><p>Lista de expositores próximamente.</p>');
    const before = fake.tables.commercialSignals.length;
    const { ctx, agent } = setup([extract({ page_kind: 'event_home', notes: 'sin lista' })], { fake, web, history: new MemorySignalHistory() });
    const out = (await agent.run(ctx)).output as unknown as SignalsOut;
    expect(out).toMatchObject({ signal_id: s.anuga.id, outcome: 'PARTIAL' });
    expect(out.events?.[0]).toMatchObject({ status: 'event_signal' });
    expect(fake.tables.commercialSignals).toHaveLength(before);
  });

  it('no QUALIFIED current signal -> SKIPPED, cost 0, no model call, no CRM summary, but past signals still expire', async () => {
    const fake = new FakeTwenty();
    const past = fake.seed('commercialSignals', {
      name: 'Fruit Attraction 2026 (feria)',
      signalType: 'FAIR',
      status: 'QUALIFIED',
      eventDate: '2026-10-01',
      sourceUrl: { primaryLinkUrl: 'https://www.ifema.es/fruit-attraction', primaryLinkLabel: '', secondaryLinks: [] },
      companyId: null,
    });
    fake.seed('commercialSignals', {
      name: 'Feria Nueva 2027 (feria)',
      signalType: 'FAIR',
      status: 'NEW',
      eventDate: '2027-05-01',
      sourceUrl: { primaryLinkUrl: 'https://www.ferianueva.com/', primaryLinkLabel: '', secondaryLinks: [] },
      companyId: null,
    });
    const { provider, ctx, agent } = setup([], { fake });
    const result = await agent.run(ctx);
    const out = result.output as unknown as SignalsOut;
    expect(out).toMatchObject({ outcome: 'SKIPPED', status: 'ok', mode: 'signals', reason: '0 señales calificadas', run_summary_id: null, cost: { model: 0, eur: 0 } });
    expect(out.signals.expired.map((e) => e.id)).toEqual([past.id]);
    expect(fake.tables.commercialSignals.find((r) => r.id === past.id)!.status).toBe('EXPIRED');
    expect(provider.requests).toHaveLength(0);
    expect(result.modelCost).toBe(0);
    expect(fake.tables.agentRunSummaries).toHaveLength(0);
    expect(fake.tables.notes).toHaveLength(0);
  });

  it('empty Twenty -> SKIPPED with no write at all', async () => {
    const { fake, ctx, agent } = setup([]);
    const out = (await agent.run(ctx)).output as unknown as SignalsOut;
    expect(out).toMatchObject({ outcome: 'SKIPPED', signals: { qualified_current: 0, expired: [] } });
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('Twenty unreachable -> FAILED with the reason', async () => {
    const fake = new FakeTwenty();
    const { ctx, agent } = setup([], { fake });
    const broken = new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client({ apiKey: undefined }), web: new FakeWeb().deps(), render: { endpoint: null } }),
      parseToolPolicy(ctx.version.configuration),
      { tenantId: 'publiexpe', executionId: 'exec-daily', agentId: 'agent-1', stage: 'PROSPECTOR' },
      new AbortController().signal,
    );
    const out = (await agent.run({ ...ctx, tools: broken })).output as unknown as SignalsOut & { list_error: { code: string } };
    expect(out).toMatchObject({ outcome: 'FAILED', list_error: { code: 'TWENTY_NOT_CONFIGURED' } });
  });
});

describe('expire_signal tool', () => {
  it('only expires open signals with a past date, and only writes the status', async () => {
    const fake = new FakeTwenty();
    const mk = (status: string, eventDate: string | null) => fake.seed('commercialSignals', { name: 'X', signalType: 'FAIR', status, eventDate, companyId: null });
    const cases = [mk('QUALIFIED', '2026-10-08'), mk('DISCARDED', '2026-10-01'), mk('NEW', '2026-10-09'), mk('REVIEWING', null)];
    const registry = createDefaultToolRegistry({ twenty: fake.client(), render: { endpoint: null } });
    const tool = registry.get('expire_signal')!;
    const ctx = { tenantId: 't', executionId: 'e', agentId: 'a', stage: null, idempotencyKey: 'k', signal: new AbortController().signal, logger: { info() {}, error() {} } };
    const results = [];
    for (const c of cases) results.push(await tool.execute({ signalId: c.id, today: '2026-10-09' }, ctx));
    expect(results.map((r) => (r.status === 'ok' ? (r.output as { reason: string }).reason : r.status))).toEqual(['expired', 'status_not_open', 'event_not_past', 'no_event_date']);
    expect(fake.tables.commercialSignals.map((r) => r.status)).toEqual(['EXPIRED', 'DISCARDED', 'NEW', 'REVIEWING']);
  });
});
