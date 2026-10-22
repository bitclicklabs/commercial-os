/**
 * Shared pieces of the Prospector: input / decision schemas, run accounting (steps,
 * tokens, cost), the JSON-with-repair LLM call and the per-exhibitor pipeline
 * (classification -> hypothesis -> Twenty tools). Used by the direct mode
 * (`prospector-agent.ts`) and by the scout mode (`event-scout.ts`).
 */
import { z } from 'zod';
import { HYPOTHESIS_TIMINGS, normalizeDomain, SIGNAL_TYPES, type SignalType } from '../integrations/twenty/index.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import type { ChatMessage, CompletionResult, GroundingResult, TokenUsage } from '../providers/model-provider.js';
import type { AgentToolbox, ToolCallOutcome } from '../tools/executor.js';
import type { AgentContext, AgentStep } from './agent.js';
import { buildExhibitorPrompt, buildRepairPrompt } from './prospector-prompt.js';
import { buildExhibitorResearch, type ExhibitorResearchArgs } from './exhibitor-research.js';
import { scrubUnknownUrls, type SourceLedger } from './source-ledger.js';
import { priceHintText, recommendedProductLabel, type RecommendedProduct } from '../integrations/catalog/index.js';
import { pickCatalogProducts, type CatalogPickSummary } from './prospector-catalog.js';
import { resolveExhibitorDomain, type DomainResolution, type DomainResolverSession, type ResolveContext } from './domain-resolver.js';

// ---------------------------------------------------------------------------
// Input (direct mode)
// ---------------------------------------------------------------------------

/** Spanish / free-text aliases accepted for `event.type`. */
const EVENT_TYPE_ALIASES: Record<string, SignalType> = {
  FERIA: 'FAIR',
  TRADE_FAIR: 'FAIR',
  TRADE_SHOW: 'FAIR',
  EXPO: 'FAIR',
  CONGRESO: 'CONGRESS',
  CONFERENCE: 'CONGRESS',
  CONFERENCIA: 'CONGRESS',
  EVENTO: 'EVENT',
  PATROCINIO: 'SPONSORSHIP',
};

const EventType = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const key = value.toUpperCase().replace(/[\s-]+/g, '_');
    const mapped = (SIGNAL_TYPES as readonly string[]).includes(key) ? (key as SignalType) : EVENT_TYPE_ALIASES[key];
    if (!mapped) {
      ctx.addIssue({ code: 'custom', message: `Unknown event type "${value}". Use one of ${SIGNAL_TYPES.join(', ')}` });
      return z.NEVER;
    }
    return mapped;
  });

export const ExhibitorInput = z.object({
  name: z.string().trim().min(1).max(255),
  domain: z.string().trim().max(253).optional(),
  description: z.string().trim().max(4000).optional(),
  sector: z.string().trim().max(255).optional(),
});
export type ExhibitorInput = z.infer<typeof ExhibitorInput>;

export const ProspectorInput = z.object({
  event: z.object({
    name: z.string().trim().min(1).max(255),
    type: EventType,
    date: z.iso.date().optional(),
    location: z.string().trim().min(1).max(255).optional(),
    source_url: z.url({ protocol: /^https?$/ }).max(2048).optional(),
  }),
  exhibitors: z.array(ExhibitorInput).min(1).max(50),
});
export type ProspectorInput = z.infer<typeof ProspectorInput>;
export type ProspectorEvent = ProspectorInput['event'];

// ---------------------------------------------------------------------------
// LLM decision (one per exhibitor)
// ---------------------------------------------------------------------------

export const DIFFERENTIATORS = ['OFERTAS', 'TRATO_CERCANO', 'TALLER_PROPIO', 'PRECIO'] as const;

export const ExhibitorHypothesis = z.object({
  need: z.string().trim().min(1).max(2000),
  why_now: z.string().trim().min(1).max(2000),
  quantity_min: z.number().int().nonnegative(),
  quantity_max: z.number().int().nonnegative(),
  budget_min_eur: z.number().nonnegative(),
  budget_max_eur: z.number().nonnegative(),
  recommended_products: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
  timing: z.enum(HYPOTHESIS_TIMINGS),
  differentiators: z.array(z.enum(DIFFERENTIATORS)).max(4).default([]),
});

export type ExhibitorHypothesisData = z.infer<typeof ExhibitorHypothesis>;

export const ExhibitorDecision = z
  .object({
    relevant: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(1000),
    hypothesis: ExhibitorHypothesis.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.relevant && !v.hypothesis) ctx.addIssue({ code: 'custom', path: ['hypothesis'], message: 'required when relevant is true' });
    if (v.hypothesis) {
      if (v.hypothesis.quantity_max < v.hypothesis.quantity_min) {
        ctx.addIssue({ code: 'custom', path: ['hypothesis', 'quantity_max'], message: 'must be >= quantity_min' });
      }
      if (v.hypothesis.budget_max_eur < v.hypothesis.budget_min_eur) {
        ctx.addIssue({ code: 'custom', path: ['hypothesis', 'budget_max_eur'], message: 'must be >= budget_min_eur' });
      }
    }
  });
