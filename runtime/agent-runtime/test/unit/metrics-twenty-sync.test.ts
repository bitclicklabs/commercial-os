/**
 * Metrics sync to Twenty (src/metrics/twenty-sync.ts): day windows, record mapping, upsert by
 * dayKey and quiet degradation. The summary is stubbed; Twenty is the in-memory FakeTwenty.
 */
import { describe, expect, it, vi } from 'vitest';
import { TwentyApiError } from '../../src/integrations/twenty/client.js';
import {
  addDays,
  computeDailyMetric,
  DAILY_METRICS_OBJECT,
  emailSendsOfDay,
  localDayWindow,
  localMidnight,
  metricsSyncSettingsFromEnv,
  TwentyMetricsSync,
  upsertDailyMetric,
  type SummaryFn,
  type SummarySlice,
} from '../../src/metrics/twenty-sync.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const slice = (over: Partial<{ total: number; status: Record<string, number>; outcome: Record<string, number>; cost: number | null; hyp: number; reviewed: number; accepted: number; rate: number | null; sends: number | null }> = {}): SummarySlice => ({
  runs: { total: over.total ?? 0, by_status: over.status ?? {}, by_outcome: over.outcome ?? {} },
  cost: { total_eur: over.cost ?? 0 },
  funnel: { hypotheses_created: over.hyp ?? 0 },
  human_feedback: { subjects_reviewed: over.reviewed ?? 0, accepted: over.accepted ?? 0, acceptance_rate: over.rate ?? null },
  email: { sends: { in_window: over.sends ?? 0 } },
});

/** Day summary when `since` is given, cumulative one otherwise. */
const stubSummary = (day: SummarySlice, toDate: SummarySlice) => {
  const calls: Array<{ since?: Date; until?: Date }> = [];
  const fn: SummaryFn = async (w) => {
    calls.push({ since: w.since, until: w.until });
    return w.since ? day : toDate;
  };
  return { fn, calls };
};

function fakeWithObject(): FakeTwenty {
  const fake = new FakeTwenty();
  fake.tables[DAILY_METRICS_OBJECT] = [];
  return fake;
}

