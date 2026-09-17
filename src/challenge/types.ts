/**
 * The persisted artifact this whole repo builds up to: a function's behaviour,
 * captured once from a real implementation (the oracle) as a fixed test suite, so
 * that grading a rewrite against it never again needs the oracle's source or a live
 * re-run of it. This is the literal claim in this repo's own opening line -- "That
 * tool captures a real TypeScript function's behaviour as a fixed test suite, with
 * the original implementation as the oracle" -- made into a concrete, JSON-safe
 * object.
 *
 * Every value here is either a primitive or an `EncodedValue`/`Outcome` (see
 * src/encoding.ts, src/protocol.ts): both are already JSON-safe tagged forms that
 * round-trip `NaN`, `-0`, `Map`, `Date`, cycles, etc. losslessly, so a `Challenge` is
 * plain `JSON.stringify`-able with no further lifting.
 */

import type { EncodedValue } from '../encoding';
import type { Outcome } from '../protocol';

export const CHALLENGE_SCHEMA_VERSION = 1 as const;

export interface ChallengeTest {
  id: string;
  /** Encoded argument list (a single tagged node, so aliasing between arguments survives). */
  args: EncodedValue;
  /** The oracle's own outcome for this input, frozen at capture time. This -- not the oracle source -- is what a rewrite is graded against. */
  expected: Outcome;
}

/**
 * A quality signal recorded at capture time, not re-run on every grade: how many of
 * the suite's own mutants (src/mutator/) survived. Absent when mutation testing
 * wasn't requested during capture. A high `survivedCount` is a prompt to look at
 * `survived`, not an automatic verdict -- see the "equivalent mutants" caveat in
 * README.md.
 */
export interface ChallengeMutationSummary {
  killedCount: number;
  survivedCount: number;
  inconclusiveCount: number;
  mutationScore: number | undefined;
  survived: Array<{ description: string; line: number; column: number }>;
}

export interface Challenge {
  schemaVersion: typeof CHALLENGE_SCHEMA_VERSION;
  /** Content hash of {entryName, allowedModules, tests}; see src/challenge/capture.ts. Stable identity for dedup, independent of when or how it was captured. */
  id: string;
  entryName: string;
  /**
   * Kept for provenance and re-capture (e.g. after the generator improves), not
   * required to grade against this challenge -- gradeAgainstChallenge never reads
   * it, and a Challenge JSON file could have this field stripped for distribution
   * without breaking grading.
   */
  oracleSource: string;
  allowedModules: string[];
  tests: ChallengeTest[];
  /** Test ids the oracle consistently timed out on during capture; recorded, never graded either way (see README decision #4). */
  droppedTestIds: string[];
  generation: {
    seed: number;
  };
  mutationTesting?: ChallengeMutationSummary;
  capturedAt: string;
}
