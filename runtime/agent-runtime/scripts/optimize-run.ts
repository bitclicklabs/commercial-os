/**
 * pnpm optimize:run --skill <nombre> [--dataset prospeccion-v1] [--budget 0.30] [--llm-budget 0.05]
 *                   [--repeat 2] [--min-labeled 5] [--min-failures 3] [--today AAAA-MM-DD]
 *                   [--tenant publiexpe] [--created-by "<quién>"] [--no-judge] [--no-note] [--dry-run]
 *
 * Skill Optimizer run in this process (src/optimizer/pipeline.ts), the same pipeline the worker
 * runs for `POST /optimizer/skills/:name/run`: harvest of production failures of the ACTIVE
 * version, clustering and candidate proposal with Gemini (edit-ops with the 35 % / 50 %
 * ceilings, DRAFT version), new dataset version with the failure entities burned as design
 * (P5), experiment ACTIVE vs candidate (`pnpm experiment:run` path, in-memory CRM) and Release
 * Gate. With PASS / PASS_FORM it leaves the note "Propuesta de promoción — <skill> v<N>" in
 * Twenty (unless --no-note). It NEVER activates the candidate.
 *
 * - `--dry-run`: harvest + data check only (failures found, fresh labelled VALIDATION cases).
 *   Writes nothing and calls no model.
 * - Exit code: 0 GATE_PASS, 3 GATE_FAIL, 4 BLOCKED_NO_DATA, 1 ERROR, 2 invalid arguments.
 */
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { buildDataset } from '../src/datasets/service.js';
import { twentyClientFromEnv } from '../src/integrations/twenty/index.js';
import { createRun, dataCheck, harvestFailures, optimizerConfig, OPTIMIZABLE_SKILLS, runLabel, runOptimization, selectFailures, type OptimizerConfig } from '../src/optimizer/index.js';
import { GeminiProvider } from '../src/providers/index.js';
import { findSkill, listVersions } from '../src/skills/service.js';

