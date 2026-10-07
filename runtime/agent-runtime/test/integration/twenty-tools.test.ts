/**
 * Tools against the REAL local Twenty (TWENTY_BASE_URL, default http://localhost:3020).
 * Skipped cleanly when TWENTY_API_KEY is missing or the server does not answer.
 * TWENTY_API_KEY is read from the environment or from runtime/agent-runtime/.env (test/setup-env.ts).
 *
 * Creates clearly-labelled test records ("[TEST] pxos-it ...", domain test-{uuid}.example)
 * and NEVER deletes anything (deleting CRM data is forbidden).
 *
 * The last block also runs the full worker path (API -> RunProcessor -> SmokeAgent ->
 * real tools -> trace) when the Agent OS PostgreSQL is reachable too.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { twentyClientFromEnv } from '../../src/integrations/twenty/index.js';
import { createProviderRegistry } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { ToolExecutor, createDefaultToolRegistry, type ToolResult } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';

const ALL = ['find_company', 'get_company', 'upsert_company', 'create_signal', 'create_research', 'create_hypothesis', 'create_agent_run_summary'];

const twenty = twentyClientFromEnv();
const twentyAvailable = twenty.isConfigured() && (await twenty.ping());
if (!twentyAvailable) {
  console.warn(
    `[integration] Twenty not available at ${twenty.baseUrl} (${twenty.isConfigured() ? 'server not responding' : 'TWENTY_API_KEY not set'}); skipping`,
  );
}

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
const dbAvailable = twentyAvailable && (await databaseReachable(DATABASE_URL));

function unwrap<T>(result: ToolResult<unknown>): T {
  if (result.status !== 'ok') throw new Error(`tool failed: ${JSON.stringify(result)}`);
  return result.output as T;
}

describe.skipIf(!twentyAvailable)('Twenty tools (live Twenty)', () => {
  const runId = randomUUID().slice(0, 8);
  const domain = `test-${randomUUID()}.example`;
  const executionId = `it-exec-${runId}`;
  const registry = createDefaultToolRegistry({ twenty });
  const executor = new ToolExecutor(
    registry,
    { allow: ALL, maxCallsPerExecution: 60, maxRiskLevel: 'LOW_WRITE' },
    { tenantId: 'publiexpe', executionId, agentId: 'it-agent', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  const call = async <T>(tool: string, input: unknown) => unwrap<T>((await executor.call(tool, input)).result);

  let companyId = '';
  let signalId = '';

  it('upsert_company creates once and is idempotent by domain', async () => {
    const first = await call<{ created: boolean; company: { id: string; domain: string; name: string } }>('upsert_company', {
      domain: `https://www.${domain}/contacto`,
      name: `[TEST] pxos-it ${runId}`,
    });
    expect(first.created).toBe(true);
    expect(first.company.domain).toBe(domain);
    companyId = first.company.id;

    const second = await call<{ created: boolean; company: { id: string; name: string } }>('upsert_company', {
      domain,
      name: `[TEST] pxos-it ${runId} renamed`,
    });
    expect(second).toMatchObject({ created: false, company: { id: companyId, name: `[TEST] pxos-it ${runId}` } });
  });

  it('find_company finds it by domain and by name', async () => {
    expect(await call('find_company', { domain })).toMatchObject({ matchedBy: 'domain', companies: [{ id: companyId }] });
    const byName = await call<{ companies: Array<{ id: string }> }>('find_company', { name: `pxos-it ${runId}` });
    expect(byName.companies.map((c) => c.id)).toContain(companyId);
  });

  it('create_signal writes LINKS/SELECT/DATE fields and dedupes retries', async () => {
    const input = {
      companyId,
      title: `[TEST] pxos-it ${runId} feria`,
      signalType: 'FAIR',
      description: 'Integration test signal',
      sourceUrl: `https://ferias-${runId}.example/expositores`,
      eventDate: '2027-03-15',
      confidence: 0.85,
    };
    const first = await call<{ created: boolean; record: { id: string; sourceDomain: string; eventDate: string; status: string } }>('create_signal', input);
    expect(first).toMatchObject({ created: true, record: { sourceDomain: `ferias-${runId}.example`, eventDate: '2027-03-15', status: 'NEW' } });
    signalId = first.record.id;
    expect(await call('create_signal', input)).toMatchObject({ created: false, record: { id: signalId } });

    const raw = await twenty.get<Record<string, unknown>>('commercialSignals', signalId);
    expect(raw).toMatchObject({
      tenantId: 'publiexpe',
      companyId,
      signalType: 'FAIR',
      confidence: 0.85,
      sourceUrl: { primaryLinkUrl: input.sourceUrl },
    });
  });

  it('create_research links company + signal and is one per execution', async () => {
    const input = {
      companyId,
      signalId,
      researchType: 'COMPANY_PROFILE',
      query: 'perfil de empresa',
      summary: 'Integration test research, no real data.',
      structuredResult: { test: true, runId },
      sources: [`https://${domain}`, `https://news-${runId}.example/a`],
      confidence: 0.6,
    };
    const first = await call<{ created: boolean; record: { id: string; companyId: string; commercialSignalId: string; agentExecutionId: string } }>(
      'create_research',
      input,
    );
    expect(first).toMatchObject({ created: true, record: { companyId, commercialSignalId: signalId, agentExecutionId: executionId } });
    expect(await call('create_research', input)).toMatchObject({ created: false, record: { id: first.record.id } });
    const raw = await twenty.get<Record<string, unknown>>('researches', first.record.id);
    expect(raw).toMatchObject({ sources: input.sources, structuredResult: { test: true, runId }, tenantId: 'publiexpe' });
  });

  it('create_hypothesis writes CURRENCY (micros, EUR) and evidence', async () => {
    const input = {
      companyId,
      signalId,
      // Comma and parentheses on purpose: the dedupe filter must survive Twenty's filter parser.
      need: `[TEST] ${runId} 500 mochilas, bolsas (tela) personalizadas`,
      whyNow: 'Integration test',
      quantityMin: 300,
      quantityMax: 500,
      budgetMinEur: 1500,
      budgetMaxEur: 3000.5,
      recommendedProducts: ['SKU-TEST-1'],
      timing: 'THIS_QUARTER',
      confidence: 0.55,
      evidence: [{ claim: 'Test evidence', sourceUrl: `https://ferias-${runId}.example/expositores`, quote: 'n/a' }],
    };
    const first = await call<{ created: boolean; record: { id: string; status: string } }>('create_hypothesis', input);
    expect(first).toMatchObject({ created: true, record: { status: 'PROPOSED' } });
    expect(await call('create_hypothesis', input)).toMatchObject({ created: false, record: { id: first.record.id } });
    const raw = await twenty.get<Record<string, unknown>>('commercialHypotheses', first.record.id);
    expect(raw).toMatchObject({
      budgetMin: { amountMicros: 1_500_000_000, currencyCode: 'EUR' },
      budgetMax: { amountMicros: 3_000_500_000, currencyCode: 'EUR' },
      commercialSignalId: signalId,
      tenantId: 'publiexpe',
    });
  });

  it('create_agent_run_summary is one per execution', async () => {
    const input = {
      task: `[TEST] pxos-it ${runId}`,
      agentName: 'IntegrationTest',
      agentVersion: 1,
      outcome: 'SUCCESS',
      resultSummary: 'Integration test run',
      costEur: 0.0431,
      traceUrl: `http://localhost:4020/executions/${executionId}/trace`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      companyId,
    };
    const first = await call<{ created: boolean; record: { id: string; agentExecutionId: string } }>('create_agent_run_summary', input);
    expect(first).toMatchObject({ created: true, record: { agentExecutionId: executionId } });
    expect(await call('create_agent_run_summary', input)).toMatchObject({ created: false, record: { id: first.record.id } });
    const raw = await twenty.get<Record<string, unknown>>('agentRunSummaries', first.record.id);
    expect(raw).toMatchObject({ cost: { amountMicros: 43_100, currencyCode: 'EUR' }, traceUrl: { primaryLinkUrl: input.traceUrl } });
  });

  it('get_company returns the company with its new records', async () => {
    const out = await call<{ found: boolean; company: { signals: Array<{ id: string }>; researches: unknown[]; hypotheses: unknown[] } }>('get_company', {
      companyId,
    });
    expect(out.found).toBe(true);
    expect(out.company.signals.map((s) => s.id)).toContain(signalId);
    expect(out.company.researches).toHaveLength(1);
    expect(out.company.hypotheses).toHaveLength(1);
  });

  it('surfaces Twenty validation errors as tool errors', async () => {
    const { result } = await executor.call('get_company', { companyId: '00000000-0000-4000-8000-000000000000' });
    expect(result).toMatchObject({ status: 'ok', output: { found: false } });
  });
});

describe.skipIf(!dbAvailable)('worker e2e: SmokeAgent runs real tools (PostgreSQL + Twenty)', () => {
  const tenant = 'publiexpe';
  const runId = randomUUID().slice(0, 8);
  let handle: DbHandle;
  let app: FastifyInstance;
  let queue: MemoryRunQueue;
  let processor: RunProcessor;

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    queue = new MemoryRunQueue();
    processor = new RunProcessor(handle.db, createProviderRegistry(), undefined, createDefaultToolRegistry({ twenty }));
    app = await buildServer({ db: handle.db, queue, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('executes upsert_company + create_signal through the worker and traces both TOOL steps; out-of-policy tools are rejected', async () => {
    const agentRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { 'x-tenant-id': tenant },
      payload: {
        name: `[TEST] pxos-it smoke ${runId}`,
        role: 'prospecting',
        version: {
          system_prompt: 'smoke',
          configuration: { implementation: 'smoke', stage: 'PROSPECTOR', tool_policy: ['upsert_company', 'create_signal'] },
        },
      },
    });
    expect(agentRes.statusCode).toBe(201);
    const { agent } = agentRes.json();
    const domain = `test-${randomUUID()}.example`;
    const exec = await app.inject({
      method: 'POST',
      url: '/executions',
      headers: { 'x-tenant-id': tenant },
      payload: {
        agent_id: agent.id,
        input: {
          tool_calls: [
            { tool: 'upsert_company', input: { domain, name: `[TEST] pxos-it smoke ${runId}` } },
            {
              tool: 'create_signal',
              input: {
                companyId: { $ref: '0.company.id' },
                title: `[TEST] pxos-it smoke ${runId}`,
                signalType: 'OTHER',
                sourceUrl: `https://${domain}/news`,
                confidence: 0.5,
              },
            },
            { tool: 'create_hypothesis', input: { companyId: { $ref: '0.company.id' } } },
          ],
        },
      },
    });
    expect(exec.statusCode).toBe(202);
    for (const { job } of queue.drain()) await processor.process(job);

    const detail = (await app.inject({ method: 'GET', url: `/executions/${exec.json().execution.id}`, headers: { 'x-tenant-id': tenant } })).json();
    expect(detail.execution.status).toBe('COMPLETED');
    expect(detail.execution.tool_calls).toBe(3);
    const steps = detail.trace.steps as Array<{ type: string; tool: string | null; tool_output: unknown; error: unknown }>;
    expect(steps.map((s) => s.type)).toEqual(['THINK', 'TOOL', 'TOOL', 'TOOL', 'FINAL']);
    expect(steps[1]).toMatchObject({ tool: 'upsert_company', tool_output: { created: true, company: { domain } } });
    expect(steps[2]).toMatchObject({ tool: 'create_signal', tool_output: { created: true } });
    expect(steps[3]).toMatchObject({ tool: 'create_hypothesis', error: { code: 'TOOL_NOT_ALLOWED' } });
    expect(detail.execution.output).toMatchObject({ status: 'error' });
  });
});
