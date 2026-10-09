/**
 * CatalogService: the one object the tools, the health gate and the API share.
 *
 * - `enabled = false` (CATALOG_ENABLED is not `true`): the catalog does not exist for the agents.
 *   The tools are registered disabled (the registry never resolves them) and nothing is called.
 * - `availability()`: the connector's `/health`, cached 60 s with one shared in-flight probe.
 *   Failure = no answer, network error, 503, 401/403 or an unknown contract MAJOR (the client
 *   throws CATALOG_CONTRACT_MISMATCH). `degraded` is NOT a failure (informative only).
 * - Data calls go through the TTL cache and first check availability: when the connector is
 *   down they fail fast with CATALOG_UNAVAILABLE instead of waiting on timeouts. A call that
 *   fails for availability reasons marks the connector unavailable until the next probe.
 */
import type { CatalogApi } from './api.js';
import { CATALOG_CACHE_TTL_MS, TtlCache } from './cache.js';
import { HttpCatalogClient } from './client.js';
import { catalogConfigFromEnv, type CatalogConfig } from './config.js';
import { CatalogError, isAvailabilityFailure, type CatalogErrorCode } from './errors.js';
import { loadStubCatalogData, StubCatalogClient } from './stub.js';
import type { CustomizationEstimate, Describe, EstimateParams, FamiliesParams, FamiliesResponse, Health, Product, SearchParams, SearchResponse } from './types.js';

export const CATALOG_HEALTH_TTL_MS = 60_000;

export type CatalogAvailability =
  | { available: true; checkedAt: string; health: Health; degraded: boolean }
  | { available: false; checkedAt: string; reason: 'disabled' | 'not_configured' | 'unhealthy'; code: CatalogErrorCode; message: string };

export interface CatalogServiceOptions {
  enabled: boolean;
  /** null: enabled but not usable (invalid configuration); every call answers CATALOG_UNAVAILABLE. */
  api: CatalogApi | null;
  /** Why `api` is null (configuration problems). */
  problems?: string[];
  healthTtlMs?: number;
  cache?: TtlCache;
  now?: () => number;
}

export class CatalogService {
  readonly enabled: boolean;
  readonly api: CatalogApi | null;
  readonly cache: TtlCache;
  private readonly problems: string[];
  private readonly healthTtlMs: number;
  private readonly now: () => number;
  private cached: { value: CatalogAvailability; at: number } | null = null;
  private inflight: Promise<CatalogAvailability> | null = null;

  constructor(opts: CatalogServiceOptions) {
    this.enabled = opts.enabled;
    this.api = opts.api;
    this.problems = opts.problems ?? [];
    this.healthTtlMs = opts.healthTtlMs ?? CATALOG_HEALTH_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.cache = opts.cache ?? new TtlCache(2_000, this.now);
  }

