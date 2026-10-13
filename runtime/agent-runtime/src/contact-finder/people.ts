/**
 * Which candidates of a contact search become native Twenty Persons (tanda 19, pure).
 *
 * A candidate becomes a Person when ALL of these hold:
 * - a person NAME was published next to the address (web) or returned by the provider, and it
 *   reads as a person name (`splitPersonName`);
 * - the address is a personal mailbox: never `info@` / `comercial@` / `rrhh@` (not people);
 * - it is usable: on the company domain, MX verified, not suppressed (the suppression list was
 *   read; when it could not be, nobody is created: fail closed);
 * - web candidates as published; provider candidates (phase 2) only with confidence >= 0.70 AND
 *   a job title (PM decision);
 * - it is the CHOSEN address, or a priority-1 candidate (person with a relevant job title).
 *
 * The chosen one goes first; at most `MAX_PEOPLE_PER_SEARCH` per search.
 */
import { isPersonMailbox, splitPersonName } from '../crm/people.js';
import { ENRICH_MIN_CONFIDENCE } from './enrich/types.js';
import type { ContactCandidate, FinderResult } from './finder.js';

export const MAX_PEOPLE_PER_SEARCH = 3;

export interface ContactPersonCandidate {
  email: string;
  name: string;
  jobTitle: string | null;
  chosen: boolean;
}

function usable(c: ContactCandidate): boolean {
  if (!c.onDomain || c.tier > 4 || c.mx !== 'ok') return false;
  if (c.origin === 'web') return true;
  return (c.confidence ?? 0) >= ENRICH_MIN_CONFIDENCE && !!c.jobTitle && c.jobTitle.trim().length > 0;
}

export function contactPeople(result: Pick<FinderResult, 'candidates' | 'chosen' | 'suppressionChecked'>): ContactPersonCandidate[] {
  if (!result.suppressionChecked) return [];
  const chosenEmail = result.chosen?.email ?? null;
  const out: ContactPersonCandidate[] = [];
  const ordered = [...result.candidates].sort((a, b) => Number(b.email === chosenEmail) - Number(a.email === chosenEmail));
  for (const c of ordered) {
    if (out.length >= MAX_PEOPLE_PER_SEARCH) break;
    const chosen = c.email === chosenEmail;
    if (!chosen && c.tier !== 1) continue;
    if (!c.name || !splitPersonName(c.name) || !isPersonMailbox(c.email) || !usable(c)) continue;
    if (out.some((p) => p.email === c.email)) continue;
    out.push({ email: c.email, name: c.name, jobTitle: c.jobTitle, chosen });
  }
  return out;
}
