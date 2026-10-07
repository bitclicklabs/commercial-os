import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../src/agents/agent.js';
import {
  DEFAULT_COMPANY_DESCRIPTOR,
  DEFAULT_SENDER,
  DRAFT_NOTE_HEADER,
  buildDraftNoteMarkdown,
  countWords,
  draftNoteTitle,
  escapeMarkdown,
  finalizeDraft,
  parseEmailDraft,
  unsubscribeLine,
} from '../../src/agents/email-draft.js';
import { EMAIL_DRAFTER_SYSTEM_PROMPT, buildDraftPrompt } from '../../src/agents/email-drafter-prompt.js';
import { EMAIL_DRAFTER_TOOLS, EmailDrafterAgent, differentiatorsFromEvidence, readDrafterConfig, readDrafterInput } from '../../src/agents/email-drafter.js';
import { resolveAgentImplementation } from '../../src/agents/stub-agent.js';
import { EventEnvelopeSchema, type EventEnvelope } from '../../src/events/envelope.js';
import { evaluationRecordedEvent } from '../../src/events/runtime-events.js';
import { evaluateTrigger, eventTriggeredInput, parseEventTrigger } from '../../src/events/triggers.js';
import { StubProvider } from '../../src/providers/index.js';
import { desiredEmailDraftTask, desiredEmailDrafterVersion } from '../../src/seed/email-drafter-seed.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor, type ToolResult } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const BODY_120 = [
  'Hola, equipo de Conservas Marineras del Cantábrico:',
  '',
  'Soy Jesús Abril, de PubliEXPE, expertos en merchandising para empresas. He visto que estaréis en Expo Alimentaria Ibérica el 24 de noviembre presentando vuestra nueva línea de ventresca, y he pensado que os puede venir bien tener resuelto el material para el stand con tiempo.',
  '',
  'Podemos prepararos bolsas tote de algodón personalizadas para los visitantes, polos bordados para vuestro equipo comercial y algún detalle gourmet para compradores y distribuidores. Tenemos taller propio, así que personalizamos en casa y con plazos cortos, y un comercial de referencia os acompaña en todo el pedido para que no tengáis que perseguir a nadie.',
  '',
  '¿Te encaja que te mande dos o tres propuestas con precios para que las veáis con calma esta semana? Si lo prefieres, también podemos hablar por teléfono diez minutos cuando te venga bien.',
  '',
  'Un saludo,',
].join('\n');

const ANSWER = { asunto: 'Material para vuestro stand en Expo Alimentaria Ibérica', cuerpo: BODY_120 };
const opts = (contact: { firstName: string | null; lastName: string | null } | null = null) => ({
  sender: DEFAULT_SENDER,
  companyName: 'Conservas Marineras del Cantábrico',
  contact,
});

describe('parseEmailDraft (zod contract of the model answer)', () => {
  it('accepts {asunto, cuerpo}, also inside ```json fences', () => {
    expect(parseEmailDraft(JSON.stringify(ANSWER))).toMatchObject({ ok: true, value: { asunto: ANSWER.asunto } });
    expect(parseEmailDraft('```json\n' + JSON.stringify(ANSWER) + '\n```').ok).toBe(true);
  });

  it('rejects missing or empty fields and broken JSON', () => {
    expect(parseEmailDraft(JSON.stringify({ asunto: 'Hola' }))).toMatchObject({ ok: false, error: expect.stringContaining('cuerpo') });
    expect(parseEmailDraft(JSON.stringify({ asunto: 'x', cuerpo: BODY_120 }))).toMatchObject({ ok: false, error: expect.stringContaining('asunto') });
    expect(parseEmailDraft(JSON.stringify({ asunto: 'Asunto válido', cuerpo: 'corto' })).ok).toBe(false);
    expect(parseEmailDraft('{"asunto": ').ok).toBe(false);
  });
});

