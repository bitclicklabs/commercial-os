/**
 * Scheduled Skill Optimizer (src/optimizer/schedule-job.ts) without a database: settings from
 * the environment (off by default), the cron window in Europe/Madrid across both DST changes,
 * at most one fire per window (also after a simulated restart: a new job over the same store),
 * the catch-up limit, configurable skills, the skip with an open run (no ERROR, no audit), the
 * audit row only on a real enqueue, failures that never throw, and the timers.
 * The real fire against PostgreSQL is in test/integration/optimizer-schedule.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditInsert } from '../../src/audit/service.js';
import type { OptimizationRun, OptimizationRunStatus } from '../../src/db/schema.js';
import {
  cronWindow,
  DEFAULT_OPTIMIZER_SCHEDULE_CRON,
  OPTIMIZER_SCHEDULE_ACTOR,
  OPTIMIZER_SCHEDULE_AUDIT_ACTION,
  OPTIMIZER_SCHEDULE_JOB_ROUTE,
  OptimizerLaunchError,
  OptimizerScheduleJob,
  optimizerScheduleSettingsFromEnv,
  OptimizerServiceError,
  type FiredRun,
  type OptimizerScheduleSettings,
  type OptimizerScheduleStore,
} from '../../src/optimizer/index.js';

const MADRID = 'Europe/Madrid';
const PROSPECTOR = 'prospector-event-exhibitors';

function settings(o: Partial<OptimizerScheduleSettings> = {}): OptimizerScheduleSettings {
  return { enabled: true, cron: DEFAULT_OPTIMIZER_SCHEDULE_CRON, timezone: MADRID, skills: [PROSPECTOR], errors: [], ...o };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** In-memory optimization_runs: survives "restarts" (a new job over the same store). */
class FakeStore implements OptimizerScheduleStore {
  runs: Array<FiredRun & { skill: string; tenantId: string }> = [];
  audits: AuditInsert[] = [];
  launches = 0;
  firedCalls = 0;
  clock: () => Date = () => new Date();
  launchError: Error | null = null;
  auditError: Error | null = null;
  firedError: Error | null = null;

  async firedRun(tenantId: string, skill: string, since: Date): Promise<FiredRun | null> {
    this.firedCalls++;
    if (this.firedError) throw this.firedError;
    const open: OptimizationRunStatus[] = ['PENDING', 'HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING'];
    const hit = this.runs
      .filter((r) => r.tenantId === tenantId && r.skill === skill && (open.includes(r.status) || r.createdAt.getTime() >= since.getTime()))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return hit ?? null;
  }

  async launch(tenantId: string, skill: string): Promise<OptimizationRun> {
    this.launches++;
    if (this.launchError) throw this.launchError;
    const id = `run-${this.runs.length + 1}`;
    // The worker ends a run without data as BLOCKED_NO_DATA (closed, not open).
    this.runs.push({ id, status: 'BLOCKED_NO_DATA', createdAt: this.clock(), createdBy: OPTIMIZER_SCHEDULE_ACTOR, skill, tenantId });
    return { id, baseVersion: 1, skillName: skill, tenantId } as OptimizationRun;
  }

  async audit(row: AuditInsert): Promise<unknown> {
    if (this.auditError) throw this.auditError;
    this.audits.push(row);
    return row;
  }
}

