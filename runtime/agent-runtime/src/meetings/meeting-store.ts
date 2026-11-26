/**
 * «Already detected» marks of the meeting sync (tanda 22): the `audit_log` rows
 * `opportunity.meeting_detected` (subject `opportunity`, `payload.event_key`), one per
 * (opportunity, meeting). Append-only: the mark survives a note or task deleted by hand in Twenty,
 * and an opportunity moved back by a person is never moved forward again for the same meeting.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { MEETING_SYNC_AUDIT_ACTION, MEETING_SYNC_AUDIT_SUBJECT } from './meeting-sync.js';

export const detectionKey = (opportunityId: string, eventKey: string) => `${opportunityId}|${eventKey}`;

export interface MeetingSyncStore {
  /** `detectionKey`s of the (opportunity, event) pairs already detected, among `opportunityIds`. */
  alreadyDetected(tenantId: string, opportunityIds: readonly string[]): Promise<Set<string>>;
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
}

/** In-memory store for unit tests. */
export class MemoryMeetingSyncStore implements MeetingSyncStore {
  rows: Array<{ tenantId: string; opportunityId: string; eventKey: string }> = [];

  async alreadyDetected(tenantId: string, opportunityIds: readonly string[]): Promise<Set<string>> {
    const ids = new Set(opportunityIds);
    return new Set(this.rows.filter((r) => r.tenantId === tenantId && ids.has(r.opportunityId)).map((r) => detectionKey(r.opportunityId, r.eventKey)));
  }
}
