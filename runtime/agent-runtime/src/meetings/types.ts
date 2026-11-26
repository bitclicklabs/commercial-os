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
}

export interface MeetingAvailability {
  /** Up to `count` slots after `now`. Must not throw for "no availability": return source `none`. */
  propose(opts: { now: Date; count: number }): Promise<MeetingProposal>;
}

/** Default duration of the call the draft proposes when nobody says otherwise. */
export const DEFAULT_MEETING_DURATION_MIN = 30;

/** No calendar, no link: the draft asks the client which day and time suits them. */
export const NULL_AVAILABILITY: MeetingAvailability = {
  async propose() {
    return { slots: [], bookingUrl: null, videoUrl: null, durationMin: DEFAULT_MEETING_DURATION_MIN, source: 'none' };
  },
};
