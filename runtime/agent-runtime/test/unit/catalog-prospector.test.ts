/**
 * The Prospector with the catalog (no database): real products only when the skill carries the
 * capability marker and the catalog is enabled and healthy; validation of the model's picks
 * against the candidates; graceful fallback to generic families otherwise.
 */
import { describe, expect, it } from 'vitest';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import { CATALOG_SKILL_MARKER, skillRequestsCatalog } from '../../src/agents/prospector-catalog.js';
import { PROSPECTOR_SYSTEM_PROMPT } from '../../src/agents/prospector-prompt.js';
import { UNTRUSTED_OPEN } from '../../src/agents/untrusted.js';
import { CatalogError, CatalogService, loadStubCatalogData, StubCatalogClient } from '../../src/integrations/catalog/index.js';
import { StubProvider } from '../../src/providers/index.js';
import { CATALOG_SKILL_SECTION, withCatalogSection } from '../../src/seed/catalog-skill-seed.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const INPUT = {
  event: { name: 'Expo Alimentaria Ibérica', type: 'FAIR', date: '2026-11-24', source_url: 'https://expo.example.com/expositores' },
  exhibitors: [{ name: 'Conservas del Norte', domain: 'conservasdelnorte.es', description: 'Fabricante de conservas con stand propio.' }],
};
const DECISION = JSON.stringify({
  relevant: true,
  confidence: 0.82,
  reason: 'Fabricante con stand propio.',
  hypothesis: {
    need: 'Unas 500 bolsas tote para los visitantes del stand y bolígrafos para el equipo.',
    why_now: 'Expone el 24/11.',
    quantity_min: 500,
    quantity_max: 900,
    budget_min_eur: 800,
    budget_max_eur: 2000,
    recommended_products: ['Bolsas tote de algodón', 'Bolígrafos', 'Abrebotellas'],
    timing: 'IMMEDIATE',
    differentiators: ['TALLER_PROPIO'],
  },
});
const SELECTION = JSON.stringify({
  selected: [
    { productId: '10482', sku: '12/BT-ALG-140', reason: 'Bolsa ligera de feria, pedido mínimo 100.' },
    { productId: '99999', sku: 'INVENTADO-1' },
    { productId: '11020', sku: '7/BOL-WRONG' },
    { productId: '11020', sku: '7/BOL-PUL', reason: 'Bolígrafo de volumen.' },
  ],
});

