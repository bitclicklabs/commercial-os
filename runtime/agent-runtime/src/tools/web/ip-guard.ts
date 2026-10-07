/**
 * SSRF guard for `fetch_url` (LLD v0.2 §10.4.5): which IP addresses and hosts the
 * runtime may connect to. Only public unicast addresses are allowed; loopback,
 * private, link-local (cloud metadata 169.254.169.254 included), CGNAT, multicast,
 * documentation/benchmark and reserved ranges are refused, also when they are
 * embedded in IPv6 (IPv4-mapped, NAT64, 6to4, Teredo).
 */
import { isIP } from 'node:net';

export type AddressVerdict = { ok: true } | { ok: false; reason: string };

/** IPv4 ranges that are never reachable from fetch_url: [network, prefix, label]. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function v4InRange(ip: number, network: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  const base = v4ToInt(network);
  return ip >= base && ip < base + size;
}

export function checkIPv4(ip: string): AddressVerdict {
  const n = v4ToInt(ip);
  for (const [network, prefix, label] of BLOCKED_V4) {
    if (v4InRange(n, network, prefix)) return { ok: false, reason: `${label} address ${ip}` };
  }
  return { ok: true };
}

/** Expands an IPv6 literal (with optional zone id and embedded dotted quad) into 8 hextets. */
export function expandIPv6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  // Embedded IPv4 in the last 32 bits.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    ip = `${ip.slice(0, -v4[1]!.length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const parts = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...t].map((p) => parseInt(p, 16));
  return parts.length === 8 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 0xffff) ? parts : null;
}

function embeddedV4(h: number[], hiIndex: number): string {
  const a = h[hiIndex]!;
  const b = h[hiIndex + 1]!;
  return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
}

export function checkIPv6(ip: string): AddressVerdict {
  const h = expandIPv6(ip);
  if (!h) return { ok: false, reason: `unparseable IPv6 address ${ip}` };
  const deny = (label: string): AddressVerdict => ({ ok: false, reason: `${label} address ${ip}` });
  const allZeroTo = (n: number) => h.slice(0, n).every((x) => x === 0);

  if (allZeroTo(8)) return deny('unspecified');
  if (allZeroTo(7) && h[7] === 1) return deny('loopback');
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated).
  if (allZeroTo(5) && h[5] === 0xffff) return checkIPv4(embeddedV4(h, 6));
  if (allZeroTo(6)) return checkIPv4(embeddedV4(h, 6));
  // 64:ff9b::/96 NAT64 and 64:ff9b:1::/48 local-use NAT64.
  if (h[0] === 0x64 && h[1] === 0xff9b) return h[2] === 1 ? deny('nat64-local') : checkIPv4(embeddedV4(h, 6));
  // 2002::/16 6to4: the IPv4 is in hextets 1-2.
  if (h[0] === 0x2002) return checkIPv4(embeddedV4(h, 1));
  // 2001:0::/32 Teredo: tunnels to arbitrary IPv4 (obfuscated); refuse outright.
  if (h[0] === 0x2001 && h[1] === 0) return deny('teredo');
  if (h[0] === 0x2001 && h[1] === 0xdb8) return deny('documentation');
  if (h[0] === 0x2001 && h[1]! < 0x200) return deny('ietf-protocol');
  // 100::/64 discard-only.
  if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return deny('discard');
  if ((h[0]! & 0xfe00) === 0xfc00) return deny('unique-local');
  if ((h[0]! & 0xffc0) === 0xfe80) return deny('link-local');
  if ((h[0]! & 0xffc0) === 0xfec0) return deny('site-local');
  if ((h[0]! & 0xff00) === 0xff00) return deny('multicast');
  // Only global unicast 2000::/3 is routable on the public internet.
  if ((h[0]! & 0xe000) !== 0x2000) return deny('non-global');
  return { ok: true };
}

/** True only for public unicast IPv4/IPv6 addresses. */
export function checkAddress(ip: string): AddressVerdict {
  const bare = ip.replace(/^\[|\]$/g, '');
  const family = isIP(bare.split('%')[0]!);
  if (family === 4) return checkIPv4(bare);
  if (family === 6) return checkIPv6(bare);
  return { ok: false, reason: `not an IP address: ${ip}` };
}

// ---------------------------------------------------------------------------
// Host policy (allowlist / denylist)
// ---------------------------------------------------------------------------

export interface HostPolicy {
  /** Empty = every public host is allowed. Entries are domains; subdomains match. */
  allow: string[];
  /** Always wins over `allow`. Entries are domains; subdomains match. */
  deny: string[];
  /** Ports allowed in URLs (the scheme's default port is always 80/443). */
  allowedPorts: number[];
}

/** Hostnames refused before any DNS lookup, whatever the configuration says. */
const IMPLICIT_DENY = ['localhost', 'localdomain', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'corp', 'metadata.google.internal'];

export const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443];

export function parseDomainList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, ''))
    .filter((d) => d.length > 0);
}

/** `FETCH_URL_ALLOWLIST`, `FETCH_URL_DENYLIST`, `FETCH_URL_ALLOWED_PORTS` (comma separated). */
export function hostPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): HostPolicy {
  const ports = parseDomainList(env.FETCH_URL_ALLOWED_PORTS)
    .map(Number)
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return {
    allow: parseDomainList(env.FETCH_URL_ALLOWLIST),
    deny: parseDomainList(env.FETCH_URL_DENYLIST),
    allowedPorts: ports.length > 0 ? ports : DEFAULT_ALLOWED_PORTS,
  };
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Checks a parsed URL against scheme, credentials, port and host policy. Does NOT
 * resolve DNS (the fetcher does that and checks every resolved address).
 */
export function checkUrl(url: URL, policy: HostPolicy): AddressVerdict {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} not allowed (only http/https)` };
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.allowedPorts.includes(port)) return { ok: false, reason: `port ${port} not allowed` };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'missing host' };
  const literal = host.replace(/^\[|\]$/g, '');
  if (isIP(literal.split('%')[0]!)) {
    const verdict = checkAddress(literal);
    if (!verdict.ok) return verdict;
  } else {
    if (!host.includes('.')) return { ok: false, reason: `single-label host ${host} not allowed` };
    const implicit = IMPLICIT_DENY.find((d) => hostMatches(host, d));
    if (implicit) return { ok: false, reason: `host ${host} is internal (${implicit})` };
  }
  const denied = policy.deny.find((d) => hostMatches(host, d));
  if (denied) return { ok: false, reason: `host ${host} is in the denylist (${denied})` };
  if (policy.allow.length > 0 && !policy.allow.some((d) => hostMatches(host, d))) {
    return { ok: false, reason: `host ${host} is not in the allowlist` };
  }
  return { ok: true };
}
