/**
 * RULE evaluators distilled from EXP-001 and EXP-002 (docs/experimentos): the metrics the
 * experiments computed by hand, turned into deterministic per-case checks (no LLM).
 *
 * Every regex and threshold lives in the evaluator's `definition`, so it is part of its
 * content_hash: changing one means a new version. The regexes are COPIED from
 * `src/skills/compare.ts` on purpose (frozen per version); the test suite checks they
 * still agree with the comparison metrics on the EXP-002 data.
 *
 * Dimension of each rule (LLD v0.1 §11.2) and whether it is a hard constraint (§11.3):
 *
 * | Rule                        | Dimension            | Hard | Origin                                   |
 * |-----------------------------|----------------------|------|------------------------------------------|
 * | decision_valid              | TASK_SUCCESS         | no   | errors / invalid decisions of the runs   |
 * | need_has_quantities         | NEXT_ACTION_QUALITY  | no   | F1 (EXP-001/002)                         |
 * | quantity_spread_le_2_5      | NEXT_ACTION_QUALITY  | no   | F1                                       |
 * | budget_derived              | FACTUALITY           | no   | F1 (OP4: units x unit price)             |
 * | assumptions_marked          | FACTUALITY           | no   | F3                                       |
 * | confidence_capped_by_data   | FACTUALITY           | no   | F2 (OP1 cap)                             |
 * | discard_confidence_low      | COMMERCIAL_RELEVANCE | YES  | F4 (EXP-002 criterion 4: verdict NO)     |
 * | source_urls_known           | SOURCE_QUALITY       | YES  | LLD §11.3 `hallucinated_source -> FAIL`  |
 */
import { hostOf, normalizeUrl } from '../agents/source-ledger.js';
import type { CaseEvaluator, CaseInput, CaseOutput, EvaluationContext, EvaluatorOutcome } from './types.js';

/** Statuses that are errors of the run (prospector-core `ERROR_STATUSES`). */
const ERROR_STATUSES = ['llm_error', 'llm_invalid', 'tool_error', 'skipped_unverified_source'];

/** A number in free text that is not a year ("Gastrónoma 2026" is not a quantity). Copied from compare.ts. */
export const QUANTITY_IN_TEXT = /\b(?!(?:19|20)\d\d\b)\d+\b/;

/** Words that mark a statement as an inference. Copied from compare.ts. */
export const INFERENCE_MARKERS =
  /\b(parece|pareceria|parecer|por el nombre|por su nombre|supone|suponemos|suposici[oó]n|asum|previsiblemente|probablemente|posiblemente|podr[ií]a|presumiblemente|sin confirmar|no consta|deducimos|se deduce|intuye)/i;

/** The reason declares notoriety (OP1: the cap may be exceeded only when said in `reason`). */
export const NOTORIETY_MARKERS = /(notori|conocid|conocimiento general|reconocid|l[ií]der|consolidad|referente|multinacional|gran marca)/i;

/** URLs in free text (same shape as `scrubUnknownUrls` in source-ledger.ts). */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'()\[\]{}]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'()\[\]{}]*/gi;

const pass = (dimension: EvaluatorOutcome['dimension'], ok: boolean, details: Record<string, unknown>, score = ok ? 1 : 0): EvaluatorOutcome => ({ dimension, score, pass: ok, details });

// ---------------------------------------------------------------------------

export const decisionValid: CaseEvaluator = {
  id: 'rule.decision_valid',
  version: 1,
  type: 'RULE',
  dimension: 'TASK_SUCCESS',
  hard: false,
  description: 'La decisión existe y es válida: sin error del modelo/CRM, con relevant y confidence, e hipótesis si relevant = true.',
  definition: { error_statuses: ERROR_STATUSES },
  evaluate(_i, o) {
    const problems: string[] = [];
    if (ERROR_STATUSES.includes(o.status)) problems.push(`status ${o.status}`);
    if (o.relevant === null) problems.push('sin relevant');
    if (o.confidence === null) problems.push('sin confidence');
    if (o.relevant === true && !o.hypothesis) problems.push('relevante sin hipótesis');
    return pass('TASK_SUCCESS', problems.length === 0, { status: o.status, problems });
  },
};

