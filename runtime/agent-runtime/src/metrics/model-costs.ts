/**
 * Model cost projection by role (LLD §18 routing + §17.3 cost): what the volume of a window
 * (default: the last 30 days) would cost with the CURRENT routing, at today's list prices and
 * at the prices of a future date (default 2027-01-01, when gemini-3.6/3.7/3.8-flash double).
 * The tool to decide a model change before a price change: run it with candidate
 * `MODEL_ROUTE_<ROL>` values and compare. Read-only.
 *
 * Sources (same tables and EUR conversion as /metrics):
 * - agent_executions (+ agent_versions): real tokens per version; role from the version
 *   (`configuration.model_role` / implementation); route = the router for that version.
 *   Repriced token by token (method `tokens`).
 * - experiments (`metrics.cost.executor_eur` / `judge_eur`) and optimizer_runs (own LLM cost =
 *   `cost_eur` minus its experiment's): only EUR is stored, so the EUR is scaled by the price
 *   ratio route/served model (input + output list price; exact when both double, as 3.8-flash
 *   does). Method `scaled_eur`; `unpriced` when the served model has no price (stub).
 * Not modelled: grounding (search queries, priced per query and unchanged by the token
 * prices) and tool costs. `actual_eur` is what was charged (it includes grounding).
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { DEFAULT_USD_TO_EUR } from '../providers/gemini-pricing.js';
import { priceUsage, type ModelPricing } from '../providers/model-provider.js';
import { agentVersionRole, MODEL_ROLES, modelPricing, routeAgentVersion, type ModelRole, type ModelRoute, type ModelRouter, type ModelTarget } from '../providers/model-router.js';
import { execCostEur, windowWhere } from './queries.js';

/** Next known price change of the routed models (gemini-pricing.ts periods). */
export const NEXT_PRICE_CHANGE = '2027-01-01';
export const MODEL_COSTS_DEFAULT_DAYS = 30;

export interface ModelCostsOptions {
  tenantId: string;
  since: Date;
  until: Date;
  router: ModelRouter;
  /** "Today" for today's prices (default now). */
  today?: Date;
  /** Date of the projected prices, YYYY-MM-DD (default NEXT_PRICE_CHANGE). */
  at?: string;
  usdToEur?: number;
}

export interface PriceView {
  input_per_mtok: number;
  output_per_mtok: number;
  cached_per_mtok: number;
}

export interface RoleRow {
  role: ModelRole;
  route: string;
  source: ModelRoute['source'];
  env: string | null;
  price_today: PriceView | null;
  price_at: PriceView | null;
  /** (input + output) at `at` / today − 1; null when unpriced. */
  change: number | null;
}

export interface VolumeRow {
  source: 'agent_executions' | 'experiments.executor' | 'experiments.judge' | 'optimizer';
  label: string;
  role: ModelRole;
  /** Model the volume was served by (as recorded). */
  served: string;
  /** Model the current routing would use for it. */
  route: string;
  route_source: ModelRoute['source'];
  count: number;
  tokens: { input: number; output: number; cached: number } | null;
  actual_eur: number;
  projected_today_eur: number | null;
  projected_at_eur: number | null;
  method: 'tokens' | 'scaled_eur' | 'unpriced';
}

export interface RoleTotals {
  actual_eur: number;
  projected_today_eur: number;
  projected_at_eur: number;
  delta_eur: number;
}

const r6 = (v: number) => Math.round(v * 1_000_000) / 1_000_000;
const view = (p: ModelPricing | undefined): PriceView | null => (p ? { input_per_mtok: p.inputPerMTok, output_per_mtok: p.outputPerMTok, cached_per_mtok: p.cachedPerMTok } : null);
const blended = (p: ModelPricing | undefined): number | null => (p ? p.inputPerMTok + p.outputPerMTok : null);
const label = (t: ModelTarget) => `${t.provider}:${t.model}`;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

type Row = Record<string, unknown>;
async function rows(db: Db, q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(q)).rows as Row[];
}

