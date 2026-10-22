/**
 * Native Twenty Tasks for the runtime's ACTIONABLE alerts (tanda 19). An alert that asks a person
 * to do something (re-validation failed, promotion proposal, catalog down, out-of-window signal)
 * is a Task with a status (TODO) and a due date, not a note: it shows up in the task inbox and can
 * be closed. Notes stay for append-only books (the suppression list) and history.
 *
 * Twenty 2.45 format (verified read-only against GET /rest/open-api/core of the live instance):
 * - `POST /rest/tasks` `{ title, bodyV2: { markdown }, dueAt, status }`, status TODO | IN_PROGRESS | DONE.
 * - The link to a record is a `taskTarget` row: `POST /rest/taskTargets` `{ taskId, target<Object>Id }`,
 *   one per record. Custom App objects are task-targetable (`targetCommercialSignalId`,
 *   `targetCommercialHypothesisId`, ...).
 * - `task` is a STANDARD object: no `tenantId` (shared by every tenant of the workspace, the same
 *   documented limit as notes). Titles that must be per tenant carry the tenant themselves.
 *
 * Idempotency by title + LOCAL day (Europe/Madrid) of creation, like the dated alert notes: a task
 * with the same title created the same day is reused (missing targets are added) and never edited.
 * `scope: 'ever'` reuses a same-title task of any day (the promotion proposal: one per version).
 * With targets, a same-title task must already point to the first target (or have no targets at
 * all: an orphan from a call that died between the two POSTs, adopted). Nothing is ever deleted.
 */
import { localMidnight } from '../../metrics/twenty-sync.js';
import { filterValue, type TwentyClient } from './client.js';
import { TWENTY_OBJECTS, type TaskStatus, type TwentyTask, type TwentyTaskTarget } from './objects.js';

export const CRM_TASK_TIMEZONE = 'Europe/Madrid';
export const CRM_TASK_TITLE_MAX = 255;
/** Local hour of a due date given as a plain day. */
export const CRM_TASK_DUE_HOUR = 9;

/** Records a task can point to (one taskTarget row each). */
export interface CrmTaskTargets {
  companyId?: string | undefined;
  personId?: string | undefined;
  opportunityId?: string | undefined;
  signalId?: string | undefined;
  hypothesisId?: string | undefined;
}

const TARGET_COLUMN: Record<keyof CrmTaskTargets, keyof TwentyTaskTarget> = {
  companyId: 'targetCompanyId',
  personId: 'targetPersonId',
  opportunityId: 'targetOpportunityId',
  signalId: 'targetCommercialSignalId',
  hypothesisId: 'targetCommercialHypothesisId',
};

export interface CreateCrmTaskInput {
  title: string;
  /** Markdown body (Twenty renders it as rich text). */
  body: string;
  /** ISO date-time, or `YYYY-MM-DD` (09:00 Europe/Madrid of that day). Omitted: no due date. */
  dueAt?: string | Date | null | undefined;
  targets?: CrmTaskTargets | undefined;
  status?: TaskStatus;
  /** 'day' (default): same title created the same local day. 'ever': same title, any day. */
  scope?: 'day' | 'ever';
  /**
   * Target that identifies the task among same-title ones (default: the first of company, person,
   * opportunity, signal, hypothesis that is given). The lead follow-up (tanda 21) anchors on the
   * hypothesis: two hypotheses of one company get one task each.
   */
  anchor?: keyof CrmTaskTargets;
}

export interface CreateCrmTaskResult {
  taskId: string;
  title: string;
  created: boolean;
  /** True when an orphan task (same title, no targets) was adopted. */
  adopted: boolean;
  dueAt: string | null;
  targetIds: string[];
}

