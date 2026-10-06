/**
 * Schedule parsing and pure scheduling decisions (LLD v0.2 section 5.6).
 *
 * A TaskDefinition stores its schedule as free-form JSON (`ScheduleSpec`). This module
 * normalises it into one of the time-based schedules the BullMQ scheduler understands:
 *
 *   ONCE      { run_at | at }                       fires once at that instant
 *   CRON      { expression | cron, timezone? }      5 or 6 fields (seconds optional)
 *   INTERVAL  { every_seconds | interval_seconds }  fixed interval, aligned to epoch
 *
 * MANUAL, EVENT, DEPENDENCY and CONDITION are not time-triggered: they normalise to `null`
 * and never register anything in the scheduler.
 */
import { CronExpressionParser } from 'cron-parser';
import type { ScheduleSpec, TaskDefinition } from '../db/schema.js';
import { normalizeScheduledAt } from '../domain/idempotency.js';

export const DEFAULT_TIMEZONE = 'Europe/Madrid';
export const TIME_SCHEDULE_TYPES = ['ONCE', 'CRON', 'INTERVAL'] as const;
export type TimeScheduleType = (typeof TIME_SCHEDULE_TYPES)[number];

/** Upper bound for INTERVAL (one year), mostly to reject nonsense. */
const MAX_INTERVAL_SECONDS = 366 * 24 * 3600;

export type NormalizedSchedule =
  | { type: 'ONCE'; runAt: string }
  | { type: 'CRON'; expression: string; timezone: string }
  | { type: 'INTERVAL'; everySeconds: number };

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalises a ScheduleSpec. Returns `null` for non time-based types.
 * Throws ScheduleValidationError when a time-based schedule is malformed.
 */
export function parseSchedule(
  spec: ScheduleSpec | null | undefined,
  taskTimezone: string = DEFAULT_TIMEZONE,
): NormalizedSchedule | null {
  const type = spec?.type ?? 'MANUAL';
  switch (type) {
    case 'ONCE': {
      const raw = spec?.run_at ?? spec?.at;
      if (!raw) throw new ScheduleValidationError('ONCE schedule requires run_at');
      try {
        return { type: 'ONCE', runAt: normalizeScheduledAt(raw) };
      } catch {
        throw new ScheduleValidationError(`invalid run_at: ${raw}`);
      }
    }
    case 'CRON': {
      const expression = (spec?.expression ?? spec?.cron)?.trim();
      if (!expression) throw new ScheduleValidationError('CRON schedule requires expression');
      const timezone = spec?.timezone ?? taskTimezone ?? DEFAULT_TIMEZONE;
      if (!isValidTimezone(timezone)) throw new ScheduleValidationError(`invalid timezone: ${timezone}`);
      const fields = expression.split(/\s+/).length;
      if (!expression.startsWith('@') && (fields < 5 || fields > 6)) {
        throw new ScheduleValidationError('CRON expression must have 5 or 6 fields');
      }
      try {
        CronExpressionParser.parse(expression, { tz: timezone }).next();
      } catch (err) {
        throw new ScheduleValidationError(`invalid CRON expression "${expression}": ${(err as Error).message}`);
      }
      return { type: 'CRON', expression, timezone };
    }
    case 'INTERVAL': {
      const every = spec?.every_seconds ?? spec?.interval_seconds;
      if (typeof every !== 'number' || !Number.isInteger(every) || every < 1 || every > MAX_INTERVAL_SECONDS) {
        throw new ScheduleValidationError(`INTERVAL schedule requires every_seconds between 1 and ${MAX_INTERVAL_SECONDS}`);
      }
      return { type: 'INTERVAL', everySeconds: every };
    }
    default:
      return null;
  }
}

/** The schedule that should be registered for a task right now, or null (nothing registered). */
export function desiredSchedule(
  task: Pick<TaskDefinition, 'status' | 'enabled' | 'schedule' | 'timezone'>,
): NormalizedSchedule | null {
  if (task.status !== 'ACTIVE' || !task.enabled) return null;
  try {
    return parseSchedule(task.schedule, task.timezone);
  } catch {
    // Invalid schedules are rejected by the API; a legacy invalid row simply stays unscheduled.
    return null;
  }
}

