#!/usr/bin/env node
/**
 * The harness. Runs INSIDE the container, as the main thread.
 *
 * It owns the result file descriptor and the per-test timers; the worker thread it
 * spawns owns nothing but the untrusted code. The split matters: when a submission
 * enters `while (true) {}`, the worker's event loop is dead and no timer scheduled
 * there can ever fire. This thread is still alive, still has a working event loop,
 * and can call `worker.terminate()` to tear the other isolate down.
 *
 * Channel discipline:
 *   result fd  <- ONLY this thread writes, and only signed lines (src/channel.ts)
 *   raw fd     <- the worker's stdout/stderr, forwarded verbatim and capped
 *
 * Untrusted code can also write to the result fd (fds are process-wide), which is
 * exactly why every line is signed and why the host reconciles the test-id set.
 *
 * Worker lifecycle within a pass:
 *   One worker runs every test in the pass, on purpose. Module-level state, caches,
 *   counters and prototype pollution are meant to persist between tests here --
 *   that leakage is the thing the ordered/shuffled double run is designed to
 *   detect. Workers are never reused across passes or across submissions.
 *
 *   When a worker has to be killed (timeout or heap cap) a fresh one takes over and
 *   `workerGeneration` increments, which tells the host that module state was reset
 *   partway through and the order-sensitivity comparison for later tests in that
 *   pass is weaker evidence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import { frame } from '../channel';
import { encodeArgs } from '../encoding';
import {
  DEFAULT_RESULT_FD,
  PROTOCOL_VERSION,
  type FromWorker,
  type Outcome,
  type ResultLine,
  type SandboxRequest,
  type TestInput,
  type TestResult,
  type ToWorker,
} from '../protocol';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// --- fd plumbing ----------------------------------------------------------

const resultFd = Number(process.env.SANDBOX_RESULT_FD ?? DEFAULT_RESULT_FD);
// Whatever fd the results are NOT on carries the untrusted console stream. Under
// Docker the result channel is fd 1, because `docker run` only forwards three
// descriptors into the container; locally it is a real fd 3. Either way the two
// streams never share a descriptor.
const rawFd = resultFd === 1 ? 2 : 1;

/**
 * Pipes can be non-blocking, in which case `writeSync` throws EAGAIN rather than
 * blocking. Retrying is the standard workaround; results must not be dropped.
 */
function writeFdSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EPIPE') return;
      throw err;
    }
  }
}

let rawBytesWritten = 0;
function writeRaw(text: string, cap: number): void {
  if (rawBytesWritten >= cap) return;
  const remaining = cap - rawBytesWritten;
  const slice = text.length > remaining ? `${text.slice(0, remaining)}\n[sandbox output truncated]\n` : text;
  rawBytesWritten += Buffer.byteLength(slice, 'utf8');
  try {
    writeFdSync(rawFd, slice);
  } catch {
    /* never let console capture break the run */
  }
}

// --- request ingestion ----------------------------------------------------

