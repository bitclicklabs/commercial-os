/**
 * Outbound webhook subscriptions, pure part: event type patterns and signature.
 *
 * Patterns (`event_types`): an exact type (`task.completed`) or a prefix with a trailing
 * wildcard (`task.*` = every type starting with `task.`), as in GET /events?type=.
 *
 * Signature (same scheme as Twenty's webhooks, see src/evaluations/twenty-webhook.ts):
 *   X-Pxos-Event-Timestamp: <epoch ms>
 *   X-Pxos-Event-Signature: hex(HMAC-SHA256(secret, `${timestamp}:${rawBody}`))
 * `rawBody` is exactly the bytes POSTed (`JSON.stringify(envelope)`, no extra spaces).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EVENT_TYPE_RE } from './envelope.js';

export const SIGNATURE_HEADER = 'x-pxos-event-signature';
export const TIMESTAMP_HEADER = 'x-pxos-event-timestamp';
export const EVENT_ID_HEADER = 'x-pxos-event-id';
export const EVENT_TYPE_HEADER = 'x-pxos-event-type';
export const SUBSCRIPTION_ID_HEADER = 'x-pxos-subscription-id';
export const DELIVERY_ATTEMPT_HEADER = 'x-pxos-delivery-attempt';

export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
export const MAX_EVENT_TYPE_PATTERNS = 50;

const PREFIX_PATTERN_RE = /^[a-z]+(\.[a-z_]+)*\.\*$/;

export function isValidEventTypePattern(pattern: string): boolean {
  return EVENT_TYPE_RE.test(pattern) || PREFIX_PATTERN_RE.test(pattern);
}

export function matchesEventType(type: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return type === pattern;
}

export function matchesSubscription(type: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesEventType(type, p));
}

export function signEventBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex');
}

/** Receiver side (what n8n or any consumer must do); used by the tests and documented. */
export function verifyEventSignature(input: {
  secret: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number;
  toleranceMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.signature || !input.timestamp) return { ok: false, reason: 'missing signature or timestamp' };
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs((input.now ?? Date.now()) - ts) > (input.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS)) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  const expected = Buffer.from(signEventBody(input.secret, input.timestamp, input.rawBody));
  const given = Buffer.from(input.signature.toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'invalid signature' };
}

/** 32 random bytes, hex (64 chars): generated when a subscription is created without secret. */
export function generateSubscriptionSecret(): string {
  return randomBytes(32).toString('hex');
}

/** `…wxyz` (last 4 characters) so a secret can be recognised without being disclosed. */
export function secretHint(secret: string): string {
  return secret.length < 16 ? '****' : `…${secret.slice(-4)}`;
}
