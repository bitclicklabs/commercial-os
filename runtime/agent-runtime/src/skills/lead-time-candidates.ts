/**
 * Lead-time candidates (tanda 18): the skills must speak with the right calendar.
 *
 * Feedback of 2026-10-12: the user rejected the 6 drafts of Gastrónoma. The fair was 14 days
 * away and the drafts boasted of short lead times ("podemos adaptarnos a estos plazos…"), when
 * producing customised merchandising in 2 weeks is not possible. New rule: PubliEXPE prospects
 * fairs of the next quarter (window 45-210 days, enforced by code in feat/lead-time-window) and
 * the commercial argument is the opposite one: time to produce calmly (samples, marking proofs
 * and production without rush).
 *
 * Two bounded candidates (src/skills/edit-ops.ts) over the ACTIVE text of each skill:
 * - `prospector-event-exhibitors`: fairs < 45 days -> relevant = false («Fuera de ventana
 *   comercial», discard confidence 0-0,19); need and quantities planned for a comfortable
 *   production; why_now argues the lead time, never haste.
 * - `email-first-contact-draft`: the draft uses the lead time computed by code («a N semanas/
 *   meses de la feria») as the argument. Tone and format untouched (only the time angle).
 *
 * Pure module (no I/O): the seed (src/seed/lead-time-seed.ts) creates the DRAFT versions
 * through the skill service; nothing here activates anything.
 *
 * Merge note: the window constants live in src/signals/lead-time.ts on feat/lead-time-window
 * (DEFAULT_LEADTIME_MIN_DAYS / DEFAULT_LEADTIME_MAX_DAYS). This branch does not have it yet:
 * Single source of truth: src/signals/lead-time.ts (agreed between the tanda-18 branches).
 */
import { DEFAULT_LEADTIME_MIN_DAYS, DEFAULT_LEADTIME_MAX_DAYS } from '../signals/lead-time.js';
import { EMAIL_DRAFTER_SKILL_ID } from '../agents/email-drafter-prompt.js';
import { PROSPECTOR_SKILL_ID } from '../agents/prospector-prompt.js';
import { applyEditOperations, type EditOperation, type EditResult } from './edit-ops.js';

/** Local copy of the commercial window (see the merge note above). */
export const LEAD_TIME_WINDOW_MIN_DAYS = DEFAULT_LEADTIME_MIN_DAYS;
export const LEAD_TIME_WINDOW_MAX_DAYS = DEFAULT_LEADTIME_MAX_DAYS;

export const LEAD_TIME_FEEDBACK_DATE = '2026-10-12';
/** `metadata.candidate` of both DRAFT versions (idempotency key of the seed). */
export const LEAD_TIME_CANDIDATE = 'lead-time-v1';
/** Prefix of the discard reason the Prospector candidate asks for. */
export const OUT_OF_WINDOW_REASON = 'Fuera de ventana comercial';

/**
 * Wording of the rejected angle: none of these may appear in a candidate text (the tests
 * assert it literally). The email keeps its tone line «sin urgencia falsa», which forbids it.
 */
export const SHORT_LEAD_TIME_FRAGMENTS: readonly string[] = [
  'plazos cortos',
  'plazo corto',
  'plazo es corto',
  'está cerca',
  'pocos días',
  'adaptarnos',
  'urgente',
  'última hora',
];

/** The new angle, as the candidates word it. */
export const CALM_PRODUCTION_ANGLE = 'muestras, pruebas de marcaje y producción sin prisas';

const FEEDBACK =
  `Feedback directo del usuario del ${LEAD_TIME_FEEDBACK_DATE}: rechazó los 6 borradores de Gastrónoma (feria a 14 días) porque presumían de plazos cortos ` +
  '(«Al quedar pocos días para la feria… podemos adaptarnos a estos plazos cortos»); producir merchandising personalizado en 2 semanas no es posible.';

// ---------------------------------------------------------------------------
// Prospector
// ---------------------------------------------------------------------------

