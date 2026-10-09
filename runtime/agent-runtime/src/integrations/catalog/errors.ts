/**
 * Errors of the catalog client (HTTP and stub share them). The token never appears in a message.
 */
export type CatalogErrorCode =
  | 'CATALOG_DISABLED'
  | 'CATALOG_NOT_CONFIGURED'
  | 'CATALOG_UNAVAILABLE'
  | 'CATALOG_BAD_REQUEST'
  | 'CATALOG_UNAUTHENTICATED'
  | 'CATALOG_FORBIDDEN'
  | 'CATALOG_NOT_FOUND'
  | 'CATALOG_RATE_LIMITED'
  | 'CATALOG_TIMEOUT'
  | 'CATALOG_NETWORK_ERROR'
  | 'CATALOG_INVALID_RESPONSE'
  | 'CATALOG_CONTRACT_MISMATCH'
  | 'CATALOG_EGRESS_REFUSED';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

/**
 * Failures that mean "the connector is not usable right now" (the gate's definition of failure:
 * no answer, network error, 503, 401/403 or an unknown contract MAJOR). A 404 or a 400 is an
 * answer about the request, not about availability.
 */
export function isAvailabilityFailure(err: unknown): boolean {
  if (!(err instanceof CatalogError)) return true;
  return [
    'CATALOG_UNAVAILABLE',
    'CATALOG_TIMEOUT',
    'CATALOG_NETWORK_ERROR',
    'CATALOG_UNAUTHENTICATED',
    'CATALOG_FORBIDDEN',
    'CATALOG_CONTRACT_MISMATCH',
    'CATALOG_EGRESS_REFUSED',
    'CATALOG_NOT_CONFIGURED',
    'CATALOG_DISABLED',
  ].includes(err.code);
}
