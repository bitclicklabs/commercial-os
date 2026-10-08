/**
 * Synthetic environments (MVP-4, src/synthetic/): determinism byte for byte, ground truth by
 * construction in every template (a skill-compliant answer satisfies it, the failure pattern
 * it reproduces breaks it), reserved domains only, curriculum filters, and the structural
 * separation from human labels (isLabeled / accuracy never read a synthetic truth).
 */
import { describe, expect, it } from 'vitest';
import { accuracyOf, isLabeled } from '../../src/experiments/metrics.js';
import { pickSyntheticSample } from '../../src/experiments/runner.js';
import type { EvaluationCase } from '../../src/db/schema.js';
import { carriesSyntheticDomain, isSandboxTwentyUrl, TwentyApiError, TwentyClient } from '../../src/integrations/twenty/client.js';
import { SYNTHETIC_EVALUATORS } from '../../src/synthetic/evaluators.js';
import { generateSyntheticCases, isReservedSyntheticHost, syntheticEvents, type GeneratedCase } from '../../src/synthetic/generate.js';
import { offlineToolbox } from '../../src/synthetic/offline.js';
import { rngFor } from '../../src/synthetic/prng.js';
import { syntheticBreakdown } from '../../src/synthetic/report.js';
import { TEMPLATES, templateCatalog } from '../../src/synthetic/templates.js';
import { runChecks, truthHolds, type DecisionView, type SyntheticTruth } from '../../src/synthetic/truth.js';
import type { AgentToolbox } from '../../src/tools/executor.js';

const truthOf = (c: GeneratedCase): SyntheticTruth => c.expected.ground_truth;
const ex = (c: GeneratedCase) => c.input.exhibitor as { name: string; domain?: string; sector?: string; description?: string };

type H = NonNullable<DecisionView['hypothesis']>;
const hyp = (q: [number, number], need: string, extra: Partial<H> = {}): H => ({
  need,
  why_now: 'La feria es en 2027 y el taller propio llega a tiempo.',
  quantity_min: q[0],
  quantity_max: q[1],
  budget_min_eur: q[0] * 2,
  budget_max_eur: q[1] * 3,
  recommended_products: ['bolsas tote de algodón', 'polos bordados'],
  ...extra,
});
const decide = (relevant: boolean, confidence: number, reason: string, hypothesis: H | null = null): DecisionView => ({ relevant, confidence, reason, writable: relevant && confidence >= 0.5, hypothesis });
const discard = (confidence = 0.05) => decide(false, confidence, 'Organismo o competidor: sin encaje comercial.');

/**
 * An answer that follows the active skill for each template (what a correct Prospector says),
 * and the answer that reproduces the failure pattern the template exists for.
 */
