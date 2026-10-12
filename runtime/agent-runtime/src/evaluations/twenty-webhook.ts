/**
 * Twenty 2.45 webhook: authentication and processing of `commercialHypothesis` updates.
 *
 * Authentication (any of them, `TWENTY_WEBHOOK_SECRET` is mandatory):
 * - HMAC signature from Twenty: `X-Twenty-Webhook-Signature` = hex HMAC-SHA256 of
 *   `${X-Twenty-Webhook-Timestamp}:${raw body}` with the webhook `secret`; the timestamp
 *   (epoch ms) must be within `toleranceMs`. This is what Twenty sends when the webhook has
 *   a secret, and it is the preferred mode.
 * - Shared secret in the `x-pxos-webhook-secret` header or the `?secret=` query parameter,
 *   for senders that cannot sign (Twenty logs the full target URL, so avoid the query form).
 *
 * Expiry is never a verdict (tanda 18). A `commercialHypothesis` whose status is EXPIRED (the
 * runtime's lead-time / calendar maintenance PATCHes it through the API and Twenty sends the
 * webhook back to us; or a person expires it by hand) is discarded BEFORE the HUMAN evaluator,
 * whoever the actor is. Because Twenty webhooks carry no previous values, the transition is
 * remembered as a `hypothesis.status_changed` event (never an evaluation): a later
 * EXPIRED -> REJECTED / VALIDATED is then recognised and not scored either. A reopening
 * (EXPIRED -> PROPOSED) is remembered the same way, so the verdict after it counts again.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import type { EventPublisher } from '../events/event-bus.js';
import {
  classifyHypothesisChange,
  EXPIRY_NOT_A_VERDICT,
  passedOf,
  scoreOf,
  type Classification,
  type TwentyWebhookPayload,
} from './human-feedback.js';
import { linkDetails, resolveHypothesisOrigin } from './link-resolver.js';
import { recordHumanEvaluation, subjectHistory } from './service.js';

export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type AuthResult = { ok: true; method: 'signature' | 'shared_secret' } | { ok: false; reason: string };

export interface AuthInput {
  secret: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  now?: number;
  toleranceMs?: number;
}

function header(headers: AuthInput['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signTwentyPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex');
}

export function authenticateTwentyWebhook(input: AuthInput): AuthResult {
  const signature = header(input.headers, 'x-twenty-webhook-signature');
  const timestamp = header(input.headers, 'x-twenty-webhook-timestamp');
  if (signature && timestamp) {
    const ts = Number(timestamp);
    const now = input.now ?? Date.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > (input.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS)) {
      return { ok: false, reason: 'signature timestamp outside tolerance' };
    }
    return safeEqual(signTwentyPayload(input.secret, timestamp, input.rawBody), signature.toLowerCase())
      ? { ok: true, method: 'signature' }
      : { ok: false, reason: 'invalid signature' };
  }
  const shared = header(input.headers, 'x-pxos-webhook-secret') ?? (typeof input.query.secret === 'string' ? input.query.secret : undefined);
  if (shared !== undefined) {
    return safeEqual(shared, input.secret) ? { ok: true, method: 'shared_secret' } : { ok: false, reason: 'invalid shared secret' };
  }
  return { ok: false, reason: 'missing signature or shared secret' };
}

const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/** Tenant of a webhook record: its `tenantId` field when valid (C6), else null. */
export function tenantOfRecord(record: Record<string, unknown>): string | null {
  return typeof record.tenantId === 'string' && TENANT_RE.test(record.tenantId) ? record.tenantId : null;
}

/**
 * The tenant of a webhook record when it is NOT the one this runtime serves (`runtimeTenantId`,
 * config.defaultTenantId), else null. A record without tenant (made by hand in the Twenty UI,
 * which leaves the field empty) belongs to the runtime tenant. Any other non-empty value, valid
 * or not, is another tenant's: the handlers ignore it (200 ignored, logged by the route).
 */
export function foreignTenantOf(record: Record<string, unknown>, runtimeTenantId: string): string | null {
  const raw = typeof record.tenantId === 'string' ? record.tenantId.trim() : '';
  return raw.length > 0 && raw !== runtimeTenantId ? raw.slice(0, 64) : null;
}

/** Reason of an `ignored` outcome for a record of another tenant. */
export function foreignTenantReason(tenant: string, runtimeTenantId: string): string {
  return `record of tenant "${tenant}" (this runtime serves "${runtimeTenantId}")`;
}

function actorOf(payload: TwentyWebhookPayload): { evaluatedBy: string | null; actor: Record<string, unknown> } {
  const updatedBy = (payload.record.updatedBy ?? null) as { source?: string; workspaceMemberId?: string | null; name?: string } | null;
  const memberId = payload.workspaceMemberId ?? updatedBy?.workspaceMemberId ?? null;
  const human = Boolean(memberId) || (updatedBy?.source !== undefined && updatedBy.source !== 'API');
  return {
    evaluatedBy: memberId ? `twenty-member:${memberId}` : payload.userId ? `twenty-user:${payload.userId}` : updatedBy?.name ? `twenty-${(updatedBy.source ?? 'unknown').toLowerCase()}:${updatedBy.name}` : null,
    actor: {
      source: updatedBy?.source ?? null,
      name: updatedBy?.name ?? null,
      workspace_member_id: memberId,
      user_id: payload.userId ?? null,
      human,
    },
  };
}

