/**
 * Egress rule of the catalog client (contract v1.1, "Red: VPN y guard anti-SSRF").
 *
 * The connector lives behind a VPN, on a private address that the runtime's SSRF guard refuses
 * by design. The exemption is an ALLOWLIST OF ONE ORIGIN inside this dedicated client:
 *
 * - a URL whose origin (scheme + host + port) is exactly the configured `CATALOG_BASE_URL`
 *   origin is allowed even if it resolves to a private address;
 * - any other URL (another host, a subdomain, the same host on another port or scheme) goes
 *   through the general guard of src/tools/web/ip-guard.ts unchanged: scheme, credentials,
 *   ports, internal names, and every resolved address must be public.
 *
 * The general guard (`fetch_url`, `render_url`, webhooks) is not touched: this file only
 * imports its pure checks. Changing CATALOG_BASE_URL changes the only exempt origin.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkAddress, checkUrl, DEFAULT_ALLOWED_PORTS, type AddressVerdict, type HostPolicy } from '../../tools/web/ip-guard.js';

export type CatalogResolver = (hostname: string) => Promise<string[]>;

export const systemCatalogResolver: CatalogResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

const GENERAL_POLICY: HostPolicy = { allow: [], deny: [], allowedPorts: DEFAULT_ALLOWED_PORTS };

/** Origin of a URL in canonical form (lowercase host, default port dropped). */
export function originOf(url: string | URL): string {
  return new URL(url.toString()).origin.toLowerCase();
}

export async function checkCatalogEgress(url: URL, exemptOrigin: string, resolver: CatalogResolver = systemCatalogResolver): Promise<AddressVerdict> {
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  if (originOf(url) === exemptOrigin.toLowerCase()) return { ok: true };
  // Not the configured connector: the general SSRF guard applies, exactly as for fetch_url.
  const verdict = checkUrl(url, GENERAL_POLICY);
  if (!verdict.ok) return verdict;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host.split('%')[0]!)) return checkAddress(host);
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} has no address` };
  for (const address of addresses) {
    const v = checkAddress(address);
    if (!v.ok) return { ok: false, reason: `${host} resolves to a non-public address (${v.reason})` };
  }
  return { ok: true };
}
