/**
 * Metrics sync to Twenty (docs/estudio-dashboard-twenty.md): writes one `agentOsDailyMetric`
 * record per tenant and LOCAL day (Europe/Madrid) so the native Twenty page
 * "Agent OS · Métricas" can chart what only the runtime knows (runs, cost, sends, warm-up
 * target, human acceptance).
 *
 * - Same numbers as GET /metrics/summary: each day is a `metricsSummary` call over
 *   [local midnight, next local midnight); the acceptance rate is cumulative (no `since`).
 * - Upsert by the unique `dayKey` ("<tenant>:<YYYY-MM-DD>"): find, then PATCH or POST.
 *   A POST that loses a race (duplicate) is resolved by finding again and patching.
 * - Read-only on the runtime side; never deletes in Twenty (the client has no delete).
 * - Degrades quietly: if Twenty is down or the App (object) is not synced yet, the tick logs
 *   one warning per distinct error and tries again on the next tick. Nothing throws out of the
 *   timer, and the runtime API and /dashboard are unaffected.
 * - Opt-in: METRICS_TWENTY_SYNC_ENABLED=true (scheduler role). See .env.example.
 * - Passive counter of re-validations (optional `revalidations` probe): each tick also counts the
 *   PASS_FORM experiments ready to re-validate (src/experiments/revalidation-service.ts) and logs
 *   the number when it changes. It never writes it to Twenty (the agentOsDailyMetric object has
 *   no field for it) and never re-validates: that stays manual (POST /experiments/:id/revalidate).
 */
import type { Db } from '../db/client.js';
import { warmupDay, WARMUP_TIMEZONE, type WarmupStage } from '../email-ops/warmup.js';
import { localDate } from '../inbound/suppression-list.js';
import { filterValue, TwentyApiError, type TwentyClient } from '../integrations/twenty/client.js';
import { metricsSummary } from './queries.js';

export const DAILY_METRICS_OBJECT = 'agentOsDailyMetrics';

const DAY_MS = 86_400_000;

export interface DailyMetricRecord {
  name: string;
  day: string;
  dayKey: string;
  tenantId: string;
  runs: number;
  runsSucceeded: number;
  runsFailed: number;
  cost: { amountMicros: number; currencyCode: 'EUR' };
  hypothesesCreated: number;
  emailSends: number;
  warmupTarget: number | null;
  warmupStage: 'BEFORE' | 'WARMUP' | 'POST_WARMUP';
  warmupPhase: string | null;
  humanReviewed: number;
  humanAccepted: number;
  /** Percent 0-100, one decimal, cumulative up to the end of the day; null without verdicts. */
  acceptanceRate: number | null;
  syncedAt: string;
}

/** The slice of `metricsSummary` the sync reads (lets unit tests inject a stub). */
export interface SummarySlice {
  runs: { total: number; by_status: Record<string, number>; by_outcome: Record<string, number> };
  cost: { total_eur: number | null };
  funnel: { hypotheses_created: number };
  human_feedback: { subjects_reviewed: number; accepted: number; acceptance_rate: number | null };
  email: { sends: { in_window: number | null; today?: number } } | null | undefined;
}

/**
 * Sends of ONE local day (tanda 19 fix). `in_window` is the per-day count from `email_sends` over
 * [local midnight, next local midnight): right for every day of the backfill. It is null when the
 * summary had no window (GET /metrics/summary without since/until, which is what showed
 * `in_window: null` next to `today: 1`); then only the current local day has a per-day number,
 * `sends.today` (relative to `now`), and an older day is unknown -> 0.
 */
export function emailSendsOfDay(day: SummarySlice, date: string, today: string): number {
  const sends = day.email?.sends;
  if (!sends) return 0;
  if (typeof sends.in_window === 'number') return sends.in_window;
  return date === today ? (sends.today ?? 0) : 0;
}

export type SummaryFn = (w: { tenantId: string; since?: Date; until?: Date }) => Promise<SummarySlice>;

export const dayKeyOf = (tenantId: string, date: string) => `${tenantId}:${date}`;

