/**
 * Persistence of human evaluations (append-only, no DELETE).
 *
 * Dedupe, in one transaction serialised per subject (advisory lock):
 * - `idempotency_key` (unique per tenant): exact replays of the same delivery/request;
 * - window: the same (subject, feedback, target status) recorded less than
 *   `dedupeWindowMs` before `occurred_at` is not recorded again.
 *
 * After the transaction commits, `evaluation.recorded` is emitted (best-effort, when an
 * event publisher is given). The event idempotency key is the evaluation id, so it is
 * also emitted on a deduplicated call: a replay re-dispatches an event whose first
 * publish failed, and is a no-op otherwise.
 */
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { evaluations, type Evaluation } from '../db/schema.js';
import type { EventPublisher } from '../events/event-bus.js';
import { evaluationRecordedEvent } from '../events/runtime-events.js';
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
  /** Twenty company of the subject, when known (goes into `evaluation.recorded`). Falls back to `details.company_id`. */
  companyId?: string | null;
}

export interface RecordOptions {
  /** Publisher of `evaluation.recorded`; without it nothing is emitted. */
  events?: EventPublisher | undefined;
}

export interface RecordResult {
  evaluation: Evaluation;
  deduplicated: boolean;
  dedupedBy: 'idempotency_key' | 'window' | null;
  /** Id of the `evaluation.recorded` event, or null when not emitted (no publisher or publish failed). */
  eventId: string | null;
}

function companyIdOf(input: RecordHumanEvaluationInput, evaluation: Evaluation): string | null {
  if (typeof input.companyId === 'string' && input.companyId.length > 0) return input.companyId;
  const fromDetails = evaluation.details?.company_id;
  return typeof fromDetails === 'string' && fromDetails.length > 0 ? fromDetails : null;
}

export async function recordHumanEvaluation(db: Db, input: RecordHumanEvaluationInput, opts: RecordOptions = {}): Promise<RecordResult> {
  const result = await insertHumanEvaluation(db, input);
  let eventId: string | null = null;
  if (opts.events) {
    const published = await opts.events.emit(evaluationRecordedEvent(result.evaluation, { companyId: companyIdOf(input, result.evaluation) }));
    eventId = published?.event.id ?? null;
  }
  return { ...result, eventId };
}

async function insertHumanEvaluation(db: Db, input: RecordHumanEvaluationInput): Promise<Omit<RecordResult, 'eventId'>> {
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
  /** When the most recent verdict happened (null without verdicts). */
  lastOccurredAt?: Date | null;
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
  return { lastKnownStatus, editedWhileProposed, lastOccurredAt: rows[0]?.occurredAt ?? null };
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
