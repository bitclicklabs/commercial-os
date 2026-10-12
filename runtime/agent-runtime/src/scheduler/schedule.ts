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
 * and never register a job scheduler. EVENT is still validated here (event_type, filter) and
 * is registered as an event trigger (src/scheduler/event-triggers.ts).
 */
import { CronExpressionParser } from 'cron-parser';
import type { ScheduleSpec, TaskDefinition } from '../db/schema.js';
import { normalizeScheduledAt } from '../domain/idempotency.js';
import { EventTriggerValidationError, parseEventTrigger } from '../events/triggers.js';

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
    case 'EVENT':
      try {
        parseEventTrigger(spec);
      } catch (err) {
        if (err instanceof EventTriggerValidationError) throw new ScheduleValidationError(err.message);
        throw err;
      }
      return null;
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
// Catch-up policy (tanda 16): what a late CRON/INTERVAL tick may recover
// ---------------------------------------------------------------------------
/** `CATCHUP_MAX_SLOTS`: slots a task recovers after a stop (default 1, as before tanda 16). */
export const DEFAULT_CATCHUP_MAX_SLOTS = 1;
/** `CATCHUP_MAX_AGE_MS`: a missed slot older than this is never recovered (default 48 h). */
export const DEFAULT_CATCHUP_MAX_AGE_MS = 48 * 3600 * 1000;
/**
 * A tick at most this late is "on time" (busy worker, BullMQ retry backoff, a short restart)
 * and simply runs its own slot. Capped by the max age.
 */
export const CATCHUP_ON_TIME_GRACE_MS = 5 * 60 * 1000;

export interface CatchUpPolicy {
  /** >= 1: the most recent due slot always counts as one. */
  maxSlots: number;
  maxAgeMs: number;
}

export const DEFAULT_CATCHUP_POLICY: CatchUpPolicy = { maxSlots: DEFAULT_CATCHUP_MAX_SLOTS, maxAgeMs: DEFAULT_CATCHUP_MAX_AGE_MS };

export type TickPlan =
  /** Normal tick: run its own slot. */
  | { kind: 'on_time'; tickSlot: string; run: string[] }
  /** Late tick (the scheduler was down): run the most recent due slots within the policy, oldest first. */
  | { kind: 'catch_up'; tickSlot: string; run: string[] }
  /** Late tick whose due slots are all older than the max age: nothing runs, the next natural slot rules. */
  | { kind: 'stale'; tickSlot: string; run: string[]; newestDue: string };

/**
 * Natural slots of a CRON/INTERVAL schedule in [fromMs, nowMs], most recent first, at most
 * `limit` and none older than `oldestMs`. Bounded work: never walks the whole gap.
 */
function recentSlots(schedule: NormalizedSchedule, fromMs: number, nowMs: number, oldestMs: number, limit: number): number[] {
  const lower = Math.max(fromMs, oldestMs);
  if (limit <= 0 || lower > nowMs) return [];
  if (schedule.type === 'INTERVAL') {
    // Same phase as the tick (BullMQ `every` keeps the phase of its first slot).
    const every = schedule.everySeconds * 1000;
    const kMax = Math.floor((nowMs - fromMs) / every);
    const out: number[] = [];
    for (let k = kMax; k >= 0 && out.length < limit; k--) {
      const ms = fromMs + k * every;
      if (ms < lower) break;
      out.push(ms);
    }
    return out;
  }
  if (schedule.type === 'CRON') {
    // Start a little after now (cron-parser works in whole seconds) and walk backwards.
    const it = CronExpressionParser.parse(schedule.expression, { tz: schedule.timezone, currentDate: new Date(nowMs + 1000) });
    const out: number[] = [];
    for (let guard = 0; guard < limit + 4 && out.length < limit; guard++) {
      let ms: number;
      try {
        ms = it.prev().toDate().getTime();
      } catch {
        break; // no earlier occurrence
      }
      if (ms > nowMs) continue;
      if (ms < lower) break;
      out.push(ms);
    }
    return out;
  }
  return [];
}

/**
 * Decides which slots a CRON/INTERVAL tick runs (ONCE ticks never go through here).
 *
 * BullMQ keeps one pending job per job scheduler and, once it is processed, computes the next
 * one from "now": after a stop, exactly one late tick arrives per task, carrying the OLDEST
 * missed slot. Before tanda 16 that slot always ran, however old (the 2026-10-12 storm).
 * Now a late tick runs the most recent `maxSlots` due slots between its own slot and now that
 * are younger than `maxAgeMs` (oldest first, each with its own idempotency key); if there is
 * none, nothing runs and the next natural slot rules.
 */
export function planTickSlots(
  schedule: NormalizedSchedule | null,
  tickSlot: string,
  policy: CatchUpPolicy = DEFAULT_CATCHUP_POLICY,
  now: Date = new Date(),
): TickPlan {
  const slot = normalizeScheduledAt(tickSlot);
  const nowMs = now.getTime();
  const tickMs = new Date(slot).getTime();
  const maxSlots = Math.max(1, Math.floor(policy.maxSlots));
  const maxAgeMs = Math.max(0, policy.maxAgeMs);
  if (nowMs - tickMs <= Math.min(CATCHUP_ON_TIME_GRACE_MS, maxAgeMs)) return { kind: 'on_time', tickSlot: slot, run: [slot] };

  const due = new Set<number>([tickMs]);
  if (schedule && schedule.type !== 'ONCE') {
    // Ignoring the age here only to report the newest due slot when everything is stale.
    for (const ms of recentSlots(schedule, tickMs, nowMs, Number.NEGATIVE_INFINITY, maxSlots)) due.add(ms);
  }
  const newestFirst = [...due].filter((ms) => ms <= nowMs || ms === tickMs).sort((a, b) => b - a);
  const fresh = newestFirst.filter((ms) => nowMs - ms <= maxAgeMs).slice(0, maxSlots);
  const iso = (ms: number) => normalizeScheduledAt(new Date(ms));
  if (fresh.length === 0) return { kind: 'stale', tickSlot: slot, run: [], newestDue: iso(newestFirst[0] ?? tickMs) };
  return { kind: 'catch_up', tickSlot: slot, run: fresh.reverse().map(iso) };
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
