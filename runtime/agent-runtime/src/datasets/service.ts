/**
 * Evaluation datasets (LLD v0.1 section 11.4, P5): build versions by harvesting the database,
 * serve splits without contaminated cases and record which experiment used which cases.
 *
 * - A build always creates a NEW version (`max(version) + 1` of the same name), DRAFT, with
 *   all its cases in one transaction. Older versions are never touched.
 * - `markUsed` appends to `used_by` (the only mutable column of a case, append-only by trigger).
 * - Serving VALIDATION/TEST filters out the cases an experiment may not use (`vetoReason`).
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pgErrorCode } from '../api/http.js';
import {
  HELD_SPLITS,
  evaluationCases,
  evaluationDatasets,
  type CaseUse,
  type CaseUseRole,
  type DatasetOrigin,
  type DatasetSplit,
  type HeldSplit,
  type DatasetStatus,
  type EvaluationCase,
  type EvaluationDataset,
} from '../db/schema.js';
import { EXPERIMENT_ID_RE, hasUse, isBurned, mergeUses, SPLIT_RATIOS, vetoReason } from './core.js';
import { EXCLUSION_RULES } from './exclusions.js';
import { harvestProspeccion, type HarvestResult } from './harvest-prospeccion.js';
import { planCases, summarise, type PlannedCase, type PlanSummary } from './plan.js';
import { generateSyntheticCases, SYNTHETIC_DOMAINS, type GenerateOptions, type GenerationSummary } from '../synthetic/generate.js';

export const DATASET_NAME_RE = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

export class DatasetServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DatasetServiceError';
  }
}

/** Harvesters by dataset domain. Only `prospeccion` exists today (Prospector decisions). */
export const HARVESTERS: Record<string, (db: Db, tenantId: string) => Promise<HarvestResult>> = {
  prospeccion: harvestProspeccion,
};

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface BuildOptions {
  tenantId: string;
  name: string;
  domain: string;
  description?: string | null | undefined;
  createdBy?: string | null | undefined;
  /** Database to harvest from (read-only); defaults to `db`. */
  sourceDb?: Db | undefined;
  /** Compute everything but write nothing. */
  dryRun?: boolean;
  /** Only for a new dataset (`createDataset`): 409 when the name already exists. */
  mustBeNew?: boolean;
  /**
   * Synthetic cases (src/synthetic/, `pnpm synth:build`): generated from the seed, split SYNTH.
   * Without `withHarvest` the version is SYNTHETIC (no harvest at all); with it, MIXED (the
   * harvest planned as usual plus the synthetic cases). The origin is fixed per dataset name.
   */
  synthetic?: GenerateOptions & { withHarvest?: boolean };
}

export interface BuildResult {
  dataset: EvaluationDataset | null;
  version: number;
  summary: PlanSummary;
  warnings: string[];
  cases: PlannedCase[];
  harvest: HarvestResult['stats'];
  origin: DatasetOrigin;
  /** What the synthetic generator produced (null without `synthetic`). */
  synthetic: GenerationSummary | null;
}

function checkName(name: string, domain: string): void {
  if (!DATASET_NAME_RE.test(name)) throw new DatasetServiceError('invalid', 'name must be lower-case (a-z, 0-9, separated by - _ .), e.g. "prospeccion-v1"');
  if (!HARVESTERS[domain]) throw new DatasetServiceError('invalid', `no harvester for domain "${domain}" (available: ${Object.keys(HARVESTERS).join(', ')})`);
}

/** A SYNTHETIC version harvests nothing. */
function emptyHarvest(domain: string, tenantId: string): HarvestResult {
  return { harvester: `none (synthetic, domain ${domain})`, tenantId, occurrences: [], verdicts: [], warnings: [], stats: { traces: 0, decisions: 0, human_evaluations: 0, human_verdicts: 0, skipped_evaluations: [] } };
}

