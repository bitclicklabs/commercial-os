/**
 * Signal-driven daily prospecting end to end against a real PostgreSQL (no Redis, no network):
 * the seed v2 of `daily-event-prospecting` (`{ mode: 'signals' }`, idempotent), the discovery-only
 * weekly scouting, the retired live-test task (disabled with a new version, never deleted), and
 * daily runs (RunProcessor + StubProvider + FakeTwenty + FakeWeb) that expire past fair signals,
 * scout the least recently worked QUALIFIED fair (round-robin read from agent_executions) and end
 * SKIPPED when nothing is qualified. Fresh tenants per run, no DELETE.
 * Run it against its own database: DATABASE_URL=postgres://.../agentos_wt15_signals.
 * Skipped when the database is not reachable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { agentExecutions, taskDefinitions, taskDefinitionVersions, taskRuns } from '../../src/db/schema.js';
import { DrizzleSignalHistory } from '../../src/agents/signal-prospecting.js';
import { StubProvider } from '../../src/providers/index.js';
import { MemoryRunQueue } from '../../src/queue/run-queue.js';
import { PROSPECTOR_TASK_NAME, RETIRED_TASKS, SCOUT_SECTORS, SCOUT_TASK_NAME, seedProspector } from '../../src/seed/prospector-seed.js';
import { requestTaskRun } from '../../src/services/task-runs.js';
import { createDefaultToolRegistry } from '../../src/tools/index.js';
import { RunProcessor } from '../../src/worker/processor.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';
import { FakeWeb } from '../helpers/fake-web.js';

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
const NO_LIST = JSON.stringify({ page_kind: 'event_home', event: null, exhibitors: [], exhibitors_page_url: null, notes: 'sin lista publicada' });

const ANUGA_URL = 'https://www.anugaselect-iberica.com/expositores';
const BWW_URL = 'https://www.barcelonawineweek.com/expositores';

function fairSignal(fake: FakeTwenty, tenantId: string, name: string, status: string, eventDate: string, url: string) {
  return fake.seed('commercialSignals', {
    name,
    signalType: 'FAIR',
    status,
    eventDate,
    sourceUrl: { primaryLinkUrl: url, primaryLinkLabel: '', secondaryLinks: [] },
    sourceDomain: new URL(url).hostname.replace(/^www\./, ''),
    companyId: null,
    tenantId,
  });
}

type DailyOutput = {
  outcome: string;
  mode: string;
  signal_id?: string;
  event_name?: string;
  reason?: string;
  signals: { expired: Array<{ id: string }>; qualified_current: number; selection?: { source: string; candidates: Array<{ id: string; last_worked_at: string | null }> } };
  cost: { model: number };
};

describe.skipIf(!dbAvailable)('signal-driven daily prospecting (PostgreSQL)', () => {
  const tenant = `it-sig-${randomUUID().slice(0, 8)}`;
  let handle: DbHandle;
  let provider: StubProvider;
  let runSeq = 0;

  const processorFor = (fake: FakeTwenty, web: FakeWeb) =>
    new RunProcessor(handle.db, () => provider, { info() {}, warn() {}, error() {} }, createDefaultToolRegistry({ twenty: fake.client(), web: web.deps(), render: { endpoint: null } }), null);

  async function dailyRun(tenantId: string, processor: RunProcessor, responses: string[]) {
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, tenantId), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const queue = new MemoryRunQueue();
    const { taskRun } = await requestTaskRun(handle.db, queue, task!, { idempotencyKey: `it-signals:${tenantId}:${++runSeq}`, trigger: 'MANUAL' });
    provider = new StubProvider({ responses });
    for (const { job } of queue.drain()) await processor.process(job);
    const run = await handle.db.query.taskRuns.findFirst({ where: eq(taskRuns.id, taskRun.id) });
    return { run: run!, output: run!.output as unknown as DailyOutput, requests: provider.requests.length };
  }

  beforeAll(async () => {
    handle = createDb(DATABASE_URL);
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('seed v2: daily task to signals mode with a new version, weekly to discovery only, retired task disabled; idempotent', async () => {
    const t = `${tenant}-seed`;
    // v1 as it was deployed: the fixture fair inside the daily task.
    const v1 = await seedProspector(handle.db, { tenantId: t, defaultInput: fixture });
    expect(v1.taskAction).toBe('created');
    // The orphan live-test task, as the live scout test left it (MANUAL, enabled).
    const [orphan] = await handle.db
      .insert(taskDefinitions)
      .values({ tenantId: t, name: RETIRED_TASKS[0], agentId: v1.agentId, defaultInput: { sector: 'alimentación y bebidas' }, schedule: { type: 'MANUAL' }, enabled: true, currentVersion: 1 })
      .returning();

    const v2 = await seedProspector(handle.db, { tenantId: t });
    expect(v2).toMatchObject({ taskAction: 'updated', taskVersion: 2, scoutTaskAction: 'unchanged' });
    expect(v2.retiredTasks).toEqual([{ name: 'event-scouting-live-test-muxyo7gz', action: 'disabled', version: 2 }]);
    const daily = await handle.db.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, v2.taskId) });
    expect(daily).toMatchObject({ defaultInput: { mode: 'signals' }, enabled: true, timeoutMs: 1_800_000, schedule: { type: 'CRON', expression: '0 8 * * *' }, currentVersion: 2 });
    const versions = await handle.db.select().from(taskDefinitionVersions).where(eq(taskDefinitionVersions.taskDefinitionId, v2.taskId));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    // The v1 snapshot (with the fixture) is kept: versions are never deleted.
    expect((versions.find((v) => v.version === 1)!.definition as { default_input: Record<string, unknown> }).default_input).toMatchObject({ event: { name: 'Expo Alimentaria Ibérica 2026' } });
    const weekly = await handle.db.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, v2.scoutTaskId) });
    // Tanda 21: the six sectors in one run + company signals.
    expect(weekly!.defaultInput).toEqual({ sectors: [...SCOUT_SECTORS], region: 'España', horizon_months: 6, discover_only: true, company_signals: true, company_signal_kinds: ['financiacion', 'aniversario'] });
    const retired = await handle.db.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, orphan!.id) });
    expect(retired).toMatchObject({ enabled: false, currentVersion: 2, status: orphan!.status });
    const retiredVersions = await handle.db.select().from(taskDefinitionVersions).where(eq(taskDefinitionVersions.taskDefinitionId, orphan!.id));
    expect(retiredVersions).toHaveLength(1);
    expect(retiredVersions[0]).toMatchObject({ version: 2, changeReason: expect.stringContaining('retired by seed') });

    const again = await seedProspector(handle.db, { tenantId: t });
    expect(again).toMatchObject({ agentAction: 'unchanged', taskAction: 'unchanged', taskVersion: 2, scoutTaskAction: 'unchanged' });
    expect(again.retiredTasks).toEqual([{ name: 'event-scouting-live-test-muxyo7gz', action: 'already_disabled', version: 2 }]);
    expect(await handle.db.select().from(taskDefinitionVersions).where(eq(taskDefinitionVersions.taskDefinitionId, v2.taskId))).toHaveLength(2);
    // Weekly scouting: same name, a new version with the discovery input (it was created with it here).
    expect(SCOUT_TASK_NAME).toBe('weekly-event-scouting');
  });

  it('daily runs: past fair expired, directed scout on the least recently worked QUALIFIED fair (round-robin from agent_executions)', async () => {
    const t = `${tenant}-run`;
    await seedProspector(handle.db, { tenantId: t });
    const fake = new FakeTwenty();
    const anuga = fairSignal(fake, t, 'Anuga Select Ibérica 2027 (1ª edición) (feria)', 'QUALIFIED', '2027-01-20', ANUGA_URL);
    const bww = fairSignal(fake, t, 'Barcelona Wine Week 2027 (feria)', 'QUALIFIED', '2027-02-10', BWW_URL);
    const past = fairSignal(fake, t, 'Alimentaria Lisboa 2026 (feria)', 'QUALIFIED', '2026-09-20', 'https://www.alimentaria-lisboa.pt/');
    const web = new FakeWeb()
      .page(ANUGA_URL, '<title>Anuga Select Ibérica 2027</title><p>Expositores próximamente.</p>')
      .page(BWW_URL, '<title>Barcelona Wine Week 2027</title><p>Expositores próximamente.</p>');
    const processor = processorFor(fake, web);
    const before = fake.tables.commercialSignals.length;

    // Run 1: nothing worked yet -> nearest date (Anuga); the past one expires first.
    const r1 = await dailyRun(t, processor, [NO_LIST]);
    expect(r1.run.status).toBe('COMPLETED');
    expect(r1.output).toMatchObject({ mode: 'signals', signal_id: anuga.id, event_name: 'Anuga Select Ibérica 2027 (1ª edición)' });
    expect(r1.output.signals.expired.map((e) => e.id)).toEqual([past.id]);
    expect(r1.output.signals.selection?.source).toBe('agent_executions');
    expect(fake.tables.commercialSignals.find((s) => s.id === past.id)!.status).toBe('EXPIRED');

    // Run 2: Anuga was worked by run 1 -> Barcelona Wine Week.
    const r2 = await dailyRun(t, processor, [NO_LIST]);
    expect(r2.output.signal_id).toBe(bww.id);
    expect(r2.output.signals.expired).toEqual([]);
    expect(r2.output.signals.selection?.candidates.find((c) => c.id === anuga.id)?.last_worked_at).not.toBeNull();

    // Run 3: both worked -> the one worked longest ago (Anuga again).
    const r3 = await dailyRun(t, processor, [NO_LIST]);
    expect(r3.output.signal_id).toBe(anuga.id);

    // The qualified fairs were not duplicated (same date and domain) and keep their status.
    expect(fake.tables.commercialSignals).toHaveLength(before);
    expect([anuga, bww].map((s) => fake.tables.commercialSignals.find((r) => r.id === s.id)!.status)).toEqual(['QUALIFIED', 'QUALIFIED']);
    const task = await handle.db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.tenantId, t), eq(taskDefinitions.name, PROSPECTOR_TASK_NAME)) });
    const history = await new DrizzleSignalHistory(handle.db).lastWorked({ tenantId: t, agentId: task!.agentId, excludeExecutionId: randomUUID() });
    expect([...history.keys()].sort()).toEqual([anuga.id as string, bww.id as string].sort());
  });

  it('round-robin also counts a directed scout run that carries signal_id in its input (trigger on qualification)', async () => {
    const t = `${tenant}-trig`;
    const seeded = await seedProspector(handle.db, { tenantId: t });
    const fake = new FakeTwenty();
    const anuga = fairSignal(fake, t, 'Anuga Select Ibérica 2027 (feria)', 'QUALIFIED', '2027-01-20', ANUGA_URL);
    const bww = fairSignal(fake, t, 'Barcelona Wine Week 2027 (feria)', 'QUALIFIED', '2027-02-10', BWW_URL);
    // A run of another task (same agent) on Anuga, as the trigger on qualification records it.
    await handle.db.insert(agentExecutions).values({
      tenantId: t,
      agentId: seeded.agentId,
      status: 'COMPLETED',
      input: { mode: 'scout', event_url: ANUGA_URL, event_name: 'Anuga Select Ibérica 2027', max_events: 1, signal_id: anuga.id },
      startedAt: new Date(),
    });
    const web = new FakeWeb().page(BWW_URL, '<title>Barcelona Wine Week 2027</title><p>Expositores próximamente.</p>');
    const r = await dailyRun(t, processorFor(fake, web), [NO_LIST]);
    expect(r.output.signal_id).toBe(bww.id);
  });

  it('no QUALIFIED current fair -> COMPLETED with outcome SKIPPED, cost 0, no model call, past fairs still expired', async () => {
    const t = `${tenant}-skip`;
    await seedProspector(handle.db, { tenantId: t });
    const fake = new FakeTwenty();
    const past = fairSignal(fake, t, 'Fruit Attraction 2026 (feria)', 'NEW', '2026-10-01', 'https://www.ifema.es/fruit-attraction');
    fairSignal(fake, t, 'Feria Nueva 2027 (feria)', 'NEW', '2027-05-01', 'https://www.ferianueva.com/');
    const r = await dailyRun(t, processorFor(fake, new FakeWeb()), []);
    expect(r.run.status).toBe('COMPLETED');
    expect(r.output).toMatchObject({ outcome: 'SKIPPED', reason: '0 señales calificadas', cost: { model: 0 } });
    expect(r.output.signals.expired.map((e) => e.id)).toEqual([past.id]);
    expect(r.requests).toBe(0);
    expect(Number(r.run.cost ?? 0)).toBe(0);
    expect(fake.tables.agentRunSummaries).toHaveLength(0);
  });
});
