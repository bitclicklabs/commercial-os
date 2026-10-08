import type { ModelPricing, TokenUsage } from './model-provider.js';
import { priceUsage } from './model-provider.js';

/**
 * Gemini API list prices, paid tier, USD per 1M tokens (text input).
 * Source: https://ai.google.dev/gemini-api/docs/pricing ("Last updated 2026-10-06 UTC"),
 * checked on 2026-10-06. Output prices include thinking tokens.
 *
 * EDITABLE: when Google changes prices, add a new period with its `from` date
 * (ISO, UTC) instead of overwriting the old one, so past runs stay reproducible.
 * Periods of a model must be sorted by `from` ascending.
 */
export interface PricingPeriod extends ModelPricing {
  /** First day (inclusive, UTC) the price applies. Omit for "since forever". */
  from?: string;
}

export const GEMINI_PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing (consultado 2026-10-06)';

export const GEMINI_PRICING: Readonly<Record<string, readonly PricingPeriod[]>> = {
  'gemini-3.8-flash': [
    { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedPerMTok: 0.075 },
    { from: '2027-01-01', inputPerMTok: 1.5, outputPerMTok: 7.5, cachedPerMTok: 0.15 },
  ],
  'gemini-3.7-flash': [
    { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedPerMTok: 0.075 },
    { from: '2027-01-01', inputPerMTok: 1.5, outputPerMTok: 7.5, cachedPerMTok: 0.15 },
  ],
  // 2027 input corrected 0.75 -> 1.50 (it was a transcription error): the pricing page
  // ("Last updated 2026-10-07 UTC", checked on 2026-10-08) lists 3.6 / 3.7 / 3.8 Flash with the
  // same prices: $1.50 input, $7.50 output, $0.15 caching starting January 1, 2027. A future
  // period, so no past run was priced with the wrong value.
  'gemini-3.6-flash': [
    { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedPerMTok: 0.075 },
    { from: '2027-01-01', inputPerMTok: 1.5, outputPerMTok: 7.5, cachedPerMTok: 0.15 },
  ],
  'gemini-3.5-flash': [{ inputPerMTok: 1.5, outputPerMTok: 9, cachedPerMTok: 0.15 }],
  'gemini-3.5-flash-lite': [{ inputPerMTok: 0.3, outputPerMTok: 2.5, cachedPerMTok: 0.03 }],
  'gemini-3-flash-preview': [{ inputPerMTok: 0.5, outputPerMTok: 3, cachedPerMTok: 0.05 }],
  'gemini-3.1-flash-lite': [{ inputPerMTok: 0.25, outputPerMTok: 1.5, cachedPerMTok: 0.025 }],
  'gemini-2.5-flash': [{ inputPerMTok: 0.3, outputPerMTok: 2.5, cachedPerMTok: 0.03 }],
  'gemini-2.5-flash-lite': [{ inputPerMTok: 0.1, outputPerMTok: 0.4, cachedPerMTok: 0.01 }],
  // Pro (LLM_JUDGE of the evaluators). Prompts <= 200k tokens; above that the list price is
  // higher (3.1 Pro: 4 / 18 / 0,40; 2.5 Pro: 2,50 / 15 / 0,25) and is not modelled here.
  // Source: pricing page "Last updated 2026-10-07 UTC", checked on 2026-10-07.
  'gemini-3.1-pro-preview': [{ inputPerMTok: 2, outputPerMTok: 12, cachedPerMTok: 0.2 }],
  'gemini-2.5-pro': [{ inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 }],
};

/**
 * `*-latest` aliases. The API reports the concrete model in `modelVersion` and the
 * provider prices by that; the alias entry is only the fallback when a response
 * does not say which model served it. On 2026-10-06 `gemini-flash-latest` was
 * served by `gemini-3.8-flash` (observed in `modelVersion`).
 */
export const GEMINI_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gemini-flash-latest': 'gemini-3.8-flash',
  'gemini-flash-lite-latest': 'gemini-3.5-flash-lite',
  // Observed in `modelVersion` on 2026-10-07.
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
};

/**
 * Editable USD -> EUR rate for reporting costs in EUR (Twenty `agentRunSummary.cost`).
 * Agents may override it with `configuration.usd_to_eur`; set 2026-10-06.
 */
export const DEFAULT_USD_TO_EUR = 0.86;

