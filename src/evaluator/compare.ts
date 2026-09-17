/**
 * The comparison core shared by `gradeSubmission` (grade.ts) and mutation testing
 * (src/mutator/mutation-test.ts): given an oracle's `SubmissionReport` and a
 * candidate's -- a rewrite, or a mutant of the oracle -- decide whether they agree.
 * Pulled out on its own so mutation testing can run the oracle through `evaluate()`
 * exactly ONCE and reuse that report across every mutant, instead of re-evaluating
 * an unchanged oracle source once per mutant.
 */

import { canonical } from '../encoding';
import { evaluate, type EvaluateOptions, type Problem, type SubmissionReport, type TestCase } from '../host/orchestrator';
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
 * Test ids where the oracle consistently produced no real answer -- a timeout, a
 * resource limit (e.g. its memory cap), or a harness error, on BOTH the ordered and
 * shuffled pass -- are dropped, not scored either way (README decision #4): nothing
 * here can tell a candidate that answers fast and correctly from one whose fast
 * wrong answer never happened to hit the same wall, when the oracle itself never
 * produced a real value on that input to compare against.
 *
 * This has to cover every non-return/non-thrown outcome, not just 'timeout': a pass's
 * overall status (PassStatus in orchestrator.ts) is derived from container/process-level
 * signals, not from any one test's outcome, so a per-test resource_limit that happens
 * consistently on both passes leaves the oracle's overall verdict 'ok' -- and
 * `outcomesMatch` never matches a resource_limit/harness_error outcome, even against
 * an identical one, so leaving it in `gradedTests` would make that test slot
 * permanently unpassable by any candidate, including one that fails identically.
 *
 * Only meaningful once `oracleReport.verdict === 'ok'` -- callers check that first.
 */
export function dropUngradableOracleOutcomes(
  oracleReport: SubmissionReport,
  tests: TestCase[],
): { gradedTests: TestCase[]; droppedTestIds: string[] } {
  const droppedTestIds = tests
    .map((t) => t.id)
    .filter((id) => {
      const type = oracleReport.results[id].outcome.type;
      return type === 'timeout' || type === 'resource_limit' || type === 'harness_error';
    });
  const gradedTests = tests.filter((t) => !droppedTestIds.includes(t.id));
  return { gradedTests, droppedTestIds };
}

export interface OracleContext {
  oracleReport: SubmissionReport;
  gradedTests: TestCase[];
  droppedTestIds: string[];
}

export type OracleRunResult =
  | { ok: true; context: OracleContext }
  | { ok: false; oracleReport: SubmissionReport; problem: Problem };

/**
 * Evaluates an oracle and prepares it for comparison: runs `evaluate()` once,
 * refuses it outright if its own verdict isn't `ok` (decision #1 -- an
 * order-sensitive "oracle" has no single right answer to grade against), then
 * drops any input it consistently produced no real answer for (decision #4). Shared by
 * `gradeSubmission` (grade.ts), `runMutationTests` (mutator/mutation-test.ts) and
 * `captureChallenge` (challenge/capture.ts), which all needed the identical
 * sequence and used to each run it by hand.
 */
export async function runOracle(
  oracleSource: string,
  tests: TestCase[],
  evalOptions: Omit<EvaluateOptions, 'source' | 'tests'>,
): Promise<OracleRunResult> {
  const oracleReport = await evaluate({ source: oracleSource, tests, ...evalOptions });
  if (oracleReport.verdict !== 'ok') {
    return {
      ok: false,
      oracleReport,
      problem: { code: `oracle_${oracleReport.verdict}`, detail: describeInvalid('oracle', oracleReport) },
    };
  }

  const { gradedTests, droppedTestIds } = dropUngradableOracleOutcomes(oracleReport, tests);
  if (gradedTests.length === 0) {
    return {
      ok: false,
      oracleReport,
      problem: { code: 'no_gradable_tests', detail: 'every test input made the oracle time out or hit a resource limit; none can be used to grade' },
    };
  }

  return { ok: true, context: { oracleReport, gradedTests, droppedTestIds } };
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
  // Every internal caller routes through runOracle(), which already refuses an
  // empty gradedTests before this runs -- but this is exported, so an empty list
  // here shouldn't produce the self-contradictory "passed" with a 0% score that
  // `matches === tests.length` (0 === 0) would otherwise give it.
  return {
    verdict: tests.length > 0 && matches === tests.length ? 'passed' : 'failed',
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
    // Decision #3: match on error class plus normalised message, not exact wording.
    // When a non-Error value was thrown, `value` also carries its full encoded form
    // (protocol.ts) specifically so two differently-shaped throws (e.g. `throw {code:42}`
    // vs `throw {code:99}`) aren't both flattened to the same generic `String(thrown)`
    // message and wrongly treated as a match.
    const bt = b as typeof a;
    if (a.errorClass !== bt.errorClass || a.message !== bt.message) return false;
    if (a.value === undefined || bt.value === undefined) return a.value === undefined && bt.value === undefined;
    return canonical(a.value) === canonical(bt.value);
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
