/**
 * Builds evaluation SUBJECTS (one run output, with its cases) from what the runtime
 * already stores:
 *
 * - `comparison_case`: one version x one input x one repetition of a `pnpm skill:compare`
 *   report (the JSON the CLI writes, single or multi-fixture). Subject id
 *   `<skill>@v<version>:<input_sha256[0:16]>:r<repetition>`.
 * - `execution_output`: one Prospector execution read from its trace (direct or scout
 *   mode). Subject id = the execution id.
 *
 * Inputs of a comparison come from the fixture files the report names; they are used only
 * when their hash matches the report's `input_sha256` (otherwise the subject falls back to
 * the data level the report recorded and warns).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, eq, or } from 'drizzle-orm';
import { readConfig } from '../agents/prospector-core.js';
import { normalizeUrl } from '../agents/source-ledger.js';
import type { Db } from '../db/client.js';
import { agentExecutions, agentVersions, traces, traceSteps } from '../db/schema.js';
import { canonicalJson, sha256, type CaseHypothesis, type CaseInput, type CaseOutput, type DataLevel, type EvaluationContext, type KnownSources } from './types.js';

export type SubjectType = 'execution_output' | 'comparison_case';

export interface EvaluationCaseRef {
  id: string;
  input: CaseInput;
  output: CaseOutput;
}

export interface EvaluationSubject {
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  /** Aggregation group: `v<version>` in a comparison, the execution id for a trace. */
  group: string;
  executorModel: string;
  agentExecutionId: string | null;
  taskRunId: string | null;
  context: EvaluationContext;
  cases: EvaluationCaseRef[];
  /** The judge scores this subject (comparisons: only the first repetition, see README). */
  judgeEligible: boolean;
  meta: Record<string, unknown>;
  /** sha256 of the canonical outputs (with case ids): the idempotency of the evaluation. */
  outputHash: string;
}

export interface LoadedSubjects {
  source: { kind: 'comparison' | 'trace'; ref: string; sha256?: string };
  subjects: EvaluationSubject[];
  warnings: string[];
}

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function outputHashOf(cases: EvaluationCaseRef[]): string {
  return sha256(canonicalJson(cases.map((c) => ({ id: c.id, output: c.output }))));
}

export function dataLevelOf(ex: { description?: string | undefined; domain?: string | undefined; sector?: string | undefined } | undefined): DataLevel {
  if (!ex) return 'unknown';
  if ((ex.description && ex.description.trim()) || (ex.domain && ex.domain.trim())) return 'rich';
  if (ex.sector && ex.sector.trim()) return 'sector';
  return 'name_only';
}