describe('finalizeDraft (compliance by code)', () => {
  it('ALWAYS ends with the unsubscribe line, even when the model omits it', () => {
    const d = finalizeDraft(ANSWER, opts());
    const lines = d.body.split('\n');
    expect(lines[lines.length - 1]).toBe('Si no quieres recibir más mensajes, respóndeme o escribe a baja@publiexpe.info');
    expect(lines[lines.length - 1]).toBe(unsubscribeLine(DEFAULT_SENDER));
    expect(d.fixes).toContain('unsubscribe_line_added');
  });

  it('replaces an opt-out line written by the model: the canonical line appears exactly once, at the end', () => {
    const cuerpo = `${BODY_120}\n\nSi no deseas recibir más correos, escríbeme a baja@publiexpe.info.\nPrivacidad: tratamos tus datos según el RGPD.`;
    const d = finalizeDraft({ ...ANSWER, cuerpo }, opts());
    expect(d.body.match(/baja@publiexpe\.info/g)).toHaveLength(1);
    expect(d.body.endsWith(unsubscribeLine(DEFAULT_SENDER))).toBe(true);
    expect(d.body).not.toMatch(/RGPD|no deseas/);
    expect(d.fixes).toContain('unsubscribe_line_replaced');
  });

  it('adds the sender signature (name, company, web) before the unsubscribe line', () => {
    const d = finalizeDraft(ANSWER, opts());
    expect(d.body).toContain('Un saludo,\n\nJesús Abril\nPubliEXPE · Merchandising y regalo promocional personalizado\nwww.publiexpe.com\n\nSi no quieres');
    expect(d.fixes).toContain('signature_added');
    expect(d.fixes).not.toContain('farewell_added');
  });

  it('keeps a signature the model already wrote and adds a farewell only when missing', () => {
    const signed = finalizeDraft({ ...ANSWER, cuerpo: `${BODY_120}\nJesús Abril\nPubliEXPE` }, opts());
    expect(signed.body.match(/Jesús Abril\n/g)).toHaveLength(1);
    expect(signed.fixes).not.toContain('signature_added');
    const noFarewell = finalizeDraft({ ...ANSWER, cuerpo: BODY_120.replace(/\n\nUn saludo,$/, '') }, opts());
    expect(noFarewell.fixes).toContain('farewell_added');
    expect(noFarewell.body).toContain('Un saludo,\n\nJesús Abril');
  });

  it('removes an invented contact name from the greeting when there is no decision maker', () => {
    const d = finalizeDraft({ ...ANSWER, cuerpo: BODY_120.replace('Hola, equipo de Conservas Marineras del Cantábrico:', 'Hola Marta,') }, opts());
    expect(d.body.startsWith('Hola:\n')).toBe(true);
    expect(d.fixes).toContain('greeting_name_removed');
    expect(d.warnings.join(' ')).toMatch(/saludo/);
    // Company names and generic greetings are fine.
    expect(finalizeDraft({ ...ANSWER, cuerpo: BODY_120.replace('Hola, equipo de', 'Hola, Conservas Marineras, equipo de') }, opts()).fixes).not.toContain('greeting_name_removed');
    // With a known contact, that name is allowed and a different one is replaced by it.
    expect(finalizeDraft({ ...ANSWER, cuerpo: BODY_120.replace(/^Hola[^\n]*/, 'Hola, Ana:') }, opts({ firstName: 'Ana', lastName: 'Ruiz' })).fixes).not.toContain('greeting_name_removed');
    expect(finalizeDraft({ ...ANSWER, cuerpo: BODY_120.replace(/^Hola[^\n]*/, 'Hola Pedro,') }, opts({ firstName: 'Ana', lastName: 'Ruiz' })).body.startsWith('Hola, Ana:')).toBe(true);
  });

  it('counts the words of the model text only and warns outside 120-180', () => {
    const d = finalizeDraft(ANSWER, opts());
    expect(d.wordCount).toBe(countWords(BODY_120));
    expect(d.wordCount).toBeGreaterThanOrEqual(120);
    expect(d.warnings.filter((w) => w.includes('palabras'))).toHaveLength(0);
    const short = finalizeDraft({ ...ANSWER, cuerpo: 'Hola:\n\nSoy Jesús, de PubliEXPE. ¿Hablamos de vuestro stand?\n\nUn saludo,' }, opts());
    expect(short.warnings.join(' ')).toMatch(/palabras/);
    expect(short.body.endsWith(unsubscribeLine(DEFAULT_SENDER))).toBe(true);
  });

  it('cleans the subject and strips markdown from the body', () => {
    const d = finalizeDraft({ asunto: 'Asunto: "Vuestro stand en Expo Alimentaria".', cuerpo: BODY_120.replace('taller propio', '**taller propio**') }, opts());
    expect(d.subject).toBe('Vuestro stand en Expo Alimentaria');
    expect(d.body).not.toContain('**');
    expect(d.fixes).toContain('markdown_removed');
  });
});

