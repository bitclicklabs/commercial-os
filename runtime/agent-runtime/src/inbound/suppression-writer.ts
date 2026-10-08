/**
 * Append-only writer of the suppression list ("Lista de supresión — NO contactar"), shared by
 * the BajasAgent and the InboxAgent: ONE `get_note` + at most ONE `update_note` per run.
 *
 * - Addresses already covered by the note (exact address or `@domain`) or repeated in the batch
 *   are duplicates and are not written again.
 * - `update_note` only APPENDS lines; existing content is never edited or removed.
 * - Lines already present verbatim (a run that died after the PATCH) are reported back as
 *   duplicates (`skippedExisting`).
 *
 * The trace keeps the size of the note, never the whole list.
 */
import type { AgentStep } from '../agents/agent.js';
import type { AgentToolbox } from '../tools/executor.js';
import { isSuppressed, parseSuppressionList } from './suppression-list.js';

export interface SuppressionTarget {
  noteId: string;
  noteTitle: string;
}

export interface SuppressionEntry {
  email: string;
  /** Full line in the documented format (`email — AAAA-MM-DD — motivo`). */
  line: string;
}

export type SuppressionWriteResult =
  | { ok: true; newEntries: string[]; duplicates: string[] }
  | { ok: false; error: Record<string, unknown>; pendingEntries?: string[] };

export function toolError(tool: string, result: { status: string } & Record<string, unknown>): Record<string, unknown> {
  return { tool, status: result.status, code: result.code ?? null, message: result.message ?? null };
}

/** The trace keeps the size of the note, not the whole suppression list. */
export function redactNoteStep(step: AgentStep): AgentStep {
  const out = step.toolOutput as { found?: boolean; note?: { id?: string; title?: string | null; markdown?: string } | null } | null | undefined;
  const note = out?.note;
  if (!note || typeof note.markdown !== 'string') return step;
  return { ...step, toolOutput: { found: out.found, note: { id: note.id, title: note.title, markdown_chars: note.markdown.length } } };
}

/**
 * Appends the entries that are not in the list yet. Steps of the tool calls are pushed to
 * `steps`. With no entries nothing is read or written.
 */
export async function appendSuppressionEntries(
  tools: AgentToolbox,
  target: SuppressionTarget,
  entries: readonly SuppressionEntry[],
  steps: AgentStep[],
): Promise<SuppressionWriteResult> {
  const newEntries: string[] = [];
  const duplicates: string[] = [];
  if (entries.length === 0) return { ok: true, newEntries, duplicates };

  const got = await tools.call('get_note', { noteId: target.noteId });
  steps.push(redactNoteStep(got.step));
  if (got.result.status !== 'ok') return { ok: false, error: toolError('get_note', got.result as { status: string } & Record<string, unknown>) };
  const out = got.result.output as { found: boolean; note: { title: string | null; markdown: string } | null };
  if (!out.found || !out.note) {
    return { ok: false, error: { code: 'NOTE_NOT_FOUND', message: `la nota ${target.noteId} no existe en Twenty` } };
  }
  const list = parseSuppressionList(out.note.markdown);
  const lines: string[] = [];
  const seenNow = new Set<string>();
  for (const e of entries) {
    if (isSuppressed(e.email, list) || seenNow.has(e.email)) {
      duplicates.push(e.email);
      continue;
    }
    seenNow.add(e.email);
    lines.push(e.line);
    newEntries.push(e.email);
  }
  if (lines.length > 0) {
    const upd = await tools.call('update_note', { noteId: target.noteId, expectedTitle: target.noteTitle, appendLines: lines });
    steps.push(upd.step);
    if (upd.result.status !== 'ok') {
      return { ok: false, error: toolError('update_note', upd.result as { status: string } & Record<string, unknown>), pendingEntries: newEntries };
    }
    const u = upd.result.output as { skippedExisting: string[] };
    // Lines that were already there verbatim (a run that died after the PATCH).
    for (const line of u.skippedExisting) {
      const email = line.split(' — ')[0]!;
      const i = newEntries.indexOf(email);
      if (i >= 0) newEntries.splice(i, 1);
      duplicates.push(email);
    }
  }
  return { ok: true, newEntries, duplicates };
}
