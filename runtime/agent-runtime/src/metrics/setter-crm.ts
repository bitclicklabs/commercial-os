/**
 * What the setter metrics (src/metrics/setter.ts, tanda 24) read from Twenty. READ ONLY: nothing
 * here writes, sends or changes a record. Every read answers `{ status: 'ok', value }` or
 * `{ status: 'no_disponible', reason }`: Twenty down, the mailbox not synced or hidden from the
 * API key, a missing object... are reported as NOT AVAILABLE, never turned into zeros.
 *
 * Two implementations of the same `SetterCrmReader`:
 * - `twentySetterCrm(twenty)`: straight on a TwentyClient (GET /metrics/setter);
 * - `toolSetterCrm(tools)`: through the READ tool `read_setter_crm` (the weekly report agent, so
 *   every Twenty read is in the trace and under the tool policy).
 *
 * Sources:
 * - mailbox imported by Twenty (`messages` / `messageParticipants`, src/integrations/twenty/messages.ts):
 *   the messages of a window, the addresses that had a message before a date, the messages of a
 *   set of addresses;
 * - `opportunities` (standard, no tenantId): the OPEN ones (not won / lost / closed) by stage;
 * - `tasks` (standard, no tenantId): the open tasks created by the system (titles of
 *   src/crm/reply-task.ts and src/crm/followup.ts, new «text first, emoji last» spelling and the
 *   old «emoji first» one) whose due date has passed;
 * - `commercialHypotheses` -> `commercialSignals` (App objects, tenant scoped): the signal (fair)
 *   a hypothesis came from, for the breakdown by origin;
 * - `companies`: names, for the «upcoming meetings» list.
 */
import { isClosedStage } from '../crm/opportunities.js';
import { TWENTY_OBJECTS, TwentyApiError, filterValue, type TwentyClient, type TwentyCommercialHypothesis, type TwentyCommercialSignal, type TwentyCompany, type TwentyOpportunity, type TwentyTask } from '../integrations/twenty/index.js';
import {
  readAddressesWithMessagesBefore,
  readMailMessages,
  readMailWindow,
  type MailMessage,
  type WindowMessage,
} from '../integrations/twenty/messages.js';
import type { AgentStep } from '../agents/agent.js';
import type { AgentToolbox } from '../tools/executor.js';

export type Avail<T> = { status: 'ok'; value: T } | { status: 'no_disponible'; reason: string };

export const ok = <T>(value: T): Avail<T> => ({ status: 'ok', value });
export const noDisponible = <T = never>(reason: string): Avail<T> => ({ status: 'no_disponible', reason: reason.slice(0, 300) });

export type SystemTaskKind = 'responder' | 'cerrar_reunion' | 'seguimiento' | 'retomar';

export interface OverdueTask {
  id: string;
  title: string;
  kind: SystemTaskKind;
  dueAt: string;
}

export interface OriginInfo {
  signalId: string | null;
  /** Name of the signal (the fair / event), plain text. */
  signalName: string | null;
}

export interface SetterCrmReader {
  mailWindow(q: { since: Date; until: Date; ownDomains: readonly string[] }): Promise<Avail<{ messages: WindowMessage[]; truncated: boolean }>>;
  priorAddresses(q: { addresses: readonly string[]; before: Date }): Promise<Avail<{ addresses: string[]; truncated: boolean }>>;
  mailFor(q: { addresses: readonly string[]; since: Date; ownDomains: readonly string[] }): Promise<Avail<{ byAddress: Record<string, MailMessage[]>; truncated: boolean }>>;
  openOpportunities(): Promise<Avail<{ total: number; byStage: Record<string, number>; truncated: boolean }>>;
  overdueTasks(q: { now: Date }): Promise<Avail<{ tasks: OverdueTask[]; truncated: boolean }>>;
  origins(q: { hypothesisIds: readonly string[] }): Promise<Avail<Record<string, OriginInfo>>>;
  companyNames(q: { ids: readonly string[] }): Promise<Avail<Record<string, string>>>;
}

