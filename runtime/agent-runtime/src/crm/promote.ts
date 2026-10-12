/**
 * Promotion to a native Opportunity (tanda 19), shared by the triage tool `upsert_opportunity`
 * (INTERESADO reply) and the manual endpoint `POST /opportunities/promote` (a person decides).
 *
 * `openOpportunityFor`: company name + fair of the hypothesis -> `«<Empresa> — <feria>»` ->
 * reuse the company's open Opportunity or create one at the first stage; then the note of the
 * reply (when given) is attached to it and to the person.
 *
 * `promoteHypothesis`: the manual path. Reads the hypothesis (tenant-scoped), refuses a REJECTED
 * one, takes the point of contact from the decision maker or, when `emailTo` is a personal
 * mailbox, from the Person of that address (created or completed through the same dedupe as the
 * ContactFinder). A generic `emailTo` (info@) gives an Opportunity without point of contact.
 */
import { TWENTY_OBJECTS, type TwentyClient, type TwentyCommercialHypothesisExpanded, type TwentyCompany } from '../integrations/twenty/index.js';
import { fairOfHypothesis, linkNoteToOpportunity, opportunityName, upsertOpenOpportunity, type UpsertOpportunityResult } from './opportunities.js';
import { isPersonMailbox, upsertPerson, type UpsertPersonResult } from './people.js';

export class PromotionError extends Error {
  constructor(
    readonly code: 'HYPOTHESIS_NOT_FOUND' | 'HYPOTHESIS_REJECTED' | 'HYPOTHESIS_WITHOUT_COMPANY' | 'COMPANY_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}

export interface OpenOpportunityInput {
  tenantId: string;
  companyId: string;
  hypothesisId?: string | null;
  pointOfContactId?: string | null;
  /** Note of the reply to attach to the opportunity (and to the person). */
  noteId?: string | null;
}

export interface OpenOpportunityResult extends UpsertOpportunityResult {
  fair: string | null;
  noteTargetsAdded: number;
}

/** Fair of a hypothesis read tenant-scoped; null when it does not exist or has none. */
async function fairOf(twenty: TwentyClient, tenantId: string, hypothesisId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const h = await twenty.get<TwentyCommercialHypothesisExpanded>(TWENTY_OBJECTS.commercialHypothesis, hypothesisId, { depth: 1, tenantId, ...(signal ? { signal } : {}) });
    if (!h) return null;
    const s = h.commercialSignal && twenty.belongsTo(h.commercialSignal, tenantId) ? h.commercialSignal : null;
    return fairOfHypothesis({ name: h.name, signalName: s?.name ?? null });
  } catch (err) {
    // The fair only decorates the name: an unreadable hypothesis never blocks the promotion.
    if (signal?.aborted) throw err;
    return null;
  }
}

export async function openOpportunityFor(twenty: TwentyClient, input: OpenOpportunityInput, signal?: AbortSignal): Promise<OpenOpportunityResult> {
  const company = await twenty.get<TwentyCompany>(TWENTY_OBJECTS.company, input.companyId, { depth: 0, ...(signal ? { signal } : {}) });
  if (!company) throw new PromotionError('COMPANY_NOT_FOUND', `company ${input.companyId} does not exist`);
  const fair = input.hypothesisId ? await fairOf(twenty, input.tenantId, input.hypothesisId, signal) : null;
  const result = await upsertOpenOpportunity(twenty, { companyId: company.id, name: opportunityName(company.name, fair), pointOfContactId: input.pointOfContactId ?? null }, signal);
  const added = input.noteId ? await linkNoteToOpportunity(twenty, input.noteId, { opportunityId: result.opportunity.id, personId: input.pointOfContactId ?? null }, signal) : [];
  return { ...result, fair, noteTargetsAdded: added.length };
}

export interface PromoteHypothesisResult extends OpenOpportunityResult {
  hypothesisId: string;
  person: UpsertPersonResult | null;
  pointOfContactId: string | null;
  /** Where the point of contact came from. */
  contactFrom: 'decision_maker' | 'email_to' | null;
}

export async function promoteHypothesis(twenty: TwentyClient, args: { tenantId: string; hypothesisId: string; signal?: AbortSignal }): Promise<PromoteHypothesisResult> {
  const { signal } = args;
  const h = await twenty.get<TwentyCommercialHypothesisExpanded>(TWENTY_OBJECTS.commercialHypothesis, args.hypothesisId, { depth: 1, tenantId: args.tenantId, ...(signal ? { signal } : {}) });
  if (!h) throw new PromotionError('HYPOTHESIS_NOT_FOUND', `hypothesis ${args.hypothesisId} does not exist`);
  if (h.status === 'REJECTED') throw new PromotionError('HYPOTHESIS_REJECTED', 'the hypothesis is REJECTED: it is not promoted');
  if (!h.companyId) throw new PromotionError('HYPOTHESIS_WITHOUT_COMPANY', 'the hypothesis has no company');

  let person: UpsertPersonResult | null = null;
  let pointOfContactId: string | null = null;
  let contactFrom: PromoteHypothesisResult['contactFrom'] = null;
  if (h.decisionMakerId) {
    pointOfContactId = h.decisionMakerId;
    contactFrom = 'decision_maker';
  } else {
    const emailTo = typeof h.emailTo === 'string' ? h.emailTo.split(/[,;\s]+/).find((e) => e.length > 0) ?? null : null;
    if (emailTo && isPersonMailbox(emailTo)) {
      person = await upsertPerson(twenty, { email: emailTo, companyId: h.companyId }, signal);
      if (person.person) {
        pointOfContactId = person.person.id;
        contactFrom = 'email_to';
      }
    }
  }
  const opened = await openOpportunityFor(twenty, { tenantId: args.tenantId, companyId: h.companyId, hypothesisId: h.id, pointOfContactId }, signal);
  return { ...opened, hypothesisId: h.id, person, pointOfContactId, contactFrom };
}
