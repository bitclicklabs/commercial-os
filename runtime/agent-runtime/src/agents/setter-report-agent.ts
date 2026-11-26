/**
 * SetterReportAgent (`configuration.implementation = "setter_report"`, tanda 24): the weekly
 * summary of the setter as a NOTE in Twenty. Task `setter-weekly-report` (CRON Monday 08:45
 * Europe/Madrid). Deterministic: no LLM call (model provider `stub`, never called); the note and
 * its «Para esta semana» are built by code (src/metrics/setter-report.ts). Level 1: it only reads
 * and writes one internal note; it never sends anything.
 *
 * 1. The reported week: the previous Monday-Sunday (local), or the week of `input.week_of`.
 * 2. Already reported (`audit_log` `metrics.setter_weekly`, subject the Monday) -> SKIPPED
 *    `already_reported`, nothing read or written. `dry_run` skips this check.
 * 3. The metrics of the week and of the week before (src/metrics/setter.ts): runtime tables
 *    straight from the database, Twenty through the READ tool `read_setter_crm` (each read is a
 *    TOOL step of the trace). Opportunities and overdue tasks are read once (they are «now»).
 * 4. Upcoming meetings: the `opportunity.meeting_detected` marks that start in the next 7 days,
 *    with the company names (`read_setter_crm` company_names).
 * 5. `dry_run: true` -> the note (title + markdown) is returned in the output, nothing is written.
 *    Otherwise `create_report_note` (LOW_WRITE, untargeted, idempotent by title) and the audit mark.
 *    A failure of the mark does not fail the run: the note is found again by title next time.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { recordAudit, type AuditInsert } from '../audit/service.js';
import { localDay } from '../crm/followup.js';
import { normAddress } from '../integrations/twenty/messages.js';
import { meetingConfigFromEnv } from '../meetings/config.js';
import { collectSetterMetrics, mondayOf, setterPeriod, SETTER_TIMEZONE, type SetterDbReader } from '../metrics/setter.js';
import { toolSetterCrm } from '../metrics/setter-crm.js';
import { renderSetterReport, type UpcomingMeeting } from '../metrics/setter-report.js';
import { addDays } from '../metrics/twenty-sync.js';
import { toolError } from '../inbound/suppression-writer.js';
import { ZERO_USAGE } from '../providers/model-provider.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';

export const SETTER_REPORT_IMPLEMENTATION = 'setter_report';
export const SETTER_REPORT_TOOLS = ['read_setter_crm', 'create_report_note'] as const;
export const SETTER_REPORT_AUDIT_ACTION = 'metrics.setter_weekly';
export const SETTER_REPORT_AUDIT_SUBJECT = 'setter_weekly_report';
/** Reads of `read_setter_crm` per run: 2 weeks x (window, prior, replies, origins) + opportunities, tasks, names. */
export const SETTER_REPORT_MAX_READS = 12;

export const SetterReportInput = z
  .object({
    dry_run: z.boolean().default(false),
    /** Any day of the week to report (`YYYY-MM-DD`); default: the previous week. */
    week_of: z.iso.date().optional(),
  })
  .passthrough();

export interface SetterReportAgentDeps {
  db?: Db;
  /** Replaces the database reads of the metrics (unit tests). */
  readDb?: SetterDbReader;
  /** True when the week was already reported (default: `audit_log` on `db`). */
  alreadyReported?: (tenantId: string, monday: string) => Promise<{ noteId: string | null } | null>;
  /** Writes the `metrics.setter_weekly` mark (default: `recordAudit` on `db`). */
  audit?: (row: AuditInsert) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';
const str = (v: unknown, d: string) => (typeof v === 'string' && v.length > 0 ? v : d);

/** Domains of the own mailbox (same rule as the FollowUpAgent): MEETING_INTERNAL_DOMAINS + the IMAP user's domain. */
export function setterOwnDomains(env: NodeJS.ProcessEnv): string[] {
  const imapUser = normAddress(env.IONOS_IMAP_USER ?? '');
  return [...new Set([...meetingConfigFromEnv(env).internalDomains, ...(imapUser ? [imapUser.split('@')[1]!] : [])])];
}

export class SetterReportAgent implements AgentImplementation {
  readonly kind = SETTER_REPORT_IMPLEMENTATION;
  private readonly clock: () => Date;

