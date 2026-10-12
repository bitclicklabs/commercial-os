/**
 * Deterministic generator of synthetic Prospector cases: `seed -> cases`, byte for byte.
 *
 * - Every case is drawn from its own Rng keyed by (generator version, seed, template, index,
 *   attempt), so a case does not depend on the other templates or on the filters.
 * - Generation is index-major (index 0 of every template, then index 1...) over ALL templates,
 *   and the filters (curriculum level, template ids) apply afterwards: a filtered build is
 *   always a subset of the unfiltered one with the same seed, and raising `perTemplate` only
 *   adds cases.
 * - Exhibitor names are unique in a build (a collision redraws with the next attempt).
 * - Every domain and URL is under `.invalid` (asserted here, not only promised).
 * - The web content of the "exhibitor site" is embedded in the case (`description`): running a
 *   case never needs the network.
 */
import { caseContentHash } from '../datasets/core.js';
import { DIFFICULTY_BY_LEVEL, type PlannedCase } from '../datasets/plan.js';
import { dataLevel } from '../skills/compare.js';
import { rngFor } from './prng.js';
import { LEAD_TIME_TEMPLATES } from './lead-time-templates.js';
import { TEMPLATES, type SyntheticExhibitor, type SyntheticTemplate } from './templates.js';
import { CURRICULUM_LEVELS, type CurriculumLevel, type SyntheticExpected, type SyntheticTruth } from './truth.js';
import { FAIR_KINDS, PLACES, slug, SYNTHETIC_TLD } from './vocab.js';

export const GENERATOR_ID = 'pxos-synth';
/** Bump when the generator itself (not a template) changes how cases are drawn. */
export const GENERATOR_VERSION = 1;
/** Dataset domains the templates produce cases for (Prospector decisions only, today). */
export const SYNTHETIC_DOMAINS: readonly string[] = ['prospeccion'];
export const DEFAULT_PER_TEMPLATE = 2;
export const MAX_PER_TEMPLATE = 20;
/** Fictitious fairs per build: cases are grouped by event (one skill:compare fixture per event). */
const EVENTS_PER_BUILD = 3;

export interface SyntheticEvent {
  name: string;
  type: 'FAIR';
  date: string;
  location: string;
  source_url: string;
}

export interface GenerateOptions {
  seed: number;
  /** Cases per template (default 2, max 20). */
  perTemplate?: number;
  /** Keep only these curriculum levels (default all). */
  levels?: readonly CurriculumLevel[];
  /** Keep only these templates (default all the default ones; opt-in ids are accepted too). */
  templates?: readonly string[];
  /**
   * Tanda 18: add the opt-in lead-time templates (src/synthetic/lead-time-templates.ts) to the
   * build. Without it (and without naming them in `templates`) the build is exactly the default one.
   */
  leadTime?: boolean;
}

/** Templates a build draws from: the default ones, then the opt-in ones requested (appended, so the default draws never change). */
export function templatePool(opts: Pick<GenerateOptions, 'templates' | 'leadTime'> = {}): SyntheticTemplate[] {
  const named = new Set(opts.templates ?? []);
  const optIn = LEAD_TIME_TEMPLATES.filter((t) => opts.leadTime || named.has(t.id));
  return [...TEMPLATES, ...optIn];
}

export interface GeneratedCase extends PlannedCase {
  kind: 'synthetic';
  split: 'SYNTH';
  curriculumLevel: CurriculumLevel;
  expected: Record<string, unknown> & SyntheticExpected;
}

export interface GenerationSummary {
  seed: number;
  generator: string;
  generator_version: number;
  per_template: number;
  levels: CurriculumLevel[];
  templates: string[];
  total: number;
  by_template: Record<string, number>;
  by_curriculum_level: Record<string, number>;
  events: SyntheticEvent[];
}

export class SyntheticGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticGenerationError';
  }
}

