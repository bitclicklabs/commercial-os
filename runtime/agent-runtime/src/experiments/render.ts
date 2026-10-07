/**
 * Report of an automatic experiment (Spanish markdown + JSON), the automatic version of the
 * EXP-001/EXP-002 documents: decision first, then data (P5), metrics and the annexes with the
 * full comparison and evaluation.
 */
import { renderEvaluationMarkdown, type PipelineReport } from '../evaluators/pipeline.js';
import { renderComparisonMarkdown } from '../skills/compare.js';
import type { GateCriterion, GateResult } from './gate.js';
import type { VersionPhaseMetrics } from './metrics.js';
import type { ExperimentReport, PhaseReport } from './runner.js';

const num = (n: number | null | undefined, d = 3) => (n === null || n === undefined ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }));
const eur = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toLocaleString('es-ES', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} €`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const STATUS: Record<GateCriterion['status'], string> = { pass: '✅ cumple', fail: '❌ no cumple', skipped: '— no aplica' };

/** JSON-friendly pipeline report (Maps -> arrays), as `pnpm evaluate --out` writes it. */
export function pipelineToJson(r: PipelineReport): unknown {
  return {
    ...r,
    subjects: r.subjects.map((s) => ({
      subject: { ...s.subject, cases: s.subject.cases.map((c) => ({ id: c.id, dataLevel: c.input.dataLevel })) },
      composite: s.composite,
      evaluators: s.evaluators.map((e) => ({ ...e, cases: [...e.cases].map(([id, c]) => ({ case: id, ...c })) })),
    })),
  };
}

export function reportToJson(r: ExperimentReport): unknown {
  return { ...r, phases: r.phases.map((p) => ({ ...p, pipeline: pipelineToJson(p.pipeline) })) };
}

function criterionValue(c: GateCriterion, which: 'baseline' | 'candidate' | 'threshold'): string {
  const v = c[which];
  if (v === null) return '—';
  if (c.id === 'cost_per_decision') return eur(v);
  if (c.id === 'hard_failures' || c.id === 'seesaw') return String(v);
  return num(v);
}

function gateTable(g: GateResult): string[] {
  const L = ['| Criterio | Baseline | Candidata | Umbral | Resultado | Detalle |', '|---|---|---|---|---|---|'];
  for (const c of g.criteria) {
    L.push(`| ${c.label} | ${criterionValue(c, 'baseline')} | ${criterionValue(c, 'candidate')} | ${criterionValue(c, 'threshold')} | ${STATUS[c.status]} | ${cell(c.detail)} |`);
  }
  return L;
}

function versionTable(vs: VersionPhaseMetrics[]): string[] {
  const [a, b] = vs;
  if (!a || !b) return [];
  const row = (label: string, x: string, y: string) => `| ${label} | ${x} | ${y} |`;
  const L = [`| Métrica | v${a.version} (baseline) | v${b.version} (candidata) |`, '|---|---|---|'];
  L.push(row('**Composite** (veredicto del composite)', `**${num(a.composite)}** (${a.composite_verdict ?? '—'})`, `**${num(b.composite)}** (${b.composite_verdict ?? '—'})`));
  const dims = [...new Set([...Object.keys(a.dimensions), ...Object.keys(b.dimensions)])];
  for (const d of dims) L.push(row(`${d}`, num(a.dimensions[d]), num(b.dimensions[d])));
  if (a.missing_dimensions.length || b.missing_dimensions.length) L.push(row('Sin evaluar (peso redistribuido)', a.missing_dimensions.join(', ') || '—', b.missing_dimensions.join(', ') || '—'));
  const keys = [...new Set([...a.rules, ...a.judges, ...b.rules, ...b.judges].map((r) => r.key))];
  for (const k of keys) {
    const x = [...a.rules, ...a.judges].find((r) => r.key === k);
    const y = [...b.rules, ...b.judges].find((r) => r.key === k);
    const f = (r: typeof x) => (!r ? '—' : r.applicable === 0 ? 'no aplica' : `${num(r.score)} · ${r.failures}/${r.applicable} fallos`);
    L.push(row(`\`${k}\`${x?.hard ? ' (dura)' : ''}`, f(x), f(y)));
  }
  L.push(row('Decisiones (errores)', `${a.decisions} (${a.errors})`, `${b.decisions} (${b.errors})`));
  L.push(row('Relevantes / escribibles', `${a.relevant} / ${a.writable}`, `${b.relevant} / ${b.writable}`));
  L.push(row('Confianza media', num(a.confidence_mean, 2), num(b.confidence_mean, 2)));
  L.push(row('No relevantes con confianza > 0,19', `${a.irrelevant_high_confidence}`, `${b.irrelevant_high_confidence}`));
  L.push(row('Accuracy (casos etiquetados)', a.accuracy.value === null ? `— (${a.accuracy.labeled_cases} etiquetados)` : `${num(a.accuracy.value)} (${a.accuracy.correct}/${a.accuracy.decisions})`, b.accuracy.value === null ? `— (${b.accuracy.labeled_cases} etiquetados)` : `${num(b.accuracy.value)} (${b.accuracy.correct}/${b.accuracy.decisions})`));
  L.push(row('Tokens entrada / salida', `${a.input_tokens} / ${a.output_tokens}`, `${b.input_tokens} / ${b.output_tokens}`));
  L.push(row('Coste ejecutor (por decisión)', `${eur(a.cost_eur)} (${eur(a.cost_eur_per_decision)})`, `${eur(b.cost_eur)} (${eur(b.cost_eur_per_decision)})`));
  return L;
}

