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
 *  2b. Lead-time maintenance (tanda 18): PROPOSED hypotheses whose fair is closer than
 *     LEADTIME_MIN_DAYS (or past) go to EXPIRED (`expire_hypothesis`, at most 50 per run);
 *     VALIDATED ones are never touched, only listed as a warning (see `planHypothesisExpiry`).
 *  3. Of the QUALIFIED ones INSIDE the lead-time window (LEADTIME_MIN_DAYS <= days <=
 *     LEADTIME_MAX_DAYS, Europe/Madrid; src/signals/lead-time.ts), the least recently worked one
 *     is chosen (round-robin, see `pickNextSignal`) and the directed scout flow runs on it.
 *     Too close, too far and undated ones are never chosen; the output lists them
 *     (`lead_time.too_close` / `too_far` / `no_date`, with the days). The window filters, the
 *     calendar expires: a too-close signal keeps its status until its date is past.
 *     The directed scout flow:
 *     `runScout` with `{ event_url, event_name, max_events: 1 }`, exactly the input a person
 *     uses for a manual run. Its deduplication (company / hypothesis find-before-create)
 *     makes a fair already combed cheap to repeat: only new exhibitors are written.
 *  4. None QUALIFIED inside the window: the run ends SKIPPED ("0 señales calificadas" or "0
 *     señales calificadas en ventana de lead time", with the breakdown), no model call, no CRM summary.
 *
 * Round-robin memory: the runtime's own `agent_executions` of this agent. The last time a
 * signal was worked is the latest execution whose output (this mode) or input (a directed
 * scout run that carries `signal_id`, e.g. the trigger on qualification) names it. Executions
 * that ended SKIPPED (e.g. a trigger outside the lead-time window) do not count. Nothing
 * new is stored: the run output carries `signal_id`, which is what the next run reads.
 */
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agentExecutions } from '../db/schema.js';
import type { EventSignal, ExpireSignalOutput, ListEventSignalsOutput } from '../tools/twenty/signal-tools.js';
import type { ExpireHypothesisOutput, HypothesisForExpiry, ListHypothesesForExpiryOutput } from '../tools/twenty/hypothesis-expiry-tools.js';
import {
  classifyLeadTime,
  isDeadForLeadTime,
  leadTimeWindowFromEnv,
  madridToday,
  windowInfo,
  windowLabel,
  type LeadTimeStatus,
  type LeadTimeWindow,
} from '../signals/lead-time.js';
import { runScout, type ScoutRunOutput } from './event-scout.js';
import type { DomainResolverConfig } from './domain-resolver.js';
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
/** Hypothesis expirations by lead time per run (a bound; the rest expire on the next run). */
export const MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN = 50;

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
// Lead-time rules (tanda 18, pure)
// ---------------------------------------------------------------------------

export interface LeadTimeEntry {
  id: string;
  name: string;
  event_date: string | null;
  days: number | null;
}

export interface LeadTimePartition<T> {
  inWindow: Array<T & { days: number }>;
  tooClose: LeadTimeEntry[];
  tooFar: LeadTimeEntry[];
  noDate: LeadTimeEntry[];
}

/**
 * Splits the QUALIFIED, not past, fair signals by the lead-time window (Madrid day). Only
 * `inWindow` can be chosen; an undated signal cannot be judged and is excluded too (PM decision,
 * tanda 18: never prospect blind, add the date to the signal).
 */
export function partitionByLeadTime<T extends Pick<EventSignal, 'id' | 'name' | 'eventDate'>>(signals: T[], today: string, window: LeadTimeWindow): LeadTimePartition<T> {
  const out: LeadTimePartition<T> = { inWindow: [], tooClose: [], tooFar: [], noDate: [] };
  for (const s of signals) {
    const v = classifyLeadTime(s.eventDate, today, window);
    const entry: LeadTimeEntry = { id: s.id, name: s.name, event_date: s.eventDate, days: v.days };
    if (v.status === 'in_window') out.inWindow.push({ ...s, days: v.days! });
    else if (v.status === 'too_far') out.tooFar.push(entry);
    else if (v.status === 'no_date') out.noDate.push(entry);
    else out.tooClose.push(entry);
  }
  return out;
}

/** Folded name for comparisons: lowercase, no accents, single spaces. */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const NAME_SEP = ' — ';

/**
 * Fair name a hypothesis belongs to: the per-exhibitor signal is named "<feria> — <empresa>" and
 * the hypothesis "<empresa> — <feria>" (src/agents/prospector-core.ts). Null when neither has it.
 */
