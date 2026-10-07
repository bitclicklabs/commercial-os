/**
 * Versioned skills (MVP-1), without a database: rendering, resolution (exact version vs
 * ACTIVE), fallback to the code constants, state transitions and what the trace records.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProspectorAgent } from '../../src/agents/prospector-agent.js';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SKILL_VERSION, PROSPECTOR_SYSTEM_PROMPT } from '../../src/agents/prospector-prompt.js';
import { EMAIL_DRAFTER_SYSTEM_PROMPT } from '../../src/agents/email-drafter-prompt.js';
import { SCOUT_EXTRACT_SYSTEM_PROMPT, SCOUT_SEARCH_SYSTEM_PROMPT } from '../../src/agents/event-scout-prompt.js';
import type { Skill, SkillRef, SkillVersion } from '../../src/db/schema.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { desiredEmailDrafterVersion } from '../../src/seed/email-drafter-seed.js';
import { CODE_SKILLS, codeSkill } from '../../src/skills/code-skills.js';
import { renderSkill, sha256 } from '../../src/skills/render.js';
import { resolveSkillRefs, SkillSet, useSkill, type SkillStore } from '../../src/skills/resolver.js';
import { planActivate, planDeprecate, SkillServiceError, type VersionState } from '../../src/skills/service.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const T = 'publiexpe';
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function skill(name: string, activeVersionId: string | null): Skill {
  return { id: id(), tenantId: T, name, description: null, domain: null, status: activeVersionId ? 'ACTIVE' : 'DRAFT', activeVersionId, createdAt: new Date(), updatedAt: new Date() };
}
function version(skillId: string, n: number, status: SkillVersion['status'], instructions: string, extra: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id: id(),
    tenantId: T,
    skillId,
    version: n,
    status,
    instructions,
    constraints: null,
    examples: null,
    antiPatterns: null,
    metadata: {},
    contentHash: sha256(instructions),
    activatedAt: status === 'DRAFT' ? null : new Date(),
    deprecatedAt: null,
    createdAt: new Date(),
    createdBy: 'test',
    ...extra,
  };
}

/** Store with skill `prospector-event-exhibitors`: v1 DEPRECATED (constant), v2 ACTIVE, v3 DRAFT. */
function store() {
  const s = skill(PROSPECTOR_SKILL_ID, null);
  const v1 = version(s.id, 1, 'DEPRECATED', PROSPECTOR_SYSTEM_PROMPT);
  const v2 = version(s.id, 2, 'ACTIVE', 'PROMPT V2');
  const v3 = version(s.id, 3, 'DRAFT', 'PROMPT V3');
  s.activeVersionId = v2.id;
  s.status = 'ACTIVE';
  const st: SkillStore & { calls: number } = {
    calls: 0,
    async load(tenantId, names) {
      st.calls += 1;
      if (tenantId !== T) return { skills: [], versions: [] };
      const skills = [s].filter((x) => names.includes(x.name));
      return { skills, versions: skills.length ? [v1, v2, v3] : [] };
    },
  };
  return { st, s, v1, v2, v3 };
}

function warnings() {
  const list: Array<{ obj: object; msg?: string | undefined }> = [];
  return { list, logger: { warn: (obj: object, msg?: string) => list.push({ obj, msg }) } };
}

describe('renderSkill', () => {
  it('renders instructions verbatim, so the migrated v1 is byte for byte the constant', () => {
    for (const cs of CODE_SKILLS) expect(renderSkill({ instructions: cs.text })).toBe(cs.text);
  });

  it('appends constraints, anti-patterns and examples as sections', () => {
    const text = renderSkill({ instructions: 'Base', constraints: ' No inventes. ', antiPatterns: 'Superlativos', examples: [{ in: 1 }, 'texto'] });
    expect(text).toBe('Base\n\n## Restricciones\nNo inventes.\n\n## Antipatrones (no lo hagas)\nSuperlativos\n\n## Ejemplos\n{\n  "in": 1\n}\n\ntexto');
  });
});

