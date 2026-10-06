import { z } from 'zod';
import { HYPOTHESIS_TIMINGS, normalizeDomain, SIGNAL_TYPES, type SignalType } from '../integrations/twenty/index.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import type { ChatMessage, CompletionResult, TokenUsage } from '../providers/model-provider.js';
import type { ToolCallOutcome } from '../tools/executor.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';
import { buildExhibitorPrompt, buildRepairPrompt, PROSPECTOR_SYSTEM_PROMPT } from './prospector-prompt.js';

// ---------------------------------------------------------------------------
// Input
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

export const ProspectorInput = z.object({
  event: z.object({
    name: z.string().trim().min(1).max(255),
    type: EventType,
    date: z.iso.date().optional(),
    location: z.string().trim().min(1).max(255).optional(),
    source_url: z.url({ protocol: /^https?$/ }).max(2048).optional(),
  }),
  exhibitors: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255),
        domain: z.string().trim().max(253).optional(),
        description: z.string().trim().max(4000).optional(),
        sector: z.string().trim().max(255).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type ProspectorInput = z.infer<typeof ProspectorInput>;

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

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(raíz)'}: ${i.message}`)
    .join('; ');
}

/** Parses the raw model text into a validated decision. Tolerates ```json fences. */
export function parseExhibitorDecision(text: string): { ok: true; value: ExhibitorDecision } | { ok: false; error: string } {
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
// Agent
// ---------------------------------------------------------------------------

export const PROSPECTOR_TOOLS = ['find_company', 'upsert_company', 'create_signal', 'create_hypothesis', 'create_agent_run_summary'] as const;

type ExhibitorStatus =
  | 'hypothesis_created'
  | 'hypothesis_existing'
  | 'discarded_irrelevant'
  | 'discarded_low_confidence'
  | 'skipped_no_domain'
  | 'llm_error'
  | 'llm_invalid'
  | 'tool_error';

/** Labels for the commercial-facing run summary in Twenty. */
const STATUS_LABELS_ES: Record<ExhibitorStatus, string> = {
  hypothesis_created: 'hipótesis creada',
  hypothesis_existing: 'hipótesis ya existente',
  discarded_irrelevant: 'descartado (sin encaje)',
  discarded_low_confidence: 'descartado (confianza baja)',
  skipped_no_domain: 'omitido (sin dominio verificado)',
  llm_error: 'error del modelo',
  llm_invalid: 'respuesta del modelo no válida',
  tool_error: 'error al escribir en el CRM',
};

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

interface ProspectorConfig {
  minConfidence: number;
  usdToEur: number;
  taskName: string;
  maxTokens: number;
  modelOptions: Record<string, unknown>;
}

function readConfig(configuration: Record<string, unknown>): ProspectorConfig {
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const raw = (configuration.model_options ?? {}) as Record<string, unknown>;
  // snake_case in configuration -> provider option names.
  const modelOptions: Record<string, unknown> = {};
  if (raw.thinking_level !== undefined) modelOptions.thinkingLevel = raw.thinking_level;
  if (raw.thinking_budget !== undefined) modelOptions.thinkingBudget = raw.thinking_budget;
  if (raw.temperature !== undefined) modelOptions.temperature = raw.temperature;
  return {
    minConfidence: num(configuration.min_confidence, 0.5),
    usdToEur: num(configuration.usd_to_eur, DEFAULT_USD_TO_EUR),
    taskName: typeof configuration.task_name === 'string' ? configuration.task_name : 'daily-event-prospecting',
    maxTokens: num(configuration.max_output_tokens, 4096),
    modelOptions,
  };
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cachedTokens: a.cachedTokens + b.cachedTokens };
}

