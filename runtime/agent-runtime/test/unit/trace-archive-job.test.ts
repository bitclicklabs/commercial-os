/**
 * Scheduled trace archive (src/maintenance/trace-archive-job.ts) without a database: the
 * enabled flag and the interval from the environment, the overlap skip, the audit row only
 * when a pass lightened steps (also a failed pass that had), never throwing, and the timers.
 * The real pass against PostgreSQL is in test/integration/trace-archive-job.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditInsert } from '../../src/audit/service.js';
import type { Db } from '../../src/db/client.js';
import { archiveAuditPayload, DEFAULT_TRACE_ARCHIVE_INTERVAL_MS, TraceArchiveJob, traceArchiveSettingsFromEnv } from '../../src/maintenance/trace-archive-job.js';
import { partialArchiveReport, type ArchiveOptions, type ArchiveReport } from '../../src/maintenance/trace-archive.js';

const db = {} as Db;

function report(steps: number, o: Partial<ArchiveReport> = {}): ArchiveReport {
  return {
    cutoff: '2026-07-10T00:00:00.000Z',
    archive_dir: '/data/trace-archive',
    dry_run: false,
    min_bytes: 4096,
    files:
      steps > 0
        ? [{ file: 'publiexpe/2026-06.jsonl.gz', tenant: 'publiexpe', month: '2026-06', lines: steps, gz_bytes: 1234, sha256: 'a'.repeat(64), verified: true, steps_lightened: steps, steps_skipped: 0 }]
        : [],
    steps_lightened: steps,
    fields_lightened: steps * 2,
    bytes_lightened: steps * 10_000,
    steps_skipped: 0,
    fields_unrepresentable: 0,
    candidates: [],
    ...o,
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function job(archive: (db: Db, o: ArchiveOptions) => Promise<ArchiveReport>, extra: { audit?: (db: Db, row: AuditInsert) => Promise<unknown>; tenantId?: string } = {}) {
  const audits: AuditInsert[] = [];
  const log = logger();
  const j = new TraceArchiveJob(db, {
    olderThanDays: 90,
    archiveDir: '/data/trace-archive',
    auditTenantId: 'publiexpe',
    tenantId: extra.tenantId,
    logger: log,
    archive,
    audit:
      extra.audit ??
      (async (_db, row) => {
        audits.push(row);
        return row;
      }),
  });
  return { j, audits, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('traceArchiveSettingsFromEnv', () => {
  it('off by default, 24 h by default', () => {
    expect(traceArchiveSettingsFromEnv({})).toEqual({ enabled: false, intervalMs: DEFAULT_TRACE_ARCHIVE_INTERVAL_MS });
    expect(DEFAULT_TRACE_ARCHIVE_INTERVAL_MS).toBe(86_400_000);
  });

  it('TRACE_ARCHIVE_ENABLED true/1/yes/on turns it on; anything else keeps it off', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) expect(traceArchiveSettingsFromEnv({ TRACE_ARCHIVE_ENABLED: v }).enabled).toBe(true);
    for (const v of ['false', '0', '', 'no', 'si']) expect(traceArchiveSettingsFromEnv({ TRACE_ARCHIVE_ENABLED: v }).enabled).toBe(false);
  });

  it('TRACE_ARCHIVE_INTERVAL_MS: minimum 60 s, invalid -> default', () => {
    expect(traceArchiveSettingsFromEnv({ TRACE_ARCHIVE_INTERVAL_MS: '3600000' }).intervalMs).toBe(3_600_000);
    expect(traceArchiveSettingsFromEnv({ TRACE_ARCHIVE_INTERVAL_MS: '1000' }).intervalMs).toBe(60_000);
    expect(traceArchiveSettingsFromEnv({ TRACE_ARCHIVE_INTERVAL_MS: 'abc' }).intervalMs).toBe(DEFAULT_TRACE_ARCHIVE_INTERVAL_MS);
    expect(traceArchiveSettingsFromEnv({ TRACE_ARCHIVE_INTERVAL_MS: '-5' }).intervalMs).toBe(DEFAULT_TRACE_ARCHIVE_INTERVAL_MS);
  });
});

describe('TraceArchiveJob pass', () => {
  it('passes the retention settings to archiveTraces', async () => {
    const archive = vi.fn(async () => report(0));
    const { j } = job(archive, { tenantId: 'acme' });
    await j.runOnce();
    expect(archive).toHaveBeenCalledWith(db, expect.objectContaining({ olderThanDays: 90, archiveDir: '/data/trace-archive', tenantId: 'acme' }));
  });

  it('a pass that lightened steps writes one audit row traces.archive (system, JOB, job:trace-archive) with counts and files', async () => {
    const { j, audits, log } = job(async () => report(3));
    const r = await j.runOnce();
    expect(r).toMatchObject({ status: 'done', audited: true, report: { steps_lightened: 3 } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: 'publiexpe',
      actor: 'system',
      actorLabel: 'trace-archive',
      action: 'traces.archive',
      subjectType: 'traces',
      method: 'JOB',
      route: 'job:trace-archive',
      result: 'ok',
      statusCode: 200,
      errorCode: null,
      payload: {
        older_than_days: 90,
        steps_lightened: 3,
        fields_lightened: 6,
        bytes_lightened: 30_000,
        tenants: ['publiexpe'],
        files: [{ file: 'publiexpe/2026-06.jsonl.gz', lines: 3, sha256: 'a'.repeat(64), steps_lightened: 3 }],
      },
    });
    expect(audits[0]!.requestId).toBe((r as { pass_id: string }).pass_id);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ steps_lightened: 3 }), expect.stringMatching(/3 steps lightened/));
  });

  it('a pass with nothing to archive writes no audit row, only a log line', async () => {
    const { j, audits, log } = job(async () => report(0));
    expect(await j.runOnce()).toMatchObject({ status: 'done', audited: false });
    expect(audits).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.anything(), 'trace archive: nothing to archive');
  });

  it('the audit tenant is the job tenant when it is restricted to one', async () => {
    const { j, audits } = job(async () => report(1), { tenantId: 'acme' });
    await j.runOnce();
    expect(audits[0]).toMatchObject({ tenantId: 'acme', subjectId: 'acme' });
  });

  it('a failure after lightening steps is audited as error with what was done; without work, log only; never throws', async () => {
    const boom = Object.assign(new Error('archive x failed verification'), {});
    Object.defineProperty(boom, 'archiveReport', { value: report(2), enumerable: false });
    expect(partialArchiveReport(boom)).toMatchObject({ steps_lightened: 2 });
    const a = job(async () => {
      throw boom;
    });
    const r = await a.j.runOnce();
    expect(r).toMatchObject({ status: 'failed', error: 'archive x failed verification', audited: true, report: { steps_lightened: 2 } });
    expect(a.audits[0]).toMatchObject({ result: 'error', statusCode: 500, errorCode: 'Error', payload: { steps_lightened: 2 }, details: { message: 'archive x failed verification' } });
    expect(a.log.error).toHaveBeenCalled();

    const b = job(async () => {
      throw new Error('database down');
    });
    expect(await b.j.runOnce()).toMatchObject({ status: 'failed', error: 'database down', audited: false, report: null });
    expect(b.audits).toHaveLength(0);
  });

  it('an audit insert failure is logged and does not fail the pass', async () => {
    const { j, log } = job(async () => report(1), {
      audit: async () => {
        throw new Error('audit_log down');
      },
    });
    expect(await j.runOnce()).toMatchObject({ status: 'done', audited: false });
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'audit_log down' }), expect.stringMatching(/audit_log insert failed/));
  });

  it('overlap: a call while a pass runs is skipped with a log line (not queued); the next one runs', async () => {
    let release!: () => void;
    const archive = vi.fn(
      () =>
        new Promise<ArchiveReport>((resolve) => {
          release = () => resolve(report(1));
        }),
    );
    const { j, audits, log } = job(archive);
    const first = j.runOnce();
    expect(j.busy).toBe(true);
    expect(await j.runOnce()).toEqual({ status: 'skipped', reason: 'overlap' });
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/still running, this tick is skipped/));
    expect(archive).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ status: 'done', audited: true });
    expect(j.busy).toBe(false);
    archive.mockImplementation(async () => report(0));
    expect(await j.runOnce()).toMatchObject({ status: 'done' });
    expect(archive).toHaveBeenCalledTimes(2);
    expect(audits).toHaveLength(1);
  });

  it('archiveAuditPayload lists the tenants of the files', () => {
    const r = report(1);
    r.files.push({ ...r.files[0]!, tenant: 'acme', file: 'acme/2026-06.jsonl.gz' });
    expect(archiveAuditPayload(r, 30)).toMatchObject({ older_than_days: 30, tenants: ['acme', 'publiexpe'] });
  });
});

describe('TraceArchiveJob timers', () => {
  it('first pass after the initial delay, then every interval; a tick during a long pass is skipped; stop waits for the pass', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const archive = vi.fn(
      () =>
        new Promise<ArchiveReport>((resolve) => {
          release = () => resolve(report(0));
        }),
    );
    const { j, log } = job(archive);
    j.start(60_000, 5_000);
    j.start(60_000, 5_000); // idempotent
    await vi.advanceTimersByTimeAsync(4_999);
    expect(archive).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(archive).toHaveBeenCalledTimes(1);
    // The pass is still running when the interval fires: skipped.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(archive).toHaveBeenCalledTimes(2);
    const stopped = j.stop();
    release!();
    await stopped;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(archive).toHaveBeenCalledTimes(2);
  });
});