describe('code skills (fallbacks and seed content)', () => {
  it('registers the four MVP-0 prompts with their exact constants', () => {
    expect(CODE_SKILLS.map((s) => s.name)).toEqual(['prospector-event-exhibitors', 'event-source-discovery', 'exhibitor-list-extraction', 'email-first-contact-draft']);
    expect(codeSkill('prospector-event-exhibitors')!.text).toBe(PROSPECTOR_SYSTEM_PROMPT);
    expect(codeSkill('event-source-discovery')!.text).toBe(SCOUT_SEARCH_SYSTEM_PROMPT);
    expect(codeSkill('exhibitor-list-extraction')!.text).toBe(SCOUT_EXTRACT_SYSTEM_PROMPT);
    expect(codeSkill('email-first-contact-draft')!.text).toBe(EMAIL_DRAFTER_SYSTEM_PROMPT);
    expect(codeSkill('prospector-event-exhibitors')!.source).toMatchObject({ legacy_skill_id: 'prospector-event-exhibitors', legacy_version: 2 });
    expect(codeSkill('exhibitor-list-extraction')!.source).toMatchObject({ legacy_skill_id: 'event-source-discovery', legacy_version: 4 });
  });

  it('seeded agent versions reference the database skills by name, unpinned, with an empty system_prompt', () => {
    expect(desiredProspectorVersion()).toMatchObject({ systemPrompt: '', skillRefs: [{ name: 'prospector-event-exhibitors' }, { name: 'event-source-discovery' }, { name: 'exhibitor-list-extraction' }] });
    expect(desiredEmailDrafterVersion()).toMatchObject({ systemPrompt: '', skillRefs: [{ name: 'email-first-contact-draft' }] });
  });
});

describe('resolveSkillRefs', () => {
  it('without version uses the ACTIVE version', async () => {
    const { st, v2 } = store();
    const set = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID }]);
    expect(set.dbText(PROSPECTOR_SKILL_ID)).toBe('PROMPT V2');
    expect(set.traceRecords()).toEqual([
      { name: PROSPECTOR_SKILL_ID, version: 2, skill_version_id: v2.id, content_hash: sha256('PROMPT V2'), source: 'db', requested: { name: PROSPECTOR_SKILL_ID } },
    ]);
  });

  it('with version uses that exact version, whatever its status (DEPRECATED, DRAFT)', async () => {
    const { st, v1, v3 } = store();
    const old = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID, version: 1 }]);
    expect(old.dbText(PROSPECTOR_SKILL_ID)).toBe(PROSPECTOR_SYSTEM_PROMPT);
    expect(old.traceRecords()[0]).toMatchObject({ version: 1, skill_version_id: v1.id, source: 'db' });
    const draft = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID, version: 3 }]);
    expect(draft.traceRecords()[0]).toMatchObject({ version: 3, skill_version_id: v3.id, source: 'db' });
  });

  it('falls back (with a warning) when the skill, the version or the ACTIVE version is missing', async () => {
    const { st } = store();
    const w = warnings();
    const set = await resolveSkillRefs(st, T, [{ name: 'unknown-skill' }, { name: PROSPECTOR_SKILL_ID, version: 9 }], w.logger);
    expect(set.dbText('unknown-skill')).toBeUndefined();
    expect(set.dbText(PROSPECTOR_SKILL_ID)).toBeUndefined();
    expect(set.runRecords().map((r) => [r.name, r.source, r.fallback_reason])).toEqual([
      ['unknown-skill', 'none', 'skill_not_found'],
      [PROSPECTOR_SKILL_ID, 'none', 'version_not_found'],
    ]);
    expect(w.list).toHaveLength(2);

    const noActive: SkillStore = { load: async () => ({ skills: [skill('draft-only', null)], versions: [] }) };
    const w2 = warnings();
    const r2 = await resolveSkillRefs(noActive, T, [{ name: 'draft-only' }], w2.logger);
    expect(r2.runRecords()[0]).toMatchObject({ source: 'none', fallback_reason: 'no_active_version' });
    expect(w2.list).toHaveLength(1);
  });

  it('a database error never fails the run: every db ref falls back with db_error', async () => {
    const broken: SkillStore = {
      load: async () => {
        throw new Error('relation "skills" does not exist');
      },
    };
    const w = warnings();
    const set = await resolveSkillRefs(broken, T, [{ name: PROSPECTOR_SKILL_ID }], w.logger);
    expect(set.runRecords()[0]).toMatchObject({ source: 'none', fallback_reason: 'db_error' });
    expect(set.use(PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT)).toBe(PROSPECTOR_SYSTEM_PROMPT);
    expect(w.list[0]!.obj).toMatchObject({ err: 'relation "skills" does not exist' });
  });

  it('legacy MVP-0 refs ({skill_id, version}) never read the database', async () => {
    const { st } = store();
    const set = await resolveSkillRefs(st, T, [{ skill_id: PROSPECTOR_SKILL_ID, version: 2 }] as SkillRef[]);
    expect(st.calls).toBe(0);
    expect(set.dbText(PROSPECTOR_SKILL_ID)).toBeUndefined();
    expect(set.runRecords()[0]).toMatchObject({ name: PROSPECTOR_SKILL_ID, version: 2, source: 'none', fallback_reason: 'legacy_ref' });
  });

  it('is tenant-scoped and tolerates empty or malformed refs', async () => {
    const { st } = store();
    expect((await resolveSkillRefs(st, 'other-tenant', [{ name: PROSPECTOR_SKILL_ID }])).dbText(PROSPECTOR_SKILL_ID)).toBeUndefined();
    expect((await resolveSkillRefs(st, T, [])).traceRecords()).toEqual([]);
    expect((await resolveSkillRefs(st, T, null)).traceRecords()).toEqual([]);
  });
});

