/**
 * Model routing by ROLE (LLD v0.1 §18 "Model registry y routing"): the code asks for a role,
 * never for a model; the router resolves (provider, model).
 *
 *   role               who asks for it                                   default (= today's model)
 *   -----------------  ------------------------------------------------  -------------------------
 *   executor_cheap     simple agents (EmailDrafter, Bajas, stub, smoke)  gemini:gemini-flash-latest
 *   executor_reasoner  research agents (Prospector + EventScout)         gemini:gemini-flash-latest
 *   triage             inbound reply classifier (InboxAgent)             gemini:gemini-flash-latest
 *   judge              LLM_JUDGE evaluators (experiments, evaluate)      gemini:gemini-pro-latest
 *   optimizer          Skill Optimizer clustering + proposal             gemini:gemini-flash-latest
 *
 * Precedence of one resolution (first that applies wins):
 *   1. `MODEL_ROUTE_<ROL>` = `provider:model` (e.g. `MODEL_ROUTE_JUDGE=anthropic:claude-sonnet-5-5`).
 *   2. The model PINNED by the caller: the agent version's `model` / `model_provider` (versioned
 *      state, more specific than any default). Stub versions are test fixtures and are never
 *      re-routed, not even by step 1.
 *   3. The LEGACY variables, kept as fallbacks so existing deployments do not break:
 *        JUDGE_MODEL  -> role judge (bare model; provider inferred: claude-* anthropic, else gemini)
 *        GEMINI_MODEL -> every other role (gemini). It never re-routes a pinned agent version
 *                        (it never did: it only filled versions/runs without a Gemini model).
 *      Legacy values are validated leniently (as before): an unpriced model is accepted with a
 *      warning instead of stopping the boot.
 *   4. The code table `DEFAULT_MODEL_ROUTES`.
 * When `MODEL_ROUTE_<ROL>` and its legacy variable are both set and name different models,
 * `warnings()` says so (main.ts logs it at boot, the CLIs print it): MODEL_ROUTE_* wins.
 * Then an optional CEILING (cost cap): the route never resolves to a model more expensive than
 * the ceiling; when it would, the ceiling model is used and the route says so (`capped`).
 * Hook for the harness: harness v1 has no D1 MODEL field (the model lives in the agent
 * version), so today nobody passes a ceiling; when a harness version gets one, the processor
 * passes it as `ceiling` and nothing else changes.
 *
 * Every MODEL_ROUTE_* override is validated when the router is built (process boot, CLI start): an invalid
 * format, an unknown provider or a model without a price in the tables fails loudly. An
 * unpriced model would cost 0 and blind every budget guard, so it is refused.
 *
 * Independence of the judge (§18 "El evaluador no debe ser el mismo modelo que ejecuta"):
 * `assertJudgeIndependent` / `experimentRoutes` refuse a judge that resolves to the executor's
 * model (aliases resolved: `gemini-flash-latest` = `gemini-3.8-flash`).
 */
import { ANTHROPIC_PRICING } from './anthropic-provider.js';
import { GEMINI_MODEL_ALIASES, resolveGeminiPricing } from './gemini-pricing.js';
import { DEFAULT_GEMINI_MODEL } from './gemini-provider.js';
import type { ModelPricing } from './model-provider.js';

export const MODEL_PROVIDERS = ['stub', 'anthropic', 'gemini'] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

export const MODEL_ROLES = ['executor_cheap', 'executor_reasoner', 'triage', 'judge', 'optimizer'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** A concrete (provider, model). `provider` is a string: pinned versions may carry test providers. */
export interface ModelTarget {
  provider: string;
  model: string;
}

export type ModelRouteSource = 'env' | 'legacy_env' | 'pinned' | 'default';

/** Result of one resolution; recorded in traces (`traces.harness.model_route`) and experiments. */
export interface ModelRoute extends ModelTarget {
  role: ModelRole;
  source: ModelRouteSource;
  /** Env var that set it (sources `env` / `legacy_env`). */
  env?: string;
  /** Present when a ceiling replaced a more expensive choice. */
  capped?: { from: ModelTarget; ceiling: ModelTarget };
}

/** The models the code used before the router: changing nothing in env changes nothing. */
export const DEFAULT_JUDGE_ROUTE_MODEL = 'gemini-pro-latest';
export const DEFAULT_MODEL_ROUTES: Readonly<Record<ModelRole, Readonly<ModelTarget>>> = Object.freeze({
  executor_cheap: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
  executor_reasoner: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
  triage: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
  judge: { provider: 'gemini', model: DEFAULT_JUDGE_ROUTE_MODEL },
  optimizer: { provider: 'gemini', model: DEFAULT_GEMINI_MODEL },
});

/**
 * Default role of each agent implementation (`configuration.implementation`). A version may
 * set `configuration.model_role` to use another executor role (judge is never an agent role).
 */
export const IMPLEMENTATION_ROLES: Readonly<Record<string, ModelRole>> = Object.freeze({
  prospector: 'executor_reasoner',
  email_drafter: 'executor_cheap',
  inbound_inbox: 'triage',
  inbound_bajas: 'executor_cheap',
  stub: 'executor_cheap',
  smoke: 'executor_cheap',
});

export class ModelRouteError extends Error {
  readonly code = 'MODEL_ROUTE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ModelRouteError';
  }
}

