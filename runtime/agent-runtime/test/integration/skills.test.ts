/**
 * Versioned skills end to end against a real PostgreSQL (no Redis, no network): seed of the
 * code prompts as v1 ACTIVE, the skills API (v2 from the active one, activate, deprecate =
 * rollback), and Prospector runs (RunProcessor + StubProvider + fake Twenty) that inject the
 * resolved version and record it in the trace. Fresh tenants per run, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt7_skills.
 * Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SYSTEM_PROMPT } from '../../src/agents/prospector-prompt.js';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { skills, skillVersions, taskDefinitions, taskRuns, traces, type SkillVersionUsed } from '../../src/db/schema.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { PROSPECTOR_TASK_NAME, seedProspector } from '../../src/seed/prospector-seed.js';
import { seedSkills } from '../../src/seed/skills-seed.js';
import { seedHarnesses } from '../../src/seed/harness-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { CODE_SKILLS } from '../../src/skills/code-skills.js';
import { sha256 } from '../../src/skills/render.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

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
const dbAvailable = await databaseReachable(DATABASE_URL);

const fixture = JSON.parse(readFileSync(new URL('../fixtures/feria-ejemplo.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const IRRELEVANT = JSON.stringify({ relevant: false, confidence: 0.05, reason: 'Sin encaje.', hypothesis: null });
/** Human override of the Release Gate (these tests are about the skill lifecycle, not the gate: test/integration/experiments.test.ts). */
const FORCE = { force: true, reason: 'prueba de integración del ciclo de vida', by: 'it' };
const V2_TEXT = `${PROSPECTOR_SYSTEM_PROMPT}\n\n## Prueba v2\nPrioriza expositores con lanzamientos de producto.`;

