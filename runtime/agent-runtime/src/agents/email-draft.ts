/**
 * Pure pieces of the EmailDrafter (no I/O, unit tested): the zod contract of the model
 * answer, the post-processing that GUARANTEES the sender identification and the LSSI
 * unsubscribe line, and the markdown of the Twenty note.
 *
 * Nothing here sends email. The draft is text for a human to copy into their mailbox or, in
 * the send-from-Twenty flow, to review in the hypothesis fields and send themselves.
 */
import { z } from 'zod';
import { parseWith, type Parsed } from './prospector-core.js';

// ---------------------------------------------------------------------------
// Model answer
// ---------------------------------------------------------------------------

export const EmailDraftAnswer = z.object({
  asunto: z.string().trim().min(3).max(200),
  cuerpo: z.string().trim().min(40).max(5000),
});
export type EmailDraftAnswer = z.infer<typeof EmailDraftAnswer>;

export function parseEmailDraft(text: string): Parsed<EmailDraftAnswer> {
  return parseWith(EmailDraftAnswer, text);
}

// ---------------------------------------------------------------------------
// Sender and compliance constants
// ---------------------------------------------------------------------------

export interface SenderConfig {
  name: string;
  company: string;
  /** Main cold-outreach mailbox (LLD v0.1 section 10.1). */
  email: string;
  /** Second identity of the same real sender. */
  altEmail: string | null;
  /** Signature lines after the name (company line, web). */
  signatureLines: string[];
  /** Unsubscribe mailbox (LSSI art. 21). */
  unsubscribeEmail: string;
}

export const DEFAULT_SENDER: SenderConfig = {
  name: 'Jesús Abril',
  company: 'PubliEXPE',
  email: 'jesus.abril@publiexpe.info',
  altEmail: 'j.abril@publiexpe.info',
  signatureLines: ['PubliEXPE · Merchandising y regalo promocional personalizado', 'www.publiexpe.com'],
  unsubscribeEmail: 'baja@publiexpe.info',
};

/** The mandatory last line of every draft (LSSI art. 21: a simple way to opt out). */
export function unsubscribeLine(sender: Pick<SenderConfig, 'unsubscribeEmail'>): string {
  return `Si no quieres recibir más mensajes, respóndeme o escribe a ${sender.unsubscribeEmail}`;
}

export const WORD_RANGE = { min: 120, max: 180 } as const;

/**
 * What PubliEXPE is, in a few words (brand manual: "merchandising para empresas"). A cold
 * reader does not know the company, so its first mention in the body must say what it does.
 */
export const DEFAULT_COMPANY_DESCRIPTOR = 'expertos en merchandising para empresas';

// ---------------------------------------------------------------------------
// Lead time (tanda 18): how far the event is, computed by code for the prompt
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Whole days from `today` to `eventDate` (both `YYYY-MM-DD…`; UTC calendar days). Null without a parsable date. */
export function daysUntilEvent(eventDate: string | null | undefined, today: string): number | null {
  const e = ISO_DATE_RE.exec(eventDate ?? '');
  const t = ISO_DATE_RE.exec(today);
  if (!e || !t) return null;
  const utc = (m: RegExpExecArray) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((utc(e) - utc(t)) / 86_400_000);
  return Number.isFinite(days) ? days : null;
}

/** The lead time in words: «12 días», «unas 6 semanas», «unos 3 meses» (null for a past event). */
export function leadTimeLabel(days: number): string | null {
  if (days < 0) return null;
  if (days < 14) return days === 1 ? '1 día' : `${days} días`;
  if (days < 60) return `unas ${Math.round(days / 7)} semanas`;
  return `unos ${Math.round(days / 30.44)} meses`;
}

export interface DraftLeadTime {
  days: number;
  /** null when the event already took place. */
  label: string | null;
}

