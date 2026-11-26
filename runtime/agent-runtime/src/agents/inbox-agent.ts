/**
 * InboxAgent (`configuration.implementation = "inbound_inbox"`): general triage of the
 * mailbox (Inbound Manager, LLD v0.1 section 10.2). Supersedes the BajasAgent in the task
 * `process-inbox` (same 2-hour cadence; `process-unsubscribes` is disabled by the seed, so the
 * mailbox is read by ONE task).
 *
 * 1. Reads the mailbox over IMAP in READ-ONLY mode (EXAMINE + BODY.PEEK) from its own cursor
 *    (`inbound_state`, consumer `inbox`). Same reader, same limits as the BajasAgent.
 * 2. Classifies every message once (idempotent by Message-ID, table `inbound_triage`):
 *    - deterministic rules first, no LLM (`triage-rules.ts`): REBOTE, AUTO_REPLY, BAJA
 *      (exactly the BajasAgent classifier), OTRO for own domains / invalid senders / empty text;
 *    - the rest with ONE small LLM call each (`reply-classifier.ts`): INTERESADO, PREGUNTA,
 *      NO_INTERESADO, OTRO, with a confidence; low confidence -> OTRO.
 * 3. Acts, without ever writing to anybody:
 *    - BAJA and explicit NO_INTERESADO -> append-only entry in the suppression note (one
 *      get_note + one update_note per run, deduped), motives "baja solicitada" / "no interesado
 *      (respuesta)";
 *    - INTERESADO / PREGUNTA / NO_INTERESADO -> note "📬 Respuesta recibida — <clase>" on the
 *      company (+ hypothesis) of the send it answers (`email_sends`), or of the company found by
 *      the sender's domain in Twenty;
 *    - hard bounce -> note "⚠️ Rebote: el email no existe" on the company of the send (the
 *      suppression list is NOT touched);
 *    - native CRM records (tanda 19), after the 📬 note, when the reply is linked to a company:
 *      INTERESADO -> Person of the sender (From name + address; none for info@/comercial@...),
 *      the company's OPEN Opportunity (created at the first stage of the pipeline, or reused:
 *      never duplicated) with the note attached, a Task «📬 Responder a <persona/empresa>» (TODO,
 *      due in 2 working days) and the event `opportunity.created` when it is new;
 *      PREGUNTA -> Person (only when the From header carries a name) + the same Task, NO
 *      Opportunity. The 📬 note stays: it is the record with the excerpt, the Task is the action;
 *    - reply DRAFT (tanda 22, `configuration.reply_draft.enabled`): for INTERESADO / PREGUNTA
 *      replies with the native records, ONE LLM call (skill `email-reply-draft`, model of the
 *      drafting role of the model router) writes the answer; the code adds «Re: …», the meeting
 *      paragraph (from a `MeetingAvailability`, src/meetings/types.ts), the farewell and the
 *      signature. It goes into the body of the Task (section «Borrador de respuesta») and,
 *      summarised, into the 📬 note. NEVER sent: the commercial reviews it and sends it himself
 *      (autonomy level 1). A failed draft never blocks: the Task says «borrador no disponible».
 *      With `meeting_intent` (the client accepts / proposes a meeting) the Task is
 *      «📅 Cerrar reunión con <empresa>» and the draft focuses on closing the date;
 *    - AUTO_REPLY, soft bounces, OTRO -> only recorded.
 *    Every triaged message emits `email.reply_received` (with its class) and gets its
 *    `inbound_triage` row, written after the actions.
 * 4. Advances the cursor to the last message fully processed. A Twenty failure stops the run
 *    there (the next run retries from it; notes, entries and events are idempotent); the LLM
 *    and note budgets per run stop it the same way, without an error.
 *
 * Email content is UNTRUSTED: the rules only match fixed patterns, the LLM sees it inside the
 * untrusted-data block and can only pick a label. It never sends, replies to, forwards, moves
 * or deletes mail; the only possible mailbox change is `\Seen` on bajas with `mark_seen: true`.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { NOOP_EVENT_PUBLISHER, type EventPublisher } from '../events/event-bus.js';
import { ImapFlowMailboxReader, imapConfigFromEnv, mailboxKey, type MailboxSession, type RawMessage } from '../inbound/imap-mailbox.js';
import { DrizzleInboundStateStore } from '../inbound/inbound-state.js';
import { DEFAULT_REPLY_THRESHOLDS, MEETING_INTENT_SIGNAL, REPLY_CLASSIFICATION_JSON_SCHEMA, REPLY_CLASSIFIER_SYSTEM_PROMPT, buildReplyPrompt, decideReplyClass, parseReplyClassification, LLM_TEXT_MAX_DEFAULT, type ReplyThresholds } from '../inbound/reply-classifier.js';
import { DrizzleSendLookup, FREEMAIL_DOMAINS, type SendLookup, type SendMatch } from '../inbound/reply-links.js';
import { localDate, noInterestLine, sanitizeSubject, suppressionLine } from '../inbound/suppression-list.js';
import { appendSuppressionEntries, toolError } from '../inbound/suppression-writer.js';
import { bounceNoteBody, bounceNoteTitle, NOTE_CLASSES, replyNoteBody, replyNoteTitle, sanitizeExcerpt } from '../inbound/triage-notes.js';
import { cleanPersonName, personDisplayName, type PersonSummary } from '../crm/people.js';
import { opportunityCreatedEvent } from '../crm/opportunities.js';
import { addBusinessDays, REPLY_TASK_BUSINESS_DAYS, replyTaskBody } from '../crm/reply-task.js';
import { NULL_AVAILABILITY, type MeetingAvailability, type MeetingProposal } from '../meetings/types.js';
import { meetingParagraph, MEETING_SLOTS_IN_DRAFT } from '../inbound/meeting-paragraph.js';
import { defaultModelRouter, isModelRole, type ModelRole, type ModelRouter } from '../providers/model-router.js';
import { useKnowledge } from '../knowledge/resolver.js';
import { useSkill } from '../skills/resolver.js';
import type { GetHypothesisOutput } from '../tools/twenty/hypothesis-tools.js';
import { DEFAULT_REPLY_SENDER, finalizeReplyDraft, parseReplyDraft, replyDraftNoteSection, replyDraftSection, replyDraftSectionTitle, type ReplyDraftOutcome, type ReplySender } from './reply-draft.js';
import { buildReplyDraftPrompt, REPLY_DRAFT_JSON_SCHEMA, REPLY_DRAFT_SKILL_ID, REPLY_DRAFT_SYSTEM_PROMPT, REPLY_TEXT_MAX } from './reply-draft-prompt.js';
import { classifyByRules, extractTriageFeatures, type BounceInfo, type TriageClass, type TriageFeatures } from '../inbound/triage-rules.js';
import { DrizzleInboundTriageStore, messageKeyOf, type InboundTriageStore } from '../inbound/triage-store.js';
import { emailDomain, isDomainOrSubdomain, parseRawMessage, type ParsedInboundMessage } from '../inbound/unsubscribe-classifier.js';
import type { AgentContext, AgentImplementation, AgentResult, AgentStep } from './agent.js';
import { imapErrorPayload, readBajasConfig, type BajasAgentDeps, type BajasConfig } from './bajas-agent.js';
import { recordAudit } from '../audit/service.js';
import { ProspectorRun, readConfig, round6 } from './prospector-core.js';

export const INBOX_IMPLEMENTATION = 'inbound_inbox';
export const INBOX_CONSUMER = 'inbox';
/** Native Person / Opportunity / Task of a reply (tanda 19), plus `get_company` to name the task. */
export const INBOX_CRM_TOOLS = ['upsert_person', 'upsert_opportunity', 'create_reply_task', 'get_company'] as const;
/** Tanda 22: READ of the hypothesis of the send (need, why now, first email) for the reply draft. */
export const INBOX_DRAFT_TOOLS = ['get_hypothesis'] as const;
export const INBOX_TOOLS = ['get_note', 'update_note', 'create_note', 'find_company', ...INBOX_CRM_TOOLS, ...INBOX_DRAFT_TOOLS] as const;
export const REPLY_RECEIVED_EVENT = 'email.reply_received';

