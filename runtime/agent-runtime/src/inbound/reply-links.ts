/**
 * Which send an incoming message answers, from `email_sends` (the log of emails sent from
 * Twenty). Twenty sends the mail, so the runtime has no outgoing Message-ID to match
 * In-Reply-To against: the link is made by address.
 *
 * 1. `email`: the sender (or, for a bounce, the failed recipient) is one of the recipients of
 *    a send; the latest send at or before the receive time wins (else the latest one).
 * 2. `domain`: no send to that address, but sends to the same domain all belong to ONE company
 *    (a colleague answered). Never for free-mail domains (gmail.com, hotmail.com...), where a
 *    domain says nothing about the company.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailSends } from '../db/schema.js';
import { emailDomain } from './unsubscribe-classifier.js';

export interface SendRow {
  id: string;
  hypothesisId: string;
  companyId: string | null;
  toEmail: string;
  toDomain: string | null;
  subject: string | null;
  sentAt: Date;
}

export interface SendMatch {
  sendId: string;
  hypothesisId: string;
  companyId: string | null;
  subject: string | null;
  sentAt: Date;
  by: 'email' | 'domain';
}

export const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'outlook.com',
  'outlook.es',
  'live.com',
  'live.es',
  'msn.com',
  'yahoo.com',
  'yahoo.es',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'gmx.com',
  'gmx.es',
  'gmx.de',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'yandex.com',
  'mail.com',
  'telefonica.net',
  'movistar.es',
  'terra.es',
  'ono.com',
  'orange.es',
  'vodafone.es',
]);

function recipientsOf(row: SendRow): string[] {
  return row.toEmail
    .toLowerCase()
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pure matching over candidate rows (newest first or not; sorted here). */
export function matchSend(rows: readonly SendRow[], email: string, receivedAt: Date | null): SendMatch | null {
  const sorted = [...rows].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const pick = (cands: SendRow[]) => (receivedAt ? (cands.find((r) => r.sentAt.getTime() <= receivedAt.getTime()) ?? cands[0]) : cands[0]);
  const toMatch = (r: SendRow, by: 'email' | 'domain'): SendMatch => ({ sendId: r.id, hypothesisId: r.hypothesisId, companyId: r.companyId, subject: r.subject, sentAt: r.sentAt, by });

  const byEmail = sorted.filter((r) => recipientsOf(r).includes(email));
  const exact = pick(byEmail);
  if (exact) return toMatch(exact, 'email');

  const domain = emailDomain(email);
  if (FREEMAIL_DOMAINS.has(domain)) return null;
  const byDomain = sorted.filter((r) => (r.toDomain ?? '').toLowerCase() === domain || recipientsOf(r).some((e) => emailDomain(e) === domain));
  const companies = new Set(byDomain.map((r) => r.companyId ?? `hyp:${r.hypothesisId}`));
  if (companies.size !== 1) return null;
  const one = pick(byDomain);
  return one ? toMatch(one, 'domain') : null;
}

export interface SendLookup {
  find(tenantId: string, email: string, receivedAt: Date | null): Promise<SendMatch | null>;
}

export class DrizzleSendLookup implements SendLookup {
  constructor(private readonly db: Db) {}

  async find(tenantId: string, email: string, receivedAt: Date | null): Promise<SendMatch | null> {
    const domain = emailDomain(email);
    const rows = await this.db
      .select({
        id: emailSends.id,
        hypothesisId: emailSends.hypothesisId,
        companyId: emailSends.companyId,
        toEmail: emailSends.toEmail,
        toDomain: emailSends.toDomain,
        subject: emailSends.subject,
        sentAt: emailSends.sentAt,
      })
      .from(emailSends)
      .where(
        and(
          eq(emailSends.tenantId, tenantId),
          // Candidates only; the exact token / domain match is done in matchSend.
          or(sql`strpos(lower(${emailSends.toEmail}), ${email}) > 0`, sql`lower(${emailSends.toDomain}) = ${domain}`, sql`strpos(lower(${emailSends.toEmail}), ${`@${domain}`}) > 0`),
        ),
      )
      .orderBy(desc(emailSends.sentAt))
      .limit(200);
    return matchSend(rows, email, receivedAt);
  }
}

/** In-memory lookup for tests. */
export class MemorySendLookup implements SendLookup {
  constructor(public rows: Array<SendRow & { tenantId: string }> = []) {}

  async find(tenantId: string, email: string, receivedAt: Date | null): Promise<SendMatch | null> {
    return matchSend(
      this.rows.filter((r) => r.tenantId === tenantId),
      email,
      receivedAt,
    );
  }
}
