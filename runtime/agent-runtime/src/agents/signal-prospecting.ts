/**
 * Prospector "signals" mode (task `daily-event-prospecting`, input `{ mode: 'signals' }`):
 * the daily run works the fairs the commercial QUALIFIED in Twenty instead of a fixed fair.
 *
 *  1. `list_event_signals`: the event-level commercial signals (no company: a fair or
 *     congress, never the per-exhibitor "<feria> — <empresa>" ones) in NEW, REVIEWING or
 *     QUALIFIED. Only fair-like types (FAIR, CONGRESS, EVENT) with an http(s) source URL count.
 *  2. Ageing first: every one of them whose event date is already past goes to EXPIRED
 *     (`expire_signal`, which re-reads the record and only writes `status`). It is the only
 *     state the machine changes; qualifying and discarding stay human.
 *  3. Of the QUALIFIED ones still ahead (or without a date), the least recently worked one
 *     is chosen (round-robin, see `pickNextSignal`) and the directed scout flow runs on it:
 *     `runScout` with `{ event_url, event_name, max_events: 1 }`, exactly the input a person
 *     uses for a manual run. Its deduplication (company / hypothesis find-before-create)
 *     makes a fair already combed cheap to repeat: only new exhibitors are written.
 *  4. None QUALIFIED and current: the run ends SKIPPED ("0 señales calificadas"), no model
 *     call, no CRM summary.
 *
 * Round-robin memory: the runtime's own `agent_executions` of this agent. The last time a
 * signal was worked is the latest execution whose output (this mode) or input (a directed
 * scout run that carries `signal_id`, e.g. the trigger on qualification) names it. Nothing
 * new is stored: the run output carries `signal_id`, which is what the next run reads.
 */
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agentExecutions } from '../db/schema.js';
import type { EventSignal, ExpireSignalOutput, ListEventSignalsOutput } from '../tools/twenty/signal-tools.js';
import { runScout, type ScoutRunOutput } from './event-scout.js';
import { issues, SCOUT_TIME_BUDGET_CAP_MS, toolError, type ProspectorRun, type RunOutcome } from './prospector-core.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const SignalsInput = z.object({
  mode: z.literal('signals'),
  /** Lowers the scout time budget of this run (never above the agent configuration). */
  scout_time_budget_ms: z.number().int().min(10_000).max(SCOUT_TIME_BUDGET_CAP_MS).optional(),
});
export type SignalsInput = z.infer<typeof SignalsInput>;

/** Default input of the daily task: no fair inside, the fairs come from Twenty. */
export const SIGNALS_DEFAULT_INPUT = { mode: 'signals' } as const;

/** Signals mode only when asked explicitly (additive: the direct and scout inputs are unchanged). */
export function isSignalsInput(input: Record<string, unknown>): boolean {
  return input.mode === 'signals';
}

// ---------------------------------------------------------------------------
// Pure selection rules
// ---------------------------------------------------------------------------

/** Signal types that describe an event a person can prospect by its exhibitor list. */
export const EVENT_SIGNAL_TYPES = ['FAIR', 'CONGRESS', 'EVENT'] as const;
/** Statuses read: the open ones (ageing applies to all of them, prospecting only to QUALIFIED). */
export const OPEN_SIGNAL_STATUSES = ['NEW', 'REVIEWING', 'QUALIFIED'] as const;
/** Expirations per run (a bound; the rest expire on the next run). */
export const MAX_EXPIRATIONS_PER_RUN = 50;

const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);

/**
 * A fair-level signal: no company (guaranteed by `list_event_signals`), a fair-like type and an
 * http(s) event URL. The historical per-exhibitor signals carry a company and never get here.
 */
export function isFairLevelSignal(s: Pick<EventSignal, 'signalType' | 'sourceUrl'>): boolean {
  return (EVENT_SIGNAL_TYPES as readonly string[]).includes(s.signalType) && s.sourceUrl !== null && HttpUrl.safeParse(s.sourceUrl).success;
}

/** Event name from the signal name: the scout names them "<feria> (feria)". */
export function eventNameOf(signalName: string): string {
  const name = signalName.replace(/\s*\((?:feria|congreso|evento)\)\s*$/i, '').trim();
  return (name.length > 0 ? name : signalName.trim()).slice(0, 255);
}

/** True when the event date is strictly before `today` (YYYY-MM-DD). No date: never past. */
export function isPastEvent(s: Pick<EventSignal, 'eventDate'>, today: string): boolean {
  return s.eventDate !== null && s.eventDate.slice(0, 10) < today;
}

/**
 * Round-robin: never worked first, then the one worked longest ago; ties by nearest event date
 * (undated last), then name and id (deterministic).
 */