export function routeEnvName(role: ModelRole): string {
  return `MODEL_ROUTE_${role.toUpperCase()}`;
}

export function isModelRole(v: unknown): v is ModelRole {
  return typeof v === 'string' && (MODEL_ROLES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Pricing across providers
// ---------------------------------------------------------------------------
const ZERO_PRICING: ModelPricing = Object.freeze({ inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0 });

/** List price of a model on a date (Gemini periods, Anthropic table, stub = 0). Undefined = unknown. */
export function modelPricing(provider: string, model: string, at: Date = new Date()): ModelPricing | undefined {
  switch (provider) {
    case 'gemini':
      return resolveGeminiPricing(model, at);
    case 'anthropic':
      return ANTHROPIC_PRICING[model.trim()];
    case 'stub':
      return ZERO_PRICING;
    default:
      return undefined;
  }
}

/** Price used to compare models: input + output per 1M tokens (USD). */
function blendedPrice(p: ModelPricing): number {
  return p.inputPerMTok + p.outputPerMTok;
}

/** `gemini-flash-latest` and `gemini-3.8-flash` are the same model; `models/` prefix ignored. */
export function canonicalModelId(model: string): string {
  const id = model.replace(/^models\//, '').trim();
  return GEMINI_MODEL_ALIASES[id] ?? id;
}

export function sameModel(a: ModelTarget, b: ModelTarget): boolean {
  return canonicalModelId(a.model) === canonicalModelId(b.model);
}

const label = (t: ModelTarget) => `${t.provider}:${t.model}`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
const SPEC_RE = /^([a-z]+):([A-Za-z0-9][A-Za-z0-9._/-]*)$/;

/**
 * `provider:model` -> target. Throws ModelRouteError with the variable name and an example.
 * `requirePrice: false` (legacy variables) accepts a model missing from the price tables.
 */
export function parseModelRoute(raw: string, source: string, at: Date = new Date(), opts: { requirePrice?: boolean } = {}): ModelTarget {
  const value = raw.trim();
  const m = SPEC_RE.exec(value);
  const example = `p. ej. ${source}=anthropic:claude-sonnet-5-5 o ${source}=gemini:gemini-3.5-flash-lite`;
  if (!m) throw new ModelRouteError(`${source}="${raw}" no es válido: usa el formato proveedor:modelo (${example})`);
  const provider = m[1]!;
  const model = m[2]!;
  if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ModelRouteError(`${source}="${raw}": proveedor "${provider}" desconocido (válidos: ${MODEL_PROVIDERS.join(', ')}; ${example})`);
  }
  if (opts.requirePrice !== false && !modelPricing(provider, model, at)) {
    throw new ModelRouteError(
      `${source}="${raw}": el modelo "${model}" no tiene precio en la tabla de ${provider} (src/providers/${provider === 'gemini' ? 'gemini-pricing.ts' : 'anthropic-provider.ts'}); añádelo antes de enrutarlo (sin precio el coste sería 0 y los presupuestos no protegerían)`,
    );
  }
  return { provider, model };
}

/**
 * `provider:model`, or a bare model name (legacy `JUDGE_MODEL`, CLI `--judge-model`) whose
 * provider is inferred: `claude-*` -> anthropic, `stub*` -> stub, anything else -> gemini.
 */
export function parseModelSpec(raw: string, source: string, at: Date = new Date(), opts: { requirePrice?: boolean } = {}): ModelTarget {
  const value = raw.trim();
  if (value.includes(':')) return parseModelRoute(value, source, at, opts);
  const provider = value.startsWith('claude-') ? 'anthropic' : value.startsWith('stub') ? 'stub' : 'gemini';
  return parseModelRoute(`${provider}:${value}`, source, at, opts);
}

/** Legacy variable of each role (fallback below MODEL_ROUTE_<ROL> and below a pinned version). */
export const LEGACY_ROUTE_ENV: Readonly<Record<ModelRole, string>> = Object.freeze({
  executor_cheap: 'GEMINI_MODEL',
  executor_reasoner: 'GEMINI_MODEL',
  triage: 'GEMINI_MODEL',
  judge: 'JUDGE_MODEL',
  optimizer: 'GEMINI_MODEL',
});

/** API key env vars the given routes need and that are not set (CLI pre-flight). */
export function missingProviderKeys(routes: readonly ModelTarget[], env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const need = new Set<string>();
  for (const r of routes) {
    if (r.provider === 'gemini') need.add('GEMINI_API_KEY');
    if (r.provider === 'anthropic') need.add('ANTHROPIC_API_KEY');
  }
  return [...need].filter((k) => !env[k] || env[k]!.trim() === '');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export interface ModelRouterOptions {
  /** Where overrides are read (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replaces entries of the code table (tests). */
  defaults?: Partial<Record<ModelRole, ModelTarget>>;
  /** Date used for prices (ceilings and validation). */
  now?: () => Date;
}

export interface ResolveOptions {
  /** Model the caller is bound to (the agent version's). Only MODEL_ROUTE_<ROL> overrides it (never for stub). */
  pinned?: ModelTarget | null;
  /** Cost cap: never resolve to a model more expensive than this one. */
  ceiling?: ModelTarget | null;
}

interface Override {
  target: ModelTarget;
  source: 'env' | 'legacy_env';
  env: string;
}

export class ModelRouter {
  private readonly overrides = new Map<ModelRole, Override>();
  private readonly legacy = new Map<ModelRole, Override>();
  private readonly defaults: Record<ModelRole, ModelTarget>;
  private readonly now: () => Date;
  private readonly warningList: string[] = [];

  constructor(opts: ModelRouterOptions = {}) {
    const env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.defaults = { ...DEFAULT_MODEL_ROUTES, ...(opts.defaults ?? {}) } as Record<ModelRole, ModelTarget>;
    const at = this.now();
    for (const key of Object.keys(env)) {
      if (!key.startsWith('MODEL_ROUTE_')) continue;
      const value = env[key];
      if (value === undefined || value.trim() === '') continue;
      const role = key.slice('MODEL_ROUTE_'.length).toLowerCase();
      if (!isModelRole(role)) {
        throw new ModelRouteError(`${key}: rol desconocido "${role}" (roles: ${MODEL_ROLES.map(routeEnvName).join(', ')})`);
      }
      this.overrides.set(role, { target: parseModelRoute(value, key, at), source: 'env', env: key });
    }
    for (const role of MODEL_ROLES) {
      const name = LEGACY_ROUTE_ENV[role];
      const raw = env[name]?.trim();
      if (!raw) continue;
      // GEMINI_MODEL is a Gemini model name by definition; JUDGE_MODEL infers the provider.
      const target = name === 'GEMINI_MODEL' ? parseModelRoute(`gemini:${raw.replace(/^models\//, '')}`, name, at, { requirePrice: false }) : parseModelSpec(raw, name, at, { requirePrice: false });
      this.legacy.set(role, { target, source: 'legacy_env', env: name });
      const override = this.overrides.get(role);
      if (override && !(override.target.provider === target.provider && sameModel(override.target, target))) {
        this.warningList.push(`${override.env}=${label(override.target)} y ${name}=${raw} discrepan para el rol ${role}: gana ${override.env} (${name} queda como fallback sin efecto en este rol)`);
      }
    }
    for (const name of new Set(Object.values(LEGACY_ROUTE_ENV))) {
      const t = [...this.legacy.values()].find((o) => o.env === name)?.target;
      if (t && !modelPricing(t.provider, t.model, at)) this.warningList.push(`${name}=${t.model} no tiene precio en la tabla de ${t.provider}: su coste se contará como 0`);
    }
  }

  /** Non-fatal configuration notes (legacy vs MODEL_ROUTE_* discrepancies, unpriced legacy models). */
  warnings(): string[] {
    return [...this.warningList];
  }

  resolve(role: ModelRole, opts: ResolveOptions = {}): ModelRoute {
    const pinned = opts.pinned ?? null;
    const override = this.overrides.get(role);
    const legacy = this.legacy.get(role);
    let route: ModelRoute;
    // Stub versions are fixtures (tests, smoke): an override never turns them into real calls.
    if (pinned && pinned.provider === 'stub') route = { role, ...pinned, source: 'pinned' };
    else if (override) route = { role, ...override.target, source: override.source, env: override.env };
    else if (pinned) route = { role, provider: pinned.provider, model: pinned.model, source: 'pinned' };
    else if (legacy) route = { role, ...legacy.target, source: legacy.source, env: legacy.env };
    else route = { role, ...this.defaults[role], source: 'default' };
    return opts.ceiling ? this.applyCeiling(route, opts.ceiling) : route;
  }

  /** Every role with no pin: what the code table plus env resolve to today. */
  table(): ModelRoute[] {
    return MODEL_ROLES.map((r) => this.resolve(r));
  }

  /** LLD §18: the judge must not be the model that produced the output. */
  assertJudgeIndependent(judge: ModelTarget, executor: ModelTarget): void {
    if (!sameModel(judge, executor)) return;
    const executorRole = 'role' in executor ? ` (rol ${(executor as ModelRoute).role})` : '';
    throw new ModelRouteError(
      `el juez (${label(judge)}) resuelve al mismo modelo que el ejecutor${executorRole} (${label(executor)}): el evaluador no puede ser el modelo que ejecuta (LLD §18). Cambia ${routeEnvName('judge')} o la ruta del ejecutor.`,
    );
  }

  private applyCeiling(route: ModelRoute, ceiling: ModelTarget): ModelRoute {
    const at = this.now();
    const chosen = modelPricing(route.provider, route.model, at);
    const cap = modelPricing(ceiling.provider, ceiling.model, at);
    if (!cap) return route; // an unpriced ceiling cannot be compared: it does not bind
    if (chosen && blendedPrice(chosen) <= blendedPrice(cap)) return route;
    return { ...route, provider: ceiling.provider, model: ceiling.model, capped: { from: { provider: route.provider, model: route.model }, ceiling: { ...ceiling } } };
  }
}

/** Router over `process.env` (validated on construction). Cheap: build it where needed. */
export function defaultModelRouter(env: Readonly<Record<string, string | undefined>> = process.env): ModelRouter {
  return new ModelRouter({ env });
}

// ---------------------------------------------------------------------------
// Agent versions and experiments
// ---------------------------------------------------------------------------
export interface RoutableVersion {
  model: string;
  /** Absent in experiment configs (CompareAgentVersion): treated as Gemini, as the CLI runs them. */
  modelProvider?: string;
  configuration: Record<string, unknown>;
}

/** Role of an agent version: `configuration.model_role` (executor roles only) or its implementation's. */
export function agentVersionRole(configuration: Record<string, unknown>): ModelRole {
  const explicit = configuration.model_role;
  if (isModelRole(explicit) && explicit !== 'judge') return explicit;
  const impl = typeof configuration.implementation === 'string' ? configuration.implementation : 'stub';
  return IMPLEMENTATION_ROLES[impl] ?? 'executor_cheap';
}

/** Route of an agent execution: the version's model is pinned; env overrides of its role win. */
export function routeAgentVersion(router: ModelRouter, v: RoutableVersion, opts: { ceiling?: ModelTarget | null } = {}): ModelRoute {
  return router.resolve(agentVersionRole(v.configuration), { pinned: { provider: v.modelProvider ?? 'gemini', model: v.model }, ...(opts.ceiling ? { ceiling: opts.ceiling } : {}) });
}

/**
 * Executor and judge of one experiment, checked for independence BEFORE anything runs.
 * Throws ModelRouteError when both resolve to the same model.
 */
export function experimentRoutes(router: ModelRouter, executorVersion: RoutableVersion): { executor: ModelRoute; judge: ModelRoute } {
  const executor = routeAgentVersion(router, executorVersion);
  const judge = router.resolve('judge');
  router.assertJudgeIndependent(judge, executor);
  return { executor, judge };
}
