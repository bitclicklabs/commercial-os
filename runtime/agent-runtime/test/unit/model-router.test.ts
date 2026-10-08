/**
 * Model router (LLD §18): roles -> (provider, model). Defaults reproduce the models the code
 * used before the router; MODEL_ROUTE_<ROL> overrides; legacy JUDGE_MODEL / GEMINI_MODEL as
 * fallbacks with discrepancy warnings; judge independence; ceiling hook; clear errors.
 * Hermetic: every router reads an explicit env object, never process.env.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JUDGE_MODEL } from '../../src/evaluators/judge.js';
import { optimizerConfig } from '../../src/optimizer/core.js';
import {
  agentVersionRole,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MODEL_ROUTES,
  experimentRoutes,
  MODEL_ROLES,
  missingProviderKeys,
  modelPricing,
  ModelRouteError,
  ModelRouter,
  parseModelRoute,
  resolveGeminiPricing,
  routeAgentVersion,
} from '../../src/providers/index.js';
import { desiredProspectorVersion } from '../../src/seed/prospector-seed.js';

const router = (env: Record<string, string> = {}) => new ModelRouter({ env, now: () => new Date('2026-10-08T10:00:00Z') });
const prospector = desiredProspectorVersion();

describe('default routing = the models the code used before', () => {
  it('code table: flash for executors, triage and optimizer; pro for the judge', () => {
    expect(DEFAULT_MODEL_ROUTES).toEqual({
      executor_cheap: { provider: 'gemini', model: 'gemini-flash-latest' },
      executor_reasoner: { provider: 'gemini', model: 'gemini-flash-latest' },
      triage: { provider: 'gemini', model: 'gemini-flash-latest' },
      judge: { provider: 'gemini', model: 'gemini-pro-latest' },
      optimizer: { provider: 'gemini', model: 'gemini-flash-latest' },
    });
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-flash-latest');
    expect(DEFAULT_JUDGE_MODEL).toBe('gemini-pro-latest');
    const table = router().table();
    expect(table.map((r) => r.role)).toEqual([...MODEL_ROLES]);
    for (const r of table) expect(r).toMatchObject({ ...DEFAULT_MODEL_ROUTES[r.role], source: 'default' });
  });

  it('an agent version keeps its own model (pinned) when nothing is set in env', () => {
    const r = routeAgentVersion(router(), prospector);
    expect(r).toEqual({ role: 'executor_reasoner', provider: 'gemini', model: 'gemini-flash-latest', source: 'pinned' });
    expect(routeAgentVersion(router(), { model: 'gemini-3.5-flash', modelProvider: 'gemini', configuration: { implementation: 'email_drafter' } })).toMatchObject({ role: 'executor_cheap', model: 'gemini-3.5-flash', source: 'pinned' });
  });

  it('roles by implementation, and configuration.model_role (executor roles only)', () => {
    expect(agentVersionRole({ implementation: 'prospector' })).toBe('executor_reasoner');
    expect(agentVersionRole({ implementation: 'email_drafter' })).toBe('executor_cheap');
    expect(agentVersionRole({ implementation: 'inbound_inbox' })).toBe('triage');
    expect(agentVersionRole({ implementation: 'inbound_bajas' })).toBe('executor_cheap');
    expect(agentVersionRole({})).toBe('executor_cheap');
    expect(agentVersionRole({ implementation: 'email_drafter', model_role: 'executor_reasoner' })).toBe('executor_reasoner');
    expect(agentVersionRole({ implementation: 'prospector', model_role: 'judge' })).toBe('executor_reasoner');
    expect(agentVersionRole({ implementation: 'prospector', model_role: 'nope' })).toBe('executor_reasoner');
  });

  describe('optimizer default model through the router (process.env)', () => {
    const saved = { route: process.env.MODEL_ROUTE_OPTIMIZER, gemini: process.env.GEMINI_MODEL };
    beforeEach(() => {
      delete process.env.MODEL_ROUTE_OPTIMIZER;
      delete process.env.GEMINI_MODEL;
    });
    afterEach(() => {
      for (const [k, v] of [['MODEL_ROUTE_OPTIMIZER', saved.route], ['GEMINI_MODEL', saved.gemini]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    it('unset -> gemini-flash-latest; GEMINI_MODEL (legacy) -> that model; MODEL_ROUTE_OPTIMIZER wins', () => {
      expect(optimizerConfig('prospector-event-exhibitors').model).toBe('gemini-flash-latest');
      process.env.GEMINI_MODEL = 'gemini-3.5-flash';
      expect(optimizerConfig('prospector-event-exhibitors').model).toBe('gemini-3.5-flash');
      process.env.MODEL_ROUTE_OPTIMIZER = 'gemini:gemini-3.5-flash-lite';
      expect(optimizerConfig('prospector-event-exhibitors').model).toBe('gemini-3.5-flash-lite');
    });
  });
});

describe('MODEL_ROUTE_<ROL> overrides', () => {
  it('moves the judge to Anthropic without touching code', () => {
    const r = router({ MODEL_ROUTE_JUDGE: 'anthropic:claude-sonnet-5-5' });
    expect(r.resolve('judge')).toEqual({ role: 'judge', provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'env', env: 'MODEL_ROUTE_JUDGE' });
    expect(r.resolve('optimizer')).toMatchObject({ model: 'gemini-flash-latest', source: 'default' });
  });

  it('an executor override wins over the pinned version model; stub versions are never re-routed', () => {
    const r = router({ MODEL_ROUTE_EXECUTOR_REASONER: 'gemini:gemini-3.5-flash-lite', MODEL_ROUTE_EXECUTOR_CHEAP: 'gemini:gemini-3.5-flash-lite' });
    expect(routeAgentVersion(r, prospector)).toMatchObject({ role: 'executor_reasoner', provider: 'gemini', model: 'gemini-3.5-flash-lite', source: 'env' });
    expect(routeAgentVersion(r, { model: 'stub-1', modelProvider: 'stub', configuration: {} })).toEqual({ role: 'executor_cheap', provider: 'stub', model: 'stub-1', source: 'pinned' });
    // Another role's override does not touch it.
    expect(routeAgentVersion(router({ MODEL_ROUTE_TRIAGE: 'gemini:gemini-2.5-flash' }), prospector).source).toBe('pinned');
  });

  it('invalid overrides fail with a clear message naming the variable', () => {
    expect(() => router({ MODEL_ROUTE_JUDGE: 'gemini-pro-latest' })).toThrow(ModelRouteError);
    expect(() => router({ MODEL_ROUTE_JUDGE: 'gemini-pro-latest' })).toThrow(/MODEL_ROUTE_JUDGE="gemini-pro-latest" no es válido: usa el formato proveedor:modelo/);
    expect(() => router({ MODEL_ROUTE_JUDGE: 'openai:gpt-9' })).toThrow(/proveedor "openai" desconocido/);
    expect(() => router({ MODEL_ROUTE_EXECUTOR_CHEAP: 'gemini:gemini-9-ultra' })).toThrow(/no tiene precio en la tabla de gemini/);
    expect(() => router({ MODEL_ROUTE_EXECUTOR_CHEAP: 'anthropic:claude-unknown' })).toThrow(/no tiene precio en la tabla de anthropic/);
    expect(() => router({ MODEL_ROUTE_RESEARCH: 'gemini:gemini-2.5-flash' })).toThrow(/MODEL_ROUTE_RESEARCH: rol desconocido "research"/);
    expect(() => router({ MODEL_ROUTE_JUDGE: 'gemini: gemini-2.5-pro' })).toThrow(/no es válido/);
    // Empty values are ignored (unset in a .env file).
    expect(router({ MODEL_ROUTE_JUDGE: '  ' }).resolve('judge').source).toBe('default');
    expect(parseModelRoute(' stub:stub-x ', 'X')).toEqual({ provider: 'stub', model: 'stub-x' });
  });
});

describe('legacy JUDGE_MODEL / GEMINI_MODEL', () => {
  it('JUDGE_MODEL is a fallback below MODEL_ROUTE_JUDGE (provider inferred), with a warning when they differ', () => {
    expect(router({ JUDGE_MODEL: 'gemini-2.5-pro' }).resolve('judge')).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro', source: 'legacy_env', env: 'JUDGE_MODEL' });
    expect(router({ JUDGE_MODEL: 'claude-haiku-4-5' }).resolve('judge')).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    const both = router({ JUDGE_MODEL: 'gemini-2.5-pro', MODEL_ROUTE_JUDGE: 'anthropic:claude-sonnet-5-5' });
    expect(both.resolve('judge')).toMatchObject({ provider: 'anthropic', source: 'env' });
    expect(both.warnings()).toEqual([expect.stringMatching(/MODEL_ROUTE_JUDGE=anthropic:claude-sonnet-5-5 y JUDGE_MODEL=gemini-2.5-pro discrepan para el rol judge: gana MODEL_ROUTE_JUDGE/)]);
    // Same model (alias resolved) -> no warning.
    expect(router({ JUDGE_MODEL: 'gemini-pro-latest', MODEL_ROUTE_JUDGE: 'gemini:gemini-3.1-pro-preview' }).warnings()).toEqual([]);
  });

  it('GEMINI_MODEL fills unpinned roles but never re-routes a pinned version; legacy values stay lenient', () => {
    const r = router({ GEMINI_MODEL: 'gemini-3.5-flash' });
    expect(r.resolve('optimizer')).toMatchObject({ model: 'gemini-3.5-flash', source: 'legacy_env', env: 'GEMINI_MODEL' });
    expect(r.resolve('judge').source).toBe('default');
    expect(routeAgentVersion(r, prospector)).toMatchObject({ model: 'gemini-flash-latest', source: 'pinned' });
    const lenient = router({ GEMINI_MODEL: 'gemini-experimental-x' });
    expect(lenient.resolve('triage').model).toBe('gemini-experimental-x');
    expect(lenient.warnings()).toEqual([expect.stringMatching(/GEMINI_MODEL=gemini-experimental-x no tiene precio/)]);
    const clash = router({ GEMINI_MODEL: 'gemini-3.5-flash', MODEL_ROUTE_OPTIMIZER: 'gemini:gemini-2.5-flash' });
    expect(clash.warnings()).toEqual([expect.stringMatching(/MODEL_ROUTE_OPTIMIZER=gemini:gemini-2.5-flash y GEMINI_MODEL=gemini-3.5-flash discrepan para el rol optimizer/)]);
  });
});

describe('judge independence (LLD §18)', () => {
  it('default judge and Prospector executor are distinct', () => {
    const { executor, judge } = experimentRoutes(router(), prospector);
    expect(executor).toMatchObject({ role: 'executor_reasoner', model: 'gemini-flash-latest' });
    expect(judge).toMatchObject({ role: 'judge', model: 'gemini-pro-latest' });
  });

  it('a configuration that makes them equal is refused (aliases resolved), never silently accepted', () => {
    expect(() => experimentRoutes(router({ MODEL_ROUTE_JUDGE: 'gemini:gemini-3.8-flash' }), prospector)).toThrow(
      /el juez \(gemini:gemini-3.8-flash\) resuelve al mismo modelo que el ejecutor \(rol executor_reasoner\) \(gemini:gemini-flash-latest\)/,
    );
    expect(() => experimentRoutes(router({ MODEL_ROUTE_EXECUTOR_REASONER: 'gemini:gemini-pro-latest' }), prospector)).toThrow(ModelRouteError);
    expect(() => experimentRoutes(router({ JUDGE_MODEL: 'gemini-flash-latest' }), prospector)).toThrow(/LLD §18/);
  });
});

describe('ceiling hook (harness D1 MODEL has no field yet)', () => {
  it('never resolves to a model more expensive than the ceiling', () => {
    const r = router({ MODEL_ROUTE_EXECUTOR_REASONER: 'gemini:gemini-3.1-pro-preview' });
    const capped = routeAgentVersion(r, prospector, { ceiling: { provider: 'gemini', model: 'gemini-3.5-flash' } });
    expect(capped).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash', capped: { from: { model: 'gemini-3.1-pro-preview' }, ceiling: { model: 'gemini-3.5-flash' } } });
    // Cheaper than the ceiling: untouched.
    const cheap = r.resolve('optimizer', { ceiling: { provider: 'gemini', model: 'gemini-3.5-flash' } });
    expect(cheap).toMatchObject({ model: 'gemini-flash-latest' });
    expect(cheap.capped).toBeUndefined();
  });
});

describe('pricing across providers and the 2027 change', () => {
  it('gemini-flash-latest (= 3.8-flash) doubles on 2027-01-01; 3.6 / 3.7 / 3.8 flash share prices', () => {
    expect(modelPricing('gemini', 'gemini-flash-latest', new Date('2026-12-31T23:00:00Z'))).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75, cachedPerMTok: 0.075 });
    expect(modelPricing('gemini', 'gemini-flash-latest', new Date('2027-01-01T00:00:00Z'))).toEqual({ from: '2027-01-01', inputPerMTok: 1.5, outputPerMTok: 7.5, cachedPerMTok: 0.15 });
    const at = new Date('2027-02-01T00:00:00Z');
    expect(resolveGeminiPricing('gemini-3.6-flash', at)).toEqual(resolveGeminiPricing('gemini-3.8-flash', at));
    expect(resolveGeminiPricing('gemini-3.7-flash', at)).toEqual(resolveGeminiPricing('gemini-3.8-flash', at));
    expect(modelPricing('anthropic', 'claude-sonnet-5-5')).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(modelPricing('stub', 'anything')).toMatchObject({ inputPerMTok: 0 });
    expect(modelPricing('other', 'x')).toBeUndefined();
  });

  it('missingProviderKeys lists the API keys the routes need', () => {
    expect(missingProviderKeys([{ provider: 'gemini', model: 'a' }, { provider: 'anthropic', model: 'b' }, { provider: 'stub', model: 'c' }], { GEMINI_API_KEY: 'k' })).toEqual(['ANTHROPIC_API_KEY']);
  });
});
