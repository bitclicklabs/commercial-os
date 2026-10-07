/**
 * Offline comparison of two versions of a skill on the SAME input (manual skill cycle,
 * LLD v0.1 sections 6.3 and 11.5; the automatic Experiment is MVP-3). Each version runs the
 * real agent pipeline with the real provider, but the tools are whatever the caller injects:
 * `pnpm skill:compare` injects an in-memory Twenty (FakeTwenty), so nothing reaches the CRM.
 *
 * P5 (never evaluate on the data that produced the change) is the caller's job: the input
 * must not contain the traces used to design the candidate. The report records the input
 * hash so the experiment document can cite exactly what was run.
 *
 * Supported skills: `prospector-event-exhibitors` (Prospector, direct mode). Another skill
 * needs its own harness here (which agent runs it and how its decisions are read).
 */
import { ProspectorAgent, ProspectorInput, type ExhibitorResult } from '../agents/prospector-agent.js';
import { readConfig } from '../agents/prospector-core.js';
import type { AgentContext, AgentStep } from '../agents/agent.js';
import type { CompletionRequest, CompletionResult, CostBreakdown, ModelProvider, StreamChunk, TokenUsage } from '../providers/model-provider.js';
import type { AgentToolbox } from '../tools/executor.js';
import { sha256 } from './render.js';
import { SkillSet } from './resolver.js';

export const COMPARABLE_SKILLS = ['prospector-event-exhibitors'] as const;

/** One version under comparison: the exact rendered text the agent injects. */
export interface CompareVersion {
  version: number;
  status: string;
  skillVersionId: string;
  /** `renderSkill(version)`: the text injected in the system prompt. */
  text: string;
  contentHash: string;
}

export interface CompareAgentVersion {
  model: string;
  configuration: Record<string, unknown>;
}

export interface CompareOptions {
  skillName: string;
  versions: [CompareVersion, CompareVersion];
  /** Direct-mode Prospector input: `{ event, exhibitors[] }`. */
  input: Record<string, unknown>;
  provider: ModelProvider;
  /** A fresh toolbox per run (FakeTwenty in the CLI, so every run starts from an empty CRM). */
  makeTools: (runLabel: string) => AgentToolbox;
  agentVersion: CompareAgentVersion;
  /** Runs per version (>= 1). Order alternates (a,b / b,a) between repetitions. */
  repeat?: number;
  /** "Today" the agent sees (timing is relative to it). */
  now?: () => Date;
  /** Stops before the next model call once the spent cost (EUR) reaches it. */
  maxCostEur?: number;
  /** A budget shared by several comparisons (the CLI runs one per fixture); overrides `maxCostEur`. */
  budget?: BudgetGuardProvider;
  tenantId?: string;
  onProgress?: (msg: string) => void;
}

export type DataLevel = 'name_only' | 'sector' | 'rich';

export interface CaseDecision {
  exhibitor: string;
  dataLevel: DataLevel;
  status: ExhibitorResult['status'];
  relevant: boolean | null;
  confidence: number | null;
  /** relevant and confidence >= min_confidence: the case the agent writes to the CRM. */
  writable: boolean;
  reason: string | null;
  hypothesis: ExhibitorResult['hypothesis'] | null;
  usage: TokenUsage;
  /** Model cost of this exhibitor's calls, provider currency (USD for Gemini). */
  cost: number;
  attempts: number;
}

export interface VersionRun {
  version: number;
  repetition: number;
  decisions: CaseDecision[];
  usage: TokenUsage;
  costEur: number;
  llmCalls: number;
  outcome: string;
  /** Records the run's SkillSet produced (proves which version was injected). */
  skillRecords: ReturnType<SkillSet['runRecords']>;
}

