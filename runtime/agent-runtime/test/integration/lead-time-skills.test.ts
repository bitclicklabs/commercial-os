/**
 * Tanda 18 · lead time against a real PostgreSQL (own database: DATABASE_URL=.../agentos_wt18_skills):
 *
 * - the seed creates the DRAFT candidates of the Prospector and the EmailDrafter through the skill
 *   service, idempotently, without touching the ACTIVE versions (nothing is activated);
 * - the knowledge entry prospeccion/lead-time-comercial is ACTIVE with evidence and the
 *   Prospector's MEMORY_READ injects it;
 * - an experiment of the Prospector candidate on a synthetic dataset with the lead-time templates
 *   runs with a scripted executor (no network): each lead-time fixture sees its own "today"
 *   (as_of), the gate decides (form mode: PASS_FORM at most) and the verdict is stored, nothing
 *   is activated.
 * Fresh tenants per run, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_DRAFTER_SKILL_ID } from '../../src/agents/email-drafter-prompt.js';
import { daysUntilEvent } from '../../src/agents/email-draft.js';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import { buildDataset } from '../../src/datasets/service.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { experiments, knowledgeEntries, skills } from '../../src/db/schema.js';
import { gateConfig, runExperiment } from '../../src/experiments/index.js';
import { resolveKnowledge } from '../../src/knowledge/resolver.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../../src/providers/model-provider.js';
import { seedCatalogSkillCandidate } from '../../src/seed/catalog-skill-seed.js';
import { LEAD_TIME_KNOWLEDGE_STATEMENT, seedKnowledge } from '../../src/seed/knowledge-seed.js';
import { seedLeadTimeCandidates } from '../../src/seed/lead-time-seed.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { CALM_PRODUCTION_ANGLE, LEAD_TIME_CANDIDATE, OUT_OF_WINDOW_REASON, shortLeadTimeFragments } from '../../src/skills/lead-time-candidates.js';
import { findSkill, listVersions } from '../../src/skills/service.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

async function databaseReachable(url: string): Promise<boolean> {
  if (process.env.SKIP_DB_TESTS === '1') return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
const dbAvailable = await databaseReachable(DATABASE_URL);

// ---------------------------------------------------------------------------
// Scripted executor: the ACTIVE skill (no lead-time section) answers like the Gastrónoma run did
// (relevant, "plazos cortos"); the candidate applies the lead-time rule from the prompt's dates.
// ---------------------------------------------------------------------------

const CANDIDATE_MARK = '## Ventana comercial (lead time)';

const hypothesis = (whyNow: string) => ({
  need: 'Unas 300 bolsas tote (estimación orientativa) y 15 polos bordados para el equipo.',
  why_now: whyNow,
  quantity_min: 250,
  quantity_max: 450,
  budget_min_eur: 700,
  budget_max_eur: 1500,
  recommended_products: ['bolsas tote de algodón', 'polos bordados'],
  timing: 'NEXT_QUARTER',
  differentiators: ['TALLER_PROPIO'],
});

function answer(candidate: boolean, content: string) {
  const block = content.slice(content.indexOf('<expositor>'), content.indexOf('</expositor>'));
  const today = /Fecha de hoy: (\d{4}-\d{2}-\d{2})/.exec(content)?.[1] ?? '';
  const date = /"date":\s*"([^"]+)"/.exec(content.slice(content.indexOf('<evento>'), content.indexOf('</evento>')))?.[1] ?? null;
  const days = daysUntilEvent(date, today);
  const name = /"name":\s*"([^"]+)"/.exec(block)?.[1] ?? '';
  const hasDescription = /"description":/.test(block);
  const hasSector = /"sector":/.test(block);
  if (/Ayuntamiento|Diputación|Consejería|capital íntegramente público|negocio principal es la venta de merchandising/.test(block)) return { relevant: false, confidence: 0.05, reason: 'Organismo público o competidor: sin encaje comercial.', hypothesis: null };
  if (candidate && days !== null && days < 45) return { relevant: false, confidence: 0.05, reason: `${OUT_OF_WINDOW_REASON}: la feria es en ${days} días.`, hypothesis: null };
  const whyNow = candidate ? `A unas semanas de la feria: hay tiempo para ${CALM_PRODUCTION_ANGLE}.` : 'Al quedar pocos días para la feria, el taller propio puede adaptarnos a estos plazos cortos.';
  if (!hasDescription && !hasSector) {
    if (/^(Grupo|Inversiones)|Holding|Global/.test(name)) return { relevant: false, confidence: 0.05, reason: 'Datos insuficientes para identificar actividad comercial.', hypothesis: null };
    return { relevant: true, confidence: 0.55, reason: 'Por el nombre, parece un productor del sector; sin más datos.', hypothesis: hypothesis(whyNow) };
  }
  if (!hasDescription) return { relevant: true, confidence: 0.7, reason: 'Empresa del sector con stand; faltan datos de tamaño.', hypothesis: hypothesis(whyNow) };
  const units = /(?:necesita|presupuesto para) (\d+) unidades/.exec(block)?.[1];
  const h = hypothesis(whyNow);
  if (units) Object.assign(h, { quantity_min: Number(units), quantity_max: Math.round(Number(units) * 1.2), need: `Unas ${units} unidades con logotipo (estimación orientativa).` });
  return { relevant: true, confidence: 0.85, reason: 'Fabricante con lanzamiento y presencia en la feria; tamaño estimado.', hypothesis: h };
}

class ScriptedExecutor implements ModelProvider {
  readonly name = 'scripted';
  prompts: Array<{ candidate: boolean; content: string }> = [];
  estimateCost(_m: string, _u: TokenUsage): CostBreakdown {
    return { modelCost: 0.002, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const content = request.messages.map((m) => m.content).join('\n');
    const candidate = (request.system ?? '').includes(CANDIDATE_MARK);
    this.prompts.push({ candidate, content });
    const text = JSON.stringify(answer(candidate, content));
    return { text, model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1500, outputTokens: 300, cachedTokens: 0 }, cost: this.estimateCost(request.model, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), latencyMs: 0 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

describe.skipIf(!dbAvailable)('lead time: skill candidates, knowledge and synthetic experiment (PostgreSQL)', () => {
  const tenant = `it-leadtime-${randomUUID().slice(0, 8)}`;
  const evTenant = `it-leadtime-ev-${randomUUID().slice(0, 8)}`;
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  const activeOf = async (name: string) => {
    const skill = (await findSkill(handle.db, tenant, name))!;
    const versions = await listVersions(handle.db, skill.id);
    return { skill, versions, active: versions.find((v) => v.status === 'ACTIVE')! };
  };

  it('seed: DRAFT candidates of both skills from their ACTIVE text, idempotent, ACTIVE versions untouched', async () => {
    await seedSkills(handle.db, { tenantId: tenant });
    // Same order as `pnpm seed`: the catalog candidate exists first.
    await seedCatalogSkillCandidate(handle.db, { tenantId: tenant });
    const before = { p: await activeOf(PROSPECTOR_SKILL_ID), e: await activeOf(EMAIL_DRAFTER_SKILL_ID) };

    const first = await seedLeadTimeCandidates(handle.db, { tenantId: tenant });
    expect(first).toEqual([
      { skill: PROSPECTOR_SKILL_ID, action: 'created', version: 3, status: 'DRAFT', base_version: 1 },
      { skill: EMAIL_DRAFTER_SKILL_ID, action: 'created', version: 2, status: 'DRAFT', base_version: 1 },
    ]);
    const second = await seedLeadTimeCandidates(handle.db, { tenantId: tenant });
    expect(second.map((s) => [s.action, s.version, s.status])).toEqual([
      ['unchanged', 3, 'DRAFT'],
      ['unchanged', 2, 'DRAFT'],
    ]);

    const after = { p: await activeOf(PROSPECTOR_SKILL_ID), e: await activeOf(EMAIL_DRAFTER_SKILL_ID) };
    // ACTIVE untouched: same version, same row, same content; the skill pointer did not move.
    expect(after.p.active.id).toBe(before.p.active.id);
    expect(after.e.active.id).toBe(before.e.active.id);
    expect(after.p.skill.activeVersionId).toBe(before.p.skill.activeVersionId);
    expect(after.e.skill.activeVersionId).toBe(before.e.skill.activeVersionId);
    expect(after.p.active.contentHash).toBe(before.p.active.contentHash);
    expect(after.p.versions.filter((v) => v.status === 'ACTIVE')).toHaveLength(1);
    expect(after.p.versions).toHaveLength(3);
    expect(after.e.versions).toHaveLength(2);

    const pc = after.p.versions.find((v) => v.version === 3)!;
    const ec = after.e.versions.find((v) => v.version === 2)!;
    for (const v of [pc, ec]) {
      expect(v.status).toBe('DRAFT');
      expect(v.activatedAt).toBeNull();
      expect(v.metadata).toMatchObject({ candidate: LEAD_TIME_CANDIDATE, base_version: 1, copied_from: { version: 1 }, feedback: { type: 'feedback', ref: '2026-10-12' } });
      expect(String(v.metadata.change_reason)).toContain('2026-10-12');
      expect(shortLeadTimeFragments(v.instructions)).toEqual([]);
      expect(v.instructions).toContain(CALM_PRODUCTION_ANGLE);
    }
    expect(pc.instructions).toContain(CANDIDATE_MARK);
    expect(ec.instructions).toContain('es el momento ideal para dejar el merchandising resuelto con calma');
    // Skill rows stay ACTIVE with their v1.
    const rows = await handle.db.select().from(skills).where(eq(skills.tenantId, tenant));
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it('a skill whose ACTIVE text lost an anchor is skipped with the reason (nothing created)', async () => {
    const t = `${tenant}-nolink`;
    const { createSkill } = await import('../../src/skills/service.js');
    await createSkill(handle.db, { tenantId: t, name: PROSPECTOR_SKILL_ID, content: { instructions: 'Texto sin las anclas.' }, activate: true });
    const r = await seedLeadTimeCandidates(handle.db, { tenantId: t });
    expect(r[0]).toMatchObject({ skill: PROSPECTOR_SKILL_ID, action: 'skipped', version: null });
    expect(r[0]!.reason).toMatch(/does not take the operations/);
    expect(r[1]).toMatchObject({ skill: EMAIL_DRAFTER_SKILL_ID, action: 'skipped', reason: 'skill not found (run the skills seed first)' });
    const skill = (await findSkill(handle.db, t, PROSPECTOR_SKILL_ID))!;
    expect(await listVersions(handle.db, skill.id)).toHaveLength(1);
  });

  it('knowledge: lead-time-comercial ACTIVE with the 2026-10-12 evidence, and the Prospector MEMORY_READ injects it', async () => {
    await seedKnowledge(handle.db, { tenantId: tenant });
    const [entry] = await handle.db
      .select()
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.tenantId, tenant), eq(knowledgeEntries.domain, 'prospeccion'), eq(knowledgeEntries.topic, 'lead-time-comercial')));
    expect(entry).toMatchObject({ status: 'ACTIVE', source: 'human', statement: LEAD_TIME_KNOWLEDGE_STATEMENT });
    expect(entry!.evidence[0]).toMatchObject({ type: 'feedback', ref: '2026-10-12' });
    expect(entry!.activatedAt).not.toBeNull();

    // The Prospector's configuration (knowledge_domains = ['prospeccion']), as the worker resolves it.
    const set = await resolveKnowledge(handle.db, tenant, desiredProspectorVersion().configuration);
    expect(set.domains).toEqual(['prospeccion']);
    expect(set.entries.map((e) => e.topic)).toContain('lead-time-comercial');
    const system = set.apply('Sistema base.');
    expect(system).toContain(LEAD_TIME_KNOWLEDGE_STATEMENT);
    const step = set.traceStep()!;
    expect(step.type).toBe('MEMORY_READ');
    expect((step.output as { knowledge_entry_ids: string[] }).knowledge_entry_ids).toContain(entry!.id);
    expect(step.output).toMatchObject({ resolution: 'ok', injected: true });
    // The EmailDrafter (domain email) does not get it.
    const email = await resolveKnowledge(handle.db, tenant, { knowledge_domains: ['email'] });
    expect(email.entries.map((e) => e.topic)).not.toContain('lead-time-comercial');
  });

  async function experimentOn(dataset: string) {
    const executor = new ScriptedExecutor();
    const agentVersion = desiredProspectorVersion();
    const policy = parseToolPolicy(agentVersion.configuration);
    const r = await runExperiment(
      {
        db: handle.db,
        executorProvider: executor,
        judgeProvider: null,
        makeTools: (label) => new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), policy, { tenantId: tenant, executionId: label, agentId: 'it-leadtime', stage: 'PROSPECTOR' }, new AbortController().signal),
        agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
        now: () => new Date('2026-10-12T08:00:00Z'),
        evaluationsTenant: evTenant,
      },
      { tenantId: tenant, subjectName: PROSPECTOR_SKILL_ID, candidateVersion: 3, dataset, budgetEur: 1, repeat: 1, gate: gateConfig(), judge: false, createdBy: 'it' },
    );
    return { executor, ...r };
  }

  const stored = async (id: string) => (await handle.db.select().from(experiments).where(eq(experiments.id, id)))[0]!;

  it('experiment on the full synthetic set + lead time: each fixture sees its as_of, the candidate holds the lead-time truth, the gate decides (FAIL: the gain is diluted) and the verdict is stored', async () => {
    const built = await buildDataset(handle.db, { tenantId: tenant, name: 'it-leadtime-synth', domain: 'prospeccion', createdBy: 'it', synthetic: { seed: 18, perTemplate: 1, leadTime: true } });
    expect(built.synthetic).toMatchObject({ total: 14, by_template: { lead_time_too_close: 1, lead_time_comfortable: 1 } });
    const { executor, experiment, report } = await experimentOn('it-leadtime-synth');

    const val = report.phases[0]!;
    expect(val.cases.every((c) => c.use === 'synthetic')).toBe(true);
    expect(val.cases.map((c) => c.template)).toEqual(expect.arrayContaining(['lead_time_too_close', 'lead_time_comfortable']));

    // The lead-time fixtures ran with their own "today" (as_of), the rest with the experiment clock.
    const leadCases = built.cases.filter((c) => c.split === 'SYNTH' && String((c.expected as { ground_truth: { template: string } }).ground_truth.template).startsWith('lead_time_'));
    expect(leadCases).toHaveLength(2);
    for (const c of leadCases) {
      const asOf = (c.expected as { ground_truth: { as_of: string } }).ground_truth.as_of;
      const name = (c.input.exhibitor as { name: string }).name;
      const seen = executor.prompts.filter((p) => p.content.includes(name));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((p) => p.content.startsWith(`Fecha de hoy: ${asOf}`))).toBe(true);
    }
    expect(executor.prompts.some((p) => p.content.startsWith('Fecha de hoy: 2026-10-12'))).toBe(true);

    // Ground truth per template: the ACTIVE v1 fails the lead-time cases, the candidate v3 holds them.
    const row = (template: string, version: number) => val.synthetic!.by_template.find((r) => r.key === template)!.versions.find((v) => v.version === version)!;
    expect(row('lead_time_too_close', 1).rate).toBe(0);
    expect(row('lead_time_too_close', 3).rate).toBe(1);
    expect(row('lead_time_comfortable', 1).rate).toBe(0); // «plazos cortos» in why_now
    expect(row('lead_time_comfortable', 3).rate).toBe(1);

    // Form mode (no labelled case). 2 of 14 cases change: composite +0,005 < 0,02 -> FAIL, with no
    // seesaw regression. The gate decided and the verdict is stored; nothing was activated.
    expect(val.gate.mode).toBe('form');
    expect(val.gate.criteria.find((c) => c.id === 'composite_delta')!.status).toBe('fail');
    expect(val.gate.criteria.find((c) => c.id === 'seesaw')!.status).toBe('pass');
    expect(val.gate.criteria.find((c) => c.id === 'hard_failures')!.status).toBe('pass');
    expect(experiment.decision).toBe('FAIL');
    expect(await stored(experiment.id)).toMatchObject({ status: 'COMPLETED', decision: 'FAIL', subjectName: PROSPECTOR_SKILL_ID, baselineVersion: 1, candidateVersion: 3 });
  });

  it('experiment on the lead-time templates only: PASS_FORM (the most a synthetic dataset can give), stored, nothing activated', async () => {
    const built = await buildDataset(handle.db, { tenantId: tenant, name: 'it-leadtime-only', domain: 'prospeccion', createdBy: 'it', synthetic: { seed: 18, perTemplate: 3, templates: ['lead_time_too_close', 'lead_time_comfortable'] } });
    expect(built.synthetic).toMatchObject({ total: 6 });
    const { experiment, report } = await experimentOn('it-leadtime-only');
    const val = report.phases[0]!;
    expect(val.gate.mode).toBe('form');
    expect(val.gate.criteria.find((c) => c.id === 'accuracy')!.status).toBe('skipped');
    expect(experiment.decision).toBe('PASS_FORM');
    const row = await stored(experiment.id);
    expect(row).toMatchObject({ status: 'COMPLETED', decision: 'PASS_FORM', baselineVersion: 1, candidateVersion: 3 });
    expect((row.gateResult as { decision: string }).decision).toBe('PASS_FORM');
    expect(report.test_skipped).toMatch(/PASS_FORM/);

    // Never activated: v1 is still the ACTIVE one, v3 still DRAFT.
    const { active, versions } = await activeOf(PROSPECTOR_SKILL_ID);
    expect(active.version).toBe(1);
    expect(versions.find((v) => v.version === 3)!.status).toBe('DRAFT');
  });
});