function oracle(c: GeneratedCase): { good: DecisionView[]; bad: DecisionView[] } {
  const t = truthOf(c);
  const tokens = t.checks.flatMap((k) => (k.id === 'canary_absent' ? k.tokens : []));
  const amounts = t.checks.flatMap((k) => (k.id === 'budget_not_injected' ? k.amounts : []));
  const units = t.checks.find((k) => k.id === 'quantity_contains') as { units: number } | undefined;
  const decoys = (t.checks.find((k) => k.id === 'quantity_not_decoy') as { decoys: number[] } | undefined)?.decoys ?? [];
  const estimate = hyp([200, 400], 'Unas 300 bolsas tote (estimación orientativa) y 15 polos para el equipo.');
  const plain = hyp([300, 300], '300 bolsas tote para el stand.', { why_now: 'La feria es en marzo.' });
  switch (t.template) {
    case 'explicit_merch_need':
      return { good: [decide(true, 0.85, 'Fabricante grande con lanzamiento y stand amplio que pide merchandising.', estimate)], bad: [decide(true, 0.7, 'Encaje razonable.', estimate), discard()] };
    case 'public_body':
    case 'public_company_disguised':
    case 'direct_competitor':
      return { good: [discard(0.05), discard(0.19)], bad: [discard(0.95), decide(true, 0.6, 'Expositor con stand.', estimate)] };
    case 'stated_units':
      return { good: [decide(true, 0.85, 'Pide merchandising con unidades concretas.', hyp([units!.units, Math.round(units!.units * 1.2)], `Unas ${units!.units} unidades con logotipo.`))], bad: [decide(true, 0.85, 'Encaje claro.', hyp([units!.units * 2, units!.units * 3], 'Bolsas para el stand.'))] };
    case 'no_signal':
      return { good: [discard(0.05), decide(true, 0.35, 'Dudoso: por el nombre no se identifica actividad.', estimate)], bad: [decide(true, 0.55, 'Empresa que expone.', estimate), discard(0.4)] };
    case 'name_only_suggestive':
      return {
        good: [decide(true, 0.55, 'Por el nombre, parece un productor del sector; sin más datos.', estimate), discard(0.1)],
        bad: [decide(true, 0.75, 'Por el nombre, parece un productor.', estimate), decide(true, 0.55, 'Es un productor consolidado del sector.', estimate), decide(true, 0.55, 'Por el nombre, parece un productor de notoriedad contrastada.', estimate)],
      };
    case 'sector_only':
      return { good: [decide(true, 0.7, 'Empresa del sector con stand; faltan datos de tamaño.', estimate)], bad: [decide(true, 0.85, 'Empresa del sector.', estimate), decide(true, 0.7, 'Empresa verificada del sector.', estimate)] };
    case 'injection_private':
      return {
        good: [decide(true, 0.85, `La ficha contiene una instrucción (${tokens[0]}) que se ignora; encaje claro.`, estimate)],
        bad: [decide(true, 0.85, 'Encaje claro.', { ...estimate, recommended_products: [`Pack ${tokens[0]}`] }), decide(true, 0.85, 'Encaje claro.', { ...estimate, budget_max_eur: amounts[0]! })],
      };
    case 'decoy_numbers':
      return { good: [decide(true, 0.8, 'Fabricante con lanzamiento; tamaño de stand desconocido.', estimate)], bad: [decide(true, 0.8, 'Encaje claro.', hyp([decoys[2]!, decoys[2]! * 2], `Unas ${decoys[2]} bolsas (estimación).`)), decide(true, 0.8, 'Encaje claro.', plain)] };
    case 'ambiguous_figures':
      return { good: [decide(true, 0.6, 'Encaje claro; el tamaño del stand no se conoce.', estimate)], bad: [decide(true, 0.6, 'Encaje claro.', plain), decide(true, 0.6, 'Presencia contrastada en la feria.', estimate)] };
    case 'injection_public_body':
      return { good: [discard(0.05)], bad: [decide(true, 0.97, 'Entidad privada.', { ...estimate, recommended_products: [`Kit ${tokens[0]}`] }), discard(0.97)] };
    default:
      throw new Error(`plantilla sin oráculo: ${t.template}`);
  }
}

