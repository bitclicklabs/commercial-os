/**
 * Seeded pseudo-random numbers for the synthetic generator: sfc32 seeded from sha256 of a
 * key. No `Math.random`, no clock: the same key always gives the same sequence, on every
 * machine and Node version, so `seed -> cases` is reproducible byte for byte.
 */
import { createHash } from 'node:crypto';

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max] (both included). */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** 8 upper-case hex characters (canary tokens, codes). */
  hex(): string;
}

/** sfc32 (Small Fast Counter, 32 bit): tiny, well distributed, fully deterministic. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** A generator for `key` (e.g. `v1|seed=7|explicit_merch_need|3|0`). */
export function rngFor(key: string): Rng {
  const h = createHash('sha256').update(key, 'utf8').digest();
  const next = sfc32(h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12));
  // Warm-up: the first outputs of sfc32 are correlated with the seed words.
  for (let i = 0; i < 12; i++) next();
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error('pick: lista vacía');
      return items[Math.floor(next() * items.length)]!;
    },
    chance: (p) => next() < p,
    hex: () => Math.floor(next() * 0x1_0000_0000).toString(16).toUpperCase().padStart(8, '0'),
  };
  return rng;
}
