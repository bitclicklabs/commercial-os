import { z } from 'zod';
import { parseEventTypePrefixes } from './events/external.js';
import { DEFAULT_WEBHOOK_BACKOFF_MS, DEFAULT_WEBHOOK_TIMEOUT_MS } from './events/webhook-delivery.js';
import { parsePrivateAllowlist } from './events/webhook-target.js';
import { DEFAULT_CATCHUP_MAX_AGE_MS, DEFAULT_CATCHUP_MAX_SLOTS } from './scheduler/schedule.js';
import { parseSchedulerTenants } from './scheduler/tenant-allowlist.js';

const RuntimeRole = z.enum(['all', 'api', 'worker', 'scheduler']);
export type RuntimeRole = z.infer<typeof RuntimeRole>;

const ConfigSchema = z.object({
  role: RuntimeRole.default('all'),
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().positive().default(4020),
  logLevel: z.string().default('info'),
  databaseUrl: z.string().default('postgres://agentos:agentos_dev@127.0.0.1:5440/agentos'),
  redisUrl: z.string().default('redis://127.0.0.1:6391'),
  queueName: z.string().default('pxos-agent-runs'),
  workerConcurrency: z.coerce.number().int().positive().default(4),
  defaultTenantId: z.string().min(1).default('publiexpe'),
  defaultModelProvider: z.enum(['stub', 'anthropic', 'gemini']).default('stub'),
  anthropicApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  geminiModel: z.string().optional(),
  schedulerSyncIntervalMs: z.coerce.number().int().positive().default(60_000),
  /** `SCHEDULER_TENANTS` as given; resolved into `schedulerTenants` (default `[defaultTenantId]`, `*` = all). */
  schedulerTenantsRaw: z.string().optional(),
  /** Missed slots a CRON/INTERVAL task recovers after a stop (>= 1). */
  catchupMaxSlots: z.coerce.number().int().min(1).max(100).default(DEFAULT_CATCHUP_MAX_SLOTS),
  /** A missed slot older than this is skipped (the next natural slot rules). */
  catchupMaxAgeMs: z.coerce.number().int().positive().default(DEFAULT_CATCHUP_MAX_AGE_MS),
  reconcileIntervalMs: z.coerce.number().int().positive().default(60_000),
  reconcileGraceMs: z.coerce.number().int().nonnegative().default(120_000),
  /** TaskRun heartbeat (`updated_at`) while an attempt runs; keep it well below reconcileGraceMs. 0 = off. */
  runHeartbeatMs: z.coerce.number().int().nonnegative().default(30_000),
  concurrencyDeferMs: z.coerce.number().int().positive().default(2_000),
  stalledIntervalMs: z.coerce.number().int().positive().default(30_000),
  maxStalledCount: z.coerce.number().int().nonnegative().default(1),
  // Event bus (src/events/)
  eventChainMaxDepth: z.coerce.number().int().min(1).max(50).default(5),
  eventRepublishIntervalMs: z.coerce.number().int().positive().default(30_000),
  eventRepublishGraceMs: z.coerce.number().int().nonnegative().default(15_000),
  eventConsumerConcurrency: z.coerce.number().int().positive().default(4),
  /** Shared secret of the Twenty webhook (HMAC key and fallback URL/header secret). Unset = webhook disabled. */
  twentyWebhookSecret: z.string().min(16).optional(),
  /** Window in which an identical human verdict (subject, feedback, target status) is not recorded twice. */
  evaluationDedupeWindowMs: z.coerce.number().int().nonnegative().default(600_000),
  // External events (src/events/external.ts, webhook-delivery.ts; LLD v0.1 section 20)
  /** Bearer token of POST /events/external. Unset = ingestion disabled (503). */
  externalEventsToken: z.string().min(16).optional(),
  /** Allowed prefixes of external event types (comma separated). Default `ext.`. */
  externalEventTypePrefixes: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      try {
        return parseEventTypePrefixes(raw);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
  /** `host[:port]` entries an outbound webhook may target even if they resolve to a private IP. */
  externalWebhookAllowPrivate: z
    .string()
    .optional()
    .transform((raw) => parsePrivateAllowlist(raw)),
  webhookDeliveryTimeoutMs: z.coerce.number().int().positive().default(DEFAULT_WEBHOOK_TIMEOUT_MS),
  webhookDeliveryBackoffMs: z.coerce.number().int().positive().default(DEFAULT_WEBHOOK_BACKOFF_MS),
  webhookDeliveryConcurrency: z.coerce.number().int().positive().default(4),
  // Trace retention without loss (src/maintenance/trace-archive.ts, LLD v0.1 section 22)
  /** Age (days) from which `pnpm traces:archive` archives heavy step payloads. */
  traceRetentionDays: z.coerce.number().nonnegative().default(90),
  /** Where the archive files live (`<tenant>/<YYYY-MM>.jsonl.gz`); GET /traces/:id rehydrates from here. */
  traceArchiveDir: z.string().min(1).default('./data/trace-archive'),
}).transform((c, ctx) => {
  // SCHEDULER_TENANTS depends on DEFAULT_TENANT_ID, hence resolved after the field parse.
  try {
    return { ...c, schedulerTenants: parseSchedulerTenants(c.schedulerTenantsRaw, c.defaultTenantId) };
  } catch (err) {
    ctx.addIssue({ code: 'custom', path: ['schedulerTenantsRaw'], message: (err as Error).message });
    return z.NEVER;
  }
});

export type Config = z.infer<typeof ConfigSchema>;

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Reads configuration from the environment (and an optional `--role=` CLI flag). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): Config {
  const roleArg = argv.find((a) => a.startsWith('--role='))?.slice('--role='.length);
  return ConfigSchema.parse({
    role: emptyToUndefined(roleArg) ?? emptyToUndefined(env.RUNTIME_ROLE),
    host: emptyToUndefined(env.RUNTIME_HOST),
    port: emptyToUndefined(env.RUNTIME_PORT),
    logLevel: emptyToUndefined(env.LOG_LEVEL),
    databaseUrl: emptyToUndefined(env.DATABASE_URL),
    redisUrl: emptyToUndefined(env.REDIS_URL),
    queueName: emptyToUndefined(env.QUEUE_NAME),
    workerConcurrency: emptyToUndefined(env.WORKER_CONCURRENCY),
    defaultTenantId: emptyToUndefined(env.DEFAULT_TENANT_ID),
    defaultModelProvider: emptyToUndefined(env.DEFAULT_MODEL_PROVIDER),
    anthropicApiKey: emptyToUndefined(env.ANTHROPIC_API_KEY),
    geminiApiKey: emptyToUndefined(env.GEMINI_API_KEY),
    geminiModel: emptyToUndefined(env.GEMINI_MODEL),
    schedulerSyncIntervalMs: emptyToUndefined(env.SCHEDULER_SYNC_INTERVAL_MS),
    schedulerTenantsRaw: emptyToUndefined(env.SCHEDULER_TENANTS),
    catchupMaxSlots: emptyToUndefined(env.CATCHUP_MAX_SLOTS),
    catchupMaxAgeMs: emptyToUndefined(env.CATCHUP_MAX_AGE_MS),
    reconcileIntervalMs: emptyToUndefined(env.RECONCILE_INTERVAL_MS),
    reconcileGraceMs: emptyToUndefined(env.RECONCILE_GRACE_MS),
    runHeartbeatMs: emptyToUndefined(env.RUN_HEARTBEAT_MS),
    concurrencyDeferMs: emptyToUndefined(env.CONCURRENCY_DEFER_MS),
    stalledIntervalMs: emptyToUndefined(env.STALLED_INTERVAL_MS),
    maxStalledCount: emptyToUndefined(env.MAX_STALLED_COUNT),
    eventChainMaxDepth: emptyToUndefined(env.EVENT_CHAIN_MAX_DEPTH),
    eventRepublishIntervalMs: emptyToUndefined(env.EVENT_REPUBLISH_INTERVAL_MS),
    eventRepublishGraceMs: emptyToUndefined(env.EVENT_REPUBLISH_GRACE_MS),
    eventConsumerConcurrency: emptyToUndefined(env.EVENT_CONSUMER_CONCURRENCY),
    twentyWebhookSecret: emptyToUndefined(env.TWENTY_WEBHOOK_SECRET),
    evaluationDedupeWindowMs: emptyToUndefined(env.EVALUATION_DEDUPE_WINDOW_MS),
    externalEventsToken: emptyToUndefined(env.EXTERNAL_EVENTS_TOKEN),
    externalEventTypePrefixes: emptyToUndefined(env.EXTERNAL_EVENT_TYPE_PREFIXES),
    externalWebhookAllowPrivate: emptyToUndefined(env.EXTERNAL_WEBHOOK_ALLOW_PRIVATE),
    webhookDeliveryTimeoutMs: emptyToUndefined(env.WEBHOOK_DELIVERY_TIMEOUT_MS),
    webhookDeliveryBackoffMs: emptyToUndefined(env.WEBHOOK_DELIVERY_BACKOFF_MS),
    webhookDeliveryConcurrency: emptyToUndefined(env.WEBHOOK_DELIVERY_CONCURRENCY),
    traceRetentionDays: emptyToUndefined(env.TRACE_RETENTION_DAYS),
    traceArchiveDir: emptyToUndefined(env.TRACE_ARCHIVE_DIR),
  });
}
