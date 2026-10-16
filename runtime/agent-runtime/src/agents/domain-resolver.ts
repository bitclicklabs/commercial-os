/**
 * Domain resolver of the Prospector (tanda 20): name -> verified official website.
 *
 * Fair catalogs list many exhibitors BY NAME only. Without a domain there is no company,
 * no ContactFinder and no lead (`skipped_no_domain`). For a RELEVANT exhibitor (the LLM
 * decision already said so) without a domain, after its catalog profile (scout mode), the
 * Prospector tries to resolve its website BEFORE dropping it:
 *
 *  1. Twenty first: an exact-name company of the tenant is reused (no search, no cost).
 *  2. One grounded search (the same Google Search grounding as the scout, its cost counted in
 *     the run). The query carries the name and, when known, the fair's place. The exhibitor
 *     name is web data: it reaches the model only inside a DATOS_NO_CONFIABLES block.
 *  3. Candidates = domains of the GROUNDING SOURCES (redirect URIs resolved to their final
 *     domain first: by the chunk title when it is a domain, else by fetch_url, which follows the
 *     3xx). Only when the search ran but returned no usable source (Gemini sometimes runs the
 *     tool and sends no groundingMetadata) the site the model proposed is a candidate too
 *     (`search_unsourced`), like the scout's `verify_unsourced_by_fetch`; minus a hard denylist (social networks, marketplaces,
 *     directories, press, encyclopedias, fair aggregators, generic platforms) and the fair's
 *     own sites.
 *  4. Deterministic verification, no LLM judgement: a candidate is accepted only when its
 *     domain label matches the normalised company name AND its home page (or its legal
 *     notice, linked from the home) corroborates the brand in the title or text. Every page
 *     goes through `fetch_url` (SSRF guard, public IPs only); `render_url` only when the home
 *     HTML is a JavaScript shell.
 *  5. Exactly one verified domain -> `domain_resolved` (with the URL that corroborated it).
 *     Two or more, or a name match whose page does not corroborate the brand ->
 *     `domain_ambiguous` (the candidates are listed for a human). Nothing -> `domain_not_found`.
 *     Neither is a veto: a later run tries again.
 *
 * Budget: `DOMAIN_RESOLVER_MAX_PER_RUN` searches per run (default 25, cap 50) and at most
 * `DOMAIN_RESOLVER_PAGES_PER_LOOKUP` page reads per search. When the budget is spent the rest
 * stay `skipped_no_domain` (catalog order) and come back in a later run.
 */
import { normalizeDomain } from '../integrations/twenty/index.js';
import type { GroundingSource } from '../providers/model-provider.js';
import { toolError, type ExhibitorInput, type Parsed, type ProspectorRun } from './prospector-core.js';
import { isExcludedDomain, registrableDomain } from './exhibitor-profile.js';
import { hostOf } from './source-ledger.js';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from './untrusted.js';

// ---------------------------------------------------------------------------
// Configuration (env)
// ---------------------------------------------------------------------------

export const DEFAULT_DOMAIN_RESOLVER_MAX_PER_RUN = 25;
/** Hard cap of `DOMAIN_RESOLVER_MAX_PER_RUN` (the fetch_url tool budget of the agent version is sized for it). */
export const DOMAIN_RESOLVER_MAX_PER_RUN_CAP = 50;
/** fetch_url / render_url calls of one resolution (redirects of grounding, homes, legal notices). */
export const DOMAIN_RESOLVER_PAGES_PER_LOOKUP = 4;
/** Name-matching candidates verified per resolution (best first). */
export const DOMAIN_RESOLVER_MAX_CANDIDATES = 3;
/** Characters read of each home / legal page (the brand is in the title, the header or the footer). */
const PAGE_MAX_CHARS = 20_000;
/** Below this many characters a JavaScript shell is rendered (same criterion as the scout / contact-finder). */
const EMPTY_SHELL_CHARS = 200;

export interface DomainResolverConfig {
  enabled: boolean;
  /** Searches per run. 0 = never search. */
  maxPerRun: number;
}

/** `DOMAIN_RESOLVER_ENABLED` (default true; `false`/`0`/`off`/`no` switch it off) and `DOMAIN_RESOLVER_MAX_PER_RUN` (default 25, 0..50). */
export function domainResolverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DomainResolverConfig {
  const flag = (env.DOMAIN_RESOLVER_ENABLED ?? '').trim().toLowerCase();
  const enabled = !['false', '0', 'off', 'no'].includes(flag);
  const raw = (env.DOMAIN_RESOLVER_MAX_PER_RUN ?? '').trim();
  const n = Number(raw);
  const maxPerRun = raw !== '' && Number.isInteger(n) && n >= 0 ? Math.min(n, DOMAIN_RESOLVER_MAX_PER_RUN_CAP) : DEFAULT_DOMAIN_RESOLVER_MAX_PER_RUN;
  return { enabled, maxPerRun };
}

