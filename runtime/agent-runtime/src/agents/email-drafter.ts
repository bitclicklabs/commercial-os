/**
 * EmailDrafterAgent (`configuration.implementation = "email_drafter"`).
 *
 * HITL model of the LLD (section 10 and the human gates of section 15): when a commercial
 * validates a hypothesis, the agent prepares a DRAFT of the first email and leaves it in
 * Twenty as a Note on the company (and on the hypothesis). It never sends anything: there
 * is no mail tool, no SMTP dependency and no mail API anywhere in the runtime. The
 * commercial copies the draft and sends it from their own mailbox.
 *
 * Input, either:
 * - `{ event }`: the `evaluation.recorded` envelope, as the EVENT trigger delivers it
 *   (task `draft-email-on-validated`, filter `feedback = ACCEPTED`); or
 * - `{ hypothesis_id }`: manual run (`POST /tasks/:id/run`).
 *
 * Flow: get_hypothesis (hypothesis + signal + company + decision maker, one READ) ->
 * get_company only if the company was not expanded -> ONE Gemini call returning
 * `{asunto, cuerpo}` -> `finalizeDraft` (signature and unsubscribe line by code) ->
 * create_note (idempotent per company + title).
 */
import { z } from 'zod';
import { HYPOTHESIS_STATUSES } from '../integrations/twenty/index.js';
import type { GetHypothesisOutput } from '../tools/twenty/hypothesis-tools.js';
import type { AgentContext, AgentImplementation, AgentResult } from './agent.js';
import {
  DEFAULT_COMPANY_DESCRIPTOR,
  DEFAULT_SENDER,
  WORD_RANGE,
  buildDraftNoteMarkdown,
  draftNoteTitle,
  finalizeDraft,
  parseEmailDraft,
  type FinalDraft,
  type SenderConfig,
} from './email-draft.js';
import { EMAIL_DRAFT_JSON_SCHEMA, EMAIL_DRAFTER_SYSTEM_PROMPT, buildDraftPrompt } from './email-drafter-prompt.js';
import { DIFFERENTIATORS, ProspectorRun, issues, readConfig, round6, toolError } from './prospector-core.js';

export const EMAIL_DRAFTER_TOOLS = ['find_company', 'get_company', 'get_hypothesis', 'create_note'] as const;

const Guid = z.guid();

const EvaluationEventInput = z.object({
  event: z
    .object({
      id: z.string().min(1),
      type: z.literal('evaluation.recorded'),
      occurredAt: z.string().optional(),
      data: z
        .object({
          evaluationId: z.string().min(1),
          subjectType: z.string().min(1),
          subjectId: z.string().min(1),
          feedback: z.string().min(1),
          companyId: Guid.nullish(),
          occurredAt: z.string().nullish(),
        })
        .loose(),
    })
    .loose(),
});

const ManualInput = z.object({ hypothesis_id: Guid });

/** Verdicts that mean "the commercial wants to pursue this hypothesis". */
const DRAFTABLE_FEEDBACK = new Set(['ACCEPTED', 'EDITED']);
/** Hypothesis statuses that still deserve a first email. */
const DRAFTABLE_STATUS = new Set<string>(HYPOTHESIS_STATUSES.filter((s) => s === 'PROPOSED' || s === 'VALIDATED'));

export interface DrafterRequest {
  hypothesisId: string;
  companyId: string | null;
  feedback: string | null;
  evaluationId: string | null;
  evaluatedAt: string | null;
  eventId: string | null;
}

export type DrafterInputResult = { ok: true; request: DrafterRequest } | { ok: false; skip: boolean; reason: string };

/** Reads the run input. `skip: true` = valid input that must not produce a draft. */
export function readDrafterInput(input: Record<string, unknown>): DrafterInputResult {
  if (input.event !== undefined) {
    const parsed = EvaluationEventInput.safeParse(input);
    if (!parsed.success) return { ok: false, skip: false, reason: `evento inválido: ${issues(parsed.error)}` };
    const { event } = parsed.data;
    const d = event.data;
    if (d.subjectType !== 'hypothesis') return { ok: false, skip: true, reason: `el sujeto es ${d.subjectType}, no una hipótesis` };
    if (!DRAFTABLE_FEEDBACK.has(d.feedback)) return { ok: false, skip: true, reason: `veredicto ${d.feedback}: no se prepara borrador` };
    if (!Guid.safeParse(d.subjectId).success) return { ok: false, skip: false, reason: `subjectId no es un id de Twenty: ${d.subjectId}` };
    return {
      ok: true,
      request: {
        hypothesisId: d.subjectId,
        companyId: d.companyId ?? null,
        feedback: d.feedback,
        evaluationId: d.evaluationId,
        evaluatedAt: d.occurredAt ?? event.occurredAt ?? null,
        eventId: event.id,
      },
    };
  }
  const manual = ManualInput.safeParse(input);
  if (!manual.success) return { ok: false, skip: false, reason: 'entrada inválida: se espera { event } (evaluation.recorded) o { hypothesis_id }' };
  return {
    ok: true,
    request: { hypothesisId: manual.data.hypothesis_id, companyId: null, feedback: null, evaluationId: null, evaluatedAt: null, eventId: null },
  };
}

