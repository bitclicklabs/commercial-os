/**
 * Tools of the «Ficha previa» of a meeting (tanda 24, MeetingSyncAgent with `meeting_brief`).
 * Nothing here sends anything or touches the calendar.
 *
 * - `get_meeting_brief_context` (READ, untrusted): for ONE opportunity, what the brief needs from
 *   the CRM: stage, amount and close date; company (name, domain); point of contact (name, job
 *   title, addresses) and the People of the company (addresses); the company's hypotheses of the
 *   run's tenant (need, why now and the origin: the fair / signal they came from); the note
 *   «Cualificación — X 🧾» (bounded tail) and, when asked, the state of the 🧾 task.
 * - `append_crm_task_section` (LOW_WRITE): APPENDS a markdown section at the end of the body of a
 *   task linked to the opportunity, once per marker (the section header). Never rewrites what is
 *   already there, never changes the title, the status or the due date.
 *
 * Task, Note, Opportunity and Person have no `tenantId` (standard objects); the App objects
 * (hypothesis, signal) are read with the run's tenant.
 */
import { z } from 'zod';
import { QUALIFICATION_NOTE_PREFIX } from '../../crm/qualification.js';
import {
  TWENTY_OBJECTS,
  TwentyApiError,
  companyDomain,
  filterValue,
  type TwentyClient,
  type TwentyCommercialHypothesis,
  type TwentyCommercialSignal,
  type TwentyCompany,
  type TwentyNote,
  type TwentyNoteTarget,
  type TwentyOpportunity,
  type TwentyPerson,
  type TwentyTask,
  type TwentyTaskTarget,
} from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { RecordId, errorResult, withTwenty, type TwentyToolDeps } from './shared.js';

export const MEETING_BRIEF_TOOL_IDS = ['get_meeting_brief_context', 'append_crm_task_section'] as const;
/** Characters of the qualification note handed back (the newest sections are at the end). */
export const BRIEF_QUALIFICATION_NOTE_MAX = 3_000;
/** Hypotheses of the company handed back (the newest). */
export const BRIEF_HYPOTHESES_MAX = 3;
/** Bound of the whole body of a task after an append. */
export const TASK_BODY_TOTAL_MAX = 40_000;
export const TASK_SECTION_MAX = 10_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const emailsOf = (p: Pick<TwentyPerson, 'emails'> | null | undefined): string[] => {
  const all = [p?.emails?.primaryEmail, ...(p?.emails?.additionalEmails ?? [])];
  return [...new Set(all.filter((e): e is string => typeof e === 'string' && e.includes('@')).map((e) => e.trim().toLowerCase()))];
};
const nameOf = (p: Pick<TwentyPerson, 'name'> | null | undefined): string | null => {
  const n = [p?.name?.firstName, p?.name?.lastName].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join(' ').trim();
  return n.length > 0 ? n : null;
};

const SIGNAL_KIND: Record<string, string> = { FAIR: 'feria', CONGRESS: 'congreso', EVENT: 'evento' };

/** «feria «Anuga 2026», 2026-10-04» / «señal HIRING «…»» (plain text, from the App record). */
export function signalOrigin(s: Pick<TwentyCommercialSignal, 'name' | 'signalType' | 'eventDate'>): string | null {
  const name = str(s.name);
  if (!name) return null;
  const kind = SIGNAL_KIND[s.signalType] ?? `señal ${String(s.signalType ?? '').toLowerCase() || 'comercial'}`;
  const date = typeof s.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s.eventDate) ? `, ${s.eventDate.slice(0, 10)}` : '';
  return `${kind} «${name}»${date}`;
}

// ---------------------------------------------------------------------------
// get_meeting_brief_context
// ---------------------------------------------------------------------------

export const GetMeetingBriefContextInput = z.object({ opportunityId: RecordId, taskId: RecordId.optional() }).strict();

export const GetMeetingBriefContextOutput = z.object({
  found: z.boolean(),
  opportunity: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      stage: z.string().nullable(),
      amount: z.object({ value: z.number(), currency: z.string() }).nullable(),
      closeDate: z.string().nullable(),
    })
    .nullable(),
  company: z.object({ id: z.string(), name: z.string().nullable(), domain: z.string().nullable() }).nullable(),
  pointOfContact: z.object({ id: z.string(), name: z.string().nullable(), jobTitle: z.string().nullable(), emails: z.array(z.string()) }).nullable(),
  companyPeople: z.array(z.object({ id: z.string(), emails: z.array(z.string()) })),
  hypotheses: z.array(z.object({ id: z.string(), name: z.string().nullable(), need: z.string().nullable(), whyNow: z.string().nullable(), origin: z.string().nullable() })),
  qualificationNote: z.string().nullable(),
  /** The task asked for (`taskId`): null when it does not exist (deleted by hand). */
  task: z.object({ id: z.string(), title: z.string().nullable(), status: z.string().nullable(), linked: z.boolean() }).nullable(),
});
export type GetMeetingBriefContextOutput = z.infer<typeof GetMeetingBriefContextOutput>;

