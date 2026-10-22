/**
 * Runtime-database side of the lead follow-up (tanda 21). Three read-only questions:
 *
 * - `sends`: the rows of `email_sends` (the log the email-ops webhook writes when a hypothesis
 *   turns SENT in Twenty) of the given hypotheses: the date and subject of the first send.
 * - `replies`: the `inbound_triage` rows (InboxAgent) linked to the hypothesis, or to its
 *   company, received at or after the send. This is THE trace of a reply: the triage writes one
 *   row per message, with the hypothesis / company of the send it answers (by address, by domain,
 *   or by the company domain in Twenty), BEFORE or together with the 📬 note, the Opportunity and
 *   the 📬 task, which all derive from it. Append-only, so it cannot be lost by an edit in Twenty.
 * - `alreadyFollowedUp`: hypotheses with an `audit_log` row `lead.followup_task` (one per task
 *   created). Append-only: the «already done» mark survives a task deleted in Twenty.
 */
import { and, eq, gte, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, emailSends, inboundTriage, type InboundTriageClass } from '../db/schema.js';
import { FOLLOWUP_AUDIT_ACTION, FOLLOWUP_AUDIT_SUBJECT } from './followup.js';

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
  /** Hypotheses (of `hypothesisIds`) that already got a follow-up task. */
  alreadyFollowedUp(tenantId: string, hypothesisIds: readonly string[]): Promise<Set<string>>;
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

  async alreadyFollowedUp(tenantId: string, hypothesisIds: readonly string[]): Promise<Set<string>> {
    if (hypothesisIds.length === 0) return new Set();
    const rows = await this.db
      .select({ subjectId: auditLog.subjectId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, FOLLOWUP_AUDIT_ACTION),
          eq(auditLog.subjectType, FOLLOWUP_AUDIT_SUBJECT),
          eq(auditLog.result, 'ok'),
          inArray(auditLog.subjectId, [...new Set(hypothesisIds)]),
        ),
      );
    return new Set(rows.map((r) => r.subjectId).filter((s): s is string => typeof s === 'string'));
  }
}

/** In-memory store for unit tests. */
export class MemoryFollowUpStore implements FollowUpStore {
  sendRows: Array<FollowUpSend & { tenantId: string }> = [];
  replyRows: Array<FollowUpReply & { tenantId: string }> = [];
  followedUp: Array<{ tenantId: string; hypothesisId: string }> = [];

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

  async alreadyFollowedUp(tenantId: string, hypothesisIds: readonly string[]): Promise<Set<string>> {
    const ids = new Set(hypothesisIds);
    return new Set(this.followedUp.filter((f) => f.tenantId === tenantId && ids.has(f.hypothesisId)).map((f) => f.hypothesisId));
  }
}
