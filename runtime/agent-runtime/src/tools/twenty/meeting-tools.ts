/**
 * Tools of the meeting sync (tanda 22, task `meeting-sync`). The calendar is only READ: no tool
 * here creates, changes or answers a calendar event, and none sends anything.
 *
 * - `list_calendar_events` (READ, untrusted): the events of the synced calendar that start in a
 *   window, with their participants; `calendar: 'no_channel'` when Twenty has no synced calendar
 *   channel (src/meetings/calendar.ts).
 * - `list_open_opportunities` (READ, untrusted): the OPEN opportunities with what the matching
 *   needs: company (name, domain, People and their addresses), point of contact and the company's
 *   hypotheses of the run's tenant.
 * - `mark_opportunity_meeting` (LOW_WRITE): the 📅 note on the opportunity (and its company) and
 *   the move to the meeting stage, ONLY from an earlier stage (never backwards, never from a later
 *   or closed stage). Idempotent: the note is found by title on the opportunity.
 *
 * Opportunity, Person, Note and the calendar objects have no `tenantId` (standard objects).
 */
import { z } from 'zod';
import { isClosedStage, linkNoteToOpportunity, readOpportunityStages } from '../../crm/opportunities.js';
import {
  TWENTY_OBJECTS,
  companyDomain,
  filterValue,
  type TwentyClient,
  type TwentyCommercialHypothesis,
  type TwentyCompany,
  type TwentyNote,
  type TwentyNoteTarget,
  type TwentyOpportunity,
  type TwentyPerson,
} from '../../integrations/twenty/index.js';
import { readCalendarEvents } from '../../meetings/calendar.js';
import { legacyMeetingNoteTitle, meetingNoteBody, meetingNoteTitle, meetingStageOf, stageVerdict } from '../../meetings/meeting-sync.js';
import type { OpenOpportunityView } from '../../meetings/match.js';
import { defineTool } from '../types.js';
import { RecordId, withTwenty, type TwentyToolDeps } from './shared.js';

export const MEETING_TOOL_IDS = ['list_calendar_events', 'list_open_opportunities', 'mark_opportunity_meeting'] as const;

const MAX_RANGE_MS = 70 * 86_400_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
/** Distinct companies (and points of contact) read one by one. */
export const MAX_MEETING_LOOKUPS = 200;

// ---------------------------------------------------------------------------
// list_calendar_events
// ---------------------------------------------------------------------------
const Participant = z.object({
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  isOrganizer: z.boolean(),
  responseStatus: z.string().nullable(),
  personId: z.string().nullable(),
  workspaceMemberId: z.string().nullable(),
});

export const CalendarEventSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  isCanceled: z.boolean(),
  isFullDay: z.boolean(),
  location: z.string().nullable(),
  conferenceUrl: z.string().nullable(),
  iCalUid: z.string().nullable(),
  participants: z.array(Participant),
});

export const ListCalendarEventsInput = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .strict()
  .refine((v) => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= MAX_RANGE_MS, { message: 'to must be after from, at most 70 days later' });

export const ListCalendarEventsOutput = z.object({
  calendar: z.enum(['ok', 'no_channel', 'unreadable']),
  probe: z.enum(['associations', 'events']).nullable(),
  code: z.string().nullable(),
  events: z.array(CalendarEventSchema),
  truncated: z.boolean(),
});
export type ListCalendarEventsOutput = z.infer<typeof ListCalendarEventsOutput>;

export function createListCalendarEventsTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_calendar_events',
    name: 'List calendar events',
    version: '1.0.0',
    description:
      "List the events of the salesperson's calendar synced in the CRM that start in a window, with their participants. Reports when no calendar channel is synced. Read only: never creates, changes or answers an event.",
    inputSchema: ListCalendarEventsInput,
    outputSchema: ListCalendarEventsOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:calendar:read'],
    timeoutMs: 60_000,
    // Titles, places and names come from invitations written by third parties: data, never instructions.
    outputTrust: 'untrusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const read = await readCalendarEvents(deps.twenty, { from: new Date(input.from), to: new Date(input.to) }, ctx.signal);
        ctx.logger.info('calendar read', { calendar: read.status, events: read.status === 'ok' ? read.events.length : 0 });
        if (read.status === 'ok') return { status: 'ok' as const, output: { calendar: 'ok' as const, probe: read.probe, code: null, events: read.events, truncated: read.truncated } };
        if (read.status === 'no_channel') return { status: 'ok' as const, output: { calendar: 'no_channel' as const, probe: read.probe, code: null, events: [], truncated: false } };
        return { status: 'ok' as const, output: { calendar: 'unreadable' as const, probe: null, code: read.code, events: [], truncated: false } };
      }),
  });
}

