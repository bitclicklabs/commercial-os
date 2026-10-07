/**
 * Harvest of production failures of one skill version (Skill Optimizer, step 1). Read only.
 *
 * Two sources, both restricted to real runs that injected exactly that version from the
 * database (`traces.skill_versions` with `source = db`; no `stub` model, no `[TEST]` agent),
 * the same exclusions as the dataset harvester (src/datasets/harvest-prospeccion.ts):
 *
 * 1. Negative human verdicts (`evaluations.kind = 'HUMAN'`, `details.actor.human = true`, no
 *    `[TEST]` hypothesis): per hypothesis the LATEST verdict counts; DISCARDED and EDITED are
 *    failures (an EDITED carries the commercial's correction, `edited_fields`).
 * 2. Hard RULE failures: the hard RULE evaluators (src/evaluators/rules.ts) run on the most
 *    recent traces of the version, as `pnpm evaluate` does on one trace (no LLM, no cost).
 *
 * Every failure carries its entity key: the pipeline burns those entities as `design`
 * material (P5) before any experiment, so the cases that generated the change are never the
 * ones it is evaluated on.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { entityKeyOf } from '../datasets/core.js';
import { normaliseEvent, normaliseExhibitor } from '../datasets/harvest-prospeccion.js';
import { RULE_EVALUATORS, subjectsFromTrace, evaluatorKey } from '../evaluators/index.js';
import type { FailureCase } from './core.js';

interface VerdictRow extends Record<string, unknown> {
  id: string;
  subject_id: string;
  feedback: string;
  occurred_at: Date | string;
  agent_execution_id: string;
  details: Record<string, unknown>;
  trace_id: string;
  final_output: Record<string, unknown> | null;
  exec_input: Record<string, unknown> | null;
}

export interface FailureHarvest {
  failures: Array<Omit<FailureCase, 'id'>>;
  stats: {
    human_verdicts: number;
    human_failures: number;
    traces_checked: number;
    rule_failures: number;
    skipped: Array<{ ref: string; reason: string }>;
  };
}

type Result = { name?: unknown; relevant?: unknown; confidence?: unknown; reason?: unknown; hypothesis?: unknown; hypothesis_id?: unknown; domain?: unknown };

/** The result of the run that wrote `hypothesisId`, with the event it belongs to (scout) or null (direct). */
function findResult(finalOutput: Record<string, unknown> | null, hypothesisId: string): { result: Result; event: Record<string, unknown> | null } | null {
  if (!finalOutput) return null;
  const direct = Array.isArray(finalOutput.results) ? (finalOutput.results as Result[]) : [];
  const hit = direct.find((r) => r && r.hypothesis_id === hypothesisId);
  if (hit) return { result: hit, event: null };
  const events = Array.isArray(finalOutput.events) ? (finalOutput.events as Array<Record<string, unknown>>) : [];
  for (const e of events) {
    const rs = Array.isArray(e.results) ? (e.results as Result[]) : [];
    const r = rs.find((x) => x && x.hypothesis_id === hypothesisId);
    if (r) return { result: r, event: e };
  }
  return null;
}

const asOutput = (r: Result): FailureCase['output'] => ({
  relevant: typeof r.relevant === 'boolean' ? r.relevant : null,
  confidence: typeof r.confidence === 'number' ? r.confidence : null,
  reason: typeof r.reason === 'string' ? r.reason : null,
  hypothesis: r.hypothesis && typeof r.hypothesis === 'object' ? (r.hypothesis as Record<string, unknown>) : null,
});

const iso = (d: Date | string) => new Date(d).toISOString();

