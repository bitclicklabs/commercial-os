import { describe, expect, it } from 'vitest';
import { SmokeAgent, resolveRefs } from '../../src/agents/smoke-agent.js';
import { StubProvider } from '../../src/providers/index.js';
import { ToolExecutor, createDefaultToolRegistry, parseToolPolicy, type AgentToolPolicy } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const ALL = ['find_company', 'get_company', 'upsert_company', 'create_signal', 'create_research', 'create_hypothesis', 'create_agent_run_summary'];

function setup(opts: { allow?: string[]; executionId?: string; apiKey?: string } = {}) {
  const fake = new FakeTwenty();
  const registry = createDefaultToolRegistry({ twenty: fake.client('apiKey' in opts ? { apiKey: opts.apiKey } : {}) });
  const policy: AgentToolPolicy = { allow: opts.allow ?? ALL, maxCallsPerExecution: 60, maxRiskLevel: 'LOW_WRITE' };
  const executor = new ToolExecutor(
    registry,
    policy,
    { tenantId: 'publiexpe', executionId: opts.executionId ?? 'exec-1', agentId: 'a1', stage: 'PROSPECTOR' },
    new AbortController().signal,
  );
  return { fake, registry, executor };
}

async function ok<T = Record<string, unknown>>(p: Promise<{ result: { status: string } & Record<string, unknown> }>): Promise<T> {
  const { result } = await p;
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.output as T;
}

describe('upsert_company', () => {
  it('is idempotent by normalized domain: creates once, then returns the existing company', async () => {
    const { fake, executor } = setup();
    const first = await ok<{ created: boolean; idempotencyKey: string; company: { id: string; domain: string } }>(
      executor.call('upsert_company', { domain: 'https://www.Acme-Test.example/about', name: 'ACME Test' }),
    );
    expect(first).toMatchObject({ created: true, idempotencyKey: 'publi:company:create:domain:acme-test.example', company: { domain: 'acme-test.example' } });
    const posted = fake.requests.find((r) => r.method === 'POST')!.body!;
    expect(posted).toEqual({ name: 'ACME Test', domainName: { primaryLinkUrl: 'https://acme-test.example', primaryLinkLabel: '', secondaryLinks: [] } });

    const second = await ok<{ created: boolean; company: { id: string } }>(executor.call('upsert_company', { domain: 'acme-test.example', name: 'Other name' }));
    expect(second).toMatchObject({ created: false, company: { id: first.company.id } });
    expect(fake.count('POST', 'companies')).toBe(1);
    expect(fake.tables.companies).toHaveLength(1);
    expect(fake.tables.companies[0]!.name).toBe('ACME Test'); // not overwritten
  });

  it('does not treat a domain that merely contains the needle as a match', async () => {
    const { fake, executor } = setup();
    fake.seed('companies', { name: 'Not ACME', domainName: { primaryLinkUrl: 'notacme.example', primaryLinkLabel: '', secondaryLinks: [] } });
    const out = await ok<{ created: boolean }>(executor.call('upsert_company', { domain: 'acme.example', name: 'ACME' }));
    expect(out.created).toBe(true);
  });

  it('recovers from a lost create race (unique domain) by returning the winner', async () => {
    const fake = new FakeTwenty();
    const originalFetch = fake.fetch;
    let injected = false;
    // Another writer creates the company between our lookup and our POST.
    fake.fetch = async (input, init) => {
      if (!injected && (init?.method ?? 'GET') === 'POST') {
        injected = true;
        fake.seed('companies', { name: 'Winner', domainName: { primaryLinkUrl: 'race.example', primaryLinkLabel: '', secondaryLinks: [] } });
      }
      return originalFetch(input, init);
    };
    const executor = new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client() }),
      parseToolPolicy({ tool_policy: ALL }),
      { tenantId: 'publiexpe', executionId: 'e', agentId: 'a', stage: null },
      new AbortController().signal,
    );
    const out = await ok<{ created: boolean; company: { name: string } }>(executor.call('upsert_company', { domain: 'race.example', name: 'Loser' }));
    expect(out).toMatchObject({ created: false, company: { name: 'Winner' } });
  });

  it('rejects invalid domains before calling Twenty', async () => {
    const { fake, executor } = setup();
    const { result } = await executor.call('upsert_company', { domain: 'not a domain', name: 'X' });
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect(fake.requests).toHaveLength(0);
  });

  it('answers TWENTY_NOT_CONFIGURED without an API key', async () => {
    const { executor } = setup({ apiKey: '' });
    const { result } = await executor.call('find_company', { name: 'acme' });
    expect(result).toMatchObject({ status: 'error', code: 'TWENTY_NOT_CONFIGURED' });
  });
});