function phaseSection(p: PhaseReport): string[] {
  const L: string[] = [];
  const own = p.cases.filter((c) => c.use !== 'form_sample');
  const form = p.cases.filter((c) => c.use === 'form_sample');
  L.push(`## Fase ${p.phase}`, '');
  L.push(`Casos: ${own.length} del split ${p.phase} (${own.filter((c) => c.labeled).length} etiquetados)${form.length ? ` + ${form.length} de muestra de forma (TRAIN sin quemar, sin efecto en la accuracy)` : ''}. Coste: ejecutor ${eur(p.executor_cost_eur)}, juez ${eur(p.judge_cost_eur)}.`, '');
  L.push(`### Release Gate (${p.gate.mode === 'form' ? 'modo forma' : 'con etiquetas'}): **${p.gate.decision}**`, '');
  L.push(p.gate.summary, '');
  L.push(...gateTable(p.gate), '');
  if (p.gate.seesaw_regressions.length) {
    L.push('Regresiones (seesaw):', '');
    for (const r of p.gate.seesaw_regressions) L.push(`- \`${r.rule}\` (${r.dimension}): ${num(r.baseline)} → ${r.candidate === null ? 'no aplica en la candidata' : num(r.candidate)}${r.failed_cases.length ? ` · casos: ${r.failed_cases.map((c) => cell(c)).join('; ')}` : ''}`);
    L.push('');
  }
  if (p.gate.incomplete.length) L.push(`Medición incompleta: ${p.gate.incomplete.join('; ')}.`, '');
  L.push('### Métricas por versión', '');
  L.push(...versionTable(p.versions), '');
  const acc = p.versions.flatMap((v) => v.accuracy.mismatches.map((m) => ({ v: v.version, m })));
  if (acc.length) {
    L.push('Decisiones que no coinciden con la etiqueta:', '');
    for (const { v, m } of acc) L.push(`- v${v} · ${cell(m.exhibitor)} (r${m.repetition}): esperado ${JSON.stringify(m.expected)}, obtenido ${JSON.stringify(m.got)}`);
    L.push('');
  }
  L.push('### Casos usados (P5)', '');
  L.push('| Expositor | Split | Uso | Etiqueta | Datos | Caso |', '|---|---|---|---|---|---|');
  for (const c of p.cases) L.push(`| ${cell(c.exhibitor)} | ${c.split} | ${c.use} | ${c.kind} | ${c.difficulty ?? '—'} | \`${c.id.slice(0, 8)}\` |`);
  L.push('');
  for (const m of p.mark_used) L.push(`- \`markUsed\` ${m.role}: ${m.marked} marcados, ${m.already} ya estaban, ${m.newly_burned} quemados ahora (${cell(m.note)}).`);
  if (p.skipped_cases.length) L.push(`- ${p.skipped_cases.length} caso(s) sin entrada utilizable (sin evento o expositor): no se ejecutaron.`);
  if (p.evaluations) L.push(`- Evaluaciones guardadas en el tenant \`${p.evaluations.tenant}\`: ${p.evaluations.inserted} nuevas, ${p.evaluations.existing} ya existían.`);
  L.push('');
  return L;
}

