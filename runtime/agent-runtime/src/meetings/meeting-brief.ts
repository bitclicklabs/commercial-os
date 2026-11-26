/**
 * «Ficha previa» of a meeting (tanda 24, skill `meeting-brief`): pure pieces, no I/O.
 *
 * - The zod contract of the model answer (closed JSON) and the rules checked BY CODE: a
 *   conversation bullet that states something of the client is kept only when its quote is
 *   LITERALLY in an email of the client of that day (`findQuoteInText`: tildes, case, quote marks
 *   and «¿¡» are folded on BOTH sides to compare; the quote shown is the email's original text);
 *   any text with a price / amount, a link or an urgency word is dropped (rules of
 *   src/agents/reply-draft.ts); «quién» and «origen» invalid -> the answer is invalid (repair).
 * - The data of the opportunity (stage, amount, close date) and the qualification data come from
 *   the CRM and are rendered BY CODE: the model never writes them.
 * - The markdown of the section «Ficha previa (reunión del …)» of the Task «Preparar reunión con
 *   X 🧾», of the minimal brief (LLM failed / no data) and of «Actualización — AAAA-MM-DD».
 *
 * Nothing here sends anything or writes the calendar (autonomy level 1).
 */
import { z } from 'zod';
import { replyRuleViolations } from '../agents/reply-draft.js';
import { issues, parseJsonText, type Parsed } from '../agents/prospector-core.js';
import { plainText } from '../crm/qualification.js';
import type { MeetingBriefMode } from '../agents/meeting-brief-prompt.js';

export const MEETING_BRIEF_AUDIT_ACTION = 'opportunity.meeting_brief';
export const MEETING_BRIEF_SECTION_TITLE = 'Ficha previa';
export const MEETING_BRIEF_UPDATE_TITLE = 'Actualización';
/** Bound of one rendered section (the task body is bounded by create_crm_task / append). */
export const MEETING_BRIEF_SECTION_MAX = 7_000;
export const BRIEF_ITEM_MAX = 250;
export const BRIEF_PARAGRAPH_MAX = 500;
export const BRIEF_QUOTE_MAX = 200;
export const BRIEF_BULLETS_MAX = 5;
export const BRIEF_QUESTIONS = 3;
export const BRIEF_AGENDA_MAX = 4;
export const BRIEF_BRING_MAX = 5;
export const BRIEF_GAPS_MAX = 5;
/** Qualification lines copied from the note (the newest). */
export const BRIEF_QUALIFICATION_LINES_MAX = 8;
/** Emails listed in the minimal brief (the newest). */
export const BRIEF_MINIMAL_EMAILS = 5;

// ---------------------------------------------------------------------------
// Context (what the code knows from the CRM and the mailbox)
// ---------------------------------------------------------------------------

export interface BriefEmail {
  id: string;
  direction: 'OUTBOUND' | 'INBOUND';
  subject: string | null;
  text: string | null;
  receivedAt: string;
  textRestricted: boolean;
}

export interface BriefContext {
  opportunity: { id: string; name: string | null; stage: string | null; amount: { value: number; currency: string } | null; closeDate: string | null };
  company: { id: string | null; name: string; domain: string | null };
  person: { name: string | null; jobTitle: string | null } | null;
  hypotheses: Array<{ id: string; name: string | null; need: string | null; whyNow: string | null; origin: string | null }>;
  qualificationNote: string | null;
}

// ---------------------------------------------------------------------------
// Model answer
// ---------------------------------------------------------------------------

const lenientList = z
  .array(z.unknown())
  .max(30)
  .optional()
  .catch([])
  .transform((xs) => (xs ?? []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length > 0));

const Bullet = z.object({
  fecha: z.string().trim().min(1).max(40),
  de: z.enum(['cliente', 'publiexpe']),
  texto: z.string().trim().min(3).max(1_000),
  cita: z.string().trim().max(1_000).nullable().optional(),
});
export type BriefBulletAnswer = z.infer<typeof Bullet>;