describe('find_company / get_company', () => {
  it('finds by domain first and falls back to name', async () => {
    const { fake, executor } = setup();
    const c = fake.seed('companies', { name: 'Granada Ferias SL', domainName: { primaryLinkUrl: 'feriasgranada.example', primaryLinkLabel: '', secondaryLinks: [] } });
    expect(await ok(executor.call('find_company', { domain: 'www.feriasgranada.example' }))).toMatchObject({
      matchedBy: 'domain',
      companies: [{ id: c.id, domain: 'feriasgranada.example' }],
    });
    expect(await ok(executor.call('find_company', { domain: 'missing.example', name: 'granada' }))).toMatchObject({ matchedBy: 'name', companies: [{ id: c.id }] });
    expect(await ok(executor.call('find_company', { domain: 'missing.example' }))).toEqual({ matchedBy: 'none', companies: [] });
    expect((await executor.call('find_company', {})).result).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('get_company returns related records, or found=false', async () => {
    const { fake, executor } = setup();
    const c = fake.seed('companies', { name: 'X', domainName: { primaryLinkUrl: 'x.example', primaryLinkLabel: '', secondaryLinks: [] } });
    fake.seed('commercialSignals', { name: 'Feria', signalType: 'FAIR', status: 'NEW', sourceDomain: 'f.example', eventDate: null, confidence: 0.5, detectedAt: null, companyId: c.id });
    fake.seed('commercialHypotheses', { name: 'H', need: 'n', status: 'PROPOSED', confidence: 0.4, budgetMax: { amountMicros: 2_000_000_000, currencyCode: 'EUR' }, companyId: c.id });
    const out = await ok<{ found: boolean; company: { signals: unknown[]; hypotheses: Array<{ budgetMaxEur: number }> } }>(
      executor.call('get_company', { companyId: c.id }),
    );
    expect(out.found).toBe(true);
    expect(out.company.signals).toHaveLength(1);
    expect(out.company.hypotheses[0]!.budgetMaxEur).toBe(2000);
    expect(await ok(executor.call('get_company', { companyId: '00000000-0000-4000-8000-000000000000' }))).toEqual({ found: false, company: null });
  });
});

describe('create_* tools', () => {
  async function company(executor: ToolExecutor) {
    return (await ok<{ company: { id: string } }>(executor.call('upsert_company', { domain: 'acme.example', name: 'ACME' }))).company.id;
  }

  it('create_signal maps fields (LINKS, SELECT, DATE, tenantId, companyId) and dedupes retries', async () => {
    const { fake, executor } = setup();
    const companyId = await company(executor);
    const input = {
      companyId,
      title: 'Feria Alimentaria 2027',
      signalType: 'FAIR',
      sourceUrl: 'https://www.feria.example/expositores',
      eventDate: '2027-03-15',
      confidence: 0.8,
    };
    const first = await ok<{ created: boolean; record: { id: string; sourceDomain: string } }>(executor.call('create_signal', input));
    expect(first).toMatchObject({ created: true, record: { sourceDomain: 'feria.example' } });
    const body = fake.requests.filter((r) => r.method === 'POST').at(-1)!.body!;
    expect(body).toMatchObject({
      name: 'Feria Alimentaria 2027',
      signalType: 'FAIR',
      sourceUrl: { primaryLinkUrl: 'https://www.feria.example/expositores', primaryLinkLabel: '', secondaryLinks: [] },
      sourceDomain: 'feria.example',
      eventDate: '2027-03-15',
      confidence: 0.8,
      status: 'NEW',
      tenantId: 'publiexpe',
      companyId,
    });
    expect(typeof body.detectedAt).toBe('string');
    const again = await ok<{ created: boolean; record: { id: string } }>(executor.call('create_signal', input));
    expect(again).toMatchObject({ created: false, record: { id: first.record.id } });
    expect(fake.count('POST', 'commercialSignals')).toBe(1);
  });

  it('create_signal validates enums and ranges before calling Twenty', async () => {
    const { fake, executor } = setup();
    const base = { companyId: '00000000-0000-4000-8000-000000000000', title: 't', sourceUrl: 'https://a.example', confidence: 0.5 };
    expect((await executor.call('create_signal', { ...base, signalType: 'fair' })).result).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await executor.call('create_signal', { ...base, signalType: 'FAIR', confidence: 1.5 })).result).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await executor.call('create_signal', { ...base, signalType: 'FAIR', sourceUrl: 'javascript:alert(1)' })).result).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await executor.call('create_signal', { ...base, signalType: 'FAIR', eventDate: '15/03/2027' })).result).toMatchObject({ code: 'INVALID_INPUT' });
    expect(fake.requests).toHaveLength(0);
  });

  it('create_research links company and signal, uses the execution id and is one per execution', async () => {
    const { fake, executor } = setup({ executionId: 'exec-42' });
    const companyId = await company(executor);
    const signal = await ok<{ record: { id: string } }>(
      executor.call('create_signal', { companyId, title: 's', signalType: 'HIRING', sourceUrl: 'https://jobs.example/1', confidence: 0.6 }),
    );
    const input = {
      companyId,
      signalId: signal.record.id,
      researchType: 'COMPANY_PROFILE',
      summary: 'Empresa de alimentación con 200 empleados.',
      structuredResult: { employees: 200 },
      sources: ['https://acme.example', 'https://news.example/acme'],
      confidence: 0.7,
    };
    const first = await ok<{ created: boolean; record: { name: string; agentExecutionId: string; commercialSignalId: string } }>(
      executor.call('create_research', input),
    );
    expect(first).toMatchObject({ created: true, record: { name: 'COMPANY_PROFILE — ACME', agentExecutionId: 'exec-42', commercialSignalId: signal.record.id } });
    expect(fake.requests.filter((r) => r.method === 'POST').at(-1)!.body).toMatchObject({ sources: input.sources, structuredResult: { employees: 200 }, tenantId: 'publiexpe' });
    expect(await ok(executor.call('create_research', input))).toMatchObject({ created: false });
    expect(fake.count('POST', 'researches')).toBe(1);
    expect((await executor.call('create_research', { ...input, sources: [] })).result).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('create_hypothesis maps CURRENCY in micros and validates ranges', async () => {
    const { fake, executor } = setup();
    const companyId = await company(executor);
    const input = {
      companyId,
      need: '500 mochilas personalizadas para la feria',
      whyNow: 'Expone en marzo',
      quantityMin: 300,
      quantityMax: 500,
      budgetMinEur: 1500,
      budgetMaxEur: 3000.25,
      recommendedProducts: ['SKU-MOCH-01'],
      timing: 'THIS_QUARTER',
      confidence: 0.65,
      evidence: [{ claim: 'Expositor confirmado', sourceUrl: 'https://feria.example/expositores' }],
    };
    const out = await ok<{ created: boolean; record: { name: string; status: string } }>(executor.call('create_hypothesis', input));
    expect(out).toMatchObject({ created: true, record: { name: 'ACME — 500 mochilas personalizadas para la feria', status: 'PROPOSED' } });
    expect(fake.requests.filter((r) => r.method === 'POST').at(-1)!.body).toMatchObject({
      budgetMin: { amountMicros: 1_500_000_000, currencyCode: 'EUR' },
      budgetMax: { amountMicros: 3_000_250_000, currencyCode: 'EUR' },
      recommendedProducts: ['SKU-MOCH-01'],
      timing: 'THIS_QUARTER',
      tenantId: 'publiexpe',
      companyId,
    });
    expect(await ok(executor.call('create_hypothesis', input))).toMatchObject({ created: false });
    expect((await executor.call('create_hypothesis', { ...input, quantityMax: 10 })).result).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await executor.call('create_hypothesis', { ...input, evidence: [] })).result).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('create_agent_run_summary is one per execution and maps cost and trace link', async () => {
    const { fake, executor } = setup({ executionId: 'exec-7' });
    const input = {
      task: 'Daily prospecting',
      agentName: 'Prospector',
      agentVersion: 3,
      outcome: 'SUCCESS',
      costEur: 0.0431,
      traceUrl: 'http://localhost:4020/executions/exec-7/trace',
      startedAt: '2026-10-06T08:00:00.000Z',
    };
    const out = await ok<{ created: boolean; record: { name: string; agentExecutionId: string } }>(executor.call('create_agent_run_summary', input));
    expect(out).toMatchObject({ created: true, record: { name: 'Daily prospecting · Prospector v3 · 2026-10-06', agentExecutionId: 'exec-7' } });
    expect(fake.requests.filter((r) => r.method === 'POST').at(-1)!.body).toMatchObject({
      agentVersion: '3',
      cost: { amountMicros: 43_100, currencyCode: 'EUR' },
      traceUrl: { primaryLinkUrl: input.traceUrl, primaryLinkLabel: 'Trace' },
      tenantId: 'publiexpe',
    });
    expect(await ok(executor.call('create_agent_run_summary', input))).toMatchObject({ created: false });
  });
});