function setup(opts: { skill: string; responses: string[]; catalog: CatalogService }) {
  const fake = new FakeTwenty();
  const twenty = fake.client();
  const provider = new StubProvider({ responses: opts.responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: 0.001 });
  const version = desiredProspectorVersion();
  const tools = new ToolExecutor(
    createDefaultToolRegistry({ twenty, catalog: opts.catalog }),
    parseToolPolicy(version.configuration),
    { tenantId: 'publiexpe', executionId: 'exec-cat', agentId: 'agent-1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const ctx = {
    tenantId: 'publiexpe',
    executionId: 'exec-cat',
    agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
    version: { id: 'v1', version: 9, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: opts.skill, configuration: version.configuration },
    input: INPUT,
    provider,
    signal: new AbortController().signal,
    tools,
  };
  return { fake, provider, ctx, agent: new ProspectorAgent(() => new Date('2026-10-09T08:00:00Z')) };
}

const enabledStub = () => {
  const api = new StubCatalogClient(loadStubCatalogData());
  return { api, catalog: new CatalogService({ enabled: true, api }) };
};
const CATALOG_SKILL = withCatalogSection(PROSPECTOR_SYSTEM_PROMPT);
type Result = { status: string; recommended_products?: unknown[]; catalog?: { status: string }; hypothesis?: { recommended_products: string[] } };

describe('catalog skill candidate text', () => {
  it('adds the section with the marker, replaces the "no catalog" sentence, keeps the untrusted rule; idempotent', () => {
    expect(skillRequestsCatalog(PROSPECTOR_SYSTEM_PROMPT)).toBe(false);
    expect(skillRequestsCatalog(CATALOG_SKILL)).toBe(true);
    expect(CATALOG_SKILL).not.toContain('Aún no hay catálogo conectado');
    expect(CATALOG_SKILL).toContain(CATALOG_SKILL_SECTION);
    expect(CATALOG_SKILL).toContain('## Seguridad: contenido web');
    expect(CATALOG_SKILL).toMatch(/orden de magnitud: «en torno a X-Y €\/ud antes de personalización»/);
    expect(withCatalogSection(CATALOG_SKILL)).toBe(CATALOG_SKILL);
    expect(CATALOG_SKILL.split(CATALOG_SKILL_MARKER)).toHaveLength(2);
  });
});

describe('Prospector + catalog', () => {
  it('skill asks + catalog up: 1-3 real products validated against the candidates, written to Twenty with the price as an order of magnitude', async () => {
    const { api, catalog } = enabledStub();
    const { fake, provider, ctx, agent } = setup({ skill: CATALOG_SKILL, responses: [DECISION, SELECTION], catalog });
    const out = await agent.run(ctx);
    expect(out.output).toMatchObject({ outcome: 'SUCCESS' });
    const r = (out.output.results as Result[])[0]!;
    expect(r.status).toBe('hypothesis_created');
    expect(r.catalog).toMatchObject({ status: 'selected', searches: 3 });
    // Invented id and wrong sku dropped; the duplicate 11020 with the right sku kept once.
    expect(r.recommended_products).toEqual([
      { productId: '10482', sku: '12/BT-ALG-140', name: 'Bolsa tote de algodón 140 g', priceHint: expect.objectContaining({ fromEur: 1.2, toEur: 1.35, basis: 'INDICATIVE' }) },
      { productId: '11020', sku: '7/BOL-PUL', name: 'Bolígrafo de plástico con pulsador', priceHint: expect.objectContaining({ fromEur: 0.18, toEur: 0.22 }) },
    ]);
    // The generic families stay in the model's hypothesis.
    expect(r.hypothesis!.recommended_products).toEqual(['Bolsas tote de algodón', 'Bolígrafos', 'Abrebotellas']);

    const hyp = fake.tables.commercialHypotheses[0] as { recommendedProducts: string[]; evidence: Array<{ claim: string }> };
    expect(hyp.recommendedProducts.slice(0, 2)).toEqual(['[STUB] Bolsa tote de algodón 140 g · ref. 12/BT-ALG-140 · id 10482', '[STUB] Bolígrafo de plástico con pulsador · ref. 7/BOL-PUL · id 11020']);
    expect(hyp.recommendedProducts).toContain('Bolsas tote de algodón');
    const claims = hyp.evidence.map((e) => e.claim).join('\n');
    expect(claims).toContain('en torno a 1,20-1,35 €/ud antes de personalización (orientativo, sin IVA)');
    expect(claims).toContain('el presupuesto lo hace el CMS de publiexpe');
    expect(claims).not.toMatch(/INVENTADO/);

    // Second LLM call: same skill, catalog texts inside the untrusted block.
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.system).toContain(CATALOG_SKILL_MARKER);
    const user = provider.requests[1]!.messages[0]!.content;
    expect(user).toContain(`<<<${UNTRUSTED_OPEN}`);
    expect(user.indexOf('Bolsa de algodón natural')).toBeGreaterThan(user.lastIndexOf(`<<<${UNTRUSTED_OPEN}`));
    const tools = out.steps.filter((s) => s.type === 'TOOL').map((s) => s.tool);
    expect(tools.filter((t) => t === 'catalog_search_products')).toHaveLength(3);
    expect(tools.filter((t) => t === 'catalog_get_product')).toHaveLength(2);
    expect(tools.indexOf('catalog_get_product')).toBeLessThan(tools.indexOf('create_hypothesis'));
    expect(api.calls.searchProducts).toBe(3);
  });

  it('ACTIVE skill (no marker): identical behaviour, no catalog call even with the catalog up', async () => {
    const { api, catalog } = enabledStub();
    const { fake, provider, ctx, agent } = setup({ skill: PROSPECTOR_SYSTEM_PROMPT, responses: [DECISION], catalog });
    const out = await agent.run(ctx);
    const r = (out.output.results as Result[])[0]!;
    expect(r.catalog).toBeUndefined();
    expect(r.recommended_products).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
    expect(api.calls.searchProducts).toBeUndefined();
    expect((fake.tables.commercialHypotheses[0] as { recommendedProducts: string[] }).recommendedProducts).toEqual(['Bolsas tote de algodón', 'Bolígrafos', 'Abrebotellas']);
  });

  it('catalog enabled but down: degraded run, generic families, one failed search only, outcome SUCCESS', async () => {
    const { api, catalog } = enabledStub();
    api.failure = new CatalogError('CATALOG_UNAVAILABLE', 'UNAVAILABLE', 503, true);
    const { fake, provider, ctx, agent } = setup({ skill: CATALOG_SKILL, responses: [DECISION], catalog });
    const out = await agent.run(ctx);
    expect(out.output).toMatchObject({ outcome: 'SUCCESS' });
    const r = (out.output.results as Result[])[0]!;
    expect(r).toMatchObject({ status: 'hypothesis_created', catalog: { status: 'unavailable', code: 'CATALOG_UNAVAILABLE' } });
    expect(r.recommended_products).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
    expect(out.steps.filter((s) => s.tool === 'catalog_search_products')).toHaveLength(1);
    expect((fake.tables.commercialHypotheses[0] as { recommendedProducts: string[] }).recommendedProducts).toEqual(['Bolsas tote de algodón', 'Bolígrafos', 'Abrebotellas']);
  });

  it('catalog disabled: the tools are not exposed, the skill falls back to generic families', async () => {
    const { ctx, agent, provider } = setup({ skill: CATALOG_SKILL, responses: [DECISION], catalog: new CatalogService({ enabled: false, api: null }) });
    const out = await agent.run(ctx);
    expect((out.output.results as Result[])[0]).toMatchObject({ status: 'hypothesis_created', catalog: { status: 'tools_not_allowed' } });
    expect(out.steps.some((s) => s.tool?.startsWith('catalog_'))).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it('the model picks nothing (or only invented products): generic families, no sheet read', async () => {
    const { catalog } = enabledStub();
    const { ctx, agent } = setup({ skill: CATALOG_SKILL, responses: [DECISION, JSON.stringify({ selected: [{ productId: '1', sku: 'X' }] })], catalog });
    const out = await agent.run(ctx);
    expect((out.output.results as Result[])[0]).toMatchObject({ status: 'hypothesis_created', catalog: { status: 'none_selected' } });
    expect(out.steps.some((s) => s.tool === 'catalog_get_product')).toBe(false);
  });
});
