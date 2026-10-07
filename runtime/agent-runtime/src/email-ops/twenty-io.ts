/**
 * Twenty side of email-ops: read the suppression list and leave a visible alert note on a
 * hypothesis. Only reads, creates notes/noteTargets and APPENDS lines to the runtime's own
 * alert notes: it never edits or removes existing content and never deletes anything.
 */
import { TWENTY_OBJECTS, filterValue, type TwentyClient, type TwentyNote, type TwentyNoteTarget } from '../integrations/twenty/index.js';
import { parseSuppressionList, SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE, type SuppressionList } from '../inbound/suppression-list.js';
import { appendMarkdownLines, noteTitle } from '../tools/twenty/note-tools.js';

const eq = (field: string, value: string) => `${field}[eq]:${filterValue(value)}`;

export interface LoadedSuppressionList {
  list: SuppressionList;
  noteIds: string[];
  /** True when the note was accepted by id with a damaged title (U+FFFD characters). */
  titleDamaged: boolean;
}

/**
 * Title equality that tolerates an encoding-damaged title: every U+FFFD (replacement
 * character, what a non-UTF-8 client leaves behind) stands for exactly one character. The
 * real note in the local Twenty is stored as "Lista de supresi�n � NO contactar".
 * Only used for the note found BY ID; the search by title stays exact.
 */
export function titleMatches(actual: string, expected: string): boolean {
  const a = [...noteTitle(actual)];
  const e = [...noteTitle(expected)];
  return a.length === e.length && a.every((c, i) => c === e[i] || c === '�');
}

/**
 * The suppression list: the note with the known id (if it still has the expected title)
 * plus any other note titled exactly "Lista de supresión — NO contactar" (there should be
 * one; if somebody made a copy, every copy counts). null when no such note exists: callers
 * must FAIL CLOSED.
 */
export async function loadSuppressionList(
  twenty: TwentyClient,
  opts: { noteId?: string; title?: string; signal?: AbortSignal } = {},
): Promise<LoadedSuppressionList | null> {
  const title = noteTitle(opts.title ?? SUPPRESSION_NOTE_TITLE);
  const signal = opts.signal ? { signal: opts.signal } : {};
  const notes = new Map<string, TwentyNote>();
  const byId = await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, opts.noteId ?? SUPPRESSION_NOTE_ID, signal);
  let titleDamaged = false;
  if (byId && titleMatches(byId.title ?? '', title)) {
    notes.set(byId.id, byId);
    titleDamaged = noteTitle(byId.title ?? '') !== title;
  }
  const { records } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: eq('title', title), limit: 20, ...signal });
  for (const n of records) if (noteTitle(n.title ?? '') === title) notes.set(n.id, n);
  if (notes.size === 0) return null;
  const list: SuppressionList = { emails: new Set(), domains: new Set() };
  for (const n of notes.values()) {
    const parsed = parseSuppressionList(n.bodyV2?.markdown ?? '');
    for (const e of parsed.emails) list.emails.add(e);
    for (const d of parsed.domains) list.domains.add(d);
  }
  return { list, noteIds: [...notes.keys()], titleDamaged };
}

export interface AlertNoteInput {
  hypothesisId: string;
  companyId: string | null;
  title: string;
  /** Body of a NEW note. It should end with a markdown list (the history). */
  bodyMarkdown: string;
  /** One history line (`- ...`). Appended to an existing note unless already there. */
  historyLine: string;
}

export interface AlertNoteResult {
  noteId: string;
  created: boolean;
  appended: boolean;
}

/**
 * One alert note per (hypothesis, title): created with targets hypothesis (+ company) the
 * first time; later occurrences append their history line (append-only, idempotent: the
 * same line is never added twice, so a redelivered webhook changes nothing).
 */
export async function upsertAlertNote(twenty: TwentyClient, input: AlertNoteInput, opts: { signal?: AbortSignal } = {}): Promise<AlertNoteResult> {
  const signal = opts.signal ? { signal: opts.signal } : {};
  const title = noteTitle(input.title);
  const { records: sameTitle } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: eq('title', title), limit: 50, ...signal });
  for (const candidate of sameTitle) {
    const { records: targets } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: eq('noteId', candidate.id), limit: 50, ...signal });
    if (!targets.some((t) => t.targetCommercialHypothesisId === input.hypothesisId)) continue;
    const current = (await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, candidate.id, signal)) ?? candidate;
    const next = appendMarkdownLines(current.bodyV2?.markdown ?? '', [input.historyLine]);
    if (next.appended.length > 0) await twenty.update(TWENTY_OBJECTS.note, candidate.id, { bodyV2: { markdown: next.markdown } }, signal);
    return { noteId: candidate.id, created: false, appended: next.appended.length > 0 };
  }
  const note = await twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown: input.bodyMarkdown } }, signal);
  await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId: note.id, targetCommercialHypothesisId: input.hypothesisId }, signal);
  if (input.companyId) await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId: note.id, targetCompanyId: input.companyId }, signal);
  return { noteId: note.id, created: true, appended: false };
}
