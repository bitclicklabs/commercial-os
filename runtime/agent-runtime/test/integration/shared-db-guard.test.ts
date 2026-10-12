/**
 * The shared-database guard installed by test/setup-env.ts (tanda 16, incident 2026-10-12):
 * from a test process, every path to PostgreSQL (a bare pg.Client, `createDb`'s pool through
 * drizzle, `runMigrations`) refuses the database named `agentos` unless
 * ALLOW_SHARED_TEST_DB=1, while the suite's own database keeps working.
 *
 * No connection to `agentos` is ever opened: the refusal happens before the socket.
 */
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ALLOW_SHARED_TEST_DB_ENV, SharedTestDatabaseError, sharedDatabaseRefusal, sharedDbGuardState, type SharedDbGuardState } from '../helpers/shared-db-guard.js';

const OWN_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt16_sched';
const SHARED_URL = 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

describe('shared-database guard (test/setup-env.ts)', () => {
  let state: SharedDbGuardState;
  let saved: Pick<SharedDbGuardState, 'report' | 'reported'>;
  const reports: Error[] = [];

  beforeEach(() => {
    const installed = sharedDbGuardState(pg);
    if (!installed) throw new Error('the guard is not installed: test/setup-env.ts must call installSharedDbGuard(pg)');
    state = installed;
    saved = { report: state.report, reported: state.reported };
    // Capture the report instead of the uncaught rethrow (which would fail this run on purpose).
    reports.length = 0;
    state.report = (e) => reports.push(e);
    state.reported = false;
  });

  afterEach(() => {
    state.report = saved.report;
    state.reported = saved.reported;
  });

  it.skipIf(process.env[ALLOW_SHARED_TEST_DB_ENV] === '1')('refuses "agentos" without ALLOW_SHARED_TEST_DB: bare client, drizzle pool and migrations', async () => {
    await expect(new pg.Client({ connectionString: SHARED_URL }).connect()).rejects.toBeInstanceOf(SharedTestDatabaseError);

    // drizzle wraps driver errors (DrizzleQueryError): the guard's error is the cause.
    const rootCause = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        let e: unknown = err;
        while (e instanceof Error && !(e instanceof SharedTestDatabaseError) && e.cause) e = e.cause;
        return e;
      }
      throw new Error('expected a rejection');
    };
    const shared = createDb(SHARED_URL);
    try {
      expect(await rootCause(shared.db.execute(sql`select 1`))).toBeInstanceOf(SharedTestDatabaseError);
      expect(await rootCause(runMigrations(shared.db))).toBeInstanceOf(SharedTestDatabaseError);
    } finally {
      await shared.close();
    }
    // Reported once per file (vitest shows it as an uncaught exception of the file).
    expect(reports).toHaveLength(1);
    expect(reports[0]!.message).toMatch(/DATABASE_URL=postgres:\/\/agentos:agentos_dev@127\.0\.0\.1:5440\/agentos_<yours>/);
  });

  it('ALLOW_SHARED_TEST_DB=1 lifts the refusal (checked without connecting)', () => {
    expect(sharedDatabaseRefusal('agentos', { ...process.env, [ALLOW_SHARED_TEST_DB_ENV]: '1' })).toBeNull();
    expect(sharedDatabaseRefusal('agentos', { ...process.env, [ALLOW_SHARED_TEST_DB_ENV]: '' })).toBeInstanceOf(SharedTestDatabaseError);
  });

  it.skipIf(process.env.SKIP_DB_TESTS === '1')('the suite\'s own database is not affected', async (ctx) => {
    const client = new pg.Client({ connectionString: OWN_URL, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
    } catch (err) {
      if (err instanceof SharedTestDatabaseError) throw err;
      ctx.skip(); // PostgreSQL not reachable
      return;
    }
    try {
      expect((await client.query('select current_database() as db')).rows[0].db).not.toBe('agentos');
    } finally {
      await client.end();
    }
    expect(reports).toHaveLength(0);
  });
});
