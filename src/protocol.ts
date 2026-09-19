/**
 * The wire contract between the host orchestrator and the sandbox (src/sandbox/harness.ts).
 *
 * Direction of trust:
 *
 *   host  --stdin-->  sandbox   : trusted input, written by us
 *   host  <--fd N---  sandbox   : UNTRUSTED. The sandbox is one single process
 *                                 running the submission directly; there is no
 *                                 privileged component inside it anymore, and
 *                                 nothing else on the host end of this pipe. Every
 *                                 line is reconciled against the expected test-id
 *                                 set (host/orchestrator.ts) and the host enforces
 *                                 timeouts/memory limits from OUTSIDE by killing the
 *                                 whole sandbox process/container -- there is no
 *                                 trusted watcher left inside to do it from within.
 */

import type { EncodedValue, EncodeBudget } from './encoding';

export const PROTOCOL_VERSION = 1 as const;

/** Result-channel fd *inside* the sandbox. Overridden by SANDBOX_RESULT_FD. */
export const DEFAULT_RESULT_FD = 3;

export interface Limits {
  /**
   * Wall-clock budget for a single test call. Enforced by the HOST killing the
   * sandbox process/container from outside (src/host/runner.ts,
   * src/host/docker-runner.ts): nothing inside a single-process sandbox can recover
   * from its own synchronous `while (true) {}`, so there is no longer a live thread
   * inside to call `.terminate()` from -- see the Security model section of README.md.
   */
  perTestTimeoutMs: number;
  /** Total budget for one pass, across every attempt the host makes at it (see `generation` on SandboxRequest). */
  passTimeoutMs: number;
  /** Budget for the whole submission (both passes + container startup), host side. */
  submissionTimeoutMs: number;
  /**
   * V8 old-space cap for the sandbox process, applied via `--max-old-space-size` when
   * the host spawns it (a resourceLimits option only exists for worker_threads, which
   * this no longer uses). Trips before the container memory cgroup does.
   */
  workerMaxOldGenerationMb: number;
  /**
   * Whole-process RSS cap. The sandbox self-reports its own RSS via periodic
   * `heartbeat` lines (nothing outside a single process can poll it without a live
   * thread inside, which no longer exists); the host kills the sandbox if a report
   * exceeds this. Catches memory the V8 heap cap cannot see -- ArrayBuffer backing
   * stores live off-heap. Must sit below the container memory limit so it trips
   * first and reports cleanly; the container cgroup remains the hard backstop for a
   * submission that never yields long enough to send a heartbeat at all.
   */
  maxProcessRssMb: number;
  /** Per-test console capture cap, in bytes. */
  maxConsoleBytesPerTest: number;
  /** Cap on the whole result payload read back by the host, in bytes. */
  maxResultBytes: number;
  /** Cap on unattributed stdio captured from the sandbox, in bytes. */
  maxRawOutputBytes: number;
  encode: EncodeBudget;
  determinism: DeterminismSettings;
}

/**
 * Time and randomness inside the sandbox realm (README decision #2).
 *
 * With `enabled`, every test starts from the same instant and the same random
 * sequence: `Date.now()`, `new Date()`, `Date()` and `Intl.DateTimeFormat#format()`
 * read a logical clock reset to `epochMs`, and `Math.random()` is a PRNG reseeded
 * from `seed` and the test's id. Reset per test, not per pass, so a test sees the
 * same values wherever the shuffled pass puts it, and a rewrite sees exactly what
 * the oracle saw for that test id.
 */
export interface DeterminismSettings {
  enabled: boolean;
  /** Instant the clock reads at the start of every test, in ms since the epoch. */
  epochMs: number;
  /**
   * How far each clock read advances the clock. Non-zero so elapsed-time loops
   * (`while (Date.now() - start < 50) {}`) terminate instead of spinning until the
   * per-test timeout, while staying deterministic: the value depends only on how
   * many times the clock was read.
   */
  tickMs: number;
  /** Mixed with each test id to seed that test's `Math.random()` sequence. */
  seed: number;
}

