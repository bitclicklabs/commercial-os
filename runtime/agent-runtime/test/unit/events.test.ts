import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema, schemaVersionFor, sourceOfProducer, type EventEnvelope } from '../../src/events/envelope.js';
import { NOOP_EVENT_PUBLISHER } from '../../src/events/event-bus.js';
import {
  executionFinishedEvent,
  executionStartedEvent,
  taskFinishedEvent,
  taskScheduledEvent,
  taskStartedEvent,
} from '../../src/events/runtime-events.js';
import {
  chainDepthOfRunInput,
  DEFAULT_MAX_CHAIN_DEPTH,
  desiredEventTrigger,
  evaluateTrigger,
  eventTaskRunIdempotencyKey,
  eventTriggeredInput,
  getPath,
  matchesFilter,
  MAX_IN_VALUES,
  parseEventTrigger,
} from '../../src/events/triggers.js';
import { parseSchedule, ScheduleValidationError } from '../../src/scheduler/schedule.js';

const TENANT = 'publiexpe';
const TASK = { id: '11111111-1111-4111-8111-111111111111', tenantId: TENANT };

function envelope(type: string, data: Record<string, unknown>, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return EventEnvelopeSchema.parse({
    id: randomUUID(),
    type,
    schemaVersion: schemaVersionFor(type),
    tenantId: TENANT,
    occurredAt: new Date().toISOString(),
    producer: 'agent-runtime',
    correlationId: randomUUID(),
    data,
    ...over,
  });
}

describe('event.envelope.v1', () => {
  it('accepts a catalogue event and rejects extra fields or bad types', () => {
    const ev = envelope('agent.execution.completed', { executionId: 'x' });
    expect(ev.schemaVersion).toBe('agent.execution.completed.v1');
    expect(() => EventEnvelopeSchema.parse({ ...ev, extra: 1 })).toThrow();
    expect(() => EventEnvelopeSchema.parse({ ...ev, type: 'Task.Completed' })).toThrow();
    expect(() => EventEnvelopeSchema.parse({ ...ev, type: 'task' })).toThrow();
    expect(() => EventEnvelopeSchema.parse({ ...ev, producer: 'someone' })).toThrow();
  });

  it('maps producers to the events.source column', () => {
    expect(sourceOfProducer('agent-runtime')).toBe('runtime');
    expect(sourceOfProducer('scheduler')).toBe('runtime');
    expect(sourceOfProducer('twenty-app')).toBe('twenty');
    expect(sourceOfProducer('n8n')).toBe('n8n');
  });

  it('the no-op publisher never throws on emit', async () => {
    await expect(NOOP_EVENT_PUBLISHER.emit({ tenantId: TENANT, type: 'task.started', data: {}, correlationId: 'x' })).resolves.toBeNull();
  });
});

describe('EVENT schedule parsing', () => {
  it('normalises event_type (alias event) and the filter', () => {
    expect(parseEventTrigger({ type: 'EVENT', event_type: 'task.completed' })).toEqual({ eventType: 'task.completed', filter: {} });
    expect(parseEventTrigger({ type: 'EVENT', event: 'signal.detected', filter: { type: 'FAIR' } })).toEqual({
      eventType: 'signal.detected',
      filter: { type: 'FAIR' },
    });
    expect(parseEventTrigger({ type: 'CRON', expression: '* * * * *' })).toBeNull();
  });

  it('rejects malformed EVENT schedules (and parseSchedule surfaces it as invalid_schedule)', () => {
    expect(() => parseEventTrigger({ type: 'EVENT' })).toThrow(/event_type/);
    expect(() => parseEventTrigger({ type: 'EVENT', event_type: 'Task Completed' })).toThrow(/invalid event_type/);
    expect(() => parseEventTrigger({ type: 'EVENT', event_type: 'task.completed', filter: [] as never })).toThrow(/filter/);
    expect(() => parseEventTrigger({ type: 'EVENT', event_type: 'task.completed', filter: { 'a..b': 1 } })).toThrow(/path/);
    expect(() => parseSchedule({ type: 'EVENT' })).toThrow(ScheduleValidationError);
    expect(parseSchedule({ type: 'EVENT', event_type: 'task.completed' })).toBeNull();
  });

  it('only ACTIVE and enabled tasks want a registered trigger', () => {
    const base = { status: 'ACTIVE' as const, enabled: true, schedule: { type: 'EVENT', event_type: 'task.completed' } };
    expect(desiredEventTrigger(base)).not.toBeNull();
    expect(desiredEventTrigger({ ...base, status: 'PAUSED' })).toBeNull();
    expect(desiredEventTrigger({ ...base, status: 'ARCHIVED' })).toBeNull();
    expect(desiredEventTrigger({ ...base, enabled: false })).toBeNull();
    expect(desiredEventTrigger({ ...base, schedule: { type: 'EVENT' } })).toBeNull();
  });
});

