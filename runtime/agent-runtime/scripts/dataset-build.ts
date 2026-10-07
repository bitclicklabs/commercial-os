/**
 * pnpm dataset:build [--name prospeccion-v1] [--domain prospeccion] [--tenant publiexpe]
 *                    [--description "..."] [--created-by "..."]
 *                    [--source-url <postgres>] [--dry-run] [--out <informe.json>]
 *
 * Harvests the real decisions and human verdicts and creates a NEW version of the dataset
 * (v1 if the name does not exist; v(n+1) otherwise). Never mutates an existing version.
 *
 * - Reads from `--source-url` (default DATABASE_URL) in a READ ONLY transaction.
 * - Writes ONLY `evaluation_datasets` / `evaluation_cases` in DATABASE_URL (migration 0010).
 * - `--dry-run`: harvest and plan, print the summary, write nothing.
 * - `--out`: also saves the summary and the planned cases as JSON (for the experiment doc).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { buildDataset } from '../src/datasets/service.js';

const USAGE = 'uso: pnpm dataset:build [--name prospeccion-v1] [--domain prospeccion] [--tenant publiexpe] [--source-url <postgres>] [--dry-run] [--out <informe.json>]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string', default: 'prospeccion-v1' },
      domain: { type: 'string', default: 'prospeccion' },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      description: { type: 'string' },
      'created-by': { type: 'string', default: 'dataset:build' },
      'source-url': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const target = process.env.DATABASE_URL;
  if (!target) {
    console.error('DATABASE_URL no está definida');
    console.error(USAGE);
    process.exit(2);
  }
  const db = createDb(target);
  const source = values['source-url'] && values['source-url'] !== target ? createDb(values['source-url']) : null;
  try {
    const r = await buildDataset(db.db, {
      tenantId: values.tenant!,
      name: values.name!,
      domain: values.domain!,
      description: values.description ?? null,
      createdBy: values['created-by'] ?? null,
      sourceDb: source?.db,
      dryRun: values['dry-run'],
    });
    const s = r.summary;
    const line = (label: string, rec: Record<string, number>) => console.log(`${label.padEnd(22)} ${Object.entries(rec).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`${values['dry-run'] ? '[dry-run] ' : ''}dataset ${values.name} v${r.version}${r.dataset ? ` (${r.dataset.id}, ${r.dataset.status})` : ''}`);
    console.log(`harvest                trazas ${r.harvest.traces} · decisiones ${r.harvest.decisions} · veredictos humanos ${r.harvest.human_verdicts} (de ${r.harvest.human_evaluations} evaluaciones humanas)`);
    console.log(`casos                  ${s.total} (${s.entities} entidades) · quemados ${s.burned} · forzados a TRAIN ${s.forced_train}`);
    line('por split', s.by_split);
    line('etiquetados por split', s.labeled_by_split);
    line('por tipo', s.by_kind);
    line('por nivel de datos', s.by_data_level);
    if (r.harvest.skipped_evaluations.length > 0) console.log(`evaluaciones omitidas  ${r.harvest.skipped_evaluations.map((e) => `${e.evaluation_id.slice(0, 8)} (${e.reason})`).join('; ')}`);
    for (const w of r.warnings.slice(0, 20)) console.log(`aviso: ${w}`);
    if (values.out) {
      const path = resolve(values.out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ dataset: r.dataset, version: r.version, summary: s, harvest: r.harvest, warnings: r.warnings, cases: r.cases }, null, 2)}\n`);
      console.log(`informe: ${path}`);
    }
  } finally {
    await db.close();
    await source?.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
