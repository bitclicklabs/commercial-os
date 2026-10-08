/**
 * The note a GATE_PASS run leaves in Twenty: "Propuesta de promoción — <skill> v<N>". It is a
 * proposal for a human, never an activation: it says what the candidate attacks, what the
 * experiment measured and how to activate it (the activation endpoint re-checks the Release
 * Gate). Written with the runtime's TwentyClient (not the agents' tool executor). Idempotent:
 * a note with the same title is reused, never duplicated or edited. Nothing is deleted.
 */
import { filterValue, TWENTY_OBJECTS, type TwentyClient, type TwentyNote } from '../integrations/twenty/index.js';
import { noteTitle } from '../tools/twenty/note-tools.js';
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
  return noteTitle(`Propuesta de promoción — ${skillName} v${version}`);
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

/** Creates the note, or returns the existing one with the same title. */
export async function upsertPromotionNote(twenty: TwentyClient, input: PromotionNoteInput, opts: { signal?: AbortSignal } = {}): Promise<{ noteId: string; created: boolean; title: string }> {
  const signal = opts.signal ? { signal: opts.signal } : {};
  const title = promotionNoteTitle(input.skillName, input.candidateVersion);
  const { records } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: `title[eq]:${filterValue(title)}`, limit: 5, ...signal });
  const existing = records.find((n) => noteTitle(n.title ?? '') === title);
  if (existing) return { noteId: existing.id, created: false, title };
  const note = await twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown: promotionNoteMarkdown(input) } }, signal);
  return { noteId: note.id, created: true, title };
}