function domainOf(d: string | undefined | null): string | null {
  if (!d) return null;
  const s = d.trim().toLowerCase();
  if (!s) return null;
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function knownFromInput(event: CaseInput['event'] | undefined, exhibitors: Array<{ domain?: string }>): KnownSources {
  const urls = [event?.source_url].filter((u): u is string => typeof u === 'string' && normalizeUrl(u) !== null);
  const domains = exhibitors.map((e) => domainOf(e.domain)).filter((d): d is string => d !== null);
  return { urls, domains: [...new Set(domains)] };
}

function asHypothesis(h: unknown): CaseHypothesis | null {
  if (!h || typeof h !== 'object') return null;
  const o = h as Record<string, unknown>;
  return {
    need: String(o.need ?? ''),
    why_now: String(o.why_now ?? ''),
    quantity_min: Number(o.quantity_min ?? 0),
    quantity_max: Number(o.quantity_max ?? 0),
    budget_min_eur: Number(o.budget_min_eur ?? 0),
    budget_max_eur: Number(o.budget_max_eur ?? 0),
    recommended_products: Array.isArray(o.recommended_products) ? o.recommended_products.map(String) : [],
    timing: String(o.timing ?? 'UNKNOWN'),
    differentiators: Array.isArray(o.differentiators) ? o.differentiators.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// skill:compare reports
// ---------------------------------------------------------------------------

interface SavedDecision {
  exhibitor: string;
  dataLevel: DataLevel;
  status: string;
  relevant: boolean | null;
  confidence: number | null;
  writable: boolean;
  reason: string | null;
  hypothesis: unknown;
}
interface SavedRun {
  version: number;
  repetition: number;
  decisions: SavedDecision[];
}
interface SavedReport {
  skill: string;
  model: string;
  input_sha256: string;
  event: string;
  today?: string;
  versions: Array<{ version: number; skillVersionId?: string; contentHash?: string }>;
  runs: SavedRun[];
}
interface SavedMulti {
  skill: string;
  reports: Array<{ fixture?: string; report: SavedReport }>;
}

interface FixtureInput {
  event: CaseInput['event'];
  exhibitors: Array<CaseInput['exhibitor']>;
}

function readFixture(path: string, baseDirs: string[]): { input: FixtureInput; raw: unknown; path: string } | null {
  const candidates = isAbsolute(path) ? [path] : baseDirs.map((d) => resolve(d, path));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return { input: raw as FixtureInput, raw, path: p };
  }
  return null;
}

export interface ComparisonLoadOptions {
  /** Where the comparison JSON lives (fixture paths are resolved against it, the cwd and the runtime root). */
  baseDir?: string;
  /** Agent threshold (configuration.min_confidence) the comparison ran with. */
  minConfidence?: number;
  /**
   * Fixture inputs already in memory, by the `fixture` name of each report (the experiment
   * runner builds them from dataset cases). Used instead of reading the file; the hash check
   * against `input_sha256` still applies.
   */
  fixtureInputs?: Readonly<Record<string, unknown>>;
}

/** Parses a `skill:compare` JSON (multi-fixture `{ reports: [...] }` or a single report). */
export function subjectsFromComparison(json: unknown, ref: string, opts: ComparisonLoadOptions = {}): LoadedSubjects {
  const warnings: string[] = [];
  const multi = json as Partial<SavedMulti> & Partial<SavedReport>;
  const reports: Array<{ fixture?: string; report: SavedReport }> = Array.isArray(multi.reports)
    ? multi.reports
    : Array.isArray(multi.runs)
      ? [{ report: multi as SavedReport }]
      : [];
  if (reports.length === 0) throw new Error(`${ref}: no parece un informe de skill:compare (faltan "reports" o "runs")`);
  const baseDirs = [...new Set([opts.baseDir ?? process.cwd(), process.cwd(), RUNTIME_ROOT])];
  const minConfidence = opts.minConfidence ?? 0.5;
  const subjects: EvaluationSubject[] = [];

  for (const { fixture, report } of reports) {
    let input: FixtureInput | null = null;
    if (fixture) {
      const inMemory = opts.fixtureInputs?.[fixture];
      const f = inMemory !== undefined ? { input: inMemory as FixtureInput, raw: inMemory, path: fixture } : readFixture(fixture, baseDirs);
      if (!f) warnings.push(`no encuentro el fixture ${fixture}: se usan solo el nombre y el nivel de datos del informe`);
      else if (sha256(JSON.stringify(f.raw)) !== report.input_sha256) warnings.push(`el fixture ${fixture} no coincide con input_sha256 del informe (${report.input_sha256.slice(0, 12)}…): no se usan sus datos`);
      else input = f.input;
    }
    const event: CaseInput['event'] = input?.event ?? { name: report.event };
    const known = knownFromInput(event, input?.exhibitors ?? []);
    const minRep = Math.min(...report.runs.map((r) => r.repetition));
    for (const run of report.runs) {
      const cases: EvaluationCaseRef[] = run.decisions.map((d, i) => {
        const ex = input?.exhibitors[i]?.name === d.exhibitor ? input.exhibitors[i] : input?.exhibitors.find((e) => e.name === d.exhibitor);
        return {
          id: `${i}:${d.exhibitor}`,
          input: { event, exhibitor: ex ?? { name: d.exhibitor }, dataLevel: ex ? dataLevelOf(ex) : d.dataLevel },
          output: {
            status: d.status,
            relevant: d.relevant,
            confidence: d.confidence,
            reason: d.reason,
            hypothesis: asHypothesis(d.hypothesis),
            writable: d.writable,
          },
        };
      });
      const version = report.versions.find((v) => v.version === run.version);
      subjects.push({
        subjectType: 'comparison_case',
        subjectId: `${report.skill}@v${run.version}:${report.input_sha256.slice(0, 16)}:r${run.repetition}`,
        label: `v${run.version} · ${fixture ? (fixture.split(/[\\/]/).pop() ?? fixture).replace(/\.json$/, '') : report.event} · r${run.repetition}`,
        group: `v${run.version}`,
        executorModel: report.model,
        agentExecutionId: null,
        taskRunId: null,
        context: { knownSources: known, minConfidence },
        cases,
        judgeEligible: run.repetition === minRep,
        meta: {
          skill: report.skill,
          version: run.version,
          skill_version_id: version?.skillVersionId ?? null,
          skill_content_hash: version?.contentHash ?? null,
          repetition: run.repetition,
          input_sha256: report.input_sha256,
          fixture: fixture ?? null,
          event: report.event,
          today: report.today ?? null,
          comparison: ref,
        },
        outputHash: outputHashOf(cases),
      });
    }
  }
  return { source: { kind: 'comparison', ref, sha256: sha256(canonicalJson(json)) }, subjects, warnings };
}

// ---------------------------------------------------------------------------
// Traces (execution_output)
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set(['create_signal', 'create_research', 'create_hypothesis']);

function urlsIn(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) urlsIn(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (/url|sources?|evidence/i.test(k) || depth > 0) urlsIn(v, out, depth + 1);
}

/** Loads one Prospector execution by trace id (or execution id) with its steps. */
export async function subjectsFromTrace(db: Db, tenantId: string, id: string): Promise<LoadedSubjects> {
  const warnings: string[] = [];
  const isUuid = /^[0-9a-f-]{36}$/i.test(id);
  if (!isUuid) throw new Error(`"${id}" no es un trace_id (uuid)`);
  const trace = await db.query.traces.findFirst({ where: or(eq(traces.id, id), eq(traces.executionId, id)) });
  if (!trace || trace.tenantId !== tenantId) throw new Error(`no hay traza ${id} en el tenant ${tenantId}`);
  const exec = await db.query.agentExecutions.findFirst({ where: eq(agentExecutions.id, trace.executionId) });
  if (!exec) throw new Error(`la traza ${id} no tiene ejecución`);
  const version = exec.agentVersionId ? await db.query.agentVersions.findFirst({ where: eq(agentVersions.id, exec.agentVersionId) }) : undefined;
  const steps = await db.select().from(traceSteps).where(eq(traceSteps.traceId, trace.id)).orderBy(asc(traceSteps.sequence));
  const output = (trace.finalOutput ?? exec.output ?? {}) as Record<string, unknown>;
  const input = (exec.input ?? {}) as Record<string, unknown>;
  const cfg = readConfig((version?.configuration ?? {}) as Record<string, unknown>);

  const inputEvent = input.event as CaseInput['event'] | undefined;
  const inputExhibitors = (Array.isArray(input.exhibitors) ? input.exhibitors : []) as Array<CaseInput['exhibitor']>;
  const scoutEvents = (Array.isArray(output.events) ? output.events : []) as Array<Record<string, unknown>>;

  // Known sources: the run's SourceLedger (scout) + the input + domains the CRM returned.
  const ledger = (output.sources ?? {}) as { visited?: string[]; grounded?: Array<{ uri: string }> };
  const known = knownFromInput(inputEvent, inputExhibitors);
  known.urls.push(...(ledger.visited ?? []), ...(ledger.grounded ?? []).map((g) => g.uri));
  for (const s of steps) {
    if (s.type !== 'TOOL' || !s.tool || !['find_company', 'upsert_company'].includes(s.tool)) continue;
    const found: string[] = [];
    JSON.stringify(s.toolOutput ?? null).replace(/"domain(?:Name)?"\s*:\s*"([^"]+)"/g, (_m, d: string) => {
      found.push(d);
      return '';
    });
    for (const d of found) {
      const dom = domainOf(d);
      if (dom) known.domains.push(dom);
    }
  }

  const written = new Map<string, string[]>();
  for (const s of steps) {
    if (s.type !== 'TOOL' || !s.tool || !WRITE_TOOLS.has(s.tool)) continue;
    const ti = (s.toolInput ?? {}) as Record<string, unknown>;
    const companyId = typeof ti.companyId === 'string' ? ti.companyId : null;
    if (!companyId) continue;
    const urls: string[] = [];
    urlsIn(ti, urls);
    written.set(companyId, [...(written.get(companyId) ?? []), ...urls]);
  }

  type Result = { name: string; domain?: string | null; status: string; relevant?: boolean; confidence?: number; reason?: string; hypothesis?: unknown; company_id?: string };
  const groups: Array<{ event: CaseInput['event']; results: Result[] }> =
    scoutEvents.length > 0
      ? scoutEvents.map((ev) => ({
          event: { name: String(ev.name ?? ''), ...(ev.date ? { date: String(ev.date) } : {}), ...(ev.location ? { location: String(ev.location) } : {}), ...(ev.source_url ? { source_url: String(ev.source_url) } : {}) },
          results: (Array.isArray(ev.results) ? ev.results : []) as Result[],
        }))
      : [{ event: inputEvent ?? { name: '(sin evento)' }, results: (Array.isArray(output.results) ? output.results : []) as Result[] }];
  if (scoutEvents.length > 0) warnings.push('modo scout: los datos del expositor no se guardan en la traza; las reglas que dependen del nivel de datos no aplican');

  const cases: EvaluationCaseRef[] = [];
  for (const g of groups) {
    for (const r of g.results) {
      const ex = inputExhibitors.find((e) => e.name === r.name);
      const dom = domainOf(r.domain ?? null);
      if (dom) known.domains.push(dom);
      const confidence = typeof r.confidence === 'number' ? r.confidence : null;
      cases.push({
        id: `${cases.length}:${r.name}`,
        input: { event: g.event, exhibitor: ex ?? { name: r.name, ...(r.domain ? { domain: r.domain } : {}) }, dataLevel: ex ? dataLevelOf(ex) : scoutEvents.length > 0 ? 'unknown' : 'name_only' },
        output: {
          status: r.status,
          relevant: typeof r.relevant === 'boolean' ? r.relevant : null,
          confidence,
          reason: r.reason ?? null,
          hypothesis: asHypothesis(r.hypothesis),
          writable: r.relevant === true && confidence !== null && confidence >= cfg.minConfidence,
          writtenUrls: r.company_id ? [...new Set(written.get(r.company_id) ?? [])] : [],
        },
      });
    }
  }
  if (cases.length === 0) warnings.push('la salida de la ejecución no tiene resultados por expositor (¿es una ejecución del Prospector?)');
  known.domains = [...new Set(known.domains)];
  known.urls = [...new Set(known.urls)];

  const subject: EvaluationSubject = {
    subjectType: 'execution_output',
    subjectId: exec.id,
    label: `ejecución ${exec.id.slice(0, 8)}`,
    group: exec.id,
    executorModel: version?.model ?? 'desconocido',
    agentExecutionId: exec.id,
    taskRunId: exec.taskRunId ?? null,
    context: { knownSources: known, minConfidence: cfg.minConfidence },
    cases,
    judgeEligible: true,
    meta: { trace_id: trace.id, execution_id: exec.id, agent_version_id: exec.agentVersionId, skill_versions: trace.skillVersions, mode: scoutEvents.length > 0 ? 'scout' : 'direct' },
    outputHash: outputHashOf(cases),
  };
  return { source: { kind: 'trace', ref: trace.id }, subjects: [subject], warnings };
}
