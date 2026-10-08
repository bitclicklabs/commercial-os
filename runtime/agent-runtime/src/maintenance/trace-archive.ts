/**
 * Trace retention WITHOUT loss (LLD v0.1 section 22): archive first, lighten after, never delete.
 *
 * `pnpm traces:archive [--older-than=<days>] [--tenant=<id>] [--min-bytes=<n>] [--batch=<n>] [--dry-run]`
 *
 * 1. Picks the `trace_steps` of traces older than N days (default TRACE_RETENTION_DAYS or 90)
 *    whose execution is terminal and that carry a heavy payload: any of `input`, `output`,
 *    `tool_input`, `tool_output` whose JSON text is >= `minBytes` (default 4096) and is not a
 *    pointer yet. Small payloads stay in the database untouched (they keep the trace queries
 *    of src/evaluations/link-resolver.ts and the dataset harvest working: Twenty record ids,
 *    `created` flags, `input.exhibitor`...).
 * 2. Writes them as JSONL compressed with gzip under TRACE_ARCHIVE_DIR (default
 *    ./data/trace-archive): `<tenant>/<YYYY-MM>.jsonl.gz` (month of the trace, UTC), one line
 *    per step with every heavy field. Files are created with O_EXCL: an existing file is never
 *    overwritten or appended to; a later run of the same month writes `<YYYY-MM>.2.jsonl.gz`...
 *    Before writing, every field is checked to be EXACTLY representable: PostgreSQL compares its
 *    canonical jsonb text with the copy JavaScript holds. A field that is not (e.g. a 25-digit
 *    integer) is neither written nor lightened: it stays in the database and is reported
 *    (`fields_unrepresentable`).
 * 3. Verifies what it wrote: re-reads the file, gunzips it and compares the line count, the
 *    sha256 of the whole content and every line (step id and each field, value by value).
 * 4. Only then lightens the steps, field by field, in one transaction per file: every archived
 *    field becomes `{archived: true, file, line, field, sha256, bytes}`. Each UPDATE is guarded
 *    by the sha256 of the content it replaces and by the archived copy having the same canonical
 *    text, and the trigger of migration 0015 re-checks that the pointer's sha256 is the one of
 *    the replaced content. Type, timestamps, tokens, model, tool, latency, error, reward and the
 *    trace's versions (P4) are never touched.
 *
 * Nothing is deleted: not rows, not files. A file whose verification fails stays where it is
 * (nothing points to it) and the run stops with an error. Manual only (no scheduled task).
 * `GET /traces/:id?rehydrate=true` reads an archived field back on demand (`rehydrateField`).
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql, type SQL } from 'drizzle-orm';
import { sha256Hex } from '../audit/summary.js';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db/client.js';

export const ARCHIVABLE_FIELDS = ['input', 'output', 'tool_input', 'tool_output'] as const;
export type ArchivableField = (typeof ARCHIVABLE_FIELDS)[number];

export const DEFAULT_TRACE_RETENTION_DAYS = 90;
export const DEFAULT_TRACE_ARCHIVE_DIR = './data/trace-archive';
/** A payload is heavy from this size of its JSON text (bytes). */
export const DEFAULT_ARCHIVE_MIN_BYTES = 4096;
export const DEFAULT_ARCHIVE_BATCH = 200;
export const ARCHIVE_LINE_VERSION = 1;

/** What replaces an archived field in `trace_steps` (the trigger of 0015 accepts exactly this). */
export interface ArchivePointer {
  archived: true;
  /** Relative to the archive directory, `/`-separated (e.g. `publiexpe/2026-07.jsonl.gz`). */
  file: string;
  /** 1-based line of the file. */
  line: number;
  field: ArchivableField;
  /** sha256 (hex) of the canonical jsonb text of the replaced content, as PostgreSQL prints it. */
  sha256: string;
  /** Size of that text in bytes. */
  bytes: number;
}

export function isArchivePointer(v: unknown): v is ArchivePointer {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return p.archived === true && typeof p.file === 'string' && typeof p.line === 'number';
}

/** One line of an archive file. */
export interface ArchiveLine {
  v: number;
  tenant_id: string;
  trace_id: string;
  step_id: string;
  sequence: number;
  type: string;
  timestamp: string;
  archived_at: string;
  fields: Partial<Record<ArchivableField, unknown>>;
  sha256: Partial<Record<ArchivableField, string>>;
}

export interface ArchiveOptions {
  olderThanDays: number;
  archiveDir: string;
  tenantId?: string | undefined;
  minBytes?: number | undefined;
  batchSize?: number | undefined;
  dryRun?: boolean | undefined;
  now?: Date | undefined;
}