/** Addresses / ids handed to one read (the tool input is bounded the same way). */
export const SETTER_CRM_MAX_ITEMS = 500;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const IN_CHUNK = 50;
/** Ids per `or(id[eq]:…)` filter on a tenant-scoped object. */
const OR_CHUNK = 20;

/**
 * Ids of a TENANT-SCOPED object: the client wraps the filter in `and(<tenant>, …)`, and an `[in]`
 * list is only verified on 2.45 as the WHOLE filter (src/integrations/twenty/messages.ts), so the
 * ids go as `or(id[eq]:…)`.
 */
const idsFilter = (ids: readonly string[]): string => (ids.length === 1 ? `id[eq]:${filterValue(ids[0]!)}` : `or(${ids.map((id) => `id[eq]:${filterValue(id)}`).join(',')})`);

type Rec = Record<string, unknown>;

const plain = (v: unknown, max = 200): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /^FIELD_RESTRICTED/i.test(t)) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// ---------------------------------------------------------------------------
// System task titles
// ---------------------------------------------------------------------------
const TASK_KINDS: Array<{ kind: SystemTaskKind; emoji: string; re: RegExp }> = [
  { kind: 'responder', emoji: '📬', re: /^Responder a \S/u },
  { kind: 'cerrar_reunion', emoji: '📅', re: /^Cerrar reunión con \S/u },
  // «Seguimiento N — X 🔔» (tanda 23) and the tanda-21 «🔔 Seguimiento — X».
  { kind: 'seguimiento', emoji: '🔔', re: /^Seguimiento(?: \d+)? — \S/u },
  { kind: 'retomar', emoji: '🔔', re: /^Retomar conversación con \S/u },
];

/**
 * The kind of a task the system creates, from its title (new spelling «Texto … 📬», old spelling
 * «📬 Texto …»); null for any other task (a task a person wrote with similar words but without the
 * emoji is not counted).
 */
