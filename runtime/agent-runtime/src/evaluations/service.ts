/**
 * Persistence of human evaluations (append-only, no DELETE).
 *
 * Dedupe, in one transaction serialised per subject (advisory lock):
 * - `idempotency_key` (unique per tenant): exact replays of the same delivery/request;
 * - window: the same (subject, feedback, target status) recorded less than
 *   `dedupeWindowMs` before `occurred_at` is not recorded again.
 */
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { evaluations, type Evaluation } from '../db/schema.js';
import { HUMAN_EVALUATOR_ID, scoreOf, type HumanFeedback } from './human-feedback.js';

export interface RecordHumanEvaluationInput {
  tenantId: string;
  subjectType: string;
  subjectId: string;
  feedback: HumanFeedback;
  /** Target status of the subject after the verdict (dedupe key); null when unknown. */
  toStatus: string | null;
  details: Record<string, unknown>;
  source: 'twenty_webhook' | 'api';
  agentExecutionId?: string | null;
  taskRunId?: string | null;
  evaluatedBy?: string | null;
  occurredAt?: Date;
  idempotencyKey?: string | null;
  dedupeWindowMs: number;
}

export interface RecordResult {
  evaluation: Evaluation;
  deduplicated: boolean;
  dedupedBy: 'idempotency_key' | 'window' | null;
}

export async function recordHumanEvaluation(db: Db, input: RecordHumanEvaluationInput): Promise<RecordResult> {
  const occurredAt = input.occurredAt ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`evaluations:${input.tenantId}:${input.subjectType}:${input.subjectId}`}))`);

    if (input.idempotencyKey) {
      const existing = await tx.query.evaluations.findFirst({
        where: and(eq(evaluations.tenantId, input.tenantId), eq(evaluations.idempotencyKey, input.idempotencyKey)),
      });
      if (existing) return { evaluation: existing, deduplicated: true, dedupedBy: 'idempotency_key' };
    }

    const statusCond: SQL =
      input.toStatus === null ? sql`${evaluations.details}->>'to_status' is null` : sql`${evaluations.details}->>'to_status' = ${input.toStatus}`;
    const recent = await tx.query.evaluations.findFirst({
      where: and(
        eq(evaluations.tenantId, input.tenantId),
        eq(evaluations.subjectType, input.subjectType),
        eq(evaluations.subjectId, input.subjectId),
        eq(evaluations.feedback, input.feedback),
        statusCond,
        gte(evaluations.occurredAt, new Date(occurredAt.getTime() - input.dedupeWindowMs)),
      ),
      orderBy: desc(evaluations.occurredAt),
    });
    if (recent) return { evaluation: recent, deduplicated: true, dedupedBy: 'window' };

    const [inserted] = await tx
      .insert(evaluations)
      .values({
        tenantId: input.tenantId,
        kind: 'HUMAN',
        evaluatorId: HUMAN_EVALUATOR_ID,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        agentExecutionId: input.agentExecutionId ?? null,
        taskRunId: input.taskRunId ?? null,
        feedback: input.feedback,
        score: scoreOf(input.feedback),
        details: { ...input.details, to_status: input.toStatus },
        source: input.source,
        idempotencyKey: input.idempotencyKey ?? null,
        evaluatedBy: input.evaluatedBy ?? null,
        occurredAt,
      })
      .returning();
    if (!inserted) throw new Error('failed to insert evaluation');
    return { evaluation: inserted, deduplicated: false, dedupedBy: null };
  });
}

export interface SubjectHistory {
  /** `to_status` of the most recent verdict, if any. */
  lastKnownStatus: string | null;
  /** An EDITED verdict while PROPOSED exists after the last status-changing verdict. */
  editedWhileProposed: boolean;
}

export async function subjectHistory(db: Db, tenantId: string, subjectType: string, subjectId: string): Promise<SubjectHistory> {
  const rows = await db.query.evaluations.findMany({
    where: and(eq(evaluations.tenantId, tenantId), eq(evaluations.subjectType, subjectType), eq(evaluations.subjectId, subjectId)),
    orderBy: desc(evaluations.occurredAt),
    limit: 50,
  });
  const statusOf = (e: Evaluation) => (typeof e.details.to_status === 'string' ? e.details.to_status : null);
  const lastKnownStatus = rows.length > 0 ? statusOf(rows[0] as Evaluation) : null;
  let editedWhileProposed = false;
  for (const row of rows) {
    if (row.feedback === 'EDITED' && statusOf(row) === 'PROPOSED') {
      editedWhileProposed = true;
      break;
    }
    if (statusOf(row) !== 'PROPOSED') break;
  }
  return { lastKnownStatus, editedWhileProposed };
}

/** LLD v0.2 section 5.5 EvaluationResult for one stored evaluation. */
export function toEvaluationResult(e: Evaluation): Record<string, unknown> {
  return {
    evaluatorId: e.evaluatorId,
    evaluatorVersion: e.evaluatorId,
    type: e.kind,
    executionId: e.agentExecutionId,
    scores: { TASK_SUCCESS: e.score },
    hardFailures: [],
    passed: e.feedback !== 'DISCARDED',
    evaluatedAt: e.occurredAt.toISOString(),
  };
}