export interface VersionMetrics {
  version: number;
  runs: number;
  decisions: number;
  errors: number;
  relevant: number;
  writable: number;
  /** Mean confidence of every decision, relevant or not. */
  confidence_mean: number | null;
  /** Mean confidence of the relevant decisions only (the commercial fit the skill calibrates). */
  confidence_relevant_mean: number | null;
  /** Relevant decisions only, by the data the exhibitor brought. */
  confidence_by_level: Record<DataLevel, { n: number; mean: number | null; max: number | null }>;
  /**
   * relevant = false with confidence > 0,19: the skill's own scale says 0-0,19 is "no fit", so
   * a high value means the model read confidence as certainty of its verdict (no CRM effect:
   * irrelevant decisions are never written, but it breaks the calibration).
   */
  irrelevant_high_confidence: number;
  hypotheses: number;
  /** Distinct (quantity_min, quantity_max, budget_min, budget_max) tuples / hypotheses. */
  distinct_ranges_ratio: number | null;
  /** Most repeated tuple and how many hypotheses share it. */
  top_range: { range: string; count: number } | null;
  quantity_ratio_mean: number | null;
  quantity_ratio_over_2_5: number;
  need_with_quantities: number;
  /** Implied unit price (budget mid / quantity mid) inside the skill's 0,50-15 € band. */
  unit_price_in_band: number;
  /** Name-only cases whose reason marks the inference as such (parece, por el nombre...). */
  name_only_flagged_inference: { n: number; flagged: number };
  input_tokens: number;
  output_tokens: number;
  cost_eur: number;
  cost_eur_per_decision: number | null;
}

export interface CaseComparison {
  exhibitor: string;
  dataLevel: DataLevel;
  /** Per version: mean confidence over the repetitions, relevant/writable votes, last hypothesis. */
  byVersion: Array<{
    version: number;
    relevant: string;
    writable: string;
    confidence_mean: number | null;
    confidences: Array<number | null>;
    hypothesis: CaseDecision['hypothesis'];
    reason: string | null;
  }>;
  confidence_delta: number | null;
  writable_changed: boolean;
}

