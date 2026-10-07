/**
 * Skill canary routing (src/skills/canary.ts + resolver), without a database: the arm of a run
 * is a deterministic hash of the canary id and the routing key (same key -> same version), the
 * share approaches the percent over many keys, pinned refs never take part and the record
 * carries the arm, bucket and key (P4). Plus the harness arms of skill:compare (timeout, capped
 * tool policy and max_output_tokens).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID } from '../../src/agents/prospector-prompt.js';
import type { Skill, SkillCanary, SkillVersion } from '../../src/db/schema.js';
import { applyHarness, normalizeHarnessConfig } from '../../src/harness/config.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk } from '../../src/providers/model-provider.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { CANARY_BUCKETS, canaryArm, canaryBucket, canaryRouting } from '../../src/skills/canary.js';
import { runSkillComparison, type CompareVersion } from '../../src/skills/compare.js';
import { sha256 } from '../../src/skills/render.js';
import { resolveSkillRefs, type SkillStore } from '../../src/skills/resolver.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor, type AgentToolPolicy } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const T = 'publiexpe';
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function version(skillId: string, n: number, status: SkillVersion['status'], instructions: string): SkillVersion {
  return { id: id(), tenantId: T, skillId, version: n, status, instructions, constraints: null, examples: null, antiPatterns: null, metadata: {}, contentHash: sha256(instructions), activatedAt: status === 'DRAFT' ? null : new Date(), deprecatedAt: null, createdAt: new Date(), createdBy: 'test' };
}

function world(percent: number) {
  const s: Skill = { id: id(), tenantId: T, name: PROSPECTOR_SKILL_ID, description: null, domain: null, status: 'ACTIVE', activeVersionId: null, createdAt: new Date(), updatedAt: new Date() };
  const v1 = version(s.id, 1, 'ACTIVE', 'PROMPT ESTABLE');
  const v2 = version(s.id, 2, 'DRAFT', 'PROMPT CANARIO');
  s.activeVersionId = v1.id;
  const canary: SkillCanary = {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    tenantId: T,
    skillId: s.id,
    canaryVersionId: v2.id,
    canaryVersion: 2,
    stableVersionId: v1.id,
    stableVersion: 1,
    percent,
    status: 'ACTIVE',
    experimentId: id(),
    gate: {},
    startedAt: new Date(),
    startedBy: 'test',
    finishedAt: null,
    finishedBy: null,
    finishReason: null,
    finishGate: null,
  };
  const st: SkillStore = { load: async () => ({ skills: [s], versions: [v1, v2], canaries: [canary] }) };
  return { s, v1, v2, canary, st };
}

describe('canary routing (deterministic hash)', () => {
  it('same canary + same key -> same bucket and arm, always; no key -> stable', () => {
    const c = 'c0ffee00-0000-4000-8000-000000000001';
    for (const key of ['run-1', 'b3a1c9e2-7d1f-4a0e-9a63-2f7c1d2e3f40', 'x']) {
      const b = canaryBucket(c, key);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(CANARY_BUCKETS);
      expect(canaryBucket(c, key)).toBe(b);
      expect(canaryArm(c, 30, key)).toEqual(canaryArm(c, 30, key));
    }
    expect(canaryArm(c, 99, null)).toEqual({ arm: 'stable', bucket: null });
    expect(canaryArm(c, 99, '')).toEqual({ arm: 'stable', bucket: null });
    // The arm depends on the canary too: another canary reshuffles the keys.
    const keys = Array.from({ length: 200 }, (_, i) => `run-${i}`);
    const other = 'c0ffee00-0000-4000-8000-000000000002';
    expect(keys.some((k) => canaryArm(c, 50, k).arm !== canaryArm(other, 50, k).arm)).toBe(true);
  });

  it('the canary share approaches the percent over many keys, and a higher percent only adds keys', () => {
    const c = 'c0ffee00-0000-4000-8000-0000000000aa';
    const keys = Array.from({ length: 10_000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const percent of [5, 10, 25, 50]) {
      const share = keys.filter((k) => canaryArm(c, percent, k).arm === 'canary').length / keys.length;
      expect(Math.abs(share - percent / 100)).toBeLessThan(0.015);
    }
    // Monotone: a key in the canary at 10 % stays there at 25 % (ramping up keeps attribution stable).
    expect(keys.filter((k) => canaryArm(c, 10, k).arm === 'canary').every((k) => canaryArm(c, 25, k).arm === 'canary')).toBe(true);
  });

  it('canaryRouting records arm, bucket, key and both versions', () => {
    const { canary } = world(40);
    const r = canaryRouting(canary, 'run-7');
    expect(r).toEqual({ canary_id: canary.id, arm: canaryArm(canary.id, 40, 'run-7').arm, percent: 40, bucket: canaryBucket(canary.id, 'run-7'), routing_key: 'run-7', stable_version: 1, canary_version: 2 });
  });
});

describe('resolver with an ACTIVE canary', () => {
  it('a ref that follows the ACTIVE version gets the arm of its key; the text and record match the arm', async () => {
    const { st, v1, v2, canary } = world(50);
    const keys = Array.from({ length: 40 }, (_, i) => `task-run-${i}`);
    const arms = new Set<string>();
    for (const key of keys) {
      const set = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID }], undefined, { routingKey: key });
      const [rec] = set.traceRecords();
      const expected = canaryArm(canary.id, 50, key).arm;
      arms.add(expected);
      expect(rec).toMatchObject({ source: 'db', version: expected === 'canary' ? 2 : 1, skill_version_id: expected === 'canary' ? v2.id : v1.id, canary: { canary_id: canary.id, arm: expected, routing_key: key } });
      expect(set.dbText(PROSPECTOR_SKILL_ID)).toBe(expected === 'canary' ? 'PROMPT CANARIO' : 'PROMPT ESTABLE');
      // Reproducible: the same key resolves the same version again.
      const again = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID }], undefined, { routingKey: key });
      expect(again.traceRecords()[0]!.version).toBe(rec!.version);
    }
    expect(arms).toEqual(new Set(['canary', 'stable']));
  });

  it('a pinned ref ignores the canary; without a routing key the run stays on the stable version (recorded)', async () => {
    const { st, v1 } = world(99);
    const pinned = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID, version: 1 }], undefined, { routingKey: 'run-1' });
    expect(pinned.traceRecords()[0]).toMatchObject({ version: 1, skill_version_id: v1.id });
    expect(pinned.traceRecords()[0]!.canary).toBeUndefined();
    const noKey = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID }]);
    expect(noKey.traceRecords()[0]).toMatchObject({ version: 1, canary: { arm: 'stable', bucket: null, routing_key: null } });
  });

  it('a canary whose stable version is no longer the ACTIVE one does not route (defensive)', async () => {
    const { s, st, v2 } = world(99);
    s.activeVersionId = v2.id; // promoted elsewhere, canary row not closed yet
    const set = await resolveSkillRefs(st, T, [{ name: PROSPECTOR_SKILL_ID }], undefined, { routingKey: 'run-1' });
    expect(set.traceRecords()[0]).toMatchObject({ version: 2 });
    expect(set.traceRecords()[0]!.canary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Harness arms of skill:compare
// ---------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'Sin encaje.', hypothesis: null });

class SlowProvider implements ModelProvider {
  readonly name = 'slow';
  estimateCost(): CostBreakdown {
    return { modelCost: 0, currency: 'EUR' };
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    await new Promise((r) => setTimeout(r, 1_500));
    return { text: IRRELEVANT, model: request.model, provider: this.name, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, cost: this.estimateCost(), latencyMs: 1_500 };
  }
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'done', result };
  }
}

describe('skill:compare with harness arms', () => {
  const agentVersion = desiredProspectorVersion();
  const base = parseToolPolicy(agentVersion.configuration);
  const text = 'Eres el Prospector (skill fija).';
  const arm = (n: number, config: Parameters<typeof normalizeHarnessConfig>[0]): CompareVersion => ({
    version: n,
    status: n === 1 ? 'ACTIVE' : 'DRAFT',
    skillVersionId: 'sv-1',
    skillVersion: 1,
    text,
    contentHash: sha256(text),
    harness: {
      name: 'h-prueba',
      version: n,
      harnessVersionId: `hv-${n}`,
      contentHash: `hash-${n}`,
      policies: applyHarness(normalizeHarnessConfig(config), { timeoutMs: 300_000, retry: { max_attempts: 1, backoff_ms: 0 }, twentyWaitMaxMs: null, toolPolicy: base, configuration: agentVersion.configuration }),
    },
  });
  const tools = () => {
    const seen: Array<AgentToolPolicy | undefined> = [];
    const makeTools = (label: string, policy?: AgentToolPolicy) => {
      seen.push(policy);
      return new ToolExecutor(createDefaultToolRegistry({ twenty: new FakeTwenty().client() }), policy ?? base, { tenantId: T, executionId: label, agentId: 'test', stage: 'PROSPECTOR' }, new AbortController().signal);
    };
    return { seen, makeTools };
  };

  it('each arm runs with its effective policies: capped max_output_tokens and tool policy; the skill record is the fixed skill version', async () => {
    const provider = new StubProvider({ responseText: IRRELEVANT });
    const t = tools();
    const report = await runSkillComparison({
      skillName: PROSPECTOR_SKILL_ID,
      versions: [arm(1, {}), arm(2, { context: { max_output_tokens: 1200 }, tools: { max_calls_per_execution: 3, max_risk_level: 'READ' } })],
      input: fixture,
      provider,
      makeTools: t.makeTools,
      agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
    });
    expect(report.harness).toBe('h-prueba');
    expect(report.versions.map((v) => [v.version, v.skillVersion, v.harness?.harnessVersionId])).toEqual([
      [1, 1, 'hv-1'],
      [2, 1, 'hv-2'],
    ]);
    expect(new Set(provider.requests.map((r) => r.maxTokens))).toEqual(new Set([4096, 1200]));
    expect(t.seen.map((p) => [p?.maxCallsPerExecution, p?.maxRiskLevel])).toEqual([
      [base.maxCallsPerExecution, base.maxRiskLevel],
      [3, 'READ'],
    ]);
    const [r1, r2] = report.runs;
    expect(r1!.skillRecords[0]).toMatchObject({ version: 1, skill_version_id: 'sv-1' });
    expect(r2!.skillRecords[0]).toMatchObject({ version: 1, skill_version_id: 'sv-1' });
    expect(r2!.harness).toMatchObject({ label: 'h-prueba@2', attempts: 1, timed_out: false, overrides: expect.arrayContaining(['context.max_output_tokens', 'tools.max_calls_per_execution', 'tools.max_risk_level']) });
  });

  it('the harness timeout aborts the run like the worker (TIMED_OUT, no decisions, no retry)', async () => {
    const t = tools();
    const report = await runSkillComparison({
      skillName: PROSPECTOR_SKILL_ID,
      versions: [arm(1, {}), arm(2, { execution: { timeout_seconds: 1, retry: { max_attempts: 3, backoff_ms: 0 } } })],
      input: { ...fixture, exhibitors: (fixture.exhibitors as unknown[]).slice(0, 1) },
      provider: new SlowProvider(),
      makeTools: t.makeTools,
      agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration },
    });
    const slow = report.runs.find((r) => r.version === 2)!;
    expect(slow.outcome).toBe('TIMED_OUT');
    expect(slow.harness).toMatchObject({ timed_out: true, attempts: 1 });
    expect(slow.decisions.every((d) => d.confidence === null)).toBe(true);
    expect(report.runs.find((r) => r.version === 1)!.outcome).not.toBe('TIMED_OUT');
  }, 15_000);

  it('rejects arms of two different harnesses', async () => {
    const other = { ...arm(2, {}), harness: { ...arm(2, {}).harness!, name: 'otra' } };
    await expect(
      runSkillComparison({ skillName: PROSPECTOR_SKILL_ID, versions: [arm(1, {}), other], input: fixture, provider: new StubProvider({ responseText: IRRELEVANT }), makeTools: tools().makeTools, agentVersion: { model: agentVersion.model, configuration: agentVersion.configuration } }),
    ).rejects.toThrow(/MISMA harness/);
  });
});
