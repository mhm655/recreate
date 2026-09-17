/**
 * Runs each mutant of an oracle through the same test suite the oracle itself was
 * evaluated with, and checks whether the suite actually distinguishes it. This is
 * what the README calls "mutation testing": it answers "is this suite strong
 * enough to catch a wrong rewrite?", which nothing else in this repo checks --
 * `generateTests` (src/generator) only produces a *plausible* suite, never a
 * *proven-adequate* one.
 *
 * The oracle is evaluated exactly ONCE (via evaluate()) and that report is reused
 * across every mutant, both for correctness (grading every mutant against the same
 * oracle run) and for cost (an unchanged oracle source has no reason to be
 * re-evaluated once per mutant).
 */

import { compareToOracle, describeInvalid, dropOracleTimeouts } from '../evaluator/compare';
import { generateMutants, type GenerateMutantsOptions } from './mutate';
import { evaluate, type EvaluateOptions, type SubmissionReport, type TestCase } from '../host/orchestrator';

export interface MutationTestOptions {
  oracleSource: string;
  tests: TestCase[];
  entryName?: string;
  allowedModules?: readonly string[];
  runner: EvaluateOptions['runner'];
  limits?: EvaluateOptions['limits'];
  seed?: number;
  mutants?: GenerateMutantsOptions;
}

export type MutantOutcome =
  | { id: string; description: string; line: number; column: number; status: 'killed'; killedBy: string[] }
  | { id: string; description: string; line: number; column: number; status: 'survived' }
  /** The mutant itself didn't even produce a comparable run (e.g. a syntactically
   * valid but now type-incompatible edit that still transpiles). Not counted in the
   * mutation score either way -- it says nothing about the test suite. */
  | { id: string; description: string; line: number; column: number; status: 'inconclusive'; detail: string };

export interface MutationTestProblem {
  code: string;
  detail: string;
}

export interface MutationTestReport {
  oracleReport: SubmissionReport;
  droppedTestIds: string[];
  mutants: MutantOutcome[];
  killedCount: number;
  survivedCount: number;
  inconclusiveCount: number;
  /** killed / (killed + survived), in [0, 1]. Excludes inconclusive mutants from the denominator. Undefined if there's nothing to divide. */
  mutationScore: number | undefined;
  problems: MutationTestProblem[];
}

export async function runMutationTests(options: MutationTestOptions): Promise<MutationTestReport> {
  const shared = {
    entryName: options.entryName,
    allowedModules: options.allowedModules,
    limits: options.limits,
    runner: options.runner,
    seed: options.seed,
  };

  const empty = (problems: MutationTestProblem[], oracleReport: SubmissionReport, droppedTestIds: string[] = []): MutationTestReport => ({
    oracleReport,
    droppedTestIds,
    mutants: [],
    killedCount: 0,
    survivedCount: 0,
    inconclusiveCount: 0,
    mutationScore: undefined,
    problems,
  });

  const oracleReport = await evaluate({ source: options.oracleSource, tests: options.tests, ...shared });
  if (oracleReport.verdict !== 'ok') {
    return empty([{ code: `oracle_${oracleReport.verdict}`, detail: describeInvalid('oracle', oracleReport) }], oracleReport);
  }

  const { gradedTests, droppedTestIds } = dropOracleTimeouts(oracleReport, options.tests);
  if (gradedTests.length === 0) {
    return empty(
      [{ code: 'no_gradable_tests', detail: 'every test input made the oracle time out; none can be used to mutation-test' }],
      oracleReport,
      droppedTestIds,
    );
  }

  const mutants = generateMutants(options.oracleSource, options.mutants);
  if (mutants.length === 0) {
    return empty([{ code: 'no_mutants', detail: 'no mutable operator, boolean or numeric literal found in the oracle source' }], oracleReport, droppedTestIds);
  }

  const outcomes: MutantOutcome[] = [];
  for (const mutant of mutants) {
    const mutantReport = await evaluate({ source: mutant.mutatedSource, tests: options.tests, ...shared });
    const base = { id: mutant.id, description: mutant.description, line: mutant.line, column: mutant.column };

    if (mutantReport.verdict === 'rejected') {
      // A mutation that breaks static screening (rare, since these are single-token
      // operator/literal swaps) or fails to transpile says nothing about whether
      // the SUITE would have caught it, so it doesn't count toward the score.
      outcomes.push({ ...base, status: 'inconclusive', detail: `mutant did not evaluate: ${mutantReport.problems.map((p) => p.code).join(', ') || mutantReport.verdict}` });
      continue;
    }

    const cmp = compareToOracle(oracleReport, mutantReport, gradedTests);
    if (cmp.verdict === 'candidate_invalid') {
      // The mutant itself is order-sensitive or incomplete. That is a real,
      // detectable difference from the oracle (which passed the same check), so it
      // counts as caught -- just not by any specific test.
      outcomes.push({ ...base, status: 'killed', killedBy: [] });
      continue;
    }
    if (cmp.verdict === 'passed') {
      outcomes.push({ ...base, status: 'survived' });
    } else {
      outcomes.push({ ...base, status: 'killed', killedBy: cmp.tests.filter((t) => t.result === 'mismatch').map((t) => t.testId) });
    }
  }

  const killedCount = outcomes.filter((o) => o.status === 'killed').length;
  const survivedCount = outcomes.filter((o) => o.status === 'survived').length;
  const inconclusiveCount = outcomes.filter((o) => o.status === 'inconclusive').length;
  const denom = killedCount + survivedCount;

  return {
    oracleReport,
    droppedTestIds,
    mutants: outcomes,
    killedCount,
    survivedCount,
    inconclusiveCount,
    mutationScore: denom ? killedCount / denom : undefined,
    problems: [],
  };
}
