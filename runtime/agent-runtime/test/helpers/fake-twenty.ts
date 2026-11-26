/**
 * In-memory stand-in for the Twenty REST API, used through the real TwentyClient
 * (injected `fetch`). Understands the subset of filters the tools generate:
 * `field[eq]:"v"`, `field[ilike]:"%v%"`, `field[is]:NULL`, nested `a.b` paths, `and(...)` and `or(...)` (the tenant filter).
 * Mirrors observed server behaviour: strips the scheme from Company.domainName and
 * enforces its uniqueness, rejects unknown SELECT values and returns 404 for unknown ids.
 * Standard objects of tanda 19: `opportunities` (stage SELECT = `opportunityStages`, served by
 * `GET /rest/open-api/core` like the real server), `tasks` / `taskTargets`, and a unique
 * `people.emails.primaryEmail` (case-insensitive) when `uniquePersonEmails` is on. Tanda 22: the
 * calendar objects `calendarEvents`, `calendarEventParticipants` and
 * `calendarChannelEventAssociations` (read only), the `[in]` and range (`gte`/`lte`/`gt`/`lt`)
 * filters, `expandRelations` (depth 1) and `hiddenObjects` (an object the API key cannot see).
 */
import { randomUUID } from 'node:crypto';
import { TwentyClient } from '../../src/integrations/twenty/index.js';

type Rec = Record<string, unknown>;

const SINGULAR: Record<string, string> = {
  companies: 'Company',
  commercialSignals: 'CommercialSignal',
  researches: 'Research',
  commercialHypotheses: 'CommercialHypothesis',
  agentRunSummaries: 'AgentRunSummary',
  people: 'Person',
  notes: 'Note',
  noteTargets: 'NoteTarget',
  opportunities: 'Opportunity',
  tasks: 'Task',
  taskTargets: 'TaskTarget',
  calendarEvents: 'CalendarEvent',
  calendarEventParticipants: 'CalendarEventParticipant',
  calendarChannelEventAssociations: 'CalendarChannelEventAssociation',
};
/** `opportunity.stage` options of a default Twenty workspace, in order (GET /rest/open-api/core, tanda 19). */
export const DEFAULT_OPPORTUNITY_STAGES = ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER'];
const SELECTS: Record<string, Record<string, string[]>> = {
  commercialSignals: {
    signalType: ['FAIR', 'CONGRESS', 'EVENT', 'NEW_PRODUCT', 'HIRING', 'EXPANSION', 'REBRANDING', 'SPONSORSHIP', 'CAMPAIGN', 'ANNIVERSARY', 'OTHER'],
    status: ['NEW', 'REVIEWING', 'QUALIFIED', 'DISCARDED', 'EXPIRED'],
  },
  commercialHypotheses: { status: ['PROPOSED', 'VALIDATED', 'REJECTED', 'EXPIRED'] },
  agentRunSummaries: { outcome: ['SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED'] },
  tasks: { status: ['TODO', 'IN_PROGRESS', 'DONE'] },
};

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function getPath(rec: Rec, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Rec)[k] : undefined), rec);
}

