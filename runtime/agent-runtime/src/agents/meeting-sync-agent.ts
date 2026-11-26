/**
 * MeetingSyncAgent (`configuration.implementation = "meeting_sync"`, tanda 22): detects the
 * meetings the salesperson booked with a prospect. Task `meeting-sync` (CRON every 30 minutes,
 * Europe/Madrid). Level 1 of autonomy: the calendar is only READ; no event is created and no
 * invitation is sent.
 *
 * 1. `list_calendar_events` (READ): the events of the synced calendar from 1 day back to 60 days
 *    ahead. Without a synced calendar channel the run ends SKIPPED (`no_calendar_channel`) at cost
 *    zero, without reading anything else; an unreadable calendar (the API key's role cannot read
 *    the calendar objects) ends SKIPPED too (`calendar_unreadable`).
 * 2. `list_open_opportunities` (READ) and the matching by participant (src/meetings/match.ts):
 *    point of contact, People of the company, or company domain (never a free-mail domain).
 * 3. `audit_log` (`opportunity.meeting_detected`): the (opportunity, meeting) pairs already
 *    detected are skipped forever (a note or task deleted by hand is not recreated, an opportunity
 *    moved back by a person is not moved forward again for the same meeting).
 * 4. Per opportunity, ONE meeting per run (the next one to come, else the latest past one):
 *    `mark_opportunity_meeting` (LOW_WRITE) writes the 📅 note and moves it to the meeting stage
 *    ONLY from an earlier stage; then `create_crm_task` «Preparar reunión con <empresa> 🧾», due the
 *    working day before (not for a meeting that already happened); then the audit row and the
 *    domain event `opportunity.meeting_detected`.
 *
 * Tanda 24 — «Ficha previa» (`configuration.meeting_brief.enabled`; absent = the deterministic v1):
 * 5. For a meeting still to come, BEFORE the task: `get_meeting_brief_context` (READ) + the thread
 *    with the contact (`list_crm_messages`, READ) + ONE LLM call (skill `meeting-brief`, drafting
 *    role of the model router, knowledge `email` + `prospeccion`). The closed JSON is validated by
 *    code (src/meetings/meeting-brief.ts) and rendered as the section «Ficha previa» of the task
 *    body (appended with `append_crm_task_section` when the task already existed). Model failure,
 *    no data or over the cap -> the minimal brief by code with «ficha completa no disponible:
 *    <motivo>»: the detection is NEVER blocked by the brief. Mark `opportunity.meeting_brief`.
 * 6. Every pass, for the meetings with a brief that are still to come: ONE batch read of the
 *    mailbox; an opportunity with emails newer than the last one considered gets, at most once a
 *    day, a section «Actualización — AAAA-MM-DD» APPENDED at the end of its task (never rewrites
 *    what is there). Mark `opportunity.meeting_brief` (`kind: update`, last message id).
 * 7. Test mode `{ dry_run: true, opportunity_id? }`: writes NOTHING. With `opportunity_id` the
 *    brief of that opportunity is generated (even without a meeting in the calendar, which is not
 *    read) and returned in the output; without it, the meetings that would be detected get their
 *    brief in the output and nothing is marked.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import { localDay, localMinute } from '../crm/followup.js';
import { twentyRecordUrl } from '../crm/reply-task.js';
import type { EventPublisher } from '../events/event-bus.js';
import { FREEMAIL_DOMAINS } from '../inbound/reply-links.js';
import { twentyClientFromEnv } from '../integrations/twenty/index.js';
import { isOwnAddress, normAddress } from '../integrations/twenty/messages.js';
import { useKnowledge } from '../knowledge/resolver.js';
import type { CalendarEventView } from '../meetings/calendar.js';
import { meetingConfigFromEnv } from '../meetings/config.js';
import { externalParticipants, matchMeetings, type MeetingMatch, type OpenOpportunityView } from '../meetings/match.js';
import {
  MEETING_BRIEF_AUDIT_ACTION,
  meetingBriefSection,
  meetingBriefSectionTitle,
  meetingBriefUpdateSection,
  meetingBriefUpdateTitle,
  minimalMeetingBriefSection,
  parseMeetingBrief,
  qualificationLines,
  validateMeetingBrief,
  type BriefContext,
  type BriefEmail,
  type ValidatedBrief,
} from '../meetings/meeting-brief.js';
import {
  MEETING_DETECTED_EVENT,
  MEETING_SYNC_AUDIT_ACTION,
  MEETING_SYNC_AUDIT_SUBJECT,
  MEETING_SYNC_LOOKAHEAD_DAYS,
  MEETING_SYNC_LOOKBACK_DAYS,
  MEETING_SYNC_MAX_PER_RUN,
  MEETING_SYNC_TIMEZONE,
  legacyMeetingTaskTitle,
  meetingTaskBody,
  meetingTaskTitle,
  prepDueDay,
} from '../meetings/meeting-sync.js';
import { detectionKey, DrizzleMeetingSyncStore, type MeetingBriefMark, type MeetingSyncStore } from '../meetings/meeting-store.js';
import { toolError } from '../inbound/suppression-writer.js';
import { defaultModelRouter, isModelRole, type ModelRole, type ModelRouter } from '../providers/model-router.js';
import { useSkill } from '../skills/resolver.js';
import type { ListEmailMessagesOutput, MailMessageView } from '../tools/twenty/followup-tools.js';
import type { AppendCrmTaskSectionOutput, GetMeetingBriefContextOutput } from '../tools/twenty/meeting-brief-tools.js';
import type { ListCalendarEventsOutput, ListOpenOpportunitiesOutput, MarkOpportunityMeetingOutput } from '../tools/twenty/meeting-tools.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';
import {
  buildMeetingBriefPrompt,
  MEETING_BRIEF_EMAIL_MAX,
  MEETING_BRIEF_EMAILS_MAX,
  MEETING_BRIEF_JSON_SCHEMA,
  MEETING_BRIEF_SKILL_ID,
  MEETING_BRIEF_SYSTEM_PROMPT,
  type MeetingBriefMode,
} from './meeting-brief-prompt.js';
import { ProspectorRun, readConfig, round6 } from './prospector-core.js';

export const MEETING_SYNC_IMPLEMENTATION = 'meeting_sync';
/** Tools of tanda 22 (the v1 of the agent, deterministic). */
export const MEETING_SYNC_BASE_TOOLS = ['list_calendar_events', 'list_open_opportunities', 'mark_opportunity_meeting', 'create_crm_task'] as const;
/** Tanda 24: the «Ficha previa» (READ context and mailbox, append-only section of the 🧾 task). */
export const MEETING_BRIEF_TOOLS = ['get_meeting_brief_context', 'list_crm_messages', 'append_crm_task_section'] as const;
export const MEETING_SYNC_TOOLS = [...MEETING_SYNC_BASE_TOOLS, ...MEETING_BRIEF_TOOLS] as const;
/** Briefs (LLM calls: first briefs + updates) per run. */
export const MEETING_BRIEF_MAX_PER_RUN = 10;
/** Days of mailbox read for the first brief. */
export const MEETING_BRIEF_LOOKBACK_DAYS = 180;

