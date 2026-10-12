/**
 * Send from Twenty (docs/twenty-envio-email.md): the runtime writes the draft into the
 * hypothesis fields (`set_hypothesis_draft`, behind `send_from_twenty.enabled`) and defines,
 * but never activates, the manual Twenty workflow that a PERSON clicks to send it.
 * Nothing here sends email: no SMTP, no mail API, no MCP send_email call.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import { DRAFT_IN_FIELDS_HINT, DEFAULT_SENDER, unsubscribeLine } from '../../src/agents/email-draft.js';
import { EMAIL_DRAFTER_TOOLS, EmailDrafterAgent, readDrafterConfig } from '../../src/agents/email-drafter.js';
import { TwentyClient } from '../../src/integrations/twenty/index.js';
import { createSendWorkflow, mcpToolResult, parseMcpResponse, REQUIRED_HYPOTHESIS_FIELDS } from '../../src/integrations/twenty/create-send-workflow.js';
import {
  BODY_PRE_STYLE,
  SEND_DRAFT_STEP_IDS,
  SEND_DRAFT_WORKFLOW_NAME,
  TRIGGER_RECORD_ID,
  TRIGGER_WORKSPACE_MEMBER_ID,
  buildSendDraftWorkflow,
  sendDraftEmailBodyDocument,
} from '../../src/integrations/twenty/send-draft-workflow.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredEmailDrafterVersion } from '../../src/seed/email-drafter-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor, type ToolResult } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const ANSWER = {
  asunto: 'Material para vuestro stand en la feria',
  cuerpo:
    'Hola:\n\nSoy Jesús Abril, de PubliEXPE, expertos en merchandising para empresas. He visto que estaréis en la feria de noviembre y quería ofreceros ayuda con el material del stand.\n\nPodemos prepararos bolsas tote y polos bordados en nuestro taller propio.\n\n¿Te encaja que te mande dos o tres propuestas?\n\nUn saludo,',
};

const ok = <T>(r: ToolResult<unknown>) => {
  if (r.status !== 'ok') throw new Error(`tool failed: ${JSON.stringify(r)}`);
  return r.output as T;
};

function executor(twenty: TwentyClient) {
  return new ToolExecutor(
    createDefaultToolRegistry({ twenty }),
    parseToolPolicy({ tool_policy: { allow: [...EMAIL_DRAFTER_TOOLS], max_risk_level: 'LOW_WRITE' } }),
    { tenantId: 'publiexpe', executionId: `exec-${randomUUID().slice(0, 8)}`, agentId: 'agent-1', stage: 'EMAIL_DRAFTER' },
    new AbortController().signal,
  );
}

function world(decisionMaker: { email: string | null } | null = null) {
  const fake = new FakeTwenty();
  const company = fake.seed('companies', { name: 'Acme Conservas', domainName: { primaryLinkUrl: 'acme.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const signal = fake.seed('commercialSignals', { name: 'Feria — Acme', signalType: 'FAIR', eventDate: '2026-11-24', companyId: company.id });
  const person = decisionMaker ? fake.seed('people', { name: { firstName: 'Ana', lastName: 'Ruiz' }, emails: { primaryEmail: decisionMaker.email, additionalEmails: [] } }) : null;
  const hyp = fake.seed('commercialHypotheses', {
    name: 'Acme Conservas — Feria 2026',
    status: 'VALIDATED',
    need: 'Regalos para el stand',
    whyNow: 'Feria en noviembre',
    recommendedProducts: ['Bolsas tote'],
    evidence: [{ claim: 'Expositor' }],
    companyId: company.id,
    commercialSignalId: signal.id,
    decisionMakerId: person?.id ?? null,
    ...(person ? { decisionMaker: person } : {}),
  });
  return { fake, company, hyp };
}

function ctxFor(twenty: TwentyClient, input: Record<string, unknown>, provider: StubProvider, sendFromTwenty: boolean): AgentContext {
  const v = desiredEmailDrafterVersion();
  const configuration = { ...v.configuration, send_from_twenty: { enabled: sendFromTwenty } };
  return {
    tenantId: 'publiexpe',
    executionId: `exec-${randomUUID().slice(0, 8)}`,
    agent: { id: 'agent-1', name: 'EmailDrafter', role: 'email_drafter' },
    version: { id: 'v1', version: 1, model: v.model, modelProvider: 'stub', systemPrompt: v.systemPrompt, configuration },
    input,
    provider,
    signal: new AbortController().signal,
    tools: new ToolExecutor(
      createDefaultToolRegistry({ twenty }),
      parseToolPolicy(configuration),
      { tenantId: 'publiexpe', executionId: 'exec', agentId: 'agent-1', stage: 'EMAIL_DRAFTER' },
      new AbortController().signal,
    ),
  };
}

/** A TwentyClient over the fake whose PATCHes to hypotheses fail like a Twenty without the App fields. */
function clientWithoutDraftFields(fake: FakeTwenty): TwentyClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? 'GET') === 'PATCH' && url.includes('/rest/commercialHypotheses/')) {
      return new Response(JSON.stringify({ statusCode: 400, error: 'BadRequestException', messages: ['Object commercialHypothesis doesn\'t have any "emailTo" field.'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fake.fetch(input, init);
  };
  return new TwentyClient({ baseUrl: 'http://twenty.test', apiKey: 'test-key', fetch: fetchImpl, sleep: async () => {} });
}

// ---------------------------------------------------------------------------
// set_hypothesis_draft
// ---------------------------------------------------------------------------

describe('set_hypothesis_draft (LOW_WRITE, writes four fields, never sends)', () => {
  const input = (hypothesisId: string) => ({ hypothesisId, to: 'ana@acme.example', subject: 'Asunto', body: 'Hola:\n\nTexto.\n\nSi no quieres recibir más mensajes, respóndeme o escribe a baja@publiexpe.info' });

  it('writes emailTo / emailSubject / emailBody and emailStatus = DRAFT when there is no draft', async () => {
    const { fake, hyp } = world();
    const out = ok<{ written: boolean; reason: string }>((await executor(fake.client()).call('set_hypothesis_draft', input(hyp.id as string))).result);
    expect(out).toEqual({ written: true, reason: 'written', emailStatus: 'DRAFT' });
    expect(hyp).toMatchObject({ emailTo: 'ana@acme.example', emailSubject: 'Asunto', emailStatus: 'DRAFT' });
    expect(String(hyp.emailBody)).toContain('baja@publiexpe.info');
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(1);
  });

  it.each(['READY', 'SENDING', 'SENT'])('never touches a draft a person owns (%s)', async (status) => {
    const { fake, hyp } = world();
    Object.assign(hyp, { emailStatus: status, emailBody: 'editado por el comercial' });
    const out = ok<{ written: boolean; reason: string }>((await executor(fake.client()).call('set_hypothesis_draft', input(hyp.id as string))).result);
    expect(out).toMatchObject({ written: false, reason: 'human_owned', emailStatus: status });
    expect(hyp.emailBody).toBe('editado por el comercial');
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(0);
  });

  it('keeps an existing DRAFT (it may carry edits) and reports a missing hypothesis', async () => {
    const { fake, hyp } = world();
    Object.assign(hyp, { emailStatus: 'DRAFT', emailBody: 'borrador con retoques' });
    expect(ok<{ reason: string }>((await executor(fake.client()).call('set_hypothesis_draft', input(hyp.id as string))).result).reason).toBe('draft_exists');
    expect(hyp.emailBody).toBe('borrador con retoques');
    expect(ok<{ reason: string }>((await executor(fake.client()).call('set_hypothesis_draft', input(randomUUID()))).result).reason).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// EmailDrafter with and without the flag
// ---------------------------------------------------------------------------

describe('EmailDrafter: send_from_twenty flag', () => {
  it('is OFF in the seed and read as a strict boolean', () => {
    expect(desiredEmailDrafterVersion().configuration.send_from_twenty).toEqual({ enabled: true });
    expect(readDrafterConfig({}).sendFromTwenty).toBe(false);
    expect(readDrafterConfig({ send_from_twenty: { enabled: 'yes' } }).sendFromTwenty).toBe(false);
    expect(readDrafterConfig({ send_from_twenty: { enabled: true } }).sendFromTwenty).toBe(true);
  });

  it('OFF: same behaviour as before (note only, hypothesis fields untouched)', async () => {
    const { fake, hyp } = world();
    const { output, steps } = await new EmailDrafterAgent().run(ctxFor(fake.client(), { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] }), false));
    expect(output).toMatchObject({ outcome: 'SUCCESS', note_created: true, sends_email: false });
    expect(output).not.toHaveProperty('hypothesis_draft');
    // The contact step runs before (tanda 17); with send_from_twenty OFF the hypothesis fields stay untouched.
    expect(steps.filter((s) => s.type === 'TOOL').map((s) => s.tool)).toEqual(['get_hypothesis', 'find_contact', 'create_research', 'create_note']);
    expect(hyp.emailStatus).toBeUndefined();
    expect((fake.tables.notes[0] as { bodyV2: { markdown: string } }).bodyV2.markdown).not.toContain('campos Email');
  });

  it('ON: the final draft (signature + unsubscribe line) goes to the fields, To = decision maker email; the note says so', async () => {
    const { fake, hyp } = world({ email: 'ana@acme.example' });
    const { output, steps } = await new EmailDrafterAgent().run(ctxFor(fake.client(), { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] }), true));
    expect(output).toMatchObject({ outcome: 'SUCCESS', sends_email: false, hypothesis_draft: { written: true, emailStatus: 'DRAFT' } });
    expect(steps.filter((s) => s.type === 'TOOL').map((s) => s.tool)).toEqual(['get_hypothesis', 'set_hypothesis_draft', 'create_note']);
    const draft = output.draft as { subject: string; body: string };
    expect(hyp).toMatchObject({ emailTo: 'ana@acme.example', emailSubject: draft.subject, emailBody: draft.body, emailStatus: 'DRAFT' });
    expect(String(hyp.emailBody).endsWith(unsubscribeLine(DEFAULT_SENDER))).toBe(true);
    expect(String(hyp.emailBody)).toContain(DEFAULT_SENDER.name);
    const md = (fake.tables.notes[0] as { bodyV2: { markdown: string } }).bodyV2.markdown;
    expect(md).toContain('campos Email de la hipótesis');
    expect(DRAFT_IN_FIELDS_HINT).toContain('lo envías tú');
  });

  it('ON without a decision maker: To is left empty for the person to fill in', async () => {
    const { fake, hyp } = world();
    await new EmailDrafterAgent().run(ctxFor(fake.client(), { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] }), true));
    expect(hyp).toMatchObject({ emailTo: '', emailStatus: 'DRAFT' });
  });

  it('ON and redelivered: a reviewed draft (READY) is never overwritten', async () => {
    const { fake, hyp } = world();
    const agent = new EmailDrafterAgent();
    await agent.run(ctxFor(fake.client(), { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] }), true));
    Object.assign(hyp, { emailStatus: 'READY', emailBody: 'texto revisado por el comercial' });
    const again = await agent.run(ctxFor(fake.client(), { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] }), true));
    expect(again.output).toMatchObject({ outcome: 'SUCCESS', note_created: false, hypothesis_draft: { written: false, reason: 'human_owned' } });
    expect(hyp.emailBody).toBe('texto revisado por el comercial');
    expect(fake.count('PATCH', 'commercialHypotheses')).toBe(1);
  });

  it('ON but the Twenty App fields are missing: the run still succeeds with the note (clean degradation)', async () => {
    const { fake, hyp } = world();
    const { output } = await new EmailDrafterAgent().run(ctxFor(clientWithoutDraftFields(fake), { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] }), true));
    expect(output).toMatchObject({ outcome: 'SUCCESS', status: 'ok', note_created: true, hypothesis_draft: { written: false, error: expect.any(Object) } });
    expect((output.notes as string[]).join(' ')).toContain('Twenty App');
    expect((fake.tables.notes[0] as { bodyV2: { markdown: string } }).bodyV2.markdown).not.toContain('campos Email');
  });
});

