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

export const EVENT_TYPE_RE = /^[a-z]+(\.[a-z_]+)+$/;
const SCHEMA_VERSION_RE = /^[a-z.]+\.v[0-9]+$/;

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
