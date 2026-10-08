/**
 * Scheduled trace archive (LLD v0.1 section 22): the same `archiveTraces()` as
 * `pnpm traces:archive` (export -> verify -> lighten, never delete), run by the scheduler role
 * every TRACE_ARCHIVE_INTERVAL_MS (default 24 h) when TRACE_ARCHIVE_ENABLED=true (default
 * false: a human turns it on in the compose). Same pattern as the metrics sync to Twenty
 * (src/metrics/twenty-sync.ts): an in-process timer, no agent task, no database scheduler.
 *
 * - The first pass runs `initialDelayMs` after the start (default 1 min: a restart every few
 *   hours would otherwise never reach the 24 h tick), then every interval.
 * - Overlap: a tick that finds the previous pass still running is skipped with a log line (the
 *   metrics sync shares the running pass instead; archiving twice in a row adds nothing).
 * - A pass that lightened steps (> 0) writes one `audit_log` row `traces.archive` (actor
 *   `system`, method `JOB`, route `job:trace-archive`) with the counts and the files. A pass
 *   with nothing to archive writes no audit row (log only). A failed pass that had already
 *   lightened steps is audited as `error` with what it did; one that had not, log only.
 * - Never throws: a failure is logged and the next tick tries again.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import { archiveTraces, partialArchiveReport, type ArchiveOptions, type ArchiveReport } from './trace-archive.js';

export const TRACE_ARCHIVE_AUDIT_ACTION = 'traces.archive';
export const TRACE_ARCHIVE_JOB_ROUTE = 'job:trace-archive';
export const DEFAULT_TRACE_ARCHIVE_INTERVAL_MS = 86_400_000;
export const MIN_TRACE_ARCHIVE_INTERVAL_MS = 60_000;
export const DEFAULT_TRACE_ARCHIVE_INITIAL_DELAY_MS = 60_000;

export interface TraceArchiveSettings {
  enabled: boolean;
  intervalMs: number;
}

/** TRACE_ARCHIVE_ENABLED (default false) and TRACE_ARCHIVE_INTERVAL_MS (default 24 h, minimum 60 s). */
export function traceArchiveSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): TraceArchiveSettings {
  const enabled = /^(1|true|yes|on)$/i.test((env.TRACE_ARCHIVE_ENABLED ?? '').trim());
  const interval = Number(env.TRACE_ARCHIVE_INTERVAL_MS);
  return {
    enabled,
    intervalMs: Number.isFinite(interval) && interval > 0 ? Math.max(MIN_TRACE_ARCHIVE_INTERVAL_MS, Math.floor(interval)) : DEFAULT_TRACE_ARCHIVE_INTERVAL_MS,
  };
}

interface JobLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface TraceArchiveJobOptions {
  /** TRACE_RETENTION_DAYS. */
  olderThanDays: number;
  /** TRACE_ARCHIVE_DIR. */
  archiveDir: string;
  /** Tenant of the audit row when the job covers every tenant (the runtime's default tenant). */
  auditTenantId: string;
  /** Only this tenant's traces (default: every tenant, like the CLI without --tenant). */
  tenantId?: string | undefined;
  minBytes?: number | undefined;
  batchSize?: number | undefined;
  logger?: JobLogger | undefined;
  /** Injectable for tests. */
  archive?: (db: Db, opts: ArchiveOptions) => Promise<ArchiveReport>;
  audit?: (db: Db, row: AuditInsert) => Promise<unknown>;
  now?: () => Date;
}

export type TraceArchivePass =
  | { status: 'skipped'; reason: 'overlap' }
  | { status: 'done'; pass_id: string; report: ArchiveReport; audited: boolean; duration_ms: number }
  | { status: 'failed'; pass_id: string; error: string; report: ArchiveReport | null; audited: boolean; duration_ms: number };

/** Counts and files of a pass, as stored in the audit row (pure). */
export function archiveAuditPayload(report: ArchiveReport, olderThanDays: number): Record<string, unknown> {
  return {
    cutoff: report.cutoff,
    older_than_days: olderThanDays,
    archive_dir: report.archive_dir,
    min_bytes: report.min_bytes,
    steps_lightened: report.steps_lightened,
    fields_lightened: report.fields_lightened,
    bytes_lightened: report.bytes_lightened,
    steps_skipped: report.steps_skipped,
    fields_unrepresentable: report.fields_unrepresentable,
    tenants: [...new Set(report.files.map((f) => f.tenant))].sort(),
    files: report.files.map((f) => ({ file: f.file, tenant: f.tenant, month: f.month, lines: f.lines, gz_bytes: f.gz_bytes, sha256: f.sha256, steps_lightened: f.steps_lightened, steps_skipped: f.steps_skipped })),
  };
}

