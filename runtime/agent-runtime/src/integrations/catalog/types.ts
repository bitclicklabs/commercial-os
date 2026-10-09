/**
 * Shapes of the publiexpe catalog connector, contract v1.1 (docs/catalog-connector-contrato.md,
 * closed 2026-10-09). Every response the HTTP client or the stub returns is parsed with these
 * schemas, so the rest of the runtime only ever sees contract-valid data.
 *
 * Rules mirrored from the contract:
 * - unknown fields are ignored (zod objects strip them): adding fields is a MINOR change;
 * - "no data" is `null` (or an empty list), never an omitted key; the schemas still default a
 *   missing optional key to `null` / `[]` because the tombstone example omits some of them;
 * - every amount is INDICATIVE: a `priceHint` or an estimate whose `basis` is anything else is
 *   rejected (a committed price does not exist in this contract);
 * - free text (names, descriptions, material, brand, tag...) comes from suppliers: it is DATA
 *   for the runtime and only reaches a model wrapped as untrusted (src/integrations/catalog/prompt.ts).
 */
import { z } from 'zod';

/** Contract version this client implements. The runtime refuses any other MAJOR. */
export const CATALOG_CONTRACT_VERSION = '1.1.0';
export const CATALOG_SUPPORTED_MAJOR = 1;
/** REST base path appended to `CATALOG_BASE_URL` (which is only the origin). */
export const CATALOG_API_PATH = '/api/catalog/v1';

/** Fixed vocabulary of attribute names (also the names accepted by `attr.<name>`). */
export const CATALOG_ATTRIBUTE_NAMES = ['color', 'size', 'material', 'brand', 'tag'] as const;
export type CatalogAttributeName = (typeof CATALOG_ATTRIBUTE_NAMES)[number];
export const CATALOG_SORTS = ['relevance', 'name', 'updatedAt'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];
export const PRODUCT_STATUSES = ['ACTIVE', 'DISCONTINUED'] as const;
export const STATUS_REASONS = ['UNPUBLISHED', 'REMOVED'] as const;

/** Major of a `MAJOR.MINOR.PATCH` version, or null when it does not look like one. */
export function contractMajor(version: string | null | undefined): number | null {
  const m = /^(\d+)\.\d+(?:\.\d+)?/.exec(String(version ?? '').trim());
  return m ? Number(m[1]) : null;
}

const Id = z.string().trim().min(1).max(200);
const Text = z.string();
const NullableText = Text.nullable().default(null);
const Money = z.number().finite().nonnegative();
const IsoDateTime = z.string().min(1).max(64);

export const PriceHint = z
  .object({
    fromEur: Money,
    toEur: Money,
    basis: z.literal('INDICATIVE'),
    forQuantity: z.number().int().positive().nullable().default(null),
    perUnit: z.literal(true),
    includesCustomization: z.boolean(),
    onOffer: z.boolean(),
  })
  .refine((p) => p.fromEur <= p.toEur, { message: 'fromEur must be <= toEur', path: ['toEur'] });
export type PriceHint = z.infer<typeof PriceHint>;

export const FamilyRef = z.object({
  familyId: Id,
  name: Text,
  path: z.array(Text).default([]),
});
export type FamilyRef = z.infer<typeof FamilyRef>;

export const ProductAttribute = z.object({
  /** One of CATALOG_ATTRIBUTE_NAMES; an unknown name is kept as data but is not filterable. */
  name: z.string().min(1),
  label: Text,
  values: z.array(Text).default([]),
});

export const Dimensions = z.object({
  widthCm: z.number().nullable().default(null),
  heightCm: z.number().nullable().default(null),
  depthCm: z.number().nullable().default(null),
  weightG: z.number().nullable().default(null),
});

