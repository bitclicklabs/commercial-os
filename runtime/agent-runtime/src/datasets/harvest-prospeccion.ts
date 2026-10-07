/**
 * Harvester of the `prospeccion` domain (skill `prospector-event-exhibitors`): reads the real
 * Prospector decisions and the commercial's verdicts from the database, read-only. It does not
 * read the model's decisions (relevant, confidence, hypothesis): only what the agent RECEIVED
 * (event + exhibitor) and where it was seen, plus the human verdicts. So building a dataset
 * never exposes held-out outputs to whoever designs the next candidate (P5).
 *
 * One "occurrence" per (trace, exhibitor): the first MODEL step labelled `{ exhibitor }` of
 * the trace, numbered in decision order (position 1..n). Its input is rebuilt from:
 * - direct mode: `agent_executions.input` (`{ event, exhibitors[] }`), exactly what the agent got;
 * - scout mode: the catalog JSON captured by `render_url` (`jsonResponses`, read with the same
 *   `findExhibitorListInJson` the scout uses) when the event says `catalog_source = json_api`,
 *   else the LLM extraction steps (`scout_extract`); the event from `final_output.events`.
 *   Both are reconstructions (`input_fidelity`), name only when nothing else is found.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { findExhibitorListInJson, type JsonAnswer } from '../agents/catalog-json.js';
import { foldEntityName } from './core.js';

export const PROSPECCION_HARVESTER = 'prospeccion@1';

export interface ExhibitorData {
  name: string;
  domain?: string;
  sector?: string;
  description?: string;
}

export interface EventData {
  name: string;
  type: string;
  date?: string;
  location?: string;
  source_url?: string;
}

export type InputFidelity = 'execution_input' | 'catalog_json' | 'llm_extraction' | 'name_only_fallback';

export interface DecisionOccurrence {
  traceId: string;
  executionId: string;
  stepId: string;
  sequence: number;
  /** 1-based position of the exhibitor in the trace's decision order. */
  position: number;
  createdAt: Date;
  mode: 'direct' | 'scout';
  agent: { name: string; version: number | null; model: string | null };
  skillVersions: Array<{ name: string; version: number | null; content_hash: string | null }>;
  event: EventData | null;
  exhibitor: ExhibitorData;
  fidelity: InputFidelity;
}

export interface HumanVerdict {
  /** Latest verdict of the hypothesis (the one the case uses). */
  evaluationId: string;
  /** Every human verdict recorded for the hypothesis, oldest first. */
  evaluationIds: string[];
  hypothesisId: string;
  hypothesisName: string | null;
  feedback: 'ACCEPTED' | 'EDITED' | 'DISCARDED';
  score: number;
  occurredAt: Date;
  executionId: string;
  traceId: string | null;
  /** Exhibitor the hypothesis was written for (from the run's results), null if unknown. */
  exhibitorName: string | null;
  editedFields: Record<string, { before: unknown; after: unknown }>;
  /** Agent proposal (`create_hypothesis` input), when found in the trace. */
  proposal: Record<string, unknown> | null;
}

export interface HarvestResult {
  harvester: string;
  tenantId: string;
  occurrences: DecisionOccurrence[];
  verdicts: HumanVerdict[];
  stats: {
    traces: number;
    decisions: number;
    human_evaluations: number;
    human_verdicts: number;
    skipped_evaluations: Array<{ evaluation_id: string; reason: string }>;
  };
  warnings: string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

export function normaliseExhibitor(raw: unknown): ExhibitorData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  const out: ExhibitorData = { name };
  const domain = str(r.domain);
  const sector = str(r.sector);
  const description = str(r.description);
  if (domain) out.domain = domain;
  if (sector) out.sector = sector;
  if (description) out.description = description;
  return out;
}

export function normaliseEvent(raw: unknown, defaultType = 'FAIR'): EventData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  const out: EventData = { name, type: str(r.type) ?? defaultType };
  const date = str(r.date);
  const location = str(r.location);
  const source = str(r.source_url);
  if (date) out.date = date;
  if (location) out.location = location;
  if (source) out.source_url = source;
  return out;
}

interface StepRow extends Record<string, unknown> {
  trace_id: string;
  execution_id: string;
  created_at: Date | string;
  skill_versions: unknown;
  agent_name: string;
  agent_version: number | null;
  model: string | null;
  step_id: string;
  sequence: number;
  exhibitor: string;
}

interface TraceRow extends Record<string, unknown> {
  id: string;
  final_output: Record<string, unknown> | null;
  exec_input: Record<string, unknown> | null;
}

interface ExtractRow extends Record<string, unknown> {
  trace_id: string;
  sequence: number;
  kind: 'llm' | 'json';
  exhibitors: unknown;
  json_responses: unknown;
  page_text: string | null;
}