/** Lead time for the drafter prompt; null when the signal has no usable date. */
export function draftLeadTime(eventDate: string | null | undefined, today: string): DraftLeadTime | null {
  const days = daysUntilEvent(eventDate, today);
  return days === null ? null : { days, label: leadTimeLabel(days) };
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

export interface FinalizeOptions {
  sender: SenderConfig;
  companyName: string;
  /** Known contact (decision maker of the hypothesis), or null. */
  contact: { firstName: string | null; lastName: string | null } | null;
  wordRange?: { min: number; max: number };
  /** Inserted after the first mention of the company when that sentence does not say what it is. */
  companyDescriptor?: string;
}

export interface FinalDraft {
  subject: string;
  /** Full body ready to paste: text + signature + unsubscribe line. */
  body: string;
  /** Words of the text written by the model (without signature and unsubscribe line). */
  wordCount: number;
  /** What the code fixed or added. */
  fixes: Array<
    | 'unsubscribe_line_added'
    | 'unsubscribe_line_replaced'
    | 'signature_added'
    | 'farewell_added'
    | 'greeting_name_removed'
    | 'markdown_removed'
    | 'company_descriptor_added'
  >;
  warnings: string[];
}

const FAREWELL_RE = /^(un saludo|saludos|un abrazo|atentamente|muchas gracias|gracias|quedo a tu disposición|un cordial saludo|cordialmente)\b/i;
/** Lines that look like an opt-out / privacy line the model wrote on its own. */
const OPT_OUT_RE = /(baja@|darte de baja|darse de baja|dar de baja|no quieres recibir|no deseas recibir|unsubscribe|protección de datos|rgpd|lssi)/i;
const GREETING_RE = /^(hola|buenos días|buenas tardes|buenas|estimad[oa]s?|querid[oa]s?)([\s,]+)(.*)$/i;
const NAME_TOKEN_RE = /^([A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+)/;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function normaliseText(raw: string): { text: string; markdownRemoved: boolean } {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const before = text;
  text = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { text, markdownRemoved: text !== before };
}

function tokens(...names: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const t of (n ?? '').split(/[\s,.;:()-]+/)) if (t.length > 0) out.add(t.toLowerCase());
  return out;
}

/** Without a known contact, a capitalised word right after the greeting is an invented name. */
function fixGreeting(lines: string[], opts: FinalizeOptions): boolean {
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx < 0) return false;
  const line = lines[idx]!.trim();
  const m = GREETING_RE.exec(line);
  if (!m) return false;
  const rest = m[3] ?? '';
  const name = NAME_TOKEN_RE.exec(rest)?.[1];
  if (!name) return false;
  const allowed = tokens(opts.companyName, opts.contact?.firstName, opts.contact?.lastName, 'equipo', 'PubliEXPE');
  if (allowed.has(name.toLowerCase())) return false;
  const first = opts.contact?.firstName?.trim();
  lines[idx] = first ? `Hola, ${first}:` : 'Hola:';
  return true;
}

/** Index of the signature line (the sender name on its own, optionally with a short tail) among the last lines, or -1. */
function signatureIndex(lines: string[], sender: SenderConfig): number {
  const name = sender.name.toLowerCase();
  for (let i = Math.max(0, lines.length - 6); i < lines.length; i++) {
    const l = lines[i]!.trim().toLowerCase();
    if (l.startsWith(name) && l.length <= name.length + 20 && !/[.?!]$/.test(l)) return i;
  }
  return -1;
}

function hasSignature(lines: string[], sender: SenderConfig): boolean {
  return signatureIndex(lines, sender) >= 0;
}

/** Words that already say what the company does: the brand descriptor or a natural variant. */
const DESCRIPTOR_RE = /(merchandising|regalos?\s+(promocional|publicitari|corporativ|de empresa)|art[ií]culos?\s+(promocional|publicitari)|productos?\s+promocional)/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The receiver of a cold email does not know the company: its FIRST mention in the body
 * (before any signature the model wrote) must say what it is, in the same sentence. When it
 * does not, `", {descriptor}"` is inserted right after that mention
 * ("Soy Jesús Abril, de PubliEXPE." -> "Soy Jesús Abril, de PubliEXPE, expertos en
 * merchandising para empresas."). A body that never names the company is left alone (the
 * signature identifies it). Domains and addresses (www.publiexpe.com) are not mentions.
 */