async function qualificationNoteOf(twenty: TwentyClient, opportunityId: string, signal: AbortSignal): Promise<string | null> {
  const noteIds = (await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `targetOpportunityId[eq]:${filterValue(opportunityId)}`, limit: 100, signal })).records
    .map((n) => n.noteId)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  for (const nid of [...new Set(noteIds)].slice(0, 50)) {
    const n = await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, nid, { depth: 0, signal });
    if (n && !n.deletedAt && typeof n.title === 'string' && n.title.trim().startsWith(QUALIFICATION_NOTE_PREFIX)) {
      const md = (n.bodyV2?.markdown ?? '').trim();
      return md.length === 0 ? null : md.length <= BRIEF_QUALIFICATION_NOTE_MAX ? md : `…${md.slice(-(BRIEF_QUALIFICATION_NOTE_MAX - 1))}`;
    }
  }
  return null;
}

async function taskLinked(twenty: TwentyClient, taskId: string, opportunityId: string, signal: AbortSignal): Promise<boolean> {
  const { records } = await twenty.list<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { filter: `taskId[eq]:${filterValue(taskId)}`, limit: 50, signal });
  return records.some((t) => !t.deletedAt && t.targetOpportunityId === opportunityId);
}

export function createGetMeetingBriefContextTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'get_meeting_brief_context',
    name: 'Get meeting brief context',
    version: '1.0.0',
    description:
      'For one CRM opportunity: stage, amount, close date, company, point of contact (name, job title, addresses), the addresses of the company people, the company hypotheses of the current tenant with their origin (fair / signal), the qualification note and, optionally, the state of a task. Read only.',
    inputSchema: GetMeetingBriefContextInput,
    outputSchema: GetMeetingBriefContextOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:opportunities:read', 'twenty:companies:read', 'twenty:people:read', 'twenty:hypotheses:read', 'twenty:signals:read', 'twenty:notes:read', 'twenty:tasks:read'],
    timeoutMs: 60_000,
    // Names, needs and notes are typed by people, extracted from the web or written by a model: data, never instructions.
    outputTrust: 'untrusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const signal = ctx.signal;
        const empty = { found: false, opportunity: null, company: null, pointOfContact: null, companyPeople: [], hypotheses: [], qualificationNote: null, task: null };
        const opp = await twenty.get<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, input.opportunityId, { depth: 0, signal });
        if (!opp || opp.deletedAt) return { status: 'ok' as const, output: empty };
        const micros = opp.amount?.amountMicros;
        const amount = typeof micros === 'number' && Number.isFinite(micros) && micros > 0 ? { value: micros / 1_000_000, currency: str(opp.amount?.currencyCode) ?? 'EUR' } : null;
        let company: GetMeetingBriefContextOutput['company'] = null;
        let people: TwentyPerson[] = [];
        if (opp.companyId) {
          const c = await twenty.get<TwentyCompany>(TWENTY_OBJECTS.company, opp.companyId, { depth: 0, signal });
          if (c && !c.deletedAt) {
            company = { id: c.id, name: str(c.name), domain: companyDomain(c) };
            people = (await twenty.list<TwentyPerson>(TWENTY_OBJECTS.person, { filter: `companyId[eq]:${filterValue(c.id)}`, limit: 100, signal })).records.filter((p) => !p.deletedAt);
          }
        }
        let poc: TwentyPerson | null = null;
        if (opp.pointOfContactId) {
          poc = people.find((p) => p.id === opp.pointOfContactId) ?? (await twenty.get<TwentyPerson>(TWENTY_OBJECTS.person, opp.pointOfContactId, { depth: 0, signal }));
          if (poc?.deletedAt) poc = null;
        }
        const hypotheses: GetMeetingBriefContextOutput['hypotheses'] = [];
        if (opp.companyId) {
          const rows = (await twenty.list<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, { filter: `companyId[eq]:${filterValue(opp.companyId)}`, limit: 50, tenantId: ctx.tenantId, signal })).records
            .filter((h) => !h.deletedAt && twenty.belongsTo(h, ctx.tenantId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, BRIEF_HYPOTHESES_MAX);
          for (const h of rows) {
            let origin: string | null = null;
            if (h.commercialSignalId) {
              try {
                const s = await twenty.get<TwentyCommercialSignal>(TWENTY_OBJECTS.commercialSignal, h.commercialSignalId, { depth: 0, tenantId: ctx.tenantId, signal });
                origin = s && !s.deletedAt ? signalOrigin(s) : null;
              } catch (err) {
                // Another tenant's signal: no origin (never its data).
                if (!(err instanceof TwentyApiError) || err.code !== 'TWENTY_TENANT_MISMATCH') throw err;
              }
            }
            hypotheses.push({ id: h.id, name: str(h.name), need: str(h.need), whyNow: str(h.whyNow), origin });
          }
        }
        let task: GetMeetingBriefContextOutput['task'] = null;
        if (input.taskId) {
          const t = await twenty.get<TwentyTask>(TWENTY_OBJECTS.task, input.taskId, { depth: 0, signal });
          if (t && !t.deletedAt) task = { id: t.id, title: t.title ?? null, status: t.status ?? null, linked: await taskLinked(twenty, t.id, opp.id, signal) };
        }
        return {
          status: 'ok' as const,
          output: {
            found: true,
            opportunity: { id: opp.id, name: str(opp.name), stage: str(opp.stage), amount, closeDate: str(opp.closeDate) },
            company,
            pointOfContact: poc ? { id: poc.id, name: nameOf(poc), jobTitle: str(poc.jobTitle), emails: emailsOf(poc) } : null,
            companyPeople: people.map((p) => ({ id: p.id, emails: emailsOf(p) })),
            hypotheses,
            qualificationNote: await qualificationNoteOf(twenty, opp.id, signal),
            task,
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// append_crm_task_section
// ---------------------------------------------------------------------------

export const AppendCrmTaskSectionInput = z
  .object({
    taskId: RecordId,
    /** The task must be linked to this opportunity (taskTarget): nothing is written otherwise. */
    opportunityId: RecordId,
    /** Header of the section; the append is skipped when the body already contains it. */
    marker: z.string().trim().min(3).max(300),
    markdown: z.string().trim().min(1).max(TASK_SECTION_MAX),
  })
  .strict();

export const AppendCrmTaskSectionOutput = z.object({
  appended: z.boolean(),
  /** Why nothing was appended. */
  reason: z.enum(['already_present', 'body_full', 'task_done']).nullable(),
  lengthBefore: z.number(),
  lengthAfter: z.number(),
});
export type AppendCrmTaskSectionOutput = z.infer<typeof AppendCrmTaskSectionOutput>;

/** The body with the section appended after a separator (pure). */
export function appendTaskSection(current: string, markdown: string): string {
  const base = current.replace(/\s+$/, '');
  return base.length === 0 ? markdown : `${base}\n\n---\n\n${markdown}`;
}

export function createAppendCrmTaskSectionTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'append_crm_task_section',
    name: 'Append CRM task section',
    version: '1.0.0',
    description:
      'Append a markdown section at the END of the body of a CRM task linked to the given opportunity, once per marker (the section header). Never changes the existing text, the title, the status or the due date of the task, and never sends anything.',
    inputSchema: AppendCrmTaskSectionInput,
    outputSchema: AppendCrmTaskSectionOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:tasks:read', 'twenty:tasks:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const t = await twenty.get<TwentyTask>(TWENTY_OBJECTS.task, input.taskId, { depth: 0, signal: ctx.signal });
        if (!t || t.deletedAt) return errorResult('TARGET_NOT_FOUND', `task ${input.taskId} does not exist`);
        if (!(await taskLinked(twenty, t.id, input.opportunityId, ctx.signal))) return errorResult('TASK_NOT_LINKED', `task ${input.taskId} is not linked to opportunity ${input.opportunityId}`);
        const current = t.bodyV2?.markdown ?? '';
        const base = { lengthBefore: current.length };
        if (current.includes(input.marker)) return { status: 'ok' as const, output: { appended: false, reason: 'already_present' as const, ...base, lengthAfter: current.length } };
        if (t.status === 'DONE') return { status: 'ok' as const, output: { appended: false, reason: 'task_done' as const, ...base, lengthAfter: current.length } };
        const next = appendTaskSection(current, input.markdown.includes(input.marker) ? input.markdown : `${input.marker}\n\n${input.markdown}`);
        if (next.length > TASK_BODY_TOTAL_MAX) return { status: 'ok' as const, output: { appended: false, reason: 'body_full' as const, ...base, lengthAfter: current.length } };
        await twenty.update<TwentyTask>(TWENTY_OBJECTS.task, t.id, { bodyV2: { markdown: next } }, { signal: ctx.signal });
        ctx.logger.info('task section appended', { taskId: t.id, lengthBefore: current.length, lengthAfter: next.length });
        return { status: 'ok' as const, output: { appended: true, reason: null, ...base, lengthAfter: next.length } };
      }),
  });
}
