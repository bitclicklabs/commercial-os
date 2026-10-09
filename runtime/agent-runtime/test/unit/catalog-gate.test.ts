/**
 * Catalog health gate (degraded mode) without a database: never blocks, one ⚠️ note and one
 * `catalog.unavailable` event at most per tenant and Madrid day, nothing when disabled.
 */
import { describe, expect, it } from 'vitest';
import type { EventPublisher, PublishEventInput } from '../../src/events/event-bus.js';
import { CatalogError, CatalogService, Health, loadStubCatalogData, StubCatalogClient } from '../../src/integrations/catalog/index.js';
import { CatalogGate, catalogUnavailableNoteTitle, localDay } from '../../src/worker/catalog-gate.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

/** Publisher with the bus' idempotency-key semantics. */
function memoryPublisher(seen = new Set<string>()) {
  const published: PublishEventInput[] = [];
  const pub: EventPublisher = {
    async publish(input) {
      const created = !input.idempotencyKey || !seen.has(input.idempotencyKey);
      if (input.idempotencyKey) seen.add(input.idempotencyKey);
      if (created) published.push(input);
      return { created, dispatched: true, event: { id: '00000000-0000-4000-8000-000000000000', type: input.type, schemaVersion: `${input.type}.v1`, tenantId: input.tenantId, occurredAt: new Date().toISOString(), producer: 'agent-runtime', correlationId: input.correlationId, data: input.data } };
    },
    async emit(input) {
      return this.publish(input);
    },
  };
  return { pub, published, seen };
}

function setup(opts: { enabled?: boolean; now?: () => Date; seen?: Set<string>; fake?: FakeTwenty } = {}) {
  const api = new StubCatalogClient(loadStubCatalogData());
  let t = 0;
  const catalog = new CatalogService({ enabled: opts.enabled ?? true, api: opts.enabled === false ? null : api, now: () => t });
  const fake = opts.fake ?? new FakeTwenty();
  const events = memoryPublisher(opts.seen);
  const gate = new CatalogGate({ catalog, twenty: fake.client(), events: () => events.pub, ...(opts.now ? { now: opts.now } : {}) });
  return { api, catalog, fake, events, gate, advance: (ms: number) => (t += ms) };
}

const run = (gate: CatalogGate, tenantId = 'publiexpe', executionId = 'exec-1') => gate.beforeRun({ tenantId, executionId, requiresCatalog: true });
const notes = (fake: FakeTwenty) => fake.tables.notes as Array<{ title: string; bodyV2: { markdown: string } }>;

