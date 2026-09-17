/**
 * Captures a Challenge from an oracle: analyze -> generate -> run the oracle once
 * -> freeze its own outcomes as the expected results. After this, grading a
 * rewrite (src/challenge/grade.ts) never needs the oracle source again.
 */

import { createHash } from 'node:crypto';

import { analyzeIsolated } from '../analyzer/isolated';
import { dropOracleTimeouts, describeInvalid } from '../evaluator/compare';
import { encodeArgs } from '../encoding';
import { generateTests, type GenerateOptions } from '../generator/generate';
import { evaluate, type EvaluateOptions } from '../host/orchestrator';
import type { GenerateMutantsOptions } from '../mutator/mutate';
import { runMutationTests } from '../mutator/mutation-test';
import { CHALLENGE_SCHEMA_VERSION, type Challenge, type ChallengeMutationSummary } from './types';

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

  const generated = generateTests(analysis.analysis, { seed: options.seed, maxTests: options.maxTests });
  if (!generated.ok) {
    return { ok: false, reason: `oracle is not generatable: ${generated.reason}` };
  }

  const shared = {
    entryName: generated.entryName,
    allowedModules,
    limits: options.limits,
    runner: options.runner,
    seed: options.seed,
  };

  const oracleReport = await evaluate({ source: options.oracleSource, tests: generated.tests, ...shared });
  if (oracleReport.verdict !== 'ok') {
    return { ok: false, reason: describeInvalid('oracle', oracleReport) };
  }

  const { gradedTests, droppedTestIds } = dropOracleTimeouts(oracleReport, generated.tests);
  if (gradedTests.length === 0) {
    return { ok: false, reason: 'every generated test made the oracle time out; nothing left to capture' };
  }

  const tests = gradedTests.map((t) => ({
    id: t.id,
    args: encodeArgs(t.args),
    expected: oracleReport.results[t.id].outcome,
  }));

  let mutationTesting: ChallengeMutationSummary | undefined;
  if (options.mutationTest) {
    const mutantOptions = typeof options.mutationTest === 'object' ? options.mutationTest : undefined;
    const mt = await runMutationTests({
      oracleSource: options.oracleSource,
      tests: generated.tests,
      mutants: mutantOptions,
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
  }

  const challenge: Omit<Challenge, 'id'> = {
    schemaVersion: CHALLENGE_SCHEMA_VERSION,
    entryName: generated.entryName,
    oracleSource: options.oracleSource,
    allowedModules: [...(allowedModules ?? [])],
    tests,
    droppedTestIds,
    generation: { seed: options.seed ?? 1 },
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
 * (entryName, allowedModules, tests) -- not `capturedAt` or `oracleSource`, so two
 * captures of the same oracle at the same seed get the same id even if the source
 * has been reformatted, and re-capturing later (after the generator improves)
 * produces a genuinely different id when the tests actually differ.
 */
function contentId(challenge: Pick<Challenge, 'entryName' | 'allowedModules' | 'tests'>): string {
  const payload = JSON.stringify({
    entryName: challenge.entryName,
    allowedModules: challenge.allowedModules,
    tests: challenge.tests,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}
