/**
 * Scout mode helpers for paginated exhibitor lists and exhibitor profiles (pure,
 * unit-tested). Nothing here calls a tool: `event-scout.ts` decides what to read.
 *
 * - `paginationLinks`: next pages of a list from its links (`?page=N`, `/page/N`,
 *   "Siguiente"/"Next"), same site only.
 * - `findProfileLink`: the link of a list whose text is the exhibitor's name (its
 *   profile, `/exhibitors/{id}`), on the list's own site.
 * - `extractProfileWebsite`: the exhibitor's website from its profile page: the value
 *   next to a "Web/Website/Sitio web" label, else the only external link, else the only
 *   `www.` domain in the text. Social networks are returned apart, as metadata; the
 *   fair's own domains and generic platforms are never a company domain.
 */
import { normalizeDomain } from '../integrations/twenty/index.js';
import { hostOf, normalizeUrl } from './source-ledger.js';

/** Lowercase, no accents, single spaces (same folding as the exhibitor-name checks). */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.&+-]+/gu, ' ')
    .trim();
}

/** Second-level labels under which companies register (example.com.es, example.co.uk). */
const SECOND_LEVEL = new Set(['com', 'org', 'net', 'edu', 'gob', 'gov', 'co', 'ac', 'nom']);

/** Registrable domain of a host (approximation without the public suffix list): `apps.feriavalencia.com` -> `feriavalencia.com`. */
export function registrableDomain(hostOrDomain: string): string {
  const labels = hostOrDomain.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const sld = labels[labels.length - 2]!;
  const tld = labels[labels.length - 1]!;
  const n = SECOND_LEVEL.has(sld) && tld.length === 2 ? 3 : 2;
  return labels.slice(-n).join('.');
}

export function sameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}

/** Social networks: kept as metadata of the exhibitor, never as its domain. */
export const SOCIAL_NETWORKS: Readonly<Record<string, string>> = {
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'instagram.com': 'instagram',
  'linkedin.com': 'linkedin',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'tiktok.com': 'tiktok',
  'pinterest.com': 'pinterest',
  'pinterest.es': 'pinterest',
};

/** Platforms, link shorteners and mail providers: never an exhibitor's own website. */
export const NON_COMPANY_DOMAINS: readonly string[] = [
  ...Object.keys(SOCIAL_NETWORKS),
  'google.com', 'google.es', 'goo.gl', 'g.page', 'bit.ly', 'tinyurl.com', 'linktr.ee', 'wa.me', 'whatsapp.com', 'flickr.com', 'vimeo.com',
  'apple.com', 'microsoft.com', 'gmail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es', 'live.com', 'icloud.com',
  'wordpress.com', 'wix.com', 'wixsite.com', 'blogspot.com', 'cookiebot.com', 'onetrust.com', 'googletagmanager.com',
];

export function socialNetworkOf(host: string): string | null {
  const d = registrableDomain(host);
  return SOCIAL_NETWORKS[d] ?? null;
}

/**
 * True when `domain` may NOT be written as a company domain: a social network, a generic
 * platform, or one of the fair's own sites (`fairDomains`: event website, catalog host...).
 */
export function isExcludedDomain(domain: string, fairDomains: Iterable<string>): boolean {
  const d = registrableDomain(domain);
  if (NON_COMPANY_DOMAINS.some((x) => d === x || domain === x || domain.endsWith(`.${x}`))) return true;
  for (const f of fairDomains) if (registrableDomain(f) === d) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const PAGE_PARAMS = /^(page|p|pag|pagina|página|pg|paged|pagenum|page_no|pageno|offset|start|from)$/i;
const OFFSET_PARAMS = /^(offset|start|from)$/i;
const NEXT_TEXT = /^(siguiente|next|next page|página siguiente|pagina siguiente|sig\.?|suivant|weiter|›|»|>|>>|→)$/i;

/**
 * Candidate URLs for the next page(s) of the list at `pageUrl`, best first: links of the
 * same site and path that only change a page-like query parameter (`?page=3`) or a
 * `/page/3` segment to a higher number, then links whose text is "Siguiente"/"Next".
 * `skip` filters URLs already read. Pure; unit-tested.
 */
export function paginationLinks(links: ReadonlyArray<{ url: string; text: string }>, pageUrl: string, skip: (url: string) => boolean = () => false): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const basePath = base.pathname.replace(/\/(?:page|pagina)\/\d+\/?$/i, '').replace(/\/+$/, '');
  const pathPage = Number(/\/(?:page|pagina)\/(\d+)\/?$/i.exec(base.pathname)?.[1] ?? 1);
  const numbered: Array<{ url: string; n: number }> = [];
  const byText: string[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }
    if (u.origin !== base.origin) continue;
    const key = normalizeUrl(u.toString());
    if (!key || key === normalizeUrl(base.toString()) || seen.has(key) || skip(u.toString())) continue;
    seen.add(key);
    // `/page/N` segment.
    const seg = /\/(?:page|pagina)\/(\d+)\/?$/i.exec(u.pathname);
    if (seg && u.pathname.replace(/\/(?:page|pagina)\/\d+\/?$/i, '').replace(/\/+$/, '') === basePath && Number(seg[1]) > pathPage) {
      numbered.push({ url: u.toString(), n: Number(seg[1]) });
      continue;
    }
    // Same path, only a page-like parameter differs.
    if (u.pathname.replace(/\/+$/, '') === base.pathname.replace(/\/+$/, '')) {
      const changed = [...new Set([...u.searchParams.keys(), ...base.searchParams.keys()])].filter((k) => u.searchParams.get(k) !== base.searchParams.get(k));
      if (changed.length === 1 && PAGE_PARAMS.test(changed[0]!)) {
        const k = changed[0]!;
        const v = Number(u.searchParams.get(k));
        const cur = Number(base.searchParams.get(k) ?? (OFFSET_PARAMS.test(k) ? 0 : 1));
        if (Number.isInteger(v) && v > cur) {
          numbered.push({ url: u.toString(), n: v });
          continue;
        }
      }
    }
    if (NEXT_TEXT.test(l.text.trim())) byText.push(u.toString());
  }
  numbered.sort((a, b) => a.n - b.n);
  return [...new Set([...numbered.map((x) => x.url), ...byText])];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * The exhibitor's profile on the list's site: a link whose text is exactly the name
 * (folded), on the same registrable domain as the list and not the list itself.
 */