export function hypothesisEventName(h: Pick<HypothesisForExpiry, 'name' | 'signalName'>): string | null {
  if (h.signalName && h.signalName.includes(NAME_SEP)) {
    const fair = h.signalName.slice(0, h.signalName.indexOf(NAME_SEP)).trim();
    if (fair) return fair;
  }
  if (h.name.includes(NAME_SEP)) {
    const fair = h.name.slice(h.name.lastIndexOf(NAME_SEP) + NAME_SEP.length).trim();
    if (fair) return fair;
  }
  return null;
}

export interface HypothesisExpiryCandidate {
  id: string;
  name: string;
  status: string;
  event_name: string | null;
  event_date: string;
  days: number;
  date_source: 'signal' | 'event_name';
}

export interface HypothesisExpiryPlan {
  /** PROPOSED whose fair is closer than the minimum (or past): to expire, nearest first. */
  expire: HypothesisExpiryCandidate[];
  /** VALIDATED in the same situation: never expired (human decision), only reported. */
  validatedWarnings: HypothesisExpiryCandidate[];
  /** Hypotheses whose fair date could not be resolved (left untouched). */
  unresolvedDate: number;
}

/**
 * Which hypotheses the lead-time maintenance acts on. The fair date comes from the hypothesis'
 * own signal; without one, from a fair-level signal with the same (folded) event name.
 */
