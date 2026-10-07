/**
 * Headless Chromium renderer (Playwright).
 *
 * Isolation per request: a NEW browser context (no cookies, storage or cache shared
 * between requests), closed in `finally`. At most `maxConcurrency` (2) renders run at
 * once; a few more wait in a short queue, the rest get RENDERER_BUSY.
 *
 * Network: EVERY request of the page goes through `context.route` and is served by
 * `egress.ts` (URL rules + public-IP DNS check + pinned connection) with
 * `route.fulfill`. Images, media and fonts are aborted (only text is needed).
 * WebSockets are closed (`routeWebSocket`), service workers are blocked, downloads are
 * refused, popups and dialogs are closed. Chromium itself is launched with a dead proxy
 * (127.0.0.1:9, loopback included) so any request that escaped interception fails
 * instead of reaching the network, and without UDP WebRTC.
 *
 * Time: a 25 s budget for navigation + JavaScript + waits; the context is force-closed
 * when it runs out.
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import {
  checkTarget,
  deliverableResponseHeaders,
  forwardableRequestHeaders,
  nodeTransport,
  RENDER_USER_AGENT_SUFFIX,
  systemResolver,
  type EgressDeps,
  type EgressResponse,
} from './egress.js';
import { hostPolicyFromEnv } from './ip-guard.js';

export const RENDER_JS_TIMEOUT_MS = 25_000;
export const RENDER_MAX_CHARS = 40_000;
export const RENDER_DEFAULT_WAIT_MS = 2_500;
export const RENDER_MAX_WAIT_MS = 10_000;
const MAX_LINKS = 300;
const MAX_REQUESTS = 400;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'manifest', 'texttrack', 'eventsource', 'websocket', 'beacon', 'ping', 'cspviolationreport']);
/** Dead proxy for Chromium's own network stack (nothing listens on the discard port). */
export const DEAD_PROXY = 'http://127.0.0.1:9';

export type WaitUntil = 'domcontentloaded' | 'load' | 'networkidle';
export const WAIT_UNTIL: readonly WaitUntil[] = ['domcontentloaded', 'load', 'networkidle'];
export const RENDER_DEFAULT_MIN_TEXT_CHARS = 200;
export const RENDER_MAX_MIN_TEXT_CHARS = 5_000;
/** Interval of the hydration check (visible text length sampled until it is stable). */
const SETTLE_POLL_MS = 700;

export interface RenderRequest {
  url: string;
  waitMs?: number;
  maxChars?: number;
  /**
   * Hydration: keep waiting (within the 25 s budget) while the visible text is shorter
   * than this, and until it stops growing between two samples. 0 = only `waitMs`.
   */
  minTextChars?: number;
  /** Load state awaited after navigation before the hydration wait (default `domcontentloaded`). */
  waitUntil?: WaitUntil;
  /**
   * Client-side pagination (catalogs whose "next" control is a button, not a link):
   * read up to this many pages, clicking the page's "next" control between reads
   * (1 = no clicks). The text of pages 2+ is appended without the header and footer it
   * shares with page 1, after a `[Página N del listado]` marker.
   */
  maxPages?: number;
}

export interface RenderResult {
  text: string;
  title: string | null;
  links: Array<{ url: string; text: string }>;
  final_url: string;
  status: number | null;
  truncated: boolean;
  render_ms: number;
  /** Requests of the page refused by the egress guard (private IPs, bad schemes...). */
  blocked_requests: number;
  /** Time spent waiting for the app to hydrate (visible text >= min_text_chars and stable). */
  hydration_ms: number;
  /** False when the budget ran out before the text reached min_text_chars / stopped growing. */
  hydrated: boolean;
  /** Pages read (1 unless `max_pages` > 1 and a "next" control was found and changed the page). */
  pages_read: number;
  /** URL of each page read (the same URL repeated for client-side pagination). */
  page_urls: string[];
}

export const RENDER_MAX_PAGES = 5;
/** Time kept to read a page after a click (the read itself needs ~1-2 s). */
const PAGE_READ_RESERVE_MS = 3_500;
/** Wait for the list to change after clicking "next". */
const PAGE_CHANGE_TIMEOUT_MS = 6_000;

