/**
 * Native Twenty Person / Opportunity / Task (tanda 19): name splitting, mailbox kinds, Person
 * dedupe by email without overwriting, Opportunity idempotency per open company opportunity and
 * the REAL first stage of the `stage` select, the reply task (due date, idempotency), the
 * ContactFinder's person selection and the manual promotion, against the FakeTwenty.
 */
import { describe, expect, it } from 'vitest';
import { contactPeople } from '../../src/contact-finder/people.js';
import type { ContactCandidate } from '../../src/contact-finder/finder.js';
import { fairOfHypothesis, isClosedStage, opportunityCreatedEvent, opportunityName, readOpportunityStages, stagesFromOpenApi, upsertOpenOpportunity } from '../../src/crm/opportunities.js';
import { cleanPersonName, personMailbox, splitPersonName, upsertPerson } from '../../src/crm/people.js';
import { PromotionError, promoteHypothesis } from '../../src/crm/promote.js';
import { addBusinessDays, replyTaskTitle, upsertReplyTask } from '../../src/crm/reply-task.js';
import { EventEnvelopeSchema, OPPORTUNITY_EVENT_TYPES } from '../../src/events/envelope.js';
import { parseEventTypePrefixes, RESERVED_EVENT_NAMESPACES } from '../../src/events/external.js';
import { TwentyClient } from '../../src/integrations/twenty/index.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

const signal = () => new AbortController().signal;

describe('person names', () => {
  it.each([
    ['María Gómez Ruiz', 'María', 'Gómez Ruiz'],
    ['María José López', 'María José', 'López'],
    ['María del Carmen Ruiz Pérez', 'María del Carmen', 'Ruiz Pérez'],
    ['José Luis', 'José Luis', ''],
    ['Carmen', 'Carmen', ''],
    ['López García, María', 'María', 'López García'],
    ['MARÍA DE LA FUENTE', 'María', 'de la Fuente'],
    ['mARÍA lópez', 'María', 'López'],
    ['Sr. Juan Pérez', 'Juan', 'Pérez'],
    ['"Ana Ruiz" ', 'Ana', 'Ruiz'],
    ['Ana Ruiz | Acme', 'Ana', 'Ruiz'],
    ['Ana Ruiz (Marketing)', 'Ana', 'Ruiz'],
    ["Siobhan O'Neill", 'Siobhan', "O'Neill"],
    ['Jean-Luc Picard', 'Jean-Luc', 'Picard'],
  ])('%s -> %s / %s', (raw, first, last) => {
    expect(splitPersonName(raw)).toEqual({ firstName: first, lastName: last });
  });

  it('is not a person name: departments, companies, digits, addresses only, too many words', () => {
    for (const raw of ['Departamento Comercial', 'Conservas Cantábrico SL', 'Ventas 2024', 'info@acme.es', '', '   ', 'Uno Dos Tres Cuatro Cinco Seis Siete', 'Equipo de Marketing', 'A, B, C']) {
      expect(splitPersonName(raw)).toBeNull();
    }
    expect(cleanPersonName('Carmen <carmen@cliente.example>')).toBe('Carmen');
  });

  it('mailbox kinds: only personal mailboxes are people', () => {
    expect(personMailbox('maria.lopez@acme.es')).toBe('person');
    expect(personMailbox('jgarcia@acme.es')).toBe('person');
    expect(personMailbox('info@acme.es')).toBe('generic');
    expect(personMailbox('contacto@acme.es')).toBe('generic');
    expect(personMailbox('comercial@acme.es')).toBe('function');
    expect(personMailbox('marketing@acme.es')).toBe('function');
    expect(personMailbox('rrhh@acme.es')).toBe('role');
    expect(personMailbox('noreply@acme.es')).toBe('never');
    expect(personMailbox('dpo@acme.es')).toBe('never');
    expect(personMailbox('newsletter@acme.es')).toBe('never');
    expect(personMailbox('no es un email')).toBe('invalid');
  });
});

