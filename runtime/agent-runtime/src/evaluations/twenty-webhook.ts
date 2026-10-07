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
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { EventPublisher } from '../events/event-bus.js';
import {
  classifyHypothesisChange,
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

export type WebhookOutcome =
  | { status: 'ignored'; reason: string }
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
  const recordTenant = typeof record.tenantId === 'string' && TENANT_RE.test(record.tenantId) ? record.tenantId : null;
  const tenantId = recordTenant ?? opts.defaultTenantId;
  const updatedFields = Array.isArray(payload.updatedFields) ? payload.updatedFields.filter((f): f is string => typeof f === 'string') : [];

  const link = await resolveHypothesisOrigin(db, {
    tenantId,
    hypothesisId,
    companyId: typeof record.companyId === 'string' ? record.companyId : null,
    name: typeof record.name === 'string' ? record.name : null,
  });
  const history = await subjectHistory(db, tenantId, 'hypothesis', hypothesisId);
  const decision: Classification = classifyHypothesisChange({
    eventName: payload.eventName,
    record,
    updatedFields,
    lastKnownStatus: history.lastKnownStatus,
    editedWhileProposed: history.editedWhileProposed,
    proposal: link.resolved ? link.proposal : null,
  });
  if (decision.action === 'ignore') return { status: 'ignored', reason: decision.reason };

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
