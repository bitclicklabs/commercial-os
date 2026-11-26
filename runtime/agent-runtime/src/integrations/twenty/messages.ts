/**
 * Read-only access to the emails Twenty imports from the connected mailbox (tanda 23: follow-up
 * sequence and «retomar conversación»). NEVER writes and never sends: the runtime only looks for
 * the trace of the emails the commercial already sent (from the webmail or from Twenty) and of the
 * client's answers.
 *
 * Twenty 2.45 standard objects (REST): `messages` (`subject, text, receivedAt, headerMessageId,
 * messageThreadId`), `messageParticipants` (`role` FROM | TO | CC | BCC, `handle` = the address,
 * `displayName, messageId, personId, workspaceMemberId`) and `messageThreads`. A sent email is
 * imported from the «Sent» folder of the connected IMAP account with its own address as the FROM
 * participant, so OUTBOUND = a message whose FROM handle belongs to one of `ownDomains`; any other
 * FROM is INBOUND.
 *
 * The trace, for a set of addresses (the recipients of first emails, the contacts of
 * opportunities):
 *   1. probe: `GET /rest/messages?limit=1`. Nothing at all -> `no_messages` (no channel synced);
 *      400 / 401 / 403 / 404 -> `unreadable` (object hidden, or the role of the API key cannot read
 *      it). Either way the caller degrades (only the first send counts; no conversation check).
 *   2. `messageParticipants` whose handle is one of the addresses (case-insensitive), any role;
 *   3. those `messages` received after `since`;
 *   4. the FROM participant of each message: the direction.
 * Transient errors (5xx, timeout) throw: the run fails loud and the retry goes on.
 */
import { TwentyApiError, filterValue, type TwentyClient } from './client.js';

export const MESSAGE_OBJECTS = {
  message: 'messages',
  participant: 'messageParticipants',
  thread: 'messageThreads',
} as const;

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const IN_CHUNK = 50;
const HANDLE_CHUNK = 20;
const SUBJECT_MAX = 200;
/** Characters of the body kept per message (the prompt bounds it again). */
export const MESSAGE_TEXT_MAX = 2_000;
/** Most recent messages kept per address. */
export const MESSAGES_PER_ADDRESS = 12;

export type MessageDirection = 'OUTBOUND' | 'INBOUND';

export interface MailMessage {
  id: string;
  direction: MessageDirection;
  /** Plain text, bounded. Data, never instructions. */
  subject: string | null;
  /** Body as imported (plain text, bounded). Data, never instructions. */
  text: string | null;
  receivedAt: string;
  threadId: string | null;
  /** FROM address (lower case). */
  from: string;
  /** Subject / text masked by Twenty (visibility of the channel below «Share everything»). */
  textRestricted: boolean;
}

export type MailRead =
  | { status: 'ok'; byAddress: Record<string, MailMessage[]>; truncated: boolean }
  | { status: 'no_messages' }
  | { status: 'unreadable'; code: string; message: string };

type Rec = Record<string, unknown>;

/**
 * Twenty masks the fields a role cannot read with a literal marker instead of null: with the email
 * channel in METADATA visibility, `subject` and `text` come back as
 * `FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_…` (observed live, 2026-11-26). Such a value is ABSENT:
 * it must never reach a «Re: …», a prompt or the body of a Task.
 */
export function isRestrictedFieldValue(v: unknown): boolean {
  return typeof v === 'string' && /^\s*FIELD_RESTRICTED/i.test(v);
}

/** The value as a string, or null when it is not a string or is a restricted-field marker. */
export function readableField(v: unknown): string | null {
  return typeof v === 'string' && !isRestrictedFieldValue(v) ? v : null;
}