// ---------------------------------------------------------------------------
// Denylist (code constant in v1)
// ---------------------------------------------------------------------------

/**
 * Brand labels (first label of the registrable domain, any TLD: amazon.es, amazon.de...)
 * that are never an exhibitor's own website: social networks, marketplaces, business
 * directories, press, encyclopedias, fair aggregators and generic platforms.
 */
export const RESOLVER_DENY_LABELS: ReadonlySet<string> = new Set([
  // Social networks
  'facebook', 'fb', 'instagram', 'linkedin', 'twitter', 'x', 'youtube', 'youtu', 'tiktok', 'pinterest', 'threads', 'telegram', 'whatsapp', 'flickr', 'vimeo', 'reddit', 'snapchat',
  // Marketplaces / shops
  'amazon', 'alibaba', 'aliexpress', 'ebay', 'etsy', 'mercadolibre', 'milanuncios', 'wallapop', 'carrefour', 'elcorteingles', 'mercadona', 'uvinum', 'vinissimus', 'bodeboca', 'decantalo', 'lavinia', 'drinksco', 'idealo', 'kelkoo', 'rakuten', 'zalando', 'temu', 'shein', 'made-in-china', 'globalsources', 'indiamart', 'tradeindia', 'ec21', 'tradekey',
  // Business directories / company data
  'paginasamarillas', 'europages', 'kompass', 'axesor', 'einforma', 'infoempresa', 'empresite', 'infocif', 'iberinform', 'informa', 'cylex', 'cylex-espana', 'yelp', 'tripadvisor', 'infobel', 'dnb', 'opencorporates', 'libreborme', 'guiaempresa', 'qdq', 'hotfrog', 'yellowpages', 'zoominfo', 'crunchbase', 'glassdoor', 'indeed', 'infojobs', 'emis', 'datoscif', 'expansionempresas', 'eleconomistaempresas', 'thefork', 'eltenedor', 'foursquare', 'vivino', 'wine-searcher', 'winesearcher', 'boe', 'borme', 'cincodiasempresas', 'iberempresas', 'universia', 'companieslist', 'bizapedia', 'manta', 'kvk', 'northdata', 'firmenwissen', 'societe', 'pappers', 'infogreffe',
  // Press (general and trade)
  'elpais', 'elmundo', 'abc', 'lavanguardia', 'expansion', 'cincodias', 'eleconomista', 'elconfidencial', 'europapress', '20minutos', 'larazon', 'elperiodico', 'eldiario', 'publico', 'efe', 'rtve', 'lainformacion', 'okdiario', 'elespanol', 'heraldo', 'lavozdegalicia', 'elcorreo', 'diariovasco', 'levante-emv', 'lasprovincias', 'diariodesevilla', 'lanuevaespana', 'farodevigo', 'diariodenavarra', 'ideal', 'hoy', 'lne', 'bbc', 'reuters', 'bloomberg', 'forbes', 'cnn', 'nytimes', 'theguardian', 'businessinsider', 'alimarket', 'interempresas', 'foodretail', 'financialfood', 'vinetur', 'tecnovino', 'revistaaral', 'distribucionactualidad', 'mercados21', 'restauracionnews', 'gastroeconomy', 'diariodegastronomia', 'directoalpaladar', 'thefoodtech', 'foodnewslatam', 'just-food', 'foodnavigator',
  // Encyclopedias
  'wikipedia', 'wikidata', 'wikimedia', 'wiktionary', 'wikiwand', 'britannica',
  // Fair calendars / aggregators
  '10times', 'nferias', 'expodatabase', 'eventseye', 'tradefairdates', 'feriasinfo', 'auma', 'tradeshowsinfo', 'allconferencealert', 'eventbrite', 'feriasyeventos', 'ferias-info', 'conferenceindex', 'expocomer',
  // Generic platforms, search engines, hosting
  'google', 'goo', 'bing', 'yahoo', 'duckduckgo', 'apple', 'microsoft', 'wordpress', 'wix', 'wixsite', 'blogspot', 'blogger', 'medium', 'github', 'issuu', 'scribd', 'slideshare', 'calameo', 'dropbox', 'linktr', 'bit', 'tinyurl', 'vertexaisearch',
]);

