/**
 * The contact step shared by the EmailDrafter (before drafting, same run) and the
 * ContactFinder agent (backfill): find_contact -> [LLM tie-break] -> set_hypothesis_recipient ->
 * upsert_person (tanda 19: the chosen / priority-1 candidates with a published person name become
 * native Twenty Persons, deduped by email) -> create_research (which references the person ids).
 * `upsert_person` is skipped when the agent's policy does not allow it (older seeded versions).
 *
 * HITL is untouched: the step only fills an EMPTY `emailTo` (never a value typed by a person,
 * never a reviewed/sent draft) and documents the choice in a Research with its sources. It
 * never fails the caller: any error comes back as `status: 'error'` and the draft goes on
 * with an empty recipient, as before.
 */
import type { GetHypothesisOutput } from '../tools/twenty/hypothesis-tools.js';
import { ProspectorRun, toolError } from '../agents/prospector-core.js';
import type { FindContactOutput } from './tools.js';
import type { FinderResult } from './finder.js';
import {
  buildContactResearchSummary,
  buildContactStructuredResult,
  CONTACT_RESEARCH_TYPE,
  contactResearchName,
  contactResearchQuery,
  contactResearchSources,
  researchConfidence,
  type ResearchWriteState,
} from './research.js';
import { contactPeople } from './people.js';
import { acceptTriage, buildContactTriagePrompt, CONTACT_TRIAGE_JSON_SCHEMA, CONTACT_TRIAGE_SYSTEM_PROMPT, parseContactTriage } from './triage.js';

export interface ContactStepConfig {
  enabled: boolean;
  /** LLM tie-break between equally ranked candidates. */
  llmTriage: boolean;
  /** Phase 2 for VALIDATED hypotheses without a published address. */
  enrich: boolean;
}

/** `configuration.contact_finder`: `{ enabled, llm_triage, enrich }` (defaults: off, on, on). */
export function readContactStepConfig(configuration: Record<string, unknown>, defaults: Partial<ContactStepConfig> = {}): ContactStepConfig {
  const c = (configuration.contact_finder ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    enabled: bool(c.enabled, defaults.enabled ?? false),
    llmTriage: bool(c.llm_triage, defaults.llmTriage ?? true),
    enrich: bool(c.enrich, defaults.enrich ?? true),
  };
}

export type ContactStepResult =
  | { status: 'skipped'; reason: string; email: string | null }
  | {
      status: 'done';
      /** Address now usable as recipient (written, or already the hypothesis' own). */
      email: string | null;
      found: boolean;
      sourceUrl: string | null;
      reason: string | null;
      emailTo: ResearchWriteState['emailTo'];
      researchId: string | null;
      researchError?: { code: string; message: string };
      triage: { email: string; reason: string } | null;
      /** Native Persons written for this search (tanda 19). */
      people: ContactPersonWrite[];
      candidates: number;
      enrich: FinderResult['enrich'];
    }
  | { status: 'error'; error: { code: string; message: string }; email: null };

export interface ContactPersonWrite {
  email: string;
  chosen: boolean;
  /** created | updated | unchanged | skipped | error */
  outcome: string;
  personId: string | null;
  error?: { code: string; message: string };
}

export interface ContactStepSubject {
  hypothesis: NonNullable<GetHypothesisOutput['hypothesis']>;
  company: { id: string; name: string; domain: string | null };
  decisionMaker: GetHypothesisOutput['decisionMaker'];
}

