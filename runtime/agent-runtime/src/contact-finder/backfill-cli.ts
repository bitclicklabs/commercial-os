/**
 * `pnpm contacts:backfill [--limit=25] [--tenant=publiexpe] [--force] [--dry-run]`
 *
 * Queues one ContactFinder run (task `find-contact`) per VALIDATED hypothesis of the tenant
 * whose `emailTo` is empty (src/contact-finder/backfill.ts). The worker runs them: each one
 * reads the company's own web, fills an EMPTY `emailTo` and leaves a Research "Contacto — …"
 * with the sources. Needs DATABASE_URL, REDIS_URL and TWENTY_API_KEY (same .env as the
 * runtime). `--dry-run` only lists what would be queued. Nothing is sent and nothing deleted.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { twentyClientFromEnv } from '../integrations/twenty/index.js';
import { BullRunQueue } from '../queue/run-queue.js';
import { BACKFILL_DEFAULT_LIMIT, runContactBackfill } from './backfill.js';

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const config = loadConfig();
  const tenantId = arg('tenant') ?? config.defaultTenantId;
  const limitArg = arg('limit');
  const limit = limitArg !== undefined ? Number(limitArg) : BACKFILL_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`[contacts:backfill] --limit debe ser un entero >= 1 (recibido: ${limitArg})`);
    process.exit(2);
  }
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  const handle = createDb(config.databaseUrl);
  const queue = new BullRunQueue(config.queueName, config.redisUrl);
  const run = async () => {
    // The queue does not buffer offline: wait until Redis answers (the reconciler would enqueue later anyway).
    for (let i = 0; i < 10 && !dryRun; i++) {
      try {
        await queue.getJobState('contacts-backfill-ping');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const result = await runContactBackfill({ db: handle.db, queue, twenty: twentyClientFromEnv() }, { tenantId, limit, force, dryRun });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      `[contacts:backfill] ${dryRun ? 'se encolarían' : 'encoladas'} ${result.queued.length} búsquedas (${result.eligible} elegibles, ${result.skipped.length} omitidas, ${result.remaining} pendientes para otra pasada) de ${result.scanned} hipótesis VALIDATED del tenant ${tenantId}.`,
    );
  };
  run()
    .catch((err: unknown) => {
      console.error('[contacts:backfill] failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await queue.close().catch(() => undefined);
      await handle.close();
    });
}
