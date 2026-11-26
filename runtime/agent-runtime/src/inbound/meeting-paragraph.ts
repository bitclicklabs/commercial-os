/**
 * The meeting paragraph of a reply draft (tanda 22), built BY CODE from a `MeetingProposal`
 * (src/meetings/types.ts): the model never writes dates, slots or links.
 *
 *   calendar -> up to 3 concrete slots in Spanish («jueves 3 de diciembre, a las 10:30») and,
 *               when there is a booking page, «o, si os encaja mejor, reservad directamente
 *               aquí: <bookingUrl>»;
 *   link     -> only the booking link;
 *   none     -> «¿Qué día y hora os vendría bien para una llamada de <durationMin> minutos?».
 * With a video link, one more line with it. A `calendar` proposal without slots falls back to
 * `link` (with a booking URL) or `none`; a `link` proposal without URL falls back to `none`.
 *
 * `clientProposedTime`: the draft already accepts the day/time the client proposed, so the
 * paragraph is phrased as the alternative («Si al final os viene mejor otro momento, …»).
 */
import { DEFAULT_MEETING_DURATION_MIN, type MeetingProposal } from '../meetings/types.js';

export const MEETING_TIMEZONE = 'Europe/Madrid';
export const MEETING_SLOTS_IN_DRAFT = 3;

/** «jueves 3 de diciembre, a las 10:30» («a la 1:00» for one o'clock), in `timeZone`. */
export function formatSlotEs(iso: string, timeZone = MEETING_TIMEZONE): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-ES', { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: false })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = Number(parts.hour) % 24;
  const minute = parts.minute ?? '00';
  return `${parts.weekday} ${parts.day} de ${parts.month}, ${hour === 1 ? 'a la' : 'a las'} ${hour}:${minute}`;
}

/** Only http(s) URLs without spaces or markup characters; anything else is dropped. */
export function safeUrl(url: string | null | undefined): string | null {
  const u = (url ?? '').trim();
  if (!/^https?:\/\/[^\s<>"'`()[\]]+$/i.test(u)) return null;
  return u;
}

export interface MeetingParagraph {
  /** Plain-text lines to put before the farewell (no trailing blank line). */
  lines: string[];
  /** The variant actually used (after the fallbacks). */
  source: MeetingProposal['source'];
  slots: string[];
}

export function meetingParagraph(p: MeetingProposal, opts: { clientProposedTime?: boolean; timeZone?: string } = {}): MeetingParagraph {
  const duration = Number.isInteger(p.durationMin) && p.durationMin > 0 && p.durationMin <= 240 ? p.durationMin : DEFAULT_MEETING_DURATION_MIN;
  const booking = safeUrl(p.bookingUrl);
  const video = safeUrl(p.videoUrl);
  const slots =
    p.source === 'calendar'
      ? p.slots
          .map((s) => formatSlotEs(s.start, opts.timeZone))
          .filter((s): s is string => s !== null)
          .slice(0, MEETING_SLOTS_IN_DRAFT)
      : [];
  const source: MeetingProposal['source'] = slots.length > 0 ? 'calendar' : (p.source === 'calendar' || p.source === 'link') && booking ? 'link' : 'none';
  const alt = opts.clientProposedTime === true;
  const lines: string[] = [];
  if (source === 'calendar') {
    lines.push(alt ? `Si al final os viene mejor otro momento, estos huecos para una llamada de ${duration} minutos también me encajan:` : `¿Lo vemos en una llamada de ${duration} minutos? Os propongo estos huecos:`);
    lines.push(...slots.map((s) => `- ${s}`));
    if (booking) lines.push(`o, si os encaja mejor, reservad directamente aquí: ${booking}`);
  } else if (source === 'link') {
    lines.push(
      alt
        ? `Si al final os viene mejor otro momento, podéis reservar una llamada de ${duration} minutos aquí: ${booking}`
        : `¿Lo vemos en una llamada de ${duration} minutos? Podéis reservar el hueco que mejor os venga aquí: ${booking}`,
    );
  } else {
    lines.push(alt ? `Si al final os viene mejor otro momento, decidme qué día y hora os vendría bien para una llamada de ${duration} minutos.` : `¿Qué día y hora os vendría bien para una llamada de ${duration} minutos?`);
  }
  if (video) lines.push(`La llamada sería por videoconferencia: ${video}`);
  return { lines, source, slots };
}