/** `YYYY-MM-DD` plus `days` (may be negative), calendar arithmetic. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Offset (ms) of `timeZone` from UTC at instant `at`. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of 00:00 local time of `date` in `timeZone` (DST aware). */
export function localMidnight(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(new Date(guess), timeZone);
  t = guess - tzOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

export function localDayWindow(date: string, timeZone: string): { since: Date; until: Date } {
  return { since: localMidnight(date, timeZone), until: localMidnight(addDays(date, 1), timeZone) };
}

const STAGE: Record<WarmupStage, DailyMetricRecord['warmupStage']> = {
  before: 'BEFORE',
  warmup: 'WARMUP',
  post_warmup: 'POST_WARMUP',
};

/** Builds the record of one local day from two summaries (the day, and cumulative up to its end). */
export async function computeDailyMetric(
  summary: SummaryFn,
  o: { tenantId: string; date: string; timezone?: string; now?: Date },
): Promise<DailyMetricRecord> {
  const timezone = o.timezone ?? WARMUP_TIMEZONE;
  const { since, until } = localDayWindow(o.date, timezone);
  const [day, toDate] = await Promise.all([summary({ tenantId: o.tenantId, since, until }), summary({ tenantId: o.tenantId, until })]);
  // Noon of that local day: the warm-up calendar is per local date.
  const warm = warmupDay(new Date(since.getTime() + 12 * 3_600_000), timezone);
  const status = day.runs.by_status ?? {};
  const rate = toDate.human_feedback.acceptance_rate;
  return {
    name: `${o.date} · ${o.tenantId}`,
    day: o.date,
    dayKey: dayKeyOf(o.tenantId, o.date),
    tenantId: o.tenantId,
    runs: day.runs.total,
    runsSucceeded: day.runs.by_outcome?.SUCCESS ?? 0,
    runsFailed: (status.FAILED ?? 0) + (status.TIMED_OUT ?? 0),
    cost: { amountMicros: Math.round((day.cost.total_eur ?? 0) * 1_000_000), currencyCode: 'EUR' },
    hypothesesCreated: day.funnel.hypotheses_created,
    emailSends: emailSendsOfDay(day, o.date, localDate(o.now ?? new Date(), timezone)),
    warmupTarget: warm.target,
    warmupStage: STAGE[warm.stage],
    warmupPhase: warm.phase?.label ?? null,
    humanReviewed: day.human_feedback.subjects_reviewed,
    humanAccepted: day.human_feedback.accepted,
    acceptanceRate: rate === null ? null : Math.round(rate * 1000) / 10,
    syncedAt: (o.now ?? new Date()).toISOString(),
  };
}

/** Find by dayKey, then PATCH; POST when missing (a lost race is retried as PATCH). */
export async function upsertDailyMetric(twenty: TwentyClient, rec: DailyMetricRecord): Promise<'created' | 'updated'> {
  const find = async () =>
    (await twenty.list<{ id: string }>(DAILY_METRICS_OBJECT, { filter: `dayKey[eq]:${filterValue(rec.dayKey)}`, limit: 1 })).records[0];
  const existing = await find();
  if (existing) {
    await twenty.update(DAILY_METRICS_OBJECT, existing.id, { ...rec });
    return 'updated';
  }
  try {
    await twenty.create(DAILY_METRICS_OBJECT, { ...rec });
    return 'created';
  } catch (err) {
    if (!(err instanceof TwentyApiError) || err.code !== 'TWENTY_DUPLICATE') throw err;
    const again = await find();
    if (!again) throw err;
    await twenty.update(DAILY_METRICS_OBJECT, again.id, { ...rec });
    return 'updated';
  }
}

export interface SyncLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface TwentyMetricsSyncOptions {
  tenantId: string;
  /** Days synced per tick, today included (default 2: today and yesterday, to close the day). */
  days?: number;
  timezone?: string;
  logger?: SyncLogger;
  now?: () => Date;
  /** Defaults to the real `metricsSummary` over `db`. */
  summary?: SummaryFn;
  /** Counts the re-validations ready to run (PASS_FORM experiments with fresh labels); logged when it changes. */
  revalidations?: () => Promise<number>;
}

export interface SyncResult {
  ok: boolean;
  days: Array<{ date: string; result: 'created' | 'updated' }>;
  error?: { code: string; message: string };
  /** Re-validations ready to run (only with the `revalidations` probe; null if the count failed). */
  revalidations_ready?: number | null;
}

export class TwentyMetricsSync {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<SyncResult> | undefined;
  private lastErrorKey: string | undefined;
  private lastRevalidations: number | undefined;
  private readonly summary: SummaryFn;
  private readonly days: number;
  private readonly timezone: string;
  private readonly now: () => Date;

  constructor(
    db: Db | undefined,
    private readonly twenty: TwentyClient,
    private readonly opts: TwentyMetricsSyncOptions,
  ) {
    if (!opts.summary && !db) throw new Error('TwentyMetricsSync needs a db or a summary function');
    this.summary = opts.summary ?? ((w) => metricsSummary(db!, w) as Promise<SummarySlice>);
    this.days = Math.max(1, Math.floor(opts.days ?? 2));
    this.timezone = opts.timezone ?? WARMUP_TIMEZONE;
    this.now = opts.now ?? (() => new Date());
  }

  /** Dates synced on a tick, oldest first. */
  datesToSync(days = this.days): string[] {
    const today = localDate(this.now(), this.timezone);
    return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
  }

  /** One pass over the last `days` local days. Never throws; overlapping calls share one pass. */
  syncOnce(days = this.days): Promise<SyncResult> {
    this.running ??= this.run(days)
      .then((r) => this.withRevalidations(r))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** Adds the passive re-validation counter to a tick. Never throws. */
  private async withRevalidations(out: SyncResult): Promise<SyncResult> {
    if (!this.opts.revalidations) return out;
    let n: number | null;
    try {
      n = await this.opts.revalidations();
    } catch (err) {
      this.opts.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'revalidation counter failed');
      return { ...out, revalidations_ready: null };
    }
    if (n !== this.lastRevalidations && (n > 0 || this.lastRevalidations !== undefined)) {
      this.opts.logger?.info({ revalidations_ready: n }, `revalidaciones disponibles: ${n} (GET /experiments/pending-revalidation)`);
    }
    this.lastRevalidations = n;
    return { ...out, revalidations_ready: n };
  }

  private async run(days: number): Promise<SyncResult> {
    const out: SyncResult = { ok: true, days: [] };
    if (!this.twenty.isConfigured()) return this.fail(out, 'TWENTY_NOT_CONFIGURED', 'TWENTY_API_KEY is not set');
    try {
      for (const date of this.datesToSync(days)) {
        const rec = await computeDailyMetric(this.summary, { tenantId: this.opts.tenantId, date, timezone: this.timezone, now: this.now() });
        out.days.push({ date, result: await upsertDailyMetric(this.twenty, rec) });
      }
    } catch (err) {
      const code = err instanceof TwentyApiError ? err.code : 'METRICS_SYNC_ERROR';
      return this.fail(out, code, err instanceof Error ? err.message : String(err));
    }
    if (this.lastErrorKey) this.opts.logger?.info({ days: out.days.length }, 'metrics sync to Twenty recovered');
    this.lastErrorKey = undefined;
    return out;
  }

  private fail(out: SyncResult, code: string, message: string): SyncResult {
    const hint =
      code === 'TWENTY_NOT_FOUND' || code === 'TWENTY_BAD_REQUEST'
        ? ' (is the Twenty App synced? it declares the agentOsDailyMetric object)'
        : '';
    const key = `${code}:${message}`;
    if (key !== this.lastErrorKey) this.opts.logger?.warn({ code, synced: out.days.length }, `metrics sync to Twenty failed: ${message}${hint}`);
    this.lastErrorKey = key;
    return { ...out, ok: false, error: { code, message } };
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    void this.syncOnce();
    this.timer = setInterval(() => void this.syncOnce(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}

export interface MetricsSyncSettings {
  enabled: boolean;
  intervalMs: number;
  days: number;
}

/** METRICS_TWENTY_SYNC_ENABLED (default false), _INTERVAL_MS (default 15 min, min 60 s), _DAYS (default 2, 1-62). */
export function metricsSyncSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): MetricsSyncSettings {
  const enabled = /^(1|true|yes|on)$/i.test((env.METRICS_TWENTY_SYNC_ENABLED ?? '').trim());
  const interval = Number(env.METRICS_TWENTY_SYNC_INTERVAL_MS);
  const days = Number(env.METRICS_TWENTY_SYNC_DAYS);
  return {
    enabled,
    intervalMs: Number.isFinite(interval) && interval > 0 ? Math.max(60_000, Math.floor(interval)) : 900_000,
    days: Number.isFinite(days) && days >= 1 ? Math.min(62, Math.floor(days)) : 2,
  };
}