export function pickNextSignal<T extends Pick<EventSignal, 'id' | 'name' | 'eventDate'>>(signals: T[], lastWorked: ReadonlyMap<string, Date>): T | null {
  const at = (s: T) => lastWorked.get(s.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const sorted = [...signals].sort((a, b) => {
    const ta = at(a);
    const tb = at(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const da = a.eventDate ?? '9999-12-31';
    const db = b.eventDate ?? '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

// ---------------------------------------------------------------------------
// Round-robin memory
// ---------------------------------------------------------------------------

export interface SignalHistory {
  /** Last time each signal was worked by this agent (executions other than `excludeExecutionId`). */
  lastWorked(args: { tenantId: string; agentId: string; excludeExecutionId: string }): Promise<Map<string, Date>>;
}

const SIGNAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the runtime's `agent_executions`: `output.signal_id` (signals mode) or `input.signal_id` (directed scout). */
export class DrizzleSignalHistory implements SignalHistory {
  constructor(private readonly db: Db) {}

  async lastWorked(args: { tenantId: string; agentId: string; excludeExecutionId: string }): Promise<Map<string, Date>> {
    const sid = sql<string>`coalesce(${agentExecutions.output}->>'signal_id', ${agentExecutions.input}->>'signal_id')`;
    const rows = await this.db
      .select({ sid, at: sql<Date | string>`max(coalesce(${agentExecutions.startedAt}, ${agentExecutions.createdAt}))` })
      .from(agentExecutions)
      .where(
        and(
          eq(agentExecutions.tenantId, args.tenantId),
          eq(agentExecutions.agentId, args.agentId),
          ne(agentExecutions.id, args.excludeExecutionId),
          or(sql`${agentExecutions.output}->>'signal_id' is not null`, sql`${agentExecutions.input}->>'signal_id' is not null`),
        ),
      )
      .groupBy(sid);
    const out = new Map<string, Date>();
    for (const r of rows) {
      if (typeof r.sid !== 'string' || !SIGNAL_ID_RE.test(r.sid) || r.at === null) continue;
      const at = r.at instanceof Date ? r.at : new Date(r.at);
      if (!Number.isNaN(at.getTime())) out.set(r.sid, at);
    }
    return out;
  }
}

/** In-memory history (tests, and runs without the runtime database). */
export class MemorySignalHistory implements SignalHistory {
  constructor(private readonly entries: ReadonlyMap<string, Date> = new Map()) {}
  async lastWorked(): Promise<Map<string, Date>> {
    return new Map(this.entries);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type SignalsOutcome = RunOutcome | 'SKIPPED';

export interface SignalsRunOutput {
  outcome: SignalsOutcome;
  lines: string[];
  output: Record<string, unknown>;
}

interface ExpiredEntry {
  id: string;
  name: string;
  event_date: string | null;
  previous_status: string | null;
}

export async function runSignals(run: ProspectorRun, rawInput: Record<string, unknown>, today: string, history: SignalHistory | null): Promise<SignalsRunOutput> {
  const parsed = SignalsInput.safeParse(rawInput);
  run.steps.push({
    type: 'THINK',
    timestamp: new Date(),
    input: { input_keys: Object.keys(rawInput), mode: 'signals' },
    output: parsed.success
      ? {
          plan: 'list the open event-level signals in Twenty; expire the past ones; scout the least recently worked QUALIFIED fair (directed scout); publish the run summary',
          today,
          round_robin: history ? 'agent_executions' : 'none (no runtime database)',
        }
      : { error: 'invalid input', issues: issues(parsed.error) },
    latencyMs: 0,
  });
  if (!parsed.success) {
    const error = issues(parsed.error);
    return { outcome: 'FAILED', lines: [`Entrada inválida (modo señales): ${error}`], output: { mode: 'signals', input_error: error } };
  }
  const input = parsed.data;

  // 1. Open event-level signals.
  const listed = await run.callTool('list_event_signals', { statuses: [...OPEN_SIGNAL_STATUSES] });
  if (listed.result.status !== 'ok') {
    const error = toolError(listed);
    return {
      outcome: 'FAILED',
      lines: [`Modo señales: no se pudieron leer las señales de Twenty (${error.code}). No se ha prospectado ninguna feria.`],
      output: { mode: 'signals', list_error: error },
    };
  }
  const { signals: open, truncated } = listed.result.output as ListEventSignalsOutput;
  const fair = open.filter(isFairLevelSignal);
  const notFair = open.length - fair.length;

  // 2. Ageing first: past events go to EXPIRED (the only state the machine changes).
  const past = fair.filter((s) => isPastEvent(s, today));
  const expired: ExpiredEntry[] = [];
  const expireErrors: Array<{ id: string; name: string; code: string; message: string }> = [];
  const notExpired: Array<{ id: string; name: string; reason: string }> = [];
  for (const s of past.slice(0, MAX_EXPIRATIONS_PER_RUN)) {
    run.ctx.signal.throwIfAborted();
    const out = await run.callTool('expire_signal', { signalId: s.id, today });
    if (out.result.status !== 'ok') {
      expireErrors.push({ id: s.id, name: s.name, ...toolError(out) });
      continue;
    }
    const r = out.result.output as ExpireSignalOutput;
    if (r.expired) expired.push({ id: s.id, name: s.name, event_date: r.eventDate, previous_status: r.previousStatus });
    else notExpired.push({ id: s.id, name: s.name, reason: r.reason });
  }
  const expirationsDeferred = Math.max(0, past.length - MAX_EXPIRATIONS_PER_RUN);

  // 3. QUALIFIED and current (a past one is never prospected, even if its expiry failed).
  const qualified = fair.filter((s) => s.status === 'QUALIFIED' && !isPastEvent(s, today));
  const signalsInfo = {
    open_listed: open.length,
    listing_truncated: truncated,
    fair_level: fair.length,
    ignored_not_fair_level: notFair,
    qualified_current: qualified.length,
    expired,
    ...(notExpired.length > 0 ? { not_expired: notExpired } : {}),
    ...(expireErrors.length > 0 ? { expire_errors: expireErrors } : {}),
    ...(expirationsDeferred > 0 ? { expirations_deferred: expirationsDeferred } : {}),
  };
  const ageingLines = [
    ...(expired.length > 0 ? [`Señales caducadas (fecha pasada → EXPIRED): ${expired.length} — ${expired.map((e) => `${e.name} (${e.event_date})`).join('; ')}.`] : []),
    ...(expireErrors.length > 0 ? [`No se pudieron caducar ${expireErrors.length} señal(es): ${expireErrors.map((e) => `${e.name} (${e.code})`).join('; ')}.`] : []),
  ];

  if (qualified.length === 0) {
    return {
      outcome: 'SKIPPED',
      lines: ['Modo señales: 0 señales calificadas vigentes; no se ha prospectado ninguna feria.', ...ageingLines],
      output: { mode: 'signals', input, reason: '0 señales calificadas', signals: signalsInfo },
    };
  }

  // 4. Round-robin by last execution that worked each signal.
  let lastWorked = new Map<string, Date>();
  let historyError: string | null = null;
  if (history) {
    try {
      lastWorked = await history.lastWorked({ tenantId: run.ctx.tenantId, agentId: run.ctx.agent.id, excludeExecutionId: run.ctx.executionId });
    } catch (err) {
      historyError = err instanceof Error ? err.message : String(err);
    }
  }
  const chosen = pickNextSignal(qualified, lastWorked)!;
  const previous = lastWorked.get(chosen.id) ?? null;
  const eventName = eventNameOf(chosen.name);
  const selection = {
    strategy: 'least_recently_worked',
    source: history ? 'agent_executions' : 'none',
    ...(historyError ? { history_error: historyError } : {}),
    candidates: qualified.map((s) => ({ id: s.id, name: s.name, event_date: s.eventDate, last_worked_at: lastWorked.get(s.id)?.toISOString() ?? null })),
  };
  run.steps.push({
    type: 'THINK',
    timestamp: new Date(),
    output: { chosen_signal: { id: chosen.id, name: chosen.name, event_date: chosen.eventDate, last_worked_at: previous?.toISOString() ?? null }, selection },
    latencyMs: 0,
  });

  // 5. Directed scout on the chosen fair: the same input as a manual run.
  const scoutInput: Record<string, unknown> = {
    event_url: chosen.sourceUrl!,
    event_name: eventName,
    ...(chosen.eventDate ? { event_date: chosen.eventDate } : {}),
    max_events: 1,
    ...(input.scout_time_budget_ms !== undefined ? { scout_time_budget_ms: input.scout_time_budget_ms } : {}),
  };
  const scout: ScoutRunOutput = await runScout(run, scoutInput, today);
  const outcome: RunOutcome = scout.outcome === 'SUCCESS' && expireErrors.length > 0 ? 'PARTIAL' : scout.outcome;

  return {
    outcome,
    lines: [
      `Modo señales: feria calificada trabajada hoy: ${chosen.name}${chosen.eventDate ? ` (${chosen.eventDate})` : ''} — última prospección: ${previous ? previous.toISOString().slice(0, 10) : 'nunca'}; calificadas vigentes: ${qualified.length}.`,
      ...ageingLines,
      ...scout.lines,
    ],
    output: {
      ...scout.output,
      mode: 'signals',
      signals_input: input,
      signal_id: chosen.id,
      signal_name: chosen.name,
      event_name: eventName,
      event_url: chosen.sourceUrl,
      signals: { ...signalsInfo, selection },
    },
  };
}
