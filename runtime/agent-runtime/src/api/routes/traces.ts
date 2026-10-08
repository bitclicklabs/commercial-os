/**
 * GET /traces/:id[?rehydrate=true] - one trace with its steps (LLD v0.1 section 17.1).
 *
 * Steps whose heavy payloads were archived by `pnpm traces:archive` (src/maintenance/
 * trace-archive.ts) carry the pointer `{archived: true, file, line, field, sha256, bytes}` in the
 * archived field and list it in `archived_fields`. With `rehydrate=true` every pointer is read
 * back from the archive file (TRACE_ARCHIVE_DIR) and replaced by the original content;
 * `rehydrated[field]` tells whether it worked and whether the content matched the pointer's
 * sha256 (`verified`). A missing file never fails the request: the pointer stays and the
 * status says why. The same trace (without rehydration) is also served inside
 * GET /executions/:id and GET /task-runs/:id.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { traceSteps, traces, type TraceStep } from '../../db/schema.js';
import { ARCHIVABLE_FIELDS, archiveDirFromEnv, isArchivePointer, rehydrateField, type ArchivableField } from '../../maintenance/trace-archive.js';
import type { ApiContext } from '../context.js';
import { IdParams, notFound, parse, serialize, tenantOf } from '../http.js';

const TraceQuery = z.object({
  rehydrate: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

const FIELD_KEY: Record<ArchivableField, 'input' | 'output' | 'toolInput' | 'toolOutput'> = {
  input: 'input',
  output: 'output',
  tool_input: 'toolInput',
  tool_output: 'toolOutput',
};

export function archivedFieldsOf(step: TraceStep): ArchivableField[] {
  return ARCHIVABLE_FIELDS.filter((f) => isArchivePointer(step[FIELD_KEY[f]]));
}

export async function traceRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;
  const archiveDir = ctx.config.traceArchiveDir ?? archiveDirFromEnv();

  app.get('/traces/:id', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const { id } = parse(IdParams, req.params);
    const { rehydrate } = parse(TraceQuery, req.query);
    const trace = await db.query.traces.findFirst({ where: and(eq(traces.tenantId, tenantId), eq(traces.id, id)) });
    if (!trace) throw notFound('trace');
    const steps = await db.query.traceSteps.findMany({ where: eq(traceSteps.traceId, trace.id), orderBy: asc(traceSteps.sequence) });
    let archivedSteps = 0;
    const out = [];
    for (const step of steps) {
      const archived = archivedFieldsOf(step);
      const row: Record<string, unknown> = { ...serialize(step), archived_fields: archived };
      if (archived.length > 0) {
        archivedSteps++;
        if (rehydrate) {
          const status: Record<string, unknown> = {};
          for (const f of archived) {
            const pointer = step[FIELD_KEY[f]];
            if (!isArchivePointer(pointer)) continue;
            const r = await rehydrateField(db, archiveDir, step.id, pointer);
            if (r.status === 'ok') {
              row[f] = r.value;
              status[f] = { status: 'ok', verified: r.verified, file: pointer.file, line: pointer.line };
            } else {
              status[f] = { status: r.status, message: r.message, file: pointer.file, line: pointer.line };
            }
          }
          row.rehydrated = status;
        }
      }
      out.push(row);
    }
    return { trace: { ...serialize(trace), archived_steps: archivedSteps, steps: out } };
  });
}
