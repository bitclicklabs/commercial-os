/**
 * Knowledge layer lifecycle (LLD v0.1 sections 6.4 and 16, MVP-1). Used by the API and the
 * seed. RAW EXPERIENCE -> KNOWLEDGE -> SKILL: a trace never goes straight into a prompt; an
 * agent only sees ACTIVE entries, and an entry is only activated with evidence.
 *
 * States: PROPOSED -> VALIDATED -> ACTIVE -> SUPERSEDED, and PROPOSED | VALIDATED -> REJECTED
 * (PROPOSED -> ACTIVE is allowed: validating is optional for an entry with evidence).
 * No physical DELETE. While PROPOSED or VALIDATED the content can be edited; once ACTIVE,
 * SUPERSEDED or REJECTED it is immutable (database trigger): changing an ACTIVE statement
 * means a new entry that supersedes the old one.
 */
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  knowledgeEntries,
  type KnowledgeEntry,
  type KnowledgeEvidence,
  type KnowledgeSource,
  type KnowledgeStatus,
} from '../db/schema.js';

export const KNOWLEDGE_DOMAIN_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** A statement is short and actionable: it goes verbatim into prompts. */
export const STATEMENT_MAX_CHARS = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KnowledgeServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeServiceError';
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

/** Transitions accepted by the API (also enforced by the database trigger). */
export const KNOWLEDGE_TRANSITIONS: Record<KnowledgeStatus, readonly KnowledgeStatus[]> = {
  PROPOSED: ['VALIDATED', 'ACTIVE', 'REJECTED'],
  VALIDATED: ['ACTIVE', 'REJECTED'],
  ACTIVE: ['SUPERSEDED'],
  SUPERSEDED: [],
  REJECTED: [],
};

export const EDITABLE_STATUSES: readonly KnowledgeStatus[] = ['PROPOSED', 'VALIDATED'];

/**
 * Pure check of one transition. Same state: no change (idempotent). ACTIVE needs at least one
 * piece of evidence (LLD 6.4: "solo se activa con evidencia suficiente").
 */
export function planTransition(entry: Pick<KnowledgeEntry, 'status' | 'evidence'>, to: KnowledgeStatus): { changed: boolean } {
  if (entry.status === to) return { changed: false };
  if (!KNOWLEDGE_TRANSITIONS[entry.status].includes(to)) {
    throw new KnowledgeServiceError('conflict', `invalid transition ${entry.status} -> ${to}`, { from: entry.status, to });
  }
  if (to === 'ACTIVE' && (!Array.isArray(entry.evidence) || entry.evidence.length === 0)) {
    throw new KnowledgeServiceError('invalid', 'an entry can only be activated with evidence (evidence is empty)');
  }
  return { changed: true };
}

export interface KnowledgeContent {
  domain: string;
  topic: string;
  statement: string;
  evidence: KnowledgeEvidence[];
  confidence: number;
  validFrom?: Date | null | undefined;
  validUntil?: Date | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function checkContent(c: Partial<KnowledgeContent>): void {
  if (c.domain !== undefined && !KNOWLEDGE_DOMAIN_RE.test(c.domain)) {
    throw new KnowledgeServiceError('invalid', 'domain must be lower-case (a-z, 0-9, - or _), e.g. "prospeccion"');
  }
  if (c.statement !== undefined && (c.statement.trim().length === 0 || c.statement.length > STATEMENT_MAX_CHARS)) {
    throw new KnowledgeServiceError('invalid', `statement must be 1-${STATEMENT_MAX_CHARS} characters (short and actionable)`);
  }
  if (c.confidence !== undefined && !(c.confidence >= 0 && c.confidence <= 1)) throw new KnowledgeServiceError('invalid', 'confidence must be between 0 and 1');
  if (c.validFrom && c.validUntil && c.validUntil <= c.validFrom) throw new KnowledgeServiceError('invalid', 'valid_until must be after valid_from');
}

export async function findEntry(db: Conn, tenantId: string, id: string): Promise<KnowledgeEntry | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await db.select().from(knowledgeEntries).where(and(eq(knowledgeEntries.tenantId, tenantId), eq(knowledgeEntries.id, id))).limit(1);
  return row;
}

async function lockEntry(tx: Tx, tenantId: string, id: string): Promise<KnowledgeEntry> {
  if (!UUID_RE.test(id)) throw new KnowledgeServiceError('not_found', 'knowledge entry not found');
  const [row] = await tx
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.tenantId, tenantId), eq(knowledgeEntries.id, id)))
    .for('update');
  if (!row) throw new KnowledgeServiceError('not_found', 'knowledge entry not found');
  return row;
}

export interface ListKnowledgeArgs {
  tenantId: string;
  domain?: string | undefined;
  status?: KnowledgeStatus | undefined;
  topic?: string | undefined;
  limit?: number | undefined;
}

export async function listEntries(db: Conn, args: ListKnowledgeArgs): Promise<KnowledgeEntry[]> {
  const where: SQL[] = [eq(knowledgeEntries.tenantId, args.tenantId)];
  if (args.domain) where.push(eq(knowledgeEntries.domain, args.domain));
  if (args.status) where.push(eq(knowledgeEntries.status, args.status));
  if (args.topic) where.push(eq(knowledgeEntries.topic, args.topic));
  return db
    .select()
    .from(knowledgeEntries)
    .where(and(...where))
    .orderBy(desc(knowledgeEntries.createdAt))
    .limit(Math.min(Math.max(args.limit ?? 100, 1), 500));
}

export interface ProposeArgs extends KnowledgeContent {
  tenantId: string;
  source: KnowledgeSource;
  createdBy?: string | null | undefined;
}

