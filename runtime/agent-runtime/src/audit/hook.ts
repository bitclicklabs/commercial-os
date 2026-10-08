/**
 * Audit hook of the API (LLD v0.1 section 24): one `audit_log` row per request to a route of
 * AUDITED_ROUTES (src/audit/catalog.ts), with the outcome. Not a global logger: GETs and the
 * routes of NOT_AUDITED are skipped.
 *
 * - `onSend`: runs for every reply, also the ones built by the error handler (400 validation,
 *   404, 409 of the Release Gate, 500), so a rejected action is audited too. It runs before the
 *   reply leaves, so the row exists when the client gets the answer.
 * - The action is already committed (or rejected) when the hook runs: a failed audit insert is
 *   logged at error level and never changes the reply.
 * - Actor: `api` (the API has no authentication yet), the client IP and a free label (`x-actor`
 *   header, else `by` / `created_by` of the body). The label is NOT authenticated.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { tenantOf } from '../api/http.js';
import { AUDITED_ROUTES, MUTATING_METHODS, NOT_AUDITED, routeKey, type AuditInput, type AuditSpec } from './catalog.js';
import { recordAudit, resultOf, type AuditInsert } from './service.js';
import { summarizePayload } from './summary.js';

const ACTOR_HEADER = 'x-actor';
const LABEL_MAX = 200;
const MESSAGE_MAX = 500;

const unclassified = new WeakMap<FastifyInstance, string[]>();

/** Mutating routes registered on `app` that are neither audited nor exempted (should be empty). */
export function unclassifiedMutatingRoutes(app: FastifyInstance): string[] {
  return [...(unclassified.get(app) ?? [])];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseResponse(reply: FastifyReply, payload: unknown): Record<string, unknown> | null {
  const type = String(reply.getHeader('content-type') ?? '');
  if (!type.includes('json')) return null;
  const text = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function headerValue(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim().slice(0, LABEL_MAX) : null;
}

function actorLabel(req: FastifyRequest, body: Record<string, unknown>): string | null {
  const fromHeader = headerValue(req, ACTOR_HEADER);
  if (fromHeader) return fromHeader;
  for (const key of ['by', 'created_by', 'updated_by', 'decided_by', 'evaluated_by']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, LABEL_MAX);
  }
  return null;
}

/** Short facts of the response worth keeping next to the action. */
function responseDetails(response: Record<string, unknown> | null, statusCode: number): Record<string, unknown> {
  if (!response) return {};
  const out: Record<string, unknown> = {};
  if (typeof response.changed === 'boolean') out.changed = response.changed;
  const gate = asRecord(response.gate);
  if (typeof gate.mode === 'string') {
    out.gate_mode = gate.mode;
    const exp = asRecord(gate.experiment);
    if (typeof exp.name === 'string') out.gate_experiment = exp.name;
    if (gate.revalidated === true) out.gate_revalidated = true;
    if (typeof gate.blocked_reason === 'string') out.gate_blocked_reason = gate.blocked_reason;
    const reval = asRecord(gate.revalidation);
    if (typeof reval.id === 'string') out.gate_revalidation = { id: reval.id, verdict: reval.verdict };
  }
  if (statusCode >= 400) {
    if (typeof response.message === 'string') out.message = response.message.slice(0, MESSAGE_MAX);
    const details = asRecord(response.details);
    if (typeof details.required === 'string') out.required = details.required.slice(0, MESSAGE_MAX);
    if (typeof details.reason === 'string') out.reason = details.reason.slice(0, LABEL_MAX);
    const reval = asRecord(details.revalidation);
    if (typeof reval.id === 'string') out.revalidation = { id: reval.id, verdict: reval.verdict };
  }
  return out;
}

function subjectVersionOf(spec: AuditSpec, input: AuditInput): number | null {
  if (spec.subjectVersion) {
    const v = spec.subjectVersion(input);
    if (typeof v === 'number' && Number.isInteger(v)) return v;
  }
  const raw = input.params.v;
  const n = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isInteger(n) ? n : null;
}

function subjectIdOf(spec: AuditSpec, input: AuditInput): string | null {
  const fromSpec = spec.subjectId?.(input);
  if (typeof fromSpec === 'string' && fromSpec !== '') return fromSpec.slice(0, LABEL_MAX);
  const p = input.params.id ?? input.params.name;
  return typeof p === 'string' && p !== '' ? p.slice(0, LABEL_MAX) : null;
}

/** Builds the row of one audited request (pure: unit tested). */
export function auditRow(
  req: FastifyRequest,
  spec: AuditSpec,
  route: string,
  statusCode: number,
  response: Record<string, unknown> | null,
  defaultTenantId: string,
): AuditInsert {
  const body = asRecord(req.body);
  const input: AuditInput = { params: asRecord(req.params), body, response };
  let tenantId = defaultTenantId;
  const details = responseDetails(response, statusCode);
  try {
    tenantId = tenantOf(req, defaultTenantId);
  } catch {
    details.invalid_tenant_header = headerValue(req, 'x-tenant-id');
  }
  const errorCode = statusCode >= 400 && typeof response?.error === 'string' ? response.error.slice(0, LABEL_MAX) : statusCode >= 400 ? `http_${statusCode}` : null;
  return {
    tenantId,
    actor: 'api',
    actorIp: req.ip ?? null,
    actorLabel: actorLabel(req, body),
    action: typeof spec.action === 'function' ? spec.action(input) : spec.action,
    subjectType: spec.subjectType,
    subjectId: subjectIdOf(spec, input),
    subjectVersion: subjectVersionOf(spec, input),
    method: req.method,
    route,
    requestId: String(req.id),
    payload: summarizePayload(req.body),
    result: resultOf(statusCode),
    statusCode,
    errorCode,
    details,
  };
}

export function installAuditHook(app: FastifyInstance, ctx: { db: Db; config: { defaultTenantId: string } }): void {
  const missing: string[] = [];
  unclassified.set(app, missing);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      if (!MUTATING_METHODS.has(m.toUpperCase())) continue;
      const key = routeKey(m, route.url);
      if (!AUDITED_ROUTES[key] && !NOT_AUDITED[key]) missing.push(key);
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.routeOptions.url;
    if (!url || !MUTATING_METHODS.has(req.method)) return payload;
    const route = url;
    const spec = AUDITED_ROUTES[routeKey(req.method, route)];
    if (!spec) return payload;
    try {
      const row = auditRow(req, spec, route, reply.statusCode, parseResponse(reply, payload), ctx.config.defaultTenantId);
      await recordAudit(ctx.db, row);
    } catch (err) {
      req.log.error({ err, route, method: req.method }, 'audit_log insert failed (the action itself is not affected)');
    }
    return payload;
  });
}
