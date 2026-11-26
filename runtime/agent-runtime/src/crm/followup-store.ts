/**
 * Runtime-database side of the lead follow-up (tanda 21, sequence and conversations tanda 23).
 * Read-only questions:
 *
 * - `sends`: the rows of `email_sends` (the log the email-ops webhook writes when a hypothesis
 *   turns SENT in Twenty) of the given hypotheses: the date and subject of the first send.
 * - `replies`: the `inbound_triage` rows (InboxAgent) linked to the hypothesis, or to its
 *   company, received at or after the send. This is THE trace of a reply: the triage writes one
 *   row per message, with the hypothesis / company of the send it answers (by address, by domain,
 *   or by the company domain in Twenty), BEFORE or together with the 📬 note, the Opportunity and
 *   the 📬 task, which all derive from it. Append-only, so it cannot be lost by an edit in Twenty.
 * - `followUpTouches`: per hypothesis, the touches whose task was already created, from the
 *   `audit_log` rows `lead.followup_task` (one per task). Detail `touch` (2, 3, 4); a tanda-21
 *   row without it is touch 2. Append-only: the mark survives a task deleted in Twenty.
 * - `conversationMarks`: per opportunity, the ids of the last outbound messages whose «Retomar
 *   conversación» task was already created (`lead.followup_task`, `kind: 'conversation'`).
 */
import { and, eq, gte, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, emailSends, inboundTriage, type InboundTriageClass } from '../db/schema.js';
import { CONVERSATION_AUDIT_SUBJECT, FOLLOWUP_AUDIT_ACTION, FOLLOWUP_AUDIT_SUBJECT } from './followup.js';

export interface FollowUpSend {
  hypothesisId: string;
  companyId: string | null;
  toEmail: string;
  subject: string | null;
  sentAt: Date;
}

export interface FollowUpReply {
  class: InboundTriageClass;
  receivedAt: Date | null;
  createdAt: Date;
  hypothesisId: string | null;
  companyId: string | null;
}

export interface FollowUpStore {
  /** Sends of the hypotheses, oldest first. */
  sends(tenantId: string, hypothesisIds: readonly string[]): Promise<FollowUpSend[]>;
  /** Triaged messages linked to the hypothesis or its company, received at or after `since`. */
  replies(tenantId: string, q: { hypothesisId: string; companyIds: readonly string[]; since: Date }): Promise<FollowUpReply[]>;
  /** Touches (2, 3, 4) whose follow-up task was already created, per hypothesis of `hypothesisIds`. */
  followUpTouches(tenantId: string, hypothesisIds: readonly string[]): Promise<Map<string, Set<number>>>;
  /** Last-outbound message ids already followed up, per opportunity of `opportunityIds`. */
  conversationMarks(tenantId: string, opportunityIds: readonly string[]): Promise<Map<string, Set<string>>>;
}

/** Touch of an audit detail: `touch` 2..4; anything else (tanda-21 rows) is touch 2. */
export function touchOfPayload(payload: unknown): number {
  const t = (payload as { touch?: unknown } | null | undefined)?.touch;
  return typeof t === 'number' && Number.isInteger(t) && t >= 2 && t <= 4 ? t : 2;
}

export class DrizzleFollowUpStore implements FollowUpStore {
  constructor(private readonly db: Db) {}

  async sends(tenantId: string, hypothesisIds: readonly string[]): Promise<FollowUpSend[]> {
    if (hypothesisIds.length === 0) return [];
    return this.db
      .select({ hypothesisId: emailSends.hypothesisId, companyId: emailSends.companyId, toEmail: emailSends.toEmail, subject: emailSends.subject, sentAt: emailSends.sentAt })
      .from(emailSends)
      .where(and(eq(emailSends.tenantId, tenantId), inArray(emailSends.hypothesisId, [...new Set(hypothesisIds)])))
      .orderBy(emailSends.sentAt);
  }

