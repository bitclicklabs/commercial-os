/**
 * Idempotent seed of the EmailDrafter agent and its task `draft-email-on-validated`
 * (EVENT trigger: `evaluation.recorded` with `feedback` ACCEPTED or EDITED on a hypothesis
 * that ends VALIDATED: `{"feedback":{"in":["ACCEPTED","EDITED"]},"subjectType":"hypothesis",
 * "toStatus":"VALIDATED"}`). `toStatus` keeps out the EDITED verdicts recorded while the
 * hypothesis is still PROPOSED (an in-place edit is not a validation). The drafter reads the
 * hypothesis from Twenty when it runs, so an edited-and-validated one is drafted with the
 * corrected data.
 * Same rules as the Prospector seed: a changed agent version is added as a NEW version,
 * a changed task gets a new TaskDefinitionVersion; a second run changes nothing.
 *
 * The agent only writes internal Notes in Twenty (and, with `send_from_twenty.enabled`, the
 * draft fields of the hypothesis; with `contact_finder.enabled`, an empty `emailTo` and a
 * Research "Contacto — <empresa>"): its tool policy has no mail tool (none exists) and its
 * risk ceiling is LOW_WRITE.
 */
import type { Db } from '../db/client.js';
import { EMAIL_DRAFTER_TOOLS } from '../agents/email-drafter.js';
import { EMAIL_DRAFTER_SKILL_ID } from '../agents/email-drafter-prompt.js';
import { DEFAULT_COMPANY_DESCRIPTOR, DEFAULT_SENDER, WORD_RANGE } from '../agents/email-draft.js';
import { MAX_PEOPLE_PER_SEARCH } from '../contact-finder/people.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import type { SkillRef } from '../db/schema.js';
import { CATALOG_TOOL_IDS } from '../tools/catalog/catalog-tools.js';
import { upsertAgent, upsertTask, type AgentVersionSpec, type TaskSpec } from './prospector-seed.js';

export const EMAIL_DRAFTER_AGENT_NAME = 'EmailDrafter';
export const EMAIL_DRAFT_TASK_NAME = 'draft-email-on-validated';

export function desiredEmailDrafterVersion(): AgentVersionSpec {
  return {
    model: 'gemini-flash-latest',
    modelProvider: 'gemini',
    // MVP-1: the prompt is the database skill (skillRefs, ACTIVE version); fallback: the code constant.
    systemPrompt: '',
    configuration: {
      implementation: 'email_drafter',
      stage: 'EMAIL_DRAFTER',
      tool_policy: {
        // Catalog tools (READ): allowed so a future skill version can look products up; the drafter
        // code does not call them and its copy (confirmed by the user) does not change.
        // upsert_person (tanda 19, additive): the contact step writes the published people as Persons.
        allow: [...EMAIL_DRAFTER_TOOLS, ...CATALOG_TOOL_IDS, 'upsert_person'],
        max_risk_level: 'LOW_WRITE',
        max_calls_per_execution: 15 + MAX_PEOPLE_PER_SEARCH,
        max_calls_per_tool: {
          create_note: 1,
          set_hypothesis_draft: 1,
          find_contact: 1,
          set_hypothesis_recipient: 1,
          create_research: 1,
          upsert_person: MAX_PEOPLE_PER_SEARCH,
          catalog_search_products: 2,
          catalog_get_product: 3,
          catalog_estimate_customization: 2,
          catalog_list_families: 1,
          catalog_describe: 1,
        },
      },
      // Send from Twenty (docs/twenty-envio-email.md): OFF until the Twenty App fields
      // emailTo / emailSubject / emailBody / emailStatus are synced. Turning it on only adds
      // the draft to those fields; sending is always a person clicking the Twenty workflow.
      send_from_twenty: { enabled: true },
      // ContactFinder (tanda 17): before drafting, look for the recipient on the company's own
      // web, fill an EMPTY emailTo and leave a Research with the sources. Never overwrites a
      // recipient typed by a person; never fatal (the draft is written anyway).
      contact_finder: { enabled: true, llm_triage: true, enrich: true },
      sender: {
        name: DEFAULT_SENDER.name,
        company: DEFAULT_SENDER.company,
        email: DEFAULT_SENDER.email,
        alt_email: DEFAULT_SENDER.altEmail,
        signature_lines: [...DEFAULT_SENDER.signatureLines],
      },
      unsubscribe_email: DEFAULT_SENDER.unsubscribeEmail,
      company_descriptor: DEFAULT_COMPANY_DESCRIPTOR,
      // Knowledge layer (LLD 6.4): ACTIVE entries of these domains go into the drafting prompt.
      knowledge_domains: ['email'],
      word_range: { min: WORD_RANGE.min, max: WORD_RANGE.max },
      usd_to_eur: DEFAULT_USD_TO_EUR,
      max_output_tokens: 4096,
      model_options: { thinking_level: 'low' },
    },
    skillRefs: [{ name: EMAIL_DRAFTER_SKILL_ID }] as SkillRef[],
  };
}

export function desiredEmailDraftTask(): TaskSpec {
  return {
    description:
      'Cuando un comercial valida una hipótesis (veredicto ACCEPTED, o EDITED si la corrigió antes de validarla), el EmailDrafter prepara un BORRADOR del primer email y lo deja como nota en Twenty sobre la empresa y la hipótesis. El sistema no envía nada: el comercial revisa el borrador y lo envía desde su buzón.',
    defaultInput: {},
    schedule: {
      type: 'EVENT',
      event_type: 'evaluation.recorded',
      filter: { feedback: { in: ['ACCEPTED', 'EDITED'] }, subjectType: 'hypothesis', toStatus: 'VALIDATED' },
    },
    timezone: 'Europe/Madrid',
    enabled: true,
    priority: 0,
    maxConcurrency: 2,
    retryPolicy: { max_attempts: 2, backoff_ms: 5_000 },
    // 180 s: contact step (web search, max ~60 s) + the drafting call.
    timeoutMs: 180_000,
  };
}

export interface EmailDrafterSeedResult {
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  agentAction: 'created' | 'version_added' | 'unchanged';
  taskId: string;
  taskVersion: number;
  taskAction: 'created' | 'updated' | 'unchanged';
}

export async function seedEmailDrafter(
  db: Db,
  opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void },
): Promise<EmailDrafterSeedResult> {
  const log = opts.log ?? (() => {});
  const createdBy = opts.createdBy ?? 'seed';
  const agent = await upsertAgent(db, {
    tenantId: opts.tenantId,
    createdBy,
    name: EMAIL_DRAFTER_AGENT_NAME,
    description: 'Prepara borradores del primer email (nunca los envía) cuando un comercial valida una hipótesis.',
    role: 'email_drafter',
    want: desiredEmailDrafterVersion(),
    log,
  });
  log(`agent ${EMAIL_DRAFTER_AGENT_NAME}: ${agent.action} (id ${agent.agentId}, version ${agent.version})`);
  const task = await upsertTask(db, { tenantId: opts.tenantId, createdBy, agentId: agent.agentId, name: EMAIL_DRAFT_TASK_NAME, want: desiredEmailDraftTask() });
  log(`task ${EMAIL_DRAFT_TASK_NAME}: ${task.action} (id ${task.taskId}, version ${task.version})`);
  return {
    agentId: agent.agentId,
    agentVersionId: agent.versionId,
    agentVersion: agent.version,
    agentAction: agent.action,
    taskId: task.taskId,
    taskVersion: task.version,
    taskAction: task.action,
  };
}
