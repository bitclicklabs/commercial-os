/**
 * Company signals of the Prospector (tanda 21; conventions in src/signals/company-signal.ts).
 *
 * A) Discovery (`discoverCompanySignals`, weekly scout, one call per sector after its fairs):
 *    1. ONE grounded search (Gemini + Google Search) for news of the last 60 days of companies of
 *       the sector in the region: openings, funding rounds, anniversaries;
 *    2. per proposed news, by code: valid kind, news date at most COMPANY_SIGNAL_FRESH_DAYS old,
 *       not already seen in this run (same article URL, or same company + kind in another
 *       sector), URL backed by grounding (redirects resolved like the scout) or, when the search
 *       returned no sources, accepted only by corroboration (`verify_unsourced_by_fetch`);
 *    3. `fetch_url` of the article (SSRF guard): it must download AND name the company (same
 *       corroboration as an unsourced fair). Without a verifiable source nothing is created;
 *    4. `create_signal` event-level, NEW, `"<empresa>: <qué pasó> — <tipo>"`, eventDate = news
 *       date, sourceUrl = the article, idempotent by the article URL (`dedupeBySourceUrl`).
 *
 * B) Prospecting of ONE qualified company signal (`runCompanySignal`: trigger on qualification or
 *    the daily round-robin). No exhibitor catalog: the company itself is evaluated.
 *    1. news older than COMPANY_SIGNAL_EXPIRY_DAYS: SKIPPED (the daily run expires it);
 *    2. `fetch_url` of the article (re-verified; its text is the evaluation input, untrusted);
 *    3. ONE LLM decision (relevance for merchandising, the news as why_now);
 *    4. relevant: company domain by the tanda 20 resolver (Twenty first, then grounded search +
 *       verification); no verified domain (ambiguous / not found / resolver off) -> no company, no
 *       hypothesis, and a short note on the signal with the candidates (PM decision 10);
 *    5. `upsert_company` -> `create_research` (SIGNAL_VERIFICATION) -> `create_hypothesis` PROPOSED,
 *       both linked to THE QUALIFIED SIGNAL itself (no second per-company signal is written). The
 *       hypothesis `whyNow` always starts with the news (by code).
 */
import { normalizeDomain } from '../integrations/twenty/index.js';
import type { FetchUrlOutput } from '../tools/web/fetch-url.js';
import { useKnowledge } from '../knowledge/resolver.js';
import {
  COMPANY_SIGNAL_EXPIRY_DAYS,
  COMPANY_SIGNAL_FRESH_DAYS,
  COMPANY_SIGNAL_LABEL_ES,
  COMPANY_SIGNAL_TYPE,
  companySignalFreshness,
  companySignalKindOfName,
  companySignalTitle,
  isExpiredCompanySignal,
  newsAgeDays,
  parseCompanySignalName,
  type CompanySignalKind,
} from '../signals/company-signal.js';
import { madridToday } from '../signals/lead-time.js';
import {
  buildCompanyNewsRepairPrompt,
  buildCompanyNewsSearchPrompt,
  buildCompanySignalPrompt,
  COMPANY_NEWS_SEARCH_SYSTEM_PROMPT,
  COMPANY_SIGNAL_DECISION_JSON_SCHEMA,
  COMPANY_SIGNAL_SYSTEM_PROMPT,
  NewsSearchAnswer,
  parseCompanySignalDecision,
  type CompanySignalDecision,
} from './company-signals-prompt.js';
import { domainResolverConfigFromEnv, DomainResolverSession, resolveExhibitorDomain, type DomainResolverConfig } from './domain-resolver.js';
import { foldText, pageCorroboratesEvent } from './event-scout.js';
import { exhibitorCounters, formatEur, parseWith, resultLine, toolError, type ExhibitorResult, type ProspectorRun, type RunOutcome } from './prospector-core.js';
import { hostOf, normalizeUrl, scrubUnknownUrls, SourceLedger } from './source-ledger.js';

// ---------------------------------------------------------------------------
// A) Discovery (weekly scout)
// ---------------------------------------------------------------------------

/** Default company signals created per sector and run (agent configuration `scout.max_company_signals_per_sector`). */
export const DEFAULT_MAX_COMPANY_SIGNALS_PER_SECTOR = 3;
export const MAX_COMPANY_SIGNALS_PER_SECTOR_CAP = 5;
/** Characters of the article read to corroborate it (and, at qualification, to evaluate the company). */
const ARTICLE_MAX_CHARS = 20_000;
const ARTICLE_TEXT_FOR_PROMPT = 12_000;