/** Marker of a non-verdict status transition of a hypothesis (tanda 18). */
export const HYPOTHESIS_STATUS_CHANGED_EVENT = 'hypothesis.status_changed';
export type StatusMarkerResult = 'recorded' | 'deduplicated' | 'not_recorded';

/** Last non-verdict status transition remembered for a hypothesis (newest by occurrence). */
export async function lastStatusMarker(db: Db, tenantId: string, hypothesisId: string): Promise<{ toStatus: string; occurredAt: Date } | null> {
  const [row] = await db
    .select({ payload: events.payload, occurredAt: events.occurredAt })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.type, HYPOTHESIS_STATUS_CHANGED_EVENT), sql`${events.payload}->>'hypothesis_id' = ${hypothesisId}`))
    .orderBy(desc(events.occurredAt), desc(events.createdAt))
    .limit(1);
  const to = row?.payload.to_status;
  return row && typeof to === 'string' ? { toStatus: to, occurredAt: row.occurredAt } : null;
}

/** Previous status for the classifier: the newest of the last verdict and the last marker. */
export function mergeLastKnownStatus(
  verdict: { lastKnownStatus: string | null; lastOccurredAt?: Date | null },
  marker: { toStatus: string; occurredAt: Date } | null,
): string | null {
  if (!marker) return verdict.lastKnownStatus;
  if (!verdict.lastOccurredAt || marker.occurredAt.getTime() >= verdict.lastOccurredAt.getTime()) return marker.toStatus;
  return verdict.lastKnownStatus;
}

async function recordStatusMarker(
  publisher: EventPublisher | undefined,
  args: { tenantId: string; hypothesisId: string; toStatus: string; occurredAt: Date; updatedAt: string; actorHuman: boolean; webhookId: string | null },
): Promise<StatusMarkerResult> {
  if (!publisher) return 'not_recorded';
  try {
    const published = await publisher.publish({
      tenantId: args.tenantId,
      type: HYPOTHESIS_STATUS_CHANGED_EVENT,
      correlationId: `hypothesis:${args.hypothesisId}`,
      producer: 'agent-runtime',
      occurredAt: args.occurredAt,
      idempotencyKey: `evt:${HYPOTHESIS_STATUS_CHANGED_EVENT}:${args.hypothesisId}:${args.toStatus}:${args.updatedAt}`.slice(0, 255),
      data: {
        hypothesis_id: args.hypothesisId,
        to_status: args.toStatus,
        verdict: false,
        actor_human: args.actorHuman,
        updated_at: args.updatedAt,
        twenty_webhook_id: args.webhookId,
      },
    });
    return published.created ? 'recorded' : 'deduplicated';
  } catch {
    return 'not_recorded';
  }
}

export type WebhookOutcome =
  | { status: 'ignored'; reason: string; foreign_tenant?: string; expiry?: true; status_marker?: StatusMarkerResult }
  | {
      status: 'recorded' | 'deduplicated';
      evaluationId: string;
      feedback: string;
      score: number;
      passed: boolean;
      agentExecutionId: string | null;
      linkResolved: boolean;
    };

export interface ProcessOptions {
  defaultTenantId: string;
  dedupeWindowMs: number;
  /** Publisher of `evaluation.recorded` (best-effort). */
  events?: EventPublisher | undefined;
}

/** Hypothesis webhook events the HUMAN evaluator reads (same set as `classifyHypothesisChange`). */
const HUMAN_UPDATE_EVENTS = new Set(['commercialHypothesis.updated', 'commercialHypothesis.upserted']);

export function isHypothesisPayload(body: unknown): body is TwentyWebhookPayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<TwentyWebhookPayload>;
  return typeof b.eventName === 'string' && !!b.record && typeof b.record === 'object';
}

