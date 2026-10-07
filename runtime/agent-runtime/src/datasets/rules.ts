/**
 * Declared rules that give a case its `expected` without a human verdict ("descartes
 * estructurales"). Only rules the active skill states as hard rules qualify:
 * `prospector-event-exhibitors` says "Administraciones, organismos y empresas públicas:
 * compran por licitación pública" -> relevant = false, hypothesis = null, and its calibration
 * puts every "no fit" in 0-0,19. So a public body has a known expected behaviour.
 *
 * The patterns are deliberately narrow (high precision): a false positive would put a wrong
 * expected value in a dataset. They run on the folded name, sector and description (no
 * diacritics, lower case). Sector alone is not enough: Feria Valencia mixes
 * "Organismos públicos, asociaciones" in one category, and associations are private.
 */
import { foldEntityName } from './core.js';

export interface PublicBodyMatch {
  rule: 'public_body';
  /** Pattern family that matched. */
  pattern: 'government' | 'university' | 'regulatory_council' | 'public_company';
  field: 'name' | 'description' | 'sector';
  matched: string;
}

const NAME_PATTERNS: Array<{ pattern: PublicBodyMatch['pattern']; re: RegExp }> = [
  {
    pattern: 'government',
    re: /\b(xunta|generalitat|junta de [a-z]+|gobierno de|govern de|diputacion|diputacio|ayuntamiento|ajuntament|concello|cabildo|consejeria|conselleria|ministerio|ivace)\b/,
  },
  { pattern: 'university', re: /\b(universidad de|universitat de|universidade de|universitat politecnica|universidad politecnica)\b/ },
  { pattern: 'regulatory_council', re: /\b(denominacion de origen|denominacio d origen|consejo regulador|consell regulador|indicacion geografica protegida)\b|^(dop|igp)\b/ },
];

const TEXT_PATTERNS: Array<{ pattern: PublicBodyMatch['pattern']; re: RegExp }> = [
  { pattern: 'public_company', re: /\b(capital (integramente )?publico|empresa publica|organismo publico|licitacion publica|ley de contratos del sector publico)\b/ },
  { pattern: 'government', re: /\badministracion publica\b/ },
];

/** First public-body pattern that matches the exhibitor, or null. */
export function matchPublicBody(ex: { name: string; sector?: string | null | undefined; description?: string | null | undefined }): PublicBodyMatch | null {
  const name = foldEntityName(ex.name);
  for (const p of NAME_PATTERNS) {
    const m = p.re.exec(name);
    if (m) return { rule: 'public_body', pattern: p.pattern, field: 'name', matched: m[0] };
  }
  for (const field of ['description', 'sector'] as const) {
    const value = ex[field];
    if (!value) continue;
    const text = foldEntityName(value);
    for (const p of TEXT_PATTERNS) {
      // "administracion publica" is only trusted as an exact sector, never inside a mixed category.
      if (field === 'sector' && p.pattern === 'government' && text !== 'administracion publica') continue;
      const m = p.re.exec(text);
      if (m) return { rule: 'public_body', pattern: p.pattern, field, matched: m[0] };
    }
  }
  return null;
}

/** `expected` of a public body (the skill's hard rule and calibration). */
export function publicBodyExpected(match: PublicBodyMatch): Record<string, unknown> {
  return {
    kind: 'structural_discard',
    relevant: false,
    writable: false,
    hypothesis: null,
    confidence_max: 0.19,
    rule: match.rule,
    rule_pattern: match.pattern,
    rule_text: 'Administraciones, organismos y empresas públicas: compran por licitación pública (prospector-event-exhibitors, "Cuándo NO es relevante"); 0-0,19: no hay encaje.',
  };
}
