/**
 * Versioned harness v1, without a database: config validation and normalisation, the
 * precedence rules (harness over task/env, ceiling over the agent's own policy), the
 * resolver (exact version, ACTIVE, every fallback), the trace record, the lifecycle plans
 * and the per-run cap of the Twenty gate.
 */
import { describe, expect, it } from 'vitest';
import type { Harness, HarnessConfig, HarnessVersion } from '../../src/db/schema.js';
import {
  applyHarness,
  DEFAULT_COMMERCIAL_CONFIG,
  harnessConfigHash,
  HarnessConfigInput,
  harnessRecord,
  normalizeHarnessConfig,
  parseHarnessRef,
  placeholderWarnings,
  resolveHarnessRef,
  type HarnessStore,
  type PolicyBaseline,
} from '../../src/harness/index.js';
import { HarnessServiceError, mergeHarnessConfig, planHarnessActivate, planHarnessDeprecate } from '../../src/harness/service.js';
import { desiredEmailDrafterVersion } from '../../src/seed/email-drafter-seed.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';
import { parseToolPolicy } from '../../src/tools/index.js';
import { TwentyGate } from '../../src/worker/twenty-gate.js';

const T = 'publiexpe';
const cfg = (input: HarnessConfigInput): HarnessConfig => normalizeHarnessConfig(input);

function baseline(configuration: Record<string, unknown> = {}, over: Partial<PolicyBaseline> = {}): PolicyBaseline {
  return {
    timeoutMs: 900_000,
    retry: { max_attempts: 1, backoff_ms: 0 },
    twentyWaitMaxMs: 600_000,
    toolPolicy: parseToolPolicy(configuration),
    configuration,
    ...over,
  };
}

function harnessRow(over: Partial<Harness> = {}): Harness {
  const now = new Date('2026-10-07T10:00:00Z');
  return { id: 'h1', tenantId: T, name: 'default-commercial', description: null, status: 'ACTIVE', activeVersionId: 'hv1', createdAt: now, updatedAt: now, ...over };
}

function versionRow(version: number, config: unknown, over: Partial<HarnessVersion> = {}): HarnessVersion {
  const now = new Date('2026-10-07T10:00:00Z');
  return {
    id: `hv${version}`,
    tenantId: T,
    harnessId: 'h1',
    version,
    status: 'DEPRECATED',
    config: config as HarnessConfig,
    metadata: {},
    contentHash: `hash-${version}`,
    activatedAt: null,
    deprecatedAt: null,
    createdAt: now,
    createdBy: 'test',
    ...over,
  };
}

function store(harness: Harness | null, versions: HarnessVersion[] = []): HarnessStore & { calls: number } {
  const s = {
    calls: 0,
    async load() {
      s.calls++;
      return harness ? { harness, versions } : null;
    },
  };
  return s;
}

const V1 = versionRow(1, DEFAULT_COMMERCIAL_CONFIG, { status: 'ACTIVE', activatedAt: new Date('2026-10-07T10:00:00Z') });
const V2 = versionRow(2, cfg({ execution: { timeout_seconds: 60 } }));

