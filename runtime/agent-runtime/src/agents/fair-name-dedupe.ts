/**
 * Tanda 25: dedupe of fairs by normalized name (pure, unit-tested).
 *
 * The scout's other dedupes (create_signal: company + type + date + source domain; across sectors:
 * URL or folded name + exact date) miss the same fair spelled twice by the search model: on
 * 2026-10-22 it created "Barcelona Wine Week (BWW) 2027 (feria)" next to the QUALIFIED
 * "Barcelona Wine Week 2027 (feria)". Before recording a fair proposed by the search, the scout
 * compares it with every event-level signal of the tenant (any status: one the commercial
 * DISCARDED or that EXPIRED is not brought back either).
 *
 * Normalized name ({@link fairNameTokens}):
 *  1. without the "(feria)" / "(congreso)" / "(evento)" suffix the scout adds to its titles;
 *  2. without acronyms in parentheses, all capitals in the original: "(BWW)", "(IFEMA)";
 *  3. lowercase, without accents;
 *  4. without edition texts and ordinals: "15ª edición", "20.ª edición", "1ª Edición", "edición 25",
 *     "XV edición", a loose "25º";
 *  5. without years (19xx / 20xx);
 *  6. without signs (dashes, dots, parentheses...) and without the words de, del, la, las, el,
 *     los, y, e, en, the, of, and.
 *
 * Two fairs are the same ({@link sameFair}) when ALL of these hold:
 *  - the year of both is known and equal (the date's year, else the year in the name; without a
 *    year on either side they never match: different editions must not merge);
 *  - if both have a date, they are at most {@link MAX_DAYS_APART} days apart;
 *  - the normalized names are equal, OR they are equal once city words are removed
 *    ({@link CITY_WORDS}), the rest has at least 2 words and the cities of one side are a subset of
 *    the other's ("Retail Forum" vs "Retail Forum Madrid" match; "Retail Forum Madrid" vs "Retail
 *    Forum Barcelona" and "Gourmets" vs "Gourmets Barcelona" do not).
 */

/** Signal types the scout records for a fair (signal-prospecting's EVENT_SIGNAL_TYPES; not imported to avoid a cycle). */
export const FAIR_SIGNAL_TYPES = ['FAIR', 'CONGRESS', 'EVENT'] as const;

export const MAX_DAYS_APART = 10;

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'en', 'the', 'of', 'and']);

/**
 * Single-word city names (folded) that the search model adds or drops from a fair's name
 * ("Retail Forum Madrid"). Only used to tolerate an EXTRA city on one side, never to match two
 * different cities.
 */
export const CITY_WORDS: ReadonlySet<string> = new Set([
  'madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao', 'malaga', 'zaragoza', 'murcia', 'alicante', 'valladolid',
  'vigo', 'gijon', 'oviedo', 'coruna', 'granada', 'cordoba', 'palma', 'pamplona', 'santander', 'donostia',
  'vitoria', 'salamanca', 'burgos', 'leon', 'cadiz', 'almeria', 'huelva', 'jaen', 'badajoz', 'caceres',
  'toledo', 'girona', 'tarragona', 'lleida', 'castellon', 'logrono', 'santiago',
  'lisboa', 'oporto', 'porto', 'paris', 'londres', 'london', 'milan', 'milano', 'berlin', 'colonia', 'koln',
  'dusseldorf', 'frankfurt', 'munich', 'hannover', 'nuremberg', 'amsterdam', 'bruselas', 'lyon',
]);

/** Normalized name as words (rules 1-6 of the module doc). */
export function fairNameTokens(name: string): string[] {
  let s = name
    .replace(/\(\s*(?:feria|congreso|evento)\s*\)/gi, ' ')
    // Acronyms in parentheses, all capitals in the original ("(BWW)"): before lowercasing.
    .replace(/\(\s*[A-Z][A-Z0-9&.+-]{1,11}\s*\)/g, ' ');
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s
    // "15ª edición", "20.ª edición", "1a edicion", "25 edición", "15º edicion"
    .replace(/\b\d{1,3}\s*\.?\s*[ªº°]?\s*(?:a|o)?\s*edicion\b/g, ' ')
    // "edición 25", "edición nº 25"
    .replace(/\bedicion\s+(?:n[ºo°]?\.?\s*)?\d{1,3}\b/g, ' ')
    // "XV edición"
    .replace(/\b[ivxlc]{1,7}\s+edicion\b/g, ' ')
    // A loose ordinal: "25º", "3.ª"
    .replace(/\b\d{1,3}\s*\.?\s*[ªº°]/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ');
  return s
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** The normalized name as one string (empty when nothing is left). */
export function fairNameKey(name: string): string {
  return fairNameTokens(name).join(' ');
}

/** The fair's year: its date's year, else the (single) year in its name. */
export function fairYear(f: { name: string; date: string | null }): number | null {
  if (f.date && /^\d{4}-\d{2}-\d{2}/.test(f.date)) return Number(f.date.slice(0, 4));
  const years = [...new Set([...f.name.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1])))];
  return years.length === 1 ? years[0]! : null;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
}

export type FairMatchRule = 'nombre_normalizado' | 'nombre_sin_ciudad';

/** Whether two fairs are the same one (rules in the module doc); the rule that matched, or null. */
export function sameFair(a: { name: string; date: string | null }, b: { name: string; date: string | null }): FairMatchRule | null {
  const ya = fairYear(a);
  const yb = fairYear(b);
  if (ya === null || yb === null || ya !== yb) return null;
  if (a.date && b.date && daysApart(a.date, b.date) > MAX_DAYS_APART) return null;
  const ta = fairNameTokens(a.name);
  const tb = fairNameTokens(b.name);
  if (ta.length === 0 || tb.length === 0) return null;
  if (ta.join(' ') === tb.join(' ')) return 'nombre_normalizado';
  const restA = ta.filter((t) => !CITY_WORDS.has(t));
  const restB = tb.filter((t) => !CITY_WORDS.has(t));
  if (restA.length < 2 || restA.join(' ') !== restB.join(' ')) return null;
  const citiesA = new Set(ta.filter((t) => CITY_WORDS.has(t)));
  const citiesB = new Set(tb.filter((t) => CITY_WORDS.has(t)));
  const subset = (x: Set<string>, y: Set<string>) => [...x].every((c) => y.has(c));
  return subset(citiesA, citiesB) || subset(citiesB, citiesA) ? 'nombre_sin_ciudad' : null;
}

/** An event-level fair signal already in the CRM (or recorded earlier in this run). */
export interface KnownFair {
  id: string;
  name: string;
  status: string;
  date: string | null;
}

/** The first known fair that is the same as `candidate`, with the rule that matched. */
export function findSameFair(
  candidate: { name: string; date: string | null },
  known: readonly KnownFair[],
): { fair: KnownFair; rule: FairMatchRule } | null {
  for (const fair of known) {
    const rule = sameFair(candidate, fair);
    if (rule) return { fair, rule };
  }
  return null;
}
