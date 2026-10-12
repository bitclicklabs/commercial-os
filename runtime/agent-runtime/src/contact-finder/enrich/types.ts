/**
 * External enrichment (phase 2 of the ContactFinder): domain -> people and mailboxes known
 * by a data provider. Only asked for VALIDATED hypotheses that are still without an address
 * after reading the company's own website, and OFF by default (`ENRICH_PROVIDER=stub`, whose
 * fixtures only cover reserved test domains).
 */

export interface EnrichCandidate {
  email: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  department: string | null;
  /** 0-1 (Hunter answers 0-100). */
  confidence: number;
  /** Public pages where the provider saw the address (http(s) only). */
  sources: string[];
}

export class EnrichError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EnrichError';
  }
}

export interface EnrichProvider {
  /** `hunter`, `stub`. Recorded in the Research next to every candidate (GDPR traceability). */
  readonly name: string;
  /** One domain search. Throws EnrichError. */
  lookup(domain: string, signal: AbortSignal): Promise<EnrichCandidate[]>;
}

export type EnrichOutcome =
  | { status: 'ok'; provider: string; candidates: EnrichCandidate[]; costEur: number; lookupsToday: number; cap: number }
  | { status: 'cap_reached'; provider: string; lookupsToday: number; cap: number }
  | { status: 'error'; provider: string; code: string; message: string; lookupsToday: number; cap: number };

/** Below this confidence an enriched address is listed in the Research but never written into `emailTo`. */
export const ENRICH_MIN_CONFIDENCE = 0.7;