// ---------------------------------------------------------------------------
// list_open_opportunities
// ---------------------------------------------------------------------------
export const OpenOpportunitySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  stage: z.string().nullable(),
  createdAt: z.string(),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  companyDomain: z.string().nullable(),
  pointOfContactId: z.string().nullable(),
  pointOfContactName: z.string().nullable(),
  pointOfContactEmails: z.array(z.string()),
  companyPeople: z.array(z.object({ id: z.string(), emails: z.array(z.string()) })),
  hypotheses: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
});

export const ListOpenOpportunitiesInput = z.object({}).strict();
export const ListOpenOpportunitiesOutput = z.object({ opportunities: z.array(OpenOpportunitySchema), truncated: z.boolean() });
export type ListOpenOpportunitiesOutput = z.infer<typeof ListOpenOpportunitiesOutput>;

type Rec = Record<string, unknown>;

const emailsOf = (p: Pick<TwentyPerson, 'emails'> | null | undefined): string[] => {
  const all = [p?.emails?.primaryEmail, ...(p?.emails?.additionalEmails ?? [])];
  return [...new Set(all.filter((e): e is string => typeof e === 'string' && e.includes('@')).map((e) => e.trim().toLowerCase()))];
};
const nameOf = (p: Pick<TwentyPerson, 'name'> | null | undefined): string | null => {
  const n = [p?.name?.firstName, p?.name?.lastName].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).join(' ').trim();
  return n.length > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

interface CompanyInfo {
  name: string | null;
  domain: string | null;
  people: TwentyPerson[];
  hypotheses: Array<{ id: string; name: string | null }>;
}

