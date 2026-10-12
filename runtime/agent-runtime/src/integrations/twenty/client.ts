/**
 * Typed REST client for Twenty CRM (`/rest/{objectNamePlural}`).
 *
 * - Bearer API key auth (TWENTY_API_KEY). The key never leaves this module: it is
 *   not logged and not included in errors.
 * - Per-request timeout via AbortSignal, combined with the caller's signal.
 * - Gentle retries with exponential backoff for 429 and 5xx (honours Retry-After).
 *   Network errors and timeouts are retried only for GET: a POST/PATCH that timed
 *   out may have been applied, so the tools re-check (find-before-create) instead.
 * - There is intentionally NO delete method: deleting CRM data is never autonomous
 *   (LLD v0.2 section 10.3).
 * - Tenancy (LLD C6): one Twenty workspace may hold records of several tenants (the App
 *   objects carry `tenantId`). `list()` / `get()` / `update()` take an optional `tenantId`: on a
 *   tenant-scoped object (`TENANT_SCOPED_OBJECTS`) the list gets the `tenantId[eq]` filter
 *   injected, and a record of another tenant is refused with `TWENTY_TENANT_MISMATCH` before any
 *   PATCH. Records with an EMPTY `tenantId` (created by hand in the Twenty UI, which does not
 *   fill it) belong to the workspace owner, `ownerTenantId` (the runtime's DEFAULT_TENANT_ID).
 *   On the standard objects (no `tenantId` field) the option is a no-op.
 */
import { isTenantScopedObject } from './objects.js';

export interface TwentyClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after the first one. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Upper bound for a single backoff / Retry-After wait. */
  maxRetryDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Tenant that owns the records with an empty `tenantId` (hand-made in the Twenty UI): the
   * runtime's DEFAULT_TENANT_ID. Default `publiexpe` (the config default).
   */
  ownerTenantId?: string;
}

/** Same default as `config.defaultTenantId` (src/config.ts). */
export const DEFAULT_OWNER_TENANT_ID = 'publiexpe';

export type TwentyErrorCode =
  | 'TWENTY_NOT_CONFIGURED'
  | 'TWENTY_UNAUTHORIZED'
  | 'TWENTY_BAD_REQUEST'
  | 'TWENTY_DUPLICATE'
  | 'TWENTY_NOT_FOUND'
  | 'TWENTY_RATE_LIMITED'
  | 'TWENTY_SERVER_ERROR'
  | 'TWENTY_TIMEOUT'
  | 'TWENTY_NETWORK_ERROR'
  | 'TWENTY_INVALID_RESPONSE'
  | 'TWENTY_SYNTHETIC_REFUSED'
  | 'TWENTY_TENANT_MISMATCH';

export class TwentyApiError extends Error {
  constructor(
    readonly code: TwentyErrorCode,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly messages: string[] = [],
  ) {
    super(message);
    this.name = 'TwentyApiError';
  }
}

export interface PageInfo {
  startCursor?: string | null;
  endCursor?: string | null;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
}

export interface ListOptions {
  /** Twenty filter expression, e.g. `name[ilike]:"%acme%"`. Build values with `filterValue()`. */
  filter?: string;
  limit?: number;
  orderBy?: string;
  depth?: 0 | 1 | 2;
  startingAfter?: string;
  signal?: AbortSignal;
  /**
   * Tenant of the caller. On a tenant-scoped object the client adds the `tenantId[eq]` filter
   * (plus the empty-tenant records when it is the owner tenant) and drops any record of another
   * tenant a server might return anyway. No-op on objects without `tenantId`.
   */
  tenantId?: string;
}

export interface TenantOption {
  /** Tenant of the caller: a record of another tenant is refused with `TWENTY_TENANT_MISMATCH`. */
  tenantId?: string;
}

export interface ListResult<T> {
  records: T[];
  totalCount: number | null;
  pageInfo: PageInfo;
}

type Method = 'GET' | 'POST' | 'PATCH';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Quotes a value for a Twenty filter expression. Quotes and backslashes are dropped (no escape syntax). */
export function filterValue(value: string): string {
  return `"${value.replace(/["\\]/g, '')}"`;
}

/** The `tenantId` of a record, trimmed; null when the field is missing, null or empty. */
export function recordTenantOf(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const t = (record as { tenantId?: unknown }).tenantId;
  return typeof t === 'string' && t.trim().length > 0 ? t.trim() : null;
}

