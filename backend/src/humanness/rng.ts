/**
 * Deterministic RNG seeded by conversation id (+ turn index). We want
 * humanness effects (typos, casing, delays) to feel *consistent* per
 * conversation — the same fan shouldn't see her style flip between bubbles —
 * so we seed from a stable key.
 *
 * mulberry32 was picked because it's ~3 lines, well-distributed, and doesn't
 * need crypto.
 */

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max] inclusive */
  int(min: number, max: number): number;
  /** true with probability p in [0, 1] */
  chance(p: number): boolean;
  /** pick one element from a non-empty array */
  pick<T>(arr: readonly T[]): T;
  /** approx N(mean, std) via Box-Muller */
  gaussian(mean: number, std: number): number;
}

export function seededRng(seedInput: string): Rng {
  let state = fnv1a32(seedInput) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    chance(p) {
      return next() < p;
    },
    pick(arr) {
      if (arr.length === 0) throw new Error("pick from empty array");
      return arr[Math.floor(next() * arr.length)]!;
    },
    gaussian(mean, std) {
      // Box-Muller
      const u = Math.max(next(), 1e-9);
      const v = next();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + z * std;
    },
  };
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
