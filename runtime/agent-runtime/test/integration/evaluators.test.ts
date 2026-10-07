/**
 * Automatic evaluators against a real PostgreSQL: a Prospector trace read from the
 * database (execution_output, with the URLs it wrote), persistence in `evaluations`
 * (idempotent by subject + evaluator + output hash) and the judge cache. Fresh tenant per
 * run, no DELETE. Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, agentVersions, evaluations, traces, traceSteps } from '../../src/db/schema.js';
import { contentHashOf, defaultEvaluators, loadJudgeCache, persistEvaluations, runEvaluationPipeline, subjectsFromComparison, subjectsFromTrace } from '../../src/evaluators/index.js';
import { StubProvider } from '../../src/providers/index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos';

async function databaseReachable(url: string): Promise<boolean> {
  if (process.env.SKIP_DB_TESTS === '1') return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
const dbAvailable = await databaseReachable(DATABASE_URL);
const here = dirname(fileURLToPath(import.meta.url));
const EXP2_PATH = resolve(here, '../../../../docs/experimentos/EXP-002/compare-v1-v3.json');

describe.skipIf(!dbAvailable)('automatic evaluators (PostgreSQL)', () => {
  const tenant = `it-eval-${randomUUID().slice(0, 8)}`;
  const companyId = randomUUID();
  let handle: DbHandle;
  let traceId = '';
  let executionId = '';

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenant, name: `it-eval-${randomUUID().slice(0, 6)}` }).returning();
    const [version] = await handle.db
      .insert(agentVersions)
      .values({ tenantId: tenant, agentId: agent!.id, version: 1, model: 'gemini-flash-latest', modelProvider: 'gemini', configuration: { implementation: 'prospector', min_confidence: 0.5 } })
      .returning();
    const event = { name: 'Feria Test 2026', type: 'FAIR', date: '2026-11-20', source_url: 'https://feria-test.example/expositores' };
    const output = {
      mode: 'direct',
      outcome: 'SUCCESS',
      results: [
        {
          name: 'Acme Conservas',
          domain: 'acme.example',
          status: 'hypothesis_created',
          relevant: true,
          confidence: 0.85,
          reason: 'Conservera privada con stand grande y lanzamiento.',
          company_id: companyId,
          hypothesis: { need: 'Unas 300 bolsas y 20 polos para el stand.', why_now: 'La feria es en noviembre.', quantity_min: 320, quantity_max: 600, budget_min_eur: 900, budget_max_eur: 1800, recommended_products: ['bolsas', 'polos'], timing: 'THIS_QUARTER', differentiators: ['TALLER_PROPIO'] },
        },
        { name: 'Ayuntamiento de Test', domain: null, status: 'discarded_irrelevant', relevant: false, confidence: 0.9, reason: 'Organismo público: compra por licitación.' },
      ],
    };
    const [execution] = await handle.db
      .insert(agentExecutions)
      .values({ tenantId: tenant, agentId: agent!.id, agentVersionId: version!.id, status: 'COMPLETED', input: { event, exhibitors: [{ name: 'Acme Conservas', domain: 'acme.example' }, { name: 'Ayuntamiento de Test', sector: 'Organismos públicos' }] }, output })
      .returning();
    const [trace] = await handle.db.insert(traces).values({ tenantId: tenant, executionId: execution!.id, agentId: agent!.id, finalOutput: output }).returning();
    await handle.db.insert(traceSteps).values([
      { tenantId: tenant, traceId: trace!.id, sequence: 1, type: 'TOOL', tool: 'create_signal', toolInput: { companyId, sourceUrl: event.source_url } },
      { tenantId: tenant, traceId: trace!.id, sequence: 2, type: 'TOOL', tool: 'create_research', toolInput: { companyId, sources: ['https://acme.example/', 'https://inventada.example/nota'] } },
    ]);
    traceId = trace!.id;
    executionId = execution!.id;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('reads a trace as execution_output and flags the hard failures (unknown source, high-confidence discard)', async () => {
    const loaded = await subjectsFromTrace(handle.db, tenant, traceId);
    expect(loaded.subjects).toHaveLength(1);
    const s = loaded.subjects[0]!;
    expect(s).toMatchObject({ subjectType: 'execution_output', subjectId: executionId, agentExecutionId: executionId, executorModel: 'gemini-flash-latest' });
    expect(s.cases[0]!.output.writtenUrls).toEqual(['https://feria-test.example/expositores', 'https://acme.example/', 'https://inventada.example/nota']);
    expect(s.cases[1]!.input.dataLevel).toBe('sector');
    const report = await runEvaluationPipeline(loaded.subjects);
    const c = report.subjects[0]!.composite;
    expect(c.verdict).toBe('FAIL');
    expect(c.hard_failures.map((h) => h.evaluator).sort()).toEqual(['rule.discard_confidence_low@1', 'rule.source_urls_known@1']);
    // Also by execution id, and never across tenants.
    expect((await subjectsFromTrace(handle.db, tenant, executionId)).subjects[0]!.subjectId).toBe(executionId);
    await expect(subjectsFromTrace(handle.db, 'otro-tenant', traceId)).rejects.toThrow(/no hay traza/);

    const p1 = await persistEvaluations(handle.db, report, tenant);
    expect(p1.inserted).toBe(p1.rows);
    const rows = await handle.db.select().from(evaluations).where(and(eq(evaluations.tenantId, tenant), eq(evaluations.subjectId, executionId)));
    expect(rows.find((r) => r.kind === 'COMPOSITE')).toMatchObject({ feedback: 'FAIL', agentExecutionId: executionId, subjectType: 'execution_output', source: 'auto' });
    expect(rows.find((r) => r.evaluatorId === 'rule.source_urls_known@1')?.details).toMatchObject({ aggregate: { failures: 1 } });
  });

  it('persists a comparison idempotently and reuses the stored judge notes', async () => {
    const json = JSON.parse(readFileSync(EXP2_PATH, 'utf8'));
    const { subjects } = subjectsFromComparison(json, 'exp2', { baseDir: dirname(EXP2_PATH) });
    const judgeText = (ids: string[], quote: (id: string) => string) => JSON.stringify({ items: ids.map((id) => ({ id, level: 3, justification: 'Accionable con detalles menores.', quote: quote(id) })) });
    // A stub that echoes a literal fragment of each case's reason.
    const provider = new StubProvider();
    provider.complete = async (req) => {
      const msg = req.messages[0]!.content;
      const casos = (JSON.parse(msg.slice(msg.indexOf('{"casos"'), msg.lastIndexOf('}') + 1)) as { casos: Array<{ id: string; salida: { razon: string } }> }).casos;
      const text = judgeText(casos.map((c) => c.id), (id) => casos.find((c) => c.id === id)!.salida.razon.split(' ').slice(0, 4).join(' '));
      return { text, model: 'stub-judge', provider: 'stub', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, cost: { modelCost: 0, currency: 'USD' }, latencyMs: 0 };
    };
    const ev = defaultEvaluators({ judgeProvider: provider });
    const first = await runEvaluationPipeline(subjects, { ...ev });
    const p1 = await persistEvaluations(handle.db, first, tenant);
    expect(p1.inserted).toBe(p1.rows);
    const again = await persistEvaluations(handle.db, first, tenant);
    expect(again).toMatchObject({ inserted: 0, existing: p1.rows });

    const cache = await loadJudgeCache(handle.db, tenant, subjects, ev.judges.map((j) => ({ id: j.id, version: j.version, contentHash: contentHashOf(j) })));
    let calls = 0;
    provider.complete = async () => {
      calls++;
      throw new Error('no debería llamarse');
    };
    const second = await runEvaluationPipeline(subjects, { ...ev, judgeCache: cache });
    expect(calls).toBe(0);
    expect(second.judge.cached_cases).toBe(40);
    expect(second.groups.map((g) => g.composite.score)).toEqual(first.groups.map((g) => g.composite.score));
    expect((await persistEvaluations(handle.db, second, tenant)).inserted).toBe(0);
  });
});