export type ExhibitorDecision = z.infer<typeof ExhibitorDecision>;

/** JSON Schema sent to the provider (Gemini `responseJsonSchema`). Kept to the widely supported subset. */
export const EXHIBITOR_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    hypothesis: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            need: { type: 'string' },
            why_now: { type: 'string' },
            quantity_min: { type: 'integer', minimum: 0 },
            quantity_max: { type: 'integer', minimum: 0 },
            budget_min_eur: { type: 'number', minimum: 0 },
            budget_max_eur: { type: 'number', minimum: 0 },
            recommended_products: { type: 'array', items: { type: 'string' } },
            timing: { type: 'string', enum: [...HYPOTHESIS_TIMINGS] },
            differentiators: { type: 'array', items: { type: 'string', enum: [...DIFFERENTIATORS] } },
          },
          required: ['need', 'why_now', 'quantity_min', 'quantity_max', 'budget_min_eur', 'budget_max_eur', 'recommended_products', 'timing'],
        },
      ],
    },
  },
  required: ['relevant', 'confidence', 'reason', 'hypothesis'],
};

export function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(raíz)'}: ${i.message}`)
    .join('; ');
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Extracts a JSON value from model text: plain JSON, ```json fences, or the outermost
 * `{...}` when the model wrapped it in prose (grounded answers sometimes do).
 */
export function parseJsonText(text: string): Parsed<unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(first, last + 1)) };
      } catch {
        // fall through
      }
    }
    return { ok: false, error: `JSON inválido (${err instanceof Error ? err.message : String(err)})` };
  }
}

export function parseWith<S extends z.ZodType>(schema: S, text: string): Parsed<z.output<S>> {
  const json = parseJsonText(text);
  if (!json.ok) return json;
  const parsed = schema.safeParse(json.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: issues(parsed.error) };
}

/** Parses the raw model text into a validated decision. Tolerates ```json fences. */
export function parseExhibitorDecision(text: string): Parsed<ExhibitorDecision> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `JSON inválido (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = ExhibitorDecision.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: issues(parsed.error) };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Tools the Prospector may use (all modes). `fetch_url` and `render_url` are READ and only used
 * by the scout mode; `list_event_signals` (READ) and `expire_signal` (LOW_WRITE, only to EXPIRED)
 * only by the signals mode. Lead-time window (tanda 18): `list_hypotheses_for_expiry` (READ) and
 * `expire_hypothesis` (LOW_WRITE, only PROPOSED -> EXPIRED) in the signals mode;
 * when a qualification falls outside the window, `create_crm_task` (LOW_WRITE, tanda 19: a Twenty
 * Task on the signal; it replaces `create_signal_note`, still registered for older versions).
 */
export const PROSPECTOR_TOOLS = [
  'find_company',
  'upsert_company',
  'create_signal',
  'create_research',
  'create_hypothesis',
  'create_agent_run_summary',
  'fetch_url',
  'render_url',
  'list_event_signals',
  'expire_signal',
  'list_hypotheses_for_expiry',
  'expire_hypothesis',
  'create_crm_task',
  // Tanda 21: note on a qualified company signal whose company has no verified website (no hypothesis).
  'create_signal_note',
] as const;

export interface ScoutConfig {
  taskName: string;
  maxEvents: number;
  maxExhibitorsPerEvent: number;
  /** fetch_url calls per run, all events included. */
  maxFetches: number;
  /** Pages read per event (event page + exhibitor list page...). */
  maxPagesPerEvent: number;
  /** render_url calls per run (JavaScript catalogs), all events included. 0 = never render. */
  maxRenders: number;
  /** Catalog / exhibitor-list PDFs linked from the pages downloaded per event (fetch_url). */
  maxPdfsPerEvent: number;
  /**
   * Pages of a paginated exhibitor list read per event (the first one included): client-side
   * pagination inside one render_url call (`maxPages`), or "next"/`?page=N` links. 1 = first page only.
   */
  maxCatalogPages: number;
  /**
   * Exhibitor profiles (`/exhibitors/{id}`) opened per run to find the website of RELEVANT
   * exhibitors without a domain, after the LLM evaluation. Each lookup is one fetch_url or
   * render_url of the profile plus one fetch_url of the domain found (resolvable + public).
   */
  maxProfileLookups: number;
  /** Profiles opened at the same time (the renderer runs 2 renders at once). */
  profileConcurrency: number;
  /**
   * Time budget of a scout run (ms), from the start of the run: pages, renders, extractions,
   * evaluations and profiles stop when it runs out (writes of what was evaluated are not cut).
   */
  timeBudgetMs: number;
  /** Ask the renderer for the JSON answers of catalog pages (JSON API shortcut). */
  captureJson: boolean;
  /** Grounding redirects resolved to learn a source's domain when grounding did not report it. */
  maxRedirectResolutions: number;
  eventSignalConfidence: number;
  /**
   * When the grounded search ran queries but returned no sources, accept the proposed
   * URL only if the downloaded page corroborates the fair (default true; false = strict).
   */
  verifyUnsourcedByFetch: boolean;
  /** Tanda 21: company signals (news) created per sector and run when the input asks for them (0 = never). */
  maxCompanySignalsPerSector: number;
}

export interface ProspectorConfig {
  minConfidence: number;
  usdToEur: number;
  taskName: string;
  maxTokens: number;
  modelOptions: Record<string, unknown>;
  scout: ScoutConfig;
}

/** Hard caps of the scout limits (configuration and per-run input). */
export const SCOUT_MAX_EXHIBITORS_CAP = 200;
export const SCOUT_CATALOG_PAGES_CAP = 20;
export const SCOUT_PROFILE_LOOKUPS_CAP = 100;
/** 20 min by default. */
export const SCOUT_TIME_BUDGET_DEFAULT_MS = 1_200_000;
/**
 * Ceiling of the time budget: the `weekly-event-scouting` task timeout (30 min) minus 5 min
 * kept for the CRM writes of what was evaluated and the run summary. The agent does not
 * receive the task timeout; a task with a shorter timeout needs a lower `time_budget_ms`.
 */
export const SCOUT_TIME_BUDGET_CAP_MS = 1_500_000;

export function readConfig(configuration: Record<string, unknown>): ProspectorConfig {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const int = (v: unknown, fallback: number, max: number) => Math.max(0, Math.min(max, Math.floor(num(v, fallback))));
  const raw = (configuration.model_options ?? {}) as Record<string, unknown>;
  // snake_case in configuration -> provider option names.
  const modelOptions: Record<string, unknown> = {};
  if (raw.thinking_level !== undefined) modelOptions.thinkingLevel = raw.thinking_level;
  if (raw.thinking_budget !== undefined) modelOptions.thinkingBudget = raw.thinking_budget;
  if (raw.temperature !== undefined) modelOptions.temperature = raw.temperature;
  const s = (configuration.scout ?? {}) as Record<string, unknown>;
  return {
    minConfidence: num(configuration.min_confidence, 0.5),
    usdToEur: num(configuration.usd_to_eur, DEFAULT_USD_TO_EUR),
    taskName: typeof configuration.task_name === 'string' ? configuration.task_name : 'daily-event-prospecting',
    maxTokens: num(configuration.max_output_tokens, 4096),
    modelOptions,
    scout: {
      taskName: typeof s.task_name === 'string' ? s.task_name : 'weekly-event-scouting',
      maxEvents: int(s.max_events, 3, 3),
      maxExhibitorsPerEvent: Math.max(1, int(s.max_exhibitors_per_event, 100, SCOUT_MAX_EXHIBITORS_CAP)),
      maxFetches: int(s.max_fetches, 18, 30),
      maxPagesPerEvent: int(s.max_pages_per_event, 3, 4),
      maxRenders: int(s.max_renders, 4, 6),
      maxPdfsPerEvent: int(s.max_pdfs_per_event, 2, 2),
      maxCatalogPages: Math.max(1, int(s.max_catalog_pages, 10, SCOUT_CATALOG_PAGES_CAP)),
      maxProfileLookups: int(s.max_profile_lookups, 100, SCOUT_PROFILE_LOOKUPS_CAP),
      profileConcurrency: Math.max(1, int(s.profile_concurrency, 2, 4)),
      timeBudgetMs: Math.max(10_000, int(s.time_budget_ms, SCOUT_TIME_BUDGET_DEFAULT_MS, SCOUT_TIME_BUDGET_CAP_MS)),
      captureJson: s.capture_json !== false,
      maxRedirectResolutions: int(s.max_redirect_resolutions, 3, 5),
      eventSignalConfidence: Math.min(1, Math.max(0, num(s.event_signal_confidence, 0.5))),
      verifyUnsourcedByFetch: s.verify_unsourced_by_fetch !== false,
      maxCompanySignalsPerSector: int(s.max_company_signals_per_sector, 3, 5),
    },
  };
}

// ---------------------------------------------------------------------------
// Run accounting
// ---------------------------------------------------------------------------

export const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cachedTokens: a.cachedTokens + b.cachedTokens };
}

export function formatEur(n: number): string {
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 4, maximumFractionDigits: 6 })} €`;
}

