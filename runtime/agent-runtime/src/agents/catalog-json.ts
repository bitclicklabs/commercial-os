/**
 * Scout mode: exhibitor list read from the JSON API of a catalog SPA (pure, unit-tested).
 *
 * Many catalog apps (Feria Valencia's among them: `POST /api/puisearch`) download the
 * whole exhibitor list as JSON and paginate it in the browser. With `captureJson` the
 * renderer returns those answers (same origin as the page, at most 5, 200 KB each) and
 * this module finds, among them, the array that is the exhibitor list:
 *
 * - an array of at least 3 objects with a string "name" field (`name`, `nombre`,
 *   `companyName`, `*name`... never `country`, `sector`, `province`...), with
 *   distinct values;
 * - the one whose names appear the most in the rendered page text (the page shows at
 *   least its first page of exhibitors): at least 3 names. A list of provinces, sectors
 *   or countries in the same answers does not win.
 *
 * Each item gives `name` and, when the JSON has them, `domain` (website field),
 * `description`, `sector` and `id`. The JSON is UNTRUSTED web data like any page: names
 * are plain strings (HTML entities decoded, tags removed), nothing is executed and the
 * scout applies the same checks as for a page (name in the downloaded content, domain
 * in it and never the fair's own nor a social network, SourceLedger for the cited URL).
 *
 * `inferProfileUrls`: catalogs link each exhibitor to `/exhibitors/{id}`. From the links
 * of the rendered page whose text is an exhibitor's name and whose URL contains that
 * exhibitor's JSON id, the URL template is learnt (at least 2 agreeing links) and applied
 * to the items the rendered pages did not show.
 */
import { normalizeDomain } from '../integrations/twenty/index.js';
import { foldName, sameSite } from './exhibitor-profile.js';
import { hostOf } from './source-ledger.js';

export interface JsonAnswer {
  url: string;
  method?: string;
  body: unknown;
}

export interface JsonCatalogItem {
  name: string;
  id: string | null;
  domain: string | null;
  description: string | null;
  sector: string | null;
}

export interface JsonCatalogList {
  /** URL of the JSON answer (the API call), for the trace; never cited as a source. */
  url: string;
  method: string;
  /** Path of the array inside the body (`data`, `result.items`...). */
  path: string;
  nameKey: string;
  idKey: string | null;
  domainKey: string | null;
  /** Items of the array (before deduplication by name). */
  total: number;
  items: JsonCatalogItem[];
  /** Names of the list found in the rendered page text. */
  matchedInPage: number;
}

const MIN_ITEMS = 3;
const MIN_MATCHED = 3;
const MAX_DEPTH = 6;

/** Keys that hold the exhibitor's name, best first. */
const NAME_KEYS_EXACT = [
  'name', 'nombre', 'nom', 'companyname', 'company_name', 'company', 'empresa', 'razonsocial', 'razon_social', 'exhibitorname', 'exhibitor_name',
  'exhiname', 'expositor', 'nombreexpositor', 'displayname', 'display_name', 'tradename', 'trade_name', 'comercialname', 'commercialname', 'title', 'titulo',
];
/** Keys that are never the exhibitor's name, even if they end in "name". */
const NOT_NAME_KEY = /(country|pais|province|provincia|city|ciudad|town|region|state|sector|categor|activit|actividad|pavilion|pabellon|stand|hall|event|feria|lang|user|contact|person|first|last|file|image|logo|photo|type|tipo|status|path|color|brand|marca|product|producto)/i;
const ID_KEY = /^(id|_id|uuid|code|codigo)$/i;
const ID_KEY_OWN = /^(exhi|exhibitor|expositor|company|empresa)[_-]?(id|code)?$/i;
const WEB_KEY = /^(web|website|webpage|web_?site|web_?url|url|www|site|homepage|home_?page|paginaweb|pagina_?web|sitioweb|sitio_?web|exhi(bitor)?_?web(site)?|companyweb)$/i;
const DESCRIPTION_KEY = /(descr|about|resumen|summary|presentacion|presentation)/i;
/** Sector labels first (`sectorsname`), then any sector-like key (`sectors` may hold ids). */
const SECTOR_NAME_KEY = /^(sectors?_?names?|sectoresnombre|categor(y|ies|ia|ias)_?names?|activities_?names?)$/i;
const SECTOR_KEY = /^(sectorsname|sectorname|sectors?|sectores|categor(y|ies|ia|ias)|activitiesname|actividades)$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text of a JSON string value: HTML tags removed, basic entities decoded, spaces collapsed. */
export function plainText(v: string): string {
  return v
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Arrays of (mostly) objects inside a JSON value, with their path. */
function objectArrays(value: unknown, path: string, depth: number, out: Array<{ path: string; items: Obj[] }>): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    const items = value.filter(isObj);
    if (items.length >= MIN_ITEMS && items.length / value.length >= 0.8) out.push({ path: path || '(raíz)', items });
    for (const v of value.slice(0, 20)) objectArrays(v, `${path}[]`, depth + 1, out);
    return;
  }
  for (const [k, v] of Object.entries(value).slice(0, 200)) objectArrays(v, path ? `${path}.${k}` : k, depth + 1, out);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);
