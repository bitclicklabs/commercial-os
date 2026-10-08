/**
 * Skill Optimizer (MVP-3, LLD v0.1 section 18), pure part: run lifecycle, the failure and
 * cluster shapes, the two prompts (clustering and candidate proposal) and the validation of
 * what the model answers. No I/O, so the unit tests pin every rule with a scripted provider.
 *
 * The optimizer automates the manual skill cycle (docs/ciclo-mejora-skills.md):
 *   failures in production -> patterns (clusters) -> bounded operations (edit-ops, DRAFT)
 *   -> experiment against the ACTIVE version -> Release Gate -> HUMAN decision.
 * It never activates a version: the human does, through the activation endpoint, which
 * re-checks the gate.
 */
import { z } from 'zod';
import { parseWith } from '../agents/prospector-core.js';
import { UNTRUSTED_SYSTEM_RULE, wrapUntrusted } from '../agents/untrusted.js';
import type { OptimizationRunStatus } from '../db/schema.js';
import { defaultModelRouter, DEFAULT_MODEL_ROUTES } from '../providers/model-router.js';
import { applyEditOperations, EditOperationError, parseEditOperations, type EditOperation, type EditResult } from '../skills/edit-ops.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** States the pipeline moves through while a run is open (one open run per skill). */
export const OPEN_STATUSES: readonly OptimizationRunStatus[] = ['PENDING', 'HARVESTING', 'CLUSTERED', 'CANDIDATE_CREATED', 'EXPERIMENT_RUNNING'];
/** Waiting for the human: the gate decided, nobody has closed the run yet. */
export const AWAITING_HUMAN_STATUSES: readonly OptimizationRunStatus[] = ['GATE_PASS', 'GATE_FAIL'];
export const TERMINAL_STATUSES: readonly OptimizationRunStatus[] = ['BLOCKED_NO_DATA', 'ERROR', 'PROMOTED', 'DISCARDED'];

/** Valid transitions. ERROR is reachable from every open state (the pipeline broke). */
export const TRANSITIONS: Readonly<Record<OptimizationRunStatus, readonly OptimizationRunStatus[]>> = {
  PENDING: ['HARVESTING', 'ERROR'],
  HARVESTING: ['CLUSTERED', 'BLOCKED_NO_DATA', 'ERROR'],
  CLUSTERED: ['CANDIDATE_CREATED', 'ERROR'],
  CANDIDATE_CREATED: ['EXPERIMENT_RUNNING', 'BLOCKED_NO_DATA', 'ERROR'],
  EXPERIMENT_RUNNING: ['GATE_PASS', 'GATE_FAIL', 'BLOCKED_NO_DATA', 'ERROR'],
  GATE_PASS: ['PROMOTED', 'DISCARDED'],
  GATE_FAIL: ['DISCARDED'],
  BLOCKED_NO_DATA: [],
  ERROR: [],
  PROMOTED: [],
  DISCARDED: [],
};