describe('SkillSet.use: what the trace records', () => {
  it('database text wins over the fallback; the record keeps version id and hash of the exact text', async () => {
    const { st, v2 } = store();
    const set = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID }]);
    expect(set.use(PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT)).toBe('PROMPT V2');
    const [rec] = set.traceRecords();
    expect(rec).toMatchObject({ source: 'db', skill_version_id: v2.id, content_hash: sha256('PROMPT V2') });
    expect(rec!.text).toBeUndefined();
  });

  it('a fallback is recorded with its exact text, its hash and the code version', async () => {
    const set = await resolveSkillRefs(store().st, T, [{ name: 'unknown-skill' }, { skill_id: PROSPECTOR_SKILL_ID, version: 2 }] as SkillRef[]);
    expect(set.use(PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT)).toBe(PROSPECTOR_SYSTEM_PROMPT);
    expect(set.use(PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT)).toBe(PROSPECTOR_SYSTEM_PROMPT); // deduped
    const recs = set.traceRecords();
    expect(recs).toHaveLength(2);
    expect(recs[1]).toEqual({
      name: PROSPECTOR_SKILL_ID,
      version: PROSPECTOR_SKILL_VERSION,
      skill_version_id: null,
      content_hash: sha256(PROSPECTOR_SYSTEM_PROMPT),
      source: 'code',
      requested: { skill_id: PROSPECTOR_SKILL_ID, version: 2 },
      fallback_reason: 'legacy_ref',
      text: PROSPECTOR_SYSTEM_PROMPT,
    });
    expect(recs[0]).toMatchObject({ name: 'unknown-skill', source: 'none' });
    expect(set.runRecords()[1]!.text).toBeUndefined();
  });

  it('a code skill used without a ref is recorded as not_referenced; useSkill without a set returns the fallback', () => {
    const set = SkillSet.empty();
    expect(set.use('exhibitor-list-extraction', SCOUT_EXTRACT_SYSTEM_PROMPT)).toBe(SCOUT_EXTRACT_SYSTEM_PROMPT);
    expect(set.traceRecords()[0]).toMatchObject({ name: 'exhibitor-list-extraction', version: 4, source: 'code', requested: null, fallback_reason: 'not_referenced', text: SCOUT_EXTRACT_SYSTEM_PROMPT });
    expect(useSkill({}, 'x', 'fallback')).toBe('fallback');
  });
});

