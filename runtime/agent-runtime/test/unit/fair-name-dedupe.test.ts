/**
 * Tanda 25: dedupe of fairs by normalized name. Real cases: on 2026-10-22 the scout created
 * "Barcelona Wine Week (BWW) 2027 (feria)" next to the QUALIFIED "Barcelona Wine Week 2027 (feria)".
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { fairNameKey, fairYear, findSameFair, sameFair } from '../../src/agents/fair-name-dedupe.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import { StubProvider, type StubResponse } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

const f = (name: string, date: string | null = null) => ({ name, date });

describe('fairNameKey (normalization)', () => {
  it('drops the (feria) suffix, acronyms in parentheses, accents, signs, editions, ordinals and years', () => {
    expect(fairNameKey('Barcelona Wine Week (BWW) 2027 (feria)')).toBe('barcelona wine week');
    expect(fairNameKey('Barcelona Wine Week 2027 (feria)')).toBe('barcelona wine week');
    expect(fairNameKey('Retail Forum 2027 (15ª Edición)')).toBe('retail forum');
    expect(fairNameKey('Retail Forum Madrid 2027 (15ª edición)')).toBe('retail forum madrid');
    expect(fairNameKey('Expo Foods 2027 – 20.ª edición')).toBe('expo foods');
    expect(fairNameKey('1ª Edición Feria Vegana 2027')).toBe('feria vegana');
    expect(fairNameKey('Salón Look 2027, 25ª edición')).toBe('salon look');
    expect(fairNameKey('Hostelco edición 25 2027')).toBe('hostelco');
    expect(fairNameKey('Fruit Attraction XIX edición 2027')).toBe('fruit attraction');
    expect(fairNameKey('25º Salón Internacional del Club de Gourmets')).toBe('salon internacional club gourmets');
    expect(fairNameKey('HIP – Horeca Professional Expo 2027')).toBe('hip horeca professional expo');
    expect(fairNameKey('HIP - Horeca Professional Expo 2027')).toBe('hip horeca professional expo');
  });

  it('keeps parentheses that are not an acronym, and lowercase words', () => {
    expect(fairNameKey('Feria del Mueble (Yecla) 2027')).toBe('feria mueble yecla');
  });

  it('fairYear: the date first, else a single year in the name', () => {
    expect(fairYear(f('Retail Forum 2027', '2027-03-04'))).toBe(2027);
    expect(fairYear(f('Retail Forum 2027'))).toBe(2027);
    expect(fairYear(f('Retail Forum'))).toBeNull();
    expect(fairYear(f('Retail Forum 2026-2027'))).toBeNull();
  });
});

describe('sameFair (real cases)', () => {
  it('BWW with and without "(BWW)" match, also against the "(feria)" title of the CRM', () => {
    expect(sameFair(f('Barcelona Wine Week (BWW) 2027', '2027-02-01'), f('Barcelona Wine Week 2027 (feria)', '2027-02-01'))).toBe('nombre_normalizado');
    expect(sameFair(f('Barcelona Wine Week (BWW) 2027 (feria)'), f('Barcelona Wine Week 2027 (feria)'))).toBe('nombre_normalizado');
  });

  it('Retail Forum: an extra city word on one side matches ("madrid" sobrante)', () => {
    expect(sameFair(f('Retail Forum 2027 (15ª Edición)', '2027-03-10'), f('Retail Forum Madrid 2027 (15ª edición)', '2027-03-10'))).toBe('nombre_sin_ciudad');
  });

  it('HIP with an en dash and with a hyphen match', () => {
    expect(sameFair(f('HIP – Horeca Professional Expo 2027', '2027-02-22'), f('HIP - Horeca Professional Expo 2027', '2027-02-23'))).toBe('nombre_normalizado');
  });

  it('different fairs do NOT match', () => {
    // Different names (one word in common, a city on one side): never by the city rule.
    expect(sameFair(f('Salón Gourmets 2027', '2027-04-12'), f('Gourmets Barcelona 2027', '2027-04-12'))).toBeNull();
    // A single word left once the city is removed: too little to tolerate the city.
    expect(sameFair(f('Gourmets 2027'), f('Gourmets Barcelona 2027'))).toBeNull();
    // Two different cities.
    expect(sameFair(f('Retail Forum Madrid 2027'), f('Retail Forum Barcelona 2027'))).toBeNull();
    // Same name, different years (by name and by date).
    expect(sameFair(f('Barcelona Wine Week 2027'), f('Barcelona Wine Week 2028'))).toBeNull();
    expect(sameFair(f('Barcelona Wine Week', '2027-02-01'), f('Barcelona Wine Week', '2028-02-07'))).toBeNull();
    // Same name and year, dates more than 10 days apart (two editions / two cities of a roadshow).
    expect(sameFair(f('Expo Foods 2027', '2027-03-01'), f('Expo Foods 2027', '2027-03-12'))).toBeNull();
    expect(sameFair(f('Expo Foods 2027', '2027-03-01'), f('Expo Foods 2027', '2027-03-11'))).toBe('nombre_normalizado');
    // No year on either side: never merged.
    expect(sameFair(f('Expo Foods'), f('Expo Foods'))).toBeNull();
    // Nothing left of the name.
    expect(sameFair(f('2027 (feria)'), f('2027 (feria)'))).toBeNull();
  });

  it('findSameFair returns the first known fair that matches, with the rule', () => {
    const known = [
      { id: 'a', name: 'Salón Gourmets 2027 (feria)', status: 'NEW', date: '2027-04-12' },
      { id: 'b', name: 'Barcelona Wine Week 2027 (feria)', status: 'QUALIFIED', date: '2027-02-01' },
    ];
    expect(findSameFair(f('Barcelona Wine Week (BWW) 2027', '2027-02-02'), known)).toMatchObject({ fair: { id: 'b' }, rule: 'nombre_normalizado' });
    expect(findSameFair(f('Gourmets Barcelona 2027', '2027-04-12'), known)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scout (discover_only): the dedupe before creating a fair signal
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-10-07T07:30:00Z');
const BWW_SOURCE = { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/B1', title: 'barcelonawineweek.com', domain: 'barcelonawineweek.com' };
const HIP_SOURCE = { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/H1', title: 'expohip.com', domain: 'expohip.com' };
const GOURMETS_SOURCE = { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/G1', title: 'gourmets.net', domain: 'gourmets.net' };
const BWW_EVENT = { name: 'Barcelona Wine Week (BWW) 2027', start_date: '2027-02-01', end_date: '2027-02-03', city: 'Barcelona', website_url: 'https://www.barcelonawineweek.com/', exhibitors_url: null, why_relevant: 'x' };
const HIP_EVENT = { name: 'HIP – Horeca Professional Expo 2027', start_date: '2027-02-22', end_date: '2027-02-24', city: 'Madrid', website_url: 'https://www.expohip.com/', exhibitors_url: null, why_relevant: 'x' };
const GOURMETS_EVENT = { name: 'Gourmets Barcelona 2027', start_date: '2027-03-15', end_date: '2027-03-17', city: 'Barcelona', website_url: 'https://www.gourmets.net/barcelona', exhibitors_url: null, why_relevant: 'x' };
const page = (title: string) => `<html><head><title>${title}</title></head><body>${title}, febrero de 2027.</body></html>`;

const fairSearch = (events: unknown[], sources: unknown[]): StubResponse => ({ text: JSON.stringify({ events }), grounding: { queries: ['ferias'], sources: sources as never }, cost: 0.03 });

function setup(responses: Array<string | StubResponse>, input: Record<string, unknown>, fake: FakeTwenty) {
  const web = new FakeWeb()
    .page('https://www.barcelonawineweek.com/', page('Barcelona Wine Week 2027'))
    .page('https://www.expohip.com/', page('HIP – Horeca Professional Expo 2027'))
    .page('https://www.gourmets.net/barcelona', page('Gourmets Barcelona 2027'));
  const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
  const version = desiredProspectorVersion();
  const tools = new ToolExecutor(
    createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: { endpoint: null } }),
    parseToolPolicy(version.configuration),
    { tenantId: 'publiexpe', executionId: 'exec-25', agentId: 'agent-1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const ctx: AgentContext = {
    tenantId: 'publiexpe',
    executionId: 'exec-25',
    agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
    version: { id: 'v25', version: 25, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
    input,
    provider,
    signal: new AbortController().signal,
    tools,
  };
  return { ctx, agent: new ProspectorAgent(() => TODAY) };
}

const fairSignal = (fake: FakeTwenty, name: string, status: string, eventDate: string, url: string, extra: Record<string, unknown> = {}) =>
  fake.seed('commercialSignals', {
    name,
    signalType: 'FAIR',
    status,
    eventDate,
    sourceUrl: { primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] },
    sourceDomain: new URL(url).hostname.replace(/^www\./, ''),
    companyId: null,
    tenantId: 'publiexpe',
    ...extra,
  });

describe('scout: dedupe of fairs by normalized name before creating the signal', () => {
  it('BWW (QUALIFIED, other domain) and HIP (DISCARDED) are not recorded again; a different fair is; one listing per run for all sectors', async () => {
    const fake = new FakeTwenty();
    // Recorded earlier from another source (so the domain + date idempotency of create_signal would not catch it).
    fairSignal(fake, 'Barcelona Wine Week 2027 (feria)', 'QUALIFIED', '2027-02-01', 'https://www.fira.example/bww');
    fairSignal(fake, 'HIP - Horeca Professional Expo 2027 (feria)', 'DISCARDED', '2027-02-23', 'https://www.ifema.example/hip');
    // Another tenant's identical fair is never seen.
    fairSignal(fake, 'Gourmets Barcelona 2027 (feria)', 'NEW', '2027-03-15', 'https://www.otro.example/g', { tenantId: 'otro' });
    const { ctx, agent } = setup(
      [fairSearch([BWW_EVENT, GOURMETS_EVENT], [BWW_SOURCE, GOURMETS_SOURCE]), fairSearch([HIP_EVENT, BWW_EVENT], [HIP_SOURCE, BWW_SOURCE])],
      { sectors: ['alimentación y bebidas', 'hostelería'], region: 'España', horizon_months: 6, discover_only: true, max_events: 3 },
      fake,
    );
    const result = await agent.run(ctx);
    const out = result.output as Record<string, any>;

    const mine = fake.tables.commercialSignals!.filter((s) => s.tenantId === 'publiexpe').map((s) => s.name).sort();
    expect(mine).toEqual(['Barcelona Wine Week 2027 (feria)', 'Gourmets Barcelona 2027 (feria)', 'HIP - Horeca Professional Expo 2027 (feria)']);
    // The existing ones are untouched (no status reopened).
    expect(fake.tables.commercialSignals!.find((s) => s.name === 'HIP - Horeca Professional Expo 2027 (feria)')!.status).toBe('DISCARDED');

    expect(out.counters).toMatchObject({ event_signals_created: 1, events_duplicated_by_name: 3 });
    // The stub answers in run order (the sector order rotates every week).
    expect(out.sectors[0]).toMatchObject({ fair_signals_created: 1, fairs_duplicated_by_name: 1 });
    expect(out.sectors[1]).toMatchObject({ fair_signals_created: 0, fairs_duplicated_by_name: 2 });
    const summary = String(fake.tables.agentRunSummaries![0]!.resultSummary);
    expect(summary).toContain('ya en el CRM con otro nombre 3');
    const dups = out.sector_runs.flatMap((r: any) => r.discarded_events.filter((d: any) => d.reason === 'duplicada_por_nombre'));
    expect(dups.map((d: any) => [d.name, d.duplicate_of.name, d.duplicate_of.status]).sort()).toEqual([
      ['Barcelona Wine Week (BWW) 2027', 'Barcelona Wine Week 2027 (feria)', 'QUALIFIED'],
      ['Barcelona Wine Week (BWW) 2027', 'Barcelona Wine Week 2027 (feria)', 'QUALIFIED'],
      ['HIP – Horeca Professional Expo 2027', 'HIP - Horeca Professional Expo 2027 (feria)', 'DISCARDED'],
    ]);
    // A duplicate is not even fetched.
    expect(result.steps.filter((s) => s.tool === 'fetch_url').map((s) => (s.toolInput as { url: string }).url)).toEqual(['https://www.gourmets.net/barcelona']);
    expect(result.steps.filter((s) => s.tool === 'list_event_signals')).toHaveLength(1);
  });

  it('a fair recorded earlier in the same run is compared too (the second spelling in the next sector is dropped)', async () => {
    const fake = new FakeTwenty();
    const { ctx, agent } = setup(
      [fairSearch([{ ...BWW_EVENT, name: 'Barcelona Wine Week 2027' }], [BWW_SOURCE]), fairSearch([{ ...BWW_EVENT, website_url: 'https://www.barcelonawineweek.com/es/' }], [BWW_SOURCE])],
      { sectors: ['alimentación y bebidas', 'hostelería'], region: 'España', horizon_months: 6, discover_only: true },
      fake,
    );
    const out = (await agent.run(ctx)).output as Record<string, any>;
    expect(fake.tables.commercialSignals!.map((s) => s.name)).toEqual(['Barcelona Wine Week 2027 (feria)']);
    expect(out.counters).toMatchObject({ event_signals_created: 1, events_duplicated_by_name: 1 });
  });

  it('when the listing fails the fair is still recorded (the other dedupes apply) and the run says so', async () => {
    const fake = new FakeTwenty();
    // Twenty refuses the listing (status filter); the other requests go through.
    const original = fake.fetch;
    fake.fetch = async (input, init) => {
      const u = new URL(String(input));
      if ((init?.method ?? 'GET') === 'GET' && u.pathname.startsWith('/rest/commercialSignals') && (u.searchParams.get('filter') ?? '').includes('status[eq]')) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return original(input, init);
    };
    const { ctx, agent } = setup([fairSearch([BWW_EVENT], [BWW_SOURCE])], { sector: 'alimentación y bebidas', region: 'España', horizon_months: 6, discover_only: true }, fake);
    const out = (await agent.run(ctx)).output as Record<string, any>;
    expect(fake.tables.commercialSignals!.map((s) => s.name)).toEqual(['Barcelona Wine Week (BWW) 2027 (feria)']);
    expect(out.fair_name_dedupe).toMatchObject({ checked: false });
    expect(out.fair_name_dedupe.error).toBeTruthy();
  });
});
