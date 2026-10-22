/**
 * create_crm_task (LOW_WRITE, tanda 19): a native Twenty Task (status TODO, optional due date)
 * linked through `taskTargets` to the records it is about (company, person, opportunity,
 * commercial signal, commercial hypothesis). For ACTIONABLE alerts that a person must close
 * (e.g. a qualified signal outside the lead-time window); informative history stays in notes.
 *
 * Same rules as create_signal_note: the App records (signal, hypothesis) are re-read with the run's
 * tenant first (another tenant's record: `TWENTY_TENANT_MISMATCH`, nothing written); a missing
 * record is `TARGET_NOT_FOUND`. Never changes the targets, never sends anything to anybody.
 * Idempotent by title + local day (src/integrations/twenty/tasks.ts): a task with that title
 * created today on the first target is returned (`created: false`). With `scope: 'ever'` (tanda 21,
 * lead follow-up) a same-title task of any day on the `anchor` target is returned instead. The `task` object has no
 * `tenantId` (standard object): the targets carry the tenant.
 */
import { z } from 'zod';
import { TWENTY_OBJECTS, type TwentyCommercialHypothesis, type TwentyCommercialSignal } from '../../integrations/twenty/index.js';
import { createCrmTask } from '../../integrations/twenty/tasks.js';
import { defineTool } from '../types.js';
import { RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

export const CRM_TASK_BODY_MAX = 8_000;

const DueAt = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const CreateCrmTaskInput = z.object({
  title: z.string().trim().min(1).max(255),
  bodyMarkdown: z.string().trim().min(1).max(CRM_TASK_BODY_MAX),
  /** `YYYY-MM-DD` (09:00 Europe/Madrid of that day) or ISO date-time. Omitted: no due date. */
  dueAt: DueAt.optional(),
  targets: z
    .object({
      companyId: RecordId.optional(),
      personId: RecordId.optional(),
      opportunityId: RecordId.optional(),
      signalId: RecordId.optional(),
      hypothesisId: RecordId.optional(),
    })
    .strict()
    .default({}),
  /** 'day' (default): reuse a same-title task created today. 'ever': of any day (one task per anchor, forever). */
  scope: z.enum(['day', 'ever']).optional(),
  /** Target a same-title task must already point to (default: the first given, company first). */
  anchor: z.enum(['companyId', 'personId', 'opportunityId', 'signalId', 'hypothesisId']).optional(),
});

export const CreateCrmTaskOutput = z.object({
  created: z.boolean(),
  adopted: z.boolean(),
  taskId: z.string(),
  title: z.string(),
  dueAt: z.string().nullable(),
  targetIds: z.array(z.string()),
});
export type CreateCrmTaskOutput = z.infer<typeof CreateCrmTaskOutput>;

export function createCreateCrmTaskTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_crm_task',
    name: 'Create CRM task',
    version: '1.0.0',
    description:
      'Create a to-do task (markdown body, optional due date) in the CRM linked to records of the current tenant (company, person, opportunity, commercial signal, commercial hypothesis). Idempotent per title and day (or, with scope "ever", per title and anchor target forever). Never changes the linked records and never sends anything to anybody.',
    inputSchema: CreateCrmTaskInput,
    outputSchema: CreateCrmTaskOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:tasks:read', 'twenty:tasks:write', 'twenty:signals:read', 'twenty:hypotheses:read'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const t = input.targets;
        // Tenant check of the App records (throws TWENTY_TENANT_MISMATCH for another tenant's record).
        if (t.signalId) {
          const s = await twenty.get<TwentyCommercialSignal>(TWENTY_OBJECTS.commercialSignal, t.signalId, { depth: 0, tenantId: ctx.tenantId, signal: ctx.signal });
          if (!s) return { status: 'error' as const, code: 'TARGET_NOT_FOUND', message: `commercial signal ${t.signalId} does not exist`, retryable: false };
        }
        if (t.hypothesisId) {
          const h = await twenty.get<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, t.hypothesisId, { depth: 0, tenantId: ctx.tenantId, signal: ctx.signal });
          if (!h) return { status: 'error' as const, code: 'TARGET_NOT_FOUND', message: `commercial hypothesis ${t.hypothesisId} does not exist`, retryable: false };
        }
        if (input.anchor && !t[input.anchor]) return { status: 'error' as const, code: 'INVALID_ANCHOR', message: `anchor ${input.anchor} is not among the targets`, retryable: false };
        const task = await createCrmTask(
          twenty,
          { title: input.title, body: input.bodyMarkdown, dueAt: input.dueAt, targets: t, ...(input.scope ? { scope: input.scope } : {}), ...(input.anchor ? { anchor: input.anchor } : {}) },
          { signal: ctx.signal },
        );
        ctx.logger.info('crm task', { taskId: task.taskId, created: task.created, adopted: task.adopted, targets: task.targetIds.length });
        return {
          status: 'ok' as const,
          output: { created: task.created, adopted: task.adopted, taskId: task.taskId, title: task.title, dueAt: task.dueAt, targetIds: task.targetIds },
        };
      }),
  });
}
