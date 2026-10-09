import type { CustomizationEstimate, Describe, EstimateParams, FamiliesParams, FamiliesResponse, Health, Product, SearchParams, SearchResponse } from './types.js';

export interface CatalogCallOptions {
  signal?: AbortSignal | undefined;
}

/**
 * The six operations of contract v1.1, as the runtime consumes them. Implemented by the HTTP
 * client (`HttpCatalogClient`) and by the fixtures stub (`StubCatalogClient`). Every method
 * returns contract-valid data (zod-parsed) or throws a `CatalogError`.
 */
export interface CatalogApi {
  readonly kind: 'stub' | 'http';
  searchProducts(params: SearchParams, opts?: CatalogCallOptions): Promise<SearchResponse>;
  /** Tombstones come back as DISCONTINUED / REMOVED; an unknown id throws CATALOG_NOT_FOUND. */
  getProduct(productId: string, opts?: CatalogCallOptions): Promise<Product>;
  estimateCustomization(productId: string, params: EstimateParams, opts?: CatalogCallOptions): Promise<CustomizationEstimate>;
  listFamilies(params?: FamiliesParams, opts?: CatalogCallOptions): Promise<FamiliesResponse>;
  describe(opts?: CatalogCallOptions): Promise<Describe>;
  health(opts?: CatalogCallOptions): Promise<Health>;
}
