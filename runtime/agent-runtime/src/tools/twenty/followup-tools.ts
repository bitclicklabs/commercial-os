/**
 * `list_sent_hypotheses` (READ, tanda 21): the commercial hypotheses of the run's tenant whose
 * first email was sent from Twenty (`emailStatus = SENT`), with what the daily lead follow-up
 * needs to write its Task without any LLM call: company (id + name), the angle already stored
 * (`need`, `whyNow`), recipient and subject of the email. Relations come from `depth=1` when the
 * server expands them; otherwise the company is read once per distinct id (bounded).
 *
 * Read only: it never changes a hypothesis (the send workflow reads the email fields, so a
 * follow-up must never touch them).
 */
import { z } from 'zod';
import { TWENTY_OBJECTS, filterValue, type TwentyCommercialHypothesisExpanded, type TwentyCompany } from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { withTwenty, type TwentyToolDeps } from './shared.js';

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
/** Distinct companies read one by one when the listing does not expand them. */
export const MAX_COMPANY_LOOKUPS = 200;

export const SentHypothesis = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().nullable(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  need: z.string().nullable(),
  whyNow: z.string().nullable(),
  emailTo: z.string().nullable(),
  emailSubject: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type SentHypothesis = z.infer<typeof SentHypothesis>;

export const ListSentHypothesesInput = z.object({}).strict();

export const ListSentHypothesesOutput = z.object({
  hypotheses: z.array(SentHypothesis),
  truncated: z.boolean(),
});
export type ListSentHypothesesOutput = z.infer<typeof ListSentHypothesesOutput>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

export function createListSentHypothesesTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_sent_hypotheses',
    name: 'List sent hypotheses',
    version: '1.0.0',
    description:
      'List the commercial hypotheses of the current tenant whose first email was sent (emailStatus SENT), with company, need, why now, recipient and subject. Read only.',
    inputSchema: ListSentHypothesesInput,
    outputSchema: ListSentHypothesesOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:companies:read'],
    timeoutMs: 60_000,
    // need / whyNow / subject are model-written or typed by a person: data, never instructions.
    outputTrust: 'untrusted',
    enabled: true,
    execute: (_input, ctx) =>
      withTwenty(deps, async () => {
        const rows: TwentyCommercialHypothesisExpanded[] = [];
        let truncated = false;
        let after: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) {
            truncated = true;
            break;
          }
          const res = await deps.twenty.list<TwentyCommercialHypothesisExpanded>(TWENTY_OBJECTS.commercialHypothesis, {
            filter: `emailStatus[eq]:${filterValue('SENT')}`,
            limit: PAGE_SIZE,
            orderBy: 'createdAt',
            depth: 1,
            ...(after ? { startingAfter: after } : {}),
            tenantId: ctx.tenantId,
            signal: ctx.signal,
          });
          rows.push(...res.records.filter((r) => r.emailStatus === 'SENT' && !r.deletedAt));
          const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
          if (!next) break;
          after = next;
        }
        const companies = new Map<string, string | null>();
        for (const r of rows) if (r.companyId && r.company) companies.set(r.companyId, text(r.company.name));
        let lookups = 0;
        for (const id of new Set(rows.map((r) => r.companyId).filter((v): v is string => typeof v === 'string' && v.length > 0))) {
          if (companies.has(id) || lookups >= MAX_COMPANY_LOOKUPS) continue;
          lookups += 1;
          const c = await deps.twenty.get<TwentyCompany>(TWENTY_OBJECTS.company, id, { depth: 0, signal: ctx.signal });
          companies.set(id, text(c?.name));
        }
        const hypotheses = rows.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status ?? null,
          companyId: r.companyId ?? null,
          companyName: r.companyId ? (companies.get(r.companyId) ?? null) : null,
          need: text(r.need),
          whyNow: text(r.whyNow),
          emailTo: text(r.emailTo),
          emailSubject: text(r.emailSubject),
          updatedAt: r.updatedAt ?? null,
        }));
        return { status: 'ok', output: { hypotheses, truncated } };
      }),
  });
}