const RESERVED_HOST = new RegExp(`(^|\\.)[a-z0-9-]+\\.${SYNTHETIC_TLD}$`);

/** True for a host (or URL) under the reserved `.invalid` TLD. */
export function isReservedSyntheticHost(hostOrUrl: string): boolean {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (host.includes('://')) host = new URL(host).hostname;
  } catch {
    return false;
  }
  return RESERVED_HOST.test(host);
}

export function validateSeed(seed: unknown): number {
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) throw new SyntheticGenerationError('seed debe ser un entero ≥ 0');
  return seed;
}

/** The fictitious fairs of a build (depend only on the seed). */
export function syntheticEvents(seed: number): SyntheticEvent[] {
  const out: SyntheticEvent[] = [];
  for (let i = 0; i < EVENTS_PER_BUILD; i++) {
    const rng = rngFor(`${GENERATOR_ID}|v${GENERATOR_VERSION}|seed=${seed}|event|${i}`);
    const kind = FAIR_KINDS[i % FAIR_KINDS.length]!;
    const place = rng.pick(PLACES);
    const month = rng.int(1, 12);
    const day = rng.int(1, 28);
    const name = `${kind.name} de ${place} 2027`;
    out.push({
      name,
      type: 'FAIR',
      date: `2027-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      location: `${place} (recinto ferial)`,
      source_url: `https://${slug(`${kind.name}-${place}`)}.${SYNTHETIC_TLD}/expositores`,
    });
  }
  return out;
}

function assertReserved(ex: SyntheticExhibitor, event: SyntheticEvent, template: string): void {
  if (ex.domain !== undefined && !isReservedSyntheticHost(ex.domain)) throw new SyntheticGenerationError(`${template}: dominio no reservado ${ex.domain}`);
  if (!isReservedSyntheticHost(event.source_url)) throw new SyntheticGenerationError(`${template}: URL de evento no reservada ${event.source_url}`);
  // A URL or host inside free text must be reserved too (the generator writes none today).
  for (const text of [ex.description ?? '', ex.sector ?? '', ex.name]) {
    for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi)) {
      if (/^\d/.test(m[0]) || /^[A-Z]\.[A-Z]/.test(m[0]) || /^s\.(a|l)/i.test(m[0])) continue; // "S.L.", "S.A.U." are legal forms, not hosts
      if (!isReservedSyntheticHost(m[0])) throw new SyntheticGenerationError(`${template}: texto con un dominio no reservado (${m[0]})`);
    }
  }
}

function makeCase(t: SyntheticTemplate, seed: number, index: number, exhibitor: SyntheticExhibitor, event: SyntheticEvent, checks: SyntheticTruth['checks'], attempt: number, asOf?: string): GeneratedCase {
  const truth: SyntheticTruth = {
    template: t.id,
    template_version: t.version,
    curriculum_level: t.curriculum_level,
    patterns: [...t.patterns],
    decision: t.decision,
    checks,
    rationale: t.rationale,
    ...(asOf ? { as_of: asOf } : {}),
  };
  const expected: SyntheticExpected = { kind: 'synthetic', ground_truth: truth };
  const input = { event: { ...event }, exhibitor: { ...exhibitor } };
  const level = dataLevel(exhibitor);
  return {
    entityKey: `synth:${slug(exhibitor.name)}`,
    kind: 'synthetic',
    split: 'SYNTH',
    hashSplit: 'SYNTH',
    forcedTrain: false,
    input,
    context: { data_level: level, generator: GENERATOR_ID, template: t.id },
    expected: expected as GeneratedCase['expected'],
    source: {
      origin: 'synthetic',
      expected_source: 'synthetic',
      generator: GENERATOR_ID,
      generator_version: GENERATOR_VERSION,
      seed,
      template: t.id,
      template_version: t.version,
      index,
      ...(attempt > 0 ? { attempt } : {}),
    },
    // `difficulty` keeps its meaning for every case: the level of the input data.
    difficulty: DIFFICULTY_BY_LEVEL[level],
    curriculumLevel: t.curriculum_level,
    tags: [
      'kind:synthetic',
      `template:${t.id}`,
      `curriculum:${t.curriculum_level}`,
      `data:${level}`,
      `decision:${t.decision}`,
      ...t.patterns.map((p) => `pattern:${p.toLowerCase()}`),
    ].sort(),
    contentHash: caseContentHash(input, expected),
    usedBy: [],
  };
}