/** Keys shared by the sectors of one run: an article or a company + kind is recorded once. */
export class CompanySignalSeen {
  private readonly keys = new Set<string>();
  static urlKey(url: string): string {
    return `url:${normalizeUrl(url) ?? url}`;
  }
  static companyKey(company: string, kind: CompanySignalKind): string {
    return `co:${kind}:${foldText(company)}`;
  }
  has(key: string): boolean {
    return this.keys.has(key);
  }
  add(...keys: string[]): void {
    for (const k of keys) this.keys.add(k);
  }
}

export interface CompanySignalEntry {
  company: string;
  kind: CompanySignalKind;
  what: string;
  news_date: string | null;
  url: string | null;
  status: 'signal_created' | 'signal_existing' | 'signal_error' | 'discarded';
  reason?: string;
  age_days?: number | null;
  source_url?: string;
  signal_id?: string;
  verification?: 'grounding_domain' | 'fetch_corroboration';
  error?: { code: string; message: string };
}

export interface CompanyDiscoveryResult {
  search: { queries: string[]; sources: number; proposed: number; verification: 'grounding_sources' | 'fetch_corroboration' | 'none' } | null;
  search_error?: { code: string; message: string };
  entries: CompanySignalEntry[];
  counters: { proposed: number; created: number; existing: number; discarded: number; errors: number; fetches: number; skipped_time_budget: number };
}