describe('SmokeAgent', () => {
  it('chains real tool calls with $ref and records one TOOL step per call', async () => {
    const { executor } = setup();
    const result = await new SmokeAgent().run({
      tenantId: 'publiexpe',
      executionId: 'exec-1',
      agent: { id: 'a1', name: 'Smoke', role: null },
      version: { id: 'v1', version: 1, model: 'stub', modelProvider: 'stub', systemPrompt: '', configuration: {} },
      input: {
        tool_calls: [
          { tool: 'upsert_company', input: { domain: 'smoke.example', name: 'Smoke Co' } },
          { tool: 'create_signal', input: { companyId: { $ref: '0.company.id' }, title: 's', signalType: 'OTHER', sourceUrl: 'https://smoke.example', confidence: 0.1 } },
        ],
      },
      provider: new StubProvider(),
      signal: new AbortController().signal,
      tools: executor,
    });
    expect(result.steps.map((s) => s.type)).toEqual(['THINK', 'TOOL', 'TOOL', 'FINAL']);
    expect(result.output).toMatchObject({ status: 'ok', tool_results: [{ tool: 'upsert_company', status: 'ok' }, { tool: 'create_signal', status: 'ok' }] });
  });

  it('stops at the first rejected call (allowlist) and keeps the step', async () => {
    const { executor } = setup({ allow: ['find_company'] });
    const result = await new SmokeAgent().run({
      tenantId: 'publiexpe',
      executionId: 'exec-1',
      agent: { id: 'a1', name: 'Smoke', role: null },
      version: { id: 'v1', version: 1, model: 'stub', modelProvider: 'stub', systemPrompt: '', configuration: {} },
      input: { tool_calls: [{ tool: 'upsert_company', input: { domain: 'x.example', name: 'X' } }, { tool: 'find_company', input: { name: 'x' } }] },
      provider: new StubProvider(),
      signal: new AbortController().signal,
      tools: executor,
    });
    expect(result.steps.map((s) => s.type)).toEqual(['THINK', 'TOOL', 'FINAL']);
    expect(result.steps[1]!.error).toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
    expect(result.output).toMatchObject({ status: 'error' });
  });

  it('resolveRefs substitutes nested values and fails loudly on unknown paths', () => {
    expect(resolveRefs({ a: [{ $ref: '0.x.y' }], b: 1 }, [{ x: { y: 'v' } }])).toEqual({ a: ['v'], b: 1 });
    expect(() => resolveRefs({ $ref: '1.nope' }, [{}])).toThrow(/Unresolved/);
  });
});
