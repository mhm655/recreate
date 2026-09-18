/**
 * Runs one pass to completion, transparently starting a fresh sandbox attempt
 * (with only the tests not yet reported) whenever the current one hangs, exceeds
 * its memory budget, or dies unexpectedly.
 *
 * This plays the role `WorkerSupervisor` used to play INSIDE the old in-container
 * harness, spawning fresh worker THREADS when one died mid-pass. That role moved
 * here, to the host, spawning fresh whole processes/containers instead, because
 * there is no longer a live thread inside the sandbox that could recover from its
 * own hang -- see README.md's Security model section. `LocalRunner` and
 * `DockerRunner` each only need to know how to spawn ONE attempt and how to kill
 * one; this drives the retry loop and stitches every attempt's output into one
 * `RunnerResult`, exactly the shape `reconcile()` (host/orchestrator.ts) already
 * expects.
 */

import { frame } from '../channel';
import type { Limits, Outcome, ResultLine, TestInput } from '../protocol';
import type { RunnerResult } from './runner';

/** A small buffer beyond `perTestTimeoutMs` to absorb IPC/scheduling jitter before calling it a hang. */
const HANG_GRACE_MS = 300;

export interface AttemptExit {
  exitCode: number | null;
  signal: string | null;
  /** True if the runner can determine the attempt was killed for exceeding a memory limit (e.g. a container's memory cgroup). */
  oomKilled: boolean;
  startupError?: string;
}

export interface Attempt {
  /** Resolves once the underlying process/container has actually exited, however that happened. */
  exited: Promise<AttemptExit>;
  /** Force-terminate the underlying process/container. Safe to call after it has already exited. */
  kill(): void;
}

export interface SpawnedAttempt {
  attempt: Attempt;
  /** Fires with each chunk of the result channel as it arrives. */
  onResultData: (cb: (chunk: string) => void) => void;
  /** Fires with each chunk of captured console/diagnostic output as it arrives. */
  onRawData: (cb: (chunk: string) => void) => void;
}

/** Tracks what has arrived on one attempt's result stream without re-parsing everything on every chunk. */
class ResultStreamWatcher {
  private buffer = '';
  private scanned = 0;
  lastActivityAt = Date.now();
  /** True once this attempt has produced at least one complete line -- see supervisePass's startup-vs-hang distinction. */
  everActive = false;
  lastRssBytes: number | undefined;
  readonly completedTestIds = new Set<string>();
  passEnded = false;

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n', this.scanned)) !== -1) {
      const line = this.buffer.slice(this.scanned, idx);
      this.scanned = idx + 1;
      this.lastActivityAt = Date.now();
      this.everActive = true;
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ResultLine;
        if (parsed.kind === 'result') this.completedTestIds.add(parsed.result.testId);
        else if (parsed.kind === 'heartbeat') this.lastRssBytes = parsed.rssBytes;
        else if (parsed.kind === 'pass-end') this.passEnded = true;
      } catch {
        /* malformed lines are dealt with by reconcile()'s own parsing; this pass only tracks progress */
      }
    }
  }

  get fullText(): string {
    return this.buffer;
  }
}