export function canTransition(from: OptimizationRunStatus, to: OptimizationRunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States from which `to` is reachable (the WHERE of the guarded UPDATE). */
export function sourcesOf(to: OptimizationRunStatus): OptimizationRunStatus[] {
  return (Object.keys(TRANSITIONS) as OptimizationRunStatus[]).filter((from) => TRANSITIONS[from].includes(to));
}

/** Short id of a run in the P5 ledger (`used_by.experiment`) and in texts: `OPT-1a2b3c4d`. */
export function runLabel(runId: string): string {
  return `OPT-${runId.replace(/-/g, '').slice(0, 8)}`;
}

/** Skills the optimizer can work on: those with an experiment runner, and the dataset domain of each. */
export const OPTIMIZABLE_SKILLS: Readonly<Record<string, { domain: string; defaultDataset: string }>> = {
  'prospector-event-exhibitors': { domain: 'prospeccion', defaultDataset: 'prospeccion-v1' },
};

export interface OptimizerConfig {
  /** Dataset to re-harvest (a new version of it is built; burned cases stay burned). */
  datasetName: string;
  domain: string;
  /** Experiment budget (executor + judge), EUR. */
  experimentBudgetEur: number;
  /** Budget of the optimizer's own calls (clustering + proposal), EUR. */
  llmBudgetEur: number;
  repeat: number;
  /** Minimum labelled, unburned VALIDATION cases to run the experiment (else BLOCKED_NO_DATA). */
  minLabeledValidation: number;
  /** Minimum failures to cluster (else BLOCKED_NO_DATA). */
  minFailures: number;
  /** Failures sent to the model (the most recent first; human verdicts before rules). */
  maxFailures: number;
  /** Production traces read for RULE hard failures (most recent first). */
  maxTraces: number;
  /** Model of the optimizer's calls (the executor model). */
  model: string;
  /** "Today" the agent sees in the experiment (YYYY-MM-DD), or null for the current date. */
  today: string | null;
}

export const DEFAULT_OPTIMIZER_CONFIG = {
  experimentBudgetEur: 0.3,
  llmBudgetEur: 0.05,
  repeat: 2,
  minLabeledValidation: 5,
  minFailures: 3,
  maxFailures: 40,
  maxTraces: 100,
  /** Code default of the `optimizer` role; the effective default is the router's (MODEL_ROUTE_OPTIMIZER). */
  model: DEFAULT_MODEL_ROUTES.optimizer.model,
  today: null,
} as const;

export function optimizerConfig(skillName: string, o: Partial<OptimizerConfig> = {}): OptimizerConfig {
  const skill = OPTIMIZABLE_SKILLS[skillName];
  if (!skill) throw new Error(`no hay optimizador para la skill "${skillName}" (soportadas: ${Object.keys(OPTIMIZABLE_SKILLS).join(', ')})`);
  const c: OptimizerConfig = {
    datasetName: o.datasetName ?? skill.defaultDataset,
    domain: skill.domain,
    experimentBudgetEur: o.experimentBudgetEur ?? DEFAULT_OPTIMIZER_CONFIG.experimentBudgetEur,
    llmBudgetEur: o.llmBudgetEur ?? DEFAULT_OPTIMIZER_CONFIG.llmBudgetEur,
    repeat: o.repeat ?? DEFAULT_OPTIMIZER_CONFIG.repeat,
    minLabeledValidation: o.minLabeledValidation ?? DEFAULT_OPTIMIZER_CONFIG.minLabeledValidation,
    minFailures: o.minFailures ?? DEFAULT_OPTIMIZER_CONFIG.minFailures,
    maxFailures: o.maxFailures ?? DEFAULT_OPTIMIZER_CONFIG.maxFailures,
    maxTraces: o.maxTraces ?? DEFAULT_OPTIMIZER_CONFIG.maxTraces,
    model: o.model ?? defaultModelRouter().resolve('optimizer').model,
    today: o.today ?? DEFAULT_OPTIMIZER_CONFIG.today,
  };
  if (!(c.experimentBudgetEur > 0 && c.experimentBudgetEur <= 5)) throw new Error('el presupuesto del experimento debe estar entre 0 y 5 €');
  if (!(c.llmBudgetEur > 0 && c.llmBudgetEur <= 1)) throw new Error('el presupuesto del optimizador debe estar entre 0 y 1 €');
  if (!Number.isInteger(c.repeat) || c.repeat < 1 || c.repeat > 5) throw new Error('repeat debe estar entre 1 y 5');
  if (!Number.isInteger(c.minLabeledValidation) || c.minLabeledValidation < 1) throw new Error('min_labeled_validation debe ser un entero ≥ 1');
  if (!Number.isInteger(c.minFailures) || c.minFailures < 1) throw new Error('min_failures debe ser un entero ≥ 1');
  if (c.today !== null && !/^\d{4}-\d{2}-\d{2}$/.test(c.today)) throw new Error('today debe ser AAAA-MM-DD');
  return c;
}

// ---------------------------------------------------------------------------
// Failures and clusters
// ---------------------------------------------------------------------------

export type FailureKind = 'human_discarded' | 'human_edited' | 'rule_hard_fail';

export interface FailureCase {
  /** F1, F2... in the order sent to the model. */
  id: string;
  kind: FailureKind;
  /** Entity of the case (`org:<folded name>`): what P5 burns as design material. */
  entityKey: string;
  exhibitor: { name: string; domain?: string; sector?: string; description?: string };
  event: { name: string; type?: string; date?: string; location?: string } | null;
  /** What the agent decided for the case (from the trace), when known. */
  output: { relevant: boolean | null; confidence: number | null; reason: string | null; hypothesis: Record<string, unknown> | null } | null;
  /** Human verdict: `edited_fields` with before/after (the commercial's correction). */
  editedFields?: Record<string, { before: unknown; after: unknown }>;
  /** Rule hard failure: evaluator key and what it found. */
  evaluator?: string;
  evaluatorDetails?: Record<string, unknown>;
  source: { traceId: string; executionId: string; evaluationId?: string; hypothesisId?: string; skillVersion: number; occurredAt: string };
}

export interface FailureCluster {
  id: string;
  title: string;
  /** What the failures have in common, citing them. */
  pattern: string;
  /** Which part of the skill causes it (or what it lacks). */
  skillGap: string;
  failureIds: string[];
}

const ClusterResponse = z.object({
  clusters: z
    .array(
      z.object({
        id: z.string().regex(/^C\d{1,2}$/, 'id de cluster: C1, C2…'),
        title: z.string().trim().min(3).max(160),
        pattern: z.string().trim().min(10).max(1200),
        skill_gap: z.string().trim().min(10).max(1200),
        failure_ids: z.array(z.string().regex(/^F\d{1,3}$/)).min(1),
      }),
    )
    .min(1)
    .max(8),
  unclustered: z.array(z.string()).optional(),
});

export const CLUSTER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          pattern: { type: 'string' },
          skill_gap: { type: 'string' },
          failure_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'pattern', 'skill_gap', 'failure_ids'],
      },
    },
    unclustered: { type: 'array', items: { type: 'string' } },
  },
  required: ['clusters'],
};

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates the clustering answer against the failures that were sent. */
export function parseClusters(text: string, failures: readonly FailureCase[]): Validated<FailureCluster[]> {
  const parsed = parseWith(ClusterResponse, text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const known = new Set(failures.map((f) => f.id));
  const seenClusters = new Set<string>();
  const owner = new Map<string, string>();
  const problems: string[] = [];
  for (const c of parsed.value.clusters) {
    if (seenClusters.has(c.id)) problems.push(`cluster repetido ${c.id}`);
    seenClusters.add(c.id);
    for (const f of c.failure_ids) {
      if (!known.has(f)) problems.push(`${c.id}: fallo desconocido ${f}`);
      else if (owner.has(f) && owner.get(f) !== c.id) problems.push(`${f} está en ${owner.get(f)} y en ${c.id} (cada fallo va en un cluster como mucho)`);
      else owner.set(f, c.id);
    }
  }
  if (problems.length > 0) return { ok: false, error: problems.slice(0, 8).join('; ') };
  return {
    ok: true,
    value: parsed.value.clusters.map((c) => ({ id: c.id, title: c.title, pattern: c.pattern, skillGap: c.skill_gap, failureIds: [...new Set(c.failure_ids)] })),
  };
}

const KIND_LABEL: Record<FailureKind, string> = {
  human_discarded: 'el comercial DESCARTÓ la hipótesis',
  human_edited: 'el comercial EDITÓ la hipótesis antes de validarla',
  rule_hard_fail: 'un evaluador duro (RULE) falló',
};

/** The failure as the model sees it (all of it is untrusted data: it comes from the web and the CRM). */
export function failureForPrompt(f: FailureCase): Record<string, unknown> {
  return {
    id: f.id,
    tipo: KIND_LABEL[f.kind],
    evento: f.event?.name ?? null,
    expositor: f.exhibitor,
    decision_del_agente: f.output,
    ...(f.editedFields && Object.keys(f.editedFields).length > 0 ? { correccion_del_comercial: f.editedFields } : {}),
    ...(f.evaluator ? { evaluador: f.evaluator, hallazgo: f.evaluatorDetails ?? {} } : {}),
  };
}

export const CLUSTER_SYSTEM_PROMPT = `Eres el analista del optimizador de skills de PubliEXPE (expertos en merchandising y regalo promocional). Una skill es el texto de instrucciones que sigue un agente comercial. Recibes fallos reales de producción de UNA skill: decisiones que el comercial descartó o tuvo que editar, o que un evaluador automático duro rechazó.

Tu tarea: agrupar los fallos por PATRÓN (la causa común), no por empresa ni por feria.
- Un cluster necesita al menos dos fallos salvo que un fallo sea grave y claramente distinto.
- Cada fallo va como mucho en un cluster. Los que no encajen van en "unclustered".
- "pattern" describe lo que tienen en común citando los ids (F1, F3…) y los campos concretos.
- "skill_gap" dice qué parte de la skill lo provoca o qué le falta, citando su texto si puedes.
- Como mucho 8 clusters, ordenados de más a menos fallos. Ids C1, C2…
- No inventes fallos ni ids. Si una corrección del comercial no tiene patrón, déjala fuera.

${UNTRUSTED_SYSTEM_RULE}

Responde SOLO con JSON: {"clusters":[{"id":"C1","title":"…","pattern":"…","skill_gap":"…","failure_ids":["F1","F2"]}],"unclustered":["F7"]}`;

export function clusterUserMessage(skillName: string, skillText: string, failures: readonly FailureCase[]): string {
  return [
    `Skill: ${skillName}. Texto de la versión activa (confiable, es nuestro):`,
    '```',
    skillText,
    '```',
    '',
    `Fallos de producción (${failures.length}):`,
    wrapUntrusted(JSON.stringify({ fallos: failures.map(failureForPrompt) }, null, 1), { origin: 'trazas de producción y veredictos del CRM' }),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Candidate proposal (edit-ops)
// ---------------------------------------------------------------------------

export const MAX_OPERATIONS = 5;

const ProposalOp = z.object({
  op: z.enum(['ADD', 'REMOVE', 'REPLACE', 'MOVE', 'REORDER']),
  anchor: z.string().optional(),
  position: z.enum(['after', 'before']).optional(),
  find: z.string().optional(),
  text: z.string().optional(),
  order: z.array(z.string()).optional(),
  why: z.string().trim().min(10).max(1000),
  clusters: z.array(z.string()).min(1),
});

const ProposalResponse = z.object({
  summary: z.string().trim().min(10).max(1500),
  operations: z.array(ProposalOp).min(1).max(MAX_OPERATIONS),
});

export const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['ADD', 'REMOVE', 'REPLACE', 'MOVE', 'REORDER'] },
          anchor: { type: 'string' },
          position: { type: 'string', enum: ['after', 'before'] },
          find: { type: 'string' },
          text: { type: 'string' },
          order: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
          clusters: { type: 'array', items: { type: 'string' } },
        },
        required: ['op', 'why', 'clusters'],
      },
    },
  },
  required: ['summary', 'operations'],
};

