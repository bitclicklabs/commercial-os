/**
 * Real products in the Prospector's hypothesis (Catalog Service, contract v1.1).
 *
 * Opt-in BY THE SKILL: nothing here runs unless the resolved skill text carries the capability
 * marker `[[capacidad:catalogo]]` (CATALOG_SKILL_MARKER). The ACTIVE skill versions do not carry
 * it, so today's behaviour is unchanged; the DRAFT candidate created by the seed
 * (src/seed/catalog-skill-seed.ts) does. It also needs the catalog tools in the agent's policy,
 * the catalog enabled and healthy (the tools answer CATALOG_UNAVAILABLE otherwise).
 *
 * Flow, for a hypothesis about to be written (both direct and scout modes):
 *   1. up to 3 `catalog_search_products`, one per generic product the model proposed
 *      (`recommended_products`), filtered by the hypothesis' minimum quantity;
 *   2. one LLM call (same system prompt = the skill) that picks 0-3 of the candidates; the
 *      catalog texts reach it only inside an untrusted block;
 *   3. the picks are validated against the candidates (productId AND sku must match: the model
 *      cannot invent a product) and confirmed with `catalog_get_product` (only ACTIVE ones stay);
 *   4. the result `{ productId, sku, name, priceHint }` is built from catalog data, never from
 *      model text. The price wording ("en torno a X-Y €/ud antes de personalización") is code.
 *
 * Any failure (catalog down, no candidates, model error) leaves the hypothesis exactly as
 * before: generic families. The run never fails because of the catalog.
 */
import { z } from 'zod';
import { catalogCandidatesPrompt, type Product, type ProductSummary, type RecommendedProduct } from '../integrations/catalog/index.js';
import type { ExhibitorHypothesisData as ExhibitorHypothesis, ExhibitorInput, ProspectorEvent, ProspectorRun } from './prospector-core.js';
import { wrapUntrusted } from './untrusted.js';

/** Capability marker a skill version carries to ask for real catalog products. */
export const CATALOG_SKILL_MARKER = '[[capacidad:catalogo]]';
export const CATALOG_MAX_SEARCHES_PER_HYPOTHESIS = 3;
export const CATALOG_MAX_PRODUCTS = 3;
export const CATALOG_MAX_CANDIDATES = 12;
const SEARCH_PAGE = 5;

export function skillRequestsCatalog(system: string): boolean {
  return system.includes(CATALOG_SKILL_MARKER);
}

export const CatalogSelection = z.object({
  selected: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(200),
        sku: z.string().trim().min(1).max(200),
        reason: z.string().trim().max(400).optional(),
      }),
    )
    .max(6)
    .default([]),
});
export type CatalogSelection = z.infer<typeof CatalogSelection>;

export const CATALOG_SELECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    selected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { productId: { type: 'string' }, sku: { type: 'string' }, reason: { type: 'string' } },
        required: ['productId', 'sku'],
      },
    },
  },
  required: ['selected'],
};

export type CatalogPick =
  | { status: 'not_requested' }
  | { status: 'tools_not_allowed' }
  | { status: 'unavailable'; code: string }
  | { status: 'no_candidates'; searches: number }
  | { status: 'none_selected'; searches: number; candidates: number }
  | { status: 'llm_error' | 'llm_invalid'; message: string; searches: number; candidates: number }
  | { status: 'selected'; searches: number; candidates: number; products: RecommendedProduct[]; reasons: Record<string, string>; provider: 'stub' | 'http' | null };

/** What the result records of the catalog step (the products go to `recommended_products`). */
export type CatalogPickSummary =
  | Exclude<CatalogPick, { status: 'not_requested' } | { status: 'selected' }>
  | Omit<Extract<CatalogPick, { status: 'selected' }>, 'products'>;

/** Per-run memo: tools allowed, and whether the catalog was found down (then no more calls this run). */
const runState = new WeakMap<ProspectorRun, { allowed: boolean; down: string | null }>();

function stateOf(run: ProspectorRun) {
  let s = runState.get(run);
  if (!s) {
    const names = new Set(run.tools.specs().map((t) => t.name));
    s = { allowed: names.has('catalog_search_products') && names.has('catalog_get_product'), down: null };
    runState.set(run, s);
  }
  return s;
}

function parseSelection(text: string): { ok: true; value: CatalogSelection } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    const a = trimmed.indexOf('{');
    const b = trimmed.lastIndexOf('}');
    try {
      json = a >= 0 && b > a ? JSON.parse(trimmed.slice(a, b + 1)) : undefined;
    } catch {
      json = undefined;
    }
    if (json === undefined) return { ok: false, error: 'JSON inválido' };
  }
  const parsed = CatalogSelection.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ') };
}

