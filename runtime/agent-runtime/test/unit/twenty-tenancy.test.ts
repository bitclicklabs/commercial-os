/**
 * Tenancy of the Twenty reads and writes (tanda 16): test tenants share the one Twenty workspace
 * with publiexpe, so the client injects the `tenantId` filter on the App objects, refuses a
 * record of another tenant before any PATCH, and the webhook handlers ignore foreign records.
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { foreignTenantOf, processTwentyWebhook } from '../../src/evaluations/twenty-webhook.js';
import type { TwentyWebhookPayload } from '../../src/evaluations/human-feedback.js';
import {
  TENANT_SCOPED_OBJECTS,
  TwentyApiError,
  TwentyClient,
  recordBelongsTo,
  tenantFilter,
  twentyClientFromEnv,
} from '../../src/integrations/twenty/index.js';
import { processSignalQualification } from '../../src/signals/qualified.js';
import { createDefaultToolRegistry, type ToolContext } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const OWNER = 'publiexpe';

function ctxFor(tenantId: string): ToolContext {
  return { tenantId, executionId: 'exec-1', agentId: 'agent-1', stage: null, idempotencyKey: 'k', signal: new AbortController().signal, logger: { info() {}, error() {} } };
}

/** A fetch that records the URLs and answers a fixed list (as a server that ignores the filter would). */
function recordingFetch(records: Array<Record<string, unknown>>) {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const plural = url.pathname.split('/')[2]!;
    return new Response(JSON.stringify({ data: { [plural]: records }, totalCount: records.length, pageInfo: {} }), { status: 200 });
  };
  return { urls, client: new TwentyClient({ baseUrl: 'http://twenty.test', apiKey: 'k', fetch: fetchImpl, sleep: async () => {}, ownerTenantId: OWNER }) };
}

