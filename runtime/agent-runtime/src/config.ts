import { z } from 'zod';

const RuntimeRole = z.enum(['all', 'api', 'worker']);
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
  defaultModelProvider: z.enum(['stub', 'anthropic']).default('stub'),
  anthropicApiKey: z.string().optional(),
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
  });
}
