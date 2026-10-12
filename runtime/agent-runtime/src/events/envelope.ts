/**
 * `event.envelope.v1` (LLD v0.2 section 7.2) and the MVP-0 event catalogue (section 7.1).
 *
 * The envelope is what travels on the BullMQ events queue and what GET /events returns.
 * The `events` row stores the same information in columns (`data` -> `payload`).
 */
import { z } from 'zod';
import type { EventRow, EventSource } from '../db/schema.js';

export const ENVELOPE_SCHEMA = 'event.envelope.v1';

export const EVENT_PRODUCERS = ['agent-runtime', 'scheduler', 'twenty-app', 'n8n'] as const;
export type EventProducer = (typeof EVENT_PRODUCERS)[number];

/** Runtime-produced event types (subset of the catalogue implemented in MVP-0). */
export const RUNTIME_EVENT_TYPES = [
  'task.scheduled',
  'task.started',
  'task.completed',
  'task.failed',
  'agent.execution.started',
  'agent.execution.completed',
  'agent.execution.failed',
] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

/** Domain events of the HUMAN evaluator (one per verdict stored in `evaluations`). */
export const EVALUATION_EVENT_TYPES = ['evaluation.recorded'] as const;
export type EvaluationEventType = (typeof EVALUATION_EVENT_TYPES)[number];

/**
 * Email-ops events (src/email-ops/): guard and tracking of the send-from-Twenty flow, plus
 * `email.reply_received` from the inbound triage (src/agents/inbox-agent.ts, one per triaged
 * message, `data.class` = BAJA | NO_INTERESADO | INTERESADO | PREGUNTA | AUTO_REPLY | REBOTE | OTRO).
 * Payloads never carry a full address, only domains.
 */
export const EMAIL_EVENT_TYPES = [
  'email.blocked_suppressed',
  'email.sent',
  'email.sent_suppressed',
  'email.warmup_target_exceeded',
  'email.reply_received',
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

/**
 * Catalog Service events (src/worker/catalog-gate.ts): `catalog.unavailable`, at most once a day
 * per tenant, when the catalog is enabled but its /health fails before a run (degraded mode).
 * For n8n to route; the runtime never emails about it.
 */
export const CATALOG_EVENT_TYPES = ['catalog.unavailable'] as const;
export type CatalogEventType = (typeof CATALOG_EVENT_TYPES)[number];

/**
 * Commercial-signal events (src/signals/qualified.ts): `signal.qualified` when a person moves a
 * fair-level `commercialSignal` to QUALIFIED in Twenty (signed webhook), at most once per signal
 * every 24 h. Data: `{signal_id, name, event_url, event_date, signal_type, chainDepth: 0}`. Fires
 * the EVENT task `prospect-on-qualified` (targeted scout of that fair).
 */
export const SIGNAL_EVENT_TYPES = ['signal.qualified'] as const;
export type SignalEventType = (typeof SIGNAL_EVENT_TYPES)[number];

/**
 * Hypothesis status markers (src/evaluations/twenty-webhook.ts, tanda 18): `hypothesis.status_changed`
 * when a `commercialHypothesis` moves to a status that is NOT a human verdict (EXPIRED, or back to
 * PROPOSED). Never an evaluation; it only lets the HUMAN evaluator know the previous status of the
 * next change (Twenty webhooks carry no previous values), so EXPIRED -> REJECTED / VALIDATED is
 * never scored. Data: `{hypothesis_id, to_status, actor_human, updated_at}`.
 */
export const HYPOTHESIS_EVENT_TYPES = ['hypothesis.status_changed'] as const;
export type HypothesisEventType = (typeof HYPOTHESIS_EVENT_TYPES)[number];

/**
 * Native CRM events (src/crm/opportunities.ts, tanda 19): `opportunity.created` when the inbound
 * triage (INTERESADO reply, `origin: 'reply'`) or a person (`POST /opportunities/promote`,
 * `origin: 'manual'`) opens a NEW Opportunity in Twenty (a reused one emits nothing). For n8n.
 * Data: `{opportunityId, name, stage, companyId, pointOfContactId, hypothesisId, taskId, origin}`;
 * ids only, never an address.
 */
export const OPPORTUNITY_EVENT_TYPES = ['opportunity.created'] as const;
export type OpportunityEventType = (typeof OPPORTUNITY_EVENT_TYPES)[number];

export const EVENT_TYPE_RE =/^[a-z]+(\.[a-z_]+)+$/;
/** `{type}.v{n}`; underscores allowed, as in EVENT_TYPE_RE (`email.blocked_suppressed.v1`). */
const SCHEMA_VERSION_RE = /^[a-z._]+\.v[0-9]+$/;

export const EventEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.string().regex(EVENT_TYPE_RE),
    schemaVersion: z.string().regex(SCHEMA_VERSION_RE),
    tenantId: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    producer: z.enum(EVENT_PRODUCERS),
    correlationId: z.string(),
    idempotencyKey: z.string().max(255).optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Schema of `data` for runtime events: `{type}.v1` (compact payloads, never the trace). */
export function schemaVersionFor(type: string): string {
  return `${type}.v1`;
}

export function sourceOfProducer(producer: EventProducer): EventSource {
  if (producer === 'twenty-app') return 'twenty';
  if (producer === 'n8n') return 'n8n';
  return 'runtime';
}

export function envelopeFromRow(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    type: row.type,
    schemaVersion: row.schemaVersion,
    tenantId: row.tenantId,
    occurredAt: row.occurredAt.toISOString(),
    producer: row.producer as EventProducer,
    correlationId: row.correlationId,
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    data: row.payload,
  };
}
