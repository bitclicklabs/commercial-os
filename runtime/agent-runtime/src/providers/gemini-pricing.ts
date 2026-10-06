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
  'gemini-3.6-flash': [
    { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedPerMTok: 0.075 },
    { from: '2027-01-01', inputPerMTok: 0.75, outputPerMTok: 7.5, cachedPerMTok: 0.15 },
  ],
  'gemini-3.5-flash': [{ inputPerMTok: 1.5, outputPerMTok: 9, cachedPerMTok: 0.15 }],
  'gemini-3.5-flash-lite': [{ inputPerMTok: 0.3, outputPerMTok: 2.5, cachedPerMTok: 0.03 }],
  'gemini-3-flash-preview': [{ inputPerMTok: 0.5, outputPerMTok: 3, cachedPerMTok: 0.05 }],
  'gemini-3.1-flash-lite': [{ inputPerMTok: 0.25, outputPerMTok: 1.5, cachedPerMTok: 0.025 }],
  'gemini-2.5-flash': [{ inputPerMTok: 0.3, outputPerMTok: 2.5, cachedPerMTok: 0.03 }],
  'gemini-2.5-flash-lite': [{ inputPerMTok: 0.1, outputPerMTok: 0.4, cachedPerMTok: 0.01 }],
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