describe('harness config', () => {
  it('normalises every key to null and hashes independently of key order', () => {
    const a = cfg({ safety: { twenty_wait_max_ms: 5 }, tools: { max_risk_level: 'READ' } });
    expect(a).toEqual({
      execution: { timeout_seconds: null, retry: null, max_turns: null },
      tools: { max_calls_per_execution: null, max_risk_level: 'READ', parallel_calls: null },
      context: { max_output_tokens: null },
      safety: { twenty_wait_max_ms: 5, verify_before_commit: null },
    });
    const reordered = JSON.parse(JSON.stringify({ tools: a.tools, safety: a.safety, context: a.context, execution: a.execution })) as HarnessConfig;
    expect(harnessConfigHash(reordered)).toBe(harnessConfigHash(a));
    expect(harnessConfigHash(cfg({}))).not.toBe(harnessConfigHash(a));
  });

  it('rejects unknown keys (typos), DESTRUCTIVE and out-of-range values', () => {
    expect(HarnessConfigInput.safeParse({ execution: { timeout_secs: 5 } }).success).toBe(false);
    expect(HarnessConfigInput.safeParse({ memory: { semantic: true } }).success).toBe(false);
    expect(HarnessConfigInput.safeParse({ tools: { max_risk_level: 'DESTRUCTIVE' } }).success).toBe(false);
    expect(HarnessConfigInput.safeParse({ execution: { timeout_seconds: 0 } }).success).toBe(false);
    expect(HarnessConfigInput.safeParse({ execution: { retry: { max_attempts: 11, backoff_ms: 0 } } }).success).toBe(false);
    expect(HarnessConfigInput.safeParse({ safety: { twenty_wait_max_ms: 0 } }).success).toBe(true);
  });

  it('warns (without blocking) about placeholder fields with a value', () => {
    expect(placeholderWarnings(DEFAULT_COMMERCIAL_CONFIG)).toEqual([]);
    const w = placeholderWarnings(cfg({ execution: { max_turns: 12 }, tools: { parallel_calls: true }, safety: { verify_before_commit: true } }));
    expect(w).toHaveLength(3);
    expect(w.join(' ')).toMatch(/max_turns.*parallel_calls.*verify_before_commit/);
  });

  it('merge for copy_from: the dimensions sent override, the rest is kept, null unsets', () => {
    const merged = mergeHarnessConfig(DEFAULT_COMMERCIAL_CONFIG, { execution: { timeout_seconds: 30 }, safety: { twenty_wait_max_ms: null } });
    expect(merged.execution.timeout_seconds).toBe(30);
    expect(merged.tools.max_risk_level).toBe('LOW_WRITE');
    expect(merged.safety.twenty_wait_max_ms).toBeNull();
  });

  it('the seed config only sets today\'s global values (per-task / per-agent ones stay inherited)', () => {
    expect(DEFAULT_COMMERCIAL_CONFIG).toEqual(cfg({ tools: { max_risk_level: 'LOW_WRITE' }, safety: { twenty_wait_max_ms: 600_000 } }));
  });
});

describe('harness precedence', () => {
  it('no harness: exactly today\'s policies', () => {
    const base = baseline({ max_output_tokens: 4096 });
    const p = applyHarness(null, base);
    expect(p).toEqual({ ...base, overrides: [] });
    expect(p.configuration).toBe(base.configuration);
  });

  it('harness wins over task (timeout, retry) and env (Twenty wait)', () => {
    const p = applyHarness(cfg({ execution: { timeout_seconds: 42, retry: { max_attempts: 3, backoff_ms: 100 } }, safety: { twenty_wait_max_ms: 0 } }), baseline());
    expect(p.timeoutMs).toBe(42_000);
    expect(p.retry).toEqual({ max_attempts: 3, backoff_ms: 100 });
    expect(p.twentyWaitMaxMs).toBe(0);
    expect(p.overrides).toEqual(['execution.timeout_seconds', 'execution.retry', 'safety.twenty_wait_max_ms']);
  });

  it('a disabled Twenty gate stays disabled', () => {
    const p = applyHarness(cfg({ safety: { twenty_wait_max_ms: 5_000 } }), baseline({}, { twentyWaitMaxMs: null }));
    expect(p.twentyWaitMaxMs).toBeNull();
    expect(p.overrides).toEqual([]);
  });

  it('tools: the harness is a ceiling over the version\'s tool_policy, it never loosens it', () => {
    const conf = { tool_policy: { allow: ['find_company'], max_calls_per_execution: 1_500, max_risk_level: 'LOW_WRITE' } };
    const tight = applyHarness(cfg({ tools: { max_calls_per_execution: 100, max_risk_level: 'READ' } }), baseline(conf));
    expect(tight.toolPolicy).toMatchObject({ allow: ['find_company'], maxCallsPerExecution: 100, maxRiskLevel: 'READ' });
    expect(tight.overrides).toEqual(['tools.max_calls_per_execution', 'tools.max_risk_level']);
    const loose = applyHarness(cfg({ tools: { max_calls_per_execution: 5_000, max_risk_level: 'EXTERNAL_SIDE_EFFECT' } }), baseline(conf));
    expect(loose.toolPolicy).toMatchObject({ maxCallsPerExecution: 1_500, maxRiskLevel: 'LOW_WRITE' });
    expect(loose.overrides).toEqual([]);
  });

  it('context: max_output_tokens caps the version value, or applies when the version sets none', () => {
    const capped = applyHarness(cfg({ context: { max_output_tokens: 1024 } }), baseline({ max_output_tokens: 4096, other: 1 }));
    expect(capped.configuration).toEqual({ max_output_tokens: 1024, other: 1 });
    const kept = applyHarness(cfg({ context: { max_output_tokens: 8192 } }), baseline({ max_output_tokens: 4096 }));
    expect(kept.configuration.max_output_tokens).toBe(4096);
    expect(kept.overrides).toEqual([]);
    const set = applyHarness(cfg({ context: { max_output_tokens: 2048 } }), baseline({}));
    expect(set.configuration.max_output_tokens).toBe(2048);
  });

  it('default-commercial v1 leaves the seeded agents exactly as today', () => {
    for (const want of [desiredProspectorVersion(), desiredEmailDrafterVersion()]) {
      const base = baseline(want.configuration);
      const p = applyHarness(DEFAULT_COMMERCIAL_CONFIG, base);
      expect({ ...p, overrides: [] }).toEqual({ ...base, overrides: [] });
      expect(p.configuration).toBe(base.configuration);
      // Only the Twenty wait is "set" by the harness, with today's value.
      expect(p.overrides).toEqual(['safety.twenty_wait_max_ms']);
    }
  });
});

