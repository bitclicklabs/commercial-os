/**
 * Evaluador HUMAN (LLD v0.2 section 6.4):
 * - POST /webhooks/twenty   - Twenty webhook (signed), maps hypothesis changes to verdicts.
 * - POST /evaluations/human - manual verdict (also the contract of the Twenty App logic function).
 * - GET  /evaluations       - list verdicts (filters: subject_id, subject_type, feedback, since, agent_execution_id).
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agentExecutions, evaluations } from '../../db/schema.js';
import { HUMAN_EVALUATOR_ID, HUMAN_FEEDBACK_VALUES, passedOf, scoreOf } from '../../evaluations/human-feedback.js';
import { linkDetails, resolveHypothesisOrigin } from '../../evaluations/link-resolver.js';
import { recordHumanEvaluation } from '../../evaluations/service.js';
import { authenticateTwentyWebhook, isHypothesisPayload, processTwentyWebhook } from '../../evaluations/twenty-webhook.js';
import { processEmailStatusChange, type EmailOpsOutcome } from '../../email-ops/service.js';
import type { ApiContext } from '../context.js';
import { HttpError, notFound, parse, serialize, tenantOf } from '../http.js';

const DEFAULT_DEDUPE_WINDOW_MS = 600_000;

const Feedback = z.enum(HUMAN_FEEDBACK_VALUES);
const EditedFields = z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() }));

/** Body of POST /evaluations/human: the runtime shape, or the LLD v0.2 section 6.4 shape (hypothesisId...). */
export const HumanEvaluationBody = z.union([
  z
    .object({
      subject_type: z.string().min(1).max(60).default('hypothesis'),
      subject_id: z.string().min(1).max(200),
      feedback: Feedback,
      details: z.record(z.string(), z.unknown()).default({}),
      agent_execution_id: z.uuid().optional(),
      evaluated_by: z.string().max(200).optional(),
      occurred_at: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      hypothesisId: z.string().min(1).max(200),
      agentExecutionId: z.uuid().optional(),
      feedback: Feedback,
      note: z.string().max(4000).optional(),
      editedFields: EditedFields.optional(),
      reviewerId: z.string().max(200).optional(),
      reviewedAt: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
]);

export const ListEvaluationsQuery = z.object({
  subject_id: z.string().min(1).optional(),
  subject_type: z.string().min(1).optional(),
  feedback: Feedback.optional(),
  agent_execution_id: z.uuid().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface Normalised {
  subjectType: string;
  subjectId: string;
  feedback: z.infer<typeof Feedback>;
  details: Record<string, unknown>;
  agentExecutionId?: string | undefined;
  evaluatedBy?: string | undefined;
  occurredAt?: string | undefined;
}

function normalise(body: z.infer<typeof HumanEvaluationBody>): Normalised {
  if ('hypothesisId' in body) {
    return {
      subjectType: 'hypothesis',
      subjectId: body.hypothesisId,
      feedback: body.feedback,
      details: {
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.editedFields !== undefined ? { edited_fields: body.editedFields } : {}),
      },
      agentExecutionId: body.agentExecutionId,
      evaluatedBy: body.reviewerId,
      occurredAt: body.reviewedAt,
    };
  }
  return {
    subjectType: body.subject_type,
    subjectId: body.subject_id,
    feedback: body.feedback,
    details: body.details,
    agentExecutionId: body.agent_execution_id,
    evaluatedBy: body.evaluated_by,
    occurredAt: body.occurred_at,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  if (value.length > 200) throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key is too long');
  return value;
}

export async function evaluationRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;
  const dedupeWindowMs = ctx.config.evaluationDedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;

  // Encapsulated scope: this JSON parser keeps the raw body for the HMAC check and only
  // applies to the webhook route.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      (req as FastifyRequest & { rawBody?: string }).rawBody = raw;
      try {
        done(null, raw.length === 0 ? {} : JSON.parse(raw));
      } catch {
        done(new HttpError(400, 'invalid_json', 'body is not valid JSON'), undefined);
      }
    });

    scope.post('/webhooks/twenty', async (req, reply) => {
      const secret = ctx.config.twentyWebhookSecret;
      if (!secret) throw new HttpError(503, 'webhook_not_configured', 'TWENTY_WEBHOOK_SECRET is not set');
      const auth = authenticateTwentyWebhook({
        secret,
        rawBody: (req as FastifyRequest & { rawBody?: string }).rawBody ?? '',
        headers: req.headers,
        query: (req.query ?? {}) as Record<string, unknown>,
      });
      if (!auth.ok) {
        req.log.warn({ reason: auth.reason }, 'twenty webhook rejected');
        throw new HttpError(401, 'unauthorized', 'invalid webhook credentials');
      }
      if (!isHypothesisPayload(req.body)) throw new HttpError(400, 'invalid_payload', 'not a Twenty record webhook payload');
      // Email-ops first: the READY check races the manual send workflow (src/email-ops/service.ts).
      let email: EmailOpsOutcome | { status: 'error'; message: string } | null;
      try {
        email = await processEmailStatusChange(db, req.body, {
          defaultTenantId: ctx.config.defaultTenantId,
          twenty: ctx.twenty,
          events: ctx.events,
          logger: req.log,
        });
      } catch (err) {
        req.log.error({ err: (err as Error).message, event: req.body.eventName }, 'email-ops failed');
        email = { status: 'error', message: (err as Error).message.slice(0, 300) };
      }
      const outcome = await processTwentyWebhook(db, req.body, { defaultTenantId: ctx.config.defaultTenantId, dedupeWindowMs, events: ctx.events });
      req.log.info({ event: req.body.eventName, outcome, email, auth: auth.method }, 'twenty webhook processed');
      const code = email?.status === 'error' ? 502 : outcome.status === 'recorded' ? 201 : 200;
      return reply.status(code).send(email ? { ...outcome, email } : outcome);
    });
  });

  app.post('/evaluations/human', async (req, reply) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const input = normalise(parse(HumanEvaluationBody, req.body));
    const idempotencyKey = idempotencyKeyOf(req);

    let agentExecutionId: string | null = null;
    let taskRunId: string | null = null;
    let companyId: string | null = null;
    let link: Record<string, unknown>;
    if (input.agentExecutionId) {
      const execution = await db.query.agentExecutions.findFirst({
        where: and(eq(agentExecutions.tenantId, tenantId), eq(agentExecutions.id, input.agentExecutionId)),
      });
      if (!execution) throw notFound('agent execution');
      agentExecutionId = execution.id;
      taskRunId = execution.taskRunId;
      link = { resolved: true, method: 'provided' };
    } else if (input.subjectType === 'hypothesis') {
      const resolved = await resolveHypothesisOrigin(db, { tenantId, hypothesisId: input.subjectId });
      if (resolved.resolved) {
        agentExecutionId = resolved.agentExecutionId;
        taskRunId = resolved.taskRunId;
        // The agent's create_hypothesis input names the company (goes into evaluation.recorded).
        const proposedCompany = (resolved.proposal as { companyId?: unknown } | null)?.companyId;
        if (typeof proposedCompany === 'string') companyId = proposedCompany;
      }
      link = linkDetails(resolved);
    } else {
      link = { resolved: false, reason: `no resolver for subject_type ${input.subjectType}` };
    }

    const toStatus =
      typeof input.details.to_status === 'string'
        ? input.details.to_status
        : input.subjectType === 'hypothesis'
          ? input.feedback === 'DISCARDED'
            ? 'REJECTED'
            : 'VALIDATED'
          : null;
    const result = await recordHumanEvaluation(db, {
      tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      feedback: input.feedback,
      toStatus,
      details: { ...input.details, link },
      source: 'api',
      agentExecutionId,
      taskRunId,
      evaluatedBy: input.evaluatedBy ?? null,
      ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
      idempotencyKey: idempotencyKey ?? null,
      dedupeWindowMs,
      companyId,
    }, { events: ctx.events });
    const e = result.evaluation;
    return reply.status(result.deduplicated ? 200 : 201).send({
      evaluatorId: HUMAN_EVALUATOR_ID,
      executionId: e.agentExecutionId,
      scores: { TASK_SUCCESS: scoreOf(input.feedback) },
      passed: passedOf(input.feedback),
      deduplicated: result.deduplicated,
      event_id: result.eventId,
      evaluation: serialize(e),
    });
  });

  app.get('/evaluations', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ListEvaluationsQuery, req.query);
    const rows = await db.query.evaluations.findMany({
      where: and(
        eq(evaluations.tenantId, tenantId),
        q.subject_id ? eq(evaluations.subjectId, q.subject_id) : undefined,
        q.subject_type ? eq(evaluations.subjectType, q.subject_type) : undefined,
        q.feedback ? eq(evaluations.feedback, q.feedback) : undefined,
        q.agent_execution_id ? eq(evaluations.agentExecutionId, q.agent_execution_id) : undefined,
        q.since ? gte(evaluations.occurredAt, new Date(q.since)) : undefined,
      ),
      orderBy: desc(evaluations.occurredAt),
      limit: q.limit,
    });
    return { items: rows.map((r) => serialize(r)) };
  });
}