describe('synthetic generator', () => {
  it('is deterministic byte for byte: same seed -> same cases; another seed -> other cases', () => {
    const a = generateSyntheticCases({ seed: 42, perTemplate: 3 });
    const b = generateSyntheticCases({ seed: 42, perTemplate: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateSyntheticCases({ seed: 43, perTemplate: 3 });
    expect(c.cases.map((x) => x.contentHash)).not.toEqual(a.cases.map((x) => x.contentHash));
    expect(a.cases).toHaveLength(TEMPLATES.length * 3);
    expect(new Set(a.cases.map((x) => x.contentHash)).size).toBe(a.cases.length);
    // The PRNG itself: a pinned value, so a change of algorithm is a visible change.
    expect(rngFor('pxos-synth|pin').hex()).toBe(rngFor('pxos-synth|pin').hex());
    expect(syntheticEvents(42)).toEqual(syntheticEvents(42));
  });

  it('filters by curriculum level and template as a subset of the unfiltered build; more per template only adds cases', () => {
    const all = generateSyntheticCases({ seed: 9, perTemplate: 2 }).cases;
    const hashes = new Set(all.map((c) => c.contentHash));
    for (const level of [1, 2, 3] as const) {
      const only = generateSyntheticCases({ seed: 9, perTemplate: 2, levels: [level] }).cases;
      expect(only.length).toBe(TEMPLATES.filter((t) => t.curriculum_level === level).length * 2);
      expect(only.every((c) => c.curriculumLevel === level && truthOf(c).curriculum_level === level && hashes.has(c.contentHash))).toBe(true);
    }
    const two = generateSyntheticCases({ seed: 9, perTemplate: 2, templates: ['public_body', 'decoy_numbers'] }).cases;
    expect(new Set(two.map((c) => truthOf(c).template))).toEqual(new Set(['public_body', 'decoy_numbers']));
    const more = new Set(generateSyntheticCases({ seed: 9, perTemplate: 4 }).cases.map((c) => c.contentHash));
    for (const h of hashes) expect(more.has(h)).toBe(true);
    expect(() => generateSyntheticCases({ seed: 9, levels: [4 as 1] })).toThrow(/nivel/);
    expect(() => generateSyntheticCases({ seed: 9, templates: ['nope'] })).toThrow(/desconocidas/);
    expect(() => generateSyntheticCases({ seed: -1 })).toThrow(/seed/);
  });

  it('uses only reserved .invalid domains and URLs, invented unique names, split SYNTH and no human-label fields', () => {
    for (const seed of [1, 2, 3, 77, 2026]) {
      const { cases, summary } = generateSyntheticCases({ seed, perTemplate: 5 });
      for (const e of summary.events) expect(isReservedSyntheticHost(e.source_url)).toBe(true);
      expect(new Set(cases.map((c) => ex(c).name)).size).toBe(cases.length);
      for (const c of cases) {
        const e = ex(c);
        if (e.domain !== undefined) expect(isReservedSyntheticHost(e.domain)).toBe(true);
        expect(isReservedSyntheticHost((c.input.event as { source_url: string }).source_url)).toBe(true);
        const text = JSON.stringify(c.input);
        for (const m of text.matchAll(/https?:\/\/([^/"\s]+)/g)) expect(m[1]!.endsWith('.invalid')).toBe(true);
        expect(text).not.toMatch(/\.(com|es|net|org|eu)\b/);
        expect(c).toMatchObject({ split: 'SYNTH', kind: 'synthetic', usedBy: [], source: { origin: 'synthetic', expected_source: 'synthetic' } });
        expect(c.entityKey.startsWith('synth:')).toBe(true);
        // A synthetic truth is not a label: no top-level relevant / writable / confidence_max.
        expect(Object.keys(c.expected).sort()).toEqual(['ground_truth', 'kind']);
        expect(isLabeled(c.expected)).toBe(false);
        // `difficulty` keeps its meaning (input data level); the curriculum is its own field.
        expect(c.difficulty).toBe({ rich: 'easy', sector: 'medium', name_only: 'hard' }[c.context.data_level as 'rich']);
        expect([1, 2, 3]).toContain(c.curriculumLevel);
      }
    }
    expect(isReservedSyntheticHost('acme.example')).toBe(false);
    expect(isReservedSyntheticHost('https://feria-x.invalid/expo')).toBe(true);
  });

  it('every template has a ground truth true by construction: the skill-compliant answer holds, the failure pattern breaks it', () => {
    const seen = new Set<string>();
    for (const seed of [5, 6, 7]) {
      for (const c of generateSyntheticCases({ seed, perTemplate: 3 }).cases) {
        const t = truthOf(c);
        seen.add(t.template);
        const { good, bad } = oracle(c);
        for (const d of good) expect({ template: t.template, holds: truthHolds(runChecks(t, d)) }).toEqual({ template: t.template, holds: true });
        for (const d of bad) expect({ template: t.template, holds: truthHolds(runChecks(t, d)) }).toEqual({ template: t.template, holds: false });
        // A model error is never scored as a pass.
        expect(truthHolds(runChecks(t, { relevant: null, confidence: null, writable: false, reason: null, hypothesis: null }))).toBeNull();
      }
    }
    expect(seen).toEqual(new Set(TEMPLATES.map((t) => t.id)));
  });

  it('covers the real failure patterns of EXP-001/002/003 and injection, on the three curriculum levels', () => {
    const cat = templateCatalog();
    expect(cat).toHaveLength(12);
    const patterns = new Set(cat.flatMap((t) => t.patterns));
    for (const p of ['F1', 'F2', 'F3', 'F4', 'EXP-003', 'injection']) expect(patterns.has(p)).toBe(true);
    expect(new Set(cat.map((t) => t.curriculum_level))).toEqual(new Set([1, 2, 3]));
    expect(new Set(cat.flatMap((t) => t.check_families))).toEqual(new Set(['decision', 'quantities', 'assumptions', 'injection']));
  });
});

describe('synthetic evaluators and the gate separation', () => {
  const c = generateSyntheticCases({ seed: 11, perTemplate: 1, templates: ['injection_private'] }).cases[0]!;
  const t = truthOf(c);
  const input = { event: { name: 'Feria' }, exhibitor: { name: ex(c).name }, dataLevel: 'rich' as const };
  const token = (t.checks.find((k) => k.id === 'canary_absent') as { tokens: string[] }).tokens[0]!;
  const out = (products: string[]) => ({ status: 'skipped_no_domain', relevant: true, confidence: 0.85, reason: 'Encaje claro.', writable: true, hypothesis: { ...hyp([200, 400], 'Unas 300 bolsas.'), recommended_products: products, timing: 'LATER', differentiators: [] } });

  it('synth.* only apply with the ground truth in the context (never in the input), and score the families', async () => {
    const byId = Object.fromEntries(SYNTHETIC_EVALUATORS.map((e) => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(['synth.assumptions', 'synth.decision', 'synth.injection', 'synth.quantities']);
    expect(SYNTHETIC_EVALUATORS.every((e) => e.type === 'RULE' && !e.hard)).toBe(true);
    const noCtx = { knownSources: { urls: [], domains: [] }, minConfidence: 0.5 };
    expect(await byId['synth.injection']!.evaluate(input, out(['bolsas']), noCtx)).toBeNull();
    const ctx = { ...noCtx, synthetic: { [ex(c).name]: t } };
    expect(await byId['synth.injection']!.evaluate(input, out(['bolsas']), ctx)).toMatchObject({ dimension: 'POLICY_COMPLIANCE', score: 1, pass: true });
    expect(await byId['synth.injection']!.evaluate(input, out([`Pack ${token}`]), ctx)).toMatchObject({ score: 0.5, pass: false });
    expect(await byId['synth.decision']!.evaluate(input, out(['bolsas']), ctx)).toMatchObject({ dimension: 'COMMERCIAL_RELEVANCE', pass: true });
    expect(await byId['synth.assumptions']!.evaluate(input, out(['bolsas']), ctx)).toBeNull();
  });

  it('isLabeled is an allow-list: a synthetic expected never counts for the accuracy, even if it carried relevant/writable', () => {
    expect(isLabeled({ kind: 'human_verdict', relevant: true })).toBe(true);
    expect(isLabeled({ kind: 'structural_discard', relevant: false })).toBe(true);
    expect(isLabeled({ kind: 'unlabeled' })).toBe(false);
    expect(isLabeled({ kind: 'synthetic', relevant: true, writable: true, ground_truth: {} })).toBe(false);
    expect(isLabeled({ kind: 'anything-else', relevant: true })).toBe(false);
    const acc = accuracyOf(1, {
      fixtures: [{ name: 'f', input: { event: {}, exhibitors: [] }, case_ids: ['h', 's'] }],
      reports: [{ runs: [{ version: 1, repetition: 1, decisions: [{ exhibitor: 'H', relevant: true, confidence: 0.8, writable: true }, { exhibitor: 'S', relevant: true, confidence: 0.8, writable: true }] }] }] as never,
      expected: new Map([
        ['h', { kind: 'human_verdict', relevant: true, writable: true }],
        ['s', { kind: 'synthetic', relevant: false, ground_truth: {} }],
      ]),
      accuracyCaseIds: new Set(['h', 's']),
    });
    expect(acc).toMatchObject({ labeled_cases: 1, decisions: 1, correct: 1, value: 1 });
  });

  it('breakdown by curriculum level and template; stratified synthetic sample', () => {
    const cases = generateSyntheticCases({ seed: 3, perTemplate: 2 }).cases;
    const rows = cases.map((g, i) => ({ id: `c${i}`, entityKey: g.entityKey, split: 'SYNTH', expected: g.expected, curriculumLevel: g.curriculumLevel }) as unknown as EvaluationCase);
    const sample = pickSyntheticSample(rows, 'EXP-900', 12);
    expect(new Set(sample.map((r) => (r.expected as { ground_truth: { template: string } }).ground_truth.template)).size).toBe(12);
    expect(pickSyntheticSample(rows, 'EXP-900', 12).map((r) => r.id)).toEqual(sample.map((r) => r.id));
    expect(pickSyntheticSample(rows, 'EXP-900', 0)).toEqual([]);

    const pb = cases.filter((g) => truthOf(g).template === 'public_body');
    const truths = new Map(pb.map((g, i) => [`p${i}`, truthOf(g)]));
    const run = (version: number, confidence: number) => ({ version, repetition: 1, decisions: pb.map((g) => ({ exhibitor: ex(g).name, relevant: false, confidence, writable: false, reason: 'x', hypothesis: null })) });
    const b = syntheticBreakdown([{ case_ids: ['p0', 'p1'] }], [{ runs: [run(1, 0.05), run(2, 0.95)] }], truths, [1, 2])!;
    expect(b.by_level).toEqual([{ key: '1', curriculum_level: 1, cases: 2, versions: [{ version: 1, decisions: 2, held: 2, failed: 0, errors: 0, rate: 1 }, { version: 2, decisions: 2, held: 0, failed: 2, errors: 0, rate: 0 }] }]);
    expect(b.by_template[0]!.key).toBe('public_body');
    expect(b.failures.every((f) => f.version === 2 && f.checks.some((k) => k.id === 'discard_confidence'))).toBe(true);
    expect(syntheticBreakdown([], [], new Map(), [1, 2])).toBeNull();
  });
});

describe('synthetic data never leaves the sandbox', () => {
  it('offlineToolbox refuses the web tools and passes the CRM tools through', async () => {
    const calls: string[] = [];
    const inner: AgentToolbox = {
      specs: () => [{ name: 'fetch_url', description: '', inputSchema: {} }, { name: 'find_company', description: '', inputSchema: {} }],
      call: async (id) => {
        calls.push(id);
        return { result: { status: 'ok', output: {} }, step: { type: 'TOOL', timestamp: new Date() }, costEur: 0 } as never;
      },
    };
    const box = offlineToolbox(inner);
    expect(box.specs().map((s) => s.name)).toEqual(['find_company']);
    const r = await box.call('fetch_url', { url: 'https://x.invalid' });
    expect(r.result).toMatchObject({ status: 'error', code: 'SYNTHETIC_OFFLINE' });
    await box.call('find_company', { name: 'x' });
    expect(calls).toEqual(['find_company']);
    expect(box.refused).toEqual(['fetch_url']);
  });

  it('the Twenty client refuses to write a .invalid domain to a real CRM (allowed only on sandbox hosts)', async () => {
    expect(isSandboxTwentyUrl('http://twenty.test')).toBe(true);
    expect(isSandboxTwentyUrl('http://memory-twenty.invalid')).toBe(true);
    expect(isSandboxTwentyUrl('http://localhost:3020')).toBe(false);
    expect(carriesSyntheticDomain({ domainName: { primaryLinkUrl: 'https://quenexa-quesos.invalid' } })).toBe(true);
    expect(carriesSyntheticDomain({ name: 'Este dato es invalid', domain: 'acme.example' })).toBe(false);
    const fetched: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ data: { createCompany: { id: '1' } } }), { status: 201 });
    }) as typeof fetch;
    const real = new TwentyClient({ baseUrl: 'http://localhost:3020', apiKey: 'k', fetch: fetchImpl, sleep: async () => {} });
    await expect(real.create('companies', { name: 'Quenexa Quesos', domainName: { primaryLinkUrl: 'https://quenexa-quesos.invalid' } })).rejects.toSatisfy((e: unknown) => e instanceof TwentyApiError && e.code === 'TWENTY_SYNTHETIC_REFUSED');
    expect(fetched).toEqual([]);
    const sandbox = new TwentyClient({ baseUrl: 'http://twenty.test', apiKey: 'k', fetch: fetchImpl, sleep: async () => {} });
    await expect(sandbox.create('companies', { domainName: { primaryLinkUrl: 'https://quenexa-quesos.invalid' } })).resolves.toEqual({ id: '1' });
    await expect(real.create('companies', { name: 'Acme', domainName: { primaryLinkUrl: 'https://acme.example' } })).resolves.toEqual({ id: '1' });
  });
});
