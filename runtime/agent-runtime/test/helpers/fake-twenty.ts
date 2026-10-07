/**
 * In-memory stand-in for the Twenty REST API, used through the real TwentyClient
 * (injected `fetch`). Understands the subset of filters the tools generate:
 * `field[eq]:"v"`, `field[ilike]:"%v%"`, `field[is]:NULL`, nested `a.b` paths and `and(...)`.
 * Mirrors observed server behaviour: strips the scheme from Company.domainName and
 * enforces its uniqueness, rejects unknown SELECT values and returns 404 for unknown ids.
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
};
const SELECTS: Record<string, Record<string, string[]>> = {
  commercialSignals: {
    signalType: ['FAIR', 'CONGRESS', 'EVENT', 'NEW_PRODUCT', 'HIRING', 'EXPANSION', 'REBRANDING', 'SPONSORSHIP', 'CAMPAIGN', 'ANNIVERSARY', 'OTHER'],
    status: ['NEW', 'REVIEWING', 'QUALIFIED', 'DISCARDED', 'EXPIRED'],
  },
  commercialHypotheses: { status: ['PROPOSED', 'VALIDATED', 'REJECTED', 'EXPIRED'] },
  agentRunSummaries: { outcome: ['SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED'] },
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
  const m = /^([\w.]+)\[(eq|ilike|is)\]:(?:"(.*)"|(NULL))$/.exec(f);
  if (!m) throw new Error(`fake-twenty: unsupported filter ${f}`);
  const [, path, op, value] = m;
  const actual = getPath(rec, path!);
  if (op === 'is') return actual === null || actual === undefined;
  if (op === 'eq') return actual === value;
  const needle = (value ?? '').replace(/^%|%$/g, '').toLowerCase();
  return typeof actual === 'string' && actual.toLowerCase().includes(needle);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export class FakeTwenty {
  readonly tables: Record<
    'companies' | 'commercialSignals' | 'researches' | 'commercialHypotheses' | 'agentRunSummaries' | 'people' | 'notes' | 'noteTargets',
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
  };
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
    const [, rest, plural, id] = url.pathname.split('/');
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
        };
      }
      return json(200, { data: { [singular[0]!.toLowerCase() + singular.slice(1)]: out } });
    }
    if (method === 'GET') {
      const filter = url.searchParams.get('filter');
      const limit = Number(url.searchParams.get('limit') ?? 60);
      const rows = filter ? table.filter((r) => matches(r, filter)) : table;
      return json(200, { data: { [plural]: rows.slice(0, limit) }, totalCount: rows.length, pageInfo: { hasNextPage: rows.length > limit } });
    }
    if (method === 'POST' && body && this.failNextCreate === plural) {
      this.failNextCreate = null;
      return json(400, { statusCode: 400, error: 'BadRequestException', messages: ['simulated failure'] });
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
      if (plural === 'notes') {
        const v2 = body.bodyV2 as Rec | undefined;
        // Twenty derives blocknote from markdown (transformRichTextValue).
        if (v2) body.bodyV2 = { markdown: v2.markdown ?? null, blocknote: v2.blocknote ?? (v2.markdown ? '[blocknote]' : null) };
      }
      const defaults: Rec =
        plural === 'noteTargets'
          ? { noteId: null, targetCompanyId: null, targetPersonId: null, targetOpportunityId: null, targetCommercialHypothesisId: null }
          : plural === 'notes' || plural === 'people'
            ? {}
            : { companyId: null, commercialSignalId: null };
      const rec = this.seed(plural, { ...defaults, ...body });
      return json(201, { data: { [`create${SINGULAR[plural]}`]: rec } });
    }
    if (method === 'PATCH' && id && body) {
      const rec = table.find((r) => r.id === id);
      if (!rec) return json(404, { statusCode: 404, error: 'NotFoundException', messages: ['Record not found'] });
      if (plural === 'notes' && body.bodyV2) {
        const v2 = body.bodyV2 as Rec;
        body.bodyV2 = { markdown: v2.markdown ?? null, blocknote: v2.blocknote ?? (v2.markdown ? '[blocknote]' : null) };
      }
      Object.assign(rec, body, { updatedAt: new Date().toISOString() });
      return json(200, { data: { [`update${SINGULAR[plural]}`]: rec } });
    }
    return json(405, { messages: ['Method not supported by fake'] });
  };

  client(opts: { apiKey?: string } = {}): TwentyClient {
    return new TwentyClient({
      baseUrl: 'http://twenty.test',
      apiKey: 'apiKey' in opts ? opts.apiKey : 'test-key',
      fetch: this.fetch,
      sleep: async () => {},
    });
  }
}
