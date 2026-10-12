/**
 * ContactFinder core: given (company, domain), finds the addresses the company itself
 * publishes, classifies them, verifies them and picks one, deterministically.
 *
 * Phase 1 (always): the home page + the usual pages (`/contacto`, `/contact`, `/aviso-legal`,
 * `/legal`, `/equipo`, `/about`, `/empresa`, `/quienes-somos`) and the links of the home page
 * whose path or text matches those words. At most `maxFetches` (6) requests and a short time
 * budget (25 s) per company; `render_url` only when the fetched HTML is a JavaScript shell
 * without useful text. Every request goes through the same egress guard as `fetch_url`
 * (public IPs only, pinned connection, host allow/deny lists).
 *
 * Phase 2 (only when asked: VALIDATED hypothesis still without an address): the enrichment
 * provider (`enrich/`), same filters, and an address below confidence 0.7 is only listed.
 *
 * Filters: never `noreply@`/`dpo@`/`rgpd@`/`privacy@`/`baja@`...; never an address in the
 * suppression list ("Lista de supresión — NO contactar"; when the list cannot be read
 * nothing is chosen: fail closed); never an address outside the company domain (listed
 * as tier 5); never an address whose domain publishes no MX record.
 *
 * Nothing here writes anywhere and nothing is invented: every candidate carries the exact
 * URL(s) where it was published (or the provider that returned it).
 */
import type { SuppressionList } from '../inbound/suppression-list.js';
import { emailDomain } from '../inbound/unsubscribe-classifier.js';
import { suppressionMatch } from '../email-ops/recipients.js';
import { registrableDomain } from '../agents/exhibitor-profile.js';
import { fetchPublicUrl, type FetchUrlDeps } from '../tools/web/fetch-url.js';
import { renderPublicUrl, type RenderUrlDeps } from '../tools/web/render-url.js';
import { classifyCandidate, fold, neverReason, type ContactTier, type RoleKind, TIER_LABELS } from './classify.js';
import { extractFromPage, type ExtractVia } from './extract.js';
import { cachedMx, systemMxResolver, type MxResolver, type MxStatus } from './mx.js';
import { ENRICH_MIN_CONFIDENCE, type EnrichCandidate, type EnrichOutcome } from './enrich/types.js';
import type { EnrichService } from './enrich/index.js';

export const CONTACT_MAX_FETCHES = 6;
export const CONTACT_BUDGET_MS = 25_000;
export const CONTACT_FETCH_TIMEOUT_MS = 8_000;

/** Usual paths, in the order they are tried when the home page does not link them. */
export const CANDIDATE_PATHS = ['/contacto', '/contact', '/aviso-legal', '/legal', '/equipo', '/quienes-somos', '/about', '/empresa'] as const;

/** Keyword groups for links of the home page (folded path or text), in priority order. */
const LINK_GROUPS: Array<{ group: string; re: RegExp }> = [
  { group: 'contact', re: /\b(contacto|contact|contacta|contactanos|contactenos|contactar|contact-us)\b/ },
  { group: 'team', re: /\b(equipo|team|nuestro-equipo|nuestro equipo|people)\b/ },
  { group: 'legal', re: /\b(aviso-legal|aviso legal|avisolegal|aviso_legal|nota-legal|legal|informacion-legal|legal-notice)\b/ },
  { group: 'about', re: /\b(quienes-somos|quienes somos|quienes_somos|sobre-nosotros|sobre nosotros|nosotros|about|about-us|empresa|company|la-empresa)\b/ },
];

/** Reserved test TLDs / domains (RFC 2606, RFC 6761): never fetched unless the caller allows it (tests). */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return /\.(example|test|invalid|localhost|local)$/.test(d) || /^(example\.(com|net|org)|localhost)$/.test(d);
}

export interface PageFetchOk {
  ok: true;
  url: string;
  finalUrl: string;
  method: 'fetch' | 'render';
  html: string | null;
  text: string;
  links: Array<{ url: string; text: string }>;
  jsAppLikely: boolean;
}
export interface PageFetchError {
  ok: false;
  url: string;
  method: 'fetch' | 'render';
  code: string;
  message: string;
}
export type PageFetch = PageFetchOk | PageFetchError;

export interface ContactFinderDeps {
  /** Egress deps of `fetch_url` (resolver, transport, host policy). */
  web?: FetchUrlDeps;
  /** Renderer deps of `render_url`. */
  render?: RenderUrlDeps;
  mx?: MxResolver;
  /** Phase 2 service; null/undefined = no enrichment available. */
  enrich?: EnrichService | null;
  now?: () => Date;
  budgetMs?: number;
  fetchTimeoutMs?: number;
  maxFetches?: number;
  /** Tests only: allow fetching reserved test domains (`*.example`). */
  allowReservedDomains?: boolean;
}

