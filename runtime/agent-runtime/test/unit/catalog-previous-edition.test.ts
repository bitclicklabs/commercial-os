/**
 * Catalog of a past edition (tanda 20, knowledge entry `catalogo-edicion-anterior`): when the
 * exhibitor list read is of an edition already held and the signal is for the next one, the
 * fair ends by code, before the per-exhibitor evaluations. StubProvider + FakeWeb + FakeTwenty.
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { catalogPreviousEdition } from '../../src/agents/event-scout.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

const TODAY = '2026-10-16';

describe('catalogPreviousEdition (pure)', () => {
  const pages = [{ url: 'https://www.expohip.com/expositores', title: 'Expositores' }];
  it('page dates: all past and >= 90 days before the signal -> previous edition', () => {
    expect(catalogPreviousEdition({ signalDate: '2027-03-01', today: TODAY, catalogDates: ['2026-02-16'], pages })).toMatchObject({
      previous: true,
      catalogDate: '2026-02-16',
      catalogYear: 2026,
      evidence: 'page_date',
    });
    // The catalog of the target edition, or a mix with it: not previous.
    expect(catalogPreviousEdition({ signalDate: '2027-03-01', today: TODAY, catalogDates: ['2027-03-01'], pages }).previous).toBe(false);
    expect(catalogPreviousEdition({ signalDate: '2027-03-01', today: TODAY, catalogDates: ['2026-02-16', '2027-03-01'], pages }).previous).toBe(false);
    // A future date far before the signal is not "already held".
    expect(catalogPreviousEdition({ signalDate: '2027-09-01', today: TODAY, catalogDates: ['2026-12-01'], pages }).previous).toBe(false);
    // The signal itself is past: nothing to compare against.
    expect(catalogPreviousEdition({ signalDate: '2026-02-16', today: TODAY, catalogDates: ['2025-02-16'], pages }).previous).toBe(false);
  });

  it('without page dates, the years in the URL / title of the list pages decide', () => {
    expect(catalogPreviousEdition({ signalDate: '2027-02-02', today: TODAY, catalogDates: [], pages: [{ url: 'https://feria.example/2026/expositores', title: 'Expositores' }] })).toMatchObject({
      previous: true,
      catalogYear: 2026,
      evidence: 'url_year',
    });
    expect(catalogPreviousEdition({ signalDate: '2027-02-02', today: TODAY, catalogDates: [], pages: [{ url: 'https://feria.example/expositores', title: 'Expositores 2027' }] }).previous).toBe(false);
    expect(catalogPreviousEdition({ signalDate: '2027-02-02', today: TODAY, catalogDates: [], pages: [{ url: 'https://feria.example/expositores', title: 'Expositores' }] }).previous).toBe(false);
  });
});

describe('scout: catalog of a previous edition', () => {
  const CATALOG = 'https://www.expohip.com/expositores';
  const names = ['Cafés Uno', 'Bodega Dos', 'Hornos Tres'];
  const web = () =>
    new FakeWeb().page(CATALOG, `<html><head><title>HIP - Expositores</title></head><body><h1>Expositores</h1><ul>${names.map((n) => `<li>${n}</li>`).join('')}</ul></body></html>`);
  const extract = (start: string) =>
    JSON.stringify({
      page_kind: 'exhibitor_list',
      event: { name: 'HIP', start_date: start, end_date: start, city: 'Madrid' },
      exhibitors: names.map((name) => ({ name, domain: null, description: null, sector: null })),
      exhibitors_page_url: null,
      notes: null,
    });
  const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.1, reason: 'Sin encaje.', hypothesis: null });

  function setup(responses: string[], input: Record<string, unknown>) {
    const fake = new FakeTwenty();
    const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
    const version = desiredProspectorVersion();
    const tools = new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client(), web: web().deps(), render: { endpoint: null } }),
      parseToolPolicy(version.configuration),
      { tenantId: 'publiexpe', executionId: 'exec-pe', agentId: 'agent-1', stage: 'PROSPECTOR' },
      new AbortController().signal,
    );
    const ctx: AgentContext = {
      tenantId: 'publiexpe',
      executionId: 'exec-pe',
      agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
      version: { id: 'v9', version: 9, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
      input,
      provider,
      signal: new AbortController().signal,
      tools,
    };
    return { fake, provider, agent: new ProspectorAgent(() => new Date(`${TODAY}T08:00:00Z`)), ctx };
  }

  it('signal HIP 2027 and list of HIP 2026: no exhibitor is evaluated, the fair ends with a citable reason, the run is not PARTIAL', async () => {
    const { fake, provider, agent, ctx } = setup([extract('2026-02-16')], { event_url: CATALOG, event_name: 'HIP 2027', event_date: '2027-03-01', max_events: 1 });
    const out = (await agent.run(ctx)).output as {
      outcome: string;
      counters: Record<string, number>;
      events: Array<{ status: string; reason: string; date: string; results: unknown[]; previous_edition: Record<string, unknown>; exhibitors_skipped_previous_edition: number }>;
      partial_reasons: string[];
    };
    // Only the extraction: zero evaluations.
    expect(provider.requests).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev).toMatchObject({
      status: 'catalog_previous_edition',
      date: '2027-03-01',
      results: [],
      exhibitors_skipped_previous_edition: 3,
      previous_edition: { catalog_date: '2026-02-16', catalog_year: 2026, signal_date: '2027-03-01', evidence: 'page_date' },
    });
    expect(ev.reason).toContain('edición del 2026-02-16');
    expect(ev.reason).toContain(CATALOG);
    expect(out.counters).toMatchObject({ events_previous_edition: 1, exhibitors_skipped_previous_edition: 3, exhibitors_read: 3, evaluated: 0 });
    expect(out.outcome).toBe('SUCCESS');
    expect(out.partial_reasons).toEqual([]);
    expect(fake.tables.companies).toHaveLength(0);
    expect(fake.tables.commercialSignals).toHaveLength(0);
    // The commercial summary in Twenty says why.
    expect(String(fake.tables.agentRunSummaries[0]!.resultSummary)).toContain('catálogo de una edición anterior: 3 expositores sin evaluar');
  });

  it('the catalog of the target edition is evaluated as before', async () => {
    const { provider, agent, ctx } = setup([extract('2027-03-01'), IRRELEVANT, IRRELEVANT, IRRELEVANT], { event_url: CATALOG, event_name: 'HIP 2027', event_date: '2027-03-01', max_events: 1 });
    const out = (await agent.run(ctx)).output as { events: Array<{ status: string }>; counters: Record<string, number> };
    expect(provider.requests).toHaveLength(4);
    expect(out.events[0]!.status).toBe('exhibitors_processed');
    expect(out.counters).toMatchObject({ events_previous_edition: 0, evaluated: 3 });
  });

  it('without the signal date (manual / weekly scout) nothing is cut', async () => {
    const { provider, agent, ctx } = setup([extract('2026-02-16'), IRRELEVANT, IRRELEVANT, IRRELEVANT], { event_url: CATALOG });
    const out = (await agent.run(ctx)).output as { events: Array<{ status: string }> };
    expect(provider.requests).toHaveLength(4);
    expect(out.events[0]!.status).toBe('exhibitors_processed');
  });
});
