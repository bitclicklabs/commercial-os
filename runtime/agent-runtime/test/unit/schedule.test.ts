import { describe, expect, it } from 'vitest';
import {
  desiredSchedule,
  nextRuns,
  onceJobIdFor,
  parseSchedule,
  repeatOptionsFor,
  sameRepeat,
  ScheduleValidationError,
  schedulerIdFor,
  slotFromTickJob,
  taskIdFromSchedulerId,
} from '../../src/scheduler/schedule.js';

const TASK = '8c1f5d2e-1a3b-4c5d-8e9f-0a1b2c3d4e5f';

describe('parseSchedule', () => {
  it('returns null for non time-based types', () => {
    expect(parseSchedule({ type: 'MANUAL' })).toBeNull();
    expect(parseSchedule({ type: 'EVENT', event: 'company.created' })).toBeNull();
    expect(parseSchedule(undefined)).toBeNull();
  });

  it('parses CRON with the task timezone by default (Europe/Madrid)', () => {
    expect(parseSchedule({ type: 'CRON', expression: '0 8 * * *' })).toEqual({
      type: 'CRON',
      expression: '0 8 * * *',
      timezone: 'Europe/Madrid',
    });
    expect(parseSchedule({ type: 'CRON', cron: '30 8 * * 1-5', timezone: 'UTC' }, 'Europe/Madrid')).toEqual({
      type: 'CRON',
      expression: '30 8 * * 1-5',
      timezone: 'UTC',
    });
    // 6 fields (seconds) are accepted.
    expect(parseSchedule({ type: 'CRON', expression: '*/2 * * * * *' })?.type).toBe('CRON');
  });

  it('rejects malformed CRON schedules', () => {
    expect(() => parseSchedule({ type: 'CRON' })).toThrow(ScheduleValidationError);
    expect(() => parseSchedule({ type: 'CRON', expression: '61 * * * *' })).toThrow(ScheduleValidationError);
    expect(() => parseSchedule({ type: 'CRON', expression: '* * *' })).toThrow(/5 or 6 fields/);
    expect(() => parseSchedule({ type: 'CRON', expression: '0 8 * * *', timezone: 'Mars/Olympus' })).toThrow(/timezone/);
  });

  it('parses ONCE (run_at or at) normalised to UTC seconds', () => {
    expect(parseSchedule({ type: 'ONCE', run_at: '2026-10-07T10:00:00.250+02:00' })).toEqual({
      type: 'ONCE',
      runAt: '2026-10-07T08:00:00Z',
    });
    expect(parseSchedule({ type: 'ONCE', at: '2026-10-07T08:00:00Z' })).toEqual({ type: 'ONCE', runAt: '2026-10-07T08:00:00Z' });
    expect(() => parseSchedule({ type: 'ONCE' })).toThrow(ScheduleValidationError);
    expect(() => parseSchedule({ type: 'ONCE', run_at: 'tomorrow' })).toThrow(ScheduleValidationError);
  });

  it('parses INTERVAL (every_seconds or interval_seconds)', () => {
    expect(parseSchedule({ type: 'INTERVAL', every_seconds: 30 })).toEqual({ type: 'INTERVAL', everySeconds: 30 });
    expect(parseSchedule({ type: 'INTERVAL', interval_seconds: 60 })).toEqual({ type: 'INTERVAL', everySeconds: 60 });
    expect(() => parseSchedule({ type: 'INTERVAL' })).toThrow(ScheduleValidationError);
    expect(() => parseSchedule({ type: 'INTERVAL', every_seconds: 0 })).toThrow(ScheduleValidationError);
    expect(() => parseSchedule({ type: 'INTERVAL', every_seconds: 1.5 })).toThrow(ScheduleValidationError);
  });
});

describe('desiredSchedule', () => {
  const base = { status: 'ACTIVE' as const, enabled: true, timezone: 'Europe/Madrid', schedule: { type: 'CRON', expression: '0 8 * * *' } };

  it('registers only ACTIVE, enabled, valid time-based schedules', () => {
    expect(desiredSchedule(base)?.type).toBe('CRON');
    expect(desiredSchedule({ ...base, status: 'PAUSED' })).toBeNull();
    expect(desiredSchedule({ ...base, status: 'ARCHIVED' })).toBeNull();
    expect(desiredSchedule({ ...base, enabled: false })).toBeNull();
    expect(desiredSchedule({ ...base, schedule: { type: 'MANUAL' } })).toBeNull();
    expect(desiredSchedule({ ...base, schedule: { type: 'CRON', expression: 'nope' } })).toBeNull();
  });
});

