/**
 * FollowUpAgent (`configuration.implementation = "lead_followup"`): daily check of the emails that
 * got no answer. Task `lead-followup-check` (CRON 30 8 * * *, Europe/Madrid). Never sends anything:
 * it prepares Tasks with a draft, the commercial sends (autonomy level 1).
 *
 * A. Follow-up SEQUENCE of a hypothesis (tanda 21, sequence tanda 23):
 *    1. `list_sent_hypotheses` (READ): the hypotheses of the tenant with `emailStatus = SENT`.
 *    2. Runtime database (src/crm/followup-store.ts): the sends (`email_sends`), the triaged
 *       messages linked to it or to its company since the first send (`inbound_triage`), and the
 *       touches whose task already exists (`audit_log` `lead.followup_task`, detail `touch`).
 *    3. `list_crm_messages` (READ, tanda 23): the emails Twenty imported from the connected
 *       mailbox with the recipients. A follow-up counts as SENT only if an OUTBOUND email (FROM an
 *       own domain: MEETING_INTERNAL_DOMAINS + the domain of IONOS_IMAP_USER) to the recipient
 *       exists after the first send (and is not the imported copy of a recorded send). Without
 *       that trace (no messages, no permission, tool not in the policy) it degrades to tanda 21:
 *       only the first send counts, so only touch 2 can be created; the output says so.
 *    4. Per hypothesis, oldest first send first, the first reason that applies is `skipped`:
 *       `no_send_record`, `touches_exhausted` (FOLLOWUP_MAX_TOUCHES follow-ups done),
 *       `previous_touch_not_sent` (the task of the previous touch was created but that email was
 *       never sent: its task stays open, no new one), `messages_unavailable` (same, without the
 *       mailbox trace), `too_recent` (fewer than FOLLOWUP_AFTER_BUSINESS_DAYS working days since
 *       the last touch SENT), `bounced`, `replied` (any triaged message except an automatic reply,
 *       or an inbound email in the mailbox), `cap_reached`, `suppression_list_unavailable` (FAILS
 *       CLOSED) and `suppressed`.
 *    5. Otherwise ONE LLM call (skill `email-followup-draft`, mode `recordatorio` or `cierre`,
 *       model of the drafting role of the model router) and `create_crm_task` (LOW_WRITE):
 *       «Seguimiento N — <empresa> 🔔», due the day the touch is due, idempotent `scope: 'ever'`
 *       on the hypothesis (old emoji-first titles recognised); then the audit row with `touch`.
 *       A failed draft never blocks: the task carries the fixed script and «borrador no disponible».
 *
 * B. «Retomar conversación» of an opportunity (tanda 23, PM):
 *    `list_open_opportunities` + `list_opportunity_followup_context` (READ): the OPEN opportunities
 *    in a stage BEFORE the meeting one (stages read from the workspace), their open tasks and their
 *    «Cualificación» note. The thread with the point of contact (or, without one, with the People of
 *    the company with a non-generic address): when its LAST message is OUTBOUND, at least N working
 *    days old, with fewer than FOLLOWUP_MAX_TOUCHES consecutive outbound emails at its end, no open
 *    «Retomar conversación» / «Cerrar reunión» task and no mark for that last outbound message ->
 *    one LLM call (mode `conversacion`) and a Task «Retomar conversación con <empresa> 🔔» due today;
 *    audit `lead.followup_task` with `kind: 'conversation'` and the id of that message.
 *
 * Manual test mode: input `{ dry_run: true, as_of?: 'YYYY-MM-DD' }` writes NOTHING (no task, no
 * audit row) and returns, per hypothesis / opportunity, what it would do, with the full draft.
 *
 * It never writes a hypothesis (the send workflow reads its email fields) and never sends anything.
 */
