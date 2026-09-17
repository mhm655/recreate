/**
 * Runs each mutant of an oracle through the same test suite the oracle itself was
 * evaluated with, and checks whether the suite actually distinguishes it. This is
 * what the README calls "mutation testing": it answers "is this suite strong
 * enough to catch a wrong rewrite?", which nothing else in this repo checks --
 * `generateTests` (src/generator) only produces a *plausible* suite, never a
 * *proven-adequate* one.
 *
 * The oracle is evaluated exactly ONCE (via evaluate(), through compare.ts's
 * shared `runOracle`) and that report is reused across every mutant, both for
 * correctness (grading every mutant against the same oracle run) and for cost (an
 * unchanged oracle source has no reason to be re-evaluated once per mutant -- or,
 * via `precomputedOracle`, once per caller that already ran it: see
 * src/challenge/capture.ts, which captures a Challenge from the same oracle run
 * this function would otherwise redundantly repeat).
 */

import { compareToOracle, runOracle, type OracleContext } from '../evaluator/compare';
import { generateMutants, type GenerateMutantsOptions } from './mutate';
import { evaluate, type EvaluateOptions, type Problem, type SubmissionReport, type TestCase } from '../host/orchestrator';

export interface MutationTestOptions {
  oracleSource: string;
  tests: TestCase[];
  entryName?: string;
  allowedModules?: readonly string[];
  runner: EvaluateOptions['runner'];
  limits?: EvaluateOptions['limits'];
  seed?: number;
  mutants?: GenerateMutantsOptions;
  /**
   * Skips re-running the oracle when a caller already has its own `evaluate()`
   * result for this exact `oracleSource`/`tests` (see src/challenge/capture.ts).
   * The caller is responsible for that match; this function does not re-verify it.
   */
  precomputedOracle?: OracleContext;
}

export type MutantOutcome =
  | { id: string; description: string; line: number; column: number; status: 'killed'; killedBy: string[] }
  | { id: string; description: string; line: number; column: number; status: 'survived' }
  /** The mutant itself didn't even produce a comparable run (e.g. a syntactically
   * valid but now type-incompatible edit that still transpiles). Not counted in the
   * mutation score either way -- it says nothing about the test suite. */
  | { id: string; description: string; line: number; column: number; status: 'inconclusive'; detail: string };

export type MutationTestProblem = Problem;

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

  let oracleContext: OracleContext;
  if (options.precomputedOracle) {
    oracleContext = options.precomputedOracle;
  } else {
    const oracle = await runOracle(options.oracleSource, options.tests, shared);
    if (!oracle.ok) return empty([oracle.problem], oracle.oracleReport);
    oracleContext = oracle.context;
  }
  const { oracleReport, gradedTests, droppedTestIds } = oracleContext;

  const mutants = generateMutants(options.oracleSource, options.mutants);
  if (mutants.length === 0) {
    return empty([{ code: 'no_mutants', detail: 'no mutable operator, boolean or numeric literal found in the oracle source' }], oracleReport, droppedTestIds);
  }

  const outcomes: MutantOutcome[] = [];
  for (const mutant of mutants) {
    // gradedTests, not options.tests: same reasoning as gradeSubmission
    // (src/evaluator/grade.ts) -- a mutant must never be run against an input the
    // oracle itself couldn't answer, or flakiness on a question nobody is scoring
    // could mark it 'killed' (or, if it happens to hang identically, 'survived')
    // for reasons that have nothing to do with whether the suite caught it.
    const mutantReport = await evaluate({ source: mutant.mutatedSource, tests: gradedTests, ...shared });
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