describe('nextRuns', () => {
  const from = new Date('2026-10-06T05:30:00Z');

  it('computes CRON slots in the schedule timezone', () => {
    // 08:00 Europe/Madrid (CEST, UTC+2) = 06:00Z
    expect(nextRuns({ type: 'CRON', expression: '0 8 * * *', timezone: 'Europe/Madrid' }, 2, from)).toEqual([
      '2026-10-06T06:00:00Z',
      '2026-10-07T06:00:00Z',
    ]);
  });

  it('aligns INTERVAL slots to the epoch like BullMQ', () => {
    expect(nextRuns({ type: 'INTERVAL', everySeconds: 3600 }, 2, from)).toEqual(['2026-10-06T06:00:00Z', '2026-10-06T07:00:00Z']);
  });

  it('returns the ONCE slot only while it is in the future', () => {
    expect(nextRuns({ type: 'ONCE', runAt: '2026-10-06T06:00:00Z' }, 3, from)).toEqual(['2026-10-06T06:00:00Z']);
    expect(nextRuns({ type: 'ONCE', runAt: '2026-10-06T05:00:00Z' }, 3, from)).toEqual([]);
  });
});

describe('registration identity', () => {
  it('maps task ids to BullMQ-safe scheduler ids and back', () => {
    expect(schedulerIdFor(TASK)).toBe(`task__${TASK}`);
    expect(schedulerIdFor(TASK)).not.toContain(':');
    expect(taskIdFromSchedulerId(schedulerIdFor(TASK))).toBe(TASK);
    expect(taskIdFromSchedulerId('something-else')).toBeNull();
    expect(onceJobIdFor(TASK, '2026-10-06T06:00:00Z')).toBe(`once__${TASK}__${Date.parse('2026-10-06T06:00:00Z')}`);
  });

  it('detects when the registered repeat already matches (no needless upsert)', () => {
    const cron = { type: 'CRON' as const, expression: '0 8 * * *', timezone: 'Europe/Madrid' };
    expect(sameRepeat({ pattern: '0 8 * * *', tz: 'Europe/Madrid' }, cron)).toBe(true);
    expect(sameRepeat({ pattern: '0 8 * * *', tz: 'UTC' }, cron)).toBe(false);
    expect(sameRepeat({ pattern: '0 9 * * *', tz: 'Europe/Madrid' }, cron)).toBe(false);
    expect(sameRepeat(null, cron)).toBe(false);
    const interval = { type: 'INTERVAL' as const, everySeconds: 5 };
    expect(sameRepeat({ every: '5000' }, interval)).toBe(true);
    expect(sameRepeat({ every: 6000 }, interval)).toBe(false);
    expect(repeatOptionsFor(cron)).toEqual({ pattern: '0 8 * * *', tz: 'Europe/Madrid' });
    expect(repeatOptionsFor(interval)).toEqual({ every: 5000 });
  });
});

describe('slotFromTickJob', () => {
  const slotMs = Date.parse('2026-10-06T06:00:00Z');

  it('uses the planned slot, not the delivery time', () => {
    expect(slotFromTickJob({ data: { slot: '2026-10-06T08:00:00+02:00' } })).toBe('2026-10-06T06:00:00Z');
    expect(slotFromTickJob({ opts: { prevMillis: slotMs + 123 } })).toBe('2026-10-06T06:00:00Z');
    expect(slotFromTickJob({ id: `repeat:task__${TASK}:${slotMs}` })).toBe('2026-10-06T06:00:00Z');
    expect(slotFromTickJob({ timestamp: slotMs - 5000, delay: 5000 })).toBe('2026-10-06T06:00:00Z');
  });
});

describe('schedule validation in the API (no database)', () => {
  it('rejects an invalid CRON on POST /tasks with 400 before touching the database', async () => {
    const { buildServer } = await import('../../src/api/server.js');
    const { MemoryRunQueue } = await import('../../src/queue/run-queue.js');
    const db = new Proxy({} as never, {
      get() {
        throw new Error('database must not be touched in this test');
      },
    });
    const app = await buildServer({ db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
    const res = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { name: 'bad', agent_id: TASK, schedule: { type: 'INTERVAL', every_seconds: 0 } },
    });
    // every_seconds: 0 fails zod (positive) -> validation_error; a bad cron fails the scheduler parser.
    expect(res.statusCode).toBe(400);
    const cron = await app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { name: 'bad', agent_id: TASK, schedule: { type: 'CRON', expression: '99 * * * *' } },
    });
    expect(cron.statusCode).toBe(400);
    expect(cron.json().error).toBe('invalid_schedule');
    await app.close();
  });
});
