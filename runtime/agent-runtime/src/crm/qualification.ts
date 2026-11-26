/**
 * Qualification of an opportunity out of the client's reply (tanda 23). The reply-draft model
 * returns, in the SAME call as the draft, an optional `cualificacion` with CLOSED fields:
 *
 *   cantidad_aprox          { valor: number, cita }                      units
 *   presupuesto_aprox_eur   { valor: number, valor_max?: number, cita }  EUR (a range: both ends)
 *   fecha_necesaria         { valor: 'YYYY-MM-DD', cita }
 *   decisor                 { valor: short text, cita }
 *   productos_interes       [{ valor: short text, cita }] (at most 5)
 *
 * Every datum needs the LITERAL quote of the client's email that justifies it. The code (this
 * file) keeps a datum only when its quote really is in the client's text (whitespace, case and
 * quote marks normalised) and, for numbers, when the number is written in the quote; anything
 * else is discarded: nothing is ever invented. Pure, no I/O.
 *
 * Where it goes (src/tools/twenty/qualification-tools.ts): a note «Cualificación — {empresa} 🧾»
 * on the opportunity (one section per reply, appended) and, ONLY when empty, the standard fields
 * `amount` (the budget; for a range, the LOWER end: PM decision, conservative) and `closeDate`.
 */
import { z } from 'zod';
import { addDaysToDate } from '../meetings/slots.js';
import { validYmd } from '../meetings/client-window.js';

export const QUALIFICATION_NOTE_PREFIX = 'Cualificación — ';
export const QUALIFICATION_NOTE_EMOJI = '🧾';
export const QUALIFICATION_AUDIT_ACTION = 'opportunity.qualified';
export const QUOTE_MAX = 300;
export const QUOTE_MIN = 3;
export const TEXT_VALUE_MAX = 80;
export const PRODUCTS_MAX = 5;
/** Plausibility bounds: outside them the number is not believed. */
export const QUANTITY_MAX = 10_000_000;
export const BUDGET_MAX_EUR = 10_000_000;
/** A needed-by date further than this is not believed. */
export const NEEDED_BY_MAX_DAYS = 548;

// ---------------------------------------------------------------------------
// Model answer (lenient: a bad field is dropped, never fails the draft)
// ---------------------------------------------------------------------------

const Quote = z.string().trim().min(1).max(1_000);
const lenient = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional().catch(null);

const NumberDatum = z.object({ valor: z.number().finite(), cita: Quote });
const BudgetDatum = z.object({ valor: z.number().finite(), valor_max: z.number().finite().nullable().optional(), cita: Quote });
const TextDatum = z.object({ valor: z.string().trim().min(1).max(500), cita: Quote });

export const Cualificacion = z.object({
  cantidad_aprox: lenient(NumberDatum),
  presupuesto_aprox_eur: lenient(BudgetDatum),
  fecha_necesaria: lenient(TextDatum),
  decisor: lenient(TextDatum),
  productos_interes: z
    .array(z.unknown())
    .max(20)
    .optional()
    .catch([])
    .transform((items) => (items ?? []).map((i) => TextDatum.safeParse(i)).flatMap((r) => (r.success ? [r.data] : []))),
});
export type Cualificacion = z.infer<typeof Cualificacion>;

// ---------------------------------------------------------------------------
// Validation against the client's text
// ---------------------------------------------------------------------------

/** Text normalised for the literal-quote check: NFC, lower case, one kind of quote, single spaces. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[«»“”"„]/g, '"')
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** The quote without surrounding quote marks / ellipses, when it is literally in `text`. */
export function literalQuote(quote: string, text: string): string | null {
  const q = normalizeForQuote(quote).replace(/^["'.…\s]+|["'.…\s]+$/g, '');
  if (q.length < QUOTE_MIN || q.length > QUOTE_MAX) return null;
  return normalizeForQuote(text).includes(q) ? q : null;
}

/**
 * Numbers written in a quote, in plain units: «2.000» / «2 000» -> 2000, «2,5» -> 2.5,
 * «3 mil» / «3k» -> 3000.
 */
export function numbersIn(quote: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d+))?\s*(mil\b|k\b)?/giu;
  for (const m of quote.matchAll(re)) {
    const int = Number(m[1]!.replace(/[.\s]/g, ''));
    const n = m[2] ? Number(`${int}.${m[2]}`) : int;
    if (Number.isFinite(n)) out.push(m[3] ? n * 1_000 : n);
  }
  return out;
}

