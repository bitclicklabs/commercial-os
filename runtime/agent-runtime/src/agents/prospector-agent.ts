import type { AgentContext, AgentImplementation, AgentResult } from './agent.js';
import { isScoutInput, runScout } from './event-scout.js';
import {
  evaluateExhibitor,
  exhibitorCounters,
  formatEur,
  issues,
  ProspectorInput,
  ProspectorRun,
  readConfig,
  resultLine,
  round6,
  type ExhibitorResult,
  type RunOutcome,
} from './prospector-core.js';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT } from './prospector-prompt.js';
import { useSkill } from '../skills/resolver.js';
import { useKnowledge } from '../knowledge/resolver.js';

export {
  DIFFERENTIATORS,
  EXHIBITOR_DECISION_JSON_SCHEMA,
  ExhibitorDecision,
  ExhibitorHypothesis,
  parseExhibitorDecision,
  PROSPECTOR_TOOLS,
  ProspectorInput,
  type ExhibitorResult,
} from './prospector-core.js';

/**
 * ProspectorAgent (`configuration.implementation = "prospector"`). Two modes, chosen by
 * the shape of the input:
 *
 * - **direct** (`{ event, exhibitors[] }`, task `daily-event-prospecting`): for each
 *   exhibitor one LLM call returning structured JSON (validated with zod; one repair
 *   retry). Relevant exhibitors with `confidence >= min_confidence` are written to
 *   Twenty: `upsert_company` -> `create_signal` (status NEW) -> `create_hypothesis`
 *   (status PROPOSED).
 * - **scout** (`{ sector, region?, horizon_months? }` or `{ event_url }`, task
 *   `weekly-event-scouting`): finds real fairs with Gemini grounding, downloads their
 *   exhibitor pages with `fetch_url`, extracts exhibitors from the downloaded text and
 *   runs the same per-exhibitor pipeline (see `event-scout.ts`).
 *
 * The run always ends with `create_agent_run_summary`. Per-exhibitor failures do not
 * abort the run: the outcome becomes PARTIAL or FAILED and the agent returns normally,
 * so the trace keeps every MODEL and TOOL step and the real cost.
 */
export class ProspectorAgent implements AgentImplementation {
  readonly kind = 'prospector';

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('ProspectorAgent requires a tool executor');
    const cfg = readConfig(ctx.version.configuration);
    const run = new ProspectorRun(ctx, ctx.tools, cfg, this.clock);
    const today = run.startedAt.toISOString().slice(0, 10);

    let outcome: RunOutcome;
    let lines: string[];
    let body: Record<string, unknown>;
    let taskName: string;

    if (isScoutInput(ctx.input)) {
      const scout = await runScout(run, ctx.input, today);
      ({ outcome, lines } = scout);
      body = scout.output;
      taskName = cfg.scout.taskName;
    } else {
      ({ outcome, lines, body } = await this.runDirect(run, today));
      taskName = cfg.taskName;
    }

    const summary = await run.publishSummary(taskName, outcome, lines);
    const modelCost = round6(run.modelCost);
    const output: Record<string, unknown> = {
      status: outcome === 'FAILED' ? 'error' : 'ok',
      outcome,
      agent: ctx.agent.name,
      agent_version: ctx.version.version,
      ...body,
      cost: {
        model: modelCost,
        currency: run.currency,
        eur: run.costEur(),
        usd_to_eur: cfg.usdToEur,
        ...(run.groundingCalls > 0 ? { grounding: round6(run.groundingCost), grounding_units: run.groundingUnits } : {}),
      },
      run_summary_id: summary.id,
      ...(summary.error ? { run_summary_error: summary.error } : {}),
    };
    const finishedAt = this.clock();
    run.steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: finishedAt.getTime() - run.startedAt.getTime() });
    return { output, steps: run.steps, usage: run.usage, modelCost, toolCost: run.toolCost };
  }

  private async runDirect(run: ProspectorRun, today: string): Promise<{ outcome: RunOutcome; lines: string[]; body: Record<string, unknown> }> {
    const { ctx, cfg } = run;
    const parsedInput = ProspectorInput.safeParse(ctx.input);
    run.steps.push({
      type: 'THINK',
      timestamp: new Date(),
      input: { input_keys: Object.keys(ctx.input) },
      output: parsedInput.success
        ? {
            plan: 'evaluate each exhibitor with the LLM; write relevant ones to Twenty (company, signal, research, hypothesis); publish the run summary',
            event: parsedInput.data.event.name,
            exhibitors: parsedInput.data.exhibitors.length,
            min_confidence: cfg.minConfidence,
            allowed_tools: run.tools.specs().map((s) => s.name),
          }
        : { error: 'invalid input', issues: issues(parsedInput.error) },
      latencyMs: 0,
    });
    if (!parsedInput.success) {
      const error = issues(parsedInput.error);
      return {
        outcome: 'FAILED',
        lines: [`Entrada inválida: ${error}`],
        body: { input_error: error, counters: { ...exhibitorCounters([]), llm_calls: 0 }, results: [] },
      };
    }

    const { event, exhibitors } = parsedInput.data;
    const system = useKnowledge(ctx, useSkill(ctx, PROSPECTOR_SKILL_ID, ctx.version.systemPrompt.trim().length > 0 ? ctx.version.systemPrompt : PROSPECTOR_SYSTEM_PROMPT));
    const results: ExhibitorResult[] = [];
    for (const exhibitor of exhibitors) {
      ctx.signal.throwIfAborted();
      results.push(await evaluateExhibitor(run, event, exhibitor, { today, system }));
    }

    const counters = { ...exhibitorCounters(results), llm_calls: run.llmCalls };
    const outcome: RunOutcome = counters.errors === 0 ? 'SUCCESS' : counters.errors === counters.exhibitors ? 'FAILED' : 'PARTIAL';
    const lines = [
      `Evento: ${event.name}${event.date ? ` (${event.date})` : ''}.`,
      `Expositores: ${counters.exhibitors} · evaluados: ${counters.evaluated} · relevantes: ${counters.relevant} · hipótesis nuevas: ${counters.hypotheses_created} · ya existentes: ${counters.hypotheses_existing} · research: ${counters.research_created}${counters.research_errors > 0 ? ` (${counters.research_errors} sin registrar)` : ''}.`,
      `Descartados: ${counters.discarded_irrelevant} sin encaje, ${counters.discarded_low_confidence} por confianza < ${cfg.minConfidence}, ${counters.skipped_no_domain} sin dominio verificado. Errores: ${counters.errors}.`,
      `Coste del modelo: ${formatEur(run.costEur())} (${run.llmCalls} llamadas, ${run.usage.inputTokens} tokens de entrada y ${run.usage.outputTokens} de salida).`,
      ...results.map(resultLine),
    ];
    return { outcome, lines, body: { mode: 'direct', event, counters, results } };
  }
}