export interface TestInput {
  id: string;
  /** Encoded argument list; decoded inside the sandbox realm. */
  args: EncodedValue;
}

export interface SandboxRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  passId: string;
  entryName: string;
  /**
   * CommonJS JavaScript for the function under test: screened by the import guard
   * and transpiled on the host (see src/transpile.ts). The sandbox never sees TS.
   */
  code: string;
  /**
   * The tests THIS attempt should run -- not necessarily the whole pass. When an
   * earlier attempt this pass hangs or is killed, the host (src/host/runner.ts)
   * starts a fresh sandbox with only the remaining tests; `generation` says which
   * attempt this is, for TestResult.workerGeneration.
   */
  tests: TestInput[];
  generation: number;
  limits: Limits;
}

export type Outcome =
  | { type: 'return'; value: EncodedValue }
  | {
      type: 'thrown';
      errorClass: string;
      message: string;
      /** Present only when a non-Error value was thrown (`throw 42`), to keep it distinguishable. */
      value?: EncodedValue;
    }
  /** Per-test wall-clock budget exhausted; the worker was terminated. */
  | { type: 'timeout'; limitMs: number }
  /** A limit inside the sandbox was hit (worker heap cap, etc.). */
  | { type: 'resource_limit'; limit: 'memory' | 'worker_died'; detail: string }
  /** The harness could not run the test at all (compile error, entry not callable). */
  | { type: 'harness_error'; detail: string };

export interface TestResult {
  testId: string;
  outcome: Outcome;
  /** Encoded argument list *after* the call, to expose functions that mutate inputs. */
  argsAfterCall: EncodedValue;
  /** Truncated. Captured for display only, and never part of the correctness verdict. */
  consoleOutput: string;
  durationMs: number;
  /**
   * Which sandbox attempt ran this test (SandboxRequest.generation). A bump mid-pass
   * means the previous attempt was killed (it hung, or a resource limit fired) and a
   * fresh sandbox took over, so module-level state was reset at that point -- which
   * matters when interpreting the order-sensitivity comparison.
   */
  workerGeneration: number;
}

/**
 * One line on the result channel: plain NDJSON, unsigned. Earlier versions of this
 * protocol had the sandbox sign each line with a per-pass HMAC key, to prove it came
 * from a trusted parent thread rather than the untrusted worker thread sharing its
 * process. That trusted/untrusted split inside one sandbox is gone -- see the
 * Security model section of README.md -- so there is no longer anything for a
 * signature to distinguish: every byte on this channel is the sandbox's own
 * self-report, and the host (src/host/runner.ts, src/host/docker-runner.ts) is the
 * only reader of the private pipe/stream it created for exactly this sandbox
 * instance. `heartbeat` exists so the host can detect an off-heap memory blow-up (V8
 * heap caps don't see ArrayBuffer backing stores) from OUTSIDE, since nothing inside
 * a single-process sandbox can watch itself while running a synchronous test.
 */
export type ResultLine =
  | { kind: 'result'; result: TestResult }
  | { kind: 'heartbeat'; rssBytes: number }
  | { kind: 'pass-end'; passId: string; completed: number }
  | { kind: 'fatal'; passId: string; reason: string; detail: string };

export const DEFAULT_LIMITS: Limits = {
  perTestTimeoutMs: 1_000,
  passTimeoutMs: 30_000,
  submissionTimeoutMs: 120_000,
  workerMaxOldGenerationMb: 64,
  maxProcessRssMb: 192,
  maxConsoleBytesPerTest: 8 * 1024,
  maxResultBytes: 8 * 1024 * 1024,
  maxRawOutputBytes: 256 * 1024,
  encode: {
    maxNodes: 20_000,
    maxDepth: 32,
    maxStringLength: 16_384,
    maxKeys: 1_000,
    maxCollectionEntries: 1_000,
  },
  determinism: {
    enabled: true,
    epochMs: Date.UTC(2025, 0, 1),
    tickMs: 1,
    seed: 0x5eed,
  },
};