export interface ArchiveFileReport {
  file: string;
  tenant: string;
  month: string;
  lines: number;
  gz_bytes: number;
  sha256: string;
  verified: true;
  steps_lightened: number;
  /** Lines written whose step was not (fully) lightened: its content changed after it was read. */
  steps_skipped: number;
}

export interface ArchiveReport {
  cutoff: string;
  archive_dir: string;
  dry_run: boolean;
  min_bytes: number;
  files: ArchiveFileReport[];
  steps_lightened: number;
  fields_lightened: number;
  bytes_lightened: number;
  steps_skipped: number;
  /** Heavy fields left in the database because JavaScript cannot carry them exactly (reported, never lost). */
  fields_unrepresentable: number;
  /** Dry run: what would be archived, per tenant and month. */
  candidates: Array<{ tenant: string; month: string; steps: number; fields: number; bytes: number }>;
}

export class ArchiveVerificationError extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(`archive ${file} failed verification (${reason}); nothing was lightened`);
    this.name = 'ArchiveVerificationError';
  }
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  trace_id: string;
  sequence: number;
  type: string;
  timestamp: Date | string;
  month: string;
  input: unknown;
  input_sha: string | null;
  input_bytes: number | null;
  output: unknown;
  output_sha: string | null;
  output_bytes: number | null;
  tool_input: unknown;
  tool_input_sha: string | null;
  tool_input_bytes: number | null;
  tool_output: unknown;
  tool_output_sha: string | null;
  tool_output_bytes: number | null;
}

const col = (f: ArchivableField) => sql.raw(`s."${f}"`);
const canonicalSha = (expr: SQL) => sql`encode(sha256(convert_to((${expr})::text, 'UTF8')), 'hex')`;

/** The field is heavy and not archived yet. */
function heavy(f: ArchivableField, minBytes: number): SQL {
  return sql`(${col(f)} is not null and octet_length(${col(f)}::text) >= ${minBytes} and (${col(f)} -> 'archived') is distinct from 'true'::jsonb)`;
}

