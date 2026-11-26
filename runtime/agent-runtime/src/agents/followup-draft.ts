/**
 * Pure pieces of the follow-up draft (tanda 23, skill `email-followup-draft`): the zod contract of
 * the model answer, the rules checked BY CODE and the markdown of the «Borrador del seguimiento»
 * section of the Task. The urgency / price / link rules and the post-processing (subject
 * «Re: …», meeting paragraph, farewell, signature) are the ones of the reply draft
 * (src/agents/reply-draft.ts), reused as they are; the follow-up adds «no reproaches» and a length
 * bound per mode.
 *
 * Nothing here sends anything: the draft is text for the commercial to review and send himself.
 */
import { z } from 'zod';
import type { MeetingProposal } from '../meetings/types.js';
import { escapeMarkdown } from './email-draft.js';
import { readableField } from '../integrations/twenty/messages.js';
import type { FollowUpDraftMode } from './followup-draft-prompt.js';
import { issues, parseJsonText, type Parsed } from './prospector-core.js';
import { finalizeReplyDraft, replyRuleViolations, type FinalReplyDraft, type ReplySender } from './reply-draft.js';

/** Reproaches the follow-up can never carry («no has contestado», «sigo sin noticias»…). */
export const REPROACH_RE = /(no (me )?(has|habéis|ha|han) (contestado|respondido)|sin (respuesta|noticias)|no he (recibido|tenido) (respuesta|noticias)|no (he )?sé nada|como no (me )?(contestas|respondes|contestaste|respondiste))/iu;

/** Word bounds of the model's text per mode (the code parts are not counted). */
export const FOLLOWUP_WORDS: Record<FollowUpDraftMode, { min: number; max: number }> = {
  recordatorio: { min: 15, max: 140 },
  cierre: { min: 8, max: 80 },
  conversacion: { min: 15, max: 140 },
};

const words = (s: string) => s.split(/\s+/).filter((w) => w.length > 0).length;

/** Violations of the fixed rules in the model's text (empty = compliant). Spanish (repair prompt). */
export function followUpRuleViolations(text: string, mode: FollowUpDraftMode): string[] {
  const out = replyRuleViolations(text);
  const reproach = REPROACH_RE.exec(text);
  if (reproach) out.push(`contiene un reproche ("${reproach[0]}"): no digas que no ha contestado ni que sigues sin noticias`);
  const n = words(text);
  const b = FOLLOWUP_WORDS[mode];
  if (n > b.max) out.push(`es demasiado largo (${n} palabras; como mucho ${b.max} en el modo ${mode})`);
  if (n < b.min) out.push(`es demasiado corto (${n} palabras; al menos ${b.min})`);
  return out;
}

export const FollowUpDraftAnswer = z.object({ cuerpo: z.string().trim().min(20).max(2_000) });
export type FollowUpDraftAnswer = z.infer<typeof FollowUpDraftAnswer>;

export function parseFollowUpDraft(mode: FollowUpDraftMode): (text: string) => Parsed<FollowUpDraftAnswer> {
  return (text: string) => {
    const json = parseJsonText(text);
    if (!json.ok) return json;
    const parsed = FollowUpDraftAnswer.safeParse(json.value);
    if (!parsed.success) return { ok: false, error: issues(parsed.error) };
    const violations = followUpRuleViolations(parsed.data.cuerpo, mode);
    if (violations.length > 0) return { ok: false, error: `cuerpo: ${violations.join('; ')}` };
    return { ok: true, value: parsed.data };
  };
}

export interface FinalizeFollowUpOptions {
  sender: ReplySender;
  personFirstName: string | null;
  companyName: string;
  /** Subject of the email answered in the thread (the first send / our last email). */
  threadSubject: string | null;
  proposal: MeetingProposal;
  timeZone?: string;
}

