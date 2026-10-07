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
 * The agent only writes internal Notes in Twenty: its tool policy has no mail tool
 * (none exists) and its risk ceiling is LOW_WRITE.
 */
import type { Db } from '../db/client.js';
import { EMAIL_DRAFTER_TOOLS } from '../agents/email-drafter.js';
import { EMAIL_DRAFTER_SKILL_ID, EMAIL_DRAFTER_SKILL_VERSION, EMAIL_DRAFTER_SYSTEM_PROMPT } from '../agents/email-drafter-prompt.js';
import { DEFAULT_COMPANY_DESCRIPTOR, DEFAULT_SENDER, WORD_RANGE } from '../agents/email-draft.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import type { SkillRef } from '../db/schema.js';
import { upsertAgent, upsertTask, type AgentVersionSpec, type TaskSpec } from './prospector-seed.js';

export const EMAIL_DRAFTER_AGENT_NAME = 'EmailDrafter';
export const EMAIL_DRAFT_TASK_NAME = 'draft-email-on-validated';

export function desiredEmailDrafterVersion(): AgentVersionSpec {
  return {
    model: 'gemini-flash-latest',
    modelProvider: 'gemini',
    systemPrompt: EMAIL_DRAFTER_SYSTEM_PROMPT,
    configuration: {
      implementation: 'email_drafter',
      stage: 'EMAIL_DRAFTER',
      tool_policy: {
        allow: [...EMAIL_DRAFTER_TOOLS],
        max_risk_level: 'LOW_WRITE',
        max_calls_per_execution: 6,
        max_calls_per_tool: { create_note: 1 },
      },
      sender: {
        name: DEFAULT_SENDER.name,
        company: DEFAULT_SENDER.company,
        email: DEFAULT_SENDER.email,
        alt_email: DEFAULT_SENDER.altEmail,
        signature_lines: [...DEFAULT_SENDER.signatureLines],
      },
      unsubscribe_email: DEFAULT_SENDER.unsubscribeEmail,
      company_descriptor: DEFAULT_COMPANY_DESCRIPTOR,
      word_range: { min: WORD_RANGE.min, max: WORD_RANGE.max },
      usd_to_eur: DEFAULT_USD_TO_EUR,
      max_output_tokens: 4096,
      model_options: { thinking_level: 'low' },
    },
    skillRefs: [{ skill_id: EMAIL_DRAFTER_SKILL_ID, version: EMAIL_DRAFTER_SKILL_VERSION }] as SkillRef[],
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
    timeoutMs: 120_000,
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
