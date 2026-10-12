import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildExhibitorResearch } from '../../src/agents/exhibitor-research.js';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import {
  KNOWLEDGE_BLOCK_TITLE,
  KNOWLEDGE_MAX_CHARS,
  KnowledgeSet,
  knowledgeDomains,
  renderKnowledgeBlock,
  resolveKnowledge,
  selectEntries,
  useKnowledge,
  type KnowledgeEntryRow,
  type KnowledgeStore,
} from '../../src/knowledge/resolver.js';
import { KNOWLEDGE_DOMAIN_RE, KnowledgeServiceError, planTransition, STATEMENT_MAX_CHARS } from '../../src/knowledge/service.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredEmailDrafterVersion } from '../../src/seed/email-drafter-seed.js';
import { KNOWLEDGE_SEED } from '../../src/seed/knowledge-seed.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const entry = (i: number, statement = `Regla número ${i}.`, domain = 'prospeccion'): KnowledgeEntryRow => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  domain,
  topic: `tema-${i}`,
  statement,
  confidence: 0.8,
  activatedAt: new Date(Date.UTC(2026, 9, 7, 0, 0, i)),
  createdAt: new Date(Date.UTC(2026, 9, 7)),
});

function memoryStore(rows: KnowledgeEntryRow[]): KnowledgeStore & { calls: Array<{ domains: readonly string[]; limit: number }> } {
  const calls: Array<{ domains: readonly string[]; limit: number }> = [];
  return {
    calls,
    async active(_tenant, domains, _now, limit) {
      calls.push({ domains, limit });
      return rows.filter((r) => domains.includes(r.domain)).slice(0, limit);
    },
  };
}

describe('knowledge: configuration and selection', () => {
  it('knowledge_domains: strings only, lower-cased, deduplicated; anything else is no domains', () => {
    expect(knowledgeDomains({ knowledge_domains: ['Prospeccion', 'email', 'prospeccion', 3, ''] })).toEqual(['prospeccion', 'email']);
    expect(knowledgeDomains({ knowledge_domains: 'prospeccion' })).toEqual([]);
    expect(knowledgeDomains({})).toEqual([]);
    expect(knowledgeDomains(null)).toEqual([]);
  });

  it('at most 10 entries, newest first (the order the store returns)', () => {
    const rows = Array.from({ length: 14 }, (_, i) => entry(i));
    const { selected, omitted } = selectEntries(rows);
    expect(selected.map((e) => e.topic)).toEqual(rows.slice(0, 10).map((e) => e.topic));
    expect(omitted).toHaveLength(4);
  });

  it('at most 2,000 characters of block: an entry that does not fit is left out and the next one is tried', () => {
    const long = 'x'.repeat(STATEMENT_MAX_CHARS);
    const rows = [entry(1, long), entry(2, long), entry(3, long), entry(4, long), entry(5, long), entry(6, 'Corta.')];
    const { selected, omitted } = selectEntries(rows);
    expect(selected.map((e) => e.topic)).toEqual(['tema-1', 'tema-2', 'tema-3', 'tema-4', 'tema-6']);
    expect(omitted.map((e) => e.topic)).toEqual(['tema-5']);
    expect(renderKnowledgeBlock(selected).length).toBeLessThanOrEqual(KNOWLEDGE_MAX_CHARS);
  });

  it('renders the block with its title, one line per entry', () => {
    const block = renderKnowledgeBlock([entry(1, 'Deriva cantidades\nde un desglose.')]);
    expect(block.startsWith(`${KNOWLEDGE_BLOCK_TITLE}\n`)).toBe(true);
    expect(block).toContain('- [prospeccion · tema-1] Deriva cantidades de un desglose.');
    expect(renderKnowledgeBlock([])).toBe('');
  });
});