/** True when `domain` may not be an exhibitor's website: denylist, generic platforms or the fair's own sites. */
export function isDeniedForResolver(domain: string, fairDomains: Iterable<string>): boolean {
  const d = normalizeDomain(domain);
  if (!d) return true;
  const reg = registrableDomain(d);
  const label = reg.split('.')[0] ?? '';
  if (RESOLVER_DENY_LABELS.has(label)) return true;
  // Government sites (*.gob.es, *.gov...) are never a company.
  if (/\.(gob|gov)\.[a-z]{2}$|\.gov$|\.gob$/.test(d)) return true;
  return isExcludedDomain(d, fairDomains);
}

// ---------------------------------------------------------------------------
// Name normalisation and brand checks (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Company legal forms, after the dots are removed and single letters joined (S. L. U. -> slu). */
const LEGAL_FORMS = new Set([
  'sl', 'slu', 'sa', 'sau', 'sll', 'slne', 'slp', 'scoop', 'coop', 'scl', 'sat', 'cb', 'sc', 'scp', 'srl', 'spa', 'sas', 'sarl', 'sasu', 'lda', 'gmbh', 'ag', 'kg', 'ohg', 'ug',
  'ltd', 'limited', 'llc', 'llp', 'inc', 'corp', 'corporation', 'plc', 'bv', 'nv', 'ab', 'oy', 'as', 'aps', 'sro', 'spzoo', 'co',
]);

/** Words that do not identify a company on their own (articles, sector nouns, places). */
const GENERIC_TOKENS = new Set([
  'de', 'del', 'la', 'las', 'los', 'el', 'lo', 'y', 'e', 'i', 'o', 'd', 'l', 'en', 'the', 'and', 'of', 'et', 'des', 'du', 'le', 'les', 'und', 'der', 'die', 'das', 'di', 'da', 'do', 'dos', 'das',
  'bodega', 'bodegas', 'vino', 'vinos', 'vins', 'vinya', 'vinyes', 'celler', 'cellers', 'cava', 'cavas', 'grupo', 'group', 'groupe', 'hermanos', 'hnos', 'hijos', 'cia', 'compania', 'company', 'comercial',
  'industrias', 'industria', 'industrial', 'alimentacion', 'alimentos', 'alimentaria', 'foods', 'food', 'conservas', 'quesos', 'embutidos', 'cervezas', 'cerveza', 'aceites', 'aceite', 'cafes', 'cafe',
  'distribuciones', 'distribucion', 'productos', 'export', 'import', 'trading', 'internacional', 'international', 'global', 'sociedad', 'cooperativa', 'agricola', 'agraria',
  'spain', 'espana', 'iberica', 'iberia', 'europe', 'europa', 'gourmet', 'premium', 'selection', 'seleccion',
]);

export interface NameTokens {
  /** All tokens (folded, legal forms removed), in order. */
  tokens: string[];
  /** Tokens that identify the company (not generic). Empty: the name is too generic to verify. */
  distinctive: string[];
}

/** Lowercase, no accents, no punctuation, legal forms removed: «Bodegas Emilio Moro, S.L.» -> bodegas emilio moro. */
export function companyNameTokens(name: string): NameTokens {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\p{L})\.(?=\p{L}?\.|\s|$|,)/gu, '$1') // S.L. / S.A.U. -> sl / sau (dots of initials)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const raw = folded.length > 0 ? folded.split(' ') : [];
  // Join runs of single letters ("s l u" -> "slu") so a spaced legal form is caught too.
  const joined: string[] = [];
  let inRun = false;
  for (const t of raw) {
    const single = t.length === 1 && /^\p{L}$/u.test(t);
    if (single && inRun) joined[joined.length - 1] += t;
    else joined.push(t);
    inRun = single;
  }
  const tokens = joined.filter((t) => !LEGAL_FORMS.has(t));
  const distinctive = tokens.filter((t) => t.length >= 2 && !GENERIC_TOKENS.has(t));
  return { tokens, distinctive };
}

