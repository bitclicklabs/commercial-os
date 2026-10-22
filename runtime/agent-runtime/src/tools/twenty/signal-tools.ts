/**
 * Event-level commercial signals (the fairs the commercial qualifies by hand in Twenty).
 *
 * - `list_event_signals` (READ): commercial signals WITHOUT company (event level: a fair, a
 *   congress) in the given statuses, of the run's tenant only (the client injects the
 *   `tenantId` filter). Per-exhibitor signals ("<feria> — <empresa>") always carry a company
 *   and never come back from this tool.
 * - `expire_signal` (LOW_WRITE): moves ONE signal to EXPIRED, and only when its event date
 *   is already past and its status is still NEW / REVIEWING / QUALIFIED. It re-reads the
 *   record right before the PATCH and writes nothing else: it can never qualify, discard or
 *   reopen a signal, and never touches a date in the future. A signal of another tenant is
 *   refused (`TWENTY_TENANT_MISMATCH`) before the PATCH.
 */
import { z } from 'zod';
import { SIGNAL_STATUSES, TWENTY_OBJECTS, filterValue, type TwentyCommercialSignal, type TwentyNote, type TwentyNoteTarget } from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { noteTitle } from './note-tools.js';
import { RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

/** Statuses a signal can be expired from (the open ones; DISCARDED / EXPIRED are final). */
export const EXPIRABLE_SIGNAL_STATUSES = ['NEW', 'REVIEWING', 'QUALIFIED'] as const;

/** Records per REST page and pages per status (a safety bound: 5 x 200 open fairs is far above reality). */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

export const EventSignal = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  signalType: z.string(),
  eventDate: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceDomain: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EventSignal = z.infer<typeof EventSignal>;

export const ListEventSignalsInput = z.object({
  statuses: z.array(z.enum(SIGNAL_STATUSES)).min(1).max(SIGNAL_STATUSES.length),
});

export const ListEventSignalsOutput = z.object({
  signals: z.array(EventSignal),
  /** True when a status had more pages than the safety bound (the rest is read on a later run). */
  truncated: z.boolean(),
});
export type ListEventSignalsOutput = z.infer<typeof ListEventSignalsOutput>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/** `day` (YYYY-MM-DD) plus `days` (negative: before). */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function toEventSignal(s: TwentyCommercialSignal): EventSignal {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    signalType: s.signalType,
    eventDate: text(s.eventDate)?.slice(0, 10) ?? null,
    sourceUrl: text(s.sourceUrl?.primaryLinkUrl),
    sourceDomain: text(s.sourceDomain),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function createListEventSignalsTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_event_signals',
    name: 'List event-level commercial signals',
    version: '1.0.0',
    description:
      'List the commercial signals without company (event level: fairs, congresses) of the current tenant in the given statuses, with their event date and source URL. Per-company signals are not returned.',
    inputSchema: ListEventSignalsInput,
    outputSchema: ListEventSignalsOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:signals:read'],
    timeoutMs: 30_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const signals: EventSignal[] = [];
        let truncated = false;
        // One query per status with [eq] (the filter subset every Twenty version understands).
        for (const status of [...new Set(input.statuses)]) {
          let after: string | undefined;
          for (let page = 0; ; page++) {
            if (page >= MAX_PAGES) {
              truncated = true;
              break;
            }
            const res = await deps.twenty.list<TwentyCommercialSignal>(TWENTY_OBJECTS.commercialSignal, {
              filter: `and(status[eq]:${filterValue(status)},companyId[is]:NULL)`,
              limit: PAGE_SIZE,
              orderBy: 'createdAt',
              ...(after ? { startingAfter: after } : {}),
              tenantId: ctx.tenantId,
              signal: ctx.signal,
            });
            // Defensive: a server that ignores the filter must not leak per-company signals in.
            signals.push(...res.records.filter((r) => !r.companyId && r.status === status).map(toEventSignal));
            const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
            if (!next) break;
            after = next;
          }
        }
        return { status: 'ok', output: { signals, truncated } };
      }),
  });
}

// ---------------------------------------------------------------------------
// expire_signal (LOW_WRITE)
// ---------------------------------------------------------------------------

export const ExpireSignalInput = z.object({
  signalId: RecordId,
  /** The run's date (YYYY-MM-DD): the signal expires only if its event date is strictly before it. */
  today: z.iso.date(),
  /**
   * Tanda 21 (company signals): expire only when the event date (the news date) is more than this
   * many days before `today`. Omitted: strictly before `today` (fairs, unchanged).
   */
  minAgeDays: z.number().int().min(1).max(3650).optional(),
});

export const ExpireSignalOutput = z.object({
  expired: z.boolean(),
  reason: z.enum(['expired', 'not_found', 'status_not_open', 'no_event_date', 'event_not_past']),
  previousStatus: z.string().nullable(),
  eventDate: z.string().nullable(),
});
export type ExpireSignalOutput = z.infer<typeof ExpireSignalOutput>;

