/**
 * create_note (LOW_WRITE): an internal Note in Twenty attached to a Company (and,
 * optionally, to a commercial hypothesis). Internal notes are an automatic action in the
 * LLD human gates (section 15): writing a note never contacts anybody.
 *
 * Twenty 2.45 format (verified against the live REST API):
 * - `POST /rest/notes` `{ title, bodyV2: { markdown } }`: the server derives
 *   `bodyV2.blocknote` from the markdown.
 * - The link to a record is a separate `noteTarget` row:
 *   `POST /rest/noteTargets` `{ noteId, targetCompanyId }` (one row per linked record;
 *   `targetCommercialHypothesisId` for the App object).
 *
 * Idempotent by (companyId + title): a note with the same title already targeting the
 * company is returned (`created: false`) and missing targets are added. A note with that
 * title and NO targets at all (a previous call that died between the two POSTs) is
 * adopted instead of creating a second one.
 */
import { z } from 'zod';
import { TWENTY_OBJECTS, filterValue, type TwentyClient, type TwentyNote, type TwentyNoteTarget } from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { RecordId, ShortText, truncate, withTwenty, type TwentyToolDeps } from './shared.js';

export const NOTE_TITLE_MAX = 255;
export const NOTE_BODY_MAX = 20_000;

/** Title as stored: filter values cannot carry quotes or backslashes, so they are dropped. */
export function noteTitle(title: string): string {
  return truncate(title.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim(), NOTE_TITLE_MAX);
}

export const CreateNoteInput = z.object({
  companyId: RecordId,
  title: ShortText,
  /** Markdown body (Twenty renders it as rich text). */
  bodyMarkdown: z.string().trim().min(1).max(NOTE_BODY_MAX),
  /** Also attach the note to this commercial hypothesis. */
  hypothesisId: RecordId.optional(),
});

export const CreateNoteOutput = z.object({
  created: z.boolean(),
  /** True when an orphan note (same title, no targets) was adopted. */
  adopted: z.boolean(),
  idempotencyKey: z.string(),
  record: z.object({
    id: z.string(),
    title: z.string(),
    companyId: z.string(),
    hypothesisId: z.string().nullable(),
    targetIds: z.array(z.string()),
  }),
});

const eq = (field: string, value: string) => `${field}[eq]:${filterValue(value)}`;

async function targetsOf(twenty: TwentyClient, noteId: string, signal: AbortSignal): Promise<TwentyNoteTarget[]> {
  const { records } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: eq('noteId', noteId), limit: 50, signal });
  return records;
}

export function createCreateNoteTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_note',
    name: 'Create note',
    version: '1.0.0',
    description:
      'Create an internal note (markdown) in the CRM attached to a company and optionally to a commercial hypothesis. Idempotent per company and title. Never sends anything to anybody.',
    inputSchema: CreateNoteInput,
    outputSchema: CreateNoteOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:notes:read', 'twenty:notes:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const title = noteTitle(input.title);
        const idempotencyKey = `publi:note:create:${input.companyId}:${title}`;

        // 1. Existing note with the same title on this company, or an orphan to adopt.
        const { records: sameTitle } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: eq('title', title), limit: 20, signal: ctx.signal });
        let note: TwentyNote | null = null;
        let targets: TwentyNoteTarget[] = [];
        let orphan: TwentyNote | null = null;
        for (const candidate of sameTitle) {
          const t = await targetsOf(twenty, candidate.id, ctx.signal);
          if (t.some((x) => x.targetCompanyId === input.companyId)) {
            note = candidate;
            targets = t;
            break;
          }
          if (t.length === 0 && !orphan) orphan = candidate;
        }
        const created = !note && !orphan;
        const adopted = !note && orphan !== null;
        if (!note) note = orphan;

        // 2. Create the note if there is none.
        if (!note) {
          note = await twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown: input.bodyMarkdown } }, { signal: ctx.signal });
          ctx.logger.info('note created', { noteId: note.id, companyId: input.companyId });
        }

        // 3. Targets: company (+ hypothesis). Only the missing ones are created.
        if (!targets.some((t) => t.targetCompanyId === input.companyId)) {
          targets.push(await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId: note.id, targetCompanyId: input.companyId }, { signal: ctx.signal }));
        }
        if (input.hypothesisId && !targets.some((t) => t.targetCommercialHypothesisId === input.hypothesisId)) {
          targets.push(
            await twenty.create<TwentyNoteTarget>(
              TWENTY_OBJECTS.noteTarget,
              { noteId: note.id, targetCommercialHypothesisId: input.hypothesisId },
              { signal: ctx.signal },
            ),
          );
        }

        return {
          status: 'ok',
          output: {
            created,
            adopted,
            idempotencyKey,
            record: {
              id: note.id,
              title: note.title ?? title,
              companyId: input.companyId,
              hypothesisId: input.hypothesisId ?? null,
              targetIds: targets.map((t) => t.id),
            },
          },
        };
      }),
  });
}
