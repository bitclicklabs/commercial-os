/**
 * pnpm experiment:revalidate --id <EXP-NNN|uuid> [--tenant publiexpe] [--min-labels 5]
 *                            [--report <informe.json>] [--by "<quién>"] [--no-note] [--dry-run]
 * pnpm experiment:revalidate --pending [--tenant publiexpe] [--min-labels 5]
 *
 * Re-validation of a PASS_FORM experiment (src/experiments/revalidation.ts): measures the
 * accuracy of baseline and candidate on the per-case outputs the experiment stored, against
 * HUMAN labels that arrived later (harvested into a newer version of its dataset:
 * `POST /datasets/:id/build`). No model is called: cost 0.
 *
 * - Writes one row to `experiment_revalidations` (DATABASE_URL); the experiment is never touched.
 *   The same labels return the existing row.
 * - On a REFUTED of a version still ACTIVE or in canary: a note in Twenty (if TWENTY_API_KEY is
 *   set; `--no-note` to skip it) and the event `experiment.revalidation_failed` (the row is
 *   written to `events`; the scheduler's re-publisher delivers it if Redis is not reachable here).
 *   It never deactivates or rolls back anything.
 * - `--report`: for experiments older than `metrics.phases.*.case_outputs`, the informe.json of
 *   the experiment (by default the path recorded in `metrics.artifacts.json`).
 * - `--dry-run`: computes and prints; writes nothing.
 *
 * Exit code: 0 CONFIRMED, 3 REFUTED, 4 INSUFFICIENT, 2 invalid arguments or experiment, 1 error.
 */
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.js';
import { BullEventQueue, EventBus, eventsQueueName } from '../src/events/event-bus.js';
import { pendingRevalidations, revalidateExperiment, RevalidationError } from '../src/experiments/revalidation-service.js';
import { twentyClientFromEnv } from '../src/integrations/twenty/index.js';

const USAGE = 'uso: pnpm experiment:revalidate --id <EXP-NNN|uuid> [--tenant publiexpe] [--min-labels 5] [--report informe.json] [--by Q] [--no-note] [--dry-run] | --pending [--tenant publiexpe] [--min-labels 5]';

function fail(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const pct = (v: number | null) => (v === null ? '—' : v.toFixed(3));

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      id: { type: 'string' },
      pending: { type: 'boolean', default: false },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
      'min-labels': { type: 'string' },
      report: { type: 'string' },
      by: { type: 'string', default: 'experiment:revalidate' },
      'no-note': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.pending && !values.id) fail('falta --id (o --pending)');
  const minLabels = values['min-labels'] === undefined ? undefined : Number(values['min-labels']);
  if (minLabels !== undefined && (!Number.isInteger(minLabels) || minLabels < 1 || minLabels > 200)) fail('--min-labels debe ser un entero entre 1 y 200');
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) fail('falta DATABASE_URL (cópiala a runtime/agent-runtime/.env)');
  const handle = createDb(dbUrl);
  let bus: EventBus | null = null;
  try {
    if (values.pending) {
      const { items, ready } = await pendingRevalidations(handle.db, { tenantId: values.tenant!, minLabels });
      if (items.length === 0) console.log('No hay experimentos PASS_FORM con la versión ACTIVE o en canario.');
      for (const i of items) {
        console.log(
          `${i.experiment.name} · ${i.experiment.subject_type} ${i.experiment.subject_name} v${i.experiment.candidate_version} (${i.version_state.state}) · etiquetas utilizables ${i.labels.usable} (frescas ${i.labels.fresh}, mínimo ${i.labels.min_required}, excluidas ${i.labels.excluded}) · salidas ${i.outputs_source ?? 'no disponibles'} · ${i.ready ? 'LISTA para revalidar' : 'aún no'}${i.last_revalidation ? ` · última ${i.last_revalidation.verdict}` : ''}`,
        );
      }
      console.log(`Revalidaciones listas: ${ready}`);
      return;
    }

    const twenty = values['no-note'] ? null : twentyClientFromEnv();
    if (!values['dry-run']) {
      const queueName = eventsQueueName(process.env.QUEUE_NAME || 'pxos-agent-runs');
      bus = new EventBus(handle.db, new BullEventQueue(queueName, process.env.REDIS_URL || 'redis://127.0.0.1:6391'));
    }
    const { computation: c, revalidation, created } = await revalidateExperiment(
      { db: handle.db, twenty: twenty?.isConfigured() ? twenty : null, events: bus },
      { tenantId: values.tenant!, experiment: values.id!, minLabels, requestedBy: values.by!, source: 'cli', reportPath: values.report, dryRun: values['dry-run']!, note: !values['no-note'] },
    );
    const e = c.experiment;
    console.log(`${values['dry-run'] ? 'simulación (no escribe nada) · ' : ''}${e.name} · ${e.subjectType} ${e.subjectName} v${e.baselineVersion} (baseline) vs v${e.candidateVersion} · versión hoy: ${c.versionState.state}`);
    console.log(`Salidas por caso: ${c.outputs.count} (${c.outputs.source}${c.outputs.artifact ? `: ${c.outputs.artifact}` : ''}) · casos ejecutados ${c.executed} · etiquetas usadas ${c.selection.labels.length} (mínimo ${c.criteria.min_labels}) · excluidas ${c.selection.excluded.length} · sin etiqueta ${c.selection.unlabeled}`);
    for (const x of c.selection.excluded) console.log(`  - excluida ${x.exhibitor}: ${x.reason} (${x.detail})`);
    console.log(`Accuracy v${e.baselineVersion}: ${pct(c.accuracy.baseline.value)} (${c.accuracy.baseline.correct}/${c.accuracy.baseline.decisions}) · v${e.candidateVersion}: ${pct(c.accuracy.candidate.value)} (${c.accuracy.candidate.correct}/${c.accuracy.candidate.decisions})`);
    for (const w of c.warnings) console.log(`  aviso: ${w}`);
    console.log(c.verdict.summary);
    if (revalidation) {
      console.log(`Revalidación ${revalidation.id} ${created ? 'registrada' : 'ya existía con estas etiquetas'} · coste 0 €`);
      const cons = revalidation.consequence as { note?: Record<string, unknown>; event?: Record<string, unknown> };
      if (cons.note) console.log(`Nota en Twenty: ${JSON.stringify(cons.note)}`);
      if (cons.event) console.log(`Evento: ${JSON.stringify(cons.event)}`);
    }
    process.exitCode = c.verdict.verdict === 'CONFIRMED' ? 0 : c.verdict.verdict === 'REFUTED' ? 3 : 4;
  } catch (err) {
    if (err instanceof RevalidationError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = err.code === 'outputs_unavailable' ? 1 : 2;
      return;
    }
    throw err;
  } finally {
    await bus?.close().catch(() => undefined);
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
