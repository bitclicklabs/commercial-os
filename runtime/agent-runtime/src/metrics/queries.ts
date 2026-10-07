/**
 * Metrics (LLD v0.1 sections 17.2 and 17.3, LLD v0.2 section 11): read-only SQL over the
 * runtime tables. No new stores, no writes. Every query is scoped by `tenant_id` (C6).
 *
 * Conventions:
 * - Cost in EUR per execution: `output.cost.eur` when the agent reports it (Prospector does);
 *   otherwise `total_cost` (model currency, USD for Gemini) times `output.cost.usd_to_eur`
 *   or DEFAULT_USD_TO_EUR. The raw `total_cost` is also returned as `cost_model_currency`.
 * - Cost of a TaskRun = sum of its AgentExecutions (all attempts), as AC-15 asks; the
 *   `task_runs.cost` column only holds the last successful attempt.
 * - Latency of a TaskRun = `finished_at - started_at` (AC-16).
 * - Human acceptance uses the LATEST verdict per subject (subject_type, subject_id): a
 *   hypothesis edited and later discarded counts once, as DISCARDED. `verdicts` counts
 *   every row.
 * - ARCHIVED agents (e.g. the "[TEST] ..." agents of the live tests, archived by
 *   `pnpm cleanup:archive-test-agents`) are hidden from the per-agent table
 *   (/metrics/agents) and the recent runs list (/metrics/runs) unless `includeArchived`.
 *   Their historical runs STILL count in /metrics/summary and /metrics/evaluations.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { countEmailSends } from '../email-ops/sends.js';
import { exceedsTarget, ionosHourlyLimit, WARMUP_END, WARMUP_START, WARMUP_TIMEZONE, warmupDay } from '../email-ops/warmup.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';

export interface Window {
  tenantId: string;
  since?: Date | undefined;
  until?: Date | undefined;
}

/** Per-agent views: ARCHIVED agents are hidden by default. */
export interface AgentFilter {
  includeArchived?: boolean | undefined;
}

/** `and a.status <> 'ARCHIVED'` unless archived agents are requested (alias of `agents`). */
function archivedAgentsWhere(alias: string, f: AgentFilter): SQL {
  return f.includeArchived ? sql`` : sql` and ${sql.raw(alias)}.status <> 'ARCHIVED'`;
}

/** AC-15 and AC-16 thresholds (LLD v0.2 section 11.2, `[PROPUESTA]`). */
export const AC15_MAX_RUN_COST_EUR = 3;
export const AC16_MAX_RUN_DURATION_MS = 30 * 60 * 1000;

type Row = Record<string, unknown>;

