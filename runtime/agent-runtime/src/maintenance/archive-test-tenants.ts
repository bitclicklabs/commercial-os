/**
 * `pnpm cleanup:archive-test-tenants [--dry-run] [--protect=a,b]`
 *
 * Archives everything that integration suites left behind in TEST TENANTS (incident
 * 2026-10-12: ACTIVE tasks of `it-*`, `e2e-*`, ... tenants run by the production scheduler).
 * `cleanup:archive-test-agents` matches agent NAMES inside one tenant and protects
 * "Prospector"/"EmailDrafter", so it never covered tenants like `it-1a2b3c4d` whose agents
 * have normal names. This script matches the TENANT ID instead (`isTestTenantId`):
 *
 *   prefixes  it-*  e2e-*  ev-*  ar-*  (plus the exact id `it`)
 *             mt-/ms-/n8n- followed by 8 hex chars (random tenants of other suites)
 *   suffixes  *-run  *-empty  *-seed  *-trig  *-skip
 *
 * Every TaskDefinition ACTIVE/PAUSED of a matched tenant moves to ARCHIVED (same transition as
 * POST /tasks/:id/archive) and every agent not yet ARCHIVED moves to ARCHIVED. Nothing is
 * deleted (LLD section 22); runs, executions and traces stay.
 *
 * - Never touches a protected tenant, whatever the pattern says: `publiexpe`,
 *   `DEFAULT_TENANT_ID`, every tenant of `SCHEDULER_TENANTS` and `--protect=...`.
 * - Idempotent: a second run changes nothing.
 * - `--dry-run` prints the same report without writing.
 * - Registrations already in BullMQ/Redis are removed by the running scheduler's periodic
 *   `syncAll` (archived tasks desire nothing); the allowlist already keeps them from firing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db/client.js';
import { agents, taskDefinitions } from '../db/schema.js';

/** Never archived, whatever the configuration says. */
export const ALWAYS_PROTECTED_TENANTS: readonly string[] = ['publiexpe'];

const TEST_TENANT_PREFIXES = ['it-', 'e2e-', 'ev-', 'ar-'] as const;
const TEST_TENANT_EXACT: ReadonlySet<string> = new Set(['it']);
const TEST_TENANT_RANDOM = /^(mt|ms|n8n)-[0-9a-f]{8}$/;
const TEST_TENANT_SUFFIX = /-(run|empty|seed|trig|skip)$/;

/** True for tenant ids created by the test suites. */
export function isTestTenantId(tenantId: string): boolean {
  const id = tenantId.trim();
  if (id === '') return false;
  return (
    TEST_TENANT_EXACT.has(id) ||
    TEST_TENANT_PREFIXES.some((p) => id.startsWith(p) && id.length > p.length) ||
    TEST_TENANT_RANDOM.test(id) ||
    TEST_TENANT_SUFFIX.test(id)
  );
}

export interface TenantArchiveChange {
  tenant: string;
  /** TaskDefinitions moved to ARCHIVED, by previous status. */
  tasks: { ACTIVE: number; PAUSED: number };
  /** Agents moved to ARCHIVED. */
  agents: number;
}

export interface TenantArchiveReport {
  dryRun: boolean;
  protected: string[];
  /** Test tenants found (with at least one agent or task). */
  matched: number;
  /** Tenants with changes (the rest were already archived). */
  changes: TenantArchiveChange[];
  totals: { tasks: number; agents: number };
  /** Matched tenants skipped because they are protected (should be empty). */
  skippedProtected: string[];
}

export interface ArchiveTestTenantsOptions {
  /** Never archived even if they match (the script adds DEFAULT_TENANT_ID and SCHEDULER_TENANTS). */
  protectedTenants?: readonly string[];
  dryRun?: boolean;
  /** Restrict the scan to these tenant ids (tests); they still have to match the pattern. */
  onlyTenants?: readonly string[];
}

