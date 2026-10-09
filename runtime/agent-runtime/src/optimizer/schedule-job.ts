/**
 * Scheduled Skill Optimizer: the same run as `POST /optimizer/skills/:name/run` (one shared
 * path, src/optimizer/launch.ts: same checks, same default budgets, same queue), enqueued by the
 * scheduler role on a CRON in Europe/Madrid. Same pattern as the scheduled trace archive
 * (src/maintenance/trace-archive-job.ts): an in-process timer, off by default.
 *
 *   OPTIMIZER_SCHEDULE_ENABLED=false             a human turns it on
 *   OPTIMIZER_SCHEDULE_CRON="0 9 * * 3"          Wednesday 09:00 (after Monday's scout and
 *                                                Tuesday's labelling by the commercial)
 *   OPTIMIZER_SCHEDULE_SKILLS=prospector-event-exhibitors   comma separated
 *
 * At most once per cron window, even across restarts. The window of an instant is
 * [last fire time <= now, next fire time). A tick (every minute, CPU only) works out the
 * window; per skill, the first tick of a window asks the database whether the skill already
 * has a run that is open OR was created inside the window (by anyone: the job, a human, another
 * replica). If so, the window counts as fired; if not, the job launches one. The answer is
 * remembered in memory for the rest of the window, so the database is read once per window and
 * skill. Nothing is stored besides the run itself: `optimization_runs` is the record of the last
 * fire (`created_by = optimizer-schedule`), which survives restarts. Two replicas racing for
 * the same window meet the open-run unique index: the loser gets a conflict, logged as skipped.
 *
 * - A window whose fire time is older than the catch-up limit (12 h by default) is not fired
 *   late: a process that was down all Wednesday waits for the next Wednesday, and turning the
 *   job on on a Friday does not fire the previous Wednesday's window.
 * - An open run of the skill: skipped with an INFO log (no ERROR, no audit).
 * - A real enqueue writes one `audit_log` row `optimizer.scheduled_run` (actor `system`, method
 *   `JOB`, route `job:optimizer-schedule`) with the skill and the run id. A tick that fires
 *   nothing writes nothing.
 * - BLOCKED_NO_DATA (no failures, burned VALIDATION) is the expected outcome many weeks: the
 *   worker ends the run before any model call, at no cost, with an INFO log; nothing reaches
 *   Twenty (only a GATE_PASS writes the "Propuesta de promoción" note).
 * - It only enqueues. Activation, the Release Gate and the human close are untouched: nothing
 *   is ever promoted by this job.
 * - Never throws: a failure is logged and the next tick tries again (or the next window).
 */
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { optimizationRuns, type OptimizationRun, type OptimizationRunStatus } from '../db/schema.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import { DEFAULT_TIMEZONE, nextRuns, parseSchedule, ScheduleValidationError } from '../scheduler/schedule.js';
import { SKILL_NAME_RE } from '../skills/service.js';
import { OPEN_STATUSES, OPTIMIZABLE_SKILLS } from './core.js';
import { launchOptimizationRun, OptimizerLaunchError } from './launch.js';
import type { OptimizerQueue } from './queue.js';
import { OptimizerServiceError } from './service.js';

export const OPTIMIZER_SCHEDULE_AUDIT_ACTION = 'optimizer.scheduled_run';
export const OPTIMIZER_SCHEDULE_JOB_ROUTE = 'job:optimizer-schedule';
/** `created_by` of the runs the job launches (and how GET /optimizer/schedule finds the last fire). */
export const OPTIMIZER_SCHEDULE_ACTOR = 'optimizer-schedule';
export const DEFAULT_OPTIMIZER_SCHEDULE_CRON = '0 9 * * 3';
export const DEFAULT_OPTIMIZER_SCHEDULE_SKILLS: readonly string[] = ['prospector-event-exhibitors'];
/** A window is fired late at most this long after its fire time (restart, deploy). */
export const DEFAULT_OPTIMIZER_SCHEDULE_CATCH_UP_MS = 12 * 3600 * 1000;
export const DEFAULT_OPTIMIZER_SCHEDULE_TICK_MS = 60_000;
export const DEFAULT_OPTIMIZER_SCHEDULE_INITIAL_DELAY_MS = 15_000;

