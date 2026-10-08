/**
 * Evaluation datasets (LLD v0.1 section 11.4 and P5), pure part: content hash, entity key,
 * deterministic split and the contamination rule. No I/O, so the unit tests pin the rules.
 *
 * P5 in one sentence: a case that an experiment has used (for design, or to validate/test a
 * decision) can never be validation or test for another experiment. `used_by` is the ledger
 * of those uses; `vetoReason` reads it when a dataset is built and when a split is served.
 */
import { createHash } from 'node:crypto';
import type { CaseUse, CaseUseRole, HeldSplit } from '../db/schema.js';

/** 50 / 25 / 25 (TRAIN / VALIDATION / TEST), by hash of the entity: stable between runs. */
export const SPLIT_RATIOS: Readonly<Record<HeldSplit, number>> = { TRAIN: 0.5, VALIDATION: 0.25, TEST: 0.25 };

/** JSON with object keys sorted at every level and `undefined` dropped (stable hash input). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortDeep(v)));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `content_hash` of a case: sha256 of the canonical `{ input, expected }` (context and provenance do not count). */
export function caseContentHash(input: unknown, expected: unknown): string {
  return sha256Hex(canonicalJson({ input, expected }));
}

const LEGAL_SUFFIX = /(?:\s+(?:s\s?l\s?u|s\s?l\s?l|s\s?l|s\s?a\s?u|s\s?a|s\s?c\s?o\s?o\s?p|scoop|coop|cb|s\s?c))+$/;

/**
 * Folded company name: lower case, no diacritics, only a-z0-9 separated by single spaces,
 * without a trailing legal form (S.L., S.A., S.L.U.…). "STEEL-INOX S.L." and "Steel Inox"
 * are the same entity.
 */
export function foldEntityName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const stripped = base.replace(LEGAL_SUFFIX, '').trim();
  return stripped.length > 0 ? stripped : base;
}

/**
 * Key of the entity a case is about (the exhibitor company). The split is decided by this key,
 * not by the case, so the same company never lands in TRAIN and TEST at once (even with a
 * different fair, input data or verdict).
 */
export function entityKeyOf(name: string): string {
  return `org:${foldEntityName(name)}`;
}

/** Position in [0, 1) of a key, from sha256(`salt \0 key`): uniform and stable. */
export function splitBucket(salt: string, key: string): number {
  const hex = sha256Hex(`${salt}\u0000${key}`).slice(0, 13);
  return Number.parseInt(hex, 16) / 16 ** 13;
}

/** Split by hash only (the 50/25/25 rule, before exclusions). */
export function hashSplit(salt: string, key: string, ratios: Readonly<Record<HeldSplit, number>> = SPLIT_RATIOS): HeldSplit {
  const b = splitBucket(salt, key);
  if (b < ratios.TRAIN) return 'TRAIN';
  if (b < ratios.TRAIN + ratios.VALIDATION) return 'VALIDATION';
  return 'TEST';
}

export interface SplitDecision {
  split: HeldSplit;
  /** What the hash alone says (differs from `split` when the case is burned). */
  hashSplit: HeldSplit;
  /** True when an earlier use forced the case to TRAIN. */
  forcedTrain: boolean;
}

/**
 * Split of a case at build time. A case with any recorded use (design material, or a
 * validation/test already spent) can only be TRAIN: it is no longer data no one has looked at.
 */
export function assignSplit(salt: string, key: string, uses: readonly CaseUse[]): SplitDecision {
  const h = hashSplit(salt, key);
  if (uses.length > 0 && h !== 'TRAIN') return { split: 'TRAIN', hashSplit: h, forcedTrain: true };
  return { split: h, hashSplit: h, forcedTrain: false };
}

/**
 * Why a case cannot be used by `experiment` in `role` (null when it can).
 *
 * - `design` is always allowed (it burns the case for the future).
 * - `validation` / `test`: allowed only if every earlier use is this same experiment in this
 *   same role (re-running the same comparison). Any design use, any use by another experiment
 *   or a use in the other held-out role vetoes it. `experiment = null` means "a new
 *   experiment": any earlier use vetoes.
 */
export function vetoReason(uses: readonly CaseUse[], experiment: string | null, role: CaseUseRole): string | null {
  if (role === 'design') return null;
  for (const u of uses) {
    if (u.role === 'design') return `used as design by ${u.experiment}`;
    if (experiment === null || u.experiment !== experiment) return `already used as ${u.role} by ${u.experiment}`;
    if (u.role !== role) return `already used as ${u.role} by ${u.experiment} (a case cannot be ${u.role} and ${role})`;
  }
  return null;
}

/** True when the case has been consumed by any experiment (it is no longer clean held-out data). */
export function isBurned(uses: readonly CaseUse[]): boolean {
  return uses.length > 0;
}

/** Same (experiment, role) already recorded: marking again is a no-op. */
export function hasUse(uses: readonly CaseUse[], experiment: string, role: CaseUseRole): boolean {
  return uses.some((u) => u.experiment === experiment && u.role === role);
}

/**
 * Merges use lists keeping one entry per (experiment, role) (the first seen wins), in order.
 * Used to carry the uses of an older version forward and to union the uses of all the
 * occurrences of an entity.
 */
export function mergeUses(...lists: ReadonlyArray<readonly CaseUse[]>): CaseUse[] {
  const out: CaseUse[] = [];
  for (const list of lists) for (const u of list) if (!hasUse(out, u.experiment, u.role)) out.push(u);
  return out;
}

/** `EXP-001`, `EXP-002`, `exp-wt10-test`...: an experiment id in the ledger. */
export const EXPERIMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** Tag of a use (`exp-001:design`). */
export function useTag(u: Pick<CaseUse, 'experiment' | 'role'>): string {
  return `${u.experiment.toLowerCase()}:${u.role}`;
}
