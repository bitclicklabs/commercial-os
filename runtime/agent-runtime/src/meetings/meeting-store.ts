/**
 * «Already detected» marks of the meeting sync (tanda 22): the `audit_log` rows
 * `opportunity.meeting_detected` (subject `opportunity`, `payload.event_key`), one per
 * (opportunity, meeting). Append-only: the mark survives a note or task deleted by hand in Twenty,
 * and an opportunity moved back by a person is never moved forward again for the same meeting.
 *
 * Tanda 24: the marks of the «Ficha previa» (`opportunity.meeting_brief`, one row per brief written
 * in the 🧾 task: `kind` initial | update, the meeting, the task, the local day and the last
 * email considered). They make the brief and its «Actualización — AAAA-MM-DD» idempotent.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { MEETING_BRIEF_AUDIT_ACTION } from './meeting-brief.js';
import { MEETING_SYNC_AUDIT_ACTION, MEETING_SYNC_AUDIT_SUBJECT } from './meeting-sync.js';

export const detectionKey = (opportunityId: string, eventKey: string) => `${opportunityId}|${eventKey}`;

/** One `opportunity.meeting_brief` row (the fields the agent reads back). */
export interface MeetingBriefMark {
  opportunityId: string;
  kind: 'initial' | 'update';
  eventKey: string | null;
  eventId: string | null;
  taskId: string | null;
  startsAt: string | null;
  /** Local day (`AAAA-MM-DD`) of the brief. */
  day: string | null;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: Date;
}

export interface MeetingSyncStore {
  /** `detectionKey`s of the (opportunity, event) pairs already detected, among `opportunityIds`. */
  alreadyDetected(tenantId: string, opportunityIds: readonly string[]): Promise<Set<string>>;
  /** Tanda 24: the brief marks of `opportunityIds` (null `opportunityIds` = every one of the tenant), oldest first. */
  briefMarks?(tenantId: string, opportunityIds: readonly string[] | null): Promise<MeetingBriefMark[]>;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function briefMarkFromPayload(opportunityId: string, payload: Record<string, unknown>, createdAt: Date): MeetingBriefMark {
  return {
    opportunityId,
    kind: payload.kind === 'update' ? 'update' : 'initial',
    eventKey: s(payload.event_key),
    eventId: s(payload.event_id),
    taskId: s(payload.task_id),
    startsAt: s(payload.starts_at),
    day: s(payload.day),
    lastMessageId: s(payload.last_message_id),
    lastMessageAt: s(payload.last_message_at),
    createdAt,
  };
}

export class DrizzleMeetingSyncStore implements MeetingSyncStore {
  constructor(private readonly db: Db) {}

  async alreadyDetected(tenantId: string, opportunityIds: readonly string[]): Promise<Set<string>> {
    if (opportunityIds.length === 0) return new Set();
    const rows = await this.db
      .select({ subjectId: auditLog.subjectId, eventKey: sql<string | null>`${auditLog.payload}->>'event_key'` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, MEETING_SYNC_AUDIT_ACTION),
          eq(auditLog.subjectType, MEETING_SYNC_AUDIT_SUBJECT),
          eq(auditLog.result, 'ok'),
          inArray(auditLog.subjectId, [...new Set(opportunityIds)]),
        ),
      );
    return new Set(rows.filter((r) => r.subjectId && r.eventKey).map((r) => detectionKey(r.subjectId!, r.eventKey!)));
  }

  async briefMarks(tenantId: string, opportunityIds: readonly string[] | null): Promise<MeetingBriefMark[]> {
    if (opportunityIds !== null && opportunityIds.length === 0) return [];
    const rows = await this.db
      .select({ subjectId: auditLog.subjectId, payload: auditLog.payload, createdAt: auditLog.occurredAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, MEETING_BRIEF_AUDIT_ACTION),
          eq(auditLog.subjectType, MEETING_SYNC_AUDIT_SUBJECT),
          eq(auditLog.result, 'ok'),
          ...(opportunityIds !== null ? [inArray(auditLog.subjectId, [...new Set(opportunityIds)])] : []),
        ),
      )
      .orderBy(asc(auditLog.occurredAt))
      .limit(5_000);
    return rows.filter((r) => r.subjectId).map((r) => briefMarkFromPayload(r.subjectId!, (r.payload ?? {}) as Record<string, unknown>, r.createdAt));
  }
}

/** In-memory store for unit tests. */
export class MemoryMeetingSyncStore implements MeetingSyncStore {
  rows: Array<{ tenantId: string; opportunityId: string; eventKey: string }> = [];
  briefs: Array<{ tenantId: string } & MeetingBriefMark> = [];

  async alreadyDetected(tenantId: string, opportunityIds: readonly string[]): Promise<Set<string>> {
    const ids = new Set(opportunityIds);
    return new Set(this.rows.filter((r) => r.tenantId === tenantId && ids.has(r.opportunityId)).map((r) => detectionKey(r.opportunityId, r.eventKey)));
  }

  async briefMarks(tenantId: string, opportunityIds: readonly string[] | null): Promise<MeetingBriefMark[]> {
    const ids = opportunityIds ? new Set(opportunityIds) : null;
    return this.briefs.filter((r) => r.tenantId === tenantId && (!ids || ids.has(r.opportunityId))).map(({ tenantId: _t, ...m }) => m);
  }
}
