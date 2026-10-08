/**
 * Which API routes are audited and how (src/audit/hook.ts). Keyed by `METHOD /route/pattern`
 * exactly as Fastify registers it. Every mutating route (POST/PUT/PATCH/DELETE) must be in
 * AUDITED_ROUTES or in NOT_AUDITED with the reason: test/unit/audit.test.ts builds the server and
 * fails on any unclassified one, so a new route cannot skip the decision. GETs are never audited.
 */

export interface AuditInput {
  params: Record<string, unknown>;
  body: Record<string, unknown>;
  /** Parsed JSON response (null when it was not JSON). */
  response: Record<string, unknown> | null;
}

export interface AuditSpec {
  /** e.g. `skill.activate`; a function when the body decides it (`skill.force_activate`). */
  action: string | ((i: AuditInput) => string);
  subjectType: string;
  /** Defaults to `params.id` (or `params.name`). */
  subjectId?: (i: AuditInput) => string | null | undefined;
  /** Defaults to `params.v` when numeric. */
  subjectVersion?: (i: AuditInput) => number | null | undefined;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** `response[key][field]`. */
const res = (i: AuditInput, key: string, field: string): unknown => obj(i.response?.[key])?.[field];

/** Activation with `force: true` is its own action: a human override of the Release Gate. */
const activation = (kind: 'skill' | 'harness') => (i: AuditInput) => (i.body.force === true ? `${kind}.force_activate` : `${kind}.activate`);

const createdName = (key: string) => (i: AuditInput) => str(res(i, key, 'name')) ?? str(i.body.name);
const responseVersion = (key: string) => (i: AuditInput) => num(res(i, key, 'version'));

export const AUDITED_ROUTES: Readonly<Record<string, AuditSpec>> = {
  // Skills and their canary (src/api/routes/skills.ts)
  'POST /skills': { action: 'skill.create', subjectType: 'skill', subjectId: createdName('skill'), subjectVersion: responseVersion('version') },
  'POST /skills/:id/versions': { action: 'skill.version_create', subjectType: 'skill', subjectVersion: responseVersion('version') },
  'POST /skills/:id/versions/:v/activate': { action: activation('skill'), subjectType: 'skill' },
  'POST /skills/:id/versions/:v/deprecate': { action: 'skill.deprecate', subjectType: 'skill' },
  'POST /skills/:id/versions/:v/canary': { action: 'canary.start', subjectType: 'skill' },
  'POST /skills/:id/canary/promote': { action: 'canary.promote', subjectType: 'skill', subjectVersion: (i) => num(res(i, 'canary', 'canary_version')) },
  'POST /skills/:id/canary/rollback': { action: 'canary.rollback', subjectType: 'skill', subjectVersion: (i) => num(res(i, 'canary', 'canary_version')) },
  // Harnesses (src/api/routes/harnesses.ts)
  'POST /harnesses': { action: 'harness.create', subjectType: 'harness', subjectId: createdName('harness'), subjectVersion: responseVersion('version') },
  'POST /harnesses/:id/versions': { action: 'harness.version_create', subjectType: 'harness', subjectVersion: responseVersion('version') },
  'POST /harnesses/:id/versions/:v/activate': { action: activation('harness'), subjectType: 'harness' },
  'POST /harnesses/:id/versions/:v/deprecate': { action: 'harness.deprecate', subjectType: 'harness' },
  // Skill Optimizer (src/api/routes/optimizer.ts)
  'POST /optimizer/skills/:name/run': { action: 'optimizer.run', subjectType: 'skill', subjectVersion: (i) => num(res(i, 'run', 'base_version')) },
  'POST /optimizer/runs/:id/close': { action: 'optimizer.close', subjectType: 'optimization_run', subjectVersion: (i) => num(res(i, 'run', 'candidate_version')) },
  // Evaluation datasets (src/api/routes/datasets.ts)
  'POST /datasets': { action: 'dataset.create', subjectType: 'dataset', subjectId: (i) => str(res(i, 'dataset', 'id')) ?? str(i.body.name), subjectVersion: responseVersion('dataset') },
  'POST /datasets/:id/build': { action: 'dataset.build', subjectType: 'dataset', subjectVersion: responseVersion('dataset') },
  'POST /datasets/:id/mark-used': { action: 'dataset.mark_used', subjectType: 'dataset' },
  'POST /datasets/:id/activate': { action: 'dataset.activate', subjectType: 'dataset', subjectVersion: responseVersion('dataset') },
  'POST /datasets/:id/archive': { action: 'dataset.archive', subjectType: 'dataset', subjectVersion: responseVersion('dataset') },
  // Knowledge layer (src/api/routes/knowledge.ts)
  'POST /knowledge': { action: 'knowledge.propose', subjectType: 'knowledge_entry', subjectId: (i) => str(res(i, 'entry', 'id')) },
  'PATCH /knowledge/:id': { action: 'knowledge.update', subjectType: 'knowledge_entry' },
  'POST /knowledge/:id/validate': { action: 'knowledge.validate', subjectType: 'knowledge_entry' },
  'POST /knowledge/:id/activate': { action: 'knowledge.activate', subjectType: 'knowledge_entry' },
  'POST /knowledge/:id/supersede': { action: 'knowledge.supersede', subjectType: 'knowledge_entry' },
  'POST /knowledge/:id/reject': { action: 'knowledge.reject', subjectType: 'knowledge_entry' },
  // Agents and tasks: configuration and lifecycle (src/api/routes/agents.ts, tasks.ts)
  'POST /agents': { action: 'agent.create', subjectType: 'agent', subjectId: (i) => str(res(i, 'agent', 'id')) ?? str(i.body.name), subjectVersion: (i) => num(res(i, 'version', 'version')) },
  'PATCH /agents/:id': { action: 'agent.update', subjectType: 'agent' },
  'POST /agents/:id/pause': { action: 'agent.pause', subjectType: 'agent' },
  'POST /tasks': { action: 'task.create', subjectType: 'task', subjectId: (i) => str(res(i, 'task', 'id')) ?? str(i.body.name) },
  'PATCH /tasks/:id': { action: 'task.update', subjectType: 'task' },
  'POST /tasks/:id/pause': { action: 'task.pause', subjectType: 'task' },
  'POST /tasks/:id/resume': { action: 'task.resume', subjectType: 'task' },
  'POST /tasks/:id/archive': { action: 'task.archive', subjectType: 'task' },
  'POST /executions/:id/cancel': { action: 'execution.cancel', subjectType: 'execution' },
  // Outbound webhooks (src/events/external-routes.ts)
  'POST /event-subscriptions': { action: 'event_subscription.create', subjectType: 'event_subscription', subjectId: (i) => str(res(i, 'subscription', 'id')) ?? str(i.body.name) },
  'PATCH /event-subscriptions/:id': { action: 'event_subscription.update', subjectType: 'event_subscription' },
};

/** Mutating routes deliberately left out, with the reason (they have their own record). */
export const NOT_AUDITED: Readonly<Record<string, string>> = {
  'POST /executions': 'operativa: la ejecución es su propio registro (agent_executions + traces)',
  'POST /tasks/:id/run': 'operativa: el TaskRun (trigger MANUAL) es su propio registro',
  'POST /evaluations/human': 'el veredicto es su propio registro append-only (evaluations)',
  'POST /webhooks/twenty': 'webhook firmado de Twenty: el veredicto queda en evaluations',
  'POST /events/external': 'ingesta autenticada por token: el evento queda en events (append-only)',
  'POST /agents/:id/evaluate': '501 sin implementar',
  'POST /agents/:id/promote': '501 sin implementar',
  'POST /agents/:id/rollback': '501 sin implementar',
  'POST /executions/:id/pause': '501 sin implementar',
  'POST /executions/:id/resume': '501 sin implementar',
};

export const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}
