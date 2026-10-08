/**
 * pnpm experiment:run --subject skill:<nombre>|harness:<nombre> --candidate <v> [--skill <nombre>] [--dataset prospeccion-v1]
 *                     [--budget 0.30] [--judge-budget <eur>] [--repeat 2] [--form-sample auto|N|0]
 *                     [--test-on-form] [--min-delta 0.02] [--max-cost-ratio 1.25]
 *                     [--seesaw-tolerance 0] [--no-judge] [--judge-model gemini-pro-latest]
 *                     [--today AAAA-MM-DD] [--tenant publiexpe] [--created-by "<quién>"]
 *                     [--out-dir ../../docs/experimentos] [--dry-run]
 *
 * Automatic experiment (src/experiments/runner.ts): reserves the VALIDATION cases with P5
 * (markUsed; a contamination 409 aborts), runs the ACTIVE version (baseline) and the candidate
 * with Gemini on an in-memory CRM, evaluates them (RULEs + judge + composite), applies the
 * Release Gate and stores the experiment (table `experiments`) and its report
 * (`<out-dir>/EXP-NNN-auto/informe.md` and `.json`, plus the fixtures).
 *
 * - Never activates anything: activation is `POST /skills/:id/versions/:v/activate`, a human
 *   decision that the gate lets through only with PASS / PASS_FORM.
 * - Never writes to Twenty (FakeTwenty per run). Writes to DATABASE_URL: `experiments`,
 *   `evaluation_cases.used_by` (the P5 ledger) and `evaluations` (tenant `experiments`).
 * - `--subject harness:<nombre>`: baseline = the ACTIVE harness version, candidate = `--candidate`;
 *   every run injects the ACTIVE version of `--skill` (default prospector-event-exhibitors), fixed,
 *   and only the harness policies vary (timeout, retry, tool caps, max_output_tokens). Activation:
 *   `POST /harnesses/:id/versions/:v/activate`, same gate.
 * - `--dry-run`: shows the versions, the dataset and the cases it would reserve; writes nothing.
 * - Models by role (src/providers/model-router.ts): the executor is the Prospector's role
 *   (`MODEL_ROUTE_EXECUTOR_REASONER`, default its seed model) and the judge the `judge` role
 *   (`MODEL_ROUTE_JUDGE`; `--judge-model` wins, `provider:model` or a bare model). A judge equal
 *   to the executor stops the run before anything is created (exit 2).
 *
 * Dev-only tool (it imports the FakeTwenty test helper); not part of the runtime build.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfig } from '../src/agents/prospector-core.js';
import { createDb } from '../src/db/client.js';
import { listCases, listDatasets } from '../src/datasets/service.js';
import { autoFormSampleSize, DEFAULT_EUR_PER_DECISION, ExperimentAbortedError, gateConfig, renderExperimentMarkdown, reportToJson, runExperiment, type ExperimentReport } from '../src/experiments/index.js';
import { createProviderRegistry, defaultModelRouter, missingProviderKeys, ModelRouteError, parseModelSpec, routeAgentVersion, type ModelRoute } from '../src/providers/index.js';
import { findHarness, listHarnessVersions } from '../src/harness/service.js';
import { desiredProspectorVersion } from '../src/seed/prospector-seed.js';
import { COMPARABLE_SKILLS } from '../src/skills/compare.js';
import { findSkill, listVersions } from '../src/skills/service.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../src/tools/index.js';
import { FakeTwenty } from '../test/helpers/fake-twenty.js';

const USAGE =
  'uso: pnpm experiment:run --subject skill:<nombre>|harness:<nombre> --candidate <v> [--skill <nombre> (harness)] [--dataset prospeccion-v1] [--budget 0.30] [--judge-budget E] [--repeat 2] [--form-sample auto|N|0] [--test-on-form] [--min-delta 0.02] [--max-cost-ratio 1.25] [--seesaw-tolerance 0] [--no-judge] [--today AAAA-MM-DD] [--tenant publiexpe] [--created-by Q] [--out-dir DIR] [--dry-run]';
const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const numberArg = (v: string | undefined, name: string, fallback: number) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${name} debe ser un número`);
  return n;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      subject: { type: 'string' },
      candidate: { type: 'string' },
      skill: { type: 'string', default: COMPARABLE_SKILLS[0] },
      dataset: { type: 'string', default: 'prospeccion-v1' },
      budget: { type: 'string', default: '0.30' },
      'judge-budget': { type: 'string' },
      repeat: { type: 'string', default: '2' },
      'form-sample': { type: 'string', default: 'auto' },
      'test-on-form': { type: 'boolean', default: false },
      'min-delta': { type: 'string' },
      'max-cost-ratio': { type: 'string' },
      'seesaw-tolerance': { type: 'string' },
      'no-judge': { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
      today: { type: 'string' },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      'created-by': { type: 'string', default: 'experiment:run' },
      'out-dir': { type: 'string', default: resolve(RUNTIME_ROOT, '../../docs/experimentos') },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const m = /^(skill|harness):([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(values.subject ?? '');
  if (!m) fail('--subject debe ser skill:<nombre> o harness:<nombre> (p. ej. skill:prospector-event-exhibitors, harness:default-commercial)');
  const subjectType = m[1] as 'skill' | 'harness';
  const subjectName = m[2]!;
  const skillName = subjectType === 'harness' ? values.skill! : subjectName;
  const candidate = numberArg(values.candidate, '--candidate', NaN);
  if (!Number.isInteger(candidate) || candidate < 1) fail('--candidate debe ser un número de versión');
  const budget = numberArg(values.budget, '--budget', 0.3);
  if (!(budget > 0) || budget > 5) fail('--budget debe estar entre 0 y 5 €');
  const repeat = numberArg(values.repeat, '--repeat', 2);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) fail('--repeat debe estar entre 1 y 5');
  const formSample = values['form-sample'] === 'auto' ? 'auto' : numberArg(values['form-sample'], '--form-sample', 0);
  if (formSample !== 'auto' && (!Number.isInteger(formSample) || formSample < 0)) fail('--form-sample debe ser auto o un entero ≥ 0');
  if (values.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) fail('--today debe ser AAAA-MM-DD');
  const gate = gateConfig({
    ...(values['min-delta'] !== undefined ? { min_delta: numberArg(values['min-delta'], '--min-delta', 0.02) } : {}),
    ...(values['max-cost-ratio'] !== undefined ? { max_cost_ratio: numberArg(values['max-cost-ratio'], '--max-cost-ratio', 1.25) } : {}),
    ...(values['seesaw-tolerance'] !== undefined ? { seesaw: { tolerance: numberArg(values['seesaw-tolerance'], '--seesaw-tolerance', 0) } } : {}),
  });
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) fail('falta DATABASE_URL (cópiala a runtime/agent-runtime/.env)');
  const tenant = values.tenant!;
  const handle = createDb(dbUrl);

  try {
    if (values['dry-run']) {
      const skill = await findSkill(handle.db, tenant, skillName);
      if (!skill) fail(`la skill ${skillName} no existe en ${tenant}`);
      const skillVersions = await listVersions(handle.db, skill.id);
      const harness = subjectType === 'harness' ? await findHarness(handle.db, tenant, subjectName) : null;
      if (subjectType === 'harness' && !harness) fail(`la harness ${subjectName} no existe en ${tenant}`);
      const versions = harness ? await listHarnessVersions(handle.db, harness.id) : skillVersions;
      const active = versions.find((v) => v.status === 'ACTIVE');
      const fixedSkill = harness ? ` · skill fija ${skillName} v${skillVersions.find((v) => v.status === 'ACTIVE')?.version ?? '—'} (ACTIVE)` : '';
      const ds = (await listDatasets(handle.db, { tenantId: tenant, name: values.dataset! })).find((d) => d.status !== 'ARCHIVED');
      if (!ds) fail(`no hay dataset ${values.dataset} en ${tenant}`);
      const val = await listCases(handle.db, { tenantId: tenant, datasetId: ds.id, split: 'VALIDATION', role: 'validation' });
      const train = await listCases(handle.db, { tenantId: tenant, datasetId: ds.id, split: 'TRAIN', includeVetoed: true });
      const labeled = val.items.filter((c) => c.expected.kind !== 'unlabeled').length;
      const freeTrain = train.items.filter((c) => c.usedBy.length === 0).length;
      const judgeBudget = values['no-judge'] ? 0 : numberArg(values['judge-budget'], '--judge-budget', budget / 3);
      const auto = autoFormSampleSize(budget - judgeBudget, DEFAULT_EUR_PER_DECISION, repeat, val.items.length);
      console.log(
        [
          `simulación (no escribe nada) · ${subjectType} ${subjectName}: baseline v${active?.version ?? '—'} (ACTIVE) vs candidata v${candidate} (${versions.find((v) => v.version === candidate)?.status ?? 'no existe'})${fixedSkill}`,
          `dataset ${ds.name} v${ds.version} (${ds.status}) · VALIDATION utilizable: ${val.items.length} (${labeled} etiquetados; ${val.vetoed} vetados por P5)`,
          `modo del gate: ${labeled > 0 ? 'con etiquetas' : 'forma (PASS_FORM como mucho)'} · TRAIN sin quemar: ${freeTrain} · muestra de forma ${formSample === 'auto' ? `auto = ${labeled > 0 ? 0 : Math.min(auto, freeTrain)}` : formSample}`,
          `presupuesto ${budget} € (juez ${judgeBudget.toFixed(4)} €) · ${repeat} repetición(es)`,
        ].join('\n'),
      );
      return;
    }

    const agentVersion = desiredProspectorVersion();
    // Roles -> (provider, model); the judge must not be the executor (LLD §18).
    let executorRoute: ModelRoute;
    let judgeRoute: ModelRoute | null = null;
    try {
      const router = defaultModelRouter();
      for (const w of router.warnings()) console.error(`aviso: ${w}`);
      executorRoute = routeAgentVersion(router, agentVersion);
      if (!values['no-judge']) {
        const flag = values['judge-model'];
        judgeRoute = flag ? { role: 'judge', ...parseModelSpec(flag, '--judge-model'), source: 'env', env: '--judge-model' } : router.resolve('judge');
        router.assertJudgeIndependent(judgeRoute, executorRoute);
      }
    } catch (err) {
      if (err instanceof ModelRouteError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
    const missing = missingProviderKeys(judgeRoute ? [executorRoute, judgeRoute] : [executorRoute]);
    if (missing.length) fail(`${missing.join(', ')} no está definida (cópiala de deployments/.env a runtime/agent-runtime/.env)`);
    console.error(`· ejecutor ${executorRoute.provider}:${executorRoute.model} (rol ${executorRoute.role}, ${executorRoute.source})${judgeRoute ? ` · juez ${judgeRoute.provider}:${judgeRoute.model} (${judgeRoute.source})` : ' · sin juez'}`);
    const providers = createProviderRegistry({ geminiApiKey: process.env.GEMINI_API_KEY, anthropicApiKey: process.env.ANTHROPIC_API_KEY });
    const executor = providers(executorRoute.provider);
    const judge = judgeRoute ? providers(judgeRoute.provider) : null;
    const policy = parseToolPolicy(agentVersion.configuration);
    const fakes: FakeTwenty[] = [];
    // Harness arms pass the tool policy capped by their harness; skill arms use the agent's.
    const makeTools = (runLabel: string, toolPolicy?: ReturnType<typeof parseToolPolicy>) => {
      const fake = new FakeTwenty();
      fakes.push(fake);
      return new ToolExecutor(createDefaultToolRegistry({ twenty: fake.client() }), toolPolicy ?? policy, { tenantId: tenant, executionId: runLabel, agentId: 'experiment-run', stage: 'PROSPECTOR' }, new AbortController().signal);
    };
    const now = values.today ? () => new Date(`${values.today}T08:00:00Z`) : () => new Date();
    const controller = new AbortController();
    process.once('SIGINT', () => {
      console.error('cancelando… (el experimento queda CANCELLED)');
      controller.abort();
    });
    const outRoot = resolve(values['out-dir']!);
    const writeArtifacts = (report: ExperimentReport) => {
      const dir = join(outRoot, `${report.experiment.name}-auto`);
      mkdirSync(join(dir, 'fixtures'), { recursive: true });
      const fixturePaths: string[] = [];
      for (const p of report.phases)
        for (const f of p.fixtures) {
          const file = join(dir, 'fixtures', `${f.name.split('/').pop()}.json`);
          writeFileSync(file, `${JSON.stringify({ ...f.input, case_ids: f.case_ids }, null, 2)}\n`);
          fixturePaths.push(file);
        }
      writeFileSync(join(dir, 'informe.md'), renderExperimentMarkdown(report));
      writeFileSync(join(dir, 'informe.json'), `${JSON.stringify(reportToJson(report), null, 2)}\n`);
      const rel = (p: string) => relative(resolve(RUNTIME_ROOT, '../..'), p).replace(/\\/g, '/');
      console.error(`informe: ${join(dir, 'informe.md')}`);
      return { markdown: rel(join(dir, 'informe.md')), json: rel(join(dir, 'informe.json')), fixtures: fixturePaths.map(rel).join(',') };
    };

    const { experiment, report } = await runExperiment(
      {
        db: handle.db,
        executorProvider: executor,
        judgeProvider: judge,
        ...(judgeRoute ? { judgeModel: judgeRoute.model } : {}),
        routes: { executor: executorRoute, ...(judgeRoute ? { judge: judgeRoute } : {}) },
        makeTools,
        agentVersion: { model: executorRoute.model, configuration: agentVersion.configuration },
        now,
        onProgress: (msg) => console.error(`· ${msg}`),
        writeArtifacts,
        signal: controller.signal,
      },
      {
        tenantId: tenant,
        subjectType,
        subjectName,
        ...(subjectType === 'harness' ? { skillName } : {}),
        candidateVersion: candidate,
        dataset: values.dataset!,
        budgetEur: budget,
        ...(values['judge-budget'] !== undefined ? { judgeBudgetEur: numberArg(values['judge-budget'], '--judge-budget', budget / 3) } : {}),
        repeat,
        formSample,
        testOnForm: values['test-on-form']!,
        gate,
        judge: !values['no-judge'],
        createdBy: values['created-by']!,
      },
    );
    const crmWrites = fakes.reduce((n, f) => n + f.tables.companies.length + f.tables.commercialHypotheses.length, 0);
    console.log(`${experiment.name} ${experiment.status} · decisión ${experiment.decision} (${report.mode === 'form' ? 'modo forma' : 'con etiquetas'}) · ${report.cost.total_eur.toFixed(4)} € de ${budget} €`);
    console.log(report.summary);
    console.log(`Escrituras en el CRM en memoria (FakeTwenty): ${crmWrites}; en Twenty real: 0. Umbral de confianza del agente: ${readConfig(agentVersion.configuration).minConfidence}.`);
    if (experiment.decision !== 'PASS' && experiment.decision !== 'PASS_FORM') process.exitCode = 3;
  } catch (err) {
    if (err instanceof ExperimentAbortedError) {
      console.error(`${err.experiment?.name ?? 'experimento'} ${err.experiment?.status ?? 'no creado'} (${err.code}): ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2).slice(0, 2000));
      process.exitCode = err.code === 'invalid' ? 2 : 4;
      return;
    }
    throw err;
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
