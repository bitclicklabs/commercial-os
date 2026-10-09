/**
 * REST client of the publiexpe catalog connector (contract v1.1, base `{origin}/api/catalog/v1`).
 *
 * - Bearer `pxcat_…` token (CATALOG_API_TOKEN). The token is never logged nor put in an error,
 *   and it never leaves the configured origin: a redirect to another origin is refused.
 * - Egress: every URL (first request and each redirect hop) passes `checkCatalogEgress`: the
 *   configured origin is the only one exempt from the SSRF guard (VPN, private address).
 * - Per-attempt timeout (default 10 s, the contract's cut) combined with the caller's signal.
 * - Soft retries, all operations being GETs: 429 honours `Retry-After` (up to 3 retries, as the
 *   contract asks), 5xx / timeouts / network errors up to `maxRetries` (2) with exponential
 *   backoff. `health()` never retries: it is the gate's probe and must answer fast.
 * - Every 2xx body is parsed with the zod schemas of `types.ts`; a contract MAJOR other than 1 in
 *   `X-Catalog-Contract-Version` (or in `/health`) is refused with CATALOG_CONTRACT_MISMATCH.
 * - Cursor pagination: `searchProducts` passes `cursor` through and returns `page.nextCursor`.
 */
import type { z } from 'zod';
import type { CatalogApi, CatalogCallOptions } from './api.js';
import { CatalogError, type CatalogErrorCode } from './errors.js';
import { checkCatalogEgress, originOf, systemCatalogResolver, type CatalogResolver } from './egress.js';
import {
  CATALOG_API_PATH,
  CATALOG_SUPPORTED_MAJOR,
  contractMajor,
  CustomizationEstimate,
  Describe,
  ErrorBody,
  FamiliesResponse,
  Health,
  Product,
  SearchResponse,
  type EstimateParams,
  type FamiliesParams,
  type SearchParams,
} from './types.js';

export interface HttpCatalogClientOptions {
  /** Origin only (`https://host[:port]`), already validated by `parseCatalogOrigin`. */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Retries for 5xx, timeouts and network errors. */
  maxRetries?: number;
  /** Retries for 429 (the contract: at most 3). */
  rateLimitRetries?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Health probe timeout (single attempt). */
  healthTimeoutMs?: number;
  /** Largest body accepted (the contract caps responses at 1 MB). */
  maxBodyBytes?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  resolver?: CatalogResolver;
}

const MAX_REDIRECTS = 2;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function classify(status: number): { code: CatalogErrorCode; retryable: boolean } {
  if (status === 400) return { code: 'CATALOG_BAD_REQUEST', retryable: false };
  if (status === 401) return { code: 'CATALOG_UNAUTHENTICATED', retryable: false };
  if (status === 403) return { code: 'CATALOG_FORBIDDEN', retryable: false };
  if (status === 404) return { code: 'CATALOG_NOT_FOUND', retryable: false };
  if (status === 429) return { code: 'CATALOG_RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'CATALOG_UNAVAILABLE', retryable: true };
  return { code: 'CATALOG_INVALID_RESPONSE', retryable: false };
}

function zodSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Builds the query string of `GET /products` (`attr.<name>` for attribute filters). */
export function searchQuery(params: SearchParams): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.sku) qs.set('sku', params.sku);
  if (params.familyId) qs.set('familyId', params.familyId);
  for (const [name, value] of Object.entries(params.attributes ?? {})) {
    if (typeof value === 'string' && value.length > 0) qs.set(`attr.${name}`, value);
  }
  if (params.quantity !== undefined) qs.set('quantity', String(params.quantity));
  if (params.sort) qs.set('sort', params.sort);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  return qs;
}

export class HttpCatalogClient implements CatalogApi {
  readonly kind = 'http' as const;
  readonly origin: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimitRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly healthTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolver: CatalogResolver;

  constructor(opts: HttpCatalogClientOptions) {
    this.origin = originOf(opts.baseUrl);
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.rateLimitRetries = opts.rateLimitRetries ?? 3;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 300;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 10_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? Math.min(this.timeoutMs, 5_000);
    this.maxBodyBytes = opts.maxBodyBytes ?? 2 * 1024 * 1024;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.resolver = opts.resolver ?? systemCatalogResolver;
  }

  async searchProducts(params: SearchParams, opts: CatalogCallOptions = {}) {
    return this.get('/products', searchQuery(params), SearchResponse, opts);
  }

  async getProduct(productId: string, opts: CatalogCallOptions = {}) {
    return this.get(`/products/${encodeURIComponent(productId)}`, new URLSearchParams(), Product, opts);
  }

  async estimateCustomization(productId: string, params: EstimateParams, opts: CatalogCallOptions = {}) {
    const qs = new URLSearchParams({ technique: params.technique, area: params.area, colors: String(params.colors), quantity: String(params.quantity) });
    return this.get(`/products/${encodeURIComponent(productId)}/customization-estimate`, qs, CustomizationEstimate, opts);
  }

  async listFamilies(params: FamiliesParams = {}, opts: CatalogCallOptions = {}) {
    const qs = new URLSearchParams();
    if (params.parentId) qs.set('parentId', params.parentId);
    if (params.includeAttributes !== undefined) qs.set('includeAttributes', String(params.includeAttributes));
    return this.get('/families', qs, FamiliesResponse, opts);
  }

