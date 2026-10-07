/**
 * pnpm evaluate -- --input <informe skill:compare .json | trace_id>
 *                  [--tenant experiments] [--trace-tenant publiexpe] [--no-judge] [--judge-model gemini-pro-latest]
 *                  [--judge-max-cost-eur 0.10] [--judge-batch 20] [--no-persist]
 *                  [--min-confidence 0.5] [--out <prefijo>] [--provider gemini|stub]
 *
 * Runs the automatic evaluation pipeline (RULEs -> LLM judge -> COMPOSITE) over the output
 * of an execution (trace id or execution id, read from the database) or of a skill
 * comparison (the JSON `pnpm skill:compare --out` writes), prints the report and stores
 * every evaluation in `evaluations` (idempotent).
 *
 * - Tenant: `experiments` by default (PM decision): automatic evaluations of offline runs
 *   never mix with the human verdicts of `publiexpe`. A trace is READ from `--trace-tenant` (default
 *   DEFAULT_TENANT_ID or publiexpe) and its evaluations are WRITTEN to `--tenant`.
 * - The judge is a model DIFFERENT from the executor (JUDGE_MODEL, default
 *   gemini-pro-latest) and never spends more than `--judge-max-cost-eur`.
 * - Judge notes already stored for the same output and judge version are reused (a re-run
 *   costs nothing and stores nothing new).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDb, type DbHandle } from '../src/db/client.js';
import {
  contentHashOf,
  DEFAULT_EXPERIMENTS_TENANT,
  defaultEvaluators,
  JudgeBudgetProvider,
  loadJudgeCache,
  persistEvaluations,
  renderEvaluationMarkdown,
  runEvaluationPipeline,
  subjectsFromComparison,
  subjectsFromTrace,
  type LoadedSubjects,
  type PipelineReport,
} from '../src/evaluators/index.js';
import { DEFAULT_USD_TO_EUR, GeminiProvider, StubProvider, type ModelProvider } from '../src/providers/index.js';

const USAGE =
  'uso: pnpm evaluate -- --input <informe.json | trace_id> [--tenant experiments] [--trace-tenant publiexpe] [--no-judge] [--judge-model M] [--judge-max-cost-eur 0.10] [--judge-batch 20] [--no-persist] [--min-confidence 0.5] [--out <prefijo>]';

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

/** JSON-friendly report (Maps -> arrays). */
export function reportToJson(r: PipelineReport): unknown {
  return {
    ...r,
    subjects: r.subjects.map((s) => ({
      subject: { ...s.subject, cases: s.subject.cases.map((c) => ({ id: c.id, dataLevel: c.input.dataLevel })) },
      composite: s.composite,
      evaluators: s.evaluators.map((e) => ({ ...e, cases: [...e.cases].map(([id, c]) => ({ case: id, ...c })) })),
    })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      input: { type: 'string' },
      tenant: { type: 'string', default: DEFAULT_EXPERIMENTS_TENANT },
      'trace-tenant': { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      'no-judge': { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
      'judge-max-cost-eur': { type: 'string', default: '0.10' },
      'judge-batch': { type: 'string', default: '20' },
      'no-persist': { type: 'boolean', default: false },
      'min-confidence': { type: 'string', default: '0.5' },
      out: { type: 'string' },
      provider: { type: 'string', default: 'gemini' },
    },
  });
  if (!values.input) fail('falta --input');
  const tenant = values.tenant!;
  const maxEur = Number(values['judge-max-cost-eur']);
  if (!(maxEur >= 0)) fail('--judge-max-cost-eur no válido');
  const isFile = /\.json$/i.test(values.input);
  const needsDb = !values['no-persist'] || !isFile;
  const dbUrl = process.env.DATABASE_URL;
  if (needsDb && !dbUrl) fail('falta DATABASE_URL (o usa --no-persist con un informe .json)');
  const handle: DbHandle | null = needsDb ? createDb(dbUrl!) : null;

  try {
    let loaded: LoadedSubjects;
    if (isFile) {
      const path = resolve(values.input);
      loaded = subjectsFromComparison(JSON.parse(readFileSync(path, 'utf8')), values.input, { baseDir: dirname(path), minConfidence: Number(values['min-confidence']) });
    } else {
      loaded = await subjectsFromTrace(handle!.db, values['trace-tenant']!, values.input);
    }
    for (const w of loaded.warnings) console.error(`aviso: ${w}`);

    let budget: JudgeBudgetProvider | undefined;
    let judgeProvider: ModelProvider | undefined;
    if (!values['no-judge']) {
      const inner = values.provider === 'stub' ? new StubProvider() : new GeminiProvider();
      budget = new JudgeBudgetProvider(inner, maxEur, DEFAULT_USD_TO_EUR);
      judgeProvider = budget;
    }
    const ev = defaultEvaluators({
      ...(judgeProvider ? { judgeProvider } : {}),
      ...(values['judge-model'] ? { judgeModel: values['judge-model'] } : {}),
      judgeMaxItemsPerCall: Number(values['judge-batch']),
    });
    const judgeCache = handle && ev.judges.length
      ? await loadJudgeCache(handle.db, tenant, loaded.subjects, ev.judges.map((j) => ({ id: j.id, version: j.version, contentHash: contentHashOf(j) })))
      : undefined;

    const report = await runEvaluationPipeline(loaded.subjects, {
      rules: ev.rules,
      judges: ev.judges,
      composite: ev.composite,
      ...(budget ? { budget } : {}),
      ...(judgeCache ? { judgeCache } : {}),
      onProgress: (m) => console.error(`· ${m}`),
    });
    report.warnings.unshift(...loaded.warnings);

    const md = renderEvaluationMarkdown(report, `Evaluación automática · ${loaded.source.kind === 'comparison' ? values.input : `traza ${loaded.source.ref}`}`);
    console.log(md);

    if (handle && !values['no-persist']) {
      const p = await persistEvaluations(handle.db, report, tenant);
      console.error(`evaluations (tenant ${tenant}): ${p.inserted} filas nuevas, ${p.existing} ya existían (de ${p.rows}).`);
    }
    if (values.out) {
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(`${values.out}.md`, `${md}\n`);
      writeFileSync(`${values.out}.json`, `${JSON.stringify(reportToJson(report), null, 2)}\n`);
      console.error(`informe: ${values.out}.md y ${values.out}.json`);
    }
  } finally {
    await handle?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
