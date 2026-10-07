/**
 * Bounded edits of a skill text (LLD v0.1 section 6.3: the optimizer only runs `ADD`,
 * `REMOVE`, `REPLACE`, `MOVE` and `REORDER`; it never rewrites the whole skill). A candidate
 * version is the ACTIVE text plus an explicit, auditable list of operations, each one
 * anchored on text that must appear exactly once. The list and its justification travel in
 * the new version's `metadata.operations`, so any reviewer can replay it.
 *
 * Pure module (no I/O): `pnpm skill:candidate` and the unit tests use it.
 */

export type EditOperation =
  /** Inserts `text` as new line(s) right after (or before) the line that contains `anchor`. */
  | { op: 'ADD'; anchor: string; position?: 'after' | 'before'; text: string; why?: string }
  /** Removes the exact fragment `find` (a whole line is removed with its line break). */
  | { op: 'REMOVE'; find: string; why?: string }
  /** Replaces the exact fragment `find` with `text`. */
  | { op: 'REPLACE'; find: string; text: string; why?: string }
  /** Cuts the exact fragment `find` (whole lines) and re-inserts it after the line that contains `anchor`. */
  | { op: 'MOVE'; find: string; anchor: string; why?: string }
  /** Reorders the `## ` sections: `order` lists every heading (without `## `) in the new order. */
  | { op: 'REORDER'; order: string[]; why?: string };

export type EditOpName = EditOperation['op'];
export const EDIT_OPS: readonly EditOpName[] = ['ADD', 'REMOVE', 'REPLACE', 'MOVE', 'REORDER'];

export class EditOperationError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(`operación ${index + 1}: ${message}`);
    this.name = 'EditOperationError';
  }
}

export interface AppliedEdit {
  index: number;
  op: EditOpName;
  /** Characters removed and added by this operation. */
  removed: number;
  added: number;
}

export interface EditResult {
  text: string;
  applied: AppliedEdit[];
  /**
   * The "textual learning rate", in two parts. `removedRatio`: share of the base text that
   * the edits delete or overwrite (a rewrite destroys the base). `addedRatio`: share of new
   * text, relative to the base (a skill that doubles is not a bounded edit either). A moved
   * block counts once as added. `changeRatio` = removed + added, for information.
   */
  removedRatio: number;
  addedRatio: number;
  changeRatio: number;
}

/** Default ceilings: at most 35 % of the base removed or overwritten, at most 50 % added. */
export const DEFAULT_MAX_REMOVED_RATIO = 0.35;
export const DEFAULT_MAX_ADDED_RATIO = 0.5;

function occurrences(text: string, fragment: string): number {
  if (fragment.length === 0) return 0;
  let n = 0;
  for (let i = text.indexOf(fragment); i >= 0; i = text.indexOf(fragment, i + fragment.length)) n++;
  return n;
}

function uniqueIndex(text: string, fragment: string, index: number, what: string): number {
  const n = occurrences(text, fragment);
  if (n === 0) throw new EditOperationError(index, `${what} no aparece en el texto: ${JSON.stringify(fragment.slice(0, 80))}`);
  if (n > 1) throw new EditOperationError(index, `${what} aparece ${n} veces; debe ser único: ${JSON.stringify(fragment.slice(0, 80))}`);
  return text.indexOf(fragment);
}

/** [start, end) of the full line(s) that contain the fragment at [at, at + len). `end` includes the trailing \n. */
function lineSpan(text: string, at: number, len: number): [number, number] {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at + Math.max(len, 1) - 1);
  return [start, nl < 0 ? text.length : nl + 1];
}

function isWholeLines(text: string, at: number, len: number): boolean {
  const [start, end] = lineSpan(text, at, len);
  const body = text.slice(start, end).replace(/\n$/, '');
  return start === at && body === text.slice(at, at + len).replace(/\n$/, '');
}

function insertLines(text: string, lineEnd: number, block: string): string {
  const piece = block.endsWith('\n') ? block : `${block}\n`;
  if (lineEnd === text.length && !text.endsWith('\n')) return `${text}\n${piece.replace(/\n$/, '')}`;
  return text.slice(0, lineEnd) + piece + text.slice(lineEnd);
}

