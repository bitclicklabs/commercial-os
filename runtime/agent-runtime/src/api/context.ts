import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { RunQueue } from '../queue/run-queue.js';

export interface ApiContext {
  db: Db;
  queue: RunQueue;
  config: Pick<Config, 'defaultTenantId' | 'defaultModelProvider'> & Partial<Pick<Config, 'geminiModel'>>;
}