import type { Db } from '../db/client.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import {
  businessDaysSince,
  CONVERSATION_AUDIT_SUBJECT,
  CONVERSATION_LOOKBACK_DAYS,
  conversationTaskBody,
  conversationTaskTitle,
  detectFollowUps,
  FOLLOWUP_AUDIT_ACTION,
  FOLLOWUP_AUDIT_SUBJECT,
  FOLLOWUP_MAX_TASKS_PER_RUN,
  FOLLOWUP_TIMEZONE,
  followUpAfterBusinessDaysFromEnv,
  followUpDueDay,
  followUpKind,
  followUpLegacyTitles,
  followUpMaxTouchesFromEnv,
  followUpTaskBody,
  followUpTaskTitle,
  isBlockingOpportunityTask,
  isFollowUpDue,
  localDay,
  localMinute,
  planConversation,
  planNextTouch,
  type ConversationMessage,
  type ConversationSkipReason,
  type FollowUpSkipReason,
} from '../crm/followup.js';
import { DrizzleFollowUpStore, type FollowUpSend, type FollowUpStore } from '../crm/followup-store.js';
import { parseRecipients, suppressionMatch } from '../email-ops/recipients.js';
import { titleMatches } from '../email-ops/twenty-io.js';
import { FREEMAIL_DOMAINS } from '../inbound/reply-links.js';
import { meetingParagraph, MEETING_SLOTS_IN_DRAFT } from '../inbound/meeting-paragraph.js';
import { parseSuppressionList, SUPPRESSION_NOTE_TITLE, suppressionNoteId, type SuppressionList } from '../inbound/suppression-list.js';
import { redactNoteStep, toolError } from '../inbound/suppression-writer.js';
import { crmTaskDueAt, legacyEmojiFirstTitle } from '../integrations/twenty/tasks.js';
import { isOwnAddress, normAddress } from '../integrations/twenty/messages.js';
import { useKnowledge } from '../knowledge/resolver.js';
import { meetingConfigFromEnv } from '../meetings/config.js';
import { NULL_AVAILABILITY, type MeetingAvailability, type MeetingProposal } from '../meetings/types.js';
import { defaultModelRouter, isModelRole, type ModelRole, type ModelRouter } from '../providers/model-router.js';
import { useSkill } from '../skills/resolver.js';
import type { ListEmailMessagesOutput, ListOpportunityFollowUpContextOutput, MailMessageView, SentHypothesis } from '../tools/twenty/followup-tools.js';
import type { ListOpenOpportunitiesOutput } from '../tools/twenty/meeting-tools.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';
import { buildFollowUpDraftPrompt, FOLLOWUP_DRAFT_JSON_SCHEMA, FOLLOWUP_DRAFT_SKILL_ID, FOLLOWUP_DRAFT_SYSTEM_PROMPT, type FollowUpDraftMode } from './followup-draft-prompt.js';
import { finalizeFollowUpDraft, followUpDraftSection, parseFollowUpDraft, readableSubject, type FollowUpDraftOutcome } from './followup-draft.js';
import { ProspectorRun, readConfig, round6 } from './prospector-core.js';
import { DEFAULT_REPLY_SENDER, type ReplySender } from './reply-draft.js';

export const FOLLOWUP_IMPLEMENTATION = 'lead_followup';
/** Tools of tanda 21 (the v1 of the agent). */
export const FOLLOWUP_BASE_TOOLS = ['list_sent_hypotheses', 'get_note', 'create_crm_task'] as const;
/** Tanda 23: the mailbox trace and the open opportunities (all READ). */
export const FOLLOWUP_SEQUENCE_TOOLS = ['list_crm_messages', 'list_open_opportunities', 'list_opportunity_followup_context'] as const;
export const FOLLOWUP_TOOLS = [...FOLLOWUP_BASE_TOOLS, ...FOLLOWUP_SEQUENCE_TOOLS] as const;

export interface FollowUpAgentDeps {
  db?: Db;
  store?: FollowUpStore;
  /** Writes the `lead.followup_task` audit row (default: `recordAudit` on `db`). */
  audit?: (row: AuditInsert) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Tanda 23: free slots / booking link for the meeting paragraph of the drafts. */
  availability?: MeetingAvailability;
  /** Tanda 23: resolves the model of the drafting role (default: router over process.env). */
  router?: ModelRouter;
}

/** `configuration.followup_draft` (tanda 23). Absent (v1 of the agent): no draft, fixed script. */
export interface FollowUpDraftConfig {
  enabled: boolean;
  modelRole: ModelRole;
  model: string | null;
  maxPerRun: number;
  maxAttempts: number;
  maxOutputTokens: number;
  slots: number;
  sender: ReplySender;
}

const int = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : d);

