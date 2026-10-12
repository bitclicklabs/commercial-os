/**
 * Tanda 18 · the skills speak with the right calendar (feedback of 2026-10-12: the 6 Gastrónoma
 * drafts argued short lead times for a fair 14 days away).
 *
 * - The DRAFT candidates of the Prospector and the EmailDrafter carry the new angle (produce
 *   calmly, window 45-210 days) and none of the rejected wording; tone and format of the email
 *   are untouched.
 * - The lead time N reaches the drafter prompt, computed by code from the event date and today.
 * - Opt-in synthetic lead-time templates: true by construction, default builds unchanged.
 */
import { describe, expect, it } from 'vitest';
import { daysUntilEvent, draftLeadTime, leadTimeLabel } from '../../src/agents/email-draft.js';
import { buildDraftPrompt, EMAIL_DRAFTER_SKILL_ID, EMAIL_DRAFTER_SYSTEM_PROMPT, leadTimeLine, type DraftPromptData } from '../../src/agents/email-drafter-prompt.js';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT } from '../../src/agents/prospector-prompt.js';
import { fixtureClock } from '../../src/experiments/runner.js';
import { LEAD_TIME_KNOWLEDGE_STATEMENT } from '../../src/seed/knowledge-seed.js';
import {
  buildLeadTimeCandidate,
  CALM_PRODUCTION_ANGLE,
  EMAIL_LEAD_TIME_CHANGELOG,
  LEAD_TIME_CANDIDATES,
  LEAD_TIME_WINDOW_MAX_DAYS,
  LEAD_TIME_WINDOW_MIN_DAYS,
  OUT_OF_WINDOW_REASON,
  PROSPECTOR_LEAD_TIME_CHANGELOG,
  SHORT_LEAD_TIME_FRAGMENTS,
  shortLeadTimeFragments,
} from '../../src/skills/lead-time-candidates.js';
import { generateSyntheticCases, templatePool, type GeneratedCase } from '../../src/synthetic/generate.js';
import { LEAD_TIME_TEMPLATE_IDS, LEAD_TIME_TEMPLATES, optInTemplateCatalog } from '../../src/synthetic/lead-time-templates.js';
import { TEMPLATES, templateCatalog } from '../../src/synthetic/templates.js';
import { runChecks, truthHolds, type DecisionView } from '../../src/synthetic/truth.js';

const spec = (skill: string) => LEAD_TIME_CANDIDATES.find((c) => c.skill === skill)!;
const prospector = buildLeadTimeCandidate(spec(PROSPECTOR_SKILL_ID), PROSPECTOR_SYSTEM_PROMPT);
const email = buildLeadTimeCandidate(spec(EMAIL_DRAFTER_SKILL_ID), EMAIL_DRAFTER_SYSTEM_PROMPT);

describe('lead-time candidate of the Prospector (prospector-event-exhibitors)', () => {
  it('the base text has the rejected angle; the candidate has none of it (literal asserts)', () => {
    expect(PROSPECTOR_SYSTEM_PROMPT).toContain('plazos cortos');
    expect(shortLeadTimeFragments(PROSPECTOR_SYSTEM_PROMPT).length).toBeGreaterThan(0);
    expect(shortLeadTimeFragments(prospector.text)).toEqual([]);
    expect(prospector.text).not.toContain('plazos cortos');
    expect(prospector.text).not.toContain('plazo es corto');
    expect(prospector.text).not.toContain('la feria está cerca');
    expect(prospector.text).not.toMatch(/urgen/i);
    for (const f of SHORT_LEAD_TIME_FRAGMENTS) expect(prospector.text.toLowerCase()).not.toContain(f);
  });

  it('carries the lead-time rule: out of window < 45 days is a discard with low confidence, 45-210 days window, calm production', () => {
    expect(prospector.text).toContain('## Ventana comercial (lead time)');
    expect(prospector.text).toContain(`la ventana de valor va de ${LEAD_TIME_WINDOW_MIN_DAYS} a ${LEAD_TIME_WINDOW_MAX_DAYS} días antes de la feria`);
    expect(prospector.text).toContain(`- ${OUT_OF_WINDOW_REASON}: la feria se celebra en menos de 45 días desde la fecha de hoy`);
    expect(prospector.text).toContain('relevant = false, hypothesis = null, confianza entre 0 y 0,19');
    expect(prospector.text).toContain(`"reason" empieza por «${OUT_OF_WINDOW_REASON}»`);
    expect(prospector.text).toContain(CALM_PRODUCTION_ANGLE);
    expect(prospector.text).toContain('plantea need y cantidades para una producción con plazo cómodo');
    expect(prospector.text).toContain('Nunca argumentes con prisa ni con poco margen.');
    // The out-of-window rule sits among the discards; the window section before «Casos dudosos».
    const notRelevant = prospector.text.indexOf('## Cuándo NO es relevante');
    expect(prospector.text.indexOf(`- ${OUT_OF_WINDOW_REASON}`)).toBeGreaterThan(notRelevant);
    expect(prospector.text.indexOf('## Ventana comercial (lead time)')).toBeLessThan(prospector.text.indexOf('## Casos dudosos'));
    // Everything else is kept: the bounded edit is small, the JSON contract and the safety rules are intact.
    expect(prospector.removedRatio).toBeLessThan(0.1);
    expect(prospector.addedRatio).toBeLessThan(0.5);
    expect(prospector.text).toContain('timing: IMMEDIATE');
    expect(prospector.text).toContain('<<<DATOS_NO_CONFIABLES');
  });

  it('the changelog cites the feedback of 2026-10-12', () => {
    expect(PROSPECTOR_LEAD_TIME_CHANGELOG).toContain('2026-10-12');
    expect(PROSPECTOR_LEAD_TIME_CHANGELOG).toContain('Gastrónoma');
    expect(spec(PROSPECTOR_SKILL_ID).activation).toMatch(/PASS_FORM/);
  });
});

