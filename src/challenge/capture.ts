/**
 * Captures a Challenge from an oracle: analyze -> generate -> run the oracle once
 * -> freeze its own outcomes as the expected results. After this, grading a
 * rewrite (src/challenge/grade.ts) never needs the oracle source again.
 */

import { createHash } from 'node:crypto';

import { analyzeIsolated } from '../analyzer/isolated';
import { runOracle } from '../evaluator/compare';
import { encodeArgs } from '../encoding';
import { generateTests, type GenerateOptions, type GeneratedTest } from '../generator/generate';
import { suggestTestsWithLlm, type LlmSuggestOptions } from '../generator/llm';
import type { EvaluateOptions } from '../host/orchestrator';
import { DEFAULT_LIMITS } from '../protocol';
import type { GenerateMutantsOptions } from '../mutator/mutate';
import { runMutationTests } from '../mutator/mutation-test';
import {
  CHALLENGE_SCHEMA_VERSION,
  type Challenge,
  type ChallengeLlmSummary,
  type ChallengeMutationSummary,
} from './types';

export interface CaptureOptions {
  oracleSource: string;
  entryName?: string;
  allowedModules?: readonly string[];
  runner: EvaluateOptions['runner'];
  limits?: EvaluateOptions['limits'];
  seed?: number;
  maxTests?: GenerateOptions['maxTests'];
  /**
   * Runs mutation testing during capture and stores a summary on the Challenge.
   * Off by default: it's a real cost (one evaluate() call per mutant, on top of
   * generation and the initial oracle run), worth paying once when a challenge is
   * authored, not implied by just wanting a suite.
   */
  mutationTest?: boolean | GenerateMutantsOptions;
  /**
   * Quality gate: refuses to capture a challenge whose mutation score falls below
   * this threshold (in [0, 1]), instead of silently producing a challenge that
   * looks identical to a strong one downstream. Setting this implies running
   * mutation testing even if `mutationTest` was left unset -- asking for a floor
   * on the score is asking to measure it. A source with nothing mutable (no
   * relational/arithmetic/logical operator or literal for generateMutants to
   * touch) has no score to fall below and passes the gate: there is nothing for a
   * suite to have missed.
   */
  minMutationScore?: number;
  /**
   * Also ask Claude for inputs aimed at the function's actual logic (see
   * src/generator/llm.ts). Off by default: it sends the oracle source to the
   * Anthropic API, costs tokens and needs credentials. Paid once here -- the
   * accepted inputs are frozen into the challenge, so grading never calls the model.
   * If it was requested and fails, capture fails rather than silently producing a
   * weaker suite than was asked for.
   */
  llm?: boolean | LlmSuggestOptions;
}

export type CaptureResult = { ok: true; challenge: Challenge } | { ok: false; reason: string };

