/**
 * pnpm synth:build --dataset <nombre> --seed <n> [--difficulty 1,2,3] [--templates a,b]
 *                  [--per-template 2] [--with-harvest] [--domain prospeccion] [--tenant publiexpe]
 *                  [--description "..."] [--created-by "..."] [--dry-run] [--out <casos.json>] [--list]
 *
 * Synthetic environments (MVP-4, LLD v0.1 section 13): generates Prospector cases from the
 * parameterised templates of src/synthetic/templates.ts with a known ground truth (by
 * construction, never an LLM) and stores them as a NEW version of `--dataset`, DRAFT (a human
 * activates it: POST /datasets/:id/activate).
 *
 * - Same `--seed` (and filters) -> the same cases byte for byte. No model, no network.
 * - `--difficulty` filters by curriculum level (1-3: data plus traps). It is NOT the
 *   `difficulty` column of the cases, which keeps its meaning: level of the input data.
 * - Split SYNTH: the cases never enter the 50/25/25 split, are never burned by P5 and never
 *   count as labels for the Release Gate accuracy. `pnpm experiment:run --dataset <nombre>`
 *   runs them as the "synthetic sample" of VALIDATION.
 * - `--with-harvest`: MIXED dataset (the usual harvest + the synthetic cases). The origin is
 *   fixed per dataset name: a harvested dataset never receives synthetic cases.
 * - Exhibitors are invented and every domain is `.invalid`: they cannot be fetched and the
 *   Twenty client refuses to write them to a real CRM.
 * - Writes ONLY `evaluation_datasets` / `evaluation_cases` in DATABASE_URL (migration 0017).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { buildDataset, DatasetServiceError } from '../src/datasets/service.js';
import { DEFAULT_PER_TEMPLATE, MAX_PER_TEMPLATE } from '../src/synthetic/generate.js';
import { templateCatalog } from '../src/synthetic/templates.js';
import type { CurriculumLevel } from '../src/synthetic/truth.js';

const USAGE =
  'uso: pnpm synth:build --dataset <nombre> --seed <n> [--difficulty 1,2,3] [--templates a,b] [--per-template 2] [--with-harvest] [--domain prospeccion] [--tenant publiexpe] [--dry-run] [--out <casos.json>] [--list]';

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      dataset: { type: 'string' },
      seed: { type: 'string' },
      difficulty: { type: 'string' },
      templates: { type: 'string' },
      'per-template': { type: 'string' },
      'with-harvest': { type: 'boolean', default: false },
      domain: { type: 'string', default: 'prospeccion' },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      description: { type: 'string' },
      'created-by': { type: 'string', default: 'synth:build' },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.list) {
    for (const t of templateCatalog()) console.log(`nivel ${t.curriculum_level} · ${t.id.padEnd(26)} ${t.patterns.join(', ').padEnd(18)} ${t.expectation}`);
    return;
  }
  if (!values.dataset) fail('falta --dataset');
  if (values.seed === undefined || !/^\d+$/.test(values.seed)) fail('--seed debe ser un entero ≥ 0');
  const seed = Number(values.seed);
  const levels = values.difficulty
    ? values.difficulty.split(',').map((x) => {
        const n = Number(x.trim());
        if (![1, 2, 3].includes(n)) fail(`--difficulty: ${x} no es un nivel (1, 2 o 3)`);
        return n as CurriculumLevel;
      })
    : undefined;
  const perTemplate = values['per-template'] !== undefined ? Number(values['per-template']) : DEFAULT_PER_TEMPLATE;
  if (!Number.isInteger(perTemplate) || perTemplate < 1 || perTemplate > MAX_PER_TEMPLATE) fail(`--per-template debe estar entre 1 y ${MAX_PER_TEMPLATE}`);
  const templates = values.templates ? values.templates.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const target = process.env.DATABASE_URL;
  if (!target) fail('DATABASE_URL no está definida');
  const db = createDb(target);
  try {
    const r = await buildDataset(db.db, {
      tenantId: values.tenant!,
      name: values.dataset,
      domain: values.domain!,
      description: values.description ?? `Casos sintéticos (seed ${seed}${levels ? `, niveles ${levels.join(',')}` : ''})`,
      createdBy: values['created-by'] ?? null,
      dryRun: values['dry-run'],
      synthetic: { seed, perTemplate, ...(levels ? { levels } : {}), ...(templates ? { templates } : {}), withHarvest: values['with-harvest'] },
    });
    const g = r.synthetic!;
    const line = (label: string, rec: Record<string, number>) => console.log(`${label.padEnd(24)} ${Object.entries(rec).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`${values['dry-run'] ? '[dry-run] ' : ''}dataset ${values.dataset} v${r.version} · ${r.origin}${r.dataset ? ` (${r.dataset.id}, ${r.dataset.status}: actívalo con POST /datasets/${r.dataset.id}/activate)` : ''}`);
    console.log(`generador                ${g.generator} v${g.generator_version} · seed ${g.seed} · ${g.per_template} por plantilla`);
    console.log(`casos sintéticos         ${g.total} (split SYNTH)`);
    line('por nivel de curriculum', g.by_curriculum_level);
    line('por plantilla', g.by_template);
    line('por split (todo)', r.summary.by_split);
    console.log(`ferias ficticias         ${g.events.map((e) => `${e.name} (${e.source_url})`).join(' · ')}`);
    for (const w of r.warnings.slice(0, 20)) console.log(`aviso: ${w}`);
    if (values.out) {
      const path = resolve(values.out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ dataset: r.dataset, version: r.version, origin: r.origin, synthetic: g, cases: r.cases.filter((c) => c.split === 'SYNTH') }, null, 2)}\n`);
      console.log(`casos: ${path}`);
    }
  } catch (err) {
    if (err instanceof DatasetServiceError) fail(`${err.code}: ${err.message}`);
    throw err;
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
