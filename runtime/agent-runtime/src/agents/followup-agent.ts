/**
 * FollowUpAgent (`configuration.implementation = "lead_followup"`, tanda 21): daily check of the
 * first emails that got no answer. Task `lead-followup-check` (CRON 30 8 * * *, Europe/Madrid).
 * Deterministic: no LLM call, model provider `stub`.
 *
 * 1. `list_sent_hypotheses` (READ): the hypotheses of the tenant with `emailStatus = SENT`.
 * 2. Runtime database (src/crm/followup-store.ts): first send of each one (`email_sends`), the
 *    triaged messages linked to it or to its company since the send (`inbound_triage`), and the
 *    hypotheses that already got their follow-up (`audit_log` `lead.followup_task`).
 * 3. Per hypothesis, oldest send first, the first reason that applies is reported as `skipped`:
 *    `task_exists` (already followed up: ONE task per hypothesis, forever, even if deleted in
 *    Twenty), `no_send_record` (SENT in Twenty but no row in email_sends: the webhook never
 *    recorded the send date), `too_recent` (fewer than FOLLOWUP_AFTER_BUSINESS_DAYS working days),
 *    `bounced` (a bounce of that send: a bounce never gets a follow-up), `replied` (any other
 *    triaged message except an automatic reply), `suppressed` (a recipient is in the suppression
 *    list), `suppression_list_unavailable` (the list could not be read: FAILS CLOSED), and
 *    `cap_reached` (FOLLOWUP_MAX_TASKS_PER_RUN tasks already created in this run).
 * 4. Otherwise `create_crm_task` (LOW_WRITE): Task «🔔 Seguimiento — <empresa>», due today
 *    (09:00 local), fixed script, targets company + hypothesis, idempotent `scope: 'ever'` anchored
 *    on the hypothesis; then one audit row `lead.followup_task`.
 *
 * It never writes a hypothesis (the send workflow reads its email fields) and never sends anything.
 */
import type { Db } from '../db/client.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import {
  businessDaysSince,
  FOLLOWUP_AUDIT_ACTION,
  FOLLOWUP_AUDIT_SUBJECT,
  FOLLOWUP_MAX_TASKS_PER_RUN,
  FOLLOWUP_TIMEZONE,
  followUpAfterBusinessDaysFromEnv,
  followUpDueDay,
  followUpTaskBody,
  followUpTaskTitle,
  isFollowUpDue,
  localDay,
  localMinute,
  type FollowUpSkipReason,
} from '../crm/followup.js';
import { DrizzleFollowUpStore, type FollowUpSend, type FollowUpStore } from '../crm/followup-store.js';
import { parseRecipients, suppressionMatch } from '../email-ops/recipients.js';
import { titleMatches } from '../email-ops/twenty-io.js';
import { parseSuppressionList, SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE, type SuppressionList } from '../inbound/suppression-list.js';
import { redactNoteStep, toolError } from '../inbound/suppression-writer.js';
import { ZERO_USAGE } from '../providers/model-provider.js';
import type { SentHypothesis } from '../tools/twenty/followup-tools.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';

export const FOLLOWUP_IMPLEMENTATION = 'lead_followup';
export const FOLLOWUP_TOOLS = ['list_sent_hypotheses', 'get_note', 'create_crm_task'] as const;

export interface FollowUpAgentDeps {
  db?: Db;
  store?: FollowUpStore;
  /** Writes the `lead.followup_task` audit row (default: `recordAudit` on `db`). */
  audit?: (row: AuditInsert) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';

interface Examined {
  hypothesis_id: string;
  company: string | null;
  result: 'created' | 'reused' | 'skipped';
  reason?: FollowUpSkipReason;
  sent_at?: string;
  business_days?: number;
  due_day?: string;
  task_id?: string;
  /** Classes of the triaged messages that stopped the follow-up. */
  reply_classes?: string[];
  /** For `no_send_record`: what Twenty does have. */
  hypothesis_updated_at?: string | null;
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.length > 0 ? v : d);

export class FollowUpAgent implements AgentImplementation {
  readonly kind = FOLLOWUP_IMPLEMENTATION;
  private readonly clock: () => Date;