export const needHasQuantities: CaseEvaluator = {
  id: 'rule.need_has_quantities',
  version: 1,
  type: 'RULE',
  dimension: 'NEXT_ACTION_QUALITY',
  hard: false,
  description: '«need» lleva unidades aproximadas (un número que no es un año). Solo hipótesis.',
  definition: { regex: QUANTITY_IN_TEXT },
  evaluate(_i, o) {
    if (!o.hypothesis) return null;
    const m = QUANTITY_IN_TEXT.exec(o.hypothesis.need);
    return pass('NEXT_ACTION_QUALITY', m !== null, { first_quantity: m?.[0] ?? null });
  },
};

export const quantitySpread: CaseEvaluator = {
  id: 'rule.quantity_spread_le_2_5',
  version: 1,
  type: 'RULE',
  dimension: 'NEXT_ACTION_QUALITY',
  hard: false,
  description: 'Horquilla de cantidad acotada: quantity_max / quantity_min ≤ 2,5 (quantity_min > 0). Solo hipótesis.',
  definition: { max_ratio: 2.5 },
  evaluate(_i, o) {
    const h = o.hypothesis;
    if (!h) return null;
    if (h.quantity_min <= 0) return pass('NEXT_ACTION_QUALITY', false, { quantity_min: h.quantity_min, quantity_max: h.quantity_max, ratio: null });
    const ratio = Math.round((h.quantity_max / h.quantity_min) * 1000) / 1000;
    return pass('NEXT_ACTION_QUALITY', ratio <= 2.5, { quantity_min: h.quantity_min, quantity_max: h.quantity_max, ratio });
  },
};

export const discardConfidenceLow: CaseEvaluator = {
  id: 'rule.discard_confidence_low',
  version: 1,
  type: 'RULE',
  dimension: 'COMMERCIAL_RELEVANCE',
  hard: true,
  description: 'Un descarte (relevant = false) lleva confianza < 0,2: la confianza mide el encaje comercial, no la seguridad del veredicto (F4).',
  definition: { max_exclusive: 0.2 },
  evaluate(_i, o) {
    if (o.relevant !== false || o.confidence === null) return null;
    return pass('COMMERCIAL_RELEVANCE', o.confidence < 0.2, { confidence: o.confidence });
  },
};

/** Units the need enumerates ("unas 250 bolsas… 10 delantales" = 260); null when it lists none. */
export function needUnits(need: string): number | null {
  const re = /\b\d{1,3}(?:\.\d{3})+\b|\b\d+\b/g;
  let total = 0;
  let found = false;
  for (const m of need.matchAll(re)) {
    const raw = m[0];
    const n = Number(raw.replace(/\./g, ''));
    if (/^(19|20)\d\d$/.test(raw)) continue; // a year
    const after = need.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 8);
    if (/^\s?(€|%|euros?|m²|m2|,\d)/i.test(after)) continue; // money, percentages, surfaces, decimals
    const before = need.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0);
    if (before === ',' || before === '.') continue; // decimal part
    total += n;
    found = true;
  }
  return found ? total : null;
}

export const budgetDerived: CaseEvaluator = {
  id: 'rule.budget_derived',
  version: 1,
  type: 'RULE',
  dimension: 'FACTUALITY',
  hard: false,
  description:
    'El presupuesto se deriva de las unidades: precio unitario implícito (presupuesto medio / cantidad media) entre 0,50 y 15 € y suma de unidades de «need» dentro de la horquilla. 1 si ambas; 0,5 si el precio cuadra pero «need» no enumera unidades; 0 si no.',
  definition: { unit_price_eur: [0.5, 15], need_units_within_range: true, partial_score_without_units: 0.5 },
  evaluate(_i, o) {
    const h = o.hypothesis;
    if (!h) return null;
    const qMid = (h.quantity_min + h.quantity_max) / 2;
    const unit = qMid > 0 ? Math.round(((h.budget_min_eur + h.budget_max_eur) / 2 / qMid) * 100) / 100 : null;
    const priceOk = unit !== null && unit >= 0.5 && unit <= 15;
    const units = needUnits(h.need);
    const unitsOk = units !== null && units >= h.quantity_min && units <= h.quantity_max;
    const score = !priceOk ? 0 : units === null ? 0.5 : unitsOk ? 1 : 0;
    return { dimension: 'FACTUALITY', score, pass: score === 1, details: { unit_price_eur: unit, price_in_band: priceOk, need_units: units, need_units_in_range: units === null ? null : unitsOk } };
  },
};

