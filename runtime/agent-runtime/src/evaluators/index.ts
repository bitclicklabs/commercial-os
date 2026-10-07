/**
 * Evaluators registered as code (like the tools): `defaultEvaluatorRegistry()` is the
 * catalog the pipeline runs. See README, section "Evaluadores".
 */
import type { ModelProvider } from '../providers/model-provider.js';
import { CompositeEvaluator, type CompositeConfig } from './composite.js';
import { COMMERCIAL_RELEVANCE_RUBRIC, DEFAULT_JUDGE_MODEL, LlmJudgeEvaluator, NEXT_ACTION_QUALITY_RUBRIC } from './judge.js';
import { RULE_EVALUATORS } from './rules.js';
import { EvaluatorRegistry, type EvaluatorMeta } from './types.js';

export * from './types.js';
export * from './rules.js';
export * from './exact.js';
export * from './judge.js';
export * from './composite.js';
export * from './subjects.js';
export * from './pipeline.js';
export * from './persist.js';

export interface DefaultEvaluatorsOptions {
  /** Judge provider; without it there are no LLM_JUDGE evaluators. */
  judgeProvider?: ModelProvider;
  judgeModel?: string;
  judgeMaxItemsPerCall?: number;
  composite?: Partial<CompositeConfig>;
}

export function defaultEvaluators(o: DefaultEvaluatorsOptions = {}) {
  const judges = o.judgeProvider
    ? [NEXT_ACTION_QUALITY_RUBRIC, COMMERCIAL_RELEVANCE_RUBRIC].map(
        (rubric) =>
          new LlmJudgeEvaluator({
            provider: o.judgeProvider!,
            rubric,
            model: o.judgeModel ?? process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
            ...(o.judgeMaxItemsPerCall ? { maxItemsPerCall: o.judgeMaxItemsPerCall } : {}),
          }),
      )
    : [];
  const composite = new CompositeEvaluator(o.composite);
  const registry = new EvaluatorRegistry<EvaluatorMeta>();
  for (const e of [...RULE_EVALUATORS, ...judges, composite]) registry.register(e);
  return { rules: RULE_EVALUATORS, judges, composite, registry };
}
