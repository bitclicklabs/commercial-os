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
}

type Entry = { kind: 'page'; page: FakeRendered } | { kind: 'raw'; status: number; body: unknown };

export class FakeRenderer {
  readonly entries = new Map<string, Entry>();
  /** Bodies POSTed to /render. */
  readonly requests: Array<Record<string, unknown>> = [];

  page(url: string, page: FakeRendered): this {
    this.entries.set(url, { kind: 'page', page });
    return this;
  }

  error(url: string, status: number, code: string, message = code): this {
    this.entries.set(url, { kind: 'raw', status, body: { error: { code, message } } });
    return this;
  }

  raw(url: string, status: number, body: unknown): this {
    this.entries.set(url, { kind: 'raw', status, body });
    return this;
  }

  deps(extra: Partial<RenderUrlDeps> = {}): RenderUrlDeps {
    const fakeFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      this.requests.push(body);
      const entry = this.entries.get(String(body.url));
      const json = (status: number, payload: unknown) =>
        new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      if (!entry) return json(502, { error: { code: 'NAVIGATION_FAILED', message: `no fake page for ${String(body.url)}` } });
      if (entry.kind === 'raw') return json(entry.status, entry.body);
      const p = entry.page;
      return json(200, { text: p.text, title: p.title ?? null, links: p.links ?? [], final_url: p.final_url ?? body.url, status: p.status ?? 200, render_ms: 1500 });
    };
    return {
      endpoint: 'http://pxos-renderer.test:3000',
      fetch: fakeFetch as typeof fetch,
      policy: { allow: [], deny: [], allowedPorts: [80, 443, 8080, 8443] },
      ...extra,
    };
  }
}
