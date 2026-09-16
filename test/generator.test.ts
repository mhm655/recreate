import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { analyzeIsolated } from '../src/analyzer/isolated';
import { generateTests } from '../src/generator/generate';
import { Rng } from '../src/generator/rng';
import { valuesFor } from '../src/generator/values';
import type { TypeShape } from '../src/analyzer/types';
import { evaluate } from '../src/host/orchestrator';
import { LocalRunner } from '../src/host/runner';

async function analysisOf(source: string) {
  const result = await analyzeIsolated(source);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
  if (!result.ok) throw new Error('unreachable');
  return result.analysis;
}

describe('valuesFor', () => {
  const rng = new Rng(1);

  it('never returns an empty set for a generatable primitive shape', () => {
    for (const shape of [
      { kind: 'string', text: 'string' },
      { kind: 'number', text: 'number' },
      { kind: 'boolean', text: 'boolean' },
      { kind: 'null', text: 'null' },
      { kind: 'undefined', text: 'undefined' },
    ] as TypeShape[]) {
      assert.ok(valuesFor(shape, rng).length > 0, JSON.stringify(shape));
    }
  });

  it('includes edge-case numbers: 0, negative, NaN, +/-Infinity', () => {
    const values = valuesFor({ kind: 'number', text: 'number' }, new Rng(1), {
      maxDepth: 4,
      maxPerShape: 100,
      maxContainerSize: 3,
    });
    assert.ok(values.includes(0));
    assert.ok(values.some((v) => typeof v === 'number' && v < 0));
    assert.ok(values.some((v) => Number.isNaN(v)));
    assert.ok(values.includes(Infinity));
  });

  it('respects maxDepth on recursive-shaped containers instead of looping forever', () => {
    const selfArray: TypeShape = { kind: 'array', element: null as unknown as TypeShape, readonly: false, text: 'T[]' };
    // Element refers back to the array itself, simulating a cyclic shape.
    (selfArray as { element: TypeShape }).element = selfArray;
    const values = valuesFor(selfArray, new Rng(1), { maxDepth: 3, maxPerShape: 3, maxContainerSize: 2 });
    assert.ok(values.length > 0);
  });

  it('throws rather than fabricate a value for a shape the analyzer would have blocked', () => {
    assert.throws(() => valuesFor({ kind: 'function', text: '() => void' }, rng));
  });

  it('builds objects with and without optional properties', () => {
    const shape: TypeShape = {
      kind: 'object',
      text: '{a: number, b?: string}',
      properties: [
        { name: 'a', optional: false, readonly: false, type: { kind: 'number', text: 'number' } },
        { name: 'b', optional: true, readonly: false, type: { kind: 'string', text: 'string' } },
      ],
    };
    const values = valuesFor(shape, new Rng(1), { maxDepth: 4, maxPerShape: 10, maxContainerSize: 3 }) as Record<string, unknown>[];
    assert.ok(values.every((v) => 'a' in v));
    assert.ok(values.some((v) => !('b' in v)));
  });
});

describe('generateTests', () => {
  it('refuses a non-generatable function with the blocker as the reason', async () => {
    const analysis = await analysisOf('export function f(cb: () => void): void { cb(); }');
    const result = generateTests(analysis);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /callback/);
  });

  it('is deterministic for a fixed seed', async () => {
    const analysis = await analysisOf('export function add(a: number, b: number): number { return a + b; }');
    const a = generateTests(analysis, { seed: 42 });
    const b = generateTests(analysis, { seed: 42 });
    assert.deepEqual(a, b);
  });

  it('two different seeds are still both valid but need not be identical', async () => {
    const analysis = await analysisOf('export function add(a: number, b: number): number { return a + b; }');
    const a = generateTests(analysis, { seed: 1 });
    const b = generateTests(analysis, { seed: 2 });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  it('generates a no-args call for a zero-parameter function', async () => {
    const analysis = await analysisOf('export function f(): number { return 1; }');
    const result = generateTests(analysis);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.tests, [{ id: 'no-args', args: [] }]);
  });

  it('produces both a call with the optional arg and one without it', async () => {
    const analysis = await analysisOf('export function greet(name: string, loud?: boolean): string { return name; }');
    const result = generateTests(analysis, { seed: 1 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.tests.some((t) => t.args.length === 1));
    assert.ok(result.tests.some((t) => t.args.length === 2));
  });

  it('respects maxTests', async () => {
    const analysis = await analysisOf(
      'export function f(a: string, b: string, c: string, d: string): string { return a; }',
    );
    const result = generateTests(analysis, { seed: 1, maxTests: 5 });
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(result.tests.length <= 5);
  });

  it('respects maxTests even when every overload contributes its own "typical" test', async () => {
    // Regression: each overload signature contributes a `sigN-typical` test that
    // sampleKeepingCoverage always used to keep, uncapped, before sampling the rest.
    const analysis = await analysisOf(`
      export function f(a: string): string;
      export function f(a: string, b: string): string;
      export function f(a: string, b: string, c: string): string;
      export function f(a: string, b?: string, c?: string): string { return a; }
    `);
    assert.equal(analysis.signatures.length, 3);
    for (const maxTests of [0, 1, 2, 3, 5]) {
      const result = generateTests(analysis, { seed: 1, maxTests });
      assert.equal(result.ok, true);
      if (result.ok) assert.ok(result.tests.length <= maxTests, `maxTests=${maxTests} got ${result.tests.length}`);
    }
  });

  it('every generated test runs through the real pipeline against the actual function', async () => {
    const source = fs.readFileSync(path.resolve('examples/slugify.ts'), 'utf8');
    const analysis = await analysisOf(source);
    const generated = generateTests(analysis, { seed: 7 });
    assert.equal(generated.ok, true);
    if (!generated.ok) return;
    assert.ok(generated.tests.length > 3);

    const report = await evaluate({
      source,
      tests: generated.tests,
      entryName: generated.entryName,
      runner: new LocalRunner(),
      limits: { perTestTimeoutMs: 1_000, passTimeoutMs: 30_000, submissionTimeoutMs: 120_000 },
    });
    assert.equal(report.verdict, 'ok', JSON.stringify(report.problems));
    for (const id of generated.tests.map((t) => t.id)) {
      assert.equal(report.results[id]?.outcome.type, 'return', `test '${id}' did not return normally`);
    }
  });
});