export const Variant = z.object({
  variantId: Id,
  sku: Id,
  name: Text,
  color: z.object({ name: Text, group: Text.nullable().default(null) }).nullable().default(null),
  size: NullableText,
  priceEur: Money.nullable().default(null),
  stock: z.number().int().nullable().default(null),
  availableFrom: IsoDateTime.nullable().default(null),
  imageUrl: NullableText,
});
export type Variant = z.infer<typeof Variant>;

export const CustomizationArea = z.object({
  name: Text,
  maxColors: z.number().int().nonnegative().nullable().default(null),
  widthMm: z.number().nonnegative().nullable().default(null),
  heightMm: z.number().nonnegative().nullable().default(null),
});

export const Customization = z.object({
  techniques: z.array(Text).default([]),
  areas: z.array(CustomizationArea).default([]),
  maxColors: z.number().int().nonnegative().nullable().default(null),
  notes: NullableText,
});
export type Customization = z.infer<typeof Customization>;

export const QuantityRule = z.object({
  min: z.number().int().positive(),
  step: z.number().int().nonnegative(),
  breaks: z.array(z.number().int().positive()).default([]),
});

export const LeadTimeDays = z.object({
  min: z.number().int().nonnegative().nullable().default(null),
  max: z.number().int().nonnegative().nullable().default(null),
  /** DEFAULT today; PRODUCT / TECHNIQUE may arrive later (MINOR change): kept as free string. */
  source: z.string().min(1),
});

export const ProductImage = z.object({
  url: Text,
  kind: z.enum(['MAIN', 'GALLERY']),
  width: z.number().int().positive().nullable().default(null),
});

/** Full product sheet (`GET /products/{productId}`), tombstones included. */
export const Product = z
  .object({
    productId: Id,
    sku: Id,
    name: Text,
    family: FamilyRef.nullable().default(null),
    secondaryFamilies: z.array(FamilyRef).nullable().default([]).transform((v) => v ?? []),
    description: NullableText,
    descriptionTruncated: z.boolean().nullable().default(null),
    attributes: z.array(ProductAttribute).nullable().default([]).transform((v) => v ?? []),
    dimensions: Dimensions.nullable().default(null),
    variants: z.array(Variant).nullable().default([]).transform((v) => v ?? []),
    customization: Customization.nullable().default(null),
    quantity: QuantityRule.nullable().default(null),
    priceHint: PriceHint.nullable().default(null),
    leadTimeDays: LeadTimeDays.nullable().default(null),
    images: z.array(ProductImage).nullable().default([]).transform((v) => v ?? []),
    productUrl: NullableText,
    status: z.enum(PRODUCT_STATUSES),
    statusReason: z.enum(STATUS_REASONS).nullable().default(null),
    updatedAt: IsoDateTime.nullable().default(null),
  })
  .refine((p) => p.status === 'DISCONTINUED' || p.statusReason === null, { message: 'statusReason only with DISCONTINUED', path: ['statusReason'] })
  .refine((p) => p.status === 'ACTIVE' || p.productUrl === null, { message: 'productUrl must be null when not ACTIVE', path: ['productUrl'] });
export type Product = z.infer<typeof Product>;

/** One item of `GET /products`: only ACTIVE products, no `status` field. */
export const ProductSummary = z.object({
  productId: Id,
  sku: Id,
  name: Text,
  familyId: Id.nullable().default(null),
  familyName: NullableText,
  shortDescription: NullableText,
  minQuantity: z.number().int().positive().nullable().default(null),
  variantCount: z.number().int().nonnegative(),
  /** Normalised colour groups. */
  colors: z.array(Text).default([]),
  inStock: z.boolean().nullable().default(null),
  priceHint: PriceHint.nullable().default(null),
  imageUrl: NullableText,
  productUrl: NullableText,
  updatedAt: IsoDateTime.nullable().default(null),
});
export type ProductSummary = z.infer<typeof ProductSummary>;

