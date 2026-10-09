/**
 * `pnpm seed [--tenant=publiexpe] [--input=path/to/event.json]`
 *

 * Seeds first the harness `default-commercial` (v1 ACTIVE with today's values if missing;
 * an existing harness is never touched), then the skills migrated from the code constants
 * (v1 ACTIVE if missing; existing skills are never touched), then the first knowledge entries
 * (ACTIVE, with evidence; existing domain/topic pairs are never touched), the DRAFT candidate of the
 * Prospector skill with real catalog products (never activated), then the Prospector
 * agent and its tasks `daily-event-prospecting` and
 * `weekly-event-scouting`, and the EmailDrafter agent with its task
 * `draft-email-on-validated`, the BajasAgent with its task `process-unsubscribes` (kept
 * DISABLED since the inbound triage) and the InboxAgent with its task `process-inbox` (CRON
 * every 2 hours; all idempotent).
 * The daily task default input is `{ mode: 'signals' }` (tanda 15: the fairs QUALIFIED in Twenty);
 * `--input` still accepts a direct-mode fixture (`{ event, exhibitors[] }`, e.g.
 * `test/fixtures/feria-ejemplo.json`) for a demo tenant.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProspectorInput } from '../agents/prospector-agent.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { seedBajas } from './bajas-seed.js';
import { seedCatalogSkillCandidate } from './catalog-skill-seed.js';
import { seedEmailDrafter } from './email-drafter-seed.js';
import { seedHarnesses } from './harness-seed.js';
import { seedInbox } from './inbox-seed.js';
import { seedKnowledge } from './knowledge-seed.js';
import { seedProspector } from './prospector-seed.js';
import { seedSkills } from './skills-seed.js';

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
  const defaultInput = input ? loadSeedInput(path.resolve(input)) : undefined;
  seedHarnesses(handle.db, { tenantId, log })
    .then(async (harness) => ({ harness, skills: await seedSkills(handle.db, { tenantId, log }) }))
    // Catalog (tanda 14): one DRAFT candidate of the Prospector skill with real products; never activated here.
    .then(async (acc) => ({ ...acc, catalogSkill: await seedCatalogSkillCandidate(handle.db, { tenantId, log }) }))
    .then(async (acc) => ({ ...acc, knowledge: await seedKnowledge(handle.db, { tenantId, log }) }))
    .then(async (r) => ({ ...r, prospector: await seedProspector(handle.db, { tenantId, ...(defaultInput ? { defaultInput } : {}), log }) }))
    .then(async (r) => ({ ...r, emailDrafter: await seedEmailDrafter(handle.db, { tenantId, log }) }))
    .then(async (r) => ({ ...r, bajas: await seedBajas(handle.db, { tenantId, log }) }))
    .then(async (r) => ({ ...r, inbox: await seedInbox(handle.db, { tenantId, log }) }))
    .then((r) => console.log(JSON.stringify({ tenant: tenantId, ...r }, null, 2)))
    .catch((err: unknown) => {
      console.error('[seed] failed', err);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