describe('finalizeDraft: the first mention of PubliEXPE says what it is', () => {
  const PRESENTACION = 'Soy Jesús Abril, de PubliEXPE, expertos en merchandising para empresas.';
  const withIntro = (intro: string) => BODY_120.replace(PRESENTACION, intro);

  it('leaves the body untouched when the model already said it (brand descriptor or a natural variant)', () => {
    const d = finalizeDraft(ANSWER, opts());
    expect(d.fixes).not.toContain('company_descriptor_added');
    expect(d.body.match(/expertos en merchandising/g)).toHaveLength(1);
    const variant = finalizeDraft({ ...ANSWER, cuerpo: withIntro('Soy Jesús Abril, de PubliEXPE; somos especialistas en merchandising y regalo promocional.') }, opts());
    expect(variant.fixes).not.toContain('company_descriptor_added');
    expect(variant.body).toContain('de PubliEXPE; somos especialistas en merchandising y regalo promocional.');
  });

  it('injects the descriptor when the model omitted it ("de PubliEXPE." -> "de PubliEXPE, expertos en ...")', () => {
    const d = finalizeDraft({ ...ANSWER, cuerpo: withIntro('Soy Jesús Abril, de PubliEXPE.') }, opts());
    expect(d.fixes).toContain('company_descriptor_added');
    expect(d.body).toContain('Soy Jesús Abril, de PubliEXPE, expertos en merchandising para empresas. He visto que');
    // The word count is the one of the final text (descriptor included).
    expect(d.wordCount).toBe(countWords(BODY_120));
    // Mid-sentence mention: the descriptor goes between commas so the sentence still reads.
    const mid = finalizeDraft({ ...ANSWER, cuerpo: withIntro('Soy Jesús Abril y te escribo desde PubliEXPE porque he visto vuestra feria.') }, opts());
    expect(mid.body).toContain('desde PubliEXPE, expertos en merchandising para empresas, porque he visto');
  });

  it('injects it at the FIRST mention when only a later one carries a descriptor', () => {
    const cuerpo = withIntro('Soy Jesús Abril, de PubliEXPE.').replace('Tenemos taller propio', 'En PubliEXPE, especialistas en merchandising, tenemos taller propio');
    const d = finalizeDraft({ ...ANSWER, cuerpo }, opts());
    expect(d.fixes).toContain('company_descriptor_added');
    expect(d.body).toContain('Soy Jesús Abril, de PubliEXPE, expertos en merchandising para empresas. He visto');
    expect(d.body).toContain('En PubliEXPE, especialistas en merchandising, tenemos taller propio');
  });

  it('does not touch a body that never names PubliEXPE (the signature identifies the sender)', () => {
    const cuerpo = withIntro('Soy Jesús Abril.');
    const d = finalizeDraft({ ...ANSWER, cuerpo }, opts());
    expect(d.fixes).not.toContain('company_descriptor_added');
    expect(d.body.startsWith(cuerpo)).toBe(true);
    expect(d.body).toContain('Jesús Abril\nPubliEXPE · Merchandising y regalo promocional personalizado');
    // A signature written by the model, domains and addresses are not mentions.
    const sig = finalizeDraft({ ...ANSWER, cuerpo: `${cuerpo}\n\nJesús Abril\nPubliEXPE` }, opts());
    expect(sig.fixes).not.toContain('company_descriptor_added');
    expect(sig.body).toContain('Jesús Abril\nPubliEXPE\n');
    const web = finalizeDraft({ ...ANSWER, cuerpo: withIntro('Soy Jesús Abril; tienes el catálogo en www.publiexpe.com y puedes escribir a info@publiexpe.info.') }, opts());
    expect(web.fixes).not.toContain('company_descriptor_added');
  });

  it('the descriptor is configurable (configuration.company_descriptor) and defaults to the brand one', () => {
    expect(DEFAULT_COMPANY_DESCRIPTOR).toBe('expertos en merchandising para empresas');
    expect(readDrafterConfig({}).companyDescriptor).toBe(DEFAULT_COMPANY_DESCRIPTOR);
    expect(desiredEmailDrafterVersion().configuration.company_descriptor).toBe(DEFAULT_COMPANY_DESCRIPTOR);
    const custom = readDrafterConfig({ company_descriptor: 'especialistas en regalo promocional' }).companyDescriptor;
    expect(custom).toBe('especialistas en regalo promocional');
    const d = finalizeDraft({ ...ANSWER, cuerpo: withIntro('Soy Jesús Abril, de PubliEXPE.') }, { ...opts(), companyDescriptor: custom });
    expect(d.body).toContain('de PubliEXPE, especialistas en regalo promocional. He visto');
  });
});