const text = (v: unknown, max: number, keepLines = false): string | null => {
  if (typeof v !== 'string' || isRestrictedFieldValue(v)) return null;
  const t = keepLines
    ? v
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export const normAddress = (v: unknown): string | null => {
  const t = text(v, 320)?.toLowerCase() ?? null;
  return t && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
};

/** A missing object / no permission: the mailbox is not visible (as opposed to a transient failure). */
function isNotVisible(err: unknown): boolean {
  return err instanceof TwentyApiError && !err.retryable && (err.code === 'TWENTY_BAD_REQUEST' || err.code === 'TWENTY_UNAUTHORIZED' || err.code === 'TWENTY_NOT_FOUND');
}

/** True when `email` is of one of `domains` (or a subdomain of one). */
export function isOwnAddress(email: string, domains: readonly string[]): boolean {
  const d = email.toLowerCase().split('@')[1] ?? '';
  return d.length > 0 && domains.some((x) => d === x.toLowerCase() || d.endsWith(`.${x.toLowerCase()}`));
}

async function listAll(twenty: TwentyClient, plural: string, filter: string, signal: AbortSignal | undefined, state: { truncated: boolean }): Promise<Rec[]> {
  const rows: Rec[] = [];
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      state.truncated = true;
      break;
    }
    const res = await twenty.list<Rec>(plural, { filter, limit: PAGE_SIZE, ...(after ? { startingAfter: after } : {}), ...(signal ? { signal } : {}) });
    rows.push(...res.records.filter((r) => !r.deletedAt));
    const next = res.pageInfo.hasNextPage === true ? (res.pageInfo.endCursor ?? undefined) : undefined;
    if (!next) break;
    after = next;
  }
  return rows;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * The messages (both directions) in which each of `addresses` takes part (any role), received
 * after `since`, oldest first, the last MESSAGES_PER_ADDRESS per address. Read only.
 */