async function companyInfo(twenty: TwentyClient, id: string, tenantId: string, signal: AbortSignal): Promise<CompanyInfo | null> {
  const c = await twenty.get<TwentyCompany & { people?: TwentyPerson[]; commercialHypotheses?: TwentyCommercialHypothesis[] }>(TWENTY_OBJECTS.company, id, { depth: 1, signal });
  if (!c) return null;
  let people = Array.isArray(c.people) ? c.people : null;
  if (!people) people = (await twenty.list<TwentyPerson>(TWENTY_OBJECTS.person, { filter: `companyId[eq]:${filterValue(id)}`, limit: 100, signal })).records;
  const hypotheses = (Array.isArray(c.commercialHypotheses) ? c.commercialHypotheses : [])
    .filter((h) => !h.deletedAt && twenty.belongsTo(h, tenantId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3)
    .map((h) => ({ id: h.id, name: str(h.name) }));
  return { name: str(c.name), domain: companyDomain(c), people: people.filter((p) => !p.deletedAt), hypotheses };
}

export function createListOpenOpportunitiesTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'list_open_opportunities',
    name: 'List open opportunities',
    version: '1.0.0',
    description:
      'List the open CRM opportunities (not won, lost or closed) with their company (name, domain, people and their addresses), point of contact and the company hypotheses. Read only.',
    inputSchema: ListOpenOpportunitiesInput,
    outputSchema: ListOpenOpportunitiesOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:opportunities:read', 'twenty:companies:read', 'twenty:people:read', 'twenty:hypotheses:read'],
    timeoutMs: 120_000,
    outputTrust: 'untrusted',
    enabled: true,
    execute: (_input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const rows: Array<TwentyOpportunity & { company?: Rec | null; pointOfContact?: TwentyPerson | null }> = [];
        let truncated = false;
        let after: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) {
            truncated = true;
            break;
          }
          const res = await twenty.list<TwentyOpportunity & { company?: Rec | null; pointOfContact?: TwentyPerson | null }>(TWENTY_OBJECTS.opportunity, {
            limit: PAGE_SIZE,
            orderBy: 'createdAt',
            depth: 1,
            ...(after ? { startingAfter: after } : {}),
            signal: ctx.signal,
          });
          rows.push(...res.records.filter((o) => !o.deletedAt && !isClosedStage(o.stage)));
          const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
          if (!next) break;
          after = next;
        }
        const companies = new Map<string, CompanyInfo | null>();
        let lookups = 0;
        for (const id of new Set(rows.map((o) => o.companyId).filter((v): v is string => typeof v === 'string' && v.length > 0))) {
          if (lookups >= MAX_MEETING_LOOKUPS) {
            truncated = true;
            break;
          }
          lookups += 1;
          companies.set(id, await companyInfo(twenty, id, ctx.tenantId, ctx.signal));
        }
        const opportunities: OpenOpportunityView[] = [];
        for (const o of rows) {
          const info = o.companyId ? (companies.get(o.companyId) ?? null) : null;
          let poc: TwentyPerson | null = o.pointOfContact && typeof o.pointOfContact === 'object' ? o.pointOfContact : null;
          if (!poc && o.pointOfContactId) {
            poc = info?.people.find((p) => p.id === o.pointOfContactId) ?? null;
            if (!poc && lookups < MAX_MEETING_LOOKUPS) {
              lookups += 1;
              poc = await twenty.get<TwentyPerson>(TWENTY_OBJECTS.person, o.pointOfContactId, { depth: 0, signal: ctx.signal });
            }
          }
          opportunities.push({
            id: o.id,
            name: str(o.name),
            stage: str(o.stage),
            createdAt: o.createdAt,
            companyId: o.companyId ?? null,
            companyName: info?.name ?? str(o.company?.name),
            companyDomain: info?.domain ?? (o.company ? companyDomain(o.company as unknown as TwentyCompany) : null),
            pointOfContactId: o.pointOfContactId ?? null,
            pointOfContactName: nameOf(poc),
            pointOfContactEmails: emailsOf(poc),
            companyPeople: (info?.people ?? []).map((p) => ({ id: p.id, emails: emailsOf(p) })),
            hypotheses: info?.hypotheses ?? [],
          });
        }
        ctx.logger.info('open opportunities', { count: opportunities.length, companies: companies.size, truncated });
        return { status: 'ok' as const, output: { opportunities, truncated } };
      }),
  });
}

// ---------------------------------------------------------------------------
// mark_opportunity_meeting
// ---------------------------------------------------------------------------
export const MarkOpportunityMeetingInput = z.object({
  opportunityId: RecordId,
  eventId: z.string().min(1).max(64),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  title: z.string().max(255).nullable().optional(),
  attendees: z.array(z.string().max(320)).max(50).default([]),
  location: z.string().max(255).nullable().optional(),
  conferenceUrl: z.string().max(2048).nullable().optional(),
  via: z.enum(['point_of_contact', 'company_person', 'domain']),
});

export const MARK_MEETING_VERDICTS = ['advanced', 'resumed', 'at_meeting', 'past_meeting', 'closed', 'unknown_stage', 'no_meeting_stage', 'not_found'] as const;
export type MarkMeetingVerdict = (typeof MARK_MEETING_VERDICTS)[number];

export const MarkOpportunityMeetingOutput = z.object({
  verdict: z.enum(MARK_MEETING_VERDICTS),
  /** True when the stage, the note or a note target was written. */
  changed: z.boolean(),
  stageFrom: z.string().nullable(),
  stageTo: z.string().nullable(),
  stageSource: z.enum(['twenty', 'default']).nullable(),
  noteId: z.string().nullable(),
  noteCreated: z.boolean(),
  companyId: z.string().nullable(),
});
export type MarkOpportunityMeetingOutput = z.infer<typeof MarkOpportunityMeetingOutput>;

/**
 * The meeting note with one of these titles (the current one first, then the pre-tanda 23
 * emoji-first spelling) already attached to the opportunity, or null.
 */