/** Title as stored: filter values cannot carry quotes or backslashes, so they are dropped. */
export function crmTaskTitle(title: string): string {
  const t = title.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
  return t.length <= CRM_TASK_TITLE_MAX ? t : `${t.slice(0, CRM_TASK_TITLE_MAX - 1)}…`;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function crmTaskLocalDay(date: Date, timeZone = CRM_TASK_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** `YYYY-MM-DD` plus `days` (calendar arithmetic). */
export function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Due date as ISO: a plain day becomes 09:00 local time of that day (DST aware). */
export function crmTaskDueAt(due: string | Date | null | undefined, timeZone = CRM_TASK_TIMEZONE): string | null {
  if (due === null || due === undefined) return null;
  if (due instanceof Date) return due.toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return new Date(localMidnight(due, timeZone).getTime() + CRM_TASK_DUE_HOUR * 3_600_000).toISOString();
  const t = Date.parse(due);
  if (Number.isNaN(t)) throw new Error(`invalid task due date: ${due}`);
  return new Date(t).toISOString();
}

/** Due date `days` local days after `now` (09:00 Europe/Madrid). */
export function dueInDays(now: Date, days: number, timeZone = CRM_TASK_TIMEZONE): string {
  return crmTaskDueAt(addCalendarDays(crmTaskLocalDay(now, timeZone), days), timeZone)!;
}

function targetEntries(targets: CrmTaskTargets | undefined, anchor?: keyof CrmTaskTargets): Array<[keyof TwentyTaskTarget, string]> {
  const out: Array<[keyof TwentyTaskTarget, string]> = [];
  for (const [key, column] of Object.entries(TARGET_COLUMN) as Array<[keyof CrmTaskTargets, keyof TwentyTaskTarget]>) {
    const v = targets?.[key];
    if (typeof v === 'string' && v.length > 0) out.push([column, v]);
  }
  // The anchor goes first: it is the target a same-title task must already point to.
  const at = anchor ? out.findIndex(([column]) => column === TARGET_COLUMN[anchor]) : -1;
  if (at > 0) out.unshift(...out.splice(at, 1));
  return out;
}

async function targetsOf(twenty: TwentyClient, taskId: string, signal?: AbortSignal): Promise<TwentyTaskTarget[]> {
  const { records } = await twenty.list<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { filter: `taskId[eq]:${filterValue(taskId)}`, limit: 50, ...(signal ? { signal } : {}) });
  return records;
}

/**
 * Creates the task (status TODO by default) and its taskTargets, or returns today's task with the
 * same title (see the module comment). Throws on Twenty errors: callers that must never fail
 * (internal services) catch and record the error.
 */
export async function createCrmTask(
  twenty: TwentyClient,
  input: CreateCrmTaskInput,
  opts: { now?: Date; signal?: AbortSignal; timeZone?: string } = {},
): Promise<CreateCrmTaskResult> {
  const signal = opts.signal ? { signal: opts.signal } : {};
  const tz = opts.timeZone ?? CRM_TASK_TIMEZONE;
  const now = opts.now ?? new Date();
  const title = crmTaskTitle(input.title);
  if (title.length === 0) throw new Error('task title is empty');
  const wanted = targetEntries(input.targets, input.anchor);
  const today = crmTaskLocalDay(now, tz);

  // 1. Same title (today, or ever): reuse the one already on the first target, or adopt an orphan.
  const { records: sameTitle } = await twenty.list<TwentyTask>(TWENTY_OBJECTS.task, { filter: `title[eq]:${filterValue(title)}`, limit: 20, ...signal });
  const candidates = sameTitle.filter(
    (t) => crmTaskTitle(t.title ?? '') === title && (input.scope === 'ever' || (t.createdAt ? crmTaskLocalDay(new Date(t.createdAt), tz) === today : false)),
  );
  let task: TwentyTask | null = null;
  let existingTargets: TwentyTaskTarget[] = [];
  let orphan: TwentyTask | null = null;
  for (const candidate of candidates) {
    const t = wanted.length > 0 ? await targetsOf(twenty, candidate.id, opts.signal) : [];
    if (wanted.length === 0 || t.some((x) => x[wanted[0]![0]] === wanted[0]![1])) {
      task = candidate;
      existingTargets = t;
      break;
    }
    if (t.length === 0 && !orphan) orphan = candidate;
  }
  const created = !task && !orphan;
  const adopted = !task && orphan !== null;
  if (!task) task = orphan;

  // 2. New task.
  const dueAt = crmTaskDueAt(input.dueAt, tz);
  if (!task) {
    task = await twenty.create<TwentyTask>(
      TWENTY_OBJECTS.task,
      { title, bodyV2: { markdown: input.body }, status: input.status ?? 'TODO', ...(dueAt ? { dueAt } : {}) },
      signal,
    );
  }

  // 3. Missing targets only.
  const targetIds = existingTargets.map((t) => t.id);
  for (const [column, id] of wanted) {
    if (existingTargets.some((t) => t[column] === id)) continue;
    const row = await twenty.create<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { taskId: task.id, [column]: id }, signal);
    targetIds.push(row.id);
  }
  return { taskId: task.id, title, created, adopted, dueAt: task.dueAt ?? dueAt, targetIds };
}