/** Folded page text for whole-word checks (same folding as the names). */
export function foldPageText(s: string): string {
  return ` ${s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

const hasWord = (hay: string, w: string) => hay.includes(` ${w} `);

/**
 * The domain label carries the company name: `emiliomoro.com` / `bodegasemiliomoro.es` for
 * «Bodegas Emilio Moro S.L.», `mahou-sanmiguel.com` for «Grupo Mahou San Miguel». The label
 * (hyphens removed) is the whole name, its distinctive part, contains the distinctive part
 * (>= 4 chars), or is a large (>= 60%) piece of the whole name.
 */
export function domainMatchesName(domain: string, name: string): boolean {
  const { tokens, distinctive } = companyNameTokens(name);
  const cd = distinctive.join('');
  if (cd.length < 3) return false;
  const label = (registrableDomain(domain).split('.')[0] ?? '').replace(/-/g, '');
  if (label.length < 3) return false;
  const all = tokens.join('');
  if (label === all || label === cd) return true;
  if (cd.length >= 4 && label.includes(cd)) return true;
  if (label.length >= 4 && all.includes(label) && label.length >= 0.6 * cd.length && distinctive.some((t) => label.includes(t))) return true;
  // Leading words spelled out + initials of the rest: `1001saboresrm.es` for «1001 Sabores, Región de Murcia».
  for (let k = distinctive.length - 1; k >= 1; k--) {
    const head = distinctive.slice(0, k).join('');
    if (head.length < 6 || !label.startsWith(head)) continue;
    const rest = label.slice(head.length);
    const initials = distinctive.slice(k).map((t) => t[0]).join('');
    if (rest.length >= 1 && rest === initials) return true;
  }
  return false;
}

/**
 * The page corroborates the brand: every distinctive token of the name is in the page title
 * (`title`), or the whole folded name / its distinctive part appears in the text as
 * consecutive words (`text`: header, h1, footer «© 2026 Empresa S.L.», legal notice).
 */
export function pageCorroboratesBrand(name: string, page: { title: string | null; text: string }): 'title' | 'text' | null {
  const { tokens, distinctive } = companyNameTokens(name);
  if (distinctive.length === 0) return null;
  const title = foldPageText(page.title ?? '');
  if (distinctive.every((t) => hasWord(title, t))) return 'title';
  const text = foldPageText(page.text);
  if (text.includes(` ${tokens.join(' ')} `) || text.includes(` ${distinctive.join(' ')} `)) return 'text';
  return null;
}

const LEGAL_LINK = /aviso[\s-]*legal|nota[\s-]*legal|informaci[oó]n[\s-]*legal|legal[\s-]*notice|legal|impressum|mentions[\s-]*l[eé]gales|t[eé]rminos[\s-]*legales/i;

/** The legal-notice link of a home page, on the same site, or null. */
export function legalNoticeLink(links: ReadonlyArray<{ url: string; text: string }>, homeUrl: string): string | null {
  const home = hostOf(homeUrl);
  if (!home) return null;
  const same = links.filter((l) => {
    const h = hostOf(l.url);
    return h !== null && registrableDomain(h) === registrableDomain(home);
  });
  const byText = same.find((l) => LEGAL_LINK.test(l.text) && !/privacidad|privacy|cookies/i.test(l.text));
  if (byText) return byText.url;
  return same.find((l) => /aviso-legal|avisolegal|legal-notice|nota-legal|impressum/i.test(l.url))?.url ?? null;
}

// ---------------------------------------------------------------------------
// Candidates (pure, unit-tested)
// ---------------------------------------------------------------------------

export interface DomainCandidate {
  domain: string;
  /**
   * Where the candidate comes from: a grounding source (domain reported), a grounding redirect
   * resolved by fetch, or (`search_unsourced`) the site the model proposed after a search that
   * ran but returned no usable sources (observed 2026-10-16 with Gemini: toolCalls without
   * groundingMetadata). The same verification applies to all of them.
   */
  origin: 'grounding' | 'redirect' | 'search_unsourced';
  status:
    | 'verified'
    | 'name_not_in_domain'
    | 'brand_not_on_page'
    | 'unreachable'
    | 'excluded'
    | 'redirects_elsewhere'
    | 'not_checked';
  /** URL that corroborated the brand (verified) or the last page read. */
  url?: string;
  verified_by?: 'title' | 'text' | 'legal_notice';
  error?: string;
}

/**
 * Distinct registrable domains of the grounding sources (search order), the model's proposal
 * first when the search returned it too, denied ones apart. Sources without a domain (only a
 * redirect URI) are returned for an optional resolution by fetch.
 */
export function groundingCandidates(
  sources: readonly GroundingSource[],
  proposed: string | null,
  fairDomains: readonly string[],
): { domains: string[]; excluded: string[]; withoutDomain: GroundingSource[] } {
  const domains: string[] = [];
  const excluded = new Set<string>();
  const withoutDomain: GroundingSource[] = [];
  for (const s of sources) {
    const d = normalizeDomain(s.domain);
    // A redirect host (vertexaisearch...) is not the page's domain: resolved by fetch instead.
    if (!d || isGroundingRedirectHost(d)) {
      withoutDomain.push(s);
      continue;
    }
    const reg = registrableDomain(d);
    if (isDeniedForResolver(d, fairDomains)) excluded.add(reg);
    else if (!domains.includes(reg)) domains.push(reg);
  }
  const p = normalizeDomain(proposed);
  if (p) {
    const reg = registrableDomain(p);
    const i = domains.indexOf(reg);
    if (i > 0) {
      domains.splice(i, 1);
      domains.unshift(reg);
    }
  }
  return { domains, excluded: [...excluded], withoutDomain };
}

/** Hosts of the grounding redirects (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`). */
export function isGroundingRedirectHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === 'vertexaisearch.cloud.google.com' || h.endsWith('.vertexaisearch.cloud.google.com');
}