describe('knowledge: resolution, injection and trace', () => {
  it('no knowledge_domains: the store is never read, nothing injected, no trace step', async () => {
    const store = memoryStore([entry(1)]);
    const set = await resolveKnowledge(store, 'publiexpe', { implementation: 'prospector' });
    expect(store.calls).toHaveLength(0);
    expect(set.apply('SYSTEM')).toBe('SYSTEM');
    expect(set.traceStep()).toBeNull();
  });

  it('only entries of the configured domains; the block is appended to the system prompt and the ids go to MEMORY_READ', async () => {
    const store = memoryStore([entry(1, 'Regla de prospección.'), entry(2, 'Regla de email.', 'email')]);
    const set = await resolveKnowledge(store, 'publiexpe', { knowledge_domains: ['prospeccion'] });
    expect(store.calls[0]).toMatchObject({ domains: ['prospeccion'] });
    const system = useKnowledge({ knowledge: set }, 'Eres el Prospector.\n');
    expect(system).toBe(`Eres el Prospector.\n\n${set.block}`);
    expect(system).toContain('Regla de prospección.');
    expect(system).not.toContain('Regla de email.');
    const step = set.traceStep()!;
    expect(step.type).toBe('MEMORY_READ');
    expect(step.output).toMatchObject({ resolution: 'ok', knowledge_entry_ids: [entry(1).id], injected: true, injections: 1, block_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('database error: clean fallback (prompt unchanged), the step records db_error, a warning is logged', async () => {
    const warnings: unknown[] = [];
    const failing: KnowledgeStore = {
      async active() {
        throw new Error('relation "knowledge_entries" does not exist');
      },
    };
    const set = await resolveKnowledge(failing, 'publiexpe', { knowledge_domains: ['email'] }, { warn: (o) => warnings.push(o) });
    expect(set.apply('SYSTEM')).toBe('SYSTEM');
    expect(warnings).toHaveLength(1);
    expect(set.traceStep()).toMatchObject({ type: 'MEMORY_READ', output: { resolution: 'db_error', knowledge_entry_ids: [], injected: false }, error: { code: 'KNOWLEDGE_DB_ERROR' } });
  });

  it('resolved but not used by the agent: the step says injected = false', () => {
    const set = new KnowledgeSet(['prospeccion'], [entry(1)]);
    expect(set.traceStep()!.output).toMatchObject({ injected: false, injections: 0, knowledge_entry_ids: [entry(1).id] });
    expect(KnowledgeSet.empty(['x'], 'empty').traceStep()!.output).toMatchObject({ resolution: 'empty', block_chars: 0 });
  });

  it('the Prospector (direct mode) injects the block in every exhibitor decision', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const irrelevant = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'x', hypothesis: null });
    const provider = new StubProvider({ responses: [irrelevant, irrelevant, irrelevant] });
    const version = desiredProspectorVersion();
    const twenty = new FakeTwenty().client();
    const tools = new ToolExecutor(createDefaultToolRegistry({ twenty }), parseToolPolicy(version.configuration), { tenantId: 'publiexpe', executionId: 'exec-k', agentId: 'a', stage: 'PROSPECTOR' }, new AbortController().signal);
    const knowledge = new KnowledgeSet(['prospeccion'], [entry(1, 'Deriva cantidades de un desglose por producto.')]);
    await new ProspectorAgent().run({
      tenantId: 'publiexpe',
      executionId: 'exec-k',
      agent: { id: 'a', name: 'Prospector', role: 'prospector' },
      version: { id: 'v', version: 1, model: 'm', modelProvider: 'stub', systemPrompt: '', configuration: version.configuration },
      input: fixture,
      provider,
      signal: new AbortController().signal,
      tools,
      knowledge,
    });
    expect(provider.requests).toHaveLength(3);
    for (const r of provider.requests) expect(r.system).toContain(`${KNOWLEDGE_BLOCK_TITLE}\n`);
    expect(provider.requests[0]!.system).toContain('Deriva cantidades de un desglose por producto.');
    expect(knowledge.traceStep()!.output).toMatchObject({ injected: true });
  });

  it('seeded agents: the Prospector reads "prospeccion" and the EmailDrafter "email"', () => {
    expect(knowledgeDomains(desiredProspectorVersion().configuration)).toEqual(['prospeccion']);
    expect(knowledgeDomains(desiredEmailDrafterVersion().configuration)).toEqual(['email']);
  });
});

describe('knowledge: lifecycle rules', () => {
  const ev = [{ type: 'experiment' as const, ref: 'EXP-001' }];
  it('valid transitions; same state is a no-op; SUPERSEDED and REJECTED are final', () => {
    expect(planTransition({ status: 'PROPOSED', evidence: ev }, 'VALIDATED')).toEqual({ changed: true });
    expect(planTransition({ status: 'PROPOSED', evidence: ev }, 'ACTIVE')).toEqual({ changed: true });
    expect(planTransition({ status: 'VALIDATED', evidence: ev }, 'ACTIVE')).toEqual({ changed: true });
    expect(planTransition({ status: 'ACTIVE', evidence: ev }, 'SUPERSEDED')).toEqual({ changed: true });
    expect(planTransition({ status: 'ACTIVE', evidence: ev }, 'ACTIVE')).toEqual({ changed: false });
    for (const [from, to] of [
      ['ACTIVE', 'REJECTED'],
      ['ACTIVE', 'PROPOSED'],
      ['SUPERSEDED', 'ACTIVE'],
      ['REJECTED', 'ACTIVE'],
      ['PROPOSED', 'SUPERSEDED'],
    ] as const) {
      expect(() => planTransition({ status: from, evidence: ev }, to)).toThrow(KnowledgeServiceError);
    }
  });

  it('an entry without evidence cannot be activated', () => {
    expect(() => planTransition({ status: 'PROPOSED', evidence: [] }, 'ACTIVE')).toThrow(/evidence/);
    expect(planTransition({ status: 'PROPOSED', evidence: [] }, 'VALIDATED')).toEqual({ changed: true });
  });

  it('seed: documented knowledge only, each with evidence, short statements, valid domains; no confidence ceiling (EXP-001 regression)', () => {
    expect(KNOWLEDGE_SEED.length).toBeGreaterThanOrEqual(2);
    expect(KNOWLEDGE_SEED.map((e) => `${e.domain}/${e.topic}`)).toEqual([
      'prospeccion/cantidades-y-presupuesto',
      'prospeccion/suposiciones-por-nombre',
      'email/presentacion-primer-contacto',
      'prospeccion/lead-time-comercial',
    ]);
    for (const e of KNOWLEDGE_SEED) {
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.statement.length).toBeLessThanOrEqual(STATEMENT_MAX_CHARS);
      expect(KNOWLEDGE_DOMAIN_RE.test(e.domain)).toBe(true);
      expect(e.statement).not.toMatch(/0,6|techo/);
    }
    expect(KNOWLEDGE_SEED[0]!.evidence[0]).toMatchObject({ type: 'experiment', ref: 'EXP-001' });
    expect(KNOWLEDGE_SEED[2]!.evidence[0]).toMatchObject({ type: 'feedback', ref: '2026-10-07' });
    expect(KNOWLEDGE_SEED[2]!.statement).toContain('expertos en merchandising para empresas');
    // Tanda 18: the lead-time rule, from the user's feedback of 2026-10-12, in the Prospector's domain.
    expect(KNOWLEDGE_SEED[3]!.evidence[0]).toMatchObject({ type: 'feedback', ref: '2026-10-12' });
    expect(KNOWLEDGE_SEED[3]!.statement).toMatch(/45 días/);
    expect(KNOWLEDGE_SEED[3]!.statement).toMatch(/45 a 210 días/);
  });
});