export const SearchResponse = z.object({
  items: z.array(ProductSummary),
  page: z.object({
    limit: z.number().int().positive(),
    nextCursor: z.string().min(1).nullable().default(null),
    totalApprox: z.number().int().nonnegative().nullable().default(null),
  }),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const CustomizationEstimate = z
  .object({
    unitEur: Money,
    setupEur: Money,
    totalEur: Money,
    forQuantity: z.number().int().positive(),
    basis: z.literal('INDICATIVE'),
  })
  // totalEur = unitEur x forQuantity + setupEur (customization only, product excluded); 1 cent of rounding slack.
  .refine((e) => Math.abs(e.unitEur * e.forQuantity + e.setupEur - e.totalEur) <= 0.01 + 1e-9 * e.totalEur, {
    message: 'totalEur must equal unitEur x forQuantity + setupEur',
    path: ['totalEur'],
  });
export type CustomizationEstimate = z.infer<typeof CustomizationEstimate>;

export const Family = z.object({
  familyId: Id,
  name: Text,
  parentId: Id.nullable().default(null),
  productCount: z.number().int().nonnegative(),
  attributes: z
    .array(z.object({ name: z.string().min(1), label: Text, topValues: z.array(Text).default([]) }))
    .optional(),
});
export type Family = z.infer<typeof Family>;

export const FamiliesResponse = z.object({ items: z.array(Family) });
export type FamiliesResponse = z.infer<typeof FamiliesResponse>;

/**
 * `GET /describe`. The contract says the exact key names come from the backend's JSON Schema
 * (`schemas/v1`) and the published example is illustrative: this schema follows the example and
 * keeps every block optional-with-default, so a different nesting degrades to empty lists
 * instead of failing the call. Re-check against `schemas/v1` on delivery.
 */
export const Describe = z.object({
  contractVersion: z.string().min(1),
  filters: z
    .object({
      attributes: z.array(z.string()).default([...CATALOG_ATTRIBUTE_NAMES]),
      color: z.object({ groups: z.array(Text).default([]) }).default({ groups: [] }),
      size: z.object({ values: z.array(Text).default([]) }).default({ values: [] }),
    })
    .default({ attributes: [...CATALOG_ATTRIBUTE_NAMES], color: { groups: [] }, size: { values: [] } }),
  customization: z.object({ techniques: z.array(Text).default([]) }).default({ techniques: [] }),
  sort: z.array(z.string()).default([...CATALOG_SORTS]),
  limits: z
    .object({
      defaultLimit: z.number().int().positive().optional(),
      maxLimit: z.number().int().positive().optional(),
      maxQueryLength: z.number().int().positive().optional(),
      maxDescriptionLength: z.number().int().positive().optional(),
      requestsPerMinute: z.number().int().positive().optional(),
      cursorTtlSeconds: z.number().int().positive().optional(),
    })
    .loose()
    .default({}),
});
export type Describe = z.infer<typeof Describe>;

export const Health = z.object({
  status: z.enum(['ok', 'degraded']),
  contractVersion: z.string().min(1),
  connectorVersion: z.string().nullable().default(null),
  catalog: z
    .object({
      productCount: z.number().int().nonnegative().nullable().default(null),
      lastUpdatedAt: IsoDateTime.nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type Health = z.infer<typeof Health>;

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

// ---------------------------------------------------------------------------
// Request parameters (shared by the HTTP client, the stub and the tools)
// ---------------------------------------------------------------------------

export interface SearchParams {
  q?: string | undefined;
  /** Exact match on the product `sku` (may return several products). */
  sku?: string | undefined;
  familyId?: string | undefined;
  attributes?: Partial<Record<CatalogAttributeName, string>> | undefined;
  quantity?: number | undefined;
  sort?: CatalogSort | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface EstimateParams {
  technique: string;
  area: string;
  colors: number;
  quantity: number;
}

export interface FamiliesParams {
  parentId?: string | undefined;
  includeAttributes?: boolean | undefined;
}

export const CATALOG_MAX_QUERY_LENGTH = 200;
export const CATALOG_MAX_LIMIT = 100;
export const CATALOG_DEFAULT_LIMIT = 20;
