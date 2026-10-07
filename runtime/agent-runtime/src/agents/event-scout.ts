/**
 * Prospector "scout" mode (skill `event-source-discovery`): works on REAL fairs.
 *
 * Input `{ sector, region?, horizon_months? }` or `{ event_url }`:
 *  a) one Gemini call WITH Google Search grounding locates 1-3 upcoming fairs and
 *     their URLs (skipped with `event_url`);
 *  b) `fetch_url` downloads the fair's exhibitor page (or its home page, then the
 *     exhibitor link found in it). If the page looks like a JavaScript app (little
 *     text, a lot of script, empty SPA mount point) or yields no exhibitors,
 *     `render_url` renders it with a browser (separate pxos-renderer service). Up to
 *     `max_pdfs_per_event` catalog / exhibitor-list PDFs linked from the pages are
 *     downloaded with `fetch_url` (text extracted from the PDF) and read too;
 *  c) the LLM extracts `{name, domain?, description?}` from the DOWNLOADED TEXT only
 *     (static HTML, rendered page or PDF);
 *  d) a paginated list is read up to `max_catalog_pages`: client-side pagination in the
 *     same render_url call (`maxPages`, the renderer clicks "next"), or the list's
 *     "next" / `?page=N` links;
 *  e) every exhibitor is evaluated by the LLM FIRST (no write); then, only for the
 *     RELEVANT ones without a domain, best confidence first and up to
 *     `max_profile_lookups` per run, the exhibitor profile linked from the list
 *     (`/exhibitors/{id}`) is opened (fetch_url, or render_url if it is a JS app) and
 *     its website taken ("Web/Website" label, only external link or only www. domain),
 *     refusing the fair's own sites and social networks (kept as metadata); the domain
 *     must resolve to public addresses (fetch_url of its home page, same guards);
 *  f) the existing pipeline writes company -> signal -> hypothesis (no domain after the
 *     lookup: `skipped_no_domain`, as before).
 * Without an exhibitor list the fair is recorded as an event-level FAIR signal and
 * the run ends PARTIAL with the reason. Without a renderer (`RENDERER_NOT_CONFIGURED`,
 * render_url not in the tool policy) the flow is the same minus step b's rendering.
 *
 * Security (LLD §22 / v0.2 §10.4):
 * - web text only enters user messages inside DATOS_NO_CONFIABLES blocks;
 * - the model never chooses which tool to call: the code does, with fixed arguments;
 * - URLs proposed by the model are fetched only if their domain was returned by
 *   grounding, or if they are links of a page already downloaded;
 * - every `sourceUrl` written to Twenty is checked against the run's SourceLedger
 *   (visited or grounded), exhibitor names must appear in the downloaded text and
 *   their domains in its text or links; free text is scrubbed of foreign URLs.
 */
import { z } from 'zod';
import { normalizeDomain } from '../integrations/twenty/index.js';
import type { FetchUrlOutput } from '../tools/web/fetch-url.js';
import type { RenderUrlOutput } from '../tools/web/render-url.js';
import {
  extractProfileWebsite,
  findProfileLink,
  paginationLinks,
  profileMatchesExhibitor,
  registrableDomain,
} from './exhibitor-profile.js';
import {
  decideExhibitor,
  ERROR_STATUSES,
  writeExhibitor,
  type DecidedExhibitor,
  exhibitorCounters,
  formatEur,
  issues,
  parseWith,
  resultLine,
  round6,
  toolError,
  type ExhibitorInput,
  type ExhibitorResult,
  type ProspectorEvent,
  type ProspectorRun,
  type RunOutcome,
} from './prospector-core.js';
import {
  buildEventSearchPrompt,
  buildExtractPrompt,
  buildSearchRepairPrompt,
  SCOUT_EXTRACT_SYSTEM_PROMPT,
  SCOUT_SEARCH_SYSTEM_PROMPT,
} from './event-scout-prompt.js';
import { PROSPECTOR_SYSTEM_PROMPT } from './prospector-prompt.js';
import { hostOf, normalizeUrl, scrubUnknownUrls, SourceLedger } from './source-ledger.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const ScoutInput = z
  .object({
    mode: z.literal('scout').optional(),
    sector: z.string().trim().min(2).max(120).optional(),
    region: z.string().trim().min(2).max(120).default('España'),
    horizon_months: z.number().int().min(1).max(24).default(6),
    event_url: z.url({ protocol: /^https?$/ }).max(2048).optional(),
    event_name: z.string().trim().min(1).max(255).optional(),
    /** Lower caps for one run (never above the agent configuration). */
    max_events: z.number().int().min(1).max(3).optional(),
    max_exhibitors: z.number().int().min(1).max(100).optional(),
    max_catalog_pages: z.number().int().min(1).max(5).optional(),
    max_profile_lookups: z.number().int().min(0).max(30).optional(),
  })
  .refine((v) => v.sector !== undefined || v.event_url !== undefined, { message: 'sector or event_url is required' });
export type ScoutInput = z.infer<typeof ScoutInput>;

/** Scout mode when the input asks for it or has no `event`/`exhibitors` but a sector / event_url. */
export function isScoutInput(input: Record<string, unknown>): boolean {
  if (input.mode === 'scout') return true;
  if ('event' in input || 'exhibitors' in input) return false;
  return 'sector' in input || 'event_url' in input;
}

// ---------------------------------------------------------------------------
// LLM outputs
// ---------------------------------------------------------------------------

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null));

const FoundEvent = z.object({
  name: z.string().trim().min(1).max(255),
  start_date: nullableText(40),
  end_date: nullableText(40),
  city: nullableText(255),
  website_url: nullableText(2048),
  exhibitors_url: nullableText(2048),
  why_relevant: nullableText(1000),
});
export const SearchAnswer = z.object({ events: z.array(FoundEvent).max(10) });
export type FoundEvent = z.infer<typeof FoundEvent>;

const ExtractedExhibitor = z.object({
  name: z.string().trim().min(1).max(255),
  domain: nullableText(253),
  description: nullableText(4000),
  sector: nullableText(255),
});
export const ExtractAnswer = z.object({
  page_kind: z.enum(['exhibitor_list', 'event_home', 'other']).catch('other'),
  event: z
    .object({ name: nullableText(255), start_date: nullableText(40), end_date: nullableText(40), city: nullableText(255) })
    .nullish()
    .transform((v) => v ?? { name: null, start_date: null, end_date: null, city: null }),
  exhibitors: z.array(ExtractedExhibitor).max(300).default([]),
  exhibitors_page_url: nullableText(2048),
  notes: nullableText(1000),
});
export type ExtractAnswer = z.infer<typeof ExtractAnswer>;