describe('filter matching', () => {
  const data = { status: 'COMPLETED', costEur: 0, funnel: { in: 3, out: 1 }, results: [{ status: 'ok' }], tags: ['a', 'b'] };

  it('matches by equality on dot paths, $. prefix and array indexes', () => {
    expect(getPath(data, 'funnel.out')).toBe(1);
    expect(getPath(data, '$.funnel.in')).toBe(3);
    expect(getPath(data, 'results.0.status')).toBe('ok');
    expect(getPath(data, 'missing.deep')).toBeUndefined();
    expect(matchesFilter(data, {})).toBe(true);
    expect(matchesFilter(data, { status: 'COMPLETED', 'funnel.out': 1 })).toBe(true);
    expect(matchesFilter(data, { tags: ['a', 'b'], funnel: { out: 1, in: 3 } })).toBe(true);
  });

  it('is strict: type, missing keys and partial objects do not match', () => {
    expect(matchesFilter(data, { status: 'FAILED' })).toBe(false);
    expect(matchesFilter(data, { 'funnel.out': '1' })).toBe(false);
    expect(matchesFilter(data, { costEur: null })).toBe(false);
    expect(matchesFilter(data, { missing: null })).toBe(false);
    expect(matchesFilter(data, { funnel: { out: 1 } })).toBe(false);
    expect(matchesFilter(data, { tags: ['a'] })).toBe(false);
  });

  it('{in: [...]} matches any listed value (OR), combined with equality keys (AND)', () => {
    const ev = { feedback: 'EDITED', subjectType: 'hypothesis', score: 0.5, toStatus: null };
    const filter = { feedback: { in: ['ACCEPTED', 'EDITED'] }, subjectType: 'hypothesis' };
    expect(matchesFilter(ev, filter)).toBe(true);
    expect(matchesFilter({ ...ev, feedback: 'ACCEPTED' }, filter)).toBe(true);
    expect(matchesFilter({ ...ev, feedback: 'DISCARDED' }, filter)).toBe(false);
    expect(matchesFilter({ ...ev, subjectType: 'research' }, filter)).toBe(false);
    // Strict per value: no type coercion, missing paths never match, null can be listed.
    expect(matchesFilter(ev, { score: { in: ['0.5', 1] } })).toBe(false);
    expect(matchesFilter(ev, { score: { in: [0.5, 1] } })).toBe(true);
    expect(matchesFilter(ev, { missing: { in: ['x'] } })).toBe(false);
    expect(matchesFilter(ev, { toStatus: { in: ['VALIDATED', null] } })).toBe(true);
    // Dot paths and deep-equal candidates.
    expect(matchesFilter(data, { 'funnel.out': { in: [0, 1] }, tags: { in: [['a', 'b'], ['c']] } })).toBe(true);
    // An object with other keys besides "in" keeps the literal (deep-equal) meaning.
    expect(matchesFilter(data, { funnel: { in: 3, out: 1 } })).toBe(true);
    // The literal object {in: 3} is reachable through the "funnel.in" path.
    expect(matchesFilter(data, { 'funnel.in': 3 })).toBe(true);
  });

  it('validates the {in} operator: array, non-empty, bounded (400 invalid_schedule at the API)', () => {
    const spec = (filter: Record<string, unknown>) => ({ type: 'EVENT', event_type: 'evaluation.recorded', filter });
    expect(parseEventTrigger(spec({ feedback: { in: ['ACCEPTED', 'EDITED'] }, subjectType: 'hypothesis' }))).toEqual({
      eventType: 'evaluation.recorded',
      filter: { feedback: { in: ['ACCEPTED', 'EDITED'] }, subjectType: 'hypothesis' },
    });
    expect(() => parseEventTrigger(spec({ feedback: { in: 'ACCEPTED' } }))).toThrow(/"in" must be an array/);
    expect(() => parseEventTrigger(spec({ feedback: { in: [] } }))).toThrow(/at least one value/);
    expect(() => parseEventTrigger(spec({ feedback: { in: Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => i) } }))).toThrow(/at most/);
    expect(() => parseSchedule(spec({ feedback: { in: null } }))).toThrow(ScheduleValidationError);
    // A malformed operator that slipped in (legacy row) never matches.
    expect(matchesFilter({ feedback: 'ACCEPTED' }, { feedback: { in: 'ACCEPTED' } })).toBe(false);
  });
});