/** New entry, always PROPOSED (activate it, with evidence, to use it). */
export async function proposeEntry(db: Conn, args: ProposeArgs): Promise<KnowledgeEntry> {
  checkContent(args);
  const [row] = await db
    .insert(knowledgeEntries)
    .values({
      tenantId: args.tenantId,
      domain: args.domain,
      topic: args.topic.trim(),
      statement: args.statement.trim(),
      evidence: args.evidence,
      confidence: args.confidence,
      source: args.source,
      status: 'PROPOSED',
      validFrom: args.validFrom ?? null,
      validUntil: args.validUntil ?? null,
      metadata: args.metadata ?? {},
      createdBy: args.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error('insert knowledge entry failed');
  return row;
}

/** Edits the content of a PROPOSED or VALIDATED entry (409 otherwise: create a new entry). */
export async function updateEntry(db: Db, tenantId: string, id: string, patch: Partial<KnowledgeContent>): Promise<KnowledgeEntry> {
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, tenantId, id);
    if (!EDITABLE_STATUSES.includes(entry.status)) {
      throw new KnowledgeServiceError('conflict', `entry is ${entry.status}: its content is immutable; propose a new entry and supersede this one`);
    }
    checkContent({ ...patch, validFrom: patch.validFrom ?? entry.validFrom, validUntil: patch.validUntil ?? entry.validUntil });
    const [row] = await tx
      .update(knowledgeEntries)
      .set({
        ...(patch.domain !== undefined ? { domain: patch.domain } : {}),
        ...(patch.topic !== undefined ? { topic: patch.topic.trim() } : {}),
        ...(patch.statement !== undefined ? { statement: patch.statement.trim() } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.validFrom !== undefined ? { validFrom: patch.validFrom } : {}),
        ...(patch.validUntil !== undefined ? { validUntil: patch.validUntil } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeEntries.id, entry.id))
      .returning();
    return row!;
  });
}

export interface TransitionResult {
  entry: KnowledgeEntry;
  /** false when the entry already was in the requested state (idempotent call). */
  changed: boolean;
  /** supersede with `supersededBy`: the replacement entry (activated if it was not). */
  replacement?: KnowledgeEntry | null;
}

async function transition(
  tx: Tx,
  entry: KnowledgeEntry,
  to: KnowledgeStatus,
  set: Partial<typeof knowledgeEntries.$inferInsert> = {},
): Promise<TransitionResult> {
  const plan = planTransition(entry, to);
  if (!plan.changed) return { entry, changed: false };
  const [row] = await tx
    .update(knowledgeEntries)
    .set({ ...set, status: to, updatedAt: new Date() })
    .where(eq(knowledgeEntries.id, entry.id))
    .returning();
  return { entry: row!, changed: true };
}

export async function validateEntry(db: Db, args: { tenantId: string; id: string; reason?: string | undefined }): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, args.tenantId, args.id);
    return transition(tx, entry, 'VALIDATED', args.reason ? { statusReason: args.reason } : {});
  });
}

/** ACTIVE (from PROPOSED or VALIDATED). Requires evidence. `valid_from` defaults to now. */
export async function activateEntry(db: Db, args: { tenantId: string; id: string; reason?: string | undefined }): Promise<TransitionResult> {
  return db.transaction(async (tx) => activateLocked(tx, await lockEntry(tx, args.tenantId, args.id), args.reason));
}

async function activateLocked(tx: Tx, entry: KnowledgeEntry, reason?: string): Promise<TransitionResult> {
  const now = new Date();
  if (!planTransition(entry, 'ACTIVE').changed) return { entry, changed: false };
  if (entry.validUntil && entry.validUntil <= now) throw new KnowledgeServiceError('invalid', 'valid_until is in the past: the entry would never apply');
  return transition(tx, entry, 'ACTIVE', { activatedAt: now, validFrom: entry.validFrom ?? now, ...(reason ? { statusReason: reason } : {}) });
}

/**
 * ACTIVE -> SUPERSEDED (`valid_until` = now). With `supersededBy` the replacement entry (same
 * tenant) is activated in the same transaction when it is PROPOSED/VALIDATED, so the domain is
 * never left without the knowledge in between.
 */
export async function supersedeEntry(
  db: Db,
  args: { tenantId: string; id: string; supersededBy?: string | undefined; reason?: string | undefined },
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, args.tenantId, args.id);
    if (entry.status === 'SUPERSEDED') return { entry, changed: false, replacement: null };
    let replacement: KnowledgeEntry | null = null;
    if (args.supersededBy) {
      if (args.supersededBy === entry.id) throw new KnowledgeServiceError('invalid', 'an entry cannot supersede itself');
      const r = await lockEntry(tx, args.tenantId, args.supersededBy);
      if (r.status === 'SUPERSEDED' || r.status === 'REJECTED') throw new KnowledgeServiceError('conflict', `replacement entry is ${r.status}`);
      replacement = r.status === 'ACTIVE' ? r : (await activateLocked(tx, r)).entry;
    }
    const result = await transition(tx, entry, 'SUPERSEDED', {
      validUntil: new Date(),
      ...(replacement ? { supersededBy: replacement.id } : {}),
      ...(args.reason ? { statusReason: args.reason } : {}),
    });
    return { ...result, replacement };
  });
}

/** PROPOSED | VALIDATED -> REJECTED, with the reason. */
export async function rejectEntry(db: Db, args: { tenantId: string; id: string; reason: string }): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, args.tenantId, args.id);
    return transition(tx, entry, 'REJECTED', { statusReason: args.reason });
  });
}