export async function harvestFailures(db: Db, opts: { tenantId: string; skillName: string; version: number; maxTraces: number }): Promise<FailureHarvest> {
  const marker = JSON.stringify([{ name: opts.skillName, version: opts.version, source: 'db' }]);
  const skipped: FailureHarvest['stats']['skipped'] = [];
  const failures: FailureHarvest['failures'] = [];

  // 1. Human verdicts on hypotheses written by runs of this version.
  const verdicts = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return (
      await tx.execute<VerdictRow>(sql`
        select ev.id, ev.subject_id, ev.feedback, ev.occurred_at, ev.agent_execution_id, ev.details,
               t.id as trace_id, t.final_output, e.input as exec_input
        from evaluations ev
        join traces t on t.execution_id = ev.agent_execution_id and t.tenant_id = ev.tenant_id
        join agent_executions e on e.id = ev.agent_execution_id
        join agents a on a.id = t.agent_id
        left join agent_versions av on av.id = t.agent_version_id
        where ev.tenant_id = ${opts.tenantId} and ev.kind = 'HUMAN' and ev.subject_type = 'hypothesis'
          and (ev.details->'actor'->>'human')::boolean is true
          and coalesce(ev.details->>'hypothesis_name', '') not like '[TEST]%'
          and coalesce(av.model, '') not ilike 'stub%' and coalesce(av.model, '') <> 'none'
          and a.name not like '%[TEST]%'
          and t.skill_versions @> ${marker}::jsonb
        order by ev.occurred_at, ev.id`)
    ).rows;
  });
  const latest = new Map<string, VerdictRow>();
  for (const v of verdicts) latest.set(v.subject_id, v); // rows ordered by occurred_at: the last verdict wins
  let humanFailures = 0;
  const newestFirst = [...latest.values()].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() || b.id.localeCompare(a.id));
  for (const v of newestFirst) {
    if (v.feedback !== 'DISCARDED' && v.feedback !== 'EDITED') continue;
    const found = findResult(v.final_output, v.subject_id);
    const hypName = typeof v.details.hypothesis_name === 'string' ? v.details.hypothesis_name : '';
    const name = found && typeof found.result.name === 'string' ? found.result.name : hypName.includes(' — ') ? hypName.slice(0, hypName.indexOf(' — ')) : null;
    if (!name) {
      skipped.push({ ref: `evaluation ${v.id}`, reason: 'no se encuentra el expositor de la hipótesis en la ejecución' });
      continue;
    }
    const input = v.exec_input ?? {};
    const exhibitors = Array.isArray(input.exhibitors) ? input.exhibitors : [];
    const exhibitor = exhibitors.map(normaliseExhibitor).find((x) => x?.name === name) ?? { name, ...(typeof found?.result.domain === 'string' ? { domain: found.result.domain } : {}) };
    const event = normaliseEvent(found?.event ?? input.event);
    const edited = v.details.edited_fields && typeof v.details.edited_fields === 'object' ? (v.details.edited_fields as Record<string, { before: unknown; after: unknown }>) : {};
    failures.push({
      kind: v.feedback === 'DISCARDED' ? 'human_discarded' : 'human_edited',
      entityKey: entityKeyOf(name),
      exhibitor,
      event,
      output: found ? asOutput(found.result) : null,
      ...(v.feedback === 'EDITED' ? { editedFields: edited } : {}),
      source: { traceId: v.trace_id, executionId: v.agent_execution_id, evaluationId: v.id, hypothesisId: v.subject_id, skillVersion: opts.version, occurredAt: iso(v.occurred_at) },
    });
    humanFailures++;
  }

  // 2. Hard RULE failures on the most recent traces of this version.
  const traceRows = (
    await db.execute<{ id: string; created_at: Date | string }>(sql`
      select t.id, t.created_at
      from traces t
      join agents a on a.id = t.agent_id
      left join agent_versions av on av.id = t.agent_version_id
      where t.tenant_id = ${opts.tenantId} and t.skill_versions @> ${marker}::jsonb
        and coalesce(av.model, '') not ilike 'stub%' and coalesce(av.model, '') <> 'none'
        and a.name not like '%[TEST]%'
      order by t.created_at desc, t.id
      limit ${opts.maxTraces}`)
  ).rows;
  const hard = RULE_EVALUATORS.filter((r) => r.hard);
  let ruleFailures = 0;
  for (const t of traceRows) {
    let loaded;
    try {
      loaded = await subjectsFromTrace(db, opts.tenantId, t.id);
    } catch (err) {
      skipped.push({ ref: `trace ${t.id}`, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const s of loaded.subjects) {
      for (const c of s.cases) {
        for (const r of hard) {
          const o = await r.evaluate(c.input, c.output, s.context);
          if (!o || o.pass !== false) continue;
          failures.push({
            kind: 'rule_hard_fail',
            entityKey: entityKeyOf(c.input.exhibitor.name),
            exhibitor: c.input.exhibitor,
            event: c.input.event,
            output: { relevant: c.output.relevant, confidence: c.output.confidence, reason: c.output.reason, hypothesis: c.output.hypothesis as Record<string, unknown> | null },
            evaluator: evaluatorKey(r),
            evaluatorDetails: o.details,
            source: { traceId: t.id, executionId: s.subjectId, skillVersion: opts.version, occurredAt: iso(t.created_at) },
          });
          ruleFailures++;
        }
      }
    }
  }

  return {
    failures,
    stats: { human_verdicts: latest.size, human_failures: humanFailures, traces_checked: traceRows.length, rule_failures: ruleFailures, skipped },
  };
}

/** Failures sent to the model: human verdicts first (most recent first), then rules; numbered F1.. */
export function selectFailures(all: FailureHarvest['failures'], max: number): FailureCase[] {
  const human = all.filter((f) => f.kind !== 'rule_hard_fail');
  const rules = all.filter((f) => f.kind === 'rule_hard_fail');
  return [...human, ...rules].slice(0, max).map((f, i) => ({ id: `F${i + 1}`, ...f }));
}
