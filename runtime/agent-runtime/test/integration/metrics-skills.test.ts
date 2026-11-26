/**
 * GET /metrics/skills against a real PostgreSQL: acceptance per SKILL version from
 * traces.skill_versions (source 'db' only) crossed with human verdicts. Same database
 * policy as metrics.test.ts: own test DB agentos_wt4_metrics (never the shared `agentos`),
 * fresh tenants per run, no DELETE.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, agents, evaluations, skills, skillVersions, traces, type SkillVersionUsed } from '../../src/db/schema.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://agentos:agentos_dev@127.0.0.1:5440/agentos_wt4_metrics';

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROSPECTOR_SKILL = 'prospector-event-exhibitors';
const SCOUT_SKILL = 'event-scout-core';

describe.skipIf(!dbAvailable)('metrics/skills (PostgreSQL, seeded)', () => {
  const tenantA = `ms-${randomUUID().slice(0, 8)}`;
  const tenantB = `ms-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  let handle: DbHandle;
  let app: FastifyInstance;
  let sv1Id = '';
  let sv2Id = '';

  const get = (url: string, tenant: string) => app.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } });

  const dbSkill = (name: string, version: number, id: string): SkillVersionUsed => ({
    name,
    version,
    skill_version_id: id,
    content_hash: `hash-${name}-v${version}`,
    source: 'db',
    requested: { name },
  });
  const codeSkill = (name: string, version: number): SkillVersionUsed => ({
    name,
    version,
    skill_version_id: null,
    content_hash: `hash-${name}-code`,
    source: 'code',
    requested: { skill_id: name, version },
    fallback_reason: 'legacy_ref',
  });

  /** One COMPLETED execution with its trace carrying the given skill versions. */
  async function seedExecution(tenant: string, agentId: string, createdAt: Date, used: SkillVersionUsed[]): Promise<string> {
    const [ex] = await handle.db
      .insert(agentExecutions)
      .values({ tenantId: tenant, agentId, status: 'COMPLETED', totalCost: 0, createdAt })
      .returning();
    await handle.db.insert(traces).values({ tenantId: tenant, executionId: ex!.id, agentId, skillVersions: used });
    return ex!.id;
  }

  async function verdict(
    tenant: string,
    subjectId: string,
    executionId: string,
    feedback: 'ACCEPTED' | 'EDITED' | 'DISCARDED',
    at: Date,
    opts: { human?: boolean | null; editedFields?: Record<string, { before: unknown; after: unknown }> } = {},
  ) {
    const human = opts.human === undefined ? true : opts.human;
    await handle.db.insert(evaluations).values({
      tenantId: tenant,
      subjectType: 'hypothesis',
      subjectId,
      agentExecutionId: executionId,
      feedback,
      score: feedback === 'ACCEPTED' ? 1 : feedback === 'EDITED' ? 0.5 : 0,
      details: {
        ...(human === null ? {} : { actor: { human } }),
        ...(opts.editedFields ? { edited_fields: opts.editedFields } : {}),
      },
      occurredAt: at,
    });
  }

  async function seedSkill(tenant: string, name: string, versions: Array<{ version: number; status: 'ACTIVE' | 'DEPRECATED'; activatedAt?: Date }>) {
    const [skill] = await handle.db.insert(skills).values({ tenantId: tenant, name, status: 'ACTIVE' }).returning();
    const ids: string[] = [];
    for (const v of versions) {
      const [row] = await handle.db
        .insert(skillVersions)
        .values({
          tenantId: tenant,
          skillId: skill!.id,
          version: v.version,
          status: v.status,
          instructions: `instructions v${v.version}`,
          contentHash: `hash-${name}-v${v.version}`,
          activatedAt: v.activatedAt ?? null,
        })
        .returning();
      ids.push(row!.id);
    }
    return ids;
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);

    // ---- tenant A: Prospector with skill v1 (DEPRECATED) and v2 (ACTIVE since 10-05)
    const [agent] = await handle.db.insert(agents).values({ tenantId: tenantA, name: 'Prospector', status: 'ACTIVE' }).returning();
    [sv1Id, sv2Id] = (await seedSkill(tenantA, PROSPECTOR_SKILL, [
      { version: 1, status: 'DEPRECATED' },
      { version: 2, status: 'ACTIVE', activatedAt: new Date('2026-10-05T10:00:00Z') },
    ])) as [string, string];
    const [scoutId] = await seedSkill(tenantA, SCOUT_SKILL, [{ version: 1, status: 'ACTIVE' }]);

    // e1 (10 days ago) and e2 used skill v1; e3 and e4 used v2. e3 also used another db
    // skill and a code skill (the code entry must never appear in the metric).
    const e1 = await seedExecution(tenantA, agent!.id, new Date(now - 10 * DAY), [dbSkill(PROSPECTOR_SKILL, 1, sv1Id)]);
    const e2 = await seedExecution(tenantA, agent!.id, new Date(now - 3 * HOUR), [dbSkill(PROSPECTOR_SKILL, 1, sv1Id)]);
    const e3 = await seedExecution(tenantA, agent!.id, new Date(now - 2 * HOUR), [
      dbSkill(PROSPECTOR_SKILL, 2, sv2Id),
      dbSkill(SCOUT_SKILL, 1, scoutId!),
      codeSkill('catalog-json', 3),
    ]);
    const e4 = await seedExecution(tenantA, agent!.id, new Date(now - 1 * HOUR), [dbSkill(PROSPECTOR_SKILL, 2, sv2Id)]);

    // An ARCHIVED agent also ran with v2: hidden unless include_archived=true.
    const [archived] = await handle.db.insert(agents).values({ tenantId: tenantA, name: '[TEST] Old', status: 'ARCHIVED' }).returning();
    await seedExecution(tenantA, archived!.id, new Date(now - 1 * HOUR), [dbSkill(PROSPECTOR_SKILL, 2, sv2Id)]);

    // Human verdicts. v1: h1 ACCEPTED; h2 EDITED (need, quantityMax) then DISCARDED (latest
    // wins; the edit still counts in edited_fields). v2: h3 ACCEPTED, h4 EDITED (need).
    await verdict(tenantA, 'h1', e1, 'ACCEPTED', new Date('2026-10-01T09:00:00Z'));
    await verdict(tenantA, 'h2', e2, 'EDITED', new Date('2026-10-01T10:00:00Z'), {
      editedFields: { need: { before: '200 lanyards', after: '300 lanyards' }, quantityMax: { before: 200, after: 250 } },
    });
    await verdict(tenantA, 'h2', e2, 'DISCARDED', new Date('2026-10-02T10:00:00Z'));
    await verdict(tenantA, 'h3', e3, 'ACCEPTED', new Date('2026-10-06T11:00:00Z'));
    await verdict(tenantA, 'h4', e4, 'EDITED', new Date('2026-10-06T12:00:00Z'), { editedFields: { need: { before: 'a', after: 'b' } } });
    // Not human / no actor: must not count anywhere.
    await verdict(tenantA, 'h5', e4, 'ACCEPTED', new Date('2026-10-06T13:00:00Z'), { human: false });
    await verdict(tenantA, 'h6', e4, 'ACCEPTED', new Date('2026-10-06T14:00:00Z'), { human: null });

    // ---- tenant B: same skill name, everything discarded. Must never leak into A.
    const [agentB] = await handle.db.insert(agents).values({ tenantId: tenantB, name: 'Prospector', status: 'ACTIVE' }).returning();
    const [svB] = await seedSkill(tenantB, PROSPECTOR_SKILL, [{ version: 1, status: 'ACTIVE' }]);
    const eB = await seedExecution(tenantB, agentB!.id, new Date(now - 1 * HOUR), [dbSkill(PROSPECTOR_SKILL, 1, svB!)]);
    await verdict(tenantB, 'hb1', eB, 'DISCARDED', new Date('2026-10-02T10:00:00Z'));

    app = await buildServer({ db: handle.db, queue: new MemoryRunQueue(), config: { defaultTenantId: 'publiexpe', defaultModelProvider: 'stub' } });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('skills: acceptance and edited fields per skill version, source db only, human verdicts only', async () => {
    const res = await get('/metrics/skills', tenantA);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tenant_id: tenantA, skill: null, source: 'db', human_verdicts_only: true, include_archived: false });
    expect(body.window.field).toBe('agent_executions.created_at');

    const items = body.items as Array<Record<string, any>>;
    // Ordered by name then version; the 'code' entry (catalog-json) never shows up.
    expect(items.map((i) => [i.skill_name, i.skill_version])).toEqual([
      [SCOUT_SKILL, 1],
      [PROSPECTOR_SKILL, 1],
      [PROSPECTOR_SKILL, 2],
    ]);
    const [scout, v1, v2] = items;

    expect(v1).toMatchObject({ version_label: 'v1', skill_version_id: sv1Id, version_status: 'DEPRECATED', executions: 2 });
    expect(v1!.activated_at).toBeNull();
    // h1 ACCEPTED; h2 EDITED -> DISCARDED (latest): 1/2 accepted, 3 verdict rows.
    expect(v1!.human_feedback).toMatchObject({ verdicts: 3, subjects_reviewed: 2, accepted: 1, edited: 0, discarded: 1, acceptance_rate: 0.5, useful_rate: 0.5, avg_score: 0.5 });
    // The EDITED row of h2 still counts its fields (equal counts -> field name order).
    expect(v1!.edited_fields).toEqual([
      { field: 'need', edits: 1 },
      { field: 'quantityMax', edits: 1 },
    ]);

    expect(v2).toMatchObject({ version_label: 'v2', skill_version_id: sv2Id, version_status: 'ACTIVE', executions: 2 });
    expect(v2!.activated_at).toBe('2026-10-05T10:00:00.000Z');
    // h3 ACCEPTED, h4 EDITED; h5 (actor.human=false) and h6 (no actor) are ignored.
    expect(v2!.human_feedback).toMatchObject({ verdicts: 2, subjects_reviewed: 2, accepted: 1, edited: 1, discarded: 0, acceptance_rate: 0.5, useful_rate: 1, avg_score: 0.75 });
    expect(v2!.edited_fields).toEqual([{ field: 'need', edits: 1 }]);

    // e3 also injected the scout skill: its verdict (h3) counts for that version too.
    expect(scout).toMatchObject({ skill_name: SCOUT_SKILL, executions: 1, version_status: 'ACTIVE' });
    expect(scout!.human_feedback).toMatchObject({ verdicts: 1, accepted: 1, acceptance_rate: 1 });
  });

  it('skills: skill filter, kebab-case validation and window rules', async () => {
    const filtered = (await get(`/metrics/skills?skill=${PROSPECTOR_SKILL}`, tenantA)).json();
    expect(filtered.skill).toBe(PROSPECTOR_SKILL);
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((i: { skill_name: string }) => i.skill_name === PROSPECTOR_SKILL)).toBe(true);

    const unknown = (await get('/metrics/skills?skill=no-such-skill', tenantA)).json();
    expect(unknown.items).toEqual([]);

    expect((await get('/metrics/skills?skill=Not_Kebab', tenantA)).statusCode).toBe(400);
    const since = new Date(now).toISOString();
    const until = new Date(now - DAY).toISOString();
    expect((await get(`/metrics/skills?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`, tenantA)).statusCode).toBe(400);
  });

  it('skills: since/until window on agent_executions.created_at', async () => {
    const since = new Date(now - 7 * DAY).toISOString();
    const body = (await get(`/metrics/skills?skill=${PROSPECTOR_SKILL}&since=${encodeURIComponent(since)}`, tenantA)).json();
    const v1 = body.items.find((i: { skill_version: number }) => i.skill_version === 1);
    // e1 (10 days ago) is out: one execution left and h1's verdict no longer counts.
    expect(v1).toMatchObject({ executions: 1 });
    expect(v1.human_feedback).toMatchObject({ verdicts: 2, subjects_reviewed: 1, accepted: 0, discarded: 1, acceptance_rate: 0 });
  });

  it('skills: archived agents are hidden unless include_archived', async () => {
    const v2 = (q: string) =>
      get(`/metrics/skills?skill=${PROSPECTOR_SKILL}${q}`, tenantA).then((r) => r.json().items.find((i: { skill_version: number }) => i.skill_version === 2));
    expect((await v2(''))!.executions).toBe(2);
    expect((await v2('&include_archived=true'))!.executions).toBe(3);
  });

  it('skills: tenant isolation', async () => {
    const b = (await get('/metrics/skills', tenantB)).json();
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ skill_name: PROSPECTOR_SKILL, skill_version: 1, executions: 1 });
    expect(b.items[0].human_feedback).toMatchObject({ verdicts: 1, discarded: 1, acceptance_rate: 0 });
    // Tenant B's skill_version_id differs from A's even though name and version match.
    expect(b.items[0].skill_version_id).not.toBe(sv1Id);
  });
});