export function renderExperimentMarkdown(r: ExperimentReport): string {
  const e = r.experiment;
  const cfg = r.config as {
    baseline: { version: number; version_id: string; content_hash: string };
    candidate: { version: number; version_id: string; content_hash: string; status: string };
    dataset: { id: string; name: string; version: number; status: string };
    repeat: number;
    today: string;
    executor: { model: string };
    judge: { model: string | null } | null;
    budget_eur: number;
    executor_budget_eur: number;
    judge_budget_eur: number;
  };
  const isHarness = e.subjectType === 'harness';
  const fixed = (r.config as { fixed_skill?: { name: string; version: number; version_id: string } }).fixed_skill;
  const route = isHarness ? 'harnesses' : 'skills';
  const L: string[] = [];
  L.push(`# ${e.name} · ${isHarness ? 'harness ' : ''}${e.subjectName} v${e.baselineVersion} vs v${e.candidateVersion} (experimento automático)`, '');
  L.push(`Generado por \`pnpm experiment:run\` (runner v${String((r.config as { runner_version?: unknown }).runner_version ?? 1)}). Lo que EXP-001 y EXP-002 hicieron a mano, en una ejecución: reserva de casos con P5, comparación con el proveedor real, evaluación automática y Release Gate (LLD v0.1 §11.5-11.6).`, '');
  L.push('| Campo | Valor |', '|---|---|');
  L.push(`| Fecha | ${r.started_at.slice(0, 10)} (el agente ve ${cfg.today}) |`);
  L.push(`| Sujeto | ${isHarness ? 'harness' : 'skill'} \`${e.subjectName}\` |`);
  if (isHarness && fixed) L.push(`| Skill (fija en las dos ramas) | \`${fixed.name}\` v${fixed.version} \`ACTIVE\` · \`${fixed.version_id}\` |`);
  L.push(`| Baseline | v${cfg.baseline.version} \`ACTIVE\` · \`${cfg.baseline.version_id}\` · \`content_hash\` \`${cfg.baseline.content_hash.slice(0, 12)}…\` |`);
  L.push(`| Candidata | v${cfg.candidate.version} \`${cfg.candidate.status}\` · \`${cfg.candidate.version_id}\` · \`content_hash\` \`${cfg.candidate.content_hash.slice(0, 12)}…\` |`);
  L.push(`| Dataset | \`${cfg.dataset.name}\` v${cfg.dataset.version} (${cfg.dataset.status}) · \`${cfg.dataset.id}\` |`);
  L.push(`| Ejecución | ${cfg.executor.model}, ${cfg.repeat} repetición(es) por versión, FakeTwenty (0 escrituras en Twenty) |`);
  L.push(`| Juez | ${cfg.judge?.model ?? 'sin juez'} |`);
  L.push(`| Coste | ${eur(r.cost.total_eur)} de ${eur(cfg.budget_eur)} (ejecutor ${eur(r.cost.executor_eur)} de ${eur(cfg.executor_budget_eur)}; juez ${eur(r.cost.judge_eur)} de ${eur(cfg.judge_budget_eur)}) |`);
  L.push(`| Fases | ${r.phases.map((p) => `${p.phase} ${p.gate.decision}`).join(' · ')}${r.test_skipped ? ` · TEST no ejecutado` : ''} |`);
  L.push(`| **Decisión** | **${r.decision}** (${r.mode === 'form' ? 'modo forma' : 'con etiquetas'}) |`);
  L.push('');
  L.push(`**${r.summary}**`, '');
  if (r.decision === 'PASS_FORM') {
    L.push(
      `> **Importante — PASS_FORM:** el split no tenía casos etiquetados, así que el gate solo ha podido comprobar la forma de las decisiones (reglas, juez, coste, ausencia de regresiones), no si aciertan. PASS_FORM basta para que \`POST /${route}/:id/versions/:v/activate\` acepte la versión sin \`force\`, pero el experimento queda registrado como pendiente de re-validar: cuando el dataset tenga veredictos del comercial en VALIDATION/TEST, repite el experimento contra la versión activa.`,
      '',
    );
  }
  if (r.test_skipped) L.push(`TEST: ${r.test_skipped}.`, '');
  L.push('La activación es una decisión humana (LLD §19): este experimento no activa nada.', '');
  L.push('```sh');
  L.push(`# Si decides activar (el gate la deja pasar solo con PASS o PASS_FORM frente a la versión activa):`);
  L.push(`curl -s -X POST "http://127.0.0.1:4020/${route}/${e.subjectName}/versions/${e.candidateVersion}/activate" -H 'x-tenant-id: ${e.tenantId}'`);
  L.push('```', '');
  for (const p of r.phases) L.push(...phaseSection(p));
  L.push('## Anexo A · Comparación lado a lado (skill:compare)', '');
  for (const p of r.phases) {
    p.reports.forEach((rep, i) => {
      L.push(`Fase ${p.phase} · fixture \`${p.fixtures[i]?.name ?? i}\``, '');
      L.push(renderComparisonMarkdown(rep).replace(/^### /gm, '#### '), '');
    });
  }
  L.push('## Anexo B · Evaluación automática', '');
  for (const p of r.phases) L.push(renderEvaluationMarkdown(p.pipeline, `Evaluación · ${e.name} · ${p.phase}`).replace(/^### /gm, '#### ').replace(/^#### (Por|Notas|Llamadas)/gm, '##### $1'), '');
  return `${L.join('\n')}\n`;
}