// ---------------------------------------------------------------------------
// Twenty workflow definition
// ---------------------------------------------------------------------------

describe('send-draft workflow definition (Twenty 2.45)', () => {
  const wf = buildSendDraftWorkflow({ hypothesisIdFieldMetadataId: randomUUID() });
  const step = (id: string) => wf.steps.find((s) => s.id === id)! as unknown as { type: string; nextStepIds: string[]; settings: { input: Record<string, unknown>; errorHandlingOptions: unknown } };

  it('starts ONLY by hand on one hypothesis and is never activated by code', () => {
    expect(wf.activate).toBe(false);
    expect(wf.name).toBe(SEND_DRAFT_WORKFLOW_NAME);
    expect(wf.trigger).toMatchObject({ type: 'MANUAL', settings: { availability: { type: 'SINGLE_RECORD', objectNameSingular: 'commercialHypothesis' } } });
    expect(JSON.stringify(wf)).not.toMatch(/DATABASE_EVENT|CRON|WEBHOOK/);
  });

  it('re-reads the record, filters, marks SENDING, sends, marks SENT, in that order', () => {
    const ids = SEND_DRAFT_STEP_IDS;
    expect(wf.steps.map((s) => s.type)).toEqual(['FIND_RECORDS', 'FILTER', 'UPDATE_RECORD', 'SEND_EMAIL', 'UPDATE_RECORD']);
    expect((wf.trigger as { nextStepIds: string[] }).nextStepIds).toEqual([ids.find]);
    expect(step(ids.find).nextStepIds).toEqual([ids.filter]);
    expect(step(ids.filter).nextStepIds).toEqual([ids.markSending]);
    expect(step(ids.markSending).nextStepIds).toEqual([ids.send]);
    expect(step(ids.send).nextStepIds).toEqual([ids.markSent]);
    expect(step(ids.markSending).settings.input).toMatchObject({ objectRecord: { emailStatus: 'SENDING' }, fieldsToUpdate: ['emailStatus'] });
    expect(step(ids.markSent).settings.input).toMatchObject({ objectRecord: { emailStatus: 'SENT' }, fieldsToUpdate: ['emailStatus'] });
    const find = step(ids.find).settings.input as { filter: { recordFilters: Array<{ value: string }> } };
    expect(find.filter.recordFilters[0]!.value).toBe(TRIGGER_RECORD_ID);
  });

  it('sends only when Email status = READY, the hypothesis is VALIDATED and To / Subject / Body are filled (fresh values)', () => {
    const filters = (step(SEND_DRAFT_STEP_IDS.filter).settings.input as { stepFilters: Array<{ stepOutputKey: string; operand: string; value: string }> }).stepFilters;
    const by = (field: string) => filters.find((f) => f.stepOutputKey === `{{${SEND_DRAFT_STEP_IDS.find}.first.${field}}}`);
    expect(by('emailStatus')).toMatchObject({ operand: 'IS', value: '["READY"]' });
    expect(by('status')).toMatchObject({ operand: 'IS', value: '["VALIDATED"]' });
    for (const f of ['emailTo', 'emailSubject', 'emailBody']) expect(by(f)).toMatchObject({ operand: 'IS_NOT_EMPTY' });
  });

  it('sends from the mailbox of whoever clicked, with no retry, using the fresh fields', () => {
    const send = step(SEND_DRAFT_STEP_IDS.send);
    expect(send.settings.input).toMatchObject({
      connectedAccountId: TRIGGER_WORKSPACE_MEMBER_ID,
      recipients: { to: `{{${SEND_DRAFT_STEP_IDS.find}.first.emailTo}}`, cc: '', bcc: '' },
      subject: `{{${SEND_DRAFT_STEP_IDS.find}.first.emailSubject}}`,
      files: [],
    });
    for (const s of wf.steps) expect((s.settings as { errorHandlingOptions: unknown }).errorHandlingOptions).toEqual({ retryOnFailure: { value: 0 }, continueOnFailure: { value: false } });
    expect(buildSendDraftWorkflow({ hypothesisIdFieldMetadataId: randomUUID(), senderId: 'acct-1' }).steps[3]!.settings).toMatchObject({ input: { connectedAccountId: 'acct-1' } });
  });

  it('the body is an email document with one html node <pre> around the body variable (line breaks kept, value escaped by Twenty)', () => {
    const doc = JSON.parse(sendDraftEmailBodyDocument('{{x.body}}')) as { type: string; version: number; content: Array<{ type: string; attrs: { html: string } }> };
    expect(doc).toEqual({ type: 'doc', version: 1, content: [{ type: 'html', attrs: { html: `<pre style="${BODY_PRE_STYLE}">{{x.body}}</pre>` } }] });
    expect(BODY_PRE_STYLE).toContain('white-space:pre-wrap');
    expect((step(SEND_DRAFT_STEP_IDS.send).settings.input as { body: string }).body).toContain(`{{${SEND_DRAFT_STEP_IDS.find}.first.emailBody}}`);
  });
});