export type ResolutionStatus =
  | 'domain_resolved'
  | 'domain_ambiguous'
  | 'domain_not_found'
  /** An exact-name company of the tenant already exists in Twenty: reused, no search. */
  | 'existing_company'
  | 'budget_exhausted'
  | 'time_budget_exhausted'
  | 'search_error';

/** Exactly one verified domain -> resolved; two or more, or a name match left unproven -> ambiguous; else not found. Pure. */
export function decideResolution(candidates: readonly DomainCandidate[]): { status: 'domain_resolved' | 'domain_ambiguous' | 'domain_not_found'; domain: string | null; reason: string } {
  const verified = [...new Set(candidates.filter((c) => c.status === 'verified').map((c) => c.domain))];
  if (verified.length === 1) return { status: 'domain_resolved', domain: verified[0]!, reason: 'un único dominio verificado' };
  if (verified.length > 1) return { status: 'domain_ambiguous', domain: null, reason: `varios dominios verificados (${verified.join(', ')})` };
  const doubtful = candidates.filter((c) => c.status === 'brand_not_on_page' || c.status === 'unreachable' || c.status === 'redirects_elsewhere' || c.status === 'not_checked');
  if (doubtful.length > 0) return { status: 'domain_ambiguous', domain: null, reason: 'el nombre coincide con algún dominio pero su web no corrobora la marca' };
  return { status: 'domain_not_found', domain: null, reason: candidates.length > 0 ? 'ningún resultado de la búsqueda lleva el nombre de la empresa' : 'la búsqueda no devolvió ninguna web candidata' };
}

// ---------------------------------------------------------------------------
// Search prompt (trusted constants; the name goes in an untrusted block)
// ---------------------------------------------------------------------------

export const DOMAIN_SEARCH_SYSTEM_PROMPT = `Eres el buscador de webs oficiales del Prospector de PubliEXPE.
Recibes el nombre de una empresa que expone en una feria. Buscas en Google su web OFICIAL (dominio propio de la empresa).

## Reglas
- SIEMPRE buscas en Google antes de responder. Nunca respondas de memoria.
- Solo la web propia de la empresa: no redes sociales, marketplaces, directorios de empresas, prensa, Wikipedia ni la web de la feria.
- No inventes ni construyas URLs: copia la que aparezca en los resultados. Si no la encuentras o dudas entre varias, devuelve null.
- Devuelve únicamente el objeto JSON pedido: {"website_url": "https://..." | null}.

${UNTRUSTED_SYSTEM_RULE}`;

export function buildDomainSearchPrompt(a: { name: string; sector?: string; eventName: string; place: string | null }): string {
  const data = [`Empresa: ${a.name}`, a.sector ? `Sector: ${a.sector}` : '', `Feria: ${a.eventName}`, a.place ? `País o localidad: ${a.place}` : ''].filter(Boolean).join('\n');
  return [
    `Busca en Google la web oficial de la empresa del bloque (consulta sugerida: «<nombre de la empresa> empresa${a.place ? ' <país o localidad>' : ''} web oficial»).`,
    wrapUntrusted(data, { origin: 'catálogo de expositores de la feria' }),
    'Responde solo con {"website_url": "https://..."} o {"website_url": null}.',
  ].join('\n\n');
}