/** True when `record` belongs to `tenantId`: same `tenantId`, or no tenant and `tenantId` is the owner. */
export function recordBelongsTo(record: unknown, tenantId: string, ownerTenantId: string): boolean {
  const t = recordTenantOf(record);
  return t === null ? tenantId === ownerTenantId : t === tenantId;
}

/**
 * Twenty filter that keeps the records of `tenantId`. The owner tenant also keeps the records
 * without tenant (`[is]:NULL`, or empty text: how Twenty stores an unfilled TEXT field).
 */
export function tenantFilter(tenantId: string, ownerTenantId: string): string {
  const own = `tenantId[eq]:${filterValue(tenantId)}`;
  return tenantId === ownerTenantId ? `or(${own},tenantId[is]:NULL,tenantId[eq]:"")` : own;
}

function classify(status: number, messages: string[]): { code: TwentyErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'TWENTY_UNAUTHORIZED', retryable: false };
  if (status === 404) return { code: 'TWENTY_NOT_FOUND', retryable: false };
  if (status === 429) return { code: 'TWENTY_RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'TWENTY_SERVER_ERROR', retryable: true };
  if (messages.some((m) => /duplicate entry|unique constraint/i.test(m))) return { code: 'TWENTY_DUPLICATE', retryable: false };
  return { code: 'TWENTY_BAD_REQUEST', retryable: false };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Synthetic evaluation data (src/synthetic/) uses only `.invalid` domains (RFC 6761). A write
 * that carries one is refused unless the client points at an in-memory or test CRM (host under
 * `.invalid` or `.test`, as MemoryTwenty and the test FakeTwenty do): synthetic exhibitors can
 * never land in the real Twenty, whatever path they take.
 */
const SYNTHETIC_HOST_IN_TEXT = /(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)+invalid(?![a-z0-9-])/i;

export function isSandboxTwentyUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.endsWith('.invalid') || host.endsWith('.test');
  } catch {
    return false;
  }
}

export function carriesSyntheticDomain(body: unknown): boolean {
  return body !== undefined && SYNTHETIC_HOST_IN_TEXT.test(JSON.stringify(body));
}

/** Twenty wraps every payload as `{ data: { <operationName>: value } }`; return that single value. */
function unwrap(json: unknown): unknown {
  if (!json || typeof json !== 'object' || !('data' in json)) {
    throw new TwentyApiError('TWENTY_INVALID_RESPONSE', 'Twenty response has no data envelope', null, false);
  }
  const data = (json as { data: unknown }).data;
  if (!data || typeof data !== 'object') {
    throw new TwentyApiError('TWENTY_INVALID_RESPONSE', 'Twenty response data is not an object', null, false);
  }
  const values = Object.values(data as Record<string, unknown>);
  return values[0];
}