describe('ProspectorAgent with database skills', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as { event: unknown; exhibitors: unknown[] };
  const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'Sin encaje.', hypothesis: null });

  async function run(skills: SkillSet | undefined) {
    const provider = new StubProvider({ responseText: IRRELEVANT });
    const version = desiredProspectorVersion();
    const tools = new ToolExecutor(
      createDefaultToolRegistry({ twenty: new FakeTwenty().client() }),
      parseToolPolicy(version.configuration),
      { tenantId: T, executionId: 'exec-skills', agentId: 'agent-1', stage: 'PROSPECTOR' },
      new AbortController().signal,
    );
    await new ProspectorAgent().run({
      tenantId: T,
      executionId: 'exec-skills',
      agent: { id: 'agent-1', name: 'Prospector', role: 'prospector' },
      version: { id: 'v', version: 9, model: 'gemini-flash-latest', modelProvider: 'stub', systemPrompt: version.systemPrompt, configuration: version.configuration },
      input: { event: fixture.event, exhibitors: fixture.exhibitors.slice(0, 1) },
      provider,
      signal: new AbortController().signal,
      tools,
      ...(skills ? { skills } : {}),
    });
    return provider.requests.map((r) => r.system);
  }

  it('injects the ACTIVE database version instead of the constant', async () => {
    const set = await resolveSkillRefs(store().st, T, desiredProspectorVersion().skillRefs);
    expect(await run(set)).toEqual(['PROMPT V2']);
  });

  it('without skills (MVP-0 path) the prompt is still the constant, exactly', async () => {
    expect(await run(undefined)).toEqual([PROSPECTOR_SYSTEM_PROMPT]);
    const set = await resolveSkillRefs({ load: async () => ({ skills: [], versions: [] }) }, T, desiredProspectorVersion().skillRefs);
    expect(await run(set)).toEqual([PROSPECTOR_SYSTEM_PROMPT]);
    expect(set.traceRecords().find((r) => r.name === PROSPECTOR_SKILL_ID)).toMatchObject({ source: 'code', fallback_reason: 'skill_not_found', text: PROSPECTOR_SYSTEM_PROMPT, content_hash: sha256(PROSPECTOR_SYSTEM_PROMPT) });
  });
});

describe('state transitions', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 12, 0, s));
  const v = (n: number, status: VersionState['status'], activatedAt: Date | null): VersionState => ({ id: `v${n}`, version: n, status, activatedAt });

  it('activate: DRAFT -> ACTIVE and the previous ACTIVE -> DEPRECATED; idempotent on ACTIVE', () => {
    const versions = [v(1, 'ACTIVE', at(1)), v(2, 'DRAFT', null)];
    expect(planActivate(versions, 2)).toEqual({ changed: true, deprecate: ['v1'], activate: 'v2', activeVersionId: 'v2' });
    expect(planActivate(versions, 1)).toEqual({ changed: false, deprecate: [], activate: null });
    expect(planActivate([v(1, 'DRAFT', null)], 1)).toEqual({ changed: true, deprecate: [], activate: 'v1', activeVersionId: 'v1' });
  });

  it('activate a DEPRECATED version is a manual rollback', () => {
    expect(planActivate([v(1, 'DEPRECATED', at(1)), v(2, 'ACTIVE', at(2))], 1)).toMatchObject({ deprecate: ['v2'], activate: 'v1' });
  });

  it('deprecate: DRAFT -> DEPRECATED; idempotent on DEPRECATED', () => {
    expect(planDeprecate([v(1, 'ACTIVE', at(1)), v(2, 'DRAFT', null)], 2)).toEqual({ changed: true, deprecate: ['v2'], activate: null, restore: null });
    expect(planDeprecate([v(1, 'DEPRECATED', at(1))], 1)).toMatchObject({ changed: false });
  });

  it('deprecate the ACTIVE version restores the most recently activated earlier version', () => {
    const versions = [v(1, 'DEPRECATED', at(5)), v(2, 'DEPRECATED', at(3)), v(3, 'ACTIVE', at(6)), v(4, 'DRAFT', null)];
    expect(planDeprecate(versions, 3)).toMatchObject({ changed: true, deprecate: ['v3'], activate: 'v1', activeVersionId: 'v1' });
  });

  it('deprecate the ACTIVE version with no earlier one to restore is rejected (409)', () => {
    expect(() => planDeprecate([v(1, 'ACTIVE', at(1)), v(2, 'DEPRECATED', at(2))], 1)).toThrow(SkillServiceError);
    expect(() => planDeprecate([v(1, 'ACTIVE', at(1))], 1)).toThrow(/no earlier version/);
    expect(() => planActivate([v(1, 'ACTIVE', at(1))], 7)).toThrow(/not found/);
  });
});
