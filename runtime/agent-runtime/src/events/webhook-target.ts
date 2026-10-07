/**
 * SSRF guard of outbound webhooks (event_subscriptions.target_url).
 *
 * - Only `http:` / `https:`, no credentials in the URL, at most 2048 characters.
 * - Every address the host resolves to must be public unicast (same IP rules as fetch_url,
 *   `src/tools/web/ip-guard.ts`): loopback, private, link-local (cloud metadata), CGNAT,
 *   unique-local IPv6, IPv4 embedded in IPv6... are refused.
 * - Exception: hosts listed in EXTERNAL_WEBHOOK_ALLOW_PRIVATE (comma separated `host` or
 *   `host:port`; exact host match, no subdomains). Example for a local n8n in development:
 *     EXTERNAL_WEBHOOK_ALLOW_PRIVATE=host.docker.internal:5678,localhost:5678
 *   With a port the entry only covers that port.
 *
 * The check runs when a subscription is created or its URL changes (400 if refused) and
 * again before every delivery; the delivery pins the TCP connection to the checked address
 * so a DNS rebinding between check and connect cannot reach a private address.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkAddress } from '../tools/web/ip-guard.js';

export interface PrivateAllowEntry {
  host: string;
  /** Undefined = any port. */
  port?: number;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultLookupAll: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export type TargetVerdict =
  | { ok: true; url: URL; addresses: ResolvedAddress[]; allowlisted: boolean }
  | { ok: false; reason: string };

export const MAX_TARGET_URL_LENGTH = 2048;

function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** `host.docker.internal:5678, localhost , [::1]:8080` -> entries. Invalid ports are dropped. */
export function parsePrivateAllowlist(raw: string | undefined): PrivateAllowEntry[] {
  const out: PrivateAllowEntry[] = [];
  for (const item of (raw ?? '').split(/[\s,;]+/)) {
    const entry = item.trim();
    if (!entry) continue;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    const plain = bracketed ? null : /^([^:]+)(?::(\d+))?$/.exec(entry);
    const host = bracketed?.[1] ?? plain?.[1] ?? (isIP(entry) === 6 ? entry : undefined);
    const portRaw = bracketed?.[2] ?? plain?.[2];
    if (!host) continue;
    if (portRaw !== undefined) {
      const port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      out.push({ host: normaliseHost(host), port });
    } else out.push({ host: normaliseHost(host) });
  }
  return out;
}

export function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

export function isAllowlisted(url: URL, allow: readonly PrivateAllowEntry[]): boolean {
  const host = normaliseHost(url.hostname);
  const port = effectivePort(url);
  return allow.some((e) => e.host === host && (e.port === undefined || e.port === port));
}

/** Syntax only (no DNS): scheme, credentials, length, host present. */
export function parseTargetUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  if (raw.length > MAX_TARGET_URL_LENGTH) return { ok: false, reason: `target_url longer than ${MAX_TARGET_URL_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'target_url is not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} not allowed (only http/https)` };
  if (url.username || url.password) return { ok: false, reason: 'target_url must not contain credentials' };
  if (!normaliseHost(url.hostname)) return { ok: false, reason: 'target_url has no host' };
  return { ok: true, url };
}

/**
 * Full check: syntax, DNS resolution and IP policy. Allowlisted hosts may resolve to
 * private addresses (they still have to resolve, except at creation time where
 * `requireResolution = false` lets the API accept a host only visible to the scheduler).
 */
export async function checkWebhookTarget(
  raw: string,
  opts: { allowPrivate: readonly PrivateAllowEntry[]; lookup?: LookupAll; requireResolution?: boolean },
): Promise<TargetVerdict> {
  const parsed = parseTargetUrl(raw);
  if (!parsed.ok) return parsed;
  const url = parsed.url;
  const host = normaliseHost(url.hostname);
  const allowlisted = isAllowlisted(url, opts.allowPrivate);

  let addresses: ResolvedAddress[];
  const family = isIP(host.split('%')[0]!);
  if (family !== 0) addresses = [{ address: host, family }];
  else {
    try {
      addresses = await (opts.lookup ?? defaultLookupAll)(host);
    } catch (err) {
      if (allowlisted && opts.requireResolution === false) return { ok: true, url, addresses: [], allowlisted };
      return { ok: false, reason: `host ${host} does not resolve (${(err as NodeJS.ErrnoException).code ?? 'dns error'})` };
    }
  }
  if (addresses.length === 0) {
    if (allowlisted && opts.requireResolution === false) return { ok: true, url, addresses, allowlisted };
    return { ok: false, reason: `host ${host} does not resolve` };
  }
  if (!allowlisted) {
    for (const a of addresses) {
      const verdict = checkAddress(a.address);
      if (!verdict.ok) {
        return {
          ok: false,
          reason: `${verdict.reason} (host ${host}); private targets need EXTERNAL_WEBHOOK_ALLOW_PRIVATE=${host}:${effectivePort(url)}`,
        };
      }
    }
  }
  return { ok: true, url, addresses, allowlisted };
}
