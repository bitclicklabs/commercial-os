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
import { readOpportunityStages } from '../../crm/opportunities.js';
import {
  TWENTY_OBJECTS,
  filterValue,
  type TwentyCommercialHypothesisExpanded,
  type TwentyCompany,
  type TwentyNote,
  type TwentyNoteTarget,
  type TwentyOpportunity,
  type TwentyTask,
  type TwentyTaskTarget,
} from '../../integrations/twenty/index.js';
import { readMailMessages } from '../../integrations/twenty/messages.js';
import { meetingStageOf, stageVerdict } from '../../meetings/meeting-sync.js';
import { defineTool } from '../types.js';
import { RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

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
  /** Body of the first email (tanda 23: context of the follow-up draft). Optional for old callers. */
  emailBody: z.string().nullable().optional(),
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
          emailBody: text(r.emailBody),
          updatedAt: r.updatedAt ?? null,
        }));
        return { status: 'ok', output: { hypotheses, truncated } };
      }),
  });
}

// ---------------------------------------------------------------------------
// Tanda 23: the emails Twenty imported (follow-up sequence, «retomar conversación»)
// ---------------------------------------------------------------------------

/** Addresses read in one call (recipients of first emails + contacts of open opportunities). */
export const MAX_MESSAGE_ADDRESSES = 500;

const MailMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(['OUTBOUND', 'INBOUND']),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  receivedAt: z.string(),
  threadId: z.string().nullable(),
  from: z.string(),
  /** Subject / text masked by Twenty (`FIELD_RESTRICTED_…`): they come as null. */
  textRestricted: z.boolean(),
});
export type MailMessageView = z.infer<typeof MailMessageSchema>;

export const ListEmailMessagesInput = z
  .object({
    addresses: z.array(z.string().trim().min(3).max(320)).max(MAX_MESSAGE_ADDRESSES),
    since: z.iso.datetime({ offset: true }),
    /** Domains of the own mailbox: a FROM of one of them is OUTBOUND. */
    ownDomains: z.array(z.string().trim().min(3).max(253)).min(1).max(20),
  })
  .strict();

export const ListEmailMessagesOutput = z.object({
  /** `ok`; `no_messages` (no mailbox synced in Twenty); `unreadable` (object hidden / no permission). */
  status: z.enum(['ok', 'no_messages', 'unreadable']),
  byAddress: z.record(z.string(), z.array(MailMessageSchema)),
  truncated: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type ListEmailMessagesOutput = z.infer<typeof ListEmailMessagesOutput>;

/**
 * `list_crm_messages` (READ, untrusted): the emails Twenty imported from the connected mailbox
 * in which the given addresses take part, with their direction (OUTBOUND = FROM an own domain).
 * Read only: never sends, replies or changes anything (src/integrations/twenty/messages.ts).
 */
export function createListEmailMessagesTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_crm_messages',
    name: 'List email messages',
    version: '1.0.0',
    description:
      'List the emails imported by the CRM from the connected mailbox in which the given addresses take part (sender or recipient), received after a date, with their direction (outbound = sent from an own domain), subject, text and thread. Read only; never sends anything.',
    inputSchema: ListEmailMessagesInput,
    outputSchema: ListEmailMessagesOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:messages:read'],
    timeoutMs: 120_000,
    // Email subjects and bodies are written by third parties: data, never instructions.
    outputTrust: 'untrusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const read = await readMailMessages(deps.twenty, { addresses: input.addresses, since: new Date(input.since), ownDomains: input.ownDomains }, ctx.signal);
        if (read.status === 'ok') return { status: 'ok' as const, output: { status: 'ok' as const, byAddress: read.byAddress, truncated: read.truncated, error: null } };
        if (read.status === 'no_messages') return { status: 'ok' as const, output: { status: 'no_messages' as const, byAddress: {}, truncated: false, error: null } };
        return { status: 'ok' as const, output: { status: 'unreadable' as const, byAddress: {}, truncated: false, error: { code: read.code, message: read.message } } };
      }),
  });
}