/**
 * Marks (data-pxos-next) the most likely "next page" control of the page, or returns
 * false. Runs inside the page. Pagination containers, rel=next, "Siguiente"/"Next"
 * texts or labels and arrow icons (fa-arrow-right, mdi-chevron-right...) score;
 * "last"/"double" arrows, disabled controls, carousels and links to other origins are
 * never chosen. Exported for tests.
 */
export function markNextControl(): boolean {
  // No named helper functions in here: the dev build (tsx/esbuild keepNames) wraps them in
  // __name(), which does not exist inside the page.
  for (const el of Array.from(document.querySelectorAll('[data-pxos-next]'))) el.removeAttribute('data-pxos-next');
  const WORD = /^(siguiente|next|next page|página siguiente|pagina siguiente|suivant|weiter|avanti|seguinte|próxima|proxima)$/i;
  const SYMBOL = /^(›|»|>|>>|→|⟩|❯|▶|►)$/;
  const ICON = /(^|[-_])(arrow-right|chevron-right|angle-right|caret-right|arrow-forward|arrow-forward-ios|navigate-next|keyboard-arrow-right|right-arrow|next)$/i;
  const OWN_NEXT = /(^|[-_])(next|siguiente)([-_]|$)/i;
  const BAD = /(^|[-_\s])(last|double|end|first|prev|previous|back|left|to-right|último|ultimo|primero|primera|anterior)([-_\s]|$)/i;
  const CAROUSEL = /(swiper|slick|carousel|slider|glide|splide|owl-|flickity|tns-)/i;
  const PAGER = /(paginat|pager|paging|pagina)/i;
  let best: HTMLElement | null = null;
  let bestScore = 0;
  const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]')).slice(0, 3000);
  for (const node of candidates) {
    const el = node as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/i.test((el.getAttribute('class') ?? ''))) continue;
    if (el.parentElement && /\bdisabled\b/i.test((el.parentElement.getAttribute('class') ?? ''))) continue;
    let carousel = false;
    for (let a: Element | null = el; a; a = a.parentElement) if (CAROUSEL.test((a.getAttribute('class') ?? ''))) carousel = true;
    if (carousel) continue;
    // A real link (not "#" / javascript:) navigates: only inside a pager or with rel=next, and never off-site.
    let navigates = false;
    if (el instanceof HTMLAnchorElement && el.getAttribute('href') && !/^\s*(#|javascript:)/i.test(el.getAttribute('href') ?? '')) {
      try {
        if (new URL(el.href).origin !== location.origin) continue;
      } catch {
        continue;
      }
      navigates = true;
    }
    const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim();
    const text = (el.innerText ?? '').trim();
    const ownTokens = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const iconTokens = Array.from(el.querySelectorAll('i,svg,span,use,img'))
      .slice(0, 6)
      .flatMap((n) => (n.getAttribute('class') ?? '').split(/\s+/))
      .filter(Boolean);
    if ([label, text, ...ownTokens, ...iconTokens].some((t) => BAD.test(t) && !WORD.test(t))) continue;
    let score = 0;
    if ((el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('next')) score += 3;
    if (WORD.test(label) || WORD.test(text)) score += 3;
    else if (SYMBOL.test(label) || (text.length <= 3 && SYMBOL.test(text))) score += 1;
    if (ownTokens.some((t) => OWN_NEXT.test(t))) score += 2;
    if (iconTokens.some((t) => ICON.test(t))) score += 1;
    if (score === 0) continue;
    let pager = false;
    for (let a: Element | null = el.parentElement, depth = 0; a && depth < 6; a = a.parentElement, depth++) {
      if (PAGER.test((a.getAttribute('class') ?? '')) || PAGER.test(a.getAttribute('aria-label') ?? '') || a.getAttribute('role') === 'navigation' || a.tagName === 'NAV') pager = true;
    }
    if (pager) score += 2;
    else if (navigates && !(el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('next')) continue;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (!best || bestScore < 3) return false;
  best.setAttribute('data-pxos-next', '1');
  return true;
}

/** Lines of `next` without the leading and trailing lines it shares with `first` (header, filters, footer). */
export function stripSharedFrame(first: string, next: string): string {
  const a = first.split('\n');
  const b = next.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return b.slice(start, b.length - end).join('\n').trim();
}

/** Deduplicates links by URL, keeping the first non-empty text (a logo link and a name link often share the URL). */
export function mergeLinks(links: Array<{ url: string; text: string }>, max: number): Array<{ url: string; text: string }> {
  const byUrl = new Map<string, { url: string; text: string }>();
  for (const l of links) {
    let key: string;
    try {
      const u = new URL(l.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      key = u.toString();
    } catch {
      continue;
    }
    if (key.length > 2048) continue;
    const seen = byUrl.get(key);
    if (seen) {
      if (!seen.text && l.text) seen.text = l.text;
      continue;
    }
    if (byUrl.size >= max) continue;
    byUrl.set(key, { url: key, text: l.text });
  }
  return [...byUrl.values()];
}

export class RenderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface RendererOptions {
  egress?: Partial<EgressDeps>;
  maxConcurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  jsTimeoutMs?: number;
  /** Launch options override (tests); the proxy and security flags are always applied. */
  headless?: boolean;
  /**
   * Chromium's own sandbox. Off by default (Playwright's default; in Docker it needs the
   * Playwright seccomp profile or extra capabilities). RENDER_CHROMIUM_SANDBOX=true.
   */
  chromiumSandbox?: boolean;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Text, title and links of the page and its frames, read inside the page. */
function readPage(maxChars: number): { title: string; text: string; links: Array<{ url: string; text: string }>; frames: string[] } {
  // Elements hidden from people are a classic prompt-injection carrier: drop them.
  for (const el of Array.from(document.querySelectorAll('script,style,noscript,template,[hidden]'))) el.remove();
  // aria-hidden: dropped when it is a snippet, NOT when it wraps a big part of the page
  // (Vue/Vuetify, MUI... set aria-hidden="true" on the whole app while a dialog, such
  // as a cookie banner, is open; dropping it left the render empty). Text that people
  // cannot see (display:none, visibility:hidden) is already excluded by innerText.
  const total = (document.body?.innerText ?? '').length || 1;
  for (const el of Array.from(document.querySelectorAll('[aria-hidden="true"]'))) {
    if (el.isConnected && ((el as HTMLElement).innerText ?? '').length < total * 0.3) el.remove();
  }
  const body = document.body as HTMLElement | null;
  const text = (body?.innerText ?? document.documentElement?.textContent ?? '').slice(0, maxChars + 1000);
  const links: Array<{ url: string; text: string }> = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 2000)) {
    const href = (a as HTMLAnchorElement).href;
    if (!/^https?:/i.test(href)) continue;
    links.push({ url: href, text: ((a as HTMLElement).innerText || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  }
  const frames = Array.from(document.querySelectorAll('iframe[src]'))
    .map((f) => (f as HTMLIFrameElement).src)
    .filter((s) => /^https?:/i.test(s));
  return { title: document.title, text, links, frames };
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v  -​  　]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}
  get stats() {
    return { active: this.active, queued: this.waiting.length };
  }
  async acquire(timeoutMs: number): Promise<() => void> {
    const release = () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
    if (this.active < this.max) {
      this.active += 1;
      return release;
    }
    if (this.waiting.length >= this.maxQueue) throw new RenderError('RENDERER_BUSY', `${this.active} renders running and ${this.waiting.length} queued`, 503);
    return new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        this.active += 1;
        resolve(release);
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new RenderError('RENDERER_BUSY', `waited ${timeoutMs} ms for a render slot`, 503));
      }, timeoutMs);
      this.waiting.push(grant);
    });
  }
}