interface EvaluationRow extends Record<string, unknown> {
  id: string;
  subject_id: string;
  feedback: string;
  score: number | string;
  occurred_at: Date | string;
  agent_execution_id: string | null;
  details: Record<string, unknown>;
  trace_id: string | null;
}

interface ProposalRow extends Record<string, unknown> {
  hypothesis_id: string;
  tool_input: Record<string, unknown> | null;
}

const inList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** Results of a run (direct: `results[]`; scout: `events[].results[]`), with the event they belong to. */
function resultsOf(finalOutput: Record<string, unknown> | null): Array<{ result: Record<string, unknown>; event: Record<string, unknown> | null }> {
  if (!finalOutput) return [];
  const out: Array<{ result: Record<string, unknown>; event: Record<string, unknown> | null }> = [];
  const direct = finalOutput.results;
  if (Array.isArray(direct)) for (const r of direct) if (r && typeof r === 'object') out.push({ result: r as Record<string, unknown>, event: null });
  const events = finalOutput.events;
  if (Array.isArray(events)) {
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      const rs = (e as { results?: unknown }).results;
      if (Array.isArray(rs)) for (const r of rs) if (r && typeof r === 'object') out.push({ result: r as Record<string, unknown>, event: e as Record<string, unknown> });
    }
  }
  return out;
}

