/**
 * EVENT triggers: TaskDefinitions with `schedule.type = "EVENT"` fired by domain events.
 *
 * Registration mirrors CRON: `BullTaskScheduler.syncTask` (API hooks after create, patch,
 * pause, resume and archive, plus the periodic `syncAll`) writes or removes the task in a
 * Redis hash (`pxos:{events_queue}:triggers`, field = task id). Only ACTIVE + enabled tasks
 * with a valid EVENT schedule are registered.
 *
 * The consumer reads the `{QUEUE_NAME}-events` queue. For every event it looks up the
 * registered triggers of the same tenant and type, re-checks the task in PostgreSQL (source
 * of truth; a stale registration is dropped), applies the filter and the anti-loop guard and
 * calls `requestTaskRun` with `taskrun:{task_id}:event:{event_id}`: the same event delivered
 * twice never creates a second TaskRun.
 *
 * Run options of the task schedule (src/events/triggers.ts, `parseEventRunOptions`):
 * `input_from_event` copies event data to top-level input keys (the envelope still goes under
 * `input.event`), and `audit` writes one audit_log row (actor `system`, method `EVENT`) per run
 * the trigger creates, e.g. `prospect.on_qualified` of the task `prospect-on-qualified`.
 *
 * Tenant allowlist (`tenants` option, `SCHEDULER_TENANTS`, tanda 16): triggers of a tenant
 * outside the list never fire (outcome `skipped_tenant`, one WARN per event). syncTask does
 * not register them in the first place; this covers registrations made before the upgrade.
 *
 * Observers (`observers` option, e.g. the outbound WebhookDispatcher) run after the
 * triggers for every event of the queue. An observer that throws fails the job, so BullMQ
 * retries it: triggers (idempotency key per task and event) and observers must be
 * idempotent.
 */
import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, taskDefinitions, type TaskDefinition } from '../db/schema.js';
import { EventEnvelopeSchema, type EventEnvelope } from '../events/envelope.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { EventObserver } from '../events/webhook-delivery.js';
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  deepEqual,
  desiredEventTrigger,
  evaluateTrigger,
  eventTaskRunIdempotencyKey,
  eventTriggeredInput,
  getPath,
  mappedEventInput,
  parseEventRunOptions,
  type EventRunOptions,
  type EventTrigger,
  type TriggerDecision,
} from '../events/triggers.js';
import { recordAudit } from '../audit/service.js';
import { redisConnectionFromUrl, type RunQueue } from '../queue/run-queue.js';
import { QueueUnavailableError, requestTaskRun } from '../services/task-runs.js';
import type { ProcessorLogger } from '../worker/processor.js';
import { IgnoredTenantsReport, tenantAllowed, type TenantAllowlist } from './tenant-allowlist.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export interface RegisteredTrigger {
  task_id: string;
  tenant_id: string;
  event_type: string;
  filter: Record<string, unknown>;
  registered_at: string;
}

export function triggerRegistryKey(eventsQueueName: string): string {
  return `pxos:${eventsQueueName}:triggers`;
}

export function sameTrigger(registered: RegisteredTrigger | null | undefined, task: Pick<TaskDefinition, 'tenantId'>, desired: EventTrigger): boolean {
  return Boolean(
    registered &&
      registered.tenant_id === task.tenantId &&
      registered.event_type === desired.eventType &&
      deepEqual(registered.filter ?? {}, desired.filter),
  );
}

/** Redis hash of registered triggers. Uses the connection of an existing BullMQ queue. */
export class EventTriggerRegistry {
  constructor(
    private readonly queue: Queue,
    readonly key: string,
  ) {}

  private async redis() {
    return this.queue.getBackend().client;
  }

  async get(taskId: string): Promise<RegisteredTrigger | null> {
    const raw = await (await this.redis()).hget(this.key, taskId);
    return raw ? (JSON.parse(raw) as RegisteredTrigger) : null;
  }

  async set(trigger: RegisteredTrigger): Promise<void> {
    await (await this.redis()).hset(this.key, { [trigger.task_id]: JSON.stringify(trigger) });
  }

  async remove(taskId: string): Promise<boolean> {
    return (await (await this.redis()).hdel(this.key, taskId)) > 0;
  }

