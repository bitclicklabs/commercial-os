/**
 * Opt-in lead-time templates (tanda 18, feedback of 2026-10-12). They are NOT part of the
 * default build (`TEMPLATES`): existing synthetic datasets, seeds and counts stay exactly as they
 * were. `synth:build --lead-time` (or `--templates lead_time_too_close,...`) adds them.
 *
 * | Template               | Level | Pattern   | Expected decision                                                  |
 * |------------------------|-------|-----------|--------------------------------------------------------------------|
 * | lead_time_too_close    | 2     | LEAD_TIME | discard: fair in 7-20 days -> relevant = false, confidence <= 0,19 |
 * | lead_time_comfortable  | 1     | LEAD_TIME | pursue: fair in 75-120 days, and no "short lead time" angle        |
 *
 * The exhibitor is a clear fit on purpose (rich data, explicit merchandising need): the only
 * thing that decides the case is the calendar. Each case has its own fictitious fair and a
 * `ground_truth.as_of` ("today" for the agent), so the truth does not depend on the day the
 * experiment runs: the runner runs that fixture with `as_of` as its clock.
 *
 * The truth follows from the lead-time rule (candidate `lead-time-v1` of
 * prospector-event-exhibitors and the knowledge entry prospeccion/lead-time-comercial): the
 * ACTIVE skill before it (v3) is expected to FAIL `lead_time_too_close` - that is the point.
 */
import { LEAD_TIME_WINDOW_MAX_DAYS, LEAD_TIME_WINDOW_MIN_DAYS, OUT_OF_WINDOW_REASON } from '../skills/lead-time-candidates.js';
import type { Rng } from './prng.js';
import { templateCatalog, type SyntheticBuildEvent, type SyntheticTemplate } from './templates.js';
import { FAIR_KINDS, fill, LEGAL, PHRASES, PLACES, root, SECTORS, slug, SYNTHETIC_TLD, syntheticDomain } from './vocab.js';

/** Skill calibration: "0-0,19: no hay encaje". */
const DISCARD_MAX = 0.19;
const WRITE_MIN = 0.5;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "Today" of the case and its fair `days` later. Deterministic from the Rng. */
function calendar(rng: Rng, days: number): { asOf: string; date: string } {
  const asOfMs = Date.UTC(2027, rng.int(0, 9), rng.int(1, 28));
  return { asOf: iso(asOfMs), date: iso(asOfMs + days * 86_400_000) };
}

function leadTimeCase(rng: Rng, days: number) {
  const s = rng.pick(SECTORS);
  const r = root(rng);
  // «Export» keeps these names disjoint from every default template (no collision, no redraw there).
  const name = `${s.activity} ${r} Export ${rng.pick(LEGAL)}`;
  const kind = rng.pick(FAIR_KINDS);
  const place = rng.pick(PLACES);
  const { asOf, date } = calendar(rng, days);
  const event: SyntheticBuildEvent = {
    name: `${kind.name} de ${place} 2027`,
    type: 'FAIR',
    date,
    location: `${place} (recinto ferial)`,
    source_url: `https://${slug(`${kind.name}-${place}-${r}`)}.${SYNTHETIC_TLD}/expositores`,
  };
  const emp = rng.int(4, 40) * 10;
  const description = [
    `${fill(rng.pick(PHRASES.company), { product: s.product, emp })} ${fill(rng.pick(PHRASES.exports), { n: rng.int(3, 25) })}.`,
    `Presenta en la feria ${s.launch} y ${fill(rng.pick(PHRASES.presence), { m2: rng.int(3, 12) * 10, k: rng.int(3, 8) })}.`,
    rng.pick(PHRASES.need),
  ].join(' ');
  return { exhibitor: { name, domain: syntheticDomain(`${r}-${s.activity}-export`), sector: s.sector, description }, event, asOf };
}

export const LEAD_TIME_TEMPLATES: readonly SyntheticTemplate[] = [
  {
    id: 'lead_time_too_close',
    version: 1,
    title: 'Feria demasiado cercana para producir (fuera de ventana comercial)',
    curriculum_level: 2,
    patterns: ['LEAD_TIME'],
    decision: 'discard',
    expectation: `Descarte (relevant = false) con confianza ≤ 0,19: la feria es en menos de ${LEAD_TIME_WINDOW_MIN_DAYS} días.`,
    rationale: `Regla de lead time (feedback del 2026-10-12, candidata lead-time-v1): una feria a menos de ${LEAD_TIME_WINDOW_MIN_DAYS} días no deja plazo para producir merchandising personalizado → «${OUT_OF_WINDOW_REASON}», relevant = false, confianza de descarte 0-0,19. El expositor encaja en todo lo demás a propósito.`,
    build(rng: Rng) {
      const c = leadTimeCase(rng, rng.int(7, 20));
      return { ...c, checks: [{ id: 'relevant', equals: false }, { id: 'writable', equals: false }, { id: 'discard_confidence', max: DISCARD_MAX }] };
    },
  },
  {
    id: 'lead_time_comfortable',
    version: 1,
    title: 'Feria del próximo trimestre: hay tiempo para producir con calma',
    curriculum_level: 1,
    patterns: ['LEAD_TIME'],
    decision: 'pursue',
    expectation: 'Relevante y escribible; la hipótesis no argumenta plazos cortos ni prisa.',
    rationale: `Regla de lead time: dentro de la ventana (${LEAD_TIME_WINDOW_MIN_DAYS}-${LEAD_TIME_WINDOW_MAX_DAYS} días) el expositor se evalúa como siempre (aquí, encaje claro con datos concretos) y el argumento es producir con calma, nunca plazos cortos.`,
    build(rng: Rng) {
      const c = leadTimeCase(rng, rng.int(75, 120));
      return { ...c, checks: [{ id: 'relevant', equals: true }, { id: 'writable', equals: true }, { id: 'confidence_min', min: WRITE_MIN }, { id: 'no_short_lead_time_angle' }] };
    },
  },
];

export const LEAD_TIME_TEMPLATE_IDS: readonly string[] = LEAD_TIME_TEMPLATES.map((t) => t.id);

/** Public description of the opt-in templates (GET /synthetic/templates `opt_in`, `synth:build --list`). */
export function optInTemplateCatalog() {
  return templateCatalog(LEAD_TIME_TEMPLATES).map((t) => ({ ...t, opt_in: true as const }));
}