export function systemTaskKind(title: string | null | undefined): SystemTaskKind | null {
  const t = (title ?? '').trim();
  for (const k of TASK_KINDS) {
    if (t.endsWith(` ${k.emoji}`) && k.re.test(t)) return k.kind;
    if (t.startsWith(`${k.emoji} `) && k.re.test(t.slice(k.emoji.length + 1).trim())) return k.kind;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Straight on Twenty
// ---------------------------------------------------------------------------
async function listPaged<T extends Rec>(twenty: TwentyClient, plural: string, opts: { filter?: string; tenantId?: string; signal?: AbortSignal }): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) return { rows, truncated: true };
    const res = await twenty.list<T>(plural, {
      limit: PAGE_SIZE,
      ...(opts.filter ? { filter: opts.filter } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(after ? { startingAfter: after } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    rows.push(...res.records.filter((r) => !r.deletedAt));
    const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
    if (!next) return { rows, truncated: false };
    after = next;
  }
}

const mailUnavailable = (r: { status: 'no_messages' } | { status: 'unreadable'; code: string }): string =>
  r.status === 'no_messages' ? 'buzón sin mensajes importados en Twenty (ningún canal de email sincronizado)' : `buzón no legible por la API key de Twenty (${r.code})`;

/** A TwentyApiError (down, timeout, no permission) is «not available»; anything else is a bug and throws. */
async function guarded<T>(twenty: TwentyClient, what: string, body: () => Promise<Avail<T>>): Promise<Avail<T>> {
  if (!twenty.isConfigured()) return noDisponible('Twenty no está configurado (TWENTY_API_KEY)');
  try {
    return await body();
  } catch (err) {
    if (err instanceof TwentyApiError) return noDisponible(`${what}: Twenty no responde o no deja leer (${err.code})`);
    throw err;
  }
}

export function twentySetterCrm(twenty: TwentyClient, o: { tenantId: string; signal?: AbortSignal }): SetterCrmReader {
  const signal = o.signal;
  return {
    mailWindow: (q) =>
      guarded(twenty, 'buzón', async () => {
        const r = await readMailWindow(twenty, q, signal);
        return r.status === 'ok' ? ok({ messages: r.messages, truncated: r.truncated }) : noDisponible(mailUnavailable(r));
      }),
    priorAddresses: (q) =>
      guarded(twenty, 'buzón', async () => {
        const r = await readAddressesWithMessagesBefore(twenty, { addresses: q.addresses.slice(0, SETTER_CRM_MAX_ITEMS), before: q.before }, signal);
        return r.status === 'ok' ? ok({ addresses: r.addresses, truncated: r.truncated || q.addresses.length > SETTER_CRM_MAX_ITEMS }) : noDisponible(mailUnavailable(r));
      }),
    mailFor: (q) =>
      guarded(twenty, 'buzón', async () => {
        const r = await readMailMessages(twenty, { addresses: q.addresses.slice(0, SETTER_CRM_MAX_ITEMS), since: q.since, ownDomains: q.ownDomains }, signal);
        return r.status === 'ok' ? ok({ byAddress: r.byAddress, truncated: r.truncated || q.addresses.length > SETTER_CRM_MAX_ITEMS }) : noDisponible(mailUnavailable(r));
      }),
    openOpportunities: () =>
      guarded(twenty, 'oportunidades', async () => {
        const { rows, truncated } = await listPaged<TwentyOpportunity & Rec>(twenty, TWENTY_OBJECTS.opportunity, { ...(signal ? { signal } : {}) });
        const byStage: Record<string, number> = {};
        let total = 0;
        for (const r of rows) {
          if (isClosedStage(r.stage)) continue;
          const stage = plain(r.stage, 64) ?? 'SIN_ETAPA';
          byStage[stage] = (byStage[stage] ?? 0) + 1;
          total += 1;
        }
        return ok({ total, byStage, truncated });
      }),
    overdueTasks: (q) =>
      guarded(twenty, 'tareas', async () => {
        const filter = `and(dueAt[lt]:${filterValue(q.now.toISOString())},or(status[eq]:${filterValue('TODO')},status[eq]:${filterValue('IN_PROGRESS')}))`;
        const { rows, truncated } = await listPaged<TwentyTask & Rec>(twenty, TWENTY_OBJECTS.task, { filter, ...(signal ? { signal } : {}) });
        const tasks: OverdueTask[] = [];
        for (const t of rows) {
          const kind = systemTaskKind(t.title);
          const due = typeof t.dueAt === 'string' ? Date.parse(t.dueAt) : Number.NaN;
          // Checked again here: the status and the date decide, not only the server filter.
          if (!kind || Number.isNaN(due) || due >= q.now.getTime() || t.status === 'DONE') continue;
          tasks.push({ id: t.id, title: plain(t.title, 255) ?? '', kind, dueAt: new Date(due).toISOString() });
        }
        tasks.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        return ok({ tasks, truncated });
      }),
    origins: (q) =>
      guarded(twenty, 'hipótesis y señales', async () => {
        const ids = [...new Set(q.hypothesisIds)].slice(0, SETTER_CRM_MAX_ITEMS);
        const out: Record<string, OriginInfo> = {};
        const signalOf = new Map<string, string | null>();
        for (const chunk of chunks(ids, OR_CHUNK)) {
          const { rows } = await listPaged<TwentyCommercialHypothesis & Rec>(twenty, TWENTY_OBJECTS.commercialHypothesis, { filter: idsFilter(chunk), tenantId: o.tenantId, ...(signal ? { signal } : {}) });
          for (const h of rows) signalOf.set(h.id, typeof h.commercialSignalId === 'string' && h.commercialSignalId ? h.commercialSignalId : null);
        }
        const signalIds = [...new Set([...signalOf.values()].filter((s): s is string => s !== null))];
        const names = new Map<string, string | null>();
        for (const chunk of chunks(signalIds, OR_CHUNK)) {
          const { rows } = await listPaged<TwentyCommercialSignal & Rec>(twenty, TWENTY_OBJECTS.commercialSignal, { filter: idsFilter(chunk), tenantId: o.tenantId, ...(signal ? { signal } : {}) });
          for (const s of rows) names.set(s.id, plain(s.name, 120));
        }
        for (const id of ids) {
          const sid = signalOf.get(id) ?? null;
          out[id] = { signalId: sid, signalName: sid ? (names.get(sid) ?? null) : null };
        }
        return ok(out);
      }),
    companyNames: (q) =>
      guarded(twenty, 'empresas', async () => {
        const ids = [...new Set(q.ids)].slice(0, SETTER_CRM_MAX_ITEMS);
        const out: Record<string, string> = {};
        for (const chunk of chunks(ids, IN_CHUNK)) {
          const filter = `id[in]:[${chunk.map(filterValue).join(',')}]`;
          const { rows } = await listPaged<TwentyCompany & Rec>(twenty, TWENTY_OBJECTS.company, { filter, ...(signal ? { signal } : {}) });
          for (const c of rows) {
            const n = plain(c.name, 120);
            if (n) out[c.id] = n;
          }
        }
        return ok(out);
      }),
  };
}

// ---------------------------------------------------------------------------
// Through the tool `read_setter_crm`
// ---------------------------------------------------------------------------
export const SETTER_CRM_OPS = ['mail_window', 'prior_addresses', 'mail_for', 'open_opportunities', 'overdue_tasks', 'origins', 'company_names'] as const;
export type SetterCrmOp = (typeof SETTER_CRM_OPS)[number];

export function toolSetterCrm(tools: AgentToolbox, onStep?: (step: AgentStep) => void): SetterCrmReader {
  const call = async <T>(input: Record<string, unknown>): Promise<Avail<T>> => {
    const r = await tools.call('read_setter_crm', input);
    onStep?.(r.step);
    if (r.result.status !== 'ok') {
      const e = r.result as { status: string; code?: string; message?: string };
      return noDisponible(`read_setter_crm ${String(input.op)}: ${e.code ?? e.status}${e.message ? ` (${e.message})` : ''}`);
    }
    return r.result.output as Avail<T>;
  };
  return {
    mailWindow: (q) => call({ op: 'mail_window', since: q.since.toISOString(), until: q.until.toISOString(), ownDomains: [...q.ownDomains] }),
    priorAddresses: (q) => call({ op: 'prior_addresses', addresses: q.addresses.slice(0, SETTER_CRM_MAX_ITEMS), before: q.before.toISOString() }),
    mailFor: (q) => call({ op: 'mail_for', addresses: q.addresses.slice(0, SETTER_CRM_MAX_ITEMS), since: q.since.toISOString(), ownDomains: [...q.ownDomains] }),
    openOpportunities: () => call({ op: 'open_opportunities' }),
    overdueTasks: (q) => call({ op: 'overdue_tasks', now: q.now.toISOString() }),
    origins: (q) => call({ op: 'origins', hypothesisIds: [...new Set(q.hypothesisIds)].slice(0, SETTER_CRM_MAX_ITEMS) }),
    companyNames: (q) => call({ op: 'company_names', ids: [...new Set(q.ids)].slice(0, SETTER_CRM_MAX_ITEMS) }),
  };
}

/** A reader where nothing of Twenty is available (no client configured). */
export function unavailableSetterCrm(reason: string): SetterCrmReader {
  const no = async () => noDisponible(reason);
  return { mailWindow: no, priorAddresses: no, mailFor: no, openOpportunities: no, overdueTasks: no, origins: no, companyNames: no };
}