export function findProfileLink(name: string, page: { finalUrl: string; links: ReadonlyArray<{ url: string; text: string }> }): string | null {
  const want = foldName(name);
  const listHost = hostOf(page.finalUrl);
  if (want.length < 2 || !listHost) return null;
  const self = normalizeUrl(page.finalUrl);
  for (const l of page.links) {
    if (foldName(l.text) !== want) continue;
    const host = hostOf(l.url);
    if (!host || !sameSite(host, listHost)) continue;
    if (normalizeUrl(l.url) === self) continue;
    return l.url;
  }
  return null;
}

/** Headings after which a profile lists OTHER companies ("Empresas similares"...). */
const OTHERS_SECTION = /^(empresas similares|expositores similares|similar (companies|exhibitors)|otros expositores|expositores relacionados|related exhibitors|tambi[eé]n te puede interesar)/im;

/** The part of a profile page about the exhibitor itself (cut before "Empresas similares"...). */
export function profileMainText(text: string): string {
  const m = OTHERS_SECTION.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/** True when the profile (main part) is about this exhibitor: its folded name is there. */
export function profileMatchesExhibitor(name: string, text: string): boolean {
  const want = foldName(name);
  return want.length >= 2 && foldName(profileMainText(text)).includes(want);
}

const WEB_LABEL = /^(?:website|web site|sitio web|p[aá]gina web|web oficial|homepage|internet|web|url|site)(?![\p{L}\p{N}])\s*:?\s*(.*)$/iu;
const DOMAIN_TOKEN = /(?<![@\w.-])(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=[\s/,;:)"'?#]|$)/gi;

function domainsInText(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(DOMAIN_TOKEN)) {
    const d = normalizeDomain(m[1]);
    if (d && !/\.(png|jpe?g|gif|svg|webp|pdf|php|html?|aspx?)$/i.test(d)) out.push(d);
  }
  return out;
}

export interface ProfileWebsite {
  domain: string | null;
  /** How it was found: `label` (next to "Web/Website"), `single_link` (only external link), `text` (only www. domain in the text). */
  source: 'label' | 'single_link' | 'text' | null;
  /** Social network pages of the exhibitor (metadata only). */
  social: Record<string, string>;
  /** Distinct candidate domains seen (for the trace when ambiguous). */
  candidates: string[];
  /** Candidate domains refused (fair, social, platform). */
  excluded: string[];
}

/**
 * The exhibitor's website from its profile page. `fairDomains`: the fair's own sites
 * (never a company domain). Pure; unit-tested.
 */
export function extractProfileWebsite(page: { finalUrl: string; text: string; links: ReadonlyArray<{ url: string; text: string }> }, fairDomains: Iterable<string>): ProfileWebsite {
  const fair = [...fairDomains, hostOf(page.finalUrl) ?? ''].filter(Boolean);
  const main = profileMainText(page.text);
  const social: Record<string, string> = {};
  const excluded = new Set<string>();
  const ok = (d: string | null): d is string => {
    if (!d) return false;
    if (isExcludedDomain(d, fair)) {
      excluded.add(d);
      return false;
    }
    return true;
  };

  // External links (social networks apart).
  const external = new Map<string, { url: string; text: string }>();
  for (const l of page.links) {
    const host = hostOf(l.url);
    if (!host) continue;
    const net = socialNetworkOf(host);
    if (net) {
      social[net] ??= l.url;
      continue;
    }
    const d = normalizeDomain(host);
    if (!ok(d)) continue;
    const key = registrableDomain(d);
    if (!external.has(key)) external.set(key, { url: l.url, text: l.text });
  }

  // 1. The value next to a "Web / Website / Sitio web" label (same line or the next non-empty one).
  const lines = main.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = WEB_LABEL.exec(lines[i]!);
    if (!m) continue;
    const value = m[1] || lines.slice(i + 1).find((l) => l.length > 0) || '';
    const d = domainsInText(value).find(ok);
    if (d) return { domain: d, source: 'label', social, candidates: [d], excluded: [...excluded] };
  }

  // 2. The only external (non-social, non-fair) link of the page.
  const candidates = [...external.keys()];
  if (candidates.length === 1) {
    const d = normalizeDomain(hostOf(external.get(candidates[0]!)!.url));
    if (d) return { domain: d, source: 'single_link', social, candidates, excluded: [...excluded] };
  }

  // 3. The only www. domain written in the profile text.
  const inText = [...new Set(domainsInText(main.replace(/\S+@\S+/g, ' ')).filter((d) => main.toLowerCase().includes(`www.${d}`)).filter(ok))];
  if (inText.length === 1 && candidates.length === 0) return { domain: inText[0]!, source: 'text', social, candidates: inText, excluded: [...excluded] };

  return { domain: null, source: null, social, candidates: [...new Set([...candidates, ...inText])], excluded: [...excluded] };
}