export type MeetingSkipReason =
  | 'already_detected'
  | 'other_meeting_this_run'
  | 'at_meeting'
  | 'past_meeting'
  | 'closed'
  | 'unknown_stage'
  | 'no_meeting_stage'
  | 'not_found'
  | 'cap_reached';

export interface MeetingSyncAgentDeps {
  db?: Db;
  store?: MeetingSyncStore;
  /** Writes the `opportunity.meeting_detected` / `opportunity.meeting_brief` audit rows (default: `recordAudit` on `db`). */
  audit?: (row: AuditInsert) => Promise<void>;
  events?: EventPublisher;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Base URL of the Twenty UI for the links of the task (default TWENTY_BASE_URL). */
  twentyBaseUrl?: string;
  /** Tanda 24: resolves the model of the drafting role (default: router over process.env). */
  router?: ModelRouter;
}

/** `configuration.meeting_brief` (tanda 24). Absent (v1 of the agent): no brief. */
export interface MeetingBriefConfig {
  enabled: boolean;
  updates: boolean;
  modelRole: ModelRole;
  model: string | null;
  maxPerRun: number;
  maxAttempts: number;
  maxOutputTokens: number;
  lookbackDays: number;
}

const intIn = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : d);

export function readMeetingBriefConfig(configuration: Record<string, unknown>): MeetingBriefConfig {
  const r = (configuration.meeting_brief ?? {}) as Record<string, unknown>;
  const role = r.model_role;
  return {
    enabled: r.enabled === true,
    updates: r.updates !== false,
    modelRole: isModelRole(role) && role !== 'judge' ? role : 'executor_cheap',
    model: typeof r.model === 'string' && r.model.trim().length > 0 ? r.model.trim() : null,
    maxPerRun: intIn(r.max_per_run, MEETING_BRIEF_MAX_PER_RUN, 0, 50),
    maxAttempts: intIn(r.max_attempts, 2, 1, 3),
    maxOutputTokens: intIn(r.max_output_tokens, 3_072, 512, 8_192),
    lookbackDays: intIn(r.lookback_days, MEETING_BRIEF_LOOKBACK_DAYS, 7, 730),
  };
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';
const DAY = 86_400_000;

interface BriefInfo {
  status: 'full' | 'minimal';
  reason?: string;
  model?: string | null;
  emails: number;
  appended?: boolean;
}

interface Examined {
  opportunity_id: string;
  event_id: string;
  starts_at: string;
  via: MeetingMatch['via'];
  result: 'detected' | 'skipped' | 'would_detect';
  reason?: MeetingSkipReason;
  stage_from?: string | null;
  stage_to?: string | null;
  note_id?: string | null;
  task_id?: string | null;
  task_due?: string | null;
  brief?: BriefInfo;
  /** Dry run: the brief, in full. */
  brief_markdown?: string;
}

interface UpdateExamined {
  opportunity_id: string;
  task_id: string | null;
  result: 'appended' | 'no_new_emails' | 'skipped';
  reason?: string;
  new_emails?: number;
  brief?: BriefInfo;
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.length > 0 ? v : d);

/** Idempotency key of the domain event (bounded: an iCalUID can be long). */
function eventIdempotencyKey(opportunityId: string, eventKey: string): string {
  const k = `evt:${MEETING_DETECTED_EVENT}:${opportunityId}:${eventKey}`;
  return k.length <= 255 ? k : `evt:${MEETING_DETECTED_EVENT}:${opportunityId}:${createHash('sha256').update(eventKey).digest('hex')}`;
}

/** The contacts whose thread is read: the point of contact, else the People of the company with a non-generic address. */
export function briefContacts(o: { pointOfContactEmails: readonly string[]; companyPeople: ReadonlyArray<{ emails: readonly string[] }> }, ownDomains: readonly string[]): string[] {
  if (o.pointOfContactEmails.length > 0) return [...new Set(o.pointOfContactEmails.map((e) => e.toLowerCase()))];
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
  ].slice(0, 20);
}

const toBriefEmail = (m: MailMessageView): BriefEmail => ({ id: m.id, direction: m.direction, subject: m.subject, text: m.text, receivedAt: m.receivedAt, textRestricted: m.textRestricted });