export const PROSPECTOR_LEAD_TIME_OPS: readonly EditOperation[] = [
  {
    op: 'REPLACE',
    find: '- Taller propio: personalización (serigrafía, tampografía, bordado, láser) y plazos cortos, clave cuando la feria está cerca.',
    text: `- Taller propio: personalización (serigrafía, tampografía, bordado, láser) en casa, con muestras y pruebas de marcaje antes de producir; con meses de antelación, la producción se hace con calma y sin sorpresas.`,
    why: 'El diferencial ya no se vende como rapidez: el valor es producir con calma y con control.',
  },
  {
    op: 'ADD',
    anchor: '- Datos insuficientes para identificar una empresa real con actividad comercial.',
    text: `- ${OUT_OF_WINDOW_REASON}: la feria se celebra en menos de ${LEAD_TIME_WINDOW_MIN_DAYS} días desde la fecha de hoy (o ya se ha celebrado). Sin plazo para producir merchandising personalizado con calma no hay propuesta seria: relevant = false, hypothesis = null, confianza entre 0 y 0,19 (es un descarte, no tu seguridad), y "reason" empieza por «${OUT_OF_WINDOW_REASON}» con los días que faltan.`,
    why: 'Ferias a < 45 días no deberían llegar (filtro por código), pero si llegan se descartan con la semántica de confianza vigente.',
  },
  {
    op: 'ADD',
    anchor: '## Casos dudosos',
    position: 'before',
    text: [
      '## Ventana comercial (lead time)',
      `PubliEXPE prospecta ferias del próximo trimestre: la ventana de valor va de ${LEAD_TIME_WINDOW_MIN_DAYS} a ${LEAD_TIME_WINDOW_MAX_DAYS} días antes de la feria. Ese margen es el argumento comercial: da tiempo a elegir producto y a hacer ${CALM_PRODUCTION_ANGLE}.`,
      '- Antes de decidir, calcula los días que faltan entre la fecha de hoy y la fecha del evento.',
      `- A ${LEAD_TIME_WINDOW_MIN_DAYS} días o más, evalúa el expositor con las reglas de siempre; a más de ${LEAD_TIME_WINDOW_MAX_DAYS} días sigue siendo válido, con timing LATER.`,
      '- Sin fecha del evento, evalúa con normalidad (timing UNKNOWN) y no hables de plazos.',
      '',
    ].join('\n'),
    why: 'Regla de lead time comercial (45-210 días) explícita en la skill.',
  },
  {
    op: 'ADD',
    anchor: '- need: necesidad concreta de merchandising ligada al evento',
    text: '- Plazo de producción: plantea need y cantidades para una producción con plazo cómodo (pedido cerrado con semanas de margen antes de la feria), nunca como un encargo apresurado.',
    why: 'La necesidad y las cantidades se dimensionan para producir con calma.',
  },
  {
    op: 'REPLACE',
    find: 'menciona el diferencial que más ayuda (por ejemplo, taller propio si el plazo es corto).',
    text: `presenta el margen que queda hasta la feria («a unas N semanas» o «a unos N meses») como ventaja: es el momento de dejar el merchandising resuelto con calma (${CALM_PRODUCTION_ANGLE}); menciona el diferencial que más ayuda. Nunca argumentes con prisa ni con poco margen.`,
    why: 'why_now argumenta el lead time, nunca la urgencia.',
  },
];

export const PROSPECTOR_LEAD_TIME_CHANGELOG =
  `Candidata (DRAFT) de la tanda 18 · regla de lead time comercial. ${FEEDBACK} ` +
  `Cambios: (1) ferias a menos de ${LEAD_TIME_WINDOW_MIN_DAYS} días -> relevant = false con «${OUT_OF_WINDOW_REASON}» y confianza de descarte 0-0,19; ` +
  `(2) nueva sección «Ventana comercial (lead time)» (${LEAD_TIME_WINDOW_MIN_DAYS}-${LEAD_TIME_WINDOW_MAX_DAYS} días); (3) need y cantidades para producción con plazo cómodo; ` +
  '(4) why_now argumenta la antelación («producir con calma»), nunca plazos cortos ni prisa; (5) el diferencial Taller propio deja de venderse como rapidez. ' +
  'El filtro de la ventana lo aplica el código (feat/lead-time-window); esta versión cubre lo que llegue igualmente.';

// ---------------------------------------------------------------------------
// EmailDrafter
// ---------------------------------------------------------------------------

