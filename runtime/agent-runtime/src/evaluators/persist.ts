/**
 * Persistence of automatic evaluations in the existing `evaluations` table (no migration).
 *
 * One row per (subject, evaluator) with at least one applicable case, one COMPOSITE row per
 * subject and, when a group pools several subjects (a version of a comparison), one
 * COMPOSITE row for the group (`details.scope = 'group'`).
 *
 * | column              | value                                                                 |
 * |---------------------|-----------------------------------------------------------------------|
 * | kind                | RULE, EXACT, LLM_JUDGE or COMPOSITE                                   |
 * | evaluator_id        | `<id>@<version>` (content_hash in details.evaluator)                  |
 * | subject_type / _id  | `comparison_case` / `execution_output` and the subject id             |
 * | feedback            | PASS / FAIL (rules, composite); SCORED (judges: a score, no pass)     |
 * | score               | mean over applicable cases (composite: the composite score; 0 if none)|
 * | details             | evaluator, output_hash, aggregate, per-case breakdown, subject meta   |
 * | source              | `auto`                                                                |
 * | idempotency_key     | `auto:<evaluator>:<evaluator hash>:<subject>:<output hash>`           |
 *
 * Idempotent: the unique (tenant_id, idempotency_key) index + ON CONFLICT DO NOTHING. A
 * re-run on the same output with the same evaluator version stores nothing new (and the
 * CLI reuses the stored judge notes instead of paying for the judge again).
 *
 * Never emits `evaluation.recorded`: that event is for HUMAN verdicts and triggers the
 * email drafter.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { evaluations } from '../db/schema.js';
import { evaluatorKey, sha256, type EvaluatorOutcome } from './types.js';
import type { CaseResult, JudgeCache, PipelineReport } from './pipeline.js';
import type { CompositeResult } from './composite.js';

export const AUTO_SOURCE = 'auto';
export const DEFAULT_EXPERIMENTS_TENANT = 'experiments';

type NewEvaluation = typeof evaluations.$inferInsert;

export function idempotencyKey(evaluator: string, evaluatorHash: string, subjectType: string, subjectId: string, outputHash: string): string {
  const key = `auto:${evaluator}:${evaluatorHash.slice(0, 12)}:${subjectType}:${subjectId}:${outputHash.slice(0, 16)}`;
  return key.length <= 400 ? key : `auto:${evaluator}:${sha256(key).slice(0, 40)}`;
}

function caseBreakdown(cases: Map<string, CaseResult>) {
  return [...cases].map(([id, r]) =>
    'outcome' in r ? { case: id, score: r.outcome.score, ...(r.outcome.pass !== undefined ? { pass: r.outcome.pass } : {}), details: r.outcome.details } : 'error' in r ? { case: id, error: r.error } : { case: id, applicable: false },
  );
}

function compositeDetails(c: CompositeResult) {
  return {
    verdict: c.verdict,
    hard_failures: c.hard_failures,
    threshold_failures: c.threshold_failures,
    thresholds_not_evaluated: c.thresholds_not_evaluated,
    dimensions: c.dimensions,
    missing: c.missing,
    unweighted: c.unweighted,
  };
}

/** The rows the report would store (pure; tests check them without a database). */
export function evaluationRows(report: PipelineReport, tenantId: string, occurredAt = new Date()): NewEvaluation[] {
  const rows: NewEvaluation[] = [];
  const hashOf = new Map(report.evaluators.map((e) => [e.key, e.content_hash]));
  for (const s of report.subjects) {
    const subj = s.subject;
    const base = {
      tenantId,
      subjectType: subj.subjectType,
      subjectId: subj.subjectId,
      agentExecutionId: subj.agentExecutionId,
      taskRunId: subj.taskRunId,
      source: AUTO_SOURCE,
      occurredAt,
    };
    // A judge with cases left unscored (error, budget) is not stored, nor is the composite that
    // depends on it: a later run completes them under the same idempotency keys.
    const incomplete = s.evaluators.some((e) => e.type === 'LLM_JUDGE' && e.aggregate.errors > 0);
    for (const e of s.evaluators) {
      if (e.aggregate.applicable === 0) continue;
      if (e.type === 'LLM_JUDGE' && e.aggregate.errors > 0) continue;
      rows.push({
        ...base,
        kind: e.type,
        evaluatorId: e.key,
        feedback: e.type === 'LLM_JUDGE' ? 'SCORED' : e.aggregate.failures > 0 ? 'FAIL' : 'PASS',
        score: e.aggregate.score ?? 0,
        details: {
          scope: 'subject',
          evaluator: { id: e.id, version: e.version, type: e.type, dimension: e.dimension, hard: e.hard, content_hash: e.contentHash },
          output_hash: subj.outputHash,
          aggregate: e.aggregate,
          cases: caseBreakdown(e.cases),
          subject: subj.meta,
          executor_model: subj.executorModel,
        },
        idempotencyKey: idempotencyKey(e.key, e.contentHash, subj.subjectType, subj.subjectId, subj.outputHash),
        evaluatedBy: e.type === 'LLM_JUDGE' ? String([...e.cases.values()].find((c): c is { outcome: EvaluatorOutcome } => 'outcome' in c)?.outcome.details.judge_model ?? 'judge') : 'evaluators',
      });
    }
    if (incomplete) continue;
    rows.push({
      ...base,
      kind: 'COMPOSITE',
      evaluatorId: report.composite.key,
      feedback: s.composite.verdict,
      score: s.composite.score ?? 0,
      details: {
        scope: 'subject',
        evaluator: { key: report.composite.key, content_hash: report.composite.content_hash, weights: report.composite.weights, thresholds: report.composite.thresholds },
        output_hash: subj.outputHash,
        score: s.composite.score,
        ...compositeDetails(s.composite),
        components: s.evaluators.map((e) => ({ evaluator: e.key, content_hash: hashOf.get(e.key) ?? e.contentHash, ...e.aggregate })),
        subject: subj.meta,
      },
      idempotencyKey: idempotencyKey(report.composite.key, report.composite.content_hash, subj.subjectType, subj.subjectId, subj.outputHash),
      evaluatedBy: 'evaluators',
    });
  }
  for (const g of report.groups) {
    if (g.subjects.length < 2) continue;
    if (g.aggregates.some((a) => a.type === 'LLM_JUDGE' && a.errors > 0)) continue;
    const members = report.subjects.filter((s) => g.subjects.includes(s.subject.subjectId));
    const first = members[0]!.subject;
    const outputHash = sha256(members.map((m) => m.subject.outputHash).sort().join(','));
    const skill = String(first.meta.skill ?? 'grupo');
    const subjectId = `${skill}@${g.group}:${outputHash.slice(0, 16)}`;
    rows.push({
      tenantId,
      kind: 'COMPOSITE',
      evaluatorId: report.composite.key,
      subjectType: first.subjectType,
      subjectId,
      agentExecutionId: null,
      taskRunId: null,
      feedback: g.composite.verdict,
      score: g.composite.score ?? 0,
      details: {
        scope: 'group',
        group: g.group,
        members: g.subjects,
        cases: g.cases,
        evaluator: { key: report.composite.key, content_hash: report.composite.content_hash, weights: report.composite.weights, thresholds: report.composite.thresholds },
        output_hash: outputHash,
        score: g.composite.score,
        ...compositeDetails(g.composite),
        components: g.aggregates,
        judge_cost_eur: report.judge.calls.filter((c) => c.group === g.group).reduce((n, c) => n + c.costEur, 0),
        comparison: first.meta.comparison ?? null,
      },
      idempotencyKey: idempotencyKey(report.composite.key, report.composite.content_hash, first.subjectType, subjectId, outputHash),
      source: AUTO_SOURCE,
      evaluatedBy: 'evaluators',
      occurredAt,
    });
  }
  return rows;
}

