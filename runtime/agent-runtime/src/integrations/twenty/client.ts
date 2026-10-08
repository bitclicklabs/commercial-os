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
 */

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
}

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
  | 'TWENTY_SYNTHETIC_REFUSED';

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

  constructor(opts: TwentyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : undefined;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 300;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 5_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
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
    if (opts.filter) query.filter = opts.filter;
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
    return { records: records as T[], totalCount: envelope.totalCount ?? null, pageInfo: envelope.pageInfo ?? {} };
  }

  /** Returns null when the record does not exist (404). */
  async get<T>(objectPlural: string, id: string, opts: { depth?: 0 | 1 | 2; signal?: AbortSignal } = {}): Promise<T | null> {
    const query: Record<string, string> = {};
    if (opts.depth !== undefined) query.depth = String(opts.depth);
    try {
      const json = await this.request('GET', `/rest/${objectPlural}/${encodeURIComponent(id)}`, { query, signal: opts.signal });
      return (unwrap(json) as T | undefined) ?? null;
    } catch (err) {
      if (err instanceof TwentyApiError && err.code === 'TWENTY_NOT_FOUND') return null;
      throw err;
    }
  }

  async create<T>(objectPlural: string, data: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const json = await this.request('POST', `/rest/${objectPlural}`, { body: data, signal: opts.signal });
    return unwrap(json) as T;
  }

  async update<T>(objectPlural: string, id: string, data: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const json = await this.request('PATCH', `/rest/${objectPlural}/${encodeURIComponent(id)}`, { body: data, signal: opts.signal });
    return unwrap(json) as T;
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

/** Builds a client from TWENTY_BASE_URL / TWENTY_API_KEY (and optional TWENTY_TIMEOUT_MS). */
export function twentyClientFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<TwentyClientOptions> = {}): TwentyClient {
  const timeout = Number(env.TWENTY_TIMEOUT_MS);
  return new TwentyClient({
    baseUrl: env.TWENTY_BASE_URL && env.TWENTY_BASE_URL.length > 0 ? env.TWENTY_BASE_URL : 'http://localhost:3020',
    apiKey: env.TWENTY_API_KEY,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...overrides,
  });
}
