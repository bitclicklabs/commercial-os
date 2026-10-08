/**
 * BajasAgent (`configuration.implementation = "inbound_bajas"`): first piece of the Inbound
 * Manager (LLD v0.1 section 10.2). Deterministic, no LLM.
 *
 * 1. Reads the IONOS mailbox over IMAP in READ-ONLY mode (EXAMINE + BODY.PEEK) from the last
 *    processed UID (table `inbound_state`).
 * 2. Classifies each message with fixed rules (`unsubscribe-classifier.ts`): sent to
 *    baja@publiexpe.info, or an unsubscribe keyword/phrase in the subject or in the text the
 *    sender wrote. Everything else is IGNORED (general inbound triage comes later).
 * 3. Appends `email — AAAA-MM-DD — baja solicitada (asunto: "...")` to the Twenty note
 *    "Lista de supresión — NO contactar" for each new address (`get_note` + `update_note`,
 *    append-only, deduped by address and by `@domain`).
 * 4. Advances the cursor only after the note write succeeded, so a failed run is retried
 *    from the same UID by the next one (the dedupe makes it idempotent).
 *
 * It never sends, replies to, forwards, moves or deletes mail. The only change it may make to
 * the mailbox is `\Seen` on messages processed as bajas, and only with `mark_seen: true`.
 * Without IONOS_IMAP_USER / IONOS_IMAP_PASSWORD it ends SKIPPED with the reason.
 */
import type { Db } from '../db/client.js';
import { ImapError, ImapFlowMailboxReader, imapConfigFromEnv, mailboxKey, type ImapConfig, type MailboxReader, type MailboxSession } from '../inbound/imap-mailbox.js';
import { DrizzleInboundStateStore, type InboundStateStore } from '../inbound/inbound-state.js';
import { localDate, sanitizeSubject, SUPPRESSION_NOTE_ID, SUPPRESSION_NOTE_TITLE, suppressionLine } from '../inbound/suppression-list.js';
import { appendSuppressionEntries } from '../inbound/suppression-writer.js';
import { classifyMessage, DEFAULT_CLASSIFIER_CONFIG, parseMessage, type BajaSignal, type ClassifierConfig } from '../inbound/unsubscribe-classifier.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';

export const BAJAS_IMPLEMENTATION = 'inbound_bajas';
export const BAJAS_CONSUMER = 'bajas';
export const BAJAS_TOOLS = ['get_note', 'update_note'] as const;

export interface BajasConfig {
  noteId: string;
  noteTitle: string;
  mailbox: string | undefined;
  initialSince: string;
  maxMessagesPerRun: number;
  maxMessageBytes: number;
  markSeen: boolean;
  timezone: string;
  classifier: ClassifierConfig;
}

const int = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : d);
const strList = (v: unknown, d: string[]) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0) ? (v as string[]).map((x) => x.toLowerCase()) : d;

export function readBajasConfig(configuration: Record<string, unknown>): BajasConfig {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : d);
  const since = str(configuration.initial_since, '2026-10-06');
  return {
    noteId: str(configuration.suppression_note_id, SUPPRESSION_NOTE_ID),
    noteTitle: str(configuration.suppression_note_title, SUPPRESSION_NOTE_TITLE),
    mailbox: typeof configuration.imap_mailbox === 'string' && configuration.imap_mailbox.length > 0 ? configuration.imap_mailbox : undefined,
    initialSince: /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : '2026-10-06',
    maxMessagesPerRun: int(configuration.max_messages_per_run, 200, 1, 2_000),
    maxMessageBytes: int(configuration.max_message_bytes, 256 * 1024, 4 * 1024, 5 * 1024 * 1024),
    markSeen: configuration.mark_seen === true,
    timezone: str(configuration.timezone, 'Europe/Madrid'),
    classifier: {
      unsubscribeAddresses: strList(configuration.unsubscribe_addresses, DEFAULT_CLASSIFIER_CONFIG.unsubscribeAddresses),
      ownDomains: strList(configuration.own_domains, DEFAULT_CLASSIFIER_CONFIG.ownDomains),
    },
  };
}

