/**
 * Hypothesis expiry by lead time (tanda 18): a PROPOSED hypothesis whose fair is closer than the
 * lead-time minimum (or already past) can no longer be sold, so the daily signals run expires it.
 *
 * - `list_hypotheses_for_expiry` (READ): the hypotheses of the run's tenant in PROPOSED and/or
 *   VALIDATED, each with its signal's name and event date (the per-exhibitor signal written with
 *   the hypothesis carries the fair date). Relations come from `depth=1` when the server expands
 *   them; otherwise the signal is read once per distinct id (bounded).
 * - `expire_hypothesis` (LOW_WRITE): moves ONE hypothesis PROPOSED -> EXPIRED, re-reading it
 *   right before the PATCH and writing only `status`. It refuses anything that is not PROPOSED
 *   (a VALIDATED one is a human decision and is never auto-expired) and anything whose fair is
 *   not closer than `minDays` (the date of the record's own signal wins over the caller's).
 *
 * The resulting `commercialHypothesis.updated` webhook is NOT a human verdict: the HUMAN evaluator
 * discards transitions to EXPIRED (src/evaluations/twenty-webhook.ts).
 */
import { z } from 'zod';
import { TWENTY_OBJECTS, filterValue, type TwentyCommercialHypothesisExpanded, type TwentyCommercialSignal } from '../../integrations/twenty/index.js';
import { daysUntil } from '../../signals/lead-time.js';
import { defineTool } from '../types.js';
import { RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

export const EXPIRY_LISTED_STATUSES = ['PROPOSED', 'VALIDATED'] as const;

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
/** Distinct signals read one by one when the listing does not expand them. */
export const MAX_SIGNAL_LOOKUPS = 300;

export const HypothesisForExpiry = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  companyId: z.string().nullable(),
  commercialSignalId: z.string().nullable(),
  signalName: z.string().nullable(),
  signalEventDate: z.string().nullable(),
});
export type HypothesisForExpiry = z.infer<typeof HypothesisForExpiry>;

export const ListHypothesesForExpiryInput = z.object({
  statuses: z.array(z.enum(EXPIRY_LISTED_STATUSES)).min(1).max(2),
});

export const ListHypothesesForExpiryOutput = z.object({
  hypotheses: z.array(HypothesisForExpiry),
  truncated: z.boolean(),
  /** Signals not resolved because the per-signal lookup bound was reached. */
  signals_unresolved: z.number().int(),
});
export type ListHypothesesForExpiryOutput = z.infer<typeof ListHypothesesForExpiryOutput>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

export function createListHypothesesForExpiryTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_hypotheses_for_expiry',
    name: 'List hypotheses for lead-time expiry',
    version: '1.0.0',
    description:
      'List the commercial hypotheses of the current tenant in PROPOSED and/or VALIDATED with the name and event date of their commercial signal. Read only.',
    inputSchema: ListHypothesesForExpiryInput,
    outputSchema: ListHypothesesForExpiryOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:signals:read'],
    timeoutMs: 60_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const rows: TwentyCommercialHypothesisExpanded[] = [];
        let truncated = false;
        for (const status of [...new Set(input.statuses)]) {
          let after: string | undefined;
          for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) {
              truncated = true;
              break;
            }
            const res = await deps.twenty.list<TwentyCommercialHypothesisExpanded>(TWENTY_OBJECTS.commercialHypothesis, {
              filter: `status[eq]:${filterValue(status)}`,
              limit: PAGE_SIZE,
              orderBy: 'createdAt',
              depth: 1,
              ...(after ? { startingAfter: after } : {}),
              tenantId: ctx.tenantId,
              signal: ctx.signal,
            });
            rows.push(...res.records.filter((r) => r.status === status && !r.deletedAt));
            const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
            if (!next) break;
            after = next;
          }
        }
        // Signals: expanded by depth=1 when the server does it; else one read per distinct id (bounded).
        const signals = new Map<string, { name: string | null; eventDate: string | null }>();
        for (const r of rows) {
          if (r.commercialSignal && r.commercialSignalId) {
            signals.set(r.commercialSignalId, { name: text(r.commercialSignal.name), eventDate: text(r.commercialSignal.eventDate)?.slice(0, 10) ?? null });
          }
        }
        let lookups = 0;
        let unresolved = 0;
        for (const id of new Set(rows.map((r) => r.commercialSignalId).filter((v): v is string => typeof v === 'string' && v.length > 0))) {
          if (signals.has(id)) continue;
          if (lookups >= MAX_SIGNAL_LOOKUPS) {
            unresolved += 1;
            continue;
          }
          lookups += 1;
          const s = await deps.twenty.get<TwentyCommercialSignal>(TWENTY_OBJECTS.commercialSignal, id, { depth: 0, signal: ctx.signal });
          signals.set(id, { name: text(s?.name), eventDate: text(s?.eventDate)?.slice(0, 10) ?? null });
        }
        const hypotheses = rows.map((r) => {
          const s = r.commercialSignalId ? signals.get(r.commercialSignalId) : undefined;
          return {
            id: r.id,
            name: r.name,
            status: r.status,
            companyId: r.companyId ?? null,
            commercialSignalId: r.commercialSignalId ?? null,
            signalName: s?.name ?? null,
            signalEventDate: s?.eventDate ?? null,
          };
        });
        return { status: 'ok', output: { hypotheses, truncated, signals_unresolved: unresolved } };
      }),
  });
}

