/**
 * Tanda 16 (incident 2026-10-12): tenant allowlist of the scheduler (SCHEDULER_TENANTS),
 * catch-up cap (CATCHUP_MAX_SLOTS / CATCHUP_MAX_AGE_MS), test-tenant patterns of the cleanup
 * and the shared-database guard of the test suites. No database, no Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { isTestTenantId } from '../../src/maintenance/archive-test-tenants.js';
import { EventTriggerConsumer, type EventTriggerRegistry, type RegisteredTrigger } from '../../src/scheduler/event-triggers.js';
import { DEFAULT_CATCHUP_MAX_AGE_MS, planTickSlots, type NormalizedSchedule } from '../../src/scheduler/schedule.js';
import {
  allTenants,
  describeAllowlist,
  IgnoredTenantsReport,
  onlyTenants,
  parseSchedulerTenants,
  tenantAllowed,
  TenantAllowlistError,
} from '../../src/scheduler/tenant-allowlist.js';
import type { RunQueue } from '../../src/queue/run-queue.js';
import {
  databaseNameOf,
  installSharedDbGuard,
  SharedTestDatabaseError,
  sharedDatabaseRefusal,
} from '../helpers/shared-db-guard.js';

const H = 3600_000;

function spyLogger() {
  const warns: Array<{ obj: object; msg?: string }> = [];
  const infos: Array<{ obj: object; msg?: string }> = [];
  return { warns, infos, logger: { info: (obj: object, msg?: string) => infos.push({ obj, msg }), warn: (obj: object, msg?: string) => warns.push({ obj, msg }), error() {} } };
}

// ---------------------------------------------------------------------------
describe('SCHEDULER_TENANTS allowlist', () => {
  it('defaults to DEFAULT_TENANT_ID (publiexpe) when unset or empty', () => {
    expect(parseSchedulerTenants(undefined, 'publiexpe')).toEqual({ all: false, tenants: ['publiexpe'] });
    expect(parseSchedulerTenants('', 'publiexpe')).toEqual({ all: false, tenants: ['publiexpe'] });
    expect(parseSchedulerTenants(' , ', 'acme')).toEqual({ all: false, tenants: ['acme'] });
  });

  it('accepts a comma separated list (trimmed, duplicates collapsed)', () => {
    const list = parseSchedulerTenants(' publiexpe , acme,publiexpe ', 'publiexpe');
    expect(list).toEqual({ all: false, tenants: ['publiexpe', 'acme'] });
    expect(tenantAllowed(list, 'acme')).toBe(true);
    expect(tenantAllowed(list, 'it-1a2b3c4d')).toBe(false);
    expect(tenantAllowed(list, undefined)).toBe(false);
    expect(describeAllowlist(list)).toBe('publiexpe,acme');
  });

  it('"*" restores the multi-tenant behaviour (test environments only)', () => {
    const list = parseSchedulerTenants('*', 'publiexpe');
    expect(list.all).toBe(true);
    expect(tenantAllowed(list, 'it-1a2b3c4d')).toBe(true);
    expect(describeAllowlist(list)).toBe('*');
  });

  it('rejects "*" mixed with tenants and malformed ids', () => {
    expect(() => parseSchedulerTenants('publiexpe,*', 'publiexpe')).toThrow(TenantAllowlistError);
    expect(() => parseSchedulerTenants('publi expe', 'publiexpe')).toThrow(/invalid tenant id/);
  });

  it('loadConfig resolves SCHEDULER_TENANTS and the catch-up knobs', () => {
    const base = loadConfig({}, []);
    expect(base.schedulerTenants).toEqual({ all: false, tenants: ['publiexpe'] });
    expect(base.catchupMaxSlots).toBe(1);
    expect(base.catchupMaxAgeMs).toBe(48 * H);
    expect(loadConfig({ DEFAULT_TENANT_ID: 'acme' }, []).schedulerTenants.tenants).toEqual(['acme']);
    expect(loadConfig({ SCHEDULER_TENANTS: 'publiexpe,acme' }, []).schedulerTenants.tenants).toEqual(['publiexpe', 'acme']);
    expect(loadConfig({ SCHEDULER_TENANTS: '*' }, []).schedulerTenants.all).toBe(true);
    const custom = loadConfig({ CATCHUP_MAX_SLOTS: '3', CATCHUP_MAX_AGE_MS: '3600000' }, []);
    expect([custom.catchupMaxSlots, custom.catchupMaxAgeMs]).toEqual([3, H]);
    expect(() => loadConfig({ SCHEDULER_TENANTS: '*,publiexpe' }, [])).toThrow(/must be used alone/);
    expect(() => loadConfig({ CATCHUP_MAX_SLOTS: '0' }, [])).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('IgnoredTenantsReport: one aggregated WARN per pass', () => {
  it('sums every ignored task and tick into a single WARN, then resets', () => {
    const { warns, logger } = spyLogger();
    const report = new IgnoredTenantsReport();
    for (let i = 0; i < 300; i++) report.addTasks(`it-${String(i).padStart(8, '0')}`, 2);
    report.addTick('e2e-aaaaaaaa');
    report.addTick('e2e-aaaaaaaa');
    expect(report.flush(onlyTenants(['publiexpe']), logger)).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ scheduler_tenants: 'publiexpe', ignored_tasks: 600, ignored_ticks: 2, ignored_tenants: 301 });
    // At most 20 tenants by name plus one "(+N more tenants)" bucket.
    expect(Object.keys((warns[0]!.obj as { tasks_by_tenant: object }).tasks_by_tenant)).toHaveLength(21);
    // Counters reset: a clean pass logs nothing.
    expect(report.flush(onlyTenants(['publiexpe']), logger)).toBe(false);
    expect(warns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('catch-up cap (planTickSlots)', () => {
  const daily9: NormalizedSchedule = { type: 'CRON', expression: '0 9 * * *', timezone: 'UTC' };
  const policy = (maxSlots = 1, maxAgeMs = DEFAULT_CATCHUP_MAX_AGE_MS) => ({ maxSlots, maxAgeMs });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an on-time (or slightly late) tick runs its own slot', () => {
    vi.setSystemTime(new Date('2026-10-12T09:00:04Z'));
    expect(planTickSlots(daily9, '2026-10-12T09:00:00Z', policy())).toEqual({ kind: 'on_time', tickSlot: '2026-10-12T09:00:00Z', run: ['2026-10-12T09:00:00Z'] });
    vi.setSystemTime(new Date('2026-10-12T09:04:00Z'));
    expect(planTickSlots(daily9, '2026-10-12T09:00:00Z', policy()).kind).toBe('on_time');
  });

  it('after a weekend off, the late Saturday tick runs ONE slot: the most recent one (Monday), not Saturday', () => {
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z')); // Monday
    const plan = planTickSlots(daily9, '2026-10-10T09:00:00Z', policy());
    expect(plan).toEqual({ kind: 'catch_up', tickSlot: '2026-10-10T09:00:00Z', run: ['2026-10-12T09:00:00Z'] });
  });

  it('CATCHUP_MAX_SLOTS caps the recovered slots and the max age still applies (Saturday is 49 h old)', () => {
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    expect(planTickSlots(daily9, '2026-10-10T09:00:00Z', policy(5)).run).toEqual(['2026-10-11T09:00:00Z', '2026-10-12T09:00:00Z']);
    expect(planTickSlots(daily9, '2026-10-10T09:00:00Z', policy(5, 72 * H)).run).toEqual([
      '2026-10-10T09:00:00Z',
      '2026-10-11T09:00:00Z',
      '2026-10-12T09:00:00Z',
    ]);
    expect(planTickSlots(daily9, '2026-10-10T09:00:00Z', policy(2, 72 * H)).run).toEqual(['2026-10-11T09:00:00Z', '2026-10-12T09:00:00Z']);
  });

  it('a missed slot older than CATCHUP_MAX_AGE_MS is skipped and the next natural slot rules', () => {
    const weekly: NormalizedSchedule = { type: 'CRON', expression: '0 9 * * 1', timezone: 'UTC' };
    vi.setSystemTime(new Date('2026-10-14T10:00:00Z')); // Wednesday; Monday 09:00 is 49 h old
    expect(planTickSlots(weekly, '2026-10-12T09:00:00Z', policy())).toEqual({
      kind: 'stale',
      tickSlot: '2026-10-12T09:00:00Z',
      run: [],
      newestDue: '2026-10-12T09:00:00Z',
    });
  });

  it('INTERVAL: recovers the most recent slots with the phase of the tick', () => {
    const every10m: NormalizedSchedule = { type: 'INTERVAL', everySeconds: 600 };
    vi.setSystemTime(new Date('2026-10-12T10:07:00Z'));
    expect(planTickSlots(every10m, '2026-10-11T22:00:00Z', policy(2)).run).toEqual(['2026-10-12T09:50:00Z', '2026-10-12T10:00:00Z']);
    vi.setSystemTime(new Date('2026-10-20T10:07:00Z'));
    expect(planTickSlots(every10m, '2026-10-11T22:00:00Z', policy(1)).run).toEqual(['2026-10-20T10:00:00Z']);
    const weekly: NormalizedSchedule = { type: 'INTERVAL', everySeconds: 7 * 24 * 3600 };
    expect(planTickSlots(weekly, '2026-10-17T10:00:00Z', policy()).kind).toBe('stale');
  });

  it('a seconds-level CRON never walks the whole gap (bounded work)', () => {
    const everySecond: NormalizedSchedule = { type: 'CRON', expression: '* * * * * *', timezone: 'UTC' };
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const started = performance.now();
    const plan = planTickSlots(everySecond, '2026-10-10T10:00:00Z', policy(3));
    expect(plan.run).toEqual(['2026-10-12T09:59:58Z', '2026-10-12T09:59:59Z', '2026-10-12T10:00:00Z']);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
describe('EVENT consumer: triggers of a tenant outside the allowlist never fire', () => {
  const trigger = (tenant: string, i: number): RegisteredTrigger => ({
    task_id: `00000000-0000-4000-8000-00000000000${i}`,
    tenant_id: tenant,
    event_type: 'prospect.qualified',
    filter: {},
    registered_at: '2026-10-10T00:00:00Z',
  });
  const envelope = (tenantId: string) => ({
    id: '00000000-0000-4000-8000-0000000000aa',
    type: 'prospect.qualified',
    schemaVersion: 'prospect.qualified.v1',
    tenantId,
    occurredAt: '2026-10-12T10:00:00Z',
    producer: 'twenty-app',
    correlationId: 'c-1',
    data: {},
  });

  it('returns skipped_tenant for every stale registration, logs ONE warn and never reads PostgreSQL', async () => {
    const registry = { list: async () => [trigger('it-1a2b3c4d', 1), trigger('it-1a2b3c4d', 2), trigger('publiexpe', 3)] } as unknown as EventTriggerRegistry;
    const db = new Proxy({}, { get: () => { throw new Error('db must not be touched'); } });
    const { warns, logger } = spyLogger();
    const consumer = new EventTriggerConsumer(db as never, {} as RunQueue, { triggers: registry, sync: async () => undefined }, {
      queueName: 'unused',
      redisUrl: 'redis://unused',
      logger,
      tenants: onlyTenants(['publiexpe']),
    });
    const parsed = await consumer.handleEvent(envelope('it-1a2b3c4d'));
    if (parsed.length === 0) throw new Error('envelope rejected: adjust the fixture to EventEnvelopeSchema');
    expect(parsed).toEqual([
      { taskId: trigger('x', 1).task_id, outcome: 'skipped_tenant' },
      { taskId: trigger('x', 2).task_id, outcome: 'skipped_tenant' },
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ ignored_tasks: 2, tasks_by_tenant: { 'it-1a2b3c4d': 2 } });
  });

  it('without the option (or with "*") the consumer behaves as before', async () => {
    const registry = { list: async () => [] } as unknown as EventTriggerRegistry;
    const consumer = new EventTriggerConsumer({} as never, {} as RunQueue, { triggers: registry, sync: async () => undefined }, {
      queueName: 'unused',
      redisUrl: 'redis://unused',
      tenants: allTenants(),
    });
    expect(await consumer.handleEvent(envelope('it-1a2b3c4d'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('cleanup:archive-test-tenants patterns', () => {
  it('matches the tenants of the test suites', () => {
    for (const t of ['it-1a2b3c4d', 'it-kn-1a2b3c4d', 'it-can-1a2b3c4d', 'it-cat-x', 'it-sig-1', 'e2e-1a2b3c4d', 'ev-1a2b3c4d', 'ar-1a2b3c4d', 'it',
      'mt-1a2b3c4d', 'ms-1a2b3c4d', 'n8n-1a2b3c4d', 'acme-run', 'x-empty', 'publi-seed', 'foo-trig', 'bar-skip']) {
      expect(isTestTenantId(t), t).toBe(true);
    }
  });

  it('never matches the real tenant or look-alikes', () => {
    for (const t of ['publiexpe', 'PubliEXPE', 'item', 'events', 'arcos', 'e2e', 'it-', 'mt-production', 'ms-nothex12', 'seed', 'runner', 'acme-runs', '']) {
      expect(isTestTenantId(t), t).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('shared-database guard of the test suites', () => {
  it('extracts the database name of a postgres URL', () => {
    expect(databaseNameOf('postgres://agentos:agentos_dev@127.0.0.1:5440/agentos')).toBe('agentos');
    expect(databaseNameOf('postgresql://u:p@h/agentos?sslmode=disable')).toBe('agentos');
    expect(databaseNameOf('postgres://u:p@h:5440/agentos_wt16_sched')).toBe('agentos_wt16_sched');
    expect(databaseNameOf('postgres://u:p@h:5440')).toBeNull();
    expect(databaseNameOf('not a url')).toBeNull();
    expect(databaseNameOf(undefined)).toBeNull();
  });

  it('refuses exactly "agentos" unless ALLOW_SHARED_TEST_DB=1, with the remedy in the message', () => {
    const err = sharedDatabaseRefusal('agentos', {});
    expect(err).toBeInstanceOf(SharedTestDatabaseError);
    expect(err!.message).toMatch(/create database agentos_<yours>/);
    expect(err!.message).toMatch(/DATABASE_URL=/);
    expect(err!.message).toMatch(/ALLOW_SHARED_TEST_DB=1/);
    expect(sharedDatabaseRefusal('agentos', { ALLOW_SHARED_TEST_DB: '1' })).toBeNull();
    expect(sharedDatabaseRefusal('agentos_wt16_sched', {})).toBeNull();
    expect(sharedDatabaseRefusal('agentos2', {})).toBeNull();
    expect(sharedDatabaseRefusal(undefined, {})).toBeNull();
  });

  it('patches Client#connect (promise and callback forms) and reports only once', async () => {
    const connected: string[] = [];
    class FakeClient {
      constructor(readonly database: string) {}
      connect(cb?: (err?: Error) => void): Promise<void> | void {
        connected.push(this.database);
        if (cb) return cb();
        return Promise.resolve();
      }
    }
    const reports: Error[] = [];
    const env: NodeJS.ProcessEnv = {};
    const fakePg = { Client: FakeClient };
    const state = installSharedDbGuard(fakePg, { env, report: (e) => reports.push(e) });
    expect(installSharedDbGuard(fakePg)).toBe(state); // idempotent

    await expect(new FakeClient('agentos').connect()).rejects.toBeInstanceOf(SharedTestDatabaseError);
    const viaCallback = await new Promise<Error | undefined>((resolve) => void new FakeClient('agentos').connect((e) => resolve(e)));
    expect(viaCallback).toBeInstanceOf(SharedTestDatabaseError);
    expect(reports).toHaveLength(1);
    expect(connected).toEqual([]);

    await new FakeClient('agentos_wt16_sched').connect();
    env.ALLOW_SHARED_TEST_DB = '1';
    await new FakeClient('agentos').connect();
    expect(connected).toEqual(['agentos_wt16_sched', 'agentos']);
  });
});
