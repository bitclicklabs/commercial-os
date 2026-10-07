/**
 * TaskScheduler on BullMQ (LLD v0.2 section 5.6).
 *
 * Registration lives in a dedicated queue (`{QUEUE_NAME}-schedule`):
 * - CRON and INTERVAL use BullMQ Job Schedulers, one per task (`task__{task_id}`).
 * - ONCE uses a single delayed job (`once__{task_id}__{run_at_ms}`).
 *
 * Every tick goes through `requestTaskRun`, the same path as `POST /tasks/:id/run`, with
 * `scheduled_at` = the planned slot. A tick delivered twice (restart, stalled job, sync
 * race) therefore collapses into the same `taskrun:{task_id}:{scheduled_at}` TaskRun.
 *
 * Sync is idempotent and level-triggered: `syncTask` compares the desired state (task ACTIVE,
 * enabled, time-based schedule) with what is registered and only touches BullMQ when they
 * differ. The API calls it after create/patch/pause/resume/archive; the scheduler process
 * also runs `syncAll` at boot and periodically, which heals missed syncs (Redis down during
 * a PATCH) and removes schedulers of tasks that no longer exist or no longer qualify.
 *
 * EVENT schedules follow the same sync path when `eventsQueueName` is set: they are
 * registered in the trigger registry consumed by `EventTriggerConsumer` (event-triggers.ts).
 */
import { Queue, Worker, type ConnectionOptions, type Job, type JobSchedulerJson, type JobsOptions } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, taskDefinitions, taskRuns, type TaskDefinition } from '../db/schema.js';
import { taskRunIdempotencyKey } from '../domain/idempotency.js';
import type { EventPublisher } from '../events/event-bus.js';
import { desiredEventTrigger, type EventTrigger } from '../events/triggers.js';
import { redisConnectionFromUrl, type RunQueue } from '../queue/run-queue.js';
import { requestTaskRun } from '../services/task-runs.js';
import type { ProcessorLogger } from '../worker/processor.js';
import {
  desiredSchedule,
  nextRuns,
  onceJobIdFor,
  parseSchedule,
  repeatOptionsFor,
  sameRepeat,
  schedulerIdFor,
  slotFromTickJob,
  taskIdFromSchedulerId,
  TIME_SCHEDULE_TYPES,
  type NormalizedSchedule,
} from './schedule.js';
import { EventTriggerRegistry, sameTrigger, triggerRegistryKey, type RegisteredTrigger } from './event-triggers.js';

export interface ScheduleTickJob {
  kind: 'schedule_tick';
  tenantId: string;
  taskDefinitionId: string;
  /** Only for ONCE: the planned instant. CRON/INTERVAL derive it from the job. */
  slot?: string;
}

export type SyncAction = 'registered' | 'updated' | 'unchanged' | 'removed' | 'none' | 'already_fired' | 'error';

export interface SyncResult {
  taskId: string;
  action: SyncAction;
  desired: NormalizedSchedule | null;
  /** EVENT schedules: the trigger that should be registered (null when none). */
  trigger?: EventTrigger | null;
  error?: string;
}

export interface RegisteredSchedule {
  kind: 'job_scheduler' | 'once' | 'event';
  id: string;
  task_id: string | null;
  tenant_id: string | null;
  pattern: string | null;
  every_ms: number | null;
  tz: string | null;
  next_run_at: string | null;
  /** Only for kind = event. */
  event_type?: string | null;
  filter?: Record<string, unknown> | null;
}

export interface TaskScheduleState {
  task_id: string;
  task_status: string;
  enabled: boolean;
  schedule: unknown;
  desired: NormalizedSchedule | null;
  error: string | null;
  registered: RegisteredSchedule | null;
  in_sync: boolean;
  /** ONCE whose slot already produced a TaskRun. */
  fired: boolean;
  next_runs: string[];
  /** EVENT schedules: desired vs registered trigger (absent when triggers are not configured). */
  event_trigger?: { desired: EventTrigger | null; registered: RegisteredTrigger | null };
}

export interface SchedulerStatus {
  queue: string;
  counts: Record<string, number>;
  items: RegisteredSchedule[];
}