export async function runContactStep(run: ProspectorRun, subject: ContactStepSubject, cfg: ContactStepConfig): Promise<ContactStepResult> {
  const { hypothesis: h, company } = subject;
  if (!cfg.enabled) return { status: 'skipped', reason: 'contact_finder desactivado', email: null };
  if (subject.decisionMaker?.email) return { status: 'skipped', reason: 'la hipótesis tiene un decisor con email', email: subject.decisionMaker.email };
  const current = h.emailTo?.trim() ? h.emailTo.trim() : null;
  if (current) return { status: 'skipped', reason: 'la hipótesis ya tiene destinatario (Email to)', email: current };
  if (h.emailStatus === 'READY' || h.emailStatus === 'SENDING' || h.emailStatus === 'SENT') {
    return { status: 'skipped', reason: `el borrador está ${h.emailStatus}: no se toca`, email: null };
  }
  if (!company.domain) return { status: 'skipped', reason: 'la empresa no tiene dominio en el CRM', email: null };

  // 1. Search (web first; enrichment only for VALIDATED hypotheses, when enabled).
  const found = await run.callTool('find_contact', { companyName: company.name, domain: company.domain, allowEnrich: cfg.enrich && h.status === 'VALIDATED' });
  if (found.result.status !== 'ok') return { status: 'error', error: toolError(found), email: null };
  const result = found.result.output as FindContactOutput as FinderResult;

  // 2. Optional tie-break by the LLM (only real ambiguity: equally ranked candidates).
  let triage: { email: string; reason: string } | null = null;
  if (result.chosen && result.tie.length > 1 && cfg.llmTriage) {
    const tied = result.tie.map((e) => result.candidates.find((c) => c.email === e)).filter((c): c is NonNullable<typeof c> => c !== undefined);
    const call = await run.completeJson({
      label: { step: 'contact_triage', hypothesis: h.id },
      system: CONTACT_TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildContactTriagePrompt(company.name, tied) }],
      parse: parseContactTriage,
      schema: CONTACT_TRIAGE_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxAttempts: 1,
      maxTokens: 512,
    });
    if (call.status === 'ok') {
      triage = acceptTriage(call.value, result.tie);
      if (triage && triage.email !== result.chosen.email) {
        const pick = result.candidates.find((c) => c.email === triage!.email)!;
        result.chosen = { ...result.chosen, email: pick.email, sourceUrl: pick.sources[0]?.url ?? null };
      }
    }
  }

  // 3. emailTo (only if still empty), then the Research that documents it.
  let emailTo: ResearchWriteState['emailTo'] = 'not_written';
  let usable: string | null = null;
  if (result.chosen) {
    const set = await run.callTool('set_hypothesis_recipient', { hypothesisId: h.id, emailTo: result.chosen.email });
    if (set.result.status === 'ok') {
      const out = set.result.output as { written: boolean; reason: string; emailTo: string | null };
      emailTo = out.reason === 'written' ? 'written' : out.reason === 'already_set' ? 'already_set' : out.reason === 'human_owned' ? 'human_owned' : 'not_written';
      usable = out.emailTo;
    }
  }
  // 4. Native Persons (tanda 19): never fatal; skipped when the policy does not allow the tool.
  const people: ContactPersonWrite[] = [];
  const candidates = contactPeople(result);
  if (candidates.length > 0 && run.tools.specs().some((t) => t.name === 'upsert_person')) {
    for (const p of candidates) {
      const up = await run.callTool('upsert_person', { email: p.email, fullName: p.name, jobTitle: p.jobTitle, companyId: company.id });
      if (up.result.status === 'ok') {
        const out = up.result.output as { outcome: string; person: { id: string } | null };
        people.push({ email: p.email, chosen: p.chosen, outcome: out.outcome, personId: out.person?.id ?? null });
      } else people.push({ email: p.email, chosen: p.chosen, outcome: 'error', personId: null, error: toolError(up) });
    }
  }
  const state: ResearchWriteState = { hypothesisName: h.name, emailTo, triage, people };
  const research = await run.callTool('create_research', {
    companyId: company.id,
    ...(h.commercialSignalId ? { signalId: h.commercialSignalId } : {}),
    name: contactResearchName(company.name, result.chosen !== null),
    researchType: CONTACT_RESEARCH_TYPE,
    query: contactResearchQuery(h.id, result.domain),
    summary: buildContactResearchSummary(result, state),
    structuredResult: buildContactStructuredResult(result, { ...state, hypothesisId: h.id }),
    sources: contactResearchSources(result),
    confidence: researchConfidence(result),
  });
  const researchId = research.result.status === 'ok' ? (research.result.output as { record: { id: string } }).record.id : null;
  return {
    status: 'done',
    email: usable,
    found: result.chosen !== null,
    sourceUrl: result.chosen?.sourceUrl ?? null,
    reason: result.chosen?.reason ?? result.noChoiceReason,
    emailTo,
    researchId,
    ...(researchId ? {} : { researchError: toolError(research) }),
    triage,
    people,
    candidates: result.candidates.length,
    enrich: result.enrich,
  };
}