/** The BriefContext of the context tool, or (it failed) of the open opportunity listed. */
function briefContextOf(out: GetMeetingBriefContextOutput | null, view: OpenOpportunityView | null, opportunityId: string): BriefContext {
  if (out?.found && out.opportunity) {
    return {
      opportunity: out.opportunity,
      company: { id: out.company?.id ?? null, name: out.company?.name ?? view?.companyName ?? out.opportunity.name ?? 'la empresa', domain: out.company?.domain ?? null },
      person: out.pointOfContact ? { name: out.pointOfContact.name, jobTitle: out.pointOfContact.jobTitle } : null,
      hypotheses: out.hypotheses,
      qualificationNote: out.qualificationNote,
    };
  }
  return {
    opportunity: { id: view?.id ?? opportunityId, name: view?.name ?? null, stage: view?.stage ?? null, amount: null, closeDate: null },
    company: { id: view?.companyId ?? null, name: view?.companyName ?? view?.name ?? 'la empresa', domain: view?.companyDomain ?? null },
    person: view?.pointOfContactName ? { name: view.pointOfContactName, jobTitle: null } : null,
    hypotheses: (view?.hypotheses ?? []).map((h) => ({ id: h.id, name: h.name, need: null, whyNow: null, origin: null })),
    qualificationNote: null,
  };
}

const amountForPrompt = (a: BriefContext['opportunity']['amount']) => (a ? `${a.value} ${a.currency}` : null);

export class MeetingSyncAgent implements AgentImplementation {
  readonly kind = MEETING_SYNC_IMPLEMENTATION;
  private readonly clock: () => Date;