  async list(): Promise<RegisteredTrigger[]> {
    const all = await (await this.redis()).hgetall(this.key);
    return Object.values(all).map((v) => JSON.parse(v) as RegisteredTrigger);
  }
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------
export type EventTriggerOutcome =
  | { taskId: string; outcome: 'created' | 'deduplicated' | 'created_unqueued'; taskRunId: string }
  | {
      taskId: string;
      outcome:
        | 'task_missing'
        | 'skipped_inactive'
        | 'skipped_agent_inactive'
        | 'skipped_tenant'
        | Extract<TriggerDecision, { fire: false }>['reason'];
    };

export interface EventTriggerConsumerOptions {
  /** `{QUEUE_NAME}-events`. */
  queueName: string;
  redisUrl: string;
  /** Emits task.scheduled for fired runs. */
  events?: EventPublisher;
  maxChainDepth?: number;
  concurrency?: number;
  logger?: ProcessorLogger;
  /** Called with every event after the triggers (outbound webhooks). */
  observers?: EventObserver[];
  /**
   * Tenants whose EVENT tasks may fire (`SCHEDULER_TENANTS`; main.ts always passes it).
   * Omitted: every tenant. Registered triggers of other tenants are ignored (one WARN per event).
   */
  tenants?: TenantAllowlist;
}

/** What the consumer needs from the scheduler: drop stale registrations. */
export interface TriggerSync {
  readonly triggers?: EventTriggerRegistry;
  sync(task: TaskDefinition): Promise<unknown>;
}

const silent: ProcessorLogger = { info() {}, warn() {}, error() {} };

export class EventTriggerConsumer {
  private worker: Worker<EventEnvelope> | undefined;
  private readonly logger: ProcessorLogger;

  constructor(
    private readonly db: Db,
    private readonly runQueue: RunQueue,
    private readonly scheduler: TriggerSync,
    private readonly opts: EventTriggerConsumerOptions,
  ) {
    this.logger = opts.logger ?? silent;
  }