async function findMeetingNote(twenty: TwentyClient, titles: readonly string[], opportunityId: string, signal: AbortSignal): Promise<TwentyNote | null> {
  const records: TwentyNote[] = [];
  for (const title of titles) {
    const { records: found } = await twenty.list<TwentyNote>(TWENTY_OBJECTS.note, { filter: `title[eq]:${filterValue(title)}`, limit: 20, signal });
    for (const n of found) if (!records.some((r) => r.id === n.id)) records.push(n);
  }
  for (const n of records) {
    if (n.deletedAt) continue;
    const { records: targets } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `noteId[eq]:${filterValue(n.id)}`, limit: 50, signal });
    if (targets.some((t) => t.targetOpportunityId === opportunityId)) return n;
  }
  return null;
}

export function createMarkOpportunityMeetingTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'mark_opportunity_meeting',
    name: 'Mark opportunity meeting',
    version: '1.0.0',
    description:
      'Record a meeting found in the calendar on an open CRM opportunity: a note on the opportunity and its company, and the move to the meeting stage ONLY from an earlier stage (never backwards, never from a later or closed stage). Idempotent. Never touches the calendar and never sends anything.',
    inputSchema: MarkOpportunityMeetingInput,
    outputSchema: MarkOpportunityMeetingOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:opportunities:read', 'twenty:opportunities:write', 'twenty:notes:read', 'twenty:notes:write'],
    timeoutMs: 30_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const twenty = deps.twenty;
        const opts = { signal: ctx.signal };
        const none = { changed: false, stageTo: null, stageSource: null, noteId: null, noteCreated: false };
        const opp = await twenty.get<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, input.opportunityId, { depth: 0, ...opts });
        if (!opp || opp.deletedAt) return { status: 'ok' as const, output: { verdict: 'not_found' as const, stageFrom: null, companyId: null, ...none } };
        const stageFrom = opp.stage ?? null;
        const companyId = opp.companyId ?? null;
        const { stages, source } = await readOpportunityStages(twenty, ctx.signal);
        const verdict = stageVerdict(stageFrom, stages);
        const start = new Date(input.startsAt);
        const title = meetingNoteTitle(start);
        const existing = await findMeetingNote(twenty, [title, legacyMeetingNoteTitle(start)], opp.id, ctx.signal);
        // A previous run moved it and wrote the note, then stopped before the task: carry on.
        if (verdict === 'at_meeting' && existing) {
          return { status: 'ok' as const, output: { verdict: 'resumed' as const, changed: false, stageFrom, stageTo: stageFrom, stageSource: source, noteId: existing.id, noteCreated: false, companyId } };
        }
        if (verdict !== 'advance') return { status: 'ok' as const, output: { verdict, stageFrom, companyId, ...none, stageSource: source } };
        const stageTo = meetingStageOf(stages)!;
        // The note first: a run that dies after it finds it again and only moves the stage.
        let note = existing;
        let noteCreated = false;
        if (!note) {
          note = await twenty.create<TwentyNote>(
            TWENTY_OBJECTS.note,
            {
              title,
              bodyV2: {
                markdown: meetingNoteBody({
                  startsAt: start,
                  endsAt: input.endsAt ? new Date(input.endsAt) : null,
                  title: input.title ?? null,
                  attendees: input.attendees,
                  location: input.location ?? null,
                  conferenceUrl: input.conferenceUrl ?? null,
                  stageFrom,
                  stageTo,
                  via: input.via,
                }),
              },
            },
            opts,
          );
          noteCreated = true;
        }
        await linkNoteToOpportunity(twenty, note.id, { opportunityId: opp.id }, ctx.signal);
        if (companyId) {
          const { records } = await twenty.list<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { filter: `noteId[eq]:${filterValue(note.id)}`, limit: 50, ...opts });
          if (!records.some((t) => t.targetCompanyId === companyId)) await twenty.create<TwentyNoteTarget>(TWENTY_OBJECTS.noteTarget, { noteId: note.id, targetCompanyId: companyId }, opts);
        }
        await twenty.update<TwentyOpportunity>(TWENTY_OBJECTS.opportunity, opp.id, { stage: stageTo }, opts);
        ctx.logger.info('opportunity meeting', { opportunityId: opp.id, stageFrom: stageFrom ?? '', stageTo, noteCreated });
        return { status: 'ok' as const, output: { verdict: 'advanced' as const, changed: true, stageFrom, stageTo, stageSource: source, noteId: note.id, noteCreated, companyId } };
      }),
  });
}
