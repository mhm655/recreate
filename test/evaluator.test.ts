import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { gradeSubmission } from '../src/evaluator/grade';
import { LocalRunner } from '../src/host/runner';
import type { TestCase } from '../src/host/orchestrator';

const runner = new LocalRunner();
const LIMITS = { perTestTimeoutMs: 1_000, passTimeoutMs: 10_000, submissionTimeoutMs: 30_000 };

const ORACLE = 'export function double(x: number): number { return x * 2; }';
const TESTS: TestCase[] = [
  { id: 't1', args: [1] },
  { id: 't2', args: [0] },
  { id: 't3', args: [-5] },
];

describe('gradeSubmission', () => {
  it('passes an identical rewrite', async () => {
    const report = await gradeSubmission({
      oracleSource: ORACLE,
      rewriteSource: 'export function double(x: number): number { return x + x; }',
      tests: TESTS,
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'passed', JSON.stringify(report.problems));
    assert.equal(report.score, 1);
    assert.equal(report.tests.length, 3);
    assert.ok(report.tests.every((t) => t.result === 'match'));
  });

  it('fails a rewrite that is wrong on some inputs', async () => {
    const report = await gradeSubmission({
      oracleSource: ORACLE,
      // Off-by-one style bug: wrong only for negative numbers.
      rewriteSource: 'export function double(x: number): number { return x < 0 ? x : x * 2; }',
      tests: TESTS,
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'failed');
    assert.ok(report.score > 0 && report.score < 1, String(report.score));
    const bad = report.tests.find((t) => t.testId === 't3');
    assert.equal(bad?.result, 'mismatch');
    if (bad?.result === 'mismatch') assert.equal(bad.reason, 'different return value');
    const good = report.tests.find((t) => t.testId === 't1');
    assert.equal(good?.result, 'match');
  });

  it('matches a rewrite that throws the same error the same way', async () => {
    const oracle = 'export function f(x: number): number { if (x < 0) throw new RangeError("negative"); return x; }';
    const rewrite = 'export function f(x: number): number { if (x < 0) throw new RangeError("negative"); return x; }';
    const report = await gradeSubmission({
      oracleSource: oracle,
      rewriteSource: rewrite,
      tests: [{ id: 't', args: [-1] }],
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'passed', JSON.stringify(report.problems));
  });

  it('fails a rewrite that throws a different error class for the same input', async () => {
    const oracle = 'export function f(x: number): number { if (x < 0) throw new RangeError("negative"); return x; }';
    const rewrite = 'export function f(x: number): number { if (x < 0) throw new TypeError("negative"); return x; }';
    const report = await gradeSubmission({
      oracleSource: oracle,
      rewriteSource: rewrite,
      tests: [{ id: 't', args: [-1] }],
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'failed');
    assert.equal(report.tests[0].result, 'mismatch');
  });

  it('rejects an order-sensitive oracle outright, without ever running the rewrite', async () => {
    const statefulOracle = `
      let n = 0;
      export function next(): number { n += 1; return n; }
    `;
    const report = await gradeSubmission({
      oracleSource: statefulOracle,
      rewriteSource: 'export function next(): number { return 1; }',
      tests: [{ id: 't1', args: [] }, { id: 't2', args: [] }],
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'oracle_invalid');
    assert.equal(report.rewriteReport, undefined);
    assert.ok(report.problems.some((p) => p.code === 'oracle_nondeterministic'));
  });

  it('drops inputs the oracle consistently times out on, and grades on what remains', async () => {
    const oracle = `
      export function f(spin: boolean): string {
        if (spin) { while (true) {} }
        return 'fine';
      }
    `;
    const report = await gradeSubmission({
      oracleSource: oracle,
      rewriteSource: 'export function f(spin: boolean): string { return "fine"; }',
      tests: [{ id: 'spins', args: [true] }, { id: 'returns', args: [false] }],
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'passed', JSON.stringify(report.problems));
    assert.deepEqual(report.droppedTestIds, ['spins']);
    assert.equal(report.tests.length, 1);
    assert.equal(report.tests[0].testId, 'returns');
  });

  it('flags a rewrite that is itself order-sensitive as rewrite_invalid, never diffed per test', async () => {
    const report = await gradeSubmission({
      oracleSource: ORACLE,
      rewriteSource: `
        let calls = 0;
        export function double(x: number): number { calls += 1; return x * 2 + (calls > 1 ? 1 : 0); }
      `,
      tests: TESTS,
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'rewrite_invalid');
    assert.equal(report.tests.length, 0);
    assert.ok(report.problems.some((p) => p.code === 'rewrite_nondeterministic'));
  });
});
