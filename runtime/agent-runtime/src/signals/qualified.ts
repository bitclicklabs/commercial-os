/**
 * `commercialSignal` -> QUALIFIED in Twenty  =>  internal event `signal.qualified`.
 *
 * Input: the signed Twenty 2.45 webhook (`POST /webhooks/twenty`, same HMAC as the HUMAN
 * evaluator). For `commercialSignal.updated` Twenty sends the record AFTER the change plus the
 * NAMES of the changed fields (`updatedFields`), never the previous values:
 *
 *   { "eventName": "commercialSignal.updated", "objectMetadata": {"nameSingular": "commercialSignal"},
 *     "webhookId": "...", "workspaceId": "...", "eventDate": "...", "updatedFields": ["status"],
 *     "record": { "id": "...", "name": "Expo Foods 2026 (feria)", "status": "QUALIFIED",
 *                 "signalType": "FAIR", "companyId": null, "eventDate": "2026-11-24",
 *                 "sourceUrl": {"primaryLinkUrl": "https://expofoods.example", ...},
 *                 "tenantId": "publiexpe", "deletedAt": null, ... } }
 *
 * Rules (pure, `classifySignalQualification`):
 * - only `commercialSignal.updated|upserted|created` with `record.status = QUALIFIED` (`created`:
 *   a signal created by hand already QUALIFIED; it has no `updatedFields`);
 * - transition: when `updatedFields` arrives it must include `status` (an edit of another field
 *   of an already QUALIFIED signal is not a qualification). Without `updatedFields` the status
 *   alone is accepted and the 24 h window below is the guard;
 * - FAIR-LEVEL signals only: no `companyId` (the per-exhibitor signals written by the Prospector
 *   always hang from a company), `signalType` FAIR / CONGRESS / EVENT and an http(s) URL in
 *   `sourceUrl`. Everything else is ignored with a reason (logged by the route).
 *
 * Idempotency, once per signal (`processSignalQualification`): the last `signal.qualified` of the
 * signal in `events` (append-only outbox) decides. Within 24 h of it nothing is emitted (qualify
 * -> unqualify -> requalify, or a webhook replay, never relaunches). Otherwise the event is
 * published with the CHAINED key `evt:signal.qualified:{signal_id}:{previous_event_id|first}`:
 * two concurrent deliveries compute the same key and the unique index of `events` keeps one row.
 * The EVENT trigger then creates one TaskRun per event (`taskrun:{task}:event:{event_id}`).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { TwentyWebhookPayload } from '../evaluations/human-feedback.js';
import { tenantOfRecord } from '../evaluations/twenty-webhook.js';

export const SIGNAL_QUALIFIED_EVENT = 'signal.qualified';
export const SIGNAL_OBJECT = 'commercialSignal';
export const QUALIFIED_STATUS = 'QUALIFIED';
/** Signal types that describe an event (a fair, a congress...), not something a company did. */
export const FAIR_LEVEL_SIGNAL_TYPES = ['FAIR', 'CONGRESS', 'EVENT'] as const;
/** PM decision (tanda 15): a signal fires again only when requalified 24 h or more after the last firing. */
export const SIGNAL_REFIRE_WINDOW_MS = 24 * 3600_000;

/** `created` covers a signal created by hand already QUALIFIED (PM decision, tanda 15). */
export const SIGNAL_WEBHOOK_EVENTS = [`${SIGNAL_OBJECT}.updated`, `${SIGNAL_OBJECT}.upserted`, `${SIGNAL_OBJECT}.created`] as const;
const HANDLED_EVENTS = new Set<string>(SIGNAL_WEBHOOK_EVENTS);
/** Suffix the scout adds to the name of an event-level signal (`"{fair} (feria)"`, congreso, evento). */
const FAIR_SUFFIX_RE = /\s*\((feria|fair|congreso|evento)\)\s*$/i;

export interface SignalQualifiedData {
  signal_id: string;
  /** Name of the fair (the signal name without the " (feria)" suffix). */
  name: string;
  event_url: string;
  /** `YYYY-MM-DD` (the date part of the signal's eventDate), or null. */
  event_date: string | null;
  signal_type: string;
  /** How the transition was established: `updated_fields` (status listed) or `status_only`. */
  transition: 'updated_fields' | 'status_only';
}

export type SignalClassification =
  | { action: 'emit'; data: SignalQualifiedData }
  | { action: 'ignore'; reason: string };

export function objectNameOf(payload: Pick<TwentyWebhookPayload, 'eventName' | 'objectMetadata'>): string {
  return payload.objectMetadata?.nameSingular ?? payload.eventName.split('.')[0] ?? '';
}

export function isSignalPayload(payload: Pick<TwentyWebhookPayload, 'eventName' | 'objectMetadata'>): boolean {
  return objectNameOf(payload) === SIGNAL_OBJECT;
}

