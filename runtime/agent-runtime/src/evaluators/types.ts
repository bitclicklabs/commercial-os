/**
 * Evaluation Engine, automatic evaluators (LLD v0.1 §11.1-11.3, LLD v0.2 §5.5, MVP-2).
 *
 * "No es un botón que pregunta a otro LLM si la respuesta parece buena": each evaluator
 * is typed (EXACT | RULE | LLM_JUDGE | COMPOSITE), scores ONE dimension of the LLD,
 * is versioned (id + version + content_hash of its definition) and is registered as
 * code, like the tools. BUSINESS and HUMAN come from other paths (the HUMAN evaluator
 * is `src/evaluations/`).
 *
 * The unit an evaluator scores is a CASE: one decision of the Prospector for one
 * exhibitor (input = event + exhibitor, output = relevant/confidence/reason/hypothesis).
 * A SUBJECT is one run output (an execution, or one version x input x repetition of a
 * skill comparison) and groups its cases; the pipeline aggregates per subject.
 */
import { createHash } from 'node:crypto';

export const EVALUATOR_TYPES = ['EXACT', 'RULE', 'LLM_JUDGE', 'REFERENCE', 'BUSINESS', 'HUMAN', 'COMPOSITE'] as const;
export type EvaluatorType = (typeof EVALUATOR_TYPES)[number];

/** LLD v0.1 §11.2. */
export const DIMENSIONS = [
  'TASK_SUCCESS',
  'FACTUALITY',
  'SOURCE_QUALITY',
  'TOOL_CORRECTNESS',
  'CRM_CORRECTNESS',
  'POLICY_COMPLIANCE',
  'COMMERCIAL_RELEVANCE',
  'NEXT_ACTION_QUALITY',
  'COST',
  'LATENCY',
  'TOKEN_EFFICIENCY',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type DataLevel = 'name_only' | 'sector' | 'rich' | 'unknown';

export interface CaseHypothesis {
  need: string;
  why_now: string;
  quantity_min: number;
  quantity_max: number;
  budget_min_eur: number;
  budget_max_eur: number;
  recommended_products: string[];
  timing: string;
  differentiators: string[];
}

/** What the agent received for this case (all of it is untrusted external data). */
export interface CaseInput {
  event: { name: string; type?: string; date?: string; location?: string; source_url?: string };
  exhibitor: { name: string; domain?: string; sector?: string; description?: string };
  dataLevel: DataLevel;
}

/** What the agent produced for this case. */
export interface CaseOutput {
  status: string;
  relevant: boolean | null;
  confidence: number | null;
  reason: string | null;
  hypothesis: CaseHypothesis | null;
  writable: boolean;
  /** URLs the run WROTE for this case (signal/research/hypothesis evidence), when known (traces). */
  writtenUrls?: string[];
}

/** Sources the run really had: the SourceLedger snapshot plus the URLs given in the input. */
export interface KnownSources {
  /** Exact URLs (normalized): ledger visited + grounded, event.source_url. */
  urls: string[];
  /** Domains whose URLs count as known (exhibitor domain from the input or the CRM). */
  domains: string[];
}

export interface EvaluationContext {
  knownSources: KnownSources;
  /** Agent threshold to write to the CRM (configuration.min_confidence). */
  minConfidence: number;
  /**
   * Ground truth of the synthetic cases of this subject, by exhibitor name (src/synthetic/).
   * Lives in the context, never in the case input, so neither the agent nor the judge sees it;
   * only the `synth.*` evaluators read it.
   */
  synthetic?: Readonly<Record<string, SyntheticTruthRef>>;
}

/** What the `synth.*` evaluators need of a synthetic ground truth (src/synthetic/truth.ts). */
export interface SyntheticTruthRef {
  template: string;
  curriculum_level: number;
  checks: ReadonlyArray<{ id: string } & Record<string, unknown>>;
}

/** One evaluator's verdict on one case. `null` from `evaluate` = not applicable. */
export interface EvaluatorOutcome {
  dimension: Dimension;
  /** 0..1 */
  score: number;
  pass?: boolean;
  details: Record<string, unknown>;
}

export interface EvaluatorMeta {
  /** Stable id, e.g. `rule.need_has_quantities`. */
  readonly id: string;
  readonly version: number;
  readonly type: EvaluatorType;
  /** Dimension it scores; null for COMPOSITE (it combines dimensions). */
  readonly dimension: Dimension | null;
  /** Hard constraint: one failing case makes the composite FAIL whatever the score. */
  readonly hard: boolean;
  readonly description: string;
  /** Everything that changes the verdict (thresholds, regexes, rubric, model). Hashed into content_hash. */
  readonly definition: Record<string, unknown>;
}

export interface CaseEvaluator extends EvaluatorMeta {
  readonly dimension: Dimension;
  evaluate(caseInput: CaseInput, output: CaseOutput, context: EvaluationContext): EvaluatorOutcome | null | Promise<EvaluatorOutcome | null>;
}

/** Stable JSON (sorted keys) so the same definition/output always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value instanceof RegExp) return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function contentHashOf(meta: Pick<EvaluatorMeta, 'id' | 'version' | 'type' | 'dimension' | 'hard' | 'definition'>): string {
  return sha256(canonicalJson({ id: meta.id, version: meta.version, type: meta.type, dimension: meta.dimension, hard: meta.hard, definition: meta.definition }));
}

/** `evaluator_id` column value: id plus version (`rule.need_has_quantities@1`). */
export const evaluatorKey = (e: Pick<EvaluatorMeta, 'id' | 'version'>) => `${e.id}@${e.version}`;

/** Registry of code evaluators (like the tool registry): id+version unique, content_hash computed. */
export class EvaluatorRegistry<E extends EvaluatorMeta = EvaluatorMeta> {
  private readonly byKey = new Map<string, { evaluator: E; contentHash: string }>();

  register(e: E): this {
    const key = evaluatorKey(e);
    if (this.byKey.has(key)) throw new Error(`evaluador duplicado: ${key}`);
    this.byKey.set(key, { evaluator: e, contentHash: contentHashOf(e) });
    return this;
  }

  get(key: string): E | undefined {
    return this.byKey.get(key)?.evaluator;
  }

  contentHash(e: Pick<EvaluatorMeta, 'id' | 'version'>): string {
    const entry = this.byKey.get(evaluatorKey(e));
    if (!entry) throw new Error(`evaluador no registrado: ${evaluatorKey(e)}`);
    return entry.contentHash;
  }

  list(): E[] {
    return [...this.byKey.values()].map((x) => x.evaluator);
  }

  catalog(): Array<{ key: string; type: EvaluatorType; dimension: Dimension | null; hard: boolean; content_hash: string; description: string }> {
    return [...this.byKey.entries()].map(([key, { evaluator: e, contentHash }]) => ({
      key,
      type: e.type,
      dimension: e.dimension,
      hard: e.hard,
      content_hash: contentHash,
      description: e.description,
    }));
  }
}
