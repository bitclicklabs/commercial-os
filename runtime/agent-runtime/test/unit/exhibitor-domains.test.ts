/**
 * Scout mode: paginated exhibitor lists and exhibitor profiles (website of the RELEVANT
 * exhibitors), with StubProvider, FakeWeb, FakeRenderer and FakeTwenty. Nothing leaves
 * the process.
 */
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import {
  extractProfileWebsite,
  findProfileLink,
  isExcludedDomain,
  paginationLinks,
  profileMatchesExhibitor,
  registrableDomain,
} from '../../src/agents/exhibitor-profile.js';
import { looksLikeExhibitorList } from '../../src/agents/event-scout.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import { StubProvider, type StubResponse } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeRenderer, type FakeRendered } from '../helpers/fake-renderer.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

const TODAY = new Date('2026-10-07T07:30:00Z');
const CATALOG = 'https://apps.feriavalencia.com/catalog/gastronoma/exhibitors';
const PROFILE = (id: number) => `${CATALOG}/${id}`;
/** Header + filters + footer of the real catalog render (the list alone would look like an empty render). */
const FRAME = ['Catálogo de expositores', 'Marketplace de productos', 'Login', 'ES', 'Buscar en Catálogo de expositores', 'Filtros', 'Sector', 'Actividad', 'Marca', 'Pabellón', 'País', 'Provincia', 'Nombre Sectores País', '2026 Feria Valencia todos los derechos reservados', 'Política de cookies', 'Política de privacidad', 'Aviso legal', ''].join('\n');
const SPA = '<!doctype html><html><head><title>es.prodevelop.feriavalencia.catalog</title><script src="/catalog/js/app.js"></script></head><body><div id="app"></div></body></html>';

const relevant = (confidence: number) =>
  JSON.stringify({
    relevant: true,
    confidence,
    reason: 'Marca con stand propio en la feria.',
    hypothesis: {
      need: 'Regalo para visitantes del stand.',
      why_now: 'Expone en la feria; el taller propio llega a tiempo.',
      quantity_min: 200,
      quantity_max: 500,
      budget_min_eur: 600,
      budget_max_eur: 2000,
      recommended_products: ['Bolsas tote'],
      timing: 'NEXT_QUARTER',
      differentiators: ['TALLER_PROPIO'],
    },
  });
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.2, reason: 'Organismo público.', hypothesis: null });
const extract = (exhibitors: string[]) =>
  JSON.stringify({
    page_kind: 'exhibitor_list',
    event: { name: 'Gastrónoma 2026', start_date: '2026-10-26', end_date: '2026-10-28', city: 'Valencia' },
    exhibitors: exhibitors.map((name) => ({ name, domain: null, description: null, sector: null })),
    exhibitors_page_url: null,
    notes: 'listado',
  });

/** One page of the rendered list: names + links "name -> /exhibitors/{id}" (logo links have no text). */
function listPage(entries: Array<[number, string]>): { text: string; links: Array<{ url: string; text: string }> } {
  return {
    text: entries.map(([, n]) => `${n}\nEspaña`).join('\n'),
    links: entries.flatMap(([id, n]) => [
      { url: PROFILE(id), text: '' },
      { url: PROFILE(id), text: n },
    ]),
  };
}

/** Rendered profile like Gastrónoma's: "Website" label, contact e-mail, similar companies. */
function profile(name: string, website: string | null, extra: { links?: Array<{ url: string; text: string }>; similar?: string } = {}): FakeRendered {
  return {
    title: `${name} | GASTRÕNOMA 2026`,
    text: [
      'Catálogo de expositores',
      'Inicio/Catálogo de expositores',
      name,
      'Alimentación / Food',
      'Información de contacto',
      `comercial@${website ?? 'gmail.com'}`,
      'Información del expositor',
      ...(website ? ['Website', '', `www.${website}`] : []),
      'Empresas similares en el sector',
      extra.similar ?? 'OTRA EMPRESA S.L.',
      'Política de cookies',
    ].join('\n'),
    links: [
      { url: `${CATALOG}`, text: 'Catálogo de expositores' },
      ...(website ? [{ url: `https://www.${website}/`, text: `www.${website}` }] : []),
      ...(extra.links ?? []),
      { url: PROFILE(99999), text: extra.similar ?? 'OTRA EMPRESA S.L.' },
    ],
  };
}

