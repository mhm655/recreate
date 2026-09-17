/**
 * Grades a from-scratch rewrite against a captured oracle, using this harness's
 * `evaluate()` as the execution primitive for both. Runs on the HOST; every actual
 * execution still goes through the same sandboxed, two-pass pipeline as any other
 * submission -- this module only decides what "correct" means once both reports
 * come back. The comparison itself (matching rules, timeout dropping) lives in
 * compare.ts, shared with mutation testing (src/mutator/mutation-test.ts).
 *
 * This is the layer the rest of the README calls "the evaluator." It encodes the
 * grading decisions already recorded there:
 *
 *   - An oracle that isn't deterministic (verdict `nondeterministic`) cannot be used
 *     as a grading reference at all -- there is no single right answer to grade
 *     against. Decision #1.
 *   - An input the oracle consistently times out on is DROPPED from grading, not
 *     kept as an "expected timeout". Decision #4.
 *   - Two `thrown` outcomes match on error class plus normalised message. Decision #3.
 */

import { compareToOracle, describeInvalid, dropOracleTimeouts, type TestVerdict as CompareVerdict } from './compare';
import { evaluate, type EvaluateOptions, type SubmissionReport, type TestCase } from '../host/orchestrator';
import type { TestResult } from '../protocol';

export interface GradeOptions {
  /** The captured-behaviour original. Rejected outright if it isn't a usable oracle. */
  oracleSource: string;
  /** The rewrite being graded against it. */
  rewriteSource: string;
  tests: TestCase[];
  entryName?: string;
  allowedModules?: readonly string[];
  runner: EvaluateOptions['runner'];
  limits?: EvaluateOptions['limits'];
  /** Seed for each submission's shuffled pass. Recorded on each report for replay. */
  seed?: number;
}

export type GradeVerdict = 'passed' | 'failed' | 'oracle_invalid' | 'rewrite_invalid';

export type TestVerdict =
  | { testId: string; result: 'match' }
  | { testId: string; result: 'mismatch'; reason: string; oracle: TestResult; rewrite: TestResult };

export interface GradeProblem {
  code: string;
  detail: string;
}

export interface GradeReport {
  verdict: GradeVerdict;
  /** Fraction of graded tests that matched, in [0, 1]. 0 when nothing could be graded. */
  score: number;
  /** One entry per test actually graded -- excludes anything in `droppedTestIds`. */
  tests: TestVerdict[];
  /** Test ids the oracle itself consistently timed out on; never counted either way. */
  droppedTestIds: string[];
  oracleReport: SubmissionReport;
  /** Absent when the oracle itself was invalid: the rewrite is never even run. */
  rewriteReport?: SubmissionReport;
  problems: GradeProblem[];
}

export async function gradeSubmission(options: GradeOptions): Promise<GradeReport> {
  const shared = {
    entryName: options.entryName,
    allowedModules: options.allowedModules,
    limits: options.limits,
    runner: options.runner,
    seed: options.seed,
  };

  const oracleReport = await evaluate({ source: options.oracleSource, tests: options.tests, ...shared });
  if (oracleReport.verdict !== 'ok') {
    return {
      verdict: 'oracle_invalid',
      score: 0,
      tests: [],
      droppedTestIds: [],
      oracleReport,
      problems: [{ code: `oracle_${oracleReport.verdict}`, detail: describeInvalid('oracle', oracleReport) }],
    };
  }

  const { gradedTests, droppedTestIds } = dropOracleTimeouts(oracleReport, options.tests);
  if (gradedTests.length === 0) {
    return {
      verdict: 'oracle_invalid',
      score: 0,
      tests: [],
      droppedTestIds,
      oracleReport,
      problems: [{ code: 'no_gradable_tests', detail: 'every test input made the oracle time out; none can be used to grade' }],
    };
  }

  const rewriteReport = await evaluate({ source: options.rewriteSource, tests: options.tests, ...shared });
  const cmp = compareToOracle(oracleReport, rewriteReport, gradedTests);
  if (cmp.verdict === 'candidate_invalid') {
    return {
      verdict: 'rewrite_invalid',
      score: 0,
      tests: [],
      droppedTestIds,
      oracleReport,
      rewriteReport,
      problems: [{ code: `rewrite_${rewriteReport.verdict}`, detail: describeInvalid('rewrite', rewriteReport) }],
    };
  }

  return {
    verdict: cmp.verdict,
    score: cmp.score,
    tests: cmp.tests.map(asRewriteVerdict),
    droppedTestIds,
    oracleReport,
    rewriteReport,
    problems: [],
  };
}

function asRewriteVerdict(v: CompareVerdict): TestVerdict {
  return v.result === 'match'
    ? v
    : { testId: v.testId, result: 'mismatch', reason: v.reason, oracle: v.oracle, rewrite: v.candidate };
}