export async function supervisePass(opts: {
  tests: TestInput[];
  limits: Limits;
  /** Wall-clock budget for the WHOLE pass, across every attempt. */
  hostTimeoutMs: number;
  /**
   * How long a FRESH attempt gets before its own silence counts as a hang, before
   * it has ever produced a single line (a heartbeat or a result). Process/container
   * cold start is a real, variable cost that is not the submission's fault -- a
   * slow-starting sandbox must not be blamed for a timeout it never got a chance to
   * run into. Once an attempt has produced its first line, the much tighter
   * `perTestTimeoutMs`-based check applies instead.
   */
  startupGraceMs: number;
  passId: string;
  spawnAttempt: (tests: TestInput[], generation: number) => SpawnedAttempt;
}): Promise<RunnerResult> {
  const startedAt = Date.now();
  const deadline = startedAt + opts.hostTimeoutMs;
  const rssCapBytes = opts.limits.maxProcessRssMb * 1024 * 1024;
  const hangThresholdMs = opts.limits.perTestTimeoutMs + HANG_GRACE_MS;

  if (opts.tests.length === 0) {
    return {
      resultChannel: frame({ kind: 'pass-end', passId: opts.passId, completed: 0 } satisfies ResultLine),
      rawOutput: '',
      exitCode: 0,
      signal: null,
      hostTimedOut: false,
      oomKilled: false,
      wallMs: Date.now() - startedAt,
    };
  }

  let remaining = opts.tests;
  let generation = 0;
  let resultChannel = '';
  let rawOutput = '';
  let hostTimedOut = false;
  let last: AttemptExit = { exitCode: null, signal: null, oomKilled: false };

  while (remaining.length > 0) {
    generation += 1;
    if (Date.now() >= deadline) {
      hostTimedOut = true;
      break;
    }

    const attemptStartedAt = Date.now();
    const watcher = new ResultStreamWatcher();
    let attemptRawOutput = '';
    const spawned = opts.spawnAttempt(remaining, generation);
    spawned.onResultData((chunk) => watcher.feed(chunk));
    spawned.onRawData((chunk) => {
      attemptRawOutput += chunk;
      if (rawOutput.length < opts.limits.maxRawOutputBytes) rawOutput += chunk;
    });

    let killReason: 'silence' | 'rss' | 'deadline' | null = null;
    const poll = setInterval(() => {
      if (Date.now() >= deadline) {
        killReason = 'deadline';
        hostTimedOut = true;
        spawned.attempt.kill();
      } else if (watcher.lastRssBytes !== undefined && watcher.lastRssBytes > rssCapBytes) {
        killReason = 'rss';
        spawned.attempt.kill();
      } else if (watcher.everActive ? Date.now() - watcher.lastActivityAt >= hangThresholdMs : Date.now() - attemptStartedAt >= opts.startupGraceMs) {
        killReason = 'silence';
        spawned.attempt.kill();
      }
    }, 10);

    last = await spawned.attempt.exited;
    clearInterval(poll);
    resultChannel += watcher.fullText;

    if (watcher.passEnded && killReason === null) break; // clean completion of this attempt

    const done = watcher.completedTestIds;
    const stillRemaining = remaining.filter((t) => !done.has(t.id));
    if (stillRemaining.length === 0) break; // every test reported, even without a clean pass-end (e.g. crashed right after the last one)

    const inFlight = stillRemaining[0];
    // V8's own --max-old-space-size cap (workerMaxOldGenerationMb) kills the WHOLE
    // process with an uncatchable native fatal error, not a JS exception -- there is
    // no parent thread left to turn that into a clean resource_limit the way
    // worker_threads' `resourceLimits` option used to. V8 does print a recognisable
    // message before it dies, which is the only way left to tell "hit its heap cap"
    // apart from any other reason the process might have died.
    //
    // Checked regardless of killReason, not just when the process died on its own:
    // V8 printing the message and actually exiting is a race against our OWN
    // silence-timeout (killReason === 'silence'/'rss'), and on a slower host V8 can
    // still be in the middle of dying -- has already written the message to stderr,
    // just hasn't exited yet -- when our timeout fires and we SIGKILL it first. The
    // message having appeared at all is a strictly more informative signal than "we
    // gave up waiting", so it takes precedence. (rawOutput is already documented
    // elsewhere as diagnostic-only, never part of the correctness verdict; using it
    // as a weak heuristic for outcome classification is consistent with that.)
    const v8HeapOom = /heap out of memory|FATAL ERROR: Reached heap limit/i.test(attemptRawOutput);
    const outcome: Outcome =
      last.oomKilled || killReason === 'rss' || v8HeapOom
        ? { type: 'resource_limit', limit: 'memory', detail: `sandbox exceeded its memory budget while running '${inFlight.id}'` }
        : killReason === 'silence' || killReason === 'deadline'
          ? { type: 'timeout', limitMs: opts.limits.perTestTimeoutMs }
          : {
              type: 'resource_limit',
              limit: 'worker_died',
              detail: last.startupError ?? `sandbox exited unexpectedly while running '${inFlight.id}' (code ${String(last.exitCode)}, signal ${String(last.signal)})`,
            };
    resultChannel += frame({
      kind: 'result',
      result: {
        testId: inFlight.id,
        outcome,
        argsAfterCall: { t: 'unsupported', kind: 'sandbox-terminated' },
        consoleOutput: '',
        durationMs: 0,
        workerGeneration: generation,
      },
    } satisfies ResultLine);

    if (hostTimedOut) break;
    remaining = stillRemaining.slice(1);
  }

  // Every id in opts.tests now has a result somewhere in resultChannel -- either
  // from a clean attempt or synthesized above -- UNLESS the loop broke because the
  // overall pass ran out of time, in which case leaving no pass-end line is correct:
  // reconcile() (host/orchestrator.ts) is supposed to see this as incomplete. A
  // clean attempt's OWN pass-end line, if the last attempt happened to end this way,
  // is harmless noise here -- reconcile() takes the last pass-end line on the
  // channel, and this one has the correct total either way.
  if (!hostTimedOut) {
    resultChannel += frame({ kind: 'pass-end', passId: opts.passId, completed: opts.tests.length } satisfies ResultLine);
  }

  // reconcile() (host/orchestrator.ts) reads exitCode/signal/oomKilled as "how did
  // the sandbox end" to decide whether the WHOLE pass is resource_limit_exceeded.
  // last.* is whichever attempt happened to run last -- if THAT one was killed for
  // hanging on the pass's very last test (no further attempt was needed once it was
  // synthesized above), last.signal is still 'SIGKILL' even though the pass as a
  // whole succeeded. A retry that happened along the way is already visible via
  // each TestResult's own workerGeneration; exitCode/signal should reflect the
  // pass's actual outcome, not an intermediate attempt's.
  const succeeded = !hostTimedOut;
  return {
    resultChannel,
    rawOutput,
    exitCode: succeeded ? 0 : last.exitCode,
    signal: succeeded ? null : last.signal,
    hostTimedOut,
    oomKilled: succeeded ? false : last.oomKilled,
    startupError: succeeded ? undefined : last.startupError,
    wallMs: Date.now() - startedAt,
  };
}