export class TwentyClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Tenant that owns the records with an empty `tenantId` (see the module comment). */
  readonly ownerTenantId: string;

  constructor(opts: TwentyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : undefined;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 300;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 5_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.ownerTenantId = opts.ownerTenantId && opts.ownerTenantId.trim().length > 0 ? opts.ownerTenantId.trim() : DEFAULT_OWNER_TENANT_ID;
  }

  /** True when `record` belongs to `tenantId` (records without tenant belong to the owner tenant). */
  belongsTo(record: unknown, tenantId: string): boolean {
    return recordBelongsTo(record, tenantId, this.ownerTenantId);
  }

  /**
   * Throws `TWENTY_TENANT_MISMATCH` when `record` (of a tenant-scoped object) belongs to another
   * tenant than `tenantId`. No-op without `tenantId` or on objects without `tenantId`.
   */
  assertTenant(objectPlural: string, id: string, record: unknown, tenantId: string | undefined): void {
    if (tenantId === undefined || !isTenantScopedObject(objectPlural) || this.belongsTo(record, tenantId)) return;
    throw new TwentyApiError(
      'TWENTY_TENANT_MISMATCH',
      `Twenty ${objectPlural}/${id} belongs to tenant "${recordTenantOf(record) ?? this.ownerTenantId}", not to "${tenantId}": refused`,
      null,
      false,
    );
  }

  isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  /** True if the server answers an authenticated request. Never throws. */
  async ping(timeoutMs = 3_000): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/rest/companies?limit=1`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Cheap liveness probe against Twenty's `/healthz` (unauthenticated: the API key is not sent).
   * One attempt, short timeout, no retries. True only on a 2xx. Never throws.
   * Used by the worker to hold runs while Twenty is still booting (`health: starting`).
   */
  async health(timeoutMs = 3_000): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain the body so the connection can be reused.
      await res.text().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  async list<T>(objectPlural: string, opts: ListOptions = {}): Promise<ListResult<T>> {
    const query: Record<string, string> = {};
    const scoped = opts.tenantId !== undefined && isTenantScopedObject(objectPlural) ? opts.tenantId : undefined;
    const tenant = scoped !== undefined ? tenantFilter(scoped, this.ownerTenantId) : undefined;
    const filter = tenant && opts.filter ? `and(${tenant},${opts.filter})` : (tenant ?? opts.filter);
    if (filter) query.filter = filter;
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    if (opts.orderBy) query.order_by = opts.orderBy;
    if (opts.depth !== undefined) query.depth = String(opts.depth);
    if (opts.startingAfter) query.starting_after = opts.startingAfter;
    const json = await this.request('GET', `/rest/${objectPlural}`, { query, signal: opts.signal });
    const records = unwrap(json);
    if (!Array.isArray(records)) {
      throw new TwentyApiError('TWENTY_INVALID_RESPONSE', `Expected a list for ${objectPlural}`, null, false);
    }
    const envelope = json as { totalCount?: number; pageInfo?: PageInfo };
    // Defensive: a server that ignored the filter must not leak another tenant's records in.
    const kept = scoped !== undefined ? records.filter((r) => this.belongsTo(r, scoped)) : records;
    return { records: kept as T[], totalCount: envelope.totalCount ?? null, pageInfo: envelope.pageInfo ?? {} };
  }

  /**
   * Returns null when the record does not exist (404). With `tenantId`, a record of another
   * tenant throws `TWENTY_TENANT_MISMATCH` (it is never returned as if it were the caller's).
   */
  async get<T>(objectPlural: string, id: string, opts: { depth?: 0 | 1 | 2; signal?: AbortSignal } & TenantOption = {}): Promise<T | null> {
    const query: Record<string, string> = {};
    if (opts.depth !== undefined) query.depth = String(opts.depth);
    let record: T | null;
    try {
      const json = await this.request('GET', `/rest/${objectPlural}/${encodeURIComponent(id)}`, { query, signal: opts.signal });
      record = (unwrap(json) as T | undefined) ?? null;
    } catch (err) {
      if (err instanceof TwentyApiError && err.code === 'TWENTY_NOT_FOUND') return null;
      throw err;
    }
    if (record !== null) this.assertTenant(objectPlural, id, record, opts.tenantId);
    return record;
  }

  async create<T>(objectPlural: string, data: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const json = await this.request('POST', `/rest/${objectPlural}`, { body: data, signal: opts.signal });
    return unwrap(json) as T;
  }

  /**
   * PATCH. With `tenantId` (tenant-scoped object), the record is re-read first and a record of
   * another tenant is refused with `TWENTY_TENANT_MISMATCH` BEFORE the PATCH (a missing one with
   * `TWENTY_NOT_FOUND`). Callers that already read the record with `get({ tenantId })` can skip it.
   */
  async update<T>(objectPlural: string, id: string, data: Record<string, unknown>, opts: { signal?: AbortSignal } & TenantOption = {}): Promise<T> {
    if (opts.tenantId !== undefined && isTenantScopedObject(objectPlural)) {
      const current = await this.get(objectPlural, id, { depth: 0, tenantId: opts.tenantId, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (current === null) throw new TwentyApiError('TWENTY_NOT_FOUND', `Twenty ${objectPlural}/${id} not found`, 404, false);
    }
    const json = await this.request('PATCH', `/rest/${objectPlural}/${encodeURIComponent(id)}`, { body: data, signal: opts.signal });
    return unwrap(json) as T;
  }

  /**
   * The workspace's OpenAPI document of the core objects (`GET /rest/open-api/core`, read only).
   * It carries the SELECT options of every field in their configured order (e.g. the stages of
   * `opportunity.stage`), readable with an ordinary API key (the metadata REST API is not).
   */
  async getOpenApiCore(opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const json = await this.request('GET', '/rest/open-api/core', { signal: opts.signal });
    if (!json || typeof json !== 'object') throw new TwentyApiError('TWENTY_INVALID_RESPONSE', 'OpenAPI document is not an object', null, false);
    return json as Record<string, unknown>;
  }

  private async request(
    method: Method,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal | undefined },
  ): Promise<unknown> {
    if (!this.apiKey) {
      throw new TwentyApiError('TWENTY_NOT_CONFIGURED', 'TWENTY_API_KEY is not set', null, false);
    }
    if (method !== 'GET' && carriesSyntheticDomain(opts.body) && !isSandboxTwentyUrl(this.baseUrl)) {
      throw new TwentyApiError('TWENTY_SYNTHETIC_REFUSED', `Twenty ${method} ${path} refused: the payload carries a synthetic .invalid domain (evaluation data never goes to a real CRM)`, null, false);
    }
    const qs = opts.query && Object.keys(opts.query).length > 0 ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: TwentyApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      opts.signal?.throwIfAborted();
      let delayHint: number | null = null;
      try {
        const signals = [AbortSignal.timeout(this.timeoutMs)];
        if (opts.signal) signals.push(opts.signal);
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.any(signals),
        });
        const text = await res.text();
        let json: unknown = null;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        if (res.ok) {
          if (json === null) throw new TwentyApiError('TWENTY_INVALID_RESPONSE', `Non-JSON response from ${method} ${path}`, res.status, false);
          return json;
        }
        const messages = extractMessages(json);
        const { code, retryable } = classify(res.status, messages);
        lastError = new TwentyApiError(
          code,
          `Twenty ${method} ${path} failed with ${res.status}${messages.length ? `: ${messages.join('; ')}` : ''}`,
          res.status,
          retryable,
          messages,
        );
        if (!retryable) throw lastError;
        delayHint = parseRetryAfter(res.headers.get('retry-after'));
      } catch (err) {
        if (err instanceof TwentyApiError) {
          if (!err.retryable) throw err;
          lastError = err;
        } else {
          // Caller cancellation is not retried.
          if (opts.signal?.aborted) throw err;
          const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          lastError = new TwentyApiError(
            isTimeout ? 'TWENTY_TIMEOUT' : 'TWENTY_NETWORK_ERROR',
            isTimeout
              ? `Twenty ${method} ${path} timed out after ${this.timeoutMs} ms`
              : `Twenty ${method} ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
            null,
            true,
          );
          // Non-idempotent writes are not blindly retried on ambiguous failures.
          if (method !== 'GET') throw lastError;
        }
      }
      if (attempt < this.maxRetries) {
        const backoff = this.retryBaseDelayMs * 2 ** attempt;
        await this.sleep(Math.min(delayHint ?? backoff, this.maxRetryDelayMs));
      }
    }
    throw lastError ?? new TwentyApiError('TWENTY_NETWORK_ERROR', `Twenty ${method} ${path} failed`, null, true);
  }
}

function extractMessages(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const j = json as { messages?: unknown; message?: unknown; error?: unknown };
  if (Array.isArray(j.messages)) return j.messages.map(String);
  if (typeof j.message === 'string') return [j.message];
  if (typeof j.error === 'string') return [j.error];
  return [];
}

/** Builds a client from TWENTY_BASE_URL / TWENTY_API_KEY (optional TWENTY_TIMEOUT_MS; owner tenant from DEFAULT_TENANT_ID). */
export function twentyClientFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<TwentyClientOptions> = {}): TwentyClient {
  const timeout = Number(env.TWENTY_TIMEOUT_MS);
  return new TwentyClient({
    baseUrl: env.TWENTY_BASE_URL && env.TWENTY_BASE_URL.length > 0 ? env.TWENTY_BASE_URL : 'http://localhost:3020',
    apiKey: env.TWENTY_API_KEY,
    // Same variable as config.defaultTenantId: the tenant this runtime serves owns the hand-made records.
    ownerTenantId: env.DEFAULT_TENANT_ID && env.DEFAULT_TENANT_ID.trim().length > 0 ? env.DEFAULT_TENANT_ID : DEFAULT_OWNER_TENANT_ID,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...overrides,
  });
}