  constructor(private readonly deps: MeetingSyncAgentDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('MeetingSyncAgent requires a tool executor');
    const tools = ctx.tools;
    const startedAt = this.clock();
    const now = startedAt;
    const steps: AgentStep[] = [];
    const env = this.deps.env ?? process.env;
    const cfgRaw = ctx.version.configuration;
    const timezone = str(cfgRaw.timezone, MEETING_SYNC_TIMEZONE);
    const cfg = meetingConfigFromEnv(env);
    const briefCfg = readMeetingBriefConfig(cfgRaw);
    const allowed = new Set(tools.specs().map((t) => t.name));
    const briefsOn = briefCfg.enabled && allowed.has('get_meeting_brief_context');
    const dryRun = ctx.input.dry_run === true;
    const dryOpportunity = dryRun && typeof ctx.input.opportunity_id === 'string' && ctx.input.opportunity_id.trim().length > 0 ? ctx.input.opportunity_id.trim() : null;
    const today = localDay(now, timezone);
    const llm = new ProspectorRun(ctx, tools, readConfig(cfgRaw), this.clock);
    const imapUser = normAddress(env.IONOS_IMAP_USER ?? '');
    const ownDomains = [...new Set([...cfg.internalDomains, ...(imapUser ? [imapUser.split('@')[1]!] : [])])];
    const counters = {
      events: 0,
      opportunities: 0,
      matches: 0,
      detected: 0,
      stage_moved: 0,
      tasks_created: 0,
      tasks_reused: 0,
      skipped: 0,
      audit_errors: 0,
      briefs_created: 0,
      briefs_failed: 0,
      brief_updates: 0,
    };
    const skippedBy: Partial<Record<MeetingSkipReason, number>> = {};
    const examined: Examined[] = [];
    const updates: UpdateExamined[] = [];
    let mailbox: { status: string; code?: string } | null = null;

    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      const modelCost = round6(llm.modelCost);
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        timezone,
        window: { lookback_days: MEETING_SYNC_LOOKBACK_DAYS, lookahead_days: MEETING_SYNC_LOOKAHEAD_DAYS },
        max_per_run: MEETING_SYNC_MAX_PER_RUN,
        meeting_brief: briefsOn ? { enabled: true, updates: briefCfg.updates, max_per_run: briefCfg.maxPerRun } : { enabled: false },
        ...(dryRun ? { dry_run: true } : {}),
        ...body,
        counters: { ...counters, skipped_by: skippedBy },
        examined,
        ...(updates.length > 0 ? { brief_updates: updates } : {}),
        ...(mailbox ? { mailbox_trace: mailbox } : {}),
        writes_calendar: false,
        sends_email: false,
        cost: { model: modelCost, currency: llm.currency, eur: llm.costEur(), llm_calls: llm.llmCalls },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - startedAt.getTime() });
      return { output, steps, usage: llm.usage, modelCost, toolCost: 0 };
    };

    // -------------------------------------------------------------------------
    // Brief helpers (never throw except on abort; never block the detection)
    // -------------------------------------------------------------------------
    /** Briefs attempted in this run (first briefs with their reads + updates with an LLM call): the cap. */
    let briefTries = 0;
    const briefAttempts = () => briefTries;
    const countTry = () => {
      briefTries += 1;
    };

    const readEmails = async (addresses: string[], since: Date): Promise<Record<string, MailMessageView[]> | null> => {
      if (addresses.length === 0) return {};
      if (!allowed.has('list_crm_messages')) {
        mailbox = { status: 'not_allowed' };
        return null;
      }
      const got = await tools.call('list_crm_messages', { addresses: addresses.slice(0, 500), since: since.toISOString(), ownDomains });
      steps.push(got.step);
      if (got.result.status !== 'ok') {
        const e = toolError('list_crm_messages', got.result as { status: string } & Record<string, unknown>);
        mailbox = { status: 'error', code: String(e.code ?? 'TOOL_ERROR') };
        return null;
      }
      const out = got.result.output as ListEmailMessagesOutput;
      mailbox = out.status === 'ok' ? { status: 'ok' } : { status: out.status, ...(out.error ? { code: out.error.code } : {}) };
      return out.status === 'ok' ? out.byAddress : null;
    };
    const emailsOf = (byAddress: Record<string, MailMessageView[]>, addrs: readonly string[]): BriefEmail[] =>
      [...new Map(addrs.flatMap((a) => byAddress[a] ?? []).map((m) => [m.id, m])).values()].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)).map(toBriefEmail);

    const readContext = async (opportunityId: string, taskId?: string): Promise<{ out: GetMeetingBriefContextOutput | null; error: string | null }> => {
      const got = await tools.call('get_meeting_brief_context', { opportunityId, ...(taskId ? { taskId } : {}) });
      steps.push(got.step);
      if (got.result.status !== 'ok') {
        const e = toolError('get_meeting_brief_context', got.result as { status: string } & Record<string, unknown>);
        return { out: null, error: String(e.code ?? 'TOOL_ERROR') };
      }
      return { out: got.result.output as GetMeetingBriefContextOutput, error: null };
    };

    /** ONE LLM call; null value + reason when it failed. */
    const compose = async (mode: MeetingBriefMode, c: BriefContext, emails: BriefEmail[], meeting: { when: string; title: string | null } | null, label: Record<string, unknown>): Promise<{ value: ValidatedBrief | null; reason: string | null; model: string | null }> => {
      const handed = emails.slice(-MEETING_BRIEF_EMAILS_MAX);
      const model = this.briefModel(ctx, briefCfg);
      const system = useKnowledge(ctx, useSkill(ctx, MEETING_BRIEF_SKILL_ID, MEETING_BRIEF_SYSTEM_PROMPT));
      const call = await llm.completeJson({
        label: { step: 'meeting_brief', mode, ...label },
        system,
        messages: [
          {
            role: 'user',
            content: buildMeetingBriefPrompt({
              today,
              mode,
              meeting,
              company: { name: c.company.name, domain: c.company.domain },
              person: c.person,
              opportunity: { name: c.opportunity.name, stage: c.opportunity.stage, amount: amountForPrompt(c.opportunity.amount), closeDate: c.opportunity.closeDate },
              hypotheses: c.hypotheses.map((h) => ({ name: h.name, need: h.need, whyNow: h.whyNow, origin: h.origin })),
              qualification: qualificationLines(c.qualificationNote).join('\n') || null,
              emails: handed.map((e) => ({ date: localDay(new Date(e.receivedAt), timezone), direction: e.direction === 'INBOUND' ? 'cliente' : 'publiexpe', subject: e.subject, text: e.text })),
            }),
          },
        ],
        parse: parseMeetingBrief(mode),
        schema: MEETING_BRIEF_JSON_SCHEMA,
        maxAttempts: briefCfg.maxAttempts,
        maxTokens: briefCfg.maxOutputTokens,
        model,
      });
      steps.push(...llm.steps.splice(0));
      if (call.status === 'model_error') return { value: null, reason: `error del modelo (${call.code})`, model };
      if (call.status === 'invalid') return { value: null, reason: `la respuesta del modelo no cumplía las reglas (${call.message.slice(0, 160)})`, model };
      return { value: validateMeetingBrief(call.value, handed, { timeZone: timezone, emailTextMax: MEETING_BRIEF_EMAIL_MAX }), reason: null, model };
    };

    /** The first brief of an opportunity: the markdown section, full or minimal. */
    const firstBrief = async (
      opportunityId: string,
      view: OpenOpportunityView | null,
      meeting: { when: string; title: string | null } | null,
    ): Promise<{ markdown: string; marker: string; info: BriefInfo; last: BriefEmail | null; context: BriefContext; json: ValidatedBrief | null; found: boolean }> => {
      const marker = meetingBriefSectionTitle(meeting?.when ?? null);
      const minimal = (c: BriefContext, emails: BriefEmail[], reason: string, model: string | null = null) => {
        counters.briefs_failed += 1;
        return { markdown: minimalMeetingBriefSection(c, emails, { meetingLocal: meeting?.when ?? null, timeZone: timezone, reason }), marker, info: { status: 'minimal' as const, reason, model, emails: emails.length }, last: emails[emails.length - 1] ?? null, context: c, json: null, found: true };
      };
      if (briefAttempts() >= briefCfg.maxPerRun) return minimal(briefContextOf(null, view, opportunityId), [], 'se ha alcanzado el límite de fichas por ejecución');
      countTry();
      try {
        const got = await readContext(opportunityId);
        const c = briefContextOf(got.out, view, opportunityId);
        const found = got.out?.found === true || view !== null;
        const contacts = got.out?.found ? briefContacts({ pointOfContactEmails: got.out.pointOfContact?.emails ?? [], companyPeople: got.out.companyPeople }, ownDomains) : view ? briefContacts(view, ownDomains) : [];
        const byAddress = await readEmails(contacts, new Date(now.getTime() - briefCfg.lookbackDays * DAY));
        const emails = byAddress ? emailsOf(byAddress, contacts) : [];
        if (got.error) return { ...minimal(c, emails, `no se pudo leer el contexto de la oportunidad en el CRM (${got.error})`), found };
        if (!got.out?.found) return { ...minimal(c, emails, 'la oportunidad no existe en el CRM'), found };
        const hasData = emails.length > 0 || c.hypotheses.some((h) => h.need || h.whyNow || h.origin) || qualificationLines(c.qualificationNote).length > 0;
        if (!hasData) return minimal(c, emails, 'no hay correos con el contacto, ni hipótesis, ni datos de cualificación con los que prepararla');
        const r = await compose('ficha', c, emails, meeting, { opportunity_id: opportunityId });
        if (!r.value) return minimal(c, emails, r.reason ?? 'sin motivo', r.model);
        counters.briefs_created += 1;
        return {
          markdown: meetingBriefSection(c, r.value, emails.slice(-MEETING_BRIEF_EMAILS_MAX), { meetingLocal: meeting?.when ?? null, timeZone: timezone }),
          marker,
          info: { status: 'full', model: r.model, emails: emails.length },
          last: emails[emails.length - 1] ?? null,
          context: c,
          json: r.value,
          found: true,
        };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        return minimal(briefContextOf(null, view, opportunityId), [], `error interno (${String((err as Error)?.message ?? err).slice(0, 120)})`);
      }
    };

    const auditRow = (subjectId: string, action: string, payload: Record<string, unknown>): AuditInsert => ({
      tenantId: ctx.tenantId,
      actor: 'agent',
      actorLabel: ctx.agent.name,
      action,
      subjectType: MEETING_SYNC_AUDIT_SUBJECT,
      subjectId,
      method: 'AGENT',
      route: `agent:${MEETING_SYNC_IMPLEMENTATION}`,
      result: 'ok',
      statusCode: 200,
      payload: { ...payload, execution_id: ctx.executionId },
    });

    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      output: {
        plan: dryOpportunity
          ? 'dry run: brief context of the opportunity -> thread with the contact -> brief (LLM) -> output; nothing written'
          : `read calendar (-1d..+60d) -> open opportunities -> match by participant -> already detected (audit_log) -> note + meeting stage (only forward) -> ${briefsOn ? 'brief (context + thread + LLM) -> ' : ''}🧾 task -> audit + event${briefsOn && briefCfg.updates ? ' -> brief updates (new emails, once a day)' : ''}`,
        ...(dryRun ? { dry_run: true } : {}),
      },
      latencyMs: 0,
    });

    // 0. Test mode for ONE opportunity: the brief, nothing written, no calendar.
    if (dryOpportunity) {
      if (!briefCfg.enabled || !allowed.has('get_meeting_brief_context')) return finish('SKIPPED', { reason: 'meeting_brief_disabled', message: 'La ficha previa no está activada en esta versión del agente (configuration.meeting_brief).' });
      const b = await firstBrief(dryOpportunity, null, null);
      if (!b.found) return finish('SKIPPED', { reason: 'opportunity_not_found', opportunity_id: dryOpportunity });
      return finish('SUCCESS', {
        opportunity_id: dryOpportunity,
        brief: { ...b.info, title: meetingTaskTitle(b.context.company.name), markdown: b.markdown, json: b.json ? { ...b.json, datos_cualificacion: qualificationLines(b.context.qualificationNote) } : null, last_message_id: b.last?.id ?? null },
      });
    }

    // 1. Calendar.
    const listed = await tools.call('list_calendar_events', {
      from: new Date(now.getTime() - MEETING_SYNC_LOOKBACK_DAYS * DAY).toISOString(),
      to: new Date(now.getTime() + MEETING_SYNC_LOOKAHEAD_DAYS * DAY).toISOString(),
    });
    steps.push(listed.step);
    if (listed.result.status !== 'ok') return finish('FAILED', { error: toolError('list_calendar_events', listed.result as { status: string } & Record<string, unknown>) });
    const cal = listed.result.output as ListCalendarEventsOutput;
    if (cal.calendar === 'no_channel') {
      return finish('SKIPPED', { reason: 'no_calendar_channel', message: 'No hay ningún calendario sincronizado en Twenty: no se ha revisado nada.' });
    }
    if (cal.calendar === 'unreadable') {
      return finish('SKIPPED', {
        reason: 'calendar_unreadable',
        code: cal.code,
        message: 'La API key del runtime no puede leer los objetos de calendario de Twenty (revisa los permisos del rol «Agent runtime»).',
      });
    }
    const events = cal.events as CalendarEventView[];
    counters.events = events.length;
    const withClients = events.filter((e) => !e.isCanceled && externalParticipants(e, cfg.internalDomains).length > 0);
    if (withClients.length === 0) return finish('SUCCESS', { truncated: cal.truncated, probe: cal.probe });

    // 2. Open opportunities and matching.
    const opps = await tools.call('list_open_opportunities', {});
    steps.push(opps.step);
    if (opps.result.status !== 'ok') return finish('FAILED', { error: toolError('list_open_opportunities', opps.result as { status: string } & Record<string, unknown>) });
    const { opportunities, truncated: oppsTruncated } = opps.result.output as ListOpenOpportunitiesOutput;
    counters.opportunities = opportunities.length;
    const byId = new Map<string, OpenOpportunityView>(opportunities.map((o) => [o.id, o]));
    const eventById = new Map(events.map((e) => [e.id, e]));
    const matches = matchMeetings(withClients, opportunities, cfg.internalDomains);
    counters.matches = matches.length;

    // 3. Already detected (append-only marks).
    const store = this.deps.store ?? (this.deps.db ? new DrizzleMeetingSyncStore(this.deps.db) : null);
    if (!store) throw new Error('MeetingSyncAgent requires the runtime database (audit_log)');
    const db = this.deps.db;
    const audit = this.deps.audit ?? (db ? async (row: AuditInsert) => void (await recordAudit(db, row)) : null);
    const writeAudit = async (row: AuditInsert) => {
      if (!audit) {
        counters.audit_errors += 1;
        return;
      }
      try {
        await audit(row);
      } catch {
        counters.audit_errors += 1;
      }
    };
    const done = await store.alreadyDetected(ctx.tenantId, [...new Set(matches.map((m) => m.opportunityId))]);

    const skip = (e: Examined, reason: MeetingSkipReason) => {
      examined.push({ ...e, result: 'skipped', reason });
      counters.skipped += 1;
      skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
    };

    // 4. One meeting per opportunity and run: the next one to come, else the latest past one.
    const startOf = (m: MeetingMatch) => Date.parse(eventById.get(m.eventId)!.startsAt);
    const endOf = (m: MeetingMatch) => {
      const e = eventById.get(m.eventId)!;
      return e.endsAt ? Date.parse(e.endsAt) : startOf(m);
    };
    const ordered = [...matches].sort((a, b) => {
      const ua = endOf(a) >= now.getTime();
      const ub = endOf(b) >= now.getTime();
      if (ua !== ub) return ua ? -1 : 1;
      return ua ? startOf(a) - startOf(b) : startOf(b) - startOf(a);
    });
    const handled = new Set<string>();
    const baseUrl = this.deps.twentyBaseUrl ?? twentyClientFromEnv(env).baseUrl;
    let failure: Record<string, unknown> | null = null;

    for (const m of ordered) {
      const ev = eventById.get(m.eventId)!;
      const opp = byId.get(m.opportunityId)!;
      const base: Examined = { opportunity_id: m.opportunityId, event_id: m.eventId, starts_at: ev.startsAt, via: m.via, result: 'skipped' };
      if (done.has(detectionKey(m.opportunityId, m.eventKey))) {
        skip(base, 'already_detected');
        continue;
      }
      if (handled.has(m.opportunityId)) {
        skip(base, 'other_meeting_this_run');
        continue;
      }
      if (counters.detected >= MEETING_SYNC_MAX_PER_RUN) {
        skip(base, 'cap_reached');
        continue;
      }
      handled.add(m.opportunityId);
      const start = new Date(ev.startsAt);
      const meeting = { when: localMinute(start, timezone), title: ev.title };

      // Dry run: the brief of the meeting that would be detected; nothing is marked or written.
      if (dryRun) {
        counters.detected += 1;
        const b = briefsOn && start.getTime() > now.getTime() ? await firstBrief(opp.id, opp, meeting) : null;
        examined.push({ ...base, result: 'would_detect', stage_from: opp.stage, ...(b ? { brief: b.info, brief_markdown: b.markdown } : {}) });
        continue;
      }

      const attendees = externalParticipants(ev, cfg.internalDomains).map((p) => (p.displayName && p.handle ? `${p.displayName} <${p.handle}>` : (p.handle ?? p.displayName ?? ''))).filter((a) => a.length > 0);
      const marked = await tools.call('mark_opportunity_meeting', {
        opportunityId: m.opportunityId,
        eventId: ev.id,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        title: ev.title,
        attendees,
        location: ev.location,
        conferenceUrl: ev.conferenceUrl,
        via: m.via,
      });
      steps.push(marked.step);
      if (marked.result.status !== 'ok') {
        failure = { ...toolError('mark_opportunity_meeting', marked.result as { status: string } & Record<string, unknown>), opportunity_id: m.opportunityId };
        break;
      }
      const mark = marked.result.output as MarkOpportunityMeetingOutput;
      if (mark.verdict !== 'advanced' && mark.verdict !== 'resumed') {
        skip({ ...base, stage_from: mark.stageFrom }, mark.verdict);
        continue;
      }
      if (mark.verdict === 'advanced') counters.stage_moved += 1;

      // The preparation task: only for a meeting still to come.
      let taskId: string | null = null;
      let taskDue: string | null = null;
      let brief: Awaited<ReturnType<typeof firstBrief>> | null = null;
      if (start.getTime() > now.getTime()) {
        taskDue = prepDueDay(start, now, timezone);
        const links = [
          ...(opp.companyId ? [{ label: `Empresa (${opp.companyName ?? 'ficha'})`, url: twentyRecordUrl(baseUrl, 'company', opp.companyId) }] : []),
          { label: 'Oportunidad', url: twentyRecordUrl(baseUrl, 'opportunity', opp.id) },
          ...opp.hypotheses.map((h) => ({ label: `Hipótesis${h.name ? ` «${h.name}»` : ''}`, url: twentyRecordUrl(baseUrl, 'commercialHypothesis', h.id) })),
        ];
        // Tanda 24: the «Ficha previa» (never blocks: a failure gives the minimal brief).
        if (briefsOn) brief = await firstBrief(opp.id, opp, meeting);
        const fixed = meetingTaskBody({ startsAt: start, endsAt: ev.endsAt ? new Date(ev.endsAt) : null, title: ev.title, attendees, location: ev.location, conferenceUrl: ev.conferenceUrl, company: opp.companyName ?? opp.name, links, timezone });
        const created = await tools.call('create_crm_task', {
          title: meetingTaskTitle(opp.companyName ?? opp.name),
          // Tanda 23: the task created before the change («🧾 Preparar reunión con …») is reused.
          legacyTitles: [legacyMeetingTaskTitle(opp.companyName ?? opp.name)],
          bodyMarkdown: brief ? `${fixed}\n\n---\n\n${brief.markdown}` : fixed,
          dueAt: taskDue,
          targets: { ...(opp.companyId ? { companyId: opp.companyId } : {}), opportunityId: opp.id },
          anchor: 'opportunityId',
        });
        steps.push(created.step);
        if (created.result.status !== 'ok') {
          failure = { ...toolError('create_crm_task', created.result as { status: string } & Record<string, unknown>), opportunity_id: m.opportunityId };
          break;
        }
        const task = created.result.output as { created: boolean; taskId: string };
        taskId = task.taskId;
        if (task.created) counters.tasks_created += 1;
        else counters.tasks_reused += 1;
        // A reused task (same title today, or the old spelling) gets the brief appended once.
        if (brief) {
          if (task.created) brief.info.appended = false;
          else if (allowed.has('append_crm_task_section')) {
            const app = await tools.call('append_crm_task_section', { taskId: task.taskId, opportunityId: opp.id, marker: brief.marker, markdown: brief.markdown });
            steps.push(app.step);
            brief.info.appended = app.result.status === 'ok' && (app.result.output as AppendCrmTaskSectionOutput).appended;
          }
        }
      }
      counters.detected += 1;
      examined.push({ ...base, result: 'detected', stage_from: mark.stageFrom, stage_to: mark.stageTo, note_id: mark.noteId, task_id: taskId, task_due: taskDue, ...(brief ? { brief: brief.info } : {}) });

      // The «already detected» mark. A failure never fails the run: the note is found again by
      // title, the stage is already moved and the task is reused the same day.
      await writeAudit(
        auditRow(m.opportunityId, MEETING_SYNC_AUDIT_ACTION, {
          event_key: m.eventKey,
          event_id: ev.id,
          starts_at: ev.startsAt,
          via: m.via,
          company_id: opp.companyId,
          stage_from: mark.stageFrom,
          stage_to: mark.stageTo,
          note_id: mark.noteId,
          task_id: taskId,
          task_due: taskDue,
        }),
      );
      // Tanda 24: the brief mark (the base of the «Actualización» sections).
      if (brief && taskId) {
        await writeAudit(
          auditRow(m.opportunityId, MEETING_BRIEF_AUDIT_ACTION, {
            kind: 'initial',
            event_key: m.eventKey,
            event_id: ev.id,
            starts_at: ev.startsAt,
            task_id: taskId,
            day: today,
            status: brief.info.status,
            ...(brief.info.reason ? { reason: brief.info.reason.slice(0, 300) } : {}),
            model: brief.info.model ?? null,
            emails: brief.info.emails,
            last_message_id: brief.last?.id ?? null,
            last_message_at: brief.last?.receivedAt ?? null,
          }),
        );
      }
      // For n8n: ids only, never an address.
      await this.deps.events?.emit({
        tenantId: ctx.tenantId,
        type: MEETING_DETECTED_EVENT,
        correlationId: ctx.executionId,
        idempotencyKey: eventIdempotencyKey(m.opportunityId, m.eventKey),
        data: {
          opportunityId: m.opportunityId,
          companyId: opp.companyId,
          calendarEventId: ev.id,
          startsAt: ev.startsAt,
          stageFrom: mark.stageFrom,
          stageTo: mark.stageTo,
          noteId: mark.noteId,
          taskId,
          via: m.via,
        },
      });
    }

    // 5. Tanda 24: «Actualización — AAAA-MM-DD» of the briefs of meetings still to come.
    if (!failure && !dryRun && briefsOn && briefCfg.updates && store.briefMarks && allowed.has('append_crm_task_section')) {
      try {
        await this.updateBriefs({
          marks: await store.briefMarks(ctx.tenantId, [...byId.keys()]),
          byId,
          eventById,
          handled,
          now,
          today,
          ownDomains,
          readEmails,
          emailsOf,
          readContext,
          compose,
          briefAttempts,
          countTry,
          maxPerRun: briefCfg.maxPerRun,
          timezone,
          steps,
          tools,
          counters,
          updates,
          writeAudit: (subjectId, payload) => writeAudit(auditRow(subjectId, MEETING_BRIEF_AUDIT_ACTION, payload)),
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        updates.push({ opportunity_id: '-', task_id: null, result: 'skipped', reason: `error interno (${String((err as Error)?.message ?? err).slice(0, 120)})` });
      }
    }

    const body = { truncated: cal.truncated || oppsTruncated, probe: cal.probe, ...(failure ? { error: failure } : {}) };
    return finish(failure ? 'FAILED' : 'SUCCESS', body);
  }

  /** Step 5: the «Actualización» sections (one batch mailbox read; at most one per task and day). */
  private async updateBriefs(a: {
    marks: MeetingBriefMark[];
    byId: Map<string, OpenOpportunityView>;
    eventById: Map<string, CalendarEventView>;
    handled: Set<string>;
    now: Date;
    today: string;
    ownDomains: string[];
    readEmails: (addresses: string[], since: Date) => Promise<Record<string, MailMessageView[]> | null>;
    emailsOf: (byAddress: Record<string, MailMessageView[]>, addrs: readonly string[]) => BriefEmail[];
    readContext: (opportunityId: string, taskId?: string) => Promise<{ out: GetMeetingBriefContextOutput | null; error: string | null }>;
    compose: (mode: MeetingBriefMode, c: BriefContext, emails: BriefEmail[], meeting: { when: string; title: string | null } | null, label: Record<string, unknown>) => Promise<{ value: ValidatedBrief | null; reason: string | null; model: string | null }>;
    briefAttempts: () => number;
    countTry: () => void;
    maxPerRun: number;
    timezone: string;
    steps: AgentStep[];
    tools: NonNullable<AgentContext['tools']>;
    counters: { brief_updates: number };
    updates: UpdateExamined[];
    writeAudit: (subjectId: string, payload: Record<string, unknown>) => Promise<void>;
  }): Promise<void> {
    // The initial brief of each (opportunity, meeting) and the last mark of that pair.
    const pairs = new Map<string, { initial: MeetingBriefMark; last: MeetingBriefMark; today: boolean }>();
    for (const m of a.marks) {
      const key = `${m.opportunityId}|${m.eventKey ?? ''}`;
      const p = pairs.get(key);
      if (!p) {
        if (m.kind === 'initial') pairs.set(key, { initial: m, last: m, today: m.day === a.today });
        continue;
      }
      p.last = m;
      if (m.day === a.today) p.today = true;
    }
    const candidates = [...pairs.values()].filter((p) => {
      const ev = p.initial.eventId ? a.eventById.get(p.initial.eventId) : undefined;
      return (
        p.initial.taskId !== null &&
        a.byId.has(p.initial.opportunityId) &&
        !a.handled.has(p.initial.opportunityId) &&
        !p.today &&
        ev !== undefined &&
        !ev.isCanceled &&
        Date.parse(ev.startsAt) > a.now.getTime()
      );
    });
    if (candidates.length === 0) return;
    const sinceOf = (p: { last: MeetingBriefMark }) => (p.last.lastMessageAt ? Date.parse(p.last.lastMessageAt) : p.last.createdAt.getTime());
    const contactsOf = new Map(candidates.map((p) => [p.initial.opportunityId, briefContacts(a.byId.get(p.initial.opportunityId)!, a.ownDomains)]));
    const addresses = [...new Set([...contactsOf.values()].flat())];
    if (addresses.length === 0) return;
    const since = new Date(Math.min(...candidates.map(sinceOf)) - 60_000);
    const byAddress = await a.readEmails(addresses, since);
    if (!byAddress) return;
    for (const p of candidates) {
      const oppId = p.initial.opportunityId;
      const taskId = p.initial.taskId!;
      const after = sinceOf(p);
      const fresh = a.emailsOf(byAddress, contactsOf.get(oppId) ?? []).filter((e) => Date.parse(e.receivedAt) > after && e.id !== p.last.lastMessageId);
      if (fresh.length === 0) {
        a.updates.push({ opportunity_id: oppId, task_id: taskId, result: 'no_new_emails' });
        continue;
      }
      if (a.briefAttempts() >= a.maxPerRun) {
        a.updates.push({ opportunity_id: oppId, task_id: taskId, result: 'skipped', reason: 'cap_reached', new_emails: fresh.length });
        continue;
      }
      a.countTry();
      const last = fresh[fresh.length - 1]!;
      const markPayload = (status: string, extra: Record<string, unknown> = {}) => ({
        kind: 'update',
        event_key: p.initial.eventKey,
        event_id: p.initial.eventId,
        starts_at: p.initial.startsAt,
        task_id: taskId,
        day: a.today,
        status,
        new_emails: fresh.length,
        last_message_id: last.id,
        last_message_at: last.receivedAt,
        ...extra,
      });
      const got = await a.readContext(oppId, taskId);
      if (got.error) {
        a.updates.push({ opportunity_id: oppId, task_id: taskId, result: 'skipped', reason: `context_error:${got.error}`, new_emails: fresh.length });
        continue;
      }
      if (!got.out?.task || !got.out.task.linked || got.out.task.status === 'DONE') {
        // Deleted, unlinked or done by the salesperson: marked, so it is not re-read until a newer email.
        const reason = !got.out?.task ? 'task_missing' : got.out.task.status === 'DONE' ? 'task_done' : 'task_not_linked';
        await a.writeAudit(oppId, markPayload(reason));
        a.updates.push({ opportunity_id: oppId, task_id: taskId, result: 'skipped', reason, new_emails: fresh.length });
        continue;
      }
      const c = briefContextOf(got.out, a.byId.get(oppId) ?? null, oppId);
      const ev = p.initial.eventId ? a.eventById.get(p.initial.eventId) : undefined;
      const meeting = ev ? { when: localMinute(new Date(ev.startsAt), a.timezone), title: ev.title } : null;
      const r = await a.compose('actualizacion', c, fresh, meeting, { opportunity_id: oppId, update: a.today });
      const markdown = meetingBriefUpdateSection(a.today, fresh.slice(-MEETING_BRIEF_EMAILS_MAX), r.value, { timeZone: a.timezone, reason: r.reason, qualificationNote: c.qualificationNote });
      const marker = meetingBriefUpdateTitle(a.today);
      const app = await a.tools.call('append_crm_task_section', { taskId, opportunityId: oppId, marker, markdown });
      a.steps.push(app.step);
      const info: BriefInfo = { status: r.value ? 'full' : 'minimal', ...(r.reason ? { reason: r.reason } : {}), model: r.model, emails: fresh.length };
      if (app.result.status !== 'ok') {
        a.updates.push({ opportunity_id: oppId, task_id: taskId, result: 'skipped', reason: `append_error:${(app.result as { code?: string }).code ?? 'TOOL_ERROR'}`, new_emails: fresh.length, brief: info });
        continue;
      }
      const out = app.result.output as AppendCrmTaskSectionOutput;
      info.appended = out.appended;
      if (out.appended) a.counters.brief_updates += 1;
      await a.writeAudit(oppId, markPayload(out.appended || out.reason === 'already_present' ? info.status : (out.reason ?? 'not_appended'), { model: r.model ?? null, ...(r.reason ? { reason: r.reason.slice(0, 300) } : {}) }));
      a.updates.push({ opportunity_id: oppId, task_id: taskId, result: out.appended ? 'appended' : 'skipped', ...(out.appended ? {} : { reason: out.reason ?? 'not_appended' }), new_emails: fresh.length, brief: info });
    }
  }

  /**
   * Model of the drafting role (model router: MODEL_ROUTE_<ROL>, the pinned `meeting_brief.model`,
   * legacy env, code table). The execution has ONE provider: when the role points to another one,
   * the version's model is used. Stub executions keep their model.
   */
  private briefModel(ctx: AgentContext, rc: MeetingBriefConfig): string {
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