describe('local day windows (Europe/Madrid)', () => {
  it('maps a summer day to 22:00Z..22:00Z and a winter day to 23:00Z..23:00Z', () => {
    expect(localDayWindow('2026-10-07', 'Europe/Madrid')).toEqual({
      since: new Date('2026-10-06T22:00:00.000Z'),
      until: new Date('2026-10-07T22:00:00.000Z'),
    });
    expect(localMidnight('2026-12-01', 'Europe/Madrid').toISOString()).toBe('2026-11-30T23:00:00.000Z');
  });

  it('handles the DST change day (25 hours long on 2026-10-25)', () => {
    const { since, until } = localDayWindow('2026-10-25', 'Europe/Madrid');
    expect(since.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(until.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});

describe('computeDailyMetric', () => {
  it('maps the day summary, the cumulative acceptance and the warm-up target of that date', async () => {
    const { fn, calls } = stubSummary(
      slice({ total: 7, status: { COMPLETED: 5, FAILED: 1, TIMED_OUT: 1 }, outcome: { SUCCESS: 4, PARTIAL: 1 }, cost: 0.123456, hyp: 3, reviewed: 2, accepted: 1, rate: 0.5, sends: 9 }),
      slice({ rate: 0.6667 }),
    );
    const rec = await computeDailyMetric(fn, { tenantId: 'publiexpe', date: '2026-10-07', now: new Date('2026-10-07T10:00:00Z') });
    expect(calls).toEqual([
      { since: new Date('2026-10-06T22:00:00.000Z'), until: new Date('2026-10-07T22:00:00.000Z') },
      { since: undefined, until: new Date('2026-10-07T22:00:00.000Z') },
    ]);
    expect(rec).toMatchObject({
      name: '2026-10-07 · publiexpe',
      day: '2026-10-07',
      dayKey: 'publiexpe:2026-10-07',
      tenantId: 'publiexpe',
      runs: 7,
      runsSucceeded: 4,
      runsFailed: 2,
      cost: { amountMicros: 123456, currencyCode: 'EUR' },
      hypothesesCreated: 3,
      emailSends: 9,
      warmupStage: 'WARMUP',
      humanReviewed: 2,
      humanAccepted: 1,
      acceptanceRate: 66.7,
      syncedAt: '2026-10-07T10:00:00.000Z',
    });
    // 2026-10-07 is a Wednesday inside the warm-up: a positive target and a phase label.
    expect(rec.warmupTarget).toBeGreaterThan(0);
    expect(rec.warmupPhase).toEqual(expect.any(String));
  });

  it('gives target 0 on a warm-up weekend, null target outside the warm-up and null rate without verdicts', async () => {
    const { fn } = stubSummary(slice(), slice({ rate: null }));
    const saturday = await computeDailyMetric(fn, { tenantId: 't', date: '2026-10-10' });
    expect(saturday.warmupTarget).toBe(0);
    const before = await computeDailyMetric(fn, { tenantId: 't', date: '2026-09-30' });
    expect(before).toMatchObject({ warmupStage: 'BEFORE', warmupTarget: null, warmupPhase: null, acceptanceRate: null, cost: { amountMicros: 0 } });
    const after = await computeDailyMetric(fn, { tenantId: 't', date: '2026-12-01' });
    expect(after).toMatchObject({ warmupStage: 'POST_WARMUP', warmupTarget: null });
  });

  it('counts zero sends when the summary has no email block', async () => {
    const day = { ...slice({ total: 1 }), email: null };
    const rec = await computeDailyMetric(async () => day, { tenantId: 't', date: '2026-10-07' });
    expect(rec.emailSends).toBe(0);
  });

  it('tanda 19: sends of the DAY of the row; a summary without window (in_window null) falls back to sends.today only for today', async () => {
    const now = new Date('2026-10-12T20:53:44Z'); // 22:53 Madrid
    // Per-day window count (what metricsSummary returns with since/until): used as is, any day.
    expect(emailSendsOfDay({ ...slice(), email: { sends: { in_window: 1, today: 1 } } }, '2026-10-12', '2026-10-12')).toBe(1);
    expect(emailSendsOfDay({ ...slice(), email: { sends: { in_window: 0, today: 1 } } }, '2026-10-11', '2026-10-12')).toBe(0);
    // in_window null + today 1 (what GET /metrics/summary showed): today's row takes it, older rows 0.
    const noWindow = { ...slice(), email: { sends: { in_window: null, today: 1 } } };
    expect(emailSendsOfDay(noWindow, '2026-10-12', '2026-10-12')).toBe(1);
    expect(emailSendsOfDay(noWindow, '2026-10-11', '2026-10-12')).toBe(0);
    const today = await computeDailyMetric(async () => noWindow, { tenantId: 't', date: '2026-10-12', now });
    expect(today.emailSends).toBe(1);
    const yesterday = await computeDailyMetric(async () => noWindow, { tenantId: 't', date: '2026-10-11', now });
    expect(yesterday.emailSends).toBe(0);
  });
});

describe('upsertDailyMetric', () => {
  it('creates the record once and then updates it by dayKey', async () => {
    const fake = fakeWithObject();
    const twenty = fake.client();
    const { fn } = stubSummary(slice({ total: 1 }), slice());
    const rec = await computeDailyMetric(fn, { tenantId: 'publiexpe', date: '2026-10-07' });
    expect(await upsertDailyMetric(twenty, rec)).toBe('created');
    expect(await upsertDailyMetric(twenty, { ...rec, runs: 5 })).toBe('updated');
    const rows = fake.tables[DAILY_METRICS_OBJECT]!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dayKey: 'publiexpe:2026-10-07', runs: 5 });
    expect(fake.requests.filter((r) => r.method === 'GET')[0]!.path).toBe(`/rest/${DAILY_METRICS_OBJECT}`);
  });

  it('turns a lost create race (duplicate) into an update', async () => {
    const fake = fakeWithObject();
    const twenty = fake.client();
    const { fn } = stubSummary(slice({ total: 2 }), slice());
    const rec = await computeDailyMetric(fn, { tenantId: 'publiexpe', date: '2026-10-07' });
    // The first find misses; meanwhile another writer creates the record, so our POST is a duplicate.
    vi.spyOn(twenty, 'list').mockResolvedValueOnce({ records: [], totalCount: 0, pageInfo: {} });
    fake.seed(DAILY_METRICS_OBJECT, { dayKey: rec.dayKey, runs: 1 });
    vi.spyOn(twenty, 'create').mockRejectedValueOnce(new TwentyApiError('TWENTY_DUPLICATE', 'duplicate entry', 400, false));
    expect(await upsertDailyMetric(twenty, rec)).toBe('updated');
    expect(fake.tables[DAILY_METRICS_OBJECT]).toHaveLength(1);
    expect(fake.tables[DAILY_METRICS_OBJECT]![0]).toMatchObject({ runs: 2 });
  });
});

describe('TwentyMetricsSync', () => {
  const now = () => new Date('2026-10-07T21:30:00Z'); // 23:30 in Madrid

  it('syncs today and yesterday (local dates) on each pass', async () => {
    const fake = fakeWithObject();
    const { fn } = stubSummary(slice({ total: 3 }), slice({ rate: 1 }));
    const sync = new TwentyMetricsSync(undefined, fake.client(), { tenantId: 'publiexpe', summary: fn, now });
    expect(sync.datesToSync()).toEqual(['2026-10-06', '2026-10-07']);
    const first = await sync.syncOnce();
    expect(first).toEqual({ ok: true, days: [{ date: '2026-10-06', result: 'created' }, { date: '2026-10-07', result: 'created' }] });
    const second = await sync.syncOnce();
    expect(second.days.map((d) => d.result)).toEqual(['updated', 'updated']);
    expect(fake.tables[DAILY_METRICS_OBJECT]).toHaveLength(2);
  });

  it('uses the local date: 00:30 in Madrid is already the next day', () => {
    const sync = new TwentyMetricsSync(undefined, new FakeTwenty().client(), {
      tenantId: 't',
      summary: async () => slice(),
      now: () => new Date('2026-10-07T22:30:00Z'),
      days: 1,
    });
    expect(sync.datesToSync()).toEqual(['2026-10-08']);
  });

  it('degrades quietly when the App object does not exist yet: one warning, no throw, then recovers', async () => {
    const fake = new FakeTwenty(); // no agentOsDailyMetrics table -> 404
    const warn = vi.fn();
    const info = vi.fn();
    const sync = new TwentyMetricsSync(undefined, fake.client(), { tenantId: 't', summary: async () => slice(), now, logger: { warn, info } });
    const r1 = await sync.syncOnce();
    const r2 = await sync.syncOnce();
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe('TWENTY_NOT_FOUND');
    expect(r2.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toMatch(/Twenty App synced/);
    fake.tables[DAILY_METRICS_OBJECT] = [];
    const r3 = await sync.syncOnce();
    expect(r3.ok).toBe(true);
    expect(info).toHaveBeenCalledWith({ days: 2 }, 'metrics sync to Twenty recovered');
  });

  it('does nothing without a Twenty API key', async () => {
    const fake = fakeWithObject();
    const sync = new TwentyMetricsSync(undefined, fake.client({ apiKey: undefined }), { tenantId: 't', summary: async () => slice(), now });
    const r = await sync.syncOnce();
    expect(r).toMatchObject({ ok: false, error: { code: 'TWENTY_NOT_CONFIGURED' } });
    expect(fake.requests).toHaveLength(0);
  });

  it('shares one pass between overlapping calls', async () => {
    const fake = fakeWithObject();
    let calls = 0;
    const sync = new TwentyMetricsSync(undefined, fake.client(), {
      tenantId: 't',
      now,
      summary: async () => {
        calls++;
        return slice();
      },
    });
    const [a, b] = await Promise.all([sync.syncOnce(), sync.syncOnce()]);
    expect(a).toBe(b);
    expect(calls).toBe(4); // 2 days x (day + cumulative)
  });

  it('starts and stops its timer without leaking', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeWithObject();
      const summary = vi.fn(async () => slice());
      const sync = new TwentyMetricsSync(undefined, fake.client(), { tenantId: 't', summary, now, days: 1 });
      sync.start(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await sync.stop();
      const after = summary.mock.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(summary.mock.calls.length).toBe(after);
      expect(after).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs a db or a summary function', () => {
    expect(() => new TwentyMetricsSync(undefined, new FakeTwenty().client(), { tenantId: 't' })).toThrow(/db or a summary/);
  });
});

describe('metricsSyncSettingsFromEnv', () => {
  it('is disabled by default with a 15 min interval and 2 days', () => {
    expect(metricsSyncSettingsFromEnv({})).toEqual({ enabled: false, intervalMs: 900_000, days: 2 });
  });

  it('parses and clamps the values', () => {
    expect(metricsSyncSettingsFromEnv({ METRICS_TWENTY_SYNC_ENABLED: 'true', METRICS_TWENTY_SYNC_INTERVAL_MS: '1000', METRICS_TWENTY_SYNC_DAYS: '500' })).toEqual({
      enabled: true,
      intervalMs: 60_000,
      days: 62,
    });
    expect(metricsSyncSettingsFromEnv({ METRICS_TWENTY_SYNC_ENABLED: 'no', METRICS_TWENTY_SYNC_DAYS: 'x' })).toMatchObject({ enabled: false, days: 2 });
  });
});
