/**
 * Cases -> inputs of `pnpm skill:compare` (src/skills/compare.ts takes the direct-mode
 * Prospector input `{ event, exhibitors[] }`, at most 50 exhibitors). Cases are grouped by
 * event (same canonical event object) in the order given, and chunked by 50.
 */
import { canonicalJson } from './core.js';

export const COMPARE_MAX_EXHIBITORS = 50;

export interface CompareFixture {
  event: Record<string, unknown>;
  exhibitors: Array<Record<string, unknown>>;
  /** Ids of the cases in this fixture, same order as `exhibitors` (to `markUsed` them after the run). */
  case_ids: string[];
}

export function toCompareInputs(cases: ReadonlyArray<{ id: string; input: Record<string, unknown> }>): { fixtures: CompareFixture[]; skipped: string[] } {
  const groups = new Map<string, CompareFixture[]>();
  const skipped: string[] = [];
  for (const c of cases) {
    const event = c.input.event as Record<string, unknown> | null | undefined;
    const exhibitor = c.input.exhibitor as Record<string, unknown> | null | undefined;
    if (!event || !exhibitor || typeof exhibitor.name !== 'string') {
      skipped.push(c.id);
      continue;
    }
    const key = canonicalJson(event);
    const list = groups.get(key) ?? [];
    let last = list[list.length - 1];
    if (!last || last.exhibitors.length >= COMPARE_MAX_EXHIBITORS) {
      last = { event, exhibitors: [], case_ids: [] };
      list.push(last);
      groups.set(key, list);
    }
    last.exhibitors.push(exhibitor);
    last.case_ids.push(c.id);
  }
  return { fixtures: [...groups.values()].flat(), skipped };
}
