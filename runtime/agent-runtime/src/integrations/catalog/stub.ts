/**
 * Stub of the publiexpe catalog connector, faithful to contract v1.1: the six operations, the
 * same shapes (every fixture and every answer is parsed with the contract schemas), the same
 * errors (400 / 404 as CatalogError) and the same cursor pagination. No network.
 *
 * Data: `fixtures/catalog/*.json` of the runtime package (override the directory with
 * CATALOG_STUB_FIXTURES_DIR). The products are FICTITIOUS merchandising (pens, tote bags,
 * notebooks, power banks...); when the backend delivers its own fixtures (from its local
 * database) they replace these files with the same names. A fixture that breaks the contract
 * makes the stub throw at construction.
 *
 * Determinism: same fixtures + same parameters = same answer, same order, same cursors (the
 * cursor encodes the offset, a hash of the query and its issue time; it expires after 10 min,
 * as the contract's cursor).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogApi, CatalogCallOptions } from './api.js';
import { CatalogError } from './errors.js';
import {
  CATALOG_ATTRIBUTE_NAMES,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  CATALOG_MAX_QUERY_LENGTH,
  CATALOG_SORTS,
  CustomizationEstimate,
  Describe,
  FamiliesResponse,
  Health,
  Product,
  ProductSummary,
  SearchResponse,
  type EstimateParams,
  type FamiliesParams,
  type Family,
  type SearchParams,
} from './types.js';

export interface StubPricing {
  tiers: Array<{ minQuantity: number; factor: number }>;
  techniques: Record<string, { unitBaseEur: number; unitPerColorEur?: number; setupPerColorEur?: number; setupFlatEur?: number }>;
}

export interface StubCatalogData {
  products: unknown[];
  families: Array<{ familyId: string; name: string; parentId: string | null }>;
  describe: unknown;
  health: unknown;
  pricing: StubPricing;
}

export const CURSOR_TTL_MS = 10 * 60_000;

/** `fixtures/catalog` of the runtime package (works from src/ with tsx and from dist/ with node). */
export function defaultStubFixturesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/catalog');
}

export function loadStubCatalogData(dir: string = defaultStubFixturesDir()): StubCatalogData {
  const read = (name: string) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`catalog stub fixture missing: ${file}`);
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  };
  return {
    products: (read('products.json').items as unknown[]) ?? [],
    families: (read('families.json').items as StubCatalogData['families']) ?? [],
    describe: read('describe.json'),
    health: read('health.json'),
    pricing: read('customization-pricing.json') as unknown as StubPricing,
  };
}

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'con', 'para', 'en', 'a', 'un', 'una', 'por', 'personalizado', 'personalizada', 'personalizados', 'personalizadas']);

/** Lowercase, no accents, alphanumerics only (the store search is accent-insensitive). */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Very small Spanish stemmer: plural endings away (bolsas -> bolsa, libretas -> libreta, botellas -> botella). */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('es') && !/[aeiou]es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function tokens(q: string): string[] {
  return [...new Set(normalizeText(q).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t)).map(stem))];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const bad = (message: string, details?: unknown) => new CatalogError('CATALOG_BAD_REQUEST', `BAD_REQUEST: ${message}`, 400, false, details);
const notFound = (message: string, details?: unknown) => new CatalogError('CATALOG_NOT_FOUND', `NOT_FOUND: ${message}`, 404, false, details);

export interface StubOptions {
  now?: () => number;
  /** Every operation (health included) throws this error while set: simulates a connector that is down. */
  failure?: CatalogError | null;
}

export class StubCatalogClient implements CatalogApi {
  readonly kind = 'stub' as const;
  /** Simulated outage (tests / local drills): set to a CatalogError, null to recover. */
  failure: CatalogError | null;
  /** Calls per operation (tests check the cache). */
  readonly calls: Record<string, number> = {};
  private readonly products: Product[];
  private readonly byId: Map<string, Product>;
  private readonly families: StubCatalogData['families'];
  private readonly describeData: ReturnType<typeof Describe.parse>;
  private readonly healthData: ReturnType<typeof Health.parse>;
  private readonly pricing: StubPricing;
  private readonly now: () => number;

