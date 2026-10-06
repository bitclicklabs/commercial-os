/**
 * EntityLocks against a real PostgreSQL (skipped when unreachable or SKIP_DB_TESTS=1).
 * Uses a fresh tenant per run: no cleanup, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EntityLockedError, EntityLocks } from '../../src/worker/entity-locks.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

async function databaseReachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const dbAvailable = process.env.SKIP_DB_TESTS === '1' ? false : await databaseReachable(DATABASE_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dbAvailable)('EntityLocks (PostgreSQL)', () => {
  const tenantId = `it-${randomUUID().slice(0, 8)}`;
  let handle: DbHandle;
  let locks: EntityLocks;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    locks = new EntityLocks(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('is exclusive, re-entrant for the holder and released only by the holder', async () => {
    const entity = { tenantId, entityType: 'company', entityId: 'acme.com' };
    const a = randomUUID();
    const b = randomUUID();

    const first = await locks.acquire({ ...entity, executionId: a, ttlMs: 60_000 });
    expect(first?.lockedByExecution).toBe(a);
    expect(await locks.acquire({ ...entity, executionId: b, ttlMs: 60_000 })).toBeNull();

    const renewed = await locks.acquire({ ...entity, executionId: a, ttlMs: 120_000 });
    expect(renewed?.lockedByExecution).toBe(a);
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(first!.expiresAt.getTime());
    expect(renewed!.acquiredAt.getTime()).toBe(first!.acquiredAt.getTime());

    expect(await locks.release({ ...entity, executionId: b })).toBe(false);
    expect((await locks.holder(entity))?.lockedByExecution).toBe(a);
    expect(await locks.release({ ...entity, executionId: a })).toBe(true);
    expect(await locks.holder(entity)).toBeNull();

    expect((await locks.acquire({ ...entity, executionId: b, ttlMs: 60_000 }))?.lockedByExecution).toBe(b);
    expect(await locks.releaseAll(b)).toBe(1);
    expect(await locks.releaseAll(b)).toBe(0);
  });

  it('only one of many concurrent acquirers wins', async () => {
    const entity = { tenantId, entityType: 'company', entityId: 'race.example' };
    const contenders = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.all(contenders.map((executionId) => locks.acquire({ ...entity, executionId, ttlMs: 60_000 })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('expires after the TTL so a crashed holder does not block forever', async () => {
    const entity = { tenantId, entityType: 'contact', entityId: 'c-1' };
    const crashed = randomUUID();
    expect(await locks.acquire({ ...entity, executionId: crashed, ttlMs: 1_000 })).not.toBeNull();
    expect(await locks.acquire({ ...entity, executionId: randomUUID(), ttlMs: 1_000 })).toBeNull();
    await sleep(1_200);
    const next = randomUUID();
    expect((await locks.acquire({ ...entity, executionId: next, ttlMs: 60_000 }))?.lockedByExecution).toBe(next);
    // The expired holder cannot release the new lease.
    expect(await locks.release({ ...entity, executionId: crashed })).toBe(false);
  });

  it('withLock runs the callback under the lock and releases it afterwards', async () => {
    const entity = { tenantId, entityType: 'company', entityId: 'with-lock.example' };
    const holder = randomUUID();
    const value = await locks.withLock({ ...entity, executionId: holder, ttlMs: 60_000 }, async () => {
      await expect(
        locks.withLock({ ...entity, executionId: randomUUID(), ttlMs: 60_000 }, async () => 'never'),
      ).rejects.toBeInstanceOf(EntityLockedError);
      return 'done';
    });
    expect(value).toBe('done');
    expect(await locks.holder(entity)).toBeNull();
  });
});
