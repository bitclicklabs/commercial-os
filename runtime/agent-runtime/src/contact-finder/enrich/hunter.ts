/**
 * Hunter.io Domain Search client (`GET https://api.hunter.io/v2/domain-search?domain=&api_key=`).
 *
 * Answer (v2): `{ data: { domain, organization, pattern, emails: [{ value, type, confidence
 * (0-100), first_name, last_name, position, department, sources: [{ uri, ... }] }] }, meta }`;
 * errors: `{ errors: [{ id, code, details }] }` with HTTP 401 (bad key), 429 (rate limit or
 * plan quota), 4xx/5xx otherwise.
 *
 * Rate limit: Hunter allows 15 requests/s on this endpoint; the client serialises its calls
 * with a minimum interval (default 250 ms) and never retries a 429 by itself (the daily cap
 * of the EnrichService keeps the volume far below the plan quota). The API key travels in
 * the query string as Hunter documents it: the URL is never logged or returned.
 */
import { z } from 'zod';
import { EnrichError, type EnrichCandidate, type EnrichProvider } from './types.js';

export const HUNTER_BASE_URL = 'https://api.hunter.io';

const HunterEmail = z
  .object({
    value: z.string(),
    type: z.string().nullish(),
    confidence: z.number().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    position: z.string().nullish(),
    department: z.string().nullish(),
    sources: z.array(z.object({ uri: z.string().nullish() }).loose()).nullish(),
  })
  .loose();

const HunterAnswer = z.object({ data: z.object({ domain: z.string().nullish(), emails: z.array(HunterEmail).default([]) }).loose() }).loose();
const HunterErrors = z.object({ errors: z.array(z.object({ id: z.string().nullish(), code: z.number().nullish(), details: z.string().nullish() }).loose()) }).loose();

export interface HunterOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Minimum time between two requests (ms). */
  minIntervalMs?: number;
  /** Max addresses asked per search (Hunter `limit`). */
  limit?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const httpUri = (u: string | null | undefined): u is string => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2048;

export class HunterProvider implements EnrichProvider {
  readonly name = 'hunter';
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly opts: HunterOptions) {
    if (!opts.apiKey) throw new Error('HunterProvider requires an API key');
  }

  lookup(domain: string, signal: AbortSignal): Promise<EnrichCandidate[]> {
    const run = this.queue.then(() => this.request(domain, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(domain: string, signal: AbortSignal): Promise<EnrichCandidate[]> {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.lastAt + (this.opts.minIntervalMs ?? 250) - now();
    if (wait > 0) await sleep(wait);
    this.lastAt = now();
    const url = new URL('/v2/domain-search', this.opts.baseUrl ?? HUNTER_BASE_URL);
    url.searchParams.set('domain', domain);
    url.searchParams.set('limit', String(this.opts.limit ?? 10));
    url.searchParams.set('api_key', this.opts.apiKey);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)]);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, { method: 'GET', headers: { accept: 'application/json' }, signal: deadline });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new EnrichError(deadline.aborted ? 'ENRICH_TIMEOUT' : 'ENRICH_NETWORK_ERROR', `hunter: ${deadline.aborted ? 'timeout' : err instanceof Error ? err.message : String(err)}`, true);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const errors = HunterErrors.safeParse(body);
      const detail = errors.success ? errors.data.errors.map((e) => e.details ?? e.id ?? '').filter(Boolean).join('; ').slice(0, 300) : '';
      if (res.status === 401) throw new EnrichError('ENRICH_UNAUTHORIZED', `hunter: API key rechazada (401)${detail ? `: ${detail}` : ''}`);
      if (res.status === 429) throw new EnrichError('ENRICH_RATE_LIMITED', `hunter: límite de peticiones o de cuota (429)${detail ? `: ${detail}` : ''}`, true);
      throw new EnrichError('ENRICH_HTTP_ERROR', `hunter: HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status >= 500);
    }
    const parsed = HunterAnswer.safeParse(body);
    if (!parsed.success) throw new EnrichError('ENRICH_BAD_RESPONSE', 'hunter: la respuesta no tiene la forma esperada');
    return parsed.data.data.emails.map((e) => ({
      email: e.value.trim().toLowerCase(),
      firstName: e.first_name?.trim() || null,
      lastName: e.last_name?.trim() || null,
      position: e.position?.trim() || null,
      department: e.department?.trim() || null,
      confidence: Math.max(0, Math.min(1, (e.confidence ?? 0) / 100)),
      sources: (e.sources ?? []).map((s) => s.uri).filter(httpUri).slice(0, 5),
    }));
  }
}
