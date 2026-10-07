/**
 * `pnpm cleanup:archive-test-agents [--tenant=publiexpe] [--dry-run]`
 *
 * Archives the agents left behind by live tests: every agent whose name starts with
 * "[TEST]" or contains "(live test)" (e.g. "Prospector Scout (live test)") moves to
 * ARCHIVED, and its ACTIVE/PAUSED TaskDefinitions move to ARCHIVED too (same transition as
 * POST /tasks/:id/archive). Nothing is deleted (LLD section 22: no physical DELETE); runs,
 * executions, traces and verdicts stay as they are and keep counting in /metrics/summary.
 *
 * - Idempotent: a second run changes nothing (already ARCHIVED rows are skipped).
 * - Protected names (Prospector, EmailDrafter) are never touched, whatever the pattern says.
 * - `--dry-run` prints the same report without writing.
 * - Every change is printed as JSON (`agent`/`task`, id, name, from -> to).
 * - Scheduler registrations (CRON/EVENT) of the archived tasks are dropped by the periodic
 *   `syncAll` of the running scheduler (and the event consumer re-checks PostgreSQL first).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db/client.js';
import { agents, taskDefinitions } from '../db/schema.js';

export const TEST_AGENT_PREFIX = '[TEST]';
const LIVE_TEST_MARK = /\(live test\)/i;
/** Real agents: never archived by this script. */
export const PROTECTED_AGENT_NAMES: ReadonlySet<string> = new Set(['Prospector', 'EmailDrafter']);

/** True for agents created by tests ("[TEST] ..." or "... (live test)"). */
export function isTestAgentName(name: string): boolean {
  const trimmed = name.trim();
  if (PROTECTED_AGENT_NAMES.has(trimmed)) return false;
  return trimmed.startsWith(TEST_AGENT_PREFIX) || LIVE_TEST_MARK.test(trimmed);
}

export interface ArchiveChange {
  kind: 'agent' | 'task';
  id: string;
  name: string;
  /** For tasks: the agent they belong to. */
  agent?: string;
  from: string;
  to: 'ARCHIVED';
}

export interface ArchiveReport {
  tenant: string;
  dryRun: boolean;
  /** Test agents found (any status). */
  matched: number;
  changes: ArchiveChange[];
  /** Test agents already ARCHIVED with no live task left. */
  alreadyArchived: string[];
}

export async function archiveTestAgents(db: Db, opts: { tenantId: string; dryRun?: boolean }): Promise<ArchiveReport> {
  const dryRun = Boolean(opts.dryRun);
  const all = await db.query.agents.findMany({ where: eq(agents.tenantId, opts.tenantId) });
  const matched = all.filter((a) => isTestAgentName(a.name)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const report: ArchiveReport = { tenant: opts.tenantId, dryRun, matched: matched.length, changes: [], alreadyArchived: [] };
  if (matched.length === 0) return report;

  const liveTasks = await db.query.taskDefinitions.findMany({
    where: and(
      eq(taskDefinitions.tenantId, opts.tenantId),
      inArray(
        taskDefinitions.agentId,
        matched.map((a) => a.id),
      ),
      inArray(taskDefinitions.status, ['ACTIVE', 'PAUSED']),
    ),
  });

  const apply = async (tx: Pick<Db, 'update'>) => {
    const now = new Date();
    for (const agent of matched) {
      const tasks = liveTasks.filter((t) => t.agentId === agent.id);
      for (const task of tasks) {
        if (!dryRun) {
          const [row] = await tx
            .update(taskDefinitions)
            .set({ status: 'ARCHIVED', updatedAt: now, updatedBy: 'cleanup:archive-test-agents' })
            .where(and(eq(taskDefinitions.id, task.id), eq(taskDefinitions.status, task.status)))
            .returning({ id: taskDefinitions.id });
          if (!row) continue; // changed concurrently; the next run picks it up
        }
        report.changes.push({ kind: 'task', id: task.id, name: task.name, agent: agent.name, from: task.status, to: 'ARCHIVED' });
      }
      if (agent.status === 'ARCHIVED') {
        if (tasks.length === 0) report.alreadyArchived.push(agent.name);
        continue;
      }
      if (!dryRun) {
        const [row] = await tx
          .update(agents)
          .set({ status: 'ARCHIVED', updatedAt: now })
          .where(and(eq(agents.id, agent.id), eq(agents.status, agent.status)))
          .returning({ id: agents.id });
        if (!row) continue;
      }
      report.changes.push({ kind: 'agent', id: agent.id, name: agent.name, from: agent.status, to: 'ARCHIVED' });
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
  const tenantId = arg('tenant') ?? config.defaultTenantId;
  const dryRun = process.argv.includes('--dry-run');
  const handle = createDb(config.databaseUrl);
  archiveTestAgents(handle.db, { tenantId, dryRun })
    .then((r) => {
      const agentsChanged = r.changes.filter((c) => c.kind === 'agent').length;
      const tasksChanged = r.changes.length - agentsChanged;
      console.log(
        `[cleanup] tenant ${r.tenant}${r.dryRun ? ' (dry-run, nothing written)' : ''}: ${r.matched} test agents, ` +
          `${agentsChanged} agents and ${tasksChanged} tasks ${r.dryRun ? 'would be archived' : 'archived'}, ${r.alreadyArchived.length} already archived`,
      );
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err: unknown) => {
      console.error('[cleanup] failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
