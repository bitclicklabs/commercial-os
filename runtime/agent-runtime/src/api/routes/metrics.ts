/**
 * Metrics API and mini dashboard (LLD v0.1 sections 17.2 and 17.3). Read-only.
 * - GET /metrics/summary      - runs by status/task/outcome, cost, tokens, latency, funnel, feedback.
 * - GET /metrics/agents       - per agent and version: runs, cost, outcome and human acceptance.
 *                               ARCHIVED agents are hidden unless `include_archived=true`.
 * - GET /metrics/evaluations  - human verdicts per day and per subject.
 * - GET /metrics/model-costs  - roles -> routed model -> price today and on `at` (default
 *                               2027-01-01) and the window's volume repriced (`pnpm models:costs`).
 * - GET /metrics/runs         - latest TaskRuns (compact) with the link to their trace (same
 *                               `include_archived` rule). /metrics/summary always counts every run.
 * - GET /dashboard            - static HTML page over the endpoints above (local requests only).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DASHBOARD_HTML } from '../../metrics/dashboard.js';
import { MODEL_COSTS_DEFAULT_DAYS, modelCostProjection, NEXT_PRICE_CHANGE } from '../../metrics/model-costs.js';
import { metricsAgents, metricsEvaluations, metricsSummary, recentRuns } from '../../metrics/queries.js';
import { defaultModelRouter, ModelRouteError } from '../../providers/model-router.js';
import type { ApiContext } from '../context.js';
import { HttpError, parse, tenantOf } from '../http.js';

const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const MetricsWindowQuery = z
  .object({
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.since || !q.until || new Date(q.since) < new Date(q.until), { message: 'since must be before until' });

/** `include_archived=true|false` (also 1/0, yes/no); default false. */
const IncludeArchived = z.stringbool().default(false);

const windowFields = {
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
};

export const MetricsAgentsQuery = z
  .object({ ...windowFields, include_archived: IncludeArchived })
  .refine((q) => !q.since || !q.until || new Date(q.since) < new Date(q.until), { message: 'since must be before until' });

export const MetricsEvaluationsQuery = z
  .object({
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    tz: z.string().max(64).refine(isTimeZone, { message: 'unknown time zone' }).default('Europe/Madrid'),
    subject_limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .refine((q) => !q.since || !q.until || new Date(q.since) < new Date(q.until), { message: 'since must be before until' });

export const RecentRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  include_archived: IncludeArchived,
});

export const ModelCostsQuery = z
  .object({
    ...windowFields,
    at: z.iso.date().default(NEXT_PRICE_CHANGE),
  })
  .refine((q) => !q.since || !q.until || new Date(q.since) < new Date(q.until), { message: 'since must be before until' });

const toDate = (v: string | undefined) => (v ? new Date(v) : undefined);

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Loopback, or a private address (Docker port mapping on 127.0.0.1 arrives from the bridge gateway). */
function isLocalAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v4 === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(v4);
  if (!m) return /^f[cd][0-9a-f]{2}:/i.test(v4);
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Local request: the client address is local AND the Host header names this machine. The
 * Host check stops DNS rebinding (a remote page resolving its own name to 127.0.0.1).
 */
export function isLocalRequest(req: Pick<FastifyRequest, 'ip' | 'headers'>): boolean {
  const host = req.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  const hostOk = LOCAL_HOSTNAMES.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith('.localhost');
  return hostOk && isLocalAddress(req.ip);
}

export async function metricsRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const { db } = ctx;

  app.get('/metrics/summary', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(MetricsWindowQuery, req.query);
    return metricsSummary(db, { tenantId, since: toDate(q.since), until: toDate(q.until) });
  });

  app.get('/metrics/agents', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(MetricsAgentsQuery, req.query);
    return metricsAgents(db, { tenantId, since: toDate(q.since), until: toDate(q.until), includeArchived: q.include_archived });
  });

  app.get('/metrics/evaluations', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(MetricsEvaluationsQuery, req.query);
    return metricsEvaluations(db, {
      tenantId,
      since: toDate(q.since),
      until: toDate(q.until),
      timezone: q.tz,
      subjectLimit: q.subject_limit,
    });
  });

  /** Read-only: no window = the last 30 days. */
  app.get('/metrics/model-costs', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(ModelCostsQuery, req.query);
    const until = toDate(q.until) ?? new Date();
    const since = toDate(q.since) ?? new Date(until.getTime() - MODEL_COSTS_DEFAULT_DAYS * 86_400_000);
    let router;
    try {
      router = defaultModelRouter();
    } catch (err) {
      if (err instanceof ModelRouteError) throw new HttpError(500, 'model_route_invalid', err.message);
      throw err;
    }
    return modelCostProjection(db, { tenantId, since, until, router, at: q.at });
  });

  app.get('/metrics/runs', async (req) => {
    const tenantId = tenantOf(req, ctx.config.defaultTenantId);
    const q = parse(RecentRunsQuery, req.query);
    return recentRuns(db, { tenantId, limit: q.limit, includeArchived: q.include_archived });
  });

  app.get('/dashboard', async (req, reply) => {
    if (!isLocalRequest(req)) throw new HttpError(403, 'forbidden', 'the dashboard is only served to local requests');
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .send(DASHBOARD_HTML);
  });
}