  /** Fires every registered task the event matches. Idempotent per (task, event). */
  async handleEvent(raw: unknown): Promise<EventTriggerOutcome[]> {
    const parsed = EventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues.slice(0, 3) }, 'invalid event envelope; ignored');
      return [];
    }
    const envelope = parsed.data;
    const registry = this.scheduler.triggers;
    if (!registry) return [];
    const candidates = (await registry.list()).filter((t) => t.tenant_id === envelope.tenantId && t.event_type === envelope.type);
    const outcomes: EventTriggerOutcome[] = [];
    if (this.opts.tenants && !tenantAllowed(this.opts.tenants, envelope.tenantId)) {
      // Stale registrations (syncAll removes them): never fire, one aggregated WARN per event.
      if (candidates.length > 0) {
        const report = new IgnoredTenantsReport();
        report.addTasks(envelope.tenantId, candidates.length);
        report.flush(this.opts.tenants, this.logger, 'event triggers of a tenant outside SCHEDULER_TENANTS ignored');
      }
      return candidates.map((c) => ({ taskId: c.task_id, outcome: 'skipped_tenant' as const }));
    }
    for (const candidate of candidates) outcomes.push(await this.fire(candidate, envelope, registry));
    return outcomes;
  }

  private async fire(candidate: RegisteredTrigger, envelope: EventEnvelope, registry: EventTriggerRegistry): Promise<EventTriggerOutcome> {
    const taskId = candidate.task_id;
    const task = await this.db.query.taskDefinitions.findFirst({
      where: and(eq(taskDefinitions.tenantId, candidate.tenant_id), eq(taskDefinitions.id, taskId)),
    });
    if (!task) {
      await registry.remove(taskId);
      return { taskId, outcome: 'task_missing' };
    }
    const trigger = desiredEventTrigger(task);
    if (!trigger || trigger.eventType !== envelope.type) {
      // Paused, archived, disabled or no longer EVENT for this type: drop the stale registration.
      await this.scheduler.sync(task);
      return { taskId, outcome: 'skipped_inactive' };
    }
    const decision = evaluateTrigger(task, trigger, envelope, this.opts.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH);
    if (!decision.fire) {
      if (decision.reason === 'chain_depth_exceeded' || decision.reason === 'self_event') {
        this.logger.warn({ taskId, eventId: envelope.id, type: envelope.type, reason: decision.reason }, 'event trigger blocked by loop guard');
      }
      return { taskId, outcome: decision.reason };
    }
    const agent = await this.db.query.agents.findFirst({ where: eq(agents.id, task.agentId) });
    if (!agent || agent.status !== 'ACTIVE' || !agent.activeVersionId) {
      this.logger.warn({ taskId, eventId: envelope.id }, 'event trigger skipped: agent not ACTIVE or without active version');
      return { taskId, outcome: 'skipped_agent_inactive' };
    }
    // Validated with the trigger (desiredEventTrigger returned non-null), so this does not throw.
    const runOptions = parseEventRunOptions(task.schedule);
    const input = { ...eventTriggeredInput(envelope), ...mappedEventInput(envelope, runOptions.inputFromEvent) };
    try {
      const result = await requestTaskRun(
        this.db,
        this.runQueue,
        task,
        { idempotencyKey: eventTaskRunIdempotencyKey(task.id, envelope.id), input, trigger: 'EVENT' },
        { ...(this.opts.events ? { events: this.opts.events } : {}), producer: 'scheduler' },
      );
      if (!result.deduplicated) await this.audit(task, envelope, runOptions, result.taskRun.id, 'created');
      return { taskId, outcome: result.deduplicated ? 'deduplicated' : 'created', taskRunId: result.taskRun.id };
    } catch (err) {
      // The TaskRun is persisted QUEUED; the orphan reconciler enqueues it.
      if (err instanceof QueueUnavailableError) {
        await this.audit(task, envelope, runOptions, err.taskRun.id, 'created_unqueued');
        return { taskId, outcome: 'created_unqueued', taskRunId: err.taskRun.id };
      }
      throw err;
    }
  }

  /**
   * `schedule.audit` of the task: one audit_log row per run the trigger creates (a duplicate
   * delivery of the same event creates no run and no row). Best-effort: a failed insert is
   * logged and never fails the event job (the run already exists).
   */
  private async audit(task: TaskDefinition, envelope: EventEnvelope, opts: EventRunOptions, taskRunId: string, outcome: string): Promise<void> {
    if (!opts.audit) return;
    const subject = opts.audit.subjectPath ? getPath(envelope.data, opts.audit.subjectPath) : undefined;
    const subjectId = typeof subject === 'string' || typeof subject === 'number' ? String(subject) : envelope.id;
    try {
      await recordAudit(this.db, {
        tenantId: task.tenantId,
        actor: 'system',
        actorLabel: `task:${task.name}`,
        action: opts.audit.action,
        subjectType: opts.audit.subjectType,
        subjectId,
        method: 'EVENT',
        route: `event:${envelope.type}`,
        requestId: envelope.id,
        payload: { [opts.audit.subjectPath ?? 'subject_id']: subjectId, run_id: taskRunId, event_id: envelope.id, task_id: task.id },
        result: 'ok',
        statusCode: outcome === 'created' ? 201 : 202,
        details: { outcome, task_name: task.name, event_type: envelope.type },
      });
    } catch (err) {
      this.logger.warn({ taskId: task.id, eventId: envelope.id, taskRunId, err: (err as Error).message }, 'event trigger audit failed');
    }
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<EventEnvelope>(
      this.opts.queueName,
      async (job) => {
        const outcomes = await this.handleEvent(job.data);
        const fired = outcomes.filter((o) => o.outcome === 'created');
        if (fired.length > 0) this.logger.info({ eventId: job.data.id, type: job.data.type, fired }, 'event triggers fired');
        for (const observer of this.opts.observers ?? []) await observer.onEvent(job.data);
        return outcomes;
      },
      {
        connection: { ...redisConnectionFromUrl(this.opts.redisUrl), maxRetriesPerRequest: null } as ConnectionOptions,
        concurrency: this.opts.concurrency ?? 4,
      },
    );
    this.worker.on('failed', (job, err) => this.logger.warn({ eventId: job?.id, err: err.message }, 'event consumer job failed'));
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'event consumer error'));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }
}