function dateOnly(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export { dateOnly as madridDate };

/** Lookup by exact trimmed name, then by folded name. */
class NameMap<T> {
  private exact = new Map<string, T>();
  private folded = new Map<string, T>();
  set(name: string, value: T, overwrite = false): void {
    const k = name.trim();
    const f = foldEntityName(name);
    if (overwrite || !this.exact.has(k)) this.exact.set(k, value);
    if (overwrite || !this.folded.has(f)) this.folded.set(f, value);
  }
  get(name: string): T | undefined {
    return this.exact.get(name.trim()) ?? this.folded.get(foldEntityName(name));
  }
}

/**
 * Reads occurrences and verdicts of one tenant. Everything runs in one READ ONLY transaction:
 * the harvest can point at the shared database without any risk of writing to it.
 */
export async function harvestProspeccion(db: Db, tenantId: string): Promise<HarvestResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    const warnings: string[] = [];

    const steps = (
      await tx.execute<StepRow>(sql`
        select t.id as trace_id, t.execution_id, t.created_at, t.skill_versions, a.name as agent_name,
               av.version as agent_version, av.model, s.id as step_id, s.sequence, s.input->>'exhibitor' as exhibitor
        from trace_steps s
        join traces t on t.id = s.trace_id
        join agents a on a.id = t.agent_id
        left join agent_versions av on av.id = t.agent_version_id
        where s.tenant_id = ${tenantId} and t.tenant_id = ${tenantId}
          and s.type = 'MODEL' and s.input ? 'exhibitor'
          and coalesce(av.model, '') not ilike 'stub%' and coalesce(av.model, '') <> 'none'
          and a.name not like '%[TEST]%'
        order by t.created_at, t.id, s.sequence`)
    ).rows;

    const traceIds = [...new Set(steps.map((s) => s.trace_id))];
    const traces = new Map<string, TraceRow>();
    const extracts = new Map<string, ExtractRow[]>();
    if (traceIds.length > 0) {
      const tr = await tx.execute<TraceRow>(sql`
        select t.id, t.final_output, e.input as exec_input
        from traces t join agent_executions e on e.id = t.execution_id
        where t.id in (${inList(traceIds)})`);
      for (const r of tr.rows) traces.set(r.id, r);
      const ex = await tx.execute<ExtractRow>(sql`
        select s.trace_id, s.sequence, 'llm' as kind, s.output->'decision'->'exhibitors' as exhibitors, null::jsonb as json_responses, null::text as page_text
        from trace_steps s
        where s.trace_id in (${inList(traceIds)}) and s.type = 'MODEL' and s.input->>'step' = 'scout_extract'
          and jsonb_typeof(s.output->'decision'->'exhibitors') = 'array'
        union all
        select s.trace_id, s.sequence, 'json' as kind, null::jsonb, s.tool_output->'jsonResponses', s.tool_output->>'text'
        from trace_steps s
        where s.trace_id in (${inList(traceIds)}) and s.tool = 'render_url'
          and jsonb_typeof(s.tool_output->'jsonResponses') = 'array' and jsonb_array_length(s.tool_output->'jsonResponses') > 0
        order by 1, 2`);
      for (const r of ex.rows) {
        const list = extracts.get(r.trace_id) ?? [];
        list.push(r);
        extracts.set(r.trace_id, list);
      }
    }

    // Per trace: mode, event lookup by exhibitor and exhibitor data lookup.
    const perTrace = new Map<string, { mode: 'direct' | 'scout'; data: NameMap<{ ex: ExhibitorData; fidelity: InputFidelity }>; events: NameMap<EventData>; defaultEvent: EventData | null }>();
    for (const id of traceIds) {
      const t = traces.get(id);
      const execInput = t?.exec_input ?? {};
      const isDirect = Array.isArray((execInput as { exhibitors?: unknown }).exhibitors);
      const data = new NameMap<{ ex: ExhibitorData; fidelity: InputFidelity }>();
      const events = new NameMap<EventData>();
      let defaultEvent: EventData | null = null;
      if (isDirect) {
        defaultEvent = normaliseEvent((execInput as { event?: unknown }).event);
        for (const raw of (execInput as { exhibitors: unknown[] }).exhibitors) {
          const ex = normaliseExhibitor(raw);
          if (ex) data.set(ex.name, { ex, fidelity: 'execution_input' });
        }
      } else {
        const evs = Array.isArray(t?.final_output?.events) ? (t!.final_output!.events as Array<Record<string, unknown>>) : [];
        const jsonFirst = evs.some((e) => e.catalog_source === 'json_api');
        const rows = extracts.get(id) ?? [];
        const fromJson: ExhibitorData[] = [];
        const fromLlm: ExhibitorData[] = [];
        for (const r of rows) {
          if (r.kind === 'llm' && Array.isArray(r.exhibitors)) {
            for (const raw of r.exhibitors) {
              const ex = normaliseExhibitor(raw);
              if (ex) fromLlm.push(ex);
            }
          } else if (r.kind === 'json' && Array.isArray(r.json_responses)) {
            const answers = (r.json_responses as Array<Record<string, unknown>>).map((j) => ({ url: String(j.url ?? ''), method: typeof j.method === 'string' ? j.method : 'GET', body: j.body })) as JsonAnswer[];
            const list = findExhibitorListInJson(answers, r.page_text ?? '');
            if (list) for (const item of list.items) {
              const ex = normaliseExhibitor(item);
              if (ex) fromJson.push(ex);
            }
          }
        }
        const ordered: Array<[ExhibitorData[], InputFidelity]> = jsonFirst ? [[fromJson, 'catalog_json'], [fromLlm, 'llm_extraction']] : [[fromLlm, 'llm_extraction'], [fromJson, 'catalog_json']];
        for (const [list, fidelity] of ordered) for (const ex of list) data.set(ex.name, { ex, fidelity });
        for (const e of evs) {
          const ev = normaliseEvent(e);
          if (!ev) continue;
          defaultEvent ??= ev;
          const rs = Array.isArray(e.results) ? (e.results as Array<Record<string, unknown>>) : [];
          for (const r of rs) if (typeof r.name === 'string') events.set(r.name, ev);
        }
        if (evs.length === 0) warnings.push(`trace ${id}: scout run without final_output.events (event unknown)`);
      }
      perTrace.set(id, { mode: isDirect ? 'direct' : 'scout', data, events, defaultEvent });
    }

    const occurrences: DecisionOccurrence[] = [];
    const seen = new Set<string>();
    const perTraceCount = new Map<string, number>();
    for (const s of steps) {
      const key = `${s.trace_id}\u0000${s.exhibitor.trim()}`;
      if (seen.has(key)) continue; // repair attempt of the same exhibitor
      seen.add(key);
      const position = (perTraceCount.get(s.trace_id) ?? 0) + 1;
      perTraceCount.set(s.trace_id, position);
      const pt = perTrace.get(s.trace_id)!;
      const found = pt.data.get(s.exhibitor);
      const skill = Array.isArray(s.skill_versions)
        ? (s.skill_versions as Array<Record<string, unknown>>).map((v) => ({
            name: String(v.name ?? ''),
            version: typeof v.version === 'number' ? v.version : null,
            content_hash: typeof v.content_hash === 'string' ? v.content_hash : null,
          }))
        : [];
      occurrences.push({
        traceId: s.trace_id,
        executionId: s.execution_id,
        stepId: s.step_id,
        sequence: Number(s.sequence),
        position,
        createdAt: new Date(s.created_at),
        mode: pt.mode,
        agent: { name: s.agent_name, version: s.agent_version === null ? null : Number(s.agent_version), model: s.model },
        skillVersions: skill,
        event: pt.events.get(s.exhibitor) ?? pt.defaultEvent,
        exhibitor: found ? found.ex : { name: s.exhibitor.trim() },
        fidelity: found ? found.fidelity : 'name_only_fallback',
      });
    }

    // Human verdicts on hypotheses (details.actor.human = true; [TEST] records excluded).
    const evals = (
      await tx.execute<EvaluationRow>(sql`
        select ev.id, ev.subject_id, ev.feedback, ev.score, ev.occurred_at, ev.agent_execution_id, ev.details, t.id as trace_id
        from evaluations ev
        left join traces t on t.execution_id = ev.agent_execution_id
        where ev.tenant_id = ${tenantId} and ev.kind = 'HUMAN' and ev.subject_type = 'hypothesis'
          and (ev.details->'actor'->>'human')::boolean is true
        order by ev.occurred_at, ev.id`)
    ).rows;
    const skipped: HarvestResult['stats']['skipped_evaluations'] = [];
    const byHypothesis = new Map<string, EvaluationRow[]>();
    for (const e of evals) {
      const name = typeof e.details?.hypothesis_name === 'string' ? e.details.hypothesis_name : '';
      if (name.startsWith('[TEST]')) {
        skipped.push({ evaluation_id: e.id, reason: 'test record ([TEST])' });
        continue;
      }
      if (!e.agent_execution_id) {
        skipped.push({ evaluation_id: e.id, reason: 'not linked to an agent execution' });
        continue;
      }
      if (!['ACCEPTED', 'EDITED', 'DISCARDED'].includes(e.feedback)) {
        skipped.push({ evaluation_id: e.id, reason: `feedback ${e.feedback} not handled` });
        continue;
      }
      const list = byHypothesis.get(e.subject_id) ?? [];
      list.push(e);
      byHypothesis.set(e.subject_id, list);
    }
    const hypothesisIds = [...byHypothesis.keys()];
    const proposals = new Map<string, Record<string, unknown>>();
    const finals = new Map<string, Record<string, unknown> | null>();
    if (hypothesisIds.length > 0) {
      const pr = await tx.execute<ProposalRow>(sql`
        select s.tool_output->'record'->>'id' as hypothesis_id, s.tool_input
        from trace_steps s
        where s.tenant_id = ${tenantId} and s.tool = 'create_hypothesis' and s.tool_output->'record'->>'id' in (${inList(hypothesisIds)})
        order by (s.tool_output->>'created' = 'true') desc, s.timestamp asc`);
      for (const r of pr.rows) if (!proposals.has(r.hypothesis_id) && r.tool_input) proposals.set(r.hypothesis_id, r.tool_input);
      const traceIdsOfEvals = [...new Set(evals.map((e) => e.trace_id).filter((x): x is string => Boolean(x)))].filter((id) => !traces.has(id));
      if (traceIdsOfEvals.length > 0) {
        const fo = await tx.execute<{ id: string; final_output: Record<string, unknown> | null }>(sql`select id, final_output from traces where id in (${inList(traceIdsOfEvals)})`);
        for (const r of fo.rows) finals.set(r.id, r.final_output);
      }
    }
    const verdicts: HumanVerdict[] = [];
    for (const [hypothesisId, list] of byHypothesis) {
      const last = list[list.length - 1]!;
      const finalOutput = last.trace_id ? (traces.get(last.trace_id)?.final_output ?? finals.get(last.trace_id) ?? null) : null;
      const result = resultsOf(finalOutput).find((r) => r.result.hypothesis_id === hypothesisId);
      const hypName = typeof last.details?.hypothesis_name === 'string' ? last.details.hypothesis_name : null;
      let exhibitorName = result && typeof result.result.name === 'string' ? result.result.name : null;
      if (!exhibitorName && hypName && hypName.includes(' — ')) {
        exhibitorName = hypName.slice(0, hypName.indexOf(' — '));
        warnings.push(`hypothesis ${hypothesisId}: exhibitor taken from the hypothesis name (no result with hypothesis_id in the run)`);
      }
      const edited = (last.details?.edited_fields ?? {}) as Record<string, { before: unknown; after: unknown }>;
      verdicts.push({
        evaluationId: last.id,
        evaluationIds: list.map((e) => e.id),
        hypothesisId,
        hypothesisName: hypName,
        feedback: last.feedback as HumanVerdict['feedback'],
        score: Number(last.score),
        occurredAt: new Date(last.occurred_at),
        executionId: last.agent_execution_id!,
        traceId: last.trace_id,
        exhibitorName,
        editedFields: edited && typeof edited === 'object' ? edited : {},
        proposal: proposals.get(hypothesisId) ?? null,
      });
    }

    return {
      harvester: PROSPECCION_HARVESTER,
      tenantId,
      occurrences,
      verdicts,
      stats: { traces: traceIds.length, decisions: occurrences.length, human_evaluations: evals.length, human_verdicts: verdicts.length, skipped_evaluations: skipped },
      warnings,
    };
  });
}