export interface CompanyDiscoveryArgs {
  sector: string;
  region: string;
  /** Madrid day (YYYY-MM-DD). */
  today: string;
  maxSignals: number;
  ledger: SourceLedger;
  seen: CompanySignalSeen;
  outOfTime: () => boolean;
  confidence: number;
  verifyUnsourced: boolean;
  maxRedirectResolutions: number;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Does the downloaded article name the company? Folded name in title + text, else the fair-name rule. */
export function pageNamesCompany(company: string, page: Pick<FetchUrlOutput, 'title' | 'text' | 'finalUrl'>): boolean {
  const name = foldText(company);
  if (name.length >= 2 && foldText(`${page.title ?? ''}\n${page.text}`).includes(name)) return true;
  return pageCorroboratesEvent(company, page);
}

export async function discoverCompanySignals(run: ProspectorRun, a: CompanyDiscoveryArgs): Promise<CompanyDiscoveryResult> {
  const { ledger } = a;
  const out: CompanyDiscoveryResult = { search: null, entries: [], counters: { proposed: 0, created: 0, existing: 0, discarded: 0, errors: 0, fetches: 0, skipped_time_budget: 0 } };
  const search = await run.completeJson({
    label: { step: 'company_signal_search', sector: a.sector, region: a.region },
    system: COMPANY_NEWS_SEARCH_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildCompanyNewsSearchPrompt({ sector: a.sector, region: a.region, today: a.today, since: shiftDay(a.today, -COMPANY_SIGNAL_FRESH_DAYS), maxSignals: a.maxSignals }) }],
    parse: (text) => parseWith(NewsSearchAnswer, text),
    grounding: true,
    repair: (previous, error) => [{ role: 'user', content: buildCompanyNewsRepairPrompt(previous, error) }],
  });
  if (search.status === 'model_error') {
    out.search_error = { code: search.code, message: search.message };
    return out;
  }
  if (search.grounding) ledger.addGrounding(search.grounding.sources);
  if (search.status === 'invalid') {
    out.search_error = { code: 'LLM_INVALID_OUTPUT', message: search.message };
    return out;
  }
  const grounding = search.grounding;
  const hasSources = (grounding?.sources.length ?? 0) > 0;
  const searched = (grounding?.queries.length ?? 0) > 0 || (grounding?.diagnostics?.toolCalls ?? 0) > 0;
  const corroborateOnly = !hasSources && searched && a.verifyUnsourced;
  const news = search.value.news;
  out.counters.proposed = news.length;
  out.search = { queries: grounding?.queries ?? [], sources: grounding?.sources.length ?? 0, proposed: news.length, verification: hasSources ? 'grounding_sources' : corroborateOnly ? 'fetch_corroboration' : 'none' };

  let redirects = 0;
  /** The article URL must belong to a grounded domain (grounding redirects resolved first, bounded). */
  const grounded = async (url: string): Promise<boolean> => {
    if (ledger.isGroundedDomain(url) || ledger.isGroundedUri(url) || ledger.isVisited(url)) return true;
    for (const s of ledger.sourcesWithoutDomain()) {
      if (redirects >= a.maxRedirectResolutions) break;
      if (ledger.isVisited(s.uri)) continue;
      redirects += 1;
      out.counters.fetches += 1;
      const r = await run.callTool('fetch_url', { url: s.uri, maxChars: 2_000 });
      if (r.result.status === 'ok') {
        const p = r.result.output as FetchUrlOutput;
        ledger.addVisited(s.uri, p.finalUrl, ...p.redirects);
        ledger.addGroundedDomainFromUrl(p.finalUrl);
      }
      if (ledger.isGroundedDomain(url)) return true;
    }
    return ledger.isGroundedDomain(url);
  };

  const discard = (e: CompanySignalEntry, reason: string) => {
    e.status = 'discarded';
    e.reason = reason;
    out.counters.discarded += 1;
    out.entries.push(e);
  };

  for (const n of news) {
    run.ctx.signal.throwIfAborted();
    const entry: CompanySignalEntry = { company: n.company, kind: n.kind, what: n.what, news_date: n.news_date && ISO_DATE.test(n.news_date) ? n.news_date : null, url: n.url, status: 'discarded' };
    if (out.counters.created + out.counters.existing >= a.maxSignals) {
      discard(entry, 'tope_de_senales_por_sector');
      continue;
    }
    // Freshness instead of lead time: the news is at most 60 days old.
    const fresh = companySignalFreshness(entry.news_date, a.today);
    entry.age_days = fresh.age_days;
    if (!fresh.fresh) {
      discard(entry, fresh.reason === 'no_news_date' ? 'sin_fecha_de_noticia' : fresh.reason === 'news_in_future' ? 'fecha_de_noticia_futura' : 'noticia_no_fresca');
      continue;
    }
    const url = n.url && normalizeUrl(n.url) ? n.url : null;
    if (!url) {
      discard(entry, 'sin_url');
      continue;
    }
    const companyKey = CompanySignalSeen.companyKey(n.company, n.kind);
    if (a.seen.has(CompanySignalSeen.urlKey(url)) || a.seen.has(companyKey)) {
      discard(entry, 'duplicada_en_otro_sector');
      continue;
    }
    if (!hasSources && !corroborateOnly) {
      discard(entry, searched ? 'sin_fuentes_de_grounding' : 'sin_busqueda');
      continue;
    }
    if (hasSources && !(await grounded(url))) {
      discard(entry, 'url_no_respaldada_por_grounding');
      continue;
    }
    if (a.outOfTime()) {
      out.counters.skipped_time_budget += 1;
      discard(entry, 'presupuesto_de_tiempo_agotado');
      continue;
    }
    // The article must download and name the company (fetch_url: SSRF guard, public addresses only).
    out.counters.fetches += 1;
    const f = await run.callTool('fetch_url', { url, maxChars: ARTICLE_MAX_CHARS });
    if (f.result.status !== 'ok') {
      discard(entry, `pagina_no_descargable (${toolError(f).code})`);
      continue;
    }
    const page = f.result.output as FetchUrlOutput;
    ledger.addVisited(url, page.finalUrl, ...page.redirects);
    if (!pageNamesCompany(n.company, page)) {
      discard(entry, 'pagina_no_corrobora_la_noticia');
      continue;
    }
    const sourceUrl = page.finalUrl;
    a.seen.add(CompanySignalSeen.urlKey(url), CompanySignalSeen.urlKey(sourceUrl), companyKey);
    entry.source_url = sourceUrl;
    entry.verification = hasSources ? 'grounding_domain' : 'fetch_corroboration';
    const label = COMPANY_SIGNAL_LABEL_ES[n.kind];
    const sig = await run.callTool('create_signal', {
      title: scrubUnknownUrls(companySignalTitle(n.company, n.what, n.kind), ledger).slice(0, 255),
      signalType: COMPANY_SIGNAL_TYPE[n.kind],
      description: scrubUnknownUrls(
        [
          `Señal de empresa (${label}) detectada por el Prospector (modo scout) para el sector "${a.sector}" en ${a.region}.`,
          `Empresa: ${n.company}.`,
          `Qué ha pasado: ${n.what.replace(/\.+$/, '')}.`,
          `Fecha de la noticia: ${entry.news_date} (caduca a los ${COMPANY_SIGNAL_EXPIRY_DAYS} días).`,
          n.city ? `Lugar: ${n.city}.` : '',
          entry.verification === 'fetch_corroboration' ? 'Fuente verificada por descarga (la búsqueda no devolvió fuentes de grounding).' : 'Fuente verificada por descarga.',
          'Califica la señal para que el Prospector evalúe a esta empresa (sin catálogo de feria).',
        ]
          .filter(Boolean)
          .join(' '),
        ledger,
      ).slice(0, 4000),
      sourceUrl,
      eventDate: entry.news_date,
      confidence: a.confidence,
      status: 'NEW',
      dedupeBySourceUrl: true,
    });
    if (sig.result.status !== 'ok') {
      entry.status = 'signal_error';
      entry.error = toolError(sig);
      out.counters.errors += 1;
      out.entries.push(entry);
      continue;
    }
    const o = sig.result.output as { created: boolean; record: { id: string } };
    entry.signal_id = o.record.id;
    entry.status = o.created ? 'signal_created' : 'signal_existing';
    if (o.created) out.counters.created += 1;
    else out.counters.existing += 1;
    out.entries.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// B) Prospecting of one qualified company signal
// ---------------------------------------------------------------------------

/**
 * Is this scout input (trigger on qualification) a COMPANY signal? `signal_kind: 'company'` (task
 * `prospect-on-qualified` v2+), the same key in the event envelope (older task versions) or, as a
 * last resort, the company suffix of `event_name`.
 */
export function isCompanySignalTriggerInput(input: Record<string, unknown>): boolean {
  if (input.signal_kind === 'company') return true;
  const ev = input.event as { data?: Record<string, unknown> } | undefined;
  if (ev && typeof ev === 'object' && ev.data && ev.data.signal_kind === 'company') return true;
  return typeof input.event_name === 'string' && companySignalKindOfName(input.event_name) !== null && input.signal_type !== 'FAIR';
}

export interface CompanySignalInput {
  signal_id: string;
  signal_name: string;
  source_url: string;
  news_date: string | null;
}

export interface CompanySignalRunOptions {
  domainResolver?: DomainResolverConfig;
}

export interface CompanySignalRunOutput {
  outcome: RunOutcome | 'SKIPPED';
  lines: string[];
  output: Record<string, unknown>;
}

/** Input of a company signal from the trigger input (`event_name` carries the full signal name). */
export function companySignalInputFromTrigger(input: Record<string, unknown>): CompanySignalInput | null {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const id = str(input.signal_id);
  const url = str(input.event_url);
  const name = str(input.signal_name) ?? str(input.event_name);
  if (!id || !url || !name) return null;
  return { signal_id: id, signal_name: name, source_url: url, news_date: str(input.event_date)?.slice(0, 10) ?? null };
}

const NO_DOMAIN_NOTE_STATUSES = new Set(['domain_ambiguous', 'domain_not_found', 'skipped_no_domain']);

export async function runCompanySignal(run: ProspectorRun, input: CompanySignalInput, today: string, opts: CompanySignalRunOptions = {}): Promise<CompanySignalRunOutput> {
  const madrid = madridToday(run.startedAt);
  const kind = companySignalKindOfName(input.signal_name);
  const kindLabel = kind ? COMPANY_SIGNAL_LABEL_ES[kind] : 'señal de empresa';
  const parsedName = parseCompanySignalName(input.signal_name);
  const age = newsAgeDays(input.news_date, madrid);
  const base = {
    mode: 'company_signal',
    signal_id: input.signal_id,
    signal_name: input.signal_name,
    kind,
    news_date: input.news_date,
    news_age_days: age,
    source_url: input.source_url,
  };
  run.steps.push({
    type: 'THINK',
    timestamp: new Date(),
    output: {
      plan: 'company signal: re-read the news article, evaluate THAT company for merchandising (no exhibitor catalog), resolve its website, write company + research + PROPOSED hypothesis linked to the signal; publish the run summary',
      ...base,
    },
    latencyMs: 0,
  });

  // 1. Freshness: a news older than 120 days is dead (the daily run expires the signal).
  if (isExpiredCompanySignal(input.news_date, madrid)) {
    return {
      outcome: 'SKIPPED',
      lines: [`Señal de empresa caducada: la noticia es del ${input.news_date} (hace ${age} días; caducan a los ${COMPANY_SIGNAL_EXPIRY_DAYS}). No se ha prospectado.`],
      output: { ...base, reason: `noticia caducada (más de ${COMPANY_SIGNAL_EXPIRY_DAYS} días)` },
    };
  }

  const ledger = new SourceLedger();
  const partial: string[] = [];
  // 2. The article, re-verified (its text is untrusted data for the evaluation).
  const fetched = await run.callTool('fetch_url', { url: input.source_url, maxChars: ARTICLE_MAX_CHARS });
  if (fetched.result.status !== 'ok') {
    const e = toolError(fetched);
    return {
      outcome: 'PARTIAL',
      lines: [`Señal de empresa «${input.signal_name}»: no se pudo descargar la noticia (${e.code}); sin fuente verificable no se escribe nada.`, costLine(run)],
      output: { ...base, error: e, counters: { ...exhibitorCounters([]), llm_calls: run.llmCalls } },
    };
  }
  const page = fetched.result.output as FetchUrlOutput;
  ledger.addVisited(input.source_url, page.finalUrl, ...page.redirects);
  const newsUrl = page.finalUrl;

  // 3. One LLM decision about the company.
  const system = useKnowledge(run.ctx, COMPANY_SIGNAL_SYSTEM_PROMPT);
  const call = await run.completeJson<CompanySignalDecision>({
    label: { step: 'company_signal_decision', signal: input.signal_name },
    system,
    messages: [
      {
        role: 'user',
        content: buildCompanySignalPrompt({
          today,
          kindLabel,
          signalName: input.signal_name,
          company: parsedName.company,
          newsDate: input.news_date,
          sourceUrl: newsUrl,
          pageTitle: page.title,
          pageText: page.text.slice(0, ARTICLE_TEXT_FOR_PROMPT),
        }),
      },
    ],
    parse: parseCompanySignalDecision,
    schema: COMPANY_SIGNAL_DECISION_JSON_SCHEMA,
  });
  // Company: from the signal name; else the model's, only if the article names it.
  const modelCompany = call.status === 'ok' ? call.value.company_name : null;
  const company = parsedName.company ?? (modelCompany && pageNamesCompany(modelCompany, page) ? modelCompany : null);
  const result: ExhibitorResult = { name: company ?? parsedName.headline.slice(0, 255), domain: null, status: 'llm_invalid' };
  const finish = (outcome: RunOutcome): CompanySignalRunOutput => {
    const counters = { ...exhibitorCounters([result]), llm_calls: run.llmCalls, grounding_calls: run.groundingCalls };
    return {
      outcome,
      lines: [
        `Señal de empresa (${kindLabel}): ${input.signal_name}${input.news_date ? ` — noticia del ${input.news_date}${age !== null ? `, hace ${age} días` : ''}` : ''}. Se evalúa la empresa directamente (sin catálogo de feria).`,
        resultLine(result),
        ...(partial.length > 0 ? [`Motivos: ${partial.join(' | ')}`] : []),
        costLine(run),
      ],
      output: { ...base, company, news_url: newsUrl, result, results: [result], counters, domain_resolver: resolver?.summary() ?? null, partial_reasons: partial, sources: ledger.snapshot() },
    };
  };
  let resolver: DomainResolverSession | null = null;
  if (call.status === 'model_error') {
    Object.assign(result, { status: 'llm_error', error: { code: call.code, message: call.message } });
    return finish('FAILED');
  }
  if (call.status === 'invalid') {
    Object.assign(result, { status: 'llm_invalid', error: { code: 'LLM_INVALID_OUTPUT', message: call.message } });
    return finish('FAILED');
  }
  const decision = call.value;
  result.relevant = decision.relevant;
  result.confidence = decision.confidence;
  result.reason = scrubUnknownUrls(decision.reason, ledger);
  if (!decision.relevant || !decision.hypothesis) {
    result.status = 'discarded_irrelevant';
    return finish('SUCCESS');
  }
  result.hypothesis = decision.hypothesis;
  if (decision.confidence < run.cfg.minConfidence) {
    result.status = 'discarded_low_confidence';
    return finish('SUCCESS');
  }
  if (!company) {
    result.status = 'skipped_no_domain';
    partial.push('la señal no sigue la convención "<empresa>: <qué pasó> — <tipo>" y la noticia no confirma el nombre de la empresa');
    await noteNoDomain(run, input, result, null);
    return finish('PARTIAL');
  }

  // 4. Website: tanda 20 resolver (Twenty exact name first, then grounded search + verification).
  const evidence: Array<{ claim: string; sourceUrl?: string }> = [];
  let domain: string | null = null;
  resolver = new DomainResolverSession(run, opts.domainResolver ?? domainResolverConfigFromEnv(), {
    fetch: async (url, maxChars) => {
      const out = await run.callTool('fetch_url', { url, maxChars });
      if (out.result.status !== 'ok') return { ok: false, code: toolError(out).code };
      const p = out.result.output as FetchUrlOutput;
      ledger.addVisited(url, p.finalUrl, ...p.redirects);
      return { ok: true, page: { finalUrl: p.finalUrl, title: p.title, text: p.text, links: p.links, jsAppLikely: p.js_app_likely } };
    },
  });
  const newsHost = hostOf(newsUrl);
  let companyId: string | null = null;
  let companyName = company;
  if (resolver.active) {
    const r = await resolveExhibitorDomain(resolver, { name: company }, result, { eventName: parsedName.headline, place: 'España', fairDomains: newsHost ? [newsHost] : [] });
    domain = normalizeDomain(r.exhibitor.domain);
    evidence.push(...r.evidence);
    if (result.domain_resolution?.status === 'existing_company' && result.domain_resolution.company_id) {
      companyId = result.domain_resolution.company_id;
      domain = normalizeDomain(result.domain_resolution.domain ?? null);
    }
  }
  if (!companyId && !domain) {
    // Resolver off or no verdict yet: an exact-name company of the tenant is still reused.
    const found = await run.callTool('find_company', { name: company, limit: 5 });
    if (found.result.status === 'ok') {
      const exact = (found.result.output as { companies: Array<{ id: string; name: string; domain: string | null }> }).companies.filter(
        (c) => c.name.trim().toLowerCase() === company.trim().toLowerCase(),
      );
      if (exact.length === 1) {
        companyId = exact[0]!.id;
        companyName = exact[0]!.name;
        domain = normalizeDomain(exact[0]!.domain);
      }
    }
  }
  if (!companyId && !domain) {
    const s = result.domain_resolution?.status;
    result.status = s === 'domain_ambiguous' || s === 'domain_not_found' ? s : 'skipped_no_domain';
    // PM decision 10: no hypothesis without a verified website; a note with the candidates helps the manual path.
    await noteNoDomain(run, input, result, company);
    return finish('SUCCESS');
  }

  // 5. Company, research, hypothesis (all linked to the qualified signal).
  if (!companyId) {
    const up = await run.callTool('upsert_company', { domain, name: company });
    if (up.result.status !== 'ok') {
      Object.assign(result, { status: 'tool_error', error: toolError(up) });
      return finish('FAILED');
    }
    const o = up.result.output as { created: boolean; company: { id: string; name: string } };
    companyId = o.company.id;
    companyName = o.company.name;
    result.company_created = o.created;
  } else {
    result.company_created = false;
  }
  result.company_id = companyId;
  result.domain = domain;
  result.signal_id = input.signal_id;

  const clean = (t: string) => scrubUnknownUrls(t, ledger);
  const newsFact = `${companyName}: ${parsedName.headline}${input.news_date ? ` (noticia del ${input.news_date})` : ''}`;
  const sources = [newsUrl, result.domain_resolution?.status === 'domain_resolved' ? (result.domain_resolution.source_url ?? null) : null].filter(
    (u): u is string => typeof u === 'string' && ledger.isKnownSource(u),
  );
  const research = await run.callTool('create_research', {
    companyId,
    signalId: input.signal_id,
    researchType: 'SIGNAL_VERIFICATION',
    query: clean(`Noticia de ${kindLabel} de «${companyName}» (${newsUrl}).`).slice(0, 2000),
    summary: clean(
      [
        `${newsFact}.`,
        `Fuente: ${hostOf(newsUrl) ?? newsUrl}, descargada y verificada por el Prospector.`,
        domain ? `Web: ${domain}${result.domain_resolution?.status === 'domain_resolved' ? ' (localizada por búsqueda web y verificada en su propia web)' : ' (la de la empresa que ya estaba en el CRM)'}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ).slice(0, 4000),
    structuredResult: {
      profile: { legalName: companyName, ...(domain ? { website: `https://${domain}` } : {}) },
      signals: [{ type: kind ?? 'company', title: input.signal_name, sourceUrl: newsUrl, eventDate: input.news_date, confidence: 1 }],
      dataQuality: { missingFields: ['employeeRange', 'contacts', ...(domain ? [] : ['website'])], conflicts: [] },
    },
    sources,
    confidence: domain ? 0.7 : 0.5,
  });
  if (research.result.status === 'ok') {
    const o = research.result.output as { created: boolean; record: { id: string } };
    result.research_id = o.record.id;
    result.research_created = o.created;
  } else {
    result.research_error = toolError(research);
  }

  const h = decision.hypothesis;
  const hypEvidence: Array<{ claim: string; sourceUrl?: string }> = [
    { claim: clean(`${newsFact}.`).slice(0, 1000), sourceUrl: newsUrl },
    { claim: clean(`Valoración del Prospector: ${decision.reason}`).slice(0, 1000) },
  ];
  if (h.differentiators.length > 0) hypEvidence.push({ claim: `Diferenciales de PubliEXPE aplicables: ${h.differentiators.join(', ')}.` });
  for (const e of evidence) hypEvidence.push({ claim: clean(e.claim).slice(0, 1000), ...(e.sourceUrl && ledger.isKnownSource(e.sourceUrl) ? { sourceUrl: e.sourceUrl } : {}) });
  // PM decision 11: the reason of the news is the hypothesis' why now (always first, by code).
  const whyNow = clean(`${newsFact}. ${h.why_now}`).slice(0, 2000);
  const hyp = await run.callTool('create_hypothesis', {
    companyId,
    signalId: input.signal_id,
    name: clean(`${companyName} — ${parsedName.headline}`).slice(0, 255),
    need: clean(h.need),
    whyNow,
    quantityMin: h.quantity_min,
    quantityMax: h.quantity_max,
    budgetMinEur: h.budget_min_eur,
    budgetMaxEur: h.budget_max_eur,
    recommendedProducts: h.recommended_products,
    timing: h.timing,
    confidence: decision.confidence,
    evidence: hypEvidence,
    status: 'PROPOSED',
  });
  if (hyp.result.status !== 'ok') {
    Object.assign(result, { status: 'tool_error', error: toolError(hyp) });
    return finish('FAILED');
  }
  const ho = hyp.result.output as { created: boolean; record: { id: string } };
  result.hypothesis_id = ho.record.id;
  result.status = ho.created ? 'hypothesis_created' : 'hypothesis_existing';
  return finish('SUCCESS');
}

function costLine(run: ProspectorRun): string {
  return `Coste del modelo: ${formatEur(run.costEur())} (${run.llmCalls} llamadas, ${run.groundingCalls} con búsqueda).`;
}

/** Short note on the signal when no hypothesis could be written for lack of a verified website (never fatal). */
async function noteNoDomain(run: ProspectorRun, input: CompanySignalInput, result: ExhibitorResult, company: string | null): Promise<void> {
  if (!NO_DOMAIN_NOTE_STATUSES.has(result.status)) return;
  const cands = (result.domain_resolution?.domain_candidates ?? []).filter((c) => c.status !== 'name_not_in_domain').slice(0, 5);
  const why =
    result.status === 'domain_ambiguous'
      ? 'web dudosa (varias candidatas o ninguna verificada)'
      : result.status === 'domain_not_found'
        ? 'no se encontró su web'
        : company
          ? 'sin web verificada (búsqueda de webs desactivada o sin presupuesto)'
          : 'no se pudo identificar la empresa en la señal';
  const body = [
    `El Prospector consideró relevante esta señal${company ? ` (${company})` : ''} pero no creó hipótesis: ${why}.`,
    cands.length > 0 ? `Candidatas vistas: ${cands.map((c) => `${c.domain} (${c.status})`).join(', ')}.` : 'Sin candidatas.',
    'Vía manual: crea la empresa en Twenty con su web y vuelve a calificar la señal pasadas 24 h.',
  ].join('\n\n');
  const noted = await run.callTool('create_signal_note', { signalId: input.signal_id, title: `🔎 Sin web verificada: ${company ?? input.signal_name}`.slice(0, 255), bodyMarkdown: body.slice(0, 4000) });
  if (noted.result.status !== 'ok') result.error ??= toolError(noted);
}