export interface PersistResult {
  inserted: number;
  existing: number;
  rows: number;
}

export async function persistEvaluations(db: Db, report: PipelineReport, tenantId: string): Promise<PersistResult> {
  const rows = evaluationRows(report, tenantId);
  if (rows.length === 0) return { inserted: 0, existing: 0, rows: 0 };
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const out = await db.insert(evaluations).values(chunk).onConflictDoNothing({ target: [evaluations.tenantId, evaluations.idempotencyKey] }).returning({ id: evaluations.id });
    inserted += out.length;
  }
  return { inserted, existing: rows.length - inserted, rows: rows.length };
}

/**
 * Judge notes already stored for these subjects (same judge version and hash, same output):
 * the CLI reuses them instead of calling the judge again.
 */
export async function loadJudgeCache(
  db: Db,
  tenantId: string,
  subjects: Array<{ subjectType: string; subjectId: string; outputHash: string }>,
  judges: Array<{ id: string; version: number; contentHash: string }>,
): Promise<JudgeCache> {
  const cache: JudgeCache = new Map();
  if (subjects.length === 0 || judges.length === 0) return cache;
  const keys = subjects.flatMap((s) => judges.map((j) => idempotencyKey(evaluatorKey(j), j.contentHash, s.subjectType, s.subjectId, s.outputHash)));
  const rows = await db
    .select({ subjectId: evaluations.subjectId, evaluatorId: evaluations.evaluatorId, details: evaluations.details })
    .from(evaluations)
    .where(and(eq(evaluations.tenantId, tenantId), eq(evaluations.kind, 'LLM_JUDGE'), inArray(evaluations.idempotencyKey, keys)));
  for (const r of rows) {
    const cases = (r.details.cases ?? []) as Array<{ case: string; score?: number; details?: Record<string, unknown> }>;
    const byCase = new Map<string, EvaluatorOutcome>();
    const dim = (r.details.evaluator as { dimension?: string } | undefined)?.dimension;
    for (const c of cases) if (typeof c.score === 'number' && c.details) byCase.set(c.case, { dimension: dim as EvaluatorOutcome['dimension'], score: c.score, details: { ...c.details, cached: true } });
    if (!cache.has(r.subjectId)) cache.set(r.subjectId, new Map());
    cache.get(r.subjectId)!.set(r.evaluatorId, byCase);
  }
  return cache;
}
