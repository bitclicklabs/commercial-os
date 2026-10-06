import type { Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createProviderRegistry } from './providers/index.js';
import { BullRunQueue } from './queue/run-queue.js';
import { startBullWorker } from './worker/bull-worker.js';
import { RunProcessor } from './worker/processor.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const dbHandle = createDb(config.databaseUrl);
  const queue = new BullRunQueue(config.queueName, config.redisUrl);

  let app: FastifyInstance | undefined;
  let worker: Worker | undefined;

  if (config.role === 'all' || config.role === 'api') {
    app = await buildServer(
      { db: dbHandle.db, queue, config },
      { logger: { level: config.logLevel } },
    );
    await app.listen({ host: config.host, port: config.port });
  }

  if (config.role === 'all' || config.role === 'worker') {
    const logger = app?.log ?? console;
    const processor = new RunProcessor(dbHandle.db, createProviderRegistry({ anthropicApiKey: config.anthropicApiKey }), {
      info: (o, m) => logger.info(o, m),
      warn: (o, m) => logger.warn(o, m),
      error: (o, m) => logger.error(o, m),
    });
    worker = startBullWorker(processor, {
      queueName: config.queueName,
      redisUrl: config.redisUrl,
      concurrency: config.workerConcurrency,
      logger: { info: (o, m) => logger.info(o, m), warn: (o, m) => logger.warn(o, m), error: (o, m) => logger.error(o, m) },
    });
    logger.info({ queue: config.queueName, concurrency: config.workerConcurrency }, 'worker started');
  }

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    await Promise.allSettled([app?.close(), worker?.close(), queue.close()]);
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