export interface CandidateSource {
  url: string;
  via: ExtractVia | 'enrich';
}

export interface ContactCandidate {
  email: string;
  name: string | null;
  jobTitle: string | null;
  tier: ContactTier;
  subrank: number;
  label: string;
  roleKind: RoleKind | null;
  onDomain: boolean;
  mx: MxStatus | 'not_checked';
  /** `web` = published by the company; otherwise the enrichment provider (`hunter`, `stub`). */
  origin: string;
  /** Provider confidence 0-1 (enrichment only). */
  confidence: number | null;
  sources: CandidateSource[];
  /** Text around the address on the page (untrusted, max 300 chars). */
  context: string | null;
  /** Order of discovery (tie-break). */
  order: number;
}

export interface DiscardedCandidate {
  email: string;
  reason: string;
  origin: string;
  sources: CandidateSource[];
}

export interface PageReport {
  url: string;
  finalUrl: string | null;
  method: 'fetch' | 'render';
  status: 'ok' | 'error';
  code: string | null;
  emails: number;
}

export interface ChosenContact {
  email: string;
  reason: string;
  origin: string;
  sourceUrl: string | null;
}

export interface FinderResult {
  companyName: string;
  domain: string;
  searchedAt: string;
  pages: PageReport[];
  candidates: ContactCandidate[];
  discarded: DiscardedCandidate[];
  chosen: ChosenContact | null;
  /** Equally ranked candidates the deterministic rules cannot separate (input of the LLM tie-break). */
  tie: string[];
  /** Why nothing was chosen (null when something was). */
  noChoiceReason: string | null;
  suppressionChecked: boolean;
  mx: Record<string, MxStatus>;
  enrich: { status: 'not_asked' | 'not_needed' | 'unavailable' | EnrichOutcome['status']; provider: string | null; lookupsToday: number | null; cap: number | null; costEur: number; message: string | null };
  budgetExhausted: boolean;
}

export interface FinderInput {
  companyName: string;
  domain: string;
  /** Phase 2 allowed (VALIDATED hypothesis). */
  allowEnrich: boolean;
  /** null = the list could not be read: nothing is chosen (fail closed). */
  suppression: SuppressionList | null;
}

function onCompanyDomain(email: string, domain: string): boolean {
  const d = emailDomain(email);
  const base = registrableDomain(domain);
  return d === domain || d.endsWith(`.${domain}`) || d === base || d.endsWith(`.${base}`);
}

function sameSite(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return registrableDomain(host) === registrableDomain(domain);
  } catch {
    return false;
  }
}

