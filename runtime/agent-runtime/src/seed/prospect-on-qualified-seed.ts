/**
 * Idempotent seed of the EVENT task `prospect-on-qualified` (tanda 15) on the existing
 * Prospector agent: when a person qualifies a fair-level signal in Twenty
 * (`commercialSignal.status -> QUALIFIED`), the runtime emits `signal.qualified`
 * (src/signals/qualified.ts) and this task runs the Prospector's targeted scout of THAT fair,
 * without waiting for the daily/weekly runs.
 *
 * Run input = default input + mapped event data + the envelope under `event`:
 *   { mode: "scout", max_events: 1, event_url, event_name, signal_id, event: {...} }
 * `mode: "scout"` is required because the envelope key `event` would otherwise select the direct
 * mode (`isScoutInput`); `ScoutInput` ignores the extra keys (`signal_id`, `event`). The scout
 * input shape and `isScoutInput` are unchanged.
 *
 * Every run it creates writes the audit row `prospect.on_qualified` (actor system, method EVENT,
 * subject the signal, payload with `signal_id` and `run_id`).
 *
 * Needs the Prospector agent (seedProspector runs first); the agent and its versions are not
 * touched here. Same upsert rules as the other seeds: a second run changes nothing.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { SIGNAL_QUALIFIED_EVENT } from '../signals/qualified.js';
import { PROSPECTOR_AGENT_NAME, upsertTask, type TaskSpec } from './prospector-seed.js';

export const PROSPECT_ON_QUALIFIED_TASK_NAME = 'prospect-on-qualified';
export const PROSPECT_ON_QUALIFIED_AUDIT_ACTION = 'prospect.on_qualified';

export function desiredProspectOnQualifiedTask(): TaskSpec {
  return {
    description:
      'Cuando un comercial califica en Twenty una señal de feria (estado QUALIFIED), el Prospector explora esa feria concreta (modo scout dirigido, una feria) y registra empresa, señal, research e hipótesis (PROPOSED) de los expositores relevantes. Una vez por señal: recalificarla antes de 24 h no la relanza.',
    defaultInput: { mode: 'scout', max_events: 1 },
    schedule: {
      type: 'EVENT',
      event_type: SIGNAL_QUALIFIED_EVENT,
      input_from_event: { event_url: 'event_url', event_name: 'name', event_date: 'event_date', signal_id: 'signal_id' },
      audit: { action: PROSPECT_ON_QUALIFIED_AUDIT_ACTION, subject_type: 'commercial_signal', subject_path: 'signal_id' },
    },
    timezone: 'Europe/Madrid',
    enabled: true,
    priority: 0,
    // One fair at a time: a scout run is long (time budget 20 min) and writes to Twenty.
    maxConcurrency: 1,
    retryPolicy: { max_attempts: 1, backoff_ms: 0 },
    timeoutMs: 1_800_000,
  };
}

export interface ProspectOnQualifiedSeedResult {
  taskId: string | null;
  taskVersion: number | null;
  taskAction: 'created' | 'updated' | 'unchanged' | 'skipped_no_agent';
}

export async function seedProspectOnQualified(
  db: Db,
  opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void },
): Promise<ProspectOnQualifiedSeedResult> {
  const log = opts.log ?? (() => {});
  const agent = await db.query.agents.findFirst({ where: and(eq(agents.tenantId, opts.tenantId), eq(agents.name, PROSPECTOR_AGENT_NAME)) });
  if (!agent || agent.status === 'ARCHIVED') {
    log(`task ${PROSPECT_ON_QUALIFIED_TASK_NAME}: skipped (agent ${PROSPECTOR_AGENT_NAME} missing or ARCHIVED; run seedProspector first)`);
    return { taskId: null, taskVersion: null, taskAction: 'skipped_no_agent' };
  }
  const task = await upsertTask(db, {
    tenantId: opts.tenantId,
    createdBy: opts.createdBy ?? 'seed',
    agentId: agent.id,
    name: PROSPECT_ON_QUALIFIED_TASK_NAME,
    want: desiredProspectOnQualifiedTask(),
  });
  log(`task ${PROSPECT_ON_QUALIFIED_TASK_NAME}: ${task.action} (id ${task.taskId}, version ${task.version})`);
  return { taskId: task.taskId, taskVersion: task.version, taskAction: task.action };
}
