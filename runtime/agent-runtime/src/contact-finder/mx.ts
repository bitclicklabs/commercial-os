/**
 * Technical check of a candidate address (v1, decision of the PM): valid syntax (done when
 * the address is extracted) + the domain publishes MX records. NO SMTP probing: it gives
 * false negatives (catch-all servers, greylisting) and gets the sending IP flagged.
 */
import { Resolver } from 'node:dns/promises';

/** `ok`: MX records exist. `none`: the domain does not receive mail (NXDOMAIN / no MX). `error`: DNS failed (unknown). */
export type MxStatus = 'ok' | 'none' | 'error';

export type MxResolver = (domain: string) => Promise<MxStatus>;

const NONE_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

/** System DNS, 3 s per try, 2 tries. */
export function systemMxResolver(opts: { timeoutMs?: number; tries?: number } = {}): MxResolver {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? 3_000, tries: opts.tries ?? 2 });
  return async (domain) => {
    try {
      const records = await resolver.resolveMx(domain);
      return records.some((r) => r.exchange && r.exchange !== '.') ? 'ok' : 'none';
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      return NONE_CODES.has(code) ? 'none' : 'error';
    }
  };
}

/** Caches one answer per domain for the lifetime of the wrapper (one company search). */
export function cachedMx(resolver: MxResolver): MxResolver & { results: Map<string, MxStatus> } {
  const results = new Map<string, MxStatus>();
  const pending = new Map<string, Promise<MxStatus>>();
  const fn = (async (domain: string) => {
    const key = domain.toLowerCase();
    const known = results.get(key);
    if (known) return known;
    let p = pending.get(key);
    if (!p) {
      p = resolver(key).then((r) => {
        results.set(key, r);
        return r;
      });
      pending.set(key, p);
    }
    return p;
  }) as MxResolver & { results: Map<string, MxStatus> };
  fn.results = results;
  return fn;
}
