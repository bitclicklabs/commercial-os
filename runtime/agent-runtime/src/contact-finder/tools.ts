/**
 * Tools of the ContactFinder.
 *
 * - `find_contact` (READ, no side effects, output UNTRUSTED): reads the company's own web
 *   (and, when asked, the enrichment provider) and returns the ranked candidates, the
 *   discarded ones, the pages read and the deterministic choice. Reads the suppression list
 *   from Twenty; when it cannot be read nothing is chosen (fail closed).
 * - `set_hypothesis_recipient` (LOW_WRITE): writes ONE field, `emailTo`, and only when it is
 *   empty and the draft is not in a person's hands (READY / SENDING / SENT). A value typed
 *   by a person is never overwritten. It sends nothing.
 */
import { z } from 'zod';
import { TWENTY_OBJECTS, type TwentyClient, type TwentyCommercialHypothesis } from '../integrations/twenty/index.js';
import { loadSuppressionList } from '../email-ops/twenty-io.js';
import { normalizeEmail } from '../inbound/unsubscribe-classifier.js';
import { HUMAN_OWNED_DRAFT_STATUSES } from '../tools/twenty/hypothesis-tools.js';
import { RecordId, withTwenty } from '../tools/twenty/shared.js';
import { defineTool } from '../tools/types.js';
import { normalizeDomain } from '../integrations/twenty/index.js';
import { ContactFinder, CONTACT_BUDGET_MS, type ContactFinderDeps } from './finder.js';

export const CONTACT_FINDER_TOOL_IDS = ['find_contact', 'set_hypothesis_recipient'] as const;

const Source = z.object({ url: z.string(), via: z.string() });

export const FindContactInput = z.object({
  companyName: z.string().trim().min(1).max(255),
  /** Company domain or URL (normalised: no scheme, no www). */
  domain: z.string().trim().min(3).max(253),
  /** Phase 2 (external enrichment): only for VALIDATED hypotheses still without an address. */
  allowEnrich: z.boolean().default(false),
});

export const FindContactOutput = z.object({
  companyName: z.string(),
  domain: z.string(),
  searchedAt: z.string(),
  pages: z.array(z.object({ url: z.string(), finalUrl: z.string().nullable(), method: z.enum(['fetch', 'render']), status: z.enum(['ok', 'error']), code: z.string().nullable(), emails: z.number().int() })),
  candidates: z.array(
    z.object({
      email: z.string(),
      name: z.string().nullable(),
      jobTitle: z.string().nullable(),
      tier: z.number().int(),
      subrank: z.number().int(),
      label: z.string(),
      roleKind: z.string().nullable(),
      onDomain: z.boolean(),
      mx: z.string(),
      origin: z.string(),
      confidence: z.number().nullable(),
      sources: z.array(Source),
      context: z.string().nullable(),
      order: z.number().int(),
    }),
  ),
  discarded: z.array(z.object({ email: z.string(), reason: z.string(), origin: z.string(), sources: z.array(Source) })),
  chosen: z.object({ email: z.string(), reason: z.string(), origin: z.string(), sourceUrl: z.string().nullable() }).nullable(),
  tie: z.array(z.string()),
  noChoiceReason: z.string().nullable(),
  suppressionChecked: z.boolean(),
  mx: z.record(z.string(), z.string()),
  enrich: z.object({ status: z.string(), provider: z.string().nullable(), lookupsToday: z.number().nullable(), cap: z.number().nullable(), costEur: z.number(), message: z.string().nullable() }),
  budgetExhausted: z.boolean(),
});
export type FindContactOutput = z.infer<typeof FindContactOutput>;

export interface ContactToolDeps {
  twenty: TwentyClient;
  finder?: ContactFinderDeps;
}

