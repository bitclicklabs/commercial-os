/**
 * Catalog configuration (docs/catalog-service.md, Variables):
 *
 * | CATALOG_ENABLED   | `false` | Only the exact value `true` turns it on. Off = the catalog_* tools are not exposed and no health check runs |
 * | CATALOG_PROVIDER  | `stub`  | `stub` (fixtures, no network) or `http` (the publiexpe connector) |
 * | CATALOG_BASE_URL  | empty   | ONLY the origin, `https://host[:port]`; the client appends `/api/catalog/v1`. Mandatory with `http`. The only host exempt from the SSRF guard |
 * | CATALOG_API_TOKEN | empty   | Read-only Bearer token (`pxcat_…`). Never logged |
 *
 * Optional: CATALOG_TIMEOUT_MS (per attempt, default 10 000 = the contract's cut) and
 * CATALOG_STUB_FIXTURES_DIR (default `fixtures/catalog` of the runtime package).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type CatalogProviderKind = 'stub' | 'http';

export interface CatalogConfig {
  enabled: boolean;
  provider: CatalogProviderKind;
  /** Normalised origin (`https://host[:port]`, no trailing slash) or null. */
  baseUrl: string | null;
  token: string | null;
  timeoutMs: number;
  fixturesDir: string | null;
  /** Blocking configuration problems (only meaningful with `enabled` + `http`). */
  problems: string[];
  /** Non-blocking remarks (logged at boot). */
  warnings: string[];
}

export const CATALOG_DEFAULT_TIMEOUT_MS = 10_000;
export const CATALOG_TOKEN_PREFIX = 'pxcat_';

const blank = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : v.trim());

/**
 * Parses `CATALOG_BASE_URL`: an http(s) ORIGIN. A path other than `/`, a query, a fragment or
 * credentials are refused (the client owns the path; credentials never go in a URL).
 */
export function parseCatalogOrigin(raw: string): { ok: true; origin: string; host: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `CATALOG_BASE_URL is not a valid URL: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `CATALOG_BASE_URL must be http(s), got ${url.protocol}` };
  if (url.username || url.password) return { ok: false, reason: 'CATALOG_BASE_URL must not carry credentials (use CATALOG_API_TOKEN)' };
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, reason: `CATALOG_BASE_URL must be only the origin (https://host[:port]); the client appends /api/catalog/v1. Got path "${url.pathname}${url.search}"` };
  }
  if (!url.hostname) return { ok: false, reason: 'CATALOG_BASE_URL has no host' };
  return { ok: true, origin: url.origin, host: url.host.toLowerCase() };
}

export function catalogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  const enabled = blank(env.CATALOG_ENABLED)?.toLowerCase() === 'true';
  const providerRaw = (blank(env.CATALOG_PROVIDER) ?? 'stub').toLowerCase();
  const problems: string[] = [];
  const warnings: string[] = [];
  let provider: CatalogProviderKind = 'stub';
  if (providerRaw === 'stub' || providerRaw === 'http') provider = providerRaw;
  else problems.push(`CATALOG_PROVIDER must be "stub" or "http", got "${providerRaw}"`);

  const rawUrl = blank(env.CATALOG_BASE_URL);
  let baseUrl: string | null = null;
  if (rawUrl) {
    const parsed = parseCatalogOrigin(rawUrl);
    if (parsed.ok) baseUrl = parsed.origin;
    else problems.push(parsed.reason);
  }
  const token = blank(env.CATALOG_API_TOKEN);
  if (provider === 'http') {
    if (!rawUrl) problems.push('CATALOG_BASE_URL is required with CATALOG_PROVIDER=http');
    if (!token) problems.push('CATALOG_API_TOKEN is required with CATALOG_PROVIDER=http');
    else if (!token.startsWith(CATALOG_TOKEN_PREFIX)) warnings.push(`CATALOG_API_TOKEN does not start with "${CATALOG_TOKEN_PREFIX}" (the backend issues catalog tokens with that prefix)`);
    if (baseUrl?.startsWith('http:')) warnings.push('CATALOG_BASE_URL is plain http: the contract asks for HTTPS (TLS 1.2+) over the VPN');
  }
  const timeout = Number(env.CATALOG_TIMEOUT_MS);
  return {
    enabled,
    provider,
    baseUrl,
    token,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 60_000) : CATALOG_DEFAULT_TIMEOUT_MS,
    fixturesDir: blank(env.CATALOG_STUB_FIXTURES_DIR),
    problems: enabled ? problems : [],
    warnings: enabled ? warnings : [],
  };
}

export type CatalogBootCheck = { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

/**
 * Boot validation (main.ts). Blocking: an enabled catalog with an invalid configuration (bad
 * provider, base URL that is not an http(s) origin, missing token). Non-blocking: a host that
 * does not resolve right now (the VPN may come up later; the health gate degrades meanwhile).
 */
export async function checkCatalogAtBoot(
  cfg: CatalogConfig,
  resolve: (host: string) => Promise<unknown> = (host) => lookup(host),
): Promise<CatalogBootCheck> {
  const warnings = [...cfg.warnings];
  if (!cfg.enabled) return { ok: true, warnings };
  if (cfg.problems.length > 0) return { ok: false, errors: cfg.problems, warnings };
  if (cfg.provider === 'http' && cfg.baseUrl) {
    const host = new URL(cfg.baseUrl).hostname.replace(/^\[|\]$/g, '');
    if (!isIP(host)) {
      try {
        await resolve(host);
      } catch (err) {
        warnings.push(`CATALOG_BASE_URL host ${host} does not resolve now (${err instanceof Error ? err.message : String(err)}); is the VPN up? Runs go on without catalog until /health answers`);
      }
    }
  }
  return { ok: true, warnings };
}