export interface InboxTriageConfig extends ReplyThresholds {
  maxLlmCallsPerRun: number;
  maxNotesPerRun: number;
  llmTextMax: number;
  maxOutputTokens: number;
  lookupCompanyByDomain: boolean;
  emitEvents: boolean;
}

/** `configuration.reply_draft` (tanda 22). Absent (older versions): disabled. */
export interface ReplyDraftConfig {
  enabled: boolean;
  /** Model router role of the drafting call (default `executor_cheap`, the EmailDrafter's). */
  modelRole: ModelRole;
  /** Model pinned for the role (optional; MODEL_ROUTE_<ROL> still wins). Default: the role's. */
  model: string | null;
  maxPerRun: number;
  maxAttempts: number;
  maxOutputTokens: number;
  textMax: number;
  slots: number;
  sender: ReplySender;
}

export interface InboxConfig extends BajasConfig {
  triage: InboxTriageConfig;
  replyDraft: ReplyDraftConfig;
}

const num01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : d);
const int = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : d);

export function readReplyDraftConfig(configuration: Record<string, unknown>): ReplyDraftConfig {
  const r = (configuration.reply_draft ?? {}) as Record<string, unknown>;
  const s = (r.sender ?? {}) as Record<string, unknown>;
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : d);
  const role = r.model_role;
  return {
    enabled: r.enabled === true,
    modelRole: isModelRole(role) && role !== 'judge' ? role : 'executor_cheap',
    model: typeof r.model === 'string' && r.model.trim().length > 0 ? r.model.trim() : null,
    maxPerRun: int(r.max_per_run, 40, 0, 200),
    maxAttempts: int(r.max_attempts, 2, 1, 3),
    maxOutputTokens: int(r.max_output_tokens, 2_048, 256, 8_192),
    textMax: int(r.text_max, REPLY_TEXT_MAX, 200, 6_000),
    slots: int(r.slots, MEETING_SLOTS_IN_DRAFT, 1, MEETING_SLOTS_IN_DRAFT),
    sender: {
      name: str(s.name, DEFAULT_REPLY_SENDER.name),
      company: str(s.company, DEFAULT_REPLY_SENDER.company),
      descriptor: str(s.descriptor, DEFAULT_REPLY_SENDER.descriptor),
      web: s.web === null ? null : str(s.web, DEFAULT_REPLY_SENDER.web ?? ''),
    },
  };
}

export function readInboxConfig(configuration: Record<string, unknown>): InboxConfig {
  const t = (configuration.triage ?? {}) as Record<string, unknown>;
  const minConfidence = num01(t.min_confidence, DEFAULT_REPLY_THRESHOLDS.minConfidence);
  return {
    ...readBajasConfig(configuration),
    triage: {
      minConfidence,
      // Never below the general bar: NO_INTERESADO is the class that suppresses.
      noInterestMinConfidence: Math.max(minConfidence, num01(t.no_interest_min_confidence, DEFAULT_REPLY_THRESHOLDS.noInterestMinConfidence)),
      maxLlmCallsPerRun: int(t.max_llm_calls_per_run, 40, 0, 200),
      maxNotesPerRun: int(t.max_notes_per_run, 40, 0, 200),
      llmTextMax: int(t.llm_text_max, LLM_TEXT_MAX_DEFAULT, 200, 4_000),
      maxOutputTokens: int(t.max_output_tokens, 1_024, 64, 4_096),
      lookupCompanyByDomain: t.lookup_company_by_domain !== false,
      emitEvents: t.emit_events !== false,
    },
    replyDraft: readReplyDraftConfig(configuration),
  };
}

export interface InboxAgentDeps extends BajasAgentDeps {
  triageStore?: InboundTriageStore;
  sends?: SendLookup;
  events?: EventPublisher;
  /** Tanda 22: free slots / booking link for the meeting paragraph of the reply drafts. */
  availability?: MeetingAvailability;
  /** Tanda 22: resolves the model of the drafting role (default: router over process.env). */
  router?: ModelRouter;
}

type Outcome = 'SUCCESS' | 'SKIPPED' | 'FAILED';