export const EMAIL_LEAD_TIME_OPS: readonly EditOperation[] = [
  {
    op: 'REPLACE',
    find: '- Taller propio: personalización (serigrafía, tampografía, bordado, láser) y plazos cortos; clave si el evento está cerca.',
    text: '- Taller propio: personalización (serigrafía, tampografía, bordado, láser) en casa, con muestras y pruebas de marcaje antes de producir.',
    why: 'El diferencial ya no se vende como rapidez.',
  },
  {
    op: 'REPLACE',
    find: '  2. El porqué ahora: el evento o la señal concreta (nombre y fecha si los hay) y la necesidad que intuyes, en palabras sencillas.',
    text:
      '  2. El porqué ahora: el evento o la señal concreta (nombre y fecha si los hay), la necesidad que intuyes, en palabras sencillas, y la antelación como ventaja. ' +
      `Usa la antelación que te da el sistema («a N semanas» o «a N meses» de la feria) con esta idea: es el momento ideal para dejar el merchandising resuelto con calma: ${CALM_PRODUCTION_ANGLE}. ` +
      `Sin antelación calculada (no hay fecha), con menos de ${LEAD_TIME_WINDOW_MIN_DAYS} días o con el evento ya celebrado, no hables de plazos.`,
    why: 'El ángulo temporal pasa a ser la antelación (lead time calculado por código).',
  },
  {
    op: 'ADD',
    anchor: '- No inventes nada que no esté en los datos',
    text: '- El tiempo juega a favor, nunca en contra: no digas que queda poco margen, que el plazo es justo ni que PubliEXPE se adapta a entregas apresuradas, aunque "porque_ahora" lo sugiera. El único argumento temporal es la antelación para producir con calma.',
    why: 'Prohibido el ángulo del feedback del 2026-10-12, incluso si la hipótesis (escrita con la skill anterior del Prospector) lo trae.',
  },
];

export const EMAIL_LEAD_TIME_CHANGELOG =
  `Candidata (DRAFT) de la tanda 18 · ángulo temporal del primer email. ${FEEDBACK} ` +
  'Cambios: (1) el porqué ahora usa la antelación que calcula el código («Antelación hasta el evento: …» en el prompt) como argumento: ' +
  `«a N semanas/meses de la feria, es el momento ideal para dejar el merchandising resuelto con calma: ${CALM_PRODUCTION_ANGLE}»; ` +
  '(2) prohibido el ángulo de prisa o poco margen, aunque la hipótesis lo traiga; (3) el diferencial Taller propio deja de venderse como rapidez. ' +
  'Tono y formato confirmados SIN cambios (cercano y profesional, extensión, personalización feria + necesidad, 1-2 diferenciales; descriptor y línea de baja por código).';

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface LeadTimeCandidateSpec {
  skill: string;
  operations: readonly EditOperation[];
  changelog: string;
  activation: string;
}

export const LEAD_TIME_CANDIDATES: readonly LeadTimeCandidateSpec[] = [
  {
    skill: PROSPECTOR_SKILL_ID,
    operations: PROSPECTOR_LEAD_TIME_OPS,
    changelog: PROSPECTOR_LEAD_TIME_CHANGELOG,
    activation:
      'Nunca automática. pnpm experiment:run --subject skill:prospector-event-exhibitors --candidate <v> sobre un dataset sintético/mixto (pnpm synth:build --lead-time): ' +
      'con la VALIDATION real quemada da como mucho PASS_FORM (o FAIL). Con PASS_FORM, la activación (o el canario) es decisión humana: POST /skills/prospector-event-exhibitors/versions/<v>/activate.',
  },
  {
    skill: EMAIL_DRAFTER_SKILL_ID,
    operations: EMAIL_LEAD_TIME_OPS,
    changelog: EMAIL_LEAD_TIME_CHANGELOG,
    activation:
      'Nunca automática. El EmailDrafter no tiene runner de experimentos (skill:compare solo cubre el Prospector): el Release Gate solo la deja pasar con ' +
      'POST /skills/email-first-contact-draft/versions/<v>/activate { "force": true, "reason": "…" } (decisión humana registrada). El canario exige el mismo gate y no acepta force.',
  },
];

/** The candidate text of a skill from its ACTIVE text. Throws EditOperationError when an anchor is missing. Pure. */
export function buildLeadTimeCandidate(spec: LeadTimeCandidateSpec, activeInstructions: string): EditResult {
  return applyEditOperations(activeInstructions, spec.operations);
}

/** Fragments of the rejected angle present in a text (empty: clean). */
export function shortLeadTimeFragments(text: string): string[] {
  const lower = text.toLowerCase();
  return SHORT_LEAD_TIME_FRAGMENTS.filter((f) => lower.includes(f));
}
