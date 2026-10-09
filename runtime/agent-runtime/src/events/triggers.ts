/**
 * Pure logic of EVENT triggers (no I/O; unit tested).
 *
 *   schedule: { "type": "EVENT", "event_type": "task.completed",
 *               "filter": { "taskDefinitionId": "...", "status": "COMPLETED" } }
 *
 * - `event_type` (alias `event`) must equal the envelope `type`.
 * - `filter` is optional: every key is a dot path into the envelope `data` ("funnel.out",
 *   "$.funnel.out" is accepted too). Every entry must match (AND between keys). The value is
 *   either a literal (deep-equal, as before) or `{"in": [v1, v2, ...]}` (OR: the value at the
 *   path deep-equals one of the listed values). Example:
 *     { "feedback": { "in": ["ACCEPTED", "EDITED"] }, "subjectType": "hypothesis" }
 *   An object whose ONLY key is "in" is always the operator; it needs a non-empty array of at
 *   most MAX_IN_VALUES values (else 400 invalid_schedule). To compare against a literal
 *   object `{"in": x}`, filter on the path "field.in" instead. Objects with other keys besides
 *   "in" keep the literal deep-equal meaning.
 *
 * Anti-loop guard:
 * - An event about a run of task T (`data.taskDefinitionId === T`) never fires T again.
 * - Every run fired by an event has depth = `event.data.chainDepth` + 1; runs not fired by an
 *   event have depth 0, and every event about a run carries the run's depth as `chainDepth`.
 *   An event whose `chainDepth` is already >= the configured maximum fires nothing.
 */
import type { ScheduleSpec, TaskDefinition } from '../db/schema.js';
import { EVENT_TYPE_RE, type EventEnvelope } from './envelope.js';

export const DEFAULT_MAX_CHAIN_DEPTH = 5;

export interface EventTrigger {
  eventType: string;
  filter: Record<string, unknown>;
}

export class EventTriggerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventTriggerValidationError';
  }
}

const MAX_FILTER_KEYS = 20;
export const MAX_IN_VALUES = 50;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for `{ in: ... }` with no other key: the OR operator (validated by parseEventTrigger). */
export function isInCondition(v: unknown): v is { in: unknown[] } {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === 'in';
}

function validateCondition(key: string, value: unknown): void {
  if (!isInCondition(value)) return; // literal: deep-equal
  const list = value.in;
  if (!Array.isArray(list)) throw new EventTriggerValidationError(`filter "${key}": "in" must be an array of values`);
  if (list.length === 0) throw new EventTriggerValidationError(`filter "${key}": "in" needs at least one value`);
  if (list.length > MAX_IN_VALUES) throw new EventTriggerValidationError(`filter "${key}": "in" allows at most ${MAX_IN_VALUES} values`);
}

/** Normalises an EVENT schedule. Returns null for other types; throws when an EVENT is malformed. */
export function parseEventTrigger(spec: ScheduleSpec | null | undefined): EventTrigger | null {
  if (spec?.type !== 'EVENT') return null;
  const eventType = (spec.event_type ?? spec.event)?.trim();
  if (!eventType) throw new EventTriggerValidationError('EVENT schedule requires event_type');
  if (!EVENT_TYPE_RE.test(eventType)) {
    throw new EventTriggerValidationError(`invalid event_type "${eventType}" (expected e.g. task.completed)`);
  }
  const filter = spec.filter ?? {};
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new EventTriggerValidationError('EVENT filter must be an object of {path: value | {"in": [values]}}');
  }
  const keys = Object.keys(filter);
  if (keys.length > MAX_FILTER_KEYS) throw new EventTriggerValidationError(`EVENT filter allows at most ${MAX_FILTER_KEYS} keys`);
  for (const key of keys) {
    if (splitPath(key).length === 0) throw new EventTriggerValidationError(`invalid filter path "${key}"`);
    validateCondition(key, (filter as Record<string, unknown>)[key]);
  }
  parseEventRunOptions(spec);
  return { eventType, filter };
}

// ---------------------------------------------------------------------------
// Run options of an EVENT task (input mapping and audit), validated with the trigger
// ---------------------------------------------------------------------------

/**
 * - `input_from_event`: `{input_key: "dot.path"}`; each value found in the event `data` becomes a
 *   TOP-LEVEL key of the run input (absent paths are skipped). `event` is reserved (the envelope).
 * - `audit`: when the trigger creates a run, an audit_log row with this action and subject type;
 *   the subject id is the value at `subject_path` in the event data (else the event id).
 */
export interface EventRunOptions {
  inputFromEvent: Record<string, string>;
  audit: { action: string; subjectType: string; subjectPath: string | null } | null;
}

const INPUT_KEY_RE = /^[a-z_][a-z0-9_]{0,63}$/i;
const AUDIT_ACTION_RE = /^[a-z_]+(\.[a-z_]+)+$/;
const AUDIT_SUBJECT_RE = /^[a-z_]{1,60}$/;
const MAX_INPUT_KEYS = 20;

