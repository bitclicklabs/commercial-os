/**
 * Versioned harness v1 (LLD v0.1 section 7, MVP-1): the policies a run executes under,
 * versioned like skills. No processor graph: the harness only carries policies.
 * See config.ts (dimensions and precedence), resolver.ts (ref -> version, fallback) and
 * service.ts (lifecycle).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, agentVersions, type RetryPolicy, type TaskDefinition } from '../db/schema.js';
import { resolveHarnessRef } from './resolver.js';

export * from './config.js';
export * from './resolver.js';

/**
 * Retry policy to enqueue a TaskRun with: `execution.retry` of the harness of the agent's
 * ACTIVE version when it sets one, else the task's `retry_policy`. BullMQ fixes the attempts
 * when the job is created, so this is read at enqueue (the processor re-reads the harness at
 * the start of each attempt and never retries past either limit). Never throws.
 */
export async function resolveTaskRetryPolicy(db: Db, task: Pick<TaskDefinition, 'tenantId' | 'agentId' | 'retryPolicy'>): Promise<RetryPolicy> {
  try {
    const [row] = await db
      .select({ ref: agentVersions.harnessRef })
      .from(agents)
      .innerJoin(agentVersions, eq(agentVersions.id, agents.activeVersionId))
      .where(and(eq(agents.tenantId, task.tenantId), eq(agents.id, task.agentId)))
      .limit(1);
    if (!row?.ref) return task.retryPolicy;
    const resolved = await resolveHarnessRef(db, task.tenantId, row.ref);
    return resolved.config?.execution.retry ?? task.retryPolicy;
  } catch {
    return task.retryPolicy;
  }
}