/** Differentiators recorded by the Prospector in the evidence ("Diferenciales de PubliEXPE aplicables: A, B."). */
export function differentiatorsFromEvidence(evidence: Array<{ claim: string }>): string[] {
  const found = new Set<string>();
  for (const e of evidence) {
    if (!/diferenciales/i.test(e.claim)) continue;
    for (const d of DIFFERENTIATORS) if (e.claim.includes(d)) found.add(d);
  }
  return [...found];
}

export interface DrafterConfig {
  sender: SenderConfig;
  wordRange: { min: number; max: number };
  /** `configuration.company_descriptor`: what the company is, said at its first mention in the body. */
  companyDescriptor: string;
}

export function readDrafterConfig(configuration: Record<string, unknown>): DrafterConfig {
  const s = (configuration.sender ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback);
  const range = (configuration.word_range ?? {}) as Record<string, unknown>;
  const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback);
  return {
    sender: {
      name: str(s.name, DEFAULT_SENDER.name),
      company: str(s.company, DEFAULT_SENDER.company),
      email: str(s.email, DEFAULT_SENDER.email),
      altEmail: s.alt_email === null ? null : str(s.alt_email, DEFAULT_SENDER.altEmail ?? ''),
      signatureLines: Array.isArray(s.signature_lines) ? s.signature_lines.map(String) : DEFAULT_SENDER.signatureLines,
      unsubscribeEmail: str(configuration.unsubscribe_email, DEFAULT_SENDER.unsubscribeEmail),
    },
    wordRange: { min: int(range.min, WORD_RANGE.min), max: int(range.max, WORD_RANGE.max) },
    companyDescriptor: str(configuration.company_descriptor, DEFAULT_COMPANY_DESCRIPTOR),
  };
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';

