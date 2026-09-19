/**
 * Runner interface, plus the local (NOT isolated) development runner.
 *
 * A runner's only job is to get a `SandboxRequest` in and the raw bytes of the
 * result channel out, along with enough process-level detail for the orchestrator
 * to tell "the sandbox reported a failure" apart from "the sandbox was killed".
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import type { SandboxRequest } from '../protocol';
import { supervisePass, type Attempt, type AttemptExit, type SpawnedAttempt } from './supervise';

export interface RunnerResult {
  /** Raw bytes read from the result channel. Untrusted. */
  resultChannel: string;
  /** Console output produced inside the sandbox, plus any runtime diagnostics. Untrusted. */
  rawOutput: string;
  exitCode: number | null;
  signal: string | null;
  /** The host killed it for exceeding the submission budget. */
  hostTimedOut: boolean;
  /** Container-level OOM kill, where the runner can determine it. */
  oomKilled: boolean;
  /** The runner could not start at all (image missing, daemon down, ...). */
  startupError?: string;
  wallMs: number;
}

export interface SandboxRunner {
  readonly name: string;
  /** True isolation, or a development stand-in? Surfaced in every report. */
  readonly isolated: boolean;
  preflight(): Promise<{ ok: boolean; detail: string }>;
  run(request: SandboxRequest, timeoutMs: number): Promise<RunnerResult>;
}

const HARNESS_ENTRY = path.join(__dirname, '..', 'sandbox', 'harness.js');

/**
 * Node flags the harness runs under, both here and in the image ENTRYPOINT
 * (docker/Dockerfile -- keep the two in sync).
 *
 * `--disallow-code-generation-from-strings` is process-wide. The vm context
 * already refuses `eval`/`new Function`; this extends the same refusal to the
 * sandbox's own top-level realm, so code that escapes the context still cannot
 * turn `Function('return process')` into a handle on Node.
 *
 * Considered and rejected: Node's `--permission` model. It would need to be
 * disabled for the sandbox's own legitimate fs/stdio use anyway, at which point it
 * is decoration, not defence.
 */
export const SANDBOX_NODE_FLAGS: readonly string[] = ['--disallow-code-generation-from-strings'];

/**
 * Runs the sandbox as a plain child process on this machine.
 *
 * !! THIS PROVIDES NO SECURITY ISOLATION !!
 *
 * It has the same filesystem, network and credentials as the developer running it.
 * It exists so the inner mechanics -- per-test timeouts, memory limits, the tagged
 * encoding, result-channel reconciliation -- can be exercised on a workstation
 * without a Linux host and gVisor, and so those mechanics are covered by tests that
 * run in CI. Every report produced through it is stamped `isolated: false`, and the
 * CLI refuses it unless `--unsafe-local` is passed explicitly.
 *
 * Do not point this at code you did not write.
 */
export interface LocalRunnerOptions {
  nodeExecutable?: string;
  /**
   * Extra node flags placed before the harness entry. The hostile test suite uses
   * `--require <script>` to simulate an attacker who already controls the sandbox
   * process and attacks the result channel from inside it.
   */
  nodeArgs?: string[];
  env?: Record<string, string>;
}

export class LocalRunner implements SandboxRunner {
  readonly name = 'local (NO ISOLATION)';
  readonly isolated = false;
  private readonly nodeExecutable: string;
  private readonly nodeArgs: string[];
  private readonly extraEnv: Record<string, string>;

  constructor(options: LocalRunnerOptions = {}) {
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.nodeArgs = options.nodeArgs ?? [];
    this.extraEnv = options.env ?? {};
  }

  async preflight(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'local child process; no isolation' };
  }

  run(request: SandboxRequest, timeoutMs: number): Promise<RunnerResult> {
    return supervisePass({
      tests: request.tests,
      limits: request.limits,
      hostTimeoutMs: timeoutMs,
      // Matches STARTUP_GRACE_MS.local in host/orchestrator.ts: a plain child
      // process's cold start (module loading, JIT warmup) is a real, variable cost
      // that isn't the submission's fault.
      startupGraceMs: 8_000,
      passId: request.passId,
      spawnAttempt: (tests, generation) => this.spawnOne(request, tests, generation),
    });
  }

  private spawnOne(request: SandboxRequest, tests: SandboxRequest['tests'], generation: number): SpawnedAttempt {
    const attemptRequest: SandboxRequest = { ...request, tests, generation };
    const cap = request.limits.maxResultBytes;

    const child = spawn(
      this.nodeExecutable,
      [
        ...SANDBOX_NODE_FLAGS,
        `--max-old-space-size=${request.limits.workerMaxOldGenerationMb}`,
        ...this.nodeArgs,
        HARNESS_ENTRY,
      ],
      {
        // fd 3 is a dedicated pipe for results; fd 1 carries console output only.
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...this.extraEnv,
          SANDBOX_RESULT_FD: '3',
          NODE_OPTIONS: '',
          // Same as the container: `getHours()`, `toString()` etc. must not depend on
          // the machine that captured or graded a challenge.
          TZ: 'UTC',
        },
      },
    );

    const resultCallbacks: Array<(chunk: string) => void> = [];
    const rawCallbacks: Array<(chunk: string) => void> = [];
    let resultBytes = 0;

    const resultStream = child.stdio[3] as NodeJS.ReadableStream | null;
    resultStream?.on('data', (chunk: Buffer) => {
      if (resultBytes >= cap) return;
      resultBytes += chunk.byteLength;
      const text = chunk.toString('utf8');
      for (const cb of resultCallbacks) cb(text);
    });
    resultStream?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const cb of rawCallbacks) cb(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const cb of rawCallbacks) cb(text);
    });

    const exited = new Promise<AttemptExit>((resolve) => {
      let settled = false;
      const finish = (exitCode: number | null, signal: string | null, startupError?: string) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode, signal, oomKilled: false, startupError });
      };
      child.on('error', (err) => finish(null, null, `spawn failed: ${err.message}`));
      child.on('close', (code, signal) => finish(code, signal));
    });

    const attempt: Attempt = { exited, kill: () => child.kill('SIGKILL') };

    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(attemptRequest));

    return {
      attempt,
      onResultData: (cb) => resultCallbacks.push(cb),
      onRawData: (cb) => rawCallbacks.push(cb),
    };
  }
}
