/**
 * audit_log (migration 0015): writes and reads. Append-only (triggers reject UPDATE, DELETE and
 * TRUNCATE): nothing here updates a row. Code outside the API (scripts, agents) can call
 * `recordAudit` directly for an administrative action of its own.
 */
import { and, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditLog, type AuditLogRow, type AuditResult } from '../db/schema.js';

export type AuditInsert = typeof auditLog.$inferInsert;

export function resultOf(statusCode: number): AuditResult {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'rejected';
  return 'ok';
}

export async function recordAudit(db: Pick<Db, 'insert'>, row: AuditInsert): Promise<AuditLogRow> {
  const [inserted] = await db.insert(auditLog).values(row).returning();
  if (!inserted) throw new Error('audit_log insert returned no row');
  return inserted;
}

export interface AuditFilters {
  tenantId: string;
  actions?: string[] | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  result?: AuditResult | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit?: number | undefined;
}

/** Newest first. */
export async function listAudit(db: Db, f: AuditFilters): Promise<AuditLogRow[]> {
  const where: Array<SQL | undefined> = [
    eq(auditLog.tenantId, f.tenantId),
    f.actions && f.actions.length > 0 ? inArray(auditLog.action, f.actions) : undefined,
    f.subjectType ? eq(auditLog.subjectType, f.subjectType) : undefined,
    f.subjectId ? eq(auditLog.subjectId, f.subjectId) : undefined,
    f.result ? eq(auditLog.result, f.result) : undefined,
    f.from ? gte(auditLog.occurredAt, f.from) : undefined,
    f.to ? lte(auditLog.occurredAt, f.to) : undefined,
  ];
  return db
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(Math.min(Math.max(f.limit ?? 100, 1), 500));
}
