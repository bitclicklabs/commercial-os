/**
 * Tools of the weekly setter report (tanda 24, task `setter-weekly-report`).
 *
 * - `read_setter_crm` (READ, untrusted): ONE read of what the setter metrics need from Twenty
 *   (src/metrics/setter-crm.ts), chosen by `op`: the mailbox of a window, the addresses that
 *   already had a message, the messages of some addresses, the open opportunities by stage, the
 *   overdue system tasks, the signal (fair) of some hypotheses, company names. Never writes. An
 *   unreadable source comes back as `{ status: 'no_disponible', reason }`, never as zeros.
 * - `create_report_note` (LOW_WRITE): an internal note WITHOUT targets (the weekly summary is not
 *   about one record). Idempotent by exact title among the notes created in the last
 *   `reuseWithinDays` days (the title has no year): the same note is returned, never edited.
 *   Writing a note never contacts anybody.
 */
import { z } from 'zod';
import { TWENTY_OBJECTS, filterValue, type TwentyNote } from '../../integrations/twenty/index.js';
import { SETTER_CRM_MAX_ITEMS, SETTER_CRM_OPS, twentySetterCrm, type SetterCrmOp } from '../../metrics/setter-crm.js';
import { defineTool } from '../types.js';
import { NOTE_BODY_MAX, noteTitle } from './note-tools.js';
import { ShortText, withTwenty, type TwentyToolDeps } from './shared.js';

export const SETTER_TOOL_IDS = ['read_setter_crm', 'create_report_note'] as const;

const Iso = z.iso.datetime({ offset: true });
const Address = z.string().trim().min(3).max(320);
const Domains = z.array(z.string().trim().min(3).max(253)).min(1).max(20);
const Ids = z.array(z.string().trim().min(1).max(64)).max(SETTER_CRM_MAX_ITEMS);
const MAX_WINDOW_MS = 100 * 86_400_000;

/** Fields each `op` needs (one flat object: tool input schemas must be a JSON object). */
const REQUIRED: Record<SetterCrmOp, ReadonlyArray<'since' | 'until' | 'before' | 'now' | 'addresses' | 'ownDomains' | 'hypothesisIds' | 'ids'>> = {
  mail_window: ['since', 'until', 'ownDomains'],
  prior_addresses: ['addresses', 'before'],
  mail_for: ['addresses', 'since', 'ownDomains'],
  open_opportunities: [],
  overdue_tasks: ['now'],
  origins: ['hypothesisIds'],
  company_names: ['ids'],
};

export const ReadSetterCrmInput = z
  .object({
    op: z.enum(SETTER_CRM_OPS),
    since: Iso.optional(),
    until: Iso.optional(),
    before: Iso.optional(),
    now: Iso.optional(),
    addresses: z.array(Address).max(SETTER_CRM_MAX_ITEMS).optional(),
    ownDomains: Domains.optional(),
    hypothesisIds: Ids.optional(),
    ids: Ids.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    for (const f of REQUIRED[v.op]) if (v[f] === undefined) c.addIssue({ code: 'custom', path: [f], message: `${f} is required for ${v.op}` });
    if (v.op === 'mail_window' && v.since && v.until) {
      const span = Date.parse(v.until) - Date.parse(v.since);
      if (span <= 0 || span > MAX_WINDOW_MS) c.addIssue({ code: 'custom', path: ['until'], message: 'until must be after since, at most 100 days later' });
    }
  });

export const ReadSetterCrmOutput = z.union([
  z.object({ status: z.literal('ok'), value: z.unknown() }),
  z.object({ status: z.literal('no_disponible'), reason: z.string() }),
]);

export function createReadSetterCrmTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'read_setter_crm',
    name: 'Read setter metrics sources',
    version: '1.0.0',
    description:
      'Read one source of the setter metrics from the CRM (op): mailbox messages of a window, addresses with earlier messages, messages of some addresses, open opportunities by stage, overdue system tasks, the signal of some hypotheses, company names. Read only; an unreadable source is reported as not available.',
    inputSchema: ReadSetterCrmInput,
    outputSchema: ReadSetterCrmOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:messages:read', 'twenty:opportunities:read', 'twenty:tasks:read', 'twenty:hypotheses:read', 'twenty:signals:read', 'twenty:companies:read'],
    timeoutMs: 120_000,
    // Addresses, subjects and names come from third parties: data, never instructions.
    outputTrust: 'untrusted',
    enabled: true,
    execute: async (input, ctx) => {
      const crm = twentySetterCrm(deps.twenty, { tenantId: ctx.tenantId, signal: ctx.signal });
      const value = await (async () => {
        switch (input.op) {
          // The required fields of each op are checked by the input schema.
          case 'mail_window':
            return crm.mailWindow({ since: new Date(input.since!), until: new Date(input.until!), ownDomains: input.ownDomains! });
          case 'prior_addresses':
            return crm.priorAddresses({ addresses: input.addresses!, before: new Date(input.before!) });
          case 'mail_for':
            return crm.mailFor({ addresses: input.addresses!, since: new Date(input.since!), ownDomains: input.ownDomains! });
          case 'open_opportunities':
            return crm.openOpportunities();
          case 'overdue_tasks':
            return crm.overdueTasks({ now: new Date(input.now!) });
          case 'origins':
            return crm.origins({ hypothesisIds: input.hypothesisIds! });
          case 'company_names':
            return crm.companyNames({ ids: input.ids! });
        }
      })();
      return { status: 'ok' as const, output: value };
    },
  });
}

export const CreateReportNoteInput = z
  .object({
    title: ShortText,
    bodyMarkdown: z.string().trim().min(1).max(NOTE_BODY_MAX),
    /** A same-title note created in the last N days is the same note (default 14). */
    reuseWithinDays: z.number().int().min(1).max(60).default(14),
  })
  .strict();

export const CreateReportNoteOutput = z.object({ created: z.boolean(), noteId: z.string(), title: z.string() });

export function createCreateReportNoteTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_report_note',
    name: 'Create report note',
    version: '1.0.0',
    description:
      'Create an internal report note (markdown) in the CRM without linking it to any record. Idempotent by title among the notes of the last days: an existing one is returned unchanged. Never sends anything to anybody.',
    inputSchema: CreateReportNoteInput,
    outputSchema: CreateReportNoteOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:notes:read', 'twenty:notes:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const title = noteTitle(input.title);
        const since = Date.now() - input.reuseWithinDays * 86_400_000;
        const { records } = await deps.twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: `title[eq]:${filterValue(title)}`, limit: 20, signal: ctx.signal });
        const same = records.find((n) => !n.deletedAt && noteTitle(n.title ?? '') === title && (!n.createdAt || Date.parse(n.createdAt) >= since));
        if (same) return { status: 'ok' as const, output: { created: false, noteId: same.id, title } };
        const note = await deps.twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown: input.bodyMarkdown } }, { signal: ctx.signal });
        return { status: 'ok' as const, output: { created: true, noteId: note.id, title } };
      }),
  });
}