export async function archiveTestTenants(db: Db, opts: ArchiveTestTenantsOptions = {}): Promise<TenantArchiveReport> {
  const dryRun = Boolean(opts.dryRun);
  const protectedSet = new Set([...ALWAYS_PROTECTED_TENANTS, ...(opts.protectedTenants ?? [])].map((t) => t.trim()).filter(Boolean));
  const [agentTenants, taskTenants] = await Promise.all([
    db.selectDistinct({ tenantId: agents.tenantId }).from(agents),
    db.selectDistinct({ tenantId: taskDefinitions.tenantId }).from(taskDefinitions),
  ]);
  const scope = opts.onlyTenants ? new Set(opts.onlyTenants) : null;
  const all = [...new Set([...agentTenants, ...taskTenants].map((r) => r.tenantId))]
    .filter((t) => isTestTenantId(t) && (!scope || scope.has(t)))
    .sort();
  const skippedProtected = all.filter((t) => protectedSet.has(t));
  const tenants = all.filter((t) => !protectedSet.has(t));
  const report: TenantArchiveReport = {
    dryRun,
    protected: [...protectedSet].sort(),
    matched: tenants.length,
    changes: [],
    totals: { tasks: 0, agents: 0 },
    skippedProtected,
  };
  if (tenants.length === 0) return report;

  const apply = async (tx: Pick<Db, 'select' | 'update'>) => {
    const now = new Date();
    for (const tenant of tenants) {
      const liveTasks = and(eq(taskDefinitions.tenantId, tenant), inArray(taskDefinitions.status, ['ACTIVE', 'PAUSED']));
      const liveAgents = and(eq(agents.tenantId, tenant), ne(agents.status, 'ARCHIVED'));
      let taskRows: Array<{ status: string }>;
      let agentCount: number;
      if (dryRun) {
        taskRows = await tx.select({ status: taskDefinitions.status }).from(taskDefinitions).where(liveTasks);
        const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(agents).where(liveAgents);
        agentCount = Number(row?.n ?? 0);
      } else {
        // One UPDATE per previous status, so the report can say what each task was.
        taskRows = [];
        for (const status of ['ACTIVE', 'PAUSED'] as const) {
          const updated = await tx
            .update(taskDefinitions)
            .set({ status: 'ARCHIVED', updatedAt: now, updatedBy: 'cleanup:archive-test-tenants' })
            .where(and(eq(taskDefinitions.tenantId, tenant), eq(taskDefinitions.status, status)))
            .returning({ id: taskDefinitions.id });
          taskRows.push(...updated.map(() => ({ status })));
        }
        const archivedAgents = await tx.update(agents).set({ status: 'ARCHIVED', updatedAt: now }).where(liveAgents).returning({ id: agents.id });
        agentCount = archivedAgents.length;
      }
      const tasks = {
        ACTIVE: taskRows.filter((t) => t.status === 'ACTIVE').length,
        PAUSED: taskRows.filter((t) => t.status === 'PAUSED').length,
      };
      if (tasks.ACTIVE + tasks.PAUSED + agentCount === 0) continue;
      report.changes.push({ tenant, tasks, agents: agentCount });
      report.totals.tasks += tasks.ACTIVE + tasks.PAUSED;
      report.totals.agents += agentCount;
    }
  };

  if (dryRun) await apply(db);
  else await db.transaction(async (tx) => apply(tx));
  return report;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const protectedTenants = [
    config.defaultTenantId,
    ...config.schedulerTenants.tenants,
    ...(arg('protect') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
  ];
  const handle = createDb(config.databaseUrl);
  archiveTestTenants(handle.db, { protectedTenants, dryRun })
    .then((r) => {
      console.log(
        `[cleanup] ${r.matched} test tenants${r.dryRun ? ' (dry-run, nothing written)' : ''}: ${r.totals.tasks} tasks and ` +
          `${r.totals.agents} agents ${r.dryRun ? 'would be archived' : 'archived'} in ${r.changes.length} tenants; protected: ${r.protected.join(', ')}`,
      );
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err: unknown) => {
      console.error('[cleanup] failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