/** Lenient: any parse gives a value (the proposal is only an ordering hint; grounding decides). */
export function parseDomainProposal(text: string): Parsed<{ proposed: string | null }> {
  const m = /"website_url"\s*:\s*"([^"]{4,2048})"/i.exec(text) ?? /\bhttps?:\/\/[^\s"'<>)\]]+/i.exec(text);
  const proposed = m ? normalizeDomain(m[1] ?? m[0]) : null;
  return { ok: true, value: { proposed } };
}

// ---------------------------------------------------------------------------
// Session (one per run)
// ---------------------------------------------------------------------------

export interface ResolverPage {
  finalUrl: string;
  title: string | null;
  text: string;
  links: ReadonlyArray<{ url: string; text: string }>;
  /** The static HTML looks like a JavaScript shell. */
  jsAppLikely: boolean;
}

export type ResolverPageRead = { ok: true; page: ResolverPage } | { ok: false; code: string };

export interface DomainResolverDeps {
  /** fetch_url of a page (the scout registers it in its SourceLedger). */
  fetch(url: string, maxChars: number): Promise<ResolverPageRead>;
  /** render_url of a JavaScript home page; absent = never render. */
  render?(url: string): Promise<ResolverPageRead>;
  /** Time budget checkpoint of the run (scout). */
  outOfTime?(): boolean;
}

export interface DomainResolution {
  status: ResolutionStatus;
  domain?: string | null;
  /** URL of the home page or legal notice that corroborated the brand (auditable). */
  source_url?: string | null;
  verified_by?: 'title' | 'text' | 'legal_notice';
  reason?: string;
  queries?: string[];
  /** Candidates seen (name-matching first): a human can decide an ambiguous case by hand. */
  domain_candidates?: DomainCandidate[];
  /** Domains of the search refused by the denylist or as the fair's own sites. */
  excluded?: string[];
  pages_read?: number;
  error?: { code: string; message: string };
  /** existing_company: the CRM company reused. */
  company_id?: string;
}

export interface ResolveContext {
  eventName: string;
  place: string | null;
  fairDomains: readonly string[];
}

export class DomainResolverSession {
  lookups = 0;
  resolved = 0;
  ambiguous = 0;
  notFound = 0;
  existing = 0;
  skippedBudget = 0;
  pagesRead = 0;

  constructor(
    private readonly run: ProspectorRun,
    readonly cfg: DomainResolverConfig,
    private readonly deps: DomainResolverDeps,
  ) {}

  get active(): boolean {
    return this.cfg.enabled;
  }

  summary(): Record<string, unknown> {
    return {
      enabled: this.cfg.enabled,
      max_per_run: this.cfg.maxPerRun,
      lookups: this.lookups,
      resolved: this.resolved,
      ambiguous: this.ambiguous,
      not_found: this.notFound,
      existing_company: this.existing,
      skipped_budget: this.skippedBudget,
      pages_read: this.pagesRead,
    };
  }

