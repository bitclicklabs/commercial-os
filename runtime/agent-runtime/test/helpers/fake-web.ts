/**
 * Fake internet for `fetch_url` tests: a DNS table and a transport that serves canned
 * responses by URL. Nothing leaves the process.
 */
import type { FetchUrlDeps, ResolvedAddress, TransportRequest, TransportResponse } from '../../src/tools/web/fetch-url.js';

export interface FakePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Simulates a slow server (ms) honouring the abort signal. */
  delayMs?: number;
}

export class FakeWeb {
  readonly dns = new Map<string, string[]>();
  readonly pages = new Map<string, FakePage>();
  readonly requests: TransportRequest[] = [];
  /** Default address for hosts not in `dns` (a public IP). */
  defaultAddress: string | null = '93.184.216.34';

  host(name: string, ...addresses: string[]): this {
    this.dns.set(name, addresses);
    return this;
  }

  page(url: string, page: FakePage | string): this {
    this.pages.set(url, typeof page === 'string' ? { body: page, headers: { 'content-type': 'text/html; charset=utf-8' } } : page);
    return this;
  }

  redirect(from: string, to: string, status = 302): this {
    return this.page(from, { status, headers: { location: to } });
  }

  deps(extra: Partial<FetchUrlDeps> = {}): FetchUrlDeps {
    return {
      policy: { allow: [], deny: [], allowedPorts: [80, 443, 8080, 8443] },
      resolver: async (hostname) => {
        const list = this.dns.get(hostname) ?? (this.defaultAddress ? [this.defaultAddress] : []);
        if (list.length === 0) throw new Error(`ENOTFOUND ${hostname}`);
        return list.map((address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
      },
      transport: async (req): Promise<TransportResponse> => {
        this.requests.push(req);
        const p = this.pages.get(req.url.toString());
        if (p?.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, p.delayMs);
            req.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        }
        if (!p) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('not found'), truncated: false };
        const body = typeof p.body === 'string' ? Buffer.from(p.body, 'utf8') : (p.body ?? Buffer.alloc(0));
        return {
          status: p.status ?? 200,
          headers: { ...(p.headers ?? { 'content-type': 'text/html; charset=utf-8' }) },
          body: body.subarray(0, req.maxBytes),
          truncated: body.length > req.maxBytes,
        };
      },
      ...extra,
    };
  }
}
