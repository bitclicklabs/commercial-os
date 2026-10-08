/**
 * pnpm skill:compare <skill> --versions a,b --fixture <ruta> [--fixture <ruta>...]
 *                    [--repeat N] [--max-cost-eur 0.15] [--today AAAA-MM-DD]
 *                    [--api http://127.0.0.1:4020] [--tenant publiexpe] [--out <prefijo>]
 *                    [--provider gemini|stub]
 * pnpm skill:compare --rerender <informe.json> [--out <prefijo>]
 *
 * `--rerender` recomputes the metrics of a saved comparison and writes the report again
 * without calling the model (to refine a measurement; the runs are not changed).
 *
 * Runs the SAME input with two versions of a skill (real provider; Gemini by default) and
 * prints the comparison: side by side, structured differences, tokens and cost per version.
 *
 * - Versions are read from the runtime API (GET /skills/:id): read only. No version is
 *   activated or modified.
 * - The CRM is an in-memory FakeTwenty, a fresh one per run: nothing is written to Twenty.
 * - P5: the fixtures must NOT contain the traces used to design the candidate. This tool
 *   cannot check it; the experiment document must say which data designed the change and
 *   which data validates it.
 *
 * Dev-only tool (it imports the FakeTwenty test helper); not part of the runtime build.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createProviderRegistry, defaultModelRouter, missingProviderKeys, ModelRouteError, routeAgentVersion, StubProvider, type ModelProvider } from '../src/providers/index.js';
import { desiredProspectorVersion } from '../src/seed/prospector-seed.js';
import { BudgetGuardProvider, rebuildReport, renderComparisonMarkdown, runSkillComparison, type CompareVersion, type ComparisonReport } from '../src/skills/compare.js';
import { renderSkill } from '../src/skills/render.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../src/tools/index.js';
import { readConfig } from '../src/agents/prospector-core.js';
import { FakeTwenty } from '../test/helpers/fake-twenty.js';

interface ApiVersion {
  id: string;
  version: number;
  status: string;
  instructions: string;
  constraints: string | null;
  examples: unknown[] | null;
  anti_patterns: string | null;
  content_hash: string;
}

const USAGE = 'uso: pnpm skill:compare <skill> --versions a,b --fixture <ruta> [--fixture <ruta>] [--repeat N] [--max-cost-eur 0.15] [--today AAAA-MM-DD] [--out <prefijo>]';

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

async function fetchVersions(api: string, tenant: string, skill: string, wanted: number[]): Promise<CompareVersion[]> {
  const res = await fetch(`${api.replace(/\/$/, '')}/skills/${encodeURIComponent(skill)}`, { headers: { 'x-tenant-id': tenant } });
  if (!res.ok) throw new Error(`GET /skills/${skill} respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { versions: ApiVersion[] };
  return wanted.map((n) => {
    const v = body.versions.find((x) => x.version === n);
    if (!v) throw new Error(`la skill ${skill} no tiene versión ${n} (hay: ${body.versions.map((x) => x.version).join(', ')})`);
    const text = renderSkill({ instructions: v.instructions, constraints: v.constraints, examples: v.examples, antiPatterns: v.anti_patterns });
    return { version: v.version, status: v.status, skillVersionId: v.id, text, contentHash: v.content_hash };
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      versions: { type: 'string' },
      fixture: { type: 'string', multiple: true },
      repeat: { type: 'string', default: '1' },
      'max-cost-eur': { type: 'string', default: '0.15' },
      today: { type: 'string' },
      api: { type: 'string', default: process.env.RUNTIME_API_URL ?? 'http://127.0.0.1:4020' },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      out: { type: 'string' },
      provider: { type: 'string', default: 'gemini' },
      rerender: { type: 'string' },
    },
  });
  if (values.rerender) {
    const saved = JSON.parse(readFileSync(resolve(values.rerender), 'utf8')) as SavedComparison;
    const reports = saved.reports.map(({ fixture, report }) => ({ fixture, report: rebuildReport(report) }));
    const prefix = values.out ?? values.rerender.replace(/\.json$/, '');
    writeOutputs({ ...saved, reports }, reports, prefix, `${saved.crm_writes ?? 'n/d'}`);
    return;
  }
  const skill = positionals[0];
  if (!skill) fail('falta el nombre de la skill');
  const versions = (values.versions ?? '').split(',').map((s) => Number(s.trim()));
  if (versions.length !== 2 || versions.some((n) => !Number.isInteger(n) || n < 1) || versions[0] === versions[1]) fail('--versions necesita dos versiones distintas, p. ej. --versions 1,2');
  const fixtures = values.fixture ?? [];
  if (fixtures.length === 0) fail('falta --fixture');
  const maxCostEur = Number(values['max-cost-eur']);
  if (!Number.isFinite(maxCostEur) || maxCostEur <= 0) fail('--max-cost-eur debe ser un número positivo');
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) fail('--repeat debe estar entre 1 y 5');
  const today = values.today;
  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) fail('--today debe ser AAAA-MM-DD');

  const agentVersion = desiredProspectorVersion();
  let provider: ModelProvider;
  let model = agentVersion.model;
  if (values.provider === 'gemini') {
    // Real runs: the Prospector's role in the model router (MODEL_ROUTE_EXECUTOR_REASONER, default its seed model).
    let route;
    try {
      route = routeAgentVersion(defaultModelRouter(), agentVersion);
    } catch (err) {
      fail(err instanceof ModelRouteError ? err.message : String(err));
    }
    const missing = missingProviderKeys([route]);
    if (missing.length) fail(`${missing.join(', ')} no está definida (cópiala a runtime/agent-runtime/.env)`);
    provider = createProviderRegistry({ geminiApiKey: process.env.GEMINI_API_KEY, anthropicApiKey: process.env.ANTHROPIC_API_KEY })(route.provider);
    model = route.model;
  } else if (values.provider === 'stub') {
    provider = new StubProvider({ responseText: JSON.stringify({ relevant: false, confidence: 0.1, reason: 'stub', hypothesis: null }) });
  } else fail(`proveedor desconocido: ${values.provider}`);

  const cfg = readConfig(agentVersion.configuration);
  const policy = parseToolPolicy(agentVersion.configuration);
  const budget = new BudgetGuardProvider(provider, maxCostEur, cfg.usdToEur);
  const fakes: FakeTwenty[] = [];
  const makeTools = (runLabel: string) => {
    const fake = new FakeTwenty();
    fakes.push(fake);
    return new ToolExecutor(createDefaultToolRegistry({ twenty: fake.client() }), policy, { tenantId: values.tenant!, executionId: runLabel, agentId: 'skill-compare', stage: 'PROSPECTOR' }, new AbortController().signal);
  };
  const now = today ? () => new Date(`${today}T08:00:00Z`) : () => new Date();

  const compareVersions = await fetchVersions(values.api!, values.tenant!, skill, versions);
  const tuple: [CompareVersion, CompareVersion] = [compareVersions[0]!, compareVersions[1]!];
  console.error(`skill ${skill}: v${tuple[0].version} (${tuple[0].status}) vs v${tuple[1].version} (${tuple[1].status}) · modelo ${provider.name}:${model} · presupuesto ${maxCostEur} €`);

  const reports: Array<{ fixture: string; report: ComparisonReport }> = [];
  for (const f of fixtures) {
    if (budget.exceeded) {
      console.error(`presupuesto agotado: no se ejecuta ${f}`);
      break;
    }
    const input = JSON.parse(readFileSync(resolve(f), 'utf8')) as Record<string, unknown>;
    const report = await runSkillComparison({
      skillName: skill,
      versions: tuple,
      input,
      provider,
      budget,
      makeTools,
      agentVersion: { model, configuration: agentVersion.configuration },
      repeat,
      now,
      tenantId: values.tenant!,
      onProgress: (m) => console.error(`  ${f}: ${m}`),
    });
    reports.push({ fixture: f, report });
  }

  // Safety net: the in-memory CRM is the only one the runs could write to.
  const crmWrites = fakes.reduce((n, f) => n + f.tables.companies.length + f.tables.commercialHypotheses.length, 0);
  const md = writeOutputs({ skill, versions, spent_eur: budget.spentEur, budget_eur: maxCostEur, crm_writes: crmWrites, reports }, reports, values.out, String(crmWrites));
  console.log(md);
  if (budget.exceeded) process.exitCode = 3;
}

interface SavedComparison {
  skill: string;
  versions: number[];
  spent_eur: number;
  budget_eur: number;
  crm_writes?: number;
  reports: Array<{ fixture: string; report: ComparisonReport }>;
}

function writeOutputs(saved: SavedComparison, reports: SavedComparison['reports'], outPrefix: string | undefined, crmWrites: string): string {
  const [a, b] = saved.versions;
  const md = [
    `## skill:compare ${saved.skill} v${a} vs v${b}`,
    '',
    `Coste total: ${saved.spent_eur.toFixed(4)} € de ${saved.budget_eur} €. Escrituras en el CRM en memoria (FakeTwenty): ${crmWrites}; en Twenty real: 0.`,
    '',
    ...reports.flatMap(({ fixture, report }) => [`Fixture: \`${fixture}\``, '', renderComparisonMarkdown(report), '']),
  ].join('\n');
  if (outPrefix) {
    const out = resolve(outPrefix);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(`${out}.json`, JSON.stringify({ ...saved, reports }, null, 2));
    writeFileSync(`${out}.md`, `${md}\n`);
    console.error(`informe: ${out}.md y ${out}.json`);
  }
  return md;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