/** Strips the `models/` prefix and a trailing version suffix the API may add (e.g. `-001`). */
function canonical(model: string): string {
  return model.replace(/^models\//, '').trim();
}

export function resolveGeminiPricing(
  model: string,
  at: Date = new Date(),
  table: Readonly<Record<string, readonly PricingPeriod[]>> = GEMINI_PRICING,
): ModelPricing | undefined {
  let id = canonical(model);
  if (!table[id] && GEMINI_MODEL_ALIASES[id]) id = GEMINI_MODEL_ALIASES[id]!;
  if (!table[id]) id = id.replace(/-\d{3}$/, '');
  const periods = table[id];
  if (!periods || periods.length === 0) return undefined;
  const day = at.toISOString().slice(0, 10);
  let chosen: PricingPeriod | undefined;
  for (const p of periods) if (!p.from || p.from <= day) chosen = p;
  return chosen ?? periods[0];
}

export function priceGeminiUsage(model: string, usage: TokenUsage, at?: Date): number {
  return priceUsage(resolveGeminiPricing(model, at), usage);
}

// ---------------------------------------------------------------------------
// Grounding with Google Search (tool `google_search`)
// ---------------------------------------------------------------------------

/**
 * Grounding with Google Search, paid tier, USD.
 * Source: https://ai.google.dev/gemini-api/docs/pricing ("Last updated 2026-10-07 UTC"),
 * checked on 2026-10-07:
 *
 * - Gemini 3.x (3.8 / 3.7 / 3.6 / 3.5 Flash, 3.5 / 3.1 Flash-Lite, 3 Flash Preview):
 *   "5,000 free search requests per month (shared across all Gemini 3.x models), then
 *   $14 per 1,000 requests". Billed PER SEARCH QUERY: one request to Gemini may run
 *   several Google searches and each one is charged. Not available on the free tier.
 * - Gemini 2.5 Flash / Flash-Lite: 1,500 RPD free, then "$35 / 1,000 grounded prompts"
 *   (billed per grounded prompt, whatever the number of queries).
 *
 * The runtime prices at list price and does NOT deduct the monthly free quota (it is
 * shared per billing account and the runtime cannot see it): reported costs are an
 * upper bound. EDITABLE like `GEMINI_PRICING`: add a period with `from` instead of
 * overwriting.
 */
export interface GroundingPricingPeriod {
  from?: string;
  /** `search_query`: each executed query is billed; `grounded_prompt`: one unit per grounded request. */
  unit: 'search_query' | 'grounded_prompt';
  perThousand: number;
}

export const GEMINI_GROUNDING_PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing (consultado 2026-10-07)';

/** Keyed by model family prefix; the longest matching prefix wins. */
export const GEMINI_GROUNDING_PRICING: Readonly<Record<string, readonly GroundingPricingPeriod[]>> = {
  'gemini-3': [{ unit: 'search_query', perThousand: 14 }],
  'gemini-2.5': [{ unit: 'grounded_prompt', perThousand: 35 }],
};

export function resolveGroundingPricing(model: string, at: Date = new Date()): GroundingPricingPeriod {
  let id = canonical(model);
  if (GEMINI_MODEL_ALIASES[id]) id = GEMINI_MODEL_ALIASES[id]!;
  const prefix = Object.keys(GEMINI_GROUNDING_PRICING)
    .filter((p) => id.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  // Unknown family: price as Gemini 3.x (per query), the current default family.
  const periods = GEMINI_GROUNDING_PRICING[prefix ?? 'gemini-3']!;
  const day = at.toISOString().slice(0, 10);
  let chosen: GroundingPricingPeriod | undefined;
  for (const p of periods) if (!p.from || p.from <= day) chosen = p;
  return chosen ?? periods[0]!;
}

/**
 * Grounding cost of one response. `queries` = `webSearchQueries.length`; a response
 * that ran no search is not billed (per-query families) and counts as grounded only
 * when it actually ran searches or returned sources (per-prompt families).
 */
export function priceGrounding(model: string, grounding: { queries: number; sources: number }, at?: Date): { cost: number; units: number } {
  const p = resolveGroundingPricing(model, at);
  const units = p.unit === 'search_query' ? grounding.queries : grounding.queries > 0 || grounding.sources > 0 ? 1 : 0;
  return { cost: Math.round(((units * p.perThousand) / 1000) * 1_000_000) / 1_000_000, units };
}
