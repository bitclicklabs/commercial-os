/**
 * Stub enrichment provider (`ENRICH_PROVIDER=stub`, the default; also `hunter` without a key).
 * Its fixtures only cover RESERVED test domains (RFC 2606 `.example`): for any real domain it
 * returns nothing, so the default configuration never invents a contact.
 */
import type { EnrichCandidate, EnrichProvider } from './types.js';

export const STUB_ENRICH_FIXTURES: Readonly<Record<string, readonly EnrichCandidate[]>> = {
  'conservas-ejemplo.example': [
    {
      email: 'laura.marin@conservas-ejemplo.example',
      firstName: 'Laura',
      lastName: 'Marín',
      position: 'Responsable de Marketing',
      department: 'marketing',
      confidence: 0.91,
      sources: ['https://conservas-ejemplo.example/prensa'],
    },
    {
      email: 'j.soto@conservas-ejemplo.example',
      firstName: 'Javier',
      lastName: 'Soto',
      position: null,
      department: null,
      confidence: 0.52,
      sources: [],
    },
  ],
  'poco-fiable.example': [
    { email: 'pedro@poco-fiable.example', firstName: 'Pedro', lastName: null, position: 'Director comercial', department: 'sales', confidence: 0.55, sources: [] },
  ],
};

export class StubEnrichProvider implements EnrichProvider {
  readonly name = 'stub';
  readonly calls: string[] = [];

  constructor(private readonly fixtures: Readonly<Record<string, readonly EnrichCandidate[]>> = STUB_ENRICH_FIXTURES) {}

  async lookup(domain: string): Promise<EnrichCandidate[]> {
    this.calls.push(domain);
    return (this.fixtures[domain.toLowerCase()] ?? []).map((c) => ({ ...c, sources: [...c.sources] }));
  }
}