export class Renderer {
  private browser: Promise<Browser> | null = null;
  private readonly slots: Semaphore;
  readonly egress: EgressDeps;
  private readonly jsTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly opts: RendererOptions = {}) {
    this.egress = {
      resolver: opts.egress?.resolver ?? systemResolver,
      transport: opts.egress?.transport ?? nodeTransport,
      policy: opts.egress?.policy ?? hostPolicyFromEnv(),
    };
    this.slots = new Semaphore(opts.maxConcurrency ?? 2, opts.maxQueue ?? 4);
    this.jsTimeoutMs = opts.jsTimeoutMs ?? RENDER_JS_TIMEOUT_MS;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 30_000;
    this.log = opts.log ?? (() => undefined);
  }

  get stats() {
    return this.slots.stats;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launching = chromium.launch({
        headless: this.opts.headless ?? true,
        chromiumSandbox: this.opts.chromiumSandbox ?? process.env.RENDER_CHROMIUM_SANDBOX === 'true',
        // Second barrier: anything not served through route.fulfill hits a dead proxy.
        proxy: { server: DEAD_PROXY, bypass: '<-loopback>' },
        args: [
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-quic',
          '--dns-prefetch-disable',
          '--no-pings',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-sync',
          '--metrics-recording-only',
          '--no-first-run',
          '--disable-dev-shm-usage',
        ],
      });
      this.browser = launching;
      launching.then(
        (b) => b.on('disconnected', () => {
          if (this.browser === launching) this.browser = null;
        }),
        () => {
          if (this.browser === launching) this.browser = null;
        },
      );
    }
    return this.browser;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b).close().catch(() => undefined);
  }

  /** Validates the target BEFORE any browser work (same rules as fetch_url). */
  async validate(url: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RenderError('INVALID_URL', 'URL could not be parsed', 400);
    }
    const verdict = await checkTarget(parsed, this.egress);
    if (!verdict.ok) throw new RenderError(verdict.code, verdict.reason, verdict.code === 'DNS_ERROR' ? 422 : 400);
    parsed.hash = '';
    return parsed;
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const target = await this.validate(req.url);
    const release = await this.slots.acquire(this.queueTimeoutMs);
    try {
      return await this.renderValidated(target, req);
    } finally {
      release();
    }
  }

  private async renderValidated(target: URL, req: RenderRequest): Promise<RenderResult> {
    const maxChars = Math.min(Math.max(req.maxChars ?? RENDER_MAX_CHARS, 500), RENDER_MAX_CHARS);
    const waitMs = Math.min(Math.max(req.waitMs ?? RENDER_DEFAULT_WAIT_MS, 0), RENDER_MAX_WAIT_MS);
    const minTextChars = Math.min(Math.max(req.minTextChars ?? RENDER_DEFAULT_MIN_TEXT_CHARS, 0), RENDER_MAX_MIN_TEXT_CHARS);
    const waitUntil: WaitUntil = req.waitUntil && WAIT_UNTIL.includes(req.waitUntil) ? req.waitUntil : 'domcontentloaded';
    const maxPages = Math.min(Math.max(Math.floor(req.maxPages ?? 1), 1), RENDER_MAX_PAGES);
    // Launching Chromium (cold start: seconds in a container) is not part of the JS budget.
    const browser = await this.getBrowser();
    const started = Date.now();
    const deadline = started + this.jsTimeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36 ${RENDER_USER_AGENT_SUFFIX}`;
    const abort = new AbortController();
    const preTimer = setTimeout(() => abort.abort(), this.jsTimeoutMs);
    // Main document first, outside the browser: resolves its redirects hop by hop through
    // the guard, so the page is opened at its real URL (relative links resolve correctly).
    let pre: Awaited<ReturnType<Renderer['fetchFollowing']>>;
    try {
      pre = await this.fetchFollowing(
        target,
        {
          method: 'GET',
          headers: forwardableRequestHeaders({ accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'es-ES,es;q=0.9,en;q=0.6' }, userAgent),
          body: null,
        },
        abort.signal,
      );
    } catch (err) {
      clearTimeout(preTimer);
      if (abort.signal.aborted) throw new RenderError('RENDER_TIMEOUT', `navigation exceeded ${this.jsTimeoutMs} ms`, 504);
      throw new RenderError('NAVIGATION_FAILED', (err instanceof Error ? err.message : String(err)).slice(0, 300), 502);
    }
    clearTimeout(preTimer);
    if (!pre.ok) {
      if (pre.code === 'TOO_MANY_REDIRECTS') throw new RenderError('TOO_MANY_REDIRECTS', pre.reason, 502);
      throw new RenderError('NAVIGATION_BLOCKED', `a redirect points to a refused destination (${pre.reason})`, 400);
    }
    if (pre.res.status >= 400) throw new RenderError('HTTP_ERROR', `HTTP ${pre.res.status}`, 502);
    const navUrl = pre.url;
    const primed = new Map<string, EgressResponse>([[navUrl.toString(), pre.res]]);
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      bypassCSP: false,
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1366, height: 900 },
      userAgent,
      permissions: [],
    });
    let blocked = 0;
    let requests = 0;
    let bytes = 0;
    // Hard stop: whatever is still running when the budget is over is torn down.
    const killer = setTimeout(() => {
      abort.abort();
      void context.close().catch(() => undefined);
    }, this.jsTimeoutMs + 3_000);
    try {
      await context.routeWebSocket(/.*/, (ws) => {
        blocked += 1;
        ws.close({ code: 1008, reason: 'WebSockets are disabled in the renderer' });
      });
      await context.route('**/*', (route) => this.serve(route, { userAgent, signal: abort.signal, count: () => ++requests, addBytes: (n) => (bytes += n) <= MAX_TOTAL_BYTES, onBlocked: () => (blocked += 1), primed }));
      const page: Page = await context.newPage();
      page.on('popup', (p) => void p.close().catch(() => undefined));
      page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
      page.on('download', (d) => void d.cancel().catch(() => undefined));
      page.setDefaultTimeout(Math.max(1_000, remaining()));

      let status: number | null = null;
      try {
        const res = await page.goto(navUrl.toString(), { waitUntil: waitUntil === 'networkidle' ? 'domcontentloaded' : waitUntil, timeout: Math.max(1_000, remaining()) });
        status = res?.status() ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ERR_BLOCKED_BY_CLIENT/.test(msg)) throw new RenderError('NAVIGATION_BLOCKED', 'the page (or one of its redirects) points to a refused destination', 400);
        if (/Download is starting|ERR_ABORTED/.test(msg)) throw new RenderError('DOWNLOAD_BLOCKED', 'the URL is a download, not a page (use fetch_url for PDFs)', 422);
        if (/Timeout|timeout/.test(msg)) throw new RenderError('RENDER_TIMEOUT', `navigation exceeded ${this.jsTimeoutMs} ms`, 504);
        throw new RenderError('NAVIGATION_FAILED', msg.split('\n')[0]!.slice(0, 300), 502);
      }
      if (status !== null && status >= 400) throw new RenderError('HTTP_ERROR', `HTTP ${status}`, 502);

      // Let the app fetch its data: network idle (bounded; longer when asked for) and then the requested wait.
      await page.waitForLoadState('networkidle', { timeout: Math.min(waitUntil === 'networkidle' ? 15_000 : 8_000, remaining()) }).catch(() => undefined);
      if (remaining() > 0) await page.waitForTimeout(Math.min(waitMs, remaining()));
      // Hydration: SPA catalogs paint the header first and the list later (after an
      // anonymous login, a config call, the list call...). Sample the visible text until
      // it is long enough AND stable, keeping 2.5 s of the budget to read the page.
      const hydrationStarted = Date.now();
      let hydrated = minTextChars === 0;
      let previous = -1;
      while (!hydrated && remaining() > 2_500) {
        const length = await page.evaluate(() => (document.body?.innerText ?? '').trim().length).catch(() => 0);
        if (length >= minTextChars && length === previous) hydrated = true;
        else {
          previous = length;
          await page.waitForTimeout(Math.min(SETTLE_POLL_MS, remaining()));
        }
      }
      const hydrationMs = Date.now() - hydrationStarted;
      // Lazy lists: a few scrolls to the bottom while there is time left.
      for (let i = 0; i < 4 && remaining() > 2_500; i++) {
        const grew = await page
          .evaluate(() => {
            const before = document.body?.scrollHeight ?? 0;
            window.scrollTo(0, before);
            return before;
          })
          .catch(() => 0);
        await page.waitForTimeout(Math.min(700, remaining()));
        const after = await page.evaluate(() => document.body?.scrollHeight ?? 0).catch(() => 0);
        if (after <= grew) break;
      }

      const finalUrl = page.url();
      let final: URL;
      try {
        final = new URL(finalUrl);
      } catch {
        throw new RenderError('NAVIGATION_FAILED', 'the page ended on an unparseable URL', 502);
      }
      if (final.protocol !== 'http:' && final.protocol !== 'https:') throw new RenderError('NAVIGATION_FAILED', `the page ended on ${final.protocol}`, 502);

      const main = await withTimeout(page.evaluate(readPage, maxChars), Math.max(2_000, remaining() + 2_000), 'reading the page');
      let text = collapse(main.text);
      const links = [...main.links];
      // Same-document frames (catalog widgets embedded in an iframe): their text and URL.
      for (const frame of page.frames().slice(1, 6)) {
        if (text.length > maxChars || remaining() <= 0) break;
        const sub = await withTimeout(frame.evaluate(readPage, maxChars), 2_000, 'reading a frame').catch(() => null);
        if (!sub) continue;
        const subText = collapse(sub.text);
        if (subText) text += `\n\n${subText}`;
        links.push(...sub.links);
      }
      links.push(...main.frames.map((url) => ({ url, text: '(iframe)' })));
      final.hash = '';
      const pageUrls = [final.toString()];

      // Client-side pagination: click the "next" control, wait for the list to change, read again.
      const firstText = collapse(main.text);
      const seenTexts = new Set([firstText]);
      for (let n = 2; n <= maxPages && text.length < maxChars && remaining() > PAGE_READ_RESERVE_MS; n++) {
        const marked = await page.evaluate(markNextControl).catch(() => false);
        if (!marked) break;
        const before = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        // DOM click, not a pointer click: a fixed cookie banner over the pager must not block it.
        const clicked = await page
          .evaluate(() => {
            const el = document.querySelector('[data-pxos-next="1"]') as HTMLElement | null;
            el?.click();
            return el !== null;
          })
          .catch(() => false);
        if (!clicked) break;
        // Changed and stable (two equal samples), within the budget.
        const until = Date.now() + Math.min(PAGE_CHANGE_TIMEOUT_MS, Math.max(0, remaining() - PAGE_READ_RESERVE_MS));
        let changed = false;
        let previous: string | null = null;
        while (Date.now() < until) {
          await page.waitForTimeout(350);
          const now = await page.evaluate(() => document.body?.innerText ?? '').catch(() => null);
          if (now === null) continue; // navigating
          if (now !== before && now === previous) {
            changed = true;
            break;
          }
          previous = now;
        }
        if (!changed) break;
        const next = await withTimeout(page.evaluate(readPage, maxChars), Math.max(2_000, remaining() + 2_000), 'reading a page').catch(() => null);
        if (!next) break;
        const full = collapse(next.text);
        if (seenTexts.has(full)) break;
        seenTexts.add(full);
        const body = stripSharedFrame(firstText, full);
        if (!body) break;
        text += `\n\n[Página ${n} del listado]\n${body}`;
        links.push(...next.links);
        try {
          const u = new URL(page.url());
          u.hash = '';
          pageUrls.push(u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : final.toString());
        } catch {
          pageUrls.push(final.toString());
        }
      }
      const cleanLinks = mergeLinks(links, MAX_LINKS);
      const truncated = text.length > maxChars;
      return {
        text: truncated ? text.slice(0, maxChars) : text,
        title: collapse(main.title).replace(/\n+/g, ' ').slice(0, 300) || null,
        links: cleanLinks,
        final_url: final.toString(),
        status,
        truncated,
        render_ms: Date.now() - started,
        blocked_requests: blocked,
        hydration_ms: hydrationMs,
        hydrated,
        pages_read: pageUrls.length,
        page_urls: pageUrls,
      };
    } catch (err) {
      if (err instanceof RenderError) throw err;
      if (abort.signal.aborted || remaining() <= 0) throw new RenderError('RENDER_TIMEOUT', `render exceeded ${this.jsTimeoutMs} ms`, 504);
      throw new RenderError('RENDER_FAILED', (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300), 502);
    } finally {
      clearTimeout(killer);
      abort.abort();
      await context.close().catch(() => undefined);
      this.log('render finished', { host: target.hostname, path: target.pathname.slice(0, 120), ms: Date.now() - started, requests, blocked, bytes });
    }
  }

  /**
   * GET/POST through the guarded egress, FOLLOWING redirects here: Chromium does not
   * route the follow-up request of a fulfilled 3xx (observed with Playwright 1.63: it
   * goes to its own network stack, i.e. the dead proxy), so every hop is checked and
   * fetched by us. Cookies / Authorization are dropped when a hop changes origin.
   */
  async fetchFollowing(
    start: URL,
    init: { method: string; headers: Record<string, string>; body: Buffer | null },
    signal: AbortSignal,
  ): Promise<{ ok: true; res: EgressResponse; url: URL; hops: number } | { ok: false; code: string; reason: string }> {
    let url = start;
    let method = init.method;
    let body = init.body;
    let headers = { ...init.headers };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const verdict = await checkTarget(url, this.egress);
      if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
      const res = await this.egress.transport({ url, address: verdict.address, method, headers, body, maxBytes: MAX_RESPONSE_BYTES, signal });
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { ok: true, res, url, hops: hop };
        }
        next.hash = '';
        if ((res.status === 301 || res.status === 302 || res.status === 303) && method !== 'GET' && method !== 'HEAD') {
          method = 'GET';
          body = null;
        }
        if (next.origin !== url.origin) {
          const { cookie: _c, authorization: _a, ...rest } = headers;
          headers = rest;
        }
        url = next;
        continue;
      }
      return { ok: true, res, url, hops: hop };
    }
    return { ok: false, code: 'TOO_MANY_REDIRECTS', reason: `more than ${MAX_REDIRECTS} redirects` };
  }

  /** Serves one browser request through the guarded egress, or refuses it. */
  private async serve(
    route: Route,
    ctx: {
      userAgent: string;
      signal: AbortSignal;
      count: () => number;
      addBytes: (n: number) => boolean;
      onBlocked: () => void;
      /** Main document already fetched (redirects resolved) before page.goto: served once. */
      primed: Map<string, EgressResponse>;
    },
  ): Promise<void> {
    const request = route.request();
    const refuse = async (why?: string) => {
      ctx.onBlocked();
      if (why) this.log('request refused', { reason: why });
      await route.abort('blockedbyclient').catch(() => undefined);
    };
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    if (ctx.count() > MAX_REQUESTS) return refuse('request budget exhausted');
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return refuse('unparseable URL');
    }
    try {
      const primed = request.isNavigationRequest() ? ctx.primed.get(url.toString()) : undefined;
      let res: EgressResponse;
      if (primed) {
        ctx.primed.delete(url.toString());
        res = primed;
      } else {
        const out = await this.fetchFollowing(
          url,
          { method: request.method(), headers: forwardableRequestHeaders(await request.allHeaders(), ctx.userAgent), body: request.postDataBuffer() },
          ctx.signal,
        );
        if (!out.ok) return refuse(`${out.code}: ${out.reason}`);
        res = out.res;
      }
      if (!ctx.addBytes(res.body.length)) return refuse('byte budget exhausted');
      await route.fulfill({ status: res.status, headers: deliverableResponseHeaders(res.headers), body: res.body });
    } catch {
      await route.abort('failed').catch(() => undefined);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new RenderError('RENDER_TIMEOUT', `timed out ${what}`, 504)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

