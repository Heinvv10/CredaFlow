/**
 * Deterministic PRNG for persona generation.
 *
 * Each persona is seeded from its own key, not from a shared stream, so adding
 * or reordering personas never changes the ones already generated.
 */

/** FNV-1a 32-bit hash of a string, used to turn a key into a seed. */
function hashSeed(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T
  /** True with probability p. */
  chance(p: number): boolean
}

/** mulberry32, seeded from `key`. */
export function createRng(key: string): Rng {
  let state = hashSeed(key)
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('pick() from an empty list')
      return items[Math.floor(next() * items.length)] as T
    },
    chance: (p) => next() < p,
  }
}

/** Round cents to whole rands — payroll and debt figures look hand-set. */
export function roundRand(cents: number, toRands = 1): number {
  const step = toRands * 100
  return Math.round(cents / step) * step
}