describe('exhibitor research (LLD 5.2): composed from data already read', () => {
  const event = { name: 'Gastrónoma 2026', type: 'FAIR' as const, date: '2026-10-26', location: 'Valencia', source_url: 'https://apps.feriavalencia.com/catalog/gastronoma/exhibitors' };
  it('scout: COMPANY_PROFILE, observed facts only, confidence from the verified data', () => {
    const r = buildExhibitorResearch({
      mode: 'scout',
      event,
      exhibitor: { name: 'ARCECARNE', sector: 'Cárnicos' },
      companyName: 'ARCECARNE',
      companyDomain: 'arcecarne.es',
      domainSource: 'profile',
      profile: { url: `${event.source_url}/1`, status: 'domain_resolved' },
      sources: [event.source_url, `${event.source_url}/1`, event.source_url],
      signalTitle: 'Gastrónoma 2026 — ARCECARNE',
    })!;
    expect(r.researchType).toBe('COMPANY_PROFILE');
    expect(r.sources).toEqual([event.source_url, `${event.source_url}/1`]);
    expect(r.summary).toBe(
      'ARCECARNE figura como expositor en Gastrónoma 2026 (2026-10-26, Valencia) según el catálogo publicado en apps.feriavalencia.com. Sector indicado: Cárnicos. Web: arcecarne.es (tomada de su ficha en el catálogo de la feria).',
    );
    expect(r.confidence).toBe(0.8);
    expect(r.structuredResult).toMatchObject({
      profile: { legalName: 'ARCECARNE', sector: 'Cárnicos', website: 'https://arcecarne.es' },
      signals: [{ type: 'FAIR', sourceUrl: event.source_url, eventDate: '2026-10-26' }],
      dataQuality: { missingFields: ['description', 'employeeRange', 'contacts'], conflicts: [] },
    });
  });

  it('direct: EVENT_EXHIBITORS; name only -> low confidence and the gaps listed; no source -> no research', () => {
    const r = buildExhibitorResearch({ mode: 'direct', event: { ...event, source_url: undefined }, exhibitor: { name: 'X' }, companyName: 'X', companyDomain: null, domainSource: null, sources: ['https://x.example/'], signalTitle: 't' })!;
    expect(r.researchType).toBe('EVENT_EXHIBITORS');
    expect(r.confidence).toBe(0.4);
    expect(r.summary).toContain('El catálogo no indica sector. Sin web verificada.');
    expect((r.structuredResult.dataQuality as { missingFields: string[] }).missingFields).toEqual(['sector', 'website', 'description', 'employeeRange', 'contacts']);
    expect(buildExhibitorResearch({ mode: 'direct', event, exhibitor: { name: 'X' }, companyName: 'X', companyDomain: null, domainSource: null, sources: [], signalTitle: 't' })).toBeNull();
  });
});