// ---------------------------------------------------------------------------
// pnpm twenty:send-workflow
// ---------------------------------------------------------------------------

describe('createSendWorkflow (script)', () => {
  type Call = { method: string; url: string; body?: unknown };
  function fakeTwentyHttp(opts: { fields: string[]; existing?: boolean }) {
    const calls: Call[] = [];
    const idFieldId = randomUUID();
    const sse = (payload: unknown) =>
      new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const f: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ method, url, body });
      if (url.includes('/rest/metadata/objects')) {
        const fields = [{ id: idFieldId, name: 'id', type: 'UUID' }, ...opts.fields.map((n) => ({ id: randomUUID(), name: n, type: 'TEXT' }))];
        return Response.json({ data: [{ id: randomUUID(), nameSingular: 'commercialHypothesis', fields }] });
      }
      if (url.includes('/rest/workflows')) return Response.json({ data: { workflows: opts.existing ? [{ id: 'wf-1', name: SEND_DRAFT_WORKFLOW_NAME, deletedAt: null }] : [] } });
      if (url.endsWith('/mcp')) {
        const tool = (body as { params: { arguments: { toolName: string } } }).params.arguments.toolName;
        if (tool === 'create_complete_workflow') return sse({ success: true, result: { coreWorkflowId: 'cw-1', coreWorkflowVersionId: 'cv-1' } });
        if (tool === 'validate_workflow') return sse({ success: true, message: 'The workflow version can be activated.' });
      }
      return new Response('not found', { status: 404 });
    };
    return { f, calls, idFieldId };
  }

  it('dry run (default): only GETs, reports missing App fields, embeds the id field metadata', async () => {
    const { f, calls, idFieldId } = fakeTwentyHttp({ fields: [] });
    const out = await createSendWorkflow({ baseUrl: 'http://twenty.test', apiKey: 'k', apply: false, fetch: f });
    expect(out).toMatchObject({ action: 'dry-run', missingFields: [...REQUIRED_HYPOTHESIS_FIELDS], existingWorkflowId: null });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(JSON.stringify(out)).toContain(idFieldId);
  });

  it('--apply is blocked until the App fields exist, and never duplicates an existing workflow', async () => {
    const missing = fakeTwentyHttp({ fields: ['emailTo'] });
    expect(await createSendWorkflow({ baseUrl: 'http://twenty.test', apiKey: 'k', apply: true, fetch: missing.f })).toMatchObject({ action: 'blocked', missingFields: ['emailSubject', 'emailBody', 'emailStatus'] });
    expect(missing.calls.some((c) => c.method === 'POST')).toBe(false);
    const existing = fakeTwentyHttp({ fields: [...REQUIRED_HYPOTHESIS_FIELDS], existing: true });
    expect(await createSendWorkflow({ baseUrl: 'http://twenty.test', apiKey: 'k', apply: true, fetch: existing.f })).toEqual({ action: 'exists', existingWorkflowId: 'wf-1' });
    expect(existing.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('--apply creates the workflow as a DRAFT (activate: false) and only validates it', async () => {
    const { f, calls } = fakeTwentyHttp({ fields: [...REQUIRED_HYPOTHESIS_FIELDS] });
    const out = await createSendWorkflow({ baseUrl: 'http://twenty.test', apiKey: 'k', apply: true, fetch: f });
    expect(out).toMatchObject({ action: 'created', validation: { success: true } });
    const mcp = calls.filter((c) => c.url.endsWith('/mcp')).map((c) => (c.body as { params: { name: string; arguments: { toolName: string; arguments: Record<string, unknown> } } }).params);
    expect(mcp.map((p) => [p.name, p.arguments.toolName])).toEqual([
      ['execute_tool', 'create_complete_workflow'],
      ['execute_tool', 'validate_workflow'],
    ]);
    expect(mcp[0]!.arguments.arguments).toMatchObject({ name: SEND_DRAFT_WORKFLOW_NAME, activate: false });
    // Never asks Twenty to send or activate anything.
    expect(JSON.stringify(mcp)).not.toMatch(/send_email|draft_email|activate_workflow/);
  });

  it('parses SSE and JSON MCP responses and surfaces MCP errors', () => {
    expect(parseMcpResponse('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(mcpToolResult(parseMcpResponse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"a\\":1}"}]}}\n\n'))).toEqual({ a: 1 });
    expect(() => mcpToolResult({ error: { message: 'Forbidden' } })).toThrow(/Forbidden/);
  });
});