export function parseEventRunOptions(spec: Pick<ScheduleSpec, 'input_from_event' | 'audit'> | null | undefined): EventRunOptions {
  const out: EventRunOptions = { inputFromEvent: {}, audit: null };
  const map = spec?.input_from_event;
  if (map !== undefined && map !== null) {
    if (!isPlainObject(map)) throw new EventTriggerValidationError('input_from_event must be an object of {input_key: "dot.path"}');
    const keys = Object.keys(map);
    if (keys.length > MAX_INPUT_KEYS) throw new EventTriggerValidationError(`input_from_event allows at most ${MAX_INPUT_KEYS} keys`);
    for (const key of keys) {
      const path = (map as Record<string, unknown>)[key];
      if (!INPUT_KEY_RE.test(key) || key === 'event') throw new EventTriggerValidationError(`input_from_event: invalid input key "${key}"`);
      if (typeof path !== 'string' || splitPath(path).length === 0) throw new EventTriggerValidationError(`input_from_event: invalid path for "${key}"`);
      out.inputFromEvent[key] = path;
    }
  }
  const audit = spec?.audit;
  if (audit !== undefined && audit !== null) {
    if (!isPlainObject(audit)) throw new EventTriggerValidationError('audit must be an object {action, subject_type, subject_path?}');
    const { action, subject_type: subjectType, subject_path: subjectPath } = audit as Record<string, unknown>;
    if (typeof action !== 'string' || !AUDIT_ACTION_RE.test(action)) throw new EventTriggerValidationError('audit.action must look like "domain.action"');
    if (typeof subjectType !== 'string' || !AUDIT_SUBJECT_RE.test(subjectType)) throw new EventTriggerValidationError('audit.subject_type must be snake_case');
    if (subjectPath !== undefined && (typeof subjectPath !== 'string' || splitPath(subjectPath).length === 0)) {
      throw new EventTriggerValidationError('audit.subject_path must be a dot path');
    }
    out.audit = { action, subjectType, subjectPath: typeof subjectPath === 'string' ? subjectPath : null };
  }
  return out;
}

/** Top-level input keys mapped from the event data (absent or null values are left out). */
export function mappedEventInput(envelope: Pick<EventEnvelope, 'data'>, inputFromEvent: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(inputFromEvent)) {
    const value = getPath(envelope.data, path);
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** The trigger that should be registered for a task right now, or null. */
export function desiredEventTrigger(task: Pick<TaskDefinition, 'status' | 'enabled' | 'schedule'>): EventTrigger | null {
  if (task.status !== 'ACTIVE' || !task.enabled) return null;
  try {
    return parseEventTrigger(task.schedule);
  } catch {
    return null;
  }
}

function splitPath(path: string): string[] {
  const trimmed = path.trim().replace(/^\$\.?/, '');
  if (trimmed === '') return [];
  const parts = trimmed.split('.');
  return parts.some((p) => p === '') ? [] : parts;
}

/** Value at a dot path (array indexes allowed: "results.0.status"); undefined if absent. */
export function getPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const part of splitPath(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** One filter entry against the actual value: `{in: [...]}` = any of them; otherwise deep-equal. */
export function matchesCondition(actual: unknown, expected: unknown): boolean {
  if (isInCondition(expected)) {
    // A malformed operator never matches (parseEventTrigger rejects it at the API).
    return Array.isArray(expected.in) && expected.in.some((candidate) => deepEqual(actual, candidate));
  }
  return deepEqual(actual, expected);
}

/** True when every filter entry matches the value at its path in `data` (AND; empty filter = match). */
export function matchesFilter(data: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([path, expected]) => matchesCondition(getPath(data, path), expected));
}

export function chainDepthOfEvent(envelope: Pick<EventEnvelope, 'data'>): number {
  const raw = envelope.data.chainDepth;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Depth of a TaskRun from its input: runs fired by an event carry the envelope under
 * `input.event` (see `eventTriggeredInput`).
 */
export function chainDepthOfRunInput(input: Record<string, unknown> | null | undefined): number {
  const ev = input?.event;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 0;
  const data = (ev as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || typeof (ev as { id?: unknown }).id !== 'string') return 0;
  return chainDepthOfEvent({ data: data as Record<string, unknown> }) + 1;
}

/** `taskrun:{task_id}:event:{event_id}`: one TaskRun per (task, event), however often it is delivered. */
export function eventTaskRunIdempotencyKey(taskId: string, eventId: string): string {
  if (!taskId || !eventId) throw new RangeError('taskId and eventId are required');
  return `taskrun:${taskId}:event:${eventId}`;
}

/** Input of an event-fired TaskRun: the task's default input plus the envelope under `event`. */
export function eventTriggeredInput(envelope: EventEnvelope): Record<string, unknown> {
  return { event: envelope };
}

export type TriggerDecision =
  | { fire: true; depth: number }
  | { fire: false; reason: 'type_mismatch' | 'filter_mismatch' | 'tenant_mismatch' | 'self_event' | 'chain_depth_exceeded' };

/** Whether `envelope` fires `task` (pure; the caller has already checked ACTIVE/enabled). */
export function evaluateTrigger(
  task: Pick<TaskDefinition, 'id' | 'tenantId'>,
  trigger: EventTrigger,
  envelope: EventEnvelope,
  maxChainDepth: number = DEFAULT_MAX_CHAIN_DEPTH,
): TriggerDecision {
  if (envelope.tenantId !== task.tenantId) return { fire: false, reason: 'tenant_mismatch' };
  if (envelope.type !== trigger.eventType) return { fire: false, reason: 'type_mismatch' };
  if (envelope.data.taskDefinitionId === task.id) return { fire: false, reason: 'self_event' };
  const depth = chainDepthOfEvent(envelope);
  if (depth >= maxChainDepth) return { fire: false, reason: 'chain_depth_exceeded' };
  if (!matchesFilter(envelope.data, trigger.filter)) return { fire: false, reason: 'filter_mismatch' };
  return { fire: true, depth: depth + 1 };
}
