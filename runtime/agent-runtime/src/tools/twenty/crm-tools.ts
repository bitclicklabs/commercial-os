/**
 * Tools over the native Twenty objects Person / Opportunity / Task (tanda 19). All LOW_WRITE,
 * idempotent, never send anything to anybody. None is in any policy unless the seed lists it:
 *
 * - `upsert_person`: the Person of an address, deduped by `emails.primaryEmail`; an existing one
 *   is only completed (empty name / jobTitle / company). Generic, function and role mailboxes
 *   (`info@`, `comercial@`, `rrhh@`) are skipped: they are not people. ContactFinder, EmailDrafter
 *   (its contact step) and InboxAgent.
 * - `upsert_opportunity`: the company's OPEN Opportunity, created at the first stage of the
 *   workspace when there is none (`«<Empresa> — <feria>»`, no amount); attaches the reply note.
 *   InboxAgent only (INTERESADO replies): never a bulk copy of hypotheses.
 * - `create_reply_task`: the Task «📬 Responder a <persona/empresa>» (TODO, due in 2 working
 *   days) linked to the opportunity / company / person. InboxAgent only.
 *
 * Person and Opportunity have no `tenantId` (standard objects); the hypothesis read to name the
 * opportunity is tenant-scoped.
 */
import { z } from 'zod';
import { OPPORTUNITY_NAME_MAX } from '../../crm/opportunities.js';
import { openOpportunityFor, PromotionError } from '../../crm/promote.js';
import { personMailbox, upsertPerson } from '../../crm/people.js';
import { replyTaskTitle, twentyRecordUrl, upsertReplyTask } from '../../crm/reply-task.js';
import { defineTool } from '../types.js';
import { errorResult, RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

export const CRM_TOOL_IDS = ['upsert_person', 'upsert_opportunity', 'create_reply_task'] as const;

const PersonOut = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  companyId: z.string().nullable(),
});

export const UpsertPersonInput = z.object({
  email: z.string().trim().min(3).max(254),
  /** Name as published (web) or as in the From header; split into first / last name. */
  fullName: z.string().trim().max(200).nullable().optional(),
  jobTitle: z.string().trim().max(300).nullable().optional(),
  companyId: RecordId.nullable().optional(),
});

export const UpsertPersonOutput = z.object({
  outcome: z.enum(['created', 'updated', 'unchanged', 'skipped']),
  /** Why nothing was written (`generic`, `function`, `role`, `never`, `invalid`). */
  reason: z.string().nullable(),
  email: z.string(),
  person: PersonOut.nullable(),
  filled: z.array(z.string()),
});

export function createUpsertPersonTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'upsert_person',
    name: 'Upsert person',
    version: '1.0.0',
    description:
      'Create or complete the CRM Person of an email address (deduplicated by primary email). An existing person only gets its EMPTY fields filled (name, job title, company); nothing is overwritten. Generic, function or role mailboxes (info@, comercial@, rrhh@) are skipped: they are not people. Never sends anything.',
    inputSchema: UpsertPersonInput,
    outputSchema: UpsertPersonOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:people:read', 'twenty:people:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: async (input, ctx) => {
      // A mailbox that is not a person needs no CRM at all (answers even without Twenty).
      const kind = personMailbox(input.email);
      if (kind !== 'person') return { status: 'ok', output: { outcome: 'skipped' as const, reason: kind, email: input.email.trim().toLowerCase(), person: null, filled: [] } };
      return withTwenty(deps, async () => {
        const r = await upsertPerson(deps.twenty, { email: input.email, fullName: input.fullName ?? null, jobTitle: input.jobTitle ?? null, companyId: input.companyId ?? null }, ctx.signal);
        if (r.outcome !== 'skipped') ctx.logger.info('person upsert', { outcome: r.outcome, personId: r.person.id, filled: r.filled.join(',') });
        return { status: 'ok', output: r };
      });
    },
  });
}

export const UpsertOpportunityInput = z.object({
  companyId: RecordId,
  /** Hypothesis the reply answers: gives the fair of the name. Optional. */
  hypothesisId: RecordId.nullable().optional(),
  pointOfContactId: RecordId.nullable().optional(),
  /** Note of the reply, attached to the opportunity (and to the person). */
  noteId: RecordId.nullable().optional(),
  /** Why it is promoted: only an interested reply or a person's decision create opportunities. */
  origin: z.enum(['reply', 'manual']),
});

