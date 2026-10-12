/**
 * Contacts backfill: one ContactFinder run (task `find-contact`) per VALIDATED hypothesis of
 * the tenant whose `emailTo` is still empty. It unblocks the drafts that were written before
 * the ContactFinder existed (their recipient was left for the commercial to type).
 *
 * Which hypotheses (listed from Twenty with `tenantId = <tenant>` and `status = VALIDATED`):
 * - `emailTo` empty (a recipient typed by a person is never touched);
 * - `emailStatus` not READY / SENDING / SENT (a reviewed or sent draft belongs to a person);
 * - with a company;
 * - not searched yet: no Research CONTACT_DISCOVERY of that company whose `query` names the
 *   hypothesis (unless `force`).
 *
 * Idempotent: the TaskRun key is `contact-backfill:{hypothesis}:{local day}` (a second call the
 * same day reuses the run), the Research check skips what was already searched, and the run
 * itself only writes an EMPTY `emailTo`. Nothing is deleted and nothing is sent.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { taskDefinitions } from '../db/schema.js';
import type { EventPublisher } from '../events/event-bus.js';
import { localDate } from '../inbound/suppression-list.js';
import { TWENTY_OBJECTS, filterValue, type TwentyClient, type TwentyCommercialHypothesis, type TwentyResearch } from '../integrations/twenty/index.js';
import type { RunQueue } from '../queue/run-queue.js';
import { QueueUnavailableError, requestTaskRun } from '../services/task-runs.js';
import { HUMAN_OWNED_DRAFT_STATUSES } from '../tools/twenty/hypothesis-tools.js';
import { CONTACT_FINDER_TASK_NAME } from '../seed/contact-finder-seed.js';
import { CONTACT_RESEARCH_TYPE } from './research.js';

export const BACKFILL_DEFAULT_LIMIT = 25;
export const BACKFILL_MAX_LIMIT = 100;
/** Hypotheses scanned at most per call (pages of 60). */
export const BACKFILL_SCAN_MAX = 1_000;

export class BackfillError extends Error {
  constructor(
    readonly code: 'TASK_NOT_FOUND' | 'TASK_DISABLED' | 'TWENTY_NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
    this.name = 'BackfillError';
  }
}

export interface BackfillDeps {
  db: Db;
  queue: RunQueue;
  twenty: TwentyClient;
  events?: EventPublisher;
}