function ensureCompanyDescriptor(lines: string[], company: string, descriptor: string, sender: SenderConfig): boolean {
  if (company.trim().length === 0 || descriptor.trim().length === 0) return false;
  const mention = new RegExp(`(?<![\\w.@/-])${escapeRegExp(company.trim())}(?![\\w@-]|\\.\\w)`, 'i');
  const sig = signatureIndex(lines, sender);
  const end = sig >= 0 ? sig : lines.length;
  for (let i = 0; i < end; i++) {
    const line = lines[i]!;
    const m = mention.exec(line);
    if (!m) continue;
    const at = m.index;
    const after = at + m[0].length;
    // The sentence that holds the mention: from the previous terminator to the next one.
    const start = Math.max(line.lastIndexOf('.', at - 1), line.lastIndexOf('!', at - 1), line.lastIndexOf('?', at - 1)) + 1;
    const rest = line.slice(after).search(/[.!?](\s|$)/);
    const sentence = line.slice(start, rest < 0 ? line.length : after + rest);
    if (DESCRIPTOR_RE.test(sentence) || sentence.toLowerCase().includes(descriptor.trim().toLowerCase())) return false;
    const next = line.charAt(after);
    const insert = next === '' || /[.,;:!?)]/.test(next) ? `, ${descriptor.trim()}` : `, ${descriptor.trim()},`;
    lines[i] = line.slice(0, after) + insert + line.slice(after);
    return true;
  }
  return false;
}

/**
 * Builds the final body. Guarantees, whatever the model returned:
 * - the last line is exactly `unsubscribeLine(sender)` (any opt-out line the model wrote is
 *   removed first, so it appears once and with the canonical wording);
 * - the sender is identified: signature with name, company and web before that line;
 * - the first mention of the company in the body says what it is (`companyDescriptor`);
 * - without a known contact, no invented person name in the greeting.
 */