export class EmailDrafterAgent implements AgentImplementation {
  readonly kind = 'email_drafter';

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('EmailDrafterAgent requires a tool executor');
    const run = new ProspectorRun(ctx, ctx.tools, readConfig(ctx.version.configuration), this.clock);
    const cfg = readDrafterConfig(ctx.version.configuration);
    const body = await this.draft(run, cfg);
    const modelCost = round6(run.modelCost);
    const output: Record<string, unknown> = {
      status: body.outcome === 'FAILED' ? 'error' : 'ok',
      agent: ctx.agent.name,
      agent_version: ctx.version.version,
      ...body,
      sends_email: false,
      cost: { model: modelCost, currency: run.currency, eur: run.costEur(), llm_calls: run.llmCalls },
    };
    run.steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - run.startedAt.getTime() });
    return { output, steps: run.steps, usage: run.usage, modelCost, toolCost: run.toolCost };
  }

  private async draft(run: ProspectorRun, cfg: DrafterConfig): Promise<Record<string, unknown> & { outcome: Outcome }> {
    const { ctx } = run;
    const read = readDrafterInput(ctx.input);
    run.steps.push({
      type: 'THINK',
      timestamp: new Date(),
      input: { input_keys: Object.keys(ctx.input) },
      output: read.ok
        ? { plan: 'read hypothesis, signal and company; one LLM call for {asunto, cuerpo}; save the draft as a Twenty note (never sent)', request: read.request }
        : { skip: read.skip, reason: read.reason },
      latencyMs: 0,
    });
    if (!read.ok) return { outcome: read.skip ? 'SKIPPED' : 'FAILED', reason: read.reason };
    const req = read.request;

    // 1. Hypothesis + signal + company + decision maker.
    const got = await run.callTool('get_hypothesis', { hypothesisId: req.hypothesisId });
    if (got.result.status !== 'ok') return { outcome: 'FAILED', hypothesis_id: req.hypothesisId, error: toolError(got) };
    const data = got.result.output as GetHypothesisOutput;
    if (!data.found || !data.hypothesis) return { outcome: 'SKIPPED', hypothesis_id: req.hypothesisId, reason: 'la hipótesis no existe en Twenty' };
    const h = data.hypothesis;
    if (!DRAFTABLE_STATUS.has(h.status)) return { outcome: 'SKIPPED', hypothesis_id: h.id, reason: `la hipótesis está ${h.status}` };

    const companyId = h.companyId ?? req.companyId;
    if (!companyId) return { outcome: 'SKIPPED', hypothesis_id: h.id, reason: 'la hipótesis no tiene empresa' };
    let company = data.company;
    if (!company || company.id !== companyId) {
      const gc = await run.callTool('get_company', { companyId });
      if (gc.result.status !== 'ok') return { outcome: 'FAILED', hypothesis_id: h.id, company_id: companyId, error: toolError(gc) };
      const out = gc.result.output as { found: boolean; company: { id: string; name: string; domain: string | null; createdAt: string } | null };
      if (!out.found || !out.company) return { outcome: 'SKIPPED', hypothesis_id: h.id, reason: 'la empresa no existe en Twenty' };
      company = { id: out.company.id, name: out.company.name, domain: out.company.domain, createdAt: out.company.createdAt };
    }
    const contact = data.decisionMaker;
    const notes: string[] = [];
    if (req.companyId && req.companyId !== companyId) notes.push(`el evento traía companyId ${req.companyId}; se usa el de la hipótesis`);

    // 2. One LLM call.
    const today = run.startedAt.toISOString().slice(0, 10);
    const system = ctx.version.systemPrompt.trim().length > 0 ? ctx.version.systemPrompt : EMAIL_DRAFTER_SYSTEM_PROMPT;
    const call = await run.completeJson({
      label: { step: 'draft_email', hypothesis: h.id },
      system,
      messages: [
        {
          role: 'user',
          content: buildDraftPrompt({
            today,
            sender: { name: cfg.sender.name, company: cfg.sender.company, descriptor: cfg.companyDescriptor },
            company: { name: company.name, domain: company.domain },
            contact: contact ? { firstName: contact.firstName, lastName: contact.lastName, jobTitle: contact.jobTitle } : null,
            signal: data.signal
              ? { name: data.signal.name, type: data.signal.signalType, date: data.signal.eventDate, description: data.signal.description }
              : null,
            hypothesis: {
              need: h.need,
              whyNow: h.whyNow,
              recommendedProducts: h.recommendedProducts,
              timing: h.timing,
              differentiators: differentiatorsFromEvidence(h.evidence),
            },
          }),
        },
      ],
      parse: parseEmailDraft,
      schema: EMAIL_DRAFT_JSON_SCHEMA,
      maxAttempts: 1,
    });
    if (call.status === 'model_error') return { outcome: 'FAILED', hypothesis_id: h.id, company_id: companyId, error: { code: call.code, message: call.message } };
    if (call.status === 'invalid') return { outcome: 'FAILED', hypothesis_id: h.id, company_id: companyId, error: { code: 'LLM_INVALID_OUTPUT', message: call.message } };

    // 3. Compliance by code: signature + unsubscribe line, no invented names, company descriptor.
    const draft: FinalDraft = finalizeDraft(call.value, {
      sender: cfg.sender,
      companyName: company.name,
      contact: contact ? { firstName: contact.firstName, lastName: contact.lastName } : null,
      wordRange: cfg.wordRange,
      companyDescriptor: cfg.companyDescriptor,
    });

    // 4. Note on the company (+ hypothesis). Idempotent per company + title.
    const title = draftNoteTitle(h.name);
    const note = await run.callTool('create_note', {
      companyId,
      hypothesisId: h.id,
      title,
      bodyMarkdown: buildDraftNoteMarkdown({
        draft,
        sender: cfg.sender,
        contact,
        hypothesisName: h.name,
        feedback: req.feedback,
        evaluatedAt: req.evaluatedAt,
        executionId: ctx.executionId,
      }),
    });
    const result = {
      hypothesis_id: h.id,
      hypothesis_name: h.name,
      company_id: companyId,
      company_name: company.name,
      evaluation_id: req.evaluationId,
      event_id: req.eventId,
      draft: { subject: draft.subject, body: draft.body, word_count: draft.wordCount, fixes: draft.fixes, warnings: draft.warnings },
      ...(notes.length > 0 ? { notes } : {}),
    };
    if (note.result.status !== 'ok') return { outcome: 'FAILED', ...result, error: toolError(note) };
    const n = note.result.output as { created: boolean; adopted: boolean; record: { id: string; title: string } };
    return { outcome: 'SUCCESS', ...result, note_id: n.record.id, note_title: n.record.title, note_created: n.created, note_adopted: n.adopted };
  }
}