const idValue = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && /^[\w-]{1,64}$/.test(v.trim()) ? v.trim() : null;

/** Share of items with a value for `key` (by `pick`), and how distinct the values are. */
function keyStats(items: Obj[], key: string, pick: (v: unknown) => string | null): { coverage: number; distinct: number } {
  const values = items.map((o) => pick(o[key])).filter((v): v is string => v !== null);
  return { coverage: values.length / items.length, distinct: values.length === 0 ? 0 : new Set(values.map((v) => v.toLowerCase())).size / values.length };
}

/** The name key of an array of objects, or null: an exact name key first, then `*name` keys. */
function nameKeyOf(items: Obj[]): string | null {
  const keys = new Set(items.slice(0, 50).flatMap((o) => Object.keys(o)));
  const candidates = [...keys]
    .map((k) => {
      const lower = k.toLowerCase();
      const exact = NAME_KEYS_EXACT.indexOf(lower);
      const rank = exact >= 0 && (lower === 'name' || lower === 'nombre' || !NOT_NAME_KEY.test(lower)) ? exact : /(name|nombre)$/i.test(k) && !NOT_NAME_KEY.test(lower) ? 100 : -1;
      return { k, rank };
    })
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  for (const { k } of candidates) {
    const s = keyStats(items, k, (v) => {
      const t = str(v);
      return t && plainText(t).length >= 2 && plainText(t).length <= 255 ? t : null;
    });
    if (s.coverage >= 0.8 && s.distinct >= 0.9) return k;
  }
  return null;
}