// ---------------------------------------------------------------------------
// expire_hypothesis (LOW_WRITE)
// ---------------------------------------------------------------------------

export const ExpireHypothesisInput = z.object({
  hypothesisId: RecordId,
  /** Fair date resolved by the caller (signal or event name). The record's own signal date wins. */
  eventDate: z.iso.date(),
  /** The run's day in Europe/Madrid (YYYY-MM-DD). */
  today: z.iso.date(),
  /** Lead-time minimum: expires only when the fair is fewer than this many days away (or past). */
  minDays: z.number().int().min(0).max(3650),
});

export const ExpireHypothesisOutput = z.object({
  expired: z.boolean(),
  reason: z.enum(['expired', 'not_found', 'status_not_proposed', 'event_in_lead_time']),
  previousStatus: z.string().nullable(),
  eventDate: z.string().nullable(),
  days: z.number().int().nullable(),
});
export type ExpireHypothesisOutput = z.infer<typeof ExpireHypothesisOutput>;

export function createExpireHypothesisTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'expire_hypothesis',
    name: 'Expire commercial hypothesis',
    version: '1.0.0',
    description:
      'Set a PROPOSED commercial hypothesis to EXPIRED (only that field) when its fair is closer than the lead-time minimum or already past. Never touches VALIDATED, REJECTED or EXPIRED hypotheses nor any other field.',
    inputSchema: ExpireHypothesisInput,
    outputSchema: ExpireHypothesisOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:hypotheses:read', 'twenty:hypotheses:write'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        // With tenantId: a hypothesis of another tenant throws TWENTY_TENANT_MISMATCH here, before any PATCH.
        const h = await deps.twenty.get<TwentyCommercialHypothesisExpanded>(TWENTY_OBJECTS.commercialHypothesis, input.hypothesisId, {
          depth: 1,
          tenantId: ctx.tenantId,
          signal: ctx.signal,
        });
        if (!h) return { status: 'ok', output: { expired: false, reason: 'not_found', previousStatus: null, eventDate: null, days: null } };
        const eventDate = text(h.commercialSignal?.eventDate)?.slice(0, 10) ?? input.eventDate;
        const days = daysUntil(eventDate, input.today);
        const base = { previousStatus: h.status ?? null, eventDate, days };
        if (h.status !== 'PROPOSED') return { status: 'ok', output: { expired: false, reason: 'status_not_proposed', ...base } };
        if (days === null || days >= input.minDays) return { status: 'ok', output: { expired: false, reason: 'event_in_lead_time', ...base } };
        await deps.twenty.update(TWENTY_OBJECTS.commercialHypothesis, input.hypothesisId, { status: 'EXPIRED' }, { signal: ctx.signal });
        ctx.logger.info('commercial hypothesis expired (lead time)', { hypothesisId: input.hypothesisId, eventDate, days });
        return { status: 'ok', output: { expired: true, reason: 'expired', ...base } };
      }),
  });
}
