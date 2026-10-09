import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { EventPublisher } from '../events/event-bus.js';
import type { CatalogService } from '../integrations/catalog/index.js';
import type { TwentyClient } from '../integrations/twenty/index.js';
import type { OptimizerQueue } from '../optimizer/queue.js';
import type { OptimizerScheduleSettings } from '../optimizer/schedule-job.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { SchedulerControl } from '../scheduler/task-scheduler.js';

export interface ApiContext {
  db: Db;
  queue: RunQueue;
  config: Pick<Config, 'defaultTenantId' | 'defaultModelProvider'> &
    Partial<Pick<Config, 'geminiModel'>> &
    Partial<Pick<Config, 'twentyWebhookSecret' | 'evaluationDedupeWindowMs'>> &
    Partial<Pick<Config, 'externalEventsToken' | 'externalEventTypePrefixes' | 'externalWebhookAllowPrivate'>> &
    Partial<Pick<Config, 'traceArchiveDir'>>;
  /** Optional: when absent, schedule changes are only picked up by the scheduler's periodic sync. */
  scheduler?: SchedulerControl;
  /** Optional: when present, runs created through the API emit task.scheduled. */
  events?: EventPublisher;
  /** Optional: Twenty client of the email-ops guard (READY check). Without it the check is skipped and logged. */
  twenty?: TwentyClient;
  /** Optional: queue of the Skill Optimizer. Without it `POST /optimizer/skills/:name/run` answers 503. */
  optimizerQueue?: OptimizerQueue;
  /** Optional: settings shown by `GET /optimizer/schedule` (default: OPTIMIZER_SCHEDULE_* of this process). */
  optimizerSchedule?: OptimizerScheduleSettings;
  /** Optional: catalog service of GET /catalog/health; defaults to the process-wide one (CATALOG_* env). */
  catalog?: CatalogService;
}
