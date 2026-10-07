/**
 * Twenty health gate (boot race fix, 2026-10-07).
 *
 * When the host boots, Docker starts every container at once: the scheduler catch-up can
 * enqueue a pending slot while pxos-twenty is still `health: starting`, and the run then
 * burns its tools on `TWENTY_NETWORK_ERROR`. Before a TaskRun goes QUEUED -> RUNNING, the
 * worker asks this gate. If the agent version can call Twenty tools and Twenty does not
 * answer `/healthz`, the job is parked in `delayed` (like `ConcurrencyLimitError`: no attempt
 * consumed, run stays QUEUED) with a growing backoff. After `maxWaitMs` the run proceeds
 * anyway: the tools fail and the agent reports PARTIAL, which is the honest outcome.
 */
import { twentyClientFromEnv } from '../integrations/twenty/index.js';
import type { AgentToolPolicy, ToolRegistry } from '../tools/index.js';

/** Minimal view of `TwentyClient` the gate needs (easy to mock). */
export interface TwentyHealthProbe {
  isConfigured(): boolean;
  health(): Promise<boolean>;
}

/** Per-job wait window, carried across deferrals in the BullMQ job data. */
export interface TwentyWaitState {
  /** Epoch ms of the first deferral of this job. */
  since: number;
  /** Deferrals so far. */
  deferrals: number;
}

export type TwentyGateDecision =
  | { action: 'proceed'; reason: 'not_required' | 'not_configured' | 'healthy' }
  | { action: 'proceed'; reason: 'wait_exceeded'; waitedMs: number; deferrals: number }
  | { action: 'defer'; delayMs: number; waitedMs: number; state: TwentyWaitState };

export const DEFAULT_TWENTY_WAIT_MAX_MS = 600_000;
export const DEFAULT_TWENTY_DEFER_STEPS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];
export const DEFAULT_TWENTY_HEALTH_CACHE_MS = 5_000;
export const DEFAULT_TWENTY_HEALTH_TIMEOUT_MS = 3_000;

/**
 * True if any tool the policy actually lets the agent call (allowlisted, enabled, within the
 * risk ceiling) is backed by Twenty. Twenty tools declare `twenty:*` permissions.
 */
export function policyRequiresTwenty(registry: ToolRegistry, policy: AgentToolPolicy): boolean {
  return registry.resolve(policy).some((tool) => tool.permissions.some((p) => p.startsWith('twenty:')));
}

/**
 * Caches the last `health()` result for `ttlMs` and shares one in-flight probe, so N
 * concurrent jobs (or workers in one process) hit `/healthz` at most once per TTL.
 */
export class TwentyHealthCache {
  private cached: { healthy: boolean; at: number } | null = null;
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly ttlMs: number = DEFAULT_TWENTY_HEALTH_CACHE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async healthy(): Promise<boolean> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.healthy;
    if (!this.inflight) {
      this.inflight = this.probe()
        .catch(() => false)
        .then((healthy) => {
          this.cached = { healthy, at: this.now() };
          return healthy;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }
}

export interface TwentyGateOptions {
  /** Total time a job may be held waiting for Twenty; 0 disables the gate. */
  maxWaitMs?: number;
  /** Backoff per deferral; the last value repeats. */
  stepsMs?: readonly number[];
  healthCacheMs?: number;
  /** Max random jitter added to each delay so deferred jobs do not wake in lockstep. */
  jitterMs?: number;
  now?: () => number;
  random?: () => number;
}

export class TwentyGate {
  readonly maxWaitMs: number;
  private readonly steps: readonly number[];
  private readonly jitterMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cache: TwentyHealthCache;

  constructor(
    private readonly probe: TwentyHealthProbe,
    opts: TwentyGateOptions = {},
  ) {
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_TWENTY_WAIT_MAX_MS;
    this.steps = opts.stepsMs && opts.stepsMs.length > 0 ? opts.stepsMs : DEFAULT_TWENTY_DEFER_STEPS_MS;
    this.jitterMs = opts.jitterMs ?? 500;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.cache = new TwentyHealthCache(() => probe.health(), opts.healthCacheMs ?? DEFAULT_TWENTY_HEALTH_CACHE_MS, this.now);
  }

  /**
   * Decides whether a run may start now.
   * @param requiresTwenty the agent version can call Twenty tools (`policyRequiresTwenty`).
   * @param state wait window of this job from previous deferrals, if any.
   * @param maxWaitMs per-run cap (harness `safety.twenty_wait_max_ms`); defaults to the env one.
   */
  async check(requiresTwenty: boolean, state?: TwentyWaitState | null, maxWaitMs: number = this.maxWaitMs): Promise<TwentyGateDecision> {
    if (!requiresTwenty || maxWaitMs <= 0) return { action: 'proceed', reason: 'not_required' };
    // Without an API key the tools answer TWENTY_NOT_CONFIGURED anyway: waiting is pointless.
    if (!this.probe.isConfigured()) return { action: 'proceed', reason: 'not_configured' };
    if (await this.cache.healthy()) return { action: 'proceed', reason: 'healthy' };

    const now = this.now();
    const since = state?.since ?? now;
    const deferrals = state?.deferrals ?? 0;
    const waitedMs = Math.max(0, now - since);
    const remaining = maxWaitMs - waitedMs;
    if (remaining <= 0) return { action: 'proceed', reason: 'wait_exceeded', waitedMs, deferrals };

    const step = this.steps[Math.min(deferrals, this.steps.length - 1)]!;
    // Never sleep past the cap: the last check lands right when the window closes.
    const delayMs = Math.max(1, Math.min(step, remaining)) + Math.floor(this.random() * this.jitterMs);
    return { action: 'defer', delayMs, waitedMs, state: { since, deferrals: deferrals + 1 } };
  }
}

/**
 * Gate over the env-configured Twenty (TWENTY_BASE_URL / TWENTY_API_KEY), with
 * TWENTY_WAIT_MAX_MS (default 10 min; 0 disables the gate).
 */
export function twentyGateFromEnv(env: NodeJS.ProcessEnv = process.env, opts: TwentyGateOptions = {}): TwentyGate {
  const client = twentyClientFromEnv(env);
  const raw = env.TWENTY_WAIT_MAX_MS;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  const maxWaitMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TWENTY_WAIT_MAX_MS;
  return new TwentyGate(
    { isConfigured: () => client.isConfigured(), health: () => client.health(DEFAULT_TWENTY_HEALTH_TIMEOUT_MS) },
    { maxWaitMs, ...opts },
  );
}
