/**
 * Seeded RNG (mulberry32). Deterministic given a seed, which keeps the
 * engine unit-testable and lets a whole life be replayed.
 */
export type Rng = () => number;

export interface StatefulRng extends Rng {
  getState(): number;
  setState(state: number): void;
}

export function makeRng(seed: number): StatefulRng {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => a >>> 0;
  rng.setState = (state: number) => {
    if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) {
      throw new Error("Invalid RNG state");
    }
    a = state >>> 0;
  };
  return rng;
}

/** Pick an index into `weights` (non-negative, at least one > 0). */
export function weightedPick(rng: Rng, weights: number[]): number {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) return -1;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= Math.max(0, weights[i]);
    if (roll < 0) return i;
  }
  return weights.length - 1;
}


/**
 * Deterministic 32-bit string hash (xmur3). Stable across runs, machines and
 * JS engines — unlike `String.hashCode`-style helpers, whose quality varies.
 */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministic unit float in [0, 1) derived from a seed plus arbitrary key
 * parts — a second, independent entropy stream. Use this for background world
 * drift so it never advances the simulation RNG and therefore never changes
 * the sequence of events. (Ported from EraLife's temporal-slice
 * `_seeded_unit_noise`.)
 */
export function seededNoise(seed: number, ...parts: (string | number)[]): number {
  return makeRng(hashString(`${seed}|${parts.join("|")}`))();
}