/** Next `count` fire times (ISO, UTC) strictly after `from`. */
export function nextRuns(schedule: NormalizedSchedule, count: number, from: Date = new Date()): string[] {
  if (count <= 0) return [];
  switch (schedule.type) {
    case 'ONCE':
      return new Date(schedule.runAt).getTime() > from.getTime() ? [schedule.runAt] : [];
    case 'CRON': {
      const it = CronExpressionParser.parse(schedule.expression, { tz: schedule.timezone, currentDate: from });
      return it.take(count).map((d) => normalizeScheduledAt(d.toDate()));
    }
    case 'INTERVAL': {
      // Same alignment BullMQ uses for `every`: floor(now / every) * every + every.
      const every = schedule.everySeconds * 1000;
      const first = Math.floor(from.getTime() / every) * every + every;
      return Array.from({ length: count }, (_, i) => normalizeScheduledAt(new Date(first + i * every)));
    }
  }
}

// ---------------------------------------------------------------------------
// BullMQ identifiers (':' is reserved by BullMQ in custom ids)
// ---------------------------------------------------------------------------
export const SCHEDULER_ID_PREFIX = 'task__';
export const ONCE_JOB_PREFIX = 'once__';

export function schedulerIdFor(taskId: string): string {
  return `${SCHEDULER_ID_PREFIX}${taskId}`;
}

export function taskIdFromSchedulerId(id: string): string | null {
  return id.startsWith(SCHEDULER_ID_PREFIX) ? id.slice(SCHEDULER_ID_PREFIX.length) : null;
}

export function onceJobIdFor(taskId: string, runAt: string): string {
  return `${ONCE_JOB_PREFIX}${taskId}__${new Date(runAt).getTime()}`;
}

/** What is currently registered in BullMQ for a task (subset of JobSchedulerJson). */
export interface RegisteredRepeat {
  pattern?: string | null;
  every?: number | string | null;
  tz?: string | null;
}

/** True when the registered job scheduler already matches the desired CRON/INTERVAL. */
export function sameRepeat(existing: RegisteredRepeat | null | undefined, desired: NormalizedSchedule): boolean {
  if (!existing) return false;
  if (desired.type === 'CRON') {
    return existing.pattern === desired.expression && (existing.tz ?? null) === desired.timezone;
  }
  if (desired.type === 'INTERVAL') {
    return !existing.pattern && Number(existing.every) === desired.everySeconds * 1000;
  }
  return false;
}

/** BullMQ repeat options for a CRON/INTERVAL schedule. */
export function repeatOptionsFor(schedule: NormalizedSchedule): { pattern: string; tz: string } | { every: number } {
  if (schedule.type === 'CRON') return { pattern: schedule.expression, tz: schedule.timezone };
  if (schedule.type === 'INTERVAL') return { every: schedule.everySeconds * 1000 };
  throw new Error('ONCE schedules are not job schedulers');
}

// ---------------------------------------------------------------------------
// Slot resolution: the instant a tick belongs to (part of the idempotency key)
// ---------------------------------------------------------------------------
export interface TickJobLike {
  id?: string | null;
  timestamp?: number;
  delay?: number;
  opts?: { prevMillis?: number; delay?: number };
  data?: { slot?: string | null };
}

const REPEAT_ID_RE = /^repeat:.+:(\d+)$/;

/**
 * The slot is the planned fire time, never "now": a tick delivered late or twice (worker
 * restart, stalled job) maps to the same `taskrun:{task_id}:{scheduled_at}` key.
 */
export function slotFromTickJob(job: TickJobLike): string {
  if (job.data?.slot) return normalizeScheduledAt(job.data.slot);
  if (typeof job.opts?.prevMillis === 'number') return normalizeScheduledAt(new Date(job.opts.prevMillis));
  const match = job.id ? REPEAT_ID_RE.exec(job.id) : null;
  if (match?.[1]) return normalizeScheduledAt(new Date(Number(match[1])));
  const planned = (job.timestamp ?? Date.now()) + (job.delay ?? job.opts?.delay ?? 0);
  return normalizeScheduledAt(new Date(planned));
}
