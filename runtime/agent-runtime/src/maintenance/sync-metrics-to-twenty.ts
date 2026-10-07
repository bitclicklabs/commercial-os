/**
 * `pnpm metrics:sync-twenty [--days=30] [--tenant=publiexpe] [--dry-run]`
 *
 * One pass of the metrics sync (src/metrics/twenty-sync.ts): upserts one `agentOsDailyMetric`
 * per local day (Europe/Madrid) into Twenty, today included. Use it once after syncing the
 * Twenty App to backfill history (the scheduler then refreshes the last 2 days every 15 min
 * when METRICS_TWENTY_SYNC_ENABLED=true). Idempotent: re-running updates the same records.
 * `--dry-run` prints the records without calling Twenty. Nothing is deleted anywhere.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { twentyClientFromEnv } from '../integrations/twenty/index.js';
import { metricsSummary } from '../metrics/queries.js';
import { computeDailyMetric, TwentyMetricsSync, type SummaryFn } from '../metrics/twenty-sync.js';

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const config = loadConfig();
  const tenantId = arg('tenant') ?? config.defaultTenantId;
  const days = Math.min(366, Math.max(1, Number(arg('days') ?? 30) || 30));
  const dryRun = process.argv.includes('--dry-run');
  const handle = createDb(config.databaseUrl);
  const summary = ((w) => metricsSummary(handle.db, w)) as SummaryFn;
  const logger = { info: (o: object, m?: string) => console.log('[metrics-sync]', m ?? '', JSON.stringify(o)), warn: (o: object, m?: string) => console.warn('[metrics-sync]', m ?? '', JSON.stringify(o)) };
  const sync = new TwentyMetricsSync(handle.db, twentyClientFromEnv(), { tenantId, days, logger, summary });
  const job = dryRun
    ? Promise.all(sync.datesToSync().map((date) => computeDailyMetric(summary, { tenantId, date }))).then((records) => {
        for (const r of records) console.log(JSON.stringify(r));
        console.log(`[metrics-sync] dry-run: ${records.length} days for tenant ${tenantId}, nothing written`);
      })
    : sync.syncOnce().then((r) => {
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) process.exitCode = 1;
      });
  job
    .catch((err: unknown) => {
      console.error('[metrics-sync] failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