export type TickOutcome =
  | { outcome: 'created' | 'deduplicated'; taskRunId: string; scheduledAt: string }
  | { outcome: 'task_missing' | 'skipped_inactive' | 'skipped_agent_inactive'; scheduledAt: string };

/** What the API needs from the scheduler (keeps routes testable without Redis). */
export interface SchedulerControl {
  /** Never throws: on failure returns action=error (the periodic syncAll heals it). */
  sync(task: TaskDefinition): Promise<SyncResult>;
  describeTask(task: TaskDefinition): Promise<TaskScheduleState>;
  status(tenantId?: string): Promise<SchedulerStatus>;
}

const TICK_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} satisfies Partial<JobsOptions>;

const ONCE_JOB_NAME = 'schedule_once';
const TICK_JOB_NAME = 'schedule_tick';

export function scheduleQueueName(runQueueName: string): string {
  return `${runQueueName}-schedule`;
}

const silent: ProcessorLogger = { info() {}, warn() {}, error() {} };

function iso(ms: number | undefined | null): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface BullTaskSchedulerOptions {
  /** Name of the schedule queue (see `scheduleQueueName`). */
  queueName: string;
  redisUrl: string;
  logger?: ProcessorLogger;
  /** Restrict syncAll to one tenant (tests); production syncs every tenant. */
  tenantId?: string;
  /** `{QUEUE_NAME}-events`: enables EVENT trigger registration. */
  eventsQueueName?: string;
  /** Emits task.scheduled for runs created by ticks. */
  events?: EventPublisher;
}

export class BullTaskScheduler implements SchedulerControl {
  readonly queue: Queue<ScheduleTickJob>;
  /** EVENT trigger registry (only with `eventsQueueName`). */
  readonly triggers?: EventTriggerRegistry;
  private readonly logger: ProcessorLogger;
  private worker: Worker<ScheduleTickJob> | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private syncing = false;

