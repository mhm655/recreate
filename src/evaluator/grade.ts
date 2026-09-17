/**
 * Grades a from-scratch rewrite against a captured oracle, using this harness's
 * `evaluate()` as the execution primitive for both. Runs on the HOST; every actual
 * execution still goes through the same sandboxed, two-pass pipeline as any other
 * submission -- this module only decides what "correct" means once both reports
 * come back.
 *
 * This is the layer the rest of the README calls "the evaluator." It encodes the
 * grading decisions already recorded there:
 *
 *   - An oracle that isn't deterministic (verdict `nondeterministic`) cannot be used
 *     as a grading reference at all -- there is no single right answer to grade
 *     against. Decision #1.
 *   - An input the oracle consistently times out on is DROPPED from grading, not
 *     kept as an "expected timeout": nothing here can tell a rewrite that answers
 *     fast and correctly from one whose fast wrong answer just never happened to
 *     time out, when the oracle never produced a real value to compare against in
 *     the first place. Decision #4.
 *   - Two `thrown` outcomes match on error class plus normalised message, not on
 *     exact wording or a non-Error's full encoded value. Decision #3.
 */

import { canonical } from '../encoding';
import { evaluate, type EvaluateOptions, type SubmissionReport, type TestCase } from '../host/orchestrator';
import type { Outcome, TestResult } from '../protocol';

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

  const droppedTestIds = options.tests
    .map((t) => t.id)
    .filter((id) => oracleReport.results[id].outcome.type === 'timeout');
  const gradedTests = options.tests.filter((t) => !droppedTestIds.includes(t.id));

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
  if (rewriteReport.verdict !== 'ok') {
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

  const tests = gradedTests.map((t) => compareOne(t.id, oracleReport.results[t.id], rewriteReport.results[t.id]));
  const matches = tests.filter((t) => t.result === 'match').length;

  return {
    verdict: matches === tests.length ? 'passed' : 'failed',
    score: matches / tests.length,
    tests,
    droppedTestIds,
    oracleReport,
    rewriteReport,
    problems: [],
  };
}

function compareOne(testId: string, oracle: TestResult, rewrite: TestResult): TestVerdict {
  if (outcomesMatch(oracle.outcome, rewrite.outcome)) return { testId, result: 'match' };
  return { testId, result: 'mismatch', reason: mismatchReason(oracle.outcome, rewrite.outcome), oracle, rewrite };
}

function outcomesMatch(a: Outcome, b: Outcome): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'return') return canonical(a.value) === canonical((b as typeof a).value);
  if (a.type === 'thrown') {
    const bt = b as typeof a;
    return a.errorClass === bt.errorClass && a.message === bt.message;
  }
  // timeout / resource_limit / harness_error: the oracle side of these never
  // survives to comparison (a consistent oracle timeout is dropped above, and an
  // oracle-side resource_limit/harness_error already failed the whole run before
  // this function is reached). A rewrite landing on one of these is always a
  // mismatch -- it did not produce a real answer to compare.
  return false;
}

function mismatchReason(a: Outcome, b: Outcome): string {
  if (a.type !== b.type) return `oracle ${a.type}, rewrite ${b.type}`;
  if (a.type === 'return') return 'different return value';
  if (a.type === 'thrown') return 'different thrown error';
  return `both ${a.type}`;
}

function describeInvalid(which: 'oracle' | 'rewrite', report: SubmissionReport): string {
  if (report.verdict === 'nondeterministic') {
    return `the ${which} is order-sensitive (carries state across calls) and cannot be graded${which === 'oracle' ? ' against' : ''}`;
  }
  if (report.verdict === 'rejected') {
    return `the ${which} was rejected by static analysis or failed to transpile`;
  }
  return `the ${which} failed to produce a complete result set (${report.problems.map((p) => p.code).join(', ') || 'no detail'})`;
}