export class TraceArchiveJob {
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;
  private running: Promise<TraceArchivePass> | undefined;
  private readonly archive: (db: Db, opts: ArchiveOptions) => Promise<ArchiveReport>;
  private readonly audit: (db: Db, row: AuditInsert) => Promise<unknown>;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly opts: TraceArchiveJobOptions,
  ) {
    if (!(opts.olderThanDays >= 0)) throw new Error('olderThanDays must be >= 0');
    this.archive = opts.archive ?? archiveTraces;
    this.audit = opts.audit ?? recordAudit;
    this.now = opts.now ?? (() => new Date());
  }

  /** True while a pass runs. */
  get busy(): boolean {
    return this.running !== undefined;
  }

  /** One pass. A call while another pass runs is skipped (logged), not queued. Never throws. */
  runOnce(): Promise<TraceArchivePass> {
    if (this.running) {
      this.opts.logger?.warn({ job: TRACE_ARCHIVE_JOB_ROUTE }, 'trace archive: the previous pass is still running, this tick is skipped');
      return Promise.resolve({ status: 'skipped', reason: 'overlap' });
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<TraceArchivePass> {
    const passId = randomUUID();
    const started = Date.now();
    const log = this.opts.logger;
    let report: ArchiveReport | null = null;
    let error: unknown = null;
    try {
      report = await this.archive(this.db, {
        olderThanDays: this.opts.olderThanDays,
        archiveDir: this.opts.archiveDir,
        tenantId: this.opts.tenantId,
        minBytes: this.opts.minBytes,
        batchSize: this.opts.batchSize,
        now: this.now(),
      });
    } catch (err) {
      error = err;
      report = partialArchiveReport(err);
    }
    const duration = Date.now() - started;
    const message = error === null ? null : error instanceof Error ? error.message : String(error);
    const worked = (report?.steps_lightened ?? 0) > 0;
    const summary = report
      ? { pass_id: passId, files: report.files.length, steps_lightened: report.steps_lightened, fields_lightened: report.fields_lightened, bytes_lightened: report.bytes_lightened, steps_skipped: report.steps_skipped, fields_unrepresentable: report.fields_unrepresentable, cutoff: report.cutoff, duration_ms: duration }
      : { pass_id: passId, duration_ms: duration };

    if (error !== null) log?.error({ ...summary, err: message }, 'trace archive pass failed (nothing is deleted; the next tick retries)');
    else if (worked) log?.info(summary, `trace archive: ${report!.steps_lightened} steps lightened in ${report!.files.length} verified file(s)`);
    else log?.info(summary, 'trace archive: nothing to archive');

    let audited = false;
    if (worked && report) {
      try {
        await this.audit(this.db, {
          tenantId: this.opts.tenantId ?? this.opts.auditTenantId,
          actor: 'system',
          actorLabel: 'trace-archive',
          action: TRACE_ARCHIVE_AUDIT_ACTION,
          subjectType: 'traces',
          subjectId: this.opts.tenantId ?? null,
          method: 'JOB',
          route: TRACE_ARCHIVE_JOB_ROUTE,
          requestId: passId,
          payload: archiveAuditPayload(report, this.opts.olderThanDays),
          result: error === null ? 'ok' : 'error',
          statusCode: error === null ? 200 : 500,
          errorCode: error === null ? null : error instanceof Error ? error.name : 'Error',
          details: { duration_ms: duration, ...(message ? { message: message.slice(0, 500) } : {}) },
        });
        audited = true;
      } catch (err) {
        log?.error({ pass_id: passId, err: err instanceof Error ? err.message : String(err) }, 'trace archive: audit_log insert failed (the archive itself is not affected)');
      }
    }
    return error === null
      ? { status: 'done', pass_id: passId, report: report!, audited, duration_ms: duration }
      : { status: 'failed', pass_id: passId, error: message!, report, audited, duration_ms: duration };
  }

  /** First pass after `initialDelayMs`, then one every `intervalMs`. Idempotent. */
  start(intervalMs: number, initialDelayMs = DEFAULT_TRACE_ARCHIVE_INITIAL_DELAY_MS): void {
    if (this.timer || this.firstTimer) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      void this.runOnce();
      this.timer = setInterval(() => void this.runOnce(), intervalMs);
      this.timer.unref?.();
    }, Math.max(0, initialDelayMs));
    this.firstTimer.unref?.();
  }

  /** Stops the timers and waits for a running pass (it is never interrupted half-way). */
  async stop(): Promise<void> {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = undefined;
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
