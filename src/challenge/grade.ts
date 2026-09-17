/**
 * Grades a rewrite against an already-captured Challenge (src/challenge/capture.ts)
 * -- no oracle source, and no oracle re-run, required. This is the payoff of
 * capturing behaviour as a fixed suite: every later grading run only needs the
 * frozen `expected` outcomes and the rewrite under test.
 */

import { decode } from '../encoding';
import { describeInvalid, mismatchReason, outcomesMatch } from '../evaluator/compare';
import { evaluate, type EvaluateOptions, type Problem, type SubmissionReport, type TestCase } from '../host/orchestrator';
import type { Outcome } from '../protocol';
import type { Challenge } from './types';

export interface GradeAgainstChallengeOptions {
  rewriteSource: string;
  /** Overrides challenge.entryName / challenge.allowedModules; normally unnecessary. */
  entryName?: string;
  allowedModules?: readonly string[];
  runner: EvaluateOptions['runner'];
  limits?: EvaluateOptions['limits'];
  seed?: number;
}

export type ChallengeGradeVerdict = 'passed' | 'failed' | 'rewrite_invalid';

export type ChallengeTestVerdict =
  | { testId: string; result: 'match' }
  | { testId: string; result: 'mismatch'; reason: string; expected: Outcome; rewrite: Outcome };

export type ChallengeGradeProblem = Problem;

export interface ChallengeGradeReport {
  verdict: ChallengeGradeVerdict;
  score: number;
  tests: ChallengeTestVerdict[];
  rewriteReport: SubmissionReport;
  problems: ChallengeGradeProblem[];
}

export async function gradeAgainstChallenge(
  challenge: Challenge,
  options: GradeAgainstChallengeOptions,
): Promise<ChallengeGradeReport> {
  const rewriteTests: TestCase[] = challenge.tests.map((t) => ({ id: t.id, args: toArgsArray(decode(t.args)) }));

  const rewriteReport = await evaluate({
    source: options.rewriteSource,
    tests: rewriteTests,
    entryName: options.entryName ?? challenge.entryName,
    allowedModules: options.allowedModules ?? challenge.allowedModules,
    limits: options.limits,
    runner: options.runner,
    seed: options.seed,
  });

  if (rewriteReport.verdict !== 'ok') {
    return {
      verdict: 'rewrite_invalid',
      score: 0,
      tests: [],
      rewriteReport,
      problems: [{ code: `rewrite_${rewriteReport.verdict}`, detail: describeInvalid('rewrite', rewriteReport) }],
    };
  }

  const tests: ChallengeTestVerdict[] = challenge.tests.map((t) => {
    const rewriteOutcome = rewriteReport.results[t.id].outcome;
    if (outcomesMatch(t.expected, rewriteOutcome)) return { testId: t.id, result: 'match' };
    return {
      testId: t.id,
      result: 'mismatch',
      reason: mismatchReason(t.expected, rewriteOutcome),
      expected: t.expected,
      rewrite: rewriteOutcome,
    };
  });
  const matches = tests.filter((t) => t.result === 'match').length;

  return {
    verdict: matches === tests.length ? 'passed' : 'failed',
    score: tests.length ? matches / tests.length : 0,
    tests,
    rewriteReport,
    problems: [],
  };
}

/** encodeArgs always encodes the whole argument list as one array node; this mirrors the same defensive unwrap the sandbox worker uses (src/sandbox/worker.ts) for consistency, though a Challenge's args should never fail to be an array. */
function toArgsArray(decoded: unknown): unknown[] {
  return Array.isArray(decoded) ? decoded : [decoded];
}