const USAGE =
  'uso: pnpm optimize:run --skill <nombre> [--dataset prospeccion-v1] [--budget 0.30] [--llm-budget 0.05] [--repeat 2] [--min-labeled 5] [--min-failures 3] [--today AAAA-MM-DD] [--tenant publiexpe] [--created-by Q] [--no-judge] [--no-note] [--dry-run]';

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const numberArg = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`${name} debe ser un número`);
  return n;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      skill: { type: 'string' },
      dataset: { type: 'string' },
      budget: { type: 'string' },
      'llm-budget': { type: 'string' },
      repeat: { type: 'string' },
      'min-labeled': { type: 'string' },
      'min-failures': { type: 'string' },
      today: { type: 'string' },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      'created-by': { type: 'string', default: 'optimize:run' },
      'no-judge': { type: 'boolean', default: false },
      'no-note': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const skillName = values.skill ?? fail('falta --skill');
  if (!OPTIMIZABLE_SKILLS[skillName]) fail(`no hay optimizador para la skill "${skillName}" (soportadas: ${Object.keys(OPTIMIZABLE_SKILLS).join(', ')})`);
  let cfg: OptimizerConfig;
  try {
    const n = (k: string, name: string) => numberArg(values[k as keyof typeof values] as string | undefined, name);
    const o: Partial<OptimizerConfig> = {};
    if (values.dataset) o.datasetName = values.dataset;
    if (values.budget !== undefined) o.experimentBudgetEur = n('budget', '--budget')!;
    if (values['llm-budget'] !== undefined) o.llmBudgetEur = n('llm-budget', '--llm-budget')!;
    if (values.repeat !== undefined) o.repeat = n('repeat', '--repeat')!;
    if (values['min-labeled'] !== undefined) o.minLabeledValidation = n('min-labeled', '--min-labeled')!;
    if (values['min-failures'] !== undefined) o.minFailures = n('min-failures', '--min-failures')!;
    if (values.today !== undefined) o.today = values.today;
    if (process.env.GEMINI_MODEL) o.model = process.env.GEMINI_MODEL;
    cfg = optimizerConfig(skillName, o);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const dbUrl = process.env.DATABASE_URL ?? fail('falta DATABASE_URL (cópiala a runtime/agent-runtime/.env)');
  const tenant = values.tenant!;
  const handle = createDb(dbUrl);
  try {
    const skill = await findSkill(handle.db, tenant, skillName);
    if (!skill) fail(`la skill ${skillName} no existe en ${tenant}`);
    const active = (await listVersions(handle.db, skill.id)).find((v) => v.status === 'ACTIVE');
    if (!active) fail(`la skill ${skillName} no tiene versión ACTIVE`);

    if (values['dry-run']) {
      const harvest = await harvestFailures(handle.db, { tenantId: tenant, skillName, version: active.version, maxTraces: cfg.maxTraces });
      const failures = selectFailures(harvest.failures, cfg.maxFailures);
      const dry = await buildDataset(handle.db, { tenantId: tenant, name: cfg.datasetName, domain: cfg.domain, dryRun: true });
      const check = dataCheck(dry.cases, new Set(failures.map((f) => f.entityKey)), cfg.minLabeledValidation, `${cfg.datasetName} v${dry.version} (simulación)`);
      console.log(
        [
          `simulación (no escribe nada, no llama a ningún modelo) · ${skillName} v${active.version} (ACTIVE)`,
          `fallos: ${harvest.failures.length} (${harvest.stats.human_failures} veredictos humanos negativos de ${harvest.stats.human_verdicts}; ${harvest.stats.rule_failures} fallos de reglas duras en ${harvest.stats.traces_checked} trazas) · se usarían ${failures.length} (mínimo ${cfg.minFailures})`,
          ...failures.slice(0, 15).map((f) => `  ${f.id} ${f.kind} · ${f.exhibitor.name}${f.evaluator ? ` · ${f.evaluator}` : ''}`),
          check.message,
          `veredicto previsto: ${failures.length < cfg.minFailures || !check.ok ? 'BLOCKED_NO_DATA' : 'el pipeline seguiría (clustering, candidata, experimento)'}`,
        ].join('\n'),
      );
      return;
    }

    if (!process.env.GEMINI_API_KEY) fail('GEMINI_API_KEY no está definida (cópiala de deployments/.env a runtime/agent-runtime/.env)');
    const gemini = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY });
    const twenty = values['no-note'] ? null : twentyClientFromEnv();
    const run = await createRun(handle.db, { tenantId: tenant, skillName, baseVersion: active.version, config: cfg as unknown as Record<string, unknown>, createdBy: values['created-by']! });
    console.error(`run ${run.id} (${runLabel(run.id)}) creado: ${skillName} v${active.version}`);
    const controller = new AbortController();
    process.once('SIGINT', () => {
      console.error('cancelando… (el run queda en ERROR)');
      controller.abort();
    });
    const done = await runOptimization(
      {
        db: handle.db,
        llmProvider: gemini,
        executorProvider: gemini,
        judgeProvider: values['no-judge'] ? null : gemini,
        twenty: twenty && twenty.isConfigured() ? twenty : null,
        onProgress: (msg) => console.error(`· ${msg}`),
        signal: controller.signal,
      },
      tenant,
      run.id,
    );
    console.log(`${runLabel(done.id)} ${done.status}${done.verdict ? ` · gate ${done.verdict}` : ''}${done.candidateVersion ? ` · candidata v${done.candidateVersion} (DRAFT, sin activar)` : ''} · ${Number(done.costEur).toFixed(4)} €`);
    if (done.error) console.log(done.error);
    const note = (done.details as { note?: Record<string, unknown> }).note;
    if (note) console.log(`nota en Twenty: ${JSON.stringify(note)}`);
    if (done.status === 'GATE_PASS') console.log(`Activar es decisión humana y pasa por el Release Gate: POST /skills/${skillName}/versions/${done.candidateVersion}/activate`);
    process.exitCode = done.status === 'GATE_PASS' ? 0 : done.status === 'GATE_FAIL' ? 3 : done.status === 'BLOCKED_NO_DATA' ? 4 : 1;
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