export interface ProposedOperation {
  operation: EditOperation;
  clusters: string[];
}

export interface CandidateProposal {
  summary: string;
  operations: ProposedOperation[];
  edit: EditResult;
}

export type ProposalFailure = { kind: 'invalid' | 'caps'; error: string };

/** Ceiling messages of applyEditOperations: the edit is too large (retry being more conservative). */
export function isCapsError(message: string): boolean {
  return /del texto base \(máximo/.test(message);
}

/**
 * Validates a proposal: shape, every operation citing existing clusters, edit-ops that apply
 * on the base text within the 35 % / 50 % ceilings, the untrusted-content rule kept, and a
 * real change.
 */
export function parseProposal(text: string, baseText: string, clusters: readonly FailureCluster[], caps: { maxRemovedRatio?: number; maxAddedRatio?: number } = {}): { ok: true; value: CandidateProposal } | ({ ok: false } & ProposalFailure) {
  const parsed = parseWith(ProposalResponse, text);
  if (!parsed.ok) return { ok: false, kind: 'invalid', error: parsed.error };
  const ids = new Set(clusters.map((c) => c.id));
  const unknown = parsed.value.operations.flatMap((o, i) => o.clusters.filter((c) => !ids.has(c)).map((c) => `operación ${i + 1}: cluster desconocido ${c}`));
  if (unknown.length > 0) return { ok: false, kind: 'invalid', error: unknown.join('; ') };
  let operations: EditOperation[];
  try {
    operations = parseEditOperations(parsed.value.operations.map(({ clusters: _c, ...op }) => op));
  } catch (err) {
    return { ok: false, kind: 'invalid', error: err instanceof Error ? err.message : String(err) };
  }
  let edit: EditResult;
  try {
    edit = applyEditOperations(baseText, operations, caps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: err instanceof EditOperationError && isCapsError(message) ? 'caps' : 'invalid', error: message };
  }
  if (edit.text === baseText) return { ok: false, kind: 'invalid', error: 'las operaciones no cambian el texto' };
  if (baseText.includes(UNTRUSTED_SYSTEM_RULE) && !edit.text.includes(UNTRUSTED_SYSTEM_RULE)) {
    return { ok: false, kind: 'invalid', error: 'las operaciones tocan la regla de seguridad de contenido web (## Seguridad: contenido web): debe quedar intacta' };
  }
  return {
    ok: true,
    value: {
      summary: parsed.value.summary,
      operations: operations.map((operation, i) => ({ operation, clusters: [...new Set(parsed.value.operations[i]!.clusters)] })),
      edit,
    },
  };
}

export const PROPOSAL_SYSTEM_PROMPT = `Eres el optimizador de skills de PubliEXPE (expertos en merchandising y regalo promocional). Propones una versión candidata de una skill como una lista CORTA de operaciones de edición acotadas sobre el texto de la versión activa. Nunca reescribes la skill.

Operaciones (cada ancla o fragmento debe aparecer EXACTAMENTE UNA VEZ en el texto, copiado literalmente):
- {"op":"ADD","anchor":"<texto de una línea existente>","position":"after"|"before","text":"<líneas nuevas>"}
- {"op":"REMOVE","find":"<fragmento exacto>"}
- {"op":"REPLACE","find":"<fragmento exacto>","text":"<texto nuevo>"}
- {"op":"MOVE","find":"<líneas completas>","anchor":"<texto de la línea tras la que van>"}
- {"op":"REORDER","order":["<título de cada sección ## en el nuevo orden>"]}

Reglas:
- Como mucho ${MAX_OPERATIONS} operaciones; cambia lo mínimo que corrige cada patrón.
- Topes: las operaciones no pueden borrar o sustituir más del 35 % del texto base ni añadir más del 50 %.
- Cada operación lleva "why" (qué patrón corrige y con qué fallos, F1…) y "clusters" (ids C1… que ataca).
- No toques la sección "## Seguridad: contenido web": debe quedar intacta.
- No añadas reglas que el texto ya tiene; no contradigas el resto de la skill.
- Escribe en el mismo idioma y tono que la skill.

Responde SOLO con JSON: {"summary":"qué cambia y por qué, en 2-4 frases","operations":[{"op":"REPLACE","find":"…","text":"…","why":"…","clusters":["C1"]}]}`;

export function proposalUserMessage(skillName: string, baseVersion: number, skillText: string, clusters: readonly FailureCluster[]): string {
  return [
    `Skill: ${skillName}, versión activa v${baseVersion}. Texto exacto sobre el que aplicas las operaciones:`,
    '```',
    skillText,
    '```',
    '',
    'Patrones de fallo a corregir (resumidos a partir de datos de producción):',
    wrapUntrusted(JSON.stringify({ clusters: clusters.map((c) => ({ id: c.id, title: c.title, pattern: c.pattern, skill_gap: c.skillGap, fallos: c.failureIds.length })) }, null, 1), {
      origin: 'clusters de fallos de producción',
    }),
  ].join('\n');
}

export function proposalRetryMessage(failure: ProposalFailure): string {
  return failure.kind === 'caps'
    ? `La propuesta anterior se rechazó por los topes de edición: ${failure.error}. Sé MÁS CONSERVADOR: menos operaciones, fragmentos más cortos, ataca solo los clusters con más fallos. Responde de nuevo con el JSON completo.`
    : `La propuesta anterior no es válida: ${failure.error}. Corrígela (las anclas y fragmentos deben copiarse literalmente y aparecer una sola vez) y responde de nuevo con el JSON completo.`;
}

/** `change_reason` of the candidate version (max 2.000 characters): run, clusters attacked and summary. */
export function changeReason(label: string, clusters: readonly FailureCluster[], proposal: CandidateProposal): string {
  const attacked = new Set(proposal.operations.flatMap((o) => o.clusters));
  const list = clusters.filter((c) => attacked.has(c.id)).map((c) => `${c.id} «${c.title}» (${c.failureIds.length} fallo${c.failureIds.length === 1 ? '' : 's'})`);
  const text = `Skill Optimizer ${label}: ataca ${list.join('; ')}. ${proposal.summary}`;
  return text.length <= 2000 ? text : `${text.slice(0, 1997)}…`;
}

// ---------------------------------------------------------------------------
// Data check (P5)
// ---------------------------------------------------------------------------

export interface DataCheck {
  ok: boolean;
  /** Labelled, unburned VALIDATION cases, without the entities this run uses as design. */
  freshLabeled: number;
  required: number;
  missing: number;
  /** VALIDATION labelled cases removed because they are design material of this run. */
  designOverlap: number;
  burnedLabeled: number;
  message: string;
}

export function dataCheck(
  cases: ReadonlyArray<{ split: string; entityKey: string; expected: Record<string, unknown>; usedBy: readonly unknown[] }>,
  designEntities: ReadonlySet<string>,
  required: number,
  datasetLabel: string,
): DataCheck {
  const isLabeled = (c: (typeof cases)[number]) => c.expected.kind !== undefined && c.expected.kind !== 'unlabeled';
  const unburned = cases.filter((c) => c.split === 'VALIDATION' && isLabeled(c) && c.usedBy.length === 0);
  const fresh = unburned.filter((c) => !designEntities.has(c.entityKey));
  // A burned case is moved to TRAIN when the dataset is (re)built: count them in any split.
  const burned = cases.filter((c) => isLabeled(c) && c.usedBy.length > 0).length;
  const missing = Math.max(0, required - fresh.length);
  const message =
    missing === 0
      ? `${datasetLabel}: ${fresh.length} casos etiquetados frescos en VALIDATION (mínimo ${required})`
      : `${datasetLabel}: hay ${fresh.length} casos etiquetados frescos en VALIDATION y hacen falta ${required}: faltan ${missing}. ` +
        `${burned} casos etiquetados del dataset ya están quemados por experimentos anteriores (P5: no vuelven a validar) y ${unburned.length - fresh.length} de VALIDATION son material de diseño de este run. ` +
        'Hacen falta más veredictos humanos (aceptar, editar o descartar hipótesis en Twenty) sobre ejecuciones nuevas.';
  return { ok: missing === 0, freshLabeled: fresh.length, required, missing, designOverlap: unburned.length - fresh.length, burnedLabeled: burned, message };
}
