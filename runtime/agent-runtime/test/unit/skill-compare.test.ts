import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StubProvider } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import {
  BudgetGuardProvider,
  dataLevel,
  renderComparisonMarkdown,
  runSkillComparison,
  versionMetrics,
  type CompareVersion,
} from '../../src/skills/compare.js';
import { sha256 } from '../../src/skills/render.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const holdout = JSON.parse(readFileSync(new URL('../fixtures/gastronoma-holdout.json', import.meta.url), 'utf8')) as { exhibitors: unknown[] };

const version = (n: number, text: string): CompareVersion => ({ version: n, status: n === 1 ? 'ACTIVE' : 'DRAFT', skillVersionId: `sv-${n}`, text, contentHash: sha256(text) });
const V1 = version(1, 'Eres el Prospector (v1 de prueba).');
const V2 = version(2, 'Eres el Prospector (v2 de prueba): techo de confianza.');

const hyp = (q: [number, number], b: [number, number], need = 'Regalo para el stand.') => ({
  need,
  why_now: 'La feria es el 24/11.',
  quantity_min: q[0],
  quantity_max: q[1],
  budget_min_eur: b[0],
  budget_max_eur: b[1],
  recommended_products: ['Bolsas tote'],
  timing: 'THIS_QUARTER',
  differentiators: ['TALLER_PROPIO'],
});
const decision = (relevant: boolean, confidence: number, h: unknown = null, reason = 'Razón.') => JSON.stringify({ relevant, confidence, reason, hypothesis: h });

// Fixture order: Conservas (rich), Envases Garrido (rich, partial competitor), Instituto (public body).
const V1_ANSWERS = [decision(true, 0.9, hyp([500, 2000], [1200, 4500])), decision(true, 0.55, hyp([150, 500], [450, 1800])), decision(false, 0.05)];
const V2_ANSWERS = [
  decision(true, 0.85, hyp([600, 1200], [1500, 3200], 'Unas 800 bolsas tote y 20 polos para el equipo.')),
  decision(true, 0.4, hyp([100, 200], [300, 600], 'Unas 150 libretas.'), 'Por el nombre, parece competidor parcial.'),
  decision(false, 0.05),
];

function harness(responses: string[], opts: { costPerCall?: number } = {}) {
  const provider = new StubProvider({ responses, usage: { inputTokens: 1600, outputTokens: 320, cachedTokens: 0 }, costPerCall: opts.costPerCall ?? 0.0025 });
  const agentVersion = desiredProspectorVersion();
  const policy = parseToolPolicy(agentVersion.configuration);
  const fakes: FakeTwenty[] = [];
  const makeTools = (label: string) => {
    const fake = new FakeTwenty();
    fakes.push(fake);
    return new ToolExecutor(createDefaultToolRegistry({ twenty: fake.client() }), policy, { tenantId: 'publiexpe', executionId: label, agentId: 'skill-compare', stage: 'PROSPECTOR' }, new AbortController().signal);
  };
  return { provider, fakes, makeTools, agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration } };
}

const NOW = () => new Date('2026-10-07T08:00:00Z');