export interface BajasAgentDeps {
  /** Cursor store; the runtime passes the Drizzle one. */
  store?: InboundStateStore;
  db?: Db;
  /** Overrides the IMAP reader (tests). Receives the resolved config. */
  readerFactory?: (config: ImapConfig) => MailboxReader;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';

interface Counters {
  messages_reviewed: number;
  bajas_detected: number;
  new_entries: number;
  duplicates: number;
  ignored_not_unsubscribe: number;
  ignored_automated: number;
  ignored_own_domain: number;
  ignored_invalid_sender: number;
  parse_errors: number;
  marked_seen: number;
}

const zeroCounters = (): Counters => ({
  messages_reviewed: 0,
  bajas_detected: 0,
  new_entries: 0,
  duplicates: 0,
  ignored_not_unsubscribe: 0,
  ignored_automated: 0,
  ignored_own_domain: 0,
  ignored_invalid_sender: 0,
  parse_errors: 0,
  marked_seen: 0,
});

interface DetectedBaja {
  uid: number;
  email: string;
  subject: string;
  date: string;
  signals: BajaSignal[];
}

export class BajasAgent implements AgentImplementation {
  readonly kind = BAJAS_IMPLEMENTATION;
  private readonly clock: () => Date;

  constructor(private readonly deps: BajasAgentDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('BajasAgent requires a tool executor');
    const startedAt = this.clock();
    const steps: AgentStep[] = [];
    const counters = zeroCounters();
    const cfg = readBajasConfig(ctx.version.configuration);
    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        ...body,
        counters,
        sends_email: false,
        modifies_mailbox: cfg.markSeen ? 'seen_flag_on_bajas_only' : 'no',
        cost: { model: 0, currency: 'EUR', eur: 0, llm_calls: 0 },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - startedAt.getTime() });
      return { output, steps, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, modelCost: 0, toolCost: 0 };
    };

    const imap = imapConfigFromEnv(this.deps.env ?? process.env, cfg.mailbox);
    if (!imap.ok) {
      const reason = `IMAP no configurado: faltan ${imap.missing.join(', ')} (añádelas al .env del runtime). No se ha leído ningún correo.`;
      steps.push({ type: 'THINK', timestamp: new Date(), output: { skip: true, reason, missing: imap.missing }, latencyMs: 0 });
      return finish('SKIPPED', { reason });
    }
    const store = this.deps.store ?? (this.deps.db ? new DrizzleInboundStateStore(this.deps.db) : null);
    if (!store) throw new Error('BajasAgent requires the runtime database (inbound_state)');

    const key = { tenantId: ctx.tenantId, consumer: BAJAS_CONSUMER, mailbox: mailboxKey(imap.config) };
    const reader = this.deps.readerFactory ? this.deps.readerFactory(imap.config) : new ImapFlowMailboxReader(imap.config);
    const cursor = await store.get(key);

    let session: MailboxSession;
    const imapStartedAt = Date.now();
    try {
      session = await reader.open();
    } catch (err) {
      const error = imapErrorPayload(err);
      steps.push({ type: 'TOOL', timestamp: new Date(), tool: 'imap.examine', toolInput: { mailbox: key.mailbox }, toolOutput: { error }, error, latencyMs: Date.now() - imapStartedAt });
      return finish('FAILED', { mailbox: key.mailbox, error });
    }

    try {
      const reset = cursor !== null && cursor.uidValidity !== session.uidValidity;
      const afterUid = cursor && !reset ? cursor.lastUid : 0;
      const query = afterUid > 0 ? { afterUid } : { since: new Date(`${cfg.initialSince}T00:00:00Z`) };
      steps.push({
        type: 'THINK',
        timestamp: new Date(),
        input: { mailbox: key.mailbox, cursor: cursor ? { uid_validity: cursor.uidValidity, last_uid: cursor.lastUid } : null },
        output: {
          plan: 'IMAP read-only (EXAMINE + BODY.PEEK) -> deterministic classification -> append new addresses to the suppression note -> advance cursor',
          uid_validity: session.uidValidity,
          cursor_reset: reset,
          query: 'afterUid' in query ? { after_uid: afterUid } : { since: cfg.initialSince },
          max_messages: cfg.maxMessagesPerRun,
        },
        latencyMs: 0,
      });

      const t0 = Date.now();
      let uids: number[];
      let raws;
      try {
        uids = await session.searchUids(query);
        raws = await session.fetch(uids.slice(0, cfg.maxMessagesPerRun), cfg.maxMessageBytes);
      } catch (err) {
        const error = imapErrorPayload(err);
        steps.push({ type: 'TOOL', timestamp: new Date(), tool: 'imap.fetch', toolInput: { mailbox: key.mailbox }, toolOutput: { error }, error, latencyMs: Date.now() - t0 });
        return finish('FAILED', { mailbox: key.mailbox, error });
      }
      const morePending = uids.length > cfg.maxMessagesPerRun;

      // Classification. The trace keeps only uid + reason for ignored mail (no content).
      const bajas: DetectedBaja[] = [];
      const reviewed: Array<Record<string, unknown>> = [];
      for (const raw of raws) {
        counters.messages_reviewed++;
        try {
          const msg = await parseMessage(raw);
          const c = classifyMessage(msg, cfg.classifier);
          if (c.kind === 'BAJA') {
            counters.bajas_detected++;
            const date = localDate(msg.receivedAt ?? this.clock(), cfg.timezone);
            bajas.push({ uid: raw.uid, email: c.email, subject: msg.subject, date, signals: c.signals });
            reviewed.push({ uid: raw.uid, kind: 'BAJA', email: c.email, signals: c.signals, subject: sanitizeSubject(msg.subject, 120) });
          } else {
            if (c.reason === 'not_unsubscribe') counters.ignored_not_unsubscribe++;
            else if (c.reason === 'automated') counters.ignored_automated++;
            else if (c.reason === 'own_domain') counters.ignored_own_domain++;
            else counters.ignored_invalid_sender++;
            reviewed.push({ uid: raw.uid, kind: 'IGNORED', reason: c.reason, ...(c.detail ? { detail: c.detail } : {}) });
          }
        } catch (err) {
          counters.parse_errors++;
          reviewed.push({ uid: raw.uid, kind: 'PARSE_ERROR', error: err instanceof Error ? err.message.slice(0, 200) : 'parse error' });
        }
      }
      const maxUid = raws.reduce((m, r) => Math.max(m, r.uid), afterUid);
      steps.push({
        type: 'TOOL',
        timestamp: new Date(),
        tool: 'imap.fetch',
        toolInput: { mailbox: key.mailbox, uids_found: uids.length, fetched: raws.length, read_only: true },
        toolOutput: { source_content: 'untrusted', messages: reviewed, more_pending: morePending },
        latencyMs: Date.now() - t0,
      });

      // Suppression list: only when there is something to add.
      let newEntries: string[] = [];
      let duplicates: string[] = [];
      if (bajas.length > 0) {
        const written = await appendSuppressionEntries(
          ctx.tools,
          { noteId: cfg.noteId, noteTitle: cfg.noteTitle },
          bajas.map((b) => ({ email: b.email, line: suppressionLine(b.email, b.date, b.subject) })),
          steps,
        );
        if (!written.ok) {
          return finish('FAILED', { mailbox: key.mailbox, error: written.error, cursor_advanced: false, ...(written.pendingEntries ? { pending_entries: written.pendingEntries } : {}) });
        }
        newEntries = written.newEntries;
        duplicates = written.duplicates;
        counters.new_entries = newEntries.length;
        counters.duplicates = duplicates.length;

        if (cfg.markSeen) {
          try {
            await session.markSeen(bajas.map((b) => b.uid));
            counters.marked_seen = bajas.length;
          } catch (err) {
            steps.push({ type: 'TOOL', timestamp: new Date(), tool: 'imap.mark_seen', toolInput: { uids: bajas.map((b) => b.uid) }, error: imapErrorPayload(err), latencyMs: 0 });
          }
        }
      }

      const summary = { ...counters, at: this.clock().toISOString(), execution_id: ctx.executionId };
      await store.save(key, { uidValidity: session.uidValidity, lastUid: maxUid, summary });
      return finish('SUCCESS', {
        mailbox: key.mailbox,
        cursor: { uid_validity: session.uidValidity, from_uid: afterUid, to_uid: maxUid, reset, more_pending: morePending },
        new_entries: newEntries,
        duplicates,
        note_id: cfg.noteId,
      });
    } finally {
      await session.close();
    }
  }
}

export function imapErrorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof ImapError) return { code: err.code, message: err.message };
  return { code: 'IMAP_ERROR', message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
}
