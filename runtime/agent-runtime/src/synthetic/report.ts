/**
 * Breakdown of an experiment phase over its synthetic cases (pure): per curriculum level and
 * per template, how many decisions of each version satisfy their ground truth. It is shown in
 * the experiment report; the gate reads the same truth through the `synth.*` evaluators.
 */
import { runChecks, truthHolds, type CheckResult, type SyntheticTruth } from './truth.js';

interface RunLike {
  version: number;
  repetition: number;
  decisions: Array<{ exhibitor: string; relevant: boolean | null; confidence: number | null; writable: boolean; reason: string | null; hypothesis?: SyntheticDecisionHypothesis | null }>;
}
type SyntheticDecisionHypothesis = {
  need: string;
  why_now: string;
  quantity_min: number;
  quantity_max: number;
  budget_min_eur: number;
  budget_max_eur: number;
  recommended_products: string[];
};

export interface VersionTally {
  version: number;
  decisions: number;
  /** Every applicable check passed. */
  held: number;
  /** Some applicable check failed. */
  failed: number;
  /** Model error or no applicable check. */
  errors: number;
  /** held / (held + failed); null without scored decisions. */
  rate: number | null;
}

export interface BreakdownRow {
  key: string;
  curriculum_level: number;
  cases: number;
  versions: VersionTally[];
}

export interface SyntheticBreakdown {
  cases: number;
  by_level: BreakdownRow[];
  by_template: BreakdownRow[];
  /** First failing decisions (max 60), for the report. */
  failures: Array<{ version: number; repetition: number; template: string; exhibitor: string; checks: CheckResult[] }>;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export function syntheticBreakdown(
  fixtures: ReadonlyArray<{ case_ids: readonly string[] }>,
  reports: ReadonlyArray<{ runs: readonly RunLike[] }>,
  truths: ReadonlyMap<string, SyntheticTruth>,
  versions: readonly number[],
): SyntheticBreakdown | null {
  if (truths.size === 0) return null;
  const tallies = new Map<string, Map<number, VersionTally>>();
  const meta = new Map<string, { level: number; cases: Set<string> }>();
  const failures: SyntheticBreakdown['failures'] = [];
  const bump = (key: string, level: number, caseId: string, version: number, outcome: boolean | null) => {
    const m = meta.get(key) ?? { level, cases: new Set<string>() };
    m.cases.add(caseId);
    meta.set(key, m);
    const byV = tallies.get(key) ?? new Map<number, VersionTally>();
    const t = byV.get(version) ?? { version, decisions: 0, held: 0, failed: 0, errors: 0, rate: null };
    t.decisions++;
    if (outcome === true) t.held++;
    else if (outcome === false) t.failed++;
    else t.errors++;
    byV.set(version, t);
    tallies.set(key, byV);
  };
  reports.forEach((report, fi) => {
    const fixture = fixtures[fi];
    if (!fixture) return;
    for (const run of report.runs) {
      run.decisions.forEach((d, i) => {
        const caseId = fixture.case_ids[i];
        const truth = caseId ? truths.get(caseId) : undefined;
        if (!caseId || !truth) return;
        const results = runChecks(truth, d);
        const holds = truthHolds(results);
        bump(`level:${truth.curriculum_level}`, truth.curriculum_level, caseId, run.version, holds);
        bump(`template:${truth.template}`, truth.curriculum_level, caseId, run.version, holds);
        if (holds === false && failures.length < 60) failures.push({ version: run.version, repetition: run.repetition, template: truth.template, exhibitor: d.exhibitor, checks: results.filter((r) => r.status === 'fail') });
      });
    }
  });
  const rows = (prefix: string): BreakdownRow[] =>
    [...meta.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, m]) => ({
        key: k.slice(prefix.length),
        curriculum_level: m.level,
        cases: m.cases.size,
        versions: versions.map((v) => {
          const t = tallies.get(k)?.get(v) ?? { version: v, decisions: 0, held: 0, failed: 0, errors: 0, rate: null };
          return { ...t, rate: t.held + t.failed > 0 ? round(t.held / (t.held + t.failed)) : null };
        }),
      }))
      .sort((a, b) => a.curriculum_level - b.curriculum_level || a.key.localeCompare(b.key));
  return { cases: new Set([...truths.keys()]).size, by_level: rows('level:'), by_template: rows('template:'), failures };
}