export const MeetingBriefAnswer = z.object({
  quien: z.string().trim().max(2_000).optional().default(''),
  origen: z.string().trim().max(2_000).optional().default(''),
  conversacion: z
    .array(z.unknown())
    .max(30)
    .optional()
    .catch([])
    .transform((xs) => (xs ?? []).map((x) => Bullet.safeParse(x)).flatMap((r) => (r.success ? [r.data] : []))),
  huecos: lenientList,
  preguntas_sugeridas: lenientList,
  agenda: lenientList,
  llevar: lenientList,
});
export type MeetingBriefAnswer = z.infer<typeof MeetingBriefAnswer>;

/** Accented letters and Spanish opening marks: a long Spanish text without any is ASCII-folded. */
const SPANISH_MARKS_RE = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/u;
/** Characters of model text from which a brief with no accent at all is considered folded. */
export const ORTHOGRAPHY_MIN_CHARS = 300;

/** All the text the model wrote (fields and list items). */
function answerText(a: MeetingBriefAnswer): string {
  return [a.quien, a.origen, ...a.conversacion.map((b) => b.texto), ...a.huecos, ...a.preguntas_sugeridas, ...a.agenda, ...a.llevar].join(' ');
}

/**
 * The answer, with «quién» / «origen» checked (mode `ficha`); the lists are filtered later.
 * Orthography (live test 2026-11-26: the model answered the whole brief without tildes, ñ or ¿):
 * the FIRST answer whose text is long and has no accented letter at all is sent back once with
 * the error; a second answer is accepted as it is (never blocks the brief). One parser per call.
 */
export function parseMeetingBrief(mode: MeetingBriefMode): (text: string) => Parsed<MeetingBriefAnswer> {
  let orthographyChecked = false;
  return (text: string) => {
    const json = parseJsonText(text);
    if (!json.ok) return json;
    const parsed = MeetingBriefAnswer.safeParse(json.value);
    if (!parsed.success) return { ok: false, error: issues(parsed.error) };
    const a = parsed.data;
    if (mode === 'ficha') {
      const errors: string[] = [];
      for (const [field, value] of [
        ['quien', a.quien],
        ['origen', a.origen],
      ] as const) {
        if (value.length < 5) errors.push(`${field}: falta (una o dos frases)`);
        else {
          const v = replyRuleViolations(value);
          if (v.length > 0) errors.push(`${field}: ${v.join('; ')}`);
        }
      }
      if (errors.length > 0) return { ok: false, error: errors.join(' | ') };
    }
    if (!orthographyChecked) {
      orthographyChecked = true;
      const all = answerText(a);
      if (all.length >= ORTHOGRAPHY_MIN_CHARS && !SPANISH_MARKS_RE.test(all)) {
        return { ok: false, error: 'el texto está escrito sin tildes, sin «ñ» y sin «¿»: reescribe TODOS los textos en español con su ortografía completa (tildes, ñ, ¿ y ¡) y copia las citas exactamente como aparecen en el correo' };
      }
    }
    return { ok: true, value: a };
  };
}

// ---------------------------------------------------------------------------
// Validation by code
// ---------------------------------------------------------------------------

export interface BriefBullet {
  date: string;
  from: 'cliente' | 'publiexpe';
  text: string;
  quote: string | null;
}

export interface ValidatedBrief {
  quien: string;
  origen: string;
  conversation: BriefBullet[];
  gaps: string[];
  questions: string[];
  agenda: string[];
  bring: string[];
  /** Items dropped by the code: bullets without a literal quote / outside the thread, rule violations. */
  discarded: { bullets: number; items: number };
}

/** Local day of an email (`AAAA-MM-DD`). */
const dayOf = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Text of an email as handed to the model (subject + body), for the literal-quote check. */
export function emailQuoteText(e: Pick<BriefEmail, 'subject' | 'text'>, max: number): string {
  const body = e.text ?? '';
  return `${e.subject ?? ''}\n${body.length <= max ? body : body.slice(0, max)}`;
}

