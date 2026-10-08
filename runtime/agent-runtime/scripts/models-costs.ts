/**
 * pnpm models:costs [--tenant publiexpe] [--days 30] [--at 2027-01-01] [--json]
 *
 * Read-only. Table of roles -> current model (MODEL_ROUTE_* / legacy / code table) -> list
 * price today -> price on `--at` (default 2027-01-01, the gemini-3.6/3.7/3.8-flash increase),
 * and the cost of the last `--days` of real volume (agent executions, experiments, optimizer)
 * repriced with the current routing (src/metrics/model-costs.ts). To evaluate a change, run it
 * with the candidate route, e.g.:
 *
 *   MODEL_ROUTE_EXECUTOR_REASONER=gemini:gemini-3.5-flash-lite pnpm models:costs
 *
 * Same data as GET /metrics/model-costs.
 */
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { MODEL_COSTS_DEFAULT_DAYS, modelCostProjection, NEXT_PRICE_CHANGE, renderModelCosts } from '../src/metrics/model-costs.js';
import { defaultModelRouter, ModelRouteError } from '../src/providers/index.js';

const USAGE = 'uso: pnpm models:costs [--tenant publiexpe] [--days 30] [--at AAAA-MM-DD] [--json]';

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      days: { type: 'string', default: String(MODEL_COSTS_DEFAULT_DAYS) },
      at: { type: 'string', default: NEXT_PRICE_CHANGE },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) fail('--days debe ser un entero entre 1 y 366');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.at!)) fail('--at debe ser AAAA-MM-DD');
  let router;
  try {
    router = defaultModelRouter();
  } catch (err) {
    fail(err instanceof ModelRouteError ? err.message : String(err));
  }
  for (const w of router.warnings()) console.error(`aviso: ${w}`);
  const dbUrl = process.env.DATABASE_URL ?? fail('falta DATABASE_URL (cópiala a runtime/agent-runtime/.env)');
  const handle = createDb(dbUrl);
  try {
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000);
    const p = await modelCostProjection(handle.db, { tenantId: values.tenant!, since, until, router, at: values.at! });
    console.log(values.json ? JSON.stringify(p, null, 2) : renderModelCosts(p));
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
