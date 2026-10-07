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
import { scrubUnknownUrls, type SourceLedger } from './source-ledger.js';

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

/** Tools the Prospector may use (both modes). `fetch_url` and `render_url` are READ and only used by the scout mode. */
export const PROSPECTOR_TOOLS = ['find_company', 'upsert_company', 'create_signal', 'create_hypothesis', 'create_agent_run_summary', 'fetch_url', 'render_url'] as const;

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
  /** Grounding redirects resolved to learn a source's domain when grounding did not report it. */
  maxRedirectResolutions: number;
  eventSignalConfidence: number;
  /**
   * When the grounded search ran queries but returned no sources, accept the proposed
   * URL only if the downloaded page corroborates the fair (default true; false = strict).
   */
  verifyUnsourcedByFetch: boolean;
}

export interface ProspectorConfig {
  minConfidence: number;
  usdToEur: number;
  taskName: string;
  maxTokens: number;
  modelOptions: Record<string, unknown>;
  scout: ScoutConfig;
}

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
      maxExhibitorsPerEvent: int(s.max_exhibitors_per_event, 20, 50),
      maxFetches: int(s.max_fetches, 16, 30),
      maxPagesPerEvent: int(s.max_pages_per_event, 2, 4),
      maxRenders: int(s.max_renders, 3, 6),
      maxPdfsPerEvent: int(s.max_pdfs_per_event, 2, 2),
      maxRedirectResolutions: int(s.max_redirect_resolutions, 3, 5),
      eventSignalConfidence: Math.min(1, Math.max(0, num(s.event_signal_confidence, 0.5))),
      verifyUnsourcedByFetch: s.verify_unsourced_by_fetch !== false,
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
  hypothesis_id?: string;
  hypothesis?: z.infer<typeof ExhibitorHypothesis>;
  error?: { code: string; message: string };
}

export interface EvaluateOptions {
  today: string;
  system: string;
  /**
   * Scout mode: web-sourced data. Every `sourceUrl` written to Twenty must be a known
   * source of the ledger and free text is scrubbed of URLs foreign to it.
   */
  ledger?: SourceLedger;
}

/** classification (LLM) -> company -> signal -> hypothesis, for one exhibitor. Never throws on business errors. */
export async function evaluateExhibitor(run: ProspectorRun, event: ProspectorEvent, exhibitor: ExhibitorInput, opts: EvaluateOptions): Promise<ExhibitorResult> {
  const domain = normalizeDomain(exhibitor.domain);
  const result: ExhibitorResult = { name: exhibitor.name, domain, status: 'llm_invalid' };
  const ledger = opts.ledger;
  const clean = (text: string) => (ledger ? scrubUnknownUrls(text, ledger) : text);

  // 1. LLM decision (+1 repair attempt).
  const call = await run.completeJson({
    label: { exhibitor: exhibitor.name },
    system: opts.system,
    messages: [{ role: 'user', content: buildExhibitorPrompt({ ...event }, { ...exhibitor, ...(domain ? { domain } : {}) }, opts.today) }],
    parse: parseExhibitorDecision,
    schema: EXHIBITOR_DECISION_JSON_SCHEMA,
  });
  if (call.status === 'model_error') {
    return Object.assign(result, { status: 'llm_error' as const, error: { code: call.code, message: call.message } });
  }
  if (call.status === 'invalid') {
    return Object.assign(result, { status: 'llm_invalid' as const, error: { code: 'LLM_INVALID_OUTPUT', message: call.message } });
  }
  const decision = call.value;
  result.relevant = decision.relevant;
  result.confidence = decision.confidence;
  result.reason = decision.reason;
  if (!decision.relevant || !decision.hypothesis) return Object.assign(result, { status: 'discarded_irrelevant' as const });
  result.hypothesis = decision.hypothesis;
  if (decision.confidence < run.cfg.minConfidence) return Object.assign(result, { status: 'discarded_low_confidence' as const });

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
    if (exact.length !== 1) return Object.assign(result, { status: 'skipped_no_domain' as const });
    companyId = exact[0]!.id;
    companyName = exact[0]!.name;
    companyDomain = exact[0]!.domain;
    result.company_created = false;
  }
  result.company_id = companyId;

  // 4. Signal: the event.
  const sourceUrl = event.source_url ?? (companyDomain ? `https://${companyDomain}` : null);
  if (!sourceUrl) return Object.assign(result, { status: 'skipped_no_domain' as const });
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

  // 5. Hypothesis. Name = company + event, so a re-run of the same event does not duplicate it.
  const h = decision.hypothesis;
  const evidence: Array<{ claim: string; sourceUrl?: string }> = [
    { claim: `${exhibitor.name} figura como expositor en ${event.name}${event.date ? ` (${event.date})` : ''}.`, ...(event.source_url ? { sourceUrl: event.source_url } : {}) },
    { claim: clean(`Valoración del Prospector: ${decision.reason}`).slice(0, 1000) },
  ];
  if (h.differentiators.length > 0) evidence.push({ claim: `Diferenciales de PubliEXPE aplicables: ${h.differentiators.join(', ')}.` });
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
    recommendedProducts: h.recommended_products,
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
    companies_created: results.filter((r) => r.company_created === true).length,
    errors: count(...ERROR_STATUSES),
  };
}

export function resultLine(r: ExhibitorResult): string {
  return `- ${r.name}: ${STATUS_LABELS_ES[r.status]}${r.confidence !== undefined ? ` (confianza ${r.confidence.toFixed(2).replace('.', ',')})` : ''}${r.error ? ` — ${r.error.code}` : ''}`;
}