export function readFollowUpDraftConfig(configuration: Record<string, unknown>): FollowUpDraftConfig {
  const r = (configuration.followup_draft ?? {}) as Record<string, unknown>;
  const s = (r.sender ?? {}) as Record<string, unknown>;
  const role = r.model_role;
  return {
    enabled: r.enabled === true,
    modelRole: isModelRole(role) && role !== 'judge' ? role : 'executor_cheap',
    model: typeof r.model === 'string' && r.model.trim().length > 0 ? r.model.trim() : null,
    maxPerRun: int(r.max_per_run, FOLLOWUP_MAX_TASKS_PER_RUN, 0, 100),
    maxAttempts: int(r.max_attempts, 2, 1, 3),
    maxOutputTokens: int(r.max_output_tokens, 2_048, 256, 8_192),
    slots: int(r.slots, MEETING_SLOTS_IN_DRAFT, 1, MEETING_SLOTS_IN_DRAFT),
    sender: {
      name: str(s.name, DEFAULT_REPLY_SENDER.name),
      company: str(s.company, DEFAULT_REPLY_SENDER.company),
      descriptor: str(s.descriptor, DEFAULT_REPLY_SENDER.descriptor),
      web: s.web === null ? null : str(s.web, DEFAULT_REPLY_SENDER.web ?? ''),
    },
  };
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';

interface Examined {
  kind: 'sequence' | 'conversation';
  hypothesis_id?: string;
  opportunity_id?: string;
  company: string | null;
  result: 'created' | 'reused' | 'skipped' | 'would_create';
  reason?: FollowUpSkipReason | ConversationSkipReason;
  touch?: number;
  sent_at?: string;
  business_days?: number;
  due_day?: string;
  task_id?: string;
  /** Follow-ups detected in the mailbox (sequence). */
  followups_sent?: Array<{ message_id: string; at: string }>;
  /** Classes of the triaged messages that stopped the follow-up. */
  reply_classes?: string[];
  /** For `no_send_record`: what Twenty does have. */
  hypothesis_updated_at?: string | null;
  last_outbound?: { message_id: string; at: string };
  consecutive_outbound?: number;
  stage?: string | null;
  draft?: { status: 'created' | 'failed' | 'disabled'; reason?: string; model?: string | null };
  /** Dry run: the task it would create, in full. */
  would_create?: { title: string; due_at: string | null; body: string; targets: Record<string, string> };
}

/** Status of the mailbox trace in this run. */
type MailStatus = 'ok' | 'no_messages' | 'unreadable' | 'not_allowed' | 'error' | 'not_needed';

/** 08:30 Europe/Madrid of `day` (the time of the cron). */
function asOfDate(day: string): Date {
  return new Date(Date.parse(crmTaskDueAt(day, FOLLOWUP_TIMEZONE)!) - 30 * 60_000);
}

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
    const steps: AgentStep[] = [];
    const cfg = ctx.version.configuration;
    const env = this.deps.env ?? process.env;
    const dryRun = ctx.input.dry_run === true;
    const asOf = typeof ctx.input.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ctx.input.as_of) && !Number.isNaN(Date.parse(ctx.input.as_of)) ? ctx.input.as_of : null;
    const now = asOf ? asOfDate(asOf) : startedAt;
    const timezone = str(cfg.timezone, FOLLOWUP_TIMEZONE);
    const noteId = suppressionNoteId(cfg.suppression_note_id, env);
    const noteTitle = str(cfg.suppression_note_title, SUPPRESSION_NOTE_TITLE);
    const days = followUpAfterBusinessDaysFromEnv(env);
    const maxTouches = followUpMaxTouchesFromEnv(env);
    const draftCfg = readFollowUpDraftConfig(cfg);
    const conversationsOn = cfg.conversations !== false;
    const today = localDay(now, timezone);
    const llm = new ProspectorRun(ctx, tools, readConfig(cfg), this.clock);
    const counters = {
      sent_hypotheses: 0,
      open_opportunities: 0,
      tasks_created: 0,
      tasks_reused: 0,
      conversation_tasks: 0,
      would_create: 0,
      skipped: 0,
      audit_errors: 0,
      drafts_created: 0,
      drafts_failed: 0,
      /** Threads whose subject / text Twenty masks (`FIELD_RESTRICTED_…`): silences still detected. */
      threads_text_restricted: 0,
    };
    const skippedBy: Partial<Record<FollowUpSkipReason | ConversationSkipReason, number>> = {};
    const examined: Examined[] = [];
    let mail: { status: MailStatus; code?: string; message?: string; truncated?: boolean } = { status: 'not_needed' };

    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      const modelCost = round6(llm.modelCost);
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        after_business_days: days,
        max_touches: maxTouches,
        today,
        timezone,
        dry_run: dryRun,
        ...(asOf ? { as_of: asOf } : {}),
        max_tasks_per_run: FOLLOWUP_MAX_TASKS_PER_RUN,
        mailbox_trace: mail.status === 'ok' || mail.status === 'not_needed' ? { status: mail.status, ...(mail.truncated ? { truncated: true } : {}) } : { ...mail, degraded: true },
        ...body,
        counters: { ...counters, skipped_by: skippedBy },
        examined,
        sends_email: false,
        writes_hypotheses: false,
        cost: { model: modelCost, currency: llm.currency, eur: llm.costEur(), llm_calls: llm.llmCalls },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - startedAt.getTime() });
      return { output, steps, usage: llm.usage, modelCost, toolCost: 0 };
    };

    if (days === 0) {
      const reason = 'Seguimiento desactivado (FOLLOWUP_AFTER_BUSINESS_DAYS=0): no se ha revisado ningún envío.';
      steps.push({ type: 'THINK', timestamp: new Date(), output: { skip: true, reason }, latencyMs: 0 });
      return finish('SKIPPED', { reason });
    }
    if (maxTouches === 0) {
      const reason = 'Sin seguimientos (FOLLOWUP_MAX_TOUCHES=0): no se crea ninguna tarea.';
      steps.push({ type: 'THINK', timestamp: new Date(), output: { skip: true, reason, code: 'max_touches_zero' }, latencyMs: 0 });
      skippedBy.max_touches_zero = 0;
      return finish('SKIPPED', { reason, reason_code: 'max_touches_zero' });
    }
    const store = this.deps.store ?? (this.deps.db ? new DrizzleFollowUpStore(this.deps.db) : null);
    if (!store) throw new Error('FollowUpAgent requires the runtime database (email_sends, inbound_triage, audit_log)');
    const db = this.deps.db;
    const audit = this.deps.audit ?? (db ? async (row: AuditInsert) => void (await recordAudit(db, row)) : null);
    const allowed = new Set(tools.specs().map((t) => t.name));
    const imapUser = normAddress(env.IONOS_IMAP_USER ?? '');
    const ownDomains = [...new Set([...meetingConfigFromEnv(env).internalDomains, ...(imapUser ? [imapUser.split('@')[1]!] : [])])];

    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      output: {
        plan: 'SENT hypotheses -> sends (email_sends) -> touches (audit_log) -> mailbox trace (list_crm_messages) -> next touch -> working days -> replies -> suppression -> draft (LLM) -> create_crm_task + audit; then open opportunities before the meeting stage -> thread -> «retomar conversación»',
        after_business_days: days,
        max_touches: maxTouches,
        today,
        dry_run: dryRun,
        own_domains: ownDomains,
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
    const touchesOf = await store.followUpTouches(ctx.tenantId, ids);
    const recipientsOf = (h: SentHypothesis) => [...new Set([...(sendsOf.get(h.id) ?? []).flatMap((s) => parseRecipients(s.toEmail).valid), ...parseRecipients(h.emailTo).valid].map((r) => r.toLowerCase()))];

    // 3. Open opportunities (tanda 23).
    const conversationTools = conversationsOn && allowed.has('list_open_opportunities') && allowed.has('list_opportunity_followup_context') && allowed.has('list_crm_messages');
    let opportunities: ListOpenOpportunitiesOutput['opportunities'] = [];
    let oppContext = new Map<string, ListOpportunityFollowUpContextOutput['opportunities'][number]>();
    let conversationsError: Record<string, unknown> | null = null;
    if (conversationTools) {
      const opps = await tools.call('list_open_opportunities', {});
      steps.push(opps.step);
      if (opps.result.status === 'ok') {
        opportunities = (opps.result.output as ListOpenOpportunitiesOutput).opportunities.slice(0, 200);
        counters.open_opportunities = opportunities.length;
        if (opportunities.length > 0) {
          const c = await tools.call('list_opportunity_followup_context', { opportunityIds: opportunities.map((o) => o.id) });
          steps.push(c.step);
          if (c.result.status === 'ok') oppContext = new Map((c.result.output as ListOpportunityFollowUpContextOutput).opportunities.map((o) => [o.id, o]));
          else conversationsError = toolError('list_opportunity_followup_context', c.result as { status: string } & Record<string, unknown>);
        }
      } else conversationsError = toolError('list_open_opportunities', opps.result as { status: string } & Record<string, unknown>);
    }
    const contactsOf = (o: ListOpenOpportunitiesOutput['opportunities'][number]): string[] => {
      if (o.pointOfContactEmails.length > 0) return o.pointOfContactEmails.map((e) => e.toLowerCase());
      return [
        ...new Set(
          o.companyPeople
            .flatMap((p) => p.emails)
            .map((e) => e.toLowerCase())
            .filter((e) => {
              const d = e.split('@')[1] ?? '';
              return d.length > 0 && !FREEMAIL_DOMAINS.has(d) && !isOwnAddress(e, ownDomains);
            }),
        ),
      ];
    };

    // 4. Mailbox trace: ONE read for every address of the run.
    const hypAddresses = hypotheses.filter((h) => (sendsOf.get(h.id) ?? []).length > 0).flatMap(recipientsOf);
    const oppAddresses = opportunities.filter((o) => oppContext.get(o.id)?.stageVerdict === 'advance').flatMap(contactsOf);
    const addresses = [...new Set([...hypAddresses, ...oppAddresses])].slice(0, 500);
    let byAddress: Record<string, MailMessageView[]> = {};
    if (addresses.length > 0) {
      if (!allowed.has('list_crm_messages')) mail = { status: 'not_allowed' };
      else {
        const firstSends = sendRows.map((s) => s.sentAt.getTime());
        const lookback = now.getTime() - CONVERSATION_LOOKBACK_DAYS * 86_400_000;
        const since = new Date(Math.min(lookback, ...firstSends) - 60_000);
        const got = await tools.call('list_crm_messages', { addresses, since: since.toISOString(), ownDomains });
        steps.push(got.step);
        if (got.result.status !== 'ok') {
          const e = toolError('list_crm_messages', got.result as { status: string } & Record<string, unknown>);
          mail = { status: 'error', code: String(e.code ?? 'TOOL_ERROR'), message: String(e.message ?? '') };
        } else {
          const out = got.result.output as ListEmailMessagesOutput;
          byAddress = out.byAddress;
          mail = out.status === 'ok' ? { status: 'ok', truncated: out.truncated } : { status: out.status, ...(out.error ? { code: out.error.code, message: out.error.message } : {}) };
        }
      }
    }
    const mailOk = mail.status === 'ok';
    const messagesFor = (addrs: readonly string[]): MailMessageView[] => [...new Map(addrs.flatMap((a) => byAddress[a] ?? []).map((m) => [m.id, m])).values()].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

    let suppression: SuppressionList | null | undefined;
    const loadSuppression = async (): Promise<SuppressionList | null> => {
      if (suppression !== undefined) return suppression;
      const got = await tools.call('get_note', { noteId });
      steps.push(redactNoteStep(got.step));
      const out = got.result.status === 'ok' ? (got.result.output as { found: boolean; note: { title: string | null; markdown: string } | null }) : null;
      suppression = out?.found && out.note && titleMatches(out.note.title ?? '', noteTitle) ? parseSuppressionList(out.note.markdown) : null;
      return suppression;
    };
    const skip = (e: Examined, reason: FollowUpSkipReason | ConversationSkipReason) => {
      examined.push({ ...e, result: 'skipped', reason });
      counters.skipped += 1;
      skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
    };
    const tasksSoFar = () => counters.tasks_created + counters.would_create;

    let proposal: MeetingProposal | undefined;
    const meetingProposal = async (): Promise<MeetingProposal> => {
      if (proposal) return proposal;
      try {
        proposal = await (this.deps.availability ?? NULL_AVAILABILITY).propose({ now: this.clock(), count: draftCfg.slots });
      } catch {
        proposal = await NULL_AVAILABILITY.propose({ now: this.clock(), count: draftCfg.slots });
      }
      return proposal;
    };

    /** ONE LLM call; never throws, never blocks the task. */
    const draft = async (d: {
      mode: FollowUpDraftMode;
      touch: number | null;
      label: Record<string, unknown>;
      company: { name: string; domain: string | null };
      person: { name: string | null; email: string };
      hypothesis: { name: string | null; need: string | null; whyNow: string | null } | null;
      ourEmail: { date: string; subject: string | null; body: string | null } | null;
      clientEmail: { date: string; subject: string | null; body: string | null } | null;
      qualification: string | null;
      previousTouches: Array<{ date: string; subject: string | null }>;
      threadSubject: string | null;
    }): Promise<{ outcome: FollowUpDraftOutcome | null; info: NonNullable<Examined['draft']> }> => {
      if (!draftCfg.enabled) return { outcome: null, info: { status: 'disabled' } };
      const failed = (reason: string, model: string | null = null) => {
        counters.drafts_failed += 1;
        return { outcome: { status: 'failed' as const, reason, mode: d.mode }, info: { status: 'failed' as const, reason, model } };
      };
      if (counters.drafts_created + counters.drafts_failed >= draftCfg.maxPerRun) return failed('se ha alcanzado el límite de borradores por ejecución');
      const p = await meetingProposal();
      const model = this.draftModel(ctx, draftCfg);
      const system = useKnowledge(ctx, useSkill(ctx, FOLLOWUP_DRAFT_SKILL_ID, FOLLOWUP_DRAFT_SYSTEM_PROMPT));
      const call = await llm.completeJson({
        label: { step: 'followup_draft', mode: d.mode, ...d.label },
        system,
        messages: [
          {
            role: 'user',
            content: buildFollowUpDraftPrompt({
              today,
              sender: { name: draftCfg.sender.name, company: draftCfg.sender.company, descriptor: draftCfg.sender.descriptor },
              mode: d.mode,
              touch: d.touch,
              meetingSource: meetingParagraph(p).source,
              company: d.company,
              person: d.person,
              hypothesis: d.hypothesis,
              ourEmail: d.ourEmail,
              clientEmail: d.clientEmail,
              qualification: d.qualification,
              previousTouches: d.previousTouches,
            }),
          },
        ],
        parse: parseFollowUpDraft(d.mode),
        schema: FOLLOWUP_DRAFT_JSON_SCHEMA,
        maxAttempts: draftCfg.maxAttempts,
        maxTokens: draftCfg.maxOutputTokens,
        model,
      });
      steps.push(...llm.steps.splice(0));
      if (call.status === 'model_error') return failed(`error del modelo (${call.code})`, model);
      if (call.status === 'invalid') return failed(`la respuesta del modelo no cumplía las reglas (${call.message.slice(0, 200)})`, model);
      const firstName = d.person.name ? (d.person.name.split(/\s+/)[0] ?? null) : null;
      const final = finalizeFollowUpDraft(call.value, { sender: draftCfg.sender, personFirstName: firstName, companyName: d.company.name, threadSubject: d.threadSubject, proposal: p, timeZone: timezone });
      counters.drafts_created += 1;
      return { outcome: { status: 'created', draft: final, to: d.person.email, mode: d.mode }, info: { status: 'created', model } };
    };

    /** create_crm_task (or, in a dry run, only the plan). Returns false when the run must stop. */
    const createTask = async (
      e: Examined,
      task: { title: string; legacyTitles: string[]; body: string; dueAt: string; targets: Record<string, string>; scope: 'ever' | 'day'; anchor: 'hypothesisId' | 'opportunityId' },
      auditRow: Omit<AuditInsert, 'payload'> & { payload: Record<string, unknown> },
    ): Promise<Record<string, unknown> | null> => {
      if (dryRun) {
        counters.would_create += 1;
        examined.push({ ...e, result: 'would_create', would_create: { title: task.title, due_at: crmTaskDueAt(task.dueAt, timezone), body: task.body, targets: task.targets } });
        return null;
      }
      const created = await tools.call('create_crm_task', {
        title: task.title,
        bodyMarkdown: task.body,
        dueAt: task.dueAt,
        targets: task.targets,
        scope: task.scope,
        anchor: task.anchor,
        ...(task.legacyTitles.length > 0 ? { legacyTitles: task.legacyTitles.slice(0, 4) } : {}),
      });
      steps.push(created.step);
      if (created.result.status !== 'ok') return { ...toolError('create_crm_task', created.result as { status: string } & Record<string, unknown>), ...(e.hypothesis_id ? { hypothesis_id: e.hypothesis_id } : { opportunity_id: e.opportunity_id }) };
      const out = created.result.output as { created: boolean; adopted: boolean; taskId: string; dueAt: string | null };
      if (out.created) counters.tasks_created += 1;
      else counters.tasks_reused += 1;
      if (e.kind === 'conversation' && out.created) counters.conversation_tasks += 1;
      examined.push({ ...e, result: out.created ? 'created' : 'reused', task_id: out.taskId });
      // The «already done» mark (survives a task deleted in Twenty). A failure never fails the run:
      // the same-title search of create_crm_task still prevents a duplicate.
      if (audit) {
        try {
          await audit({ ...auditRow, payload: { ...auditRow.payload, task_id: out.taskId, task_created: out.created, due_at: out.dueAt, execution_id: ctx.executionId } });
        } catch {
          counters.audit_errors += 1;
        }
      } else counters.audit_errors += 1;
      return null;
    };
    const auditBase = (subjectType: string, subjectId: string): Omit<AuditInsert, 'payload'> => ({
      tenantId: ctx.tenantId,
      actor: 'agent',
      actorLabel: ctx.agent.name,
      action: FOLLOWUP_AUDIT_ACTION,
      subjectType,
      subjectId,
      method: 'AGENT',
      route: `agent:${FOLLOWUP_IMPLEMENTATION}`,
      result: 'ok',
      statusCode: 200,
    });

    // 5. Sequence of each hypothesis, oldest first send first; without a send record at the end.
    const ordered = [...hypotheses].sort((a, b) => (sendsOf.get(a.id)?.[0]?.sentAt.getTime() ?? Infinity) - (sendsOf.get(b.id)?.[0]?.sentAt.getTime() ?? Infinity));
    let failure: Record<string, unknown> | null = null;
    for (const h of ordered) {
      const company = h.companyName ?? null;
      const base: Examined = { kind: 'sequence', hypothesis_id: h.id, company, result: 'skipped' };
      const sends = sendsOf.get(h.id) ?? [];
      const first = sends[0];
      const last = sends[sends.length - 1];
      if (!first || !last) {
        skip({ ...base, hypothesis_updated_at: h.updatedAt }, 'no_send_record');
        continue;
      }
      const recipients = recipientsOf(h);
      const mailbox = mailOk ? messagesFor(recipients) : [];
      const followups = detectFollowUps(
        sends.map((s) => s.sentAt),
        mailbox.filter((m) => m.direction === 'OUTBOUND'),
      );
      const history = followups.map((m, i) => ({ message_id: m.id, at: m.receivedAt, touch: i + 2, subject: m.subject }));
      const plan = planNextTouch({ created: touchesOf.get(h.id) ?? new Set(), sent: followups.length, maxTouches });
      const info0: Examined = { ...base, sent_at: first.sentAt.toISOString(), ...(history.length > 0 ? { followups_sent: history.map((x) => ({ message_id: x.message_id, at: x.at })) } : {}) };
      if (plan.status === 'skip') {
        skip(info0, plan.reason === 'previous_touch_not_sent' && !mailOk ? 'messages_unavailable' : plan.reason);
        continue;
      }
      const touch = plan.touch;
      // The clock: touch 2 from the LAST recorded send (a re-send restarts it); then from the last follow-up sent.
      const anchorAt = touch === 2 ? last.sentAt : new Date(followups[followups.length - 1]!.receivedAt);
      const info: Examined = { ...info0, touch, business_days: businessDaysSince(anchorAt, now, timezone), due_day: followUpDueDay(anchorAt, days, timezone) };
      if (!isFollowUpDue(anchorAt, now, days, timezone)) {
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
      // Belt and braces: an email of the recipient in the mailbox after the first send is an answer too.
      const inbound = mailbox.filter((m) => m.direction === 'INBOUND' && Date.parse(m.receivedAt) > first.sentAt.getTime());
      if (cutting.length > 0 || inbound.length > 0) {
        skip({ ...info, reply_classes: [...new Set([...cutting.map((r) => r.class as string), ...(inbound.length > 0 ? ['MAILBOX'] : [])])] }, 'replied');
        continue;
      }
      if (tasksSoFar() >= FOLLOWUP_MAX_TASKS_PER_RUN) {
        skip(info, 'cap_reached');
        continue;
      }
      const list = await loadSuppression();
      if (!list) {
        skip(info, 'suppression_list_unavailable');
        continue;
      }
      if (recipients.some((r) => suppressionMatch(r, list) !== null)) {
        skip(info, 'suppressed');
        continue;
      }

      const name = company ?? h.name;
      const subject = readableSubject(first.subject) ?? readableSubject(h.emailSubject);
      const textRestricted = mailbox.some((m) => m.textRestricted);
      if (textRestricted) counters.threads_text_restricted += 1;
      const to = parseRecipients(first.toEmail).valid.join(', ') || (h.emailTo ?? '');
      const mode = followUpKind(touch, maxTouches);
      const d = await draft({
        mode,
        touch,
        label: { hypothesis_id: h.id, touch },
        company: { name, domain: null },
        person: { name: null, email: parseRecipients(first.toEmail).valid[0] ?? to },
        hypothesis: { name: h.name, need: h.need, whyNow: h.whyNow },
        ourEmail: { date: localMinute(first.sentAt, timezone), subject, body: h.emailBody ?? null },
        clientEmail: null,
        qualification: null,
        previousTouches: history.map((x) => ({ date: localMinute(new Date(x.at), timezone), subject: x.subject })),
        threadSubject: subject,
      });
      const body = followUpTaskBody({
        company: name,
        hypothesisName: h.name,
        sentLocal: localMinute(first.sentAt, timezone),
        timezone,
        subject,
        recipient: to,
        businessDays: info.business_days ?? days,
        need: h.need,
        whyNow: h.whyNow,
        touch,
        maxTouches,
        history: history.map((x) => ({ touch: x.touch, at: localMinute(new Date(x.at), timezone), subject: x.subject })),
        degraded: mailOk ? null : mail.status === 'not_needed' ? null : `${mail.status}${mail.code ? `: ${mail.code}` : ''}`,
        draftSection: d.outcome ? followUpDraftSection(d.outcome) : null,
        textRestricted,
      });
      failure = await createTask(
        { ...info, draft: d.info },
        {
          title: followUpTaskTitle(name, touch),
          legacyTitles: followUpLegacyTitles(name, touch),
          body,
          dueAt: info.due_day ?? today,
          targets: { ...(h.companyId ? { companyId: h.companyId } : {}), hypothesisId: h.id },
          scope: 'ever',
          anchor: 'hypothesisId',
        },
        {
          ...auditBase(FOLLOWUP_AUDIT_SUBJECT, h.id),
          payload: { touch, kind: 'sequence', company_id: h.companyId, first_sent_at: first.sentAt.toISOString(), business_days: info.business_days ?? null, followups_sent: history.map((x) => x.message_id), draft: d.info.status },
        },
      );
      if (failure) break;
    }

    // 6. «Retomar conversación» of the open opportunities before the meeting stage.
    let convMarks = new Map<string, Set<string>>();
    if (!failure && conversationTools && opportunities.length > 0) convMarks = await store.conversationMarks(ctx.tenantId, opportunities.map((o) => o.id));
    for (const o of failure || !conversationTools ? [] : opportunities) {
      const c = oppContext.get(o.id);
      const name = o.companyName ?? o.name ?? 'la empresa';
      const base: Examined = { kind: 'conversation', opportunity_id: o.id, company: o.companyName, result: 'skipped', stage: o.stage };
      if (!c || c.stageVerdict !== 'advance') {
        skip(base, 'stage_not_before_meeting');
        continue;
      }
      const contacts = contactsOf(o);
      if (contacts.length === 0) {
        skip(base, 'no_contacts');
        continue;
      }
      if (!mailOk) {
        skip(base, 'messages_unavailable');
        continue;
      }
      const plan = planConversation(messagesFor(contacts) as ConversationMessage[], now, days, maxTouches, timezone);
      if (plan.status === 'skip') {
        skip(
          {
            ...base,
            ...(plan.lastOutbound ? { last_outbound: { message_id: plan.lastOutbound.id, at: plan.lastOutbound.receivedAt } } : {}),
            ...(plan.consecutiveOutbound !== undefined ? { consecutive_outbound: plan.consecutiveOutbound } : {}),
            ...(plan.businessDays !== undefined ? { business_days: plan.businessDays } : {}),
          },
          plan.reason,
        );
        continue;
      }
      const info: Examined = { ...base, last_outbound: { message_id: plan.lastOutbound.id, at: plan.lastOutbound.receivedAt }, consecutive_outbound: plan.consecutiveOutbound, business_days: plan.businessDays, due_day: today };
      if (convMarks.get(o.id)?.has(plan.lastOutbound.id)) {
        skip(info, 'already_done');
        continue;
      }
      if (c.openTaskTitles.some(isBlockingOpportunityTask)) {
        skip(info, 'open_task');
        continue;
      }
      if (tasksSoFar() >= FOLLOWUP_MAX_TASKS_PER_RUN) {
        skip(info, 'cap_reached');
        continue;
      }
      const list = await loadSuppression();
      if (!list) {
        skip(info, 'suppression_list_unavailable');
        continue;
      }
      if (contacts.some((r) => suppressionMatch(r, list) !== null)) {
        skip(info, 'suppressed');
        continue;
      }
      const to = plan.lastOutbound.threadId ? contacts.find((a) => (byAddress[a] ?? []).some((m) => m.id === plan.lastOutbound.id)) ?? contacts[0]! : contacts[0]!;
      const textRestricted = plan.thread.some((m) => m.textRestricted === true);
      if (textRestricted) counters.threads_text_restricted += 1;
      // «Re: <asunto del hilo>»; masked by Twenty -> the subject of a first send of the company's
      // hypotheses (email_sends / hypothesis); none -> «Seguimiento: <empresa>».
      const hypSubject = o.hypotheses
        .map((x) => readableSubject(sendsOf.get(x.id)?.[0]?.subject) ?? readableSubject(hypotheses.find((y) => y.id === x.id)?.emailSubject))
        .find((s): s is string => s !== null);
      const threadSubject = readableSubject(plan.thread.find((m) => readableSubject(m.subject))?.subject) ?? hypSubject ?? null;
      const d = await draft({
        mode: 'conversacion',
        touch: null,
        label: { opportunity_id: o.id },
        company: { name, domain: o.companyDomain },
        person: { name: o.pointOfContactName, email: to },
        hypothesis: null,
        ourEmail: { date: localMinute(new Date(plan.lastOutbound.receivedAt), timezone), subject: plan.lastOutbound.subject, body: plan.lastOutbound.text },
        clientEmail: plan.lastInbound ? { date: localMinute(new Date(plan.lastInbound.receivedAt), timezone), subject: plan.lastInbound.subject, body: plan.lastInbound.text } : null,
        qualification: c.qualificationNote,
        previousTouches: [],
        threadSubject,
      });
      const body = conversationTaskBody({
        company: name,
        opportunityName: o.name,
        stage: o.stage,
        contact: to,
        timezone,
        businessDays: plan.businessDays,
        consecutiveOutbound: plan.consecutiveOutbound,
        maxTouches,
        lastOutbound: { at: localMinute(new Date(plan.lastOutbound.receivedAt), timezone), subject: plan.lastOutbound.subject },
        lastInbound: plan.lastInbound ? { at: localMinute(new Date(plan.lastInbound.receivedAt), timezone), subject: plan.lastInbound.subject, excerpt: plan.lastInbound.text } : null,
        draftSection: d.outcome ? followUpDraftSection(d.outcome) : null,
        textRestricted,
        hasSubject: threadSubject !== null,
      });
      const title = conversationTaskTitle(name);
      const legacy = legacyEmojiFirstTitle(title);
      failure = await createTask(
        { ...info, draft: d.info },
        { title, legacyTitles: legacy ? [legacy] : [], body, dueAt: today, targets: { ...(o.companyId ? { companyId: o.companyId } : {}), opportunityId: o.id }, scope: 'day', anchor: 'opportunityId' },
        {
          ...auditBase(CONVERSATION_AUDIT_SUBJECT, o.id),
          payload: { kind: 'conversation', last_outbound_message_id: plan.lastOutbound.id, last_outbound_at: plan.lastOutbound.receivedAt, consecutive_outbound: plan.consecutiveOutbound, company_id: o.companyId, business_days: plan.businessDays, draft: d.info.status },
        },
      );
      if (failure) break;
    }

    // Fails closed and loud: a Twenty error stops the run (the next run, or the retry, goes on
    // from where it stopped: everything is idempotent); an unreadable suppression list too.
    if (!failure && skippedBy.suppression_list_unavailable) {
      failure = { code: 'SUPPRESSION_LIST_UNAVAILABLE', message: `no se pudo leer la nota ${noteId} (lista de supresión): no se crea ninguna tarea de seguimiento` };
    }
    const notExamined = hypotheses.length + (conversationTools ? opportunities.length : 0) - examined.length;
    const body = {
      truncated,
      ...(notExamined > 0 ? { not_examined: notExamined } : {}),
      conversations: conversationTools ? 'checked' : conversationsOn ? 'tools_not_allowed' : 'disabled',
      ...(conversationsError ? { conversations_error: conversationsError } : {}),
      ...(failure ? { error: failure } : {}),
    };
    return finish(failure ? 'FAILED' : 'SUCCESS', body);
  }

  /**
   * Model of the drafting role (model router: MODEL_ROUTE_<ROL>, the pinned `followup_draft.model`,
   * legacy env, code table). The execution has ONE provider: when the role points to another one,
   * the version's model is used. Stub executions keep their model.
   */
  private draftModel(ctx: AgentContext, rc: FollowUpDraftConfig): string {
    if (ctx.version.modelProvider === 'stub') return rc.model ?? ctx.version.model;
    try {
      const router = this.deps.router ?? defaultModelRouter(this.deps.env ?? process.env);
      const route = router.resolve(rc.modelRole, rc.model ? { pinned: { provider: ctx.version.modelProvider, model: rc.model } } : {});
      if (route.provider === ctx.version.modelProvider) return route.model;
    } catch {
      // invalid route: the version's model
    }
    return ctx.version.model;
  }
}