describe('lead-time candidate of the EmailDrafter (email-first-contact-draft)', () => {
  it('uses the lead time as the argument, with the PM wording', () => {
    expect(email.text).toContain('es el momento ideal para dejar el merchandising resuelto con calma: muestras, pruebas de marcaje y producción sin prisas');
    expect(email.text).toContain('«a N semanas» o «a N meses» de la feria');
    expect(email.text).toContain('El tiempo juega a favor, nunca en contra');
  });

  it('forbids the short-lead-time angle and contains none of its wording', () => {
    expect(EMAIL_DRAFTER_SYSTEM_PROMPT).toContain('plazos cortos');
    expect(shortLeadTimeFragments(email.text)).toEqual([]);
    expect(email.text).not.toContain('plazos cortos');
    expect(email.text).not.toContain('el evento está cerca');
    // The only «urgencia» left is the tone rule that forbids it.
    expect(email.text.match(/urgencia/gi)).toEqual(['urgencia']);
    expect(email.text).toContain('sin urgencia falsa');
  });

  it('keeps the confirmed tone and format byte for byte (only the time angle changes)', () => {
    const kept = [
      '- Español de España, tuteando, tono cercano y profesional. Nada de humo comercial: sin superlativos, sin exclamaciones, sin urgencia falsa, sin frases hechas tipo "solución integral" u "oportunidad única".',
      '- Cuerpo de 120 a 180 palabras, en 3 o 4 párrafos cortos:',
      '## Diferenciales de PubliEXPE (menciona 1 o 2, los que mejor encajen; nunca los cuatro)',
      '  3. Qué le puedes preparar (2 o 3 de los productos recomendados, en genérico) y 1 o 2 diferenciales.',
      '- Asunto: concreto y corto (máximo 70 caracteres), sin mayúsculas sostenidas, sin emojis, sin "Re:" ni "Fwd:".',
      '- No escribas la firma ni ninguna línea de baja o de privacidad: el sistema las añade al final. Termina el cuerpo en la despedida.',
    ];
    for (const line of kept) {
      expect(EMAIL_DRAFTER_SYSTEM_PROMPT).toContain(line);
      expect(email.text).toContain(line);
    }
    // Presentation paragraph (descriptor) untouched.
    const presentation = EMAIL_DRAFTER_SYSTEM_PROMPT.split('\n').find((l) => l.startsWith('  1. Saludo y presentación'))!;
    expect(email.text).toContain(presentation);
    expect(email.removedRatio).toBeLessThan(0.1);
    expect(EMAIL_LEAD_TIME_CHANGELOG).toContain('2026-10-12');
    expect(spec(EMAIL_DRAFTER_SKILL_ID).activation).toMatch(/force/);
  });
});