const numberInQuote = (value: number, quote: string) => numbersIn(quote).some((n) => Math.abs(n - value) < 1e-6);

/** Plain one-line text for a value or a quote shown in markdown (no markup a client could smuggle). */
export function plainText(s: string, max: number): string {
  const t = s.replace(/[`*_[\]()<>|~#\\]/g, '').replace(/https?:\/\/\S+|www\.\S+/gi, '[enlace]').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export interface QualificationData {
  quantity: { value: number; quote: string } | null;
  /** `min` = the amount for the opportunity; `max` only for a range. */
  budget: { min: number; max: number | null; quote: string } | null;
  neededBy: { date: string; quote: string } | null;
  decisionMaker: { value: string; quote: string } | null;
  products: Array<{ value: string; quote: string }>;
  /** Field names of the data that were dropped (no literal quote, implausible...). */
  discarded: string[];
}

export function isEmptyQualification(q: QualificationData): boolean {
  return !q.quantity && !q.budget && !q.neededBy && !q.decisionMaker && q.products.length === 0;
}

/**
 * Keeps only the data justified by a literal quote of `clientText` (the text the client wrote,
 * without the quoted message). `today` (local `YYYY-MM-DD`) bounds the needed-by date.
 */
export function validateQualification(c: Cualificacion | null | undefined, clientText: string, today: string): QualificationData {
  const out: QualificationData = { quantity: null, budget: null, neededBy: null, decisionMaker: null, products: [], discarded: [] };
  if (!c) return out;
  const quoteOf = (raw: string) => {
    const q = literalQuote(raw, clientText);
    return q === null ? null : plainText(raw.replace(/^["'«»“”.…\s]+|["'«»“”.…\s]+$/g, ''), QUOTE_MAX);
  };

  if (c.cantidad_aprox) {
    const { valor, cita } = c.cantidad_aprox;
    const quote = quoteOf(cita);
    if (quote && valor > 0 && valor <= QUANTITY_MAX && numberInQuote(valor, cita)) out.quantity = { value: Math.round(valor), quote };
    else out.discarded.push('cantidad_aprox');
  }
  if (c.presupuesto_aprox_eur) {
    const { valor, valor_max, cita } = c.presupuesto_aprox_eur;
    const quote = quoteOf(cita);
    const ends = [valor, ...(typeof valor_max === 'number' ? [valor_max] : [])];
    const ok = quote !== null && ends.every((n) => n > 0 && n <= BUDGET_MAX_EUR && numberInQuote(n, cita));
    if (ok) {
      const min = Math.min(...ends);
      const max = ends.length > 1 && Math.max(...ends) !== min ? Math.max(...ends) : null;
      out.budget = { min, max, quote: quote! };
    } else out.discarded.push('presupuesto_aprox_eur');
  }
  if (c.fecha_necesaria) {
    const date = validYmd(c.fecha_necesaria.valor);
    const quote = quoteOf(c.fecha_necesaria.cita);
    if (date && quote && date >= today && date <= addDaysToDate(today, NEEDED_BY_MAX_DAYS)) out.neededBy = { date, quote };
    else out.discarded.push('fecha_necesaria');
  }
  if (c.decisor) {
    const quote = quoteOf(c.decisor.cita);
    const value = plainText(c.decisor.valor, TEXT_VALUE_MAX);
    if (quote && value.length > 0) out.decisionMaker = { value, quote };
    else out.discarded.push('decisor');
  }
  for (const p of c.productos_interes) {
    const quote = quoteOf(p.cita);
    const value = plainText(p.valor, TEXT_VALUE_MAX);
    if (quote && value.length > 0 && out.products.length < PRODUCTS_MAX && !out.products.some((x) => x.value.toLowerCase() === value.toLowerCase())) out.products.push({ value, quote });
    else out.discarded.push('productos_interes');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Note «Cualificación — {empresa} 🧾»
// ---------------------------------------------------------------------------

const TITLE_MAX = 255;

/** `Cualificación — <empresa> 🧾` (text first, emoji last; no quotes or backslashes). */
export function qualificationNoteTitle(company: string): string {
  const suffix = ` ${QUALIFICATION_NOTE_EMOJI}`;
  const name = company.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || 'la empresa';
  const room = TITLE_MAX - QUALIFICATION_NOTE_PREFIX.length - suffix.length;
  return `${QUALIFICATION_NOTE_PREFIX}${name.length <= room ? name : `${name.slice(0, room - 1)}…`}${suffix}`;
}

export const QUALIFICATION_NOTE_HEADER =
  '**Cualificación de la oportunidad, extraída de las respuestas del cliente.** Cada dato lleva la cita literal de su correo que lo justifica; los datos sin cita se descartan. Lo ha extraído un modelo de lenguaje: revísalo. El Commercial OS solo rellena el importe y la fecha de cierre de la oportunidad cuando están vacíos; nunca cambia lo que hayas puesto tú.';

/** Header of the section of one reply; also the idempotency marker of the append. */
export function qualificationSectionTitle(receivedLocal: string): string {
  return `### Respuesta del ${receivedLocal}`;
}

const eur = (n: number) => `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2, useGrouping: true }).format(n)} €`;
const units = (n: number) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: true }).format(n);
const cite = (q: string) => `«${q}»`;