export async function captureChallenge(options: CaptureOptions): Promise<CaptureResult> {
  const allowedModules = options.allowedModules;

  const analysis = await analyzeIsolated(options.oracleSource, {
    entryName: options.entryName,
    allowedModules,
  });
  if (!analysis.ok) {
    return { ok: false, reason: `oracle rejected by static analysis: ${analysis.errors.map((e) => e.message).join('; ')}` };
  }

  const typed = generateTests(analysis.analysis, { seed: options.seed, maxTests: options.maxTests });
  if (!typed.ok) {
    return { ok: false, reason: `oracle is not generatable: ${typed.reason}` };
  }

  let llmSummary: ChallengeLlmSummary | undefined;
  let llmTests: GeneratedTest[] = [];
  if (options.llm) {
    const llmOptions = typeof options.llm === 'object' ? options.llm : {};
    const suggested = await suggestTestsWithLlm(options.oracleSource, analysis.analysis, typed.tests, llmOptions);
    if (!suggested.ok) return { ok: false, reason: `LLM input generation failed: ${suggested.reason}` };
    llmTests = suggested.report.accepted;
    llmSummary = {
      model: suggested.report.model,
      acceptedCount: suggested.report.accepted.length,
      rejected: suggested.report.rejected,
      rationales: Object.fromEntries(suggested.report.accepted.map((s) => [s.id, s.rationale])),
    };
  }
  const generated = { entryName: typed.entryName, tests: [...typed.tests, ...llmTests] };

  const shared = {
    entryName: generated.entryName,
    allowedModules,
    limits: options.limits,
    runner: options.runner,
    seed: options.seed,
  };

  const oracle = await runOracle(options.oracleSource, generated.tests, shared);
  if (!oracle.ok) return { ok: false, reason: oracle.problem.detail };
  const { oracleReport, gradedTests, droppedTestIds } = oracle.context;

  const tests = gradedTests.map((t) => ({
    id: t.id,
    args: encodeArgs(t.args),
    expected: oracleReport.results[t.id].outcome,
    expectedArgsAfter: oracleReport.results[t.id].argsAfterCall,
  }));

  let mutationTesting: ChallengeMutationSummary | undefined;
  if (options.mutationTest || options.minMutationScore !== undefined) {
    const mutantOptions = typeof options.mutationTest === 'object' ? options.mutationTest : undefined;
    // precomputedOracle: the oracle was already evaluated just above; mutation
    // testing would otherwise re-run that same, most-expensive-step-in-the-pipeline
    // evaluation from scratch for no reason.
    const mt = await runMutationTests({
      oracleSource: options.oracleSource,
      tests: generated.tests,
      mutants: mutantOptions,
      precomputedOracle: oracle.context,
      ...shared,
    });
    mutationTesting = {
      killedCount: mt.killedCount,
      survivedCount: mt.survivedCount,
      inconclusiveCount: mt.inconclusiveCount,
      mutationScore: mt.mutationScore,
      survived: mt.mutants
        .filter((m) => m.status === 'survived')
        .map((m) => ({ description: m.description, line: m.line, column: m.column })),
    };

    if (options.minMutationScore !== undefined && mutationTesting.mutationScore !== undefined) {
      if (mutationTesting.mutationScore < options.minMutationScore) {
        const survivedList = mutationTesting.survived.map((s) => `line ${s.line}:${s.column} (${s.description})`).join('; ');
        return {
          ok: false,
          reason:
            `mutation score ${(mutationTesting.mutationScore * 100).toFixed(1)}% is below the required minimum ` +
            `${(options.minMutationScore * 100).toFixed(1)}% -- survived: ${survivedList}`,
        };
      }
    }
  }

  const challenge: Omit<Challenge, 'id'> = {
    schemaVersion: CHALLENGE_SCHEMA_VERSION,
    entryName: generated.entryName,
    oracleSource: options.oracleSource,
    allowedModules: [...(allowedModules ?? [])],
    tests,
    droppedTestIds,
    generation: { seed: options.seed ?? 1, ...(llmSummary ? { llm: llmSummary } : {}) },
    // The settings the oracle actually ran under, resolved exactly as evaluate()
    // resolves them, so grading can reproduce them.
    determinism: { ...DEFAULT_LIMITS.determinism, ...options.limits?.determinism },
    // Spread rather than assigned outright, so the key is genuinely absent (not
    // present with value `undefined`) when mutation testing wasn't requested --
    // matching a plain `JSON.parse(JSON.stringify(challenge))` round-trip exactly.
    ...(mutationTesting ? { mutationTesting } : {}),
    capturedAt: new Date().toISOString(),
  };

  return { ok: true, challenge: { id: contentId(challenge), ...challenge } };
}

/**
 * Content hash of the parts that define this challenge's grading behaviour
 * (entryName, allowedModules, tests, determinism) -- not `capturedAt` or `oracleSource`, so two
 * captures of the same oracle at the same seed get the same id even if the source
 * has been reformatted, and re-capturing later (after the generator improves)
 * produces a genuinely different id when the tests actually differ.
 */
function contentId(challenge: Pick<Challenge, 'entryName' | 'allowedModules' | 'tests' | 'determinism'>): string {
  const payload = JSON.stringify({
    entryName: challenge.entryName,
    allowedModules: challenge.allowedModules,
    tests: challenge.tests,
    // Same tests under a different clock or seed expect different outcomes.
    determinism: challenge.determinism,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}
