/**
 * commercialSignal -> QUALIFIED -> `signal.qualified` -> `prospect-on-qualified` (tanda 15),
 * without database: webhook shape, transition rules, fair-level filter, 24 h window, run options
 * of EVENT tasks and the mapping to the Prospector's targeted scout input.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isScoutInput, ScoutInput } from '../../src/agents/event-scout.js';
import type { ApiContext } from '../../src/api/context.js';
import { ScheduleSchema } from '../../src/api/schemas.js';
import { buildServer } from '../../src/api/server.js';
import type { EventEnvelope } from '../../src/events/envelope.js';
import { SIGNAL_EVENT_TYPES } from '../../src/events/envelope.js';
import { RESERVED_EVENT_NAMESPACES, parseEventTypePrefixes } from '../../src/events/external.js';
import {
  EventTriggerValidationError,
  eventTriggeredInput,
  mappedEventInput,
  parseEventRunOptions,
  parseEventTrigger,
} from '../../src/events/triggers.js';
import type { TwentyWebhookPayload } from '../../src/evaluations/human-feedback.js';
import { signTwentyPayload } from '../../src/evaluations/twenty-webhook.js';
import { DEFAULT_OPERATIONS } from '../../src/integrations/twenty/register-webhook.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { parseSchedule } from '../../src/scheduler/schedule.js';
import { desiredProspectOnQualifiedTask, PROSPECT_ON_QUALIFIED_AUDIT_ACTION } from '../../src/seed/prospect-on-qualified-seed.js';
import {
  classifySignalQualification,
  eventDateOf,
  eventNameOf,
  eventUrlOf,
  SIGNAL_REFIRE_WINDOW_MS,
  signalQualifiedIdempotencyKey,
  withinRefireWindow,
} from '../../src/signals/qualified.js';

const SIGNAL_ID = '5f0c3a5e-1111-4a2b-9c3d-000000000001';

/** Shape of a Twenty 2.45 `commercialSignal.updated` delivery (same envelope as the captured hypothesis one). */
function signalPayload(record: Record<string, unknown> = {}, updatedFields: string[] | null = ['status'], eventName = 'commercialSignal.updated'): TwentyWebhookPayload {
  return {
    eventName,
    objectMetadata: { id: 'meta-signal', nameSingular: 'commercialSignal' },
    workspaceId: 'ws-1',
    webhookId: 'wh-1',
    eventDate: '2026-10-09T10:00:00.000Z',
    record: {
      id: SIGNAL_ID,
      name: 'Expo Foods Madrid 2026 (feria)',
      description: 'Feria detectada por el Prospector (modo scout).',
      signalType: 'FAIR',
      status: 'QUALIFIED',
      sourceUrl: { primaryLinkUrl: 'https://expofoods.example/expositores', primaryLinkLabel: '', secondaryLinks: [] },
      sourceDomain: 'expofoods.example',
      eventDate: '2026-11-24',
      confidence: 0.5,
      tenantId: 'publiexpe',
      companyId: null,
      deletedAt: null,
      updatedAt: '2026-10-09T09:59:59.000Z',
      ...record,
    },
    ...(updatedFields ? { updatedFields } : {}),
  };
}