const nullable = (type: string) => ({ type: [type, 'null'] });
export const EXTRACT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    page_kind: { type: 'string', enum: ['exhibitor_list', 'event_home', 'other'] },
    event: {
      type: 'object',
      properties: { name: nullable('string'), start_date: nullable('string'), end_date: nullable('string'), city: nullable('string') },
    },
    exhibitors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, domain: nullable('string'), description: nullable('string'), sector: nullable('string') },
        required: ['name'],
      },
    },
    exhibitors_page_url: nullable('string'),
    notes: nullable('string'),
  },
  required: ['page_kind', 'exhibitors'],
};

const isoDate = (v: string | null): string | null => (v && z.iso.date().safeParse(v).success ? v : null);

// ---------------------------------------------------------------------------
// Verification helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Lowercase, no accents, single spaces: for "does this name appear in the page" checks. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.&+-]+/gu, ' ')
    .trim();
}

/** Domains that are never an exhibitor's own website. */
const NON_COMPANY_DOMAINS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'tiktok.com',
  'google.com', 'goo.gl', 'bit.ly', 'wa.me', 'whatsapp.com', 'pinterest.com', 'flickr.com', 'vimeo.com',
];

export interface VerifiedExhibitors {
  exhibitors: ExhibitorInput[];
  dropped: Array<{ name: string; reason: string }>;
  domainsRemoved: number;
}

/**
 * Keeps only exhibitors whose name appears in the downloaded text (or link texts) and
 * domains that appear in the text or in the page links (never the fair's own site
 * nor social networks). Deduplicates by name.
 */
export function verifyExhibitors(list: ExtractAnswer['exhibitors'], page: Pick<FetchUrlOutput, 'text' | 'links' | 'finalUrl'>, max: number): VerifiedExhibitors {
  const haystack = foldText(`${page.text}\n${page.links.map((l) => l.text).join('\n')}`);
  const rawText = page.text.toLowerCase();
  const linkHosts = new Set(page.links.map((l) => hostOf(l.url)).filter((h): h is string => h !== null));
  const eventHost = hostOf(page.finalUrl);
  const out: ExhibitorInput[] = [];
  const dropped: Array<{ name: string; reason: string }> = [];
  const seen = new Set<string>();
  let domainsRemoved = 0;
  for (const e of list) {
    const folded = foldText(e.name);
    if (folded.length < 2 || !haystack.includes(folded)) {
      dropped.push({ name: e.name, reason: 'name_not_in_page' });
      continue;
    }
    if (seen.has(folded)) continue;
    seen.add(folded);
    let domain = normalizeDomain(e.domain);
    if (domain) {
      const inPage = rawText.includes(domain) || [...linkHosts].some((h) => h === domain || h.endsWith(`.${domain}`));
      const isEventSite = eventHost !== null && (domain === eventHost || domain.endsWith(`.${eventHost}`) || eventHost.endsWith(`.${domain}`));
      const generic = NON_COMPANY_DOMAINS.some((d) => domain === d || domain!.endsWith(`.${d}`));
      if (!inPage || isEventSite || generic) {
        domain = null;
        domainsRemoved += 1;
      }
    }
    out.push({
      name: e.name,
      ...(domain ? { domain } : {}),
      ...(e.description ? { description: e.description.slice(0, 1000) } : {}),
      ...(e.sector ? { sector: e.sector } : {}),
    });
    if (out.length >= max) break;
  }
  return { exhibitors: out, dropped, domainsRemoved };
}

const NAME_STOPWORDS = new Set(['feria', 'salon', 'internacional', 'international', 'edicion', 'expo', 'show', 'fair', 'congreso', 'semana', 'nacional', 'espana', 'madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao']);

/**
 * True when a downloaded page plausibly belongs to the named fair: one distinctive
 * name token is in the host, or at least half of them are in the title + text.
 * Used only for candidates whose search returned no grounding sources.
 */
export function pageCorroboratesEvent(eventName: string, page: Pick<FetchUrlOutput, 'title' | 'text' | 'finalUrl'>): boolean {
  const tokens = [...new Set(foldText(eventName).split(' '))].filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !NAME_STOPWORDS.has(t));
  if (tokens.length === 0) return false;
  const host = (hostOf(page.finalUrl) ?? '').replace(/[^a-z0-9]/g, '');
  if (tokens.some((t) => t.length >= 5 && host.includes(t.replace(/[^a-z0-9]/g, '')))) return true;
  const hay = foldText(`${page.title ?? ''}\n${page.text.slice(0, 20_000)}`);
  return tokens.filter((t) => hay.includes(t)).length / tokens.length >= 0.5;
}

/** A link of the page, matched exactly (after normalisation), or null. */
export function pickPageLink(candidate: string | null, page: Pick<FetchUrlOutput, 'links'>): string | null {
  if (!candidate) return null;
  const want = normalizeUrl(candidate);
  if (!want) return null;
  return page.links.find((l) => normalizeUrl(l.url) === want)?.url ?? null;
}

/** URL path of an exhibitor list / catalog (the renderer is then asked to paginate). */
const LIST_URL_KEYWORDS = /expositor|exhibitor|exposant|aussteller|espositori|catalog|directorio|directory|participantes|participants|empresas|companies|marcas|brands|listado|list/i;

export function looksLikeExhibitorList(url: string): boolean {
  try {
    const u = new URL(url);
    return LIST_URL_KEYWORDS.test(decodeURIComponentSafe(`${u.pathname} ${u.search}`));
  } catch {
    return false;
  }
}

/** Catalog / list keywords for PDF links (folded: no accents, lowercase). */
const CATALOG_PDF_KEYWORDS =
  /expositor|exhibitor|exposant|aussteller|espositori|catalog|listado|lista|list of|participantes|participants|empresas|companies|marcas|brands|directorio|directory|plano|floor ?plan|\bstands?\b/;

/**
 * Links of the page(s) that point to a PDF (by extension) whose URL or link text
 * suggests an exhibitor catalog / list. Keyword matches in the link text rank first.
 * `skip` filters URLs already visited or tried. Pure; unit-tested.
 */