export type JsonCallResult<T> =
  | { status: 'ok'; value: T; grounding?: GroundingResult; completion: CompletionResult }
  | { status: 'model_error'; code: string; message: string }
  | { status: 'invalid'; message: string; grounding?: GroundingResult };

export interface JsonCallRequest<T> {
  /** Merged into each MODEL step input (e.g. `{ exhibitor: name }`, `{ step: 'scout_search' }`). */
  label: Record<string, unknown>;
  system: string;
  messages: ChatMessage[];
  parse: (text: string) => Parsed<T>;
  schema?: Record<string, unknown>;
  grounding?: boolean;
  /** Messages for the repair attempt. Default: previous answer + `buildRepairPrompt`. Never grounded. */
  repair?: (previous: string, error: string, messages: ChatMessage[]) => ChatMessage[];
  maxAttempts?: number;
  /** Overrides `max_output_tokens` for this call. */
  maxTokens?: number;
}

/** Steps, tokens and cost of one Prospector execution. */
export class ProspectorRun {
  readonly steps: AgentStep[] = [];
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  modelCost = 0;
  toolCost = 0;
  llmCalls = 0;
  groundingCalls = 0;
  groundingUnits = 0;
  groundingCost = 0;
  currency = 'USD';

  readonly startedAt: Date;