describe('harness resolver', () => {
  it('parses refs: null, {name}, {name, version}; anything else is invalid', () => {
    expect(parseHarnessRef(null)).toBeNull();
    expect(parseHarnessRef(undefined)).toBeNull();
    expect(parseHarnessRef({ name: 'default-commercial' })).toEqual({ name: 'default-commercial' });
    expect(parseHarnessRef({ name: 'default-commercial', version: 2 })).toEqual({ name: 'default-commercial', version: 2 });
    for (const bad of ['default-commercial', [], { name: 'Bad Name' }, { name: 'x', version: 0 }, { name: 'x', version: '1' }]) expect(parseHarnessRef(bad)).toBe('invalid');
  });

  it('{name} -> the ACTIVE version', async () => {
    const r = await resolveHarnessRef(store(harnessRow(), [V1, V2]), T, { name: 'default-commercial' });
    expect(r.label).toBe('default-commercial@1');
    expect(r.config).toEqual(DEFAULT_COMMERCIAL_CONFIG);
    expect(r.used).toEqual({ name: 'default-commercial', version: 1, harness_version_id: 'hv1', content_hash: 'hash-1', source: 'db', requested: { name: 'default-commercial' } });
  });

  it('{name, version} -> that exact version, whatever its status', async () => {
    const r = await resolveHarnessRef(store(harnessRow(), [V1, V2]), T, { name: 'default-commercial', version: 2 });
    expect(r.label).toBe('default-commercial@2');
    expect(r.config!.execution.timeout_seconds).toBe(60);
  });

  it('every fallback keeps today\'s policies (config null), warns and never throws', async () => {
    const warns: string[] = [];
    const logger = { warn: (_o: object, msg?: string) => warns.push(msg ?? '') };
    const cases: Array<[HarnessStore, unknown, string]> = [
      [store(harnessRow(), [V1]), null, 'no_ref'],
      [store(harnessRow(), [V1]), { name: 42 }, 'invalid_ref'],
      [store(null), { name: 'missing' }, 'harness_not_found'],
      [store(harnessRow(), [V1]), { name: 'default-commercial', version: 9 }, 'version_not_found'],
      [store(harnessRow({ activeVersionId: null, status: 'DRAFT' }), [versionRow(1, DEFAULT_COMMERCIAL_CONFIG, { status: 'DRAFT' })]), { name: 'default-commercial' }, 'no_active_version'],
      [store(harnessRow(), [versionRow(1, { execution: { bogus: 1 } }, { status: 'ACTIVE' })]), { name: 'default-commercial' }, 'invalid_config'],
      [{ load: async () => { throw new Error('connection refused'); } }, { name: 'default-commercial' }, 'db_error'],
    ];
    for (const [s, ref, reason] of cases) {
      const r = await resolveHarnessRef(s, T, ref, logger);
      expect(r.config, reason).toBeNull();
      expect(r.label, reason).toBeNull();
      expect(r.used, reason).toMatchObject({ source: 'none', fallback_reason: reason, harness_version_id: null, content_hash: null });
    }
    // Every fallback except "no ref" is logged.
    expect(warns).toHaveLength(cases.length - 1);
    expect(warns.find((w) => /database error/.test(w))).toBeDefined();
  });

  it('the trace record carries the exact version, the effective values and what the harness changed', async () => {
    const r = await resolveHarnessRef(store(harnessRow(), [V1, V2]), T, { name: 'default-commercial', version: 2 });
    const policies = applyHarness(r.config, baseline({ max_output_tokens: 4096 }));
    expect(harnessRecord(r, policies)).toEqual({
      name: 'default-commercial',
      version: 2,
      harness_version_id: 'hv2',
      content_hash: 'hash-2',
      source: 'db',
      requested: { name: 'default-commercial', version: 2 },
      effective: { timeout_ms: 60_000, retry: { max_attempts: 1, backoff_ms: 0 }, twenty_wait_max_ms: 600_000, max_calls_per_execution: 60, max_risk_level: 'LOW_WRITE', max_output_tokens: 4096 },
      overrides: ['execution.timeout_seconds'],
    });
    const none = await resolveHarnessRef(store(null), T, { name: 'missing' });
    expect(harnessRecord(none, applyHarness(none.config, baseline()))).toMatchObject({ source: 'none', fallback_reason: 'harness_not_found', overrides: [], effective: { timeout_ms: 900_000 } });
  });
});

