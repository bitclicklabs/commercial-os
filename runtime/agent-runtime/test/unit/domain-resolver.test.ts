/**
 * Domain resolver (tanda 20): name -> verified website for the relevant exhibitors without a
 * domain. Pure heuristics (name normalisation, brand checks, denylist, ambiguity) and runs of
 * the Prospector (direct and scout modes) with StubProvider (scripted grounding), FakeWeb and
 * FakeTwenty. Nothing leaves the process.
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import {
  companyNameTokens,
  decideResolution,
  domainMatchesName,
  domainResolverConfigFromEnv,
  groundingCandidates,
  isDeniedForResolver,
  legalNoticeLink,
  pageCorroboratesBrand,
  parseDomainProposal,
  type DomainCandidate,
} from '../../src/agents/domain-resolver.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import type { GroundingSource } from '../../src/providers/model-provider.js';
import { StubProvider, type StubResponse } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

// ---------------------------------------------------------------------------
// Pure heuristics
// ---------------------------------------------------------------------------

describe('domain-resolver heuristics', () => {
  it('companyNameTokens: case, accents, punctuation and legal forms (also spaced) are removed; generic words are not distinctive', () => {
    expect(companyNameTokens('Bodegas Emilio Moro, S.L.')).toEqual({ tokens: ['bodegas', 'emilio', 'moro'], distinctive: ['emilio', 'moro'] });
    expect(companyNameTokens('CONSERVAS ORTIZ S. A. U.')).toEqual({ tokens: ['conservas', 'ortiz'], distinctive: ['ortiz'] });
    expect(companyNameTokens('Käsehaus Müller GmbH').tokens).toEqual(['kasehaus', 'muller']);
    expect(companyNameTokens('Vicente Gandía Pla S.A.').distinctive).toEqual(['vicente', 'gandia', 'pla']);
    expect(companyNameTokens('Grupo Mahou-San Miguel').distinctive).toEqual(['mahou', 'san', 'miguel']);
    // Too generic to verify anything.
    expect(companyNameTokens('Vinos de España, S.L.').distinctive).toEqual([]);
  });

  it('domainMatchesName: the domain label carries the (distinctive) name; a short piece of it is not enough', () => {
    expect(domainMatchesName('emiliomoro.com', 'Bodegas Emilio Moro S.L.')).toBe(true);
    expect(domainMatchesName('bodegasemiliomoro.es', 'Bodegas Emilio Moro S.L.')).toBe(true);
    expect(domainMatchesName('www.conservasortiz.com', 'Conservas Ortiz S.A.')).toBe(true);
    expect(domainMatchesName('mahou-sanmiguel.com', 'Grupo Mahou San Miguel')).toBe(true);
    expect(domainMatchesName('vicentegandia.es', 'Vicente Gandía')).toBe(true);
    expect(domainMatchesName('shop.vicentegandia.com', 'VICENTE GANDÍA')).toBe(true);
    // A piece too short of the name, or another brand.
    expect(domainMatchesName('moro.com', 'Bodegas Emilio Moro')).toBe(false);
    expect(domainMatchesName('vinoteca-online.es', 'Bodegas Emilio Moro')).toBe(false);
    expect(domainMatchesName('anything.es', 'Vinos de España')).toBe(false);
  });

  it('pageCorroboratesBrand: distinctive words in the title, or the name as consecutive words in the text', () => {
    expect(pageCorroboratesBrand('Bodegas Emilio Moro S.L.', { title: 'Emilio Moro | Ribera del Duero', text: '' })).toBe('title');
    expect(pageCorroboratesBrand('Bodegas Emilio Moro S.L.', { title: 'Inicio', text: 'Vinos.\n© 2026 BODEGAS EMILIO MORO, S.L. Todos los derechos reservados' })).toBe('text');
    expect(pageCorroboratesBrand('Conservas Ortiz', { title: 'Home', text: 'Nuestras conservas: Ortiz, desde 1891' })).toBe('text');
    // Words scattered over the page do not prove the brand.
    expect(pageCorroboratesBrand('Bodegas Emilio Moro', { title: 'Tienda de vinos', text: 'Emilio nos recomienda... el vino moro' })).toBeNull();
    expect(pageCorroboratesBrand('Vinos de España', { title: 'Vinos de España', text: 'Vinos de España' })).toBeNull();
  });

  it('isDeniedForResolver: social networks, marketplaces, directories, press, encyclopedias, fair calendars, government and the fair itself', () => {
    const fair = ['anugaselectiberica.com', 'ifema.es'];
    for (const d of [
      'facebook.com', 'es.linkedin.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com',
      'amazon.es', 'amazon.co.uk', 'alibaba.com', 'europages.es', 'kompass.com', 'paginasamarillas.es', 'einforma.com',
      'elpais.com', 'alimarket.es', 'es.wikipedia.org', '10times.com', 'nferias.com', 'vivino.com', 'wine-searcher.com',
      'www.anugaselectiberica.com', 'ifema.es', 'agricultura.gob.es', 'vertexaisearch.cloud.google.com',
    ]) {
      expect(isDeniedForResolver(d, fair), d).toBe(true);
    }
    expect(isDeniedForResolver('emiliomoro.com', fair)).toBe(false);
    expect(isDeniedForResolver('conservasortiz.com', fair)).toBe(false);
  });

  it('groundingCandidates: grounding domains only (registrable, deduplicated, search order); the proposal goes first only if grounded', () => {
    const src = (domain: string | null, n = 1): GroundingSource => ({ uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${n}`, title: domain, domain });
    const sources = [src('vivino.com', 1), src('tienda.emiliomoro.com', 2), src('emiliomoro.com', 3), src('facebook.com', 4), src(null, 5), src('otra-bodega.es', 6)];
    expect(groundingCandidates(sources, 'otra-bodega.es', [])).toEqual({
      domains: ['otra-bodega.es', 'emiliomoro.com'],
      excluded: ['vivino.com', 'facebook.com'],
      withoutDomain: [sources[4]],
    });
    // A proposal the search did not return is never a candidate.
    expect(groundingCandidates(sources, 'inventada.com', []).domains).toEqual(['emiliomoro.com', 'otra-bodega.es']);
    // The fair's own site is excluded.
    expect(groundingCandidates([src('expositores.feria.example')], null, ['feria.example'])).toMatchObject({ domains: [], excluded: ['feria.example'] });
  });

  it('decideResolution: one verified -> resolved; two verified or a name match left unproven -> ambiguous; else not found', () => {
    const c = (domain: string, status: DomainCandidate['status']): DomainCandidate => ({ domain, origin: 'grounding', status });
    expect(decideResolution([c('a.es', 'verified'), c('b.es', 'name_not_in_domain')])).toMatchObject({ status: 'domain_resolved', domain: 'a.es' });
    expect(decideResolution([c('a.es', 'verified'), c('a.es', 'verified')])).toMatchObject({ status: 'domain_resolved', domain: 'a.es' });
    expect(decideResolution([c('a.es', 'verified'), c('a.com', 'verified')])).toMatchObject({ status: 'domain_ambiguous', domain: null });
    expect(decideResolution([c('a.es', 'brand_not_on_page')])).toMatchObject({ status: 'domain_ambiguous' });
    expect(decideResolution([c('a.es', 'unreachable')])).toMatchObject({ status: 'domain_ambiguous' });
    expect(decideResolution([c('b.es', 'name_not_in_domain')])).toMatchObject({ status: 'domain_not_found' });
    expect(decideResolution([])).toMatchObject({ status: 'domain_not_found' });
  });

  it('legalNoticeLink: same-site "Aviso legal" link (not privacy / cookies)', () => {
    const links = [
      { url: 'https://www.bodegax.es/privacidad', text: 'Política de privacidad' },
      { url: 'https://otra.example/aviso-legal', text: 'Aviso legal' },
      { url: 'https://www.bodegax.es/aviso-legal', text: 'Aviso Legal' },
    ];
    expect(legalNoticeLink(links, 'https://bodegax.es/')).toBe('https://www.bodegax.es/aviso-legal');
    expect(legalNoticeLink([{ url: 'https://bodegax.es/legal-notice', text: '' }], 'https://bodegax.es/')).toBe('https://bodegax.es/legal-notice');
    expect(legalNoticeLink([{ url: 'https://bodegax.es/cookies', text: 'Cookies' }], 'https://bodegax.es/')).toBeNull();
  });

  it('parseDomainProposal is lenient (the proposal is only an ordering hint)', () => {
    expect(parseDomainProposal('{"website_url": "https://www.emiliomoro.com/es/"}')).toEqual({ ok: true, value: { proposed: 'emiliomoro.com' } });
    expect(parseDomainProposal('{"website_url": null}')).toEqual({ ok: true, value: { proposed: null } });
    expect(parseDomainProposal('No la encuentro')).toEqual({ ok: true, value: { proposed: null } });
  });

  it('domainResolverConfigFromEnv: enabled with 25 searches by default; capped at 50; false/0/off switch it off', () => {
    expect(domainResolverConfigFromEnv({})).toEqual({ enabled: true, maxPerRun: 25 });
    expect(domainResolverConfigFromEnv({ DOMAIN_RESOLVER_ENABLED: 'false', DOMAIN_RESOLVER_MAX_PER_RUN: '10' })).toEqual({ enabled: false, maxPerRun: 10 });
    expect(domainResolverConfigFromEnv({ DOMAIN_RESOLVER_ENABLED: 'off' }).enabled).toBe(false);
    expect(domainResolverConfigFromEnv({ DOMAIN_RESOLVER_MAX_PER_RUN: '999' }).maxPerRun).toBe(50);
    expect(domainResolverConfigFromEnv({ DOMAIN_RESOLVER_MAX_PER_RUN: 'abc' }).maxPerRun).toBe(25);
    expect(domainResolverConfigFromEnv({ DOMAIN_RESOLVER_MAX_PER_RUN: '0' }).maxPerRun).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prospector runs
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-10-16T08:00:00Z');
const relevant = (confidence = 0.8) =>
  JSON.stringify({
    relevant: true,
    confidence,
    reason: 'Bodega con stand propio.',
    hypothesis: {
      need: 'Regalo para visitantes del stand.',
      why_now: 'Expone en la feria.',
      quantity_min: 200,
      quantity_max: 500,
      budget_min_eur: 600,
      budget_max_eur: 2000,
      recommended_products: ['Bolsas tote'],
      timing: 'NEXT_QUARTER',
      differentiators: [],
    },
  });
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.1, reason: 'Organismo público.', hypothesis: null });
const src = (domain: string | null, n: number): GroundingSource => ({ uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/r${n}`, title: domain, domain });
const search = (sources: GroundingSource[], proposed: string | null = null): StubResponse => ({
  text: JSON.stringify({ website_url: proposed ? `https://${proposed}/` : null }),
  grounding: { queries: ['empresa web oficial'], sources },
});
const home = (title: string, body: string, links = '') => `<html><head><title>${title}</title></head><body>${body}${links}</body></html>`;

function setup(responses: Array<string | StubResponse>, opts: { input: Record<string, unknown>; web: FakeWeb; fake?: FakeTwenty; maxPerRun?: number }) {
  const fake = opts.fake ?? new FakeTwenty();
  const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
  const version = desiredProspectorVersion();
  const tools = new ToolExecutor(
    createDefaultToolRegistry({ twenty: fake.client(), web: opts.web.deps(), render: { endpoint: null } }),
    parseToolPolicy(version.configuration),
    { tenantId: 'publiexpe', executionId: 'exec-dr', agentId: 'agent-1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const ctx: AgentContext = {
    tenantId: 'publiexpe',
    executionId: 'exec-dr',
    agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
    version: { id: 'v9', version: 9, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
    input: opts.input,
    provider,
    signal: new AbortController().signal,
    tools,
  };
  const agent = new ProspectorAgent(() => TODAY, { domainResolver: { enabled: true, maxPerRun: opts.maxPerRun ?? 25 } });
  return { fake, provider, ctx, agent };
}

type Result = { name: string; status: string; domain: string | null; domain_resolution?: Record<string, unknown> & { domain_candidates?: Array<Record<string, unknown>> } };
type Out = { outcome: string; counters: Record<string, number>; results: Result[]; domain_resolver: Record<string, unknown>; events?: Array<{ results: Result[] }> };

const EVENT = { name: 'Barcelona Wine Week 2027', type: 'FAIR', date: '2027-02-02', location: 'Barcelona', source_url: 'https://www.barcelonawineweek.com/expositores' };

describe('domain resolver: direct mode', () => {
  it('resolves a unique verified site, leaves ties ambiguous (candidates listed) and directory-only results not found; irrelevant ones are never searched', async () => {
    const web = new FakeWeb()
      .page('https://emiliomoro.com/', home('Emilio Moro | Ribera del Duero', '<h1>Bodegas Emilio Moro</h1>'))
      .page('https://ambigua.es/', home('Celler Ambigua', '<p>Vinos</p>'))
      .page('https://ambigua.com/', home('Ambigua Wines', '<p>Wines</p>'));
    const { fake, provider, ctx, agent } = setup(
      [
        relevant(0.9),
        search([src('vivino.com', 1), src('emiliomoro.com', 2), src('facebook.com', 3), src('barcelonawineweek.com', 4)], 'emiliomoro.com'),
        relevant(0.8),
        search([src('ambigua.es', 5), src('ambigua.com', 6)]),
        relevant(0.7),
        search([src('europages.es', 7), src('es.wikipedia.org', 8), src('elpais.com', 9)]),
        IRRELEVANT,
      ],
      {
        web,
        input: { event: EVENT, exhibitors: [{ name: 'Bodegas Emilio Moro, S.L.' }, { name: 'Celler Ambigua' }, { name: 'Quesos Nadie Sabe' }, { name: 'Consorcio Público' }] },
      },
    );
    const result = await agent.run(ctx);
    const out = result.output as unknown as Out;
    const by = Object.fromEntries(out.results.map((r) => [r.name, r]));

    expect(by['Bodegas Emilio Moro, S.L.']).toMatchObject({
      status: 'hypothesis_created',
      domain: 'emiliomoro.com',
      domain_resolution: { status: 'domain_resolved', domain: 'emiliomoro.com', source_url: 'https://emiliomoro.com/', verified_by: 'title', excluded: ['vivino.com', 'facebook.com', 'barcelonawineweek.com'] },
    });
    expect(by['Celler Ambigua']).toMatchObject({ status: 'domain_ambiguous', domain: null, domain_resolution: { status: 'domain_ambiguous' } });
    expect(by['Celler Ambigua']!.domain_resolution!.domain_candidates!.map((c) => [c.domain, c.status])).toEqual([
      ['ambigua.es', 'verified'],
      ['ambigua.com', 'verified'],
    ]);
    expect(by['Quesos Nadie Sabe']).toMatchObject({ status: 'domain_not_found', domain_resolution: { status: 'domain_not_found', domain_candidates: [] } });
    expect(by['Consorcio Público']).toMatchObject({ status: 'discarded_irrelevant' });
    expect(by['Consorcio Público']!.domain_resolution).toBeUndefined();

    // 4 decisions + 3 grounded searches; the exhibitor name only inside an untrusted block.
    expect(provider.requests).toHaveLength(7);
    const searches = provider.requests.filter((r) => (r.options as { grounding?: boolean }).grounding === true);
    expect(searches).toHaveLength(3);
    const prompt = searches[0]!.messages[0]!.content;
    expect(prompt).toMatch(/<<<DATOS_NO_CONFIABLES id=\w+ [^>]*>>>\nEmpresa: Bodegas Emilio Moro, S.L.\nFeria: Barcelona Wine Week 2027\nPaís o localidad: Barcelona\n<<<FIN_DATOS_NO_CONFIABLES/);
    expect(searches[0]!.system).toContain('DATOS_NO_CONFIABLES');

    expect(out.counters).toMatchObject({ domain_lookups: 3, domains_resolved: 1, domains_resolved_by_search: 1, domain_ambiguous: 1, domain_not_found: 1, hypotheses_created: 1, skipped_no_domain: 0, errors: 0, llm_calls: 7 });
    expect(out.domain_resolver).toMatchObject({ enabled: true, max_per_run: 25, lookups: 3, resolved: 1, ambiguous: 1, not_found: 1 });
    expect(out.outcome).toBe('SUCCESS');

    // Twenty: ONE company (the relevant + verified one) with its domain; nothing for the doubtful ones.
    expect(fake.tables.companies.map((c) => [c.name, (c.domainName as { primaryLinkUrl: string }).primaryLinkUrl])).toEqual([['Bodegas Emilio Moro, S.L.', 'emiliomoro.com']]);
    expect(fake.tables.commercialHypotheses).toHaveLength(1);
    const evidence = JSON.stringify(fake.tables.commercialHypotheses[0]!.evidence);
    expect(evidence).toContain('localizada por búsqueda web y verificada');
    expect(evidence).toContain('https://emiliomoro.com/');
    expect(String(fake.tables.researches[0]!.summary)).toContain('Web: emiliomoro.com (localizada por búsqueda web y verificada en su propia web).');

    // Only the name-matching candidates were fetched: never the directories, the social networks or the fair.
    expect(web.requests.map((r) => r.url.toString()).sort()).toEqual(['https://ambigua.com/', 'https://ambigua.es/', 'https://emiliomoro.com/']);
    // Cost: every call (decisions + searches) is in the run.
    expect((result.output as { cost: { model: number } }).cost.model).toBeCloseTo(0.007, 6);
  });

  it('home without the brand: the legal notice linked from it corroborates it; a page that never shows the brand stays ambiguous', async () => {
    const web = new FakeWeb()
      .page('https://cafesbaque.com/', home('Inicio', '<p>Café de calidad.</p>', '<a href="/aviso-legal">Aviso legal</a>'))
      .page('https://cafesbaque.com/aviso-legal', home('Aviso legal', '<p>Titular: CAFÉS BAQUÉ, S.A. CIF A-00000000.</p>'))
      .page('https://torronsvicens.com/', home('Inicio', '<p>Turrones artesanos.</p>'));
    const { ctx, agent } = setup([relevant(), search([src('cafesbaque.com', 1)]), relevant(), search([src('torronsvicens.com', 2)])], {
      web,
      input: { event: EVENT, exhibitors: [{ name: 'Cafés Baqué S.A.' }, { name: 'Torrons Vicens' }] },
    });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.results[0]).toMatchObject({ status: 'hypothesis_created', domain: 'cafesbaque.com', domain_resolution: { status: 'domain_resolved', verified_by: 'legal_notice', source_url: 'https://cafesbaque.com/aviso-legal' } });
    expect(out.results[1]).toMatchObject({ status: 'domain_ambiguous', domain_resolution: { domain_candidates: [{ domain: 'torronsvicens.com', status: 'brand_not_on_page' }] } });
  });

  it('a candidate that resolves to a private address is refused by the fetch_url SSRF guard (never accepted)', async () => {
    const web = new FakeWeb().host('bodegainterna.es', '10.0.0.7');
    const { fake, ctx, agent } = setup([relevant(), search([src('bodegainterna.es', 1)])], { web, input: { event: EVENT, exhibitors: [{ name: 'Bodega Interna' }] } });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.results[0]).toMatchObject({ status: 'domain_ambiguous', domain_resolution: { domain_candidates: [{ domain: 'bodegainterna.es', status: 'unreachable', error: 'SSRF_BLOCKED' }] } });
    expect(fake.tables.companies).toHaveLength(0);
  });

  it('DOMAIN_RESOLVER_MAX_PER_RUN: once spent, the rest stay skipped_no_domain in list order (no search, retried next run)', async () => {
    const web = new FakeWeb().page('https://bodegauno.es/', home('Bodega Uno', ''));
    const { provider, ctx, agent } = setup([relevant(), search([src('bodegauno.es', 1)]), relevant(), relevant()], {
      web,
      maxPerRun: 1,
      input: { event: EVENT, exhibitors: [{ name: 'Bodega Uno' }, { name: 'Bodega Dos' }, { name: 'Bodega Tres' }] },
    });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.results.map((r) => [r.name, r.status, r.domain_resolution?.status])).toEqual([
      ['Bodega Uno', 'hypothesis_created', 'domain_resolved'],
      ['Bodega Dos', 'skipped_no_domain', 'budget_exhausted'],
      ['Bodega Tres', 'skipped_no_domain', 'budget_exhausted'],
    ]);
    expect(provider.requests.filter((r) => (r.options as { grounding?: boolean }).grounding === true)).toHaveLength(1);
    expect(out.counters).toMatchObject({ domain_lookups: 1, skipped_no_domain: 2 });
    expect(out.domain_resolver).toMatchObject({ skipped_budget: 2 });
  });

  it('an exact-name company already in Twenty is reused without searching; disabled resolver = previous behaviour', async () => {
    const fake = new FakeTwenty();
    fake.seed('companies', { name: 'Bodega Conocida', domainName: { primaryLinkUrl: 'bodegaconocida.es' } });
    const web = new FakeWeb();
    const { provider, ctx, agent } = setup([relevant()], { web, fake, input: { event: EVENT, exhibitors: [{ name: 'Bodega Conocida' }] } });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.results[0]).toMatchObject({ status: 'hypothesis_created', company_created: false, domain_resolution: { status: 'existing_company' } } as Record<string, unknown>);
    expect(provider.requests).toHaveLength(1);
    expect(web.requests).toHaveLength(0);

    const off = setup([relevant()], { web: new FakeWeb(), input: { event: EVENT, exhibitors: [{ name: 'Bodega Sin Web' }] } });
    const offAgent = new ProspectorAgent(() => TODAY, { domainResolver: { enabled: false, maxPerRun: 25 } });
    const offOut = (await offAgent.run(off.ctx)).output as unknown as Out;
    expect(offOut.results[0]).toMatchObject({ status: 'skipped_no_domain' });
    expect(offOut.results[0]!.domain_resolution).toBeUndefined();
    expect(off.provider.requests).toHaveLength(1);
  });
});

describe('domain resolver: scout mode', () => {
  const CATALOG = 'https://feria.example/expositores';
  const list = (names: string[]) => `<html><head><title>Expositores</title></head><body><h1>Expositores 2027</h1><ul>${names.map((n) => `<li>${n} - stand</li>`).join('')}</ul></body></html>`;
  const extract = (names: string[]) =>
    JSON.stringify({
      page_kind: 'exhibitor_list',
      event: { name: 'Feria Ejemplo 2027', start_date: '2027-03-10', end_date: '2027-03-12', city: 'Madrid' },
      exhibitors: names.map((name) => ({ name, domain: null, description: null, sector: null })),
      exhibitors_page_url: null,
      notes: null,
    });

  it('relevant exhibitors without a profile are resolved in catalog order; the verification page is a known source cited in Twenty', async () => {
    const web = new FakeWeb()
      .page(CATALOG, list(['Conservas Ortiz', 'Ayuntamiento X', 'Bodegas Torres']))
      .page('https://conservasortiz.com/', home('Conservas Ortiz | Desde 1891', ''))
      .page('https://torres.es/', home('Familia Torres', '<p>© Bodegas Torres S.A.</p>'));
    const { fake, provider, ctx, agent } = setup(
      [
        extract(['Conservas Ortiz', 'Ayuntamiento X', 'Bodegas Torres']),
        relevant(0.6), // Ortiz
        IRRELEVANT, // Ayuntamiento
        relevant(0.9), // Torres
        search([src('feria.example', 1), src('conservasortiz.com', 2)]),
        search([src('torres.es', 3), src('linkedin.com', 4)]),
      ],
      { web, input: { event_url: CATALOG, max_profile_lookups: 0 } },
    );
    const out = (await agent.run(ctx)).output as unknown as Out;
    const results = out.events![0]!.results;
    expect(results.map((r) => [r.name, r.status, r.domain])).toEqual([
      ['Conservas Ortiz', 'hypothesis_created', 'conservasortiz.com'],
      ['Ayuntamiento X', 'discarded_irrelevant', null],
      ['Bodegas Torres', 'hypothesis_created', 'torres.es'],
    ]);
    // Catalog order (Ortiz 0.6 before Torres 0.9), not confidence order.
    const searched = provider.requests.filter((r) => (r.options as { grounding?: boolean }).grounding === true).map((r) => /Empresa: (.+)/.exec(r.messages[0]!.content)?.[1]);
    expect(searched).toEqual(['Conservas Ortiz', 'Bodegas Torres']);
    expect(results[0]!.domain_resolution).toMatchObject({ status: 'domain_resolved', source_url: 'https://conservasortiz.com/', excluded: ['feria.example'] });
    expect(out.counters).toMatchObject({ domain_lookups: 2, domains_resolved: 2, domains_resolved_by_search: 2, domains_resolved_by_profile: 0, hypotheses_created: 2 });
    // The verification page is cited (it is a visited source of the run's ledger).
    const evidence = JSON.stringify(fake.tables.commercialHypotheses.map((h) => h.evidence));
    expect(evidence).toContain('https://torres.es/');
    expect(fake.tables.researches.find((r) => String(r.summary).startsWith('Bodegas Torres'))).toMatchObject({ sources: [CATALOG, 'https://torres.es/'] });
    expect(fake.tables.companies.map((c) => (c.domainName as { primaryLinkUrl: string }).primaryLinkUrl).sort()).toEqual(['conservasortiz.com', 'torres.es']);
  });
});
