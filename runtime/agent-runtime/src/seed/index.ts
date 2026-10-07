/**
 * `pnpm seed [--tenant=publiexpe] [--input=path/to/event.json]`
 *
 * Seeds the Prospector agent and its tasks `daily-event-prospecting` and
 * `weekly-event-scouting`, and the EmailDrafter agent with its task
 * `draft-email-on-validated`, and the BajasAgent with its task `process-unsubscribes`
 * (CRON every 2 hours; all idempotent).
 * The daily task default input is the demo fixture `test/fixtures/feria-ejemplo.json`
 * unless `--input` points to another file with the same shape.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProspectorInput } from '../agents/prospector-agent.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { seedBajas } from './bajas-seed.js';
import { seedEmailDrafter } from './email-drafter-seed.js';
import { seedProspector } from './prospector-seed.js';

/** Works from src/seed (tsx) and dist/seed (node). */
export const DEFAULT_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/feria-ejemplo.json');

export function loadSeedInput(file: string = DEFAULT_FIXTURE): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // Fail fast on an invalid fixture instead of discovering it at 08:00.
  ProspectorInput.parse(raw);
  return raw;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const config = loadConfig();
  const tenantId = arg('tenant') ?? config.defaultTenantId;
  const input = arg('input');
  const handle = createDb(config.databaseUrl);
  const log = (m: string) => console.log(`[seed] ${m}`);
  seedProspector(handle.db, {
    tenantId,
    defaultInput: loadSeedInput(input ? path.resolve(input) : DEFAULT_FIXTURE),
    log,
  })
    .then(async (prospector) => ({ prospector, emailDrafter: await seedEmailDrafter(handle.db, { tenantId, log }) }))
    .then(async (r) => ({ ...r, bajas: await seedBajas(handle.db, { tenantId, log }) }))
    .then((r) => console.log(JSON.stringify({ tenant: tenantId, ...r }, null, 2)))
    .catch((err: unknown) => {
      console.error('[seed] failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