export async function processTwentyWebhook(db: Db, payload: TwentyWebhookPayload, opts: ProcessOptions): Promise<WebhookOutcome> {
  const objectName = payload.objectMetadata?.nameSingular ?? payload.eventName.split('.')[0];
  if (objectName !== 'commercialHypothesis') return { status: 'ignored', reason: `object ${objectName} not handled` };
  const record = payload.record;
  const hypothesisId = typeof record.id === 'string' ? record.id : null;
  if (!hypothesisId) return { status: 'ignored', reason: 'record has no id' };
  // Tenancy: a record of another tenant (test tenants share the workspace) never becomes feedback here.
  const foreign = foreignTenantOf(record, opts.defaultTenantId);
  if (foreign !== null) return { status: 'ignored', reason: foreignTenantReason(foreign, opts.defaultTenantId), foreign_tenant: foreign };
  const recordTenant = tenantOfRecord(record);
  const tenantId = opts.defaultTenantId;
  const updatedFields = Array.isArray(payload.updatedFields) ? payload.updatedFields.filter((f): f is string => typeof f === 'string') : [];
  const statusChanged = updatedFields.includes('status');
  const occurredAtOf = () => {
    const d = typeof record.updatedAt === 'string' ? new Date(record.updatedAt) : payload.eventDate ? new Date(payload.eventDate) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
  };
  const markerArgs = (toStatus: string) => {
    const at = occurredAtOf();
    return {
      tenantId,
      hypothesisId,
      toStatus,
      occurredAt: at,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : at.toISOString(),
      actorHuman: actorOf(payload).actor.human === true,
      webhookId: payload.webhookId ?? null,
    };
  };

  // Tanda 18: EXPIRED is never a verdict, whoever expired it (runtime maintenance or a person).
  // Discarded before the link resolution; the transition is remembered for the next change.
  if (record.status === 'EXPIRED' && HUMAN_UPDATE_EVENTS.has(payload.eventName)) {
    const marker = statusChanged || updatedFields.length === 0 ? await recordStatusMarker(opts.events, markerArgs('EXPIRED')) : undefined;
    return { status: 'ignored', reason: EXPIRY_NOT_A_VERDICT, expiry: true, ...(marker ? { status_marker: marker } : {}) };
  }

  const link = await resolveHypothesisOrigin(db, {
    tenantId,
    hypothesisId,
    companyId: typeof record.companyId === 'string' ? record.companyId : null,
    name: typeof record.name === 'string' ? record.name : null,
  });
  const history = await subjectHistory(db, tenantId, 'hypothesis', hypothesisId);
  // Non-verdict transitions (EXPIRED, reopened to PROPOSED) are only in the markers.
  const lastKnownStatus = statusChanged ? mergeLastKnownStatus(history, await lastStatusMarker(db, tenantId, hypothesisId)) : history.lastKnownStatus;
  const decision: Classification = classifyHypothesisChange({
    eventName: payload.eventName,
    record,
    updatedFields,
    lastKnownStatus,
    editedWhileProposed: history.editedWhileProposed,
    proposal: link.resolved ? link.proposal : null,
  });
  if (decision.action === 'ignore') {
    // Reopened (e.g. EXPIRED -> PROPOSED): remembered, so the verdict after it is scored again.
    if (statusChanged && record.status === 'PROPOSED' && lastKnownStatus !== null && lastKnownStatus !== 'PROPOSED') {
      const marker = await recordStatusMarker(opts.events, markerArgs('PROPOSED'));
      return { status: 'ignored', reason: decision.reason, status_marker: marker };
    }
    return { status: 'ignored', reason: decision.reason };
  }

  const { evaluatedBy, actor } = actorOf(payload);
  const occurredAt = typeof record.updatedAt === 'string' ? new Date(record.updatedAt) : payload.eventDate ? new Date(payload.eventDate) : new Date();
  const result = await recordHumanEvaluation(db, {
    tenantId,
    subjectType: 'hypothesis',
    subjectId: hypothesisId,
    feedback: decision.feedback,
    toStatus: decision.toStatus,
    source: 'twenty_webhook',
    agentExecutionId: link.resolved ? link.agentExecutionId : null,
    taskRunId: link.resolved ? link.taskRunId : null,
    evaluatedBy,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    idempotencyKey: `twenty:${payload.webhookId ?? 'unknown'}:${payload.eventName}:${hypothesisId}:${String(record.updatedAt ?? payload.eventDate ?? '')}`,
    dedupeWindowMs: opts.dedupeWindowMs,
    companyId: typeof record.companyId === 'string' ? record.companyId : null,
    details: {
      from_status: decision.fromStatus,
      from_status_source: decision.fromStatusSource,
      edited_fields: decision.diff,
      edited_fields_before_source: decision.diffBeforeKnown ? 'agent_proposal' : 'unknown',
      updated_fields: decision.updatedFields,
      hypothesis_name: typeof record.name === 'string' ? record.name : null,
      company_id: typeof record.companyId === 'string' ? record.companyId : null,
      tenant_from_record: recordTenant !== null,
      link: linkDetails(link),
      actor,
      twenty: { webhook_id: payload.webhookId ?? null, workspace_id: payload.workspaceId ?? null, event: payload.eventName, event_date: payload.eventDate ?? null },
    },
  }, { events: opts.events });
  const e = result.evaluation;
  return {
    status: result.deduplicated ? 'deduplicated' : 'recorded',
    evaluationId: e.id,
    feedback: e.feedback,
    score: scoreOf(decision.feedback),
    passed: passedOf(decision.feedback),
    agentExecutionId: e.agentExecutionId,
    linkResolved: link.resolved,
  };
}