  async describe(opts: CatalogCallOptions = {}) {
    return this.get('/describe', new URLSearchParams(), Describe, opts);
  }

  async health(opts: CatalogCallOptions = {}) {
    const health = await this.get('/health', new URLSearchParams(), Health, opts, { retries: false, timeoutMs: this.healthTimeoutMs });
    const major = contractMajor(health.contractVersion);
    if (major !== CATALOG_SUPPORTED_MAJOR) {
      throw new CatalogError('CATALOG_CONTRACT_MISMATCH', `connector speaks contract ${health.contractVersion}; this runtime only knows MAJOR ${CATALOG_SUPPORTED_MAJOR}`, 200, false);
    }
    return health;
  }

  private async get<S extends z.ZodType>(
    path: string,
    query: URLSearchParams,
    schema: S,
    opts: CatalogCallOptions,
    mode: { retries?: boolean; timeoutMs?: number } = {},
  ): Promise<z.output<S>> {
    const qs = query.toString();
    const first = new URL(`${this.origin}${CATALOG_API_PATH}${path}${qs ? `?${qs}` : ''}`);
    const op = `GET ${CATALOG_API_PATH}${path}`;
    const timeoutMs = mode.timeoutMs ?? this.timeoutMs;
    let serverErrors = 0;
    let rateLimited = 0;
    for (;;) {
      opts.signal?.throwIfAborted();
      let delayHint: number | null = null;
      let failure: CatalogError;
      try {
        return await this.attempt(first, op, schema, timeoutMs, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        failure =
          err instanceof CatalogError
            ? err
            : err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
              ? new CatalogError('CATALOG_TIMEOUT', `${op} timed out after ${timeoutMs} ms`, null, true)
              : new CatalogError('CATALOG_NETWORK_ERROR', `${op} network error: ${err instanceof Error ? err.message : String(err)}`, null, true);
        if (failure.code === 'CATALOG_RATE_LIMITED') delayHint = (failure.details as { retryAfterMs?: number | null } | undefined)?.retryAfterMs ?? null;
      }
      if (!failure.retryable || mode.retries === false) throw failure;
      const isRate = failure.code === 'CATALOG_RATE_LIMITED';
      const n = isRate ? rateLimited++ : serverErrors++;
      if (n >= (isRate ? this.rateLimitRetries : this.maxRetries)) throw failure;
      await this.sleep(Math.min(delayHint ?? this.retryBaseDelayMs * 2 ** n, this.maxRetryDelayMs));
    }
  }

  /** One attempt, following at most MAX_REDIRECTS same-origin redirects. */
  private async attempt<S extends z.ZodType>(first: URL, op: string, schema: S, timeoutMs: number, signal: AbortSignal | undefined): Promise<z.output<S>> {
    let url = first;
    for (let hop = 0; ; hop++) {
      const egress = await checkCatalogEgress(url, this.origin, this.resolver);
      if (!egress.ok) throw new CatalogError('CATALOG_EGRESS_REFUSED', `${op} refused: ${egress.reason}`, null, false);
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });
      if (res.status >= 300 && res.status < 400) {
        await res.arrayBuffer().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location || hop >= MAX_REDIRECTS) throw new CatalogError('CATALOG_INVALID_RESPONSE', `${op} answered ${res.status} without a usable redirect`, res.status, false);
        const next = new URL(location, url);
        // The Bearer token never leaves the configured origin.
        if (originOf(next) !== this.origin) throw new CatalogError('CATALOG_EGRESS_REFUSED', `${op} redirected to another origin (${next.host}); refused`, res.status, false);
        url = next;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > this.maxBodyBytes) throw new CatalogError('CATALOG_INVALID_RESPONSE', `${op} body exceeds ${this.maxBodyBytes} bytes`, res.status, false);
      let json: unknown = null;
      try {
        json = buf.length > 0 ? JSON.parse(buf.toString('utf8')) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const { code, retryable } = classify(res.status);
        const body = ErrorBody.safeParse(json);
        const message = body.success ? `${body.data.error.code}: ${body.data.error.message}` : `HTTP ${res.status}`;
        const details = code === 'CATALOG_RATE_LIMITED' ? { retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) } : body.success ? body.data.error.details : undefined;
        throw new CatalogError(code, `${op} failed: ${message.slice(0, 300)}`, res.status, retryable, details);
      }
      const header = res.headers.get('x-catalog-contract-version');
      if (header && contractMajor(header) !== CATALOG_SUPPORTED_MAJOR) {
        throw new CatalogError('CATALOG_CONTRACT_MISMATCH', `${op}: connector speaks contract ${header}; only MAJOR ${CATALOG_SUPPORTED_MAJOR} is supported`, res.status, false);
      }
      if (json === null) throw new CatalogError('CATALOG_INVALID_RESPONSE', `${op}: non-JSON response`, res.status, false);
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new CatalogError('CATALOG_INVALID_RESPONSE', `${op}: response breaks contract v1.1 (${zodSummary(parsed.error)})`, res.status, false);
      return parsed.data;
    }
  }
}
