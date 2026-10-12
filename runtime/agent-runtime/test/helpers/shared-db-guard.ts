/**
 * Shared-database guard for the test suites (tanda 16, incident 2026-10-12).
 *
 * Integration suites run against the shared `agentos` database (the DATABASE_URL default)
 * left ACTIVE task_definitions in test tenants (`it-*`, `e2e-*`, ...); the production
 * scheduler later caught all of them up with real credentials. `installSharedDbGuard` is
 * installed by test/setup-env.ts for EVERY test file: any PostgreSQL connection the test
 * process opens to a database named exactly `agentos` is refused, unless
 * `ALLOW_SHARED_TEST_DB=1`.
 *
 * Where it bites: `pg.Client#connect`, the one call every path goes through (`createDb`'s
 * pool, `runMigrations`, the reachability probes of each suite). Unit tests never connect,
 * and suites already pointed at their own database (`agentos_wt*`) never notice it.
 *
 * Loud on purpose: most suites probe the database and `describe.skipIf` when it is not
 * reachable, which would turn the refusal into a silent skip. The guard therefore also throws
 * the error once per test file outside the caller's try/catch: vitest reports it as an
 * "Uncaught Exception" attributed to that file and the run exits with code 1.
 */

export const SHARED_DATABASE_NAME = 'agentos';
export const ALLOW_SHARED_TEST_DB_ENV = 'ALLOW_SHARED_TEST_DB';

export class SharedTestDatabaseError extends Error {
  constructor(readonly database: string) {
    super(
      [
        `[test-db-guard] Refusing to connect the test suite to the shared database "${database}".`,
        'Integration tests left ACTIVE tasks of test tenants in it and the production scheduler ran them (incident 2026-10-12).',
        'Use your own test database instead:',
        '  1. Create it once (same server):  docker exec pxos-postgres psql -U agentos -d postgres -c "create database agentos_<yours>"',
        '  2. Point the tests at it:          DATABASE_URL=postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_<yours>',
        '  3. Migrate it:                     pnpm db:migrate',
        `Override (not recommended): ${ALLOW_SHARED_TEST_DB_ENV}=1.`,
      ].join('\n'),
    );
    this.name = 'SharedTestDatabaseError';
  }
}

/** Database name of a postgres URL (`postgres://u:p@h:5440/agentos?x=y` -> `agentos`), or null. */
export function databaseNameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/** The error to raise for a connection to `database`, or null when it is allowed. */
export function sharedDatabaseRefusal(database: string | null | undefined, env: NodeJS.ProcessEnv = process.env): SharedTestDatabaseError | null {
  if (env[ALLOW_SHARED_TEST_DB_ENV] === '1') return null;
  return database === SHARED_DATABASE_NAME ? new SharedTestDatabaseError(database) : null;
}

type ConnectCallback = (err?: Error) => void;
interface PatchableClient {
  database?: string | undefined;
  connect(callback?: ConnectCallback): unknown;
}
interface PgLike {
  Client: { prototype: object };
}

const PATCHED = Symbol.for('pxos.sharedDbGuard');

/** Mutable state of an installed guard (tests of the guard swap `report`). */
export interface SharedDbGuardState {
  env: NodeJS.ProcessEnv;
  /** Called once (until `reported` is reset) with the first refusal. */
  report: (err: SharedTestDatabaseError) => void;
  reported: boolean;
}

/** Rethrows outside any try/catch: vitest reports it against the running test file. */
export function throwUncaught(err: SharedTestDatabaseError): void {
  setTimeout(() => {
    throw err;
  }, 0);
}

/** Patches `pg.Client.prototype.connect` (idempotent: a second call returns the same state). */
export function installSharedDbGuard(
  pgModule: PgLike,
  opts: { env?: NodeJS.ProcessEnv; report?: (err: SharedTestDatabaseError) => void } = {},
): SharedDbGuardState {
  const proto = pgModule.Client.prototype as PatchableClient & { [PATCHED]?: SharedDbGuardState };
  const existing = proto[PATCHED];
  if (existing) return existing;
  const original = proto.connect;
  const state: SharedDbGuardState = { env: opts.env ?? process.env, report: opts.report ?? throwUncaught, reported: false };
  proto.connect = function guardedConnect(this: PatchableClient, callback?: ConnectCallback) {
    const refusal = sharedDatabaseRefusal(this.database, state.env);
    if (!refusal) return original.call(this, callback);
    if (!state.reported) {
      state.reported = true;
      state.report(refusal);
    }
    if (typeof callback === 'function') {
      process.nextTick(() => callback(refusal));
      return undefined;
    }
    return Promise.reject(refusal);
  };
  Object.defineProperty(proto, PATCHED, { value: state });
  return state;
}

/** The state of the guard installed on `pgModule`, if any. */
export function sharedDbGuardState(pgModule: PgLike): SharedDbGuardState | undefined {
  return (pgModule.Client.prototype as { [PATCHED]?: SharedDbGuardState })[PATCHED];
}