  async resolve(exhibitor: ExhibitorInput, ctx: ResolveContext): Promise<DomainResolution> {
    const name = exhibitor.name;
    const { distinctive } = companyNameTokens(name);
    const spent = (): DomainResolution | null => {
      if (this.lookups >= this.cfg.maxPerRun) {
        this.skippedBudget += 1;
        return { status: 'budget_exhausted' };
      }
      if (this.deps.outOfTime?.()) {
        this.skippedBudget += 1;
        return { status: 'time_budget_exhausted' };
      }
      return null;
    };
    // Budget first: once spent, nothing is read (writeExhibitor still looks the name up in Twenty).
    const early = spent();
    if (early) return early;
    // 1. Reuse an exact-name company of the tenant (writeExhibitor reuses it too): no search.
    const found = await this.run.callTool('find_company', { name, limit: 5 });
    if (found.result.status === 'ok') {
      const companies = (found.result.output as { companies: Array<{ id: string; name: string; domain: string | null }> }).companies;
      const exact = companies.filter((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (exact.length === 1) {
        this.existing += 1;
        return { status: 'existing_company', company_id: exact[0]!.id, domain: exact[0]!.domain };
      }
    }
    if (distinctive.length === 0) {
      this.ambiguous += 1;
      return { status: 'domain_ambiguous', reason: 'nombre demasiado genérico para verificar una web', domain_candidates: [] };
    }
    // Checked again: another worker may have spent the budget while find_company ran.
    const late = spent();
    if (late) return late;
    this.lookups += 1;

    // 2. Grounded search.
    const search = await this.run.completeJson({
      label: { step: 'domain_search', company: name },
      system: DOMAIN_SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildDomainSearchPrompt({ name, ...(exhibitor.sector ? { sector: exhibitor.sector } : {}), eventName: ctx.eventName, place: ctx.place }) }],
      parse: parseDomainProposal,
      grounding: true,
      maxAttempts: 1,
      maxTokens: 1024,
    });
    if (search.status === 'model_error') return { status: 'search_error', error: { code: search.code, message: search.message } };
    const grounding = search.grounding ?? { queries: [], sources: [] };
    const proposed = search.status === 'ok' ? search.value.proposed : null;
    const cands = groundingCandidates(grounding.sources, proposed, ctx.fairDomains);

    // 3. Grounding redirects without a domain: resolved by fetch only when no named domain came back.
    let pages = 0;
    const origins = new Map<string, DomainCandidate['origin']>(cands.domains.map((d) => [d, 'grounding']));
    const excluded = new Set(cands.excluded);
    const anyMatch = () => [...origins.keys()].some((d) => domainMatchesName(d, name));
    if (!anyMatch()) {
      for (const s of cands.withoutDomain) {
        if (pages >= DOMAIN_RESOLVER_PAGES_PER_LOOKUP - 1) break;
        // The title of a redirect chunk is often the page's domain: no fetch needed then.
        const titled = s.title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.title.trim()) ? normalizeDomain(s.title) : null;
        let host: string | null = titled && !isGroundingRedirectHost(titled) ? titled : null;
        if (!host) {
          // fetch_url follows the 3xx of the redirect: its final URL is the real page.
          pages += 1;
          const r = await this.deps.fetch(s.uri, 2_000);
          host = r.ok ? hostOf(r.page.finalUrl) : null;
        }
        if (!host || isGroundingRedirectHost(host)) continue;
        const reg = registrableDomain(host);
        if (isDeniedForResolver(host, ctx.fairDomains)) excluded.add(reg);
        else if (!origins.has(reg)) origins.set(reg, 'redirect');
        if (domainMatchesName(reg, name)) break;
      }
    }
    // The search ran but brought no usable source (Gemini 2026-10-16: toolCalls without groundingMetadata):
    // the model's proposal is a candidate too, under the same verification (name in the domain + brand on
    // its own page, fetched through the SSRF guard), as the scout does for fairs (verify_unsourced_by_fetch).
    const searched = grounding.queries.length > 0 || (grounding.diagnostics?.toolCalls ?? 0) > 0;
    const proposedReg = proposed && !isGroundingRedirectHost(proposed) ? registrableDomain(proposed) : null;
    if (searched && proposedReg && !anyMatch() && !origins.has(proposedReg)) {
      if (isDeniedForResolver(proposedReg, ctx.fairDomains)) excluded.add(proposedReg);
      else origins.set(proposedReg, 'search_unsourced');
    }