export function catalogPdfLinks(links: ReadonlyArray<{ url: string; text: string }>, skip: (url: string) => boolean, max: number): string[] {
  if (max <= 0) return [];
  const scored: Array<{ url: string; score: number; i: number }> = [];
  const seen = new Set<string>();
  links.forEach((l, i) => {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (!/\.pdf$/i.test(u.pathname) && !/\.pdf(?:&|$)/i.test(u.search)) return;
    const key = normalizeUrl(l.url);
    if (!key || seen.has(key) || skip(l.url)) return;
    seen.add(key);
    const inText = CATALOG_PDF_KEYWORDS.test(foldText(l.text));
    const inUrl = CATALOG_PDF_KEYWORDS.test(foldText(decodeURIComponentSafe(`${u.pathname} ${u.search}`).replace(/[-_/.=?&]+/g, ' ')));
    if (!inText && !inUrl) return;
    scored.push({ url: l.url, score: (inText ? 2 : 0) + (inUrl ? 1 : 0), i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.url);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type ContentKind = 'html' | 'text' | 'pdf' | 'rendered';

/** A page the scout read: fetch_url (HTML, text, PDF) or render_url output. */
export type ScoutPage = Pick<FetchUrlOutput, 'url' | 'finalUrl' | 'title' | 'text' | 'truncated' | 'links' | 'redirects'> & {
  content_kind: ContentKind;
  js_app_likely: boolean;
  /** render_url with `maxPages`: list pages read in that call (null/undefined: one). */
  pages_read?: number | null;
};

type PageAttempt = {
  url: string;
  /** How the page was read: `fetch` (fetch_url), `render` (render_url) or `pdf` (catalog PDF linked from a page). */
  via: 'fetch' | 'render' | 'pdf';
  final_url?: string;
  status: 'ok' | 'error';
  code?: string;
  chars?: number;
  content_kind?: ContentKind;
  js_app_likely?: boolean;
  page_kind?: string;
  exhibitors_extracted?: number;
  /** New exhibitors (verified, not seen in an earlier page of the event). */
  exhibitors_verified?: number;
  /** List pages this attempt covers (client-side pagination inside one render). */
  list_pages?: number;
  /** A next page of an exhibitor list (link-based pagination). */
  pagination?: boolean;
};

/** render_url answers that switch rendering off for the rest of the run. */
const RENDER_OFF_CODES = new Set(['RENDERER_NOT_CONFIGURED', 'TOOL_NOT_ALLOWED', 'TOOL_NOT_FOUND', 'TOOL_DISABLED', 'TOOL_CALL_LIMIT']);
/**
 * fetch_url errors of a company home page that still prove a real, public domain: they
 * happen AFTER the DNS + public-IP check (HTTP 4xx/5xx, TLS / connection errors, timeouts).
 */
const DOMAIN_ALIVE_CODES = new Set(['HTTP_ERROR', 'NETWORK_ERROR', 'FETCH_TIMEOUT', 'TOO_MANY_REDIRECTS', 'UNSUPPORTED_CONTENT_TYPE', 'INVALID_REDIRECT', 'PDF_INVALID', 'PDF_ENCRYPTED', 'PDF_TOO_LARGE']);
/** Below this many characters a JS-app shell (or an empty render) is not worth an LLM extraction call. */
const EMPTY_SHELL_CHARS = 200;
/** First render: wait until the app shows some text and it stops growing (renderer hydration wait). */
const RENDER_FIRST = { minTextChars: 300 } as const;
/** Retry of an empty render: longer extra wait, after network idle. */
const RENDER_RETRY = { waitMs: 8_000, waitUntil: 'networkidle', minTextChars: 400 } as const;

export interface ScoutEventResult {
  name: string;
  date: string | null;
  end_date: string | null;
  location: string | null;
  website_url: string | null;
  exhibitors_url: string | null;
  source_url: string | null;
  status: 'exhibitors_processed' | 'event_signal' | 'event_signal_error' | 'unreachable';
  verification: 'operator_url' | 'grounding_domain' | 'fetch_corroboration';
  reason?: string;
  pages: PageAttempt[];
  exhibitors_extracted: number;
  exhibitors_dropped: Array<{ name: string; reason: string }>;
  domains_removed: number;
  /** Pages of the exhibitor list from which exhibitors were read (pagination included). */
  catalog_pages: number;
  signal_id?: string;
  error?: { code: string; message: string };
  results: ExhibitorResult[];
}

interface Candidate {
  name: string | null;
  start_date: string | null;
  end_date: string | null;
  city: string | null;
  website_url: string | null;
  exhibitors_url: string | null;
  /**
   * `grounding`: URL domain backed by grounding sources. `search_unsourced`: the model
   * ran Google searches but the API returned no sources; the URL is only used if the
   * downloaded page corroborates the fair. `input`: operator-provided `event_url`.
   */
  origin: 'grounding' | 'search_unsourced' | 'input';
}

export interface ScoutRunOutput {
  outcome: RunOutcome;
  lines: string[];
  output: Record<string, unknown>;
}

const PAGE_TEXT_FOR_EXTRACTION = 40_000;

export async function runScout(run: ProspectorRun, rawInput: Record<string, unknown>, today: string): Promise<ScoutRunOutput> {
  const cfg = run.cfg.scout;
  const parsed = ScoutInput.safeParse(rawInput);
  run.steps.push({
    type: 'THINK',
    timestamp: new Date(),
    input: { input_keys: Object.keys(rawInput), mode: 'scout' },
    output: parsed.success
      ? {
          plan: parsed.data.event_url
            ? 'fetch the given event page, extract exhibitors from its text, evaluate each one, publish the run summary'
            : 'locate upcoming fairs with grounded search, fetch their exhibitor pages, extract exhibitors from the text, evaluate each one, publish the run summary',
          limits: cfg,
        }
      : { error: 'invalid input', issues: issues(parsed.error) },
    latencyMs: 0,
  });
  if (!parsed.success) {
    return { outcome: 'FAILED', lines: [`Entrada inválida (modo scout): ${issues(parsed.error)}`], output: { mode: 'scout', input_error: issues(parsed.error) } };
  }
  const input = parsed.data;
  const maxEvents = Math.max(1, Math.min(input.max_events ?? cfg.maxEvents, cfg.maxEvents));
  const maxExhibitors = Math.max(1, Math.min(input.max_exhibitors ?? cfg.maxExhibitorsPerEvent, cfg.maxExhibitorsPerEvent));
  const until = addMonths(today, input.horizon_months);
  const system = run.ctx.version.systemPrompt.trim().length > 0 ? run.ctx.version.systemPrompt : PROSPECTOR_SYSTEM_PROMPT;
  const ledger = new SourceLedger();
  const pageCache = new Map<string, FetchUrlOutput>();
  const partialReasons: string[] = [];
  let fetches = 0;
  let redirectResolutions = 0;
  let renders = 0;
  let rendersOk = 0;
  let renderRetries = 0;
  let pdfsRead = 0;
  let renderOff: string | null = cfg.maxRenders === 0 ? 'RENDER_DISABLED_BY_CONFIG' : null;
  const renderCache = new Map<string, ScoutPage>();
  const maxCatalogPages = Math.max(1, Math.min(input.max_catalog_pages ?? cfg.maxCatalogPages, cfg.maxCatalogPages));
  const maxProfileLookups = Math.max(0, Math.min(input.max_profile_lookups ?? cfg.maxProfileLookups, cfg.maxProfileLookups));
  /** render_url calls for exhibitor lists / event pages (budget `max_renders`); profile renders are counted apart. */
  let catalogRenders = 0;
  let profileLookups = 0;
  let profileRenders = 0;
  let domainChecks = 0;
  let domainsResolved = 0;
  /** Hosts whose static HTML was a JavaScript shell: their profiles are rendered directly. */
  const jsAppHosts = new Set<string>();

  type PageRead = { ok: true; page: ScoutPage } | { ok: false; code: string; message: string };

  const fetchPage = async (url: string): Promise<PageRead> => {
    const key = normalizeUrl(url);
    const cached = key ? pageCache.get(key) : undefined;
    if (cached) return { ok: true, page: cached };
    if (fetches >= cfg.maxFetches) return { ok: false, code: 'FETCH_BUDGET_EXHAUSTED', message: `max_fetches (${cfg.maxFetches}) reached` };
    fetches += 1;
    return fetchUncounted(url);
  };

  /** fetch_url without the `max_fetches` budget (profile lookups have their own). */
  const fetchUncounted = async (url: string): Promise<PageRead> => {
    const out = await run.callTool('fetch_url', { url });
    if (out.result.status !== 'ok') return { ok: false, ...toolError(out) };
    const page = out.result.output as FetchUrlOutput;
    ledger.addVisited(url, page.finalUrl, ...page.redirects);
    for (const u of [url, page.finalUrl]) {
      const k = normalizeUrl(u);
      if (k) pageCache.set(k, page);
    }
    if (page.js_app_likely && page.text.trim().length < EMPTY_SHELL_CHARS) {
      const h = hostOf(page.finalUrl);
      if (h) jsAppHosts.add(h);
    }
    return { ok: true, page };
  };

  /** One render_url call (counted in the budget). */
  const callRender = async (url: string, opts: Record<string, unknown>): Promise<{ ok: true; out: RenderUrlOutput } | { ok: false; code: string; message: string }> => {
    renders += 1;
    const out = await run.callTool('render_url', { url, ...opts });
    if (out.result.status !== 'ok') {
      const e = toolError(out);
      if (RENDER_OFF_CODES.has(e.code)) renderOff = e.code;
      return { ok: false, ...e };
    }
    rendersOk += 1;
    return { ok: true, out: out.result.output as RenderUrlOutput };
  };

  /**
   * render_url with a per-run budget; switched off for the run when the renderer is
   * unavailable. A render that comes back (almost) empty, i.e. the app had not hydrated
   * yet, is retried ONCE with a longer, network-idle wait if the budget allows it.
   */
  const renderPage = async (url: string, opts: { profile?: boolean; paginate?: boolean } = {}): Promise<PageRead> => {
    const key = normalizeUrl(url);
    const cached = key ? renderCache.get(key) : undefined;
    if (cached) return { ok: true, page: cached };
    if (renderOff) return { ok: false, code: 'RENDER_DISABLED', message: renderOff };
    // Profiles: one render each, under max_profile_lookups (checked by the caller), no retry.
    const budgetLeft = () => opts.profile || catalogRenders < cfg.maxRenders;
    if (!budgetLeft()) return { ok: false, code: 'RENDER_BUDGET_EXHAUSTED', message: `max_renders (${cfg.maxRenders}) reached` };
    // Exhibitor lists: ask the renderer to click through client-side pagination.
    const paginate = !opts.profile && maxCatalogPages > 1 && (opts.paginate ?? looksLikeExhibitorList(url));
    const firstOpts = paginate ? { ...RENDER_FIRST, maxPages: maxCatalogPages } : RENDER_FIRST;
    if (opts.profile) profileRenders += 1;
    else catalogRenders += 1;
    const first = await callRender(url, firstOpts);
    if (!first.ok) return first;
    let r = first.out;
    if (!opts.profile && r.text.trim().length < EMPTY_SHELL_CHARS && budgetLeft() && !renderOff) {
      renderRetries += 1;
      catalogRenders += 1;
      const second = await callRender(url, paginate ? { ...RENDER_RETRY, maxPages: maxCatalogPages } : RENDER_RETRY);
      if (second.ok && second.out.text.trim().length > r.text.trim().length) r = second.out;
    }
    const page: ScoutPage = {
      url: r.url,
      finalUrl: r.finalUrl,
      title: r.title,
      text: r.text,
      truncated: r.truncated,
      links: r.links,
      redirects: r.redirects,
      content_kind: 'rendered',
      js_app_likely: false,
      pages_read: r.pagesRead ?? null,
    };
    ledger.addVisited(url, r.finalUrl, ...(r.pageUrls ?? []));
    for (const u of [url, r.finalUrl]) {
      const k = normalizeUrl(u);
      if (k) renderCache.set(k, page);
    }
    return { ok: true, page };
  };

  // ------------------------------------------------- exhibitor profiles (websites)

  /** The fair's own sites: event website, exhibitor list and every page read for the event (never a company domain). */
  const fairDomainsOf = (ev: ScoutEventResult): string[] => {
    const hosts = [ev.website_url, ev.exhibitors_url, ...ev.pages.filter((p) => p.via !== 'pdf').flatMap((p) => [p.url, p.final_url ?? null])]
      .map((u) => (u ? hostOf(u) : null))
      .filter((h): h is string => h !== null);
    return [...new Set(hosts.map(registrableDomain))];
  };

  /**
   * The domain must resolve to public addresses: fetch_url of its home page, with the
   * same SSRF guards as any fetch. A DNS failure or a non-public address refuses it; an
   * HTTP error, TLS / connection error or timeout after the DNS check still proves a
   * real, public domain (company sites behind a WAF often answer 403).
   */
  const checkDomain = async (domain: string): Promise<{ ok: true } | { ok: false; code: string }> => {
    domainChecks += 1;
    const out = await run.callTool('fetch_url', { url: `https://${domain}/`, maxChars: 2_000 });
    if (out.result.status === 'ok') {
      const page = out.result.output as FetchUrlOutput;
      ledger.addVisited(`https://${domain}/`, page.finalUrl, ...page.redirects);
      return { ok: true };
    }
    const e = toolError(out);
    return DOMAIN_ALIVE_CODES.has(e.code) ? { ok: true } : { ok: false, code: e.code };
  };

  type ProfileInfo = NonNullable<ExhibitorResult['profile']>;

  /** Opens the exhibitor's profile linked from the list page and returns its verified website, if any. */
  const lookupProfile = async (exhibitor: ExhibitorInput, listPage: ScoutPage, fairDomains: string[]): Promise<{ info: ProfileInfo; domain: string | null; profileUrl: string | null }> => {
    const none = (info: ProfileInfo) => ({ info, domain: null, profileUrl: null });
    const url = findProfileLink(exhibitor.name, listPage);
    if (!url) return none({ url: null, status: 'no_profile_link' });
    if (profileLookups >= maxProfileLookups) return none({ url, status: 'budget_exhausted' });
    profileLookups += 1;
    let profile: ScoutPage | null = null;
    let via: 'fetch' | 'render' = 'fetch';
    let lastCode: string | null = null;
    const host = hostOf(url);
    // A static profile is read with fetch_url; a JavaScript app (shell, or a host already known as one) is rendered.
    if (!host || !jsAppHosts.has(host)) {
      const key = normalizeUrl(url);
      const cached = key ? pageCache.get(key) : undefined;
      const f: PageRead = cached ? { ok: true, page: cached } : await fetchUncounted(url);
      if (f.ok && !(f.page.js_app_likely && f.page.text.trim().length < EMPTY_SHELL_CHARS)) profile = f.page;
      else if (!f.ok) lastCode = f.code;
    }
    if (!profile) {
      via = 'render';
      const r = await renderPage(url, { profile: true });
      if (!r.ok) return none({ url, status: 'profile_unreadable', via, error: lastCode ? `${r.code} (fetch: ${lastCode})` : r.code });
      profile = r.page;
    }
    if (!profileMatchesExhibitor(exhibitor.name, profile.text)) return none({ url, status: 'profile_mismatch', via });
    const w = extractProfileWebsite(profile, fairDomains);
    const social = Object.keys(w.social).length > 0 ? { social: w.social } : {};
    if (!w.domain) return none({ url, status: w.candidates.length > 1 ? 'website_ambiguous' : 'no_website', via, ...social });
    const check = await checkDomain(w.domain);
    if (!check.ok) return none({ url, status: 'domain_rejected', via, domain: w.domain, error: check.code, ...social });
    domainsResolved += 1;
    return { info: { url: profile.finalUrl, status: 'domain_resolved', via, domain: w.domain, domain_source: w.source ?? 'unknown', ...social }, domain: w.domain, profileUrl: profile.finalUrl };
  };

  // ------------------------------------------------------------- a) candidates
  const candidates: Candidate[] = [];
  const discarded: Array<{ name: string; reason: string; url?: string | null }> = [];
  let searchInfo: { queries: string[]; sources: number; proposed: number; verification: 'grounding_sources' | 'fetch_corroboration' | 'none' } | null = null;
  let searchFailed: { code: string; message: string } | null = null;

  if (input.event_url) {
    // Operator-provided URL: fetched directly (still subject to the fetch_url SSRF guard).
    candidates.push({ name: input.event_name ?? null, start_date: null, end_date: null, city: null, website_url: input.event_url, exhibitors_url: null, origin: 'input' });
  } else {
    const search = await run.completeJson({
      label: { step: 'scout_search', sector: input.sector, region: input.region },
      system: SCOUT_SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildEventSearchPrompt({ sector: input.sector!, region: input.region, today, until, maxEvents }) }],
      parse: (text) => parseWith(SearchAnswer, text),
      grounding: true,
      repair: (previous, error) => [{ role: 'user', content: buildSearchRepairPrompt(previous, error) }],
    });
    const grounding = search.status === 'model_error' ? undefined : search.grounding;
    if (grounding) ledger.addGrounding(grounding.sources);
    if (search.status === 'model_error') searchFailed = { code: search.code, message: search.message };
    else if (search.status === 'invalid') searchFailed = { code: 'LLM_INVALID_OUTPUT', message: search.message };
    else {
      const hasSources = (grounding?.sources.length ?? 0) > 0;
      // Observed 2026-10-07: gemini-3.8-flash runs the searches but may return no sources.
      const searched = (grounding?.queries.length ?? 0) > 0 || (grounding?.diagnostics?.toolCalls ?? 0) > 0;
      const corroborate = !hasSources && searched && cfg.verifyUnsourcedByFetch;
      searchInfo = {
        queries: grounding?.queries ?? [],
        sources: grounding?.sources.length ?? 0,
        proposed: search.value.events.length,
        verification: hasSources ? 'grounding_sources' : corroborate ? 'fetch_corroboration' : 'none',
      };
      if (!hasSources && !corroborate) {
        partialReasons.push(
          searched
            ? 'la búsqueda no devolvió fuentes de grounding y la verificación por descarga está desactivada: ninguna feria se puede verificar'
            : 'el modelo no ejecutó ninguna búsqueda: ninguna feria se puede verificar',
        );
        for (const e of search.value.events) discarded.push({ name: e.name, reason: searched ? 'sin_fuentes_de_grounding' : 'sin_busqueda', url: e.website_url });
      } else {
        for (const e of search.value.events) {
          const start = isoDate(e.start_date);
          const end = isoDate(e.end_date) ?? start;
          if ((end && end < today) || (start && start > until)) {
            discarded.push({ name: e.name, reason: 'fuera_del_horizonte', url: e.website_url });
            continue;
          }
          candidates.push({
            name: e.name,
            start_date: start,
            end_date: isoDate(e.end_date),
            city: e.city,
            website_url: e.website_url,
            exhibitors_url: e.exhibitors_url,
            origin: hasSources ? 'grounding' : 'search_unsourced',
          });
        }
      }
    }
  }

  /** Only URLs whose domain is backed by grounding are fetched (resolving grounding redirects if needed). */
  const groundedUrl = async (url: string | null): Promise<string | null> => {
    if (!url || !normalizeUrl(url)) return null;
    if (ledger.isGroundedDomain(url) || ledger.isGroundedUri(url) || ledger.isVisited(url)) return url;
    for (const s of ledger.sourcesWithoutDomain()) {
      if (redirectResolutions >= cfg.maxRedirectResolutions) break;
      if (ledger.isVisited(s.uri)) continue;
      redirectResolutions += 1;
      const r = await fetchPage(s.uri);
      if (r.ok) ledger.addGroundedDomainFromUrl(r.page.finalUrl);
      if (ledger.isGroundedDomain(url)) return url;
    }
    return ledger.isGroundedDomain(url) ? url : null;
  };

  // --------------------------------------------------- b) + c) + d) per event
  const events: ScoutEventResult[] = [];
  for (const cand of candidates) {
    if (events.length >= maxEvents) break;
    run.ctx.signal.throwIfAborted();
    const usable = (u: string | null) => (u && normalizeUrl(u) ? u : null);
    const exhibitorsUrl =
      cand.origin === 'input' ? null : cand.origin === 'search_unsourced' ? usable(cand.exhibitors_url) : await groundedUrl(cand.exhibitors_url);
    const websiteUrl =
      cand.origin === 'input' ? cand.website_url : cand.origin === 'search_unsourced' ? usable(cand.website_url) : await groundedUrl(cand.website_url);
    if (!exhibitorsUrl && !websiteUrl) {
      discarded.push({ name: cand.name ?? '(sin nombre)', reason: 'url_no_respaldada_por_grounding', url: cand.website_url ?? cand.exhibitors_url });
      continue;
    }
    const ev: ScoutEventResult = {
      name: cand.name ?? '',
      date: cand.start_date,
      end_date: cand.end_date,
      location: cand.city,
      website_url: websiteUrl,
      exhibitors_url: exhibitorsUrl,
      source_url: null,
      status: 'unreachable',
      verification: cand.origin === 'input' ? 'operator_url' : cand.origin === 'grounding' ? 'grounding_domain' : 'fetch_corroboration',
      pages: [],
      exhibitors_extracted: 0,
      exhibitors_dropped: [],
      domains_removed: 0,
      catalog_pages: 0,
      results: [],
    };
    events.push(ev);

    const queue = [...new Set([exhibitorsUrl, websiteUrl].filter((u): u is string => u !== null))];
    // Exhibitors per source page (static HTML, rendered page, PDF), deduplicated by name.
    const batches: Array<{ page: ScoutPage; exhibitors: ExhibitorInput[] }> = [];
    const seenNames = new Set<string>();
    let collected = 0;
    let lastPage: ScoutPage | null = null;
    // First page read (the corroborated / main page): cited by an event-level signal.
    let firstPage: ScoutPage | null = null;
    let lastNotes: string | null = null;
    let pagesRead = 0;
    let pdfsThisEvent = 0;
    let corroborationFailed = false;
    let renderBlocked: string | null = null;
    const triedPdfs = new Set<string>();

    /** One LLM extraction over one page; verified, new exhibitors are added to `batches`. */
    const extractFrom = async (page: ScoutPage, attempt: PageAttempt): Promise<{ added: number; next: string | null; kind: string | null }> => {
      const extract = await run.completeJson({
        label: { step: 'scout_extract', event: ev.name || cand.website_url, url: page.finalUrl, via: attempt.via },
        system: SCOUT_EXTRACT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildExtractPrompt({
              eventName: ev.name || '(desconocido)',
              pageUrl: page.finalUrl,
              pageTitle: page.title,
              text: page.text.slice(0, PAGE_TEXT_FOR_EXTRACTION),
              links: page.links.slice(0, 150),
              maxExhibitors,
              truncated: page.truncated,
              contentKind: page.content_kind,
            }),
          },
        ],
        parse: (text) => parseWith(ExtractAnswer, text),
        schema: EXTRACT_JSON_SCHEMA,
        // Up to ~60 exhibitors of a paginated list in one answer.
        maxTokens: 12_288,
      });
      if (extract.status !== 'ok') {
        attempt.code = extract.status === 'model_error' ? extract.code : 'LLM_INVALID_OUTPUT';
        return { added: 0, next: null, kind: null };
      }
      const x = extract.value;
      attempt.page_kind = x.page_kind;
      attempt.exhibitors_extracted = x.exhibitors.length;
      lastNotes = x.notes;
      // Event facts read in the page win over the search answer.
      if (x.event.name && !ev.name) ev.name = x.event.name;
      ev.date = isoDate(x.event.start_date) ?? ev.date;
      ev.end_date = isoDate(x.event.end_date) ?? ev.end_date;
      ev.location = x.event.city ?? ev.location;
      // Names must appear in THIS page's text, domains in its text or links.
      const verified = verifyExhibitors(x.exhibitors, page, maxExhibitors);
      ev.exhibitors_extracted += x.exhibitors.length;
      ev.exhibitors_dropped.push(...verified.dropped.slice(0, Math.max(0, 50 - ev.exhibitors_dropped.length)));
      ev.domains_removed += verified.domainsRemoved;
      const fresh = verified.exhibitors
        .filter((e) => {
          const k = foldText(e.name);
          if (seenNames.has(k)) return false;
          seenNames.add(k);
          return true;
        })
        .slice(0, Math.max(0, maxExhibitors - collected));
      attempt.exhibitors_verified = fresh.length;
      if (fresh.length > 0) {
        batches.push({ page, exhibitors: fresh });
        collected += fresh.length;
        if (page.content_kind !== 'pdf') {
          const listPages = page.pages_read ?? 1;
          ev.catalog_pages += listPages;
          if (listPages > 1) attempt.list_pages = listPages;
          listPage ??= { page, via: attempt.via === 'render' ? 'render' : 'fetch' };
        }
      }
      return { added: fresh.length, next: pickPageLink(x.exhibitors_page_url, page), kind: x.page_kind };
    };

    /** First list page that gave exhibitors (start of the link-based pagination). */
    let listPage: { page: ScoutPage; via: 'fetch' | 'render' } | null = null;

    /**
     * Link-based pagination ("next" / ?page=N / /page/N links) of the list, up to
     * max_catalog_pages, each page read the same way as the first (fetch or render).
     * Not used when the renderer already clicked through a client-side pagination.
     */
    const paginateList = async (): Promise<void> => {
      if (!listPage || (listPage.page.pages_read ?? 1) > 1) return;
      const via = listPage.via;
      let current = listPage.page;
      let pages = 1;
      const read = new Set([normalizeUrl(current.finalUrl)]);
      while (pages < maxCatalogPages && collected < maxExhibitors) {
        const nextUrl = paginationLinks(current.links, current.finalUrl, (u) => read.has(normalizeUrl(u)) || ledger.isVisited(u))[0];
        if (!nextUrl) break;
        read.add(normalizeUrl(nextUrl));
        const pr = via === 'render' ? await renderPage(nextUrl, { paginate: false }) : await fetchPage(nextUrl);
        if (!pr.ok) {
          ev.pages.push({ url: nextUrl, via, status: 'error', code: pr.code, pagination: true });
          break;
        }
        const att = okAttempt(nextUrl, via, pr.page);
        att.pagination = true;
        const got = await extractFrom(pr.page, att);
        if (got.added === 0) break;
        pages += 1;
        current = pr.page;
      }
    };

    const okAttempt = (url: string, via: PageAttempt['via'], page: ScoutPage): PageAttempt => {
      const attempt: PageAttempt = { url, via, final_url: page.finalUrl, status: 'ok', chars: page.text.length, content_kind: page.content_kind };
      if (page.content_kind === 'html') attempt.js_app_likely = page.js_app_likely;
      ev.pages.push(attempt);
      return attempt;
    };

    while (queue.length > 0 && pagesRead < cfg.maxPagesPerEvent && collected === 0) {
      const url = queue.shift()!;
      const fetched = await fetchPage(url);
      if (!fetched.ok) {
        ev.pages.push({ url, via: 'fetch', status: 'error', code: fetched.code });
        continue;
      }
      const page = fetched.page;
      let rendered: ScoutPage | null = null;
      // Unsourced candidate: the first page read must corroborate the fair, or the candidate is dropped.
      // A JavaScript shell may only show the fair's name once rendered.
      if (cand.origin === 'search_unsourced' && pagesRead === 0) {
        let corroborated = pageCorroboratesEvent(cand.name ?? '', page);
        if (!corroborated && page.js_app_likely) {
          const r = await renderPage(url);
          if (r.ok) {
            rendered = r.page;
            corroborated = pageCorroboratesEvent(cand.name ?? '', rendered);
          }
        }
        if (!corroborated) {
          const seen = rendered ?? page;
          ev.pages.push({ url, via: rendered ? 'render' : 'fetch', final_url: seen.finalUrl, status: 'error', code: 'NOT_CORROBORATED', chars: seen.text.length });
          corroborationFailed = true;
          break;
        }
      }
      pagesRead += 1;
      lastPage = page;
      firstPage ??= page;

      // (a) The downloaded page itself (HTML, text or PDF). An empty JS shell is not worth an LLM call.
      const attempt = okAttempt(url, 'fetch', page);
      let r: { added: number; next: string | null; kind: string | null } = { added: 0, next: null, kind: null };
      if (page.js_app_likely && page.text.trim().length < EMPTY_SHELL_CHARS) attempt.code = 'JS_APP_SHELL';
      else r = await extractFrom(page, attempt);
      let next = r.next;

      // (b) Render with a browser: JS app, or no exhibitors and no exhibitor link to follow first.
      const wantRender = page.content_kind === 'html' && collected === 0 && (page.js_app_likely || r.kind === 'exhibitor_list' || !next);
      if (wantRender) {
        const rr: PageRead = rendered ? { ok: true, page: rendered } : await renderPage(url);
        if (rr.ok) {
          rendered = rr.page;
          lastPage = rendered;
          const renderAttempt = okAttempt(url, 'render', rendered);
          if (rendered.text.trim().length < EMPTY_SHELL_CHARS) {
            // Still empty after the retry: nothing to extract (and no LLM call to pay for).
            renderAttempt.code = 'RENDER_EMPTY';
            renderBlocked ??= 'RENDER_EMPTY';
          } else {
            const r2 = await extractFrom(rendered, renderAttempt);
            next ??= r2.next;
          }
        } else {
          renderBlocked ??= rr.code === 'RENDER_DISABLED' ? rr.message : rr.code;
          if (rr.code !== 'RENDER_DISABLED') ev.pages.push({ url, via: 'render', status: 'error', code: rr.code });
        }
      }

      // (b2) Next pages of the list (link-based pagination; client-side pagination was done by the renderer).
      await paginateList();

      // (c) Catalog / exhibitor-list PDFs linked from the page (static or rendered).
      if (collected < maxExhibitors && pdfsThisEvent < cfg.maxPdfsPerEvent) {
        const pdfLinks = catalogPdfLinks(
          [...page.links, ...(rendered?.links ?? [])],
          (u) => ledger.isVisited(u) || triedPdfs.has(normalizeUrl(u) ?? u),
          cfg.maxPdfsPerEvent - pdfsThisEvent,
        );
        for (const pdfUrl of pdfLinks) {
          triedPdfs.add(normalizeUrl(pdfUrl) ?? pdfUrl);
          pdfsThisEvent += 1;
          const pdf = await fetchPage(pdfUrl);
          if (!pdf.ok) {
            ev.pages.push({ url: pdfUrl, via: 'pdf', status: 'error', code: pdf.code });
            continue;
          }
          if (pdf.page.content_kind !== 'pdf') {
            ev.pages.push({ url: pdfUrl, via: 'pdf', final_url: pdf.page.finalUrl, status: 'error', code: 'NOT_A_PDF' });
            continue;
          }
          pdfsRead += 1;
          lastPage = pdf.page;
          await extractFrom(pdf.page, okAttempt(pdfUrl, 'pdf', pdf.page));
          if (collected >= maxExhibitors) break;
        }
      }

      if (next && !ledger.isVisited(next) && !queue.includes(next)) queue.unshift(next);
    }
    if (!ev.name) ev.name = lastPage?.title?.slice(0, 255) ?? hostOf(websiteUrl ?? exhibitorsUrl ?? '') ?? 'Feria sin nombre';
    if (corroborationFailed) {
      // Nothing is written for it: the page does not prove the fair the model named.
      events.pop();
      discarded.push({ name: ev.name, reason: 'pagina_no_corrobora_la_feria', url: websiteUrl ?? exhibitorsUrl });
      continue;
    }

    if (batches.length > 0) {
      ev.status = 'exhibitors_processed';
      ev.source_url = batches[0]!.page.finalUrl;
      // 1. LLM evaluation of EVERY exhibitor first (no CRM write yet).
      const items: Array<{ event: ProspectorEvent; page: ScoutPage; exhibitor: ExhibitorInput; decided: DecidedExhibitor; evidence: Array<{ claim: string; sourceUrl?: string }> }> = [];
      for (const batch of batches) {
        // Each exhibitor cites the page (HTML, rendered page or PDF) it was read from.
        const event: ProspectorEvent = {
          name: ev.name.slice(0, 255),
          type: 'FAIR',
          ...(ev.date ? { date: ev.date } : {}),
          ...(ev.location ? { location: ev.location.slice(0, 255) } : {}),
          source_url: batch.page.finalUrl,
        };
        for (const exhibitor of batch.exhibitors) {
          run.ctx.signal.throwIfAborted();
          items.push({ event, page: batch.page, exhibitor, decided: await decideExhibitor(run, event, exhibitor, { today, system }), evidence: [] });
        }
      }
      // 2. Profiles ONLY of the relevant exhibitors without a domain, best confidence first, up to the run budget.
      const fairDomains = fairDomainsOf(ev);
      const needDomain = items
        .filter((it) => it.decided.writable && !normalizeDomain(it.exhibitor.domain))
        .sort((a, b) => (b.decided.result.confidence ?? 0) - (a.decided.result.confidence ?? 0));
      for (const it of needDomain) {
        run.ctx.signal.throwIfAborted();
        const found = await lookupProfile(it.exhibitor, it.page, fairDomains);
        it.decided.result.profile = found.info;
        if (found.domain) {
          it.exhibitor = { ...it.exhibitor, domain: found.domain };
          it.evidence.push({ claim: `Web ${found.domain} tomada de la ficha del expositor en el catálogo de la feria.`, ...(found.profileUrl ? { sourceUrl: found.profileUrl } : {}) });
        }
      }
      // 3. CRM writes (same pipeline as before; still no domain: skipped_no_domain).
      for (const it of items) {
        run.ctx.signal.throwIfAborted();
        ev.results.push(
          it.decided.writable ? await writeExhibitor(run, it.event, it.exhibitor, it.decided, { today, system, ledger, extraEvidence: it.evidence }) : it.decided.result,
        );
      }
      continue;
    }

    // No exhibitor list: event-level FAIR signal with a visited URL.
    const okPages = ev.pages.filter((p) => p.status === 'ok').length;
    // Assigned inside extractFrom (closure): TS narrows it to null otherwise.
    const notes = lastNotes as string | null;
    const why = lastPage
      ? `sin lista de expositores legible en ${okPages} página(s) leída(s)${notes ? ` (${notes.slice(0, 200)})` : ''}${
          renderBlocked === 'RENDER_EMPTY'
            ? '; la página renderizada llegó vacía (la aplicación JavaScript no cargó su contenido a tiempo)'
            : renderBlocked
              ? `; render JavaScript no disponible (${renderBlocked})`
              : ''
        }`
      : `ninguna página de la feria se pudo descargar (${ev.pages.map((p) => p.code).join(', ') || 'sin URL'})`;
    ev.reason = scrubUnknownUrls(why, ledger);
    partialReasons.push(`${ev.name}: ${ev.reason}`);
    if (!lastPage) continue;
    const sourceUrl = (firstPage ?? lastPage).finalUrl;
    if (!ledger.isKnownSource(sourceUrl)) {
      ev.status = 'event_signal_error';
      ev.error = { code: 'UNVERIFIED_SOURCE', message: `source_url ${sourceUrl} is not a known source` };
      continue;
    }
    ev.source_url = sourceUrl;
    const sig = await run.callTool('create_signal', {
      title: scrubUnknownUrls(`${ev.name} (feria)`, ledger).slice(0, 255),
      signalType: 'FAIR',
      description: scrubUnknownUrls(
        [
          `Feria detectada por el Prospector (modo scout)${input.sector ? ` para el sector "${input.sector}"` : ''}${input.region ? ` en ${input.region}` : ''}.`,
          ev.date ? `Fecha: ${ev.date}${ev.end_date && ev.end_date !== ev.date ? ` a ${ev.end_date}` : ''}.` : 'Fecha no confirmada.',
          ev.location ? `Lugar: ${ev.location}.` : '',
          `Sin expositores registrados: ${ev.reason}.`,
          ev.verification === 'fetch_corroboration' ? 'Fuente verificada por descarga (la búsqueda no devolvió fuentes de grounding).' : '',
          'Señal a nivel de evento: revisar manualmente la lista de expositores.',
        ]
          .filter(Boolean)
          .join(' '),
        ledger,
      ).slice(0, 4000),
      sourceUrl,
      ...(ev.date ? { eventDate: ev.date } : {}),
      confidence: cfg.eventSignalConfidence,
      status: 'NEW',
    });
    if (sig.result.status === 'ok') {
      ev.status = 'event_signal';
      ev.signal_id = (sig.result.output as { record: { id: string } }).record.id;
    } else {
      ev.status = 'event_signal_error';
      ev.error = toolError(sig);
    }
  }

  // ----------------------------------------------------------------- outcome
  const results = events.flatMap((e) => e.results);
  const counters = {
    ...exhibitorCounters(results),
    events_proposed: searchInfo?.proposed ?? candidates.length,
    events_verified: events.length,
    events_with_exhibitors: events.filter((e) => e.status === 'exhibitors_processed').length,
    event_signals: events.filter((e) => e.status === 'event_signal').length,
    events_discarded: discarded.length,
    fetches,
    renders,
    renders_ok: rendersOk,
    render_retries: renderRetries,
    pdfs_read: pdfsRead,
    catalog_pages: events.reduce((n, e) => n + e.catalog_pages, 0),
    profile_lookups: profileLookups,
    profile_renders: profileRenders,
    domain_checks: domainChecks,
    domains_resolved: domainsResolved,
    llm_calls: run.llmCalls,
    grounding_calls: run.groundingCalls,
    grounding_queries: searchInfo?.queries.length ?? 0,
  };
  const eventErrors = events.filter((e) => e.status === 'event_signal_error').length;
  const errors = counters.errors + eventErrors;
  if (events.length === 0 && !searchFailed) partialReasons.push('no se encontró ninguna feria verificable dentro del horizonte');
  let outcome: RunOutcome;
  if (searchFailed) outcome = 'FAILED';
  else if (results.length > 0 && counters.errors === results.length && counters.event_signals === 0) outcome = 'FAILED';
  else if (errors > 0 || partialReasons.length > 0) outcome = 'PARTIAL';
  else outcome = 'SUCCESS';

  const groundingEur = run.currency === 'EUR' ? round6(run.groundingCost) : round6(run.groundingCost * run.cfg.usdToEur);
  const lines: string[] = [
    input.event_url
      ? `Modo scout sobre ${input.event_url}.`
      : `Modo scout: sector "${input.sector}", ${input.region}, próximos ${input.horizon_months} meses (hasta ${until}).`,
    ...(searchFailed ? [`Búsqueda fallida: ${searchFailed.code}.`] : []),
    ...(searchInfo
      ? [`Búsqueda con Google (grounding): ${searchInfo.queries.length} consultas, ${searchInfo.sources} fuentes; ferias propuestas: ${searchInfo.proposed}, verificadas: ${events.length}, descartadas: ${discarded.length}.`]
      : []),
    ...events.flatMap((e) => [
      `Feria: ${e.name}${e.date ? ` (${e.date})` : ''}${e.location ? `, ${e.location}` : ''} — ${
        e.status === 'exhibitors_processed'
          ? `${e.results.length} expositores evaluados desde ${e.source_url}`
          : e.status === 'event_signal'
            ? `señal de evento creada (${e.reason})`
            : `sin registrar (${e.reason ?? e.error?.code ?? 'error'})`
      }.`,
      ...e.results.map(resultLine),
    ]),
    `Páginas de catálogo leídas: ${counters.catalog_pages}; fichas de expositor abiertas: ${profileLookups} (de ${maxProfileLookups} posibles), dominios obtenidos de la ficha: ${domainsResolved}.`,
    `Totales: relevantes ${counters.relevant}, hipótesis nuevas ${counters.hypotheses_created}, ya existentes ${counters.hypotheses_existing}, descartados ${counters.discarded_irrelevant + counters.discarded_low_confidence}, sin dominio verificado ${counters.skipped_no_domain}, errores ${errors}.`,
    `Coste del modelo: ${formatEur(run.costEur())} (${run.llmCalls} llamadas, ${run.groundingCalls} con búsqueda: ${formatEur(groundingEur)} de búsqueda; ${run.usage.inputTokens} tokens de entrada y ${run.usage.outputTokens} de salida).`,
    ...(partialReasons.length > 0 ? [`Motivos: ${partialReasons.join(' | ')}`] : []),
  ];

  return {
    outcome,
    lines,
    output: {
      mode: 'scout',
      input,
      ...(searchFailed ? { search_error: searchFailed } : {}),
      ...(searchInfo ? { search: searchInfo } : {}),
      events,
      discarded_events: discarded,
      counters: { ...counters, errors },
      results,
      partial_reasons: partialReasons,
      sources: ledger.snapshot(),
      render: { calls: renders, ok: rendersOk, retries: renderRetries, max: cfg.maxRenders, catalog_calls: catalogRenders, profile_calls: profileRenders, disabled: renderOff },
      profiles: { lookups: profileLookups, max: maxProfileLookups, domains_resolved: domainsResolved, domain_checks: domainChecks, max_catalog_pages: maxCatalogPages },
      errors_by_status: ERROR_STATUSES.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: results.filter((r) => r.status === s).length }), {}),
    },
  };
}