export function finalizeDraft(answer: EmailDraftAnswer, opts: FinalizeOptions): FinalDraft {
  const fixes: FinalDraft['fixes'] = [];
  const warnings: string[] = [];
  const range = opts.wordRange ?? WORD_RANGE;

  const { text, markdownRemoved } = normaliseText(answer.cuerpo);
  if (markdownRemoved) fixes.push('markdown_removed');
  let lines = text.split('\n');

  const optOut = lines.filter((l) => OPT_OUT_RE.test(l));
  if (optOut.length > 0) {
    lines = lines.filter((l) => !OPT_OUT_RE.test(l));
    fixes.push('unsubscribe_line_replaced');
  } else {
    fixes.push('unsubscribe_line_added');
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  if (fixGreeting(lines, opts)) {
    fixes.push('greeting_name_removed');
    warnings.push('el saludo nombraba a una persona que no consta en la hipótesis; se ha sustituido por un saludo genérico');
  }

  if (ensureCompanyDescriptor(lines, opts.sender.company, opts.companyDescriptor ?? DEFAULT_COMPANY_DESCRIPTOR, opts.sender)) {
    fixes.push('company_descriptor_added');
  }

  const wordCount = countWords(lines.join('\n'));
  if (wordCount < range.min || wordCount > range.max) warnings.push(`el cuerpo tiene ${wordCount} palabras (objetivo ${range.min}-${range.max})`);

  if (!hasSignature(lines, opts.sender)) {
    const last = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
    if (!FAREWELL_RE.test(last.trim())) {
      lines.push('', 'Un saludo,');
      fixes.push('farewell_added');
    }
    lines.push('', opts.sender.name, ...opts.sender.signatureLines);
    fixes.push('signature_added');
  }

  lines.push('', unsubscribeLine(opts.sender));
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const subject = answer.asunto
    .replace(/\s+/g, ' ')
    .replace(/^(asunto|subject)\s*:\s*/i, '')
    .replace(/[.\s]+$/, '')
    .replace(/^["'«“]+|["'»”]+$/g, '')
    .trim()
    .slice(0, 120);
  if (subject.length > 70) warnings.push(`el asunto tiene ${subject.length} caracteres (objetivo máx. 70)`);

  return { subject, body, wordCount, fixes, warnings };
}

// ---------------------------------------------------------------------------
// Twenty note
// ---------------------------------------------------------------------------

export const DRAFT_NOTE_HEADER = 'BORRADOR — revísalo y envíalo desde tu correo; el sistema no envía nada.';

export function draftNoteTitle(hypothesisName: string): string {
  return `Borrador email — ${hypothesisName}`;
}

/** Backslash-escapes what markdown would interpret in plain text (rendered back as the same characters). */
export function escapeMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/([\\`*_[\]<>~|])/g, '\\$1')
        .replace(/^(\s*)([#+-])/, '$1\\$2')
        .replace(/^(\s*\d+)([.)])/, '$1\\$2'),
    )
    .join('\n');
}

export interface DraftNoteInput {
  draft: Pick<FinalDraft, 'subject' | 'body' | 'warnings'>;
  sender: SenderConfig;
  contact: { firstName: string | null; lastName: string | null; jobTitle: string | null; email: string | null } | null;
  hypothesisName: string;
  feedback: string | null;
  evaluatedAt: string | null;
  executionId: string;
  /** The same draft was written into the hypothesis email fields (send-from-Twenty flow). */
  inHypothesisFields?: boolean;
  /** Recipient found by the ContactFinder on the company's web (no decision maker with email). */
  foundContact?: { email: string; sourceUrl: string | null; written: boolean } | null;
}

/** Paragraph added to the note when the draft is also in the hypothesis fields. */
export const DRAFT_IN_FIELDS_HINT =
  'También está en los campos Email de la hipótesis. Si tu buzón está conectado en Twenty, revísalo y edítalo allí, cambia Email status a Reviewed y pulsa «Enviar borrador de email» en la hipótesis: lo envías tú, desde tu buzón. Si editas el texto, edítalo en la hipótesis, no en esta nota.';

export function buildDraftNoteMarkdown(input: DraftNoteInput): string {
  const { draft, sender, contact } = input;
  const from = `${sender.name} <${sender.email}>${sender.altEmail ? ` (o ${sender.altEmail})` : ''}`;
  const contactName = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : '';
  const found = input.foundContact ?? null;
  const foundText = found
    ? `<${found.email}> (encontrado por el sistema${found.sourceUrl ? ` en ${found.sourceUrl}` : ''}; consulta el Research «Contacto» y revísalo antes de enviar)`
    : null;
  const to = contact
    ? `${escapeMarkdown(contactName || 'Contacto')}${contact.jobTitle ? `, ${escapeMarkdown(contact.jobTitle)}` : ''}${contact.email ? ` <${contact.email}>` : foundText ? ` ${foundText}` : ' (sin email en el CRM: añádelo tú)'}`
    : (foundText ?? 'añade tú el destinatario (la hipótesis no tiene persona de contacto; usa una dirección corporativa de rol)');
  const verdict = input.feedback ? `veredicto ${input.feedback}${input.evaluatedAt ? ` del ${input.evaluatedAt.slice(0, 10)}` : ''}` : 'petición manual';
  const lines = [
    `> **${DRAFT_NOTE_HEADER}**`,
    '',
    `**De:** ${escapeMarkdown(from)}`,
    `**Para:** ${to}`,
    `**Asunto:** ${escapeMarkdown(draft.subject)}`,
    '',
    '---',
    '',
    escapeMarkdown(draft.body),
    '',
    '---',
    '',
    `_Borrador preparado a partir de la hipótesis «${escapeMarkdown(input.hypothesisName)}» (${verdict}). Lo ha redactado un modelo de lenguaje: comprueba los datos antes de enviarlo. Ejecución ${input.executionId}._`,
  ];
  if (draft.warnings.length > 0) lines.push('', `_Avisos: ${escapeMarkdown(draft.warnings.join('; '))}._`);
  if (input.inHypothesisFields) lines.push('', `_${escapeMarkdown(DRAFT_IN_FIELDS_HINT)}_`);
  return lines.join('\n');
}