describe('trigger evaluation and anti-loop guard', () => {
  const trigger = { eventType: 'task.completed', filter: { status: 'COMPLETED' } };
  const other = '22222222-2222-4222-8222-222222222222';

  it('fires on same tenant + type + filter, with depth = chainDepth + 1', () => {
    expect(evaluateTrigger(TASK, trigger, envelope('task.completed', { taskDefinitionId: other, status: 'COMPLETED' }))).toEqual({
      fire: true,
      depth: 1,
    });
    expect(
      evaluateTrigger(TASK, trigger, envelope('task.completed', { taskDefinitionId: other, status: 'COMPLETED', chainDepth: 2 })),
    ).toEqual({ fire: true, depth: 3 });
  });

  it('skips other tenants, other types and non-matching filters', () => {
    const ok = { taskDefinitionId: other, status: 'COMPLETED' };
    expect(evaluateTrigger(TASK, trigger, envelope('task.completed', ok, { tenantId: 'other' }))).toEqual({ fire: false, reason: 'tenant_mismatch' });
    expect(evaluateTrigger(TASK, trigger, envelope('task.failed', ok))).toEqual({ fire: false, reason: 'type_mismatch' });
    expect(evaluateTrigger(TASK, trigger, envelope('task.completed', { ...ok, status: 'FAILED' }))).toEqual({
      fire: false,
      reason: 'filter_mismatch',
    });
  });

  it('a task never fires on events of its own runs (task.* and agent.execution.*)', () => {
    const own = { taskDefinitionId: TASK.id, status: 'COMPLETED' };
    expect(evaluateTrigger(TASK, trigger, envelope('task.completed', own))).toEqual({ fire: false, reason: 'self_event' });
    const anyTrigger = { eventType: 'agent.execution.completed', filter: {} };
    expect(evaluateTrigger(TASK, anyTrigger, envelope('agent.execution.completed', own))).toEqual({ fire: false, reason: 'self_event' });
  });

  it('stops chains at the configured max depth', () => {
    const at = (chainDepth: number) => envelope('task.completed', { taskDefinitionId: other, status: 'COMPLETED', chainDepth });
    expect(DEFAULT_MAX_CHAIN_DEPTH).toBe(5);
    expect(evaluateTrigger(TASK, trigger, at(4))).toEqual({ fire: true, depth: 5 });
    expect(evaluateTrigger(TASK, trigger, at(5))).toEqual({ fire: false, reason: 'chain_depth_exceeded' });
    expect(evaluateTrigger(TASK, trigger, at(1), 1)).toEqual({ fire: false, reason: 'chain_depth_exceeded' });
    // Garbage chainDepth counts as 0 (external events).
    expect(evaluateTrigger(TASK, trigger, envelope('task.completed', { status: 'COMPLETED', chainDepth: -3 }))).toEqual({
      fire: true,
      depth: 1,
    });
  });

  it('run depth comes from the envelope stored in input.event, and is re-emitted as chainDepth', () => {
    const ev = envelope('task.completed', { taskDefinitionId: other, status: 'COMPLETED', chainDepth: 2 });
    const input = { foo: 1, ...eventTriggeredInput(ev) };
    expect(chainDepthOfRunInput(input)).toBe(3);
    expect(chainDepthOfRunInput({})).toBe(0);
    expect(chainDepthOfRunInput({ event: 'not an envelope' })).toBe(0);
    expect(chainDepthOfRunInput({ event: { data: { chainDepth: 4 } } })).toBe(0); // no id: not an envelope

    const run = { id: randomUUID(), tenantId: TENANT, taskDefinitionId: TASK.id, input, scheduledAt: new Date(), idempotencyKey: 'k' };
    expect(taskScheduledEvent(run).data.chainDepth).toBe(3);
  });
});

