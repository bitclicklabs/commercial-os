/**
 * Ingestion of external events (POST /events/external), pure part: configuration,
 * authentication and validation (LLD v0.1 section 20: n8n integrates, it is never the
 * central intelligence).
 *
 * Contract:
 * - `Authorization: Bearer <EXTERNAL_EVENTS_TOKEN>` (static token, constant-time compare).
 *   Token not configured = 503; missing or wrong = 401.
 * - Body = partial envelope, strict (unknown keys = 400):
 *     { type, data, producer?, occurred_at?, correlation_id?, idempotency_key? }
 *   `type` must start with one of EXTERNAL_EVENT_TYPE_PREFIXES (default `ext.`); `data` is
 *   a JSON object of at most 64 KB; `producer` is `n8n` (default) or `twenty` and decides
 *   `source` (n8n | twenty).
 * - The runtime completes the envelope (id, schemaVersion `{type}.v1`, tenant from
 *   `x-tenant-id`), forces `data.chainDepth = 0` and publishes through the normal EventBus,
 *   so idempotency, the re-publisher and EVENT triggers work as for internal events.
 *
 * The content is UNTRUSTED DATA: it is stored and matched by triggers as any payload and is
 * never interpreted as instructions. External idempotency keys are namespaced
 * (`ext:{producer}:{key}`) so they can never collide with (or pre-empt) the runtime's own
 * keys such as `evt:task.completed:{runId}`.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EMAIL_EVENT_TYPES, EVALUATION_EVENT_TYPES, EVENT_TYPE_RE, RUNTIME_EVENT_TYPES, type EventProducer } from './envelope.js';
import type { PublishEventInput } from './event-bus.js';

export const DEFAULT_EXTERNAL_EVENT_TYPE_PREFIXES = ['ext.'] as const;
export const MAX_EXTERNAL_DATA_BYTES = 64 * 1024;
/** Fastify body limit of the ingestion route: data (64 KB) plus the envelope fields. */
export const EXTERNAL_BODY_LIMIT_BYTES = 96 * 1024;

/** Declared producer -> envelope producer (and, through it, `events.source`). */
export const EXTERNAL_PRODUCERS = { n8n: 'n8n', twenty: 'twenty-app' } as const satisfies Record<string, EventProducer>;
export type ExternalProducer = keyof typeof EXTERNAL_PRODUCERS;

/** First segment of every type the runtime emits itself: an external prefix may not cover them. */
export const RESERVED_EVENT_NAMESPACES: readonly string[] = [
  ...new Set([...RUNTIME_EVENT_TYPES, ...EVALUATION_EVENT_TYPES, ...EMAIL_EVENT_TYPES].map((t) => `${t.split('.')[0]}.`)),
];

const PREFIX_RE = /^[a-z]+(\.[a-z_]+)*\.$/;

export class ExternalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalConfigError';
  }
}

/**
 * `EXTERNAL_EVENT_TYPE_PREFIXES` (comma separated, each ending in "."). A prefix that would
 * let an external sender forge runtime events (`task.`, `agent.`, `evaluation.`, `email.`, or a
 * shorter prefix covering them) is refused at boot.
 */
export function parseEventTypePrefixes(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(/[\s,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (list.length === 0) return [...DEFAULT_EXTERNAL_EVENT_TYPE_PREFIXES];
  for (const prefix of list) {
    if (!PREFIX_RE.test(prefix)) throw new ExternalConfigError(`invalid external event prefix "${prefix}" (lowercase letters, dots and underscores, ending in "."; e.g. "ext." or "ext.crm.")`);
    const clash = RESERVED_EVENT_NAMESPACES.find((ns) => ns.startsWith(prefix) || prefix.startsWith(ns));
    if (clash) throw new ExternalConfigError(`external event prefix "${prefix}" overlaps the runtime namespace "${clash}"`);
  }
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
export type BearerAuthResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `Authorization: Bearer <token>` against EXTERNAL_EVENTS_TOKEN. */
export function authenticateExternalRequest(authorization: string | string[] | undefined, token: string | undefined): BearerAuthResult {
  if (!token) return { ok: false, status: 503, reason: 'EXTERNAL_EVENTS_TOKEN is not set' };
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value ?? '');
  if (!match) return { ok: false, status: 401, reason: 'missing bearer token' };
  return safeEqual(match[1]!, token) ? { ok: true } : { ok: false, status: 401, reason: 'invalid bearer token' };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

export function externalEventBodySchema(prefixes: readonly string[]) {
  return z
    .object({
      type: z
        .string()
        .max(120)
        .regex(EVENT_TYPE_RE, 'type must look like "ext.lead.created" (lowercase, dot separated)')
        .refine((t) => prefixes.some((p) => t.startsWith(p) && t.length > p.length), {
          message: `type must start with one of: ${prefixes.join(', ')}`,
        }),
      data: z
        .record(z.string(), z.unknown())
        .refine((d) => jsonByteLength(d) <= MAX_EXTERNAL_DATA_BYTES, { message: `data exceeds ${MAX_EXTERNAL_DATA_BYTES} bytes` }),
      producer: z.enum(Object.keys(EXTERNAL_PRODUCERS) as [ExternalProducer, ...ExternalProducer[]]).default('n8n'),
      occurred_at: z.iso.datetime({ offset: true }).optional(),
      correlation_id: z.string().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(200).optional(),
    })
    .strict();
}

export type ExternalEventBody = z.infer<ReturnType<typeof externalEventBodySchema>>;

export function externalIdempotencyKey(producer: ExternalProducer, key: string): string {
  return `ext:${producer}:${key}`;
}

/**
 * The EventBus input for a validated body. `chainDepth` is always 0 on entry (whatever the
 * sender put there); `correlationId` defaults to a fresh id supplied by the caller.
 */
export function externalPublishInput(body: ExternalEventBody, opts: { tenantId: string; fallbackCorrelationId: string }): PublishEventInput {
  return {
    tenantId: opts.tenantId,
    type: body.type,
    producer: EXTERNAL_PRODUCERS[body.producer],
    correlationId: body.correlation_id ?? opts.fallbackCorrelationId,
    ...(body.occurred_at ? { occurredAt: body.occurred_at } : {}),
    ...(body.idempotency_key ? { idempotencyKey: externalIdempotencyKey(body.producer, body.idempotency_key) } : {}),
    data: { ...body.data, chainDepth: 0 },
  };
}