export function buildCatalogSelectionPrompt(event: ProspectorEvent, exhibitor: ExhibitorInput, h: ExhibitorHypothesis, candidates: Array<ProductSummary | Product>): string {
  return `Elige productos reales del catálogo de PubliEXPE para esta hipótesis (paso «Productos reales del catálogo» de tus instrucciones).

${wrapUntrusted(
  JSON.stringify(
    { evento: event.name, expositor: exhibitor.name, necesidad: h.need, por_que_ahora: h.why_now, cantidad_min: h.quantity_min, cantidad_max: h.quantity_max, productos_genericos: h.recommended_products },
    null,
    2,
  ),
  { origin: 'hipótesis del Prospector (generada a partir de datos externos)' },
)}

${catalogCandidatesPrompt(candidates)}

Devuelve SOLO un objeto JSON:
{
  "selected": [ { "productId": string, "sku": string, "reason": "por qué encaja (1 frase)" } ]
}
- De 1 a ${CATALOG_MAX_PRODUCTS} productos, SOLO de la lista de candidatos, copiando productId y sku exactamente.
- Si ninguno encaja con la necesidad, devuelve "selected": [].
- No escribas precios: el precio orientativo lo añade el sistema y nunca es un precio cerrado.`;
}

/** Steps 1-4 above. Never throws on business errors. */
export async function pickCatalogProducts(
  run: ProspectorRun,
  event: ProspectorEvent,
  exhibitor: ExhibitorInput,
  h: ExhibitorHypothesis,
  opts: { system: string },
): Promise<CatalogPick> {
  if (!skillRequestsCatalog(opts.system)) return { status: 'not_requested' };
  const state = stateOf(run);
  if (!state.allowed) return { status: 'tools_not_allowed' };
  if (state.down) return { status: 'unavailable', code: state.down };

  // 1. Search, one query per generic product.
  const candidates = new Map<string, ProductSummary>();
  let searches = 0;
  let provider: 'stub' | 'http' | null = null;
  const queries = [...new Set(h.recommended_products.map((p) => p.trim()).filter(Boolean))].slice(0, CATALOG_MAX_SEARCHES_PER_HYPOTHESIS);
  for (const q of queries) {
    run.ctx.signal.throwIfAborted();
    const out = await run.callTool('catalog_search_products', { q: q.slice(0, 200), ...(h.quantity_min >= 1 ? { quantity: h.quantity_min } : {}), limit: SEARCH_PAGE });
    searches += 1;
    const r = out.result;
    if (r.status !== 'ok') {
      if (r.status === 'error' && (r.code === 'CATALOG_UNAVAILABLE' || r.code === 'TOOL_DISABLED' || r.code === 'TOOL_CALL_LIMIT')) {
        state.down = r.code;
        return { status: 'unavailable', code: r.code };
      }
      continue;
    }
    provider ??= (r.output as { provider: 'stub' | 'http' | null }).provider;
    for (const item of (r.output as { items: ProductSummary[] }).items) {
      if (candidates.size >= CATALOG_MAX_CANDIDATES) break;
      if (!candidates.has(item.productId)) candidates.set(item.productId, item);
    }
  }
  if (candidates.size === 0) return { status: 'no_candidates', searches };

  // 2. The model picks.
  const list = [...candidates.values()];
  const call = await run.completeJson({
    label: { exhibitor: exhibitor.name, step: 'catalog_selection' },
    system: opts.system,
    messages: [{ role: 'user', content: buildCatalogSelectionPrompt(event, exhibitor, h, list) }],
    parse: parseSelection,
    schema: CATALOG_SELECTION_JSON_SCHEMA,
  });
  if (call.status === 'model_error') return { status: 'llm_error', message: `${call.code}: ${call.message}`, searches, candidates: list.length };
  if (call.status === 'invalid') return { status: 'llm_invalid', message: call.message, searches, candidates: list.length };

  // 3. Only real candidates (id AND sku), deduplicated, at most 3; confirmed with the sheet.
  const picked: Array<{ summary: ProductSummary; reason: string | undefined }> = [];
  for (const s of call.value.selected) {
    const c = candidates.get(s.productId);
    if (!c || c.sku !== s.sku || picked.some((p) => p.summary.productId === c.productId)) continue;
    picked.push({ summary: c, reason: s.reason });
    if (picked.length >= CATALOG_MAX_PRODUCTS) break;
  }
  const products: RecommendedProduct[] = [];
  const reasons: Record<string, string> = {};
  for (const { summary, reason } of picked) {
    const sheet = await run.callTool('catalog_get_product', { productId: summary.productId });
    let source: { productId: string; sku: string; name: string; priceHint: RecommendedProduct['priceHint'] } = summary;
    if (sheet.result.status === 'ok') {
      const product = (sheet.result.output as { product: Product }).product;
      if (product.status !== 'ACTIVE') continue;
      source = product;
    } else if (sheet.result.status === 'error' && sheet.result.code === 'CATALOG_NOT_FOUND') {
      continue;
    }
    // 4. From catalog data only.
    products.push({ productId: source.productId, sku: source.sku, name: source.name, priceHint: source.priceHint });
    if (reason) reasons[source.productId] = reason;
  }
  if (products.length === 0) return { status: 'none_selected', searches, candidates: list.length };
  return { status: 'selected', searches, candidates: list.length, products, reasons, provider };
}
