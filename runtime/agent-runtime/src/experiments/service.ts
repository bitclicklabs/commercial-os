/**
 * Experiments (LLD v0.1 section 11.5) in the database: numbering, lifecycle and the queries
 * the Release Gate of the activation needs. The table is append-only by trigger (0011): no
 * DELETE, identity and config immutable, a finished experiment immutable.
 *
 * Lifecycle: DRAFT (created, nothing reserved) -> RUNNING (cases reserved, runs in progress)
 * -> COMPLETED (gate decided) | FAILED (the experiment itself broke: contamination, error)
 * | CANCELLED.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { experiments, type Experiment, type ExperimentDecision, type ExperimentStatus, type ExperimentSubjectType } from '../db/schema.js';

/** EXP-001 and EXP-002 were run by hand (docs/experimentos): automatic numbering starts after them. */
export const MANUAL_EXPERIMENTS_FLOOR = 2;

export const EXPERIMENT_NAME_RE = /^EXP-\d{3,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ExperimentServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExperimentServiceError';
  }
}

export function experimentName(n: number): string {
  return `EXP-${n < 1000 ? String(n).padStart(3, '0') : String(n)}`;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

export interface CreateExperimentArgs {
  tenantId: string;
  subjectType: ExperimentSubjectType;
  subjectName: string;
  baselineVersion: number | null;
  candidateVersion: number;
  datasetId?: string | null;
  config: Record<string, unknown>;
  createdBy?: string | null;
}

/** Creates the next EXP-NNN of the tenant (DRAFT). Numbering is serialised per tenant. */
export async function createExperiment(db: Db, args: CreateExperimentArgs): Promise<Experiment> {
  if (args.baselineVersion !== null && args.baselineVersion === args.candidateVersion) throw new ExperimentServiceError('invalid', 'baseline and candidate must be different versions');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`experiments:${args.tenantId}`}))`);
    const [last] = await tx.select({ n: sql<number>`coalesce(max(${experiments.number}), 0)::int` }).from(experiments).where(eq(experiments.tenantId, args.tenantId));
    const number = Math.max(last?.n ?? 0, MANUAL_EXPERIMENTS_FLOOR) + 1;
    const [row] = await tx
      .insert(experiments)
      .values({
        tenantId: args.tenantId,
        name: experimentName(number),
        number,
        subjectType: args.subjectType,
        subjectName: args.subjectName,
        baselineVersion: args.baselineVersion,
        candidateVersion: args.candidateVersion,
        datasetId: args.datasetId ?? null,
        config: args.config,
        status: 'DRAFT',
        createdBy: args.createdBy ?? null,
      })
      .returning();
    return row!;
  });
}

async function requireOpen(conn: Conn, id: string): Promise<Experiment> {
  const [row] = await conn.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  if (!row) throw new ExperimentServiceError('not_found', 'experiment not found');
  if (row.status !== 'DRAFT' && row.status !== 'RUNNING') throw new ExperimentServiceError('conflict', `${row.name} is ${row.status}`);
  return row;
}

/** DRAFT -> RUNNING. */
export async function startExperiment(db: Db, id: string): Promise<Experiment> {
  const row = await requireOpen(db, id);
  if (row.status === 'RUNNING') return row;
  const [updated] = await db.update(experiments).set({ status: 'RUNNING', startedAt: new Date() }).where(eq(experiments.id, id)).returning();
  return updated!;
}

export interface ExperimentProgress {
  splits?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  gateResult?: Record<string, unknown>;
  costEur?: number;
}

/** Saves partial results while RUNNING (so a crash leaves what was reserved and spent). */
export async function recordProgress(db: Db, id: string, p: ExperimentProgress): Promise<Experiment> {
  await requireOpen(db, id);
  const set: Partial<typeof experiments.$inferInsert> = {};
  if (p.splits) set.splits = p.splits;
  if (p.metrics) set.metrics = p.metrics;
  if (p.gateResult) set.gateResult = p.gateResult;
  if (p.costEur !== undefined) set.costEur = p.costEur;
  const [updated] = await db.update(experiments).set(set).where(eq(experiments.id, id)).returning();
  return updated!;
}

/** RUNNING -> COMPLETED with the gate decision. After this the row is immutable. */
export async function completeExperiment(db: Db, id: string, r: Required<Omit<ExperimentProgress, 'gateResult'>> & { gateResult: Record<string, unknown>; decision: ExperimentDecision }): Promise<Experiment> {
  const row = await requireOpen(db, id);
  if (row.status !== 'RUNNING') throw new ExperimentServiceError('conflict', `${row.name} is ${row.status}, not RUNNING`);
  const [updated] = await db
    .update(experiments)
    .set({ status: 'COMPLETED', decision: r.decision, splits: r.splits, metrics: r.metrics, gateResult: r.gateResult, costEur: r.costEur, finishedAt: new Date() })
    .where(eq(experiments.id, id))
    .returning();
  return updated!;
}

/** -> FAILED (the experiment broke) or CANCELLED. Keeps whatever was recorded so far. */
export async function closeExperiment(db: Db, id: string, status: Extract<ExperimentStatus, 'FAILED' | 'CANCELLED'>, error: string, p: ExperimentProgress = {}): Promise<Experiment> {
  await requireOpen(db, id);
  const set: Partial<typeof experiments.$inferInsert> = { status, error: error.slice(0, 4000), finishedAt: new Date() };
  if (p.splits) set.splits = p.splits;
  if (p.metrics) set.metrics = p.metrics;
  if (p.gateResult) set.gateResult = p.gateResult;
  if (p.costEur !== undefined) set.costEur = p.costEur;
  const [updated] = await db.update(experiments).set(set).where(eq(experiments.id, id)).returning();
  return updated!;
}

/** By uuid or by name (EXP-003). */
export async function findExperiment(db: Conn, tenantId: string, key: string): Promise<Experiment | null> {
  const where = UUID_RE.test(key) ? and(eq(experiments.tenantId, tenantId), eq(experiments.id, key)) : and(eq(experiments.tenantId, tenantId), eq(experiments.name, key.toUpperCase()));
  const [row] = await db.select().from(experiments).where(where).limit(1);
  return row ?? null;
}

export interface ListExperimentsQuery {
  tenantId: string;
  subjectType?: ExperimentSubjectType | undefined;
  subjectName?: string | undefined;
  candidateVersion?: number | undefined;
  status?: ExperimentStatus | undefined;
  limit?: number | undefined;
}

export async function listExperiments(db: Conn, q: ListExperimentsQuery): Promise<Experiment[]> {
  const where: SQL[] = [eq(experiments.tenantId, q.tenantId)];
  if (q.subjectType) where.push(eq(experiments.subjectType, q.subjectType));
  if (q.subjectName) where.push(eq(experiments.subjectName, q.subjectName));
  if (q.candidateVersion !== undefined) where.push(eq(experiments.candidateVersion, q.candidateVersion));
  if (q.status) where.push(eq(experiments.status, q.status));
  return db
    .select()
    .from(experiments)
    .where(and(...where))
    .orderBy(desc(experiments.number))
    .limit(q.limit ?? 50);
}

/** Short view of an experiment for gate responses and errors. */
export function experimentSummary(e: Experiment) {
  return {
    id: e.id,
    name: e.name,
    status: e.status,
    decision: e.decision,
    baseline_version: e.baselineVersion,
    candidate_version: e.candidateVersion,
    mode: (e.gateResult as { mode?: unknown }).mode ?? null,
    summary: (e.gateResult as { summary?: unknown }).summary ?? null,
    cost_eur: e.costEur,
    finished_at: e.finishedAt,
  };
}
