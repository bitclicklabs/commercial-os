/**
 * Fake pxos-renderer for `render_url` tests: answers POST /render from a table of
 * canned results by URL. Nothing leaves the process.
 */
import type { RenderUrlDeps } from '../../src/tools/web/render-url.js';

export interface FakeRendered {
  text: string;
  title?: string | null;
  links?: Array<{ url: string; text: string }>;
  /** Defaults to the requested URL. */
  final_url?: string;
  status?: number;
  /**
   * Client-side pagination: pages 2+ of a list. Served only when the request asks for
   * `max_pages` > 1 (like pxos-renderer: appended after a `[Página N del listado]` marker).
   */
  nextPages?: Array<{ text: string; links?: Array<{ url: string; text: string }> }>;
  /** Simulates a renderer without pagination support (no pages_read / page_urls). */
  legacy?: boolean;
  /** JSON answers the page received: served only when the request asks for capture_json (like pxos-renderer 0.2). */
  json?: Array<{ url: string; method?: string; status?: number; body: unknown }>;
  /** Why the client-side pagination stopped (served with max_pages > 1). */
  paginationStop?: string;
}

type Entry = { kind: 'page'; page: FakeRendered } | { kind: 'raw'; status: number; body: unknown };

export class FakeRenderer {
  readonly entries = new Map<string, Entry[]>();
  /** Bodies POSTed to /render. */
  readonly requests: Array<Record<string, unknown>> = [];
  /** Called with each request body before answering (tests: advance a fake clock...). */
  onRequest: ((body: Record<string, unknown>) => void) | null = null;
  /** Answers INVALID_INPUT to max_pages above this (a renderer older than pxos-renderer 0.2: 5). */
  maxPagesAccepted = Infinity;

  page(url: string, page: FakeRendered): this {
    this.entries.set(url, [{ kind: 'page', page }]);
    return this;
  }

  /** Successive answers for the same URL (the last one repeats): e.g. an empty render, then a hydrated one. */
  sequence(url: string, ...pages: FakeRendered[]): this {
    this.entries.set(url, pages.map((page): Entry => ({ kind: 'page', page })));
    return this;
  }

  error(url: string, status: number, code: string, message = code): this {
    this.entries.set(url, [{ kind: 'raw', status, body: { error: { code, message } } }]);
    return this;
  }

  raw(url: string, status: number, body: unknown): this {
    this.entries.set(url, [{ kind: 'raw', status, body }]);
    return this;
  }

  deps(extra: Partial<RenderUrlDeps> = {}): RenderUrlDeps {
    const fakeFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.requests.push(body);
      this.onRequest?.(body);
      const list = this.entries.get(String(body.url));
      const entry = list && list.length > 1 ? list.shift() : list?.[0];
      const json = (status: number, payload: unknown) =>
        new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      if (typeof body.max_pages === 'number' && body.max_pages > this.maxPagesAccepted) return json(400, { error: { code: 'INVALID_INPUT', message: 'max_pages: Too big' } });
      if (!entry) return json(502, { error: { code: 'NAVIGATION_FAILED', message: `no fake page for ${String(body.url)}` } });
      if (entry.kind === 'raw') return json(entry.status, entry.body);
      const p = entry.page;
      const finalUrl = p.final_url ?? String(body.url);
      const maxPages = typeof body.max_pages === 'number' ? body.max_pages : 1;
      const extra = p.legacy ? [] : (p.nextPages ?? []).slice(0, Math.max(0, maxPages - 1));
      const text = [p.text, ...extra.map((x, i) => `[Página ${i + 2} del listado]\n${x.text}`)].join('\n\n');
      const links = [...(p.links ?? []), ...extra.flatMap((x) => x.links ?? [])];
      return json(200, {
        text,
        title: p.title ?? null,
        links,
        final_url: finalUrl,
        status: p.status ?? 200,
        render_ms: 1500,
        ...(p.legacy ? {} : { pages_read: 1 + extra.length, page_urls: Array(1 + extra.length).fill(finalUrl) }),
        ...(!p.legacy && maxPages > 1 ? { pagination_stop: p.paginationStop ?? (extra.length + 1 >= maxPages ? 'max_pages' : 'no_next_control') } : {}),
        ...(!p.legacy && body.capture_json === true
          ? { json_responses: (p.json ?? []).map((j) => ({ url: j.url, method: j.method ?? 'POST', status: j.status ?? 200, bytes: JSON.stringify(j.body).length, list_length: 0, body: j.body })), json_skipped: { no_list: 0 } }
          : {}),
      });
    };
    return {
      endpoint: 'http://pxos-renderer.test:3000',
      fetch: fakeFetch as typeof fetch,
      policy: { allow: [], deny: [], allowedPorts: [80, 443, 8080, 8443] },
      ...extra,
    };
  }
}
