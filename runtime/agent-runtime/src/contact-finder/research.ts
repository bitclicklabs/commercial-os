/**
 * The Research record "Contacto — <empresa>" / "Sin contacto público — <empresa>" (pure,
 * unit tested). It is the audit trail of the ContactFinder: every candidate with its
 * priority, the EXACT URL where the company published it (or the enrichment provider, its
 * confidence and the date: GDPR traceability), the discarded ones and why, the pages read,
 * and the chosen address with its reason. The commercial checks the source in one click.
 *
 * Plain text (Twenty shows `summary` as text); web-derived names and titles are sanitised.
 */
import { TIER_LABELS } from './classify.js';
import type { ContactCandidate, FinderResult } from './finder.js';

export const CONTACT_RESEARCH_TYPE = 'CONTACT_DISCOVERY' as const;

export function contactResearchName(companyName: string, found: boolean): string {
  return `${found ? 'Contacto' : 'Sin contacto público'} — ${companyName}`.slice(0, 255);
}

/** `query` of the Research: lets the backfill find the Research of a hypothesis. */
export function contactResearchQuery(hypothesisId: string, domain: string): string {
  return `contacto:hipotesis:${hypothesisId} dominio:${domain}`;
}

/** Web text -> one safe line (no control chars, no angle brackets, max `max`). */
export function cleanWebText(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  const t = text
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length === 0 ? null : t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const VIA_TEXT: Record<string, string> = { mailto: 'enlace mailto', text: 'texto', obfuscated: 'texto ofuscado', cfemail: 'protección Cloudflare', jsonld: 'datos estructurados', enrich: 'proveedor' };

function person(c: Pick<ContactCandidate, 'name' | 'jobTitle'>): string | null {
  const parts = [cleanWebText(c.name, 80), cleanWebText(c.jobTitle, 100)].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

function sourcesText(c: ContactCandidate): string {
  if (c.origin !== 'web') {
    const conf = c.confidence !== null ? `, confianza ${c.confidence.toFixed(2)}` : '';
    const urls = c.sources.map((s) => s.url).filter((u) => !u.endsWith(`/`) || c.sources.length > 1);
    return `proveedor ${c.origin}${conf}${urls.length > 0 ? `; visto en ${urls.slice(0, 3).join(', ')}` : ''}`;
  }
  return c.sources
    .slice(0, 4)
    .map((s) => `${s.url} (${VIA_TEXT[s.via] ?? s.via})`)
    .join(', ');
}

export function researchConfidence(result: Pick<FinderResult, 'chosen' | 'candidates'>): number {
  if (!result.chosen) return 0;
  const c = result.candidates.find((x) => x.email === result.chosen!.email);
  if (!c) return 0;
  if (c.origin !== 'web') return Math.round((c.confidence ?? 0) * 100) / 100;
  return ({ 1: 0.9, 2: 0.85, 3: 0.8, 4: 0.6, 5: 0.2 } as const)[c.tier];
}

export interface ResearchWriteState {
  hypothesisName: string;
  /** What happened with `emailTo`. */
  emailTo: 'written' | 'already_set' | 'human_owned' | 'not_written' | 'decision_maker';
  /** Tie broken by the LLM (rol triage), when it happened. */
  triage: { email: string; reason: string } | null;
  timeZone?: string;
}

const EMAIL_TO_TEXT: Record<ResearchWriteState['emailTo'], string> = {
  written: 'Escrita en «Email to» de la hipótesis (estaba vacío).',
  already_set: 'No se toca «Email to»: la hipótesis ya tenía un destinatario.',
  human_owned: 'No se toca «Email to»: el borrador ya está revisado o enviado por una persona.',
  not_written: 'No se ha escrito en «Email to».',
  decision_maker: 'No se toca «Email to»: la hipótesis tiene un decisor con email.',
};

export function buildContactResearchSummary(result: FinderResult, state: ResearchWriteState): string {
  const tz = state.timeZone ?? 'Europe/Madrid';
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(result.searchedAt));
  const lines: string[] = [];
  const chosen = result.chosen ? result.candidates.find((c) => c.email === result.chosen!.email) : undefined;
  if (result.chosen && chosen) {
    const who = person(chosen);
    lines.push(`Contacto elegido: ${chosen.email}${who ? ` (${who})` : ''}`);
    lines.push(`Por qué: ${result.chosen.reason}${state.triage ? `; desempate entre ${result.tie.length} candidatos equivalentes por el modelo: ${cleanWebText(state.triage.reason, 200) ?? 'sin motivo'}` : ''}.`);
    lines.push(`Fuente: ${sourcesText(chosen)}`);
    lines.push(EMAIL_TO_TEXT[state.emailTo]);
  } else {
    lines.push(`Sin contacto público: ${result.noChoiceReason ?? 'no se ha encontrado ninguna dirección utilizable'}.`);
    lines.push('No se ha escrito nada en «Email to» y no se ha inventado ninguna dirección.');
  }
  lines.push(`Hipótesis: ${state.hypothesisName}. Dominio: ${result.domain}. Fecha de la búsqueda: ${date} (${tz}).`);

  const listed = result.candidates.slice(0, 20);
  lines.push('', listed.length > 0 ? 'Candidatos (por prioridad):' : 'Candidatos: ninguno.');
  listed.forEach((c, i) => {
    const who = person(c);
    const flags = [
      c.tier === 5 ? 'nunca se propone' : null,
      c.onDomain && c.mx !== 'ok' && c.mx !== 'not_checked' ? `MX ${c.mx === 'none' ? 'inexistente' : 'no verificable'}` : null,
      c.origin !== 'web' && (c.confidence ?? 0) < 0.7 ? 'confianza < 0,70: no se escribe en Email to' : null,
    ].filter(Boolean);
    lines.push(`${i + 1}. ${c.email} — prioridad ${c.tier}, ${c.tier === 1 ? `${TIER_LABELS[1]} (${c.roleKind})` : c.label}${who ? ` — ${who}` : ''} — ${sourcesText(c)}${flags.length > 0 ? ` [${flags.join('; ')}]` : ''}`);
  });
  if (result.discarded.length > 0) {
    lines.push('', 'Descartados:');
    for (const d of result.discarded.slice(0, 20)) lines.push(`- ${d.email} — ${d.reason} — ${d.sources.map((s) => s.url).slice(0, 2).join(', ') || d.origin}`);
  }
  if (result.pages.length > 0) {
    lines.push('', `Páginas consultadas (${result.pages.length}):`);
    for (const p of result.pages) lines.push(`- ${p.finalUrl ?? p.url} — ${p.method === 'render' ? 'renderizada, ' : ''}${p.status === 'ok' ? `${p.emails} dirección(es)` : `error ${p.code}`}`);
  }
  const mx = Object.entries(result.mx);
  lines.push(
    '',
    `Verificación: sintaxis + registros MX del dominio${mx.length > 0 ? ` (${mx.map(([d, s]) => `${d}: ${s}`).join(', ')})` : ''}. Sin sondeo SMTP.`,
    `Lista de supresión: ${result.suppressionChecked ? 'comprobada' : 'NO disponible (no se propone ninguna dirección)'}.`,
    `Enriquecimiento externo: ${enrichText(result)}.`,
    'El sistema no envía nada: revisa la dirección antes de pulsar «Enviar borrador de email».',
  );
  return lines.join('\n').slice(0, 19_000);
}

function enrichText(result: FinderResult): string {
  const e = result.enrich;
  switch (e.status) {
    case 'not_asked':
      return 'no consultado';
    case 'not_needed':
      return 'no necesario (hay contacto publicado)';
    case 'unavailable':
      return 'no disponible';
    case 'cap_reached':
      return `no consultado: tope diario alcanzado (${e.lookupsToday}/${e.cap})`;
    case 'error':
      return `${e.provider}: error (${e.message ?? 'desconocido'})`;
    case 'ok':
      return `${e.provider}, consulta ${e.lookupsToday}/${e.cap} de hoy${e.costEur > 0 ? `, coste ${e.costEur.toFixed(2)} €` : ''}`;
  }
}

export function buildContactStructuredResult(result: FinderResult, state: ResearchWriteState & { hypothesisId: string }): Record<string, unknown> {
  return {
    version: 1,
    hypothesis_id: state.hypothesisId,
    domain: result.domain,
    searched_at: result.searchedAt,
    chosen: result.chosen ? { ...result.chosen, ...(state.triage ? { tie_break: { by: 'llm_triage', reason: cleanWebText(state.triage.reason, 300) } } : {}) } : null,
    no_choice_reason: result.noChoiceReason,
    email_to: state.emailTo,
    candidates: result.candidates.slice(0, 30).map((c) => ({
      email: c.email,
      name: cleanWebText(c.name, 80),
      job_title: cleanWebText(c.jobTitle, 100),
      priority: c.tier,
      label: c.label,
      origin: c.origin,
      confidence: c.confidence,
      on_domain: c.onDomain,
      mx: c.mx,
      sources: c.sources.slice(0, 5),
    })),
    discarded: result.discarded.slice(0, 30).map((d) => ({ email: d.email, reason: d.reason, origin: d.origin, sources: d.sources.slice(0, 3) })),
    pages: result.pages,
    suppression_checked: result.suppressionChecked,
    mx: result.mx,
    enrich: result.enrich,
    tie: result.tie,
    smtp_probe: false,
  };
}

/** URLs of the Research (`sources`, http(s), max 50): pages read + where each candidate was published. */
export function contactResearchSources(result: FinderResult): string[] {
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    if (!u || out.length >= 50) return;
    try {
      const url = new URL(u);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      const s = url.toString();
      if (s.length <= 2048 && !out.includes(s)) out.push(s);
    } catch {
      /* not a URL */
    }
  };
  if (result.chosen) add(result.chosen.sourceUrl);
  for (const c of result.candidates) for (const s of c.sources) add(s.url);
  for (const p of result.pages) add(p.finalUrl ?? p.url);
  if (out.length === 0) add(`https://${result.domain}/`);
  return out;
}