describe('draft note markdown', () => {
  it('starts with the BORRADOR header and carries subject, sender and the full body', () => {
    const draft = finalizeDraft(ANSWER, opts());
    const md = buildDraftNoteMarkdown({
      draft,
      sender: DEFAULT_SENDER,
      contact: null,
      hypothesisName: 'Conservas Marineras del Cantábrico — Expo Alimentaria Ibérica 2026',
      feedback: 'ACCEPTED',
      evaluatedAt: '2026-10-07T10:00:00.000Z',
      executionId: 'exec-1',
    });
    expect(md.split('\n')[0]).toBe(`> **${DRAFT_NOTE_HEADER}**`);
    expect(DRAFT_NOTE_HEADER).toBe('BORRADOR — revísalo y envíalo desde tu correo; el sistema no envía nada.');
    expect(md).toContain('**Asunto:** Material para vuestro stand en Expo Alimentaria Ibérica');
    expect(md).toContain('jesus.abril@publiexpe.info');
    expect(md).toContain('añade tú el destinatario');
    expect(md).toContain(unsubscribeLine(DEFAULT_SENDER));
    expect(md).toContain('veredicto ACCEPTED del 2026-10-07');
  });

  it('escapes markdown so the pasted text is the model text', () => {
    expect(escapeMarkdown('- uno\n1. dos\n*tres* <cuatro> [cinco]')).toBe('\\- uno\n1\\. dos\n\\*tres\\* \\<cuatro\\> \\[cinco\\]');
    expect(draftNoteTitle('X — Y')).toBe('Borrador email — X — Y');
  });
});

describe('prompt', () => {
  it('puts CRM data inside an untrusted block and never asks for budgets', () => {
    const p = buildDraftPrompt({
      today: '2026-10-07',
      sender: { name: 'Jesús Abril', company: 'PubliEXPE', descriptor: DEFAULT_COMPANY_DESCRIPTOR },
      company: { name: 'Conservas', domain: 'conservas.example' },
      contact: null,
      signal: { name: 'Expo', type: 'FAIR', date: '2026-11-24', description: 'Expositor' },
      hypothesis: { need: 'Regalos', whyNow: 'Feria', recommendedProducts: ['Bolsas'], timing: 'THIS_QUARTER', differentiators: ['TALLER_PROPIO'] },
    });
    expect(p).toMatch(/<<<DATOS_NO_CONFIABLES id=\w+/);
    expect(p).toContain('"contacto": null');
    expect(p).not.toMatch(/budget|presupuesto_/i);
    expect(EMAIL_DRAFTER_SYSTEM_PROMPT).toMatch(/No escribas la firma ni ninguna línea de baja/);
    expect(EMAIL_DRAFTER_SYSTEM_PROMPT).toMatch(/Nunca pongas un nombre propio en el saludo/);
    expect(p).toContain('Remitente: Jesús Abril, de PubliEXPE, expertos en merchandising para empresas.');
    expect(EMAIL_DRAFTER_SYSTEM_PROMPT).toMatch(/QUÉ ES PubliEXPE/);
    expect(EMAIL_DRAFTER_SYSTEM_PROMPT).toContain('de PubliEXPE, expertos en merchandising para empresas');
  });

  it('reads the differentiators recorded by the Prospector', () => {
    const found = differentiatorsFromEvidence([{ claim: 'Diferenciales de PubliEXPE aplicables: TALLER_PROPIO, TRATO_CERCANO, PRECIO.' }, { claim: 'otra' }]);
    expect([...found].sort()).toEqual(['PRECIO', 'TALLER_PROPIO', 'TRATO_CERCANO']);
  });
});

// ---------------------------------------------------------------------------
// Tools against the fake Twenty
// ---------------------------------------------------------------------------

function executor(fake: FakeTwenty, allow: string[] = [...EMAIL_DRAFTER_TOOLS]) {
  return new ToolExecutor(
    createDefaultToolRegistry({ twenty: fake.client() }),
    parseToolPolicy({ tool_policy: { allow, max_risk_level: 'LOW_WRITE' } }),
    { tenantId: 'publiexpe', executionId: `exec-${randomUUID().slice(0, 8)}`, agentId: 'agent-1', stage: 'EMAIL_DRAFTER' },
    new AbortController().signal,
  );
}