export function createExpireSignalTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'expire_signal',
    name: 'Expire commercial signal',
    version: '1.0.0',
    description:
      'Set a commercial signal to EXPIRED (only that field) when its event date is already past (or, with minAgeDays, more than that many days old) and it is still NEW, REVIEWING or QUALIFIED. Never changes any other status or field.',
    inputSchema: ExpireSignalInput,
    outputSchema: ExpireSignalOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:signals:read', 'twenty:signals:write'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        // With tenantId: a signal of another tenant throws TWENTY_TENANT_MISMATCH here, before any PATCH.
        const s = await deps.twenty.get<TwentyCommercialSignal>(TWENTY_OBJECTS.commercialSignal, input.signalId, { depth: 0, tenantId: ctx.tenantId, signal: ctx.signal });
        if (!s) return { status: 'ok', output: { expired: false, reason: 'not_found', previousStatus: null, eventDate: null } };
        const eventDate = text(s.eventDate)?.slice(0, 10) ?? null;
        const base = { previousStatus: s.status ?? null, eventDate };
        if (!(EXPIRABLE_SIGNAL_STATUSES as readonly string[]).includes(s.status)) return { status: 'ok', output: { expired: false, reason: 'status_not_open', ...base } };
        if (!eventDate) return { status: 'ok', output: { expired: false, reason: 'no_event_date', ...base } };
        const cutoff = input.minAgeDays ? shiftDay(input.today, -input.minAgeDays) : input.today;
        if (!(eventDate < cutoff)) return { status: 'ok', output: { expired: false, reason: 'event_not_past', ...base } };
        await deps.twenty.update(TWENTY_OBJECTS.commercialSignal, input.signalId, { status: 'EXPIRED' }, { signal: ctx.signal });
        ctx.logger.info('commercial signal expired', { signalId: input.signalId, eventDate, previousStatus: s.status });
        return { status: 'ok', output: { expired: true, reason: 'expired', ...base } };
      }),
  });
}

// ---------------------------------------------------------------------------
// create_signal_note (LOW_WRITE, tanda 18)
// ---------------------------------------------------------------------------

export const CreateSignalNoteInput = z.object({
  signalId: RecordId,
  title: z.string().trim().min(1).max(255),
  bodyMarkdown: z.string().trim().min(1).max(4_000),
});

export const CreateSignalNoteOutput = z.object({
  created: z.boolean(),
  noteId: z.string(),
  title: z.string(),
  signalId: z.string(),
});
export type CreateSignalNoteOutput = z.infer<typeof CreateSignalNoteOutput>;

/**
 * create_signal_note (LOW_WRITE): an internal note attached to ONE commercial signal (noteTarget
 * `targetCommercialSignalId`), e.g. why a qualification did not start a prospecting run (lead-time
 * window). The signal itself is never modified. The signal is re-read with the run's tenant first
 * (another tenant's signal: `TWENTY_TENANT_MISMATCH`, nothing written). Idempotent by
 * (signal + title): a note with that title already on the signal is returned (`created: false`);
 * an orphan with that title (a call that died between the two POSTs) is adopted.
 */
export function createCreateSignalNoteTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'create_signal_note',
    name: 'Create note on commercial signal',
    version: '1.0.0',
    description:
      'Attach an internal note (markdown) to one commercial signal of the current tenant. Idempotent per signal and title. Never changes the signal and never sends anything to anybody.',
    inputSchema: CreateSignalNoteInput,
    outputSchema: CreateSignalNoteOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:signals:read', 'twenty:notes:read', 'twenty:notes:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const s = await twenty.get<TwentyCommercialSignal>(TWENTY_OBJECTS.commercialSignal, input.signalId, { depth: 0, tenantId: ctx.tenantId, signal: ctx.signal });
        if (!s) return { status: 'error' as const, code: 'SIGNAL_NOT_FOUND', message: `commercial signal ${input.signalId} does not exist`, retryable: false };
        const title = noteTitle(input.title);
        const { records: sameTitle } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: `title[eq]:${filterValue(title)}`, limit: 20, signal: ctx.signal });
        let orphan: TwentyNote | null = null;
        for (const candidate of sameTitle) {
          const { records: targets } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `noteId[eq]:${filterValue(candidate.id)}`, limit: 50, signal: ctx.signal });
          if (targets.some((t) => t.targetCommercialSignalId === input.signalId)) {
            return { status: 'ok' as const, output: { created: false, noteId: candidate.id, title, signalId: input.signalId } };
          }
          if (targets.length === 0 && !orphan) orphan = candidate;
        }
        const note = orphan ?? (await twenty.create<TwentyNote>(TWENTY_OBJECTS.note, { title, bodyV2: { markdown: input.bodyMarkdown } }, { signal: ctx.signal }));
        await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId: note.id, targetCommercialSignalId: input.signalId }, { signal: ctx.signal });
        ctx.logger.info('signal note created', { noteId: note.id, signalId: input.signalId, adopted: orphan !== null });
        return { status: 'ok' as const, output: { created: orphan === null, noteId: note.id, title, signalId: input.signalId } };
      }),
  });
}