export async function modelCostProjection(db: Db, o: ModelCostsOptions) {
  const today = o.today ?? new Date();
  const atIso = o.at ?? NEXT_PRICE_CHANGE;
  const at = new Date(`${atIso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) throw new Error(`fecha de proyección no válida: ${atIso}`);
  const usdToEur = o.usdToEur ?? DEFAULT_USD_TO_EUR;
  const w = { tenantId: o.tenantId, since: o.since, until: o.until };

  const roles: RoleRow[] = o.router.table().map((r) => {
    const pt = modelPricing(r.provider, r.model, today);
    const pa = modelPricing(r.provider, r.model, at);
    const bt = blended(pt);
    const ba = blended(pa);
    return { role: r.role, route: label(r), source: r.source, env: r.env ?? null, price_today: view(pt), price_at: view(pa), change: bt && ba !== null ? r6(ba / bt - 1) : null };
  });

  const volume: VolumeRow[] = [];

  // 1. Agent executions: real tokens, repriced with the route of their version.
  const ex = await rows(
    db,
    sql`select a.name as agent_name, v.model, v.model_provider,
           v.configuration->>'implementation' as implementation, v.configuration->>'model_role' as model_role,
           count(*) as n, sum(e.input_tokens) as input_tokens, sum(e.output_tokens) as output_tokens,
           sum(e.cached_tokens) as cached_tokens, sum(${execCostEur('e')}) as cost_eur
    from agent_executions e
    join agents a on a.id = e.agent_id
    join agent_versions v on v.id = e.agent_version_id
    where ${windowWhere('e', 'created_at', w)}
    group by 1, 2, 3, 4, 5
    order by 1, 2`,
  );
  for (const r of ex) {
    const configuration: Record<string, unknown> = {
      ...(r.implementation ? { implementation: r.implementation } : {}),
      ...(r.model_role ? { model_role: r.model_role } : {}),
    };
    const version = { model: String(r.model), modelProvider: String(r.model_provider), configuration };
    const route = routeAgentVersion(o.router, version);
    const usage = { inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), cachedTokens: num(r.cached_tokens) };
    const pt = modelPricing(route.provider, route.model, today);
    const pa = modelPricing(route.provider, route.model, at);
    volume.push({
      source: 'agent_executions',
      label: String(r.agent_name),
      role: agentVersionRole(configuration),
      served: `${version.modelProvider}:${version.model}`,
      route: label(route),
      route_source: route.source,
      count: num(r.n),
      tokens: { input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedTokens },
      actual_eur: r6(num(r.cost_eur)),
      projected_today_eur: pt ? r6(priceUsage(pt, usage) * usdToEur) : null,
      projected_at_eur: pa ? r6(priceUsage(pa, usage) * usdToEur) : null,
      method: pt && pa ? 'tokens' : 'unpriced',
    });
  }

  /** EUR-only volume scaled by the price ratio route / served model. */
  const scaled = (src: VolumeRow['source'], lbl: string, role: ModelRole, served: ModelTarget, route: ModelRoute, count: number, eur: number): VolumeRow => {
    const servedToday = blended(modelPricing(served.provider, served.model, today));
    const rt = blended(modelPricing(route.provider, route.model, today));
    const ra = blended(modelPricing(route.provider, route.model, at));
    const ok = servedToday !== null && servedToday > 0 && rt !== null && ra !== null;
    return {
      source: src,
      label: lbl,
      role,
      served: label(served),
      route: label(route),
      route_source: route.source,
      count,
      tokens: null,
      actual_eur: r6(eur),
      projected_today_eur: ok ? r6((eur * rt) / servedToday) : null,
      projected_at_eur: ok ? r6((eur * ra) / servedToday) : null,
      method: ok ? 'scaled_eur' : 'unpriced',
    };
  };

  // 2. Experiments: executor (the Prospector's role) and judge, from the stored EUR.
  const exps = await rows(
    db,
    sql`select x.config->'executor'->>'model' as executor_model, x.config->'judge'->>'model' as judge_model,
           count(*) as n,
           sum(coalesce((x.metrics->'cost'->>'executor_eur')::float8, 0)) as executor_eur,
           sum(coalesce((x.metrics->'cost'->>'judge_eur')::float8, 0)) as judge_eur
    from experiments x
    where ${windowWhere('x', 'created_at', w)}
    group by 1, 2`,
  );
  for (const r of exps) {
    const count = num(r.n);
    if (r.executor_model) {
      const served = { provider: 'gemini', model: String(r.executor_model) };
      const version = { model: served.model, modelProvider: served.provider, configuration: { implementation: 'prospector' } };
      const route = routeAgentVersion(o.router, version);
      volume.push(scaled('experiments.executor', 'experimentos (ejecutor)', route.role, served, route, count, num(r.executor_eur)));
    }
    if (r.judge_model && num(r.judge_eur) > 0) {
      const served = { provider: String(r.judge_model).startsWith('claude-') ? 'anthropic' : 'gemini', model: String(r.judge_model) };
      volume.push(scaled('experiments.judge', 'experimentos (juez)', 'judge', served, o.router.resolve('judge'), count, num(r.judge_eur)));
    }
  }

  // 3. Skill Optimizer: its own calls = run cost minus its experiment's.
  const opt = await rows(
    db,
    sql`select o.config->>'model' as model, count(*) as n,
           sum(greatest(o.cost_eur::float8 - coalesce(x.cost_eur::float8, 0), 0)) as own_eur
    from optimization_runs o left join experiments x on x.id = o.experiment_id
    where ${windowWhere('o', 'created_at', w)}
    group by 1`,
  );
  for (const r of opt) {
    if (!r.model || num(r.own_eur) <= 0) continue;
    const model = String(r.model);
    const served = { provider: model.startsWith('claude-') ? 'anthropic' : 'gemini', model };
    volume.push(scaled('optimizer', 'skill optimizer', 'optimizer', served, o.router.resolve('optimizer'), num(r.n), num(r.own_eur)));
  }

  const byRole = Object.fromEntries(MODEL_ROLES.map((role) => [role, { actual_eur: 0, projected_today_eur: 0, projected_at_eur: 0, delta_eur: 0 }])) as Record<ModelRole, RoleTotals>;
  const total: RoleTotals = { actual_eur: 0, projected_today_eur: 0, projected_at_eur: 0, delta_eur: 0 };
  let unpriced = 0;
  for (const v of volume) {
    if (v.method === 'unpriced') unpriced++;
    for (const t of [byRole[v.role], total]) {
      t.actual_eur += v.actual_eur;
      t.projected_today_eur += v.projected_today_eur ?? 0;
      t.projected_at_eur += v.projected_at_eur ?? 0;
    }
  }
  for (const t of [...Object.values(byRole), total]) {
    t.actual_eur = r6(t.actual_eur);
    t.projected_today_eur = r6(t.projected_today_eur);
    t.projected_at_eur = r6(t.projected_at_eur);
    t.delta_eur = r6(t.projected_at_eur - t.projected_today_eur);
  }

  return {
    tenant_id: o.tenantId,
    window: { since: o.since.toISOString(), until: o.until.toISOString() },
    prices: { today: today.toISOString().slice(0, 10), at: atIso, usd_to_eur: usdToEur },
    roles,
    volume,
    totals: { by_role: byRole, ...total, unpriced_rows: unpriced },
    notes: [
      'Proyección solo de tokens: grounding (por consulta) y tools no se modelan; actual_eur incluye lo cobrado de verdad.',
      'Experimentos y optimizador solo guardan EUR: se escalan por el cociente de precio (entrada + salida) ruta / modelo servido.',
      'Para evaluar un cambio, ejecútalo con MODEL_ROUTE_<ROL>=proveedor:modelo y compara.',
    ],
  };
}

export type ModelCostProjection = Awaited<ReturnType<typeof modelCostProjection>>;

/** Plain-text tables for the CLI. */
export function renderModelCosts(p: ModelCostProjection): string {
  const eur = (v: number | null) => (v === null ? '—' : `${v.toFixed(4)} €`);
  const price = (v: PriceView | null) => (v ? `${v.input_per_mtok} / ${v.output_per_mtok} / ${v.cached_per_mtok}` : 'sin precio');
  const L: string[] = [];
  L.push(`Costes de modelos · tenant ${p.tenant_id} · ventana ${p.window.since.slice(0, 10)} → ${p.window.until.slice(0, 10)} · precios hoy (${p.prices.today}) vs ${p.prices.at} · 1 USD = ${p.prices.usd_to_eur} €`);
  L.push('');
  L.push('Rol                ruta                                origen                         USD/1M entrada/salida/caché hoy  →  a partir de la fecha        cambio');
  for (const r of p.roles) {
    L.push(`${r.role.padEnd(18)} ${r.route.padEnd(35)} ${(r.env ?? r.source).padEnd(30)} ${price(r.price_today).padEnd(32)} →  ${price(r.price_at).padEnd(26)} ${r.change === null ? '—' : `${r.change >= 0 ? '+' : ''}${Math.round(r.change * 100)} %`}`);
  }
  L.push('');
  L.push('Volumen de la ventana con el routing actual');
  for (const v of p.volume) {
    const tk = v.tokens ? ` · ${v.tokens.input}/${v.tokens.output}/${v.tokens.cached} tok` : '';
    L.push(`- [${v.role}] ${v.label} (${v.source}) · ${v.count}${tk} · servido ${v.served} → ruta ${v.route} (${v.route_source}) · real ${eur(v.actual_eur)} · hoy ${eur(v.projected_today_eur)} · ${p.prices.at} ${eur(v.projected_at_eur)} · ${v.method}`);
  }
  if (p.volume.length === 0) L.push('- (sin volumen en la ventana)');
  L.push('');
  L.push('Totales por rol (real · proyectado hoy · proyectado en la fecha · diferencia)');
  for (const [role, t] of Object.entries(p.totals.by_role)) {
    if (t.actual_eur === 0 && t.projected_today_eur === 0 && t.projected_at_eur === 0) continue;
    L.push(`- ${role.padEnd(18)} ${eur(t.actual_eur)} · ${eur(t.projected_today_eur)} · ${eur(t.projected_at_eur)} · ${t.delta_eur >= 0 ? '+' : ''}${eur(t.delta_eur)}`);
  }
  L.push(`- ${'TOTAL'.padEnd(18)} ${eur(p.totals.actual_eur)} · ${eur(p.totals.projected_today_eur)} · ${eur(p.totals.projected_at_eur)} · ${p.totals.delta_eur >= 0 ? '+' : ''}${eur(p.totals.delta_eur)}${p.totals.unpriced_rows ? ` (${p.totals.unpriced_rows} fila(s) sin precio)` : ''}`);
  L.push('');
  for (const n of p.notes) L.push(`Nota: ${n}`);
  return L.join('\n');
}