async function rows<T extends Row = Row>(db: Db, query: SQL): Promise<T[]> {
  const res = await db.execute(query);
  return res.rows as T[];
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round = (v: number | null, digits = 6): number | null => (v === null ? null : Number(v.toFixed(digits)));
const ratio = (num: number, den: number): number | null => (den > 0 ? round(num / den, 4) : null);
/** Timestamps arrive as Date or as raw PostgreSQL text ("2026-10-07 07:17:54.6+00"); both -> ISO 8601. */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const text = String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** EUR cost of one agent_executions row aliased `e`. */
function execCostEur(alias: string): SQL {
  const e = sql.raw(alias);
  return sql`(case
    when jsonb_typeof(${e}.output->'cost'->'eur') = 'number' then (${e}.output->'cost'->>'eur')::float8
    when ${e}.output->'cost'->>'currency' = 'EUR' then ${e}.total_cost::float8
    when jsonb_typeof(${e}.output->'cost'->'usd_to_eur') = 'number'
      then ${e}.total_cost::float8 * (${e}.output->'cost'->>'usd_to_eur')::float8
    else ${e}.total_cost::float8 * ${DEFAULT_USD_TO_EUR}::float8
  end)`;
}

/** `tenant_id = ... and column >= since and column < until` for the given alias/column. */
function windowWhere(alias: string, column: string, w: Window): SQL {
  const col = sql.raw(`${alias}.${column}`);
  const parts: SQL[] = [sql`${sql.raw(alias)}.tenant_id = ${w.tenantId}`];
  if (w.since) parts.push(sql`${col} >= ${w.since.toISOString()}::timestamptz`);
  if (w.until) parts.push(sql`${col} < ${w.until.toISOString()}::timestamptz`);
  return sql.join(parts, sql` and `);
}

// ---------------------------------------------------------------------------
// Latest human verdict per subject (shared by summary and agents)
// ---------------------------------------------------------------------------
interface FeedbackCounts {
  subjects_reviewed: number;
  verdicts: number;
  accepted: number;
  edited: number;
  discarded: number;
  /** ACCEPTED / (ACCEPTED + EDITED + DISCARDED), latest verdict per subject. */
  acceptance_rate: number | null;
  /** (ACCEPTED + EDITED) / reviewed: AC-20 "utilidad percibida". */
  useful_rate: number | null;
  avg_score: number | null;
}

function feedbackCounts(r: Row | undefined): FeedbackCounts {
  const accepted = n(r?.accepted);
  const edited = n(r?.edited);
  const discarded = n(r?.discarded);
  const reviewed = accepted + edited + discarded;
  return {
    subjects_reviewed: reviewed,
    verdicts: n(r?.verdicts),
    accepted,
    edited,
    discarded,
    acceptance_rate: ratio(accepted, reviewed),
    useful_rate: ratio(accepted + edited, reviewed),
    avg_score: round(nOrNull(r?.avg_score), 4),
  };
}

// ---------------------------------------------------------------------------
// GET /metrics/summary
// ---------------------------------------------------------------------------
export async function metricsSummary(db: Db, w: Window, clock: { now?: Date; timezone?: string } = {}) {
  const runWhere = windowWhere('r', 'created_at', w);
  const runsCte = sql`runs as (
    select r.id, r.task_definition_id, r.status, r.created_at, r.started_at, r.finished_at,
           r.output->>'outcome' as outcome,
           case when r.started_at is not null and r.finished_at is not null
                then extract(epoch from (r.finished_at - r.started_at)) * 1000 end as duration_ms,
           coalesce(x.cost_eur, 0) as cost_eur,
           coalesce(x.cost_raw, 0) as cost_raw,
           coalesce(x.input_tokens, 0) as input_tokens,
           coalesce(x.output_tokens, 0) as output_tokens,
           coalesce(x.cached_tokens, 0) as cached_tokens,
           coalesce(x.executions, 0) as executions
    from task_runs r
    left join lateral (
      select sum(${execCostEur('e')}) as cost_eur, sum(e.total_cost::float8) as cost_raw,
             sum(e.input_tokens) as input_tokens, sum(e.output_tokens) as output_tokens,
             sum(e.cached_tokens) as cached_tokens, count(*) as executions
      from agent_executions e where e.task_run_id = r.id and e.tenant_id = r.tenant_id
    ) x on true
    where ${runWhere}
  )`;

  const [totals] = await rows(
    db,
    sql`with ${runsCte}
    select count(*) as runs,
           sum(executions) as executions,
           sum(cost_eur) as cost_eur, avg(cost_eur) as avg_cost_eur, max(cost_eur) as max_cost_eur,
           sum(cost_raw) as cost_raw,
           sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(cached_tokens) as cached_tokens,
           avg(duration_ms) as avg_ms,
           percentile_cont(0.95) within group (order by duration_ms) as p95_ms,
           max(duration_ms) as max_ms,
           count(*) filter (where cost_eur > ${AC15_MAX_RUN_COST_EUR}) as over_cost,
           count(*) filter (where duration_ms > ${AC16_MAX_RUN_DURATION_MS}) as over_duration,
           count(duration_ms) as timed_runs
    from runs`,
  );
  const byStatus = await rows(db, sql`with ${runsCte} select status, count(*) as n from runs group by status order by status`);
  const byOutcome = await rows(
    db,
    sql`with ${runsCte} select coalesce(outcome, 'NONE') as outcome, count(*) as n from runs group by 1 order by 1`,
  );
  const byTask = await rows(
    db,
    sql`with ${runsCte}
    select t.id, t.name, count(*) as runs,
           count(*) filter (where r.status = 'COMPLETED') as completed,
           count(*) filter (where r.status in ('FAILED', 'TIMED_OUT')) as failed,
           sum(r.cost_eur) as cost_eur, avg(r.cost_eur) as avg_cost_eur,
           avg(r.duration_ms) as avg_ms, max(r.created_at) as last_run_at
    from runs r join task_definitions t on t.id = r.task_definition_id
    group by t.id, t.name order by count(*) desc, t.name`,
  );
  // Funnel: sum of every numeric key of output.counters (Prospector run summaries).
  const counters = await rows(
    db,
    sql`with ${runsCte}
    select c.key, sum((c.value #>> '{}')::float8) as total, count(distinct r.id) as runs
    from runs r join task_runs tr on tr.id = r.id
    cross join lateral jsonb_each(case when jsonb_typeof(tr.output->'counters') = 'object' then tr.output->'counters' else '{}'::jsonb end) c
    where jsonb_typeof(c.value) = 'number'
    group by c.key order by c.key`,
  );
  const [direct] = await rows(
    db,
    sql`select count(*) as executions, sum(${execCostEur('e')}) as cost_eur
    from agent_executions e where e.task_run_id is null and ${windowWhere('e', 'created_at', w)}`,
  );
  const [feedback] = await rows(
    db,
    sql`with latest as (
      select distinct on (ev.subject_type, ev.subject_id) ev.feedback, ev.score
      from evaluations ev where ${windowWhere('ev', 'occurred_at', w)}
      order by ev.subject_type, ev.subject_id, ev.occurred_at desc, ev.created_at desc
    )
    select (select count(*) from evaluations ev where ${windowWhere('ev', 'occurred_at', w)}) as verdicts,
           count(*) filter (where feedback = 'ACCEPTED') as accepted,
           count(*) filter (where feedback = 'EDITED') as edited,
           count(*) filter (where feedback = 'DISCARDED') as discarded,
           avg(score::float8) as avg_score
    from latest`,
  );
  const [last] = await rows(
    db,
    sql`select r.id, r.status, r.output->>'outcome' as outcome, r.created_at, r.started_at, r.finished_at, t.name as task
    from task_runs r join task_definitions t on t.id = r.task_definition_id
    where ${runWhere} order by r.created_at desc limit 1`,
  );

  const counterMap: Record<string, number> = {};
  for (const c of counters) counterMap[String(c.key)] = n(c.total);
  const runsWithCounters = counters.reduce((m, c) => Math.max(m, n(c.runs)), 0);
  const runCount = n(totals?.runs);
  const hypothesesCreated = counterMap.hypotheses_created ?? 0;
  const costEur = n(totals?.cost_eur);

  return {
    tenant_id: w.tenantId,
    window: { since: w.since?.toISOString() ?? null, until: w.until?.toISOString() ?? null, field: 'task_runs.created_at' },
    runs: {
      total: runCount,
      executions: n(totals?.executions),
      by_status: Object.fromEntries(byStatus.map((r) => [String(r.status), n(r.n)])),
      by_outcome: Object.fromEntries(byOutcome.map((r) => [String(r.outcome), n(r.n)])),
      by_task: byTask.map((t) => ({
        task_definition_id: t.id,
        name: t.name,
        runs: n(t.runs),
        completed: n(t.completed),
        failed: n(t.failed),
        cost_eur: round(n(t.cost_eur)),
        avg_cost_eur: round(nOrNull(t.avg_cost_eur)),
        avg_latency_ms: round(nOrNull(t.avg_ms), 0),
        last_run_at: iso(t.last_run_at),
      })),
    },
    cost: {
      total_eur: round(costEur),
      avg_per_run_eur: round(nOrNull(totals?.avg_cost_eur)),
      max_per_run_eur: round(nOrNull(totals?.max_cost_eur)),
      cost_model_currency: round(n(totals?.cost_raw)),
    },
    tokens: {
      input: n(totals?.input_tokens),
      output: n(totals?.output_tokens),
      cached: n(totals?.cached_tokens),
    },
    latency_ms: {
      runs_measured: n(totals?.timed_runs),
      avg: round(nOrNull(totals?.avg_ms), 0),
      p95: round(nOrNull(totals?.p95_ms), 0),
      max: round(nOrNull(totals?.max_ms), 0),
    },
    funnel: {
      runs_with_counters: runsWithCounters,
      exhibitors: counterMap.exhibitors ?? 0,
      evaluated: counterMap.evaluated ?? 0,
      relevant: counterMap.relevant ?? 0,
      hypotheses_created: hypothesesCreated,
      hypotheses_existing: counterMap.hypotheses_existing ?? 0,
      companies_created: counterMap.companies_created ?? 0,
      errors: counterMap.errors ?? 0,
      counters: counterMap,
    },
    human_feedback: { window_field: 'evaluations.occurred_at', ...feedbackCounts(feedback) },
    direct_executions: { executions: n(direct?.executions), cost_eur: round(n(direct?.cost_eur)) },
    email: await emailMetrics(db, { tenantId: w.tenantId, since: w.since, until: w.until, now: clock.now ?? new Date(), timezone: clock.timezone ?? WARMUP_TIMEZONE }),
    acceptance: {
      ac15_cost_per_run: {
        threshold_eur: AC15_MAX_RUN_COST_EUR,
        max_eur: round(nOrNull(totals?.max_cost_eur)),
        runs_over: n(totals?.over_cost),
      },
      ac16_duration: {
        threshold_ms: AC16_MAX_RUN_DURATION_MS,
        max_ms: round(nOrNull(totals?.max_ms), 0),
        runs_over: n(totals?.over_duration),
      },
      // AC-17 asks for cost per HOT hypothesis; the run summary only counts created hypotheses.
      ac17_cost_per_new_hypothesis_eur: hypothesesCreated > 0 ? round(costEur / hypothesesCreated) : null,
    },
    last_run: last
      ? {
          id: last.id,
          task: last.task,
          status: last.status,
          outcome: last.outcome ?? null,
          created_at: iso(last.created_at),
          started_at: iso(last.started_at),
          finished_at: iso(last.finished_at),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Email block of /metrics/summary (email-ops): sends from Twenty and the warm-up calendar
// ---------------------------------------------------------------------------
/**
 * Day, week and hour are relative to `now` (not to the summary window): the dashboard
 * reads them from any summary call. `sends.in_window` follows since/until.
 */
export async function emailMetrics(db: Db, o: Window & { now: Date; timezone: string }) {
  const counts = await countEmailSends(db, { tenantId: o.tenantId, now: o.now, timezone: o.timezone, since: o.since, until: o.until });
  const day = warmupDay(o.now, o.timezone);
  const exceeded = exceedsTarget(day, counts.today);
  const [emitted] = await rows(
    db,
    sql`select id from events where tenant_id = ${o.tenantId} and idempotency_key = ${`evt:email.warmup_target_exceeded:${day.date}`} limit 1`,
  );
  const hourly = ionosHourlyLimit(day.mailboxAgeDays);
  return {
    source: 'twenty_workflow',
    note: 'Cuenta solo los envíos desde Twenty (email_sends). Suma a mano los del webmail.',
    timezone: o.timezone,
    sends: {
      today: counts.today,
      week: counts.week,
      total: counts.total,
      last_hour: counts.lastHour,
      last_sent_at: counts.lastSentAt,
      in_window: counts.inWindow,
      week_field: 'lunes a domingo',
    },
    warmup: {
      start: WARMUP_START,
      end: WARMUP_END,
      date: day.date,
      stage: day.stage,
      phase: day.phase,
      rest_day: day.restDay,
      target_today: day.target,
      target_per_mailbox: day.targetPerMailbox,
      target_scope: 'total de ambos buzones, por día laborable',
      status: day.target === null ? 'no_target' : exceeded ? 'exceeded' : 'ok',
      exceeded,
      exceeded_event_emitted: Boolean(emitted),
    },
    ionos_limit: {
      per_hour: hourly.perHour,
      basis: hourly.basis,
      mailbox_age_days: day.mailboxAgeDays,
      last_hour: counts.lastHour,
      status: counts.lastHour >= hourly.perHour ? 'reached' : 'ok',
      informative: true,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /metrics/agents
// ---------------------------------------------------------------------------
export async function metricsAgents(db: Db, w: Window & AgentFilter) {
  const exWhere = windowWhere('e', 'created_at', w);
  const includeArchived = Boolean(w.includeArchived);
  const runs = await rows(
    db,
    sql`select a.id as agent_id, a.name as agent_name, a.status as agent_status,
           v.id as version_id, v.version, v.status as version_status, v.model, v.model_provider,
           count(*) as runs,
           count(*) filter (where e.status = 'COMPLETED') as completed,
           count(*) filter (where e.status in ('FAILED', 'TIMED_OUT')) as failed,
           count(*) filter (where e.status = 'CANCELLED') as cancelled,
           count(*) filter (where e.output->>'outcome' = 'SUCCESS') as o_success,
           count(*) filter (where e.output->>'outcome' = 'PARTIAL') as o_partial,
           count(*) filter (where e.output->>'outcome' = 'FAILED') as o_failed,
           sum(${execCostEur('e')}) as cost_eur, avg(${execCostEur('e')}) as avg_cost_eur,
           avg(e.input_tokens + e.output_tokens) as avg_tokens,
           avg(e.latency_ms) as avg_latency_ms,
           max(e.created_at) as last_run_at
    from agent_executions e
    join agents a on a.id = e.agent_id
    left join agent_versions v on v.id = e.agent_version_id
    where ${exWhere}${archivedAgentsWhere('a', w)}
    group by a.id, a.name, a.status, v.id, v.version, v.status, v.model, v.model_provider
    order by a.name, v.version nulls first`,
  );
  // Verdicts on the subjects produced by the executions of the window, by version.
  const verdicts = await rows(
    db,
    sql`with ex as (
      select e.id, e.agent_id, e.agent_version_id from agent_executions e where ${exWhere}
    ),
    linked as (
      select ev.*, ex.agent_id, ex.agent_version_id
      from evaluations ev join ex on ex.id = ev.agent_execution_id
      where ev.tenant_id = ${w.tenantId}
    ),
    latest as (
      select distinct on (subject_type, subject_id) agent_id, agent_version_id, feedback, score
      from linked order by subject_type, subject_id, occurred_at desc, created_at desc
    ),
    totals as (
      select agent_id, agent_version_id, count(*) as verdicts from linked group by 1, 2
    )
    select l.agent_id, l.agent_version_id,
           count(*) filter (where l.feedback = 'ACCEPTED') as accepted,
           count(*) filter (where l.feedback = 'EDITED') as edited,
           count(*) filter (where l.feedback = 'DISCARDED') as discarded,
           avg(l.score::float8) as avg_score,
           max(t.verdicts) as verdicts
    from latest l join totals t on t.agent_id = l.agent_id and t.agent_version_id is not distinct from l.agent_version_id
    group by l.agent_id, l.agent_version_id`,
  );
  const key = (agentId: unknown, versionId: unknown) => `${String(agentId)}|${versionId === null ? '' : String(versionId)}`;
  const byKey = new Map(verdicts.map((v) => [key(v.agent_id, v.agent_version_id), v]));

  const items = runs.map((r) => {
    const runCount = n(r.runs);
    const withOutcome = n(r.o_success) + n(r.o_partial) + n(r.o_failed);
    return {
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      agent_status: r.agent_status,
      agent_version_id: r.version_id ?? null,
      version: nOrNull(r.version),
      version_label: r.version === null || r.version === undefined ? null : `v${String(r.version)}`,
      version_status: r.version_status ?? null,
      model: r.model ?? null,
      model_provider: r.model_provider ?? null,
      runs: runCount,
      by_status: { completed: n(r.completed), failed: n(r.failed), cancelled: n(r.cancelled) },
      completion_rate: ratio(n(r.completed), runCount),
      outcome: {
        success: n(r.o_success),
        partial: n(r.o_partial),
        failed: n(r.o_failed),
        none: runCount - withOutcome,
        success_rate: ratio(n(r.o_success), withOutcome),
      },
      cost_eur: round(n(r.cost_eur)),
      avg_cost_eur: round(nOrNull(r.avg_cost_eur)),
      avg_tokens: round(nOrNull(r.avg_tokens), 0),
      avg_latency_ms: round(nOrNull(r.avg_latency_ms), 0),
      last_run_at: iso(r.last_run_at),
      human_feedback: feedbackCounts(byKey.get(key(r.agent_id, r.version_id ?? null))),
    };
  });
  return {
    tenant_id: w.tenantId,
    window: { since: w.since?.toISOString() ?? null, until: w.until?.toISOString() ?? null, field: 'agent_executions.created_at' },
    include_archived: includeArchived,
    items,
  };
}

// ---------------------------------------------------------------------------
// GET /metrics/evaluations
// ---------------------------------------------------------------------------
export interface EvaluationsOptions extends Window {
  timezone: string;
  subjectLimit: number;
}

export async function metricsEvaluations(db: Db, o: EvaluationsOptions) {
  const where = windowWhere('ev', 'occurred_at', o);
  const days = await rows(
    db,
    sql`select to_char(date_trunc('day', ev.occurred_at at time zone ${o.timezone}), 'YYYY-MM-DD') as day,
           count(*) as verdicts,
           count(*) filter (where ev.feedback = 'ACCEPTED') as accepted,
           count(*) filter (where ev.feedback = 'EDITED') as edited,
           count(*) filter (where ev.feedback = 'DISCARDED') as discarded,
           avg(ev.score::float8) as avg_score
    from evaluations ev where ${where}
    group by 1 order by 1`,
  );
  const bySubjectType = await rows(
    db,
    sql`select ev.subject_type, count(*) as verdicts, count(distinct ev.subject_id) as subjects,
           count(*) filter (where ev.feedback = 'ACCEPTED') as accepted,
           count(*) filter (where ev.feedback = 'EDITED') as edited,
           count(*) filter (where ev.feedback = 'DISCARDED') as discarded,
           count(*) filter (where ev.agent_execution_id is not null) as linked
    from evaluations ev where ${where}
    group by 1 order by 1`,
  );
  const subjects = await rows(
    db,
    sql`with s as (
      select ev.subject_type, ev.subject_id, ev.feedback, ev.score, ev.occurred_at, ev.agent_execution_id,
             row_number() over (partition by ev.subject_type, ev.subject_id order by ev.occurred_at desc, ev.created_at desc) as rn,
             count(*) over (partition by ev.subject_type, ev.subject_id) as verdicts,
             min(ev.occurred_at) over (partition by ev.subject_type, ev.subject_id) as first_at,
             string_agg(ev.feedback, ',') over (partition by ev.subject_type, ev.subject_id order by ev.occurred_at, ev.created_at
                                                rows between unbounded preceding and unbounded following) as history
      from evaluations ev where ${where}
    )
    select subject_type, subject_id, feedback, score, occurred_at, agent_execution_id, verdicts, first_at, history
    from s where rn = 1 order by occurred_at desc limit ${o.subjectLimit}`,
  );
  const [totals] = await rows(
    db,
    sql`select count(*) as verdicts, count(distinct (ev.subject_type, ev.subject_id)) as subjects,
           count(*) filter (where ev.agent_execution_id is not null) as linked,
           count(*) filter (where ev.feedback = 'ACCEPTED') as accepted,
           count(*) filter (where ev.feedback = 'EDITED') as edited,
           count(*) filter (where ev.feedback = 'DISCARDED') as discarded
    from evaluations ev where ${where}`,
  );
  const fb = (r: Row) => ({ ACCEPTED: n(r.accepted), EDITED: n(r.edited), DISCARDED: n(r.discarded) });
  return {
    tenant_id: o.tenantId,
    window: { since: o.since?.toISOString() ?? null, until: o.until?.toISOString() ?? null, field: 'evaluations.occurred_at' },
    timezone: o.timezone,
    totals: {
      verdicts: n(totals?.verdicts),
      subjects: n(totals?.subjects),
      linked_to_execution: n(totals?.linked),
      by_feedback: totals ? fb(totals) : { ACCEPTED: 0, EDITED: 0, DISCARDED: 0 },
    },
    by_day: days.map((d) => ({ day: d.day, verdicts: n(d.verdicts), ...fb(d), avg_score: round(nOrNull(d.avg_score), 4) })),
    by_subject_type: bySubjectType.map((t) => ({
      subject_type: t.subject_type,
      verdicts: n(t.verdicts),
      subjects: n(t.subjects),
      linked_to_execution: n(t.linked),
      by_feedback: fb(t),
    })),
    subjects: subjects.map((s) => ({
      subject_type: s.subject_type,
      subject_id: s.subject_id,
      verdicts: n(s.verdicts),
      latest_feedback: s.feedback,
      latest_score: nOrNull(s.score),
      history: String(s.history ?? '').split(',').filter(Boolean),
      agent_execution_id: s.agent_execution_id ?? null,
      first_at: iso(s.first_at),
      last_at: iso(s.occurred_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /metrics/runs (latest TaskRuns, compact; used by the dashboard)
// ---------------------------------------------------------------------------
export async function recentRuns(db: Db, w: Window & AgentFilter & { limit: number }) {
  const items = await rows(
    db,
    sql`select r.id, r.status, r.output->>'outcome' as outcome, r.created_at, r.started_at, r.finished_at, r.attempts,
           t.name as task, a.name as agent, coalesce(r.agent_version, v.version) as version,
           case when r.started_at is not null and r.finished_at is not null
                then extract(epoch from (r.finished_at - r.started_at)) * 1000 end as duration_ms,
           (select sum(${execCostEur('e')}) from agent_executions e where e.task_run_id = r.id and e.tenant_id = r.tenant_id) as cost_eur
    from task_runs r
    join task_definitions t on t.id = r.task_definition_id
    join agents a on a.id = t.agent_id
    left join agent_versions v on v.id = r.agent_version_id
    where ${windowWhere('r', 'created_at', w)}${archivedAgentsWhere('a', w)}
    order by r.created_at desc limit ${w.limit}`,
  );
  return {
    tenant_id: w.tenantId,
    include_archived: Boolean(w.includeArchived),
    items: items.map((r) => ({
      id: r.id,
      task: r.task,
      agent: r.agent,
      version: nOrNull(r.version),
      status: r.status,
      outcome: r.outcome ?? null,
      attempts: n(r.attempts),
      cost_eur: round(nOrNull(r.cost_eur)),
      duration_ms: round(nOrNull(r.duration_ms), 0),
      created_at: iso(r.created_at),
      finished_at: iso(r.finished_at),
      trace_url: `/task-runs/${String(r.id)}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /skills/:id/canary (src/skills/canary.ts): canary arm vs stable arm
// ---------------------------------------------------------------------------
export interface CanaryArmsOptions {
  tenantId: string;
  skillName: string;
  canaryId: string;
}

/**
 * Same measures as /metrics/agents (executions, outcome, EUR cost, tokens, latency, latest human
 * verdict per subject) plus the automatic evaluations (COMPOSITE and other non-HUMAN rows), for
 * the executions whose trace says THIS canary routed them (`skill_versions[].canary.canary_id`),
 * split by arm. Pinned refs and runs before/after the canary never count.
 */
export async function canaryArmMetrics(db: Db, o: CanaryArmsOptions) {
  const routed = sql`routed as (
    select t.execution_id, sv->'canary'->>'arm' as arm, (sv->>'version')::int as version, sv->>'skill_version_id' as skill_version_id
    from traces t cross join lateral jsonb_array_elements(case when jsonb_typeof(t.skill_versions) = 'array' then t.skill_versions else '[]'::jsonb end) sv
    where t.tenant_id = ${o.tenantId} and sv->>'name' = ${o.skillName} and sv->'canary'->>'canary_id' = ${o.canaryId}
  )`;
  const runs = await rows(
    db,
    sql`with ${routed}
    select r.arm, r.version, r.skill_version_id,
           count(*) as runs,
           count(*) filter (where e.status = 'COMPLETED') as completed,
           count(*) filter (where e.status in ('FAILED', 'TIMED_OUT')) as failed,
           count(*) filter (where e.output->>'outcome' = 'SUCCESS') as o_success,
           count(*) filter (where e.output->>'outcome' = 'PARTIAL') as o_partial,
           count(*) filter (where e.output->>'outcome' = 'FAILED') as o_failed,
           sum(${execCostEur('e')}) as cost_eur, avg(${execCostEur('e')}) as avg_cost_eur,
           avg(e.input_tokens + e.output_tokens) as avg_tokens,
           avg(e.latency_ms) as avg_latency_ms,
           min(e.created_at) as first_run_at, max(e.created_at) as last_run_at
    from routed r join agent_executions e on e.id = r.execution_id and e.tenant_id = ${o.tenantId}
    group by r.arm, r.version, r.skill_version_id
    order by r.arm`,
  );
  const verdicts = await rows(
    db,
    sql`with ${routed},
    linked as (
      select ev.subject_type, ev.subject_id, ev.feedback, ev.score, ev.occurred_at, ev.created_at, r.arm
      from evaluations ev join routed r on r.execution_id = ev.agent_execution_id
      where ev.tenant_id = ${o.tenantId} and ev.kind = 'HUMAN'
    ),
    latest as (
      select distinct on (subject_type, subject_id) arm, feedback, score from linked order by subject_type, subject_id, occurred_at desc, created_at desc
    ),
    totals as (select arm, count(*) as verdicts from linked group by 1)
    select l.arm,
           count(*) filter (where l.feedback = 'ACCEPTED') as accepted,
           count(*) filter (where l.feedback = 'EDITED') as edited,
           count(*) filter (where l.feedback = 'DISCARDED') as discarded,
           avg(l.score::float8) as avg_score,
           max(t.verdicts) as verdicts
    from latest l join totals t on t.arm = l.arm
    group by l.arm`,
  );
  const automatic = await rows(
    db,
    sql`with ${routed}
    select r.arm, ev.evaluator_id, count(*) as n, avg(ev.score::float8) as avg_score
    from evaluations ev join routed r on r.execution_id = ev.agent_execution_id
    where ev.tenant_id = ${o.tenantId} and ev.kind <> 'HUMAN'
    group by r.arm, ev.evaluator_id order by r.arm, ev.evaluator_id`,
  );
  const arm = (name: 'canary' | 'stable') => {
    const r = runs.find((x) => x.arm === name);
    const runCount = n(r?.runs);
    const withOutcome = n(r?.o_success) + n(r?.o_partial) + n(r?.o_failed);
    return {
      arm: name,
      version: nOrNull(r?.version),
      skill_version_id: (r?.skill_version_id as string | undefined) ?? null,
      runs: runCount,
      by_status: { completed: n(r?.completed), failed: n(r?.failed) },
      completion_rate: ratio(n(r?.completed), runCount),
      outcome: { success: n(r?.o_success), partial: n(r?.o_partial), failed: n(r?.o_failed), none: runCount - withOutcome, success_rate: ratio(n(r?.o_success), withOutcome) },
      cost_eur: round(n(r?.cost_eur)),
      avg_cost_eur: round(nOrNull(r?.avg_cost_eur)),
      avg_tokens: round(nOrNull(r?.avg_tokens), 0),
      avg_latency_ms: round(nOrNull(r?.avg_latency_ms), 0),
      first_run_at: iso(r?.first_run_at),
      last_run_at: iso(r?.last_run_at),
      human_feedback: feedbackCounts(verdicts.find((v) => v.arm === name)),
      automatic_evaluations: automatic
        .filter((a) => a.arm === name)
        .map((a) => ({ evaluator_id: a.evaluator_id, evaluations: n(a.n), avg_score: round(nOrNull(a.avg_score), 4) })),
    };
  };
  const canary = arm('canary');
  const stable = arm('stable');
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : round(a - b, 6));
  const totalRuns = canary.runs + stable.runs;
  return {
    tenant_id: o.tenantId,
    canary_id: o.canaryId,
    source: 'traces.skill_versions[].canary (solo ejecuciones enrutadas por este canario)',
    observed_canary_share: ratio(canary.runs, totalRuns),
    arms: { canary, stable },
    delta_canary_minus_stable: {
      completion_rate: delta(canary.completion_rate, stable.completion_rate),
      success_rate: delta(canary.outcome.success_rate, stable.outcome.success_rate),
      avg_cost_eur: delta(canary.avg_cost_eur, stable.avg_cost_eur),
      avg_latency_ms: delta(canary.avg_latency_ms, stable.avg_latency_ms),
      acceptance_rate: delta(canary.human_feedback.acceptance_rate, stable.human_feedback.acceptance_rate),
      useful_rate: delta(canary.human_feedback.useful_rate, stable.human_feedback.useful_rate),
    },
  };
}
