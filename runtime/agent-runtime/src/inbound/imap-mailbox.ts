/**
 * READ-ONLY access to one IMAP mailbox (IONOS: imap.ionos.es:993, SSL).
 *
 * Hard rule of the Inbound Manager: the runtime only READS mail. This module is the only
 * place that talks IMAP and it exposes exactly four operations:
 *
 * - open the mailbox with EXAMINE (`readOnly: true`): the server rejects any flag change;
 * - SEARCH by UID range or by internal date;
 * - FETCH the source with `BODY.PEEK[]` (imapflow always uses PEEK: reading never sets \Seen),
 *   capped at `maxBytes` per message;
 * - optionally add the `\Seen` flag (and nothing else) to the UIDs the caller processed as
 *   unsubscribe requests. Only this call re-opens the mailbox with SELECT.
 *
 * There is intentionally NO way to delete, expunge, move, copy, append, reply or send:
 * those imapflow methods are never called and SMTP is not used anywhere in the runtime.
 */
import { ImapFlow } from 'imapflow';

export const SEEN_FLAG = '\\Seen';

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
}

export const DEFAULT_IMAP_HOST = 'imap.ionos.es';
export const DEFAULT_IMAP_PORT = 993;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export type ImapConfigResult = { ok: true; config: ImapConfig } | { ok: false; missing: string[] };

/**
 * IMAP settings from the environment: IONOS_IMAP_HOST (default imap.ionos.es),
 * IONOS_IMAP_PORT (default 993, always TLS), IONOS_IMAP_USER, IONOS_IMAP_PASSWORD and
 * IONOS_IMAP_MAILBOX (default INBOX). Without user or password the result lists what is
 * missing (never the values). `IONOS_IMAP_TLS=false` is honoured only for a loopback host
 * (tests against a local fake server).
 */
export function imapConfigFromEnv(env: NodeJS.ProcessEnv = process.env, mailbox?: string): ImapConfigResult {
  const val = (k: string) => {
    const v = env[k]?.trim();
    return v && v.length > 0 ? v : undefined;
  };
  const user = val('IONOS_IMAP_USER');
  const password = env.IONOS_IMAP_PASSWORD && env.IONOS_IMAP_PASSWORD.length > 0 ? env.IONOS_IMAP_PASSWORD : undefined;
  const missing = [...(user ? [] : ['IONOS_IMAP_USER']), ...(password ? [] : ['IONOS_IMAP_PASSWORD'])];
  if (!user || !password) return { ok: false, missing };
  const port = Number(val('IONOS_IMAP_PORT') ?? DEFAULT_IMAP_PORT);
  const host = val('IONOS_IMAP_HOST') ?? DEFAULT_IMAP_HOST;
  // Plain TCP only towards a loopback test server: credentials never travel in clear.
  const plain = val('IONOS_IMAP_TLS') === 'false' && LOOPBACK.has(host.toLowerCase());
  return {
    ok: true,
    config: {
      host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_IMAP_PORT,
      secure: !plain,
      user,
      password,
      mailbox: mailbox ?? val('IONOS_IMAP_MAILBOX') ?? 'INBOX',
    },
  };
}

/** Cursor key of a mailbox: `user@host/MAILBOX` (never the password). */
export function mailboxKey(config: Pick<ImapConfig, 'user' | 'host' | 'mailbox'>): string {
  return `${config.user.toLowerCase()}@${config.host.toLowerCase()}/${config.mailbox}`;
}

export interface RawMessage {
  uid: number;
  /** RFC 822 source, possibly truncated at `maxBytes`. */
  source: Buffer;
  /** Server receive time (INTERNALDATE). */
  internalDate: Date | null;
  truncated: boolean;
}

export type UidQuery = { afterUid: number } | { since: Date };

export interface MailboxSession {
  readonly uidValidity: number;
  readonly exists: number;
  /** UIDs matching the query, ascending; with `afterUid` only UIDs strictly greater. */
  searchUids(query: UidQuery): Promise<number[]>;
  fetch(uids: number[], maxBytes: number): Promise<RawMessage[]>;
  /** Adds `\Seen` (only that flag) to `uids`. */
  markSeen(uids: number[]): Promise<void>;
  close(): Promise<void>;
}

export interface MailboxReader {
  open(): Promise<MailboxSession>;
}

/** Error without credentials: IMAP failures are reported with a code and a safe message. */
export class ImapError extends Error {
  constructor(
    readonly code: 'IMAP_CONNECT_ERROR' | 'IMAP_AUTH_ERROR' | 'IMAP_MAILBOX_ERROR' | 'IMAP_FETCH_ERROR' | 'IMAP_FLAG_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'ImapError';
  }
}

