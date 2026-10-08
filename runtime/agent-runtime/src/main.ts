import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { BullEventQueue, EventBus, eventsQueueName } from './events/event-bus.js';
import { BullWebhookDeliveryQueue, WebhookDeliveryWorker, WebhookDispatcher, webhooksQueueName } from './events/webhook-delivery.js';
import { countReadyRevalidations } from './experiments/revalidation-service.js';
import { twentyClientFromEnv } from './integrations/twenty/index.js';
import { TraceArchiveJob, traceArchiveSettingsFromEnv } from './maintenance/trace-archive-job.js';
import { metricsSyncSettingsFromEnv, TwentyMetricsSync } from './metrics/twenty-sync.js';
import { BullOptimizerQueue, OptimizerWorker, optimizerQueueName } from './optimizer/queue.js';
import { createProviderRegistry, defaultModelRouter, experimentRoutes } from './providers/index.js';
import { BullRunQueue } from './queue/run-queue.js';
import { desiredProspectorVersion } from './seed/prospector-seed.js';
import { EventTriggerConsumer } from './scheduler/event-triggers.js';
import { BullTaskScheduler, scheduleQueueName } from './scheduler/task-scheduler.js';
import { startBullWorker } from './worker/bull-worker.js';
import { RunProcessor, type ProcessorLogger } from './worker/processor.js';
import { OrphanReconciler } from './worker/recovery.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // Model routing (LLD §18): MODEL_ROUTE_<ROL> overrides are validated here, at boot; an
  // invalid one stops the process with a clear message instead of failing at the first call.
  const modelRouter = defaultModelRouter();
  for (const w of modelRouter.warnings()) console.warn(`[model-router] ${w}`);
  const dbHandle = createDb(config.databaseUrl);
  const queue = new BullRunQueue(config.queueName, config.redisUrl);
  const has = (...roles: string[]) => config.role === 'all' || roles.includes(config.role);

  let app: FastifyInstance | undefined;
  let worker: Worker | undefined;
  let reconciler: OrphanReconciler | undefined;
  let consoleLogger: ProcessorLogger = console;
  const lateLogger: ProcessorLogger = { info: (o, m) => consoleLogger.info(o, m), warn: (o, m) => consoleLogger.warn(o, m), error: (o, m) => consoleLogger.error(o, m) };

  // Event bus: every role publishes (api: task.scheduled, worker: task.* / agent.execution.*).
  const eventsQueue = eventsQueueName(config.queueName);
  const eventBus = new EventBus(dbHandle.db, new BullEventQueue(eventsQueue, config.redisUrl), {
    logger: lateLogger,
    republishGraceMs: config.eventRepublishGraceMs,
  });

  // Registration control (API hooks) and tick processing (scheduler role) share one class.
  const scheduler = has('api', 'scheduler')
    ? new BullTaskScheduler(dbHandle.db, queue, {
        queueName: scheduleQueueName(config.queueName),
        redisUrl: config.redisUrl,
        logger: lateLogger,
        eventsQueueName: eventsQueue,
        events: eventBus,
      })
    : undefined;
  let eventConsumer: EventTriggerConsumer | undefined;
  let metricsSync: TwentyMetricsSync | undefined;
  let traceArchiveJob: TraceArchiveJob | undefined;
  let webhookQueue: BullWebhookDeliveryQueue | undefined;
  let webhookWorker: WebhookDeliveryWorker | undefined;
  // Skill Optimizer (MVP-3): the API enqueues runs, the worker role processes them. Manual only.
  const optimizerQueue = has('api') ? new BullOptimizerQueue(optimizerQueueName(config.queueName), config.redisUrl) : undefined;
  let optimizerWorker: OptimizerWorker | undefined;

  if (has('api')) {
    app = await buildServer(
      { db: dbHandle.db, queue, config, events: eventBus, twenty: twentyClientFromEnv(), ...(scheduler ? { scheduler } : {}), ...(optimizerQueue ? { optimizerQueue } : {}) },
      { logger: { level: config.logLevel } },
    );
    await app.listen({ host: config.host, port: config.port });
  }
  const log = app?.log ?? console;
  const logger: ProcessorLogger = { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) };
  consoleLogger = logger;

  if (has('worker')) {
    const providers = createProviderRegistry({
      anthropicApiKey: config.anthropicApiKey,
      geminiApiKey: config.geminiApiKey,
      geminiModel: config.geminiModel,
    });
    const processor = new RunProcessor(dbHandle.db, providers, logger);
    processor.router = modelRouter;
    processor.events = eventBus;
    processor.heartbeatMs = config.runHeartbeatMs;
    // A re-delivered stalled job only recovers its run with a heartbeat older than the reconciler's grace.
    processor.stallGraceMs = config.reconcileGraceMs;
    if (config.runHeartbeatMs === 0 || config.runHeartbeatMs * 2 > config.reconcileGraceMs) {
      logger.warn(
        { runHeartbeatMs: config.runHeartbeatMs, reconcileGraceMs: config.reconcileGraceMs },
        'RUN_HEARTBEAT_MS is off or too close to RECONCILE_GRACE_MS: long runs may be taken for orphans',
      );
    }
    worker = startBullWorker(processor, {
      queueName: config.queueName,
      redisUrl: config.redisUrl,
      concurrency: config.workerConcurrency,
      logger,
      concurrencyDeferMs: config.concurrencyDeferMs,
      stalledIntervalMs: config.stalledIntervalMs,
      maxStalledCount: config.maxStalledCount,
    });
    // Orphan recovery at boot and periodically.
    reconciler = new OrphanReconciler(dbHandle.db, queue, { graceMs: config.reconcileGraceMs, logger });
    reconciler.start(config.reconcileIntervalMs);
    logger.info({ queue: config.queueName, concurrency: config.workerConcurrency }, 'worker started');
    // Skill Optimizer: Gemini for its own calls and the experiment (executor + judge), an
    // in-memory CRM for the experiment and the real Twenty only for the promotion note.
    const optimizerTwenty = twentyClientFromEnv();
    optimizerWorker = new OptimizerWorker(dbHandle.db, {
      queueName: optimizerQueueName(config.queueName),
      redisUrl: config.redisUrl,
      logger,
      deps: () => {
        // Roles: optimizer (clustering + proposal), the Prospector's executor role and judge.
        // experimentRoutes refuses a judge equal to the executor (LLD §18) before the run starts.
        const optimizerRoute = modelRouter.resolve('optimizer');
        const prospector = desiredProspectorVersion();
        const routes = experimentRoutes(modelRouter, { model: prospector.model, modelProvider: prospector.modelProvider, configuration: prospector.configuration });
        return {
        db: dbHandle.db,
        llmProvider: providers(optimizerRoute.provider),
        executorProvider: providers(routes.executor.provider),
        judgeProvider: providers(routes.judge.provider),
        judgeModel: routes.judge.model,
        agentVersion: { model: routes.executor.model, configuration: prospector.configuration },
        routes,
        twenty: optimizerTwenty.isConfigured() ? optimizerTwenty : null,
        apiUrl: `http://127.0.0.1:${config.port}`,
        };
      },
    });
    await optimizerWorker.start();
    logger.info({ queue: optimizerQueueName(config.queueName) }, 'optimizer worker started');
  }

  if (has('scheduler') && scheduler) {
    scheduler.start({ syncIntervalMs: config.schedulerSyncIntervalMs });
    logger.info({ queue: scheduleQueueName(config.queueName) }, 'scheduler started');
    // Outbound webhooks (event_subscriptions): fan-out from the events consumer to the
    // {QUEUE_NAME}-webhooks queue, delivered with retries by a worker of this role.
    const webhooksQueue = webhooksQueueName(config.queueName);
    webhookQueue = new BullWebhookDeliveryQueue(webhooksQueue, config.redisUrl, { backoffMs: config.webhookDeliveryBackoffMs });
    webhookWorker = new WebhookDeliveryWorker(dbHandle.db, {
      queueName: webhooksQueue,
      redisUrl: config.redisUrl,
      allowPrivate: config.externalWebhookAllowPrivate,
      concurrency: config.webhookDeliveryConcurrency,
      timeoutMs: config.webhookDeliveryTimeoutMs,
      logger,
    });
    webhookWorker.start();
    // EVENT triggers + re-publisher of undispatched events live with the scheduler.
    eventConsumer = new EventTriggerConsumer(dbHandle.db, queue, scheduler, {
      queueName: eventsQueue,
      redisUrl: config.redisUrl,
      events: eventBus,
      maxChainDepth: config.eventChainMaxDepth,
      concurrency: config.eventConsumerConcurrency,
      logger,
      observers: [new WebhookDispatcher(dbHandle.db, webhookQueue, { logger })],
    });
    eventConsumer.start();
    eventBus.startRepublisher(config.eventRepublishIntervalMs);
    logger.info({ queue: eventsQueue, maxChainDepth: config.eventChainMaxDepth }, 'event consumer started');
    logger.info({ queue: webhooksQueue, allowPrivate: config.externalWebhookAllowPrivate.length }, 'event webhook delivery started');
    // Daily metrics -> Twenty (agentOsDailyMetric), for the native "Agent OS · Métricas" page.
    const syncSettings = metricsSyncSettingsFromEnv();
    if (syncSettings.enabled) {
      // The same tick also counts the PASS_FORM re-validations ready to run (log only, no Twenty field).
      metricsSync = new TwentyMetricsSync(dbHandle.db, twentyClientFromEnv(), {
        tenantId: config.defaultTenantId,
        days: syncSettings.days,
        logger,
        revalidations: () => countReadyRevalidations(dbHandle.db, config.defaultTenantId),
      });
      metricsSync.start(syncSettings.intervalMs);
      logger.info({ intervalMs: syncSettings.intervalMs, days: syncSettings.days }, 'metrics sync to Twenty started');
    }
    // Trace retention without loss (archiveTraces: export -> verify -> lighten), off by default.
    const archiveSettings = traceArchiveSettingsFromEnv();
    if (archiveSettings.enabled) {
      traceArchiveJob = new TraceArchiveJob(dbHandle.db, { olderThanDays: config.traceRetentionDays, archiveDir: config.traceArchiveDir, auditTenantId: config.defaultTenantId, logger });
      traceArchiveJob.start(archiveSettings.intervalMs);
      logger.info({ intervalMs: archiveSettings.intervalMs, olderThanDays: config.traceRetentionDays, archiveDir: config.traceArchiveDir }, 'scheduled trace archive started');
    }
  }

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    reconciler?.stop();
    await Promise.allSettled([app?.close(), worker?.close(), eventConsumer?.close(), webhookWorker?.close(), metricsSync?.stop(), optimizerWorker?.close(), traceArchiveJob?.stop()]);
    await Promise.allSettled([scheduler?.close(), eventBus.close(), queue.close(), webhookQueue?.close(), optimizerQueue?.close()]);
    await dbHandle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal', err);
  process.exit(1);
});