export const UpsertOpportunityOutput = z.object({
  created: z.boolean(),
  opportunity: z.object({
    id: z.string(),
    name: z.string().max(OPPORTUNITY_NAME_MAX).nullable(),
    stage: z.string().nullable(),
    companyId: z.string().nullable(),
    pointOfContactId: z.string().nullable(),
  }),
  filled: z.array(z.string()),
  /** `twenty`: first stage read from the workspace; `default`: fallback order; `existing`: reused. */
  stageSource: z.enum(['twenty', 'default', 'existing']),
  fair: z.string().nullable(),
  noteTargetsAdded: z.number().int(),
});

export function createUpsertOpportunityTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'upsert_opportunity',
    name: 'Upsert opportunity',
    version: '1.0.0',
    description:
      "Open the company's CRM Opportunity after real traction (an interested reply or a person's decision): reuse its open opportunity, or create one named «<Company> — <fair>» at the first stage of the pipeline, without amount. Attaches the reply note. Idempotent per company. Never sends anything.",
    inputSchema: UpsertOpportunityInput,
    outputSchema: UpsertOpportunityOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:companies:read', 'twenty:hypotheses:read', 'twenty:opportunities:read', 'twenty:opportunities:write', 'twenty:notes:write'],
    timeoutMs: 25_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        try {
          const r = await openOpportunityFor(
            deps.twenty,
            { tenantId: ctx.tenantId, companyId: input.companyId, hypothesisId: input.hypothesisId ?? null, pointOfContactId: input.pointOfContactId ?? null, noteId: input.noteId ?? null },
            ctx.signal,
          );
          ctx.logger.info('opportunity upsert', { created: r.created, opportunityId: r.opportunity.id, origin: input.origin, stage: r.opportunity.stage ?? '' });
          return { status: 'ok', output: r };
        } catch (err) {
          if (err instanceof PromotionError) return errorResult(err.code, err.message);
          throw err;
        }
      }),
  });
}

export const CreateReplyTaskInput = z.object({
  /** Who to answer: the person's name, or the company. Title = «📬 Responder a <who>». */
  who: z.string().trim().min(1).max(200),
  bodyMarkdown: z.string().trim().min(1).max(10_000),
  dueAt: z.iso.datetime({ offset: true }),
  companyId: RecordId.nullable().optional(),
  opportunityId: RecordId.nullable().optional(),
  personId: RecordId.nullable().optional(),
  /** The 📬 note of the reply: its link (and the opportunity's) is appended to the body. */
  noteId: RecordId.nullable().optional(),
});

export const CreateReplyTaskOutput = z.object({
  created: z.boolean(),
  task: z.object({ id: z.string(), title: z.string(), status: z.string().nullable(), dueAt: z.string().nullable() }),
  targetIds: z.array(z.string()),
});

export function createCreateReplyTaskTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_reply_task',
    name: 'Create reply task',
    version: '1.0.0',
    description:
      'Create the CRM task «📬 Responder a <who>» (status TODO, with a due date) linked to the opportunity, company and person of a reply. An open task with the same title on the same opportunity/company is reused. Never sends anything.',
    inputSchema: CreateReplyTaskInput,
    outputSchema: CreateReplyTaskOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:tasks:read', 'twenty:tasks:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        if (!input.companyId && !input.opportunityId && !input.personId) return errorResult('INVALID_INPUT', 'a reply task needs at least one target (company, opportunity or person)');
        const r = await upsertReplyTask(
          deps.twenty,
          {
            title: replyTaskTitle(input.who),
            bodyMarkdown: [
              input.bodyMarkdown,
              ...(input.noteId || input.opportunityId ? [''] : []),
              ...(input.noteId ? [`Nota con el extracto: ${twentyRecordUrl(deps.twenty.baseUrl, 'note', input.noteId)}`] : []),
              ...(input.opportunityId ? [`Oportunidad: ${twentyRecordUrl(deps.twenty.baseUrl, 'opportunity', input.opportunityId)}`] : []),
            ].join('\n'),
            dueAt: new Date(input.dueAt).toISOString(),
            companyId: input.companyId ?? null,
            opportunityId: input.opportunityId ?? null,
            personId: input.personId ?? null,
          },
          ctx.signal,
        );
        ctx.logger.info('reply task', { created: r.created, taskId: r.task.id });
        return { status: 'ok', output: r };
      }),
  });
}