function setup(responses: Array<string | StubResponse>, opts: { input?: Record<string, unknown>; web?: FakeWeb; renderer?: FakeRenderer; scout?: Record<string, unknown> } = {}) {
  const fake = new FakeTwenty();
  const web = opts.web ?? new FakeWeb();
  const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
  const version = desiredProspectorVersion();
  const configuration = { ...version.configuration, ...(opts.scout ? { scout: { ...(version.configuration.scout as object), ...opts.scout } } : {}) };
  const tools = new ToolExecutor(
    createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: opts.renderer ? opts.renderer.deps() : { endpoint: null } }),
    parseToolPolicy(configuration),
    { tenantId: 'publiexpe', executionId: 'exec-domains', agentId: 'agent-1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const ctx: AgentContext = {
    tenantId: 'publiexpe',
    executionId: 'exec-domains',
    agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
    version: { id: 'v5', version: 5, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration },
    input: opts.input ?? { event_url: CATALOG },
    provider,
    signal: new AbortController().signal,
    tools,
  };
  return { fake, web, provider, ctx, agent: new ProspectorAgent(() => TODAY) };
}

type Result = { name: string; status: string; domain: string | null; confidence?: number; profile?: Record<string, unknown> };
type Out = {
  outcome: string;
  counters: Record<string, number>;
  events: Array<{ catalog_pages: number; pages: Array<Record<string, unknown>>; results: Result[] }>;
  profiles: Record<string, unknown>;
  render: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('exhibitor-profile helpers', () => {
  it('registrableDomain / isExcludedDomain: fair sites, social networks and platforms are never a company domain', () => {
    expect(registrableDomain('apps.feriavalencia.com')).toBe('feriavalencia.com');
    expect(registrableDomain('www.bodega.com.es')).toBe('bodega.com.es');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    const fair = ['gastronoma.es', 'apps.feriavalencia.com'];
    expect(isExcludedDomain('feriavalencia.com', fair)).toBe(true);
    expect(isExcludedDomain('expositores.gastronoma.es', fair)).toBe(true);
    for (const d of ['facebook.com', 'es-es.facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'gmail.com', 'linktr.ee']) expect(isExcludedDomain(d, fair)).toBe(true);
    expect(isExcludedDomain('arcecarne.es', fair)).toBe(false);
  });

  it('paginationLinks: ?page=N, /page/N, offset and "Siguiente" links of the same site, best first', () => {
    const links = [
      { url: 'https://feria.example/expositores?page=3', text: '3' },
      { url: 'https://feria.example/expositores?page=2', text: '2' },
      { url: 'https://feria.example/expositores?page=1', text: '1' },
      { url: 'https://feria.example/expositores?page=2&sector=vino', text: '2 (vino)' },
      { url: 'https://otra.example/expositores?page=2', text: '2' },
      { url: 'https://feria.example/noticias?page=2', text: '2' },
      { url: 'https://feria.example/expositores/lista-b', text: 'Siguiente' },
      { url: 'https://feria.example/expositores/ficha/7', text: 'Conservas Ortiz' },
    ];
    expect(paginationLinks(links, 'https://feria.example/expositores?page=1')).toEqual([
      'https://feria.example/expositores?page=2',
      'https://feria.example/expositores?page=3',
      'https://feria.example/expositores/lista-b',
    ]);
    // Already-read pages are skipped.
    expect(paginationLinks(links, 'https://feria.example/expositores', (u) => u.endsWith('page=2'))[0]).toBe('https://feria.example/expositores?page=3');
    expect(paginationLinks([{ url: 'https://blog.example/expositores/page/3/', text: '3' }, { url: 'https://blog.example/expositores/page/2/', text: '2' }], 'https://blog.example/expositores/')).toEqual([
      'https://blog.example/expositores/page/2/',
      'https://blog.example/expositores/page/3/',
    ]);
    expect(paginationLinks([{ url: 'https://f.example/l?offset=20', text: '»' }, { url: 'https://f.example/l?offset=0', text: '«' }], 'https://f.example/l')).toEqual(['https://f.example/l?offset=20']);
    // Profile links of a client-side paginated catalog are not pagination.
    expect(paginationLinks(listPage([[1, 'A'], [2, 'B']]).links, CATALOG)).toEqual([]);
  });

  it('findProfileLink: the same-site link whose text is the exhibitor name (logo links without text are ignored)', () => {
    const page = { finalUrl: CATALOG, links: [...listPage([[36175, 'ARCECARNE'], [36190, 'AYWA SERVICIOS AMBIENTALES, S. L. TUAWA']]).links, { url: 'https://www.cervezasturia.com/', text: 'CERVEZAS TURIA' }] };
    expect(findProfileLink('Arcecarne', page)).toBe(PROFILE(36175));
    expect(findProfileLink('AYWA SERVICIOS AMBIENTALES, S. L. TUAWA', page)).toBe(PROFILE(36190));
    // A link to another site is not a profile.
    expect(findProfileLink('CERVEZAS TURIA', page)).toBeNull();
    expect(findProfileLink('NO ESTÁ', page)).toBeNull();
  });

  it('extractProfileWebsite: "Website" label first; social networks kept apart; fair links and e-mail domains never used', () => {
    const p = profile('ARCECARNE', 'arcecarne.es', {
      links: [
        { url: 'https://www.facebook.com/arcecarne', text: 'Facebook' },
        { url: 'https://www.instagram.com/arcecarne/', text: 'Instagram' },
        { url: 'https://www.linkedin.com/company/arcecarne', text: '' },
        { url: 'https://www.feriavalencia.com/', text: 'Feria Valencia' },
        { url: 'https://www.otra-empresa.es/', text: 'OTRA EMPRESA' },
      ],
    });
    const w = extractProfileWebsite({ finalUrl: PROFILE(36175), text: p.text, links: p.links! }, ['gastronoma.es', 'apps.feriavalencia.com']);
    expect(w).toMatchObject({ domain: 'arcecarne.es', source: 'label' });
    expect(w.social).toEqual({ facebook: 'https://www.facebook.com/arcecarne', instagram: 'https://www.instagram.com/arcecarne/', linkedin: 'https://www.linkedin.com/company/arcecarne' });
    expect(w.excluded).toContain('feriavalencia.com');

    // No label: the only external link.
    const single = extractProfileWebsite({ finalUrl: PROFILE(1), text: 'BODEGA X\nContacto', links: [{ url: 'https://www.bodegax.com/es/', text: 'Visitar' }, { url: 'https://facebook.com/bodegax', text: 'fb' }] }, []);
    expect(single).toMatchObject({ domain: 'bodegax.com', source: 'single_link', social: { facebook: 'https://facebook.com/bodegax' } });

    // Two external links and no label: ambiguous, no domain.
    const two = extractProfileWebsite({ finalUrl: PROFILE(1), text: 'BODEGA X', links: [{ url: 'https://a-uno.com/', text: 'a' }, { url: 'https://b-dos.com/', text: 'b' }] }, []);
    expect(two).toMatchObject({ domain: null, candidates: ['a-uno.com', 'b-dos.com'] });

    // Only the fair's own site, social networks and an e-mail: no company domain at all.
    const onlyFair = extractProfileWebsite(
      { finalUrl: PROFILE(1), text: 'BODEGA X\ninfo@bodegax-mail.com\nWeb: www.gastronoma.es', links: [{ url: 'https://www.gastronoma.es/', text: 'Gastrónoma' }, { url: 'https://instagram.com/bx', text: 'ig' }] },
      ['gastronoma.es'],
    );
    expect(onlyFair).toMatchObject({ domain: null, social: { instagram: 'https://instagram.com/bx' } });

    // Text only: the only www. domain written in the profile.
    expect(extractProfileWebsite({ finalUrl: PROFILE(1), text: 'BODEGA X\nVisítanos en www.bodegax.es', links: [] }, [])).toMatchObject({ domain: 'bodegax.es', source: 'text' });
  });

  it('profileMatchesExhibitor: the name must be in the profile itself, not only under "Empresas similares"', () => {
    const p = profile('ARCECARNE', 'arcecarne.es', { similar: 'MENU IBERIA, S.L.' });
    expect(profileMatchesExhibitor('ARCECARNE', p.text)).toBe(true);
    expect(profileMatchesExhibitor('MENU IBERIA, S.L.', p.text)).toBe(false);
  });

  it('looksLikeExhibitorList: only list-like URLs are rendered with pagination', () => {
    expect(looksLikeExhibitorList(CATALOG)).toBe(true);
    expect(looksLikeExhibitorList('https://feria.example/expositores-2027')).toBe(true);
    expect(looksLikeExhibitorList('https://www.gastronoma.es/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scout runs
// ---------------------------------------------------------------------------

describe('scout: client-side paginated catalog + exhibitor profiles', () => {
  const page1 = listPage([
    [1, 'ARCECARNE'],
    [2, 'AYUNTAMIENTO DE PRUEBA'],
  ]);
  const page2 = listPage([
    [3, 'CERVEZAS TURIA'],
    [4, 'FERIA SOLO REDES'],
  ]);
  const page3 = listPage([[5, 'MENU IBERIA, S.L.']]);

  function catalog(rendererExtra: (r: FakeRenderer) => FakeRenderer = (r) => r) {
    const web = new FakeWeb().page(CATALOG, SPA).host('nodns.example');
    const renderer = rendererExtra(
      new FakeRenderer()
        .page(CATALOG, { title: 'Catálogo de expositores', text: FRAME + page1.text, links: page1.links, nextPages: [page2, page3] })
        .page(PROFILE(1), profile('ARCECARNE', 'arcecarne.es', { links: [{ url: 'https://www.facebook.com/arcecarne', text: 'Facebook' }] }))
        .page(PROFILE(3), profile('CERVEZAS TURIA', 'cervezasturia.com'))
        .page(PROFILE(4), profile('FERIA SOLO REDES', null, { links: [{ url: 'https://www.instagram.com/solo_redes/', text: 'Instagram' }, { url: 'https://www.feriavalencia.com/', text: 'Feria Valencia' }] }))
        .page(PROFILE(5), profile('MENU IBERIA, S.L.', 'nodns.example')),
    );
    return { web, renderer };
  }

  // Extraction (one call: the 3 pages come in one render), then one decision per exhibitor in list order.
  const responses = [
    extract(['ARCECARNE', 'AYUNTAMIENTO DE PRUEBA', 'CERVEZAS TURIA', 'FERIA SOLO REDES', 'MENU IBERIA, S.L.']),
    relevant(0.7), // ARCECARNE
    IRRELEVANT, // AYUNTAMIENTO
    relevant(0.9), // CERVEZAS TURIA
    relevant(0.8), // FERIA SOLO REDES
    relevant(0.6), // MENU IBERIA
  ];

  it('reads 3 list pages in ONE render, evaluates everyone first, opens profiles only of the relevant ones (best first), then writes', async () => {
    const { web, renderer } = catalog();
    const { fake, ctx, agent, provider } = setup(responses, { web, renderer });
    const result = await agent.run(ctx);
    const out = result.output as unknown as Out;

    // The list render asks for client-side pagination; the irrelevant exhibitor's profile is never opened.
    expect(renderer.requests.map((r) => [r.url, r.max_pages ?? null])).toEqual([
      [CATALOG, 10],
      [PROFILE(3), null], // 0.9
      [PROFILE(4), null], // 0.8
      [PROFILE(1), null], // 0.7
      [PROFILE(5), null], // 0.6
    ]);
    expect(provider.requests).toHaveLength(6);
    expect(provider.requests[0]!.messages[0]!.content).toContain('extrae los expositores de todas');

    // Cost order: every LLM decision before the first profile render, every profile before the first CRM write.
    const steps = result.steps;
    const lastDecision = steps.map((s, i) => (s.type === 'MODEL' && (s.input as Record<string, unknown>).exhibitor ? i : -1)).reduce((a, b) => Math.max(a, b));
    const profileRenders = steps.map((s, i) => (s.tool === 'render_url' && String((s.toolInput as { url: string }).url).match(/exhibitors\/\d+$/) ? i : -1)).filter((i) => i >= 0);
    const firstWrite = steps.findIndex((s) => s.tool === 'upsert_company' || s.tool === 'find_company');
    expect(lastDecision).toBeLessThan(Math.min(...profileRenders));
    expect(Math.max(...profileRenders)).toBeLessThan(firstWrite);

    const ev = out.events[0]!;
    expect(ev.catalog_pages).toBe(3);
    expect(ev.pages.find((p) => p.via === 'render')).toMatchObject({ list_pages: 3, exhibitors_verified: 5 });
    const byName = Object.fromEntries(ev.results.map((r) => [r.name, r]));
    expect(byName['ARCECARNE']).toMatchObject({ status: 'hypothesis_created', domain: 'arcecarne.es', profile: { status: 'domain_resolved', via: 'render', domain_source: 'label', social: { facebook: 'https://www.facebook.com/arcecarne' } } });
    expect(byName['CERVEZAS TURIA']).toMatchObject({ status: 'hypothesis_created', domain: 'cervezasturia.com' });
    expect(byName['AYUNTAMIENTO DE PRUEBA']).toMatchObject({ status: 'discarded_irrelevant' });
    expect(byName['AYUNTAMIENTO DE PRUEBA']!.profile).toBeUndefined();
    // Only social networks and the fair's own site in the profile: no domain, nothing created.
    expect(byName['FERIA SOLO REDES']).toMatchObject({ status: 'skipped_no_domain', domain: null, profile: { status: 'no_website', social: { instagram: 'https://www.instagram.com/solo_redes/' } } });
    // A domain that does not resolve is refused.
    expect(byName['MENU IBERIA, S.L.']).toMatchObject({ status: 'skipped_no_domain', profile: { status: 'domain_rejected', domain: 'nodns.example', error: 'DNS_ERROR' } });

    expect(out.counters).toMatchObject({ catalog_pages: 3, profile_lookups: 4, domains_resolved: 2, domain_checks: 3, profile_renders: 4, relevant: 4, hypotheses_created: 2, skipped_no_domain: 2 });
    // Profile renders do not use the catalog render budget (max_renders 4).
    expect(out.render).toMatchObject({ catalog_calls: 1, profile_calls: 4 });

    // Twenty: 2 real companies with their own domain, each with a FAIR signal and a PROPOSED hypothesis citing the profile.
    expect(fake.tables.companies.map((c) => (c.domainName as { primaryLinkUrl: string }).primaryLinkUrl).sort()).toEqual(['arcecarne.es', 'cervezasturia.com']);
    expect(fake.tables.commercialSignals.map((s) => [s.signalType, (s.sourceUrl as { primaryLinkUrl: string }).primaryLinkUrl])).toEqual([
      ['FAIR', CATALOG],
      ['FAIR', CATALOG],
    ]);
    expect(fake.tables.commercialHypotheses.map((h) => h.status)).toEqual(['PROPOSED', 'PROPOSED']);
    const evidence = JSON.stringify(fake.tables.commercialHypotheses.map((h) => h.evidence));
    expect(evidence).toContain(PROFILE(1));
    expect(evidence).toContain('tomada de la ficha del expositor');
    // Domain checks went to the company home pages, never to the social networks.
    expect(web.requests.map((r) => r.url.hostname).sort()).toEqual(['apps.feriavalencia.com', 'arcecarne.es', 'cervezasturia.com']);
  });

  it('max_profile_lookups caps the profiles opened: the most confident relevant exhibitor goes first, the rest stay skipped_no_domain', async () => {
    const { web, renderer } = catalog();
    const { fake, ctx, agent } = setup(responses, { web, renderer, input: { event_url: CATALOG, max_profile_lookups: 1 } });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(renderer.requests.map((r) => r.url)).toEqual([CATALOG, PROFILE(3)]);
    const byName = Object.fromEntries(out.events[0]!.results.map((r) => [r.name, r]));
    expect(byName['CERVEZAS TURIA']).toMatchObject({ status: 'hypothesis_created', domain: 'cervezasturia.com' });
    for (const n of ['ARCECARNE', 'FERIA SOLO REDES', 'MENU IBERIA, S.L.']) expect(byName[n]).toMatchObject({ status: 'skipped_no_domain', profile: { status: 'budget_exhausted' } });
    expect(out.counters).toMatchObject({ profile_lookups: 1, domains_resolved: 1 });
    expect(fake.tables.companies).toHaveLength(1);
  });

  it('max_catalog_pages = 1: no pagination asked; max_profile_lookups = 0: no profile opened (tanda 4 behaviour)', async () => {
    const { web, renderer } = catalog();
    const { fake, ctx, agent } = setup([extract(['ARCECARNE', 'AYUNTAMIENTO DE PRUEBA']), relevant(0.7), IRRELEVANT], {
      web,
      renderer,
      input: { event_url: CATALOG, max_catalog_pages: 1, max_profile_lookups: 0 },
    });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(renderer.requests).toEqual([{ url: CATALOG, max_chars: 40_000, min_text_chars: 300, capture_json: true }]);
    expect(out.events[0]!.results.map((r) => [r.name, r.status])).toEqual([
      ['ARCECARNE', 'skipped_no_domain'],
      ['AYUNTAMIENTO DE PRUEBA', 'discarded_irrelevant'],
    ]);
    expect(out.counters).toMatchObject({ catalog_pages: 1, profile_lookups: 0 });
    expect(fake.tables.companies).toHaveLength(0);
  });

  it('a renderer without pagination support (no pages_read) still works with the first page', async () => {
    const web = new FakeWeb().page(CATALOG, SPA);
    const renderer = new FakeRenderer().page(CATALOG, { text: FRAME + page1.text, links: page1.links, nextPages: [page2], legacy: true }).page(PROFILE(1), profile('ARCECARNE', 'arcecarne.es'));
    const { ctx, agent } = setup([extract(['ARCECARNE', 'AYUNTAMIENTO DE PRUEBA']), relevant(0.7), IRRELEVANT], { web, renderer });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.events[0]!.catalog_pages).toBe(1);
    expect(out.events[0]!.results[0]).toMatchObject({ name: 'ARCECARNE', status: 'hypothesis_created', domain: 'arcecarne.es' });
  });

  it('a profile that is about another company (name only under "Empresas similares") is not used', async () => {
    const { web, renderer } = catalog((r) => r.page(PROFILE(1), profile('OTRA COSA S.A.', 'otracosa.es', { similar: 'ARCECARNE' })));
    const { ctx, agent } = setup([extract(['ARCECARNE']), relevant(0.7)], { web, renderer });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.events[0]!.results[0]).toMatchObject({ status: 'skipped_no_domain', profile: { status: 'profile_mismatch' } });
  });
});

describe('scout: static catalog with link pagination and static profiles', () => {
  const html = (title: string, rows: Array<[string, string]>, next: string | null) =>
    `<html><head><title>${title}</title></head><body><h1>Expositores 2027</h1><ul>${rows.map(([n, href]) => `<li><a href="${href}">${n}</a> - stand</li>`).join('')}</ul>${next ? `<a href="${next}">Siguiente</a>` : ''}</body></html>`;

  it('follows "Siguiente" links up to max_catalog_pages, and reads static profiles with fetch_url (no render)', async () => {
    const web = new FakeWeb()
      .page('https://feria.example/expositores', html('Expositores', [['Conservas Ortiz', '/expositor/ortiz']], '/expositores?page=2'))
      .page('https://feria.example/expositores?page=2', html('Expositores p2', [['Bodegas Torres', '/expositor/torres']], '/expositores?page=3'))
      .page('https://feria.example/expositores?page=3', html('Expositores p3', [['Cafés Baqué', '/expositor/baque']], null))
      .page('https://feria.example/expositor/torres', '<html><body><h1>Bodegas Torres</h1><p>Vinos desde 1870.</p><p>Web: <a href="https://www.torres.es/">www.torres.es</a></p><a href="https://twitter.com/torres">Twitter</a></body></html>')
      .page('https://www.torres.es/', '<html><title>Torres</title><body>Bodegas Torres</body></html>');
    const renderer = new FakeRenderer();
    const { fake, ctx, agent } = setup(
      [
        extract(['Conservas Ortiz']),
        extract(['Bodegas Torres']),
        IRRELEVANT, // Ortiz
        relevant(0.8), // Torres
      ],
      { web, renderer, input: { event_url: 'https://feria.example/expositores', max_catalog_pages: 2 } },
    );
    const out = (await agent.run(ctx)).output as unknown as Out;
    const ev = out.events[0]!;
    expect(ev.catalog_pages).toBe(2);
    expect(ev.pages.filter((p) => p.pagination)).toEqual([expect.objectContaining({ url: 'https://feria.example/expositores?page=2', via: 'fetch', status: 'ok' })]);
    expect(web.requests.map((r) => r.url.toString())).not.toContain('https://feria.example/expositores?page=3');
    expect(ev.results.map((r) => [r.name, r.status, r.domain])).toEqual([
      ['Conservas Ortiz', 'discarded_irrelevant', null],
      ['Bodegas Torres', 'hypothesis_created', 'torres.es'],
    ]);
    expect(ev.results[1]!.profile).toMatchObject({ status: 'domain_resolved', via: 'fetch', domain_source: 'label', social: { twitter: 'https://twitter.com/torres' } });
    expect(renderer.requests).toHaveLength(0);
    // The signal cites the list page it was read from (page 2).
    expect(fake.tables.commercialSignals[0]).toMatchObject({ sourceUrl: { primaryLinkUrl: 'https://feria.example/expositores?page=2' } });
  });

  it('a domain that resolves to a private address is refused (SSRF guard of fetch_url)', async () => {
    const web = new FakeWeb()
      .host('intranet-bodega.example', '10.0.0.7')
      .page('https://feria.example/expositores', html('Expositores', [['Bodega Interna', '/expositor/interna']], null))
      .page('https://feria.example/expositor/interna', '<html><body><h1>Bodega Interna</h1><p>Website: www.intranet-bodega.example</p></body></html>');
    const { fake, ctx, agent } = setup([extract(['Bodega Interna']), relevant(0.9)], { web, input: { event_url: 'https://feria.example/expositores' } });
    const out = (await agent.run(ctx)).output as unknown as Out;
    expect(out.events[0]!.results[0]).toMatchObject({ status: 'skipped_no_domain', profile: { status: 'domain_rejected', domain: 'intranet-bodega.example', error: 'SSRF_BLOCKED' } });
    expect(fake.tables.companies).toHaveLength(0);
  });
});
