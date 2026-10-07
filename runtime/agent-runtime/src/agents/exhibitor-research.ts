/**
 * Research record of one relevant exhibitor (LLD v0.1 section 5.2, `research.result.v1` of
 * LLD v0.2 section 7.4). Composed ONLY from data the run already has (catalog entry, profile
 * lookup, verified domain, visited URLs): no extra LLM call. The summary states what was
 * observed, never the model's assessment (that lives in the hypothesis).
 *
 * Research types (enum of `research.result.v1`):
 * - scout mode (`exhibitor_profile`)  -> `COMPANY_PROFILE`: the exhibitor as read in the fair's
 *   catalog, plus its profile page and website when the scout opened them;
 * - direct mode (`event_exhibitor`)   -> `EVENT_EXHIBITORS`: the exhibitor as given in the
 *   input (fixture / manual list).
 *
 * `confidence` measures how much of the profile is verified data (not the commercial fit):
 * 0.5 listed as exhibitor in a source, +0.2 website domain, +0.1 sector, +0.1 description
 * (max 0.9; direct mode without a source URL: 0.1 less, the list is not a visited page).
 */
import type { ResearchType, SignalType } from '../integrations/twenty/index.js';
import type { ExhibitorInput, ExhibitorResult, ProspectorEvent } from './prospector-core.js';

export type ResearchMode = 'scout' | 'direct';

export const RESEARCH_TYPE_BY_MODE: Record<ResearchMode, ResearchType> = {
  scout: 'COMPANY_PROFILE',
  direct: 'EVENT_EXHIBITORS',
};

export interface ExhibitorResearchArgs {
  mode: ResearchMode;
  event: ProspectorEvent;
  exhibitor: ExhibitorInput;
  /** Name / domain of the company as written in the CRM. */
  companyName: string;
  companyDomain: string | null;
  /** Where the domain came from (`input`, the profile lookup, an existing CRM company). */
  domainSource: 'input' | 'profile' | 'crm' | null;
  profile?: ExhibitorResult['profile'];
  /** URLs really visited (scout: known sources of the ledger), event page first. */
  sources: string[];
  signalTitle: string;
}

export interface ExhibitorResearch {
  researchType: ResearchType;
  query: string;
  summary: string;
  structuredResult: Record<string, unknown>;
  sources: string[];
  confidence: number;
}

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export function buildExhibitorResearch(a: ExhibitorResearchArgs): ExhibitorResearch | null {
  const sources = [...new Set(a.sources.filter((u) => /^https?:\/\//i.test(u)))].slice(0, 50);
  if (sources.length === 0) return null;
  const { event, exhibitor } = a;
  const when = [event.date, event.location].filter(Boolean).join(', ');
  const catalogHost = hostOf(event.source_url);
  const sector = exhibitor.sector?.trim() || null;
  const description = exhibitor.description?.trim() || null;
  const profileUrl = a.profile?.url && sources.includes(a.profile.url) ? a.profile.url : null;

  const sentences: string[] = [];
  sentences.push(
    a.mode === 'scout'
      ? `${exhibitor.name} figura como expositor en ${event.name}${when ? ` (${when})` : ''} según el catálogo publicado en ${catalogHost ?? 'la web de la feria'}.`
      : `${exhibitor.name} figura como expositor en ${event.name}${when ? ` (${when})` : ''} según la lista de expositores recibida${catalogHost ? ` (fuente: ${catalogHost})` : ''}.`,
  );
  sentences.push(sector ? `Sector indicado: ${oneLine(sector, 160)}.` : 'El catálogo no indica sector.');
  if (a.companyDomain) {
    const origin =
      a.domainSource === 'profile'
        ? 'tomada de su ficha en el catálogo de la feria'
        : a.domainSource === 'input'
          ? a.mode === 'scout'
            ? 'indicada en el catálogo'
            : 'indicada en la lista de expositores'
          : 'la de la empresa que ya estaba en el CRM';
    sentences.push(`Web: ${a.companyDomain} (${origin}).`);
  } else {
    sentences.push('Sin web verificada.');
  }
  if (description) sentences.push(`Descripción del catálogo: «${oneLine(description, 300)}».`);
  const summary = sentences.join(' ');

  const missing: string[] = [];
  if (!sector) missing.push('sector');
  if (!a.companyDomain) missing.push('website');
  if (!description) missing.push('description');
  missing.push('employeeRange', 'contacts');

  const profile: Record<string, unknown> = { legalName: a.companyName };
  if (sector) profile.sector = oneLine(sector, 255);
  if (a.companyDomain) profile.website = `https://${a.companyDomain}`;
  const signalType: SignalType = event.type;
  const structuredResult: Record<string, unknown> = {
    profile,
    signals: [
      {
        type: signalType,
        title: a.signalTitle,
        ...(description ? { description: oneLine(description, 1000) } : {}),
        sourceUrl: event.source_url ?? sources[0]!,
        eventDate: event.date ?? null,
        confidence: 1,
      },
    ],
    dataQuality: { missingFields: missing, conflicts: [] },
  };

  let confidence = 0.5 + (a.companyDomain ? 0.2 : 0) + (sector ? 0.1 : 0) + (description ? 0.1 : 0);
  if (a.mode === 'direct' && !event.source_url) confidence -= 0.1;
  confidence = Math.round(Math.min(0.9, Math.max(0.1, confidence)) * 100) / 100;

  const query =
    a.mode === 'scout'
      ? `Ficha del expositor «${exhibitor.name}» en el catálogo de ${event.name}${event.source_url ? ` (${event.source_url})` : ''}${profileUrl ? ` y su página de expositor` : ''}.`
      : `Expositor «${exhibitor.name}» de ${event.name} en la lista recibida (modo directo).`;

  return { researchType: RESEARCH_TYPE_BY_MODE[a.mode], query: query.slice(0, 2000), summary: summary.slice(0, 4000), structuredResult, sources, confidence };
}
