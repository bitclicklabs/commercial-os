/**
 * Optional LLM tie-break of the ContactFinder. Called ONLY when the deterministic rules leave
 * several equally ranked candidates (two people with the same kind of title, or several
 * person-looking addresses without a title). The model may only pick one of the given
 * addresses; anything else is ignored and the deterministic first candidate stays.
 *
 * The text around each address comes from the web: it goes inside a
 * <<<DATOS_NO_CONFIABLES>>> block in the user message, never in the system prompt.
 */
import { z } from 'zod';
import { parseWith, type Parsed } from '../agents/prospector-core.js';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from '../agents/untrusted.js';
import type { ContactCandidate } from './finder.js';
import { cleanWebText } from './research.js';

export const CONTACT_TRIAGE_SYSTEM_PROMPT = `Eres un clasificador del Commercial OS de PubliEXPE (expertos en merchandising para empresas).
Te doy varias direcciones de email que una empresa publica en su propia web y que las reglas automáticas consideran equivalentes. Elige la MEJOR para un primer email comercial sobre merchandising y regalo promocional: prioriza a quien decide o gestiona marketing, eventos y ferias, compras o la dirección de la empresa; evita recursos humanos, facturación, soporte técnico y personas sin relación con esas áreas.
Solo puedes elegir una de las direcciones de la lista. Si ninguna te parece mejor que las demás, elige la primera.
Responde SOLO con JSON: {"email": "<una de las direcciones>", "motivo": "<una frase en español>"}.

${UNTRUSTED_SYSTEM_RULE}`;

export const ContactTriageAnswer = z.object({ email: z.string().trim().min(3).max(254), motivo: z.string().trim().max(400).default('') });
export type ContactTriageAnswer = z.infer<typeof ContactTriageAnswer>;

export const CONTACT_TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: { email: { type: 'string' }, motivo: { type: 'string' } },
  required: ['email', 'motivo'],
} as const;

export function parseContactTriage(text: string): Parsed<ContactTriageAnswer> {
  return parseWith(ContactTriageAnswer, text);
}

export function buildContactTriagePrompt(companyName: string, tied: readonly ContactCandidate[]): string {
  const listing = tied.map((c, i) => `${i + 1}. ${c.email}`).join('\n');
  const evidence = tied
    .map((c) => `${c.email}: nombre=${cleanWebText(c.name, 80) ?? '—'}; cargo=${cleanWebText(c.jobTitle, 100) ?? '—'}; contexto=${cleanWebText(c.context, 300) ?? '—'}`)
    .join('\n');
  return [
    `Empresa: ${cleanWebText(companyName, 120) ?? 'desconocida'}`,
    'Direcciones candidatas (elige una):',
    listing,
    '',
    wrapUntrusted(evidence, { origin: `web de la empresa (${tied[0]?.sources[0]?.url ?? 'desconocida'})` }),
  ].join('\n');
}

/** The model's pick, accepted only when it is one of the tied addresses. */
export function acceptTriage(answer: ContactTriageAnswer, tied: readonly string[]): { email: string; reason: string } | null {
  const email = answer.email.trim().toLowerCase();
  return tied.includes(email) ? { email, reason: answer.motivo } : null;
}