/** Links of the home page worth reading, by keyword group priority (same site only). */
export function candidateLinks(links: ReadonlyArray<{ url: string; text: string }>, domain: string): string[] {
  const scored: Array<{ url: string; score: number; order: number }> = [];
  const seen = new Set<string>();
  links.forEach((l, order) => {
    if (!sameSite(l.url, domain)) return;
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      return;
    }
    if (u.pathname === '/' || /\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(u.pathname)) return;
    u.hash = '';
    const key = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (seen.has(key)) return;
    const haystack = `${fold(decodeURIComponent(u.pathname).replace(/[/_]+/g, ' '))} ${fold(l.text)}`;
    const idx = LINK_GROUPS.findIndex((g) => g.re.test(haystack));
    if (idx < 0) return;
    // Privacy / cookies pages only ever add dpo@ addresses.
    if (/\b(privacidad|privacy|cookies|proteccion de datos)\b/.test(haystack)) return;
    seen.add(key);
    scored.push({ url: u.toString(), score: idx, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.url);
}

function pathKey(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').toLowerCase() || '/';
  } catch {
    return url;
  }
}

/** Ranking: tier, subrank, more pages that publish it, provider confidence, discovery order. */
function compare(a: ContactCandidate, b: ContactCandidate): number {
  return a.tier - b.tier || a.subrank - b.subrank || b.sources.length - a.sources.length || (b.confidence ?? 0) - (a.confidence ?? 0) || a.order - b.order;
}

function eligible(c: ContactCandidate): boolean {
  if (c.tier > 4 || !c.onDomain || c.mx !== 'ok') return false;
  if (c.origin !== 'web' && (c.confidence ?? 0) < ENRICH_MIN_CONFIDENCE) return false;
  return true;
}

function chooseReason(c: ContactCandidate): string {
  const who = c.tier === 1 ? `${TIER_LABELS[1]} (${c.roleKind})` : c.label;
  if (c.origin === 'web') return `${who}, publicada por la propia empresa en su web`;
  return `${who}, dato del proveedor ${c.origin} con confianza ${(c.confidence ?? 0).toFixed(2)} (umbral ${ENRICH_MIN_CONFIDENCE.toFixed(2)})`;
}

export class ContactFinder {
  constructor(private readonly deps: ContactFinderDeps = {}) {}

  private async fetchPage(url: string, signal: AbortSignal): Promise<PageFetch> {
    const web: FetchUrlDeps = { ...(this.deps.web ?? {}), timeoutMs: this.deps.fetchTimeoutMs ?? CONTACT_FETCH_TIMEOUT_MS };
    try {
      const r = await fetchPublicUrl(url, web, signal, undefined, { keepHtml: true });
      if (r.status !== 'ok') return { ok: false, url, method: 'fetch', code: r.status === 'error' ? r.code : 'FETCH_FAILED', message: r.status === 'error' ? r.message : '' };
      const o = r.output;
      if (o.content_kind === 'pdf') return { ok: false, url, method: 'fetch', code: 'NOT_HTML', message: 'PDF' };
      return { ok: true, url, finalUrl: o.finalUrl, method: 'fetch', html: o.html ?? null, text: o.text, links: o.links, jsAppLikely: o.js_app_likely };
    } catch (err) {
      return { ok: false, url, method: 'fetch', code: signal.aborted ? 'BUDGET_EXHAUSTED' : 'FETCH_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async renderPage(url: string, signal: AbortSignal): Promise<PageFetch> {
    try {
      const r = await renderPublicUrl(url, this.deps.render ?? {}, signal, { minTextChars: 200 });
      if (r.status !== 'ok') return { ok: false, url, method: 'render', code: r.status === 'error' ? r.code : 'RENDER_FAILED', message: r.status === 'error' ? r.message : '' };
      return { ok: true, url, finalUrl: r.output.finalUrl, method: 'render', html: null, text: r.output.text, links: r.output.links, jsAppLikely: false };
    } catch (err) {
      return { ok: false, url, method: 'render', code: signal.aborted ? 'BUDGET_EXHAUSTED' : 'RENDER_ERROR', message: err instanceof Error ? err.message : String(err) };
    }
  }

  async find(input: FinderInput, signal: AbortSignal): Promise<FinderResult> {
    const domain = input.domain.toLowerCase().replace(/^www\./, '');
    const maxFetches = this.deps.maxFetches ?? CONTACT_MAX_FETCHES;
    const budget = AbortSignal.any([signal, AbortSignal.timeout(this.deps.budgetMs ?? CONTACT_BUDGET_MS)]);
    const mx = cachedMx(this.deps.mx ?? systemMxResolver());
    const now = this.deps.now ?? (() => new Date());
    const pages: PageReport[] = [];
    const byEmail = new Map<string, ContactCandidate>();
    const discarded = new Map<string, DiscardedCandidate>();
    let order = 0;
    let fetches = 0;

    const result = (extra: Partial<FinderResult>): FinderResult => ({
      companyName: input.companyName,
      domain,
      searchedAt: now().toISOString(),
      pages,
      candidates: [],
      discarded: [...discarded.values()],
      chosen: null,
      tie: [],
      noChoiceReason: null,
      suppressionChecked: input.suppression !== null,
      mx: Object.fromEntries(mx.results),
      enrich: { status: 'not_asked', provider: null, lookupsToday: null, cap: null, costEur: 0, message: null },
      budgetExhausted: budget.aborted && !signal.aborted,
      ...extra,
    });

    const addOccurrences = (page: PageFetchOk) => {
      const occ = extractFromPage({ url: page.finalUrl, html: page.html, text: page.text }, { exclude: [input.companyName] });
      for (const o of occ) {
        const source: CandidateSource = { url: page.finalUrl, via: o.via };
        const never = neverReason(o.email);
        if (never) {
          const d = discarded.get(o.email) ?? { email: o.email, reason: never, origin: 'web', sources: [] };
          if (!d.sources.some((s) => s.url === source.url)) d.sources.push(source);
          discarded.set(o.email, d);
          continue;
        }
        const prev = byEmail.get(o.email);
        if (prev) {
          if (!prev.sources.some((s) => s.url === source.url)) prev.sources.push(source);
          prev.name ??= o.name;
          prev.jobTitle ??= o.jobTitle;
          prev.context ??= o.context;
          continue;
        }
        byEmail.set(o.email, {
          email: o.email,
          name: o.name,
          jobTitle: o.jobTitle,
          tier: 4,
          subrank: 0,
          label: '',
          roleKind: null,
          onDomain: onCompanyDomain(o.email, domain),
          mx: 'not_checked',
          origin: 'web',
          confidence: null,
          sources: [source],
          context: o.context,
          order: order++,
        });
      }
      return occ.length;
    };

    // Early stop: a person with a relevant title on the company domain (and not suppressed) is already the best possible answer.
    const hasTopCandidate = () =>
      [...byEmail.values()].some(
        (c) =>
          c.onDomain &&
          !(input.suppression && suppressionMatch(c.email, input.suppression)) &&
          classifyCandidate(c.email, { onDomain: true, jobTitle: c.jobTitle, hasName: c.name !== null }).tier === 1,
      );

    const visit = async (url: string, method: 'fetch' | 'render'): Promise<PageFetchOk | null> => {
      if (fetches >= maxFetches || budget.aborted) return null;
      fetches += 1;
      const page = method === 'fetch' ? await this.fetchPage(url, budget) : await this.renderPage(url, budget);
      if (!page.ok) {
        pages.push({ url, finalUrl: null, method, status: 'error', code: page.code, emails: 0 });
        return null;
      }
      const n = addOccurrences(page);
      pages.push({ url, finalUrl: page.finalUrl, method, status: 'ok', code: null, emails: n });
      return page;
    };

    // ---- Phase 1: the company's own pages ----
    if (isReservedDomain(domain) && !this.deps.allowReservedDomains) {
      return this.finish(result({ noChoiceReason: 'dominio reservado de pruebas: no se consulta la web' }), byEmail, discarded, input, mx, signal, budget, now);
    }
    let home = await visit(`https://${domain}/`, 'fetch');
    if (!home && pages[0]?.code && /DNS|NETWORK|TIMEOUT|HTTP_ERROR|SSRF|TLS|CERT/i.test(pages[0].code)) {
      home = await visit(`https://www.${domain}/`, 'fetch');
    }
    const usefulText = (p: PageFetchOk | null) => p !== null && p.text.replace(/\s+/g, ' ').trim().length >= 200;
    if (home && (home.jsAppLikely || !usefulText(home))) {
      const rendered = await visit(home.finalUrl, 'render');
      if (rendered && rendered.links.length > home.links.length) home = { ...home, links: rendered.links };
    }
    const base = home ? new URL(home.finalUrl).origin : `https://${domain}`;
    const queue: string[] = [];
    const queued = new Set<string>(['/']);
    for (const u of home ? candidateLinks(home.links, domain) : []) {
      const k = pathKey(u);
      if (!queued.has(k)) {
        queued.add(k);
        queue.push(u);
      }
    }
    for (const p of CANDIDATE_PATHS) {
      if (!queued.has(p)) {
        queued.add(p);
        queue.push(`${base}${p}`);
      }
    }
    for (const url of queue) {
      if (fetches >= maxFetches || budget.aborted) break;
      if (hasTopCandidate()) break;
      const page = await visit(url, 'fetch');
      if (page && page.jsAppLikely && !usefulText(page)) await visit(page.finalUrl, 'render');
    }
    return this.finish(result({}), byEmail, discarded, input, mx, signal, budget, now);
  }

  /** Classification, filters, MX, choice; phase 2 when allowed and needed. */
  private async finish(
    base: FinderResult,
    byEmail: Map<string, ContactCandidate>,
    discarded: Map<string, DiscardedCandidate>,
    input: FinderInput,
    mx: ReturnType<typeof cachedMx>,
    signal: AbortSignal,
    budget: AbortSignal,
    now: () => Date,
  ): Promise<FinderResult> {
    const domain = base.domain;
    const pool = [...byEmail.values()];
    const evaluate = async (cands: ContactCandidate[]) => {
      const kept: ContactCandidate[] = [];
      for (const c of cands) {
        const cls = classifyCandidate(c.email, { onDomain: c.onDomain, jobTitle: c.jobTitle, hasName: c.name !== null });
        Object.assign(c, { tier: cls.tier, subrank: cls.subrank, label: cls.label, roleKind: cls.roleKind });
        const suppressed = input.suppression ? suppressionMatch(c.email, input.suppression) : null;
        if (suppressed) {
          discarded.set(c.email, { email: c.email, reason: `en la lista de supresión (${suppressed.entry})`, origin: c.origin, sources: c.sources });
          continue;
        }
        if (c.onDomain) {
          // MX of the address's own domain; DNS is not part of the time budget (3 s x 2 tries max).
          c.mx = await mx(emailDomain(c.email));
        }
        kept.push(c);
      }
      return kept.sort(compare);
    };

    let candidates = await evaluate(pool);
    let enrich = base.enrich;
    const pick = (list: ContactCandidate[]) => {
      if (!input.suppression) return { chosen: null, tie: [] as string[] };
      const ok = list.filter(eligible);
      const top = ok[0];
      if (!top) return { chosen: null, tie: [] as string[] };
      const tie = ok.filter((c) => c.tier === top.tier && c.subrank === top.subrank && c.sources.length === top.sources.length && (top.tier === 1 || top.tier === 4) && c.origin === top.origin);
      return { chosen: top, tie: tie.length > 1 ? tie.slice(0, 5).map((c) => c.email) : [] };
    };
    let { chosen, tie } = pick(candidates);

    // ---- Phase 2: enrichment, only for the gaps ----
    if (!chosen && input.suppression) {
      if (!input.allowEnrich) enrich = { ...enrich, status: 'not_asked' };
      else if (!this.deps.enrich) enrich = { ...enrich, status: 'unavailable', message: 'sin proveedor de enriquecimiento' };
      else {
        // Own short budget: phase 1 may have used all of its time.
        const outcome = await this.deps.enrich.lookup(domain, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
        enrich = {
          status: outcome.status,
          provider: outcome.provider,
          lookupsToday: outcome.lookupsToday,
          cap: outcome.cap,
          costEur: outcome.status === 'ok' ? outcome.costEur : 0,
          message: outcome.status === 'error' ? `${outcome.code}: ${outcome.message}` : outcome.status === 'cap_reached' ? 'tope diario de consultas alcanzado' : null,
        };
        if (outcome.status === 'ok') {
          const extra: ContactCandidate[] = [];
          let order = pool.length;
          for (const e of outcome.candidates) {
            const email = e.email.toLowerCase();
            if (byEmail.has(email) || extra.some((x) => x.email === email)) continue;
            const never = neverReason(email);
            const sources: CandidateSource[] = (e.sources.length > 0 ? e.sources : [`https://${domain}/`]).map((url) => ({ url, via: 'enrich' as const }));
            if (never) {
              discarded.set(email, { email, reason: never, origin: outcome.provider, sources });
              continue;
            }
            extra.push(enrichedCandidate(e, outcome.provider, domain, sources, order++));
          }
          candidates = [...candidates, ...(await evaluate(extra))].sort(compare);
          ({ chosen, tie } = pick(candidates));
        }
      }
    } else if (chosen) {
      enrich = { ...enrich, status: input.allowEnrich ? 'not_needed' : 'not_asked' };
    }

    let noChoiceReason = base.noChoiceReason;
    if (!chosen && !noChoiceReason) {
      if (!input.suppression) noChoiceReason = 'no se pudo leer la lista de supresión: no se propone ninguna dirección';
      else if (candidates.length === 0) noChoiceReason = 'la empresa no publica ninguna dirección utilizable en su web';
      else if (candidates.every((c) => !c.onDomain)) noChoiceReason = 'solo hay direcciones fuera del dominio de la empresa';
      else if (candidates.some((c) => c.onDomain && c.mx !== 'ok')) noChoiceReason = 'el dominio de las direcciones no tiene registros MX verificables';
      else noChoiceReason = `ninguna dirección supera los filtros (las del proveedor necesitan confianza ≥ ${ENRICH_MIN_CONFIDENCE.toFixed(2)})`;
    }
    return {
      ...base,
      searchedAt: now().toISOString(),
      candidates,
      discarded: [...discarded.values()],
      chosen: chosen ? { email: chosen.email, reason: chooseReason(chosen), origin: chosen.origin, sourceUrl: chosen.sources[0]?.url ?? null } : null,
      tie,
      noChoiceReason: chosen ? null : noChoiceReason,
      mx: Object.fromEntries(mx.results),
      enrich,
      budgetExhausted: base.budgetExhausted || (budget.aborted && !signal.aborted),
    };
  }
}

function enrichedCandidate(e: EnrichCandidate, provider: string, domain: string, sources: CandidateSource[], order: number): ContactCandidate {
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || null;
  return {
    email: e.email.toLowerCase(),
    name,
    jobTitle: e.position ?? (e.department ? `departamento: ${e.department}` : null),
    tier: 4,
    subrank: 0,
    label: '',
    roleKind: null,
    onDomain: onCompanyDomain(e.email.toLowerCase(), domain),
    mx: 'not_checked',
    origin: provider,
    confidence: e.confidence,
    sources,
    context: null,
    order,
  };
}