describe('classifySignalQualification', () => {
  it('a fair signal moved to QUALIFIED emits signal.qualified with the scout data', () => {
    expect(classifySignalQualification(signalPayload())).toEqual({
      action: 'emit',
      data: {
        signal_id: SIGNAL_ID,
        name: 'Expo Foods Madrid 2026',
        event_url: 'https://expofoods.example/expositores',
        event_date: '2026-11-24',
        signal_type: 'FAIR',
        transition: 'updated_fields',
      },
    });
  });

  it('without updatedFields the status alone is accepted (the 24 h window guards it)', () => {
    const d = classifySignalQualification(signalPayload({}, null));
    expect(d).toMatchObject({ action: 'emit', data: { transition: 'status_only' } });
    expect(classifySignalQualification(signalPayload({}, []))).toMatchObject({ action: 'emit', data: { transition: 'status_only' } });
  });

  it('a signal created already QUALIFIED (commercialSignal.created) is a qualification too', () => {
    expect(classifySignalQualification(signalPayload({}, null, 'commercialSignal.created'))).toMatchObject({ action: 'emit', data: { signal_id: SIGNAL_ID } });
  });

  it('ignores other statuses, edits of an already QUALIFIED signal and deleted signals', () => {
    expect(classifySignalQualification(signalPayload({ status: 'REVIEWING' }))).toEqual({ action: 'ignore', reason: 'status REVIEWING is not QUALIFIED' });
    expect(classifySignalQualification(signalPayload({ status: 'DISCARDED' }))).toMatchObject({ action: 'ignore' });
    expect(classifySignalQualification(signalPayload({}, ['description']))).toEqual({ action: 'ignore', reason: 'status not among updatedFields (signal already QUALIFIED)' });
    expect(classifySignalQualification(signalPayload({ deletedAt: '2026-10-09T10:00:00.000Z' }))).toEqual({ action: 'ignore', reason: 'signal is deleted' });
    expect(classifySignalQualification(signalPayload({}, ['status'], 'commercialSignal.deleted'))).toMatchObject({ action: 'ignore' });
  });

  it('ignores per-exhibitor signals (with company), non-event types and signals without URL', () => {
    expect(classifySignalQualification(signalPayload({ companyId: 'c-1', name: 'Expo Foods — Acme' }))).toEqual({ action: 'ignore', reason: 'per-exhibitor signal (has companyId)' });
    expect(classifySignalQualification(signalPayload({ signalType: 'HIRING' }))).toMatchObject({ action: 'ignore', reason: expect.stringContaining('not fair-level') });
    expect(classifySignalQualification(signalPayload({ sourceUrl: null }))).toEqual({ action: 'ignore', reason: 'fair signal without an http(s) sourceUrl' });
    expect(classifySignalQualification(signalPayload({ sourceUrl: { primaryLinkUrl: '', primaryLinkLabel: '' } }))).toMatchObject({ action: 'ignore' });
    expect(classifySignalQualification(signalPayload({ sourceUrl: { primaryLinkUrl: 'ftp://expofoods.example' } }))).toMatchObject({ action: 'ignore' });
  });

  it('accepts CONGRESS and EVENT signals and ignores other objects', () => {
    expect(classifySignalQualification(signalPayload({ signalType: 'CONGRESS' }))).toMatchObject({ action: 'emit' });
    expect(classifySignalQualification(signalPayload({ signalType: 'EVENT' }))).toMatchObject({ action: 'emit' });
    const hyp = { ...signalPayload(), eventName: 'commercialHypothesis.updated', objectMetadata: { nameSingular: 'commercialHypothesis' } };
    expect(classifySignalQualification(hyp)).toEqual({ action: 'ignore', reason: 'object commercialHypothesis not handled' });
  });
});

