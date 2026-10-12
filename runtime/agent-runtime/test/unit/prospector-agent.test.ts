import { readFileSync } from 'node:fs';
import { CATALOG_TOOL_IDS } from '../../src/tools/catalog/catalog-tools.js';
import { describe, expect, it } from 'vitest';
import { resolveAgentImplementation } from '../../src/agents/stub-agent.js';
import { parseExhibitorDecision, ProspectorAgent, ProspectorInput, PROSPECTOR_TOOLS } from '../../src/agents/prospector-agent.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredProspectorVersion, stableStringify } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as Record<string, unknown>;

const RELEVANT = JSON.stringify({
  relevant: true,
  confidence: 0.85,
  reason: 'Fabricante mediano con stand propio y lanzamiento.',
  hypothesis: {
    need: 'Regalo promocional para visitantes del stand y kit para el equipo comercial.',
    why_now: 'Expone en Expo Alimentaria Ibérica el 24/11; el taller propio permite llegar a tiempo.',
    quantity_min: 500,
    quantity_max: 1500,
    budget_min_eur: 1500,
    budget_max_eur: 6000,
    recommended_products: ['Bolsas tote de algodón personalizadas', 'Abrebotellas con logo', 'Polos bordados'],
    timing: 'IMMEDIATE',
    differentiators: ['TALLER_PROPIO', 'PRECIO'],
  },
});
const DOUBTFUL = JSON.stringify({
  relevant: true,
  confidence: 0.35,
  reason: 'Parcialmente competidor: imprime bolsas promocionales.',
  hypothesis: {
    need: 'Textil para el stand compartido.',
    why_now: 'Feria en noviembre.',
    quantity_min: 20,
    quantity_max: 50,
    budget_min_eur: 200,
    budget_max_eur: 600,
    recommended_products: ['Camisetas'],
    timing: 'IMMEDIATE',
    differentiators: [],
  },
});
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'Organismo público: compra por licitación.', hypothesis: null });

function setup(responses: string[], opts: { costPerCall?: number; input?: Record<string, unknown> } = {}) {
  const fake = new FakeTwenty();
  const twenty = fake.client();
  const provider = new StubProvider({ responses, usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }, costPerCall: opts.costPerCall ?? 0.001 });
  const version = desiredProspectorVersion();
  const policy = parseToolPolicy(version.configuration);
  const makeCtx = (providerOverride = provider) => {
    const tools = new ToolExecutor(
      createDefaultToolRegistry({ twenty }),
      policy,
      { tenantId: 'publiexpe', executionId: `exec-${Math.random().toString(36).slice(2, 8)}`, agentId: 'agent-1', stage: 'PROSPECTOR' },
      new AbortController().signal,
    );
    return {
      tenantId: 'publiexpe',
      executionId: 'exec-1',
      agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
      version: { id: 'v1', version: 2, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
      input: opts.input ?? fixture,
      provider: providerOverride,
      signal: new AbortController().signal,
      tools,
    };
  };
  const agent = new ProspectorAgent(() => new Date('2026-10-06T08:00:00Z'));
  return { fake, provider, makeCtx, agent };
}

describe('parseExhibitorDecision', () => {
  it('accepts valid JSON, also inside ```json fences', () => {
    expect(parseExhibitorDecision(RELEVANT).ok).toBe(true);
    expect(parseExhibitorDecision('```json\n' + IRRELEVANT + '\n```').ok).toBe(true);
  });

  it('rejects broken JSON and schema violations with a readable error', () => {
    expect(parseExhibitorDecision('{"relevant": tru')).toMatchObject({ ok: false, error: expect.stringContaining('JSON inválido') });
    const noHyp = parseExhibitorDecision(JSON.stringify({ relevant: true, confidence: 0.9, reason: 'x', hypothesis: null }));
    expect(noHyp).toMatchObject({ ok: false, error: expect.stringContaining('hypothesis') });
    const inverted = JSON.parse(RELEVANT) as { hypothesis: Record<string, unknown> };
    inverted.hypothesis.quantity_max = 10;
    expect(parseExhibitorDecision(JSON.stringify(inverted))).toMatchObject({ ok: false, error: expect.stringContaining('quantity_max') });
    expect(parseExhibitorDecision(JSON.stringify({ relevant: false, confidence: 85, reason: 'x', hypothesis: null })).ok).toBe(false);
  });
});