  constructor(
    private readonly db: Db,
    private readonly runQueue: RunQueue,
    private readonly opts: BullTaskSchedulerOptions,
  ) {
    this.logger = opts.logger ?? silent;
    this.queue = new Queue<ScheduleTickJob>(opts.queueName, {
      // Fail fast when Redis is down: API callers log and rely on the periodic syncAll.
      connection: { ...redisConnectionFromUrl(opts.redisUrl), enableOfflineQueue: false } as ConnectionOptions,
    });
    this.queue.on('error', () => {
      /* surfaced on calls */
    });
    if (opts.eventsQueueName) this.triggers = new EventTriggerRegistry(this.queue, triggerRegistryKey(opts.eventsQueueName));
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------
  private async pendingOnceJobs(): Promise<Job<ScheduleTickJob>[]> {
    const jobs = (await this.queue.getJobs(['delayed', 'waiting', 'prioritized'], 0, -1)) as Job<ScheduleTickJob>[];
    return jobs.filter((j) => j?.name === ONCE_JOB_NAME);
  }

  private tickData(task: TaskDefinition, slot?: string): ScheduleTickJob {
    return { kind: 'schedule_tick', tenantId: task.tenantId, taskDefinitionId: task.id, ...(slot ? { slot } : {}) };
  }

  private async slotAlreadyRan(task: TaskDefinition, slot: string): Promise<boolean> {
    const run = await this.db.query.taskRuns.findFirst({
      where: and(eq(taskRuns.tenantId, task.tenantId), eq(taskRuns.idempotencyKey, taskRunIdempotencyKey(task.id, slot))),
      columns: { id: true },
    });
    return Boolean(run);
  }

  /** Brings BullMQ (and the EVENT trigger registry) in line with the task's desired schedule. Idempotent. */
  async syncTask(task: TaskDefinition, pending?: Job<ScheduleTickJob>[]): Promise<SyncResult> {
    const time = await this.syncTimeSchedule(task, pending);
    if (!this.triggers) return time;
    const event = await this.syncEventTrigger(task, this.triggers);
    const action = event.trigger ? event.action : time.action === 'none' ? event.action : time.action;
    return { ...time, action, trigger: event.trigger };
  }

  private async syncEventTrigger(
    task: TaskDefinition,
    registry: EventTriggerRegistry,
  ): Promise<{ action: SyncAction; trigger: EventTrigger | null }> {
    const trigger = desiredEventTrigger(task);
    const existing = await registry.get(task.id);
    if (!trigger) return { action: existing && (await registry.remove(task.id)) ? 'removed' : 'none', trigger };
    if (sameTrigger(existing, task, trigger)) return { action: 'unchanged', trigger };
    await registry.set({
      task_id: task.id,
      tenant_id: task.tenantId,
      event_type: trigger.eventType,
      filter: trigger.filter,
      registered_at: new Date().toISOString(),
    });
    return { action: existing ? 'updated' : 'registered', trigger };
  }

  private async syncTimeSchedule(task: TaskDefinition, pending?: Job<ScheduleTickJob>[]): Promise<SyncResult> {
    const desired = desiredSchedule(task);
    const schedId = schedulerIdFor(task.id);
    const existing = await this.queue.getJobScheduler(schedId);
    const onceJobs = (pending ?? (await this.pendingOnceJobs())).filter((j) => j.data?.taskDefinitionId === task.id);
    const keepOnceId = desired?.type === 'ONCE' ? onceJobIdFor(task.id, desired.runAt) : null;
    let removed = false;

    if (existing && (!desired || desired.type === 'ONCE')) {
      await this.queue.removeJobScheduler(schedId);
      removed = true;
    }
    for (const job of onceJobs) {
      if (job.id === keepOnceId) continue;
      await job.remove();
      removed = true;
    }
    if (!desired) return { taskId: task.id, action: removed ? 'removed' : 'none', desired };

    if (desired.type === 'ONCE') {
      if (onceJobs.some((j) => j.id === keepOnceId)) return { taskId: task.id, action: 'unchanged', desired };
      const delay = new Date(desired.runAt).getTime() - Date.now();
      if (delay <= 0 && (await this.slotAlreadyRan(task, desired.runAt))) {
        return { taskId: task.id, action: 'already_fired', desired };
      }
      const previous = keepOnceId ? await this.queue.getJob(keepOnceId) : undefined;
      if (previous) {
        const state = await previous.getState();
        if (state === 'completed') return { taskId: task.id, action: 'already_fired', desired };
        if (state !== 'failed') return { taskId: task.id, action: 'unchanged', desired };
        await previous.remove();
      }
      await this.queue.add(ONCE_JOB_NAME, this.tickData(task, desired.runAt), {
        ...TICK_JOB_OPTS,
        jobId: keepOnceId!,
        delay: Math.max(0, delay),
      });
      return { taskId: task.id, action: 'registered', desired };
    }

    if (sameRepeat(existing, desired)) return { taskId: task.id, action: 'unchanged', desired };
    await this.queue.upsertJobScheduler(schedId, repeatOptionsFor(desired), {
      name: TICK_JOB_NAME,
      data: this.tickData(task),
      opts: TICK_JOB_OPTS,
    });
    return { taskId: task.id, action: existing ? 'updated' : 'registered', desired };
  }

  /** Like syncTask but never throws (API hooks): failures are healed by the periodic syncAll. */
  async sync(task: TaskDefinition): Promise<SyncResult> {
    try {
      return await this.syncTask(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ taskId: task.id, err: message }, 'schedule sync failed; periodic sync will retry');
      return { taskId: task.id, action: 'error', desired: desiredSchedule(task), error: message };
    }
  }