const CLASS_COUNTER: Record<TriageClass, keyof Counters> = {
  BAJA: 'bajas_detected',
  NO_INTERESADO: 'no_interesados',
  INTERESADO: 'interesados',
  PREGUNTA: 'preguntas',
  AUTO_REPLY: 'auto_replies',
  REBOTE: 'rebotes',
  OTRO: 'otros',
};

function zeroCounters() {
  return {
    messages_reviewed: 0,
    already_triaged: 0,
    bajas_detected: 0,
    no_interesados: 0,
    interesados: 0,
    preguntas: 0,
    auto_replies: 0,
    rebotes: 0,
    rebotes_duros: 0,
    otros: 0,
    llm_calls: 0,
    llm_errors: 0,
    lowered_to_otro: 0,
    new_entries: 0,
    duplicates: 0,
    notes_created: 0,
    unmatched: 0,
    events_emitted: 0,
    parse_errors: 0,
    marked_seen: 0,
    audit_errors: 0,
    people_created: 0,
    people_existing: 0,
    opportunities_created: 0,
    opportunities_reused: 0,
    reply_tasks: 0,
    reply_drafts_created: 0,
    reply_drafts_failed: 0,
    meeting_tasks: 0,
  };
}

type Counters = ReturnType<typeof zeroCounters>;

interface Item {
  raw: RawMessage;
  key: string;
  msg: ParsedInboundMessage | null;
  features: TriageFeatures | null;
}

interface Decision {
  item: Item;
  class: TriageClass;
  method: 'RULES' | 'LLM';
  confidence: number | null;
  signals: string[];
  email: string | null;
  bounce?: BounceInfo;
  costEur: number;
}