function idKeyOf(items: Obj[], nameKey: string): string | null {
  const keys = [...new Set(items.slice(0, 50).flatMap((o) => Object.keys(o)))].filter((k) => k !== nameKey);
  const ranked = keys
    .map((k) => ({ k, rank: ID_KEY.test(k) ? 0 : ID_KEY_OWN.test(k) ? 1 : /(^|[_-])id$|Id$|id$/.test(k) ? 2 : -1 }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  for (const { k } of ranked) {
    const s = keyStats(items, k, idValue);
    if (s.coverage >= 0.9 && s.distinct >= 0.99) return k;
  }
  return null;
}

function firstKey(items: Obj[], re: RegExp, exclude: string[]): string | null {
  const keys = [...new Set(items.slice(0, 50).flatMap((o) => Object.keys(o)))].filter((k) => !exclude.includes(k) && re.test(k));
  let best: { k: string; coverage: number } | null = null;
  for (const k of keys) {
    const coverage = items.filter((o) => str(o[k]) !== null || (Array.isArray(o[k]) && (o[k] as unknown[]).length > 0)).length / items.length;
    if (coverage > 0 && (!best || coverage > best.coverage)) best = { k, coverage };
  }
  return best?.k ?? null;
}

function sectorText(v: unknown): string | null {
  // Codes or ids ("#6036", "12,15") are not a sector label.
  if (typeof v === 'string') return /^[#\d\s,;|-]+$/.test(v) ? null : plainText(v).slice(0, 255) || null;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === 'string' ? x : isObj(x) ? (str(x.name) ?? str(x.nombre)) : null)).filter((x): x is string => x !== null);
    return parts.length > 0 ? plainText(parts.join(', ')).slice(0, 255) : null;
  }
  return null;
}

/**
 * The exhibitor list among the captured JSON answers, or null when none looks like one
 * (no array of named objects, or fewer than 3 of its names in the rendered page).
 */
export function findExhibitorListInJson(answers: readonly JsonAnswer[], pageText: string): JsonCatalogList | null {
  const page = foldName(pageText);
  let best: JsonCatalogList | null = null;
  for (const a of answers) {
    const arrays: Array<{ path: string; items: Obj[] }> = [];
    objectArrays(a.body, '', 0, arrays);
    for (const arr of arrays) {
      const nameKey = nameKeyOf(arr.items);
      if (!nameKey) continue;
      const idKey = idKeyOf(arr.items, nameKey);
      const domainKey = firstKey(arr.items, WEB_KEY, [nameKey]);
      const descriptionKey = firstKey(arr.items, DESCRIPTION_KEY, [nameKey]);
      const sectorKey = firstKey(arr.items, SECTOR_NAME_KEY, [nameKey]) ?? firstKey(arr.items, SECTOR_KEY, [nameKey]);
      const items: JsonCatalogItem[] = [];
      const seen = new Set<string>();
      let matched = 0;
      for (const o of arr.items) {
        const raw = str(o[nameKey]);
        if (!raw) continue;
        const name = plainText(raw).slice(0, 255);
        const folded = foldName(name);
        if (folded.length < 2 || /^https?:|@/.test(name) || seen.has(folded)) continue;
        seen.add(folded);
        if (page.includes(folded)) matched += 1;
        const web = domainKey ? str(o[domainKey]) : null;
        const description = descriptionKey ? str(o[descriptionKey]) : null;
        items.push({
          name,
          id: idKey ? idValue(o[idKey]) : null,
          domain: web ? normalizeDomain(plainText(web)) : null,
          description: description ? plainText(description).slice(0, 1000) || null : null,
          sector: sectorKey ? sectorText(o[sectorKey]) : null,
        });
      }
      if (matched < MIN_MATCHED) continue;
      const cand: JsonCatalogList = { url: a.url, method: (a.method ?? 'GET').toUpperCase(), path: arr.path, nameKey, idKey, domainKey, total: arr.items.length, items, matchedInPage: matched };
      if (!best || cand.matchedInPage > best.matchedInPage || (cand.matchedInPage === best.matchedInPage && cand.items.length > best.items.length)) best = cand;
    }
  }
  return best;
}

/**
 * Profile URLs of the items without a profile link in the rendered pages, from the URL
 * template learnt from the links that DO match an item (link text = item name, URL
 * contains the item id as a path segment or query value, same site as the list). At
 * least 2 links must agree on the template; otherwise nothing is inferred.
 * Returns folded name -> URL, for the items whose id is known.
 */
export function inferProfileUrls(items: readonly JsonCatalogItem[], links: ReadonlyArray<{ url: string; text: string }>, listUrl: string): { template: string | null; urls: Map<string, string> } {
  const urls = new Map<string, string>();
  const listHost = hostOf(listUrl);
  if (!listHost) return { template: null, urls };
  const byName = new Map(items.filter((i) => i.id).map((i) => [foldName(i.name), i] as const));
  const votes = new Map<string, number>();
  for (const l of links) {
    const item = byName.get(foldName(l.text));
    if (!item?.id) continue;
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }
    const host = hostOf(l.url);
    if (!host || !sameSite(host, listHost) || (u.protocol !== 'https:' && u.protocol !== 'http:')) continue;
    const id = encodeURIComponent(item.id);
    const segments = u.pathname.split('/');
    let template: string | null = null;
    const at = segments.lastIndexOf(id);
    if (at > 0) {
      segments[at] = '{id}';
      template = `${u.origin}${segments.join('/')}${u.search}`;
    } else {
      for (const [k, v] of u.searchParams) {
        if (v === item.id) {
          const t = new URL(u.toString());
          t.searchParams.set(k, '__ID__');
          template = t.toString().replace('__ID__', '{id}');
          break;
        }
      }
    }
    if (template) votes.set(template, (votes.get(template) ?? 0) + 1);
  }
  const [template, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (!template || count < 2) return { template: null, urls };
  for (const item of items) if (item.id) urls.set(foldName(item.name), template.replace('{id}', encodeURIComponent(item.id)));
  return { template, urls };
}