function job(store: FakeStore, at: { now: Date }, o: Partial<OptimizerScheduleSettings> = {}, extra: { catchUpMs?: number } = {}) {
  const log = logger();
  store.clock = () => at.now;
  const j = new OptimizerScheduleJob({ settings: settings(o), tenantId: 'publiexpe', store, logger: log, now: () => at.now, ...extra });
  return { j, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('optimizer schedule: settings', () => {
  it('off by default; Wednesday 09:00 in Europe/Madrid; the Prospector skill', () => {
    const s = optimizerScheduleSettingsFromEnv({});
    expect(s).toEqual({ enabled: false, cron: '0 9 * * 3', timezone: 'Europe/Madrid', skills: ['prospector-event-exhibitors'], errors: [] });
  });

  it('flag, cron and skills from the environment (comma separated, deduplicated)', () => {
    const s = optimizerScheduleSettingsFromEnv({ OPTIMIZER_SCHEDULE_ENABLED: 'true', OPTIMIZER_SCHEDULE_CRON: ' 30 8 * * 4 ', OPTIMIZER_SCHEDULE_SKILLS: ' prospector-event-exhibitors , prospector-event-exhibitors,' });
    expect(s).toMatchObject({ enabled: true, cron: '30 8 * * 4', skills: ['prospector-event-exhibitors'], errors: [] });
    expect(optimizerScheduleSettingsFromEnv({ OPTIMIZER_SCHEDULE_ENABLED: 'yes' }).enabled).toBe(true);
    expect(optimizerScheduleSettingsFromEnv({ OPTIMIZER_SCHEDULE_ENABLED: 'no' }).enabled).toBe(false);
  });

  it('an invalid cron or a skill without optimizer is a configuration error (the job does not start)', () => {
    const s = optimizerScheduleSettingsFromEnv({ OPTIMIZER_SCHEDULE_ENABLED: 'true', OPTIMIZER_SCHEDULE_CRON: '61 9 * * 3', OPTIMIZER_SCHEDULE_SKILLS: 'email-drafter,Not_Kebab' });
    expect(s.errors).toHaveLength(3);
    expect(s.errors.join('\n')).toMatch(/OPTIMIZER_SCHEDULE_CRON/);
    expect(s.errors.join('\n')).toMatch(/no hay optimizador para "email-drafter"/);
    expect(s.errors.join('\n')).toMatch(/"Not_Kebab" no es un nombre de skill/);
    expect(new OptimizerScheduleJob({ settings: s, tenantId: 't', store: new FakeStore() }).active).toBe(false);
  });
});

describe('optimizer schedule: cron window in Europe/Madrid', () => {
  it('Wednesday 09:00 is 07:00Z in summer (CEST) and 08:00Z in winter (CET)', () => {
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-10-07T10:00:00Z'))).toEqual({ start: new Date('2026-10-07T07:00:00Z'), next: new Date('2026-10-14T07:00:00Z') });
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-12-02T10:00:00Z'))).toEqual({ start: new Date('2026-12-02T08:00:00Z'), next: new Date('2026-12-09T08:00:00Z') });
  });

  it('across the spring change (29/03/2026): from 08:00Z to 07:00Z, the window still one week long', () => {
    const before = cronWindow('0 9 * * 3', MADRID, new Date('2026-03-28T12:00:00Z'));
    expect(before).toEqual({ start: new Date('2026-03-25T08:00:00Z'), next: new Date('2026-04-01T07:00:00Z') });
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-04-01T07:00:30Z')).start).toEqual(new Date('2026-04-01T07:00:00Z'));
    // 06:59Z on 1 April is 08:59 CEST: still the previous window.
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-04-01T06:59:00Z')).start).toEqual(new Date('2026-03-25T08:00:00Z'));
  });

  it('across the autumn change (25/10/2026): from 07:00Z to 08:00Z', () => {
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-10-26T12:00:00Z'))).toEqual({ start: new Date('2026-10-21T07:00:00Z'), next: new Date('2026-10-28T08:00:00Z') });
    // 07:30Z on 28 October is 08:30 CET: not fired yet.
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-10-28T07:30:00Z')).start).toEqual(new Date('2026-10-21T07:00:00Z'));
  });

  it('a time that does not exist (02:30 on the spring change) fires once, at 03:30 CEST; one that happens twice fires once', () => {
    expect(cronWindow('30 2 * * *', MADRID, new Date('2026-03-29T12:00:00Z')).start).toEqual(new Date('2026-03-29T01:30:00Z'));
    const fall = cronWindow('30 2 * * *', MADRID, new Date('2026-10-25T00:45:00Z'));
    expect(fall.start).toEqual(new Date('2026-10-25T00:30:00Z'));
    expect(fall.next).toEqual(new Date('2026-10-26T01:30:00Z'));
  });

  it('the window always matches the fire times of the scheduler (next()), hour by hour across both changes', () => {
    for (const cron of ['30 2 * * *', '0 3 * * *', '0 9 * * 3']) {
      for (const [from, to] of [['2026-03-27T00:00:00Z', '2026-04-02T00:00:00Z'], ['2026-10-23T00:00:00Z', '2026-10-29T00:00:00Z']] as const) {
        for (let t = new Date(from).getTime(); t < new Date(to).getTime(); t += 1_800_000) {
          const w = cronWindow(cron, MADRID, new Date(t));
          expect(w.start.getTime()).toBeLessThanOrEqual(t);
          expect(w.next.getTime()).toBeGreaterThan(t);
          // `next` of the window start is the window's own `next`: no fire time in between.
          expect(cronWindow(cron, MADRID, w.start).next).toEqual(w.next);
        }
      }
    }
  });

  it('a tick exactly on the fire time belongs to the new window', () => {
    expect(cronWindow('0 9 * * 3', MADRID, new Date('2026-10-07T07:00:00.000Z')).start).toEqual(new Date('2026-10-07T07:00:00Z'));
  });
});

describe('optimizer schedule: the job', () => {
  it('flag off: no tick does anything (no store call, no audit)', async () => {
    const store = new FakeStore();
    const at = { now: new Date('2026-10-07T07:01:00Z') };
    const { j } = job(store, at, { enabled: false });
    expect(j.active).toBe(false);
    for (let i = 0; i < 5; i++) expect(await j.tick()).toEqual({ status: 'disabled' });
    expect(store.firedCalls + store.launches + store.audits.length).toBe(0);
    vi.useFakeTimers();
    const spy = vi.spyOn(j, 'tick');
    j.start(60_000, 0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires once per window: later ticks in the window do nothing, the next window fires again', async () => {
    const store = new FakeStore();
    const at = { now: new Date('2026-10-07T07:01:00Z') }; // Wed 09:01 CEST
    const { j, log } = job(store, at);
    const first = await j.tick();
    expect(first).toMatchObject({ status: 'checked', skills: [{ skill: PROSPECTOR, outcome: 'fired', runId: 'run-1', audited: true }] });
    for (const t of ['2026-10-07T07:02:00Z', '2026-10-07T11:00:00Z', '2026-10-13T20:00:00Z']) {
      at.now = new Date(t);
      expect((await j.tick()).status).toBe('idle');
    }
    expect(store.launches).toBe(1);
    expect(store.firedCalls).toBe(1); // the database is read once per window and skill
    at.now = new Date('2026-10-14T07:00:30Z');
    expect(await j.tick()).toMatchObject({ status: 'checked', skills: [{ outcome: 'fired', runId: 'run-2' }] });
    expect(store.audits).toHaveLength(2);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'run-1', skill: PROSPECTOR }), expect.stringMatching(/run enqueued/));
  });

  it('a restart in the same window does not fire again (the run in optimization_runs answers), even with the run already closed', async () => {
    const store = new FakeStore();
    const at = { now: new Date('2026-10-07T07:01:00Z') };
    await job(store, at).j.tick();
    expect(store.runs[0]!.status).toBe('BLOCKED_NO_DATA');
    // Process restarted at 09:30: new job, empty memory, same database.
    at.now = new Date('2026-10-07T07:30:00Z');
    const { j: restarted, log } = job(store, at);
    expect(await restarted.tick()).toMatchObject({ status: 'checked', skills: [{ outcome: 'already_fired', runId: 'run-1', status: 'BLOCKED_NO_DATA', open: false }] });
    expect(store.launches).toBe(1);
    expect(store.audits).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/already has a run in this window/));
    at.now = new Date('2026-10-07T07:31:00Z');
    expect((await restarted.tick()).status).toBe('idle');
  });

  it('a process that was down at 09:00 fires late within the catch-up limit, not after it', async () => {
    const store = new FakeStore();
    const at = { now: new Date('2026-10-07T15:00:00Z') }; // 8 h late
    expect(await job(store, at).j.tick()).toMatchObject({ status: 'checked', skills: [{ outcome: 'fired' }] });
    const other = new FakeStore();
    at.now = new Date('2026-10-09T10:00:00Z'); // turned on on Friday: Wednesday is too old
    const { j, log } = job(other, at);
    expect((await j.tick()).status).toBe('missed');
    expect((await j.tick()).status).toBe('idle');
    expect(other.launches + other.firedCalls).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ next_fire: '2026-10-14T07:00:00.000Z' }), expect.stringMatching(/too old/));
    expect((await job(new FakeStore(), at, {}, { catchUpMs: 3 * 86_400_000 }).j.tick()).status).toBe('checked');
  });

  it('an open run of the skill (e.g. a manual one in progress): skipped with an INFO log, no launch, no audit, no ERROR', async () => {
    const store = new FakeStore();
    store.runs.push({ id: 'manual', status: 'EXPERIMENT_RUNNING', createdAt: new Date('2026-10-06T10:00:00Z'), createdBy: 'jesus', skill: PROSPECTOR, tenantId: 'publiexpe' });
    const at = { now: new Date('2026-10-07T07:01:00Z') };
    const { j, log } = job(store, at);
    expect(await j.tick()).toMatchObject({ status: 'checked', skills: [{ outcome: 'already_fired', runId: 'manual', open: true }] });
    expect(store.launches).toBe(0);
    expect(store.audits).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'manual' }), expect.stringMatching(/already has an open run, skipped/));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a run closed before the window does not count: the window fires', async () => {
    const store = new FakeStore();
    store.runs.push({ id: 'old', status: 'BLOCKED_NO_DATA', createdAt: new Date('2026-09-30T07:00:10Z'), createdBy: OPTIMIZER_SCHEDULE_ACTOR, skill: PROSPECTOR, tenantId: 'publiexpe' });
    expect(await job(store, { now: new Date('2026-10-07T07:01:00Z') }).j.tick()).toMatchObject({ skills: [{ outcome: 'fired' }] });
  });

  it('the race lost against another process (open-run unique index): conflict, logged as skipped, not retried', async () => {
    const store = new FakeStore();
    store.launchError = new OptimizerServiceError('conflict', 'la skill ya tiene un run en curso', { run: { id: 'x', status: 'PENDING' } });
    const at = { now: new Date('2026-10-07T07:01:00Z') };
    const { j, log } = job(store, at);
    expect(await j.tick()).toMatchObject({ skills: [{ outcome: 'conflict' }] });
    expect(log.error).not.toHaveBeenCalled();
    expect(store.audits).toHaveLength(0);
    at.now = new Date('2026-10-07T07:02:00Z');
    expect((await j.tick()).status).toBe('idle');
  });

  it('configurable skills: one fire (and one audit row) per skill', async () => {
    const store = new FakeStore();
    const { j } = job(store, { now: new Date('2026-10-07T07:01:00Z') }, { skills: [PROSPECTOR, 'otra-skill'] });
    const tick = await j.tick();
    expect(tick).toMatchObject({ status: 'checked', skills: [{ skill: PROSPECTOR, outcome: 'fired' }, { skill: 'otra-skill', outcome: 'fired' }] });
    expect(store.audits.map((a) => a.subjectId)).toEqual([PROSPECTOR, 'otra-skill']);
  });

  it('the audit row of a real enqueue: system / JOB / job:optimizer-schedule, skill and run id', async () => {
    const store = new FakeStore();
    await job(store, { now: new Date('2026-10-07T07:01:00Z') }).j.tick();
    expect(store.audits[0]).toMatchObject({
      tenantId: 'publiexpe',
      actor: 'system',
      actorLabel: OPTIMIZER_SCHEDULE_ACTOR,
      action: OPTIMIZER_SCHEDULE_AUDIT_ACTION,
      subjectType: 'skill',
      subjectId: PROSPECTOR,
      subjectVersion: 1,
      method: 'JOB',
      route: OPTIMIZER_SCHEDULE_JOB_ROUTE,
      result: 'ok',
      statusCode: 202,
      payload: { skill: PROSPECTOR, run_id: 'run-1', base_version: 1, cron: '0 9 * * 3', timezone: MADRID, window_start: '2026-10-07T07:00:00.000Z' },
    });
  });

  it('never throws: launch errors are logged (not retried in the window), a store failure is retried on the next tick, an audit failure keeps the run', async () => {
    const store = new FakeStore();
    store.launchError = new OptimizerLaunchError('no_active_version', 'sin versión ACTIVE');
    const at = { now: new Date('2026-10-07T07:01:00Z') };
    const { j, log } = job(store, at);
    expect(await j.tick()).toMatchObject({ skills: [{ outcome: 'not_launched', code: 'no_active_version' }] });
    expect(log.warn).toHaveBeenCalled();
    at.now = new Date('2026-10-07T07:02:00Z');
    expect((await j.tick()).status).toBe('idle');

    const flaky = new FakeStore();
    flaky.firedError = new Error('connection refused');
    const at2 = { now: new Date('2026-10-07T07:01:00Z') };
    const { j: j2, log: log2 } = job(flaky, at2);
    expect(await j2.tick()).toMatchObject({ skills: [{ outcome: 'error', error: 'connection refused' }] });
    expect(log2.error).toHaveBeenCalled();
    flaky.firedError = null;
    at2.now = new Date('2026-10-07T07:02:00Z');
    expect(await j2.tick()).toMatchObject({ skills: [{ outcome: 'fired' }] });

    const noAudit = new FakeStore();
    noAudit.auditError = new Error('audit down');
    expect(await job(noAudit, { now: new Date('2026-10-07T07:01:00Z') }).j.tick()).toMatchObject({ skills: [{ outcome: 'fired', audited: false }] });
  });

  it('overlap: a tick while another runs is skipped', async () => {
    const store = new FakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = store.firedRun.bind(store);
    store.firedRun = async (...args) => {
      await gate;
      return orig(...args);
    };
    const { j } = job(store, { now: new Date('2026-10-07T07:01:00Z') });
    const first = j.tick();
    expect(await j.tick()).toEqual({ status: 'overlap' });
    release();
    expect((await first).status).toBe('checked');
    expect(store.launches).toBe(1);
  });

  it('timers: first tick after the initial delay, then every minute; stop() ends them', async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    const { j } = job(store, { now: new Date('2026-10-07T07:01:00Z') });
    const spy = vi.spyOn(j, 'tick');
    j.start(60_000, 15_000);
    j.start(60_000, 15_000);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(spy).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spy).toHaveBeenCalledTimes(3);
    await j.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(store.launches).toBe(1);
  });
});