  constructor(private readonly deps: FollowUpAgentDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('FollowUpAgent requires a tool executor');
    const tools = ctx.tools;
    const startedAt = this.clock();
    const now = startedAt;
    const steps: AgentStep[] = [];
    const cfg = ctx.version.configuration;
    const timezone = str(cfg.timezone, FOLLOWUP_TIMEZONE);
    const noteId = str(cfg.suppression_note_id, SUPPRESSION_NOTE_ID);
    const noteTitle = str(cfg.suppression_note_title, SUPPRESSION_NOTE_TITLE);
    const days = followUpAfterBusinessDaysFromEnv(this.deps.env ?? process.env);
    const today = localDay(now, timezone);
    const counters = { sent_hypotheses: 0, tasks_created: 0, tasks_reused: 0, skipped: 0, audit_errors: 0 };
    const skippedBy: Partial<Record<FollowUpSkipReason, number>> = {};
    const examined: Examined[] = [];

    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        after_business_days: days,
        today,
        timezone,
        max_tasks_per_run: FOLLOWUP_MAX_TASKS_PER_RUN,
        ...body,
        counters: { ...counters, skipped_by: skippedBy },
        examined,
        sends_email: false,
        writes_hypotheses: false,
        cost: { model: 0, eur: 0, llm_calls: 0 },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - startedAt.getTime() });
      return { output, steps, usage: ZERO_USAGE, modelCost: 0, toolCost: 0 };
    };

    if (days === 0) {
      const reason = 'Seguimiento desactivado (FOLLOWUP_AFTER_BUSINESS_DAYS=0): no se ha revisado ningún envío.';
      steps.push({ type: 'THINK', timestamp: new Date(), output: { skip: true, reason }, latencyMs: 0 });
      return finish('SKIPPED', { reason });
    }
    const store = this.deps.store ?? (this.deps.db ? new DrizzleFollowUpStore(this.deps.db) : null);
    if (!store) throw new Error('FollowUpAgent requires the runtime database (email_sends, inbound_triage, audit_log)');
    const db = this.deps.db;
    const audit = this.deps.audit ?? (db ? async (row: AuditInsert) => void (await recordAudit(db, row)) : null);

    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      output: {
        plan: 'list SENT hypotheses -> first send (email_sends) -> already followed up (audit_log) -> working days -> replies (inbound_triage) -> suppression list -> create_crm_task + audit',
        after_business_days: days,
        today,
      },
      latencyMs: 0,
    });

    // 1. SENT hypotheses.
    const listed = await tools.call('list_sent_hypotheses', {});
    steps.push(listed.step);
    if (listed.result.status !== 'ok') return finish('FAILED', { error: toolError('list_sent_hypotheses', listed.result as { status: string } & Record<string, unknown>) });
    const { hypotheses, truncated } = listed.result.output as { hypotheses: SentHypothesis[]; truncated: boolean };
    counters.sent_hypotheses = hypotheses.length;

    // 2. Runtime database.
    const ids = hypotheses.map((h) => h.id);
    const sendRows = await store.sends(ctx.tenantId, ids);
    const sendsOf = new Map<string, FollowUpSend[]>();
    for (const s of sendRows) sendsOf.set(s.hypothesisId, [...(sendsOf.get(s.hypothesisId) ?? []), s]);
    const done = await store.alreadyFollowedUp(ctx.tenantId, ids);
    // Oldest first send first; hypotheses without a send record at the end.
    const ordered = [...hypotheses].sort((a, b) => (sendsOf.get(a.id)?.[0]?.sentAt.getTime() ?? Infinity) - (sendsOf.get(b.id)?.[0]?.sentAt.getTime() ?? Infinity));

    let suppression: SuppressionList | null | undefined;
    const loadSuppression = async (): Promise<SuppressionList | null> => {
      if (suppression !== undefined) return suppression;
      const got = await tools.call('get_note', { noteId });
      steps.push(redactNoteStep(got.step));
      const out = got.result.status === 'ok' ? (got.result.output as { found: boolean; note: { title: string | null; markdown: string } | null }) : null;
      suppression = out?.found && out.note && titleMatches(out.note.title ?? '', noteTitle) ? parseSuppressionList(out.note.markdown) : null;
      return suppression;
    };
    const skip = (e: Examined, reason: FollowUpSkipReason) => {
      examined.push({ ...e, result: 'skipped', reason });
      counters.skipped += 1;
      skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
    };

    let failure: Record<string, unknown> | null = null;
    for (const h of ordered) {
      const company = h.companyName ?? null;
      const base: Examined = { hypothesis_id: h.id, company, result: 'skipped' };
      if (done.has(h.id)) {
        skip(base, 'task_exists');
        continue;
      }
      const sends = sendsOf.get(h.id) ?? [];
      const first = sends[0];
      const last = sends[sends.length - 1];
      if (!first || !last) {
        skip({ ...base, hypothesis_updated_at: h.updatedAt }, 'no_send_record');
        continue;
      }
      const info: Examined = { ...base, sent_at: first.sentAt.toISOString(), business_days: businessDaysSince(last.sentAt, now, timezone), due_day: followUpDueDay(last.sentAt, days, timezone) };
      // The clock starts at the LAST send of the hypothesis (a re-send restarts it).
      if (!isFollowUpDue(last.sentAt, now, days, timezone)) {
        skip(info, 'too_recent');
        continue;
      }
      const companyIds = [h.companyId, ...sends.map((s) => s.companyId)].filter((c): c is string => typeof c === 'string' && c.length > 0);
      const replies = await store.replies(ctx.tenantId, { hypothesisId: h.id, companyIds, since: first.sentAt });
      const cutting = replies.filter((r) => r.class !== 'AUTO_REPLY');
      if (cutting.some((r) => r.class === 'REBOTE')) {
        skip({ ...info, reply_classes: [...new Set(cutting.map((r) => r.class))] }, 'bounced');
        continue;
      }
      if (cutting.length > 0) {
        skip({ ...info, reply_classes: [...new Set(cutting.map((r) => r.class))] }, 'replied');
        continue;
      }
      if (counters.tasks_created >= FOLLOWUP_MAX_TASKS_PER_RUN) {
        skip(info, 'cap_reached');
        continue;
      }
      const list = await loadSuppression();
      if (!list) {
        skip(info, 'suppression_list_unavailable');
        continue;
      }
      const recipients = [...new Set([...sends.flatMap((s) => parseRecipients(s.toEmail).valid), ...parseRecipients(h.emailTo).valid])];
      if (recipients.some((r) => suppressionMatch(r, list) !== null)) {
        skip(info, 'suppressed');
        continue;
      }

      const title = followUpTaskTitle(company ?? h.name);
      const created = await tools.call('create_crm_task', {
        title,
        bodyMarkdown: followUpTaskBody({
          company: company ?? h.name,
          hypothesisName: h.name,
          sentLocal: localMinute(first.sentAt, timezone),
          timezone,
          subject: first.subject ?? h.emailSubject,
          recipient: parseRecipients(first.toEmail).valid.join(', ') || (h.emailTo ?? ''),
          businessDays: info.business_days ?? days,
          need: h.need,
          whyNow: h.whyNow,
        }),
        dueAt: today,
        targets: { ...(h.companyId ? { companyId: h.companyId } : {}), hypothesisId: h.id },
        scope: 'ever',
        anchor: 'hypothesisId',
      });
      steps.push(created.step);
      if (created.result.status !== 'ok') {
        failure = { ...toolError('create_crm_task', created.result as { status: string } & Record<string, unknown>), hypothesis_id: h.id };
        break;
      }
      const task = created.result.output as { created: boolean; adopted: boolean; taskId: string; dueAt: string | null };
      if (task.created) counters.tasks_created += 1;
      else counters.tasks_reused += 1;
      examined.push({ ...info, result: task.created ? 'created' : 'reused', task_id: task.taskId });
      // The «already followed up» mark (survives a task deleted in Twenty). A failure never fails
      // the run: the same-title search of `scope: 'ever'` still prevents a duplicate.
      if (audit) {
        try {
          await audit({
            tenantId: ctx.tenantId,
            actor: 'agent',
            actorLabel: ctx.agent.name,
            action: FOLLOWUP_AUDIT_ACTION,
            subjectType: FOLLOWUP_AUDIT_SUBJECT,
            subjectId: h.id,
            method: 'AGENT',
            route: `agent:${FOLLOWUP_IMPLEMENTATION}`,
            result: 'ok',
            statusCode: 200,
            payload: {
              task_id: task.taskId,
              task_created: task.created,
              company_id: h.companyId,
              first_sent_at: first.sentAt.toISOString(),
              business_days: info.business_days ?? null,
              due_at: task.dueAt,
              execution_id: ctx.executionId,
            },
          });
        } catch {
          counters.audit_errors += 1;
        }
      } else counters.audit_errors += 1;
    }

    // Fails closed and loud: a Twenty error stops the run (the next run, or the retry, goes on
    // from where it stopped: everything is idempotent); an unreadable suppression list too.
    if (!failure && skippedBy.suppression_list_unavailable) {
      failure = { code: 'SUPPRESSION_LIST_UNAVAILABLE', message: `no se pudo leer la nota ${noteId} (lista de supresión): no se crea ninguna tarea de seguimiento` };
    }
    const notExamined = hypotheses.length - examined.length;
    const body = { truncated, ...(notExamined > 0 ? { not_examined: notExamined } : {}), ...(failure ? { error: failure } : {}) };
    return finish(failure ? 'FAILED' : 'SUCCESS', body);
  }
}
