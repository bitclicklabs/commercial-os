/**
 * Meeting proposal contract (tanda 22). The InboxAgent asks a `MeetingAvailability` for a
 * proposal when it drafts the answer to a reply, and turns it into the meeting paragraph of the
 * draft BY CODE (src/inbound/meeting-paragraph.ts): the model never writes dates or links.
 *
 * The real availability (calendar free slots, booking link, video link) lives in other files of
 * this folder and is wired by the integration; until then the agent uses `NULL_AVAILABILITY`,
 * which proposes nothing and lets the draft ask the client for a day and time.
 *
 * Nothing here books, invites or sends anything: a proposal is only text for a human to send.
 */

/** One free slot. ISO 8601 with the Europe/Madrid offset (e.g. `2026-12-03T10:30:00+01:00`). */
export interface MeetingSlot {
  start: string;
  end: string;
}

export interface MeetingProposal {
  /** Concrete free slots, earliest first (source `calendar`). */
  slots: MeetingSlot[];
  /** Self-service booking page, when there is one. */
  bookingUrl: string | null;
  /** Video call link to include in the draft, when there is one. */
  videoUrl: string | null;
  /** Length of the call being proposed, in minutes. */
  durationMin: number;
  /** Where the proposal comes from: free slots of a calendar, only a booking link, or nothing. */
  source: 'calendar' | 'link' | 'none';
  /**
   * Tanda 23: a `window` was asked for but left no free slot, so the slots are those of the normal
   * horizon (the meeting paragraph says so). Absent / false otherwise.
   */
  windowRelaxed?: boolean;
}

/**
 * Tanda 23: when the client wants the meeting ("la semana que viene", "por las tardes", "a partir
 * del 10"). Dates are local `YYYY-MM-DD` (Europe/Madrid), both inclusive. Built BY CODE from closed
 * categories the model picks (src/meetings/client-window.ts), never from free dates of the model.
 */
export interface MeetingWindow {
  notBefore?: string;
  notAfter?: string;
  partOfDay?: 'morning' | 'afternoon';
}

export interface MeetingAvailability {
  /**
   * Up to `count` slots after `now`. Must not throw for "no availability": return source `none`.
   * With `window` (tanda 23, optional: implementations that ignore it stay valid): only slots inside
   * it; fewer than `count` when the window has fewer; none in the window -> the normal horizon with
   * `windowRelaxed: true`.
   */
  propose(opts: { now: Date; count: number; window?: MeetingWindow }): Promise<MeetingProposal>;
}

/** Default duration of the call the draft proposes when nobody says otherwise. */
export const DEFAULT_MEETING_DURATION_MIN = 30;

/** No calendar, no link: the draft asks the client which day and time suits them. */
export const NULL_AVAILABILITY: MeetingAvailability = {
  async propose() {
    return { slots: [], bookingUrl: null, videoUrl: null, durationMin: DEFAULT_MEETING_DURATION_MIN, source: 'none' };
  },
};