function candidateFilter(cutoff: Date, opts: { tenantId?: string | undefined; minBytes: number }, exclude: string[]): SQL {
  const anyHeavy = sql.join(ARCHIVABLE_FIELDS.map((f) => heavy(f, opts.minBytes)), sql` or `);
  return sql`
    from trace_steps s
    join traces t on t.id = s.trace_id
    join agent_executions e on e.id = t.execution_id
    where t.created_at < ${cutoff}
      and e.status in ('COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
      ${opts.tenantId ? sql`and s.tenant_id = ${opts.tenantId}` : sql``}
      and (${anyHeavy})
      ${exclude.length > 0 ? sql`and s.id not in (${sql.join(exclude.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}`;
}

const monthExpr = sql`to_char(t.created_at at time zone 'UTC', 'YYYY-MM')`;

/** Directory name of a tenant (tenant ids from the API are already safe; anything else is mapped). */
export function tenantDirName(tenantId: string): string {
  const safe = tenantId.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
}

/** Creates `<dir>/<month>[.<n>].jsonl.gz` with O_EXCL (never overwrites) and returns its path. */
async function createExclusive(dir: string, month: string): Promise<{ abs: string; handle: Awaited<ReturnType<typeof open>> }> {
  await mkdir(dir, { recursive: true });
  for (let n = 1; n < 10_000; n++) {
    const abs = path.join(dir, n === 1 ? `${month}.jsonl.gz` : `${month}.${n}.jsonl.gz`);
    try {
      return { abs, handle: await open(abs, 'wx') };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`too many archive files for ${dir}/${month}`);
}

/** Re-reads a written archive and checks it against what was meant to be written. */
export async function verifyArchiveFile(abs: string, expected: { sha256: string; lines: ArchiveLine[] }): Promise<void> {
  const rel = path.basename(abs);
  const content = gunzipSync(await readFile(abs)).toString('utf8');
  if (sha256Hex(content) !== expected.sha256) throw new ArchiveVerificationError(rel, 'sha256 mismatch');
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  if (lines.length !== expected.lines.length) throw new ArchiveVerificationError(rel, `line count ${lines.length} != ${expected.lines.length}`);
  lines.forEach((text, i) => {
    const want = expected.lines[i]!;
    let got: ArchiveLine;
    try {
      got = JSON.parse(text) as ArchiveLine;
    } catch {
      throw new ArchiveVerificationError(rel, `line ${i + 1} is not JSON`);
    }
    if (got.step_id !== want.step_id) throw new ArchiveVerificationError(rel, `line ${i + 1}: step ${got.step_id} != ${want.step_id}`);
    for (const f of Object.keys(want.fields) as ArchivableField[]) {
      if (JSON.stringify(got.fields[f]) !== JSON.stringify(want.fields[f])) throw new ArchiveVerificationError(rel, `line ${i + 1}: field ${f} differs`);
    }
  });
}

export async function archiveTraces(db: Db, opts: ArchiveOptions): Promise<ArchiveReport> {
  if (!(opts.olderThanDays >= 0)) throw new Error('olderThanDays must be >= 0');
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.olderThanDays * 86_400_000);
  const minBytes = opts.minBytes ?? DEFAULT_ARCHIVE_MIN_BYTES;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_ARCHIVE_BATCH);
  const archiveDir = path.resolve(opts.archiveDir);
  const report: ArchiveReport = {
    cutoff: cutoff.toISOString(),
    archive_dir: archiveDir,
    dry_run: Boolean(opts.dryRun),
    min_bytes: minBytes,
    files: [],
    steps_lightened: 0,
    fields_lightened: 0,
    bytes_lightened: 0,
    steps_skipped: 0,
    fields_unrepresentable: 0,
    candidates: [],
  };

  if (opts.dryRun) {
    const fieldCount = sql.join(ARCHIVABLE_FIELDS.map((f) => sql`(case when ${heavy(f, minBytes)} then 1 else 0 end)`), sql` + `);
    const fieldBytes = sql.join(ARCHIVABLE_FIELDS.map((f) => sql`(case when ${heavy(f, minBytes)} then octet_length(${col(f)}::text) else 0 end)`), sql` + `);
    const rows = await db.execute<{ tenant: string; month: string; steps: number; fields: number; bytes: number }>(sql`
      select s.tenant_id as tenant, ${monthExpr} as month, count(*)::int as steps,
             sum(${fieldCount})::int as fields, sum(${fieldBytes})::bigint as bytes
      ${candidateFilter(cutoff, { tenantId: opts.tenantId, minBytes }, [])}
      group by 1, 2 order by 1, 2`);
    report.candidates = rows.rows.map((r) => ({ tenant: r.tenant, month: r.month, steps: Number(r.steps), fields: Number(r.fields), bytes: Number(r.bytes) }));
    return report;
  }

  /** Steps not to pick again in this run (a field could not be archived exactly, or lost a race). */
  const excluded: string[] = [];
  const fieldSelect = sql.join(
    ARCHIVABLE_FIELDS.map(
      (f) => sql`case when ${heavy(f, minBytes)} then ${col(f)} end as ${sql.raw(`"${f}"`)},
                 case when ${heavy(f, minBytes)} then ${canonicalSha(col(f))} end as ${sql.raw(`"${f}_sha"`)},
                 case when ${heavy(f, minBytes)} then octet_length(${col(f)}::text) end as ${sql.raw(`"${f}_bytes"`)}`,
    ),
    sql`, `,
  );
  for (;;) {
    const batch = (
      await db.execute<CandidateRow>(sql`
        select s.id, s.tenant_id, s.trace_id, s.sequence, s.type::text as type, s."timestamp", ${monthExpr} as month, ${fieldSelect}
        ${candidateFilter(cutoff, { tenantId: opts.tenantId, minBytes }, excluded)}
        order by s.tenant_id, month, t.created_at, s.trace_id, s.sequence
        limit ${batchSize}`)
    ).rows;
    if (batch.length === 0) break;

    // Only what JavaScript carries EXACTLY goes to a file (e.g. a 25-digit integer would not):
    // the rest stays in the database untouched and is reported.
    const exact = await exactFields(db, batch);
    const work: WorkItem[] = [];
    for (const row of batch) {
      const heavyFields = ARCHIVABLE_FIELDS.filter((f) => row[`${f}_sha`]);
      const ok = heavyFields.filter((f) => exact.has(`${row.id}:${f}`));
      if (ok.length < heavyFields.length) {
        report.fields_unrepresentable += heavyFields.length - ok.length;
        excluded.push(row.id);
      }
      if (ok.length > 0) work.push({ row, fields: ok });
    }

    // One file per (tenant, month) of the batch.
    const groups = new Map<string, WorkItem[]>();
    for (const w of work) {
      const key = `${w.row.tenant_id}\u0000${w.row.month}`;
      const list = groups.get(key) ?? [];
      list.push(w);
      groups.set(key, list);
    }
    for (const items of groups.values()) {
      const first = items[0]!.row;
      const done = await archiveGroup(db, archiveDir, first.tenant_id, first.month, items, now);
      report.files.push(done.file);
      report.steps_lightened += done.file.steps_lightened;
      report.steps_skipped += done.file.steps_skipped;
      report.fields_lightened += done.fields;
      report.bytes_lightened += done.bytes;
      excluded.push(...done.skippedIds);
    }
  }
  return report;
}

interface WorkItem {
  row: CandidateRow;
  /** Heavy fields of the row that can be archived exactly. */
  fields: ArchivableField[];
}

/** `${stepId}:${field}` of the heavy fields whose JavaScript copy has the same canonical jsonb text. */
async function exactFields(db: Db, rows: CandidateRow[]): Promise<Set<string>> {
  const entries: Array<{ id: string; field: ArchivableField; value: unknown }> = [];
  for (const r of rows) for (const f of ARCHIVABLE_FIELDS) if (r[`${f}_sha`]) entries.push({ id: r.id, field: f, value: r[f] });
  if (entries.length === 0) return new Set();
  const current = sql.raw(`case x.field ${ARCHIVABLE_FIELDS.map((f) => `when '${f}' then s."${f}"::text`).join(' ')} end`);
  const res = await db.execute<{ id: string; field: string }>(sql`
    select x.id, x.field
    from jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) as x(id uuid, field text, value jsonb)
    join trace_steps s on s.id = x.id
    where ${current} = x.value::text`);
  return new Set(res.rows.map((r) => `${r.id}:${r.field}`));
}

async function archiveGroup(
  db: Db,
  archiveDir: string,
  tenantId: string,
  month: string,
  items: WorkItem[],
  now: Date,
): Promise<{ file: ArchiveFileReport; fields: number; bytes: number; skippedIds: string[] }> {
  const lines: ArchiveLine[] = items.map(({ row: r, fields: list }) => {
    const fields: ArchiveLine['fields'] = {};
    const shas: ArchiveLine['sha256'] = {};
    for (const f of list) {
      fields[f] = r[f];
      shas[f] = r[`${f}_sha`] as string;
    }
    return {
      v: ARCHIVE_LINE_VERSION,
      tenant_id: r.tenant_id,
      trace_id: r.trace_id,
      step_id: r.id,
      sequence: r.sequence,
      type: r.type,
      timestamp: new Date(r.timestamp).toISOString(),
      archived_at: now.toISOString(),
      fields,
      sha256: shas,
    };
  });
  const content = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  const contentSha = sha256Hex(content);
  const gz = gzipSync(Buffer.from(content, 'utf8'));

  const { abs, handle } = await createExclusive(path.join(archiveDir, tenantDirName(tenantId)), month);
  try {
    await handle.writeFile(gz);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await verifyArchiveFile(abs, { sha256: contentSha, lines });
  const rel = path.relative(archiveDir, abs).split(path.sep).join('/');

  // Verified: lighten field by field, one transaction for the whole file. Each UPDATE is
  // guarded by the content it replaces (and the trigger of 0015 re-checks the pointer).
  let fields = 0;
  let bytes = 0;
  const skippedIds: string[] = [];
  await db.transaction(async (tx) => {
    for (const [i, { row: r, fields: list }] of items.entries()) {
      let missed = false;
      for (const f of list) {
        const sha = r[`${f}_sha`] as string;
        const size = Number(r[`${f}_bytes`] ?? 0);
        const pointer: ArchivePointer = { archived: true, file: rel, line: i + 1, field: f, sha256: sha, bytes: size };
        const column = sql.raw(`"${f}"`);
        const updated = await tx.execute(sql`
          update trace_steps set ${column} = ${JSON.stringify(pointer)}::jsonb
          where id = ${r.id}
            and ${canonicalSha(column)} = ${sha}
            and ${column}::text = (${JSON.stringify(lines[i]!.fields[f])}::jsonb)::text
          returning id`);
        if (updated.rows.length === 0) {
          missed = true;
          continue;
        }
        fields++;
        bytes += size;
      }
      if (missed) skippedIds.push(r.id);
    }
  });
  return {
    file: {
      file: rel,
      tenant: tenantId,
      month,
      lines: lines.length,
      gz_bytes: gz.length,
      sha256: contentSha,
      verified: true,
      steps_lightened: items.length - skippedIds.length,
      steps_skipped: skippedIds.length,
    },
    fields,
    bytes,
    skippedIds,
  };
}

/** Absolute path of a pointer's file, refusing anything outside the archive directory. */
export function resolveArchiveFile(archiveDir: string, file: string): string {
  const root = path.resolve(archiveDir);
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`archive file outside the archive directory: ${file}`);
  return abs;
}

/**
 * Line `line` (1-based) of a gzip JSONL file; null when the file is shorter. Reads the whole
 * file: an archive file holds one batch (at most `--batch` steps), not a whole month.
 */
export async function readArchiveLine(abs: string, line: number): Promise<string | null> {
  if (!Number.isInteger(line) || line < 1) return null;
  const content = gunzipSync(await readFile(abs)).toString('utf8');
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = content.indexOf('\n', start);
    if (next < 0) return null;
    start = next + 1;
  }
  if (start >= content.length) return null;
  const end = content.indexOf('\n', start);
  return content.slice(start, end < 0 ? undefined : end);
}

export type RehydrateResult =
  | { status: 'ok'; value: unknown; verified: boolean }
  | { status: 'missing_file' | 'missing_line' | 'mismatch' | 'invalid'; message: string };

/**
 * Reads an archived field back. `verified` = PostgreSQL's canonical text of the value has the
 * pointer's sha256 (the exact content that was replaced).
 */
export async function rehydrateField(db: Db, archiveDir: string, stepId: string, pointer: ArchivePointer): Promise<RehydrateResult> {
  let abs: string;
  try {
    abs = resolveArchiveFile(archiveDir, pointer.file);
  } catch (err) {
    return { status: 'invalid', message: (err as Error).message };
  }
  let text: string | null;
  try {
    text = await readArchiveLine(abs, pointer.line);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { status: 'missing_file', message: `archive file not found: ${pointer.file}` } : { status: 'invalid', message: (err as Error).message };
  }
  if (text === null) return { status: 'missing_line', message: `line ${pointer.line} not found in ${pointer.file}` };
  let line: ArchiveLine;
  try {
    line = JSON.parse(text) as ArchiveLine;
  } catch {
    return { status: 'invalid', message: `line ${pointer.line} of ${pointer.file} is not JSON` };
  }
  if (line.step_id !== stepId || !(pointer.field in line.fields)) {
    return { status: 'mismatch', message: `line ${pointer.line} of ${pointer.file} is not field ${pointer.field} of step ${stepId}` };
  }
  const value = line.fields[pointer.field];
  const check = await db.execute<{ sha: string }>(sql`select ${canonicalSha(sql`${JSON.stringify(value)}::jsonb`)} as sha`);
  return { status: 'ok', value, verified: check.rows[0]?.sha === pointer.sha256 };
}

export function archiveDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRACE_ARCHIVE_DIR && env.TRACE_ARCHIVE_DIR.trim() !== '' ? env.TRACE_ARCHIVE_DIR : DEFAULT_TRACE_ARCHIVE_DIR;
}

export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRACE_RETENTION_DAYS;
  const n = raw && raw.trim() !== '' ? Number(raw) : DEFAULT_TRACE_RETENTION_DAYS;
  if (!Number.isFinite(n) || n < 0) throw new Error(`TRACE_RETENTION_DAYS must be a number >= 0 (got ${raw})`);
  return n;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  /** `--name=value` or `--name value`. */
  const arg = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
  };
  const num = (name: string): number | undefined => {
    const v = arg(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const config = loadConfig();
  const handle = createDb(config.databaseUrl);
  Promise.resolve()
    .then(() =>
      archiveTraces(handle.db, {
        olderThanDays: num('older-than') ?? config.traceRetentionDays,
        archiveDir: arg('dir') ?? config.traceArchiveDir,
        tenantId: arg('tenant'),
        minBytes: num('min-bytes'),
        batchSize: num('batch'),
        dryRun: argv.includes('--dry-run'),
      }),
    )
    .then((r) => {
      if (r.dry_run) {
        const steps = r.candidates.reduce((a, c) => a + c.steps, 0);
        console.log(`[traces:archive] dry-run (nothing written): ${steps} steps with heavy payloads older than ${r.cutoff} -> ${r.archive_dir}`);
      } else {
        console.log(
          `[traces:archive] ${r.files.length} files verified under ${r.archive_dir}; ${r.steps_lightened} steps lightened ` +
            `(${r.fields_lightened} fields, ${r.bytes_lightened} bytes), ${r.steps_skipped} skipped, ` +
            `${r.fields_unrepresentable} fields kept in the database (not exactly representable); cutoff ${r.cutoff}`,
        );
      }
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err: unknown) => {
      console.error('[traces:archive] failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