export interface BackfillOptions {
  tenantId: string;
  limit?: number;
  /** Search again hypotheses that already have a contact Research. */
  force?: boolean;
  /** Only list what would be queued. */
  dryRun?: boolean;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface BackfillResult {
  tenant_id: string;
  task_id: string;
  dry_run: boolean;
  force: boolean;
  limit: number;
  scanned: number;
  eligible: number;
  queued: Array<{ hypothesis_id: string; hypothesis_name: string; task_run_id: string | null; deduplicated: boolean; enqueue_error?: string }>;
  skipped: Array<{ hypothesis_id: string; hypothesis_name: string; reason: string }>;
  /** Eligible hypotheses left for a next call (over `limit`). */
  remaining: number;
}

const eq_ = (field: string, value: string) => `${field}[eq]:${filterValue(value)}`;
const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** VALIDATED hypotheses of the tenant (Twenty filter by `tenantId`, the scope of the call). */
export async function listValidatedHypotheses(twenty: TwentyClient, tenantId: string, opts: { signal?: AbortSignal; max?: number } = {}): Promise<TwentyCommercialHypothesis[]> {
  const out: TwentyCommercialHypothesis[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const max = opts.max ?? BACKFILL_SCAN_MAX;
  while (out.length < max) {
    const page = await twenty.list<TwentyCommercialHypothesis>(TWENTY_OBJECTS.commercialHypothesis, {
      filter: `and(${eq_('status', 'VALIDATED')},${eq_('tenantId', tenantId)})`,
      limit: 60,
      depth: 0,
      ...(cursor ? { startingAfter: cursor } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    let fresh = 0;
    for (const h of page.records) {
      // Belt and braces: the filter already scopes by tenant.
      if (seen.has(h.id) || h.tenantId !== tenantId) continue;
      seen.add(h.id);
      out.push(h);
      fresh += 1;
    }
    cursor = page.pageInfo.endCursor ?? undefined;
    if (!page.pageInfo.hasNextPage || !cursor || fresh === 0) break;
  }
  return out.slice(0, max);
}

async function contactResearchOf(twenty: TwentyClient, h: TwentyCommercialHypothesis, tenantId: string, signal?: AbortSignal): Promise<TwentyResearch | null> {
  const { records } = await twenty.list<TwentyResearch>(TWENTY_OBJECTS.research, {
    filter: `and(${eq_('companyId', h.companyId!)},${eq_('researchType', CONTACT_RESEARCH_TYPE)},${eq_('tenantId', tenantId)},query[ilike]:${filterValue(`%${h.id}%`)})`,
    limit: 1,
    ...(signal ? { signal } : {}),
  });
  return records[0] ?? null;
}

export async function runContactBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillResult> {
  if (!deps.twenty.isConfigured()) throw new BackfillError('TWENTY_NOT_CONFIGURED', 'TWENTY_API_KEY no está configurada');
  const limit = Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Math.floor(opts.limit ?? BACKFILL_DEFAULT_LIMIT)));
  const now = opts.now ?? (() => new Date());
  const task = await deps.db.query.taskDefinitions.findFirst({
    where: and(eq(taskDefinitions.tenantId, opts.tenantId), eq(taskDefinitions.name, CONTACT_FINDER_TASK_NAME), ne(taskDefinitions.status, 'ARCHIVED')),
  });
  if (!task) throw new BackfillError('TASK_NOT_FOUND', `no existe la tarea ${CONTACT_FINDER_TASK_NAME} en el tenant ${opts.tenantId}: ejecuta pnpm seed`);
  if (!task.enabled || task.status === 'PAUSED') throw new BackfillError('TASK_DISABLED', `la tarea ${CONTACT_FINDER_TASK_NAME} está desactivada o en pausa`);

  const result: BackfillResult = {
    tenant_id: opts.tenantId,
    task_id: task.id,
    dry_run: opts.dryRun === true,
    force: opts.force === true,
    limit,
    scanned: 0,
    eligible: 0,
    queued: [],
    skipped: [],
    remaining: 0,
  };
  const hypotheses = await listValidatedHypotheses(deps.twenty, opts.tenantId, opts.signal ? { signal: opts.signal } : {});
  result.scanned = hypotheses.length;
  const day = localDate(now(), task.timezone || 'Europe/Madrid');
  for (const h of hypotheses) {
    opts.signal?.throwIfAborted();
    const skip = (reason: string) => result.skipped.push({ hypothesis_id: h.id, hypothesis_name: h.name, reason });
    if (filled(h.emailTo)) continue; // already has a recipient: not a backfill case
    if (h.emailStatus && (HUMAN_OWNED_DRAFT_STATUSES as readonly string[]).includes(h.emailStatus)) {
      skip(`borrador ${h.emailStatus}: es de una persona`);
      continue;
    }
    if (!h.companyId) {
      skip('sin empresa');
      continue;
    }
    if (!opts.force) {
      const research = await contactResearchOf(deps.twenty, h, opts.tenantId, opts.signal);
      if (research) {
        skip(`ya buscado (Research «${research.name}»)`);
        continue;
      }
    }
    result.eligible += 1;
    if (result.queued.length >= limit) {
      result.remaining += 1;
      continue;
    }
    if (opts.dryRun) {
      result.queued.push({ hypothesis_id: h.id, hypothesis_name: h.name, task_run_id: null, deduplicated: false });
      continue;
    }
    const idempotencyKey = `contact-backfill:${h.id}:${day}${opts.force ? `:force:${now().getTime()}` : ''}`;
    try {
      const { taskRun, deduplicated } = await requestTaskRun(
        deps.db,
        deps.queue,
        task,
        { idempotencyKey, input: { hypothesis_id: h.id }, trigger: 'API' },
        deps.events ? { events: deps.events } : {},
      );
      result.queued.push({ hypothesis_id: h.id, hypothesis_name: h.name, task_run_id: taskRun.id, deduplicated });
    } catch (err) {
      // The TaskRun exists (QUEUED): the reconciler enqueues it when the queue is back.
      if (err instanceof QueueUnavailableError) {
        result.queued.push({ hypothesis_id: h.id, hypothesis_name: h.name, task_run_id: err.taskRun.id, deduplicated: false, enqueue_error: 'cola no disponible: el reconciliador lo encolará' });
      } else throw err;
    }
  }
  return result;
}