/** The markdown section of one reply (header + one line per datum + what was written to the opportunity). */
export function qualificationSection(q: QualificationData, receivedLocal: string, fields: { amount: 'set' | 'kept' | 'none'; closeDate: 'set' | 'kept' | 'none' }): string {
  const lines = [qualificationSectionTitle(receivedLocal), ''];
  if (q.quantity) lines.push(`- **Cantidad aproximada:** ${units(q.quantity.value)} unidades — ${cite(q.quantity.quote)}`);
  if (q.budget) lines.push(`- **Presupuesto aproximado:** ${q.budget.max !== null ? `entre ${eur(q.budget.min)} y ${eur(q.budget.max)}` : eur(q.budget.min)} — ${cite(q.budget.quote)}`);
  if (q.neededBy) lines.push(`- **Fecha necesaria:** ${q.neededBy.date} — ${cite(q.neededBy.quote)}`);
  if (q.decisionMaker) lines.push(`- **Decisor:** ${q.decisionMaker.value} — ${cite(q.decisionMaker.quote)}`);
  for (const p of q.products) lines.push(`- **Productos de interés:** ${p.value} — ${cite(p.quote)}`);
  const written: string[] = [];
  if (fields.amount === 'set') written.push(`importe = ${eur(q.budget!.min)}${q.budget!.max !== null ? ' (el extremo inferior del rango)' : ''}`);
  if (fields.closeDate === 'set') written.push(`fecha de cierre = ${q.neededBy!.date}`);
  const kept: string[] = [];
  if (fields.amount === 'kept') kept.push('el importe');
  if (fields.closeDate === 'kept') kept.push('la fecha de cierre');
  if (written.length > 0 || kept.length > 0) {
    lines.push('');
    lines.push(
      `_${written.length > 0 ? `Oportunidad actualizada: ${written.join('; ')}.` : ''}${written.length > 0 && kept.length > 0 ? ' ' : ''}${kept.length > 0 ? `No se ha tocado ${kept.join(' ni ')}: ya tenía un valor.` : ''}_`,
    );
  }
  return lines.join('\n');
}
