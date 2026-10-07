/**
 * Egress of the renderer: the ONLY code that opens network connections on behalf of
 * the browser. Chromium never connects anywhere by itself: every request it makes is
 * intercepted (Playwright route) and served from here, and its own network stack is
 * pointed at a dead proxy as a second barrier.
 *
 * For every request (first navigation, subresources, XHR/fetch, every redirect hop):
 * - `checkUrl` (same rules as fetch_url: http/https only, no credentials, allowed
 *   ports, host allow/denylist, internal names, IP literals);
 * - DNS resolution where EVERY address must be public (`checkAddress`);
 * - the TCP connection is pinned to the checked address (no second lookup: no DNS
 *   rebinding between check and connect);
 * - per-response byte cap counted after decompression, timeout from the render deadline.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import zlib from 'node:zlib';
import { checkAddress, checkUrl, type HostPolicy } from './ip-guard.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to all its addresses (injectable for tests). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressRequest {
  url: URL;
  /** Already validated address the connection must use. */
  address: ResolvedAddress;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | null;
  maxBytes: number;
  signal: AbortSignal;
}

export interface EgressResponse {
  status: number;
  /** Lowercase names; multi-valued headers (set-cookie) joined with "\n". */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

/** One HTTP request without following redirects (injectable for tests). */
export type Transport = (req: EgressRequest) => Promise<EgressResponse>;

export interface EgressDeps {
  resolver: Resolver;
  transport: Transport;
  policy: HostPolicy;
}

export type TargetVerdict =
  | { ok: true; address: ResolvedAddress }
  | { ok: false; code: 'INVALID_URL' | 'URL_NOT_ALLOWED' | 'SSRF_BLOCKED' | 'DNS_ERROR'; reason: string };

export const systemResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/**
 * Validates one URL the way fetch_url does (URL rules + every resolved address public)
 * and returns the address the connection must be pinned to.
 */
export async function checkTarget(rawUrl: string | URL, deps: Pick<EgressDeps, 'resolver' | 'policy'>): Promise<TargetVerdict> {
  let url: URL;
  try {
    url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  } catch {
    return { ok: false, code: 'INVALID_URL', reason: 'URL could not be parsed' };
  }
  const verdict = checkUrl(url, deps.policy);
  if (!verdict.ok) return { ok: false, code: 'URL_NOT_ALLOWED', reason: verdict.reason };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await deps.resolver(host);
    } catch (err) {
      return { ok: false, code: 'DNS_ERROR', reason: `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (addresses.length === 0) return { ok: false, code: 'DNS_ERROR', reason: `no address for ${host}` };
  }
  for (const a of addresses) {
    const v = checkAddress(a.address);
    if (!v.ok) return { ok: false, code: 'SSRF_BLOCKED', reason: `${host} resolves to a non-public address (${v.reason})` };
  }
  return { ok: true, address: addresses[0]! };
}

function decompressor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

/** node:http(s) transport whose socket is pinned to `req.address`. Bodies are decompressed. */
export const nodeTransport: Transport = (req) =>
  new Promise<EgressResponse>((resolve, reject) => {
    const pinned: LookupFunction = (_hostname, options, callback) => {
      const cb = callback as unknown as (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
      if ((options as { all?: boolean }).all) cb(null, [{ address: req.address.address, family: req.address.family }]);
      else cb(null, req.address.address, req.address.family);
    };
    const lib = req.url.protocol === 'https:' ? https : http;
    const request = lib.request(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        lookup: pinned,
        signal: req.signal,
        agent: false,
        ...(req.url.protocol === 'https:' && !isIP(req.url.hostname) ? { servername: req.url.hostname } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join('\n') : v;
        }
        const inflate = req.method === 'HEAD' || status === 204 || status === 304 ? null : decompressor(headers['content-encoding']);
        const stream: NodeJS.ReadableStream = inflate ? res.pipe(inflate) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = (truncated: boolean) => {
          if (done) return;
          done = true;
          resolve({ status, headers, body: Buffer.concat(chunks).subarray(0, req.maxBytes), truncated });
        };
        stream.on('data', (chunk: Buffer) => {
          if (done) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size > req.maxBytes) {
            finish(true);
            res.destroy();
            inflate?.destroy();
          }
        });
        stream.on('end', () => finish(false));
        stream.on('error', (err) => (done ? undefined : reject(err)));
        res.on('error', (err) => (done ? undefined : reject(err)));
      },
    );
    request.on('error', reject);
    if (req.body && req.body.length > 0) request.write(req.body);
    request.end();
  });

/**
 * Request headers never forwarded from the browser (hop-by-hop or recomputed here).
 * `authorization` / `cookie` set by the PAGE are forwarded: they are the site's own
 * anonymous session (the context starts empty and the renderer has no credentials).
 */
const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'content-length', 'accept-encoding',
]);
/** Response headers removed before handing the body to the browser (already decoded, re-framed). */
const DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'strict-transport-security']);

export const RENDER_USER_AGENT_SUFFIX = 'PubliexpeCommercialOS/0.1';

export function forwardableRequestHeaders(headers: Record<string, string>, userAgent: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(name) || name.startsWith(':')) continue;
    // Header values must be ASCII (see fetch_url: non-ASCII UA -> WAF 403).
    if (!/^[\x20-\x7e\t]*$/.test(v)) continue;
    out[name] = v;
  }
  out['user-agent'] = userAgent;
  out['accept-encoding'] = 'gzip, deflate, br';
  return out;
}

export function deliverableResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!DROP_RESPONSE_HEADERS.has(k)) out[k] = v;
  return out;
}
