import { mulberry32 } from '../rng';

/**
 * Deterministic PRNG for the input generator. Wraps the shared mulberry32 core
 * (src/rng.ts, also used for pass-order shuffling in src/host/orchestrator.ts) with
 * the richer helper surface generation needs: int ranges, picking, sampling.
 */
export class Rng {
  private readonly source: () => number;
  constructor(seed: number) {
    this.source = mulberry32(seed);
  }

  /** [0, 1). */
  next(): number {
    return this.source();
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