  constructor(private readonly deps: SetterReportAgentDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private async alreadyReported(tenantId: string, monday: string): Promise<{ noteId: string | null } | null> {
    if (this.deps.alreadyReported) return this.deps.alreadyReported(tenantId, monday);
    if (!this.deps.db) throw new Error('SetterReportAgent requires the runtime database (audit_log)');
    const [row] = await this.deps.db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, SETTER_REPORT_AUDIT_ACTION), eq(auditLog.subjectId, monday), eq(auditLog.result, 'ok')))
      .limit(1);
    if (!row) return null;
    const noteId = (row.payload as Record<string, unknown>).note_id;
    return { noteId: typeof noteId === 'string' ? noteId : null };
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('SetterReportAgent requires a tool executor');
    const tools = ctx.tools;
    const now = this.clock();
    const steps: AgentStep[] = [];
    const env = this.deps.env ?? process.env;
    const timezone = str(ctx.version.configuration.timezone, SETTER_TIMEZONE);

    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        timezone,
        ...body,
        sends_email: false,
        cost: { model: 0, eur: 0, llm_calls: 0 },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - now.getTime() });
      return { output, steps, usage: ZERO_USAGE, modelCost: 0, toolCost: 0 };
    };

    const parsed = SetterReportInput.safeParse(ctx.input ?? {});
    if (!parsed.success) return finish('FAILED', { error: { code: 'INVALID_INPUT', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    const dryRun = parsed.data.dry_run;
    const monday = parsed.data.week_of ? mondayOf(parsed.data.week_of) : addDays(mondayOf(localDay(now, timezone)), -7);
    const week = { from: monday, to: addDays(monday, 7) };
    steps.push({
      type: 'THINK',
      timestamp: new Date(),
      output: { plan: 'already reported (audit_log) -> metrics of the week and the week before (DB + read_setter_crm) -> upcoming meetings -> note by code -> create_report_note + audit', week, dry_run: dryRun },
      latencyMs: 0,
    });

    if (!dryRun) {
      const done = await this.alreadyReported(ctx.tenantId, monday);
      if (done) return finish('SKIPPED', { reason: 'already_reported', week, note_id: done.noteId, message: `El resumen de la semana del ${monday} ya está en Twenty.` });
    }

    const crm = toolSetterCrm(tools, (s) => steps.push(s));
    const ownDomains = setterOwnDomains(env);
    const base = { ...(this.deps.db ? { db: this.deps.db } : {}), ...(this.deps.readDb ? { readDb: this.deps.readDb } : {}), crm, tenantId: ctx.tenantId, now, ownDomains, timezone };
    const shared = { opportunities: await crm.openOpportunities(), overdue: await crm.overdueTasks({ now }) };
    const current = await collectSetterMetrics({ ...base, period: setterPeriod(week.from, week.to, timezone), shared });
    const previous = await collectSetterMetrics({ ...base, period: setterPeriod(addDays(monday, -7), monday, timezone), shared });

    const upcomingRows = current.sources.db.upcomingMeetings;
    const companyIds = [...new Set(upcomingRows.map((m) => m.companyId).filter((c): c is string => c !== null))];
    const names = companyIds.length ? await crm.companyNames({ ids: companyIds }) : null;
    const upcoming: UpcomingMeeting[] = upcomingRows
      .filter((m) => m.startsAt)
      .map((m) => ({ startsAt: m.startsAt!, company: m.companyId && names?.status === 'ok' ? (names.value[m.companyId] ?? null) : null }));

    const note = renderSetterReport({ monday, current: current.metrics, previous: previous.metrics, now, upcoming, timezone });
    const summary = {
      week,
      title: note.title,
      metrics: current.metrics,
      previous_week: previous.metrics,
      upcoming_meetings: upcoming,
    };
    if (dryRun) return finish('SUCCESS', { ...summary, dry_run: true, note: { title: note.title, markdown: note.markdown, written: false } });

    const created = await tools.call('create_report_note', { title: note.title, bodyMarkdown: note.markdown });
    steps.push(created.step);
    if (created.result.status !== 'ok') return finish('FAILED', { ...summary, error: toolError('create_report_note', created.result as { status: string } & Record<string, unknown>) });
    const out = created.result.output as { created: boolean; noteId: string; title: string };

    let auditError: string | null = null;
    const db = this.deps.db;
    const audit = this.deps.audit ?? (db ? async (row: AuditInsert) => void (await recordAudit(db, row)) : null);
    try {
      if (!audit) throw new Error('no audit writer');
      await audit({
        tenantId: ctx.tenantId,
        actor: 'agent',
        actorLabel: ctx.agent.name,
        action: SETTER_REPORT_AUDIT_ACTION,
        subjectType: SETTER_REPORT_AUDIT_SUBJECT,
        subjectId: monday,
        method: 'AGENT',
        route: `agent:${SETTER_REPORT_IMPLEMENTATION}`,
        result: 'ok',
        statusCode: 200,
        payload: {
          note_id: out.noteId,
          note_created: out.created,
          week_from: week.from,
          week_to: week.to,
          primeros_contactos: current.metrics.primeros_contactos.total,
          respuestas_humanas: current.metrics.respuestas.humanas,
          reuniones_detectadas: current.metrics.reuniones_detectadas,
          execution_id: ctx.executionId,
        },
      });
    } catch (err) {
      auditError = err instanceof Error ? err.message.slice(0, 200) : 'audit failed';
    }
    return finish('SUCCESS', { ...summary, dry_run: false, note: { id: out.noteId, title: out.title, created: out.created, written: true }, ...(auditError ? { audit_error: auditError } : {}) });
  }
}
