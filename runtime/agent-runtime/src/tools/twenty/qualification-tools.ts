/**
 * record_opportunity_qualification (LOW_WRITE, tanda 23): writes the qualification of an
 * opportunity extracted from a client's reply (src/crm/qualification.ts, already validated against
 * the client's literal text by the caller):
 *
 * 1. the note «Cualificación — {empresa} 🧾» on the opportunity (and its company / person): created
 *    the first time; afterwards ONE section per reply is appended at the end (what a person wrote
 *    in the note stays). Idempotent: a section whose header (`### Respuesta del <fecha>`) is
 *    already in the note is not appended again;
 * 2. the STANDARD fields of the opportunity, only when they are EMPTY: `amount` (the budget in EUR,
 *    as micros; for a range the lower end) and `closeDate` (the needed-by date). A value already
 *    there (put by a person, or by an earlier reply) is never overwritten.
 *
 * The note goes first: a call that dies after it finds the section again and only fills the
 * fields. No schema change in the Twenty App. Never sends anything to anybody.
 */
import { z } from 'zod';
import {
  QUALIFICATION_NOTE_HEADER,
  qualificationNoteTitle,
  qualificationSection,
  qualificationSectionTitle,
  type QualificationData,
} from '../../crm/qualification.js';
import { TWENTY_OBJECTS, eurToCurrency, filterValue, type TwentyClient, type TwentyNote, type TwentyNoteTarget, type TwentyOpportunity } from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

const Quote = z.string().trim().min(1).max(300);
const Text = z.string().trim().min(1).max(80);
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RecordQualificationInput = z.object({
  opportunityId: RecordId,
  companyId: RecordId.nullable().optional(),
  personId: RecordId.nullable().optional(),
  /** Name for the note title. */
  companyName: z.string().trim().min(1).max(200),
  /** Local `AAAA-MM-DD HH:mm` of the reply (section header, idempotency marker). */
  receivedLocal: z.string().trim().min(1).max(40),
  data: z.object({
    quantity: z.object({ value: z.number().int().positive(), quote: Quote }).nullable(),
    budget: z.object({ min: z.number().positive(), max: z.number().positive().nullable(), quote: Quote }).nullable(),
    neededBy: z.object({ date: Ymd, quote: Quote }).nullable(),
    decisionMaker: z.object({ value: Text, quote: Quote }).nullable(),
    products: z.array(z.object({ value: Text, quote: Quote })).max(5),
  }),
});

const FieldOutcome = z.enum(['set', 'kept', 'none']);
export const RecordQualificationOutput = z.object({
  found: z.boolean(),
  noteId: z.string().nullable(),
  noteCreated: z.boolean(),
  sectionAppended: z.boolean(),
  /** `set`: written now; `kept`: there was a value already (never overwritten); `none`: no datum. */
  amount: FieldOutcome,
  closeDate: FieldOutcome,
});
export type RecordQualificationOutput = z.infer<typeof RecordQualificationOutput>;

const eq = (field: string, value: string) => `${field}[eq]:${filterValue(value)}`;

/** The qualification note already attached to the opportunity, or null. */
async function findQualificationNote(twenty: TwentyClient, title: string, opportunityId: string, signal: AbortSignal): Promise<{ note: TwentyNote; targets: TwentyNoteTarget[] } | null> {
  const { records } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: eq('title', title), limit: 20, signal });
  for (const n of records) {
    if (n.deletedAt) continue;
    const { records: targets } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: eq('noteId', n.id), limit: 50, signal });
    if (targets.some((t) => t.targetOpportunityId === opportunityId)) return { note: n, targets };
  }
  return null;
}

const emptyAmount = (o: TwentyOpportunity) => !o.amount || o.amount.amountMicros === null || o.amount.amountMicros === undefined;
const emptyCloseDate = (o: TwentyOpportunity) => o.closeDate === null || o.closeDate === undefined || o.closeDate === '';

