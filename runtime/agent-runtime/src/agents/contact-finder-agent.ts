/**
 * ContactFinderAgent (`configuration.implementation = "contact_finder"`, model role `triage`).
 *
 * One run = one hypothesis (`{ hypothesis_id }`): the runs of the backfill
 * (`pnpm contacts:backfill`, `POST /contacts/backfill`) for the VALIDATED hypotheses that
 * were drafted before the ContactFinder existed and still have an empty `emailTo`.
 *
 * Flow: get_hypothesis -> (VALIDATED only) -> get_company if not expanded -> the shared
 * contact step (`src/contact-finder/step.ts`): find_contact -> [LLM tie-break, rol triage] ->
 * set_hypothesis_recipient (only if empty) -> create_research. It never drafts and never
 * sends: the commercial reviews the recipient in Twenty and sends with one click.
 */
import { z } from 'zod';
import type { GetHypothesisOutput } from '../tools/twenty/hypothesis-tools.js';
import { readContactStepConfig, runContactStep } from '../contact-finder/step.js';
import type { AgentContext, AgentImplementation, AgentResult } from './agent.js';
import { ProspectorRun, readConfig, round6, toolError } from './prospector-core.js';

export const CONTACT_FINDER_IMPLEMENTATION = 'contact_finder';
export const CONTACT_FINDER_AGENT_TOOLS = ['get_hypothesis', 'get_company', 'find_contact', 'set_hypothesis_recipient', 'create_research'] as const;

const Input = z.object({ hypothesis_id: z.guid() });

export class ContactFinderAgent implements AgentImplementation {
  readonly kind = CONTACT_FINDER_IMPLEMENTATION;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('ContactFinderAgent requires a tool executor');
    const run = new ProspectorRun(ctx, ctx.tools, readConfig(ctx.version.configuration), this.clock);
    const body = await this.find(run);
    const modelCost = round6(run.modelCost);
    const output: Record<string, unknown> = {
      status: body.outcome === 'FAILED' ? 'error' : 'ok',
      agent: ctx.agent.name,
      agent_version: ctx.version.version,
      ...body,
      sends_email: false,
      cost: { model: modelCost, currency: run.currency, eur: run.costEur(), tools_eur: round6(run.toolCost), llm_calls: run.llmCalls },
    };
    run.steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - run.startedAt.getTime() });
    return { output, steps: run.steps, usage: run.usage, modelCost, toolCost: run.toolCost };
  }

  private async find(run: ProspectorRun): Promise<Record<string, unknown> & { outcome: 'SUCCESS' | 'SKIPPED' | 'FAILED' }> {
    const { ctx } = run;
    const parsed = Input.safeParse(ctx.input);
    run.steps.push({
      type: 'THINK',
      timestamp: new Date(),
      input: { input_keys: Object.keys(ctx.input) },
      output: parsed.success ? { plan: 'read the hypothesis; search the company web for its published contact; fill an EMPTY emailTo; document it in a Research (never sends)' } : { error: 'entrada inválida' },
      latencyMs: 0,
    });
    if (!parsed.success) return { outcome: 'FAILED', reason: 'entrada inválida: se espera { hypothesis_id }' };
    const got = await run.callTool('get_hypothesis', { hypothesisId: parsed.data.hypothesis_id });
    if (got.result.status !== 'ok') return { outcome: 'FAILED', hypothesis_id: parsed.data.hypothesis_id, error: toolError(got) };
    const data = got.result.output as GetHypothesisOutput;
    if (!data.found || !data.hypothesis) return { outcome: 'SKIPPED', hypothesis_id: parsed.data.hypothesis_id, reason: 'la hipótesis no existe en Twenty' };
    const h = data.hypothesis;
    if (h.status !== 'VALIDATED') return { outcome: 'SKIPPED', hypothesis_id: h.id, reason: `la hipótesis está ${h.status}, no VALIDATED` };
    if (!h.companyId) return { outcome: 'SKIPPED', hypothesis_id: h.id, reason: 'la hipótesis no tiene empresa' };
    let company = data.company;
    if (!company || company.id !== h.companyId) {
      const gc = await run.callTool('get_company', { companyId: h.companyId });
      if (gc.result.status !== 'ok') return { outcome: 'FAILED', hypothesis_id: h.id, error: toolError(gc) };
      const out = gc.result.output as { found: boolean; company: { id: string; name: string; domain: string | null; createdAt: string } | null };
      if (!out.found || !out.company) return { outcome: 'SKIPPED', hypothesis_id: h.id, reason: 'la empresa no existe en Twenty' };
      company = out.company;
    }
    const step = await runContactStep(run, { hypothesis: h, company, decisionMaker: data.decisionMaker }, readContactStepConfig(ctx.version.configuration, { enabled: true }));
    const base = { hypothesis_id: h.id, hypothesis_name: h.name, company_id: company.id, company_name: company.name, contact: step };
    if (step.status === 'error') return { outcome: 'FAILED', ...base, error: step.error };
    if (step.status === 'skipped') return { outcome: 'SKIPPED', ...base, reason: step.reason };
    return { outcome: 'SUCCESS', ...base };
  }
}
