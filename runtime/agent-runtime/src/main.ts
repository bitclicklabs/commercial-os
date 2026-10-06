import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createProviderRegistry } from './providers/index.js';
import { BullRunQueue } from './queue/run-queue.js';
import { BullTaskScheduler, scheduleQueueName } from './scheduler/task-scheduler.js';
import { startBullWorker } from './worker/bull-worker.js';
import { RunProcessor, type ProcessorLogger } from './worker/processor.js';
import { OrphanReconciler } from './worker/recovery.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const dbHandle = createDb(config.databaseUrl);
  const queue = new BullRunQueue(config.queueName, config.redisUrl);
  const has = (...roles: string[]) => config.role === 'all' || roles.includes(config.role);

  let app: FastifyInstance | undefined;
  let worker: Worker | undefined;
  let reconciler: OrphanReconciler | undefined;
  let consoleLogger: ProcessorLogger = console;

  // Registration control (API hooks) and tick processing (scheduler role) share one class.
  const scheduler = has('api', 'scheduler')
    ? new BullTaskScheduler(dbHandle.db, queue, {
        queueName: scheduleQueueName(config.queueName),
        redisUrl: config.redisUrl,
        logger: { info: (o, m) => consoleLogger.info(o, m), warn: (o, m) => consoleLogger.warn(o, m), error: (o, m) => consoleLogger.error(o, m) },
      })
    : undefined;

  if (has('api')) {
    app = await buildServer({ db: dbHandle.db, queue, config, ...(scheduler ? { scheduler } : {}) }, { logger: { level: config.logLevel } });
    await app.listen({ host: config.host, port: config.port });
  }
  const log = app?.log ?? console;
  const logger: ProcessorLogger = { info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m) };
  consoleLogger = logger;

  if (has('worker')) {
    const processor = new RunProcessor(dbHandle.db, createProviderRegistry({ anthropicApiKey: config.anthropicApiKey }), logger);
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
  }

  if (has('scheduler') && scheduler) {
    scheduler.start({ syncIntervalMs: config.schedulerSyncIntervalMs });
    logger.info({ queue: scheduleQueueName(config.queueName) }, 'scheduler started');
  }

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    reconciler?.stop();
    await Promise.allSettled([app?.close(), worker?.close(), scheduler?.close(), queue.close()]);
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