const ok = <T>(r: ToolResult<unknown>) => {
  if (r.status !== 'ok') throw new Error(`tool failed: ${JSON.stringify(r)}`);
  return r.output as T;
};

describe('create_note (idempotent by company + title)', () => {
  type NoteOut = { created: boolean; adopted: boolean; record: { id: string; targetIds: string[] } };

  it('creates note + company and hypothesis targets once; a repeat returns the same note', async () => {
    const fake = new FakeTwenty();
    const company = fake.seed('companies', { name: 'Acme' });
    const hyp = fake.seed('commercialHypotheses', { name: 'Acme — Feria', companyId: company.id, status: 'PROPOSED' });
    const input = { companyId: company.id, hypothesisId: hyp.id, title: 'Borrador email — Acme "Feria"', bodyMarkdown: '> **BORRADOR**\n\nHola' };
    const first = ok<NoteOut>((await executor(fake).call('create_note', input)).result);
    expect(first).toMatchObject({ created: true, adopted: false });
    expect(fake.tables.notes).toHaveLength(1);
    expect(fake.tables.notes[0]).toMatchObject({ title: 'Borrador email — Acme Feria', bodyV2: { markdown: input.bodyMarkdown } });
    expect(fake.tables.noteTargets.map((t) => [t.noteId, t.targetCompanyId, t.targetCommercialHypothesisId])).toEqual([
      [first.record.id, company.id, null],
      [first.record.id, null, hyp.id],
    ]);

    const second = ok<NoteOut>((await executor(fake).call('create_note', { ...input, bodyMarkdown: 'otro texto' })).result);
    expect(second).toMatchObject({ created: false, adopted: false, record: { id: first.record.id } });
    expect(fake.tables.notes).toHaveLength(1);
    expect(fake.tables.noteTargets).toHaveLength(2);
    expect(fake.count('POST', 'notes')).toBe(1);
  });

  it('the same title on another company is a different note', async () => {
    const fake = new FakeTwenty();
    const a = fake.seed('companies', { name: 'A' });
    const b = fake.seed('companies', { name: 'B' });
    await executor(fake).call('create_note', { companyId: a.id, title: 'Borrador email — X', bodyMarkdown: 'a' });
    const r = ok<NoteOut>((await executor(fake).call('create_note', { companyId: b.id, title: 'Borrador email — X', bodyMarkdown: 'b' })).result);
    expect(r.created).toBe(true);
    expect(fake.tables.notes).toHaveLength(2);
  });

  it('adopts an orphan note left by a call that died between the two POSTs', async () => {
    const fake = new FakeTwenty();
    const company = fake.seed('companies', { name: 'Acme' });
    fake.failNextCreate = 'noteTargets';
    const failed = await executor(fake).call('create_note', { companyId: company.id, title: 'Borrador email — Y', bodyMarkdown: 'x' });
    expect(failed.result.status).toBe('error');
    expect(fake.tables.notes).toHaveLength(1);
    expect(fake.tables.noteTargets).toHaveLength(0);
    const retry = ok<NoteOut>((await executor(fake).call('create_note', { companyId: company.id, title: 'Borrador email — Y', bodyMarkdown: 'x' })).result);
    expect(retry).toMatchObject({ created: false, adopted: true, record: { id: fake.tables.notes[0]!.id } });
    expect(fake.tables.notes).toHaveLength(1);
    expect(fake.tables.noteTargets).toHaveLength(1);
  });
});

