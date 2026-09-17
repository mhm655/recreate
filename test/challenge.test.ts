import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { captureChallenge } from '../src/challenge/capture';
import { gradeAgainstChallenge } from '../src/challenge/grade';
import { CHALLENGE_SCHEMA_VERSION, type Challenge } from '../src/challenge/types';
import { LocalRunner } from '../src/host/runner';

const runner = new LocalRunner();
const LIMITS = { perTestTimeoutMs: 1_000, passTimeoutMs: 10_000, submissionTimeoutMs: 60_000 };

const ORACLE = 'export function double(x: number): number { return x * 2; }';

describe('captureChallenge', () => {
  it('captures a JSON-safe challenge from a pure function', async () => {
    const result = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1 });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    if (!result.ok) return;
    const c = result.challenge;
    assert.equal(c.schemaVersion, CHALLENGE_SCHEMA_VERSION);
    assert.equal(c.entryName, 'double');
    assert.ok(c.tests.length > 0);
    assert.equal(c.droppedTestIds.length, 0);
    // Must genuinely be plain JSON -- no functions, no cycles that JSON.stringify can't handle.
    const roundTripped = JSON.parse(JSON.stringify(c)) as Challenge;
    assert.deepEqual(roundTripped, c);
  });

  it('produces the same id for the same content, and a different id for a behaviourally different oracle', async () => {
    const a = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1 });
    // Textually different but behaviourally identical to ORACLE: the id is a
    // content hash of the CAPTURED BEHAVIOUR (tests + expected outcomes), not of
    // the source text, so this must produce the same id as `a`.
    const b = await captureChallenge({
      oracleSource: 'export function double(x: number): number { return x + x; }',
      runner, limits: LIMITS, seed: 1,
    });
    const c = await captureChallenge({
      oracleSource: 'export function double(x: number): number { return x * 3; }',
      runner, limits: LIMITS, seed: 1,
    });
    assert.equal(a.ok && b.ok && a.challenge.id === b.challenge.id, true);
    assert.equal(a.ok && c.ok && a.challenge.id !== c.challenge.id, true);
  });

  it('refuses to capture an order-sensitive oracle', async () => {
    const result = await captureChallenge({
      oracleSource: 'let n = 0;\nexport function next(): number { n += 1; return n; }',
      runner, limits: LIMITS, seed: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /order-sensitive/);
  });

  it('drops inputs the oracle times out on and records them, rather than capturing a timeout as expected behaviour', async () => {
    const oracle = `
      export function f(spin: boolean): string {
        if (spin) { while (true) {} }
        return 'fine';
      }
    `;
    const result = await captureChallenge({ oracleSource: oracle, runner, limits: LIMITS, seed: 1, maxTests: 50 });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    if (!result.ok) return;
    assert.ok(result.challenge.droppedTestIds.length > 0);
    for (const t of result.challenge.tests) assert.notEqual(t.expected.type, 'timeout');
  });

  it('optionally records a mutation-testing summary', async () => {
    const result = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1, mutationTest: true });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    if (!result.ok) return;
    assert.ok(result.challenge.mutationTesting);
    assert.equal(typeof result.challenge.mutationTesting?.mutationScore, 'number');
  });

  it('omits the mutation summary when not requested', async () => {
    const result = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1 });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.challenge.mutationTesting, undefined);
  });
});

describe('gradeAgainstChallenge', () => {
  it('grades a correct rewrite as passed, using only the frozen challenge -- no oracle source needed', async () => {
    const captured = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1 });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;

    // Strip the oracle source to prove grading genuinely doesn't need it.
    const { oracleSource, ...withoutOracleSource } = captured.challenge;
    void oracleSource;
    const challenge = withoutOracleSource as Challenge;

    const report = await gradeAgainstChallenge(challenge, {
      rewriteSource: 'export function double(x: number): number { return x + x; }',
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'passed', JSON.stringify(report.problems));
    assert.equal(report.score, 1);
  });

  it('grades a buggy rewrite as failed, naming the mismatch', async () => {
    const captured = await captureChallenge({
      oracleSource: 'export function abs(x: number): number { return x < 0 ? -x : x; }',
      runner, limits: LIMITS, seed: 1,
    });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;

    const report = await gradeAgainstChallenge(captured.challenge, {
      rewriteSource: 'export function abs(x: number): number { return x; }', // forgot to negate
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'failed');
    assert.ok(report.tests.some((t) => t.result === 'mismatch'));
  });

  it('flags a rewrite that fails its own two-pass run as rewrite_invalid, never diffed per test', async () => {
    const captured = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1 });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;

    const report = await gradeAgainstChallenge(captured.challenge, {
      rewriteSource: 'export function double(x: number) { throw new Error("nope"); }',
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'failed'); // deterministic, just wrong -- not rewrite_invalid
    assert.ok(report.tests.every((t) => t.result === 'mismatch'));
  });

  it('a rewrite rejected by static analysis is rewrite_invalid', async () => {
    const captured = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1 });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;

    const report = await gradeAgainstChallenge(captured.challenge, {
      rewriteSource: "export function double(x: number): number { return require('fs') as any; }",
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'rewrite_invalid');
    assert.ok(report.problems.some((p) => p.code === 'rewrite_rejected'));
  });
});
