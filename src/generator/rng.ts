/**
 * Deterministic PRNG for the input generator. Same shape as the mulberry32 used for
 * pass-order shuffling in src/host/orchestrator.ts, but kept as its own copy: the
 * two callers have nothing to do with each other, and generation needs a richer
 * helper surface (int ranges, picking, sampling) that shuffling doesn't.
 */
export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  /** [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** Up to `n` distinct items from `items`, order preserved, for `n >= items.length` all of them. */
  sample<T>(items: readonly T[], n: number): T[] {
    if (n >= items.length) return items.slice();
    const idx = new Set<number>();
    while (idx.size < n) idx.add(this.int(0, items.length - 1));
    return [...idx].sort((a, b) => a - b).map((i) => items[i]);
  }
}
