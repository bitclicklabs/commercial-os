/**
 * Tenant allowlist of the scheduler (`SCHEDULER_TENANTS`, tanda 16).
 *
 * Incident 2026-10-12: integration suites run against the shared `agentos` database left
 * ACTIVE task_definitions in test tenants (`it-*`, `e2e-*`, ...). After a weekend off, the
 * multi-tenant scheduler caught up every one of them with the real Gemini and Twenty
 * credentials. Since then the scheduler only registers and fires tasks of the tenants in
 * this list:
 *
 * - unset or empty: `[DEFAULT_TENANT_ID]` (`publiexpe`);
 * - `a,b,c`: those tenants (comma separated, trimmed, duplicates collapsed);
 * - `*`: every tenant (the old multi-tenant behaviour). For test environments only.
 *
 * It applies to CRON, INTERVAL and ONCE registration (`syncAll` / `syncTask`), to the ticks
 * (`handleTick`) and to the EVENT trigger consumer. The API routes do not look at it: a
 * manual `POST /tasks/:id/run` of any tenant still works (human, audited action).
 */

export const ALL_TENANTS = '*';

export interface TenantAllowlist {
  /** True for `*`: every tenant is scheduled. */
  readonly all: boolean;
  /** The allowed tenants (empty when `all`). */
  readonly tenants: readonly string[];
}

export class TenantAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAllowlistError';
  }
}

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function allTenants(): TenantAllowlist {
  return { all: true, tenants: [] };
}

export function onlyTenants(tenants: readonly string[]): TenantAllowlist {
  return { all: false, tenants: [...new Set(tenants)] };
}

/** Parses `SCHEDULER_TENANTS`. Throws TenantAllowlistError on malformed input. */
export function parseSchedulerTenants(raw: string | undefined | null, defaultTenantId: string): TenantAllowlist {
  const value = (raw ?? '').trim();
  if (value === '') return onlyTenants([defaultTenantId]);
  if (value === ALL_TENANTS) return allTenants();
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (items.length === 0) return onlyTenants([defaultTenantId]);
  if (items.includes(ALL_TENANTS)) {
    throw new TenantAllowlistError(`SCHEDULER_TENANTS: "${ALL_TENANTS}" must be used alone (got "${value}")`);
  }
  const invalid = items.filter((t) => !TENANT_ID_RE.test(t));
  if (invalid.length > 0) throw new TenantAllowlistError(`SCHEDULER_TENANTS: invalid tenant id(s): ${invalid.join(', ')}`);
  return onlyTenants(items);
}

export function tenantAllowed(list: TenantAllowlist, tenantId: string | null | undefined): boolean {
  if (list.all) return true;
  return typeof tenantId === 'string' && list.tenants.includes(tenantId);
}

/** `*` or `a,b` (logs, docs). */
export function describeAllowlist(list: TenantAllowlist): string {
  return list.all ? ALL_TENANTS : list.tenants.join(',');
}

/** Max tenants listed by name in the aggregated WARN (the rest are summed). */
const MAX_LISTED_TENANTS = 20;

/**
 * Collects what the scheduler ignored because of the allowlist during one pass and logs it
 * as ONE aggregated WARN (never one line per task).
 */
export class IgnoredTenantsReport {
  private readonly tasks = new Map<string, number>();
  private readonly ticks = new Map<string, number>();

  addTasks(tenantId: string, count: number): void {
    if (count > 0) this.tasks.set(tenantId, (this.tasks.get(tenantId) ?? 0) + count);
  }

  addTick(tenantId: string): void {
    this.ticks.set(tenantId, (this.ticks.get(tenantId) ?? 0) + 1);
  }

  get empty(): boolean {
    return this.tasks.size === 0 && this.ticks.size === 0;
  }

  /** The WARN payload, or null when nothing was ignored. */
  summary(list: TenantAllowlist): Record<string, unknown> | null {
    if (this.empty) return null;
    const top = (m: Map<string, number>) => {
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const listed = Object.fromEntries(sorted.slice(0, MAX_LISTED_TENANTS));
      const rest = sorted.slice(MAX_LISTED_TENANTS);
      return rest.length > 0 ? { ...listed, [`(+${rest.length} more tenants)`]: rest.reduce((n, [, c]) => n + c, 0) } : listed;
    };
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    return {
      scheduler_tenants: describeAllowlist(list),
      ignored_tasks: sum(this.tasks),
      ignored_ticks: sum(this.ticks),
      ignored_tenants: this.tasks.size + [...this.ticks.keys()].filter((t) => !this.tasks.has(t)).length,
      ...(this.tasks.size > 0 ? { tasks_by_tenant: top(this.tasks) } : {}),
      ...(this.ticks.size > 0 ? { ticks_by_tenant: top(this.ticks) } : {}),
    };
  }

  /** Logs the single WARN (if anything was ignored) and resets the counters. */
  flush(list: TenantAllowlist, logger: { warn(obj: object, msg?: string): void }, msg = 'scheduler ignored tasks of tenants outside SCHEDULER_TENANTS'): boolean {
    const payload = this.summary(list);
    this.tasks.clear();
    this.ticks.clear();
    if (!payload) return false;
    logger.warn(payload, msg);
    return true;
  }
}
