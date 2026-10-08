/**
 * Twenty notes of the inbound triage, for the commercial (they never answer anybody):
 *
 *   📬 Respuesta recibida — Interesado (AAAA-MM-DD HH:mm)      INTERESADO / PREGUNTA / NO_INTERESADO
 *   ⚠️ Rebote: el email no existe (AAAA-MM-DD HH:mm)           hard bounce of one of our sends
 *
 * Every value that comes from the email (subject, excerpt) is reduced to plain text: no
 * markdown or HTML syntax, no links or images, no control characters, bounded. The title
 * carries the local receive time so each reply gets its own note, and `create_note` is
 * idempotent per company + title, so a retried run never duplicates it.
 */
import { sanitizeSubject } from './suppression-list.js';
import type { TriageClass } from './triage-rules.js';

export const EXCERPT_MAX = 500;

export const REPLY_CLASS_LABELS: Record<TriageClass, string> = {
  INTERESADO: 'Interesado',
  PREGUNTA: 'Pregunta',
  NO_INTERESADO: 'No interesado',
  BAJA: 'Baja',
  AUTO_REPLY: 'Respuesta automática',
  REBOTE: 'Rebote',
  OTRO: 'Otro',
};

/** Classes that get a "📬 Respuesta recibida" note. */
export const NOTE_CLASSES: ReadonlySet<TriageClass> = new Set(['INTERESADO', 'PREGUNTA', 'NO_INTERESADO']);

/**
 * Plain-text excerpt: URLs become "[enlace]", markdown/HTML punctuation becomes spaces,
 * whitespace collapses to single spaces, at most `max` characters.
 */
export function sanitizeExcerpt(text: string, max = EXCERPT_MAX): string {
  const plain = (s: string) => s.replace(/[^\p{L}\p{N}\s.,;:!?¿¡'"/&%€$+@-]/gu, ' ');
  const clean = text
    .normalize('NFC')
    .split(/(?:https?:\/\/|www\.)\S+/i)
    .map(plain)
    // "[enlace]" without a "(url)" after it is plain text in markdown.
    .join(' [enlace] ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** An address shown in a note: no backticks or markdown characters (EMAIL_RE allows some). */
function safeAddress(email: string): string {
  return email.replace(/[`*_[\]()<>|~#\\]/g, '');
}

function confidenceText(c: number | null): string {
  return c === null ? '' : `, confianza ${c.toFixed(2).replace('.', ',')}`;
}

export interface ReplyNoteInput {
  class: TriageClass;
  method: 'RULES' | 'LLM';
  confidence: number | null;
  fromEmail: string;
  subject: string;
  authoredText: string;
  /** Local `AAAA-MM-DD HH:mm`. */
  receivedLocal: string;
  timezone: string;
  /** The send it answers, when found in `email_sends`. */
  send: { sentLocal: string; subject: string | null; by: 'email' | 'domain' } | null;
  /** True when the company was found by the sender's domain in Twenty (no send matched). */
  companyByDomain: boolean;
  suppressionAdded: boolean;
}

export function replyNoteTitle(cls: TriageClass, receivedLocal: string): string {
  return `📬 Respuesta recibida — ${REPLY_CLASS_LABELS[cls]} (${receivedLocal})`;
}

export function replyNoteBody(n: ReplyNoteInput): string {
  const label = REPLY_CLASS_LABELS[n.class];
  const excerpt = sanitizeExcerpt(n.authoredText);
  const subject = sanitizeSubject(n.subject, 120) || 'sin asunto';
  const replyTo = n.send
    ? `envío del ${n.send.sentLocal}${n.send.subject ? ` «${sanitizeSubject(n.send.subject, 120)}»` : ''} (${n.send.by === 'email' ? 'coincide la dirección' : 'coincide el dominio de la empresa'})`
    : n.companyByDomain
      ? 'no se encontró el envío en el registro; empresa localizada por el dominio del remitente'
      : 'no se encontró el envío en el registro';
  const todo: Partial<Record<TriageClass, string>> = {
    INTERESADO: 'Abre el correo en tu bandeja y respóndelo tú hoy: pide lo que falte (cantidades, fechas, logo) y prepara la propuesta.',
    PREGUNTA: 'Abre el correo en tu bandeja y contesta tú la pregunta.',
    NO_INTERESADO: n.suppressionAdded
      ? 'No vuelvas a escribir a esta dirección: se ha añadido a la «Lista de supresión — NO contactar» con el motivo «no interesado (respuesta)». Si la clasificación es un error, avisa al operador (las altas no se revierten desde aquí).'
      : 'No vuelvas a escribir a esta dirección: ya estaba en la «Lista de supresión — NO contactar».',
  };
  return [
    `**Ha respondido ${safeAddress(n.fromEmail)}.** Clasificación automática: **${label}** (${n.method === 'LLM' ? 'modelo' : 'reglas'}${confidenceText(n.confidence)}).`,
    '',
    `- Recibido: ${n.receivedLocal} (${n.timezone})`,
    `- Asunto: ${subject}`,
    `- Responde a: ${replyTo}`,
    '',
    'Extracto (texto plano, sin el mensaje citado):',
    '',
    `> ${excerpt.length > 0 ? excerpt : '(sin texto)'}`,
    '',
    `Qué hacer: ${todo[n.class] ?? 'Revisa el correo en tu bandeja.'}`,
    '',
    'El Commercial OS no responde ni envía nada: la respuesta es tuya.',
    '',
  ].join('\n');
}

export interface BounceNoteInput {
  recipient: string;
  status: string | null;
  receivedLocal: string;
  timezone: string;
  originalSubject: string | null;
  send: { sentLocal: string; subject: string | null } | null;
}

export function bounceNoteTitle(receivedLocal: string): string {
  return `⚠️ Rebote: el email no existe (${receivedLocal})`;
}

export function bounceNoteBody(n: BounceNoteInput): string {
  const subject = n.send?.subject ?? n.originalSubject;
  return [
    `**El correo a ${safeAddress(n.recipient)} ha rebotado de forma definitiva**${n.status ? ` (código ${n.status.replace(/[^0-9.]/g, '')})` : ''}: el servidor dice que la dirección no existe o no acepta correo.`,
    '',
    `- Rebote recibido: ${n.receivedLocal} (${n.timezone})`,
    ...(n.send ? [`- Envío: ${n.send.sentLocal}${subject ? ` «${sanitizeSubject(subject, 120)}»` : ''}`] : subject ? [`- Asunto del envío: ${sanitizeSubject(subject, 120)}`] : []),
    '',
    'Qué hacer: no reenvíes a esta dirección. Busca otro contacto de la empresa (web, LinkedIn o una dirección de rol como info@) y corrige *Email to* antes de volver a enviar. La dirección NO se ha añadido a la lista de supresión.',
    '',
  ].join('\n');
}