export function planHypothesisExpiry(
  hypotheses: HypothesisForExpiry[],
  fairSignals: Array<Pick<EventSignal, 'name' | 'eventDate'>>,
  today: string,
  window: LeadTimeWindow,
): HypothesisExpiryPlan {
  const fairDates = new Map<string, string>();
  for (const s of fairSignals) if (s.eventDate) fairDates.set(foldName(eventNameOf(s.name)), s.eventDate.slice(0, 10));
  const plan: HypothesisExpiryPlan = { expire: [], validatedWarnings: [], unresolvedDate: 0 };
  for (const h of hypotheses) {
    const eventName = hypothesisEventName(h);
    const byName = eventName ? (fairDates.get(foldName(eventName)) ?? null) : null;
    const date = h.signalEventDate ?? byName;
    if (!date) {
      plan.unresolvedDate += 1;
      continue;
    }
    const v = classifyLeadTime(date, today, window);
    if (!isDeadForLeadTime(v)) continue;
    const c: HypothesisExpiryCandidate = {
      id: h.id,
      name: h.name,
      status: h.status,
      event_name: eventName,
      event_date: date,
      days: v.days!,
      date_source: h.signalEventDate ? 'signal' : 'event_name',
    };
    if (h.status === 'PROPOSED') plan.expire.push(c);
    else if (h.status === 'VALIDATED') plan.validatedWarnings.push(c);
  }
  const byDays = (a: HypothesisExpiryCandidate, b: HypothesisExpiryCandidate) => a.days - b.days || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  plan.expire.sort(byDays);
  plan.validatedWarnings.sort(byDays);
  return plan;
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
          // A run that ended SKIPPED (lead-time window) did not work the signal.
          sql`coalesce(${agentExecutions.output}->>'outcome', '') <> 'SKIPPED'`,
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

export interface SignalsLeadTimeOptions {
  /** Lead-time window; default `LEADTIME_MIN_DAYS` / `LEADTIME_MAX_DAYS` (45 / 210). */
  window?: LeadTimeWindow;
  /** Madrid day the window is measured from; default the run start in Europe/Madrid. */
  today?: string;
  /** Domain resolver of the directed scout (tanda 20); default DOMAIN_RESOLVER_* env. */
  domainResolver?: DomainResolverConfig;
}

/** Shortest list of names for a summary line. */
function namesWithDays(entries: Array<{ name: string; days: number | null }>, max = 10): string {
  const shown = entries.slice(0, max).map((e) => `${e.name}${e.days !== null ? ` (a ${e.days} días)` : ''}`);
  return `${shown.join('; ')}${entries.length > max ? `; y ${entries.length - max} más` : ''}`;
}

/**
 * Lead-time maintenance: PROPOSED hypotheses of fairs closer than the minimum (or past) go to
 * EXPIRED (at most MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN); VALIDATED ones are only reported. Never
 * fatal: a listing or PATCH error is recorded and the run goes on.
 */
async function expireHypothesesByLeadTime(
  run: ProspectorRun,
  fairSignals: EventSignal[],
  today: string,
  window: LeadTimeWindow,
): Promise<{ info: Record<string, unknown>; lines: string[]; errors: number }> {
  const listed = await run.callTool('list_hypotheses_for_expiry', { statuses: ['PROPOSED', 'VALIDATED'] });
  if (listed.result.status !== 'ok') {
    const error = toolError(listed);
    return {
      info: { list_error: error, expired: [], errors: [] },
      lines: [`No se pudieron leer las hipótesis para la caducidad por lead time (${error.code}).`],
      errors: 1,
    };
  }
  const out = listed.result.output as ListHypothesesForExpiryOutput;
  const plan = planHypothesisExpiry(out.hypotheses, fairSignals, today, window);
  const expired: Array<{ id: string; name: string; event_date: string | null; days: number | null }> = [];
  const notExpired: Array<{ id: string; name: string; reason: string }> = [];
  const errors: Array<{ id: string; name: string; code: string; message: string }> = [];
  for (const c of plan.expire.slice(0, MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN)) {
    run.ctx.signal.throwIfAborted();
    const r = await run.callTool('expire_hypothesis', { hypothesisId: c.id, eventDate: c.event_date, today, minDays: window.minDays });
    if (r.result.status !== 'ok') {
      errors.push({ id: c.id, name: c.name, ...toolError(r) });
      continue;
    }
    const o = r.result.output as ExpireHypothesisOutput;
    if (o.expired) expired.push({ id: c.id, name: c.name, event_date: o.eventDate, days: o.days });
    else notExpired.push({ id: c.id, name: c.name, reason: o.reason });
  }
  const deferred = Math.max(0, plan.expire.length - MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN);
  const warnings = plan.validatedWarnings.map((w) => ({ id: w.id, name: w.name, event_date: w.event_date, days: w.days }));
  const info: Record<string, unknown> = {
    checked: out.hypotheses.length,
    listing_truncated: out.truncated,
    min_days: window.minDays,
    max_per_run: MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN,
    due: plan.expire.length,
    expired,
    ...(notExpired.length > 0 ? { not_expired: notExpired } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...(deferred > 0 ? { deferred } : {}),
    validated_warnings: warnings,
    unresolved_date: plan.unresolvedDate,
  };
  const lines = [
    ...(expired.length > 0
      ? [`Hipótesis caducadas por lead time (PROPOSED de ferias a menos de ${window.minDays} días → EXPIRED): ${expired.length} — ${namesWithDays(expired)}.`]
      : []),
    ...(deferred > 0 ? [`Quedan ${deferred} hipótesis por caducar (tope de ${MAX_HYPOTHESIS_EXPIRATIONS_PER_RUN} por ejecución): se caducan en la próxima.`] : []),
    ...(errors.length > 0 ? [`No se pudieron caducar ${errors.length} hipótesis: ${errors.map((e) => `${e.name} (${e.code})`).join('; ')}.`] : []),
    ...(warnings.length > 0
      ? [`Aviso: ${warnings.length} hipótesis VALIDATED de ferias a menos de ${window.minDays} días (no se caducan, decisión humana): ${namesWithDays(warnings)}.`]
      : []),
  ];
  return { info, lines, errors: errors.length };
}

export async function runSignals(
  run: ProspectorRun,
  rawInput: Record<string, unknown>,
  today: string,
  history: SignalHistory | null,
  leadTime: SignalsLeadTimeOptions = {},
): Promise<SignalsRunOutput> {
  const window = leadTime.window ?? leadTimeWindowFromEnv();
  const madrid = leadTime.today ?? madridToday(run.startedAt);
  const parsed = SignalsInput.safeParse(rawInput);
  run.steps.push({
    type: 'THINK',
    timestamp: new Date(),
    input: { input_keys: Object.keys(rawInput), mode: 'signals' },
    output: parsed.success
      ? {
          plan: 'list the open event-level signals in Twenty; expire the past ones; expire the PROPOSED hypotheses of fairs closer than the lead-time minimum; scout the least recently worked QUALIFIED fair inside the lead-time window (directed scout); publish the run summary',
          today,
          lead_time: windowInfo(window, madrid),
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

  // 2. Ageing first: past events go to EXPIRED (the only signal state the machine changes).
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

  // 2b. Lead-time maintenance of hypotheses (before choosing: it runs even when nothing is chosen).
  const hyp = await expireHypothesesByLeadTime(run, fair, madrid, window);

  // 3. QUALIFIED and current (a past one is never prospected, even if its expiry failed), split by the window.
  const qualified = fair.filter((s) => s.status === 'QUALIFIED' && !isPastEvent(s, today));
  const split = partitionByLeadTime(qualified, madrid, window);
  const leadTimeInfo = {
    window: windowInfo(window, madrid),
    in_window: split.inWindow.length,
    too_close: split.tooClose,
    too_far: split.tooFar,
    no_date: split.noDate,
  };
  const signalsInfo = {
    open_listed: open.length,
    listing_truncated: truncated,
    fair_level: fair.length,
    ignored_not_fair_level: notFair,
    qualified_current: qualified.length,
    qualified_in_window: split.inWindow.length,
    expired,
    ...(notExpired.length > 0 ? { not_expired: notExpired } : {}),
    ...(expireErrors.length > 0 ? { expire_errors: expireErrors } : {}),
    ...(expirationsDeferred > 0 ? { expirations_deferred: expirationsDeferred } : {}),
  };
  const ageingLines = [
    ...(expired.length > 0 ? [`Señales caducadas (fecha pasada → EXPIRED): ${expired.length} — ${expired.map((e) => `${e.name} (${e.event_date})`).join('; ')}.`] : []),
    ...(expireErrors.length > 0 ? [`No se pudieron caducar ${expireErrors.length} señal(es): ${expireErrors.map((e) => `${e.name} (${e.code})`).join('; ')}.`] : []),
    ...hyp.lines,
  ];
  const outOfWindowLines = [
    ...(split.tooClose.length > 0 ? [`Calificadas demasiado cerca (< ${window.minDays} días, sin plazo de producción): ${namesWithDays(split.tooClose)}.`] : []),
    ...(split.tooFar.length > 0 ? [`Calificadas demasiado lejanas (> ${window.maxDays} días, entrarán solas en la ventana): ${namesWithDays(split.tooFar)}.`] : []),
    ...(split.noDate.length > 0 ? [`Calificadas sin fecha de feria (no se prospectan a ciegas; añade la fecha a la señal): ${split.noDate.map((e) => e.name).join('; ')}.`] : []),
  ];
  const windowLine = `Ventana de lead time: ${windowLabel(window)} (hoy ${madrid}, Europe/Madrid).`;

  if (split.inWindow.length === 0) {
    const reason = qualified.length === 0 ? '0 señales calificadas' : '0 señales calificadas en ventana de lead time';
    return {
      outcome: 'SKIPPED',
      lines: [
        qualified.length === 0
          ? 'Modo señales: 0 señales calificadas vigentes; no se ha prospectado ninguna feria.'
          : `Modo señales: ${qualified.length} señal(es) calificada(s) vigente(s) pero ninguna en la ventana de lead time; no se ha prospectado ninguna feria.`,
        windowLine,
        ...outOfWindowLines,
        ...ageingLines,
      ],
      output: { mode: 'signals', input, reason, lead_time: leadTimeInfo, signals: signalsInfo, hypothesis_expiry: hyp.info },
    };
  }

  // 4. Round-robin by last execution that worked each signal (only the ones inside the window).
  let lastWorked = new Map<string, Date>();
  let historyError: string | null = null;
  if (history) {
    try {
      lastWorked = await history.lastWorked({ tenantId: run.ctx.tenantId, agentId: run.ctx.agent.id, excludeExecutionId: run.ctx.executionId });
    } catch (err) {
      historyError = err instanceof Error ? err.message : String(err);
    }
  }
  const chosen = pickNextSignal(split.inWindow, lastWorked)!;
  const previous = lastWorked.get(chosen.id) ?? null;
  const eventName = eventNameOf(chosen.name);
  const selection = {
    strategy: 'least_recently_worked',
    source: history ? 'agent_executions' : 'none',
    ...(historyError ? { history_error: historyError } : {}),
    candidates: split.inWindow.map((s) => ({ id: s.id, name: s.name, event_date: s.eventDate, days: s.days, last_worked_at: lastWorked.get(s.id)?.toISOString() ?? null })),
  };
  run.steps.push({
    type: 'THINK',
    timestamp: new Date(),
    output: {
      chosen_signal: { id: chosen.id, name: chosen.name, event_date: chosen.eventDate, days: chosen.days, last_worked_at: previous?.toISOString() ?? null },
      selection,
      lead_time: leadTimeInfo,
    },
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
  const scout: ScoutRunOutput = await runScout(run, scoutInput, today, { leadTime: window, ...(leadTime.domainResolver ? { domainResolver: leadTime.domainResolver } : {}) });
  const outcome: RunOutcome = scout.outcome === 'SUCCESS' && (expireErrors.length > 0 || hyp.errors > 0) ? 'PARTIAL' : scout.outcome;

  return {
    outcome,
    lines: [
      `Modo señales: feria calificada trabajada hoy: ${chosen.name}${chosen.eventDate ? ` (${chosen.eventDate}, a ${chosen.days} días)` : ''} — última prospección: ${previous ? previous.toISOString().slice(0, 10) : 'nunca'}; calificadas en ventana: ${split.inWindow.length} de ${qualified.length} vigentes.`,
      windowLine,
      ...outOfWindowLines,
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
      lead_time: { ...leadTimeInfo, chosen: { id: chosen.id, name: chosen.name, event_date: chosen.eventDate, days: chosen.days } },
      signals: { ...signalsInfo, selection },
      hypothesis_expiry: hyp.info,
    },
  };
}

// ---------------------------------------------------------------------------
// Trigger on qualification (`prospect-on-qualified`): lead-time gate (tanda 18)
// ---------------------------------------------------------------------------

/**
 * A directed scout run fired by `signal.qualified` (task `prospect-on-qualified`): scout input with
 * the qualified signal's id. The gate applies to any scout run that names a `signal_id`.
 */
export function isQualifiedTriggerInput(input: Record<string, unknown>): boolean {
  return input.mode !== 'signals' && typeof input.signal_id === 'string' && SIGNAL_ID_RE.test(input.signal_id) && typeof input.event_url === 'string';
}

function addDays(day: string, days: number): string {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? day : new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** Title and body of the note left on a signal whose qualification did not start a run. */
export function outOfWindowNote(args: {
  signalName: string;
  status: Exclude<LeadTimeStatus, 'in_window'>;
  days: number | null;
  eventDate: string | null;
  today: string;
  window: LeadTimeWindow;
}): { title: string; body: string } {
  const { signalName, status, days, eventDate, today, window } = args;
  if (status === 'no_date') {
    return {
      title: `⏳ Sin fecha de feria (${today}): ${signalName}`,
      body: [
        '⏳ Sin fecha de feria: añade la fecha a la señal para que entre al reparto.',
        `El Prospector no prospecta una feria a ciegas: sin fecha no puede comprobar la ventana de lead time (${windowLabel(window)}). La señal sigue QUALIFIED.`,
      ].join('\n\n'),
    };
  }
  const lines: string[] = [];
  if (status === 'too_far') {
    lines.push(`⏳ Fuera de ventana: la feria es en ${days} días (${eventDate}), demasiado lejana (máximo ${window.maxDays} días).`);
    lines.push(`La señal sigue QUALIFIED: se trabajará sola en el reparto diario cuando entre en ventana (a partir del ${addDays(eventDate!, -window.maxDays)}).`);
  } else if (status === 'past') {
    lines.push(`⏳ Fuera de ventana: la feria ya pasó (${eventDate}, hace ${Math.abs(days ?? 0)} días).`);
    lines.push('El reparto diario la caducará (EXPIRED). No se ha prospectado.');
  } else {
    lines.push(`⏳ Fuera de ventana: la feria es en ${days} días (${eventDate}); el mínimo de lead time es ${window.minDays} días.`);
    lines.push('No da tiempo a producir merchandising: el Prospector no la prospecta. La señal sigue QUALIFIED; si merece una acción manual, decide tú.');
  }
  lines.push(`Ventana de lead time: ${windowLabel(window)} (Europe/Madrid, hoy ${today}).`);
  return { title: `⏳ Fuera de ventana (${today}): ${signalName}`, body: lines.join('\n\n') };
}

/** Days until the due date of the "⏳ Sin fecha" task (a person adds the date). */
export const NO_DATE_TASK_DUE_DAYS = 7;

/**
 * Due date (`YYYY-MM-DD`, 09:00 Europe/Madrid) of the out-of-window task: a too-far fair is due
 * the day it ENTERS the window (event date minus the window maximum); an undated one in 7 days
 * (add the date); a too-close or past fair never enters it, so today (decide now).
 */
export function outOfWindowTaskDue(args: { status: Exclude<LeadTimeStatus, 'in_window'>; eventDate: string | null; today: string; window: LeadTimeWindow }): string {
  const { status, eventDate, today, window } = args;
  if (status === 'no_date' || !eventDate) return addDays(today, NO_DATE_TASK_DUE_DAYS);
  if (status === 'too_far') {
    const enters = addDays(eventDate, -window.maxDays);
    return enters > today ? enters : today;
  }
  return today;
}

export interface QualifiedGateResult {
  /** True: the run must stop SKIPPED with `output`. */
  skip: boolean;
  output: Record<string, unknown>;
  lines: string[];
  /** Lead-time block for a run that goes on (in window). */
  leadTime: Record<string, unknown>;
}

/**
 * Lead-time gate of the trigger on qualification. Inside the window: the run goes on (the block
 * is added to its output). Outside it (too close, too far, past) or without a date: no
 * prospecting, a Twenty Task on the signal explains why (`create_crm_task`, tanda 19; before, a
 * note), and the signal keeps its QUALIFIED status (a too-far one enters the daily round-robin
 * on its own later). A Prospector version without `create_crm_task` in its allowlist (seeded
 * before tanda 19) falls back to the note (`create_signal_note`).
 */
export async function qualifiedLeadTimeGate(run: ProspectorRun, input: Record<string, unknown>, opts: SignalsLeadTimeOptions = {}): Promise<QualifiedGateResult> {
  const window = opts.window ?? leadTimeWindowFromEnv();
  const today = opts.today ?? madridToday(run.startedAt);
  const signalId = input.signal_id as string;
  const eventDate = typeof input.event_date === 'string' && input.event_date.trim() !== '' ? input.event_date.trim().slice(0, 10) : null;
  const eventName = typeof input.event_name === 'string' && input.event_name.trim() !== '' ? input.event_name.trim() : null;
  const v = classifyLeadTime(eventDate, today, window);
  const leadTime = { window: windowInfo(window, today), status: v.status, days: v.days, event_date: eventDate };
  run.steps.push({ type: 'THINK', timestamp: new Date(), output: { lead_time_gate: { signal_id: signalId, ...leadTime } }, latencyMs: 0 });
  if (v.status === 'in_window') {
    return { skip: false, output: {}, lines: [`Ventana de lead time: ${windowLabel(window)}; la feria es en ${v.days} días.`], leadTime };
  }
  const note = outOfWindowNote({ signalName: eventName ?? signalId, status: v.status, days: v.days, eventDate, today, window });
  // Tanda 19: a Twenty Task (TODO) on the signal instead of a note, due when the person can act.
  const dueAt = outOfWindowTaskDue({ status: v.status, eventDate, today, window });
  const tasked = await run.callTool('create_crm_task', { title: note.title, bodyMarkdown: note.body, dueAt, targets: { signalId } });
  let noteInfo: Record<string, unknown>;
  if (tasked.result.status === 'ok') noteInfo = { task: tasked.result.output };
  else if (toolError(tasked).code === 'TOOL_NOT_ALLOWED') {
    // A Prospector version seeded before tanda 19 (no create_crm_task in its allowlist): keep the
    // old note so the alert is not lost until `pnpm seed` creates the new version.
    const noted = await run.callTool('create_signal_note', { signalId, title: note.title, bodyMarkdown: note.body });
    noteInfo = noted.result.status === 'ok' ? { note: noted.result.output, task_error: toolError(tasked) } : { note_error: toolError(noted), task_error: toolError(tasked) };
  } else noteInfo = { task_error: toolError(tasked) };
  const reason =
    v.status === 'no_date'
      ? 'feria sin fecha: no se puede juzgar la ventana de lead time'
      : v.status === 'too_far'
        ? `feria demasiado lejana (a ${v.days} días; máximo ${window.maxDays})`
        : v.status === 'past'
          ? `feria ya pasada (${eventDate})`
          : `feria demasiado cercana (a ${v.days} días; mínimo ${window.minDays})`;
  return {
    skip: true,
    lines: [`Calificación fuera de ventana de lead time: ${reason}. No se ha prospectado; tarea en la señal.`],
    leadTime,
    output: {
      mode: 'scout',
      trigger: 'signal.qualified',
      signal_id: signalId,
      ...(eventName ? { event_name: eventName } : {}),
      event_url: input.event_url,
      reason: `fuera de ventana de lead time: ${reason}`,
      lead_time: leadTime,
      ...noteInfo,
    },
  };
}