  constructor(data: StubCatalogData = loadStubCatalogData(), opts: StubOptions = {}) {
    this.products = data.products.map((p, i) => {
      const parsed = Product.safeParse(p);
      if (!parsed.success) throw new Error(`catalog stub fixture products[${i}] breaks contract v1.1: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      return parsed.data;
    });
    this.byId = new Map(this.products.map((p) => [p.productId, p]));
    this.families = data.families;
    this.describeData = Describe.parse(data.describe);
    this.healthData = Health.parse(data.health);
    this.pricing = data.pricing;
    this.now = opts.now ?? Date.now;
    this.failure = opts.failure ?? null;
  }

  private enter(op: string, opts?: CatalogCallOptions): void {
    opts?.signal?.throwIfAborted();
    this.calls[op] = (this.calls[op] ?? 0) + 1;
    if (this.failure) throw this.failure;
  }

  async health(opts?: CatalogCallOptions) {
    this.enter('health', opts);
    return Health.parse({ ...this.healthData, catalog: { ...this.healthData.catalog, productCount: this.products.filter((p) => p.status === 'ACTIVE').length } });
  }

  async describe(opts?: CatalogCallOptions) {
    this.enter('describe', opts);
    return Describe.parse(structuredClone(this.describeData));
  }

  async getProduct(productId: string, opts?: CatalogCallOptions) {
    this.enter('getProduct', opts);
    const p = this.byId.get(productId);
    if (!p) throw notFound(`No existe el producto ${productId}.`, { productId });
    return Product.parse(structuredClone(p));
  }

  /** Family ids of `familyId` and all its descendants. */
  private subtree(familyId: string): Set<string> {
    const out = new Set([familyId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.families) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.familyId)) {
          out.add(f.familyId);
          grew = true;
        }
      }
    }
    return out;
  }

  private inFamilies(p: Product, ids: Set<string>): boolean {
    return (p.family !== null && ids.has(p.family.familyId)) || p.secondaryFamilies.some((f) => ids.has(f.familyId));
  }

  async searchProducts(params: SearchParams, opts?: CatalogCallOptions) {
    this.enter('searchProducts', opts);
    if (params.q !== undefined && params.q.length > CATALOG_MAX_QUERY_LENGTH) throw bad(`q supera ${CATALOG_MAX_QUERY_LENGTH} caracteres`);
    const limit = params.limit ?? CATALOG_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CATALOG_MAX_LIMIT) throw bad(`limit debe estar entre 1 y ${CATALOG_MAX_LIMIT}`);
    if (params.quantity !== undefined && (!Number.isInteger(params.quantity) || params.quantity < 1)) throw bad('quantity debe ser un entero >= 1');
    if (params.sort !== undefined && !(CATALOG_SORTS as readonly string[]).includes(params.sort)) throw bad(`sort no válido: ${params.sort}`);
    for (const name of Object.keys(params.attributes ?? {})) {
      if (!(CATALOG_ATTRIBUTE_NAMES as readonly string[]).includes(name)) throw bad(`atributo no filtrable: ${name}`, { attribute: name });
    }
    if (params.familyId && !this.families.some((f) => f.familyId === params.familyId)) throw notFound(`No existe la familia ${params.familyId}.`, { familyId: params.familyId });

    const queryKey = createHash('sha256')
      .update(JSON.stringify({ q: params.q ?? null, sku: params.sku ?? null, f: params.familyId ?? null, a: params.attributes ?? {}, n: params.quantity ?? null, s: params.sort ?? null }))
      .digest('hex')
      .slice(0, 16);
    let offset = 0;
    if (params.cursor) {
      let decoded: { o?: unknown; k?: unknown; t?: unknown };
      try {
        decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as typeof decoded;
      } catch {
        throw bad('cursor no válido');
      }
      if (typeof decoded.o !== 'number' || decoded.k !== queryKey || typeof decoded.t !== 'number') throw bad('cursor no válido para esta búsqueda');
      if (this.now() - decoded.t > CURSOR_TTL_MS) throw bad('cursor caducado (válido 10 minutos)');
      offset = decoded.o;
    }

    const famIds = params.familyId ? this.subtree(params.familyId) : null;
    const qTokens = params.q ? tokens(params.q) : [];
    const attr = params.attributes ?? {};
    const scored: Array<{ p: Product; score: number }> = [];
    for (const p of this.products) {
      if (p.status !== 'ACTIVE') continue;
      if (params.sku !== undefined && p.sku !== params.sku) continue;
      if (famIds && !this.inFamilies(p, famIds)) continue;
      if (params.quantity !== undefined && (p.quantity?.min ?? 1) > params.quantity) continue;
      if (!this.matchesAttributes(p, attr)) continue;
      let score = 0;
      if (qTokens.length > 0) {
        const words = normalizeText(`${p.name} ${p.sku}`).split(' ').map(stem);
        const hits = qTokens.filter((t) => words.some((w) => w === t || (t.length >= 3 && w.startsWith(t)) || (w.length >= 4 && t.startsWith(w)))).length;
        if (hits === 0) continue;
        score = hits / qTokens.length;
      }
      scored.push({ p, score });
    }
    const sort = params.sort ?? (qTokens.length > 0 ? 'relevance' : 'name');
    const byName = (a: Product, b: Product) => a.name.localeCompare(b.name, 'es') || a.productId.localeCompare(b.productId);
    scored.sort((a, b) =>
      sort === 'relevance'
        ? b.score - a.score || byName(a.p, b.p)
        : sort === 'updatedAt'
          ? (b.p.updatedAt ?? '').localeCompare(a.p.updatedAt ?? '') || a.p.productId.localeCompare(b.p.productId)
          : byName(a.p, b.p),
    );
    const page = scored.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < scored.length ? Buffer.from(JSON.stringify({ o: nextOffset, k: queryKey, t: this.now() })).toString('base64url') : null;
    return SearchResponse.parse({ items: page.map(({ p }) => summarize(p)), page: { limit, nextCursor, totalApprox: scored.length } });
  }

  private matchesAttributes(p: Product, attr: NonNullable<SearchParams['attributes']>): boolean {
    const n = (s: string | null | undefined) => normalizeText(s ?? '');
    const values = (name: string) => p.attributes.filter((a) => a.name === name).flatMap((a) => a.values.map(n));
    if (attr.color && !p.variants.some((v) => n(v.color?.group) === n(attr.color))) return false;
    if (attr.size && !p.variants.some((v) => (v.size ?? '').toUpperCase() === attr.size!.toUpperCase())) return false;
    if (attr.material && !values('material').some((v) => v.includes(n(attr.material)))) return false;
    if (attr.brand && !values('brand').some((v) => v.includes(n(attr.brand)))) return false;
    if (attr.tag && !values('tag').includes(n(attr.tag))) return false;
    return true;
  }

  async estimateCustomization(productId: string, params: EstimateParams, opts?: CatalogCallOptions) {
    this.enter('estimateCustomization', opts);
    const p = this.byId.get(productId);
    if (!p) throw notFound(`No existe el producto ${productId}.`, { productId });
    const c = p.customization;
    if (p.status !== 'ACTIVE' || !c) throw bad('el producto no admite marcaje', { productId, status: p.status });
    if (!c.techniques.includes(params.technique)) throw bad(`técnica no admitida: ${params.technique}`, { technique: params.technique, allowed: c.techniques });
    const area = c.areas.find((a) => a.name === params.area);
    if (!area) throw bad(`zona no válida: ${params.area}`, { area: params.area, allowed: c.areas.map((a) => a.name) });
    if (!Number.isInteger(params.colors) || params.colors < 1) throw bad('colors debe ser un entero >= 1');
    if (area.maxColors !== null && params.colors > area.maxColors) throw bad(`la zona ${area.name} admite como máximo ${area.maxColors} colores`, { maxColors: area.maxColors });
    const q = p.quantity;
    if (!Number.isInteger(params.quantity) || params.quantity < (q?.min ?? 1)) throw bad(`la cantidad mínima es ${q?.min ?? 1}`, { min: q?.min ?? 1 });
    if (q && q.step > 1 && params.quantity % q.step !== 0) throw bad(`la cantidad debe ser múltiplo de ${q.step}`, { step: q.step });
    const rate = this.pricing.techniques[params.technique];
    if (!rate) throw bad(`sin tarifa para la técnica ${params.technique}`);
    const factor = [...this.pricing.tiers].sort((a, b) => b.minQuantity - a.minQuantity).find((t) => params.quantity >= t.minQuantity)?.factor ?? 1;
    const unitEur = round2((rate.unitBaseEur + (rate.unitPerColorEur ?? 0) * params.colors) * factor);
    const setupEur = round2(rate.setupFlatEur ?? (rate.setupPerColorEur ?? 0) * params.colors);
    return CustomizationEstimate.parse({ unitEur, setupEur, totalEur: round2(unitEur * params.quantity + setupEur), forQuantity: params.quantity, basis: 'INDICATIVE' });
  }

  async listFamilies(params: FamiliesParams = {}, opts?: CatalogCallOptions) {
    this.enter('listFamilies', opts);
    if (params.parentId && !this.families.some((f) => f.familyId === params.parentId)) throw notFound(`No existe la familia ${params.parentId}.`, { familyId: params.parentId });
    const list = params.parentId ? this.families.filter((f) => f.parentId === params.parentId) : this.families;
    const items: Family[] = list.map((f) => {
      const ids = this.subtree(f.familyId);
      const members = this.products.filter((p) => p.status === 'ACTIVE' && this.inFamilies(p, ids));
      const base = { familyId: f.familyId, name: f.name, parentId: f.parentId, productCount: members.length };
      if (!params.includeAttributes) return base;
      const top = (name: string) => {
        const counts = new Map<string, number>();
        for (const p of members) for (const a of p.attributes.filter((x) => x.name === name)) for (const v of a.values) counts.set(v, (counts.get(v) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).slice(0, 5).map(([v]) => v);
      };
      const attributes = [
        { name: 'color', label: 'Color', topValues: top('color') },
        { name: 'material', label: 'Material', topValues: top('material') },
        { name: 'size', label: 'Talla', topValues: top('size') },
      ].filter((a) => a.topValues.length > 0);
      return { ...base, attributes };
    });
    return FamiliesResponse.parse({ items });
  }
}

/** Search summary of a product sheet, as the connector builds it. */
export function summarize(p: Product): ProductSummary {
  const main = p.images.find((i) => i.kind === 'MAIN') ?? p.images[0] ?? null;
  const short = p.description ? (p.description.length > 200 ? `${p.description.slice(0, 197).trimEnd()}…` : p.description) : null;
  return ProductSummary.parse({
    productId: p.productId,
    sku: p.sku,
    name: p.name,
    familyId: p.family?.familyId ?? null,
    familyName: p.family?.name ?? null,
    shortDescription: short,
    minQuantity: p.quantity?.min ?? null,
    variantCount: p.variants.length,
    colors: [...new Set(p.variants.map((v) => v.color?.group).filter((g): g is string => typeof g === 'string' && g.length > 0))],
    inStock: p.variants.length === 0 ? null : p.variants.some((v) => (v.stock ?? 0) > 0),
    priceHint: p.priceHint,
    imageUrl: main?.url ?? null,
    productUrl: p.productUrl,
    updatedAt: p.updatedAt,
  });
}