describe('get_hypothesis', () => {
  it('returns the hypothesis with company, signal and decision maker (depth 1)', async () => {
    const fake = new FakeTwenty();
    const company = fake.seed('companies', { name: 'Acme', domainName: { primaryLinkUrl: 'acme.example', primaryLinkLabel: '', secondaryLinks: [] } });
    const signal = fake.seed('commercialSignals', { name: 'Feria — Acme', signalType: 'FAIR', eventDate: '2026-11-24', description: 'Expositor', companyId: company.id });
    const person = fake.seed('people', { name: { firstName: 'Ana', lastName: 'Ruiz' }, jobTitle: 'Marketing', emails: { primaryEmail: 'ana@acme.example' } });
    const hyp = fake.seed('commercialHypotheses', {
      name: 'Acme — Feria',
      status: 'PROPOSED',
      need: 'Regalos',
      whyNow: 'Feria',
      budgetMax: { amountMicros: 6_500_000_000, currencyCode: 'EUR' },
      recommendedProducts: ['Bolsas'],
      evidence: [{ claim: 'c1', sourceUrl: 'https://feria.example' }],
      companyId: company.id,
      commercialSignalId: signal.id,
      decisionMakerId: person.id,
    });
    const out = ok<Record<string, unknown>>((await executor(fake).call('get_hypothesis', { hypothesisId: hyp.id })).result);
    expect(out).toMatchObject({
      found: true,
      hypothesis: { id: hyp.id, budgetMaxEur: 6500, evidence: [{ claim: 'c1', sourceUrl: 'https://feria.example' }] },
      company: { id: company.id, domain: 'acme.example' },
      signal: { id: signal.id, eventDate: '2026-11-24' },
      decisionMaker: { firstName: 'Ana', email: 'ana@acme.example' },
    });
    expect(ok<{ found: boolean }>((await executor(fake).call('get_hypothesis', { hypothesisId: randomUUID() })).result).found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

function world() {
  const fake = new FakeTwenty();
  const company = fake.seed('companies', { name: 'Conservas Marineras del Cantábrico', domainName: { primaryLinkUrl: 'conservas.example', primaryLinkLabel: '', secondaryLinks: [] } });
  const signal = fake.seed('commercialSignals', { name: 'Expo — Conservas', signalType: 'FAIR', eventDate: '2026-11-24', description: 'Expositor', companyId: company.id });
  const hyp = fake.seed('commercialHypotheses', {
    name: 'Conservas Marineras del Cantábrico — Expo Alimentaria Ibérica 2026',
    status: 'PROPOSED',
    need: 'Material promocional',
    whyNow: 'Feria el 24/11',
    recommendedProducts: ['Bolsas tote'],
    evidence: [{ claim: 'Diferenciales de PubliEXPE aplicables: TALLER_PROPIO, PRECIO.' }],
    companyId: company.id,
    commercialSignalId: signal.id,
    decisionMakerId: null,
  });
  return { fake, company, hyp };
}

function envelope(data: Record<string, unknown>): EventEnvelope {
  return EventEnvelopeSchema.parse({
    id: randomUUID(),
    type: 'evaluation.recorded',
    schemaVersion: 'evaluation.recorded.v1',
    tenantId: 'publiexpe',
    occurredAt: '2026-10-07T10:00:00.000Z',
    producer: 'agent-runtime',
    correlationId: 'corr',
    data: { evaluationId: randomUUID(), subjectType: 'hypothesis', feedback: 'ACCEPTED', score: 1, occurredAt: '2026-10-07T10:00:00.000Z', ...data },
  });
}

function ctxFor(fake: FakeTwenty, input: Record<string, unknown>, provider: StubProvider): AgentContext {
  const v = desiredEmailDrafterVersion();
  return {
    tenantId: 'publiexpe',
    executionId: `exec-${randomUUID().slice(0, 8)}`,
    agent: { id: 'agent-1', name: 'EmailDrafter', role: 'email_drafter' },
    version: { id: 'v1', version: 1, model: v.model, modelProvider: 'stub', systemPrompt: v.systemPrompt, configuration: v.configuration },
    input,
    provider,
    signal: new AbortController().signal,
    tools: new ToolExecutor(
      createDefaultToolRegistry({ twenty: fake.client() }),
      parseToolPolicy(v.configuration),
      { tenantId: 'publiexpe', executionId: 'exec', agentId: 'agent-1', stage: 'EMAIL_DRAFTER' },
      new AbortController().signal,
    ),
  };
}

describe('EmailDrafterAgent', () => {
  it('is resolved from configuration.implementation = "email_drafter"; seed policy has no mail tool', () => {
    expect(resolveAgentImplementation({ implementation: 'email_drafter' }).kind).toBe('email_drafter');
    const policy = parseToolPolicy(desiredEmailDrafterVersion().configuration);
    expect([...policy.allow].sort()).toEqual(['create_note', 'find_company', 'get_company', 'get_hypothesis', 'set_hypothesis_draft']);
    expect(policy.maxRiskLevel).toBe('LOW_WRITE');
    expect(policy.allow.some((t) => /mail|send/.test(t))).toBe(false);
  });

  it('event -> one LLM call -> note on company and hypothesis, with header and unsubscribe line (model omitted it)', async () => {
    const { fake, company, hyp } = world();
    const provider = new StubProvider({ responses: [JSON.stringify(ANSWER)], usage: { inputTokens: 900, outputTokens: 250, cachedTokens: 0 }, costPerCall: 0.0012 });
    const ev = envelope({ subjectId: hyp.id, companyId: company.id });
    const { output, steps } = await new EmailDrafterAgent().run(ctxFor(fake, eventTriggeredInput(ev), provider));
    expect(output).toMatchObject({ outcome: 'SUCCESS', status: 'ok', note_created: true, sends_email: false, company_id: company.id, cost: { llm_calls: 1 } });
    expect(provider.requests).toHaveLength(1);
    expect(fake.tables.notes).toHaveLength(1);
    const note = fake.tables.notes[0] as { title: string; bodyV2: { markdown: string } };
    expect(note.title).toBe(`Borrador email — ${hyp.name as string}`);
    expect(note.bodyV2.markdown.startsWith(`> **${DRAFT_NOTE_HEADER}**`)).toBe(true);
    expect(note.bodyV2.markdown).toContain('baja@publiexpe.info');
    expect((output.draft as { body: string }).body.endsWith(unsubscribeLine(DEFAULT_SENDER))).toBe(true);
    expect(fake.tables.noteTargets.map((t) => t.targetCompanyId ?? t.targetCommercialHypothesisId)).toEqual([company.id, hyp.id]);
    expect(steps.filter((s) => s.type === 'TOOL').map((s) => s.tool)).toEqual(['get_hypothesis', 'create_note']);

    // Second delivery (another event, same hypothesis): same note, nothing new in Twenty.
    const again = await new EmailDrafterAgent().run(ctxFor(fake, eventTriggeredInput(envelope({ subjectId: hyp.id })), new StubProvider({ responses: [JSON.stringify(ANSWER)] })));
    expect(again.output).toMatchObject({ outcome: 'SUCCESS', note_created: false });
    expect(fake.tables.notes).toHaveLength(1);
  });

  it('manual input { hypothesis_id } works too', async () => {
    const { fake, hyp } = world();
    const { output } = await new EmailDrafterAgent().run(ctxFor(fake, { hypothesis_id: hyp.id }, new StubProvider({ responses: [JSON.stringify(ANSWER)] })));
    expect(output).toMatchObject({ outcome: 'SUCCESS', note_created: true, evaluation_id: null });
  });

  it('skips without calling the LLM: DISCARDED verdict, non-hypothesis subject, rejected hypothesis', async () => {
    const { fake, hyp } = world();
    const provider = new StubProvider({ responses: [JSON.stringify(ANSWER)] });
    const discarded = await new EmailDrafterAgent().run(ctxFor(fake, eventTriggeredInput(envelope({ subjectId: hyp.id, feedback: 'DISCARDED' })), provider));
    expect(discarded.output).toMatchObject({ outcome: 'SKIPPED' });
    const other = await new EmailDrafterAgent().run(ctxFor(fake, eventTriggeredInput(envelope({ subjectId: hyp.id, subjectType: 'research' })), provider));
    expect(other.output).toMatchObject({ outcome: 'SKIPPED' });
    (hyp as Record<string, unknown>).status = 'REJECTED';
    const rejected = await new EmailDrafterAgent().run(ctxFor(fake, eventTriggeredInput(envelope({ subjectId: hyp.id })), provider));
    expect(rejected.output).toMatchObject({ outcome: 'SKIPPED', reason: expect.stringContaining('REJECTED') });
    expect(provider.requests).toHaveLength(0);
    expect(fake.tables.notes).toHaveLength(0);
  });

  it('invalid model output: FAILED, no note, a single LLM call (no repair round)', async () => {
    const { fake, hyp } = world();
    const provider = new StubProvider({ responses: ['no es JSON'] });
    const { output } = await new EmailDrafterAgent().run(ctxFor(fake, { hypothesis_id: hyp.id }, provider));
    expect(output).toMatchObject({ outcome: 'FAILED', status: 'error', error: { code: 'LLM_INVALID_OUTPUT' } });
    expect(provider.requests).toHaveLength(1);
    expect(fake.tables.notes).toHaveLength(0);
  });

  it('readDrafterInput rejects malformed input', () => {
    expect(readDrafterInput({})).toMatchObject({ ok: false, skip: false });
    expect(readDrafterInput({ event: { id: 'x', type: 'task.completed', data: {} } })).toMatchObject({ ok: false, skip: false });
  });
});

// ---------------------------------------------------------------------------
// evaluation.recorded and the EVENT filter of the seed task
// ---------------------------------------------------------------------------

describe('evaluation.recorded + draft-email-on-validated trigger', () => {
  const evaluation = {
    id: randomUUID(),
    tenantId: 'publiexpe',
    evaluatorId: 'human-v1',
    subjectType: 'hypothesis',
    subjectId: randomUUID(),
    feedback: 'ACCEPTED',
    score: 1,
    agentExecutionId: null,
    taskRunId: null,
    source: 'api',
    details: { to_status: 'VALIDATED', link: { resolved: false } },
    occurredAt: new Date('2026-10-07T10:00:00Z'),
  };

  it('builds a compact payload keyed by the evaluation id', () => {
    const ev = evaluationRecordedEvent(evaluation, { companyId: 'c-1' });
    expect(ev).toMatchObject({ type: 'evaluation.recorded', idempotencyKey: `evt:evaluation.recorded:${evaluation.id}`, correlationId: evaluation.id });
    expect(ev.data).toEqual({
      evaluationId: evaluation.id,
      evaluatorId: 'human-v1',
      subjectType: 'hypothesis',
      subjectId: evaluation.subjectId,
      feedback: 'ACCEPTED',
      score: 1,
      toStatus: 'VALIDATED',
      source: 'api',
      agentExecutionId: null,
      taskRunId: null,
      companyId: 'c-1',
      occurredAt: '2026-10-07T10:00:00.000Z',
    });
    expect(evaluationRecordedEvent(evaluation).data.companyId).toBeNull();
  });

  it('the seed task fires on ACCEPTED or EDITED verdicts that validate a hypothesis', () => {
    const spec = desiredEmailDraftTask();
    const trigger = parseEventTrigger(spec.schedule)!;
    expect(trigger).toEqual({
      eventType: 'evaluation.recorded',
      filter: { feedback: { in: ['ACCEPTED', 'EDITED'] }, subjectType: 'hypothesis', toStatus: 'VALIDATED' },
    });
    const task = { id: randomUUID(), tenantId: 'publiexpe' };
    const fire = (data: Record<string, unknown>) => evaluateTrigger(task, trigger, envelope({ toStatus: 'VALIDATED', ...data }));
    expect(fire({ subjectId: 'h' })).toEqual({ fire: true, depth: 1 });
    expect(fire({ subjectId: 'h', feedback: 'EDITED' })).toEqual({ fire: true, depth: 1 });
    // An in-place edit while PROPOSED is EDITED too, but not a validation: no draft yet.
    expect(fire({ subjectId: 'h', feedback: 'EDITED', toStatus: 'PROPOSED' })).toMatchObject({ fire: false, reason: 'filter_mismatch' });
    expect(fire({ subjectId: 'h', feedback: 'DISCARDED', toStatus: 'REJECTED' })).toMatchObject({ fire: false, reason: 'filter_mismatch' });
    expect(fire({ subjectId: 'h', subjectType: 'research' })).toMatchObject({ fire: false, reason: 'filter_mismatch' });
    expect(evaluateTrigger(task, trigger, { ...envelope({ subjectId: 'h', toStatus: 'VALIDATED' }), type: 'task.completed' })).toMatchObject({ fire: false, reason: 'type_mismatch' });
  });

  it('an EDITED verdict drafts with the hypothesis as it is NOW in Twenty (the corrected data)', async () => {
    const { fake, company, hyp } = world();
    // The commercial corrected the proposal before validating it.
    Object.assign(hyp as Record<string, unknown>, {
      status: 'VALIDATED',
      need: 'Lanyards y acreditaciones corregidos por el comercial',
      whyNow: 'Feria adelantada al 10/11',
      recommendedProducts: ['Lanyards personalizados'],
    });
    const provider = new StubProvider({ responses: [JSON.stringify(ANSWER)] });
    const ev = envelope({ subjectId: hyp.id, companyId: company.id, feedback: 'EDITED', score: 0.5, toStatus: 'VALIDATED' });
    const { output } = await new EmailDrafterAgent().run(ctxFor(fake, eventTriggeredInput(ev), provider));
    expect(output).toMatchObject({ outcome: 'SUCCESS', note_created: true });
    const prompt = JSON.stringify(provider.requests[0]!.messages);
    expect(prompt).toContain('Lanyards y acreditaciones corregidos por el comercial');
    expect(prompt).toContain('Feria adelantada al 10/11');
    expect(prompt).toContain('Lanyards personalizados');
    expect(prompt).not.toContain('Material promocional');
    expect(prompt).not.toContain('Bolsas tote');
  });
});