export interface ComparisonReport {
  skill: string;
  generated_at: string;
  today: string;
  model: string;
  input_sha256: string;
  event: string;
  exhibitors: number;
  repeat: number;
  versions: Array<Pick<CompareVersion, 'version' | 'status' | 'skillVersionId' | 'contentHash'>>;
  runs: VersionRun[];
  metrics: [VersionMetrics, VersionMetrics];
  cases: CaseComparison[];
  /** Same version, same exhibitor, between repetitions (only with repeat > 1). */
  stability: Array<{ version: number; confidence_mad: number | null; relevant_flips: number; writable_flips: number }>;
  total_cost_eur: number;
  budget_eur: number | null;
  budget_exceeded: boolean;
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(spentEur: number, maxEur: number) {
    super(`presupuesto agotado: ${spentEur.toFixed(4)} € gastados de ${maxEur.toFixed(4)} €`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Provider wrapper that refuses new calls once the spent cost reaches the budget. The
 * agent turns the refusal into an `llm_error` for that exhibitor and goes on without
 * calling the model again; the comparison is marked `budget_exceeded`.
 */
export class BudgetGuardProvider implements ModelProvider {
  readonly name: string;
  spentEur = 0;
  exceeded = false;

  constructor(
    private readonly inner: ModelProvider,
    readonly maxEur: number,
    private readonly usdToEur: number,
  ) {
    this.name = inner.name;
  }

  private toEur(cost: CostBreakdown): number {
    return cost.currency === 'EUR' ? cost.modelCost : cost.modelCost * this.usdToEur;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.spentEur >= this.maxEur) {
      this.exceeded = true;
      throw new BudgetExceededError(this.spentEur, this.maxEur);
    }
    const result = await this.inner.complete(request);
    this.spentEur += this.toEur(result.cost);
    return result;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const result = await this.complete(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }

  estimateCost(model: string, usage: TokenUsage): CostBreakdown {
    return this.inner.estimateCost(model, usage);
  }
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (a: number[]) => (a.length === 0 ? null : round(a.reduce((x, y) => x + y, 0) / a.length));
const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

export function dataLevel(ex: { description?: string | undefined; domain?: string | undefined; sector?: string | undefined }): DataLevel {
  if ((ex.description && ex.description.trim()) || (ex.domain && ex.domain.trim())) return 'rich';
  if (ex.sector && ex.sector.trim()) return 'sector';
  return 'name_only';
}

/** A number in free text that is not a year ("Gastrónoma 2026" is not a quantity). */
export const QUANTITY_IN_TEXT = /\b(?!(?:19|20)\d\d\b)\d+\b/;

/** Words that mark a statement as an inference (reason of a name-only case). */
export const INFERENCE_MARKERS = /\b(parece|pareceria|parecer|por el nombre|por su nombre|supone|suponemos|suposici[oó]n|asum|previsiblemente|probablemente|posiblemente|podr[ií]a|presumiblemente|sin confirmar|no consta|deducimos|se deduce|intuye)/i;

function modelStepsByExhibitor(steps: AgentStep[]): Map<string, { usage: TokenUsage; cost: number; attempts: number }> {
  const out = new Map<string, { usage: TokenUsage; cost: number; attempts: number }>();
  for (const s of steps) {
    if (s.type !== 'MODEL') continue;
    const name = (s.input as { exhibitor?: unknown } | undefined)?.exhibitor;
    if (typeof name !== 'string') continue;
    const acc = out.get(name) ?? { usage: { ...ZERO }, cost: 0, attempts: 0 };
    const u = s.usage ?? ZERO;
    acc.usage = { inputTokens: acc.usage.inputTokens + u.inputTokens, outputTokens: acc.usage.outputTokens + u.outputTokens, cachedTokens: acc.usage.cachedTokens + u.cachedTokens };
    acc.cost += Number((s.output as { cost?: { amount?: unknown } } | undefined)?.cost?.amount ?? 0) || 0;
    acc.attempts += 1;
    out.set(name, acc);
  }
  return out;
}

/** Builds the SkillSet a run gets: exactly this version, as the resolver would record it. */
export function skillSetFor(skillName: string, v: CompareVersion): SkillSet {
  return new SkillSet([
    {
      record: {
        name: skillName,
        version: v.version,
        skill_version_id: v.skillVersionId,
        content_hash: sha256(v.text),
        source: 'db',
        requested: { name: skillName, version: v.version },
      },
      text: v.text,
    },
  ]);
}

async function runOnce(opts: CompareOptions, v: CompareVersion, repetition: number, provider: ModelProvider): Promise<VersionRun> {
  const input = ProspectorInput.parse(opts.input);
  const runLabel = `skill-compare:${opts.skillName}:v${v.version}:r${repetition}`;
  const skills = skillSetFor(opts.skillName, v);
  const ctx: AgentContext = {
    tenantId: opts.tenantId ?? 'publiexpe',
    executionId: `${runLabel}:${Date.now().toString(36)}`,
    agent: { id: 'skill-compare', name: 'Prospector (skill:compare)', role: 'prospector' },
    version: { id: 'skill-compare', version: 0, model: opts.agentVersion.model, modelProvider: provider.name, systemPrompt: '', configuration: opts.agentVersion.configuration },
    input: opts.input,
    provider,
    signal: new AbortController().signal,
    tools: opts.makeTools(runLabel),
    skills,
  };
  const agent = new ProspectorAgent(opts.now ?? (() => new Date()));
  const result = await agent.run(ctx);
  const results = (result.output.results ?? []) as ExhibitorResult[];
  const perExhibitor = modelStepsByExhibitor(result.steps);
  const minConfidence = readConfig(opts.agentVersion.configuration).minConfidence;
  const decisions: CaseDecision[] = input.exhibitors.map((ex, i) => {
    const r = results[i];
    const m = perExhibitor.get(ex.name) ?? { usage: { ...ZERO }, cost: 0, attempts: 0 };
    return {
      exhibitor: ex.name,
      dataLevel: dataLevel(ex),
      status: r?.status ?? 'llm_error',
      relevant: r?.relevant ?? null,
      confidence: r?.confidence ?? null,
      writable: r?.relevant === true && (r.confidence ?? 0) >= minConfidence,
      reason: r?.reason ?? null,
      hypothesis: r?.hypothesis ?? null,
      usage: m.usage,
      cost: round(m.cost, 6),
      attempts: m.attempts,
    };
  });
  const cost = result.output.cost as { eur?: number } | undefined;
  return {
    version: v.version,
    repetition,
    decisions,
    usage: result.usage,
    costEur: round(cost?.eur ?? 0, 6),
    llmCalls: decisions.reduce((n, d) => n + d.attempts, 0),
    outcome: String(result.output.outcome ?? 'UNKNOWN'),
    skillRecords: skills.runRecords(),
  };
}

const rangeKey = (h: NonNullable<CaseDecision['hypothesis']>) => `${h.quantity_min}-${h.quantity_max} u / ${h.budget_min_eur}-${h.budget_max_eur} €`;

export function versionMetrics(version: number, runs: VersionRun[]): VersionMetrics {
  const mine = runs.filter((r) => r.version === version);
  const ds = mine.flatMap((r) => r.decisions);
  const ok = ds.filter((d) => d.confidence !== null);
  const rel = ok.filter((d) => d.relevant === true);
  const level = (l: DataLevel) => {
    const c = rel.filter((d) => d.dataLevel === l).map((d) => d.confidence!);
    return { n: c.length, mean: mean(c), max: c.length ? Math.max(...c) : null };
  };
  const hyps = ds.map((d) => d.hypothesis).filter((h): h is NonNullable<CaseDecision['hypothesis']> => Boolean(h));
  const ranges = new Map<string, number>();
  for (const h of hyps) ranges.set(rangeKey(h), (ranges.get(rangeKey(h)) ?? 0) + 1);
  const top = [...ranges.entries()].sort((a, b) => b[1] - a[1])[0];
  const ratios = hyps.filter((h) => h.quantity_min > 0).map((h) => h.quantity_max / h.quantity_min);
  const unitOk = hyps.filter((h) => {
    const q = (h.quantity_min + h.quantity_max) / 2;
    if (q <= 0) return false;
    const unit = (h.budget_min_eur + h.budget_max_eur) / 2 / q;
    return unit >= 0.5 && unit <= 15;
  }).length;
  const nameOnly = ok.filter((d) => d.dataLevel === 'name_only' && d.reason);
  const usage = mine.reduce((u, r) => ({ inputTokens: u.inputTokens + r.usage.inputTokens, outputTokens: u.outputTokens + r.usage.outputTokens, cachedTokens: u.cachedTokens + r.usage.cachedTokens }), { ...ZERO });
  const costEur = round(mine.reduce((n, r) => n + r.costEur, 0), 6);
  return {
    version,
    runs: mine.length,
    decisions: ds.length,
    errors: ds.filter((d) => d.confidence === null).length,
    relevant: ok.filter((d) => d.relevant).length,
    writable: ok.filter((d) => d.writable).length,
    confidence_mean: mean(ok.map((d) => d.confidence!)),
    confidence_relevant_mean: mean(rel.map((d) => d.confidence!)),
    irrelevant_high_confidence: ok.filter((d) => d.relevant === false && d.confidence! > 0.19).length,
    confidence_by_level: { name_only: level('name_only'), sector: level('sector'), rich: level('rich') },
    hypotheses: hyps.length,
    distinct_ranges_ratio: hyps.length ? round(ranges.size / hyps.length, 3) : null,
    top_range: top ? { range: top[0], count: top[1] } : null,
    quantity_ratio_mean: mean(ratios),
    quantity_ratio_over_2_5: ratios.filter((r) => r > 2.5).length,
    need_with_quantities: hyps.filter((h) => QUANTITY_IN_TEXT.test(h.need)).length,
    unit_price_in_band: unitOk,
    name_only_flagged_inference: { n: nameOnly.length, flagged: nameOnly.filter((d) => INFERENCE_MARKERS.test(d.reason!)).length },
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_eur: costEur,
    cost_eur_per_decision: ds.length ? round(costEur / ds.length, 6) : null,
  };
}

export function compareCases(versions: number[], runs: VersionRun[]): CaseComparison[] {
  const names = runs[0]?.decisions.map((d) => d.exhibitor) ?? [];
  return names.map((name, i) => {
    const byVersion = versions.map((v) => {
      const ds = runs.filter((r) => r.version === v).map((r) => r.decisions[i]!).filter(Boolean);
      const confs = ds.map((d) => d.confidence);
      const valid = confs.filter((c): c is number => c !== null);
      const last = [...ds].reverse().find((d) => d.confidence !== null) ?? ds.at(-1);
      return {
        version: v,
        relevant: `${ds.filter((d) => d.relevant === true).length}/${ds.length}`,
        writable: `${ds.filter((d) => d.writable).length}/${ds.length}`,
        confidence_mean: mean(valid),
        confidences: confs,
        hypothesis: last?.hypothesis ?? null,
        reason: last?.reason ?? null,
      };
    });
    const [a, b] = byVersion;
    return {
      exhibitor: name,
      dataLevel: runs[0]!.decisions[i]!.dataLevel,
      byVersion,
      confidence_delta: a?.confidence_mean != null && b?.confidence_mean != null ? round(b.confidence_mean - a.confidence_mean, 3) : null,
      writable_changed: a?.writable !== b?.writable,
    };
  });
}

export function stability(versions: number[], runs: VersionRun[]): ComparisonReport['stability'] {
  return versions.map((v) => {
    const mine = runs.filter((r) => r.version === v);
    if (mine.length < 2) return { version: v, confidence_mad: null, relevant_flips: 0, writable_flips: 0 };
    const n = mine[0]!.decisions.length;
    const mads: number[] = [];
    let relevantFlips = 0;
    let writableFlips = 0;
    for (let i = 0; i < n; i++) {
      const ds = mine.map((r) => r.decisions[i]!);
      const c = ds.map((d) => d.confidence).filter((x): x is number => x !== null);
      if (c.length >= 2) {
        const m = c.reduce((x, y) => x + y, 0) / c.length;
        mads.push(c.reduce((x, y) => x + Math.abs(y - m), 0) / c.length);
      }
      if (new Set(ds.map((d) => d.relevant)).size > 1) relevantFlips++;
      if (new Set(ds.map((d) => d.writable)).size > 1) writableFlips++;
    }
    return { version: v, confidence_mad: mean(mads), relevant_flips: relevantFlips, writable_flips: writableFlips };
  });
}

/**
 * Recomputes metrics, cases and stability from the runs of a saved report (refine the
 * measurements without calling the model again). The runs themselves are not changed.
 */
export function rebuildReport(r: ComparisonReport): ComparisonReport {
  const versions = r.versions.map((v) => v.version);
  return { ...r, metrics: [versionMetrics(versions[0]!, r.runs), versionMetrics(versions[1]!, r.runs)], cases: compareCases(versions, r.runs), stability: stability(versions, r.runs) };
}

/** Runs both versions on the same input and builds the structured comparison. */
export async function runSkillComparison(opts: CompareOptions): Promise<ComparisonReport> {
  if (!(COMPARABLE_SKILLS as readonly string[]).includes(opts.skillName)) {
    throw new Error(`skill:compare no tiene harness para "${opts.skillName}" (soportadas: ${COMPARABLE_SKILLS.join(', ')})`);
  }
  for (const v of opts.versions) {
    if (sha256(v.text) !== v.contentHash) throw new Error(`v${v.version}: el texto renderizado no coincide con content_hash (${v.contentHash.slice(0, 12)}…)`);
  }
  const input = ProspectorInput.parse(opts.input);
  const cfg = readConfig(opts.agentVersion.configuration);
  const repeat = Math.max(1, Math.floor(opts.repeat ?? 1));
  const guard = opts.budget ?? (opts.maxCostEur !== undefined ? new BudgetGuardProvider(opts.provider, opts.maxCostEur, cfg.usdToEur) : null);
  const provider = guard ?? opts.provider;
  const now = opts.now ?? (() => new Date());
  const runs: VersionRun[] = [];
  for (let rep = 1; rep <= repeat; rep++) {
    const order = rep % 2 === 1 ? opts.versions : ([opts.versions[1], opts.versions[0]] as const);
    for (const v of order) {
      if (guard?.exceeded) break;
      opts.onProgress?.(`v${v.version} · repetición ${rep}/${repeat} · ${input.exhibitors.length} expositores`);
      runs.push(await runOnce({ ...opts, now }, v, rep, provider));
    }
  }
  const versions = opts.versions.map((v) => v.version);
  const total = round(runs.reduce((n, r) => n + r.costEur, 0), 6);
  return {
    skill: opts.skillName,
    generated_at: new Date().toISOString(),
    today: now().toISOString().slice(0, 10),
    model: opts.agentVersion.model,
    input_sha256: sha256(JSON.stringify(opts.input)),
    event: input.event.name,
    exhibitors: input.exhibitors.length,
    repeat,
    versions: opts.versions.map(({ version, status, skillVersionId, contentHash }) => ({ version, status, skillVersionId, contentHash })),
    runs,
    metrics: [versionMetrics(versions[0]!, runs), versionMetrics(versions[1]!, runs)],
    cases: compareCases(versions, runs),
    stability: stability(versions, runs),
    total_cost_eur: total,
    budget_eur: guard?.maxEur ?? null,
    budget_exceeded: guard?.exceeded ?? false,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (Spanish, for the experiment document)
// ---------------------------------------------------------------------------

const num = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
const eur = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} €`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderComparisonMarkdown(r: ComparisonReport): string {
  const [a, b] = r.metrics;
  const va = `v${a.version}`;
  const vb = `v${b.version}`;
  const row = (label: string, x: string, y: string) => `| ${label} | ${x} | ${y} |`;
  const lines: string[] = [];
  lines.push(`### Comparación ${va} vs ${vb} — \`${r.skill}\``, '');
  lines.push(`- Entrada: ${r.event}, ${r.exhibitors} expositores, ${r.repeat} repetición(es) por versión. Hash de la entrada: \`${r.input_sha256.slice(0, 16)}\`.`);
  lines.push(`- Modelo: \`${r.model}\`. Fecha que ve el agente: ${r.today}. CRM: FakeTwenty (en memoria).`);
  lines.push(`- Coste total: ${eur(r.total_cost_eur)}${r.budget_eur !== null ? ` de un presupuesto de ${eur(r.budget_eur)}` : ''}${r.budget_exceeded ? ' (**presupuesto agotado: resultados incompletos**)' : ''}.`, '');
  lines.push(`| Métrica | ${va} | ${vb} |`, '|---|---|---|');
  lines.push(row('Decisiones (errores)', `${a.decisions} (${a.errors})`, `${b.decisions} (${b.errors})`));
  lines.push(row('Relevantes', `${a.relevant}`, `${b.relevant}`));
  lines.push(row('Escribibles (confianza ≥ umbral)', `${a.writable}`, `${b.writable}`));
  lines.push(row('Confianza media (todas las decisiones)', num(a.confidence_mean), num(b.confidence_mean)));
  lines.push(row('Confianza media (solo relevantes)', num(a.confidence_relevant_mean), num(b.confidence_relevant_mean)));
  lines.push(row('No relevantes con confianza > 0,19 (incoherencia)', `${a.irrelevant_high_confidence}`, `${b.irrelevant_high_confidence}`));
  for (const l of ['name_only', 'sector', 'rich'] as const) {
    const x = a.confidence_by_level[l];
    const y = b.confidence_by_level[l];
    if (x.n + y.n === 0) continue;
    const label = { name_only: 'solo nombre', sector: 'nombre + sector', rich: 'descripción o dominio' }[l];
    lines.push(row(`Relevantes: confianza media / máx. (${label})`, `${num(x.mean)} / ${num(x.max)} (n=${x.n})`, `${num(y.mean)} / ${num(y.max)} (n=${y.n})`));
  }
  lines.push(row('Hipótesis', `${a.hypotheses}`, `${b.hypotheses}`));
  lines.push(row('Rangos distintos / hipótesis', num(a.distinct_ranges_ratio), num(b.distinct_ranges_ratio)));
  lines.push(row('Rango más repetido', a.top_range ? `${a.top_range.range} (×${a.top_range.count})` : '—', b.top_range ? `${b.top_range.range} (×${b.top_range.count})` : '—'));
  lines.push(row('Amplitud media cantidad (máx./mín.)', num(a.quantity_ratio_mean), num(b.quantity_ratio_mean)));
  lines.push(row('Hipótesis con amplitud > 2,5', `${a.quantity_ratio_over_2_5}`, `${b.quantity_ratio_over_2_5}`));
  lines.push(row('«need» con cantidades', `${a.need_with_quantities}/${a.hypotheses}`, `${b.need_with_quantities}/${b.hypotheses}`));
  lines.push(row('Precio unitario implícito en 0,50-15 €', `${a.unit_price_in_band}/${a.hypotheses}`, `${b.unit_price_in_band}/${b.hypotheses}`));
  lines.push(row('Solo nombre: la razón marca la suposición', `${a.name_only_flagged_inference.flagged}/${a.name_only_flagged_inference.n}`, `${b.name_only_flagged_inference.flagged}/${b.name_only_flagged_inference.n}`));
  lines.push(row('Tokens de entrada / salida', `${a.input_tokens} / ${a.output_tokens}`, `${b.input_tokens} / ${b.output_tokens}`));
  lines.push(row('Coste (por decisión)', `${eur(a.cost_eur)} (${eur(a.cost_eur_per_decision ?? 0)})`, `${eur(b.cost_eur)} (${eur(b.cost_eur_per_decision ?? 0)})`));
  if (r.repeat > 1) {
    const [sa, sb] = r.stability;
    lines.push(row('Estabilidad entre repeticiones: desviación media de la confianza', num(sa?.confidence_mad ?? null, 3), num(sb?.confidence_mad ?? null, 3)));
    lines.push(row('Estabilidad: expositores que cambian relevante / escribible', `${sa?.relevant_flips ?? 0} / ${sa?.writable_flips ?? 0}`, `${sb?.relevant_flips ?? 0} / ${sb?.writable_flips ?? 0}`));
  }
  lines.push('', `#### Lado a lado por expositor`, '');
  lines.push(`| Expositor | Datos | ${va}: rel. · conf. | ${vb}: rel. · conf. | Δ conf. | ${va}: cantidad · presupuesto | ${vb}: cantidad · presupuesto |`, '|---|---|---|---|---|---|---|');
  for (const c of r.cases) {
    const [x, y] = c.byVersion;
    const q = (h: CaseDecision['hypothesis']) => (h ? `${h.quantity_min}-${h.quantity_max} u · ${h.budget_min_eur}-${h.budget_max_eur} €` : '—');
    const conf = (v: CaseComparison['byVersion'][number] | undefined) => (v ? `${v.relevant} · ${v.confidences.map((n) => num(n)).join(' / ')}` : '—');
    lines.push(`| ${cell(c.exhibitor)} | ${c.dataLevel} | ${conf(x)} | ${conf(y)} | ${num(c.confidence_delta)} | ${q(x?.hypothesis ?? null)} | ${q(y?.hypothesis ?? null)} |`);
  }
  lines.push('', '#### Necesidad y razón (última repetición válida)', '');
  for (const c of r.cases) {
    lines.push(`- **${c.exhibitor}** (${c.dataLevel})`);
    for (const v of c.byVersion) {
      lines.push(`  - v${v.version} · razón: ${v.reason ? cell(v.reason) : '—'}`);
      if (v.hypothesis) lines.push(`  - v${v.version} · need: ${cell(v.hypothesis.need)} · productos: ${cell(v.hypothesis.recommended_products.join(', '))} · ${v.hypothesis.timing} · ${v.hypothesis.differentiators.join(', ') || '—'}`);
    }
  }
  return lines.join('\n');
}
