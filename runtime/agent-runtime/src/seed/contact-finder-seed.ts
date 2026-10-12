/**
 * Idempotent seed of the ContactFinder agent and its MANUAL task `find-contact` (tanda 17).
 *
 * The task never fires by itself (schedule MANUAL): it is the target of the backfill
 * (`pnpm contacts:backfill`, `POST /contacts/backfill`), one TaskRun per VALIDATED hypothesis
 * still without a recipient. New validations do not need it: the EmailDrafter runs the same
 * contact step before drafting.
 *
 * Risk ceiling LOW_WRITE: it reads the web and Twenty, writes an EMPTY `emailTo` and one
 * Research per run. No mail tool exists in the registry.
 */
import type { Db } from '../db/client.js';
import { CONTACT_FINDER_AGENT_TOOLS, CONTACT_FINDER_IMPLEMENTATION } from '../agents/contact-finder-agent.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import { upsertAgent, upsertTask, type AgentVersionSpec, type TaskSpec } from './prospector-seed.js';

export const CONTACT_FINDER_AGENT_NAME = 'ContactFinder';
export const CONTACT_FINDER_TASK_NAME = 'find-contact';

export function desiredContactFinderVersion(): AgentVersionSpec {
  return {
    model: 'gemini-flash-latest',
    modelProvider: 'gemini',
    systemPrompt: '',
    configuration: {
      implementation: CONTACT_FINDER_IMPLEMENTATION,
      stage: 'CONTACT_FINDER',
      tool_policy: {
        allow: [...CONTACT_FINDER_AGENT_TOOLS],
        max_risk_level: 'LOW_WRITE',
        max_calls_per_execution: 8,
        max_calls_per_tool: { find_contact: 1, set_hypothesis_recipient: 1, create_research: 1 },
      },
      // LLM only to break real ties between equally ranked candidates (model role triage).
      contact_finder: { enabled: true, llm_triage: true, enrich: true },
      usd_to_eur: DEFAULT_USD_TO_EUR,
      max_output_tokens: 512,
      model_options: { thinking_level: 'low' },
    },
    skillRefs: [],
  };
}

export function desiredContactFinderTask(): TaskSpec {
  return {
    description:
      'Busca el destinatario de una hipótesis VALIDATED sin «Email to» en la web de la propia empresa (y, si está activado, en el proveedor de enriquecimiento), rellena «Email to» solo si está vacío y deja un Research «Contacto — <empresa>» con la fuente exacta. La lanza el backfill (pnpm contacts:backfill o POST /contacts/backfill); no envía nada.',
    defaultInput: {},
    schedule: { type: 'MANUAL' },
    timezone: 'Europe/Madrid',
    enabled: true,
    priority: 0,
    maxConcurrency: 2,
    retryPolicy: { max_attempts: 1, backoff_ms: 5_000 },
    timeoutMs: 120_000,
  };
}

export interface ContactFinderSeedResult {
  agentId: string;
  agentVersion: number;
  agentAction: 'created' | 'version_added' | 'unchanged';
  taskId: string;
  taskVersion: number;
  taskAction: 'created' | 'updated' | 'unchanged';
}

export async function seedContactFinder(db: Db, opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void }): Promise<ContactFinderSeedResult> {
  const log = opts.log ?? (() => {});
  const createdBy = opts.createdBy ?? 'seed';
  const agent = await upsertAgent(db, {
    tenantId: opts.tenantId,
    createdBy,
    name: CONTACT_FINDER_AGENT_NAME,
    description: 'Busca el contacto publicado por la empresa para las hipótesis validadas sin destinatario (nunca envía).',
    role: 'contact_finder',
    want: desiredContactFinderVersion(),
    log,
  });
  log(`agent ${CONTACT_FINDER_AGENT_NAME}: ${agent.action} (id ${agent.agentId}, version ${agent.version})`);
  const task = await upsertTask(db, { tenantId: opts.tenantId, createdBy, agentId: agent.agentId, name: CONTACT_FINDER_TASK_NAME, want: desiredContactFinderTask() });
  log(`task ${CONTACT_FINDER_TASK_NAME}: ${task.action} (id ${task.taskId}, version ${task.version})`);
  return { agentId: agent.agentId, agentVersion: agent.version, agentAction: agent.action, taskId: task.taskId, taskVersion: task.version, taskAction: task.action };
}