/** Local `AAAA-MM-DD HH:mm`. */
export function localMinute(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

class StopRun extends Error {
  constructor(
    readonly kind: 'error' | 'notes_budget',
    readonly payload: Record<string, unknown> = {},
  ) {
    super(kind);
  }
}

export class InboxAgent implements AgentImplementation {
  readonly kind = INBOX_IMPLEMENTATION;
  private readonly clock: () => Date;

  constructor(private readonly deps: InboxAgentDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    ctx.signal.throwIfAborted();
    if (!ctx.tools) throw new Error('InboxAgent requires a tool executor');
    const tools = ctx.tools;
    const startedAt = this.clock();
    const steps: AgentStep[] = [];
    const counters = zeroCounters();
    const cfg = readInboxConfig(ctx.version.configuration);
    const llm = new ProspectorRun(ctx, tools, readConfig(ctx.version.configuration), this.clock);
    const finish = (outcome: Outcome, body: Record<string, unknown>): AgentResult => {
      counters.llm_calls = llm.llmCalls + counters.llm_errors;
      const modelCost = round6(llm.modelCost);
      const output: Record<string, unknown> = {
        status: outcome === 'FAILED' ? 'error' : 'ok',
        outcome,
        agent: ctx.agent.name,
        agent_version: ctx.version.version,
        ...body,
        counters,
        sends_email: false,
        modifies_mailbox: cfg.markSeen ? 'seen_flag_on_bajas_only' : 'no',
        cost: { model: modelCost, currency: llm.currency, eur: llm.costEur(), llm_calls: llm.llmCalls },
      };
      steps.push({ type: 'FINAL', timestamp: new Date(), output, latencyMs: this.clock().getTime() - startedAt.getTime() });
      return { output, steps, usage: llm.usage, modelCost, toolCost: 0 };
    };

    const imap = imapConfigFromEnv(this.deps.env ?? process.env, cfg.mailbox);
    if (!imap.ok) {
      const reason = `IMAP no configurado: faltan ${imap.missing.join(', ')} (añádelas al .env del runtime). No se ha leído ningún correo.`;
      steps.push({ type: 'THINK', timestamp: new Date(), output: { skip: true, reason, missing: imap.missing }, latencyMs: 0 });
      return finish('SKIPPED', { reason });
    }
    const db: Db | undefined = this.deps.db;
    const store = this.deps.store ?? (db ? new DrizzleInboundStateStore(db) : null);
    const triageStore = this.deps.triageStore ?? (db ? new DrizzleInboundTriageStore(db) : null);
    const sends = this.deps.sends ?? (db ? new DrizzleSendLookup(db) : null);
    if (!store || !triageStore || !sends) throw new Error('InboxAgent requires the runtime database (inbound_state, inbound_triage, email_sends)');
    const events = this.deps.events ?? NOOP_EVENT_PUBLISHER;

    const key = { tenantId: ctx.tenantId, consumer: INBOX_CONSUMER, mailbox: mailboxKey(imap.config) };
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
          plan: 'IMAP read-only (EXAMINE + BODY.PEEK) -> rules (bounce, auto-reply, baja) -> LLM for the rest -> suppression entries, notes for the commercial, events -> inbound_triage -> advance cursor',
          uid_validity: session.uidValidity,
          cursor_reset: reset,
          query: 'afterUid' in query ? { after_uid: afterUid } : { since: cfg.initialSince },
          max_messages: cfg.maxMessagesPerRun,
          max_llm_calls: cfg.triage.maxLlmCallsPerRun,
        },
        latencyMs: 0,
      });

      const t0 = Date.now();
      let uids: number[];
      let raws: RawMessage[];
      try {
        uids = await session.searchUids(query);
        raws = await session.fetch(uids.slice(0, cfg.maxMessagesPerRun), cfg.maxMessageBytes);
      } catch (err) {
        const error = imapErrorPayload(err);
        steps.push({ type: 'TOOL', timestamp: new Date(), tool: 'imap.fetch', toolInput: { mailbox: key.mailbox }, toolOutput: { error }, error, latencyMs: Date.now() - t0 });
        return finish('FAILED', { mailbox: key.mailbox, error });
      }
      steps.push({
        type: 'TOOL',
        timestamp: new Date(),
        tool: 'imap.fetch',
        toolInput: { mailbox: key.mailbox, uids_found: uids.length, fetched: raws.length, read_only: true },
        toolOutput: { source_content: 'untrusted', uids: raws.map((r) => r.uid), more_pending: uids.length > cfg.maxMessagesPerRun },
        latencyMs: Date.now() - t0,
      });

      // ---- Phase 1: parse + classify (rules first, LLM for the rest, bounded) ----
      const items: Item[] = [];
      for (const raw of raws) {
        try {
          const { message, parsed } = await parseRawMessage(raw);
          items.push({ raw, key: messageKeyOf(message.messageId, raw.source), msg: message, features: extractTriageFeatures(parsed) });
        } catch {
          items.push({ raw, key: messageKeyOf(null, raw.source), msg: null, features: null });
        }
      }
      const existing = await triageStore.existingKeys(ctx.tenantId, items.map((i) => i.key));
      const plan: Array<Decision | { item: Item; skip: true }> = [];
      const keysNow = new Set<string>();
      let stopReason: 'llm_budget' | 'notes_budget' | null = null;
      for (const item of items) {
        if (existing.has(item.key) || keysNow.has(item.key)) {
          plan.push({ item, skip: true });
          continue;
        }
        if (!item.msg || !item.features) {
          keysNow.add(item.key);
          plan.push({ item, class: 'OTRO', method: 'RULES', confidence: null, signals: ['parse_error'], email: null, costEur: 0 });
          continue;
        }
        const msg = item.msg;
        const rule = classifyByRules(msg, item.features, cfg.classifier);
        if (rule.decided) {
          keysNow.add(item.key);
          plan.push({
            item,
            class: rule.class,
            method: 'RULES',
            confidence: null,
            signals: rule.signals,
            email: rule.email ?? msg.fromEmail,
            ...(rule.bounce ? { bounce: rule.bounce } : {}),
            costEur: 0,
          });
          continue;
        }
        if (counters.llm_errors + llm.llmCalls >= cfg.triage.maxLlmCallsPerRun) {
          stopReason = 'llm_budget';
          break;
        }
        keysNow.add(item.key);
        const eurBefore = llm.costEur();
        const call = await llm.completeJson({
          label: { step: 'inbound_triage', uid: item.raw.uid },
          system: REPLY_CLASSIFIER_SYSTEM_PROMPT,
          messages: buildReplyPrompt({ subject: msg.subject, authoredText: msg.authoredText }, { textMax: cfg.triage.llmTextMax }),
          parse: parseReplyClassification,
          schema: REPLY_CLASSIFICATION_JSON_SCHEMA,
          maxAttempts: 1,
          maxTokens: cfg.triage.maxOutputTokens,
        });
        steps.push(...llm.steps.splice(0));
        if (call.status === 'model_error') counters.llm_errors++;
        const d = decideReplyClass(call.status === 'ok' ? call.value : null, cfg.triage);
        const signals = [...rule.signals, ...(call.status === 'model_error' ? ['llm_error'] : d.signals)];
        if (call.status === 'ok' && d.class !== call.value.clase) counters.lowered_to_otro++;
        plan.push({ item, class: d.class, method: 'LLM', confidence: d.confidence, signals, email: msg.fromEmail, costEur: round6(llm.costEur() - eurBefore) });
      }
      const decisions = plan.filter((p): p is Decision => !('skip' in p));
      steps.push({
        type: 'THINK',
        timestamp: new Date(),
        output: {
          triage: plan.map((p) =>
            'skip' in p
              ? { uid: p.item.raw.uid, skip: 'already_triaged' }
              : { uid: p.item.raw.uid, class: p.class, method: p.method, confidence: p.confidence, signals: p.signals, from_domain: p.email ? emailDomain(p.email) : null },
          ),
          stopped: stopReason,
        },
        latencyMs: 0,
      });

      // ---- Phase 2: suppression list (BAJA + explicit NO_INTERESADO), one write ----
      const suppress = decisions.filter((d) => (d.class === 'BAJA' || d.class === 'NO_INTERESADO') && d.email);
      const written = await appendSuppressionEntries(
        tools,
        { noteId: cfg.noteId, noteTitle: cfg.noteTitle },
        suppress.map((d) => {
          const date = localDate(d.item.msg?.receivedAt ?? this.clock(), cfg.timezone);
          const subject = d.item.msg?.subject ?? '';
          return { email: d.email!, line: d.class === 'BAJA' ? suppressionLine(d.email!, date, subject) : noInterestLine(d.email!, date, subject) };
        }),
        steps,
      );
      if (!written.ok) {
        return finish('FAILED', { mailbox: key.mailbox, error: written.error, cursor_advanced: false, ...(written.pendingEntries ? { pending_entries: written.pendingEntries } : {}) });
      }
      counters.new_entries = written.newEntries.length;
      counters.duplicates = written.duplicates.length;
      // The suppression list is written by the agent, not through the API, so the audit hook
      // never sees it: record `suppression.add` here. An audit failure never fails the run.
      if (db) {
        for (const email of written.newEntries) {
          const d = suppress.find((s) => s.email === email);
          try {
            await recordAudit(db, {
              tenantId: ctx.tenantId,
              actor: 'agent',
              actorLabel: ctx.agent.name,
              action: 'suppression.add',
              subjectType: 'suppression',
              subjectId: email,
              method: 'AGENT',
              route: 'agent:inbox',
              result: 'ok',
              statusCode: 200,
              payload: { class: d?.class ?? null, note_id: cfg.noteId },
            });
          } catch {
            counters.audit_errors += 1;
          }
        }
      }
      const unattributed = new Set(written.newEntries);
      // Native CRM follow-up (tanda 19) only with the tools the policy allows (older seeded versions: none).
      const allowed = new Set(tools.specs().map((t) => t.name));
      const crmTools = INBOX_CRM_TOOLS.every((t) => allowed.has(t));

      // ---- Phase 3: per message, in UID order: link, note, event, inbound_triage row ----
      let lastDoneUid = afterUid;
      const triaged: Array<Record<string, unknown>> = [];
      const bajaUids: number[] = [];
      let failure: Record<string, unknown> | null = null;
      for (const p of plan) {
        if ('skip' in p) {
          counters.messages_reviewed++;
          counters.already_triaged++;
          lastDoneUid = Math.max(lastDoneUid, p.item.raw.uid);
          continue;
        }
        try {
          const suppressionAdded = p.email !== null && (p.class === 'BAJA' || p.class === 'NO_INTERESADO') && unattributed.delete(p.email);
          const { row: done, crm, draft } = await this.act(ctx, cfg, p, { sends, events, suppressionAdded, steps, counters, mailbox: key.mailbox, uidValidity: session.uidValidity, crmTools, allowed, llm });
          await triageStore.insert(done);
          counters.messages_reviewed++;
          counters[CLASS_COUNTER[p.class]]++;
          if (p.signals.includes('parse_error')) counters.parse_errors++;
          if (p.class === 'REBOTE' && p.bounce?.hard) counters.rebotes_duros++;
          if (p.class === 'BAJA') bajaUids.push(p.item.raw.uid);
          triaged.push({
            uid: p.item.raw.uid,
            class: p.class,
            method: p.method,
            confidence: p.confidence,
            from_domain: done.fromDomain,
            company_id: done.companyId,
            hypothesis_id: done.hypothesisId,
            match_by: done.matchBy,
            note_id: done.noteId,
            ...(crm ? { person_id: crm.personId, opportunity_id: crm.opportunityId, opportunity_created: crm.opportunityCreated, task_id: crm.taskId, task_kind: crm.taskKind } : {}),
            ...(draft ? { reply_draft: draft } : {}),
          });
          lastDoneUid = Math.max(lastDoneUid, p.item.raw.uid);
        } catch (err) {
          if (!(err instanceof StopRun)) throw err;
          if (err.kind === 'notes_budget') stopReason = 'notes_budget';
          else failure = err.payload;
          break;
        }
      }

      if (cfg.markSeen && bajaUids.length > 0) {
        try {
          await session.markSeen(bajaUids);
          counters.marked_seen = bajaUids.length;
        } catch (err) {
          steps.push({ type: 'TOOL', timestamp: new Date(), tool: 'imap.mark_seen', toolInput: { uids: bajaUids }, error: imapErrorPayload(err), latencyMs: 0 });
        }
      }

      const morePending = uids.length > cfg.maxMessagesPerRun || stopReason !== null || failure !== null;
      const summary = { ...counters, at: this.clock().toISOString(), execution_id: ctx.executionId, ...(stopReason ? { stopped: stopReason } : {}) };
      // Monotonic under the same UIDVALIDITY: saving the unchanged UID only refreshes last_run_at.
      await store.save(key, { uidValidity: session.uidValidity, lastUid: lastDoneUid, summary });
      const body = {
        mailbox: key.mailbox,
        cursor: { uid_validity: session.uidValidity, from_uid: afterUid, to_uid: lastDoneUid, reset, more_pending: morePending },
        ...(stopReason ? { stopped: stopReason } : {}),
        triaged,
        new_entries: written.newEntries,
        duplicates: written.duplicates,
        note_id: cfg.noteId,
      };
      return failure ? finish('FAILED', { ...body, error: failure }) : finish('SUCCESS', body);
    } finally {
      await session.close();
    }
  }

  /** Link, note (when the class needs one) and event of one message; returns its triage row. */
  private async act(
    ctx: AgentContext,
    cfg: InboxConfig,
    d: Decision,
    o: {
      sends: SendLookup;
      events: EventPublisher;
      suppressionAdded: boolean;
      steps: AgentStep[];
      counters: Counters;
      mailbox: string;
      uidValidity: number;
      crmTools: boolean;
      allowed: ReadonlySet<string>;
      llm: ProspectorRun;
    },
  ) {
    const tools = ctx.tools!;
    const msg = d.item.msg;
    const receivedAt = msg?.receivedAt ?? null;
    const when = receivedAt ?? this.clock();
    const receivedLocal = localMinute(when, cfg.timezone);
    const fromEmail = msg?.fromEmail ?? null;
    const isBounce = d.class === 'REBOTE';
    // The address the message is about: the sender, or the failed recipient of a bounce.
    const subjectAddress = isBounce ? (d.bounce?.recipients[0] ?? null) : d.class === 'OTRO' && d.signals.includes('own_domain') ? null : fromEmail;
    const needsNote = NOTE_CLASSES.has(d.class) || (isBounce && d.bounce?.hard === true && subjectAddress !== null);

    let match: SendMatch | null = subjectAddress ? await o.sends.find(ctx.tenantId, subjectAddress, receivedAt) : null;
    if (match && isBounce && match.by !== 'email') match = null; // a bounce is about one exact address
    let companyId = match?.companyId ?? null;
    const hypothesisId = match?.hypothesisId ?? null;
    let matchBy: string | null = match?.by ?? null;
    let noteId: string | null = null;
    let crm: CrmFollowUp | null = null;
    let prepared: PreparedDraft | null = null;
    const signals = [...d.signals];

    if (needsNote) {
      if (o.counters.notes_created >= cfg.triage.maxNotesPerRun) throw new StopRun('notes_budget');
      const domain = subjectAddress ? emailDomain(subjectAddress) : null;
      const ownDomain = domain !== null && cfg.classifier.ownDomains.some((x) => isDomainOrSubdomain(domain, x));
      if (!companyId && !isBounce && cfg.triage.lookupCompanyByDomain && domain && !FREEMAIL_DOMAINS.has(domain) && !ownDomain) {
        const found = await tools.call('find_company', { domain });
        o.steps.push(found.step);
        if (found.result.status !== 'ok') throw new StopRun('error', toolError('find_company', found.result as { status: string } & Record<string, unknown>));
        const companies = (found.result.output as { companies: Array<{ id: string }> }).companies;
        if (companies.length === 1) {
          companyId = companies[0]!.id;
          matchBy = 'company_domain';
        } else if (companies.length > 1) signals.push('ambiguous_company_domain');
      }
      if (companyId) {
        const sentLocal = match ? localMinute(match.sentAt, cfg.timezone) : null;
        const followUp = o.crmTools && (d.class === 'INTERESADO' || d.class === 'PREGUNTA') && fromEmail !== null;
        // Tanda 22: the reply draft BEFORE the note, so the note carries it too. Never blocking.
        if (followUp && cfg.replyDraft.enabled) {
          prepared = await this.prepareReplyDraft(ctx, cfg, d, o, { companyId, hypothesisId, fromEmail: fromEmail!, sendSubject: match?.subject ?? null });
          signals.push(...prepared.signals);
        }
        const note = isBounce
          ? {
              title: bounceNoteTitle(receivedLocal),
              bodyMarkdown: bounceNoteBody({
                recipient: subjectAddress!,
                status: d.bounce?.status ?? null,
                receivedLocal,
                timezone: cfg.timezone,
                originalSubject: d.bounce?.originalSubject ?? null,
                send: match ? { sentLocal: sentLocal!, subject: match.subject } : null,
              }),
            }
          : {
              title: replyNoteTitle(d.class, receivedLocal),
              bodyMarkdown: replyNoteBody({
                class: d.class,
                method: d.method,
                confidence: d.confidence,
                fromEmail: fromEmail!,
                subject: msg?.subject ?? '',
                authoredText: msg?.authoredText ?? '',
                receivedLocal,
                timezone: cfg.timezone,
                send: match ? { sentLocal: sentLocal!, subject: match.subject, by: match.by } : null,
                companyByDomain: matchBy === 'company_domain',
                suppressionAdded: o.suppressionAdded,
              }),
            };
        if (prepared) note.bodyMarkdown = `${note.bodyMarkdown.replace(/s+$/, '')}

${replyDraftNoteSection(prepared.outcome)}
`;
        const created = await tools.call('create_note', { companyId, ...(hypothesisId ? { hypothesisId } : {}), ...note });
        o.steps.push(created.step);
        if (created.result.status !== 'ok') throw new StopRun('error', toolError('create_note', created.result as { status: string } & Record<string, unknown>));
        noteId = (created.result.output as { record: { id: string } }).record.id;
        o.counters.notes_created++;
        if (followUp) {
          crm = await this.crmFollowUp(ctx, cfg, d, o, {
            companyId,
            hypothesisId,
            noteId,
            fromEmail: fromEmail!,
            when,
            receivedLocal,
            sendSubject: match?.subject ?? null,
            companyName: prepared?.companyName ?? null,
            draft: prepared?.outcome ?? null,
          });
          signals.push(...crm.signals);
        }
      } else {
        signals.push('no_company_match');
        o.counters.unmatched++;
      }
    }

    const fromDomain = fromEmail ? emailDomain(fromEmail) : null;
    let eventId: string | null = null;
    if (cfg.triage.emitEvents) {
      const published = await o.events.emit({
        tenantId: ctx.tenantId,
        type: REPLY_RECEIVED_EVENT,
        correlationId: hypothesisId ?? companyId ?? ctx.executionId,
        occurredAt: when,
        idempotencyKey: `evt:${REPLY_RECEIVED_EVENT}:${createHash('sha256').update(d.item.key).digest('hex').slice(0, 40)}`,
        data: {
          class: d.class,
          confidence: d.confidence,
          method: d.method,
          signals,
          // Domains only, never addresses (same rule as the other email.* events).
          fromDomain,
          ...(isBounce ? { bouncedDomain: subjectAddress ? emailDomain(subjectAddress) : null, hardBounce: d.bounce?.hard ?? false } : {}),
          companyId,
          hypothesisId,
          sendId: match?.sendId ?? null,
          matchBy,
          noteId,
          ...(crm ? { personId: crm.personId, opportunityId: crm.opportunityId, taskId: crm.taskId } : {}),
          suppressionAdded: o.suppressionAdded,
          receivedAt: when.toISOString(),
        },
      });
      if (published) {
        eventId = published.event.id;
        o.counters.events_emitted++;
      }
    }

    const row = {
      tenantId: ctx.tenantId,
      messageKey: d.item.key,
      messageId: msg?.messageId ?? null,
      mailbox: o.mailbox,
      uidValidity: o.uidValidity,
      uid: d.item.raw.uid,
      receivedAt,
      fromEmail,
      fromDomain,
      subject: msg ? sanitizeSubject(msg.subject, 120) || null : null,
      class: d.class,
      confidence: d.confidence,
      method: d.method,
      signals,
      companyId,
      hypothesisId,
      sendId: match?.sendId ?? null,
      matchBy,
      noteId,
      suppressionAdded: o.suppressionAdded,
      eventId,
      executionId: ctx.executionId,
      costEur: round6(d.costEur + (prepared?.costEur ?? 0)),
    };
    const draft = prepared
      ? {
          status: prepared.outcome.status,
          ...(prepared.outcome.status === 'failed' ? { reason: prepared.outcome.reason } : { subject: prepared.outcome.draft.subject, meeting_source: prepared.outcome.draft.meeting.source, fixes: prepared.outcome.draft.fixes, warnings: prepared.outcome.draft.warnings }),
          meeting_intent: prepared.outcome.meetingIntent,
          model: prepared.model,
          cost_eur: prepared.costEur,
        }
      : null;
    return { row, crm, draft };
  }

  /**
   * Native CRM records of an INTERESADO / PREGUNTA reply already linked to a company (tanda 19):
   * Person of the sender, the company's open Opportunity (INTERESADO only, confidence at or above
   * the triage threshold), the Task «📬 Responder a …», and `opportunity.created` when new. Every
   * write is idempotent, so a retried run (Twenty failure -> StopRun) never duplicates anything.
   */
  private async crmFollowUp(
    ctx: AgentContext,
    cfg: InboxConfig,
    d: Decision,
    o: { events: EventPublisher; steps: AgentStep[]; counters: Counters },
    r: {
      companyId: string;
      hypothesisId: string | null;
      noteId: string;
      fromEmail: string;
      when: Date;
      receivedLocal: string;
      sendSubject: string | null;
      /** Already read by the draft step (tanda 22); null = read it here when needed. */
      companyName: string | null;
      /** Tanda 22: the reply draft (or why it is not available); null = drafts disabled. */
      draft: ReplyDraftOutcome | null;
    },
  ): Promise<CrmFollowUp> {
    const tools = ctx.tools!;
    const msg = d.item.msg;
    const meetingIntent = d.signals.includes(MEETING_INTENT_SIGNAL);
    const out: CrmFollowUp = { personId: null, personName: null, opportunityId: null, opportunityCreated: false, taskId: null, taskKind: meetingIntent ? 'meeting' : 'reply', signals: [] };
    const call = async (tool: string, input: Record<string, unknown>) => {
      const res = await tools.call(tool, input);
      o.steps.push(res.step);
      if (res.result.status !== 'ok') throw new StopRun('error', toolError(tool, res.result as { status: string } & Record<string, unknown>));
      return res.result.output as Record<string, unknown>;
    };

    // 1. Person of the sender. PREGUNTA only when the From header carries a person name.
    const fromName = cleanPersonName(msg?.fromName ?? null);
    if (d.class === 'INTERESADO' || fromName) {
      const p = (await call('upsert_person', { email: r.fromEmail, fullName: fromName, companyId: r.companyId })) as { outcome: string; reason: string | null; person: PersonSummary | null };
      if (p.person) {
        out.personId = p.person.id;
        out.personName = personDisplayName(p.person);
        if (p.outcome === 'created') o.counters.people_created++;
        else o.counters.people_existing++;
      } else out.signals.push(`sender_not_a_person:${p.reason ?? 'unknown'}`);
    }

    // 2. Opportunity: only an INTERESADO at or above the threshold (rules never decide it).
    const interested = d.class === 'INTERESADO' && d.confidence !== null && d.confidence >= cfg.triage.minConfidence;
    if (interested) {
      const up = (await call('upsert_opportunity', { companyId: r.companyId, hypothesisId: r.hypothesisId, pointOfContactId: out.personId, noteId: r.noteId, origin: 'reply' })) as {
        created: boolean;
        opportunity: OpportunityOut;
      };
      const opportunity = up.opportunity;
      out.opportunityId = up.opportunity.id;
      out.opportunityCreated = up.created;
      out.signals.push(up.created ? 'opportunity_created' : 'opportunity_reused');
      if (up.created) o.counters.opportunities_created++;
      else o.counters.opportunities_reused++;
      // opportunity.created (n8n) right after the creation, before anything else can fail: a
      // retried run reuses the opportunity (created = false) and would never emit it again.
      if (up.created && cfg.triage.emitEvents) {
        await o.events.emit(opportunityCreatedEvent({ tenantId: ctx.tenantId, opportunity, origin: 'reply', hypothesisId: r.hypothesisId, personId: out.personId, occurredAt: r.when }));
      }
    }

    // 3. Task «📬 Responder a <persona/empresa>» (or, tanda 22, «📅 Cerrar reunión con <empresa>»
    //    when the client accepts or proposes a meeting), due in 2 working days, with the draft.
    let companyName = r.companyName;
    const company = async (): Promise<string> => {
      if (companyName === null) {
        const c = (await call('get_company', { companyId: r.companyId })) as { company: { name: string } | null };
        companyName = c.company?.name ?? r.fromEmail;
      }
      return companyName;
    };
    const who = meetingIntent ? await company() : (out.personName ?? (await company()));
    const excerpt = sanitizeExcerpt(msg?.authoredText ?? '');
    const section = r.draft ? replyDraftSection(r.draft, r.receivedLocal) : null;
    const task = (await call('create_reply_task', {
      who,
      kind: out.taskKind,
      bodyMarkdown: replyTaskBody({
        class: d.class as 'INTERESADO' | 'PREGUNTA',
        fromEmail: r.fromEmail,
        subject: msg?.subject ?? '',
        excerpt,
        receivedLocal: r.receivedLocal,
        timezone: cfg.timezone,
        sendSubject: r.sendSubject,
        meetingIntent,
        draftSection: section,
      }),
      dueAt: addBusinessDays(r.when, REPLY_TASK_BUSINESS_DAYS, cfg.timezone).toISOString(),
      companyId: r.companyId,
      opportunityId: out.opportunityId,
      personId: out.personId,
      noteId: r.noteId,
      // An open task reused by another reply of the same contact gets this reply and its draft
      // appended (once: the section title carries the receive time).
      ...(section ? { appendOnReuse: { marker: replyDraftSectionTitle(r.receivedLocal), markdown: reuseAppendix(r.fromEmail, r.receivedLocal, excerpt, section) } } : {}),
    })) as { created: boolean; appended?: boolean; task: { id: string } };
    out.taskId = task.task.id;
    o.counters.reply_tasks++;
    if (meetingIntent) o.counters.meeting_tasks++;
    if (task.appended) out.signals.push('reply_task_draft_appended');
    return out;
  }

  /**
   * Tanda 22: the draft of the answer to an INTERESADO / PREGUNTA reply. Reads the company (name)
   * and, when the send has one, the hypothesis (need, why now, our first email); asks the
   * availability for a meeting proposal; ONE LLM call with the skill `email-reply-draft` and the
   * model of the drafting role; the code finalises it (subject, meeting paragraph, signature).
   * Never blocking: a model error, an invalid answer, the per-run limit or an unreadable
   * hypothesis end as `failed` with the reason (the Task is created anyway). Only a Twenty error
   * reading the company stops the run, as in the rest of the CRM step (retried, idempotent).
   */
  private async prepareReplyDraft(
    ctx: AgentContext,
    cfg: InboxConfig,
    d: Decision,
    o: { steps: AgentStep[]; counters: Counters; allowed: ReadonlySet<string>; llm: ProspectorRun },
    r: { companyId: string; hypothesisId: string | null; fromEmail: string; sendSubject: string | null },
  ): Promise<PreparedDraft> {
    const tools = ctx.tools!;
    const msg = d.item.msg;
    const rc = cfg.replyDraft;
    const meetingIntent = d.signals.includes(MEETING_INTENT_SIGNAL);
    const signals: string[] = [];
    const failed = (reason: string, extra: Partial<PreparedDraft> = {}): PreparedDraft => {
      o.counters.reply_drafts_failed++;
      return { outcome: { status: 'failed', reason, meetingIntent }, companyName: null, costEur: 0, model: null, ...extra, signals: [...signals, 'reply_draft_failed'] };
    };
    if (o.counters.reply_drafts_created + o.counters.reply_drafts_failed >= rc.maxPerRun) return failed('se ha alcanzado el límite de borradores por ejecución');

    // Company (name for the prompt and the task). A Twenty error stops the run (as the CRM step).
    const got = await tools.call('get_company', { companyId: r.companyId });
    o.steps.push(got.step);
    if (got.result.status !== 'ok') throw new StopRun('error', toolError('get_company', got.result as { status: string } & Record<string, unknown>));
    const company = (got.result.output as { company: { name: string; domain?: string | null } | null }).company;
    const companyName = company?.name ?? null;

    // Hypothesis of the send: need, why now and our first email. Optional, never fatal.
    let hypothesis: { need: string | null; whyNow: string | null } | null = null;
    let firstEmail: { subject: string | null; body: string | null } | null = r.sendSubject ? { subject: r.sendSubject, body: null } : null;
    if (r.hypothesisId && o.allowed.has('get_hypothesis')) {
      const h = await tools.call('get_hypothesis', { hypothesisId: r.hypothesisId });
      o.steps.push(h.step);
      const out = h.result.status === 'ok' ? (h.result.output as GetHypothesisOutput) : null;
      const hyp = out?.found ? out.hypothesis : null;
      if (hyp && (hyp.companyId === null || hyp.companyId === r.companyId)) {
        hypothesis = { need: hyp.need, whyNow: hyp.whyNow };
        if (hyp.emailSubject || hyp.emailBody) firstEmail = { subject: hyp.emailSubject ?? r.sendSubject, body: hyp.emailBody };
      } else signals.push(h.result.status !== 'ok' ? 'draft_hypothesis_unavailable' : hyp ? 'draft_hypothesis_other_company' : 'draft_hypothesis_not_found');
    }

    // Meeting proposal (code). An availability error falls back to «¿qué día os viene bien?».
    let proposal: MeetingProposal;
    try {
      proposal = await (this.deps.availability ?? NULL_AVAILABILITY).propose({ now: this.clock(), count: rc.slots });
    } catch {
      signals.push('availability_error');
      proposal = await NULL_AVAILABILITY.propose({ now: this.clock(), count: rc.slots });
    }

    const model = this.draftModel(ctx, rc, signals);
    const fromName = cleanPersonName(msg?.fromName ?? null);
    const firstName = fromName ? (fromName.split(/\s+/)[0] ?? null) : null;
    const system = useKnowledge(ctx, useSkill(ctx, REPLY_DRAFT_SKILL_ID, REPLY_DRAFT_SYSTEM_PROMPT));
    const eurBefore = o.llm.costEur();
    const call = await o.llm.completeJson({
      label: { step: 'reply_draft', uid: d.item.raw.uid },
      system,
      messages: [
        {
          role: 'user',
          content: buildReplyDraftPrompt({
            today: localMinute(this.clock(), cfg.timezone).slice(0, 10),
            sender: { name: rc.sender.name, company: rc.sender.company, descriptor: rc.sender.descriptor },
            class: d.class as 'INTERESADO' | 'PREGUNTA',
            meetingIntent,
            meetingSource: meetingParagraph(proposal).source,
            company: { name: companyName ?? r.fromEmail, domain: company?.domain ?? null },
            person: { name: fromName, email: r.fromEmail },
            firstEmail,
            hypothesis,
            incoming: { subject: msg?.subject ?? '', text: msg?.authoredText ?? '' },
            textMax: rc.textMax,
          }),
        },
      ],
      parse: parseReplyDraft,
      schema: REPLY_DRAFT_JSON_SCHEMA,
      maxAttempts: rc.maxAttempts,
      maxTokens: rc.maxOutputTokens,
      model,
    });
    o.steps.push(...o.llm.steps.splice(0));
    const costEur = round6(o.llm.costEur() - eurBefore);
    if (call.status === 'model_error') return failed(`error del modelo (${call.code})`, { companyName, costEur, model });
    if (call.status === 'invalid') return failed(`la respuesta del modelo no cumplía las reglas (${call.message.slice(0, 200)})`, { companyName, costEur, model });
    const draft = finalizeReplyDraft(call.value, {
      sender: rc.sender,
      personFirstName: firstName,
      companyName: companyName ?? '',
      incomingSubject: msg?.subject ?? '',
      sendSubject: r.sendSubject,
      proposal,
      timeZone: cfg.timezone,
    });
    o.counters.reply_drafts_created++;
    return { outcome: { status: 'created', draft, to: r.fromEmail, meetingIntent }, companyName, costEur, model, signals: [...signals, 'reply_draft_created'] };
  }

  /**
   * Model of the drafting role (model router: MODEL_ROUTE_<ROL>, the pinned `reply_draft.model`,
   * legacy env, code table). The execution has ONE provider: when the role points to another
   * one, the version's model is used and the run says so. Stub executions keep their model.
   */
  private draftModel(ctx: AgentContext, rc: ReplyDraftConfig, signals: string[]): string {
    if (ctx.version.modelProvider === 'stub') return rc.model ?? ctx.version.model;
    try {
      const router = this.deps.router ?? defaultModelRouter(this.deps.env ?? process.env);
      const route = router.resolve(rc.modelRole, rc.model ? { pinned: { provider: ctx.version.modelProvider, model: rc.model } } : {});
      if (route.provider === ctx.version.modelProvider) return route.model;
      signals.push('draft_route_other_provider');
    } catch {
      signals.push('draft_route_invalid');
    }
    return ctx.version.model;
  }
}

/** What is appended to a reused reply task: the new reply, its excerpt and its draft section. */
function reuseAppendix(fromEmail: string, receivedLocal: string, excerpt: string, section: string): string {
  const from = fromEmail.replace(/[`*_[\]()<>|~#\\]/g, '');
  return [`**Nueva respuesta de ${from} (recibida ${receivedLocal}).**`, '', `> ${excerpt.length > 0 ? excerpt : '(sin texto)'}`, '', section].join('\n');
}

interface OpportunityOut {
  id: string;
  name: string | null;
  stage: string | null;
  companyId: string | null;
  pointOfContactId: string | null;
}

interface PreparedDraft {
  outcome: ReplyDraftOutcome;
  companyName: string | null;
  costEur: number;
  model: string | null;
  signals: string[];
}

interface CrmFollowUp {
  taskKind: 'reply' | 'meeting';
  personId: string | null;
  personName: string | null;
  opportunityId: string | null;
  opportunityCreated: boolean;
  taskId: string | null;
  signals: string[];
}