describe('skill:compare core', () => {
  it('runs the same input with both versions, injects each version text and writes only to the in-memory CRM', async () => {
    const h = harness([...V1_ANSWERS, ...V2_ANSWERS]);
    const report = await runSkillComparison({ skillName: 'prospector-event-exhibitors', versions: [V1, V2], input: fixture, provider: h.provider, makeTools: h.makeTools, agentVersion: h.agentVersion, now: NOW });

    expect(h.provider.requests).toHaveLength(6);
    expect(h.provider.requests.slice(0, 3).every((r) => r.system === V1.text)).toBe(true);
    expect(h.provider.requests.slice(3).every((r) => r.system === V2.text)).toBe(true);
    // Same user prompt for both versions (same input, same "today"); only the random nonce of the untrusted block differs.
    const prompt = (i: number) => h.provider.requests[i]!.messages[0]!.content.replace(/id=[0-9a-f]+/g, 'id=*');
    expect(prompt(0)).toBe(prompt(3));

    expect(report.runs.map((r) => r.version)).toEqual([1, 2]);
    expect(report.runs[0]!.skillRecords[0]).toMatchObject({ name: 'prospector-event-exhibitors', version: 1, skill_version_id: 'sv-1', source: 'db', content_hash: V1.contentHash });
    // One fresh FakeTwenty per run; the relevant, writable exhibitor is written there (and only there).
    expect(h.fakes).toHaveLength(2);
    expect(h.fakes.map((f) => f.tables.commercialHypotheses.length)).toEqual([2, 1]);
    expect(report.today).toBe('2026-10-07');
    expect(report.input_sha256).toBe(sha256(JSON.stringify(fixture)));
  });

  it('computes structured differences: relevance, writable, confidence by data level, hypothesis shape, tokens and cost', async () => {
    const h = harness([...V1_ANSWERS, ...V2_ANSWERS]);
    const report = await runSkillComparison({ skillName: 'prospector-event-exhibitors', versions: [V1, V2], input: fixture, provider: h.provider, makeTools: h.makeTools, agentVersion: h.agentVersion, now: NOW });
    const [m1, m2] = report.metrics;

    expect(m1).toMatchObject({ version: 1, decisions: 3, errors: 0, relevant: 2, writable: 2, hypotheses: 2, need_with_quantities: 0, quantity_ratio_over_2_5: 2 });
    expect(m2).toMatchObject({ version: 2, decisions: 3, relevant: 2, writable: 1, hypotheses: 2, need_with_quantities: 2, quantity_ratio_over_2_5: 0 });
    expect(m1.confidence_by_level.rich).toEqual({ n: 3, mean: 0.5, max: 0.9 });
    expect(m1.input_tokens).toBe(3 * 1600);
    expect(m2.output_tokens).toBe(3 * 320);
    expect(m1.cost_eur).toBeGreaterThan(0);
    expect(report.total_cost_eur).toBeCloseTo(m1.cost_eur + m2.cost_eur, 6);

    const envases = report.cases.find((c) => c.exhibitor === 'Envases y Bolsas Garrido')!;
    expect(envases.writable_changed).toBe(true);
    expect(envases.confidence_delta).toBeCloseTo(-0.15, 6);
    expect(report.cases.find((c) => c.exhibitor.startsWith('Instituto'))!.writable_changed).toBe(false);

    const md = renderComparisonMarkdown(report);
    expect(md).toContain('| Escribibles (confianza ≥ umbral) | 2 | 1 |');
    expect(md).toContain('Envases y Bolsas Garrido');
    expect(md).toContain('FakeTwenty');
  });

  it('alternates the order between repetitions and measures stability per version', async () => {
    const h = harness([...V1_ANSWERS, ...V2_ANSWERS, ...V2_ANSWERS, ...V1_ANSWERS.map((a, i) => (i === 1 ? decision(true, 0.45, hyp([150, 500], [450, 1800])) : a))]);
    const report = await runSkillComparison({ skillName: 'prospector-event-exhibitors', versions: [V1, V2], input: fixture, provider: h.provider, makeTools: h.makeTools, agentVersion: h.agentVersion, now: NOW, repeat: 2 });
    expect(report.runs.map((r) => `${r.version}.${r.repetition}`)).toEqual(['1.1', '2.1', '2.2', '1.2']);
    const s1 = report.stability.find((s) => s.version === 1)!;
    const s2 = report.stability.find((s) => s.version === 2)!;
    expect(s1.writable_flips).toBe(1);
    expect(s2).toMatchObject({ relevant_flips: 0, writable_flips: 0, confidence_mad: 0 });
    expect(report.cases[1]!.byVersion[0]!.confidences).toEqual([0.55, 0.45]);
  });

  it('stops calling the model once the budget is spent and marks the report incomplete', async () => {
    const h = harness([...V1_ANSWERS, ...V2_ANSWERS], { costPerCall: 0.05 });
    const budget = new BudgetGuardProvider(h.provider, 0.09, 0.92);
    const report = await runSkillComparison({ skillName: 'prospector-event-exhibitors', versions: [V1, V2], input: fixture, provider: h.provider, budget, makeTools: h.makeTools, agentVersion: h.agentVersion, now: NOW });
    // 0.05 USD * 0.92 = 0.046 EUR per call: the third call is refused.
    expect(h.provider.requests).toHaveLength(2);
    expect(report.budget_exceeded).toBe(true);
    expect(report.runs).toHaveLength(1);
    expect(report.metrics[0].errors).toBe(1);
    expect(report.runs[0]!.decisions[2]!.status).toBe('llm_error');
    expect(renderComparisonMarkdown(report)).toContain('presupuesto agotado');
  });

  it('refuses versions whose text does not match their content hash, and skills without a harness', async () => {
    const h = harness([]);
    const tampered = { ...V2, text: `${V2.text} (editada)` };
    await expect(runSkillComparison({ skillName: 'prospector-event-exhibitors', versions: [V1, tampered], input: fixture, provider: h.provider, makeTools: h.makeTools, agentVersion: h.agentVersion })).rejects.toThrow(/content_hash/);
    await expect(runSkillComparison({ skillName: 'email-first-contact-draft', versions: [V1, V2], input: fixture, provider: h.provider, makeTools: h.makeTools, agentVersion: h.agentVersion })).rejects.toThrow(/no tiene harness/);
    expect(h.provider.requests).toHaveLength(0);
  });

  it('classifies the data each exhibitor brings; the Gastrónoma holdout is mostly name-only', () => {
    expect(dataLevel({ sector: 'Alimentación' })).toBe('sector');
    expect(dataLevel({ domain: 'acme.es' })).toBe('rich');
    expect(dataLevel({})).toBe('name_only');
    const levels = holdout.exhibitors.map((e) => dataLevel(e as Record<string, string>));
    expect(levels.filter((l) => l === 'name_only')).toHaveLength(6);
    expect(versionMetrics(9, [])).toMatchObject({ decisions: 0, confidence_mean: null, cost_eur_per_decision: null });
  });
});
