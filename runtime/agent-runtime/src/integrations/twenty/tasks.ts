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
 *
 * Tanda 25: this is the ONLY place that decides «does this Task already exist?». The reply / meeting
 * task of the inbox (src/crm/reply-task.ts) is built on it with `scope: 'open'` (any day, only a task
 * not DONE), `anchor` (the opportunity, else the company, else `'none'`: only an orphan is adopted)
 * and `appendOnReuse` (the only edit ever made: text appended, once, to the body of a reused task).
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
  /**
   * 'day' (default): same title created the same local day. 'ever': same title, any day.
   * 'open' (tanda 25, the reply task): same title, any day, only a task that is not DONE nor deleted.
   */
  scope?: 'day' | 'ever' | 'open';
  /**
   * Target that identifies the task among same-title ones (default: the first of company, person,
   * opportunity, signal, hypothesis that is given). The lead follow-up (tanda 21) anchors on the
   * hypothesis: two hypotheses of one company get one task each.
   * `'none'` (tanda 25, a reply task without opportunity nor company): a same-title task that has
   * targets is never reused; only an orphan (no targets at all) is adopted.
   */
  anchor?: keyof CrmTaskTargets | 'none';
  /**
   * Tanda 23: older spellings of the same title that also count as «the same title» (same scope,
   * anchor and orphan rules). Titles used to start with an emoji, which Twenty draws as a broken
   * icon; they now end with it, and the task created before the change must still be reused.
   * Searched one by one with `title[eq]`, after the current title. A reused task keeps its title.
   */
  legacyTitles?: readonly string[] | undefined;
  /**
   * Tanda 22 / 25: markdown appended to the body when a task is reused or adopted (another reply of
   * the same contact). Append-only (what a person wrote stays) and idempotent: skipped when the
   * body already contains `marker`. Without it a reused task is never edited.
   */
  appendOnReuse?: { markdown: string; marker: string } | null | undefined;
}

/** Trailing emoji of a title (with variation selectors / ZWJ sequences): «Texto 🔔» -> «🔔». */
const TRAILING_EMOJI_RE = /^(.*?\S)\s+((?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*)+)$/u;

/**
 * Tanda 23: the old «emoji first» spelling of a title that now ends with its emoji
 * («Responder a X 📬» -> «📬 Responder a X»); null when the title does not end with an emoji.
 * Pure: the callers pass it as `legacyTitles` so the records created before the change are found.
 */
export function legacyEmojiFirstTitle(title: string): string | null {
  const m = TRAILING_EMOJI_RE.exec(title.trim());
  if (!m) return null;
  return `${m[2]} ${m[1]}`;
}

export interface CreateCrmTaskResult {
  taskId: string;
  title: string;
  created: boolean;
  /** True when an orphan task (same title, no targets) was adopted. */
  adopted: boolean;
  dueAt: string | null;
  targetIds: string[];
  /** Tanda 25: the task record (after the append, if any). */
  task: TwentyTask;
  /** Tanda 25: `appendOnReuse` was given and the reused task got it appended (absent without `appendOnReuse`). */
  appended?: boolean;
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

function targetEntries(targets: CrmTaskTargets | undefined, anchor?: keyof CrmTaskTargets | 'none'): Array<[keyof TwentyTaskTarget, string]> {
  const out: Array<[keyof TwentyTaskTarget, string]> = [];
  for (const [key, column] of Object.entries(TARGET_COLUMN) as Array<[keyof CrmTaskTargets, keyof TwentyTaskTarget]>) {
    const v = targets?.[key];
    if (typeof v === 'string' && v.length > 0) out.push([column, v]);
  }
  // The anchor goes first: it is the target a same-title task must already point to.
  const at = anchor && anchor !== 'none' ? out.findIndex(([column]) => column === TARGET_COLUMN[anchor]) : -1;
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
  const anchored = input.anchor !== 'none';
  const inScope = (t: TwentyTask): boolean =>
    input.scope === 'ever'
      ? true
      : input.scope === 'open'
        ? !t.deletedAt && t.status !== 'DONE'
        : t.createdAt
          ? crmTaskLocalDay(new Date(t.createdAt), tz) === today
          : false;

  // 1. Same title (today, or ever): reuse the one already on the first target, or adopt an orphan.
  //    The current title first, then its older spellings (tanda 23, `legacyTitles`).
  const titles = [title, ...(input.legacyTitles ?? []).map(crmTaskTitle).filter((t) => t.length > 0)].filter((t, i, all) => all.indexOf(t) === i);
  const candidates: TwentyTask[] = [];
  for (const wantedTitle of titles) {
    const { records: sameTitle } = await twenty.list<TwentyTask>(TWENTY_OBJECTS.task, { filter: `title[eq]:${filterValue(wantedTitle)}`, limit: 20, ...signal });
    for (const t of sameTitle) {
      if (candidates.some((c) => c.id === t.id)) continue;
      if (crmTaskTitle(t.title ?? '') !== wantedTitle) continue;
      if (inScope(t)) candidates.push(t);
    }
  }
  let task: TwentyTask | null = null;
  let existingTargets: TwentyTaskTarget[] = [];
  let orphan: TwentyTask | null = null;
  for (const candidate of candidates) {
    const t = wanted.length > 0 || !anchored ? await targetsOf(twenty, candidate.id, opts.signal) : [];
    if (anchored && (wanted.length === 0 || t.some((x) => x[wanted[0]![0]] === wanted[0]![1]))) {
      task = candidate;
      existingTargets = t;
      break;
    }
    if (t.length === 0 && !orphan) orphan = candidate;
  }
  const created = !task && !orphan;
  const adopted = !task && orphan !== null;
  if (!task) task = orphan;

  // 2. New task, or (reused / adopted) the append-only addition to its body.
  const dueAt = crmTaskDueAt(input.dueAt, tz);
  let appended = false;
  if (!task) {
    task = await twenty.create<TwentyTask>(
      TWENTY_OBJECTS.task,
      { title, bodyV2: { markdown: input.body }, status: input.status ?? 'TODO', ...(dueAt ? { dueAt } : {}) },
      signal,
    );
  } else if (input.appendOnReuse) {
    const current = task.bodyV2?.markdown ?? '';
    if (!current.includes(input.appendOnReuse.marker)) {
      const markdown = `${current.replace(/\s+$/, '')}\n\n---\n\n${input.appendOnReuse.markdown}`;
      const updated = await twenty.update<TwentyTask>(TWENTY_OBJECTS.task, task.id, { bodyV2: { markdown } }, signal);
      task = { ...task, ...updated };
      appended = true;
    }
  }

  // 3. Missing targets only.
  const targetIds = existingTargets.map((t) => t.id);
  for (const [column, id] of wanted) {
    if (existingTargets.some((t) => t[column] === id)) continue;
    const row = await twenty.create<TwentyTaskTarget>(TWENTY_OBJECTS.taskTarget, { taskId: task.id, [column]: id }, signal);
    targetIds.push(row.id);
  }
  return { taskId: task.id, title, created, adopted, dueAt: task.dueAt ?? dueAt, targetIds, task, ...(input.appendOnReuse ? { appended } : {}) };
}
