/**
 * EXACT evaluators: a field of the case output must equal an expected value (from a
 * dataset annotated by the commercial team, LLD §11.4). The expectations are part of the
 * definition, so a different expectation set is a different content_hash.
 */
import type { CaseEvaluator, CaseOutput, Dimension } from './types.js';

export type ExactField = 'relevant' | 'writable' | 'status';

export interface ExactEvaluatorOptions {
  id: string;
  version: number;
  dimension: Dimension;
  field: ExactField;
  /** Expected value per exhibitor name (cases without an expectation are not applicable). */
  expected: Record<string, CaseOutput[ExactField]>;
  hard?: boolean;
  description?: string;
}

export function makeExactEvaluator(o: ExactEvaluatorOptions): CaseEvaluator {
  const expected = { ...o.expected };
  return {
    id: o.id,
    version: o.version,
    type: 'EXACT',
    dimension: o.dimension,
    hard: o.hard ?? false,
    description: o.description ?? `«${o.field}» coincide con el valor esperado del dataset.`,
    definition: { field: o.field, expected },
    evaluate(input, output) {
      if (!Object.hasOwn(expected, input.exhibitor.name)) return null;
      const want = expected[input.exhibitor.name];
      const got = output[o.field];
      return { dimension: o.dimension, score: got === want ? 1 : 0, pass: got === want, details: { field: o.field, expected: want, actual: got } };
    },
  };
}