describe('signal helpers', () => {
  it('eventUrlOf reads Twenty LINKS, adds https to bare domains and refuses other schemes', () => {
    expect(eventUrlOf({ primaryLinkUrl: 'https://a.example/x' })).toBe('https://a.example/x');
    expect(eventUrlOf({ primaryLinkUrl: 'expofoods.example' })).toBe('https://expofoods.example/');
    expect(eventUrlOf('http://b.example')).toBe('http://b.example/');
    expect(eventUrlOf('javascript:alert(1)')).toBeNull();
    expect(eventUrlOf('not a url')).toBeNull();
    expect(eventUrlOf(null)).toBeNull();
  });

  it('eventNameOf drops the " (feria)" / " (congreso)" / " (evento)" suffix', () => {
    expect(eventNameOf('Alimentaria 2026 (feria)')).toBe('Alimentaria 2026');
    expect(eventNameOf('Congreso Retail (congreso)')).toBe('Congreso Retail');
    expect(eventNameOf('Gala (Evento)')).toBe('Gala');
    expect(eventNameOf('Congreso X')).toBe('Congreso X');
    expect(eventNameOf('  ')).toBeNull();
  });

  it('eventDateOf keeps only a valid YYYY-MM-DD (DATE or DATE_TIME values)', () => {
    expect(eventDateOf('2026-11-24')).toBe('2026-11-24');
    expect(eventDateOf('2026-11-24T00:00:00.000Z')).toBe('2026-11-24');
    expect(eventDateOf('2026-02-30')).toBeNull();
    expect(eventDateOf('24/11/2026')).toBeNull();
    expect(eventDateOf(null)).toBeNull();
  });

  it('24 h window per signal and chained idempotency key', () => {
    const now = new Date('2026-10-10T10:00:00Z');
    expect(SIGNAL_REFIRE_WINDOW_MS).toBe(86_400_000);
    expect(withinRefireWindow(null, now)).toBe(false);
    expect(withinRefireWindow(new Date(now.getTime() - 3600_000), now)).toBe(true);
    expect(withinRefireWindow(new Date(now.getTime() - SIGNAL_REFIRE_WINDOW_MS + 1), now)).toBe(true);
    expect(withinRefireWindow(new Date(now.getTime() - SIGNAL_REFIRE_WINDOW_MS), now)).toBe(false);
    expect(signalQualifiedIdempotencyKey('s1', null)).toBe('evt:signal.qualified:s1:first');
    expect(signalQualifiedIdempotencyKey('s1', 'e9')).toBe('evt:signal.qualified:s1:e9');
  });

  it('signal.* is reserved: external senders cannot forge signal.qualified', () => {
    expect(SIGNAL_EVENT_TYPES).toContain('signal.qualified');
    expect(RESERVED_EVENT_NAMESPACES).toContain('signal.');
    expect(() => parseEventTypePrefixes('signal.')).toThrow();
  });

  it('register:webhook subscribes commercialSignal updated and created by default', () => {
    expect(DEFAULT_OPERATIONS).toEqual(['commercialHypothesis.updated', 'commercialSignal.updated', 'commercialSignal.created']);
  });
});

describe('EVENT run options (input_from_event, audit)', () => {
  it('parses and validates them with the trigger', () => {
    expect(parseEventRunOptions({})).toEqual({ inputFromEvent: {}, audit: null });
    expect(parseEventRunOptions({ input_from_event: { url: 'a.b' }, audit: { action: 'x.y', subject_type: 'thing', subject_path: 'id' } })).toEqual({
      inputFromEvent: { url: 'a.b' },
      audit: { action: 'x.y', subjectType: 'thing', subjectPath: 'id' },
    });
    const bad = [
      { input_from_event: { event: 'x' } },
      { input_from_event: { 'bad key': 'x' } },
      { input_from_event: { ok: '' } },
      { input_from_event: ['x'] },
      { audit: { action: 'noDot', subject_type: 'x' } },
      { audit: { action: 'a.b', subject_type: 'Bad-Type' } },
      { audit: { action: 'a.b', subject_type: 'x', subject_path: '' } },
    ];
    for (const b of bad) {
      expect(() => parseEventTrigger({ type: 'EVENT', event_type: 'signal.qualified', ...(b as object) })).toThrow(EventTriggerValidationError);
    }
    expect(() => parseSchedule({ type: 'EVENT', event_type: 'signal.qualified', input_from_event: { event: 'x' } })).toThrow();
  });

  it('the API schedule schema keeps the options (not stripped)', () => {
    const spec = desiredProspectOnQualifiedTask().schedule;
    expect(ScheduleSchema.parse(spec)).toEqual(spec);
  });

  it('mappedEventInput copies present values only', () => {
    expect(mappedEventInput({ data: { a: { b: 1 }, c: null } }, { x: 'a.b', y: 'c', z: 'missing' })).toEqual({ x: 1 });
  });
});