export const MAX_CONTEXT_OPPORTUNITIES = 200;
/** Characters of the «Cualificación» note handed to the drafter. */
export const QUALIFICATION_NOTE_MAX = 1_500;
/** Prefix of the qualification note of an opportunity (tanda 23, InboxAgent): «Cualificación — X 🧾». */
export const QUALIFICATION_NOTE_PREFIX = 'Cualificación — ';

export const ListOpportunityFollowUpContextInput = z.object({ opportunityIds: z.array(RecordId).max(MAX_CONTEXT_OPPORTUNITIES) }).strict();
export const ListOpportunityFollowUpContextOutput = z.object({
  stages: z.array(z.string()),
  stageSource: z.enum(['twenty', 'default']),
  meetingStage: z.string().nullable(),
  opportunities: z.array(
    z.object({
      id: z.string(),
      stage: z.string().nullable(),
      /** `advance` = an earlier stage than the meeting one (the only one that gets «retomar conversación»). */
      stageVerdict: z.string(),
      /** Titles of the tasks of the opportunity that are not DONE. */
      openTaskTitles: z.array(z.string()),
      qualificationNote: z.string().nullable(),
    }),
  ),
});
export type ListOpportunityFollowUpContextOutput = z.infer<typeof ListOpportunityFollowUpContextOutput>;

/**
 * `list_opportunity_followup_context` (READ, untrusted): per opportunity, where its stage stands
 * relative to the meeting stage (stages read from the workspace SELECT, as crm/opportunities.ts),
 * the titles of its open tasks and its «Cualificación» note (bounded). Read only.
 */
export function createListOpportunityFollowUpContextTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_opportunity_followup_context',
    name: 'List opportunity follow-up context',
    version: '1.0.0',
    description: 'For the given CRM opportunities: their stage relative to the meeting stage, the titles of their open tasks and their qualification note. Read only.',
    inputSchema: ListOpportunityFollowUpContextInput,
    outputSchema: ListOpportunityFollowUpContextOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:opportunities:read', 'twenty:tasks:read', 'twenty:notes:read'],
    timeoutMs: 120_000,
    outputTrust: 'untrusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const { stages, source } = await readOpportunityStages(twenty, ctx.signal);
        const opportunities: ListOpportunityFollowUpContextOutput['opportunities'] = [];
        for (const id of [...new Set(input.opportunityIds)]) {
          const opp = await twenty.get<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, id, { depth: 0, signal: ctx.signal });
          if (!opp || opp.deletedAt) continue;
          const taskIds = (await twenty.list<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { filter: `targetOpportunityId[eq]:${filterValue(id)}`, limit: 100, signal: ctx.signal })).records
            .map((t) => t.taskId)
            .filter((t): t is string => typeof t === 'string' && t.length > 0);
          const openTaskTitles: string[] = [];
          for (const tid of [...new Set(taskIds)].slice(0, 50)) {
            const t = await twenty.get<TwentyTask>(TWENTY_OBJECTS.task, tid, { depth: 0, signal: ctx.signal });
            if (t && !t.deletedAt && t.status !== 'DONE' && typeof t.title === 'string') openTaskTitles.push(t.title);
          }
          const noteIds = (await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `targetOpportunityId[eq]:${filterValue(id)}`, limit: 100, signal: ctx.signal })).records
            .map((n) => n.noteId)
            .filter((n): n is string => typeof n === 'string' && n.length > 0);
          let qualificationNote: string | null = null;
          for (const nid of [...new Set(noteIds)].slice(0, 50)) {
            const n = await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, nid, { depth: 0, signal: ctx.signal });
            if (n && !n.deletedAt && typeof n.title === 'string' && n.title.trim().startsWith(QUALIFICATION_NOTE_PREFIX)) {
              const md = (n.bodyV2?.markdown ?? '').trim();
              // The newest sections are at the end: keep the tail.
              qualificationNote = md.length === 0 ? null : md.length <= QUALIFICATION_NOTE_MAX ? md : `…${md.slice(-(QUALIFICATION_NOTE_MAX - 1))}`;
              break;
            }
          }
          opportunities.push({ id, stage: opp.stage ?? null, stageVerdict: stageVerdict(opp.stage ?? null, stages), openTaskTitles, qualificationNote });
        }
        return { status: 'ok' as const, output: { stages, stageSource: source, meetingStage: meetingStageOf(stages), opportunities } };
      }),
  });
}