describe.skipIf(!dbAvailable)('versioned skills (PostgreSQL)', () => {
  const tenant = `it-${randomUUID().slice(0, 8)}`;
  const headers = { 'x-tenant-id': tenant };
  const fake = new FakeTwenty();
  const warns: Array<{ obj: object; msg?: string | undefined }> = [];
  let handle: DbHandle;
  let app: FastifyInstance;
  let provider: StubProvider;
  let processor: RunProcessor;
  let runSeq = 0;

  /** One Prospector task run (direct mode, fixture input); returns the system prompts sent and the run + trace. */
  async function prospectorRun(tenantId: string) {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-skills:${tenantId}:${++runSeq}`, trigger: 'MANUAL' });
    provider = new StubProvider({ responseText: IRRELEVANT });
    for (const { job } of queue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, run!.executionId!) });
    return { systems: provider.requests.map((r) => r.system), run: run!, trace: trace! };
  }
  const recordOf = (list: SkillVersionUsed[] | unknown[], name: string) => (list as SkillVersionUsed[]).find((r) => r.name === name);

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    processor = new RunProcessor(
      handle.db,
      () => provider,
      { info() {}, warn: (obj, msg) => warns.push({ obj, msg }), error() {} },
      createDefaultToolRegistry({ twenty: fake.client() }),
      null,
    );
    // As `pnpm seed`: the seeded agent versions reference this harness (0008_harness).
    await seedHarnesses(handle.db, { tenantId: tenant });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('seed migrates the code prompts as v1 ACTIVE with their exact text, and is idempotent', async () => {
    const first = await seedSkills(handle.db, { tenantId: tenant });
    expect(first.map((s) => [s.name, s.action, s.activeVersion, s.matchesCode])).toEqual(CODE_SKILLS.map((c) => [c.name, 'created', 1, true]));
    for (const cs of CODE_SKILLS) {
      const skill = await handle.db.query.skills.findFirst({ where: and(eq(skills.tenantId, tenant), eq(skills.name, cs.name)) });
      expect(skill).toMatchObject({ status: 'ACTIVE', domain: cs.domain });
      const [v1] = await handle.db.select().from(skillVersions).where(eq(skillVersions.skillId, skill!.id));
      expect(v1).toMatchObject({ version: 1, status: 'ACTIVE', instructions: cs.text, contentHash: sha256(cs.text), createdBy: 'seed' });
      expect(skill!.activeVersionId).toBe(v1!.id);
      expect(v1!.metadata).toMatchObject({ migrated_from: cs.source });
    }
    const second = await seedSkills(handle.db, { tenantId: tenant });
    expect(second.every((s) => s.action === 'unchanged' && s.matchesCode)).toBe(true);
  });

  it('no physical DELETE and immutable version content (triggers)', async () => {
    const skill = await handle.db.query.skills.findFirst({ where: and(eq(skills.tenantId, tenant), eq(skills.name, PROSPECTOR_SKILL_ID)) });
    await expect(handle.pool.query('delete from skill_versions where skill_id = $1', [skill!.id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query('delete from skills where id = $1', [skill!.id])).rejects.toThrow(/no physical DELETE/);
    await expect(handle.pool.query(`update skill_versions set instructions = 'x' where skill_id = $1`, [skill!.id])).rejects.toThrow(/immutable/);
  });

  it('GET /skills and GET /skills/:id (by name or uuid, with versions)', async () => {
    const list = await app.inject({ method: 'GET', url: '/skills', headers });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ name: string; active_version: number; status: string }> }).items;
    expect(items.map((i) => i.name).sort()).toEqual(CODE_SKILLS.map((c) => c.name).sort());
    expect(items.every((i) => i.active_version === 1 && i.status === 'ACTIVE')).toBe(true);

    const byName = await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}`, headers });
    expect(byName.statusCode).toBe(200);
    const body = byName.json() as { skill: { id: string; active_version: number }; versions: Array<{ version: number; instructions: string }> };
    expect(body.skill.active_version).toBe(1);
    expect(body.versions.map((v) => v.version)).toEqual([1]);
    expect(body.versions[0]!.instructions).toBe(PROSPECTOR_SYSTEM_PROMPT);
    const byId = await app.inject({ method: 'GET', url: `/skills/${body.skill.id}`, headers });
    expect((byId.json() as { skill: { id: string } }).skill.id).toBe(body.skill.id);

    expect((await app.inject({ method: 'GET', url: '/skills/no-existe', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}`, headers: { 'x-tenant-id': 'otro-tenant' } })).statusCode).toBe(404);
  });

  it('POST /skills creates the skill with v1 DRAFT; validation, conflicts and no DELETE route', async () => {
    const res = await app.inject({ method: 'POST', url: '/skills', headers, payload: { name: 'it-borrador', description: 'Prueba', domain: 'testing', instructions: 'Hola' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { skill: { status: string; active_version_id: string | null }; version: { version: number; status: string; content_hash: string }; warnings: string[] };
    expect(body.skill).toMatchObject({ status: 'DRAFT', active_version_id: null });
    expect(body.version).toMatchObject({ version: 1, status: 'DRAFT', content_hash: sha256('Hola') });
    expect(body.warnings[0]).toMatch(/UNTRUSTED_SYSTEM_RULE/);

    expect((await app.inject({ method: 'POST', url: '/skills', headers, payload: { name: 'it-borrador', instructions: 'x' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/skills', headers, payload: { name: 'Mal Nombre', instructions: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/skills', headers, payload: { name: 'it-vacia' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/skills/it-borrador/versions', headers, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/skills/it-borrador/versions', headers, payload: { copy_from: 'active' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/skills/it-borrador/versions/7/activate', headers })).statusCode).toBe(404);
    // Release Gate: a version that was never ACTIVE needs an experiment or a human override.
    expect((await app.inject({ method: 'POST', url: '/skills/it-borrador/versions/1/activate', headers })).statusCode).toBe(409);
    // Deprecating the only (ACTIVE) version would leave the skill without one: rejected.
    expect((await app.inject({ method: 'POST', url: '/skills/it-borrador/versions/1/activate', headers, payload: FORCE })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/skills/it-borrador/versions/1/deprecate', headers })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/skills/it-borrador', headers })).statusCode).toBe(404);
  });

  it('v2 by API -> activate -> the next Prospector run injects v2 and the trace records it; deprecate -> back to v1', async () => {
    await seedProspector(handle.db, { tenantId: tenant, defaultInput: fixture });

    // Run on v1: the exact text of the migrated constant.
    const r1 = await prospectorRun(tenant);
    expect(r1.run.status).toBe('COMPLETED');
    expect(r1.systems.length).toBeGreaterThan(0);
    expect(r1.systems.every((s) => s === PROSPECTOR_SYSTEM_PROMPT)).toBe(true);
    const v1 = await handle.db.query.skillVersions.findFirst({
      where: and(eq(skillVersions.tenantId, tenant), eq(skillVersions.version, 1), eq(skillVersions.contentHash, sha256(PROSPECTOR_SYSTEM_PROMPT))),
    });
    expect(recordOf(r1.trace.skillVersions, PROSPECTOR_SKILL_ID)).toEqual({
      name: PROSPECTOR_SKILL_ID,
      version: 1,
      skill_version_id: v1!.id,
      content_hash: sha256(PROSPECTOR_SYSTEM_PROMPT),
      source: 'db',
      requested: { name: PROSPECTOR_SKILL_ID },
    });
    expect(recordOf(r1.run.skillVersions, PROSPECTOR_SKILL_ID)).toMatchObject({ version: 1, skill_version_id: v1!.id, source: 'db' });

    // New version from the active one (DRAFT): not used until activated.
    const created = await app.inject({
      method: 'POST',
      url: `/skills/${PROSPECTOR_SKILL_ID}/versions`,
      headers,
      payload: { copy_from: 'active', instructions: V2_TEXT, change_reason: 'prueba de integración', created_by: 'it' },
    });
    expect(created.statusCode).toBe(201);
    const v2 = (created.json() as { version: { id: string; version: number; status: string; metadata: Record<string, unknown>; created_by: string } }).version;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT', created_by: 'it' });
    expect(v2.metadata).toMatchObject({ copied_from: { version: 1, skill_version_id: v1!.id }, change_reason: 'prueba de integración' });
    expect((await prospectorRun(tenant)).systems.every((s) => s === PROSPECTOR_SYSTEM_PROMPT)).toBe(true);

    const act = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/2/activate`, headers, payload: FORCE });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ changed: true, version: { version: 2, status: 'ACTIVE' }, previous_version: { version: 1, status: 'DEPRECATED' }, skill: { active_version_id: v2.id }, gate: { mode: 'override' } });
    const again = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/2/activate`, headers });
    expect(again.json()).toMatchObject({ changed: false });

    const r2 = await prospectorRun(tenant);
    expect(r2.run.status).toBe('COMPLETED');
    expect(r2.systems.length).toBeGreaterThan(0);
    expect(r2.systems.every((s) => s === V2_TEXT)).toBe(true);
    expect(recordOf(r2.trace.skillVersions, PROSPECTOR_SKILL_ID)).toEqual({
      name: PROSPECTOR_SKILL_ID,
      version: 2,
      skill_version_id: v2.id,
      content_hash: sha256(V2_TEXT),
      source: 'db',
      requested: { name: PROSPECTOR_SKILL_ID },
    });
    expect(recordOf(r2.run.skillVersions, PROSPECTOR_SKILL_ID)).toMatchObject({ version: 2, skill_version_id: v2.id });
    // The other refs of the version resolved too (the direct mode does not inject them).
    expect(recordOf(r2.trace.skillVersions, 'event-source-discovery')).toMatchObject({ version: 1, source: 'db' });
    // The earlier trace is untouched (immutable execution).
    const old = await handle.db.query.traces.findFirst({ where: eq(traces.id, r1.trace.id) });
    expect(recordOf(old!.skillVersions, PROSPECTOR_SKILL_ID)).toMatchObject({ version: 1 });

    // Deprecating the ACTIVE v2 restores v1.
    const dep = await app.inject({ method: 'POST', url: `/skills/${PROSPECTOR_SKILL_ID}/versions/2/deprecate`, headers });
    expect(dep.statusCode).toBe(200);
    expect(dep.json()).toMatchObject({ changed: true, version: { version: 2, status: 'DEPRECATED' }, restored_version: { version: 1, status: 'ACTIVE' }, skill: { active_version_id: v1!.id } });
    const r3 = await prospectorRun(tenant);
    expect(r3.systems.every((s) => s === PROSPECTOR_SYSTEM_PROMPT)).toBe(true);
    expect(recordOf(r3.trace.skillVersions, PROSPECTOR_SKILL_ID)).toMatchObject({ version: 1, skill_version_id: v1!.id, source: 'db' });

    const detail = await app.inject({ method: 'GET', url: `/skills/${PROSPECTOR_SKILL_ID}`, headers });
    expect((detail.json() as { versions: Array<{ version: number; status: string }> }).versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'DEPRECATED'],
      [1, 'ACTIVE'],
    ]);
    expect(warns).toEqual([]);
  });

  it('a skill missing in the database falls back to the code constant with a warning; the trace keeps the exact text', async () => {
    const bare = `it-${randomUUID().slice(0, 8)}`; // agents seeded, skills not seeded
    await seedProspector(handle.db, { tenantId: bare, defaultInput: fixture });
    warns.length = 0;
    const r = await prospectorRun(bare);
    expect(r.run.status).toBe('COMPLETED');
    expect(r.systems.every((s) => s === PROSPECTOR_SYSTEM_PROMPT)).toBe(true);
    expect(recordOf(r.trace.skillVersions, PROSPECTOR_SKILL_ID)).toEqual({
      name: PROSPECTOR_SKILL_ID,
      version: 2, // code version of the constant (PROSPECTOR_SKILL_VERSION)
      skill_version_id: null,
      content_hash: sha256(PROSPECTOR_SYSTEM_PROMPT),
      source: 'code',
      requested: { name: PROSPECTOR_SKILL_ID },
      fallback_reason: 'skill_not_found',
      text: PROSPECTOR_SYSTEM_PROMPT,
    });
    expect(recordOf(r.run.skillVersions, PROSPECTOR_SKILL_ID)).not.toHaveProperty('text');
    expect(warns.filter((w) => /skill not found/.test(w.msg ?? '')).map((w) => (w.obj as { skill: string }).skill).sort()).toEqual(
      ['event-source-discovery', 'exhibitor-list-extraction', PROSPECTOR_SKILL_ID].sort(),
    );
  });

  it('a version pinned in skill_refs is kept after another version is activated (direct execution, StubAgent)', async () => {
    await app.inject({ method: 'POST', url: '/skills', headers, payload: { name: 'it-pinned', instructions: 'PIN V1' } });
    await app.inject({ method: 'POST', url: '/skills/it-pinned/versions/1/activate', headers, payload: FORCE });
    await app.inject({ method: 'POST', url: '/skills/it-pinned/versions', headers, payload: { instructions: 'PIN V2' } });
    await app.inject({ method: 'POST', url: '/skills/it-pinned/versions/2/activate', headers, payload: FORCE });
    const agentRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers,
      payload: { name: `it-stub-${randomUUID().slice(0, 6)}`, version: { system_prompt: 'BASE', skill_refs: [{ name: 'it-pinned', version: 1 }, { name: 'it-borrador' }] } },
    });
    expect(agentRes.statusCode).toBe(201);
    const { agent } = agentRes.json() as { agent: { id: string } };
    const queue = new MemoryRunQueue();
    const app2 = await buildServer({ db: handle.db, queue, config: { defaultTenantId: tenant, defaultModelProvider: 'stub' } });
    const exec = await app2.inject({ method: 'POST', url: '/executions', headers, payload: { agent_id: agent.id, input: { query: 'x' } } });
    await app2.close();
    expect(exec.statusCode).toBe(202);
    provider = new StubProvider();
    for (const { job } of queue.drain()) await processor.process(job);
    // it-borrador: v1 was activated in an earlier test.
    expect(provider.requests.map((r) => r.system)).toEqual(['BASE\n\nPIN V1\n\nHola']);
    const execution = (exec.json() as { execution: { id: string } }).execution;
    const trace = await handle.db.query.traces.findFirst({ where: eq(traces.executionId, execution.id) });
    expect(trace!.skillVersions.map((r) => [r.name, r.version, r.source])).toEqual([
      ['it-pinned', 1, 'db'],
      ['it-borrador', 1, 'db'],
    ]);
  });
});
