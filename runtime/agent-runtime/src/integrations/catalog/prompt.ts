/**
 * How catalog data reaches a model and Twenty.
 *
 * Trust (contract v1.1, "Texto libre del catálogo"): names, descriptions, family names, material,
 * brand, tag and variant names come from suppliers. Whenever they travel to an LLM they go inside
 * a `<<<DATOS_NO_CONFIABLES …>>>` block (src/agents/untrusted.ts, user messages only). Ids, SKUs,
 * amounts, quantities, stock flags and controlled vocabularies (colour groups) are data and stay
 * outside the block, so the model can cite them exactly.
 *
 * Prices: `priceHint` is only an order of magnitude ("en torno a X-Y €/ud antes de
 * personalización"), worded HERE by code, never by the model, and never as a committed price:
 * the quote is made by publiexpe's CMS.
 */
import { wrapUntrusted } from '../../agents/untrusted.js';
import type { PriceHint, Product, ProductSummary } from './types.js';

const eur = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "en torno a 1,20-1,35 €/ud antes de personalización (orientativo, sin IVA)". */
export function priceHintText(hint: PriceHint | null | undefined): string {
  if (!hint) return 'sin precio orientativo en el catálogo';
  const range = hint.fromEur === hint.toEur ? `${eur(hint.fromEur)} €/ud` : `${eur(hint.fromEur)}-${eur(hint.toEur)} €/ud`;
  return `en torno a ${range} antes de personalización (orientativo, sin IVA${hint.onOffer ? ', con oferta activa' : ''})`;
}

/** The product a hypothesis recommends (agent output, docs/catalog-service.md). */
export interface RecommendedProduct {
  productId: string;
  sku: string;
  name: string;
  priceHint: PriceHint | null;
}

/** Max length of one `recommendedProducts` item in Twenty (create_hypothesis input). */
export const RECOMMENDED_ITEM_MAX = 120;

/**
 * One `recommendedProducts` entry of the Twenty hypothesis (ARRAY of text, the field the App
 * already has for "Catalog Service references"): `Nombre · ref. SKU · id productId`. The name is
 * the part that gets shortened, never the ids.
 */
export function recommendedProductLabel(p: Pick<RecommendedProduct, 'productId' | 'sku' | 'name'>, opts: { stub?: boolean } = {}): string {
  // Stub products are fictitious: if one ever reaches a real CRM it must say so.
  const head = opts.stub ? '[STUB] ' : '';
  const tail = ` · ref. ${p.sku} · id ${p.productId}`;
  const room = Math.max(10, RECOMMENDED_ITEM_MAX - tail.length - head.length);
  const name = p.name.replace(/\s+/g, ' ').trim();
  return `${head}${name.length > room ? `${name.slice(0, room - 1)}…` : name}${tail}`.slice(0, RECOMMENDED_ITEM_MAX);
}

type Candidate = ProductSummary | Product;

function freeText(c: Candidate): Record<string, unknown> {
  if ('family' in c) {
    return {
      nombre: c.name,
      familia: c.family?.path.join(' > ') ?? null,
      descripcion: c.description ? c.description.slice(0, 600) : null,
      materiales: c.attributes.filter((a) => a.name === 'material').flatMap((a) => a.values),
      tecnicas_de_marcaje: c.customization?.techniques ?? [],
    };
  }
  return { nombre: c.name, familia: c.familyName, descripcion: c.shortDescription };
}

function structured(c: Candidate): Record<string, unknown> {
  const minQuantity = 'family' in c ? (c.quantity?.min ?? null) : c.minQuantity;
  const colors = 'family' in c ? [...new Set(c.variants.map((v) => v.color?.group).filter(Boolean))] : c.colors;
  const inStock = 'family' in c ? (c.variants.length === 0 ? null : c.variants.some((v) => (v.stock ?? 0) > 0)) : c.inStock;
  return {
    productId: c.productId,
    sku: c.sku,
    pedido_minimo: minQuantity,
    precio_orientativo_eur_ud: c.priceHint ? { desde: c.priceHint.fromEur, hasta: c.priceHint.toEur, oferta: c.priceHint.onOffer } : null,
    en_stock: inStock,
    grupos_de_color: colors,
  };
}

/**
 * Prompt block with catalog candidates: the structured fields as plain JSON, the supplier texts
 * (keyed by productId) inside one untrusted block.
 */
export function catalogCandidatesPrompt(candidates: Candidate[], origin = 'catálogo de publiexpe (textos de proveedores)'): string {
  const data = candidates.map(structured);
  const texts = Object.fromEntries(candidates.map((c) => [c.productId, freeText(c)]));
  return [
    'Productos candidatos del catálogo. Datos estructurados (ids, referencias, cantidades y precios orientativos; son fiables):',
    JSON.stringify(data, null, 2),
    '',
    'Textos de los productos, por productId (vienen de proveedores):',
    wrapUntrusted(JSON.stringify(texts, null, 2), { origin }),
  ].join('\n');
}