describe('lead time N in the drafter prompt (computed by code)', () => {
  it('days from today to the event, and the words for them', () => {
    expect(daysUntilEvent('2026-10-26', '2026-10-12')).toBe(14);
    expect(daysUntilEvent('2027-01-10T09:00:00Z', '2026-10-12')).toBe(90);
    expect(daysUntilEvent('2026-10-01', '2026-10-12')).toBe(-11);
    expect(daysUntilEvent(null, '2026-10-12')).toBeNull();
    expect(daysUntilEvent('pronto', '2026-10-12')).toBeNull();
    // Across the DST change (2026-10-25): calendar days, not 24 h slices.
    expect(daysUntilEvent('2026-11-01', '2026-10-24')).toBe(8);
    expect(leadTimeLabel(1)).toBe('1 día');
    expect(leadTimeLabel(10)).toBe('10 días');
    expect(leadTimeLabel(14)).toBe('unas 2 semanas');
    expect(leadTimeLabel(45)).toBe('unas 6 semanas');
    expect(leadTimeLabel(60)).toBe('unos 2 meses');
    expect(leadTimeLabel(91)).toBe('unos 3 meses');
    expect(leadTimeLabel(210)).toBe('unos 7 meses');
    expect(leadTimeLabel(-3)).toBeNull();
    expect(draftLeadTime('2027-01-11', '2026-10-12')).toEqual({ days: 91, label: 'unos 3 meses' });
    expect(draftLeadTime(undefined, '2026-10-12')).toBeNull();
  });

  const base: DraftPromptData = {
    today: '2026-10-12',
    sender: { name: 'Jesús Abril', company: 'PubliEXPE', descriptor: 'expertos en merchandising para empresas' },
    company: { name: 'Conservas Ejemplo', domain: 'conservas.example' },
    contact: null,
    signal: { name: 'Feria de Prueba 2027', type: 'FAIR', date: '2027-01-11', description: null },
    hypothesis: { need: 'Bolsas para el stand.', whyNow: 'Feria en enero.', recommendedProducts: ['bolsas tote'], timing: 'NEXT_QUARTER', differentiators: ['TALLER_PROPIO'] },
  };

  it('the prompt states the event date AND today AND the lead time, before the untrusted block', () => {
    const p = buildDraftPrompt({ ...base, leadTime: draftLeadTime(base.signal!.date, base.today) });
    expect(p.startsWith('Fecha de hoy: 2026-10-12\nAntelación hasta el evento (calculada por el sistema): unos 3 meses (91 días).\nRemitente:')).toBe(true);
    expect(p).toContain('"date": "2027-01-11"');
    expect(p.indexOf('Antelación hasta el evento')).toBeLessThan(p.indexOf('DATOS_NO_CONFIABLES'));
  });

  it('without a date the prompt is exactly as before; a past event is said as such', () => {
    // The untrusted markers carry a random id per call: compare without it.
    const norm = (p: string) => p.replace(/id=[0-9a-f]+/g, 'id=X');
    const before = buildDraftPrompt(base);
    expect(norm(buildDraftPrompt({ ...base, leadTime: null }))).toBe(norm(before));
    expect(before).not.toContain('Antelación');
    expect(leadTimeLine({ days: -5, label: null })).toBe('Antelación hasta el evento (calculada por el sistema): el evento ya se ha celebrado.');
  });
});

