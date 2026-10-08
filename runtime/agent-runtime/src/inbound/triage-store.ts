/**
 * Persistence of the inbound triage (table `inbound_triage`, migration 0014): append-only,
 * one row per (tenant, message_key). `existingKeys` is the idempotency check of the
 * InboxAgent; `insert` never overwrites (ON CONFLICT DO NOTHING).
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { inboundTriage, type InboundTriageClass, type InboundTriageMethod } from '../db/schema.js';

export interface TriageRecord {
  tenantId: string;
  messageKey: string;
  messageId: string | null;
  mailbox: string;
  uidValidity: number;
  uid: number;
  receivedAt: Date | null;
  fromEmail: string | null;
  fromDomain: string | null;
  subject: string | null;
  class: InboundTriageClass;
  confidence: number | null;
  method: InboundTriageMethod;
  signals: string[];
  companyId: string | null;
  hypothesisId: string | null;
  sendId: string | null;
  matchBy: string | null;
  noteId: string | null;
  suppressionAdded: boolean;
  eventId: string | null;
  executionId: string | null;
  costEur: number;
}

export interface InboundTriageStore {
  /** The subset of `keys` already triaged for the tenant. */
  existingKeys(tenantId: string, keys: readonly string[]): Promise<Set<string>>;
  /** Inserts the row; `created: false` when the message was already there. */
  insert(record: TriageRecord): Promise<{ created: boolean }>;
}

/**
 * Idempotency key of a message: its Message-ID without angle brackets (bounded), or the
 * SHA-256 of the source when it has none.
 */
export function messageKeyOf(messageId: string | null, source: Buffer): string {
  const id = messageId?.trim().replace(/^<|>$/g, '').trim();
  if (id && id.length > 0) return `mid:${id.slice(0, 300)}`;
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

export class DrizzleInboundTriageStore implements InboundTriageStore {
  constructor(private readonly db: Db) {}

  async existingKeys(tenantId: string, keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.db
      .select({ key: inboundTriage.messageKey })
      .from(inboundTriage)
      .where(and(eq(inboundTriage.tenantId, tenantId), inArray(inboundTriage.messageKey, [...new Set(keys)])));
    return new Set(rows.map((r) => r.key));
  }

  async insert(record: TriageRecord): Promise<{ created: boolean }> {
    const rows = await this.db
      .insert(inboundTriage)
      .values(record)
      .onConflictDoNothing({ target: [inboundTriage.tenantId, inboundTriage.messageKey] })
      .returning({ id: inboundTriage.id });
    return { created: rows.length > 0 };
  }
}

/** In-memory store for tests. */
export class MemoryInboundTriageStore implements InboundTriageStore {
  readonly rows: TriageRecord[] = [];

  async existingKeys(tenantId: string, keys: readonly string[]): Promise<Set<string>> {
    const set = new Set(keys);
    return new Set(this.rows.filter((r) => r.tenantId === tenantId && set.has(r.messageKey)).map((r) => r.messageKey));
  }

  async insert(record: TriageRecord): Promise<{ created: boolean }> {
    if (this.rows.some((r) => r.tenantId === record.tenantId && r.messageKey === record.messageKey)) return { created: false };
    this.rows.push(record);
    return { created: true };
  }
}
