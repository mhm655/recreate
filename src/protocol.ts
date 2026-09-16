/**
 * The wire contract between the host orchestrator and the in-container harness.
 *
 * Direction of trust:
 *
 *   host  --stdin-->  harness   : trusted input, written by us
 *   host  <--fd N---  harness   : UNTRUSTED. The harness parent thread is honest,
 *                                 but it shares a process with the worker thread
 *                                 running attacker code, and file descriptors are
 *                                 process-wide. Anything arriving on this channel
 *                                 is treated as hostile until it has been HMAC
 *                                 verified and reconciled against the expected
 *                                 test-id set. See docs in host/orchestrator.ts.
 */

import type { EncodedValue, EncodeBudget } from './encoding';

export const PROTOCOL_VERSION = 1 as const;

/** Result-channel fd *inside* the sandbox. Overridden by SANDBOX_RESULT_FD. */
export const DEFAULT_RESULT_FD = 3;

export interface Limits {
  /** Wall-clock budget for a single test call, enforced by worker.terminate(). */
  perTestTimeoutMs: number;
  /** Budget for one whole pass, enforced inside the container. */
  passTimeoutMs: number;
  /** Budget for the whole submission (both passes + container startup), host side. */
  submissionTimeoutMs: number;
  /** V8 old-space cap for the worker. Trips before the container memory cgroup does. */
  workerMaxOldGenerationMb: number;
  workerMaxYoungGenerationMb: number;
  /**
   * Whole-process RSS cap, polled from the harness parent thread. Catches memory the
   * V8 heap cap cannot see -- ArrayBuffer backing stores live off-heap. Must sit
   * below the container memory limit so it trips first and reports cleanly; the
   * container cgroup remains the hard backstop.
   */
  maxProcessRssMb: number;
  /** Per-test console capture cap, in bytes. */
  maxConsoleBytesPerTest: number;
  /** Cap on the whole result payload read back by the host, in bytes. */
  maxResultBytes: number;
  /** Cap on unattributed stdio captured from the sandbox, in bytes. */
  maxRawOutputBytes: number;
  encode: EncodeBudget;
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
  /**
   * Per-run HMAC key for the result channel. Read by the harness parent thread and
   * kept only in its JS heap: never placed in env, workerData, or on disk, so that
   * JS running in the worker cannot read it. (Not a hard boundary -- see README.)
   */
  resultKey: string;
  entryName: string;
  /**
   * CommonJS JavaScript for the function under test: screened by the import guard
   * and transpiled on the host (see src/transpile.ts). The sandbox never sees TS.
   */
  code: string;
  tests: TestInput[];
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
   * Which worker instance ran this test. A bump mid-pass means the previous worker
   * was killed, so module-level state was reset at that point -- which matters when
   * interpreting the order-sensitivity comparison.
   */
  workerGeneration: number;
}

/** One line on the result channel. */
export type ResultLine =
  | { kind: 'result'; result: TestResult }
  | { kind: 'pass-end'; passId: string; workerGenerations: number; completed: number }
  | { kind: 'fatal'; passId: string; reason: string; detail: string };

/** Messages parent thread -> worker thread (inside the sandbox). */
export type ToWorker = { kind: 'run'; testId: string; args: EncodedValue };

/** Messages worker thread -> parent thread (inside the sandbox). */
export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'init-failed'; detail: string }
  | {
      kind: 'done';
      testId: string;
      outcome: Outcome;
      argsAfterCall: EncodedValue;
      consoleOutput: string;
      durationMs: number;
    };

export const DEFAULT_LIMITS: Limits = {
  perTestTimeoutMs: 1_000,
  passTimeoutMs: 30_000,
  submissionTimeoutMs: 120_000,
  workerMaxOldGenerationMb: 64,
  workerMaxYoungGenerationMb: 16,
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
};