describe('catalog gate', () => {
  it('does nothing for a policy without catalog tools, or with the catalog disabled', async () => {
    const { gate, fake, events } = setup();
    expect(await gate.beforeRun({ tenantId: 'publiexpe', executionId: 'e', requiresCatalog: false })).toEqual({ checked: false, reason: 'not_required' });
    const off = setup({ enabled: false });
    expect(await run(off.gate)).toEqual({ checked: false, reason: 'disabled' });
    expect(notes(fake)).toHaveLength(0);
    expect(events.published).toHaveLength(0);
    expect(notes(off.fake)).toHaveLength(0);
  });

  it('healthy: available, no note; degraded counts as available (informative only)', async () => {
    const { gate, fake, api } = setup();
    expect(await run(gate)).toMatchObject({ checked: true, available: true });
    api.health = async () => Health.parse({ status: 'degraded', contractVersion: '1.1.0' });
    const g2 = setup();
    g2.api.health = api.health;
    expect(await run(g2.gate)).toMatchObject({ checked: true, available: true, availability: { degraded: true } });
    expect(notes(fake)).toHaveLength(0);
  });

  it('down: the run goes on; one ⚠️ note and one catalog.unavailable event per tenant and day; never an email', async () => {
    let now = new Date('2026-10-09T06:00:00Z'); // 08:00 Madrid
    const { gate, fake, events, api, advance } = setup({ now: () => now });
    api.failure = new CatalogError('CATALOG_UNAUTHENTICATED', 'UNAUTHENTICATED: token caducado', 401);
    const first = await run(gate);
    expect(first).toMatchObject({ checked: true, available: false, availability: { reason: 'unhealthy', code: 'CATALOG_UNAUTHENTICATED' }, notice: { day: '2026-10-09', eventPublished: true, noteCreated: true } });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({ type: 'catalog.unavailable', tenantId: 'publiexpe', idempotencyKey: 'evt:catalog.unavailable:publiexpe:2026-10-09', data: { code: 'CATALOG_UNAUTHENTICATED', provider: 'stub' } });
    expect(notes(fake)).toHaveLength(1);
    expect(notes(fake)[0]!.title).toBe(catalogUnavailableNoteTitle('2026-10-09', 'publiexpe'));
    expect(notes(fake)[0]!.title.startsWith('⚠️ Catálogo no disponible')).toBe(true);
    expect(notes(fake)[0]!.bodyV2.markdown).toContain('familias genéricas');
    expect(notes(fake)[0]!.bodyV2.markdown).toContain('No se envía ningún correo');

    // Same day, more runs (also after the 60 s health cache): nothing new.
    advance(61_000);
    expect(await run(gate, 'publiexpe', 'exec-2')).toMatchObject({ available: false, notice: { alreadyNotified: true } });
    expect(await run(gate, 'publiexpe', 'exec-3')).toMatchObject({ available: false });
    expect(events.published).toHaveLength(1);
    expect(notes(fake)).toHaveLength(1);

    // Another tenant the same day: its own notice.
    await run(gate, 'otro-tenant', 'exec-4');
    expect(events.published).toHaveLength(2);
    expect(notes(fake)).toHaveLength(2);

    // Next Madrid day (22:30 UTC = 00:30 Madrid): a new notice.
    now = new Date('2026-10-09T22:30:00Z');
    expect(localDay(now)).toBe('2026-10-10');
    await run(gate, 'publiexpe', 'exec-5');
    expect(events.published).toHaveLength(3);
    expect(notes(fake)).toHaveLength(3);
  });

  it('a second worker (shared event store) does not leave a second note; an existing note is reused', async () => {
    const now = () => new Date('2026-10-09T06:00:00Z');
    const seen = new Set<string>();
    const fake = new FakeTwenty();
    const a = setup({ now, seen, fake });
    const b = setup({ now, seen, fake });
    for (const s of [a, b]) s.api.failure = new CatalogError('CATALOG_UNAVAILABLE', 'UNAVAILABLE', 503, true);
    await run(a.gate);
    expect(await run(b.gate)).toMatchObject({ notice: { alreadyNotified: true, eventPublished: false, noteCreated: false } });
    expect(notes(fake)).toHaveLength(1);
    // A process without the event (restart with a NOOP bus) finds the note by its title.
    const c = setup({ now, fake });
    c.api.failure = new CatalogError('CATALOG_UNAVAILABLE', 'UNAVAILABLE', 503, true);
    expect(await run(c.gate)).toMatchObject({ notice: { noteCreated: false, noteId: expect.any(String) } });
    expect(notes(fake)).toHaveLength(1);
  });

  it('concurrent runs of one worker notify once; a failed note is retried by the next run', async () => {
    const now = () => new Date('2026-10-09T06:00:00Z');
    const { gate, fake, api } = setup({ now });
    api.failure = new CatalogError('CATALOG_TIMEOUT', 'timeout', null, true);
    await Promise.all([run(gate, 'publiexpe', 'a'), run(gate, 'publiexpe', 'b'), run(gate, 'publiexpe', 'c')]);
    expect(notes(fake)).toHaveLength(1);

    // Same gate, same event store: Twenty fails once, the next run of the day leaves the note.
    const broken = new FakeTwenty();
    const s = setup({ now, fake: broken });
    s.api.failure = new CatalogError('CATALOG_TIMEOUT', 'timeout', null, true);
    const client = broken.client();
    let down = true;
    const realList = client.list.bind(client);
    client.list = (async (...args: Parameters<typeof client.list>) => {
      if (down) throw new Error('twenty down');
      return realList(...args);
    }) as typeof client.list;
    const g = new CatalogGate({ catalog: s.catalog, twenty: client, events: () => s.events.pub, now });
    expect(await run(g)).toMatchObject({ available: false, notice: { eventPublished: true, noteError: 'twenty down' } });
    down = false;
    expect(await run(g, 'publiexpe', 'exec-retry')).toMatchObject({ notice: { eventPublished: false, noteCreated: true } });
    expect(notes(broken)).toHaveLength(1);
    expect(s.events.published).toHaveLength(1);
  });
});
