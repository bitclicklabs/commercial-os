import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { SchedulerControl } from '../scheduler/task-scheduler.js';

export interface ApiContext {
  db: Db;
  queue: RunQueue;
  config: Pick<Config, 'defaultTenantId' | 'defaultModelProvider'>;
  /** Optional: when absent, schedule changes are only picked up by the scheduler's periodic sync. */
  scheduler?: SchedulerControl;
}
