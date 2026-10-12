/**
 * In-memory CRM behind the real TwentyClient (injected `fetch`), for runs that must never
 * reach Twenty: the experiments the Skill Optimizer launches from the worker
 * (src/optimizer/). Same behaviour as the test helper `test/helpers/fake-twenty.ts` (which
 * `pnpm skill:compare` and `pnpm experiment:run` use from scripts/), but inside `src/` so the
 * runtime build can use it: the image does not ship `test/`.
 *
 * Understands the filters the tools generate: `field[eq]:"v"`, `field[ilike]:"%v%"`,
 * `field[is]:NULL`, nested `a.b` paths, `and(...)` and `or(...)` (the tenant filter). Strips the scheme from
 * Company.domainName and enforces its uniqueness, rejects unknown SELECT values and returns
 * 404 for unknown ids, like the server. No DELETE (the tools never delete).
 */
import { randomUUID } from 'node:crypto';
import { TwentyClient } from './client.js';

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
  tasks: 'Task',
  taskTargets: 'TaskTarget',
};
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
  const m = /^([\w.]+)\[(eq|ilike|is)\]:(?:"(.*)"|(NULL))$/.exec(f);
  if (!m) throw new Error(`memory-twenty: unsupported filter ${f}`);
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

const richText = (v2: Rec) => ({ markdown: v2.markdown ?? null, blocknote: v2.blocknote ?? (v2.markdown ? '[blocknote]' : null) });

export class MemoryTwenty {
  readonly tables: Record<string, Rec[]> = Object.fromEntries(Object.keys(SINGULAR).map((k) => [k, [] as Rec[]]));

  /** Records written (POST) to any table: the CRM writes the run would have made. */
  writes(): number {
    return Object.values(this.tables).reduce((n, t) => n + t.length, 0);
  }

  private insert(plural: string, rec: Rec): Rec {
    const now = new Date().toISOString();
    const full = { id: randomUUID(), createdAt: now, updatedAt: now, deletedAt: null, ...rec };
    this.tables[plural]!.push(full);
    return full;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Rec) : undefined;
    const [, rest, plural, id] = url.pathname.split('/');
    if (rest !== 'rest' || !plural || !this.tables[plural]) return json(404, { messages: ['Unknown object'] });
    const table = this.tables[plural]!;

    if (method === 'GET' && id) {
      const rec = table.find((r) => r.id === id);
      if (!rec) return json(404, { statusCode: 404, error: 'NotFoundException', messages: ['Record not found'] });
      const singular = SINGULAR[plural]!;
      let out: Rec = rec;
      if (url.searchParams.get('depth') === '1') {
        const byId = (t: string, v: unknown) => this.tables[t]!.find((r) => r.id === v) ?? null;
        if (plural === 'commercialHypotheses') {
          out = {
            ...rec,
            company: byId('companies', rec.companyId),
            commercialSignal: byId('commercialSignals', rec.commercialSignalId),
            decisionMaker: byId('people', rec.decisionMakerId),
            noteTargets: this.tables.noteTargets!.filter((t) => t.targetCommercialHypothesisId === id),
          };
        }
        if (plural === 'companies') {
          out = {
            ...rec,
            commercialSignals: this.tables.commercialSignals!.filter((s) => s.companyId === id),
            researches: this.tables.researches!.filter((s) => s.companyId === id),
            commercialHypotheses: this.tables.commercialHypotheses!.filter((s) => s.companyId === id),
            agentRunSummaries: this.tables.agentRunSummaries!.filter((s) => s.companyId === id),
          };
        }
      }
      return json(200, { data: { [singular[0]!.toLowerCase() + singular.slice(1)]: out } });
    }
    if (method === 'GET') {
      const filter = url.searchParams.get('filter');
      const limit = Number(url.searchParams.get('limit') ?? 60);
      const rows = filter ? table.filter((r) => matches(r, filter)) : table;
      return json(200, { data: { [plural]: rows.slice(0, limit) }, totalCount: rows.length, pageInfo: { hasNextPage: rows.length > limit } });
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
            return json(400, { statusCode: 400, error: 'BadRequestException', messages: ['A duplicate entry was detected: unique constraint company.IDX_UNIQUE was violated'] });
          }
        }
      }
      if ((plural === 'notes' || plural === 'tasks') && body.bodyV2) body.bodyV2 = richText(body.bodyV2 as Rec);
      const defaults: Rec =
        plural === 'noteTargets'
          ? { noteId: null, targetCompanyId: null, targetPersonId: null, targetOpportunityId: null, targetCommercialHypothesisId: null }
          : plural === 'taskTargets'
            ? { taskId: null, targetCompanyId: null, targetPersonId: null, targetOpportunityId: null, targetCommercialHypothesisId: null, targetCommercialSignalId: null }
            : plural === 'tasks'
              ? { status: 'TODO', dueAt: null, assigneeId: null }
              : plural === 'notes' || plural === 'people'
                ? {}
                : { companyId: null, commercialSignalId: null };
      const rec = this.insert(plural, { ...defaults, ...body });
      return json(201, { data: { [`create${SINGULAR[plural]}`]: rec } });
    }
    if (method === 'PATCH' && id && body) {
      const rec = table.find((r) => r.id === id);
      if (!rec) return json(404, { statusCode: 404, error: 'NotFoundException', messages: ['Record not found'] });
      if ((plural === 'notes' || plural === 'tasks') && body.bodyV2) body.bodyV2 = richText(body.bodyV2 as Rec);
      Object.assign(rec, body, { updatedAt: new Date().toISOString() });
      return json(200, { data: { [`update${SINGULAR[plural]}`]: rec } });
    }
    return json(405, { messages: ['Method not supported by the in-memory CRM'] });
  };

  client(): TwentyClient {
    return new TwentyClient({ baseUrl: 'http://memory-twenty.invalid', apiKey: 'memory', fetch: this.fetch, sleep: async () => {} });
  }
}
