/**
 * Persistence of the IMAP read cursor (table `inbound_state`, migration 0004_inbound).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { inboundState } from '../db/schema.js';

export interface InboundCursor {
  uidValidity: number;
  lastUid: number;
  lastRunAt: Date | null;
}

export interface InboundCursorKey {
  tenantId: string;
  consumer: string;
  mailbox: string;
}

export interface InboundStateStore {
  get(key: InboundCursorKey): Promise<InboundCursor | null>;
  /** Upsert. `lastUid` never moves backwards under the same UIDVALIDITY. */
  save(key: InboundCursorKey, cursor: { uidValidity: number; lastUid: number; summary: Record<string, unknown> }): Promise<void>;
}

export class DrizzleInboundStateStore implements InboundStateStore {
  constructor(private readonly db: Db) {}

  async get(key: InboundCursorKey): Promise<InboundCursor | null> {
    const row = await this.db.query.inboundState.findFirst({
      where: and(eq(inboundState.tenantId, key.tenantId), eq(inboundState.consumer, key.consumer), eq(inboundState.mailbox, key.mailbox)),
    });
    return row ? { uidValidity: row.uidValidity, lastUid: row.lastUid, lastRunAt: row.lastRunAt } : null;
  }

  async save(key: InboundCursorKey, cursor: { uidValidity: number; lastUid: number; summary: Record<string, unknown> }): Promise<void> {
    const now = new Date();
    await this.db
      .insert(inboundState)
      .values({ ...key, uidValidity: cursor.uidValidity, lastUid: cursor.lastUid, lastRunAt: now, lastSummary: cursor.summary, updatedAt: now })
      .onConflictDoUpdate({
        target: [inboundState.tenantId, inboundState.consumer, inboundState.mailbox],
        set: {
          // Same UIDVALIDITY: keep the highest UID. New UIDVALIDITY: the old cursor is void.
          lastUid: sql`case when ${inboundState.uidValidity} = ${cursor.uidValidity} then greatest(${inboundState.lastUid}, ${cursor.lastUid}) else ${cursor.lastUid} end`,
          uidValidity: cursor.uidValidity,
          lastRunAt: now,
          lastSummary: cursor.summary,
          updatedAt: now,
        },
      });
  }
}

/** In-memory store for tests. */
export class MemoryInboundStateStore implements InboundStateStore {
  readonly rows = new Map<string, InboundCursor & { summary: Record<string, unknown> }>();

  private k(key: InboundCursorKey): string {
    return `${key.tenantId}\u0000${key.consumer}\u0000${key.mailbox}`;
  }

  async get(key: InboundCursorKey): Promise<InboundCursor | null> {
    const r = this.rows.get(this.k(key));
    return r ? { uidValidity: r.uidValidity, lastUid: r.lastUid, lastRunAt: r.lastRunAt } : null;
  }

  async save(key: InboundCursorKey, cursor: { uidValidity: number; lastUid: number; summary: Record<string, unknown> }): Promise<void> {
    const prev = this.rows.get(this.k(key));
    const lastUid = prev && prev.uidValidity === cursor.uidValidity ? Math.max(prev.lastUid, cursor.lastUid) : cursor.lastUid;
    this.rows.set(this.k(key), { uidValidity: cursor.uidValidity, lastUid, lastRunAt: new Date(), summary: cursor.summary });
  }
}
