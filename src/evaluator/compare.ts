/**
 * The comparison core shared by `gradeSubmission` (grade.ts) and mutation testing
 * (src/mutator/mutation-test.ts): given an oracle's `SubmissionReport` and a
 * candidate's -- a rewrite, or a mutant of the oracle -- decide whether they agree.
 * Pulled out on its own so mutation testing can run the oracle through `evaluate()`
 * exactly ONCE and reuse that report across every mutant, instead of re-evaluating
 * an unchanged oracle source once per mutant.
 */

import { canonical } from '../encoding';
import type { SubmissionReport, TestCase } from '../host/orchestrator';
import type { Outcome, TestResult } from '../protocol';

export type TestVerdict =
  | { testId: string; result: 'match' }
  | { testId: string; result: 'mismatch'; reason: string; oracle: TestResult; candidate: TestResult };

export type CompareVerdict = 'passed' | 'failed' | 'candidate_invalid';

export interface CompareResult {
  verdict: CompareVerdict;
  /** Fraction of `gradedTests` that matched, in [0, 1]. 0 when the candidate is invalid. */
  score: number;
  tests: TestVerdict[];
}

/**
 * Test ids the oracle consistently timed out on are dropped, not scored either way
 * (README decision #4): nothing here can tell a candidate that answers fast and
 * correctly from one whose fast wrong answer never happened to time out, when the
 * oracle itself never produced a real value on that input to compare against.
 *
 * Only meaningful once `oracleReport.verdict === 'ok'` -- callers check that first.
 */
export function dropOracleTimeouts(
  oracleReport: SubmissionReport,
  tests: TestCase[],
): { gradedTests: TestCase[]; droppedTestIds: string[] } {
  const droppedTestIds = tests.map((t) => t.id).filter((id) => oracleReport.results[id].outcome.type === 'timeout');
  const gradedTests = tests.filter((t) => !droppedTestIds.includes(t.id));
  return { gradedTests, droppedTestIds };
}

/**
 * Compares a candidate's report against an already-validated oracle report
 * (`oracleReport.verdict === 'ok'`) over `gradedTests`. A candidate whose own
 * `evaluate()` verdict isn't `ok` is `candidate_invalid` wholesale -- there is no
 * single result set to diff test by test against a rejected, order-sensitive, or
 * incomplete run.
 */
export function compareToOracle(
  oracleReport: SubmissionReport,
  candidateReport: SubmissionReport,
  gradedTests: TestCase[],
): CompareResult {
  if (candidateReport.verdict !== 'ok') return { verdict: 'candidate_invalid', score: 0, tests: [] };

  const tests = gradedTests.map((t) => compareOne(t.id, oracleReport.results[t.id], candidateReport.results[t.id]));
  const matches = tests.filter((t) => t.result === 'match').length;
  return {
    verdict: matches === tests.length ? 'passed' : 'failed',
    score: tests.length ? matches / tests.length : 0,
    tests,
  };
}

function compareOne(testId: string, oracle: TestResult, candidate: TestResult): TestVerdict {
  if (outcomesMatch(oracle.outcome, candidate.outcome)) return { testId, result: 'match' };
  return { testId, result: 'mismatch', reason: mismatchReason(oracle.outcome, candidate.outcome), oracle, candidate };
}

/**
 * The matching rule itself, exported so a caller comparing against a frozen
 * expected `Outcome` -- rather than a live oracle `SubmissionReport` -- doesn't have
 * to duplicate it. See src/challenge/grade.ts.
 */
export function outcomesMatch(a: Outcome, b: Outcome): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'return') return canonical(a.value) === canonical((b as typeof a).value);
  if (a.type === 'thrown') {
    // Decision #3: match on error class plus normalised message, not exact wording
    // or a non-Error's full encoded value.
    const bt = b as typeof a;
    return a.errorClass === bt.errorClass && a.message === bt.message;
  }
  // timeout / resource_limit / harness_error: the oracle side of these never
  // reaches this function (a consistent oracle timeout is dropped before comparison,
  // and an oracle-side resource_limit/harness_error already failed the whole run
  // before comparison starts). A candidate landing on one of these is always a
  // mismatch -- it did not produce a real answer to compare.
  return false;
}

export function mismatchReason(a: Outcome, b: Outcome): string {
  if (a.type !== b.type) return `oracle ${a.type}, candidate ${b.type}`;
  if (a.type === 'return') return 'different return value';
  if (a.type === 'thrown') return 'different thrown error';
  return `both ${a.type}`;
}

export function describeInvalid(which: string, report: SubmissionReport): string {
  if (report.verdict === 'nondeterministic') {
    return `the ${which} is order-sensitive (carries state across calls) and cannot be graded`;
  }
  if (report.verdict === 'rejected') {
    return `the ${which} was rejected by static analysis or failed to transpile`;
  }
  return `the ${which} failed to produce a complete result set (${report.problems.map((p) => p.code).join(', ') || 'no detail'})`;
}
