/**
 * Summary of a request body for `audit_log.payload`: enough to know WHAT was asked (flags,
 * ids, versions, short texts, the full `reason` of a force) without copying long contents
 * (skill instructions, harness configs, knowledge statements, evidence lists): those go as
 * `{ sha256, length, excerpt }`, so the exact content can be matched later against the
 * versioned row without living twice in the database.
 */
import { createHash } from 'node:crypto';

/** Strings up to this length are kept as they are. */
export const SHORT_TEXT = 200;
/** Excerpt of a long string. */
export const EXCERPT = 120;
/** Keys whose strings are kept in full (up to FULL_TEXT): who and why of a human decision. */
const FULL_KEYS = new Set(['reason', 'by', 'created_by', 'updated_by', 'decided_by', 'evaluated_by', 'note', 'outcome', 'change_reason']);
export const FULL_TEXT = 2_000;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 50;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestOf(value: unknown): { sha256: string; length: number } {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  return { sha256: sha256Hex(text), length: text.length };
}

function summarizeString(s: string, limit: number): unknown {
  if (s.length <= limit) return s;
  return { ...digestOf(s), excerpt: s.slice(0, EXCERPT) };
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function summarizeValue(key: string, value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return summarizeString(value, FULL_KEYS.has(key) ? FULL_TEXT : SHORT_TEXT);
  if (Array.isArray(value)) {
    // Short lists of ids / tags are kept (e.g. `case_ids`); anything else is digested.
    if (value.length <= MAX_ARRAY_ITEMS && value.every((v) => isPrimitive(v) && (typeof v !== 'string' || v.length <= SHORT_TEXT))) return value;
    return { type: 'array', items: value.length, ...digestOf(value) };
  }
  if (typeof value === 'object') {
    if (depth >= 1) return { type: 'object', keys: Object.keys(value as object).length, ...digestOf(value) };
    return summarizeObject(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

function summarizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  for (const key of keys.slice(0, MAX_KEYS)) out[key] = summarizeValue(key, obj[key], depth);
  if (keys.length > MAX_KEYS) out._truncated_keys = keys.length - MAX_KEYS;
  return out;
}

/** Summary of a request body (anything that is not a JSON object is digested). */
export function summarizePayload(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return { _body: summarizeValue('_body', body, 1) };
  return summarizeObject(body as Record<string, unknown>, 0);
}
