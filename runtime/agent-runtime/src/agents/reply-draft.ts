/**
 * Pure pieces of the reply draft (tanda 22, skill `email-reply-draft`): the zod contract of the
 * model answer plus the rules checked BY CODE, the post-processing that guarantees the subject,
 * the meeting paragraph, the farewell and the signature (Jesús Abril, PubliEXPE «expertos en
 * merchandising»), and the markdown of the «Borrador de respuesta» section of the Task 📬 and
 * of the 📬 note.
 *
 * Nothing here sends anything: the draft is text for the commercial to review and send himself
 * (autonomy level 1).
 */
import { z } from 'zod';
import type { MeetingProposal } from '../meetings/types.js';
import { meetingParagraph } from '../inbound/meeting-paragraph.js';
import { VentanaCliente } from '../meetings/client-window.js';
import { Cualificacion } from '../crm/qualification.js';
import { sanitizeSubject } from '../inbound/suppression-list.js';
import { DEFAULT_COMPANY_DESCRIPTOR, DEFAULT_SENDER, escapeMarkdown } from './email-draft.js';
import { issues, parseJsonText, type Parsed } from './prospector-core.js';

// ---------------------------------------------------------------------------
// Rules checked by code
// ---------------------------------------------------------------------------

/** Urgency words the draft can never carry (commercial feedback: no pressure). */
export const FORBIDDEN_URGENCY_RE = /(?<![\p{L}])(plazos?|urgentes?|urgentemente|urgencias?|prisas?|deprisa)(?![\p{L}])/iu;
/** Prices, amounts and discounts: no data for them reaches the model, so any is invented. */
const PRICE_RE = /(€|(?<![\p{L}])eur(os)?(?![\p{L}])|\d+(?:[.,]\d+)?\s*%)/iu;
/** Links and addresses: only the code adds links (meeting paragraph, signature). */
const LINK_RE = /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.-]+|(?<![\p{L}])[\w-]+\.(com|es|net|org|info|eu|io)(?![\p{L}]))/iu;

/** Violations of the fixed rules in a text (empty = compliant). Messages in Spanish (repair prompt). */
export function replyRuleViolations(text: string): string[] {
  const out: string[] = [];
  const urgency = FORBIDDEN_URGENCY_RE.exec(text);
  if (urgency) out.push(`usa la palabra prohibida "${urgency[1]}" (no se puede escribir "plazo", "urgente", "prisa" ni sus variantes)`);
  const price = PRICE_RE.exec(text);
  if (price) out.push(`incluye un importe o un descuento ("${price[0]}"): no hay precios en los datos, promete enviarlos`);
  const link = LINK_RE.exec(text);
  if (link) out.push(`incluye un enlace o una dirección ("${link[0]}"): no escribas enlaces ni direcciones`);
  return out;
}

// ---------------------------------------------------------------------------
// Model answer
// ---------------------------------------------------------------------------

export const ReplyDraftAnswer = z.object({
  cuerpo: z.string().trim().min(20).max(4_000),
  confirma_fecha_cliente: z.boolean().optional().default(false),
  /**
   * Tanda 23 (skill v2, marker REPLY_WINDOW_MARKER): when the client wants the meeting, in closed
   * categories; the dates are computed by code (src/meetings/client-window.ts). Lenient: a bad
   * value is dropped (null), it never invalidates the draft.
   */
  ventana_cliente: VentanaCliente.nullable().optional().catch(null),
  /**
   * Tanda 23 (skill v2, marker REPLY_QUALIFICATION_MARKER): qualification data, each with its
   * literal quote; validated against the client's text by code (src/crm/qualification.ts).
   */
  cualificacion: Cualificacion.nullable().optional().catch(null),
});
export type ReplyDraftAnswer = z.infer<typeof ReplyDraftAnswer>;