/** URL of a Twenty LINKS field (`{primaryLinkUrl}`) or a plain string; scheme-less values get https. Null if not http(s). */
export function eventUrlOf(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as { primaryLinkUrl?: unknown }).primaryLinkUrl === 'string'
        ? (value as { primaryLinkUrl: string }).primaryLinkUrl
        : null;
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return candidate.length <= 2048 ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` of a Twenty DATE / DATE_TIME value, or null (the scout input takes a plain date). */
export function eventDateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1] ? null : m[1]!;
}

/** Fair name for the scout input: the signal name without the " (feria)" suffix (max 255). */
export function eventNameOf(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(FAIR_SUFFIX_RE, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Pure: does this webhook qualify a fair-level signal? */
export function classifySignalQualification(payload: TwentyWebhookPayload): SignalClassification {
  if (!isSignalPayload(payload)) return { action: 'ignore', reason: `object ${objectNameOf(payload)} not handled` };
  if (!HANDLED_EVENTS.has(payload.eventName)) return { action: 'ignore', reason: `event ${payload.eventName} not handled` };
  const record = payload.record ?? {};
  const signalId = str(record.id);
  if (!signalId) return { action: 'ignore', reason: 'record has no id' };
  if (record.deletedAt) return { action: 'ignore', reason: 'signal is deleted' };
  if (record.status !== QUALIFIED_STATUS) return { action: 'ignore', reason: `status ${String(record.status ?? 'unknown')} is not ${QUALIFIED_STATUS}` };
  const updatedFields = Array.isArray(payload.updatedFields) ? payload.updatedFields.filter((f): f is string => typeof f === 'string') : null;
  if (updatedFields && updatedFields.length > 0 && !updatedFields.includes('status')) {
    return { action: 'ignore', reason: 'status not among updatedFields (signal already QUALIFIED)' };
  }
  if (str(record.companyId)) return { action: 'ignore', reason: 'per-exhibitor signal (has companyId)' };
  const signalType = str(record.signalType);
  if (!signalType || !(FAIR_LEVEL_SIGNAL_TYPES as readonly string[]).includes(signalType)) {
    return { action: 'ignore', reason: `signalType ${signalType ?? 'unknown'} is not fair-level (${FAIR_LEVEL_SIGNAL_TYPES.join(', ')})` };
  }
  const eventUrl = eventUrlOf(record.sourceUrl);
  if (!eventUrl) return { action: 'ignore', reason: 'fair signal without an http(s) sourceUrl' };
  const name = eventNameOf(record.name);
  if (!name) return { action: 'ignore', reason: 'signal has no name' };
  const eventDate = eventDateOf(record.eventDate);
  return {
    action: 'emit',
    data: {
      signal_id: signalId,
      name,
      event_url: eventUrl,
      event_date: eventDate,
      signal_type: signalType,
      transition: updatedFields && updatedFields.length > 0 ? 'updated_fields' : 'status_only',
    },
  };
}

/** Pure: is a previous firing at `lastAt` still inside the window at `now`? */
export function withinRefireWindow(lastAt: Date | null, now: Date, windowMs: number = SIGNAL_REFIRE_WINDOW_MS): boolean {
  return lastAt !== null && now.getTime() - lastAt.getTime() < windowMs;
}

/** Chained idempotency key: one event per (signal, previous firing). */
export function signalQualifiedIdempotencyKey(signalId: string, previousEventId: string | null): string {
  return `evt:${SIGNAL_QUALIFIED_EVENT}:${signalId}:${previousEventId ?? 'first'}`;
}

export type SignalQualificationOutcome =
  | { status: 'ignored'; reason: string; signal_id?: string }
  | { status: 'within_window'; signal_id: string; last_event_id: string; last_fired_at: string }
  | { status: 'emitted' | 'deduplicated'; signal_id: string; event_id: string; dispatched: boolean }
  | { status: 'error'; signal_id: string; message: string };

export interface SignalQualificationOptions {
  defaultTenantId: string;
  events?: EventPublisher | undefined;
  now?: Date;
  windowMs?: number;
}

/** Last `signal.qualified` of the signal (newest by insertion). */
export async function lastSignalQualified(db: Db, tenantId: string, signalId: string): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: events.id, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.type, SIGNAL_QUALIFIED_EVENT), sql`${events.payload}->>'signal_id' = ${signalId}`))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return row ?? null;
}

/** Classifies the webhook and, for a fair-level qualification outside the window, publishes `signal.qualified`. */
export async function processSignalQualification(
  db: Db,
  payload: TwentyWebhookPayload,
  opts: SignalQualificationOptions,
): Promise<SignalQualificationOutcome> {
  const decision = classifySignalQualification(payload);
  const recordId = str(payload.record?.id);
  if (decision.action === 'ignore') return { status: 'ignored', reason: decision.reason, ...(recordId ? { signal_id: recordId } : {}) };
  const { data } = decision;
  const tenantId = tenantOfRecord(payload.record) ?? opts.defaultTenantId;
  const now = opts.now ?? new Date();
  const last = await lastSignalQualified(db, tenantId, data.signal_id);
  if (last && withinRefireWindow(last.createdAt, now, opts.windowMs)) {
    return { status: 'within_window', signal_id: data.signal_id, last_event_id: last.id, last_fired_at: last.createdAt.toISOString() };
  }
  if (!opts.events) return { status: 'error', signal_id: data.signal_id, message: 'event bus not configured' };
  try {
    const published = await opts.events.publish({
      tenantId,
      type: SIGNAL_QUALIFIED_EVENT,
      correlationId: `signal:${data.signal_id}`,
      producer: 'agent-runtime',
      idempotencyKey: signalQualifiedIdempotencyKey(data.signal_id, last?.id ?? null),
      data: {
        ...data,
        // Root of a chain: the run it fires has depth 1 (src/events/triggers.ts).
        chainDepth: 0,
        twenty: { webhook_id: payload.webhookId ?? null, workspace_id: payload.workspaceId ?? null, event_date: payload.eventDate ?? null },
      },
    });
    return { status: published.created ? 'emitted' : 'deduplicated', signal_id: data.signal_id, event_id: published.event.id, dispatched: published.dispatched };
  } catch (err) {
    return { status: 'error', signal_id: data.signal_id, message: (err as Error).message.slice(0, 300) };
  }
}
