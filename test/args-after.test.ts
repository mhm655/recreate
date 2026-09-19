/**
 * Grading compares what a function leaves in its arguments, not just what it
 * returns. A rewrite of an in-place sort that returns a sorted copy has the right
 * return value and the wrong behaviour.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { captureChallenge } from '../src/challenge/capture';
import { gradeAgainstChallenge } from '../src/challenge/grade';
import { decode } from '../src/encoding';
import { ARGS_AFTER_MISMATCH_REASON } from '../src/evaluator/compare';
import { gradeSubmission } from '../src/evaluator/grade';
import { LocalRunner } from '../src/host/runner';
import type { Limits } from '../src/protocol';

const runner = new LocalRunner();
const LIMITS: Partial<Limits> = { perTestTimeoutMs: 2_000, passTimeoutMs: 30_000 };

const SORT_IN_PLACE = `
export function sortScores(scores: number[]): number[] {
  scores.sort((a, b) => b - a);
  return scores;
}`;

// Same return value, but the caller's array is left untouched.
const RETURNS_COPY = `
export function sortScores(scores: number[]): number[] {
  return [...scores].sort((a, b) => b - a);
}`;

// Different algorithm, same in-place effect.
const IN_PLACE_REWRITE = `
export function sortScores(scores: number[]): number[] {
  for (let i = 1; i < scores.length; i++) {
    for (let j = i; j > 0 && scores[j - 1] < scores[j]; j--) {
      [scores[j - 1], scores[j]] = [scores[j], scores[j - 1]];
    }
  }
  return scores;
}`;

const TESTS = [
  { id: 'mixed', args: [[3, 10, 1, 7]] },
  { id: 'already-sorted', args: [[9, 5, 2]] },
  { id: 'empty', args: [[]] },
];

describe('grading compares arguments after the call', () => {
  it('fails a rewrite that returns the right value but does not mutate like the original', async () => {
    const report = await gradeSubmission({ oracleSource: SORT_IN_PLACE, rewriteSource: RETURNS_COPY, tests: TESTS, runner, limits: LIMITS });
    assert.equal(report.verdict, 'failed');
    const bad = report.tests.filter((t) => t.result === 'mismatch');
    // 'already-sorted' and 'empty' leave the array unchanged either way, so they match.
    assert.deepEqual(bad.map((t) => t.testId), ['mixed']);
    const t = bad[0];
    assert.ok(t.result === 'mismatch');
    assert.equal(t.reason, ARGS_AFTER_MISMATCH_REASON);
    assert.deepEqual(decode(t.oracle.argsAfterCall), [[10, 7, 3, 1]]);
    assert.deepEqual(decode(t.rewrite.argsAfterCall), [[3, 10, 1, 7]]);
  });

  it('passes a differently written rewrite with the same in-place effect', async () => {
    const report = await gradeSubmission({ oracleSource: SORT_IN_PLACE, rewriteSource: IN_PLACE_REWRITE, tests: TESTS, runner, limits: LIMITS });
    assert.equal(report.verdict, 'passed');
  });

  it('also fails a rewrite that mutates when the original did not', async () => {
    const report = await gradeSubmission({
      oracleSource: RETURNS_COPY,
      rewriteSource: SORT_IN_PLACE,
      tests: TESTS,
      runner,
      limits: LIMITS,
    });
    assert.equal(report.verdict, 'failed');
  });
});

describe('challenges record and grade arguments after the call', () => {
  it('stores the oracle state and uses it when grading', async () => {
    const captured = await captureChallenge({ oracleSource: SORT_IN_PLACE, runner, limits: LIMITS, seed: 1 });
    assert.ok(captured.ok, captured.ok ? '' : captured.reason);
    const challenge = captured.challenge;
    assert.ok(challenge.tests.every((t) => t.expectedArgsAfter !== undefined));

    const copy = await gradeAgainstChallenge(challenge, { rewriteSource: RETURNS_COPY, runner, limits: LIMITS });
    assert.equal(copy.verdict, 'failed');
    const bad = copy.tests.filter((t) => t.result === 'mismatch');
    assert.ok(bad.length > 0);
    for (const t of bad) {
      assert.ok(t.result === 'mismatch');
      assert.equal(t.reason, ARGS_AFTER_MISMATCH_REASON);
      assert.ok(t.expectedArgsAfter && t.rewriteArgsAfter, 'both argument states are reported');
    }

    const inPlace = await gradeAgainstChallenge(challenge, { rewriteSource: IN_PLACE_REWRITE, runner, limits: LIMITS });
    assert.equal(inPlace.verdict, 'passed');
  });

  it('grades challenges captured before this on outcomes alone', async () => {
    const captured = await captureChallenge({ oracleSource: SORT_IN_PLACE, runner, limits: LIMITS, seed: 1 });
    assert.ok(captured.ok);
    const legacy = {
      ...captured.challenge,
      tests: captured.challenge.tests.map(({ expectedArgsAfter: _dropped, ...rest }) => rest),
    };
    const graded = await gradeAgainstChallenge(legacy, { rewriteSource: RETURNS_COPY, runner, limits: LIMITS });
    assert.equal(graded.verdict, 'passed');
  });
});