export interface OptimizerScheduleSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  skills: string[];
  /** Configuration problems: with any, the job does not start (and says why). */
  errors: string[];
}

/** OPTIMIZER_SCHEDULE_ENABLED (default false), OPTIMIZER_SCHEDULE_CRON, OPTIMIZER_SCHEDULE_SKILLS. */
export function optimizerScheduleSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): OptimizerScheduleSettings {
  const enabled = /^(1|true|yes|on)$/i.test((env.OPTIMIZER_SCHEDULE_ENABLED ?? '').trim());
  const cron = (env.OPTIMIZER_SCHEDULE_CRON ?? '').trim() || DEFAULT_OPTIMIZER_SCHEDULE_CRON;
  const rawSkills = (env.OPTIMIZER_SCHEDULE_SKILLS ?? '').trim();
  const skills = rawSkills
    ? [...new Set(rawSkills.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
    : [...DEFAULT_OPTIMIZER_SCHEDULE_SKILLS];
  const timezone = DEFAULT_TIMEZONE;
  const errors: string[] = [];
  try {
    parseSchedule({ type: 'CRON', expression: cron }, timezone);
  } catch (err) {
    errors.push(`OPTIMIZER_SCHEDULE_CRON: ${err instanceof ScheduleValidationError ? err.message : String(err)}`);
  }
  if (skills.length === 0) errors.push('OPTIMIZER_SCHEDULE_SKILLS: ninguna skill');
  for (const skill of skills) {
    if (!SKILL_NAME_RE.test(skill)) errors.push(`OPTIMIZER_SCHEDULE_SKILLS: "${skill}" no es un nombre de skill (kebab-case)`);
    else if (!OPTIMIZABLE_SKILLS[skill]) errors.push(`OPTIMIZER_SCHEDULE_SKILLS: no hay optimizador para "${skill}" (soportadas: ${Object.keys(OPTIMIZABLE_SKILLS).join(', ')})`);
  }
  return { enabled, cron, timezone, skills, errors };
}

export interface CronWindow {
  /** Last fire time <= now. */
  start: Date;
  /** First fire time > now. */
  next: Date;
}

/**
 * The cron window `now` belongs to, in `timezone` (pure). cron-parser resolves the DST changes:
 * a time that does not exist (spring forward) fires at the first valid instant after it, and a
 * time that happens twice (fall back) fires once.
 */
export function cronWindow(cron: string, timezone: string, now: Date): CronWindow {
  const t = now.getTime();
  // prev() is only an anchor: across a spring-forward gap it skips the shifted occurrence that
  // next() (and BullMQ) do produce. Two occurrences back, then forward with next() up to `now`,
  // so the window always matches the fire times of nextRuns. +1 ms: a tick exactly on the fire
  // time belongs to the new window.
  const back = CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(t + 1) });
  back.prev();
  let start = back.prev().toDate();
  const fwd = CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(start.getTime() - 1) });
  for (let i = 0; i < 1000; i++) {
    const d = fwd.next().toDate();
    if (d.getTime() > t) return { start, next: d };
    start = d;
  }
  const [next] = nextRuns({ type: 'CRON', expression: cron, timezone }, 1, now);
  return { start, next: new Date(next!) };
}

/** A run that makes the window count as fired. */
export interface FiredRun {
  id: string;
  status: OptimizationRunStatus;
  createdAt: Date;
  createdBy: string | null;
}

