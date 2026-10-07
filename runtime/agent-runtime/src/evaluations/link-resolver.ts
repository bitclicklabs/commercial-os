/**
 * Resolves the Agent OS run that produced a Twenty `commercialHypothesis`.
 *
 * The hypothesis in Twenty does not store `agentExecutionId` (App deviation 8 / D1), so the
 * link is recovered from the Agent OS traces, in this order:
 *
 * 1. `trace_output`: a `create_hypothesis` trace step whose tool output is that record id
 *    (`tool_output.record.id`). Re-runs are idempotent and return the same id with
 *    `created = false`, so the step with `created = true` wins, then the oldest.
 * 2. `execution_output`: an execution whose final output mentions the record id.
 * 3. `company_name`: a `create_hypothesis` call for the same company whose explicit name, or
 *    default name `{company} — {need}`, matches the hypothesis name (covers a tool call that
 *    timed out after Twenty applied it, so its output was never stored).
 *
 * Unresolved subjects return `{ resolved: false }`; the caller stores the evaluation
 * without link and says so in `details.link`.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { HypothesisProposal } from './human-feedback.js';

export type LinkMethod = 'trace_output' | 'execution_output' | 'company_name';

export type ResolvedLink =
  | {
      resolved: true;
      method: LinkMethod;
      agentExecutionId: string;
      taskRunId: string | null;
      traceId: string | null;
      /** Input of the originating `create_hypothesis` call (the agent's proposal). */
      proposal: HypothesisProposal | null;
      /** How many runs touched the same record (idempotent re-runs). */
      candidates: number;
    }
  | { resolved: false; method: null; reason: string };

export interface HypothesisRef {
  tenantId: string;
  hypothesisId: string;
  companyId?: string | null;
  name?: string | null;
}

interface StepRow extends Record<string, unknown> {
  execution_id: string;
  task_run_id: string | null;
  trace_id: string;
  tool_input: unknown;
  created: string | null;
}

const MAX_NAME = 120;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** True when a `create_hypothesis` input would have produced `name` (explicit or default `{company} — {need}`). */
export function inputMatchesName(input: unknown, name: string): boolean {
  if (!input || typeof input !== 'object') return false;
  const i = input as { name?: unknown; need?: unknown };
  if (typeof i.name === 'string') return truncate(i.name, MAX_NAME) === name;
  if (typeof i.need !== 'string') return false;
  const sep = name.indexOf(' — ');
  if (sep < 0) return false;
  const company = name.slice(0, sep);
  return truncate(`${company} — ${i.need}`, MAX_NAME) === name;
}

function proposalOf(input: unknown): HypothesisProposal | null {
  return input && typeof input === 'object' ? (input as HypothesisProposal) : null;
}

export async function resolveHypothesisOrigin(db: Db, ref: HypothesisRef): Promise<ResolvedLink> {
  // 1. Exact: tool output carries the Twenty record id.
  const byOutput = await db.execute<StepRow>(sql`
    select t.execution_id, coalesce(t.task_run_id, e.task_run_id) as task_run_id, t.id as trace_id,
           s.tool_input, s.tool_output->>'created' as created
    from trace_steps s
    join traces t on t.id = s.trace_id
    join agent_executions e on e.id = t.execution_id
    where s.tenant_id = ${ref.tenantId}
      and s.tool = 'create_hypothesis'
      and s.tool_output->'record'->>'id' = ${ref.hypothesisId}
    order by (s.tool_output->>'created' = 'true') desc, s.timestamp asc
    limit 50`);
  const first = byOutput.rows[0];
  if (first) {
    return {
      resolved: true,
      method: 'trace_output',
      agentExecutionId: first.execution_id,
      taskRunId: first.task_run_id,
      traceId: first.trace_id,
      proposal: proposalOf(first.tool_input),
      candidates: byOutput.rows.length,
    };
  }

  // 2. The id appears in an execution's final output.
  const byExecution = await db.execute<{ id: string; task_run_id: string | null; trace_id: string | null }>(sql`
    select e.id, e.task_run_id, t.id as trace_id
    from agent_executions e
    left join traces t on t.execution_id = e.id
    where e.tenant_id = ${ref.tenantId}
      and e.output is not null
      and strpos(e.output::text, ${ref.hypothesisId}) > 0
    order by e.created_at asc
    limit 10`);
  const execution = byExecution.rows[0];
  if (execution) {
    return {
      resolved: true,
      method: 'execution_output',
      agentExecutionId: execution.id,
      taskRunId: execution.task_run_id,
      traceId: execution.trace_id,
      proposal: null,
      candidates: byExecution.rows.length,
    };
  }

  // 3. Fallback: same company + hypothesis name.
  if (ref.companyId && ref.name) {
    const byCompany = await db.execute<StepRow>(sql`
      select t.execution_id, coalesce(t.task_run_id, e.task_run_id) as task_run_id, t.id as trace_id,
             s.tool_input, s.tool_output->>'created' as created
      from trace_steps s
      join traces t on t.id = s.trace_id
      join agent_executions e on e.id = t.execution_id
      where s.tenant_id = ${ref.tenantId}
        and s.tool = 'create_hypothesis'
        and s.tool_input->>'companyId' = ${ref.companyId}
      order by s.timestamp asc
      limit 200`);
    const name = ref.name;
    const matches = byCompany.rows.filter((r) => inputMatchesName(r.tool_input, name));
    const match = matches[0];
    if (match) {
      return {
        resolved: true,
        method: 'company_name',
        agentExecutionId: match.execution_id,
        taskRunId: match.task_run_id,
        traceId: match.trace_id,
        proposal: proposalOf(match.tool_input),
        candidates: matches.length,
      };
    }
  }

  return { resolved: false, method: null, reason: 'no create_hypothesis trace or execution output references this record' };
}

/** Compact form stored in `evaluations.details.link`. */
export function linkDetails(link: ResolvedLink): Record<string, unknown> {
  if (!link.resolved) return { resolved: false, reason: link.reason };
  return { resolved: true, method: link.method, trace_id: link.traceId, candidates: link.candidates };
}