  constructor(
    readonly ctx: AgentContext,
    readonly tools: AgentToolbox,
    readonly cfg: ProspectorConfig,
    readonly clock: () => Date = () => new Date(),
  ) {
    this.startedAt = clock();
  }

  async callTool(tool: string, input: unknown): Promise<ToolCallOutcome> {
    const outcome = await this.tools.call(tool, input);
    this.toolCost += outcome.costEur;
    this.steps.push({ ...outcome.step, output: { ...(outcome.step.output as Record<string, unknown>), costEur: outcome.costEur } });
    return outcome;
  }

  /** One LLM call that must return JSON, validated by `parse`; one repair attempt by default. */
  async completeJson<T>(req: JsonCallRequest<T>): Promise<JsonCallResult<T>> {
    const ctx = this.ctx;
    let messages = [...req.messages];
    let grounding: GroundingResult | undefined;
    let lastError = '';
    const maxAttempts = req.maxAttempts ?? 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const grounded = req.grounding === true && attempt === 1;
      let completion: CompletionResult;
      try {
        completion = await ctx.provider.complete({
          model: ctx.version.model,
          system: req.system,
          messages,
          maxTokens: req.maxTokens ?? this.cfg.maxTokens,
          options: { ...this.cfg.modelOptions, ...(req.schema ? { responseSchema: req.schema } : {}), ...(grounded ? { grounding: true } : {}) },
          signal: ctx.signal,
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const e = err as { code?: unknown; message?: unknown };
        const code = typeof e.code === 'string' ? e.code : 'MODEL_ERROR';
        const message = String(e.message ?? err);
        this.steps.push({ type: 'MODEL', timestamp: new Date(), model: ctx.version.model, input: { ...req.label, attempt }, error: { code, message }, latencyMs: 0 });
        return { status: 'model_error', code, message };
      }
      this.llmCalls += 1;
      this.usage = addUsage(this.usage, completion.usage);
      this.modelCost += completion.cost.modelCost;
      this.currency = completion.cost.currency;
      if (grounded) {
        this.groundingCalls += 1;
        this.groundingUnits += completion.cost.groundingUnits ?? 0;
        this.groundingCost += completion.cost.groundingCost ?? 0;
        grounding = completion.grounding ?? { queries: [], sources: [] };
      }
      const parsed = req.parse(completion.text);
      this.steps.push({
        type: 'MODEL',
        timestamp: new Date(),
        model: completion.model,
        usage: completion.usage,
        input: { ...req.label, attempt, prompt_chars: messages.reduce((n, m) => n + m.content.length, 0), ...(grounded ? { grounding: true } : {}) },
        output: {
          valid: parsed.ok,
          ...(parsed.ok ? { decision: parsed.value } : { validation_error: parsed.error, raw: completion.text.slice(0, 2000) }),
          stop_reason: completion.stopReason,
          cost: {
            amount: completion.cost.modelCost,
            currency: completion.cost.currency,
            ...(completion.cost.groundingCost !== undefined ? { grounding: completion.cost.groundingCost, grounding_units: completion.cost.groundingUnits ?? 0 } : {}),
          },
          ...(grounded && completion.grounding
            ? {
                grounding: {
                  queries: completion.grounding.queries,
                  sources: completion.grounding.sources.slice(0, 30),
                  ...(completion.grounding.diagnostics ? { diagnostics: completion.grounding.diagnostics } : {}),
                  source_trust: 'untrusted',
                },
              }
            : {}),
        },
        latencyMs: completion.latencyMs,
      });
      if (parsed.ok) return { status: 'ok', value: parsed.value, completion, ...(grounding ? { grounding } : {}) };
      lastError = parsed.error;
      messages = req.repair
        ? req.repair(completion.text, parsed.error, messages)
        : [...messages, { role: 'assistant', content: completion.text || '(respuesta vacía)' }, { role: 'user', content: buildRepairPrompt(parsed.error) }];
    }
    return { status: 'invalid', message: lastError, ...(grounding ? { grounding } : {}) };
  }

  costEur(): number {
    const m = round6(this.modelCost);
    return this.currency === 'EUR' ? m : round6(m * this.cfg.usdToEur);
  }

  /** Publishes the agentRunSummary (always called once at the end of a run). */
  async publishSummary(task: string, outcome: RunOutcome, lines: string[]): Promise<{ id: string | null; error?: { code: string; message: string } }> {
    const summary = await this.callTool('create_agent_run_summary', {
      task,
      agentName: this.ctx.agent.name,
      agentVersion: this.ctx.version.version,
      outcome,
      resultSummary: lines.join('\n').slice(0, 4000),
      costEur: this.costEur(),
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.clock().toISOString(),
    });
    return summary.result.status === 'ok'
      ? { id: (summary.result.output as { record: { id: string } }).record.id }
      : { id: null, error: toolError(summary) };
  }
}

export type RunOutcome = 'SUCCESS' | 'PARTIAL' | 'FAILED';

export function toolError(outcome: ToolCallOutcome): { code: string; message: string } {
  const r = outcome.result;
  if (r.status === 'error') return { code: r.code, message: r.message };
  if (r.status === 'approval_required') return { code: 'APPROVAL_REQUIRED', message: r.summary };
  return { code: 'UNKNOWN', message: 'unexpected tool result' };
}

// ---------------------------------------------------------------------------
// Per-exhibitor pipeline
// ---------------------------------------------------------------------------

export type ExhibitorStatus =
  | 'hypothesis_created'
  | 'hypothesis_existing'
  | 'discarded_irrelevant'
  | 'discarded_low_confidence'
  | 'skipped_no_domain'
  /** Tanda 20: the domain resolver searched and found several candidates or could not prove one (listed in `domain_resolution`). */
  | 'domain_ambiguous'
  /** Tanda 20: the domain resolver searched and found no website carrying the company name. */
  | 'domain_not_found'
  | 'skipped_unverified_source'
  | 'llm_error'
  | 'llm_invalid'
  | 'tool_error';

/** Labels for the commercial-facing run summary in Twenty. */
export const STATUS_LABELS_ES: Record<ExhibitorStatus, string> = {
  hypothesis_created: 'hipótesis creada',
  hypothesis_existing: 'hipótesis ya existente',
  discarded_irrelevant: 'descartado (sin encaje)',
  discarded_low_confidence: 'descartado (confianza baja)',
  skipped_no_domain: 'omitido (sin dominio verificado)',
  domain_ambiguous: 'omitido (web dudosa: varias candidatas o sin verificar)',
  domain_not_found: 'omitido (web no encontrada en la búsqueda)',
  skipped_unverified_source: 'omitido (fuente no verificada)',
  llm_error: 'error del modelo',
  llm_invalid: 'respuesta del modelo no válida',
  tool_error: 'error al escribir en el CRM',
};

export const ERROR_STATUSES: readonly ExhibitorStatus[] = ['llm_error', 'llm_invalid', 'tool_error', 'skipped_unverified_source'];

export interface ExhibitorResult {
  name: string;
  domain: string | null;
  status: ExhibitorStatus;
  relevant?: boolean;
  confidence?: number;
  reason?: string;
  company_id?: string;
  company_created?: boolean;
  signal_id?: string;
  /** Research record (LLD 5.2) of the exhibitor, composed from the data already read (no LLM call). */
  research_id?: string;
  research_created?: boolean;
  /** create_research failed or had no source: the exhibitor goes on (hypothesis is still written). */
  research_error?: { code: string; message: string };
  hypothesis_id?: string;
  hypothesis?: z.infer<typeof ExhibitorHypothesis>;
  /**
   * Real catalog products of the hypothesis `{ productId, sku, name, priceHint }` (only when the
   * skill asks for the catalog and it was available; `hypothesis.recommended_products` keeps the
   * generic families the model proposed). Written to Twenty `recommendedProducts` + evidence.
   */
  recommended_products?: RecommendedProduct[];
  /** What the catalog step did (absent when the skill does not ask for the catalog). */
  catalog?: CatalogPickSummary;
  error?: { code: string; message: string };
  /** Scout mode: lookup of the exhibitor profile (website) after a writable decision. */
  profile?: {
    url: string | null;
    /** `json_template`: URL built from the catalog's profile-link template and the JSON id (no link in the rendered pages). */
    url_source?: 'json_template';
    status: string;
    via?: 'fetch' | 'render';
    domain?: string | null;
    domain_source?: string;
    /** Why the lookup failed (tool error code). */
    error?: string;
    /** Social network pages found in the profile: metadata, never used as the company domain. */
    social?: Record<string, string>;
  };
  /**
   * Tanda 20: name -> website resolution (grounded search + verification of the home page /
   * legal notice), only for writable exhibitors without a domain. `status: 'domain_resolved'`
   * means the exhibitor went on with `domain` and `source_url` is the page that proved it.
   */
  domain_resolution?: DomainResolution;
}

export interface EvaluateOptions {
  today: string;
  system: string;
  /**
   * Scout mode: web-sourced data. Every `sourceUrl` written to Twenty must be a known
   * source of the ledger and free text is scrubbed of URLs foreign to it.
   */
  ledger?: SourceLedger;
  /** Direct mode (tanda 20): resolver of the website of writable exhibitors without a domain. */
  domainResolver?: { session: DomainResolverSession; context: ResolveContext };
}

/** classification (LLM) -> [domain resolution] -> company -> signal -> hypothesis, for one exhibitor. Never throws on business errors. */
export async function evaluateExhibitor(run: ProspectorRun, event: ProspectorEvent, exhibitor: ExhibitorInput, opts: EvaluateOptions): Promise<ExhibitorResult> {
  const decided = await decideExhibitor(run, event, exhibitor, opts);
  if (!decided.writable) return decided.result;
  const resolver = opts.domainResolver;
  if (resolver?.session.active && !normalizeDomain(exhibitor.domain)) {
    const r = await resolveExhibitorDomain(resolver.session, exhibitor, decided.result, resolver.context);
    return writeExhibitor(run, event, r.exhibitor, decided, { ...opts, extraEvidence: r.evidence });
  }
  return writeExhibitor(run, event, exhibitor, decided, opts);
}

/** Final status of a writable exhibitor left without a domain: what the resolver said, else `skipped_no_domain`. */
function noDomainStatus(result: ExhibitorResult): 'skipped_no_domain' | 'domain_ambiguous' | 'domain_not_found' {
  const s = result.domain_resolution?.status;
  return s === 'domain_ambiguous' || s === 'domain_not_found' ? s : 'skipped_no_domain';
}

/** Outcome of the LLM step of one exhibitor. `writable`: relevant with enough confidence (the CRM steps come next). */
export interface DecidedExhibitor {
  result: ExhibitorResult;
  decision: ExhibitorDecision | null;
  writable: boolean;
}

/**
 * Step 1 only: the LLM decision (+1 repair attempt), no CRM write. The scout mode
 * evaluates every exhibitor first and opens exhibitor profiles only for the writable ones.
 */
export async function decideExhibitor(run: ProspectorRun, event: ProspectorEvent, exhibitor: ExhibitorInput, opts: Pick<EvaluateOptions, 'today' | 'system'>): Promise<DecidedExhibitor> {
  const domain = normalizeDomain(exhibitor.domain);
  const result: ExhibitorResult = { name: exhibitor.name, domain, status: 'llm_invalid' };
  const call = await run.completeJson({
    label: { exhibitor: exhibitor.name },
    system: opts.system,
    messages: [{ role: 'user', content: buildExhibitorPrompt({ ...event }, { ...exhibitor, ...(domain ? { domain } : {}) }, opts.today) }],
    parse: parseExhibitorDecision,
    schema: EXHIBITOR_DECISION_JSON_SCHEMA,
  });
  if (call.status === 'model_error') {
    return { result: Object.assign(result, { status: 'llm_error' as const, error: { code: call.code, message: call.message } }), decision: null, writable: false };
  }
  if (call.status === 'invalid') {
    return { result: Object.assign(result, { status: 'llm_invalid' as const, error: { code: 'LLM_INVALID_OUTPUT', message: call.message } }), decision: null, writable: false };
  }
  const decision = call.value;
  result.relevant = decision.relevant;
  result.confidence = decision.confidence;
  result.reason = decision.reason;
  if (!decision.relevant || !decision.hypothesis) return { result: Object.assign(result, { status: 'discarded_irrelevant' as const }), decision, writable: false };
  result.hypothesis = decision.hypothesis;
  if (decision.confidence < run.cfg.minConfidence) return { result: Object.assign(result, { status: 'discarded_low_confidence' as const }), decision, writable: false };
  return { result, decision, writable: true };
}

/**
 * Steps 2-5 for a writable decision: source check, company, signal, hypothesis. The
 * exhibitor's domain is read again here (the scout may have found it in the exhibitor
 * profile after the decision). `extraEvidence` is added to the hypothesis evidence
 * (each `sourceUrl` must be a known source in scout mode, or it is dropped).
 */
export async function writeExhibitor(
  run: ProspectorRun,
  event: ProspectorEvent,
  exhibitor: ExhibitorInput,
  decided: DecidedExhibitor,
  opts: EvaluateOptions & { extraEvidence?: Array<{ claim: string; sourceUrl?: string }> },
): Promise<ExhibitorResult> {
  const result = decided.result;
  const decision = decided.decision!;
  const domain = normalizeDomain(exhibitor.domain);
  result.domain = domain;
  const ledger = opts.ledger;
  const clean = (text: string) => (ledger ? scrubUnknownUrls(text, ledger) : text);
  const extraEvidence = opts.extraEvidence ?? [];
  if (!decision.hypothesis) return Object.assign(result, { status: 'discarded_irrelevant' as const });

  // 2. Source check before any write (scout mode): the URL must have been visited or returned by grounding.
  if (ledger && (!event.source_url || !ledger.isKnownSource(event.source_url))) {
    return Object.assign(result, {
      status: 'skipped_unverified_source' as const,
      error: { code: 'UNVERIFIED_SOURCE', message: `source_url ${event.source_url ?? '(none)'} was not visited nor returned by grounding` },
    });
  }

  // 3. Company: by domain (upsert, idempotent); without domain only reuse an exact name match.
  let companyId: string;
  let companyName = exhibitor.name;
  let companyDomain: string | null = domain;
  if (domain) {
    const up = await run.callTool('upsert_company', { domain, name: exhibitor.name });
    if (up.result.status !== 'ok') return Object.assign(result, { status: 'tool_error' as const, error: toolError(up) });
    const out = up.result.output as { created: boolean; company: { id: string; name: string } };
    companyId = out.company.id;
    companyName = out.company.name;
    result.company_created = out.created;
  } else {
    const found = await run.callTool('find_company', { name: exhibitor.name, limit: 5 });
    if (found.result.status !== 'ok') return Object.assign(result, { status: 'tool_error' as const, error: toolError(found) });
    const companies = (found.result.output as { companies: Array<{ id: string; name: string; domain: string | null }> }).companies;
    const exact = companies.filter((c) => c.name.trim().toLowerCase() === exhibitor.name.trim().toLowerCase());
    // Skill rule: never create a company without a verified domain.
    if (exact.length !== 1) return Object.assign(result, { status: noDomainStatus(result) });
    companyId = exact[0]!.id;
    companyName = exact[0]!.name;
    companyDomain = exact[0]!.domain;
    result.company_created = false;
  }
  result.company_id = companyId;

  // 4. Signal: the event.
  const sourceUrl = event.source_url ?? (companyDomain ? `https://${companyDomain}` : null);
  if (!sourceUrl) return Object.assign(result, { status: noDomainStatus(result) });
  const sig = await run.callTool('create_signal', {
    companyId,
    title: clean(`${event.name} — ${companyName}`).slice(0, 255),
    signalType: event.type,
    description: clean(
      [
        `Expositor en ${event.name}${event.date ? ` (${event.date})` : ''}${event.location ? `, ${event.location}` : ''}.`,
        exhibitor.sector ? `Sector: ${exhibitor.sector}.` : '',
        exhibitor.description ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    ).slice(0, 4000),
    sourceUrl,
    ...(event.date ? { eventDate: event.date } : {}),
    confidence: decision.confidence,
    status: 'NEW',
  });
  if (sig.result.status !== 'ok') return Object.assign(result, { status: 'tool_error' as const, error: toolError(sig) });
  const signalId = (sig.result.output as { record: { id: string } }).record.id;
  result.signal_id = signalId;

  // 4b. Research (LLD 5.2): what was observed about the exhibitor, from data already read. Not fatal.
  await writeResearch(run, event, exhibitor, result, {
    companyId,
    signalId,
    companyName,
    companyDomain,
    domainSource: domain
      ? result.profile?.status === 'domain_resolved' && result.profile.domain === domain
        ? 'profile'
        : result.domain_resolution?.status === 'domain_resolved' && result.domain_resolution.domain === domain
          ? 'search'
          : 'input'
      : companyDomain
        ? 'crm'
        : null,
    signalTitle: clean(`${event.name} — ${companyName}`).slice(0, 255),
    ledger,
    extraSources: extraEvidence.map((e) => e.sourceUrl).filter((u): u is string => typeof u === 'string'),
  });

  // 5. Hypothesis. Name = company + event, so a re-run of the same event does not duplicate it.
  const h = decision.hypothesis;
  const evidence: Array<{ claim: string; sourceUrl?: string }> = [
    { claim: `${exhibitor.name} figura como expositor en ${event.name}${event.date ? ` (${event.date})` : ''}.`, ...(event.source_url ? { sourceUrl: event.source_url } : {}) },
    { claim: clean(`Valoración del Prospector: ${decision.reason}`).slice(0, 1000) },
  ];
  if (h.differentiators.length > 0) evidence.push({ claim: `Diferenciales de PubliEXPE aplicables: ${h.differentiators.join(', ')}.` });
  for (const e of extraEvidence) {
    const known = e.sourceUrl && (!ledger || ledger.isKnownSource(e.sourceUrl)) ? { sourceUrl: e.sourceUrl } : {};
    evidence.push({ claim: clean(e.claim).slice(0, 1000), ...known });
  }
  // 5a. Real catalog products, only when the skill asks for them (CATALOG_SKILL_MARKER). Never fatal.
  const pick = await pickCatalogProducts(run, event, exhibitor, h, { system: opts.system });
  let recommendedProducts = h.recommended_products;
  if (pick.status !== 'not_requested') {
    if (pick.status === 'selected') {
      const { products, ...rest } = pick;
      result.catalog = rest;
      result.recommended_products = products;
      const stub = pick.provider === 'stub';
      recommendedProducts = [...new Set([...products.map((p) => recommendedProductLabel(p, { stub })), ...h.recommended_products])].slice(0, 20);
      for (const p of products) {
        if (evidence.length >= 30) break;
        const why = pick.reasons[p.productId];
        evidence.push({
          claim: clean(
            `${stub ? 'Producto del catálogo de PRUEBA (stub, ficticio): ' : 'Producto del catálogo: '}${p.name} (ref. ${p.sku}, id ${p.productId}): ${priceHintText(p.priceHint)}. Orden de magnitud, no un precio: el presupuesto lo hace el CMS de publiexpe.${why ? ` Encaje: ${why}` : ''}`,
          ).slice(0, 1000),
        });
      }
    } else {
      result.catalog = pick;
    }
  }
  const hyp = await run.callTool('create_hypothesis', {
    companyId,
    signalId,
    name: clean(`${companyName} — ${event.name}`).slice(0, 255),
    need: clean(h.need),
    whyNow: clean(h.why_now),
    quantityMin: h.quantity_min,
    quantityMax: h.quantity_max,
    budgetMinEur: h.budget_min_eur,
    budgetMaxEur: h.budget_max_eur,
    recommendedProducts,
    timing: h.timing,
    confidence: decision.confidence,
    evidence,
    status: 'PROPOSED',
  });
  if (hyp.result.status !== 'ok') return Object.assign(result, { status: 'tool_error' as const, error: toolError(hyp) });
  const hypOut = hyp.result.output as { created: boolean; record: { id: string } };
  result.hypothesis_id = hypOut.record.id;
  result.status = hypOut.created ? 'hypothesis_created' : 'hypothesis_existing';
  return result;
}

async function writeResearch(
  run: ProspectorRun,
  event: ProspectorEvent,
  exhibitor: ExhibitorInput,
  result: ExhibitorResult,
  w: {
    companyId: string;
    signalId: string;
    companyName: string;
    companyDomain: string | null;
    domainSource: ExhibitorResearchArgs['domainSource'];
    signalTitle: string;
    ledger: SourceLedger | undefined;
    extraSources: string[];
  },
): Promise<void> {
  const { ledger } = w;
  const clean = (text: string) => (ledger ? scrubUnknownUrls(text, ledger) : text);
  // Scout: only URLs the run really visited (or grounding returned). Direct: the event URL, else the company site.
  const candidates = [
    event.source_url,
    ...w.extraSources,
    result.profile?.url ?? undefined,
    result.domain_resolution?.status === 'domain_resolved' ? (result.domain_resolution.source_url ?? undefined) : undefined,
    w.companyDomain && (!ledger || result.profile?.status === 'domain_resolved') ? `https://${w.companyDomain}/` : undefined,
  ].filter((u): u is string => typeof u === 'string' && u.length > 0);
  const sources = ledger ? candidates.filter((u) => ledger.isKnownSource(u)) : candidates.slice(0, event.source_url ? 1 : 2);
  const research = buildExhibitorResearch({
    mode: ledger ? 'scout' : 'direct',
    event,
    // Catalog text is untrusted web data: no URL foreign to the run's sources reaches Twenty (summary or JSON).
    exhibitor: {
      ...exhibitor,
      ...(exhibitor.description ? { description: clean(exhibitor.description) } : {}),
      ...(exhibitor.sector ? { sector: clean(exhibitor.sector) } : {}),
    },
    companyName: clean(w.companyName),
    companyDomain: w.companyDomain,
    domainSource: w.domainSource,
    profile: result.profile,
    sources,
    signalTitle: w.signalTitle,
  });
  if (!research) {
    result.research_error = { code: 'NO_SOURCE', message: 'no visited source URL to cite' };
    return;
  }
  const r = await run.callTool('create_research', {
    companyId: w.companyId,
    signalId: w.signalId,
    researchType: research.researchType,
    query: clean(research.query),
    summary: clean(research.summary),
    structuredResult: research.structuredResult,
    sources: research.sources,
    confidence: research.confidence,
  });
  if (r.result.status !== 'ok') {
    result.research_error = toolError(r);
    return;
  }
  const out = r.result.output as { created: boolean; record: { id: string } };
  result.research_id = out.record.id;
  result.research_created = out.created;
}

export function exhibitorCounters(results: ExhibitorResult[]) {
  const count = (...s: ExhibitorStatus[]) => results.filter((r) => s.includes(r.status)).length;
  return {
    exhibitors: results.length,
    evaluated: results.filter((r) => r.relevant !== undefined).length,
    relevant: results.filter((r) => r.relevant === true).length,
    hypotheses_created: count('hypothesis_created'),
    hypotheses_existing: count('hypothesis_existing'),
    discarded_irrelevant: count('discarded_irrelevant'),
    discarded_low_confidence: count('discarded_low_confidence'),
    skipped_no_domain: count('skipped_no_domain'),
    domain_ambiguous: count('domain_ambiguous'),
    domain_not_found: count('domain_not_found'),
    domains_resolved_by_search: results.filter((r) => r.domain_resolution?.status === 'domain_resolved').length,
    companies_created: results.filter((r) => r.company_created === true).length,
    research_created: results.filter((r) => r.research_created === true).length,
    research_existing: results.filter((r) => r.research_created === false).length,
    research_errors: results.filter((r) => r.research_error !== undefined).length,
    errors: count(...ERROR_STATUSES),
  };
}

export function resultLine(r: ExhibitorResult): string {
  return `- ${r.name}: ${STATUS_LABELS_ES[r.status]}${r.confidence !== undefined ? ` (confianza ${r.confidence.toFixed(2).replace('.', ',')})` : ''}${r.error ? ` — ${r.error.code}` : ''}`;
}