/** One character folded for the quote comparison: no diacritics, lower case, no quote marks, no «¿¡». */
function foldChar(c: string): string {
  if (/[«»“”"„‘’`´']/u.test(c) || c === '¿' || c === '¡') return '';
  if (/\s/u.test(c)) return ' ';
  return c.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The folded text and, per folded character, the original index it comes from. */
function foldWithMap(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (const out of f) {
      if (out === ' ' && (folded.length === 0 || folded.endsWith(' '))) continue;
      folded += out;
      from.push(i);
      to.push(i + ch.length);
    }
    i += ch.length;
  }
  return { folded, from, to };
}

/** Folded form used for the comparison (both sides): `foldWithMap` without the map, edges trimmed. */
export function foldForQuote(s: string): string {
  return foldWithMap(s).folded.replace(/^[\s.,;:!?…-]+|[\s.,;:!?…-]+$/gu, '');
}

/** Minimum folded length of a quote (shorter ones prove nothing). */
export const BRIEF_QUOTE_MIN = 6;

/**
 * Finds the model's `quote` in `text` tolerating differences of tildes, case, quote marks and the
 * opening «¿¡» (both sides folded the same way). Returns the ORIGINAL span of `text` (with its
 * tildes and, when they surround it, its «¿…?» / «¡…!»), or null when it is not there.
 */
export function findQuoteInText(quote: string, text: string): string | null {
  const q = foldForQuote(quote);
  if (q.length < BRIEF_QUOTE_MIN || q.length > 600) return null;
  const t = foldWithMap(text);
  const at = t.folded.indexOf(q);
  if (at < 0) return null;
  let start = t.from[at]!;
  let end = t.to[at + q.length - 1]!;
  if (start > 0 && /[¿¡]/u.test(text[start - 1]!)) start -= 1;
  if (end < text.length && /[?!]/u.test(text[end]!)) end += 1;
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** «¿» in front of a question that ends with «?» and lacks it (Spanish punctuation). */
export function withOpeningQuestionMark(q: string): string {
  return q.trim().endsWith('?') && !q.includes('¿') ? `¿${q.trim()}` : q;
}

/**
 * Keeps what the code can stand behind: bullets on a day with an email of the thread and, when
 * they state something of the client, with a literal quote of a client email of that day; list
 * items without prices, links or urgency words. `emails` = the emails handed to the model.
 */
export function validateMeetingBrief(a: MeetingBriefAnswer, emails: readonly BriefEmail[], opts: { timeZone: string; emailTextMax: number }): ValidatedBrief {
  let bullets = 0;
  let items = 0;
  const days = new Map<string, BriefEmail[]>();
  for (const e of emails) {
    const d = dayOf(e.receivedAt, opts.timeZone);
    days.set(d, [...(days.get(d) ?? []), e]);
  }
  const conversation: BriefBullet[] = [];
  for (const b of a.conversacion) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(b.fecha)?.[0] ?? '';
    const sameDay = days.get(date) ?? [];
    const text = plainText(b.texto, BRIEF_ITEM_MAX);
    if (sameDay.length === 0 || text.length < 3 || replyRuleViolations(b.texto).length > 0) {
      bullets += 1;
      continue;
    }
    if (b.de === 'cliente') {
      const raw = b.cita ?? '';
      const inbound = sameDay.filter((e) => e.direction === 'INBOUND');
      // The quote shown is the client's original text, never the model's copy of it.
      const original = raw.length > 0 ? (inbound.map((e) => findQuoteInText(raw, emailQuoteText(e, opts.emailTextMax))).find((x): x is string => x !== null) ?? null) : null;
      if (!original) {
        bullets += 1;
        continue;
      }
      conversation.push({ date, from: 'cliente', text, quote: plainText(original, BRIEF_QUOTE_MAX) });
    } else conversation.push({ date, from: 'publiexpe', text, quote: null });
  }
  conversation.sort((x, y) => x.date.localeCompare(y.date));
  if (conversation.length > BRIEF_BULLETS_MAX) conversation.splice(0, conversation.length - BRIEF_BULLETS_MAX);

  const keep = (xs: string[], max: number, ok: (s: string) => boolean = () => true): string[] => {
    const out: string[] = [];
    for (const x of xs) {
      const t = plainText(x, BRIEF_ITEM_MAX);
      if (t.length < 3 || replyRuleViolations(x).length > 0 || !ok(t) || out.some((o) => o.toLowerCase() === t.toLowerCase())) {
        items += 1;
        continue;
      }
      if (out.length < max) out.push(t);
    }
    return out;
  };
  const clean = (s: string) => {
    const t = plainText(s, BRIEF_PARAGRAPH_MAX);
    return t.length >= 3 && replyRuleViolations(s).length === 0 ? t : '';
  };
  return {
    quien: clean(a.quien),
    origen: clean(a.origen),
    conversation,
    gaps: keep(a.huecos, BRIEF_GAPS_MAX),
    questions: keep(a.preguntas_sugeridas, BRIEF_QUESTIONS, (t) => t.includes('?')).map(withOpeningQuestionMark),
    agenda: keep(a.agenda, BRIEF_AGENDA_MAX),
    bring: keep(a.llevar, BRIEF_BRING_MAX),
    discarded: { bullets, items },
  };
}

// ---------------------------------------------------------------------------
// Qualification note (rendered by code, never by the model)
// ---------------------------------------------------------------------------

const QUALIFICATION_LINE_RE = /^\s*-\s+\*\*(.+?):\*\*\s*(.+?)\s*$/;

/** The data lines of the «Cualificación — X 🧾» note (`Etiqueta: valor — «cita»`), the newest last. */
export function qualificationLines(note: string | null | undefined): string[] {
  if (!note) return [];
  const out: string[] = [];
  for (const line of note.split('\n')) {
    const m = QUALIFICATION_LINE_RE.exec(line);
    if (!m) continue;
    const t = plainText(`${m[1]}: ${m[2]}`, BRIEF_ITEM_MAX);
    const i = out.findIndex((o) => o.toLowerCase() === t.toLowerCase());
    if (i >= 0) out.splice(i, 1);
    out.push(t);
  }
  return out.slice(-BRIEF_QUALIFICATION_LINES_MAX);
}

const QUALIFICATION_TOPICS: Array<{ label: string; gap: string }> = [
  { label: 'cantidad aproximada', gap: 'cantidad' },
  { label: 'presupuesto aproximado', gap: 'presupuesto' },
  { label: 'fecha necesaria', gap: 'fecha en la que lo necesitan' },
  { label: 'decisor', gap: 'quién decide' },
  { label: 'productos de interés', gap: 'qué productos' },
];

/** What the qualification note does not say yet (cantidad, presupuesto, fecha, decisor, productos). */
export function qualificationGaps(note: string | null | undefined): string[] {
  const lines = qualificationLines(note).map((l) => l.toLowerCase());
  return QUALIFICATION_TOPICS.filter((t) => !lines.some((l) => l.startsWith(`${t.label}:`))).map((t) => t.gap);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** `### Ficha previa (reunión del 2026-11-30 10:00)`: header and idempotency marker of the append. */
export function meetingBriefSectionTitle(meetingLocal: string | null): string {
  return `### ${MEETING_BRIEF_SECTION_TITLE}${meetingLocal ? ` (reunión del ${meetingLocal})` : ''}`;
}

/** `### Actualización — 2026-11-27`: one per day at most (header and marker). */
export function meetingBriefUpdateTitle(day: string): string {
  return `### ${MEETING_BRIEF_UPDATE_TITLE} — ${day}`;
}

const inline = (s: string | null | undefined, max = BRIEF_ITEM_MAX) => plainText(s ?? '', max);

const amountText = (a: BriefContext['opportunity']['amount']) =>
  a ? `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2, useGrouping: true }).format(a.value)} ${a.currency === 'EUR' ? '€' : inline(a.currency, 8)}` : null;

/** «Empresa / Contacto / Oportunidad» lines, from the CRM (by code). */
function crmLines(c: BriefContext): string[] {
  const person = c.person && (c.person.name || c.person.jobTitle) ? [inline(c.person.name) || 'sin nombre', ...(c.person.jobTitle ? [inline(c.person.jobTitle, 120)] : [])].join(', ') : null;
  const opp = [
    `etapa ${inline(c.opportunity.stage, 40) || 'sin etapa'}`,
    `importe ${amountText(c.opportunity.amount) ?? 'sin indicar'}`,
    `cierre ${c.opportunity.closeDate ? inline(c.opportunity.closeDate.slice(0, 10), 12) : 'sin fecha'}`,
  ].join(' · ');
  return [
    `**Empresa:** ${inline(c.company.name) || 'la empresa'}${c.company.domain ? ` (${inline(c.company.domain, 120)})` : ''}  `,
    `**Contacto:** ${person ?? 'sin punto de contacto en la oportunidad'}  `,
    `**Oportunidad (CRM):** ${opp}`,
  ];
}

function originLines(c: BriefContext): string[] {
  if (c.hypotheses.length === 0) return ['- Sin hipótesis enlazada en el CRM.'];
  return c.hypotheses.map((h) => {
    const parts = [
      ...(h.origin ? [`origen: ${inline(h.origin)}`] : []),
      ...(h.need ? [`necesidad: ${inline(h.need)}`] : []),
      ...(h.whyNow ? [`por qué ahora: ${inline(h.whyNow)}`] : []),
    ];
    return `- Hipótesis${h.name ? ` «${inline(h.name, 120)}»` : ''}${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`;
  });
}

function qualificationBlock(c: BriefContext): string[] {
  const lines = qualificationLines(c.qualificationNote);
  return lines.length > 0 ? lines.map((l) => `- ${l}`) : ['- Sin datos de cualificación todavía (no hay nota «Cualificación» con datos).'];
}

function emailLines(emails: readonly BriefEmail[], timeZone: string, max: number): string[] {
  if (emails.length === 0) return ['- No hay correos con el contacto en el buzón conectado.'];
  return emails.slice(-max).map((e) => `- ${dayOf(e.receivedAt, timeZone)} · ${e.direction === 'INBOUND' ? 'del cliente' : 'de PubliEXPE'} · ${e.subject ? inline(e.subject, 150) : e.textRestricted ? 'asunto no visible' : 'sin asunto'}`);
}

const numbered = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`);
const bulleted = (xs: string[]) => xs.map((x) => `- ${x}`);

/** Cuts a rendered section at a line boundary. */
function bound(md: string, max = MEETING_BRIEF_SECTION_MAX): string {
  if (md.length <= max) return md;
  const cut = md.slice(0, max - 2);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))}\n…`;
}

const bulletLine = (b: BriefBullet) => `- ${b.date} · ${b.from === 'cliente' ? 'cliente' : 'PubliEXPE'}: ${b.text}${b.quote ? ` — «${b.quote}»` : ''}`;

export const MEETING_BRIEF_FOOTER =
  '_Ficha preparada por un modelo de lenguaje con los datos del CRM y los correos con el contacto. Cada cita del cliente se ha comprobado en el texto de su correo; los datos de la oportunidad y de cualificación salen del CRM. Revísala antes de la reunión. No se ha enviado nada ni se ha tocado tu calendario._';

/** The full «Ficha previa» section. */
export function meetingBriefSection(c: BriefContext, v: ValidatedBrief, emails: readonly BriefEmail[], opts: { meetingLocal: string | null; timeZone: string }): string {
  const gaps = v.gaps.length > 0 ? v.gaps : qualificationGaps(c.qualificationNote).map((g) => `Falta saber: ${g}.`);
  const md = [
    meetingBriefSectionTitle(opts.meetingLocal),
    '',
    ...crmLines(c),
    '',
    '#### Quién',
    '',
    v.quien || 'Sin resumen.',
    '',
    '#### Cómo llegamos',
    '',
    ...(v.origen ? [v.origen, ''] : []),
    ...originLines(c),
    '',
    '#### Conversación',
    '',
    ...(v.conversation.length > 0 ? v.conversation.map(bulletLine) : emailLines(emails, opts.timeZone, BRIEF_MINIMAL_EMAILS)),
    '',
    '#### Datos de cualificación',
    '',
    ...qualificationBlock(c),
    '',
    '#### Huecos',
    '',
    ...(gaps.length > 0 ? bulleted(gaps) : ['- No falta ningún dato básico: confírmalos en la reunión.']),
    '',
    '#### Preguntas sugeridas',
    '',
    ...(v.questions.length > 0 ? numbered(v.questions) : ['- Sin preguntas sugeridas.']),
    '',
    '#### Agenda (30 min)',
    '',
    ...(v.agenda.length > 0 ? numbered(v.agenda) : ['- Sin agenda sugerida.']),
    '',
    '#### Qué llevar',
    '',
    ...(v.bring.length > 0 ? bulleted(v.bring) : ['- La propuesta o el correo que le enviamos y alguna idea de producto para su caso.']),
    '',
    ...(v.discarded.bullets > 0 ? [`_${v.discarded.bullets === 1 ? 'Se ha descartado 1 punto de la conversación' : `Se han descartado ${v.discarded.bullets} puntos de la conversación`} porque su cita no aparecía en los correos del cliente._`, ''] : []),
    MEETING_BRIEF_FOOTER,
  ].join('\n');
  return bound(md);
}

/** The minimal brief, by code (LLM failed, disabled or over the cap): never blocks the task. */
export function minimalMeetingBriefSection(c: BriefContext, emails: readonly BriefEmail[], opts: { meetingLocal: string | null; timeZone: string; reason: string }): string {
  const gaps = qualificationGaps(c.qualificationNote);
  const md = [
    meetingBriefSectionTitle(opts.meetingLocal),
    '',
    `_Ficha completa no disponible: ${inline(opts.reason, 300)}. Esta es la ficha mínima con los datos del CRM._`,
    '',
    ...crmLines(c),
    '',
    '#### Cómo llegamos',
    '',
    ...originLines(c),
    '',
    '#### Últimos correos con el contacto',
    '',
    ...emailLines(emails, opts.timeZone, BRIEF_MINIMAL_EMAILS),
    '',
    '#### Datos de cualificación',
    '',
    ...qualificationBlock(c),
    '',
    '#### Huecos',
    '',
    gaps.length > 0 ? `- Falta saber: ${gaps.join(', ')}.` : '- No falta ningún dato básico: confírmalos en la reunión.',
  ].join('\n');
  return bound(md);
}

/** «Actualización — AAAA-MM-DD»: what is new since the last brief (full, or minimal on failure). */
export function meetingBriefUpdateSection(
  day: string,
  newEmails: readonly BriefEmail[],
  v: ValidatedBrief | null,
  opts: { timeZone: string; reason?: string | null; qualificationNote?: string | null },
): string {
  const head = [meetingBriefUpdateTitle(day), '', `_${newEmails.length === 1 ? 'Hay 1 correo nuevo' : `Hay ${newEmails.length} correos nuevos`} con el contacto desde la última ficha._`, ''];
  if (!v) {
    return bound(
      [
        ...head,
        ...emailLines(newEmails, opts.timeZone, BRIEF_BULLETS_MAX),
        '',
        `_Resumen no disponible: ${inline(opts.reason ?? 'sin motivo', 300)}._`,
      ].join('\n'),
    );
  }
  const quals = qualificationLines(opts.qualificationNote);
  return bound(
    [
      ...head,
      '#### Conversación (nuevo)',
      '',
      ...(v.conversation.length > 0 ? v.conversation.map(bulletLine) : emailLines(newEmails, opts.timeZone, BRIEF_BULLETS_MAX)),
      '',
      ...(quals.length > 0 ? ['#### Datos de cualificación (al día)', '', ...quals.map((l) => `- ${l}`), ''] : []),
      ...(v.gaps.length > 0 ? ['#### Huecos', '', ...bulleted(v.gaps), ''] : []),
      ...(v.questions.length > 0 ? ['#### Preguntas sugeridas', '', ...numbered(v.questions), ''] : []),
      ...(v.discarded.bullets > 0 ? [`_Se han descartado ${v.discarded.bullets} puntos porque su cita no aparecía en los correos del cliente._`, ''] : []),
      '_Actualización preparada por un modelo de lenguaje: revísala._',
    ].join('\n'),
  );
}
