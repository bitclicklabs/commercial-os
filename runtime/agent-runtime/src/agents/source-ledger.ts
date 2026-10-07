/**
 * Registry of the web sources a run has really seen (LLD v0.2 §10.4.4 and §10.4.8).
 *
 * Two kinds of source:
 * - `grounded`: URLs returned by Gemini grounding (`groundingChunks[].web.uri`) and
 *   the domains they belong to;
 * - `visited`: URLs `fetch_url` downloaded successfully (requested URL, redirects and
 *   final URL).
 *
 * Any `source_url` the agent writes to Twenty must be a known source; URLs proposed by
 * the model are only fetched when their domain is grounded (or they come from the
 * links of a page already visited), and free text is scrubbed of unknown URLs.
 */
import type { GroundingSource } from '../providers/model-provider.js';

export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  let s = url.toString();
  if (url.pathname.length > 1 && s.endsWith('/') && !url.search) s = s.slice(0, -1);
  return s;
}

/** Lower-case host without `www.`; null for non-http(s) or unparseable URLs. */
export function hostOf(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return null;
  }
}

function sameSite(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
}

export class SourceLedger {
  private readonly visited = new Set<string>();
  private readonly grounded = new Map<string, GroundingSource>();
  private readonly groundedDomains = new Set<string>();

  addGrounding(sources: readonly GroundingSource[]): void {
    for (const s of sources) {
      const key = normalizeUrl(s.uri);
      if (!key) continue;
      this.grounded.set(key, s);
      if (s.domain) this.groundedDomains.add(s.domain.toLowerCase().replace(/^www\./, ''));
    }
  }

  /** A grounding redirect resolved by fetch_url: its final domain becomes grounded. */
  addGroundedDomainFromUrl(url: string): void {
    const host = hostOf(url);
    if (host) this.groundedDomains.add(host);
  }

  addVisited(...urls: string[]): void {
    for (const u of urls) {
      const key = normalizeUrl(u);
      if (key) this.visited.add(key);
    }
  }

  isVisited(url: string): boolean {
    const key = normalizeUrl(url);
    return key !== null && this.visited.has(key);
  }

  isGroundedUri(url: string): boolean {
    const key = normalizeUrl(url);
    return key !== null && this.grounded.has(key);
  }

  /** The URL's host belongs to (or contains) a domain returned by grounding. */
  isGroundedDomain(url: string): boolean {
    const host = hostOf(url);
    if (!host) return false;
    for (const d of this.groundedDomains) if (sameSite(host, d)) return true;
    return false;
  }

  /** May be written to Twenty as `sourceUrl`. */
  isKnownSource(url: string): boolean {
    return this.isVisited(url) || this.isGroundedUri(url);
  }

  groundingSources(): GroundingSource[] {
    return [...this.grounded.values()];
  }

  /** Grounding sources whose domain is unknown (only a redirect URI). */
  sourcesWithoutDomain(): GroundingSource[] {
    return this.groundingSources().filter((s) => !s.domain);
  }

  snapshot(): { visited: string[]; grounded: Array<{ uri: string; title: string | null; domain: string | null }>; grounded_domains: string[] } {
    return { visited: [...this.visited], grounded: this.groundingSources(), grounded_domains: [...this.groundedDomains] };
  }
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'()\[\]{}]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'()\[\]{}]*/gi;

/**
 * Replaces URLs that are not known sources of the run (LLD v0.2 §10.4.4: free text may
 * not carry URLs foreign to the registered sources).
 */
export function scrubUnknownUrls(text: string, ledger: SourceLedger): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trimmed = match.replace(/[.,;:!?]+$/, '');
    const tail = match.slice(trimmed.length);
    const candidate = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
    return ledger.isKnownSource(candidate) ? match : `[enlace omitido]${tail}`;
  });
}