/** Uses of every entity in older versions of `name` (carried forward as `inherited`). */
async function priorUsesOf(conn: Db | Tx, tenantId: string, name: string): Promise<Map<string, CaseUse[]>> {
  const rows = await conn
    .select({ entityKey: evaluationCases.entityKey, usedBy: evaluationCases.usedBy, version: evaluationDatasets.version })
    .from(evaluationCases)
    .innerJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationCases.datasetId))
    .where(and(eq(evaluationDatasets.tenantId, tenantId), eq(evaluationDatasets.name, name), sql`jsonb_array_length(${evaluationCases.usedBy}) > 0`))
    .orderBy(asc(evaluationDatasets.version));
  const out = new Map<string, CaseUse[]>();
  for (const r of rows) {
    // A burn is irreversible: every use is carried, even one whose registry rule was later changed.
    // planCases merges the current registry first, so a still-valid registry use keeps `via: 'registry'`.
    const inherited = r.usedBy.map((u) => ({ ...u, via: 'inherited' as const, from_version: u.from_version ?? r.version }));
    out.set(r.entityKey, mergeUses(out.get(r.entityKey) ?? [], inherited));
  }
  return out;
}

/**
 * Harvests and creates a new version of dataset `name` (v1 if it does not exist). Harvest is
 * read-only (own transaction, possibly on another database); the write is one transaction
 * serialised per (tenant, name) with an advisory lock.
 */