function matches(rec: Rec, filter: string): boolean {
  const f = filter.trim();
  if (f.startsWith('and(') && f.endsWith(')')) return splitTopLevel(f.slice(4, -1)).every((c) => matches(rec, c));
  if (f.startsWith('or(') && f.endsWith(')')) return splitTopLevel(f.slice(3, -1)).some((c) => matches(rec, c));
  const inList = /^([\w.]+)\[in\]:\[(.*)\]$/.exec(f);
  if (inList) {
    const values = [...inList[2]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    return values.includes(getPath(rec, inList[1]!) as string);
  }
  const m = /^([\w.]+)\[(eq|ilike|is|gte|lte|gt|lt)\]:(?:"(.*)"|(NULL))$/.exec(f);
  if (!m) throw new Error(`fake-twenty: unsupported filter ${f}`);
  const [, path, op, value] = m;
  const actual = getPath(rec, path!);
  if (op === 'is') return actual === null || actual === undefined;
  if (op === 'eq') return actual === value;
  // Range filters (ISO dates): compared as instants when both parse, else as strings.
  if (op === 'gte' || op === 'lte' || op === 'gt' || op === 'lt') {
    if (typeof actual !== 'string' || value === undefined) return false;
    const a = Date.parse(actual);
    const b = Date.parse(value);
    const cmp = Number.isNaN(a) || Number.isNaN(b) ? actual.localeCompare(value) : a - b;
    return op === 'gte' ? cmp >= 0 : op === 'lte' ? cmp <= 0 : op === 'gt' ? cmp > 0 : cmp < 0;
  }
  const needle = (value ?? '').replace(/^%|%$/g, '').toLowerCase();
  return typeof actual === 'string' && actual.toLowerCase().includes(needle);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export class FakeTwenty {
  readonly tables: Record<
    | 'companies'
    | 'commercialSignals'
    | 'researches'
    | 'commercialHypotheses'
    | 'agentRunSummaries'
    | 'people'
    | 'notes'
    | 'noteTargets'
    | 'opportunities'
    | 'tasks'
    | 'taskTargets'
    | 'calendarEvents'
    | 'calendarEventParticipants'
    | 'calendarChannelEventAssociations',
    Rec[]
  > &
    Record<string, Rec[] | undefined> = {
    companies: [],
    commercialSignals: [],
    researches: [],
    commercialHypotheses: [],
    agentRunSummaries: [],
    people: [],
    notes: [],
    noteTargets: [],
    opportunities: [],
    tasks: [],
    taskTargets: [],
    calendarEvents: [],
    calendarEventParticipants: [],
    calendarChannelEventAssociations: [],
  };
  /**
   * Expand relations with `depth=1` like the real server (tanda 22, verified on Twenty 2.45): lists
   * of `opportunities` carry `company` and `pointOfContact`, lists of `calendarEvents` carry
   * `calendarEventParticipants`, and a company read with depth 1 carries its `people`. Off by
   * default (the older suites expect the bare records), so both code paths get exercised.
   */
  expandRelations = false;
  /** Objects the server answers with 400 `object '<plural>' not found` (e.g. a role without access). */
  readonly hiddenObjects = new Set<string>();
  /** Options of `opportunity.stage`, in order (the first one is the entry stage). */
  opportunityStages: string[] = [...DEFAULT_OPPORTUNITY_STAGES];
  /** Twenty refuses a second person with the same primary email. */
  uniquePersonEmails = true;
  /** Makes the next POST to `plural` fail with a non-retryable 400 (once). */
  failNextCreate: string | null = null;
  readonly requests: Array<{ method: string; path: string; body?: Rec }> = [];

  seed(plural: string, rec: Rec): Rec {
    const full = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, ...rec };
    this.tables[plural]!.push(full);
    return full;
  }

  count(method: string, plural: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(`/rest/${plural}`)).length;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Rec) : undefined;
    this.requests.push({ method, path: url.pathname, ...(body ? { body: structuredClone(body) } : {}) });
    if (method === 'GET' && url.pathname === '/rest/open-api/core') {
      return json(200, { openapi: '3.0.3', components: { schemas: { Opportunity: { type: 'object', properties: { name: { type: 'string' }, stage: { type: 'string', enum: [...this.opportunityStages] } } } } } });
    }
    const [, rest, plural, id] = url.pathname.split('/');
    if (plural && this.hiddenObjects.has(plural)) return json(400, { statusCode: 400, error: 'BadRequestException', messages: [`object '${plural}' not found. eg: companies`] });
    if (rest !== 'rest' || !plural || !this.tables[plural]) return json(404, { messages: ['Unknown object'] });
    const table = this.tables[plural]!;

    if (method === 'GET' && id) {
      const rec = table.find((r) => r.id === id);
      if (!rec) return json(404, { statusCode: 404, error: 'NotFoundException', messages: ['Record not found'] });
      const singular = SINGULAR[plural]!;
      let out: Rec = rec;
      if (plural === 'commercialHypotheses' && url.searchParams.get('depth') === '1') {
        const byId = (t: string, v: unknown) => this.tables[t]!.find((r) => r.id === v) ?? null;
        out = {
          ...rec,
          company: byId('companies', rec.companyId),
          commercialSignal: byId('commercialSignals', rec.commercialSignalId),
          decisionMaker: byId('people', rec.decisionMakerId),
          noteTargets: this.tables.noteTargets!.filter((t) => t.targetCommercialHypothesisId === id),
        };
      }
      if (plural === 'companies' && url.searchParams.get('depth') === '1') {
        out = {
          ...rec,
          commercialSignals: this.tables.commercialSignals!.filter((s) => s.companyId === id),
          researches: this.tables.researches!.filter((s) => s.companyId === id),
          commercialHypotheses: this.tables.commercialHypotheses!.filter((s) => s.companyId === id),
          agentRunSummaries: this.tables.agentRunSummaries!.filter((s) => s.companyId === id),
          ...(this.expandRelations ? { people: this.tables.people!.filter((p) => p.companyId === id) } : {}),
        };
      }
      return json(200, { data: { [singular[0]!.toLowerCase() + singular.slice(1)]: out } });
    }
    if (method === 'GET') {
      const filter = url.searchParams.get('filter');
      const limit = Number(url.searchParams.get('limit') ?? 60);
      const rows = filter ? table.filter((r) => matches(r, filter)) : table;
      let page = rows.slice(0, limit);
      if (this.expandRelations && url.searchParams.get('depth') === '1') {
        const byId = (t: string, v: unknown) => this.tables[t]!.find((r) => r.id === v) ?? null;
        if (plural === 'opportunities') page = page.map((o) => ({ ...o, company: byId('companies', o.companyId), pointOfContact: byId('people', o.pointOfContactId) }));
        if (plural === 'calendarEvents') page = page.map((e) => ({ ...e, calendarEventParticipants: this.tables.calendarEventParticipants!.filter((p) => p.calendarEventId === e.id) }));
      }
      return json(200, { data: { [plural]: page }, totalCount: rows.length, pageInfo: { hasNextPage: rows.length > limit } });
    }
    if (method === 'POST' && body && this.failNextCreate === plural) {
      this.failNextCreate = null;
      return json(400, { statusCode: 400, error: 'BadRequestException', messages: ['simulated failure'] });
    }
    if ((method === 'POST' || method === 'PATCH') && body && plural === 'opportunities' && body.stage !== undefined && body.stage !== null && !this.opportunityStages.includes(String(body.stage))) {
      return json(400, { statusCode: 400, error: 'BadRequestException', messages: [`Invalid value "${String(body.stage)}" for field "stage"`] });
    }
    if (method === 'POST' && body) {
      for (const [field, allowed] of Object.entries(SELECTS[plural] ?? {})) {
        const v = body[field];
        if (v !== undefined && !allowed.includes(String(v))) {
          return json(400, { statusCode: 400, error: 'BadRequestException', messages: [`Invalid value "${String(v)}" for field "${field}"`] });
        }
      }
      if (plural === 'companies') {
        const links = body.domainName as Rec | undefined;
        if (links && typeof links.primaryLinkUrl === 'string') {
          const stripped = links.primaryLinkUrl.replace(/^https?:\/\//, '');
          body.domainName = { ...links, primaryLinkUrl: stripped };
          if (stripped && table.some((c) => getPath(c, 'domainName.primaryLinkUrl') === stripped)) {
            return json(400, {
              statusCode: 400,
              error: 'BadRequestException',
              messages: ['A duplicate entry was detected: unique constraint company.IDX_UNIQUE was violated'],
            });
          }
        }
      }
      if (plural === 'people' && this.uniquePersonEmails) {
        const email = String(getPath(body, 'emails.primaryEmail') ?? '').toLowerCase();
        if (email && table.some((p) => String(getPath(p, 'emails.primaryEmail') ?? '').toLowerCase() === email)) {
          return json(400, { statusCode: 400, error: 'BadRequestException', messages: ['A duplicate entry was detected: unique constraint person.emailsPrimaryEmail was violated'] });
        }
      }
      if (plural === 'notes' || plural === 'tasks') {
        const v2 = body.bodyV2 as Rec | undefined;
        // Twenty derives blocknote from markdown (transformRichTextValue).
        if (v2) body.bodyV2 = { markdown: v2.markdown ?? null, blocknote: v2.blocknote ?? (v2.markdown ? '[blocknote]' : null) };
      }
      const defaults: Rec =
        plural === 'noteTargets'
          ? { noteId: null, targetCompanyId: null, targetPersonId: null, targetOpportunityId: null, targetCommercialHypothesisId: null }
          : plural === 'taskTargets'
            ? { taskId: null, targetCompanyId: null, targetPersonId: null, targetOpportunityId: null, targetCommercialHypothesisId: null, targetCommercialSignalId: null }
            : plural === 'tasks'
              ? { title: null, bodyV2: null, dueAt: null, status: 'TODO', assigneeId: null }
              : plural === 'opportunities'
                ? { name: null, amount: { amountMicros: null, currencyCode: null }, closeDate: null, stage: this.opportunityStages[0] ?? null, companyId: null, pointOfContactId: null, ownerId: null }
                : plural === 'notes' || plural === 'people'
                  ? {}
                  : { companyId: null, commercialSignalId: null };
      const rec = this.seed(plural, { ...defaults, ...body });
      return json(201, { data: { [`create${SINGULAR[plural]}`]: rec } });
    }
    if (method === 'PATCH' && id && body) {
      const rec = table.find((r) => r.id === id);
      if (!rec) return json(404, { statusCode: 404, error: 'NotFoundException', messages: ['Record not found'] });
      if ((plural === 'notes' || plural === 'tasks') && body.bodyV2) {
        const v2 = body.bodyV2 as Rec;
        body.bodyV2 = { markdown: v2.markdown ?? null, blocknote: v2.blocknote ?? (v2.markdown ? '[blocknote]' : null) };
      }
      Object.assign(rec, body, { updatedAt: new Date().toISOString() });
      return json(200, { data: { [`update${SINGULAR[plural]}`]: rec } });
    }
    return json(405, { messages: ['Method not supported by fake'] });
  };

  client(opts: { apiKey?: string; ownerTenantId?: string } = {}): TwentyClient {
    return new TwentyClient({
      baseUrl: 'http://twenty.test',
      apiKey: 'apiKey' in opts ? opts.apiKey : 'test-key',
      ...(opts.ownerTenantId ? { ownerTenantId: opts.ownerTenantId } : {}),
      fetch: this.fetch,
      sleep: async () => {},
    });
  }
}
