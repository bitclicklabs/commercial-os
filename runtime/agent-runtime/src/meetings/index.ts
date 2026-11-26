/**
 * Meetings (tanda 22): slots to propose a meeting (read from the salesperson's calendar synced in
 * Twenty) and the detection of the meetings already booked (task `meeting-sync`). Read only on
 * the calendar: no event is ever created and no invitation is ever sent.
 */
import { twentyClientFromEnv, type TwentyClient } from '../integrations/twenty/index.js';
import { CalendarAvailability, LinkAvailability } from './calendar-availability.js';
import { meetingConfigFromEnv } from './config.js';
import type { MeetingAvailability } from './types.js';

export * from './types.js';
export * from './config.js';
export * from './calendar.js';
export * from './slots.js';
export * from './calendar-availability.js';
export * from './client-window.js';

/**
 * The availability the runtime uses: the calendar in Twenty when an API key is configured (it
 * degrades by itself to the booking link / nothing when there is no synced channel), else the
 * booking link (MEETING_BOOKING_URL) or nothing.
 */
export function meetingAvailabilityFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { twenty?: TwentyClient; signal?: AbortSignal } = {}): MeetingAvailability {
  const config = meetingConfigFromEnv(env);
  const twenty = deps.twenty ?? twentyClientFromEnv(env);
  if (!twenty.isConfigured()) return new LinkAvailability(config);
  return new CalendarAvailability(twenty, config, deps.signal ? { signal: deps.signal } : {});
}
