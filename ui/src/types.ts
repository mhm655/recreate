/**
 * Minimal local mirrors of the harness's API response shapes -- intentionally NOT
 * imported from ts-sandbox-harness. That package's encoder touches Node's Buffer
 * and is meant to run on the server (see ui/server/index.ts); the browser only
 * ever sees the plain JSON these requests/responses carry.
 */

export interface EncodedValue {
  t: string;
  [key: string]: unknown;
}

export interface Outcome {
  type: 'return' | 'thrown' | 'timeout' | 'resource_limit' | 'harness_error';
  value?: EncodedValue;
  errorClass?: string;
  message?: string;
  limitMs?: number;
  limit?: string;
  detail?: string;
}

export interface ChallengeTest {
  id: string;
  args: EncodedValue;
  expected: Outcome;
}

export interface ChallengeMutationSummary {
  killedCount: number;
  survivedCount: number;
  inconclusiveCount: number;
  mutationScore?: number;
  survived: Array<{ description: string; line: number; column: number }>;
}

export interface Challenge {
  schemaVersion: number;
  id: string;
  entryName: string;
  oracleSource: string;
  allowedModules: string[];
  tests: ChallengeTest[];
  droppedTestIds: string[];
  generation: { seed: number };
  mutationTesting?: ChallengeMutationSummary;
  capturedAt: string;
}

export type CaptureResult = { ok: true; challenge: Challenge } | { ok: false; reason: string };

export interface Problem {
  code: string;
  detail: string;
}

export type ChallengeTestVerdict =
  | { testId: string; result: 'match' }
  | { testId: string; result: 'mismatch'; reason: string; expected: Outcome; rewrite: Outcome };

export interface ChallengeGradeReport {
  verdict: 'passed' | 'failed' | 'rewrite_invalid';
  score: number;
  tests: ChallengeTestVerdict[];
  problems: Problem[];
}