/** All the synthetic cases of `seed`, filtered. Pure and deterministic. */
export function generateSyntheticCases(opts: GenerateOptions): { cases: GeneratedCase[]; summary: GenerationSummary } {
  const seed = validateSeed(opts.seed);
  const perTemplate = opts.perTemplate ?? DEFAULT_PER_TEMPLATE;
  if (!Number.isInteger(perTemplate) || perTemplate < 1 || perTemplate > MAX_PER_TEMPLATE) throw new SyntheticGenerationError(`perTemplate debe estar entre 1 y ${MAX_PER_TEMPLATE}`);
  const levels = [...new Set(opts.levels ?? CURRICULUM_LEVELS)].sort();
  for (const l of levels) if (!CURRICULUM_LEVELS.includes(l)) throw new SyntheticGenerationError(`nivel de curriculum no válido: ${String(l)} (1, 2 o 3)`);
  const known = [...TEMPLATES, ...LEAD_TIME_TEMPLATES];
  const unknown = (opts.templates ?? []).filter((id) => !known.some((t) => t.id === id));
  if (unknown.length) throw new SyntheticGenerationError(`plantillas desconocidas: ${unknown.join(', ')} (hay: ${known.map((t) => t.id).join(', ')})`);
  const pool = templatePool(opts);
  const events = syntheticEvents(seed);

  const all: GeneratedCase[] = [];
  const names = new Set<string>();
  for (let index = 0; index < perTemplate; index++) {
    for (const t of pool) {
      let made: GeneratedCase | null = null;
      for (let attempt = 0; attempt < 50 && !made; attempt++) {
        const rng = rngFor(`${GENERATOR_ID}|v${GENERATOR_VERSION}|seed=${seed}|${t.id}@${t.version}|${index}|${attempt}`);
        const shared = events[rng.int(0, events.length - 1)]!;
        const { exhibitor, checks, event: own, asOf } = t.build(rng);
        const event = own ?? shared;
        const key = slug(exhibitor.name);
        if (names.has(key)) continue;
        assertReserved(exhibitor, event, t.id);
        names.add(key);
        made = makeCase(t, seed, index, exhibitor, event, checks, attempt, asOf);
      }
      if (!made) throw new SyntheticGenerationError(`${t.id}: no hay nombres libres tras 50 intentos`);
      all.push(made);
    }
  }
  const wanted = new Set(opts.templates?.length ? opts.templates : pool.map((t) => t.id));
  const cases = all.filter((c) => levels.includes(c.curriculumLevel) && wanted.has(c.expected.ground_truth.template));
  const count = (key: (c: GeneratedCase) => string) => cases.reduce<Record<string, number>>((acc, c) => ((acc[key(c)] = (acc[key(c)] ?? 0) + 1), acc), {});
  return {
    cases,
    summary: {
      seed,
      generator: GENERATOR_ID,
      generator_version: GENERATOR_VERSION,
      per_template: perTemplate,
      levels,
      templates: [...wanted],
      total: cases.length,
      by_template: count((c) => c.expected.ground_truth.template),
      by_curriculum_level: count((c) => String(c.curriculumLevel)),
      // The build's shared fairs, plus the own fair of each lead-time case kept (opt-in templates).
      events: [...events, ...cases.map((c) => c.input.event as SyntheticEvent).filter((e) => !events.some((x) => x.source_url === e.source_url))],
    },
  };
}