function safeMessage(err: unknown, password: string): string {
  const e = err as { message?: unknown; responseText?: unknown; code?: unknown };
  const parts = [e?.code, e?.responseText ?? e?.message].filter((p) => typeof p === 'string' && p.length > 0) as string[];
  const text = parts.join(': ') || String(err);
  return (password ? text.split(password).join('***') : text).slice(0, 300);
}

class ImapFlowSession implements MailboxSession {
  constructor(
    private readonly client: ImapFlow,
    private readonly config: ImapConfig,
    readonly uidValidity: number,
    readonly exists: number,
  ) {}

  async searchUids(query: UidQuery): Promise<number[]> {
    try {
      const found =
        'afterUid' in query
          ? await this.client.search({ uid: `${query.afterUid + 1}:*` }, { uid: true })
          : await this.client.search({ since: query.since }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      // `N:*` also returns the highest UID when N is above it (RFC 3501): filter strictly.
      const floor = 'afterUid' in query ? query.afterUid : 0;
      return [...new Set(uids)].filter((u) => u > floor).sort((a, b) => a - b);
    } catch (err) {
      throw new ImapError('IMAP_FETCH_ERROR', `IMAP SEARCH failed: ${safeMessage(err, this.config.password)}`);
    }
  }

  async fetch(uids: number[], maxBytes: number): Promise<RawMessage[]> {
    if (uids.length === 0) return [];
    const out: RawMessage[] = [];
    try {
      for await (const msg of this.client.fetch(uids, { uid: true, internalDate: true, size: true, source: { maxLength: maxBytes } }, { uid: true })) {
        const source = msg.source ?? Buffer.alloc(0);
        const internal = msg.internalDate ? new Date(msg.internalDate) : null;
        out.push({
          uid: msg.uid,
          source,
          internalDate: internal && !Number.isNaN(internal.getTime()) ? internal : null,
          truncated: typeof msg.size === 'number' ? msg.size > source.length : source.length >= maxBytes,
        });
      }
    } catch (err) {
      throw new ImapError('IMAP_FETCH_ERROR', `IMAP FETCH failed: ${safeMessage(err, this.config.password)}`);
    }
    return out.sort((a, b) => a.uid - b.uid);
  }

  async markSeen(uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    try {
      // EXAMINE does not allow STORE: re-open with SELECT only for this flag. No CLOSE: SELECT
      // implicitly deselects without expunging (RFC 3501 6.3.1), CLOSE on a read-write
      // mailbox would expunge messages flagged \Deleted by somebody else.
      await this.client.mailboxOpen(this.config.mailbox, { readOnly: false });
      await this.client.messageFlagsAdd(uids, [SEEN_FLAG], { uid: true });
    } catch (err) {
      throw new ImapError('IMAP_FLAG_ERROR', `IMAP STORE +FLAGS (\\Seen) failed: ${safeMessage(err, this.config.password)}`);
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

/** imapflow-backed reader (TLS, no logging of the protocol: it would contain mail content). */
export class ImapFlowMailboxReader implements MailboxReader {
  constructor(
    private readonly config: ImapConfig,
    private readonly opts: { connectionTimeoutMs?: number; socketTimeoutMs?: number } = {},
  ) {}

  async open(): Promise<MailboxSession> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: this.opts.connectionTimeoutMs ?? 20_000,
      greetingTimeout: 15_000,
      socketTimeout: this.opts.socketTimeoutMs ?? 60_000,
      clientInfo: { name: 'pxos-agent-runtime', version: '0.1.0' },
    });
    // imapflow emits 'error' on socket problems; without a listener Node would crash.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      const e = err as { authenticationFailed?: boolean };
      client.close();
      throw new ImapError(e?.authenticationFailed ? 'IMAP_AUTH_ERROR' : 'IMAP_CONNECT_ERROR', `IMAP connect to ${this.config.host}:${this.config.port} failed: ${safeMessage(err, this.config.password)}`);
    }
    try {
      const box = await client.mailboxOpen(this.config.mailbox, { readOnly: true });
      return new ImapFlowSession(client, this.config, Number(box.uidValidity), box.exists);
    } catch (err) {
      await client.logout().catch(() => client.close());
      throw new ImapError('IMAP_MAILBOX_ERROR', `IMAP EXAMINE ${this.config.mailbox} failed: ${safeMessage(err, this.config.password)}`);
    }
  }
}