export function parseReplyDraft(text: string): Parsed<ReplyDraftAnswer> {
  const json = parseJsonText(text);
  if (!json.ok) return json;
  const parsed = ReplyDraftAnswer.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  const violations = replyRuleViolations(parsed.data.cuerpo);
  if (violations.length > 0) return { ok: false, error: `cuerpo: ${violations.join('; ')}` };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

export interface ReplySender {
  name: string;
  company: string;
  /** What the company is, in the signature line: «PubliEXPE · expertos en merchandising…». */
  descriptor: string;
  web: string | null;
}

export const DEFAULT_REPLY_SENDER: ReplySender = {
  name: DEFAULT_SENDER.name,
  company: DEFAULT_SENDER.company,
  descriptor: DEFAULT_COMPANY_DESCRIPTOR,
  web: 'www.publiexpe.com',
};

/** Signature lines after the name: «PubliEXPE · expertos en merchandising para empresas», web. */
export function replySignatureLines(s: ReplySender): string[] {
  return [`${s.company} · ${s.descriptor}`, ...(s.web ? [s.web] : [])];
}

/** «Re: <subject of the client's message>» (one «Re:», plain text, bounded). */
export function replySubject(incoming: string, fallback: string | null = null): string {
  let s = sanitizeSubject(incoming, 150);
  if (!s && fallback) s = sanitizeSubject(fallback, 150);
  s = s.replace(/^((re|rv|fw|fwd|aw)\s*:\s*)+/i, '').trim();
  return `Re: ${s || 'tu respuesta'}`;
}

export interface FinalizeReplyOptions {
  sender: ReplySender;
  /** First name of the person, when known (From header / Person in Twenty). */
  personFirstName: string | null;
  companyName: string;
  incomingSubject: string;
  sendSubject: string | null;
  proposal: MeetingProposal;
  timeZone?: string;
}

export interface FinalReplyDraft {
  subject: string;
  /** Full body ready to paste: text + meeting paragraph + farewell + signature. */
  body: string;
  meeting: { source: MeetingProposal['source']; slots: string[]; clientProposedTime: boolean; windowRelaxed?: boolean };
  fixes: Array<'markdown_removed' | 'closing_removed' | 'greeting_name_removed'>;
  warnings: string[];
}

const FAREWELL_LINE_RE = /^(un saludo|saludos|un abrazo|atentamente|un cordial saludo|cordialmente|quedo a (tu|vuestra) disposición|gracias de nuevo|muchas gracias)[\s,.:!]*$/i;
const GREETING_RE = /^(hola|buenos días|buenas tardes|buenas|estimad[oa]s?)([\s,]+)(.*)$/i;
const NAME_TOKEN_RE = /^([A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+)/;

function tokens(...names: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const t of (n ?? '').split(/[\s,.;:()-]+/)) if (t.length > 0) out.add(t.toLowerCase());
  return out;
}

/**
 * Builds the final reply. Guarantees, whatever the model returned: the meeting paragraph built
 * by code from the proposal, one farewell and the signature with what PubliEXPE is at the end,
 * no closing or signature written by the model, no invented name in the greeting.
 */
export function finalizeReplyDraft(answer: ReplyDraftAnswer, opts: FinalizeReplyOptions): FinalReplyDraft {
  const fixes: FinalReplyDraft['fixes'] = [];
  const warnings: string[] = [];
  const raw = answer.cuerpo.replace(/\r\n?/g, '\n').trim();
  const text = raw
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (text !== raw) fixes.push('markdown_removed');
  const lines = text.split('\n');

  // Closing / signature the model wrote anyway: the code adds its own.
  const name = opts.sender.name.toLowerCase();
  const company = opts.sender.company.toLowerCase();
  let removed = false;
  for (let guard = 0; guard < 8 && lines.length > 0; guard++) {
    const last = lines[lines.length - 1]!.trim();
    const l = last.toLowerCase();
    if (last === '') lines.pop();
    else if (FAREWELL_LINE_RE.test(last) || ((l.startsWith(name) || l.startsWith(company)) && last.length <= 80 && !/[?]/.test(last))) {
      lines.pop();
      removed = true;
    } else break;
  }
  if (removed) fixes.push('closing_removed');

  // Greeting: a capitalised word that is not the known person / company is an invented name.
  const gi = lines.findIndex((l) => l.trim().length > 0);
  if (gi >= 0) {
    const m = GREETING_RE.exec(lines[gi]!.trim());
    const candidate = m ? NAME_TOKEN_RE.exec(m[3] ?? '')?.[1] : undefined;
    if (candidate && !tokens(opts.personFirstName, opts.companyName, 'equipo', 'PubliEXPE').has(candidate.toLowerCase())) {
      lines[gi] = opts.personFirstName ? `Hola, ${opts.personFirstName}:` : 'Hola:';
      fixes.push('greeting_name_removed');
      warnings.push('el saludo nombraba a una persona que no consta; se ha sustituido por un saludo genérico');
    }
  }

  const clientProposedTime = answer.confirma_fecha_cliente === true;
  const meeting = meetingParagraph(opts.proposal, { clientProposedTime, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) });
  const body = [...lines, '', ...meeting.lines, '', 'Un saludo,', '', opts.sender.name, ...replySignatureLines(opts.sender)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Belt and braces: the code parts never carry an urgency word either.
  if (FORBIDDEN_URGENCY_RE.test(body)) warnings.push('el borrador contiene una palabra de urgencia: revísalo');
  return {
    subject: replySubject(opts.incomingSubject, opts.sendSubject),
    body,
    meeting: { source: meeting.source, slots: meeting.slots, clientProposedTime, ...(opts.proposal.windowRelaxed && meeting.source === 'calendar' ? { windowRelaxed: true } : {}) },
    fixes,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Markdown for Twenty (Task 📬 body and 📬 note)
// ---------------------------------------------------------------------------

export const REPLY_DRAFT_SECTION_TITLE = 'Borrador de respuesta';
export const REPLY_DRAFT_HEADER = 'BORRADOR — revísalo, edítalo si quieres y envíalo tú respondiendo en el mismo hilo (desde Twenty o el webmail). El sistema no envía nada.';

const MEETING_SOURCE_LABEL: Record<MeetingProposal['source'], string> = {
  calendar: 'huecos libres de tu agenda',
  link: 'enlace de reserva',
  none: 'sin agenda conectada: el borrador pregunta qué día y hora le viene bien',
};

/** Plain text as markdown: escaped, one hard line break per line (lists and signature keep their lines). */
function plainBlock(text: string): string {
  return escapeMarkdown(text)
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : `${l}  `))
    .join('\n');
}

/** One line of text, escaped for markdown (the reason may quote a validation error). */
const inlineText = (s: string) => escapeMarkdown(s.replace(/\s+/g, ' ').trim());

const plainValue = (s: string) => s.replace(/[`*_[\]()<>|~#\\]/g, '').replace(/\s+/g, ' ').trim();

/** Header line of the section; also the marker that makes the append to a reused task idempotent. */
export function replyDraftSectionTitle(receivedLocal: string): string {
  return `### ${REPLY_DRAFT_SECTION_TITLE} (a la respuesta del ${receivedLocal})`;
}

export type ReplyDraftOutcome =
  | { status: 'created'; draft: FinalReplyDraft; to: string; meetingIntent: boolean }
  | { status: 'failed'; reason: string; meetingIntent: boolean };

/** The «Borrador de respuesta» section of the Task 📬 (or the «no disponible» line). */
export function replyDraftSection(o: ReplyDraftOutcome, receivedLocal: string): string {
  if (o.status === 'failed') return [replyDraftSectionTitle(receivedLocal), '', `Borrador no disponible: ${inlineText(o.reason)}. Escribe tú la contestación.`].join('\n');
  const d = o.draft;
  return [
    replyDraftSectionTitle(receivedLocal),
    '',
    `> **${REPLY_DRAFT_HEADER}**`,
    '',
    `**Para:** ${plainValue(o.to)}  `,
    `**Asunto:** ${escapeMarkdown(d.subject)}`,
    '',
    plainBlock(d.body),
    '',
    `_Propuesta de reunión: ${MEETING_SOURCE_LABEL[d.meeting.source]}${d.meeting.clientProposedTime ? '; el borrador acepta el día y la hora que propone el cliente, compruébalo en tu agenda' : ''}${d.meeting.windowRelaxed ? '; no había huecos libres en las fechas que pide el cliente, así que se proponen los más próximos' : ''}. Lo ha redactado un modelo de lenguaje: comprueba los datos antes de enviarlo._`,
    ...(d.warnings.length > 0 ? ['', `_Avisos: ${escapeMarkdown(d.warnings.join('; '))}._`] : []),
  ].join('\n');
}

/** The same information, summarised, for the 📬 note of the reply. */
export function replyDraftNoteSection(o: ReplyDraftOutcome): string {
  if (o.status === 'failed') return `**${REPLY_DRAFT_SECTION_TITLE}:** no disponible (${inlineText(o.reason)}).`;
  return [
    `**${REPLY_DRAFT_SECTION_TITLE}** (completo en la tarea de esta respuesta; el sistema no envía nada):`,
    '',
    `**Asunto:** ${escapeMarkdown(o.draft.subject)}`,
    '',
    plainBlock(o.draft.body),
  ].join('\n');
}
