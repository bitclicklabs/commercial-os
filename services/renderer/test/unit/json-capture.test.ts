/**
 * JSON capture (`capture_json`), pagination early stop and the per-request budget:
 * pure parts of render.ts, no browser.
 */
import { describe, expect, it } from 'vitest';
import {
  addsNoNewContent,
  JSON_CAPTURE_MAX_BYTES,
  JsonCapture,
  jsonListLength,
  RENDER_JS_TIMEOUT_MS,
  RENDER_MAX_JS_TIMEOUT_MS,
  renderBudgetMs,
} from '../../src/render.js';

const ORIGIN = 'https://apps.feria.example';
const list = (n: number, extra: Record<string, unknown> = {}) => ({
  currentPage: 1,
  totalRecords: n,
  data: Array.from({ length: n }, (_, i) => ({ exhibitor: 1000 + i, name: `EXPOSITOR ${i}`, country: 'España', ...extra })),
});
const answer = (body: unknown, over: Partial<Parameters<JsonCapture['offer']>[0]> = {}) => ({
  url: `${ORIGIN}/api/puisearch`,
  method: 'POST',
  resourceType: 'xhr',
  status: 200,
  contentType: 'application/json;charset=UTF-8',
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  ...over,
});

describe('jsonListLength', () => {
  it('finds the longest array of objects, nested', () => {
    expect(jsonListLength(list(91))).toBe(91);
    expect(jsonListLength({ result: { items: [{ a: 1 }, { a: 2 }, { a: 3 }] } })).toBe(3);
    expect(jsonListLength({ token: 'abc', user: { id: 1 } })).toBe(0);
    expect(jsonListLength(['a', 'b', 'c'])).toBe(0);
    expect(jsonListLength(null)).toBe(0);
  });
});

describe('JsonCapture', () => {
  it('keeps same-origin JSON lists; refuses other origins, non-JSON, errors, oversized, invalid and list-less answers', () => {
    const c = new JsonCapture(ORIGIN);
    expect(c.offer(answer(list(91)))).toBe('kept');
    expect(c.offer(answer(list(5), { url: 'https://api.tercero.example/list' }))).toBe('cross_origin');
    expect(c.offer(answer(list(5), { url: 'https://feria.example/api/list' }))).toBe('cross_origin');
    expect(c.offer(answer(list(5), { contentType: 'text/html' }))).toBe('ignored');
    expect(c.offer(answer(list(5), { contentType: 'text/json' }))).toBe('not_json');
    expect(c.offer(answer(list(5), { status: 401 }))).toBe('status');
    expect(c.offer(answer('{"data": [', {}))).toBe('invalid_json');
    expect(c.offer(answer({ token: 'secreto', user: 'anon' }))).toBe('no_list');
    expect(c.offer(answer(list(5), { resourceType: 'script' }))).toBe('ignored');
    const big = list(4, { description: 'x'.repeat(JSON_CAPTURE_MAX_BYTES) });
    expect(c.offer(answer(big))).toBe('too_large');
    expect(c.offer(answer(list(5), { resourceType: 'fetch', contentType: 'application/vnd.api+json' }))).toBe('kept');
    expect(c.results().map((r) => r.list_length)).toEqual([91, 5]);
    expect(c.results()[0]).toMatchObject({ url: `${ORIGIN}/api/puisearch`, method: 'POST', status: 200, list_length: 91 });
    expect(c.skipped).toMatchObject({ cross_origin: 2, not_json: 1, status: 1, invalid_json: 1, no_list: 1, too_large: 1 });
  });

  it('an answer of exactly 200 KB is kept; one byte more is not', () => {
    const base = JSON.stringify(list(2));
    const pad = (n: number) => `${base.slice(0, -1)},"pad":"${'x'.repeat(n)}"}`;
    const size = (n: number) => Buffer.byteLength(pad(n));
    const n = JSON_CAPTURE_MAX_BYTES - size(0);
    expect(size(n)).toBe(JSON_CAPTURE_MAX_BYTES);
    expect(new JsonCapture(ORIGIN).offer(answer(pad(n)))).toBe('kept');
    expect(new JsonCapture(ORIGIN).offer(answer(pad(n + 1)))).toBe('too_large');
  });

  it('keeps at most 5, the longest lists first; a repeated answer is kept once', () => {
    const c = new JsonCapture(ORIGIN);
    for (const n of [3, 40, 2, 7, 91, 12]) c.offer(answer(list(n), { url: `${ORIGIN}/api/l${n}` }));
    expect(c.offer(answer(list(91), { url: `${ORIGIN}/api/l91` }))).toBe('duplicate');
    expect(c.results().map((r) => r.list_length)).toEqual([91, 40, 12, 7, 3]);
    expect(c.skipped.evicted).toBe(1);
    expect(c.skipped.duplicate).toBe(1);
  });
});

describe('client-side pagination: early stop and budget', () => {
  it('a page whose content lines were all seen adds nothing (page counters do not count)', () => {
    const seen = new Set(['CONSERVAS ORTIZ', 'España', 'BODEGAS SOL']);
    expect(addsNoNewContent(seen, 'CONSERVAS ORTIZ\n\nEspaña\n81 - 100 de 91\n5')).toBe(true);
    expect(addsNoNewContent(seen, 'CONSERVAS ORTIZ\nQUESOS DEL VALLE\nEspaña')).toBe(false);
  });

  it('25 s for one page, +3 s per extra page, never above 60 s', () => {
    expect(renderBudgetMs(1)).toBe(RENDER_JS_TIMEOUT_MS);
    expect(renderBudgetMs(5)).toBe(RENDER_JS_TIMEOUT_MS + 12_000);
    expect(renderBudgetMs(20)).toBe(RENDER_MAX_JS_TIMEOUT_MS);
    expect(renderBudgetMs(500)).toBe(RENDER_MAX_JS_TIMEOUT_MS);
  });
});
