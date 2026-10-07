/**
 * `email_sends`: append-only log of the emails sent from Twenty, and the counters the
 * warm-up guard and the dashboard read. Day and week boundaries are local (Europe/Madrid by
 * default); the week runs Monday to Sunday (`date_trunc('week')`).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailSends, type EmailSend } from '../db/schema.js';

export interface NewEmailSend {
  tenantId: string;
  hypothesisId: string;
  companyId: string | null;
  toEmail: string;
  toDomain: string | null;
  subject: string | null;
  sentAt: Date;
  workspaceMemberId: string | null;
}

/** Inserts the send unless (tenant, hypothesis, sent_at) is already there. */
export async function recordEmailSend(db: Db, send: NewEmailSend): Promise<{ send: EmailSend; created: boolean }> {
  const [inserted] = await db
    .insert(emailSends)
    .values(send)
    .onConflictDoNothing({ target: [emailSends.tenantId, emailSends.hypothesisId, emailSends.sentAt] })
    .returning();
  if (inserted) return { send: inserted, created: true };
  const existing = await db.query.emailSends.findFirst({
    where: and(eq(emailSends.tenantId, send.tenantId), eq(emailSends.hypothesisId, send.hypothesisId), eq(emailSends.sentAt, send.sentAt)),
  });
  if (!existing) throw new Error('email send could not be persisted');
  return { send: existing, created: false };
}

export interface SendCounts {
  /** Sends on the local day of `now`. */
  today: number;
  /** Sends in the local Monday-Sunday week of `now`. */
  week: number;
  total: number;
  /** Sends in the 60 minutes before `now`. */
  lastHour: number;
  lastSentAt: string | null;
  /** Sends in [since, until) when a window is given. */
  inWindow: number | null;
}

export async function countEmailSends(
  db: Db,
  o: { tenantId: string; now: Date; timezone: string; since?: Date | undefined; until?: Date | undefined },
): Promise<SendCounts> {
  const now = o.now.toISOString();
  const tz = o.timezone;
  const windowFilter =
    o.since || o.until
      ? sql`count(*) filter (where true${o.since ? sql` and s.sent_at >= ${o.since.toISOString()}::timestamptz` : sql``}${
          o.until ? sql` and s.sent_at < ${o.until.toISOString()}::timestamptz` : sql``
        })`
      : sql`null::bigint`;
  const res = await db.execute(sql`
    select count(*) as total,
           count(*) filter (where (s.sent_at at time zone ${tz})::date = (${now}::timestamptz at time zone ${tz})::date) as today,
           count(*) filter (where date_trunc('week', s.sent_at at time zone ${tz}) = date_trunc('week', ${now}::timestamptz at time zone ${tz})) as week,
           count(*) filter (where s.sent_at > ${now}::timestamptz - interval '1 hour' and s.sent_at <= ${now}::timestamptz) as last_hour,
           max(s.sent_at) as last_sent_at,
           ${windowFilter} as in_window
    from email_sends s
    where s.tenant_id = ${o.tenantId}`);
  const r = (res.rows[0] ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const last = r.last_sent_at;
  return {
    today: n(r.today),
    week: n(r.week),
    total: n(r.total),
    lastHour: n(r.last_hour),
    lastSentAt: last === null || last === undefined ? null : new Date(last instanceof Date ? last : String(last).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString(),
    inWindow: r.in_window === null || r.in_window === undefined ? null : Number(r.in_window),
  };
}
