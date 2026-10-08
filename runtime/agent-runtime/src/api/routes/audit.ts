/**
 * GET /audit - administrative actions of the tenant (audit_log, migration 0015), newest first.
 * Filters: `action` (one or a comma-separated list, e.g. `skill.force_activate,harness.force_activate`),
 * `subject_type`, `subject_id`, `result` (ok | rejected | error), `from` / `to` (ISO 8601, inclusive),
 * and `limit` (1-500, default 100; narrow `to` to page back).
 * Read-only: the log is written by the hook of src/audit/hook.ts and is append-only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUDIT_RESULTS } from '../../db/schema.js';
import { listAudit } from '../../audit/service.js';
import type { ApiContext } from '../context.js';
import { parse, serialize, tenantOf } from '../http.js';

const AuditQuery = z.object({
  action: z
    .string()
    .max(1_000)
    .optional()
    .transform((s) => (s ? s.split(',').map((a) => a.trim()).filter(Boolean) : undefined)),
  subject_type: z.string().trim().min(1).max(100).optional(),
  subject_id: z.string().trim().min(1).max(200).optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function auditRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get('/audit', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(AuditQuery, req.query);
    const rows = await listAudit(ctx.db, {
      tenantId,
      actions: q.action,
      subjectType: q.subject_type,
      subjectId: q.subject_id,
      result: q.result,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
    });
    return { items: rows.map((r) => serialize(r)) };
  });
}