describe('harness lifecycle plans', () => {
  const at = (h: number) => new Date(`2026-10-07T${String(h).padStart(2, '0')}:00:00Z`);
  const states = [
    { id: 'a', version: 1, status: 'DEPRECATED' as const, activatedAt: at(8) },
    { id: 'b', version: 2, status: 'ACTIVE' as const, activatedAt: at(9) },
    { id: 'c', version: 3, status: 'DRAFT' as const, activatedAt: null },
  ];

  it('activate deprecates the ACTIVE one; already ACTIVE is a no-op', () => {
    expect(planHarnessActivate(states, 3)).toEqual({ changed: true, deprecate: ['b'], activate: 'c', activeVersionId: 'c' });
    expect(planHarnessActivate(states, 2).changed).toBe(false);
    expect(() => planHarnessActivate(states, 9)).toThrow(HarnessServiceError);
  });

  it('deprecate of the ACTIVE one rolls back to the earlier one; with none it is refused', () => {
    expect(planHarnessDeprecate(states, 2)).toMatchObject({ changed: true, deprecate: ['b'], activate: 'a', activeVersionId: 'a' });
    expect(planHarnessDeprecate(states, 3)).toMatchObject({ changed: true, deprecate: ['c'], activate: null });
    expect(planHarnessDeprecate(states, 1).changed).toBe(false);
    expect(() => planHarnessDeprecate([{ id: 'a', version: 1, status: 'ACTIVE', activatedAt: at(8) }], 1)).toThrow(/no earlier version/);
  });
});

describe('Twenty gate per-run cap (safety.twenty_wait_max_ms)', () => {
  const probe = { isConfigured: () => true, health: async () => false };

  it('the per-run cap replaces the env one', async () => {
    const gate = new TwentyGate(probe, { maxWaitMs: 600_000, random: () => 0, now: () => 1_000_000 });
    expect(await gate.check(true, null)).toMatchObject({ action: 'defer' });
    expect(await gate.check(true, null, 0)).toEqual({ action: 'proceed', reason: 'not_required' });
    // Already waited 10 s: with a 5 s cap it proceeds, with the env 10 min it keeps waiting.
    const state = { since: 1_000_000 - 10_000, deferrals: 2 };
    expect(await gate.check(true, state, 5_000)).toMatchObject({ action: 'proceed', reason: 'wait_exceeded' });
    expect(await gate.check(true, state)).toMatchObject({ action: 'defer' });
  });
});