describe('knowledge entry of the lead-time rule', () => {
  it('states the window and the calm-production argument', () => {
    expect(LEAD_TIME_KNOWLEDGE_STATEMENT).toContain('menos de 45 días');
    expect(LEAD_TIME_KNOWLEDGE_STATEMENT).toContain('de 45 a 210 días');
    expect(LEAD_TIME_KNOWLEDGE_STATEMENT).toContain('producir con calma');
    expect(LEAD_TIME_KNOWLEDGE_STATEMENT.length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Synthetic lead-time templates (opt-in)
// ---------------------------------------------------------------------------

const leadCases = (seed: number, per = 3) => generateSyntheticCases({ seed, perTemplate: per, leadTime: true }).cases.filter((c) => LEAD_TIME_TEMPLATE_IDS.includes(c.expected.ground_truth.template));
const event = (c: GeneratedCase) => c.input.event as { name: string; date: string; source_url: string };

type H = NonNullable<DecisionView['hypothesis']>;
const hyp = (whyNow: string): H => ({ need: 'Unas 300 bolsas tote (estimación) y 15 polos.', why_now: whyNow, quantity_min: 250, quantity_max: 400, budget_min_eur: 500, budget_max_eur: 1200, recommended_products: ['bolsas tote', 'polos'] });
const decide = (relevant: boolean, confidence: number, reason: string, h: H | null = null): DecisionView => ({ relevant, confidence, reason, writable: relevant && confidence >= 0.5, hypothesis: h });

describe('synthetic lead-time templates (opt-in)', () => {
  it('do not change the default build: same templates, same cases, catalog of 12', () => {
    expect(templatePool().map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    expect(templateCatalog()).toHaveLength(12);
    expect(optInTemplateCatalog().map((t) => t.id)).toEqual(['lead_time_too_close', 'lead_time_comfortable']);
    expect(optInTemplateCatalog().every((t) => t.opt_in && t.patterns.includes('LEAD_TIME'))).toBe(true);
    const plain = generateSyntheticCases({ seed: 9, perTemplate: 3 });
    const withLead = generateSyntheticCases({ seed: 9, perTemplate: 3, leadTime: true });
    expect(withLead.cases).toHaveLength(plain.cases.length + LEAD_TIME_TEMPLATES.length * 3);
    const lead = new Set(withLead.cases.map((c) => c.contentHash));
    for (const c of plain.cases) expect(lead.has(c.contentHash)).toBe(true);
    // Naming one opt-in template is enough to get it.
    const one = generateSyntheticCases({ seed: 9, perTemplate: 2, templates: ['lead_time_too_close'] }).cases;
    expect(one.map((c) => c.expected.ground_truth.template)).toEqual(['lead_time_too_close', 'lead_time_too_close']);
  });

  it('each case has its own reserved fair and an as_of: too close = 7-20 days, comfortable = 75-120 days; deterministic', () => {
    for (const seed of [1, 2, 3]) {
      const cases = leadCases(seed);
      expect(JSON.stringify(cases)).toBe(JSON.stringify(leadCases(seed)));
      expect(new Set(cases.map((c) => event(c).source_url)).size).toBe(cases.length);
      for (const c of cases) {
        const t = c.expected.ground_truth;
        expect(event(c).source_url.endsWith('.invalid/expositores')).toBe(true);
        expect((c.input.exhibitor as { domain: string }).domain.endsWith('.invalid')).toBe(true);
        const days = daysUntilEvent(event(c).date, t.as_of!)!;
        if (t.template === 'lead_time_too_close') {
          expect(days).toBeGreaterThanOrEqual(7);
          expect(days).toBeLessThan(LEAD_TIME_WINDOW_MIN_DAYS);
        } else {
          expect(days).toBeGreaterThanOrEqual(75);
          expect(days).toBeLessThanOrEqual(120);
        }
      }
    }
  });

  it('ground truth by construction: the lead-time rule holds, the rejected behaviour breaks it', () => {
    for (const c of leadCases(5)) {
      const t = c.expected.ground_truth;
      if (t.template === 'lead_time_too_close') {
        expect(truthHolds(runChecks(t, decide(false, 0.05, `${OUT_OF_WINDOW_REASON}: la feria es en 12 días.`)))).toBe(true);
        // What the ACTIVE skill did with Gastrónoma: relevant, pushing the short lead time.
        expect(truthHolds(runChecks(t, decide(true, 0.85, 'Encaje claro.', hyp('La feria está cerca: el taller propio trabaja con plazos cortos.'))))).toBe(false);
        expect(truthHolds(runChecks(t, decide(false, 0.9, 'Fuera de ventana.')))).toBe(false);
      } else {
        expect(truthHolds(runChecks(t, decide(true, 0.85, 'Fabricante con lanzamiento.', hyp('A unos 3 meses de la feria: tiempo para muestras, pruebas de marcaje y producción sin prisas.'))))).toBe(true);
        const r = runChecks(t, decide(true, 0.85, 'Encaje claro.', hyp('Podemos adaptarnos a estos plazos cortos.')));
        expect(truthHolds(r)).toBe(false);
        expect(r.find((x) => x.id === 'no_short_lead_time_angle')).toMatchObject({ status: 'fail', family: 'decision' });
        expect(truthHolds(runChecks(t, decide(false, 0.05, `${OUT_OF_WINDOW_REASON}.`)))).toBe(false);
      }
    }
  });

  it('the runner gives a fixture the as_of of its synthetic cases (else its own clock)', () => {
    const clock = () => new Date('2026-10-12T08:00:00Z');
    expect(fixtureClock(['2027-03-02'], clock)().toISOString()).toBe('2027-03-02T08:00:00.000Z');
    expect(fixtureClock(['2027-03-02', undefined, '2027-03-02'], clock)().toISOString()).toBe('2027-03-02T08:00:00.000Z');
    expect(fixtureClock([undefined], clock)).toBe(clock);
    expect(fixtureClock(['2027-03-02', '2027-04-02'], clock)).toBe(clock);
    expect(fixtureClock(['no-date'], clock)).toBe(clock);
  });
});