  async replies(tenantId: string, q: { hypothesisId: string; companyIds: readonly string[]; since: Date }): Promise<FollowUpReply[]> {
    const link: SQL[] = [eq(inboundTriage.hypothesisId, q.hypothesisId)];
    const companies = [...new Set(q.companyIds.filter((c) => c.length > 0))];
    if (companies.length > 0) link.push(inArray(inboundTriage.companyId, companies));
    return this.db
      .select({ class: inboundTriage.class, receivedAt: inboundTriage.receivedAt, createdAt: inboundTriage.createdAt, hypothesisId: inboundTriage.hypothesisId, companyId: inboundTriage.companyId })
      .from(inboundTriage)
      .where(
        and(
          eq(inboundTriage.tenantId, tenantId),
          or(...link),
          // Without a Date header the triage time stands for the receive time.
          or(gte(inboundTriage.receivedAt, q.since), and(isNull(inboundTriage.receivedAt), gte(inboundTriage.createdAt, q.since))),
        ),
      )
      .limit(50);
  }

  private async marks(tenantId: string, subjectType: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return this.db
      .select({ subjectId: auditLog.subjectId, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, FOLLOWUP_AUDIT_ACTION),
          eq(auditLog.subjectType, subjectType),
          eq(auditLog.result, 'ok'),
          inArray(auditLog.subjectId, [...new Set(ids)]),
        ),
      );
  }

  async followUpTouches(tenantId: string, hypothesisIds: readonly string[]): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>();
    for (const r of await this.marks(tenantId, FOLLOWUP_AUDIT_SUBJECT, hypothesisIds)) {
      if (typeof r.subjectId !== 'string') continue;
      out.set(r.subjectId, new Set([...(out.get(r.subjectId) ?? []), touchOfPayload(r.payload)]));
    }
    return out;
  }

  async conversationMarks(tenantId: string, opportunityIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const r of await this.marks(tenantId, CONVERSATION_AUDIT_SUBJECT, opportunityIds)) {
      const p = (r.payload ?? {}) as { kind?: unknown; last_outbound_message_id?: unknown };
      if (typeof r.subjectId !== 'string' || p.kind !== 'conversation' || typeof p.last_outbound_message_id !== 'string') continue;
      out.set(r.subjectId, new Set([...(out.get(r.subjectId) ?? []), p.last_outbound_message_id]));
    }
    return out;
  }
}

/** In-memory store for unit tests. */
export class MemoryFollowUpStore implements FollowUpStore {
  sendRows: Array<FollowUpSend & { tenantId: string }> = [];
  replyRows: Array<FollowUpReply & { tenantId: string }> = [];
  /** Hypothesis marks; `touch` omitted = a tanda-21 row (touch 2). */
  followedUp: Array<{ tenantId: string; hypothesisId: string; touch?: number }> = [];
  conversations: Array<{ tenantId: string; opportunityId: string; messageId: string }> = [];

  async sends(tenantId: string, hypothesisIds: readonly string[]): Promise<FollowUpSend[]> {
    const ids = new Set(hypothesisIds);
    return this.sendRows.filter((r) => r.tenantId === tenantId && ids.has(r.hypothesisId)).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  async replies(tenantId: string, q: { hypothesisId: string; companyIds: readonly string[]; since: Date }): Promise<FollowUpReply[]> {
    return this.replyRows.filter(
      (r) =>
        r.tenantId === tenantId &&
        (r.hypothesisId === q.hypothesisId || (r.companyId !== null && q.companyIds.includes(r.companyId))) &&
        (r.receivedAt ?? r.createdAt).getTime() >= q.since.getTime(),
    );
  }

  async followUpTouches(tenantId: string, hypothesisIds: readonly string[]): Promise<Map<string, Set<number>>> {
    const ids = new Set(hypothesisIds);
    const out = new Map<string, Set<number>>();
    for (const f of this.followedUp) {
      if (f.tenantId !== tenantId || !ids.has(f.hypothesisId)) continue;
      out.set(f.hypothesisId, new Set([...(out.get(f.hypothesisId) ?? []), touchOfPayload({ touch: f.touch })]));
    }
    return out;
  }

  async conversationMarks(tenantId: string, opportunityIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const ids = new Set(opportunityIds);
    const out = new Map<string, Set<string>>();
    for (const c of this.conversations) {
      if (c.tenantId !== tenantId || !ids.has(c.opportunityId)) continue;
      out.set(c.opportunityId, new Set([...(out.get(c.opportunityId) ?? []), c.messageId]));
    }
    return out;
  }
}
