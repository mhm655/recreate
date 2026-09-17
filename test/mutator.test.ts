import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateMutants } from '../src/mutator/mutate';
import { runMutationTests } from '../src/mutator/mutation-test';
import { LocalRunner } from '../src/host/runner';
import type { TestCase } from '../src/host/orchestrator';

describe('generateMutants', () => {
  it('produces one mutant per relational/arithmetic/boolean/numeric-literal site', () => {
    const source = 'export function f(a: number, b: number): boolean { return a < b && !false; }';
    const mutants = generateMutants(source);
    assert.ok(mutants.length >= 3, JSON.stringify(mutants.map((m) => m.description)));
    assert.ok(mutants.some((m) => m.description.includes("'<' -> '<='")));
    assert.ok(mutants.some((m) => m.description.includes("'&&' -> '||'")));
    assert.ok(mutants.some((m) => m.description.includes('removed logical negation')));
    // Every mutant differs from the original.
    for (const m of mutants) assert.notEqual(m.mutatedSource, source);
  });

  it('does not mutate literals used in type positions', () => {
    const source = 'export function f(x: true | false, n: 1 | 2): number { return n; }';
    const mutants = generateMutants(source);
    // Only real risk here would be mistaking the literal TYPES for value literals.
    for (const m of mutants) {
      assert.ok(!m.mutatedSource.includes('true | true'), m.description);
      assert.ok(!m.mutatedSource.includes('false | false'), m.description);
    }
  });

  it('respects maxMutants and is deterministic for a fixed seed', () => {
    const source = 'export function f(a: number): number { return a + 1 - 2 * 3 / 4 % 5; }';
    const a = generateMutants(source, { maxMutants: 2, seed: 7 });
    const b = generateMutants(source, { maxMutants: 2, seed: 7 });
    assert.equal(a.length, 2);
    assert.deepEqual(a, b);
  });

  it('returns no mutants for a source with nothing mutable', () => {
    const mutants = generateMutants('export function f(s: string): string { return s; }');
    assert.deepEqual(mutants, []);
  });
});

describe('runMutationTests', () => {
  const runner = new LocalRunner();
  const LIMITS = { perTestTimeoutMs: 1_000, passTimeoutMs: 10_000, submissionTimeoutMs: 60_000 };

  // `classify`'s branches return distinct string labels rather than a shared
  // boundary value, so a `<`/`>` boundary swap always changes the observable
  // result -- unlike a clamp/min/max-style ternary, where swapping the comparison
  // at the exact tie point can be an "equivalent mutant" (unkillable by
  // construction: both branches happen to return the same value there).
  const CLASSIFY = "export function classify(x: number): string { return x < 0 ? 'neg' : x > 100 ? 'big' : 'mid'; }";

  it('a thorough suite kills every mutant of a simple function', async () => {
    const tests: TestCase[] = [
      { id: 'below', args: [-5] },
      { id: 'above', args: [150] },
      { id: 'inside', args: [50] },
      { id: 'lo-boundary', args: [0] },
      { id: 'hi-boundary', args: [100] },
      // A literal-increment mutant (100 -> 101) shifts the boundary rather than
      // removing it, so killing it needs a probe just past the ORIGINAL boundary,
      // not another one at it.
      { id: 'just-above-hi', args: [101] },
    ];
    const report = await runMutationTests({ oracleSource: CLASSIFY, tests, runner, limits: LIMITS });
    assert.equal(report.problems.length, 0, JSON.stringify(report.problems));
    assert.ok(report.mutants.length > 0);
    assert.equal(report.survivedCount, 0, JSON.stringify(report.mutants.filter((m) => m.status === 'survived')));
    assert.equal(report.mutationScore, 1);
  });

  it('a weak suite lets a real mutant survive, and reports which one', async () => {
    // Only ever probes the "inside" branch: cannot distinguish `<`/`>` from
    // `<=`/`>=` at either boundary.
    const tests: TestCase[] = [{ id: 'inside', args: [50] }];
    const report = await runMutationTests({ oracleSource: CLASSIFY, tests, runner, limits: LIMITS });
    assert.ok(report.survivedCount > 0, 'expected at least one surviving mutant with a single-input suite');
    assert.ok(report.mutationScore !== undefined && report.mutationScore < 1);
  });

  it('flags an oracle that is not a usable reference, without generating or running any mutants', async () => {
    const statefulOracle = 'let n = 0;\nexport function next(): number { n += 1; return n; }';
    const report = await runMutationTests({
      oracleSource: statefulOracle,
      tests: [{ id: 't1', args: [] }, { id: 't2', args: [] }],
      runner,
      limits: LIMITS,
    });
    assert.equal(report.mutants.length, 0);
    assert.equal(report.mutationScore, undefined);
    assert.ok(report.problems.some((p) => p.code === 'oracle_nondeterministic'));
  });

  it('reports no_mutants for a source with nothing mutable, rather than a false-perfect score', async () => {
    const report = await runMutationTests({
      oracleSource: 'export function id(s: string): string { return s; }',
      tests: [{ id: 't', args: ['x'] }],
      runner,
      limits: LIMITS,
    });
    assert.equal(report.mutationScore, undefined);
    assert.ok(report.problems.some((p) => p.code === 'no_mutants'));
  });

  it('never lets an input the oracle dropped affect a mutant\'s killed/survived classification', async () => {
    // Regression: mutants used to be evaluated against the full test list,
    // including whatever the oracle itself consistently timed out on and got
    // dropped. A mutant unrelated to the hanging branch has no business being
    // judged on it either way.
    const oracle = `
      export function f(spin: boolean, x: number): number {
        if (spin) { while (true) {} }
        return x + 1;
      }
    `;
    const report = await runMutationTests({
      oracleSource: oracle,
      tests: [{ id: 'spins', args: [true, 0] }, { id: 'returns', args: [false, 0] }],
      runner,
      limits: LIMITS,
    });
    assert.deepEqual(report.droppedTestIds, ['spins']);
    // The `1 -> 2` literal mutant changes the graded test's result and must be
    // killed by it, regardless of anything to do with the dropped 'spins' input.
    const literalMutant = report.mutants.find((m) => m.description === '1 -> 2');
    assert.equal(literalMutant?.status, 'killed');
  });

  it('demonstrates the real gap this layer exists to catch: a single-typical-case suite misses a boundary bug', async () => {
    // Mirrors what a naive generated suite (one "typical" value per parameter, no
    // boundary sweep) would produce for this signature.
    const oracle = 'export function inRange(x: number, lo: number, hi: number): boolean { return x >= lo && x <= hi; }';
    const typicalOnly: TestCase[] = [{ id: 'typical', args: [5, 0, 10] }];
    const withBoundaries: TestCase[] = [
      ...typicalOnly,
      { id: 'lo-boundary', args: [0, 0, 10] },
      { id: 'hi-boundary', args: [10, 0, 10] },
    ];

    const weak = await runMutationTests({ oracleSource: oracle, tests: typicalOnly, runner, limits: LIMITS });
    const strong = await runMutationTests({ oracleSource: oracle, tests: withBoundaries, runner, limits: LIMITS });

    assert.ok(weak.survivedCount > strong.survivedCount, `expected boundary tests to kill more mutants (weak=${weak.survivedCount}, strong=${strong.survivedCount})`);
  });
});