describe('tenant filter in the Twenty client', () => {
  it('the App objects are tenant scoped; the standard ones are not', () => {
    expect([...TENANT_SCOPED_OBJECTS].sort()).toEqual(['agentOsDailyMetrics', 'agentRunSummaries', 'commercialHypotheses', 'commercialSignals', 'researches']);
  });

  it('builds the filter: exact tenant, plus the records without tenant for the owner', () => {
    expect(tenantFilter('acme', OWNER)).toBe('tenantId[eq]:"acme"');
    expect(tenantFilter(OWNER, OWNER)).toBe('or(tenantId[eq]:"publiexpe",tenantId[is]:NULL,tenantId[eq]:"")');
    expect(recordBelongsTo({ tenantId: 'acme' }, 'acme', OWNER)).toBe(true);
    expect(recordBelongsTo({ tenantId: 'acme' }, OWNER, OWNER)).toBe(false);
    expect(recordBelongsTo({ tenantId: '' }, OWNER, OWNER)).toBe(true);
    expect(recordBelongsTo({ tenantId: null }, OWNER, OWNER)).toBe(true);
    expect(recordBelongsTo({}, 'acme', OWNER)).toBe(false);
  });

  it('list() injects the tenant filter on a scoped object, combined with the caller filter', async () => {
    const { urls, client } = recordingFetch([]);
    await client.list('commercialSignals', { filter: 'status[eq]:"QUALIFIED"', tenantId: 'acme' });
    await client.list('commercialSignals', { tenantId: OWNER });
    await client.list('commercialSignals', { filter: 'status[eq]:"NEW"' });
    await client.list('companies', { filter: 'name[ilike]:"%x%"', tenantId: 'acme' });
    expect(urls.map((u) => u.searchParams.get('filter'))).toEqual([
      'and(tenantId[eq]:"acme",status[eq]:"QUALIFIED")',
      'or(tenantId[eq]:"publiexpe",tenantId[is]:NULL,tenantId[eq]:"")',
      'status[eq]:"NEW"',
      'name[ilike]:"%x%"',
    ]);
  });

  it('list() drops the records of another tenant a server returns anyway', async () => {
    const rows = [
      { id: 'a', tenantId: OWNER },
      { id: 'b', tenantId: 'it-test' },
      { id: 'c', tenantId: '' },
      { id: 'd', tenantId: null },
    ];
    const { client } = recordingFetch(rows);
    expect((await client.list<{ id: string }>('commercialSignals', { tenantId: OWNER })).records.map((r) => r.id)).toEqual(['a', 'c', 'd']);
    expect((await client.list<{ id: string }>('commercialSignals', { tenantId: 'it-test' })).records.map((r) => r.id)).toEqual(['b']);
    // Without tenant (maintenance reads) nothing is dropped.
    expect((await client.list<{ id: string }>('commercialSignals')).records).toHaveLength(4);
  });

  it('get() refuses a record of another tenant with TWENTY_TENANT_MISMATCH; update() refuses it before the PATCH', async () => {
    const fake = new FakeTwenty();
    const mine = fake.seed('commercialSignals', { name: 'Mía', signalType: 'FAIR', status: 'NEW', tenantId: OWNER });
    const handmade = fake.seed('commercialSignals', { name: 'A mano', signalType: 'FAIR', status: 'NEW', tenantId: '' });
    const theirs = fake.seed('commercialSignals', { name: 'Ajena', signalType: 'FAIR', status: 'NEW', tenantId: 'it-1234' });
    const client = fake.client({ ownerTenantId: OWNER });

    expect(await client.get('commercialSignals', mine.id as string, { tenantId: OWNER })).toMatchObject({ id: mine.id });
    expect(await client.get('commercialSignals', handmade.id as string, { tenantId: OWNER })).toMatchObject({ id: handmade.id });
    const err = await client.get('commercialSignals', theirs.id as string, { tenantId: OWNER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TwentyApiError);
    expect(err).toMatchObject({ code: 'TWENTY_TENANT_MISMATCH', retryable: false });
    expect((err as Error).message).toContain('it-1234');
    // A record without tenant is not another tenant's own record.
    await expect(client.get('commercialSignals', handmade.id as string, { tenantId: 'it-1234' })).rejects.toMatchObject({ code: 'TWENTY_TENANT_MISMATCH' });
    // Standard objects have no tenant: no check.
    const company = fake.seed('companies', { name: 'Acme', tenantId: 'it-1234' });
    expect(await client.get('companies', company.id as string, { tenantId: OWNER })).toMatchObject({ id: company.id });

    await expect(client.update('commercialSignals', theirs.id as string, { status: 'EXPIRED' }, { tenantId: OWNER })).rejects.toMatchObject({ code: 'TWENTY_TENANT_MISMATCH' });
    expect(fake.count('PATCH', 'commercialSignals')).toBe(0);
    expect(fake.tables.commercialSignals.find((r) => r.id === theirs.id)!.status).toBe('NEW');
    await client.update('commercialSignals', mine.id as string, { status: 'REVIEWING' }, { tenantId: OWNER });
    expect(fake.tables.commercialSignals.find((r) => r.id === mine.id)!.status).toBe('REVIEWING');
  });

  it('twentyClientFromEnv takes the owner tenant from DEFAULT_TENANT_ID (default publiexpe)', () => {
    expect(twentyClientFromEnv({}).ownerTenantId).toBe('publiexpe');
    expect(twentyClientFromEnv({ DEFAULT_TENANT_ID: 'acme' }).ownerTenantId).toBe('acme');
  });
});

describe('Twenty tools only see and touch the records of their tenant', () => {
  function setup() {
    const fake = new FakeTwenty();
    const registry = createDefaultToolRegistry({ twenty: fake.client({ ownerTenantId: OWNER }), render: { endpoint: null } });
    const call = (id: string, input: unknown, tenantId = OWNER) => registry.get(id)!.execute(input as never, ctxFor(tenantId));
    return { fake, call };
  }

  it('list_event_signals returns only the tenant signals (and the hand-made ones for the owner)', async () => {
    const { fake, call } = setup();
    const fair = (name: string, tenantId: unknown) => fake.seed('commercialSignals', { name, signalType: 'FAIR', status: 'QUALIFIED', companyId: null, tenantId, sourceUrl: null });
    const mine = fair('Mía', OWNER);
    const handmade = fair('A mano', '');
    const theirs = fair('Ajena', 'it-abc');
    const own = await call('list_event_signals', { statuses: ['QUALIFIED'] });
    expect(own.status === 'ok' && own.output.signals.map((s: { id: string }) => s.id)).toEqual([mine.id, handmade.id]);
    const test = await call('list_event_signals', { statuses: ['QUALIFIED'] }, 'it-abc');
    expect(test.status === 'ok' && test.output.signals.map((s: { id: string }) => s.id)).toEqual([theirs.id]);
  });

  it('expire_signal on a signal of another tenant is an error and writes nothing', async () => {
    const { fake, call } = setup();
    const theirs = fake.seed('commercialSignals', { name: 'Ajena', signalType: 'FAIR', status: 'QUALIFIED', eventDate: '2026-01-01', companyId: null, tenantId: 'it-abc' });
    const out = await call('expire_signal', { signalId: theirs.id, today: '2026-10-12' });
    expect(out).toMatchObject({ status: 'error', code: 'TWENTY_TENANT_MISMATCH', retryable: false });
    expect(fake.count('PATCH', 'commercialSignals')).toBe(0);
    expect(fake.tables.commercialSignals[0]!.status).toBe('QUALIFIED');
  });

  it('set_hypothesis_draft / revert_hypothesis_draft_status / get_hypothesis refuse a hypothesis of another tenant', async () => {
    const { fake, call } = setup();
    const theirs = fake.seed('commercialHypotheses', { name: 'Ajena', status: 'PROPOSED', tenantId: 'it-abc', emailStatus: 'READY', companyId: null });
    const draft = await call('set_hypothesis_draft', { hypothesisId: theirs.id, to: 'a@acme.example', subject: 'Hola', body: 'Cuerpo' });
    const revert = await call('revert_hypothesis_draft_status', { hypothesisId: theirs.id });
    const read = await call('get_hypothesis', { hypothesisId: theirs.id });
    for (const out of [draft, revert, read]) expect(out).toMatchObject({ status: 'error', code: 'TWENTY_TENANT_MISMATCH' });
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(0);
    expect(fake.tables.commercialHypotheses[0]).toMatchObject({ emailStatus: 'READY' });
  });

  it('get_hypothesis leaves out a linked signal of another tenant; get_company only lists the tenant records', async () => {
    const { fake, call } = setup();
    const company = fake.seed('companies', { name: 'Acme', domainName: { primaryLinkUrl: 'acme.example', primaryLinkLabel: '', secondaryLinks: [] } });
    const foreignSignal = fake.seed('commercialSignals', { name: 'Ajena', signalType: 'FAIR', status: 'NEW', companyId: company.id, tenantId: 'it-abc' });
    const ownSignal = fake.seed('commercialSignals', { name: 'Mía', signalType: 'FAIR', status: 'NEW', companyId: company.id, tenantId: OWNER });
    const hyp = fake.seed('commercialHypotheses', { name: 'Mía', status: 'PROPOSED', tenantId: OWNER, companyId: company.id, commercialSignalId: foreignSignal.id });
    fake.seed('commercialHypotheses', { name: 'Ajena', status: 'PROPOSED', tenantId: 'it-abc', companyId: company.id });
    const h = await call('get_hypothesis', { hypothesisId: hyp.id });
    expect(h).toMatchObject({ status: 'ok', output: { found: true, signal: null, company: { id: company.id } } });
    const c = await call('get_company', { companyId: company.id });
    expect(c.status === 'ok' && c.output.company.signals.map((s: { id: string }) => s.id)).toEqual([ownSignal.id]);
    expect(c.status === 'ok' && c.output.company.hypotheses.map((s: { id: string }) => s.id)).toEqual([hyp.id]);
  });

  it('every create writes tenantId, and find-before-create never adopts a record of another tenant', async () => {
    const { fake, call } = setup();
    const company = fake.seed('companies', { name: 'Acme', domainName: { primaryLinkUrl: 'acme.example', primaryLinkLabel: '', secondaryLinks: [] } });
    // Same natural keys as below, written by a test tenant.
    const theirSignal = fake.seed('commercialSignals', { name: 'Ajena', signalType: 'FAIR', status: 'NEW', companyId: company.id, sourceDomain: 'feria.example', eventDate: '2027-01-20', tenantId: 'it-abc' });
    const theirHyp = fake.seed('commercialHypotheses', { name: 'Acme — Bolsas', status: 'PROPOSED', companyId: company.id, tenantId: 'it-abc' });
    const theirRun = fake.seed('agentRunSummaries', { name: 'x', outcome: 'SUCCESS', agentExecutionId: 'exec-1', tenantId: 'it-abc' });

    const signal = await call('create_signal', { companyId: company.id, title: 'Feria — Acme', signalType: 'FAIR', sourceUrl: 'https://feria.example/x', eventDate: '2027-01-20', confidence: 0.8 });
    const hyp = await call('create_hypothesis', { companyId: company.id, name: 'Acme — Bolsas', need: 'Bolsas', whyNow: 'Feria', confidence: 0.6, evidence: [{ claim: 'expositor' }] });
    const research = await call('create_research', { companyId: company.id, researchType: 'COMPANY_PROFILE', summary: 'Resumen', sources: ['https://acme.example/'], confidence: 0.7 });
    const run = await call('create_agent_run_summary', { task: 't', agentName: 'a', agentVersion: 1, outcome: 'SUCCESS', startedAt: '2026-10-12T08:00:00Z' });
    for (const out of [signal, hyp, research, run]) expect(out).toMatchObject({ status: 'ok', output: { created: true } });
    expect(signal.status === 'ok' && signal.output.record.id).not.toBe(theirSignal.id);
    expect(hyp.status === 'ok' && hyp.output.record.id).not.toBe(theirHyp.id);
    expect(run.status === 'ok' && run.output.record.id).not.toBe(theirRun.id);
    const posts = fake.requests.filter((r) => r.method === 'POST' && /commercialSignals|commercialHypotheses|researches|agentRunSummaries/.test(r.path));
    expect(posts).toHaveLength(4);
    for (const p of posts) expect(p.body).toMatchObject({ tenantId: OWNER });
    // The retry of the same call finds the tenant's own record.
    const again = await call('create_signal', { companyId: company.id, title: 'Feria — Acme', signalType: 'FAIR', sourceUrl: 'https://feria.example/x', eventDate: '2027-01-20', confidence: 0.8 });
    expect(again).toMatchObject({ status: 'ok', output: { created: false, record: { id: signal.status === 'ok' ? signal.output.record.id : '' } } });
  });
});

describe('webhooks: a record of another tenant is ignored', () => {
  // The foreign check runs before any database access.
  const noDb = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } }) as unknown as Db;
  const payload = (object: 'commercialHypothesis' | 'commercialSignal', record: Record<string, unknown>): TwentyWebhookPayload => ({
    eventName: `${object}.updated`,
    objectMetadata: { id: 'meta', nameSingular: object },
    record: { id: '0b5c6a32-2d41-4c39-9d57-4a3f0e2b1a11', ...record },
    updatedFields: ['status'],
  } as TwentyWebhookPayload);

  it('foreignTenantOf: empty or own tenant is not foreign; any other value is', () => {
    expect(foreignTenantOf({ tenantId: OWNER }, OWNER)).toBeNull();
    expect(foreignTenantOf({ tenantId: '' }, OWNER)).toBeNull();
    expect(foreignTenantOf({ tenantId: null }, OWNER)).toBeNull();
    expect(foreignTenantOf({}, OWNER)).toBeNull();
    expect(foreignTenantOf({ tenantId: 'it-1234' }, OWNER)).toBe('it-1234');
    expect(foreignTenantOf({ tenantId: 'not a valid tenant!' }, OWNER)).toBe('not a valid tenant!');
  });

  it('human feedback: ignored with the tenant, nothing recorded', async () => {
    const out = await processTwentyWebhook(noDb, payload('commercialHypothesis', { status: 'VALIDATED', tenantId: 'it-1234' }), { defaultTenantId: OWNER, dedupeWindowMs: 1000 });
    expect(out).toEqual({ status: 'ignored', reason: 'record of tenant "it-1234" (this runtime serves "publiexpe")', foreign_tenant: 'it-1234' });
  });

  it('qualified signal: ignored with the tenant, no event', async () => {
    const events = { publish: () => { throw new Error('must not publish'); } } as never;
    const out = await processSignalQualification(
      noDb,
      payload('commercialSignal', { status: 'QUALIFIED', signalType: 'FAIR', companyId: null, name: 'Feria X (feria)', sourceUrl: { primaryLinkUrl: 'https://feria.example' }, tenantId: 'it-1234' }),
      { defaultTenantId: OWNER, events },
    );
    expect(out).toMatchObject({ status: 'ignored', foreign_tenant: 'it-1234', signal_id: '0b5c6a32-2d41-4c39-9d57-4a3f0e2b1a11' });
  });
});
