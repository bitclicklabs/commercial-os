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
import { errorResult, RecordId, ShortText, truncate, withTwenty, type TwentyToolDeps } from './shared.js';

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

// ---------------------------------------------------------------------------
// get_note (READ) / update_note (LOW_WRITE, append-only)
// ---------------------------------------------------------------------------

/** Upper bound of a note body the runtime writes (the suppression list grows over time). */
export const NOTE_MARKDOWN_MAX = 500_000;
export const NOTE_APPEND_LINE_MAX = 500;
export const NOTE_APPEND_LINES_MAX = 200;

export const GetNoteInput = z.object({ noteId: RecordId });
export const GetNoteOutput = z.object({
  found: z.boolean(),
  note: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      markdown: z.string(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
});

/**
 * get_note (READ): one note by id with its markdown body. The body may contain text written
 * by people (or copied from emails), so its output is untrusted data.
 */
export function createGetNoteTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'get_note',
    name: 'Get note',
    version: '1.0.0',
    description: 'Read one internal CRM note by id (title and markdown body). Read only.',
    inputSchema: GetNoteInput,
    outputSchema: GetNoteOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:notes:read'],
    timeoutMs: 20_000,
    outputTrust: 'untrusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const note = await deps.twenty.get<TwentyNote>(TWENTY_OBJECTS.note, input.noteId, { signal: ctx.signal });
        if (!note) return { status: 'ok', output: { found: false, note: null } };
        return {
          status: 'ok',
          output: {
            found: true,
            note: { id: note.id, title: note.title ?? null, markdown: note.bodyV2?.markdown ?? '', updatedAt: note.updatedAt ?? null },
          },
        };
      }),
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');

/** One appended line: a single line of text (no line breaks, no control characters). */
const AppendLine = z
  .string()
  .trim()
  .min(1)
  .max(NOTE_APPEND_LINE_MAX)
  .refine((s) => !CONTROL_CHARS.test(s), 'line must be a single line without control characters');

export const UpdateNoteInput = z.object({
  noteId: RecordId,
  /** Safety check: the note must have exactly this title (after `noteTitle()` normalisation). */
  expectedTitle: ShortText.optional(),
  /** Lines appended at the END of the body, in order. Existing content is never changed. */
  appendLines: z.array(AppendLine).min(1).max(NOTE_APPEND_LINES_MAX),
});

export const UpdateNoteOutput = z.object({
  updated: z.boolean(),
  noteId: z.string(),
  appended: z.array(z.string()),
  /** Lines already present in the note (exact match): not appended again. */
  skippedExisting: z.array(z.string()),
  lengthBefore: z.number().int(),
  lengthAfter: z.number().int(),
});

/** Strips a markdown list marker, so `- a` and `a` count as the same line. */
function bareLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .trim();
}

/**
 * Appends `lines` to `markdown` without touching what is already there. Lines already in
 * the body (exact match, ignoring list markers) are skipped. If the body ends with a list
 * the new lines continue it with the same marker; otherwise each one is its own paragraph
 * (`\n\n`, as Twenty serialises BlockNote paragraphs).
 */
export function appendMarkdownLines(markdown: string, lines: string[]): { markdown: string; appended: string[]; skipped: string[] } {
  const present = new Set(
    markdown
      .split(/\r?\n/)
      .map(bareLine)
      .filter((l) => l.length > 0),
  );
  const appended: string[] = [];
  const skipped: string[] = [];
  for (const raw of lines) {
    const line = bareLine(raw);
    if (present.has(line)) skipped.push(line);
    else {
      present.add(line);
      appended.push(line);
    }
  }
  if (appended.length === 0) return { markdown, appended, skipped };
  const head = markdown.replace(/\s+$/, '');
  const lastLine =
    head
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .at(-1) ?? '';
  const marker = /^\s*([-*+])\s+/.exec(lastLine)?.[1];
  const sep = marker ? '\n' : '\n\n';
  const rendered = appended.map((l) => (marker ? `${marker} ${l}` : l));
  const next = head.length === 0 ? rendered.join(sep) : `${head}${sep}${rendered.join(sep)}`;
  return { markdown: `${next}\n`, appended, skipped };
}

/**
 * update_note (LOW_WRITE): APPEND-ONLY update of a note body. Reads the current markdown,
 * appends the lines that are not there yet and PATCHes `bodyV2.markdown` (Twenty derives the
 * BlockNote JSON from it). There is no way to replace, edit or remove existing content
 * through this tool. Idempotent: a second call with the same lines changes nothing.
 */
export function createUpdateNoteTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'update_note',
    name: 'Append to note',
    version: '1.0.0',
    description:
      'Append lines at the end of an existing internal CRM note. Never edits or removes existing content; lines already present are skipped (idempotent). Never sends anything to anybody.',
    inputSchema: UpdateNoteInput,
    outputSchema: UpdateNoteOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:notes:read', 'twenty:notes:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const note = await deps.twenty.get<TwentyNote>(TWENTY_OBJECTS.note, input.noteId, { signal: ctx.signal });
        if (!note) return errorResult('NOTE_NOT_FOUND', `note ${input.noteId} does not exist`);
        if (input.expectedTitle !== undefined && noteTitle(note.title ?? '') !== noteTitle(input.expectedTitle)) {
          return errorResult('NOTE_TITLE_MISMATCH', `note ${input.noteId} is not titled "${noteTitle(input.expectedTitle)}"`);
        }
        const before = note.bodyV2?.markdown ?? '';
        const next = appendMarkdownLines(before, input.appendLines);
        const base = { noteId: note.id, appended: next.appended, skippedExisting: next.skipped, lengthBefore: before.length };
        if (next.appended.length === 0) return { status: 'ok', output: { ...base, updated: false, lengthAfter: before.length } };
        if (next.markdown.length > NOTE_MARKDOWN_MAX) {
          return errorResult('NOTE_TOO_LARGE', `note body would exceed ${NOTE_MARKDOWN_MAX} characters`);
        }
        await deps.twenty.update<TwentyNote>(TWENTY_OBJECTS.note, note.id, { bodyV2: { markdown: next.markdown } }, { signal: ctx.signal });
        ctx.logger.info('note appended', { noteId: note.id, appended: next.appended.length, skipped: next.skipped.length });
        return { status: 'ok', output: { ...base, updated: true, lengthAfter: next.markdown.length } };
      }),
  });
}
