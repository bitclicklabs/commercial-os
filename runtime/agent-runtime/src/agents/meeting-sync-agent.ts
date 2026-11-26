/**
 * MeetingSyncAgent (`configuration.implementation = "meeting_sync"`, tanda 22): detects the
 * meetings the salesperson booked with a prospect. Task `meeting-sync` (CRON every 30 minutes,
 * Europe/Madrid). Deterministic: no LLM call, model provider `stub`. Level 1 of autonomy: the
 * calendar is only READ; no event is created and no invitation is sent.
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
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import { twentyRecordUrl } from '../crm/reply-task.js';
import type { EventPublisher } from '../events/event-bus.js';
import { twentyClientFromEnv } from '../integrations/twenty/index.js';
import type { CalendarEventView } from '../meetings/calendar.js';
import { meetingConfigFromEnv } from '../meetings/config.js';
import { externalParticipants, matchMeetings, type MeetingMatch, type OpenOpportunityView } from '../meetings/match.js';
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
import { detectionKey, DrizzleMeetingSyncStore, type MeetingSyncStore } from '../meetings/meeting-store.js';
import { toolError } from '../inbound/suppression-writer.js';
import { ZERO_USAGE } from '../providers/model-provider.js';
import type { ListCalendarEventsOutput, ListOpenOpportunitiesOutput, MarkOpportunityMeetingOutput } from '../tools/twenty/meeting-tools.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';

export const MEETING_SYNC_IMPLEMENTATION = 'meeting_sync';
export const MEETING_SYNC_TOOLS = ['list_calendar_events', 'list_open_opportunities', 'mark_opportunity_meeting', 'create_crm_task'] as const;

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
  /** Writes the `opportunity.meeting_detected` audit row (default: `recordAudit` on `db`). */
  audit?: (row: AuditInsert) => Promise<void>;
  events?: EventPublisher;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Base URL of the Twenty UI for the links of the task (default TWENTY_BASE_URL). */
  twentyBaseUrl?: string;
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';
const DAY = 86_400_000;

interface Examined {
  opportunity_id: string;
  event_id: string;
  starts_at: string;
  via: MeetingMatch['via'];
  result: 'detected' | 'skipped';
  reason?: MeetingSkipReason;
  stage_from?: string | null;
  stage_to?: string | null;
  note_id?: string | null;
  task_id?: string | null;
  task_due?: string | null;
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.length > 0 ? v : d);

/** Idempotency key of the domain event (bounded: an iCalUID can be long). */
function eventIdempotencyKey(opportunityId: string, eventKey: string): string {
  const k = `evt:${MEETING_DETECTED_EVENT}:${opportunityId}:${eventKey}`;
  return k.length <= 255 ? k : `evt:${MEETING_DETECTED_EVENT}:${opportunityId}:${createHash('sha256').update(eventKey).digest('hex')}`;
}

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
    const timezone = str(ctx.version.configuration.timezone, MEETING_SYNC_TIMEZONE);
    const cfg = meetingConfigFromEnv(env);
    const counters = { events: 0, opportunities: 0, matches: 0, detected: 0, stage_moved: 0, tasks_created: 0, tasks_reused: 0, skipped: 0, audit_errors: 0 };
    const skippedBy: Partial<Record<MeetingSkipReason, number>> = {};
    const examined: Examined[] = [];

    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        timezone,
        window: { lookback_days: MEETING_SYNC_LOOKBACK_DAYS, lookahead_days: MEETING_SYNC_LOOKAHEAD_DAYS },
        max_per_run: MEETING_SYNC_MAX_PER_RUN,
        ...body,
        counters: { ...counters, skipped_by: skippedBy },
        examined,
        writes_calendar: false,
        sends_email: false,
        cost: { model: 0, eur: 0, llm_calls: 0 },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - startedAt.getTime() });
      return { output, steps, usage: ZERO_USAGE, modelCost: 0, toolCost: 0 };
    };

    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      output: { plan: 'read calendar (-1d..+60d) -> open opportunities -> match by participant -> already detected (audit_log) -> note + meeting stage (only forward) -> 🧾 task -> audit + event' },
      latencyMs: 0,
    });

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
      const start = new Date(ev.startsAt);
      let taskId: string | null = null;
      let taskDue: string | null = null;
      if (start.getTime() > now.getTime()) {
        taskDue = prepDueDay(start, now, timezone);
        const links = [
          ...(opp.companyId ? [{ label: `Empresa (${opp.companyName ?? 'ficha'})`, url: twentyRecordUrl(baseUrl, 'company', opp.companyId) }] : []),
          { label: 'Oportunidad', url: twentyRecordUrl(baseUrl, 'opportunity', opp.id) },
          ...opp.hypotheses.map((h) => ({ label: `Hipótesis${h.name ? ` «${h.name}»` : ''}`, url: twentyRecordUrl(baseUrl, 'commercialHypothesis', h.id) })),
        ];
        const created = await tools.call('create_crm_task', {
          title: meetingTaskTitle(opp.companyName ?? opp.name),
          // Tanda 23: the task created before the change («🧾 Preparar reunión con …») is reused.
          legacyTitles: [legacyMeetingTaskTitle(opp.companyName ?? opp.name)],
          bodyMarkdown: meetingTaskBody({ startsAt: start, endsAt: ev.endsAt ? new Date(ev.endsAt) : null, title: ev.title, attendees, location: ev.location, conferenceUrl: ev.conferenceUrl, company: opp.companyName ?? opp.name, links, timezone }),
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
      }
      counters.detected += 1;
      examined.push({ ...base, result: 'detected', stage_from: mark.stageFrom, stage_to: mark.stageTo, note_id: mark.noteId, task_id: taskId, task_due: taskDue });

      // The «already detected» mark. A failure never fails the run: the note is found again by
      // title, the stage is already moved and the task is reused the same day.
      if (audit) {
        try {
          await audit({
            tenantId: ctx.tenantId,
            actor: 'agent',
            actorLabel: ctx.agent.name,
            action: MEETING_SYNC_AUDIT_ACTION,
            subjectType: MEETING_SYNC_AUDIT_SUBJECT,
            subjectId: m.opportunityId,
            method: 'AGENT',
            route: `agent:${MEETING_SYNC_IMPLEMENTATION}`,
            result: 'ok',
            statusCode: 200,
            payload: {
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
              execution_id: ctx.executionId,
            },
          });
        } catch {
          counters.audit_errors += 1;
        }
      } else counters.audit_errors += 1;
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

    const body = { truncated: cal.truncated || oppsTruncated, probe: cal.probe, ...(failure ? { error: failure } : {}) };
    return finish(failure ? 'FAILED' : 'SUCCESS', body);
  }
}