describe('ProspectorInput', () => {
  it('validates the fixture and maps Spanish event types', () => {
    expect(ProspectorInput.parse(fixture).event.type).toBe('FAIR');
    expect(ProspectorInput.parse({ ...fixture, event: { name: 'X', type: 'congreso' } }).event.type).toBe('CONGRESS');
    expect(ProspectorInput.safeParse({ event: { name: 'X', type: 'fiesta' }, exhibitors: [{ name: 'A' }] }).success).toBe(false);
    expect(ProspectorInput.safeParse({ event: { name: 'X', type: 'FAIR' }, exhibitors: [] }).success).toBe(false);
  });
});

describe('ProspectorAgent', () => {
  it('is resolved from configuration.implementation = "prospector"', () => {
    expect(resolveAgentImplementation({ implementation: 'prospector' }).kind).toBe('prospector');
  });

  it('seed tool policy: exactly the 13 Prospector tools (create_research, fetch_url, render_url, the signal and lead-time tools included) + the 5 catalog READ tools, LOW_WRITE ceiling', () => {
    const policy = parseToolPolicy(desiredProspectorVersion().configuration);
    expect([...policy.allow].sort()).toEqual([...PROSPECTOR_TOOLS, ...CATALOG_TOOL_IDS].sort());
    expect(policy.allow).toHaveLength(18);
    expect(policy.allow).toContain('list_hypotheses_for_expiry');
    expect(policy.allow).toContain('expire_hypothesis');
    // Tanda 19: the out-of-window alert is a Twenty Task; the note tool stays only for older versions.
    expect(policy.allow).toContain('create_crm_task');
    expect(policy.allow).not.toContain('create_signal_note');
    expect(policy.allow).toContain('list_event_signals');
    expect(policy.allow).toContain('expire_signal');
    expect(policy.allow).toContain('create_research');
    expect(policy.allow).toContain('fetch_url');
    expect(policy.allow).toContain('render_url');
    expect(policy.maxRiskLevel).toBe('LOW_WRITE');
  });

  it('runs the fixture: retries an invalid answer, writes only the relevant exhibitor, always publishes the summary', async () => {
    // exhibitor 1 relevant; exhibitor 2 invalid JSON then low-confidence; exhibitor 3 irrelevant
    const { fake, provider, makeCtx, agent } = setup([RELEVANT, '{"relevant": true, "confidence": ', DOUBTFUL, IRRELEVANT]);
    const result = await agent.run(makeCtx());

    // LLM calls: 4 (one repair). The repair prompt carries the validation error.
    expect(provider.requests).toHaveLength(4);
    const repair = provider.requests[2]!;
    expect(repair.messages).toHaveLength(3);
    expect(repair.messages[1]!.role).toBe('assistant');
    expect(repair.messages[2]!.content).toContain('no es válida');
    expect(repair.options?.responseSchema).toBeDefined();
    expect(provider.requests[0]!.system).toContain('Taller propio');

    // Tool flow.
    const toolSteps = result.steps.filter((s) => s.type === 'TOOL').map((s) => s.tool);
    expect(toolSteps).toEqual(['upsert_company', 'create_signal', 'create_research', 'create_hypothesis', 'create_agent_run_summary']);
    expect(result.steps.filter((s) => s.type === 'MODEL')).toHaveLength(4);
    expect(result.steps[0]!.type).toBe('THINK');
    expect(result.steps.at(-1)!.type).toBe('FINAL');

    // Twenty records.
    expect(fake.tables.companies).toHaveLength(1);
    expect(fake.tables.companies[0]).toMatchObject({ name: 'Conservas Marineras del Cantábrico', domainName: { primaryLinkUrl: 'conservasdelcantabrico.example' } });
    expect(fake.tables.commercialSignals).toHaveLength(1);
    expect(fake.tables.commercialSignals[0]).toMatchObject({
      signalType: 'FAIR',
      status: 'NEW',
      confidence: 0.85,
      eventDate: '2026-11-24',
      sourceDomain: 'expoalimentariaiberica.example',
      tenantId: 'publiexpe',
    });
    // Research (LLD 5.2): composed from the input data, linked to company and signal, no extra LLM call.
    expect(fake.tables.researches).toHaveLength(1);
    const research = fake.tables.researches[0]!;
    expect(research).toMatchObject({
      researchType: 'EVENT_EXHIBITORS',
      companyId: fake.tables.companies[0]!.id,
      commercialSignalId: fake.tables.commercialSignals[0]!.id,
      agentExecutionId: expect.stringMatching(/^exec-/),
      tenantId: 'publiexpe',
      sources: [fixture.event && (fixture.event as { source_url: string }).source_url],
    });
    expect(String(research.summary)).toContain('Conservas Marineras del Cantábrico figura como expositor en Expo Alimentaria Ibérica 2026');
    expect(String(research.summary)).toContain('Web: conservasdelcantabrico.example (indicada en la lista de expositores)');
    expect(String(research.summary)).not.toContain('Valoración');
    expect(research.structuredResult).toMatchObject({
      profile: { legalName: 'Conservas Marineras del Cantábrico', website: 'https://conservasdelcantabrico.example' },
      signals: [{ type: 'FAIR', eventDate: '2026-11-24' }],
    });
    expect(research.confidence).toBeGreaterThanOrEqual(0.7);
    expect(fake.tables.commercialHypotheses).toHaveLength(1);
    expect(fake.tables.commercialHypotheses[0]).toMatchObject({
      name: 'Conservas Marineras del Cantábrico — Expo Alimentaria Ibérica 2026',
      status: 'PROPOSED',
      quantityMin: 500,
      quantityMax: 1500,
      budgetMin: { amountMicros: 1_500_000_000, currencyCode: 'EUR' },
      budgetMax: { amountMicros: 6_000_000_000, currencyCode: 'EUR' },
      timing: 'IMMEDIATE',
      commercialSignalId: fake.tables.commercialSignals[0]!.id,
    });
    expect(fake.tables.agentRunSummaries).toHaveLength(1);
    const summary = fake.tables.agentRunSummaries[0]!;
    expect(summary).toMatchObject({ outcome: 'SUCCESS', task: 'daily-event-prospecting', agentName: 'Prospector', agentVersion: '2' });
    expect(String(summary.resultSummary)).toContain('relevantes: 2');
    expect(String(summary.resultSummary)).toContain('- Conservas Marineras del Cantábrico: hipótesis creada (confianza 0,85)');

    // Cost aggregation: 4 calls x 0.001 USD; EUR at the configured rate (0.86).
    expect(result.modelCost).toBeCloseTo(0.004, 9);
    expect(result.usage).toEqual({ inputTokens: 4000, outputTokens: 800, cachedTokens: 0 });
    expect(summary.cost).toEqual({ amountMicros: 3440, currencyCode: 'EUR' });
    const modelSteps = result.steps.filter((s) => s.type === 'MODEL');
    expect(modelSteps.every((s) => (s.output as { cost: { amount: number } }).cost.amount === 0.001)).toBe(true);
    expect(modelSteps.every((s) => s.usage?.inputTokens === 1000)).toBe(true);
    expect((modelSteps[1]!.output as { valid: boolean }).valid).toBe(false);

    expect(result.output).toMatchObject({
      status: 'ok',
      outcome: 'SUCCESS',
      counters: {
        exhibitors: 3,
        evaluated: 3,
        relevant: 2,
        hypotheses_created: 1,
        discarded_irrelevant: 1,
        discarded_low_confidence: 1,
        companies_created: 1,
        research_created: 1,
        research_errors: 0,
        errors: 0,
        llm_calls: 4,
      },
      cost: { model: 0.004, currency: 'USD', eur: 0.00344 },
    });
    const results = (result.output as { results: Array<{ status: string }> }).results.map((r) => r.status);
    expect(results).toEqual(['hypothesis_created', 'discarded_low_confidence', 'discarded_irrelevant']);
  });

  it('is idempotent on re-run: same company, signal and hypothesis are reused', async () => {
    const { fake, makeCtx, agent } = setup([RELEVANT, DOUBTFUL, IRRELEVANT, RELEVANT, DOUBTFUL, IRRELEVANT]);
    await agent.run(makeCtx());
    const second = await agent.run(makeCtx());
    expect(fake.tables.companies).toHaveLength(1);
    expect(fake.tables.commercialSignals).toHaveLength(1);
    expect(fake.tables.commercialHypotheses).toHaveLength(1);
    expect(fake.tables.agentRunSummaries).toHaveLength(2); // one per execution
    // A new research is a new record (LLD 5.2): one per execution, never overwritten.
    expect(fake.tables.researches).toHaveLength(2);
    expect(new Set(fake.tables.researches.map((r) => r.agentExecutionId)).size).toBe(2);
    expect(second.output).toMatchObject({ counters: { hypotheses_created: 0, hypotheses_existing: 1 } });
  });

  it('marks an exhibitor llm_invalid after the repair attempt also fails, and the run PARTIAL', async () => {
    const { fake, makeCtx, agent } = setup(['nope', 'still nope', IRRELEVANT, IRRELEVANT]);
    const result = await agent.run(makeCtx());
    expect(result.output).toMatchObject({ outcome: 'PARTIAL', counters: { errors: 1, llm_calls: 4 } });
    expect((result.output as { results: Array<{ status: string }> }).results[0]!.status).toBe('llm_invalid');
    expect(fake.tables.agentRunSummaries[0]).toMatchObject({ outcome: 'PARTIAL' });
  });

  it('keeps going when the provider fails; all failed -> FAILED summary', async () => {
    const failing = new StubProvider();
    failing.complete = async () => {
      throw Object.assign(new Error('Gemini 503'), { code: 'GEMINI_SERVER_ERROR' });
    };
    const { fake, makeCtx, agent } = setup([]);
    const result = await agent.run(makeCtx(failing));
    expect(result.output).toMatchObject({ status: 'error', outcome: 'FAILED', counters: { errors: 3, llm_calls: 0 } });
    expect(result.modelCost).toBe(0);
    expect(fake.tables.agentRunSummaries[0]).toMatchObject({ outcome: 'FAILED' });
    expect(result.steps.filter((s) => s.type === 'MODEL').every((s) => s.error?.code === 'GEMINI_SERVER_ERROR')).toBe(true);
  });

  it('never creates a company without domain: reuses an exact name match or skips', async () => {
    const input = {
      event: { name: 'Congreso Demo', type: 'CONGRESS', source_url: 'https://congreso.example' },
      exhibitors: [{ name: 'Empresa Existente' }, { name: 'Empresa Nueva' }],
    };
    const { fake, makeCtx, agent } = setup([RELEVANT, RELEVANT], { input });
    fake.seed('companies', { name: 'Empresa Existente', domainName: { primaryLinkUrl: 'existente.example', primaryLinkLabel: '', secondaryLinks: [] } });
    const result = await agent.run(makeCtx());
    const statuses = (result.output as { results: Array<{ status: string }> }).results.map((r) => r.status);
    expect(statuses).toEqual(['hypothesis_created', 'skipped_no_domain']);
    expect(fake.tables.companies).toHaveLength(1);
    expect(result.steps.filter((s) => s.type === 'TOOL').map((s) => s.tool)).toEqual([
      'find_company',
      'create_signal',
      'create_research',
      'create_hypothesis',
      'find_company',
      'create_agent_run_summary',
    ]);
    expect(fake.tables.researches).toHaveLength(1);
    expect(fake.tables.researches[0]).toMatchObject({ sources: ['https://congreso.example'], researchType: 'EVENT_EXHIBITORS' });
    expect(String(fake.tables.researches[0]!.summary)).toContain('Web: existente.example (la de la empresa que ya estaba en el CRM)');
  });

  it('invalid input: no LLM call, FAILED summary still published', async () => {
    const { fake, provider, makeCtx, agent } = setup([], { input: { event: { name: 'X' } } });
    const result = await agent.run(makeCtx());
    expect(provider.requests).toHaveLength(0);
    expect(result.output).toMatchObject({ status: 'error', outcome: 'FAILED' });
    expect(fake.tables.agentRunSummaries[0]).toMatchObject({ outcome: 'FAILED' });
  });

  it('stableStringify ignores key order (seed idempotency)', () => {
    expect(stableStringify({ a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(stableStringify({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 }));
  });
});