export const assumptionsMarked: CaseEvaluator = {
  id: 'rule.assumptions_marked',
  version: 1,
  type: 'RULE',
  dimension: 'FACTUALITY',
  hard: false,
  description: 'Solo nombre: la razón marca lo deducido como suposición (parece, por el nombre, suponemos…) (F3).',
  definition: { data_level: 'name_only', regex: INFERENCE_MARKERS },
  evaluate(i, o) {
    if (i.dataLevel !== 'name_only' || !o.reason || o.confidence === null) return null;
    const m = INFERENCE_MARKERS.exec(o.reason);
    return pass('FACTUALITY', m !== null, { marker: m?.[0] ?? null });
  },
};

export const confidenceCappedByData: CaseEvaluator = {
  id: 'rule.confidence_capped_by_data',
  version: 1,
  type: 'RULE',
  dimension: 'FACTUALITY',
  hard: false,
  description: 'Relevantes: la confianza no supera lo que permiten los datos (solo nombre ≤ 0,6; nombre y sector ≤ 0,75) salvo notoriedad declarada en la razón (F2, OP1).',
  definition: { caps: { name_only: 0.6, sector: 0.75 }, notoriety_regex: NOTORIETY_MARKERS },
  evaluate(i, o) {
    if (o.relevant !== true || o.confidence === null) return null;
    const cap = i.dataLevel === 'name_only' ? 0.6 : i.dataLevel === 'sector' ? 0.75 : null;
    if (cap === null) return null;
    const notoriety = o.reason ? (NOTORIETY_MARKERS.exec(o.reason)?.[0] ?? null) : null;
    const within = o.confidence <= cap;
    return pass('FACTUALITY', within || notoriety !== null, { data_level: i.dataLevel, confidence: o.confidence, cap, notoriety_declared: notoriety });
  },
};

/** Every URL a case carries: free text of the decision plus the URLs the run wrote for it. */
export function caseUrls(o: CaseOutput): string[] {
  const texts = [o.reason ?? '', o.hypothesis?.need ?? '', o.hypothesis?.why_now ?? '', ...(o.hypothesis?.recommended_products ?? [])];
  const found = texts.flatMap((t) => [...t.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,;:!?]+$/, '')));
  const all = [...found.map((u) => (u.startsWith('www.') ? `https://${u}` : u)), ...(o.writtenUrls ?? [])];
  return [...new Set(all)];
}

export function isKnownUrl(url: string, known: EvaluationContext['knownSources']): boolean {
  const key = normalizeUrl(url);
  if (key === null) return false;
  if (known.urls.some((k) => normalizeUrl(k) === key)) return true;
  const host = hostOf(url);
  return host !== null && known.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export const sourceUrlsKnown: CaseEvaluator = {
  id: 'rule.source_urls_known',
  version: 1,
  type: 'RULE',
  dimension: 'SOURCE_QUALITY',
  hard: true,
  description:
    'Toda URL del caso (texto libre y fuentes escritas en el CRM) está en el SourceLedger de la ejecución (visitada o devuelta por grounding) o venía en la entrada (URL del evento, dominio del expositor). Una URL desconocida es una fuente alucinada.',
  definition: { known: ['ledger.visited', 'ledger.grounded', 'input.event.source_url', 'input.exhibitor.domain', 'crm.company.domain'], match: 'normalized url or same host as a known domain' },
  evaluate(_i: CaseInput, o: CaseOutput, ctx: EvaluationContext) {
    if (ERROR_STATUSES.includes(o.status) && o.confidence === null) return null;
    const urls = caseUrls(o);
    const unknown = urls.filter((u) => !isKnownUrl(u, ctx.knownSources));
    const score = urls.length === 0 ? 1 : (urls.length - unknown.length) / urls.length;
    return { dimension: 'SOURCE_QUALITY', score, pass: unknown.length === 0, details: { urls: urls.length, unknown } };
  },
};

/** The RULE catalog, in pipeline order. */
export const RULE_EVALUATORS: readonly CaseEvaluator[] = [
  decisionValid,
  needHasQuantities,
  quantitySpread,
  budgetDerived,
  assumptionsMarked,
  confidenceCappedByData,
  discardConfidenceLow,
  sourceUrlsKnown,
];