/** What the job reads and writes (the database by default; injectable for tests). */
export interface OptimizerScheduleStore {
  /** The newest run of the skill that is open or was created at/after `since` (any creator), or null. */
  firedRun(tenantId: string, skill: string, since: Date): Promise<FiredRun | null>;
  /** The manual path (launchOptimizationRun) with the default config. */
  launch(tenantId: string, skill: string): Promise<OptimizationRun>;
  audit(row: AuditInsert): Promise<unknown>;
}

export async function findFiredRun(db: Db, tenantId: string, skill: string, since: Date): Promise<FiredRun | null> {
  const [row] = await db
    .select({ id: optimizationRuns.id, status: optimizationRuns.status, createdAt: optimizationRuns.createdAt, createdBy: optimizationRuns.createdBy })
    .from(optimizationRuns)
    .where(and(eq(optimizationRuns.tenantId, tenantId), eq(optimizationRuns.skillName, skill), or(inArray(optimizationRuns.status, [...OPEN_STATUSES]), gte(optimizationRuns.createdAt, since))))
    .orderBy(desc(optimizationRuns.createdAt))
    .limit(1);
  return row ?? null;
}

export function dbScheduleStore(db: Db, queue: OptimizerQueue): OptimizerScheduleStore {
  return {
    firedRun: (tenantId, skill, since) => findFiredRun(db, tenantId, skill, since),
    launch: (tenantId, skill) => launchOptimizationRun(db, queue, { tenantId, skill, createdBy: OPTIMIZER_SCHEDULE_ACTOR }),
    audit: (row) => recordAudit(db, row),
  };
}

interface JobLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface OptimizerScheduleJobOptions {
  settings: OptimizerScheduleSettings;
  /** Tenant whose skills are optimized (the runtime's default tenant). */
  tenantId: string;
  store: OptimizerScheduleStore;
  logger?: JobLogger | undefined;
  catchUpMs?: number | undefined;
  now?: () => Date;
}

export type SkillTickOutcome =
  | { skill: string; outcome: 'fired'; runId: string; audited: boolean }
  | { skill: string; outcome: 'already_fired'; runId: string; status: OptimizationRunStatus; open: boolean }
  | { skill: string; outcome: 'conflict' }
  | { skill: string; outcome: 'not_launched'; code: string; error: string }
  | { skill: string; outcome: 'error'; error: string };

export type OptimizerScheduleTick =
  | { status: 'disabled' }
  | { status: 'overlap' }
  /** Every skill already handled in this window (no I/O). */
  | { status: 'idle'; window: CronWindow }
  /** The window's fire time is older than the catch-up limit: not fired late. */
  | { status: 'missed'; window: CronWindow }
  | { status: 'checked'; tickId: string; window: CronWindow; skills: SkillTickOutcome[] };

export class OptimizerScheduleJob {
  private timer: NodeJS.Timeout | undefined;
  private firstTimer: NodeJS.Timeout | undefined;
  private running: Promise<OptimizerScheduleTick> | undefined;
  /** skill -> start (ms) of the window already handled. Lost on restart: the database answers then. */
  private readonly handled = new Map<string, number>();
  private readonly now: () => Date;
  private readonly catchUpMs: number;

  constructor(private readonly opts: OptimizerScheduleJobOptions) {
    this.now = opts.now ?? (() => new Date());
    this.catchUpMs = opts.catchUpMs ?? DEFAULT_OPTIMIZER_SCHEDULE_CATCH_UP_MS;
  }

  /** Enabled and correctly configured. */
  get active(): boolean {
    return this.opts.settings.enabled && this.opts.settings.errors.length === 0;
  }