function formatEur(n: number): string {
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 4, maximumFractionDigits: 6 })} €`;
}

/**
 * ProspectorAgent (`configuration.implementation = "prospector"`).
 *
 * For each exhibitor of the input event: one LLM call returning structured JSON
 * (validated with zod; one repair retry with the validation error in the prompt).
 * Relevant exhibitors with `confidence >= min_confidence` are written to Twenty:
 * `upsert_company` -> `create_signal` (the event, status NEW) -> `create_hypothesis`
 * (status PROPOSED). The run always ends with `create_agent_run_summary`.
 *
 * Per-exhibitor failures do not abort the run: they are counted and the outcome
 * becomes PARTIAL (some failed) or FAILED (all failed / invalid input). The agent
 * returns normally in those cases so the trace keeps every MODEL and TOOL step and
 * the real cost; the business outcome is in `output.outcome`.
 */
export class ProspectorAgent implements AgentImplementation {
  readonly kind = 'prospector';

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('ProspectorAgent requires a tool executor');
    const tools = ctx.tools;
    const startedAt = this.clock();
    const cfg = readConfig(ctx.version.configuration);
    const steps: AgentStep[] = [];
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let modelCost = 0;
    let toolCost = 0;
    let llmCalls = 0;
    let costCurrency = 'USD';

    const callTool = async (tool: string, input: unknown): Promise<ToolCallOutcome> => {
      const outcome = await tools.call(tool, input);
      toolCost += outcome.costEur;
      steps.push({ ...outcome.step, output: { ...(outcome.step.output as Record<string, unknown>), costEur: outcome.costEur } });
      return outcome;
    };

    const parsedInput = ProspectorInput.safeParse(ctx.input);
    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      input: { input_keys: Object.keys(ctx.input) },
      output: parsedInput.success
        ? {
            plan: 'evaluate each exhibitor with the LLM; write relevant ones to Twenty; publish the run summary',
            event: parsedInput.data.event.name,
            exhibitors: parsedInput.data.exhibitors.length,
            min_confidence: cfg.minConfidence,
            allowed_tools: tools.specs().map((s) => s.name),
          }
        : { error: 'invalid input', issues: issues(parsedInput.error) },
      latencyMs: 0,
    });

    const results: ExhibitorResult[] = [];

    if (parsedInput.success) {
      const { event, exhibitors } = parsedInput.data;
      const today = startedAt.toISOString().slice(0, 10);
      const system = ctx.version.systemPrompt.trim().length > 0 ? ctx.version.systemPrompt : PROSPECTOR_SYSTEM_PROMPT;

      for (const exhibitor of exhibitors) {
        ctx.signal.throwIfAborted();
        const domain = normalizeDomain(exhibitor.domain);
        // Status is provisional until the exhibitor is fully processed.
        const result: ExhibitorResult = { name: exhibitor.name, domain, status: 'llm_invalid' };
        results.push(result);

        // 1. LLM decision (+1 repair attempt).
        const messages: ChatMessage[] = [
          { role: 'user', content: buildExhibitorPrompt({ ...event }, { ...exhibitor, ...(domain ? { domain } : {}) }, today) },
        ];
        let decision: ExhibitorDecision | null = null;
        let modelError = false;
        let lastError = '';
        for (let attempt = 1; attempt <= 2 && !decision; attempt++) {
          let completion: CompletionResult;
          try {
            completion = await ctx.provider.complete({
              model: ctx.version.model,
              system,
              messages,
              maxTokens: cfg.maxTokens,
              options: { ...cfg.modelOptions, responseSchema: EXHIBITOR_DECISION_JSON_SCHEMA },
              signal: ctx.signal,
            });
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            const e = err as { code?: unknown; message?: unknown };
            lastError = String(e.message ?? err);
            steps.push({
              type: 'MODEL',
              timestamp: new Date(),
              model: ctx.version.model,
              input: { exhibitor: exhibitor.name, attempt },
              error: { code: typeof e.code === 'string' ? e.code : 'MODEL_ERROR', message: lastError },
              latencyMs: 0,
            });
            result.status = 'llm_error';
            result.error = { code: typeof e.code === 'string' ? e.code : 'MODEL_ERROR', message: lastError };
            modelError = true;
            break;
          }
          llmCalls += 1;
          usage = addUsage(usage, completion.usage);
          modelCost += completion.cost.modelCost;
          costCurrency = completion.cost.currency;
          const parsed = parseExhibitorDecision(completion.text);
          steps.push({
            type: 'MODEL',
            timestamp: new Date(),
            model: completion.model,
            usage: completion.usage,
            input: { exhibitor: exhibitor.name, attempt, prompt_chars: messages.reduce((n, m) => n + m.content.length, 0) },
            output: {
              valid: parsed.ok,
              ...(parsed.ok ? { decision: parsed.value } : { validation_error: parsed.error, raw: completion.text.slice(0, 2000) }),
              stop_reason: completion.stopReason,
              cost: { amount: completion.cost.modelCost, currency: completion.cost.currency },
            },
            latencyMs: completion.latencyMs,
          });
          if (parsed.ok) {
            decision = parsed.value;
          } else {
            lastError = parsed.error;
            messages.push({ role: 'assistant', content: completion.text || '(respuesta vacía)' }, { role: 'user', content: buildRepairPrompt(parsed.error) });
          }
        }
        if (modelError) continue;
        if (!decision) {
          result.status = 'llm_invalid';
          result.error = { code: 'LLM_INVALID_OUTPUT', message: lastError };
          continue;
        }

        result.relevant = decision.relevant;
        result.confidence = decision.confidence;
        result.reason = decision.reason;
        if (!decision.relevant || !decision.hypothesis) {
          result.status = 'discarded_irrelevant';
          continue;
        }
        result.hypothesis = decision.hypothesis;
        if (decision.confidence < cfg.minConfidence) {
          result.status = 'discarded_low_confidence';
          continue;
        }

        // 2. Company: by domain (upsert, idempotent); without domain only reuse an exact name match.
        let companyId: string | undefined;
        let companyName = exhibitor.name;
        let companyDomain: string | null = domain;
        if (domain) {
          const up = await callTool('upsert_company', { domain, name: exhibitor.name });
          if (up.result.status !== 'ok') {
            Object.assign(result, { status: 'tool_error', error: toolError(up) });
            continue;
          }
          const out = up.result.output as { created: boolean; company: { id: string; name: string } };
          companyId = out.company.id;
          companyName = out.company.name;
          result.company_created = out.created;
        } else {
          const found = await callTool('find_company', { name: exhibitor.name, limit: 5 });
          if (found.result.status !== 'ok') {
            Object.assign(result, { status: 'tool_error', error: toolError(found) });
            continue;
          }
          const companies = (found.result.output as { companies: Array<{ id: string; name: string; domain: string | null }> }).companies;
          const exact = companies.filter((c) => c.name.trim().toLowerCase() === exhibitor.name.trim().toLowerCase());
          if (exact.length !== 1) {
            // Skill rule: never create a company without a verified domain.
            result.status = 'skipped_no_domain';
            continue;
          }
          companyId = exact[0]!.id;
          companyName = exact[0]!.name;
          companyDomain = exact[0]!.domain;
          result.company_created = false;
        }
        result.company_id = companyId;

        // 3. Signal: the event.
        const sourceUrl = event.source_url ?? (companyDomain ? `https://${companyDomain}` : null);
        if (!sourceUrl) {
          result.status = 'skipped_no_domain';
          continue;
        }
        const sig = await callTool('create_signal', {
          companyId,
          title: `${event.name} — ${companyName}`,
          signalType: event.type,
          description: [
            `Expositor en ${event.name}${event.date ? ` (${event.date})` : ''}${event.location ? `, ${event.location}` : ''}.`,
            exhibitor.sector ? `Sector: ${exhibitor.sector}.` : '',
            exhibitor.description ?? '',
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 4000),
          sourceUrl,
          ...(event.date ? { eventDate: event.date } : {}),
          confidence: decision.confidence,
          status: 'NEW',
        });
        if (sig.result.status !== 'ok') {
          Object.assign(result, { status: 'tool_error', error: toolError(sig) });
          continue;
        }
        const signalId = (sig.result.output as { record: { id: string } }).record.id;
        result.signal_id = signalId;

        // 4. Hypothesis. Name = company + event, so a re-run of the same event does not duplicate it.
        const h = decision.hypothesis;
        const evidence = [
          { claim: `${exhibitor.name} figura como expositor en ${event.name}${event.date ? ` (${event.date})` : ''}.`, ...(event.source_url ? { sourceUrl: event.source_url } : {}) },
          { claim: `Valoración del Prospector: ${decision.reason}`.slice(0, 1000) },
        ];
        if (h.differentiators.length > 0) evidence.push({ claim: `Diferenciales de PubliEXPE aplicables: ${h.differentiators.join(', ')}.` });
        const hyp = await callTool('create_hypothesis', {
          companyId,
          signalId,
          name: `${companyName} — ${event.name}`.slice(0, 255),
          need: h.need,
          whyNow: h.why_now,
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
        if (hyp.result.status !== 'ok') {
          Object.assign(result, { status: 'tool_error', error: toolError(hyp) });
          continue;
        }
        const hypOut = hyp.result.output as { created: boolean; record: { id: string } };
        result.hypothesis_id = hypOut.record.id;
        result.status = hypOut.created ? 'hypothesis_created' : 'hypothesis_existing';
      }
    }

    // 5. Summary (always).
    const count = (...s: ExhibitorStatus[]) => results.filter((r) => s.includes(r.status)).length;
    const counters = {
      exhibitors: parsedInput.success ? parsedInput.data.exhibitors.length : 0,
      evaluated: results.filter((r) => r.relevant !== undefined).length,
      relevant: results.filter((r) => r.relevant === true).length,
      hypotheses_created: count('hypothesis_created'),
      hypotheses_existing: count('hypothesis_existing'),
      discarded_irrelevant: count('discarded_irrelevant'),
      discarded_low_confidence: count('discarded_low_confidence'),
      skipped_no_domain: count('skipped_no_domain'),
      companies_created: results.filter((r) => r.company_created === true).length,
      errors: count('llm_error', 'llm_invalid', 'tool_error'),
      llm_calls: llmCalls,
    };
    const outcome: 'SUCCESS' | 'PARTIAL' | 'FAILED' = !parsedInput.success
      ? 'FAILED'
      : counters.errors === 0
        ? 'SUCCESS'
        : counters.errors === counters.exhibitors
          ? 'FAILED'
          : 'PARTIAL';
    modelCost = round6(modelCost);
    const costEur = costCurrency === 'EUR' ? modelCost : round6(modelCost * cfg.usdToEur);

    const lines = parsedInput.success
      ? [
          `Evento: ${parsedInput.data.event.name}${parsedInput.data.event.date ? ` (${parsedInput.data.event.date})` : ''}.`,
          `Expositores: ${counters.exhibitors} · evaluados: ${counters.evaluated} · relevantes: ${counters.relevant} · hipótesis nuevas: ${counters.hypotheses_created} · ya existentes: ${counters.hypotheses_existing}.`,
          `Descartados: ${counters.discarded_irrelevant} sin encaje, ${counters.discarded_low_confidence} por confianza < ${cfg.minConfidence}, ${counters.skipped_no_domain} sin dominio verificado. Errores: ${counters.errors}.`,
          `Coste del modelo: ${formatEur(costEur)} (${llmCalls} llamadas, ${usage.inputTokens} tokens de entrada y ${usage.outputTokens} de salida).`,
          ...results.map(
            (r) =>
              `- ${r.name}: ${STATUS_LABELS_ES[r.status]}${r.confidence !== undefined ? ` (confianza ${r.confidence.toFixed(2).replace('.', ',')})` : ''}${r.error ? ` — ${r.error.code}` : ''}`,
          ),
        ]
      : [`Entrada inválida: ${issues(parsedInput.error)}`];

    const finishedAt = this.clock();
    const summary = await callTool('create_agent_run_summary', {
      task: cfg.taskName,
      agentName: ctx.agent.name,
      agentVersion: ctx.version.version,
      outcome,
      resultSummary: lines.join('\n').slice(0, 4000),
      costEur,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    });
    const runSummaryId = summary.result.status === 'ok' ? (summary.result.output as { record: { id: string } }).record.id : null;

    const output: Record<string, unknown> = {
      status: outcome === 'FAILED' ? 'error' : 'ok',
      outcome,
      agent: ctx.agent.name,
      agent_version: ctx.version.version,
      ...(parsedInput.success ? { event: parsedInput.data.event } : { input_error: issues(parsedInput.error) }),
      counters,
      results,
      cost: { model: modelCost, currency: costCurrency, eur: costEur, usd_to_eur: cfg.usdToEur },
      run_summary_id: runSummaryId,
      ...(summary.result.status !== 'ok' ? { run_summary_error: toolError(summary) } : {}),
    };
    steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: finishedAt.getTime() - startedAt.getTime() });
    return { output, steps, usage, modelCost, toolCost };
  }
}

function toolError(outcome: ToolCallOutcome): { code: string; message: string } {
  const r = outcome.result;
  if (r.status === 'error') return { code: r.code, message: r.message };
  if (r.status === 'approval_required') return { code: 'APPROVAL_REQUIRED', message: r.summary };
  return { code: 'UNKNOWN', message: 'unexpected tool result' };
}
