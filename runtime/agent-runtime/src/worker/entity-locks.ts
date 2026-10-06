/**
 * Entity locks (LLD v0.1 section 21): at most one execution works on a business entity
 * (e.g. `company` / `acme.com`) at a time.
 *
 * Lease semantics on PostgreSQL, using the database clock (`now()`) so every worker agrees:
 * - `acquire` is a single atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE: it takes a free
 *   row, takes over an expired one, or renews a lease already held by the same execution
 *   (re-entrant). Otherwise it returns null without waiting.
 * - `release` ends the lease by setting `expires_at = now()` (no physical DELETE, section 22).
 * - `releaseAll` frees every lease of an execution; the worker calls it when the attempt ends,
 *   so a crashed holder is bounded by the TTL and a finished one never leaks.
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { entityLocks, type EntityLock } from '../db/schema.js';

export interface EntityRef {
  tenantId: string;
  entityType: string;
  entityId: string;
}

export interface AcquireLockInput extends EntityRef {
  executionId: string;
  ttlMs: number;
}

export class EntityLockedError extends Error {
  constructor(
    readonly entity: EntityRef,
    readonly holder: EntityLock | null,
  ) {
    super(`entity ${entity.entityType}:${entity.entityId} is locked${holder ? ` by ${holder.lockedByExecution}` : ''}`);
    this.name = 'EntityLockedError';
  }
}

const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 3600 * 1000;

export class EntityLocks {
  constructor(private readonly db: Db) {}

  /** Returns the lease when acquired (or renewed by the same execution), null when held by another. */
  async acquire(input: AcquireLockInput): Promise<EntityLock | null> {
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(input.ttlMs)));
    const expiresAt = sql`now() + (${ttlMs}::int * interval '1 millisecond')`;
    const [row] = await this.db
      .insert(entityLocks)
      .values({
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        lockedByExecution: input.executionId,
        acquiredAt: sql`now()`,
        expiresAt,
        releasedAt: null,
      })
      .onConflictDoUpdate({
        target: [entityLocks.tenantId, entityLocks.entityType, entityLocks.entityId],
        set: {
          lockedByExecution: sql`excluded.locked_by_execution`,
          // Keep the original acquisition time on a re-entrant renewal.
          acquiredAt: sql`case when ${entityLocks.lockedByExecution} = excluded.locked_by_execution
            and ${entityLocks.expiresAt} > now() then ${entityLocks.acquiredAt} else now() end`,
          expiresAt: sql`excluded.expires_at`,
          releasedAt: null,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${entityLocks.expiresAt} <= now() or ${entityLocks.lockedByExecution} = excluded.locked_by_execution`,
      })
      .returning();
    return row ?? null;
  }

  /** Releases the lease if (and only if) `executionId` still holds it. */
  async release(input: EntityRef & { executionId: string }): Promise<boolean> {
    const rows = await this.db
      .update(entityLocks)
      .set({ expiresAt: sql`now()`, releasedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(entityLocks.tenantId, input.tenantId),
          eq(entityLocks.entityType, input.entityType),
          eq(entityLocks.entityId, input.entityId),
          eq(entityLocks.lockedByExecution, input.executionId),
          gt(entityLocks.expiresAt, sql`now()`),
        ),
      )
      .returning({ entityId: entityLocks.entityId });
    return rows.length > 0;
  }

  /** Releases every live lease held by an execution. Returns how many were released. */
  async releaseAll(executionId: string): Promise<number> {
    const rows = await this.db
      .update(entityLocks)
      .set({ expiresAt: sql`now()`, releasedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(entityLocks.lockedByExecution, executionId), gt(entityLocks.expiresAt, sql`now()`)))
      .returning({ entityId: entityLocks.entityId });
    return rows.length;
  }

  /** Current live holder of an entity, or null when free. */
  async holder(entity: EntityRef): Promise<EntityLock | null> {
    const row = await this.db.query.entityLocks.findFirst({
      where: and(
        eq(entityLocks.tenantId, entity.tenantId),
        eq(entityLocks.entityType, entity.entityType),
        eq(entityLocks.entityId, entity.entityId),
        gt(entityLocks.expiresAt, sql`now()`),
      ),
    });
    return row ?? null;
  }

  /** Runs `fn` while holding the lock; throws EntityLockedError if another execution holds it. */
  async withLock<T>(input: AcquireLockInput, fn: (lock: EntityLock) => Promise<T>): Promise<T> {
    const lock = await this.acquire(input);
    if (!lock) throw new EntityLockedError(input, await this.holder(input));
    try {
      return await fn(lock);
    } finally {
      await this.release(input);
    }
  }
}
