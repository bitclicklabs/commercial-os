/**
 * Meeting availability contract (tanda 22). Shared by the email drafter (which proposes slots in
 * a draft) and src/meetings/calendar-availability.ts (which computes them from the salesperson's
 * calendar synced in Twenty). Level 1 of autonomy: the system only PROPOSES slots; it never
 * creates a calendar event nor sends an invitation.
 */
export interface MeetingSlot {
  start: string;
  end: string;
} // ISO con zona Europe/Madrid

export interface MeetingProposal {
  slots: MeetingSlot[];
  bookingUrl: string | null;
  videoUrl: string | null;
  durationMin: number;
  source: 'calendar' | 'link' | 'none';
}

export interface MeetingAvailability {
  propose(opts: { now: Date; count: number }): Promise<MeetingProposal>;
}

/** No calendar, no booking link: nothing to propose (the draft asks for a time instead). */
export const NULL_AVAILABILITY: MeetingAvailability = {
  async propose() {
    return { slots: [], bookingUrl: null, videoUrl: null, durationMin: 30, source: 'none' };
  },
};