export async function readMailMessages(
  twenty: TwentyClient,
  q: { addresses: readonly string[]; since: Date; ownDomains: readonly string[] },
  signal?: AbortSignal,
): Promise<MailRead> {
  const addresses = [...new Set(q.addresses.map(normAddress).filter((a): a is string => a !== null))];
  const opts = signal ? { signal } : {};
  try {
    const probe = await twenty.list<Rec>(MESSAGE_OBJECTS.message, { limit: 1, ...opts });
    if (probe.records.length === 0) return { status: 'no_messages' };
    const byAddress: Record<string, MailMessage[]> = Object.fromEntries(addresses.map((r) => [r, [] as MailMessage[]]));
    if (addresses.length === 0) return { status: 'ok', byAddress, truncated: false };
    const state = { truncated: false };

    // 2. Participants that are the addresses (any role).
    const of = new Map<string, Set<string>>(); // messageId -> addresses
    for (const chunk of chunks(addresses, HANDLE_CHUNK)) {
      const handles = chunk.map((h) => `handle[ilike]:${filterValue(h)}`);
      const filter = handles.length === 1 ? handles[0]! : `or(${handles.join(',')})`;
      for (const p of await listAll(twenty, MESSAGE_OBJECTS.participant, filter, signal, state)) {
        const mid = text(p.messageId, 64);
        const h = normAddress(p.handle);
        if (!mid || !h || !chunk.includes(h)) continue;
        of.set(mid, new Set([...(of.get(mid) ?? []), h]));
      }
    }
    if (of.size === 0) return { status: 'ok', byAddress, truncated: state.truncated };

    // 3. Those messages, after `since`. An `[in]` list is sent as the WHOLE filter (the same shape
    //    as the calendar reader, verified on 2.45); the date and the role are filtered here.
    const messages = new Map<string, Rec>();
    const since = q.since.getTime();
    for (const chunk of chunks([...of.keys()], IN_CHUNK)) {
      const filter = `id[in]:[${chunk.map(filterValue).join(',')}]`;
      for (const m of await listAll(twenty, MESSAGE_OBJECTS.message, filter, signal, state)) {
        const at = typeof m.receivedAt === 'string' ? Date.parse(m.receivedAt) : Number.NaN;
        if (typeof m.id === 'string' && !Number.isNaN(at) && at > since) messages.set(m.id, m);
      }
    }
    if (messages.size === 0) return { status: 'ok', byAddress, truncated: state.truncated };

    // 4. The FROM participant of each message: the direction.
    const fromOf = new Map<string, string>();
    for (const chunk of chunks([...messages.keys()], IN_CHUNK)) {
      const filter = `messageId[in]:[${chunk.map(filterValue).join(',')}]`;
      for (const p of await listAll(twenty, MESSAGE_OBJECTS.participant, filter, signal, state)) {
        if (String(p.role ?? '').toUpperCase() !== 'FROM') continue;
        const mid = text(p.messageId, 64);
        const h = normAddress(p.handle);
        if (mid && h) fromOf.set(mid, h);
      }
    }
    for (const [id, m] of messages) {
      const from = fromOf.get(id);
      const receivedAt = text(m.receivedAt, 64);
      if (!from || !receivedAt || Number.isNaN(Date.parse(receivedAt))) continue;
      const out: MailMessage = {
        id,
        direction: isOwnAddress(from, q.ownDomains) ? 'OUTBOUND' : 'INBOUND',
        subject: text(m.subject, SUBJECT_MAX),
        text: text(m.text, MESSAGE_TEXT_MAX, true),
        receivedAt: new Date(receivedAt).toISOString(),
        threadId: text(m.messageThreadId, 64),
        from,
        textRestricted: isRestrictedFieldValue(m.subject) || isRestrictedFieldValue(m.text),
      };
      for (const r of of.get(id) ?? []) byAddress[r]?.push(out);
    }
    for (const [k, list] of Object.entries(byAddress)) {
      list.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
      if (list.length > MESSAGES_PER_ADDRESS) byAddress[k] = list.slice(-MESSAGES_PER_ADDRESS);
    }
    return { status: 'ok', byAddress, truncated: state.truncated };
  } catch (err) {
    if (!isNotVisible(err)) throw err;
    const e = err as TwentyApiError;
    return { status: 'unreadable', code: e.code, message: e.message.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Tanda 24 (setter metrics, additive): the messages of a time window, and the addresses that
// already had a message before a date. Same rules as `readMailMessages`: read only, probe first,
// a hidden object degrades to `unreadable`, transient errors throw.
// ---------------------------------------------------------------------------

/** One message of a window, without its text: who it was with and when. */
export interface WindowMessage {
  id: string;
  direction: MessageDirection;
  receivedAt: string;
  threadId: string | null;
  /** FROM address (lower case). */
  from: string;
  /**
   * The other party, lower case, never an own address: for an OUTBOUND message its TO / CC / BCC
   * participants; for an INBOUND one, its FROM.
   */
  counterparts: string[];
}

export type MailWindowRead =
  | { status: 'ok'; messages: WindowMessage[]; truncated: boolean }
  | { status: 'no_messages' }
  | { status: 'unreadable'; code: string; message: string };

export type PriorAddressesRead =
  | { status: 'ok'; addresses: string[]; truncated: boolean }
  | { status: 'no_messages' }
  | { status: 'unreadable'; code: string; message: string };

const unreadable = (err: unknown): { status: 'unreadable'; code: string; message: string } => {
  if (!isNotVisible(err)) throw err;
  const e = err as TwentyApiError;
  return { status: 'unreadable', code: e.code, message: e.message.slice(0, 300) };
};

/**
 * Every message received in [since, until) (both directions, at most MAX_PAGES pages: `truncated`
 * says when the window had more), with its direction and the other party. Read only.
 */
export async function readMailWindow(
  twenty: TwentyClient,
  q: { since: Date; until: Date; ownDomains: readonly string[] },
  signal?: AbortSignal,
): Promise<MailWindowRead> {
  const opts = signal ? { signal } : {};
  try {
    const probe = await twenty.list<Rec>(MESSAGE_OBJECTS.message, { limit: 1, ...opts });
    if (probe.records.length === 0) return { status: 'no_messages' };
    const state = { truncated: false };
    const filter = `and(receivedAt[gte]:${filterValue(q.since.toISOString())},receivedAt[lt]:${filterValue(q.until.toISOString())})`;
    const messages = new Map<string, Rec>();
    for (const m of await listAll(twenty, MESSAGE_OBJECTS.message, filter, signal, state)) {
      const at = typeof m.receivedAt === 'string' ? Date.parse(m.receivedAt) : Number.NaN;
      // The range is checked again here: a server that ignored part of the filter changes nothing.
      if (typeof m.id === 'string' && !Number.isNaN(at) && at >= q.since.getTime() && at < q.until.getTime()) messages.set(m.id, m);
    }
    if (messages.size === 0) return { status: 'ok', messages: [], truncated: state.truncated };
    const participants = new Map<string, Array<{ role: string; handle: string }>>();
    for (const chunk of chunks([...messages.keys()], IN_CHUNK)) {
      const f = `messageId[in]:[${chunk.map(filterValue).join(',')}]`;
      for (const p of await listAll(twenty, MESSAGE_OBJECTS.participant, f, signal, state)) {
        const mid = text(p.messageId, 64);
        const h = normAddress(p.handle);
        if (!mid || !h || !messages.has(mid)) continue;
        participants.set(mid, [...(participants.get(mid) ?? []), { role: String(p.role ?? '').toUpperCase(), handle: h }]);
      }
    }
    const out: WindowMessage[] = [];
    for (const [id, m] of messages) {
      const ps = participants.get(id) ?? [];
      const from = ps.find((p) => p.role === 'FROM')?.handle;
      if (!from) continue;
      const direction: MessageDirection = isOwnAddress(from, q.ownDomains) ? 'OUTBOUND' : 'INBOUND';
      const counterparts =
        direction === 'OUTBOUND'
          ? [...new Set(ps.filter((p) => p.role !== 'FROM' && !isOwnAddress(p.handle, q.ownDomains)).map((p) => p.handle))]
          : [from];
      out.push({ id, direction, receivedAt: new Date(String(m.receivedAt)).toISOString(), threadId: text(m.messageThreadId, 64), from, counterparts });
    }
    out.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    return { status: 'ok', messages: out, truncated: state.truncated };
  } catch (err) {
    return unreadable(err);
  }
}

/** Which of `addresses` took part (any role, any direction) in a message received before `before`. Read only. */
export async function readAddressesWithMessagesBefore(
  twenty: TwentyClient,
  q: { addresses: readonly string[]; before: Date },
  signal?: AbortSignal,
): Promise<PriorAddressesRead> {
  const addresses = [...new Set(q.addresses.map(normAddress).filter((a): a is string => a !== null))];
  const opts = signal ? { signal } : {};
  try {
    const probe = await twenty.list<Rec>(MESSAGE_OBJECTS.message, { limit: 1, ...opts });
    if (probe.records.length === 0) return { status: 'no_messages' };
    if (addresses.length === 0) return { status: 'ok', addresses: [], truncated: false };
    const state = { truncated: false };
    const of = new Map<string, Set<string>>(); // messageId -> addresses
    for (const chunk of chunks(addresses, HANDLE_CHUNK)) {
      const handles = chunk.map((h) => `handle[ilike]:${filterValue(h)}`);
      const filter = handles.length === 1 ? handles[0]! : `or(${handles.join(',')})`;
      for (const p of await listAll(twenty, MESSAGE_OBJECTS.participant, filter, signal, state)) {
        const mid = text(p.messageId, 64);
        const h = normAddress(p.handle);
        if (!mid || !h || !chunk.includes(h)) continue;
        of.set(mid, new Set([...(of.get(mid) ?? []), h]));
      }
    }
    const found = new Set<string>();
    const before = q.before.getTime();
    for (const chunk of chunks([...of.keys()], IN_CHUNK)) {
      const filter = `id[in]:[${chunk.map(filterValue).join(',')}]`;
      for (const m of await listAll(twenty, MESSAGE_OBJECTS.message, filter, signal, state)) {
        const at = typeof m.receivedAt === 'string' ? Date.parse(m.receivedAt) : Number.NaN;
        if (typeof m.id !== 'string' || Number.isNaN(at) || at >= before) continue;
        for (const a of of.get(m.id) ?? []) found.add(a);
      }
    }
    return { status: 'ok', addresses: [...found].sort(), truncated: state.truncated };
  } catch (err) {
    return unreadable(err);
  }
}