describe('idempotency per event', () => {
  it('one TaskRun key per (task, event), independent of delivery time', () => {
    const eventId = randomUUID();
    expect(eventTaskRunIdempotencyKey(TASK.id, eventId)).toBe(`taskrun:${TASK.id}:event:${eventId}`);
    expect(eventTaskRunIdempotencyKey(TASK.id, eventId)).toBe(eventTaskRunIdempotencyKey(TASK.id, eventId));
    expect(eventTaskRunIdempotencyKey(TASK.id, randomUUID())).not.toBe(eventTaskRunIdempotencyKey(TASK.id, eventId));
    expect(() => eventTaskRunIdempotencyKey(TASK.id, '')).toThrow();
  });
});

describe('runtime event payloads', () => {
  const runId = randomUUID();
  const executionId = randomUUID();
  const base = { id: runId, tenantId: TENANT, taskDefinitionId: TASK.id, input: {} };

  it('task.* events are compact and carry dedup keys per run (and attempt for task.started)', () => {
    const scheduled = taskScheduledEvent({ ...base, scheduledAt: new Date('2026-10-07T08:00:00Z'), idempotencyKey: 'k' }, { trigger: 'MANUAL' });
    expect(scheduled).toMatchObject({
      type: 'task.scheduled',
      correlationId: runId,
      idempotencyKey: `evt:task.scheduled:${runId}`,
      data: { taskRunId: runId, taskDefinitionId: TASK.id, scheduledAt: '2026-10-07T08:00:00.000Z', trigger: 'MANUAL', chainDepth: 0 },
    });
    expect(taskStartedEvent({ ...base, startedAt: new Date(), attempts: 2 }, executionId).idempotencyKey).toBe(`evt:task.started:${runId}:2`);

    const finished = {
      ...base,
      status: 'COMPLETED' as const,
      output: { outcome: 'PARTIAL', funnel: { in: 3, out: 1 }, results: [{ huge: 'x'.repeat(1000) }] },
      error: null,
      cost: 0.0123,
      finishedAt: new Date(),
      latencyMs: 42,
      executionId,
      attempts: 1,
    };
    const completed = taskFinishedEvent(finished);
    expect(completed.type).toBe('task.completed');
    expect(completed.data).toMatchObject({ status: 'COMPLETED', costEur: 0.0123, outcome: 'PARTIAL', funnel: { in: 3, out: 1 } });
    expect(completed.data).not.toHaveProperty('results');
    expect(completed.data).not.toHaveProperty('output');

    const failed = taskFinishedEvent({ ...finished, status: 'TIMED_OUT', output: null, error: { name: 'TimeoutError', message: 'm', stack: 's' } });
    expect(failed.type).toBe('task.failed');
    expect(failed.data).toMatchObject({ status: 'TIMED_OUT', error: { name: 'TimeoutError', message: 'm' } });
    expect((failed.data.error as Record<string, unknown>).stack).toBeUndefined();
  });

  it('agent.execution.* events use the task run as correlation, or the execution when direct', () => {
    const execution = { id: executionId, tenantId: TENANT, agentId: randomUUID(), agentVersionId: randomUUID(), input: {} };
    const ctx = { taskRunId: runId, taskDefinitionId: TASK.id, stage: 'PROSPECTOR', agentVersion: 3 };
    expect(executionStartedEvent(execution, ctx)).toMatchObject({
      type: 'agent.execution.started',
      correlationId: runId,
      data: { executionId, stage: 'PROSPECTOR', agentVersion: 3, taskDefinitionId: TASK.id },
    });
    const direct = { taskRunId: null, taskDefinitionId: null, stage: null, agentVersion: 1 };
    expect(executionFinishedEvent(execution, direct, { status: 'FAILED', error: { message: 'boom' } })).toMatchObject({
      type: 'agent.execution.failed',
      correlationId: executionId,
      data: { status: 'FAILED', error: { message: 'boom' } },
    });
    expect(executionFinishedEvent(execution, ctx, { status: 'COMPLETED', costEur: 0.5, output: { outcome: 'SUCCESS' } }).data).toMatchObject({
      status: 'COMPLETED',
      costEur: 0.5,
      outcome: 'SUCCESS',
    });
  });
});