function readRequest(): SandboxRequest {
  const raw = fs.readFileSync(0);
  if (raw.byteLength > MAX_REQUEST_BYTES) throw new Error('request payload too large');
  const req = JSON.parse(raw.toString('utf8')) as SandboxRequest;
  if (req.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${String(req.protocolVersion)}`);
  }
  if (!Array.isArray(req.tests)) throw new Error('request.tests must be an array');
  return req;
}

// --- worker supervision ---------------------------------------------------

type RunOutcome =
  | { kind: 'done'; outcome: Outcome; argsAfterCall: TestResult['argsAfterCall']; consoleOutput: string; durationMs: number }
  | { kind: 'timeout' }
  | { kind: 'died'; limit: 'memory' | 'worker_died'; detail: string };

class WorkerSupervisor {
  private worker: Worker | null = null;
  private pending:
    | { testId: string; resolve: (r: RunOutcome) => void; timer: NodeJS.Timeout }
    | null = null;
  private readyWaiters: Array<(r: { ok: true } | { ok: false; detail: string }) => void> = [];
  private initFailure: string | null = null;
  /** Teardown of the previous worker; awaited before a replacement is spawned. */
  private terminating: Promise<unknown> = Promise.resolve();
  generation = 0;

  constructor(
    private readonly req: SandboxRequest,
    private readonly workerPath: string,
  ) {}

  /** Spawn a worker if needed and wait for it to finish compiling the submission. */
  async ensure(): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (this.initFailure) return { ok: false, detail: this.initFailure };
    if (this.worker) return { ok: true };

    // Let the killed worker's isolate actually go away first, so its memory is not
    // still counted against the RSS watchdog when the replacement starts.
    await this.terminating;

    this.generation += 1;
    const worker = new Worker(this.workerPath, {
      // The result-channel HMAC key is NOT here, and must never be. Untrusted code
      // runs in this thread.
      workerData: {
        code: this.req.code,
        entryName: this.req.entryName,
        limits: this.req.limits,
      },
      // Keep the worker's stdio off the real descriptors so it can be capped and
      // routed to the raw channel rather than interleaved with results.
      stdout: true,
      stderr: true,
      resourceLimits: {
        maxOldGenerationSizeMb: this.req.limits.workerMaxOldGenerationMb,
        maxYoungGenerationSizeMb: this.req.limits.workerMaxYoungGenerationMb,
      },
    });
    this.worker = worker;

    worker.stdout.on('data', (chunk: Buffer) =>
      writeRaw(chunk.toString('utf8'), this.req.limits.maxRawOutputBytes));
    worker.stderr.on('data', (chunk: Buffer) =>
      writeRaw(chunk.toString('utf8'), this.req.limits.maxRawOutputBytes));

    worker.on('message', (msg: FromWorker) => this.onMessage(msg));
    worker.on('error', (err: Error) => this.onDeath(classifyWorkerError(err)));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.onDeath({ limit: 'worker_died', detail: `worker exited with code ${code}` });
      }
    });

    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
    });
  }

  private onMessage(msg: FromWorker): void {
    if (msg.kind === 'ready') {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w({ ok: true });
      return;
    }
    if (msg.kind === 'init-failed') {
      // A compile failure is deterministic: respawning would fail identically, so
      // remember it and stop trying.
      this.initFailure = msg.detail;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w({ ok: false, detail: msg.detail });
      return;
    }
    if (msg.kind === 'done') {
      const p = this.pending;
      if (!p || p.testId !== msg.testId) return; // stale reply from a killed worker
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve({
        kind: 'done',
        outcome: msg.outcome,
        argsAfterCall: msg.argsAfterCall,
        consoleOutput: msg.consoleOutput,
        durationMs: msg.durationMs,
      });
    }
  }

  /** True while a test is executing, which is the only time the watchdog may act. */
  get busy(): boolean {
    return this.pending !== null;
  }

  /** Called by the RSS watchdog. */
  killForMemory(detail: string): void {
    this.onDeath({ limit: 'memory', detail });
  }

  private onDeath(info: { limit: 'memory' | 'worker_died'; detail: string }): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) this.terminating = worker.terminate().catch(() => {});

    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w({ ok: false, detail: info.detail });

    const p = this.pending;
    if (p) {
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve({ kind: 'died', limit: info.limit, detail: info.detail });
    }
  }

  run(test: TestInput): Promise<RunOutcome> {
    const worker = this.worker;
    if (!worker) return Promise.resolve({ kind: 'died', limit: 'worker_died', detail: 'no worker' });

    return new Promise<RunOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // THE reason a worker thread is used at all. A synchronous infinite loop in
        // the worker cannot be interrupted from within; terminate() kills the
        // isolate from this thread, which still has a live event loop.
        if (this.pending && this.pending.testId === test.id) {
          this.pending = null;
          const w = this.worker;
          this.worker = null;
          if (w) this.terminating = w.terminate().catch(() => {});
          resolve({ kind: 'timeout' });
        }
      }, this.req.limits.perTestTimeoutMs);
      // Do not let the timer itself keep the process alive past the run.
      if (typeof timer.unref === 'function') timer.unref();

      this.pending = { testId: test.id, resolve, timer };
      const msg: ToWorker = { kind: 'run', testId: test.id, args: test.args };
      try {
        worker.postMessage(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        resolve({ kind: 'died', limit: 'worker_died', detail: `postMessage failed: ${String(err)}` });
      }
    });
  }

  /** Kill the current worker, resolving any in-flight test with `reason`. */
  async dispose(reason = 'pass finished'): Promise<void> {
    if (this.worker) this.onDeath({ limit: 'worker_died', detail: reason });
    await this.terminating;
  }
}

function classifyWorkerError(err: Error): { limit: 'memory' | 'worker_died'; detail: string } {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return { limit: 'memory', detail: 'worker exceeded its V8 heap limit' };
  }
  return { limit: 'worker_died', detail: `${err.name}: ${err.message}`.slice(0, 500) };
}

// --- main -----------------------------------------------------------------

async function main(): Promise<number> {
  let req: SandboxRequest;
  try {
    req = readRequest();
  } catch (err) {
    // No key means no signable channel, so there is nowhere trustworthy to report.
    // Exit non-zero and let the host classify it from the exit code.
    process.stderr.write(`harness: bad request: ${String(err)}\n`);
    return 64;
  }

  // Held only here, in this thread's heap. Never passed to the worker.
  const resultKey = req.resultKey;
  const emit = (line: ResultLine) => writeFdSync(resultFd, frame(resultKey, line));

  const workerPath = path.join(__dirname, 'worker.js');
  const sup = new WorkerSupervisor(req, workerPath);

  let passTimedOut = false;
  const passTimer = setTimeout(() => {
    passTimedOut = true;
    void sup.dispose(`pass time budget of ${req.limits.passTimeoutMs}ms exhausted`);
  }, req.limits.passTimeoutMs);
  if (typeof passTimer.unref === 'function') passTimer.unref();

  // Off-heap memory watchdog. `resourceLimits` on the worker caps the V8 heap, but
  // ArrayBuffer backing stores are allocated outside it, so
  // `while (true) bufs.push(new Uint8Array(1e8).fill(1))` sails straight past the
  // heap cap. This thread polls whole-process RSS and kills the worker first, so the
  // failure is a clean per-test `resource_limit` rather than the container's OOM
  // killer taking out the harness and every unreported result with it. A fast
  // allocator can overshoot by one polling interval; the container limit is set
  // above this cap to absorb that.
  const rssCapBytes = req.limits.maxProcessRssMb * 1024 * 1024;
  const watchdog = setInterval(() => {
    if (!sup.busy) return;
    const rss = process.memoryUsage.rss();
    if (rss > rssCapBytes) {
      sup.killForMemory(
        `process RSS ${Math.round(rss / 1048576)}MB exceeded ${req.limits.maxProcessRssMb}MB (off-heap allocation)`,
      );
    }
  }, 10);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  const emptyArgs = encodeArgs([]);
  let completed = 0;

  for (const test of req.tests) {
    if (passTimedOut) break;

    const started = Date.now();
    const ready = await sup.ensure();
    if (!ready.ok) {
      // Compile failure, or a worker that will not start. Report per test so the
      // host still sees a complete, reconcilable result set.
      emit({
        kind: 'result',
        result: {
          testId: test.id,
          outcome: { type: 'harness_error', detail: ready.detail },
          argsAfterCall: emptyArgs,
          consoleOutput: '',
          durationMs: Date.now() - started,
          workerGeneration: sup.generation,
        },
      });
      completed += 1;
      continue;
    }

    const generation = sup.generation;
    const r = await sup.run(test);

    let result: TestResult;
    if (r.kind === 'done') {
      result = {
        testId: test.id,
        outcome: r.outcome,
        argsAfterCall: r.argsAfterCall,
        consoleOutput: r.consoleOutput,
        durationMs: r.durationMs,
        workerGeneration: generation,
      };
    } else if (r.kind === 'timeout') {
      result = {
        testId: test.id,
        outcome: { type: 'timeout', limitMs: req.limits.perTestTimeoutMs },
        // The worker is gone, so post-call argument state is unknowable. Reporting
        // the pre-call encoding would be a lie; report nothing instead.
        argsAfterCall: { t: 'unsupported', kind: 'worker-terminated' },
        consoleOutput: '',
        durationMs: Date.now() - started,
        workerGeneration: generation,
      };
    } else {
      result = {
        testId: test.id,
        outcome: { type: 'resource_limit', limit: r.limit, detail: r.detail },
        argsAfterCall: { t: 'unsupported', kind: 'worker-terminated' },
        consoleOutput: '',
        durationMs: Date.now() - started,
        workerGeneration: generation,
      };
    }

    emit({ kind: 'result', result });
    completed += 1;
  }

  clearTimeout(passTimer);
  clearInterval(watchdog);
  await sup.dispose();

  if (passTimedOut) {
    emit({
      kind: 'fatal',
      passId: req.passId,
      reason: 'pass_timeout',
      detail: `pass exceeded ${req.limits.passTimeoutMs}ms after ${completed} of ${req.tests.length} tests`,
    });
  }

  emit({
    kind: 'pass-end',
    passId: req.passId,
    workerGenerations: sup.generation,
    completed,
  });
  return 0;
}

main().then(
  (code) => {
    // Untrusted code may have left handles behind; do not wait on them.
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`harness: fatal: ${String(err)}\n`);
    process.exit(70);
  },
);
