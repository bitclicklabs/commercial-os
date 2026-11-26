/**
 * Calendar event <-> open Opportunity matching (tanda 22, task `meeting-sync`). Pure.
 *
 * A participant of an event matches an OPEN Opportunity when, in this order of strength:
 * 1. `point_of_contact`: its address (or its Twenty person) is the opportunity's point of contact;
 * 2. `company_person`: its address (or person) is one of the People of the opportunity's company;
 * 3. `domain`: its address is on the company's domain (or a subdomain), never for a free-mail
 *    domain (gmail.com, hotmail.com...: src/inbound/reply-links.ts FREEMAIL_DOMAINS).
 * Participants of the own team (workspace members, MEETING_INTERNAL_DOMAINS) and participants who
 * DECLINED never match; cancelled events never match.
 *
 * One company with several open opportunities: the ones matched through their point of contact,
 * else the oldest (the same one `findOpenOpportunity` reuses).
 */
import { emailDomain, isDomainOrSubdomain } from '../inbound/unsubscribe-classifier.js';
import { FREEMAIL_DOMAINS } from '../inbound/reply-links.js';
import type { CalendarEventView, CalendarParticipant } from './calendar.js';

export type MatchVia = 'point_of_contact' | 'company_person' | 'domain';
const STRENGTH: Record<MatchVia, number> = { point_of_contact: 3, company_person: 2, domain: 1 };

export interface OpenOpportunityView {
  id: string;
  name: string | null;
  stage: string | null;
  createdAt: string;
  companyId: string | null;
  companyName: string | null;
  companyDomain: string | null;
  pointOfContactId: string | null;
  pointOfContactName: string | null;
  pointOfContactEmails: string[];
  /** People of the company (ids and lower-case addresses). */
  companyPeople: Array<{ id: string; emails: string[] }>;
  /** The company's commercial hypotheses of the run's tenant, newest first (for the task links). */
  hypotheses: Array<{ id: string; name: string | null }>;
}

export interface MeetingMatch {
  opportunityId: string;
  companyId: string | null;
  eventId: string;
  /** Idempotency key of the event: its iCalUID (stable across a channel re-sync), else its id. */
  eventKey: string;
  via: MatchVia;
  /** Addresses of the participants that matched. */
  matchedHandles: string[];
}

export function eventKey(e: Pick<CalendarEventView, 'id' | 'iCalUid'>): string {
  return e.iCalUid ? `ical:${e.iCalUid}` : `event:${e.id}`;
}

const isEmail = (h: string | null): h is string => typeof h === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(h);

export function isInternalParticipant(p: CalendarParticipant, internalDomains: readonly string[]): boolean {
  if (p.workspaceMemberId) return true;
  return isEmail(p.handle) && internalDomains.some((d) => isDomainOrSubdomain(emailDomain(p.handle!), d));
}

/** Participants that can match a client: external, not declined, with an address or a person. */
export function externalParticipants(e: CalendarEventView, internalDomains: readonly string[]): CalendarParticipant[] {
  return e.participants.filter((p) => p.responseStatus !== 'DECLINED' && !isInternalParticipant(p, internalDomains) && (isEmail(p.handle) || p.personId !== null));
}

function matchOne(o: OpenOpportunityView, people: CalendarParticipant[]): { via: MatchVia; handles: string[] } | null {
  let best: MatchVia | null = null;
  const handles = new Set<string>();
  const note = (via: MatchVia, p: CalendarParticipant) => {
    if (!best || STRENGTH[via] > STRENGTH[best]) {
      best = via;
      handles.clear();
    }
    if (via === best && p.handle) handles.add(p.handle);
  };
  const poc = new Set(o.pointOfContactEmails.map((e) => e.toLowerCase()));
  const staff = new Set(o.companyPeople.flatMap((p) => p.emails.map((e) => e.toLowerCase())));
  const staffIds = new Set(o.companyPeople.map((p) => p.id));
  const domain = o.companyDomain?.toLowerCase() ?? null;
  for (const p of people) {
    const h = p.handle;
    if ((h && poc.has(h)) || (p.personId !== null && p.personId === o.pointOfContactId)) note('point_of_contact', p);
    else if ((h && staff.has(h)) || (p.personId !== null && staffIds.has(p.personId))) note('company_person', p);
    else if (domain && isEmail(h)) {
      const d = emailDomain(h);
      if (!FREEMAIL_DOMAINS.has(d) && isDomainOrSubdomain(d, domain)) note('domain', p);
    }
  }
  return best ? { via: best, handles: [...handles].sort() } : null;
}

/** Every (event, opportunity) match, oldest event first. */
export function matchMeetings(events: readonly CalendarEventView[], opportunities: readonly OpenOpportunityView[], internalDomains: readonly string[]): MeetingMatch[] {
  const out: MeetingMatch[] = [];
  const ordered = [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const e of ordered) {
    if (e.isCanceled) continue;
    const people = externalParticipants(e, internalDomains);
    if (people.length === 0) continue;
    const hits = opportunities.map((o) => ({ o, m: matchOne(o, people) })).filter((x): x is { o: OpenOpportunityView; m: { via: MatchVia; handles: string[] } } => x.m !== null);
    // Per company: the point-of-contact matches, else the oldest opportunity.
    const byCompany = new Map<string, typeof hits>();
    for (const h of hits) {
      const k = h.o.companyId ?? `opp:${h.o.id}`;
      byCompany.set(k, [...(byCompany.get(k) ?? []), h]);
    }
    for (const group of byCompany.values()) {
      const poc = group.filter((h) => h.m.via === 'point_of_contact');
      const chosen = poc.length > 0 ? poc : [[...group].sort((a, b) => a.o.createdAt.localeCompare(b.o.createdAt))[0]!];
      for (const h of chosen) out.push({ opportunityId: h.o.id, companyId: h.o.companyId, eventId: e.id, eventKey: eventKey(e), via: h.m.via, matchedHandles: h.m.handles });
    }
  }
  return out;
}