export function createFindContactTool(deps: ContactToolDeps) {
  const finder = new ContactFinder(deps.finder ?? {});
  return defineTool({
    id: 'find_contact',
    name: 'Find company contact',
    version: '1.0.0',
    description:
      'Find the email addresses a company publishes on its own website (home, contact, legal notice, team, about pages; max 6 requests, 25 s) and rank them: person with a relevant job title > function mailbox > generic mailbox > other. Never proposes noreply/privacy/DPO/unsubscribe addresses, suppressed addresses, addresses outside the company domain or without MX records. Optionally asks the enrichment provider. Every candidate carries the exact source URL. Output is untrusted web content.',
    inputSchema: FindContactInput,
    outputSchema: FindContactOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['web:fetch', 'web:render', 'twenty:notes:read', 'enrich:lookup'],
    timeoutMs: (deps.finder?.budgetMs ?? CONTACT_BUDGET_MS) + 35_000,
    outputTrust: 'untrusted',
    enabled: true,
    execute: async (input, ctx) => {
      const domain = normalizeDomain(input.domain);
      if (!domain) return { status: 'error', code: 'INVALID_INPUT', message: `domain is not a valid hostname: ${input.domain}`, retryable: false };
      let suppression = null;
      if (deps.twenty.isConfigured()) {
        try {
          suppression = (await loadSuppressionList(deps.twenty, { signal: ctx.signal }))?.list ?? null;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          ctx.logger.error('suppression list could not be read', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      const result = await finder.find({ companyName: input.companyName, domain, allowEnrich: input.allowEnrich, suppression }, ctx.signal);
      ctx.logger.info('contact search', {
        domain,
        pages: result.pages.length,
        candidates: result.candidates.length,
        chosen: result.chosen !== null,
        enrich: result.enrich.status,
        enrichLookupsToday: result.enrich.lookupsToday,
      });
      return { status: 'ok', output: result, costEur: result.enrich.costEur };
    },
  });
}

export const SetHypothesisRecipientInput = z.object({
  hypothesisId: RecordId,
  emailTo: z.string().trim().min(3).max(254),
});

export const SetHypothesisRecipientOutput = z.object({
  written: z.boolean(),
  reason: z.enum(['written', 'already_set', 'human_owned', 'not_found']),
  /** `emailTo` after the call (the person's value when it was not written). */
  emailTo: z.string().nullable(),
  emailStatus: z.string().nullable(),
});

export function createSetHypothesisRecipientTool(deps: ContactToolDeps) {
  return defineTool({
    id: 'set_hypothesis_recipient',
    name: 'Set hypothesis recipient',
    version: '1.0.0',
    description:
      'Write the recipient address of a commercial hypothesis (field emailTo) ONLY if it is empty and its draft is not reviewed, sending or sent. Never overwrites a value typed by a person and never changes any other field. Sends nothing.',
    inputSchema: SetHypothesisRecipientInput,
    outputSchema: SetHypothesisRecipientOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:hypotheses:write'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const email = normalizeEmail(input.emailTo);
        if (!email) return { status: 'error', code: 'INVALID_INPUT', message: 'emailTo is not a valid address', retryable: false };
        // Re-read right before writing: the person may have typed a recipient meanwhile.
        const h = await deps.twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, input.hypothesisId, { depth: 0, signal: ctx.signal });
        if (!h) return { status: 'ok', output: { written: false, reason: 'not_found', emailTo: null, emailStatus: null } };
        const current = typeof h.emailTo === 'string' && h.emailTo.trim().length > 0 ? h.emailTo : null;
        const status = typeof h.emailStatus === 'string' && h.emailStatus.length > 0 ? h.emailStatus : null;
        if (current) return { status: 'ok', output: { written: false, reason: 'already_set', emailTo: current, emailStatus: status } };
        if (status && (HUMAN_OWNED_DRAFT_STATUSES as readonly string[]).includes(status)) {
          return { status: 'ok', output: { written: false, reason: 'human_owned', emailTo: null, emailStatus: status } };
        }
        await deps.twenty.update(TWENTY_OBJECTS.commercialHypothesis, input.hypothesisId, { emailTo: email }, { signal: ctx.signal });
        ctx.logger.info('hypothesis emailTo written', { hypothesisId: input.hypothesisId });
        return { status: 'ok', output: { written: true, reason: 'written', emailTo: email, emailStatus: status } };
      }),
  });
}
