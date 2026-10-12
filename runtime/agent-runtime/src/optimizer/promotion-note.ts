/**
 * The alert a GATE_PASS run leaves in Twenty: "Propuesta de promoción — <skill> v<N>". Since
 * tanda 19 it is a native Task (TODO, due in 3 days) instead of a note. It is a proposal for a
 * human, never an activation: it says what the candidate attacks, what the experiment measured
 * and how to activate it (the activation endpoint re-checks the Release Gate). Written with the
 * runtime's TwentyClient (not the agents' tool executor). Idempotent: a task with the same title
 * is reused, never duplicated or edited. Nothing is deleted.
 */
import type { TwentyClient } from '../integrations/twenty/index.js';
import { createCrmTask, crmTaskTitle, dueInDays } from '../integrations/twenty/tasks.js';
import type { FailureCluster } from './core.js';

export interface PromotionNoteInput {
  tenantId: string;
  runId: string;
  runLabel: string;
  skillName: string;
  baseVersion: number;
  candidateVersion: number;
  experimentName: string;
  decision: string;
  mode: string;
  summary: string;
  /** Per phase: composite of baseline and candidate. */
  composite: Array<{ phase: string; baseline: number | null; candidate: number | null; delta: number | null }>;
  clusters: FailureCluster[];
  attackedClusters: string[];
  operations: Array<{ op: string; why?: string | undefined; clusters: string[] }>;
  cost: { optimizer_eur: number; experiment_eur: number; total_eur: number };
  /** Base URL of the runtime API for the commands (default http://127.0.0.1:4020). */
  apiUrl?: string;
}

export function promotionNoteTitle(skillName: string, version: number): string {
  return crmTaskTitle(`Propuesta de promoción — ${skillName} v${version}`);
}

const eur = (n: number) => `${n.toFixed(4).replace('.', ',')} €`;
const num = (n: number | null) => (n === null ? '—' : n.toFixed(3).replace('.', ','));

export function promotionNoteMarkdown(i: PromotionNoteInput): string {
  const api = (i.apiUrl ?? 'http://127.0.0.1:4020').replace(/\/$/, '');
  const attacked = i.clusters.filter((c) => i.attackedClusters.includes(c.id));
  const lines = [
    `El Skill Optimizer (${i.runLabel}) propone promocionar **${i.skillName} v${i.candidateVersion}** (DRAFT) frente a la v${i.baseVersion} activa. **No se ha activado nada**: la activación es una decisión humana.`,
    '',
    `## Release Gate: ${i.decision}${i.mode === 'form' ? ' (modo forma: re-validar cuando haya casos etiquetados)' : ''}`,
    '',
    `- Experimento: ${i.experimentName}. ${i.summary}`,
    ...i.composite.map((c) => `- ${c.phase}: composite v${i.baseVersion} ${num(c.baseline)} → v${i.candidateVersion} ${num(c.candidate)} (Δ ${c.delta === null ? '—' : (c.delta >= 0 ? '+' : '') + num(c.delta)})`),
    `- Coste: optimizador ${eur(i.cost.optimizer_eur)} + experimento ${eur(i.cost.experiment_eur)} = ${eur(i.cost.total_eur)}`,
    '',
    '## Patrones de fallo que ataca',
    '',
    ...attacked.map((c) => `- **${c.id} · ${c.title}** (${c.failureIds.length} fallo${c.failureIds.length === 1 ? '' : 's'}): ${c.pattern}`),
    '',
    '## Operaciones',
    '',
    ...i.operations.map((o, n) => `${n + 1}. \`${o.op}\` (${o.clusters.join(', ')}): ${o.why ?? ''}`),
    '',
    '## Cómo decidir',
    '',
    `- Revisa el experimento: \`GET ${api}/experiments/${i.experimentName}\` y el run: \`GET ${api}/optimizer/runs/${i.runId}\`.`,
    `- Activar (el Release Gate vuelve a comprobar el experimento): \`curl -s -X POST ${api}/skills/${i.skillName}/versions/${i.candidateVersion}/activate -H 'x-tenant-id: ${i.tenantId}'\``,
    `- Después, cierra el run: \`curl -s -X POST ${api}/optimizer/runs/${i.runId}/close -H 'x-tenant-id: ${i.tenantId}' -H 'content-type: application/json' -d '{"outcome":"PROMOTED","by":"<quién>"}'\` (o \`"DISCARDED"\` si no la activas).`,
    `- Rollback si empeora en producción: \`POST ${api}/skills/${i.skillName}/versions/${i.candidateVersion}/deprecate\`.`,
  ];
  return lines.join('\n');
}

/** Due date of the promotion proposal task: three days after the GATE_PASS. */
export const PROMOTION_TASK_DUE_DAYS = 3;

/**
 * Creates the promotion proposal as a Twenty TASK (tanda 19; before, a note): status TODO, due in
 * 3 days, no CRM target (the subject is a skill version). Idempotent per title for ever (one task
 * per candidate version, as the note was): an existing task with that title is returned as is.
 */
export async function upsertPromotionTask(
  twenty: TwentyClient,
  input: PromotionNoteInput,
  opts: { signal?: AbortSignal; now?: Date } = {},
): Promise<{ taskId: string; created: boolean; title: string; dueAt: string | null }> {
  const now = opts.now ?? new Date();
  const title = promotionNoteTitle(input.skillName, input.candidateVersion);
  const t = await createCrmTask(
    twenty,
    { title, body: promotionNoteMarkdown(input), dueAt: dueInDays(now, PROMOTION_TASK_DUE_DAYS), scope: 'ever' },
    { now, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  return { taskId: t.taskId, created: t.created, title: t.title, dueAt: t.dueAt };
}