  /** `stub` | `http` | null (disabled or not configured). */
  get provider(): 'stub' | 'http' | null {
    return this.enabled && this.api ? this.api.kind : null;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Health gate probe, cached `healthTtlMs` (60 s). Never throws. */
  async availability(): Promise<CatalogAvailability> {
    if (!this.enabled) return { available: false, checkedAt: this.stamp(), reason: 'disabled', code: 'CATALOG_DISABLED', message: 'CATALOG_ENABLED is not true' };
    if (!this.api) {
      return { available: false, checkedAt: this.stamp(), reason: 'not_configured', code: 'CATALOG_NOT_CONFIGURED', message: this.problems.join('; ') || 'catalog client not configured' };
    }
    if (this.cached && this.now() - this.cached.at < this.healthTtlMs) return this.cached.value;
    if (!this.inflight) {
      const api = this.api;
      this.inflight = api
        .health()
        .then(
          (health): CatalogAvailability => ({ available: true, checkedAt: this.stamp(), health, degraded: health.status === 'degraded' }),
          (err: unknown): CatalogAvailability => {
            const e = err instanceof CatalogError ? err : new CatalogError('CATALOG_NETWORK_ERROR', err instanceof Error ? err.message : String(err));
            return { available: false, checkedAt: this.stamp(), reason: 'unhealthy', code: e.code, message: e.message };
          },
        )
        .then((value) => {
          this.cached = { value, at: this.now() };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** A data call failed for availability reasons: remember it until the next probe window. */
  markUnavailable(err: CatalogError): void {
    this.cached = { value: { available: false, checkedAt: this.stamp(), reason: 'unhealthy', code: err.code, message: err.message }, at: this.now() };
  }

  /** Drops the cached health (next call probes again). */
  resetHealth(): void {
    this.cached = null;
  }

  private async call<T>(op: string, run: (api: CatalogApi) => Promise<T>): Promise<T> {
    const state = await this.availability();
    if (!state.available) throw new CatalogError('CATALOG_UNAVAILABLE', `catalog unavailable (${state.reason}: ${state.message})`, null, false, { reason: state.reason, code: state.code });
    try {
      return await run(this.api!);
    } catch (err) {
      if (err instanceof CatalogError && isAvailabilityFailure(err)) {
        this.markUnavailable(err);
        throw new CatalogError('CATALOG_UNAVAILABLE', `catalog unavailable during ${op} (${err.code}: ${err.message})`, err.status, false, { reason: 'unhealthy', code: err.code });
      }
      throw err;
    }
  }

  searchProducts(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    const key = `search:${stableKey(params)}`;
    return this.call('search', (api) => this.cache.memo(key, CATALOG_CACHE_TTL_MS.search, () => api.searchProducts(params, { signal })));
  }

  getProduct(productId: string, signal?: AbortSignal): Promise<Product> {
    return this.call('get_product', (api) => this.cache.memo(`product:${productId}`, CATALOG_CACHE_TTL_MS.product, () => api.getProduct(productId, { signal })));
  }

  estimateCustomization(productId: string, params: EstimateParams, signal?: AbortSignal): Promise<CustomizationEstimate> {
    return this.call('estimate_customization', (api) => api.estimateCustomization(productId, params, { signal }));
  }

  listFamilies(params: FamiliesParams = {}, signal?: AbortSignal): Promise<FamiliesResponse> {
    const key = `families:${params.parentId ?? '*'}:${params.includeAttributes === true}`;
    return this.call('list_families', (api) => this.cache.memo(key, CATALOG_CACHE_TTL_MS.families, () => api.listFamilies(params, { signal })));
  }

  describe(signal?: AbortSignal): Promise<Describe> {
    return this.call('describe', (api) => this.cache.memo('describe', CATALOG_CACHE_TTL_MS.describe, () => api.describe({ signal })));
  }
}

/** JSON with sorted keys at every level and undefined values dropped (cache keys). */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface CatalogServiceDeps {
  /** Overrides the client built from the config (tests). */
  api?: CatalogApi | null;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Builds the service from a parsed configuration. Never throws: a broken config means "unavailable". */
export function catalogServiceFromConfig(cfg: CatalogConfig, deps: CatalogServiceDeps = {}): CatalogService {
  if (!cfg.enabled) return new CatalogService({ enabled: false, api: null, ...(deps.now ? { now: deps.now } : {}) });
  let api: CatalogApi | null = deps.api ?? null;
  const problems = [...cfg.problems];
  if (deps.api === undefined && problems.length === 0) {
    try {
      api =
        cfg.provider === 'http'
          ? new HttpCatalogClient({ baseUrl: cfg.baseUrl!, token: cfg.token!, timeoutMs: cfg.timeoutMs, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
          : new StubCatalogClient(loadStubCatalogData(...(cfg.fixturesDir ? [cfg.fixturesDir] : [])), deps.now ? { now: deps.now } : {});
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      api = null;
    }
  }
  return new CatalogService({ enabled: true, api, problems, ...(deps.now ? { now: deps.now } : {}) });
}

let defaultService: CatalogService | null = null;

/**
 * Process-wide service built from the environment (CATALOG_*), shared by the default tool
 * registry, the health gate and the API so they see the same health cache.
 */
export function defaultCatalogService(env: NodeJS.ProcessEnv = process.env): CatalogService {
  defaultService ??= catalogServiceFromConfig(catalogConfigFromEnv(env));
  return defaultService;
}