/** A subject usable for «Re: …»: a non-empty string that is not a Twenty restricted-field marker. */
export function readableSubject(s: string | null | undefined): string | null {
  const v = readableField(s)?.trim() ?? '';
  return v.length > 0 ? v : null;
}

/** Subject when the thread has none readable. */
export function followUpFallbackSubject(company: string): string {
  const c = company.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  return `Seguimiento: ${c || 'nuestra conversación'}`;
}

/** Subject «Re: <asunto>», meeting paragraph, farewell and signature by code (reply-draft.ts). */
export function finalizeFollowUpDraft(answer: FollowUpDraftAnswer, opts: FinalizeFollowUpOptions): FinalReplyDraft {
  const subject = readableSubject(opts.threadSubject);
  const draft = finalizeReplyDraft(
    { cuerpo: answer.cuerpo, confirma_fecha_cliente: false },
    { sender: opts.sender, personFirstName: opts.personFirstName, companyName: opts.companyName, incomingSubject: subject ?? '', sendSubject: null, proposal: opts.proposal, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) },
  );
  // No readable subject (none recorded, or masked by Twenty): «Seguimiento: <empresa>», and the
  // Task asks to answer in the existing thread. Never a «Re:» built from a masked value.
  if (!readableSubject(opts.threadSubject)) draft.subject = followUpFallbackSubject(opts.companyName);
  if (REPROACH_RE.test(draft.body)) draft.warnings.push('el borrador contiene un reproche: revísalo');
  return draft;
}

export type FollowUpDraftOutcome = { status: 'created'; draft: FinalReplyDraft; to: string; mode: FollowUpDraftMode } | { status: 'failed'; reason: string; mode: FollowUpDraftMode };

export const FOLLOWUP_DRAFT_SECTION_TITLE = 'Borrador del seguimiento';
export const FOLLOWUP_DRAFT_HEADER = 'BORRADOR — revísalo, edítalo si quieres y envíalo tú respondiendo en el mismo hilo (desde Twenty o el webmail). El sistema no envía nada.';

const MEETING_SOURCE_LABEL: Record<MeetingProposal['source'], string> = {
  calendar: 'huecos libres de tu agenda',
  link: 'enlace de reserva',
  none: 'sin agenda conectada: el borrador pregunta qué día y hora le viene bien',
};

const MODE_LABEL: Record<FollowUpDraftMode, string> = {
  recordatorio: 'recordatorio con un ángulo nuevo',
  cierre: 'cierre amable',
  conversacion: 'retomar la conversación',
};

function plainBlock(text: string): string {
  return escapeMarkdown(text)
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : `${l}  `))
    .join('\n');
}

const inlineText = (s: string) => escapeMarkdown(s.replace(/\s+/g, ' ').trim());
const plainValue = (s: string) => s.replace(/[`*_[\]()<>|~#\\]/g, '').replace(/\s+/g, ' ').trim();

/** The «Borrador del seguimiento» section of the Task (or the «no disponible» line). */
export function followUpDraftSection(o: FollowUpDraftOutcome): string {
  const title = `### ${FOLLOWUP_DRAFT_SECTION_TITLE} (${MODE_LABEL[o.mode]})`;
  if (o.status === 'failed') return [title, '', `Borrador no disponible: ${inlineText(o.reason)}. Usa el guion de abajo.`].join('\n');
  const d = o.draft;
  return [
    title,
    '',
    `> **${FOLLOWUP_DRAFT_HEADER}**`,
    '',
    `**Para:** ${plainValue(o.to)}  `,
    `**Asunto:** ${escapeMarkdown(d.subject)}`,
    '',
    plainBlock(d.body),
    '',
    `_Propuesta de reunión: ${MEETING_SOURCE_LABEL[d.meeting.source]}. Lo ha redactado un modelo de lenguaje: comprueba los datos antes de enviarlo._`,
    ...(d.warnings.length > 0 ? ['', `_Avisos: ${escapeMarkdown(d.warnings.join('; '))}._`] : []),
  ].join('\n');
}