  /** Full reconciliation of every tenant's schedules. */
  async syncAll(): Promise<SyncResult[]> {
    const scheduleTypes: string[] = [...TIME_SCHEDULE_TYPES, ...(this.triggers ? ['EVENT'] : [])];
    const types = scheduleTypes.map((t) => sql`${t}`);
    const tasks = await this.db
      .select()
      .from(taskDefinitions)
      .where(
        and(
          sql`${taskDefinitions.schedule}->>'type' in (${sql.join(types, sql`, `)})`,
          this.opts.tenantId ? eq(taskDefinitions.tenantId, this.opts.tenantId) : undefined,
        ),
      );
    const inScope = (tenantId: string | null | undefined) => !this.opts.tenantId || tenantId === this.opts.tenantId;
    const pending = await this.pendingOnceJobs();
    const results: SyncResult[] = [];
    for (const task of tasks) {
      try {
        results.push(await this.syncTask(task, pending));
      } catch (err) {
        results.push({ taskId: task.id, action: 'error', desired: null, error: (err as Error).message });
      }
    }

    // Registrations whose task is gone or no longer has a time-based schedule.
    const listed = new Set(tasks.map((t) => t.id));
    for (const s of await this.queue.getJobSchedulers(0, -1, true)) {
      const id = s.key ?? s.id ?? '';
      const taskId = taskIdFromSchedulerId(id);
      if (taskId && !listed.has(taskId) && inScope(s.template?.data?.tenantId)) {
        await this.queue.removeJobScheduler(id);
        results.push({ taskId, action: 'removed', desired: null });
      }
    }
    for (const job of pending) {
      const taskId = job.data?.taskDefinitionId;
      if (taskId && !listed.has(taskId) && inScope(job.data?.tenantId)) {
        await job.remove().catch(() => undefined);
        results.push({ taskId, action: 'removed', desired: null });
      }
    }
    // EVENT triggers whose task is gone or no longer has an EVENT schedule.
    if (this.triggers) {
      for (const t of await this.triggers.list()) {
        if (!listed.has(t.task_id) && inScope(t.tenant_id)) {
          await this.triggers.remove(t.task_id);
          results.push({ taskId: t.task_id, action: 'removed', desired: null, trigger: null });
        }
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------
  private fromScheduler(s: JobSchedulerJson<ScheduleTickJob>): RegisteredSchedule {
    const id = s.key ?? s.id ?? '';
    return {
      kind: 'job_scheduler',
      id,
      task_id: s.template?.data?.taskDefinitionId ?? taskIdFromSchedulerId(id),
      tenant_id: s.template?.data?.tenantId ?? null,
      pattern: s.pattern ?? null,
      every_ms: s.every !== undefined && s.every !== null ? Number(s.every) : null,
      tz: s.tz ?? null,
      next_run_at: iso(s.next),
    };
  }

  private fromOnceJob(job: Job<ScheduleTickJob>): RegisteredSchedule {
    return {
      kind: 'once',
      id: job.id ?? '',
      task_id: job.data?.taskDefinitionId ?? null,
      tenant_id: job.data?.tenantId ?? null,
      pattern: null,
      every_ms: null,
      tz: null,
      next_run_at: job.data?.slot ?? iso(job.timestamp + (job.delay ?? 0)),
    };
  }

  private fromTrigger(t: RegisteredTrigger): RegisteredSchedule {
    return {
      kind: 'event',
      id: t.task_id,
      task_id: t.task_id,
      tenant_id: t.tenant_id,
      pattern: null,
      every_ms: null,
      tz: null,
      next_run_at: null,
      event_type: t.event_type,
      filter: t.filter,
    };
  }

  async describeTask(task: TaskDefinition): Promise<TaskScheduleState> {
    let parsed: NormalizedSchedule | null = null;
    let error: string | null = null;
    try {
      parsed = parseSchedule(task.schedule, task.timezone);
    } catch (err) {
      error = (err as Error).message;
    }
    const desired = desiredSchedule(task);
    const existing = await this.queue.getJobScheduler(schedulerIdFor(task.id));
    const once = (await this.pendingOnceJobs()).filter((j) => j.data?.taskDefinitionId === task.id);
    const registered = existing ? this.fromScheduler(existing) : once[0] ? this.fromOnceJob(once[0]) : null;
    const fired = parsed?.type === 'ONCE' ? await this.slotAlreadyRan(task, parsed.runAt) : false;

    let inSync: boolean;
    if (!desired) inSync = registered === null;
    else if (desired.type === 'ONCE') inSync = once.some((j) => j.id === onceJobIdFor(task.id, desired.runAt)) || (fired && !registered);
    else inSync = sameRepeat(existing, desired) && once.length === 0;

    let eventTrigger: TaskScheduleState['event_trigger'];
    if (this.triggers) {
      const desiredTrigger = desiredEventTrigger(task);
      const registeredTrigger = await this.triggers.get(task.id);
      eventTrigger = { desired: desiredTrigger, registered: registeredTrigger };
      inSync &&= desiredTrigger ? sameTrigger(registeredTrigger, task, desiredTrigger) : registeredTrigger === null;
    }

    return {
      task_id: task.id,
      task_status: task.status,
      enabled: task.enabled,
      schedule: task.schedule,
      desired,
      error,
      registered,
      in_sync: inSync,
      fired,
      next_runs: desired && !(desired.type === 'ONCE' && fired) ? nextRuns(desired, 5) : [],
      ...(eventTrigger ? { event_trigger: eventTrigger } : {}),
    };
  }

  async status(tenantId?: string): Promise<SchedulerStatus> {
    const schedulers = await this.queue.getJobSchedulers(0, -1, true);
    const once = await this.pendingOnceJobs();
    const triggers = this.triggers ? await this.triggers.list() : [];
    const items = [
      ...schedulers.map((s) => this.fromScheduler(s)),
      ...once.map((j) => this.fromOnceJob(j)),
      ...triggers.map((t) => this.fromTrigger(t)),
    ].filter((i) => !tenantId || i.tenant_id === tenantId);
    const counts = await this.queue.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed');
    return {
      queue: this.opts.queueName,
      counts: { ...counts, job_schedulers: schedulers.length, once_jobs: once.length, event_triggers: triggers.length },
      items,
    };
  }

  // -------------------------------------------------------------------------
  // Ticks
  // -------------------------------------------------------------------------
  /** Turns a tick into a TaskRun through the same path as POST /tasks/:id/run. */
  async handleTick(data: ScheduleTickJob, scheduledAt: string): Promise<TickOutcome> {
    const task = await this.db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, data.tenantId), eq(taskDefinitions.id, data.taskDefinitionId)),
    });
    if (!task) {
      await this.queue.removeJobScheduler(schedulerIdFor(data.taskDefinitionId)).catch(() => undefined);
      return { outcome: 'task_missing', scheduledAt };
    }
    if (!desiredSchedule(task)) {
      // Stale registration (paused/archived/disabled meanwhile): drop it.
      await this.sync(task);
      return { outcome: 'skipped_inactive', scheduledAt };
    }
    const agent = await this.db.query.agents.findFirst({ where: eq(agents.id, task.agentId) });
    if (!agent || agent.status !== 'ACTIVE' || !agent.activeVersionId) {
      this.logger.warn({ taskId: task.id, scheduledAt }, 'scheduled slot skipped: agent not ACTIVE or without active version');
      return { outcome: 'skipped_agent_inactive', scheduledAt };
    }
    // QueueUnavailableError propagates: BullMQ retries the tick, and the reconciler would
    // enqueue the persisted QUEUED TaskRun anyway.
    const result = await requestTaskRun(
      this.db,
      this.runQueue,
      task,
      { scheduledAt, trigger: 'SCHEDULE' },
      { ...(this.opts.events ? { events: this.opts.events } : {}), producer: 'scheduler' },
    );
    return { outcome: result.deduplicated ? 'deduplicated' : 'created', taskRunId: result.taskRun.id, scheduledAt };
  }

  /** Starts the tick worker plus `syncAll` at boot and every `syncIntervalMs`. */
  start(opts: { syncIntervalMs: number; concurrency?: number }): void {
    if (this.worker) return;
    this.worker = new Worker<ScheduleTickJob>(
      this.opts.queueName,
      async (job) => {
        const slot = slotFromTickJob(job);
        const res = await this.handleTick(job.data, slot);
        this.logger.info({ jobId: job.id, taskId: job.data.taskDefinitionId, ...res }, 'schedule tick');
        return res;
      },
      {
        connection: { ...redisConnectionFromUrl(this.opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions,
        concurrency: opts.concurrency ?? 4,
      },
    );
    this.worker.on('failed', (job, err) => this.logger.warn({ jobId: job?.id, err: err.message }, 'schedule tick failed'));
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'scheduler worker error'));

    const sync = async () => {
      if (this.syncing) return;
      this.syncing = true;
      try {
        const results = await this.syncAll();
        const changed = results.filter((r) => r.action !== 'unchanged' && r.action !== 'none');
        if (changed.length > 0) this.logger.info({ changed: changed.map((r) => `${r.taskId}:${r.action}`) }, 'schedule sync');
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, 'schedule sync failed');
      } finally {
        this.syncing = false;
      }
    };
    void sync();
    this.syncTimer = setInterval(() => void sync(), opts.syncIntervalMs);
    this.syncTimer.unref();
  }

  async close(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    await this.worker?.close();
    await this.queue.close();
  }
}