export async function buildDataset(db: Db, opts: BuildOptions): Promise<BuildResult> {
  checkName(opts.name, opts.domain);
  const origin: DatasetOrigin = !opts.synthetic ? 'HARVESTED' : opts.synthetic.withHarvest ? 'MIXED' : 'SYNTHETIC';
  if (opts.synthetic && !SYNTHETIC_DOMAINS.includes(opts.domain)) throw new DatasetServiceError('invalid', `no synthetic templates for domain "${opts.domain}" (available: ${SYNTHETIC_DOMAINS.join(', ')})`);
  let generated: ReturnType<typeof generateSyntheticCases> | null = null;
  try {
    generated = opts.synthetic ? generateSyntheticCases(opts.synthetic) : null;
  } catch (err) {
    throw new DatasetServiceError('invalid', err instanceof Error ? err.message : String(err));
  }
  const harvester = HARVESTERS[opts.domain]!;
  const harvest = origin === 'SYNTHETIC' ? emptyHarvest(opts.domain, opts.tenantId) : await harvester(opts.sourceDb ?? db, opts.tenantId);

  const run = async (conn: Db | Tx, write: boolean): Promise<BuildResult> => {
    // A dry run may point at a database without migration 0010: no previous versions then.
    const tolerant = async <T>(q: () => Promise<T>, empty: T): Promise<T> => {
      try {
        return await q();
      } catch (err) {
        if (!write && pgErrorCode(err) === '42P01') return empty;
        throw err;
      }
    };
    const existing = await tolerant(
      () =>
        conn
          .select({ version: evaluationDatasets.version, domain: evaluationDatasets.domain, origin: evaluationDatasets.origin })
          .from(evaluationDatasets)
          .where(and(eq(evaluationDatasets.tenantId, opts.tenantId), eq(evaluationDatasets.name, opts.name)))
          .orderBy(desc(evaluationDatasets.version))
          .limit(1),
      [] as Array<{ version: number; domain: string; origin: DatasetOrigin }>,
    );
    const last = existing[0];
    if (last && opts.mustBeNew) throw new DatasetServiceError('conflict', `dataset "${opts.name}" already exists (v${last.version}): use POST /datasets/:id/build for a new version`);
    if (last && last.domain !== opts.domain) throw new DatasetServiceError('conflict', `dataset "${opts.name}" is of domain "${last.domain}", not "${opts.domain}"`);
    if (last && last.origin !== origin) {
      throw new DatasetServiceError(
        'conflict',
        `dataset "${opts.name}" is ${last.origin}, not ${origin}: ${last.origin === 'HARVESTED' ? 'a harvested dataset is rebuilt with POST /datasets/:id/build; use another name for synthetic cases' : 'synthetic and mixed datasets are rebuilt with pnpm synth:build (same --seed and filters to reproduce them)'}`,
      );
    }
    const version = (last?.version ?? 0) + 1;
    const prior = await tolerant(() => priorUsesOf(conn, opts.tenantId, opts.name), new Map<string, CaseUse[]>());
    const harvested = planCases(harvest, { salt: opts.name, priorUses: prior });
    const allCases: PlannedCase[] = [...harvested.cases, ...(generated?.cases ?? [])];
    const plan = { cases: allCases, summary: summarise(allCases), warnings: harvested.warnings };
    const warnings = [...harvest.warnings, ...plan.warnings];
    const buildInfo = {
      harvester: harvest.harvester,
      origin,
      ...(generated ? { synthetic: { ...generated.summary, note: 'split SYNTH: ground truth by construction; never burned by P5, never a label for the Release Gate accuracy' } } : {}),
      built_at: new Date().toISOString(),
      parent_version: last?.version ?? null,
      split: { method: 'sha256(name \\0 entity_key)', salt: opts.name, ratios: SPLIT_RATIOS, forced_train: 'any use in used_by (registry exclusion, mark_used or inherited)' },
      exclusions: EXCLUSION_RULES.map((r) => ({ id: r.id, experiment: r.experiment, role: r.role, doc: r.doc })),
      rules: ['human_verdict: latest human verdict per hypothesis', 'structural_discard: public_body (skill rule)', 'unlabeled: input only'],
      harvest: harvest.stats,
      summary: plan.summary,
      warnings: warnings.slice(0, 100),
    };
    if (!write) return { dataset: null, version, summary: plan.summary, warnings, cases: plan.cases, harvest: harvest.stats, origin, synthetic: generated?.summary ?? null };
    const [dataset] = await conn
      .insert(evaluationDatasets)
      .values({
        tenantId: opts.tenantId,
        name: opts.name,
        domain: opts.domain,
        version,
        description: opts.description ?? null,
        status: 'DRAFT',
        origin,
        buildInfo,
        createdBy: opts.createdBy ?? null,
      })
      .returning();
    const rows = plan.cases.map((c) => ({
      datasetId: dataset!.id,
      tenantId: opts.tenantId,
      split: c.split,
      entityKey: c.entityKey,
      input: c.input,
      context: c.context,
      expected: c.expected,
      source: c.source,
      difficulty: c.difficulty,
      curriculumLevel: c.curriculumLevel ?? null,
      tags: c.tags,
      contentHash: c.contentHash,
      usedBy: c.usedBy,
    }));
    for (let i = 0; i < rows.length; i += 200) await conn.insert(evaluationCases).values(rows.slice(i, i + 200));
    return { dataset: dataset!, version, summary: plan.summary, warnings, cases: plan.cases, harvest: harvest.stats, origin, synthetic: generated?.summary ?? null };
  };

  if (opts.dryRun) return run(db, false);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`evaluation_datasets:${opts.tenantId}:${opts.name}`}))`);
    return run(tx, true);
  });
}

export async function findDataset(db: Db, tenantId: string, id: string): Promise<EvaluationDataset | null> {
  const row = await db.query.evaluationDatasets.findFirst({ where: and(eq(evaluationDatasets.tenantId, tenantId), eq(evaluationDatasets.id, id)) });
  return row ?? null;
}

export async function requireDataset(db: Db, tenantId: string, id: string): Promise<EvaluationDataset> {
  const d = await findDataset(db, tenantId, id);
  if (!d) throw new DatasetServiceError('not_found', 'dataset not found');
  return d;
}

type SplitCounts = Record<HeldSplit, number> & Partial<Record<'SYNTH', number>>;

export interface DatasetCounts {
  total: number;
  /** SYNTH is present only when the dataset has synthetic cases. */
  by_split: SplitCounts;
  /** Cases with expected from a human or a rule (a synthetic ground truth is not a label). */
  labeled_by_split: SplitCounts;
  /** Cases already consumed by some experiment (any use). */
  burned_by_split: SplitCounts;
}

export async function countsOf(db: Db, datasetIds: readonly string[]): Promise<Map<string, DatasetCounts>> {
  const out = new Map<string, DatasetCounts>();
  if (datasetIds.length === 0) return out;
  const rows = await db
    .select({
      datasetId: evaluationCases.datasetId,
      split: evaluationCases.split,
      n: sql<number>`count(*)::int`,
      labeled: sql<number>`count(*) filter (where ${evaluationCases.expected}->>'kind' in ('human_verdict', 'structural_discard'))::int`,
      burned: sql<number>`count(*) filter (where jsonb_array_length(${evaluationCases.usedBy}) > 0)::int`,
    })
    .from(evaluationCases)
    .where(inArray(evaluationCases.datasetId, [...datasetIds]))
    .groupBy(evaluationCases.datasetId, evaluationCases.split);
  const zero = () => Object.fromEntries(HELD_SPLITS.map((s) => [s, 0])) as SplitCounts;
  for (const id of datasetIds) out.set(id, { total: 0, by_split: zero(), labeled_by_split: zero(), burned_by_split: zero() });
  // SYNTH appears in the counts only for datasets that have synthetic cases.
  for (const r of rows) {
    const c = out.get(r.datasetId)!;
    c.total += r.n;
    c.by_split[r.split] = r.n;
    c.labeled_by_split[r.split] = r.labeled;
    c.burned_by_split[r.split] = r.burned;
  }
  return out;
}

export async function listDatasets(db: Db, q: { tenantId: string; name?: string | undefined; domain?: string | undefined; status?: DatasetStatus | undefined; limit?: number | undefined }): Promise<EvaluationDataset[]> {
  const where: SQL[] = [eq(evaluationDatasets.tenantId, q.tenantId)];
  if (q.name) where.push(eq(evaluationDatasets.name, q.name));
  if (q.domain) where.push(eq(evaluationDatasets.domain, q.domain));
  if (q.status) where.push(eq(evaluationDatasets.status, q.status));
  return db
    .select()
    .from(evaluationDatasets)
    .where(and(...where))
    .orderBy(asc(evaluationDatasets.name), desc(evaluationDatasets.version))
    .limit(q.limit ?? 100);
}

/** A case as served, with why `experiment`/`role` may not use it (`vetoed`, null = usable). */
export type ServedCase = EvaluationCase & { vetoed: string | null };

export interface CasesQuery {
  tenantId: string;
  datasetId: string;
  split?: DatasetSplit | undefined;
  /** Experiment asking for the cases; without it, the request is treated as a new experiment. */
  experiment?: string | undefined;
  /** Role the cases are wanted for; defaults to the split (TRAIN -> design, VALIDATION -> validation, TEST -> test). */
  role?: CaseUseRole | undefined;
  /** Return vetoed cases too (annotated). Default false for VALIDATION/TEST. */
  includeVetoed?: boolean | undefined;
  tag?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

// SYNTH cases are never vetoed (their used_by is always empty): the role is irrelevant for them.
const ROLE_OF_SPLIT: Record<DatasetSplit, CaseUseRole> = { TRAIN: 'design', VALIDATION: 'validation', TEST: 'test', SYNTH: 'design' };

/**
 * Cases of a split, P5 applied: for VALIDATION and TEST the cases the experiment may not use
 * are left out (and counted) unless `includeVetoed`. TRAIN is always served whole (design).
 */
export async function listCases(db: Db, q: CasesQuery): Promise<{ items: ServedCase[]; vetoed: number }> {
  await requireDataset(db, q.tenantId, q.datasetId);
  const where: SQL[] = [eq(evaluationCases.datasetId, q.datasetId), eq(evaluationCases.tenantId, q.tenantId)];
  if (q.split) where.push(eq(evaluationCases.split, q.split));
  if (q.tag) where.push(sql`${q.tag} = any(${evaluationCases.tags})`);
  const rows = await db
    .select()
    .from(evaluationCases)
    .where(and(...where))
    .orderBy(asc(evaluationCases.split), asc(evaluationCases.entityKey), asc(evaluationCases.id));
  const role = q.role ?? (q.split ? ROLE_OF_SPLIT[q.split] : 'design');
  const annotated = rows.map((r) => ({ ...r, vetoed: vetoReason(r.usedBy, q.experiment ?? null, role) }));
  const visible = q.includeVetoed ? annotated : annotated.filter((r) => r.vetoed === null);
  const offset = q.offset ?? 0;
  return { items: visible.slice(offset, offset + (q.limit ?? 500)), vetoed: annotated.length - annotated.filter((r) => r.vetoed === null).length };
}

export interface MarkUsedInput {
  tenantId: string;
  datasetId: string;
  caseIds: readonly string[];
  experiment: string;
  role: CaseUseRole;
  by?: string | null | undefined;
  note?: string | null | undefined;
}

export interface MarkUsedResult {
  marked: string[];
  already: string[];
  /** Cases that were clean held-out data and are burned from now on. */
  newly_burned: string[];
  /** Synthetic cases (split SYNTH) given: never marked, they are regenerable and P5 does not apply to them. Only present when there are any. */
  synthetic?: string[];
}

/**
 * Records that `experiment` used these cases as `role` (P5 ledger). All or nothing:
 * - unknown ids (or of another dataset/tenant) -> not_found;
 * - validation/test on a case vetoed for this experiment and role -> conflict, nothing written;
 * - the same (experiment, role) already recorded -> no-op for that case (idempotent).
 * After a `design` mark the case is vetoed for every future validation/test.
 * Synthetic cases (split SYNTH) are never marked: they are reported in `synthetic` (P5 does not
 * apply to regenerable data, and migration 0017 keeps their used_by empty).
 */
export async function markUsed(db: Db, input: MarkUsedInput): Promise<MarkUsedResult> {
  if (!EXPERIMENT_ID_RE.test(input.experiment)) throw new DatasetServiceError('invalid', 'experiment must be an id like "EXP-003" (letters, digits, . _ : -; max 80)');
  const ids = [...new Set(input.caseIds)];
  if (ids.length === 0) throw new DatasetServiceError('invalid', 'case_ids is empty');
  return db.transaction(async (tx) => {
    const ds = await tx.query.evaluationDatasets.findFirst({ where: and(eq(evaluationDatasets.tenantId, input.tenantId), eq(evaluationDatasets.id, input.datasetId)) });
    if (!ds) throw new DatasetServiceError('not_found', 'dataset not found');
    const rows = await tx
      .select()
      .from(evaluationCases)
      .where(and(eq(evaluationCases.datasetId, input.datasetId), eq(evaluationCases.tenantId, input.tenantId), inArray(evaluationCases.id, ids)))
      .for('update');
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw new DatasetServiceError('not_found', `${missing.length} case(s) not found in this dataset`, { missing });
    const vetoed = rows.filter((r) => r.split !== 'SYNTH').map((r) => ({ id: r.id, reason: vetoReason(r.usedBy, input.experiment, input.role) })).filter((v) => v.reason !== null);
    if (vetoed.length > 0) {
      throw new DatasetServiceError('conflict', `${vetoed.length} case(s) cannot be used as ${input.role} by ${input.experiment} (P5)`, { vetoed });
    }
    const result: MarkUsedResult = { marked: [], already: [], newly_burned: [] };
    const at = new Date().toISOString();
    for (const r of rows) {
      if (r.split === 'SYNTH') {
        (result.synthetic ??= []).push(r.id);
        continue;
      }
      if (hasUse(r.usedBy, input.experiment, input.role)) {
        result.already.push(r.id);
        continue;
      }
      const use: CaseUse = { experiment: input.experiment, role: input.role, at, via: 'mark_used', by: input.by ?? null, note: input.note ?? null };
      await tx
        .update(evaluationCases)
        .set({ usedBy: [...r.usedBy, use] })
        .where(eq(evaluationCases.id, r.id));
      result.marked.push(r.id);
      if (!isBurned(r.usedBy)) result.newly_burned.push(r.id);
    }
    return result;
  });
}

/** DRAFT -> ACTIVE (archives the previous ACTIVE version of the same name in the same transaction). */
export async function activateDataset(db: Db, tenantId: string, id: string): Promise<{ dataset: EvaluationDataset; changed: boolean; archived: string[] }> {
  return db.transaction(async (tx) => {
    const d = await tx.query.evaluationDatasets.findFirst({ where: and(eq(evaluationDatasets.tenantId, tenantId), eq(evaluationDatasets.id, id)) });
    if (!d) throw new DatasetServiceError('not_found', 'dataset not found');
    if (d.status === 'ACTIVE') return { dataset: d, changed: false, archived: [] };
    if (d.status !== 'DRAFT') throw new DatasetServiceError('conflict', `invalid transition ${d.status} -> ACTIVE`);
    const others = await tx
      .update(evaluationDatasets)
      .set({ status: 'ARCHIVED' })
      .where(and(eq(evaluationDatasets.tenantId, tenantId), eq(evaluationDatasets.name, d.name), eq(evaluationDatasets.status, 'ACTIVE')))
      .returning({ id: evaluationDatasets.id });
    const [updated] = await tx.update(evaluationDatasets).set({ status: 'ACTIVE' }).where(eq(evaluationDatasets.id, id)).returning();
    return { dataset: updated!, changed: true, archived: others.map((o) => o.id) };
  });
}

export async function archiveDataset(db: Db, tenantId: string, id: string): Promise<{ dataset: EvaluationDataset; changed: boolean }> {
  const d = await requireDataset(db, tenantId, id);
  if (d.status === 'ARCHIVED') return { dataset: d, changed: false };
  const [updated] = await db.update(evaluationDatasets).set({ status: 'ARCHIVED' }).where(eq(evaluationDatasets.id, id)).returning();
  return { dataset: updated!, changed: true };
}
