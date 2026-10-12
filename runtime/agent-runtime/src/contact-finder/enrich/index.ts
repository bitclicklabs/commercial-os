/**
 * EnrichService: provider + daily lookup cap + cost accounting.
 *
 * Env:
 * - `ENRICH_PROVIDER`: `stub` (default; fixtures of reserved test domains only) or `hunter`.
 *   `hunter` without `ENRICH_API_KEY` falls back to the stub (and says so in `warning`).
 * - `ENRICH_API_KEY`: Hunter.io key.
 * - `ENRICH_MAX_LOOKUPS_PER_DAY` (default 25): lookups per local day (Europe/Madrid) and
 *   process. The counter lives in memory (a restart resets it) and every lookup is logged.
 * - `ENRICH_COST_PER_LOOKUP_EUR` (default 0.10): cost recorded per real lookup (Hunter bills
 *   credits per search; the stub costs 0).
 */
import { localDate } from '../../inbound/suppression-list.js';
import { HunterProvider } from './hunter.js';
import { StubEnrichProvider } from './stub.js';
import { EnrichError, type EnrichOutcome, type EnrichProvider } from './types.js';

export * from './types.js';
export { HunterProvider, HUNTER_BASE_URL } from './hunter.js';
export { StubEnrichProvider, STUB_ENRICH_FIXTURES } from './stub.js';

export const DEFAULT_ENRICH_MAX_LOOKUPS_PER_DAY = 25;
export const DEFAULT_ENRICH_COST_PER_LOOKUP_EUR = 0.1;
export const ENRICH_TIMEZONE = 'Europe/Madrid';

/** Lookups per local day, in memory. */
export class DailyLookupBudget {
  private day = '';
  private count = 0;

  constructor(
    readonly cap: number,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone = ENRICH_TIMEZONE,
  ) {}

  private roll(): void {
    const today = localDate(this.now(), this.timeZone);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }

  used(): number {
    this.roll();
    return this.count;
  }

  /** Takes one lookup if the cap allows it. */
  tryConsume(): boolean {
    this.roll();
    if (this.count >= this.cap) return false;
    this.count += 1;
    return true;
  }
}

export interface EnrichLogger {
  info(msg: string, meta?: object): void;
}

export class EnrichService {
  constructor(
    readonly provider: EnrichProvider,
    readonly budget: DailyLookupBudget,
    private readonly opts: { costPerLookupEur?: number; logger?: EnrichLogger; warning?: string | null } = {},
  ) {}

  get warning(): string | null {
    return this.opts.warning ?? null;
  }

  async lookup(domain: string, signal: AbortSignal): Promise<EnrichOutcome> {
    const provider = this.provider.name;
    if (!this.budget.tryConsume()) {
      this.opts.logger?.info('enrich lookup skipped: daily cap reached', { provider, cap: this.budget.cap });
      return { status: 'cap_reached', provider, lookupsToday: this.budget.used(), cap: this.budget.cap };
    }
    const lookupsToday = this.budget.used();
    const costEur = provider === 'stub' ? 0 : (this.opts.costPerLookupEur ?? DEFAULT_ENRICH_COST_PER_LOOKUP_EUR);
    try {
      const candidates = await this.provider.lookup(domain, signal);
      this.opts.logger?.info('enrich lookup', { provider, domain, results: candidates.length, lookupsToday, cap: this.budget.cap, costEur });
      return { status: 'ok', provider, candidates, costEur, lookupsToday, cap: this.budget.cap };
    } catch (err) {
      if (signal.aborted) throw err;
      const e = err instanceof EnrichError ? err : new EnrichError('ENRICH_ERROR', err instanceof Error ? err.message : String(err));
      this.opts.logger?.info('enrich lookup failed', { provider, domain, code: e.code, lookupsToday, cap: this.budget.cap });
      return { status: 'error', provider, code: e.code, message: e.message, lookupsToday, cap: this.budget.cap };
    }
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

function nonNegative(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Builds the service from env (see the module comment). */
export function enrichServiceFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { fetch?: typeof fetch; logger?: EnrichLogger; now?: () => Date } = {}): EnrichService {
  const wanted = (env.ENRICH_PROVIDER ?? 'stub').trim().toLowerCase() || 'stub';
  const key = env.ENRICH_API_KEY?.trim() ?? '';
  let provider: EnrichProvider;
  let warning: string | null = null;
  if (wanted === 'hunter' && key) {
    provider = new HunterProvider({ apiKey: key, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  } else {
    provider = new StubEnrichProvider();
    if (wanted === 'hunter') warning = 'ENRICH_PROVIDER=hunter sin ENRICH_API_KEY: se usa el stub (sin datos reales)';
    else if (wanted !== 'stub') warning = `ENRICH_PROVIDER=${wanted} desconocido: se usa el stub (valores: stub, hunter)`;
  }
  const budget = new DailyLookupBudget(positiveInt(env.ENRICH_MAX_LOOKUPS_PER_DAY, DEFAULT_ENRICH_MAX_LOOKUPS_PER_DAY), opts.now);
  return new EnrichService(provider, budget, {
    costPerLookupEur: nonNegative(env.ENRICH_COST_PER_LOOKUP_EUR, DEFAULT_ENRICH_COST_PER_LOOKUP_EUR),
    ...(opts.logger ? { logger: opts.logger } : {}),
    warning,
  });
}

let processService: EnrichService | null = null;

/** One service per process, so the daily counter is shared by every run of this worker. */
export function defaultEnrichService(): EnrichService {
  processService ??= enrichServiceFromEnv(process.env, {
    logger: { info: (msg, meta) => console.log(JSON.stringify({ level: 'info', component: 'contact-enrich', msg, ...(meta ?? {}) })) },
  });
  return processService;
}