  /** One tick. A tick while another one runs is skipped. Never throws. */
  tick(): Promise<OptimizerScheduleTick> {
    if (!this.active) return Promise.resolve({ status: 'disabled' });
    if (this.running) return Promise.resolve({ status: 'overlap' });
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<OptimizerScheduleTick> {
    const { settings, tenantId, store } = this.opts;
    const log = this.opts.logger;
    const now = this.now();
    let window: CronWindow;
    try {
      window = cronWindow(settings.cron, settings.timezone, now);
    } catch (err) {
      log?.error({ job: OPTIMIZER_SCHEDULE_JOB_ROUTE, cron: settings.cron, err: err instanceof Error ? err.message : String(err) }, 'optimizer schedule: invalid cron');
      return { status: 'disabled' };
    }
    const startMs = window.start.getTime();
    const pending = settings.skills.filter((s) => this.handled.get(s) !== startMs);
    if (pending.length === 0) return { status: 'idle', window };
    if (now.getTime() - startMs > this.catchUpMs) {
      for (const s of pending) this.handled.set(s, startMs);
      log?.info({ job: OPTIMIZER_SCHEDULE_JOB_ROUTE, window_start: window.start.toISOString(), next_fire: window.next.toISOString(), skills: pending }, 'optimizer schedule: the last fire time is too old to fire late; waiting for the next one');
      return { status: 'missed', window };
    }

    const tickId = randomUUID();
    const outcomes: SkillTickOutcome[] = [];
    for (const skill of pending) {
      const base = { job: OPTIMIZER_SCHEDULE_JOB_ROUTE, tick_id: tickId, skill, window_start: window.start.toISOString() };
      try {
        const fired = await store.firedRun(tenantId, skill, window.start);
        if (fired) {
          this.handled.set(skill, startMs);
          const open = OPEN_STATUSES.includes(fired.status);
          log?.info({ ...base, run_id: fired.id, status: fired.status, created_by: fired.createdBy }, open ? `optimizer schedule: ${skill} already has an open run, skipped` : `optimizer schedule: ${skill} already has a run in this window, skipped`);
          outcomes.push({ skill, outcome: 'already_fired', runId: fired.id, status: fired.status, open });
          continue;
        }
        const run = await store.launch(tenantId, skill);
        this.handled.set(skill, startMs);
        log?.info({ ...base, run_id: run.id, base_version: run.baseVersion, next_fire: window.next.toISOString() }, `optimizer schedule: run enqueued for ${skill} (no data = BLOCKED_NO_DATA at no cost)`);
        let audited = false;
        try {
          await store.audit({
            tenantId,
            actor: 'system',
            actorLabel: OPTIMIZER_SCHEDULE_ACTOR,
            action: OPTIMIZER_SCHEDULE_AUDIT_ACTION,
            subjectType: 'skill',
            subjectId: skill,
            subjectVersion: run.baseVersion,
            method: 'JOB',
            route: OPTIMIZER_SCHEDULE_JOB_ROUTE,
            requestId: tickId,
            payload: { skill, run_id: run.id, base_version: run.baseVersion, cron: settings.cron, timezone: settings.timezone, window_start: window.start.toISOString() },
            result: 'ok',
            statusCode: 202,
            details: { next_fire: window.next.toISOString() },
          });
          audited = true;
        } catch (err) {
          log?.error({ ...base, run_id: run.id, err: err instanceof Error ? err.message : String(err) }, 'optimizer schedule: audit_log insert failed (the run is enqueued anyway)');
        }
        outcomes.push({ skill, outcome: 'fired', runId: run.id, audited });
      } catch (err) {
        if (err instanceof OptimizerServiceError && err.code === 'conflict') {
          // Another process opened a run between the check and the insert (open-run unique index).
          this.handled.set(skill, startMs);
          log?.info({ ...base, details: err.details }, `optimizer schedule: ${skill} already has an open run, skipped`);
          outcomes.push({ skill, outcome: 'conflict' });
        } else if (err instanceof OptimizerLaunchError) {
          // Not retried in this window (a queue failure already closed its run as ERROR).
          this.handled.set(skill, startMs);
          const level = err.code === 'queue_unavailable' || err.code === 'no_queue' ? 'error' : 'warn';
          log?.[level]({ ...base, code: err.code, err: err.message, ...(err.run ? { run_id: err.run.id } : {}) }, `optimizer schedule: could not launch ${skill}`);
          outcomes.push({ skill, outcome: 'not_launched', code: err.code, error: err.message });
        } else {
          // Database unreachable or similar: nothing was created, the next tick checks again.
          const message = err instanceof Error ? err.message : String(err);
          log?.error({ ...base, err: message }, 'optimizer schedule: tick failed, the next tick retries');
          outcomes.push({ skill, outcome: 'error', error: message });
        }
      }
    }
    return { status: 'checked', tickId, window, skills: outcomes };
  }

  /** First tick after `initialDelayMs`, then one every `tickMs`. Idempotent; does nothing when inactive. */
  start(tickMs = DEFAULT_OPTIMIZER_SCHEDULE_TICK_MS, initialDelayMs = DEFAULT_OPTIMIZER_SCHEDULE_INITIAL_DELAY_MS): void {
    if (!this.active || this.timer || this.firstTimer) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.timer.unref?.();
    }, Math.max(0, initialDelayMs));
    this.firstTimer.unref?.();
  }

  /** Stops the timers and waits for a running tick. */
  async stop(): Promise<void> {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = undefined;
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// GET /optimizer/schedule
// ---------------------------------------------------------------------------

export interface ScheduledRunView {
  run_id: string;
  skill: string;
  status: OptimizationRunStatus;
  fired_at: string;
  cost_eur: number;
}

export interface OptimizerScheduleStatus {
  enabled: boolean;
  cron: string;
  timezone: string;
  skills: string[];
  errors: string[];
  catch_up_hours: number;
  /** Next fire time (ISO), null when disabled or misconfigured. */
  next_fire: string | null;
  /** Newest run launched by the job (any of its skills), from optimization_runs. */
  last_fire: ScheduledRunView | null;
  by_skill: Array<{ skill: string; last_fire: ScheduledRunView | null }>;
  note: string;
}

/**
 * Read-only status. The settings are those of the process that answers (the api role): the job
 * runs in the scheduler role, so both must share the OPTIMIZER_SCHEDULE_* variables.
 */
export async function optimizerScheduleStatus(db: Db, tenantId: string, settings: OptimizerScheduleSettings, now: Date = new Date()): Promise<OptimizerScheduleStatus> {
  const byskill = await Promise.all(
    settings.skills.map(async (skill) => {
      const [row] = await db
        .select({ id: optimizationRuns.id, status: optimizationRuns.status, createdAt: optimizationRuns.createdAt, costEur: optimizationRuns.costEur })
        .from(optimizationRuns)
        .where(and(eq(optimizationRuns.tenantId, tenantId), eq(optimizationRuns.skillName, skill), eq(optimizationRuns.createdBy, OPTIMIZER_SCHEDULE_ACTOR)))
        .orderBy(desc(optimizationRuns.createdAt))
        .limit(1);
      const view: ScheduledRunView | null = row ? { run_id: row.id, skill, status: row.status, fired_at: row.createdAt.toISOString(), cost_eur: row.costEur } : null;
      return { skill, last_fire: view };
    }),
  );
  const last = byskill
    .map((s) => s.last_fire)
    .filter((v): v is ScheduledRunView => v !== null)
    .sort((a, b) => b.fired_at.localeCompare(a.fired_at))[0];
  let next: string | null = null;
  if (settings.enabled && settings.errors.length === 0) {
    try {
      next = cronWindow(settings.cron, settings.timezone, now).next.toISOString();
    } catch {
      next = null;
    }
  }
  return {
    enabled: settings.enabled,
    cron: settings.cron,
    timezone: settings.timezone,
    skills: settings.skills,
    errors: settings.errors,
    catch_up_hours: DEFAULT_OPTIMIZER_SCHEDULE_CATCH_UP_MS / 3600_000,
    next_fire: next,
    last_fire: last ?? null,
    by_skill: byskill,
    note: 'Solo encola runs (idénticos al manual). Nunca activa ni promueve: el cierre es humano.',
  };
}