export function createRecordQualificationTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'record_opportunity_qualification',
    name: 'Record opportunity qualification',
    version: '1.0.0',
    description:
      'Record the qualification data of an opportunity extracted from a client reply (each datum with its literal quote): appends a section to the note «Cualificación — <empresa> 🧾» on the opportunity, and fills amount / closeDate ONLY when they are empty (never overwrites a value). Idempotent per reply. Never sends anything.',
    inputSchema: RecordQualificationInput,
    outputSchema: RecordQualificationOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:opportunities:read', 'twenty:opportunities:write', 'twenty:notes:read', 'twenty:notes:write'],
    timeoutMs: 30_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const opts = { signal: ctx.signal };
        const opp = await twenty.get<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, input.opportunityId, { depth: 0, ...opts });
        if (!opp || opp.deletedAt) {
          return { status: 'ok' as const, output: { found: false, noteId: null, noteCreated: false, sectionAppended: false, amount: 'none' as const, closeDate: 'none' as const } };
        }
        const data = input.data as QualificationData & { discarded?: string[] };
        const amount = data.budget ? (emptyAmount(opp) ? 'set' : 'kept') : 'none';
        const closeDate = data.neededBy ? (emptyCloseDate(opp) ? 'set' : 'kept') : 'none';

        // 1. The note (first: see the module comment).
        const title = qualificationNoteTitle(input.companyName);
        const marker = qualificationSectionTitle(input.receivedLocal);
        const section = qualificationSection({ ...data, discarded: [] }, input.receivedLocal, { amount, closeDate });
        const found = await findQualificationNote(twenty, title, opp.id, ctx.signal);
        let note = found?.note ?? null;
        const targets = found?.targets ?? [];
        let noteCreated = false;
        let sectionAppended = false;
        if (!note) {
          note = await twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown: `${QUALIFICATION_NOTE_HEADER}\n\n${section}\n` } }, opts);
          noteCreated = true;
          sectionAppended = true;
        } else {
          const current = note.bodyV2?.markdown ?? '';
          if (!current.includes(marker)) {
            await twenty.update<TwentyNote>(TWENTY_OBJECTS.note, note.id, { bodyV2: { markdown: `${current.replace(/\s+$/, '')}\n\n${section}\n` } }, opts);
            sectionAppended = true;
          }
        }
        const want: Array<[keyof TwentyNoteTarget, string | null | undefined]> = [
          ['targetOpportunityId', opp.id],
          ['targetCompanyId', input.companyId ?? opp.companyId],
          ['targetPersonId', input.personId],
        ];
        for (const [key, id] of want) {
          if (!id || targets.some((t) => t[key] === id)) continue;
          targets.push(await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId: note.id, [key]: id }, opts));
        }

        // 2. Standard fields, only the empty ones (re-read right before: a person may have just filled them).
        if (amount === 'set' || closeDate === 'set') {
          const fresh = (await twenty.get<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, opp.id, { depth: 0, ...opts })) ?? opp;
          const patch: Record<string, unknown> = {};
          if (amount === 'set' && emptyAmount(fresh)) patch.amount = eurToCurrency(data.budget!.min);
          // DATE_TIME: noon UTC keeps the same calendar day in Europe/Madrid.
          if (closeDate === 'set' && emptyCloseDate(fresh)) patch.closeDate = `${data.neededBy!.date}T12:00:00.000Z`;
          if (Object.keys(patch).length > 0) await twenty.update<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, opp.id, patch, opts);
          const outcome = (k: 'amount' | 'closeDate', planned: string) => (planned === 'set' ? (k in patch ? 'set' : 'kept') : planned);
          ctx.logger.info('opportunity qualification', { opportunityId: opp.id, noteCreated, sectionAppended, fields: Object.keys(patch).join(',') });
          return {
            status: 'ok' as const,
            output: { found: true, noteId: note.id, noteCreated, sectionAppended, amount: outcome('amount', amount) as 'set' | 'kept', closeDate: outcome('closeDate', closeDate) as 'set' | 'kept' },
          };
        }
        ctx.logger.info('opportunity qualification', { opportunityId: opp.id, noteCreated, sectionAppended, fields: '' });
        return { status: 'ok' as const, output: { found: true, noteId: note.id, noteCreated, sectionAppended, amount, closeDate } };
      }),
  });
}