describe('upsertPerson', () => {
  it('creates the person with split name, email, job title and company', async () => {
    const fake = new FakeTwenty();
    const r = await upsertPerson(fake.client(), { email: 'Maria.Gomez@Conservas.es', fullName: 'María Gómez Ruiz', jobTitle: 'Directora de Marketing', companyId: 'c1' }, signal());
    expect(r).toMatchObject({ outcome: 'created', person: { firstName: 'María', lastName: 'Gómez Ruiz', jobTitle: 'Directora de Marketing', email: 'maria.gomez@conservas.es', companyId: 'c1' } });
    expect(fake.tables.people[0]).toMatchObject({ name: { firstName: 'María', lastName: 'Gómez Ruiz' }, emails: { primaryEmail: 'maria.gomez@conservas.es', additionalEmails: [] } });
  });

  it('dedupes by email (case-insensitive) and only fills EMPTY fields: never overwrites', async () => {
    const fake = new FakeTwenty();
    const existing = fake.seed('people', { name: { firstName: 'Mari', lastName: '' }, emails: { primaryEmail: 'MARIA.GOMEZ@conservas.es', additionalEmails: [] }, jobTitle: '', companyId: null });
    const r = await upsertPerson(fake.client(), { email: 'maria.gomez@conservas.es', fullName: 'María Gómez Ruiz', jobTitle: 'Directora de Marketing', companyId: 'c1' }, signal());
    expect(r).toMatchObject({ outcome: 'updated', filled: ['jobTitle', 'companyId'], person: { id: existing.id, firstName: 'Mari' } });
    expect(fake.tables.people).toHaveLength(1);
    expect(existing).toMatchObject({ name: { firstName: 'Mari', lastName: '' }, jobTitle: 'Directora de Marketing', companyId: 'c1' });
    // Complete: nothing left to fill -> no PATCH.
    const patches = fake.count('PATCH', 'people');
    expect(await upsertPerson(fake.client(), { email: 'maria.gomez@conservas.es', fullName: 'Otra Persona', jobTitle: 'CEO', companyId: 'c2' }, signal())).toMatchObject({ outcome: 'unchanged' });
    expect(fake.count('PATCH', 'people')).toBe(patches);
    expect(existing).toMatchObject({ jobTitle: 'Directora de Marketing', companyId: 'c1' });
  });

  it('an empty name is filled; `_` in the address is not a wildcard', async () => {
    const fake = new FakeTwenty();
    fake.seed('people', { name: { firstName: '', lastName: '' }, emails: { primaryEmail: 'anaxruiz@acme.es' } });
    const blank = fake.seed('people', { name: { firstName: '', lastName: '' }, emails: { primaryEmail: 'ana_ruiz@acme.es' } });
    expect(await upsertPerson(fake.client(), { email: 'ana_ruiz@acme.es', fullName: 'Ana Ruiz' }, signal())).toMatchObject({ outcome: 'updated', filled: ['name'], person: { id: blank.id } });
  });

  it('generic / function / role mailboxes create nothing and make no request', async () => {
    const fake = new FakeTwenty();
    for (const email of ['info@acme.es', 'comercial@acme.es', 'rrhh@acme.es', 'noreply@acme.es']) {
      expect(await upsertPerson(fake.client(), { email, fullName: 'Ana Ruiz' }, signal())).toMatchObject({ outcome: 'skipped', person: null });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('a concurrent create (unique primary email) adopts the winner', async () => {
    const fake = new FakeTwenty();
    let hide = true;
    const racing = new TwentyClient({
      baseUrl: 'http://twenty.test',
      apiKey: 'k',
      sleep: async () => {},
      fetch: async (input, init) => {
        // The first lookup misses the person another process is creating right now.
        if (hide && String(input).includes('/rest/people?')) {
          hide = false;
          fake.seed('people', { name: { firstName: 'Ana', lastName: '' }, emails: { primaryEmail: 'ana@acme.es' }, jobTitle: '' });
          return new Response(JSON.stringify({ data: { people: [] }, totalCount: 0, pageInfo: {} }), { status: 200 });
        }
        return fake.fetch(input, init);
      },
    });
    const r = await upsertPerson(racing, { email: 'ana@acme.es', fullName: 'Ana Ruiz', jobTitle: 'Gerente' }, signal());
    expect(r).toMatchObject({ outcome: 'updated', filled: ['jobTitle'] });
    expect(fake.tables.people).toHaveLength(1);
  });
});

describe('opportunities', () => {
  it('reads the stage options of the workspace from the OpenAPI document, in order', async () => {
    const fake = new FakeTwenty();
    fake.opportunityStages = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'];
    expect(await readOpportunityStages(fake.client())).toEqual({ stages: ['LEAD', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'], source: 'twenty' });
    expect(stagesFromOpenApi({ components: { schemas: { Opportunity: { properties: { stage: { enum: ['NEW', 'SCREENING'] } } } } } })).toEqual(['NEW', 'SCREENING']);
    expect(stagesFromOpenApi({})).toBeNull();
    // Unreadable document: the default Twenty order, flagged as such.
    const broken = new TwentyClient({ baseUrl: 'http://twenty.test', apiKey: 'k', maxRetries: 0, fetch: async () => new Response('{"messages":["forbidden"]}', { status: 403 }) });
    expect(await readOpportunityStages(broken)).toEqual({ stages: ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER'], source: 'default' });
  });

  it('creates at the FIRST real stage, without amount, and never duplicates an open one per company', async () => {
    const fake = new FakeTwenty();
    fake.opportunityStages = ['LEAD', 'QUALIFIED', 'WON'];
    const client = fake.client();
    const first = await upsertOpenOpportunity(client, { companyId: 'c1', name: 'Acme — Fruit Attraction 2026' }, signal());
    expect(first).toMatchObject({ created: true, stageSource: 'twenty', opportunity: { stage: 'LEAD', companyId: 'c1', pointOfContactId: null, name: 'Acme — Fruit Attraction 2026' } });
    expect(fake.requests.find((r) => r.method === 'POST' && r.path === '/rest/opportunities')!.body).toEqual({ name: 'Acme — Fruit Attraction 2026', stage: 'LEAD', companyId: 'c1' });
    expect(fake.tables.opportunities[0]).toMatchObject({ amount: { amountMicros: null, currencyCode: null } });
    // Second promotion of the same company: reused; an empty point of contact is filled.
    const again = await upsertOpenOpportunity(client, { companyId: 'c1', name: 'otro nombre', pointOfContactId: 'p1' }, signal());
    expect(again).toMatchObject({ created: false, stageSource: 'existing', filled: ['pointOfContactId'], opportunity: { id: first.opportunity.id, pointOfContactId: 'p1' } });
    // ...but an existing point of contact is never replaced.
    expect(await upsertOpenOpportunity(client, { companyId: 'c1', name: 'x', pointOfContactId: 'p2' }, signal())).toMatchObject({ created: false, filled: [], opportunity: { pointOfContactId: 'p1' } });
    expect(fake.tables.opportunities).toHaveLength(1);
    // A closed one (won) does not count as open: a new one is created.
    fake.tables.opportunities[0]!.stage = 'WON';
    expect(await upsertOpenOpportunity(client, { companyId: 'c1', name: 'Acme' }, signal())).toMatchObject({ created: true });
    expect(fake.tables.opportunities).toHaveLength(2);
  });

  it('names, closing stages, fair of a hypothesis, and the opportunity.created event', () => {
    expect(opportunityName('Acme', 'Fruit Attraction 2026')).toBe('Acme — Fruit Attraction 2026');
    expect(opportunityName('Acme', null)).toBe('Acme');
    expect(opportunityName('Acme "SA"', 'Acme "SA"')).toBe('Acme SA');
    expect(['CUSTOMER', 'WON', 'CLOSED_LOST', 'PERDIDA'].every(isClosedStage)).toBe(true);
    expect(['NEW', 'SCREENING', 'MEETING', 'PROPOSAL'].some(isClosedStage)).toBe(false);
    expect(fairOfHypothesis({ name: 'Acme — Fruit Attraction 2026', signalName: null })).toBe('Fruit Attraction 2026');
    expect(fairOfHypothesis({ name: 'x', signalName: 'Alimentaria 2026 — Acme' })).toBe('Alimentaria 2026');
    expect(fairOfHypothesis({ name: 'Acme', signalName: null })).toBeNull();
    const ev = opportunityCreatedEvent({ tenantId: 't1', opportunity: { id: 'o1', name: 'Acme', stage: 'NEW', companyId: 'c1', pointOfContactId: null }, origin: 'manual', hypothesisId: 'h1', personId: null });
    expect(ev).toMatchObject({ type: 'opportunity.created', idempotencyKey: 'evt:opportunity.created:o1', data: { opportunityId: 'o1', origin: 'manual', companyId: 'c1', hypothesisId: 'h1' } });
    expect(EventEnvelopeSchema.shape.type.safeParse(ev.type).success).toBe(true);
    expect(OPPORTUNITY_EVENT_TYPES).toContain('opportunity.created');
    // External senders can never forge it.
    expect(RESERVED_EVENT_NAMESPACES).toContain('opportunity.');
    expect(() => parseEventTypePrefixes('opportunity.')).toThrow(/overlaps/);
  });
});

describe('reply task', () => {
  it('is due in 2 working days at 09:00 local (weekends skipped, DST-safe)', () => {
    // Thursday 10:30 Madrid -> Monday 09:00 (CEST, +02:00).
    expect(addBusinessDays(new Date('2026-10-08T08:30:00Z'), 2, 'Europe/Madrid').toISOString()).toBe('2026-10-12T07:00:00.000Z');
    // Friday -> Tuesday.
    expect(addBusinessDays(new Date('2026-10-09T15:00:00Z'), 2, 'Europe/Madrid').toISOString()).toBe('2026-10-13T07:00:00.000Z');
    // Saturday -> Tuesday.
    expect(addBusinessDays(new Date('2026-10-10T10:00:00Z'), 2, 'Europe/Madrid').toISOString()).toBe('2026-10-13T07:00:00.000Z');
    // Across the end of summer time (25 Oct 2026): Friday 23 -> Tuesday 27, 09:00 CET (+01:00).
    expect(addBusinessDays(new Date('2026-10-23T09:00:00Z'), 2, 'Europe/Madrid').toISOString()).toBe('2026-10-27T08:00:00.000Z');
  });

  it('creates TODO with targets once; a retry reuses it; a DONE one does not block a new one', async () => {
    const fake = new FakeTwenty();
    const client = fake.client();
    const input = { title: replyTaskTitle('Carmen Ruiz'), bodyMarkdown: 'Responder', dueAt: '2026-10-12T07:00:00.000Z', companyId: 'c1', opportunityId: 'o1', personId: 'p1' };
    const a = await upsertReplyTask(client, input, signal());
    expect(a).toMatchObject({ created: true, task: { title: '📬 Responder a Carmen Ruiz', status: 'TODO', dueAt: '2026-10-12T07:00:00.000Z' } });
    expect(fake.tables.taskTargets.map((t) => [t.targetOpportunityId, t.targetCompanyId, t.targetPersonId])).toEqual([
      ['o1', null, null],
      [null, 'c1', null],
      [null, null, 'p1'],
    ]);
    expect(await upsertReplyTask(client, input, signal())).toMatchObject({ created: false, task: { id: a.task.id } });
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.taskTargets).toHaveLength(3);
    fake.tables.tasks[0]!.status = 'DONE';
    expect(await upsertReplyTask(client, input, signal())).toMatchObject({ created: true });
    // An orphan (died between the POSTs) is adopted, not duplicated.
    const orphan = fake.seed('tasks', { title: replyTaskTitle('Otra'), status: 'TODO', bodyV2: null, dueAt: null });
    expect(await upsertReplyTask(client, { ...input, title: replyTaskTitle('Otra') }, signal())).toMatchObject({ created: false, task: { id: orphan.id } });
    expect(replyTaskTitle('Ana "la" \\ Ruiz')).toBe('📬 Responder a Ana la Ruiz');
  });

  it('create_reply_task tool: links the note and the opportunity in the body', async () => {
    const fake = new FakeTwenty();
    const registry = createDefaultToolRegistry({ twenty: fake.client() });
    const tools = new ToolExecutor(registry, parseToolPolicy({ tool_policy: { allow: ['create_reply_task'], max_risk_level: 'LOW_WRITE' } }), { tenantId: 't1', executionId: 'e', agentId: 'a', stage: null }, signal());
    const noteId = '11111111-1111-4111-8111-111111111111';
    const oppId = '22222222-2222-4222-8222-222222222222';
    const r = await tools.call('create_reply_task', { who: 'Cliente SA', bodyMarkdown: 'Hazlo', dueAt: '2026-10-12T07:00:00.000Z', opportunityId: oppId, noteId });
    expect(r.result.status).toBe('ok');
    const md = (fake.tables.tasks[0]!.bodyV2 as { markdown: string }).markdown;
    expect(md).toContain(`Nota con el extracto: http://twenty.test/object/note/${noteId}`);
    expect(md).toContain(`Oportunidad: http://twenty.test/object/opportunity/${oppId}`);
    const none = await tools.call('create_reply_task', { who: 'X', bodyMarkdown: 'y', dueAt: '2026-10-12T07:00:00.000Z' });
    expect(none.result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
  });
});

describe('ContactFinder: which candidates become Persons', () => {
  const cand = (over: Partial<ContactCandidate>): ContactCandidate => ({
    email: 'x@acme.es',
    name: null,
    jobTitle: null,
    tier: 4,
    subrank: 0,
    label: '',
    roleKind: null,
    onDomain: true,
    mx: 'ok',
    origin: 'web',
    confidence: null,
    sources: [{ url: 'https://acme.es/', via: 'text' }],
    context: null,
    order: 0,
    ...over,
  });

  it('chosen with a name + priority-1 people; never generic/function mailboxes, unusable or unnamed ones', () => {
    const candidates = [
      cand({ email: 'ana.ruiz@acme.es', name: 'Ana Ruiz', jobTitle: 'Gerente', tier: 1 }),
      cand({ email: 'comercial@acme.es', name: 'Luis Martín', tier: 2 }),
      cand({ email: 'info@acme.es', name: 'Pepa Gil', tier: 3 }),
      cand({ email: 'jperez@acme.es', name: 'Javier Pérez', jobTitle: 'Calidad', tier: 4 }),
      cand({ email: 'marta@acme.es', name: 'Marta Sanz', jobTitle: 'Directora comercial', tier: 1 }),
      cand({ email: 'sin.nombre@acme.es', name: null, tier: 1, jobTitle: 'Compras' }),
      cand({ email: 'sinmx@acme.es', name: 'Eva Mora', tier: 1, mx: 'none' }),
      cand({ email: 'hunter@acme.es', name: 'Rosa Vidal', jobTitle: 'Marketing', tier: 1, origin: 'hunter', confidence: 0.6 }),
      cand({ email: 'hunter2@acme.es', name: 'Rosa Vidal', jobTitle: 'Marketing', tier: 1, origin: 'hunter', confidence: 0.92 }),
      cand({ email: 'hunter3@acme.es', name: 'Rosa Vidal', jobTitle: null, tier: 1, origin: 'hunter', confidence: 0.92 }),
    ];
    const chosen = { email: 'marta@acme.es', reason: '', origin: 'web', sourceUrl: null };
    expect(contactPeople({ candidates, chosen, suppressionChecked: true })).toEqual([
      { email: 'marta@acme.es', name: 'Marta Sanz', jobTitle: 'Directora comercial', chosen: true },
      { email: 'ana.ruiz@acme.es', name: 'Ana Ruiz', jobTitle: 'Gerente', chosen: false },
      { email: 'hunter2@acme.es', name: 'Rosa Vidal', jobTitle: 'Marketing', chosen: false },
    ]);
    // Chosen generic mailbox: no Person for it.
    expect(contactPeople({ candidates: [candidates[2]!], chosen: { ...chosen, email: 'info@acme.es' }, suppressionChecked: true })).toEqual([]);
    // Suppression list unreadable: fail closed, nobody.
    expect(contactPeople({ candidates, chosen, suppressionChecked: false })).toEqual([]);
  });
});

describe('manual promotion', () => {
  function world() {
    const fake = new FakeTwenty();
    const company = fake.seed('companies', { name: 'Acme SL', domainName: { primaryLinkUrl: 'acme.es', primaryLinkLabel: '', secondaryLinks: [] } });
    const signalRec = fake.seed('commercialSignals', { name: 'Fruit Attraction 2026 — Acme SL', signalType: 'FAIR', status: 'QUALIFIED', tenantId: 'publiexpe', companyId: company.id });
    const hyp = fake.seed('commercialHypotheses', { name: 'Acme SL — Fruit Attraction 2026', status: 'VALIDATED', tenantId: 'publiexpe', companyId: company.id, commercialSignalId: signalRec.id, decisionMakerId: null, emailTo: 'ana.ruiz@acme.es' });
    return { fake, company, hyp };
  }

  it('company + Person of a personal emailTo, first stage, idempotent per company', async () => {
    const { fake, company, hyp } = world();
    const r = await promoteHypothesis(fake.client(), { tenantId: 'publiexpe', hypothesisId: hyp.id as string });
    expect(r).toMatchObject({ created: true, contactFrom: 'email_to', fair: 'Fruit Attraction 2026', opportunity: { name: 'Acme SL — Fruit Attraction 2026', stage: 'NEW', companyId: company.id } });
    expect(fake.tables.people).toEqual([expect.objectContaining({ emails: { primaryEmail: 'ana.ruiz@acme.es', additionalEmails: [] }, companyId: company.id })]);
    expect(r.opportunity.pointOfContactId).toBe(fake.tables.people[0]!.id);
    const again = await promoteHypothesis(fake.client(), { tenantId: 'publiexpe', hypothesisId: hyp.id as string });
    expect(again).toMatchObject({ created: false, opportunity: { id: r.opportunity.id } });
    expect(fake.tables.opportunities).toHaveLength(1);
    expect(fake.tables.people).toHaveLength(1);
  });

  it('generic emailTo: opportunity without point of contact; decision maker wins; REJECTED / other tenant refused', async () => {
    const { fake, hyp } = world();
    hyp.emailTo = 'info@acme.es';
    const r = await promoteHypothesis(fake.client(), { tenantId: 'publiexpe', hypothesisId: hyp.id as string });
    expect(r).toMatchObject({ created: true, contactFrom: null, pointOfContactId: null, opportunity: { pointOfContactId: null } });
    expect(fake.tables.people).toHaveLength(0);
    const dm = fake.seed('people', { name: { firstName: 'Ana', lastName: 'Ruiz' }, emails: { primaryEmail: 'ana@acme.es' } });
    hyp.decisionMakerId = dm.id;
    expect(await promoteHypothesis(fake.client(), { tenantId: 'publiexpe', hypothesisId: hyp.id as string })).toMatchObject({ created: false, contactFrom: 'decision_maker', filled: ['pointOfContactId'] });
    hyp.status = 'REJECTED';
    await expect(promoteHypothesis(fake.client(), { tenantId: 'publiexpe', hypothesisId: hyp.id as string })).rejects.toBeInstanceOf(PromotionError);
    await expect(promoteHypothesis(fake.client(), { tenantId: 'otro', hypothesisId: hyp.id as string })).rejects.toMatchObject({ code: 'TWENTY_TENANT_MISMATCH' });
    await expect(promoteHypothesis(fake.client(), { tenantId: 'publiexpe', hypothesisId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ code: 'HYPOTHESIS_NOT_FOUND' });
  });
});