    // 4. Verification of the name-matching candidates, best first.
    const candidates: DomainCandidate[] = [];
    let checked = 0;
    for (const [domain, origin] of origins) {
      if (!domainMatchesName(domain, name)) {
        candidates.push({ domain, origin, status: 'name_not_in_domain' });
        continue;
      }
      if (checked >= DOMAIN_RESOLVER_MAX_CANDIDATES || pages >= DOMAIN_RESOLVER_PAGES_PER_LOOKUP || candidates.filter((c) => c.status === 'verified').length >= 2) {
        candidates.push({ domain, origin, status: 'not_checked' });
        continue;
      }
      checked += 1;
      const v = await this.verify(domain, name, ctx, DOMAIN_RESOLVER_PAGES_PER_LOOKUP - pages);
      pages += v.pages;
      candidates.push({ ...v.candidate, origin });
    }
    this.pagesRead += pages;
    // Name-matching candidates first in the output.
    candidates.sort((a, b) => Number(a.status === 'name_not_in_domain') - Number(b.status === 'name_not_in_domain'));
    const decision = decideResolution(candidates);
    const verified = decision.domain ? candidates.find((c) => c.status === 'verified' && c.domain === decision.domain) : undefined;
    if (decision.status === 'domain_resolved') this.resolved += 1;
    else if (decision.status === 'domain_ambiguous') this.ambiguous += 1;
    else this.notFound += 1;
    return {
      status: decision.status,
      domain: decision.domain,
      ...(verified ? { source_url: verified.url ?? null, ...(verified.verified_by ? { verified_by: verified.verified_by } : {}) } : {}),
      reason: decision.reason,
      queries: grounding.queries.slice(0, 5),
      domain_candidates: candidates.slice(0, 10),
      ...(excluded.size > 0 ? { excluded: [...excluded].slice(0, 20) } : {}),
      pages_read: pages,
    };
  }

  /** Home page (rendered if it is a JS shell), then its legal notice, must corroborate the brand. */
  private async verify(domain: string, name: string, ctx: ResolveContext, pageBudget: number): Promise<{ candidate: Omit<DomainCandidate, 'origin'>; pages: number }> {
    let pages = 0;
    const home = `https://${domain}/`;
    pages += 1;
    const f = await this.deps.fetch(home, PAGE_MAX_CHARS);
    if (!f.ok) return { candidate: { domain, status: 'unreachable', url: home, error: f.code }, pages };
    let page = f.page;
    const finalHost = hostOf(page.finalUrl);
    let resolved = domain;
    if (finalHost && registrableDomain(finalHost) !== domain) {
      const reg = registrableDomain(finalHost);
      // A redirect to a sibling of the brand (torres.com -> torres.es) is the same company; elsewhere, doubt.
      if (isDeniedForResolver(finalHost, ctx.fairDomains)) return { candidate: { domain, status: 'excluded', url: page.finalUrl }, pages };
      if (!domainMatchesName(reg, name)) return { candidate: { domain, status: 'redirects_elsewhere', url: page.finalUrl }, pages };
      resolved = reg;
    }
    if (page.jsAppLikely && page.text.trim().length < EMPTY_SHELL_CHARS && this.deps.render && pages < pageBudget) {
      pages += 1;
      const r = await this.deps.render(page.finalUrl);
      if (r.ok) page = r.page;
    }
    const where = pageCorroboratesBrand(name, page);
    if (where) return { candidate: { domain: resolved, status: 'verified', url: page.finalUrl, verified_by: where }, pages };
    const legal = legalNoticeLink(page.links, page.finalUrl);
    if (legal && pages < pageBudget) {
      pages += 1;
      const l = await this.deps.fetch(legal, PAGE_MAX_CHARS);
      if (l.ok && pageCorroboratesBrand(name, { title: null, text: `${l.page.title ?? ''}\n${l.page.text}` })) {
        return { candidate: { domain: resolved, status: 'verified', url: l.page.finalUrl, verified_by: 'legal_notice' }, pages };
      }
    }
    return { candidate: { domain: resolved, status: 'brand_not_on_page', url: page.finalUrl }, pages };
  }
}

/** fetch_url through the run's tool executor (direct mode; the scout passes its own, ledger-aware one). */
export function toolFetcher(run: ProspectorRun): DomainResolverDeps['fetch'] {
  return async (url, maxChars) => {
    const out = await run.callTool('fetch_url', { url, maxChars });
    if (out.result.status !== 'ok') return { ok: false, code: toolError(out).code };
    const p = out.result.output as { finalUrl: string; title: string | null; text: string; links: Array<{ url: string; text: string }>; js_app_likely: boolean };
    return { ok: true, page: { finalUrl: p.finalUrl, title: p.title, text: p.text, links: p.links, jsAppLikely: p.js_app_likely } };
  };
}

const VERIFIED_BY_ES: Record<NonNullable<DomainResolution['verified_by']>, string> = {
  title: 'el título de su portada',
  text: 'el texto de su portada',
  legal_notice: 'su aviso legal',
};

/**
 * Runs the resolver for one writable exhibitor without a domain and records it in
 * `result.domain_resolution`. Returns the exhibitor with the domain when it was resolved,
 * plus the hypothesis evidence that cites the page which corroborated the brand.
 */
export async function resolveExhibitorDomain(
  session: DomainResolverSession,
  exhibitor: ExhibitorInput,
  result: { domain_resolution?: DomainResolution },
  ctx: ResolveContext,
): Promise<{ exhibitor: ExhibitorInput; evidence: Array<{ claim: string; sourceUrl?: string }> }> {
  const r = await session.resolve(exhibitor, ctx);
  result.domain_resolution = r;
  if (r.status !== 'domain_resolved' || !r.domain) return { exhibitor, evidence: [] };
  const how = r.verified_by ? VERIFIED_BY_ES[r.verified_by] : 'su web';
  return {
    exhibitor: { ...exhibitor, domain: r.domain },
    evidence: [{ claim: `Web ${r.domain} localizada por búsqueda web y verificada: la marca figura en ${how}.`, ...(r.source_url ? { sourceUrl: r.source_url } : {}) }],
  };
}