describe('prospect-on-qualified: mapping to the targeted scout input', () => {
  const task = desiredProspectOnQualifiedTask();
  const envelope: EventEnvelope = {
    id: '7d3e1a52-2222-4b3c-8d4e-000000000002',
    type: 'signal.qualified',
    schemaVersion: 'signal.qualified.v1',
    tenantId: 'publiexpe',
    occurredAt: '2026-10-09T10:00:00.000Z',
    producer: 'agent-runtime',
    correlationId: `signal:${SIGNAL_ID}`,
    data: { ...(classifySignalQualification(signalPayload()) as unknown as { data: Record<string, unknown> }).data, chainDepth: 0 },
  };

  it('is an EVENT task on signal.qualified with audit prospect.on_qualified', () => {
    expect(parseEventTrigger(task.schedule)).toEqual({ eventType: 'signal.qualified', filter: {} });
    expect(parseEventRunOptions(task.schedule).audit).toEqual({ action: PROSPECT_ON_QUALIFIED_AUDIT_ACTION, subjectType: 'commercial_signal', subjectPath: 'signal_id' });
    expect(task.maxConcurrency).toBe(1);
  });

  it('a signal without date leaves event_date out of the input', () => {
    const data = (classifySignalQualification(signalPayload({ eventDate: null })) as unknown as { data: Record<string, unknown> }).data;
    expect(data.event_date).toBeNull();
    expect(mappedEventInput({ data }, parseEventRunOptions(task.schedule).inputFromEvent)).not.toHaveProperty('event_date');
  });

  it('builds {event_url, event_name, event_date, max_events: 1, signal_id} and the Prospector takes the scout path', () => {
    // As requestTaskRun builds it: default input, then the trigger input (envelope + mapped keys).
    const input = { ...task.defaultInput, ...eventTriggeredInput(envelope), ...mappedEventInput(envelope, parseEventRunOptions(task.schedule).inputFromEvent) };
    expect(input).toMatchObject({
      mode: 'scout',
      max_events: 1,
      event_url: 'https://expofoods.example/expositores',
      event_name: 'Expo Foods Madrid 2026',
      event_date: '2026-11-24',
      signal_id: SIGNAL_ID,
      event: { id: envelope.id },
    });
    expect(isScoutInput(input)).toBe(true);
    const parsed = ScoutInput.parse(input);
    expect(parsed).toMatchObject({ event_url: 'https://expofoods.example/expositores', event_name: 'Expo Foods Madrid 2026', max_events: 1 });
    // Extra keys are harmless: the scout schema drops them.
    expect(parsed).not.toHaveProperty('signal_id');
    expect(parsed).not.toHaveProperty('event');
  });
});

describe('POST /webhooks/twenty with commercialSignal (no database needed when ignored)', () => {
  const SECRET = 'test-secret-0123456789abcdef';
  let app: FastifyInstance;
  beforeAll(async () => {
    const ctx: ApiContext = {
      db: {} as ApiContext['db'],
      queue: new MemoryRunQueue(),
      config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub', twentyWebhookSecret: SECRET },
    };
    app = await buildServer(ctx);
  });
  afterAll(async () => {
    await app.close();
  });

  it('routes by object: a per-exhibitor signal is ignored with its reason (200)', async () => {
    const raw = JSON.stringify(signalPayload({ companyId: 'c-1' }));
    const ts = String(Date.now());
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twenty',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': signTwentyPayload(SECRET, ts, raw) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ignored',
      reason: 'object commercialSignal not handled',
      signal: { status: 'ignored', reason: 'per-exhibitor signal (has companyId)', signal_id: SIGNAL_ID },
    });
  });
});
