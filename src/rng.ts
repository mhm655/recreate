/**
 * The one deterministic PRNG core for this codebase. Two callers need it for
 * unrelated reasons -- src/host/orchestrator.ts to reproduce a pass's shuffled test
 * order from its recorded seed, src/generator/rng.ts's `Rng` class to drive input
 * generation -- but the underlying generator has to be the same function in both
 * places, or a fix to one (e.g. a discovered bias) silently doesn't apply to the
 * other.
 */

/** Returns a function that yields a deterministic sequence of numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