function splitSections(text: string): { head: string; sections: Array<{ title: string; body: string }> } {
  const parts = text.split(/^(?=## )/m);
  const head = parts[0]!.startsWith('## ') ? '' : parts.shift()!;
  return { head, sections: parts.map((p) => ({ title: p.slice(3, p.indexOf('\n') < 0 ? undefined : p.indexOf('\n')).trim(), body: p })) };
}

function applyOne(text: string, op: EditOperation, index: number): { text: string; removed: number; added: number } {
  switch (op.op) {
    case 'ADD': {
      if (!op.text.trim()) throw new EditOperationError(index, 'ADD sin texto');
      const at = uniqueIndex(text, op.anchor, index, 'el ancla');
      const [start, end] = lineSpan(text, at, op.anchor.length);
      const out = op.position === 'before' ? insertLines(text, start, op.text) : insertLines(text, end, op.text);
      return { text: out, removed: 0, added: out.length - text.length };
    }
    case 'REMOVE': {
      const at = uniqueIndex(text, op.find, index, 'el fragmento');
      const [start, end] = isWholeLines(text, at, op.find.length) ? lineSpan(text, at, op.find.length) : [at, at + op.find.length];
      return { text: text.slice(0, start) + text.slice(end), removed: end - start, added: 0 };
    }
    case 'REPLACE': {
      if (op.find === op.text) throw new EditOperationError(index, 'REPLACE sin cambio');
      const at = uniqueIndex(text, op.find, index, 'el fragmento');
      return { text: text.slice(0, at) + op.text + text.slice(at + op.find.length), removed: op.find.length, added: op.text.length };
    }
    case 'MOVE': {
      const at = uniqueIndex(text, op.find, index, 'el fragmento');
      if (!isWholeLines(text, at, op.find.length)) throw new EditOperationError(index, 'MOVE solo mueve líneas completas');
      const [start, end] = lineSpan(text, at, op.find.length);
      const block = text.slice(start, end);
      const rest = text.slice(0, start) + text.slice(end);
      const anchorAt = uniqueIndex(rest, op.anchor, index, 'el ancla');
      const [, anchorEnd] = lineSpan(rest, anchorAt, op.anchor.length);
      // A move neither adds nor removes content; it counts as the moved block once.
      return { text: insertLines(rest, anchorEnd, block), removed: 0, added: block.length };
    }
    case 'REORDER': {
      const { head, sections } = splitSections(text);
      const titles = sections.map((s) => s.title);
      const sorted = (a: string[]) => [...a].sort().join('\u0000');
      if (new Set(op.order).size !== op.order.length || sorted(op.order) !== sorted(titles)) {
        throw new EditOperationError(index, `REORDER debe listar exactamente las secciones existentes: ${titles.join(' | ')}`);
      }
      const bodies = op.order.map((t) => sections.find((s) => s.title === t)!.body);
      const normalized = bodies.map((b) => (b.endsWith('\n') ? b : `${b}\n\n`));
      let out = head + normalized.join('');
      if (!text.endsWith('\n')) out = out.replace(/\n+$/, '');
      const moved = op.order.reduce((n, t, i) => (titles[i] === t ? n : n + sections.find((s) => s.title === t)!.body.length), 0);
      return { text: out, removed: 0, added: moved };
    }
    default: {
      const unknown = op as { op?: unknown };
      throw new EditOperationError(index, `operación desconocida ${String(unknown.op)} (usa ${EDIT_OPS.join(', ')})`);
    }
  }
}

/** Applies the operations in order. Throws `EditOperationError` on the first one that does not apply or when the edit is too large. */
export function applyEditOperations(base: string, ops: readonly EditOperation[], opts: { maxRemovedRatio?: number; maxAddedRatio?: number } = {}): EditResult {
  if (ops.length === 0) throw new EditOperationError(-1, 'la lista de operaciones está vacía');
  let text = base;
  const applied: AppliedEdit[] = [];
  ops.forEach((op, index) => {
    const r = applyOne(text, op, index);
    text = r.text;
    applied.push({ index, op: op.op, removed: r.removed, added: r.added });
  });
  const ratio = (n: number) => (base.length === 0 ? 1 : Math.round((n / base.length) * 10_000) / 10_000);
  const removedRatio = ratio(applied.reduce((n, a) => n + a.removed, 0));
  const addedRatio = ratio(applied.reduce((n, a) => n + a.added, 0));
  const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
  const maxRemoved = opts.maxRemovedRatio ?? DEFAULT_MAX_REMOVED_RATIO;
  const maxAdded = opts.maxAddedRatio ?? DEFAULT_MAX_ADDED_RATIO;
  if (removedRatio > maxRemoved) {
    throw new EditOperationError(ops.length - 1, `las operaciones borran o sustituyen el ${pct(removedRatio)} del texto base (máximo ${pct(maxRemoved)}): eso es reescribir la skill, no una edición acotada`);
  }
  if (addedRatio > maxAdded) {
    throw new EditOperationError(ops.length - 1, `las operaciones añaden texto equivalente al ${pct(addedRatio)} del texto base (máximo ${pct(maxAdded)}): divide el cambio en varias versiones`);
  }
  return { text, applied, removedRatio, addedRatio, changeRatio: Math.round((removedRatio + addedRatio) * 10_000) / 10_000 };
}

/** Validates the JSON shape of an operations file (untrusted input of the CLI). */
export function parseEditOperations(value: unknown): EditOperation[] {
  const list = Array.isArray(value) ? value : (value as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(list)) throw new Error('se esperaba una lista de operaciones (o { "operations": [...] })');
  return list.map((raw, i) => {
    const o = raw as Record<string, unknown>;
    const s = (k: string, required = true) => {
      const v = o[k];
      if (typeof v === 'string' && v.length > 0) return v;
      if (required) throw new EditOperationError(i, `falta el campo "${k}" (texto)`);
      return undefined;
    };
    const why = typeof o.why === 'string' ? { why: o.why } : {};
    switch (o.op) {
      case 'ADD':
        return { op: 'ADD', anchor: s('anchor')!, text: s('text')!, ...(o.position === 'before' ? { position: 'before' as const } : {}), ...why };
      case 'REMOVE':
        return { op: 'REMOVE', find: s('find')!, ...why };
      case 'REPLACE':
        return { op: 'REPLACE', find: s('find')!, text: typeof o.text === 'string' ? o.text : (s('text') as string), ...why };
      case 'MOVE':
        return { op: 'MOVE', find: s('find')!, anchor: s('anchor')!, ...why };
      case 'REORDER':
        if (!Array.isArray(o.order) || !o.order.every((t) => typeof t === 'string')) throw new EditOperationError(i, 'REORDER necesita "order" (lista de títulos)');
        return { op: 'REORDER', order: o.order as string[], ...why };
      default:
        throw new EditOperationError(i, `operación desconocida ${JSON.stringify(o.op)} (usa ${EDIT_OPS.join(', ')})`);
    }
  });
}
