#!/usr/bin/env node
/**
 * The sandbox entry point. Runs INSIDE the container, as a single process.
 *
 * SECURITY MODEL -- read this before changing anything here.
 *
 *   This whole process is UNTRUSTED. There is no privileged component inside it:
 *   no separate thread holding a signing key, nothing that could be "escaped into"
 *   for extra capability. Earlier versions split this into a privileged "harness"
 *   thread (held a per-pass HMAC key, signed every result line) and an unprivileged
 *   "worker" thread (ran the submission) -- but a worker thread shares its parent's
 *   OS process, address space and file descriptors, so that key was only ever one
 *   `/proc/self/mem` read away from a submission that fully escaped the `vm`
 *   context below. Removing the split removes that exposure entirely: there is
 *   nothing secret inside this process for an escape to find. See the Security
 *   model section of README.md for the full reasoning and what replaces it.
 *
 *   The actual security boundary is the gVisor (`runsc`) container around this
 *   process: no network, read-only root filesystem, dropped capabilities,
 *   non-root user, seccomp, and cgroup limits on CPU/memory/pids.
 *
 *   Because there is only one process, nothing in here can recover from its own
 *   synchronous `while (true) {}` -- there is no longer a second, still-alive
 *   thread able to call `.terminate()` on a hung one. Per-test timeouts and the
 *   memory watchdog are therefore the HOST's job now (src/host/runner.ts,
 *   src/host/docker-runner.ts): it watches the result channel from outside and
 *   kills this whole process/container if it stops making progress. `heartbeat`
 *   lines below exist so the host can also catch off-heap memory growth that
 *   happens to yield to the event loop, before it becomes a hard OOM kill --  but a
 *   fully synchronous resource bomb (nothing yields, ever) is caught only by the
 *   host's silence timeout, or by the container's memory cgroup, exactly like a
 *   fully synchronous infinite loop is. Both are still always caught; which one is
 *   reported for a given test is limited by what's actually observable.
 *
 * The `vm` context is a third thing again, and also not a security boundary. It is
 * REALM HYGIENE. Untrusted code gets a fresh set of intrinsics, so that when it does
 * `Object.prototype.x = 1` or `Array = evil`, the damage is confined to that realm
 * and cannot corrupt the encoder, the message plumbing, or the argument decoder --
 * all of which run in this module's realm and would otherwise be reading through a
 * poisoned prototype chain while reporting results.
 *
 * Note what is deliberately absent from the vm context: `require`, `process`, `fs`,
 * timers, `fetch`. A bare vm context has JS intrinsics and nothing else; the only
 * global added is a capturing `console`.
 *
 * Channel discipline:
 *   result fd  <- this process writes plain, unsigned NDJSON (src/channel.ts)
 *   raw fd     <- the submission's captured console output, forwarded verbatim and capped
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { frame } from '../channel';
import {
  captureRealm,
  decode,
  encode,
  encodeArgs,
  normalizeErrorMessage,
  type EncodedValue,
  type Realm,
} from '../encoding';
import {
  DEFAULT_RESULT_FD,
  PROTOCOL_VERSION,
  type Outcome,
  type ResultLine,
  type SandboxRequest,
  type TestInput,
  type TestResult,
} from '../protocol';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 50;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// A rejected promise from untrusted code must not take this process down; it would
// look like a crash and cost the rest of the pass.
process.on('unhandledRejection', () => {});

// --- fd plumbing ------------------------------------------------------------

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

function emit(line: ResultLine): void {
  writeFdSync(resultFd, frame(line));
}

// --- request ingestion -------------------------------------------------------

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

// --- console capture ---------------------------------------------------------

let consoleBuffer = '';
let consoleBytes = 0;
let consoleTruncated = false;

function resetConsole(): void {
  consoleBuffer = '';
  consoleBytes = 0;
  consoleTruncated = false;
}

function takeConsole(): string {
  return consoleTruncated ? `${consoleBuffer}\n[console output truncated]` : consoleBuffer;
}

function captureLine(parts: unknown[], maxBytes: number): void {
  if (consoleTruncated) return;
  let line: string;
  try {
    line = parts.map(formatForConsole).join(' ');
  } catch {
    line = '[unformattable console arguments]';
  }
  const chunk = `${line}\n`;
  const size = Buffer.byteLength(chunk, 'utf8');
  if (consoleBytes + size > maxBytes) {
    consoleTruncated = true;
    return;
  }
  consoleBytes += size;
  consoleBuffer += chunk;
}

function formatForConsole(v: unknown, depth = 0): string {
  switch (typeof v) {
    case 'string':
      return depth === 0 ? v : JSON.stringify(v);
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint':
      return `${v}n`;
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return String(v);
    case 'symbol':
      return String(v);
    case 'function':
      return `[Function: ${(v as { name?: string }).name || 'anonymous'}]`;
    default:
      break;
  }
  if (v === null) return 'null';
  if (depth >= 3) return '[deep]';
  try {
    if (Array.isArray(v)) {
      return `[ ${v.slice(0, 20).map((x) => formatForConsole(x, depth + 1)).join(', ')}${v.length > 20 ? ', ...' : ''} ]`;
    }
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Error]') return `${(v as Error).name}: ${(v as Error).message}`;
    if (tag === '[object Date]') return new Date(Date.prototype.valueOf.call(v as Date)).toISOString();
    if (tag === '[object RegExp]') return String(v);
    const keys = Object.keys(v as object).slice(0, 20);
    const body = keys
      .map((k) => `${k}: ${formatForConsole((v as Record<string, unknown>)[k], depth + 1)}`)
      .join(', ');
    return `{ ${body}${Object.keys(v as object).length > 20 ? ', ...' : ''} }`;
  } catch {
    return '[uninspectable]';
  }
}

// --- compilation --------------------------------------------------------------

interface Compiled {
  fn: (...args: unknown[]) => unknown;
  realm: Realm;
  /** Present when time/randomness are frozen: rewinds the clock and reseeds before a test. */
  determinism?: { reset(seed: number): void };
}

/**
 * Replaces the context's `Date`, `Math.random` and `Intl.DateTimeFormat#format` with
 * deterministic versions (README decision #2; see DeterminismSettings).
 *
 * Built INSIDE the context from source text, so every function user code can reach
 * belongs to the context's own realm; a harness-realm closure would hand user code a
 * path to this realm's `Function` constructor via `.constructor`.
 *
 * `Date` becomes a Proxy over the real constructor rather than a subclass, so
 * `x instanceof Date`, `Date.prototype`, `Date.UTC`/`Date.parse` and dates decoded
 * from test arguments all keep working unchanged. Only the zero-argument forms read
 * the clock; `new Date(ms)` and friends are already deterministic and pass through.
 */
const DETERMINISM_SHIM = `(function (epochMs, tickMs) {
  'use strict';
  const RealDate = Date;
  let clock = epochMs;
  let state = 0;
  const read = () => { const t = clock; clock += tickMs; return t; };
  const random = () => {
    // mulberry32: tiny, fast, and fully determined by its 32-bit state.
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const FrozenDate = new Proxy(RealDate, {
    // \`Date()\` called as a function ignores its arguments and stringifies "now".
    apply() { return new RealDate(read()).toString(); },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [read()] : args, newTarget);
    },
  });
  const define = (obj, key, value) =>
    Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
  define(RealDate, 'now', function now() { return read(); });
  // Otherwise \`new (new Date()).constructor()\` would reach the unfrozen constructor.
  define(RealDate.prototype, 'constructor', FrozenDate);
  define(globalThis, 'Date', FrozenDate);
  define(Math, 'random', function random_() { return random(); });

  // Intl formatters default to "now" when called with no date.
  const dtf = Intl.DateTimeFormat.prototype;
  const formatGetter = Object.getOwnPropertyDescriptor(dtf, 'format').get;
  Object.defineProperty(dtf, 'format', {
    configurable: true,
    get() {
      const bound = formatGetter.call(this);
      return function format(date) { return bound(date === undefined ? read() : date); };
    },
  });
  const formatToParts = dtf.formatToParts;
  define(dtf, 'formatToParts', function formatToParts_(date) {
    return formatToParts.call(this, date === undefined ? read() : date);
  });

  return { reset(seed) { clock = epochMs; state = seed | 0; } };
})`;

/** FNV-1a over the settings seed and the test id: a stable 32-bit seed per test. */
function testSeed(seed: number, testId: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < testId.length; i++) {
    h ^= testId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function compile(req: SandboxRequest): Compiled {
  const context = vm.createContext(Object.create(null), {
    name: 'submission',
    codeGeneration: {
      // `eval` and `new Function` inside the context are pointless to allow and
      // would only widen what static screening has to reason about.
      strings: false,
      wasm: false,
    },
  });

  // Alias `global` to this context's own globalThis, matching the one thing real
  // Node CJS modules would otherwise see. Without it, a vendored CommonJS
  // dependency (see src/bundle.ts) that probes `typeof global` and falls through to
  // `Function('return this')()` -- lodash-es does exactly this -- hits the disabled
  // string-code-generation guard below and throws. This adds no capability: `global`
  // here is the same restricted, freshly-captured realm as `globalThis`, not Node's.
  vm.runInContext('globalThis.global = globalThis', context);

  // Snapshot intrinsics NOW, before any untrusted code runs, so that a later
  // `globalThis.Array = attacker` cannot influence how arguments are constructed.
  const realm = captureRealm(vm.runInContext('globalThis', context));

  // After captureRealm, so argument decoding keeps using the real Date constructor;
  // before the submission's module code runs, so module-scope reads such as
  // `const STARTED = Date.now()` are frozen too.
  const settings = req.limits.determinism;
  const determinism = settings?.enabled
    ? (vm.runInContext(DETERMINISM_SHIM, context) as (e: number, t: number) => { reset(seed: number): void })(
        settings.epochMs,
        settings.tickMs,
      )
    : undefined;
  determinism?.reset(testSeed(settings.seed, ''));

  const shimConsole = vm.runInContext('({})', context) as Record<string, unknown>;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const) {
    shimConsole[method] = (...args: unknown[]) => captureLine(args, req.limits.maxConsoleBytesPerTest);
  }
  vm.runInContext('globalThis.console = undefined', context);
  (vm.runInContext('globalThis', context) as Record<string, unknown>).console = shimConsole;

  // entryName is spliced into generated source below, so it is re-validated here
  // rather than trusting that the host checked it: an entry name of
  // `x; doSomethingElse(); x` would otherwise be code injection into our own wrapper.
  const name = req.entryName;
  if (name !== 'default' && !IDENTIFIER.test(name)) {
    throw new Error('entry name is not a valid identifier');
  }
  const byIdentifier =
    IDENTIFIER.test(name) && name !== 'default'
      ? `try { if (typeof ${name} === 'function') return ${name}; } catch (e) { /* TDZ */ }`
      : '';

  const body = [
    '"use strict";',
    req.code,
    ';return (function () {',
    byIdentifier,
    `  if (exports && typeof exports[${JSON.stringify(name)}] === 'function') return exports[${JSON.stringify(name)}];`,
    "  if (exports && typeof exports.default === 'function') return exports.default;",
    "  if (module && typeof module.exports === 'function') return module.exports;",
    '  return undefined;',
    '})();',
  ].join('\n');

  const factory = vm.compileFunction(body, ['module', 'exports', 'require'], {
    parsingContext: context,
    filename: 'submission.js',
  }) as (module: unknown, exports: unknown, require: unknown) => unknown;

  const moduleObj = vm.runInContext('({ exports: {} })', context) as { exports: unknown };
  const blockedRequire = (specifier: unknown) => {
    // Unreachable in practice: a bare vm context has no `require` to begin with, and
    // the static allowlist rejects the identifier before launch. This exists so that
    // a submission that gets here fails loudly and reportably rather than oddly.
    throw new Error(`require(${JSON.stringify(String(specifier))}) is not available inside the sandbox`);
  };

  const fn = factory(moduleObj, moduleObj.exports, blockedRequire);
  if (typeof fn !== 'function') {
    throw new Error(`entry point '${name}' did not resolve to a function`);
  }
  return { fn: fn as (...args: unknown[]) => unknown, realm, determinism };
}

// --- per-test execution -------------------------------------------------------

function describeThrown(thrown: unknown, encodeBudget: SandboxRequest['limits']['encode']): Outcome {
  const tag = Object.prototype.toString.call(thrown);
  if (tag === '[object Error]') {
    let name = 'Error';
    let message = '';
    try {
      const n = (thrown as Error).name;
      name = typeof n === 'string' && n ? n : 'Error';
    } catch {
      /* keep default */
    }
    try {
      const m = (thrown as Error).message;
      message = typeof m === 'string' ? m : String(m ?? '');
    } catch {
      /* keep default */
    }
    return { type: 'thrown', errorClass: name.slice(0, 200), message: normalizeErrorMessage(message) };
  }
  // `throw 42`, `throw {code: 'x'}`, `throw undefined` -- all legal, all worth
  // distinguishing from each other and from a real Error.
  let rendered = '';
  try {
    rendered = typeof thrown === 'symbol' ? String(thrown) : String(thrown as string);
  } catch {
    rendered = '[unstringifiable]';
  }
  return {
    type: 'thrown',
    errorClass: `NonError:${thrown === null ? 'null' : typeof thrown}`,
    message: normalizeErrorMessage(rendered),
    value: encode(thrown, encodeBudget),
  };
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as PromiseLike<unknown>).then === 'function'
  );
}

async function runTest(compiled: Compiled, test: TestInput, req: SandboxRequest, generation: number): Promise<TestResult> {
  const started = Date.now();
  resetConsole();
  const encodeBudget = req.limits.encode;

  let args: unknown[];
  try {
    const decoded = decode(test.args, compiled.realm, encodeBudget);
    args = Array.isArray(decoded) ? (decoded as unknown[]) : [decoded];
  } catch (err) {
    return reply(test.id, { type: 'harness_error', detail: `argument decode failed: ${String(err)}` }, encodeArgs([]), started, generation);
  }

  // Same clock and random sequence for this test id wherever it runs: first or last
  // in the pass, in the oracle or in a rewrite.
  compiled.determinism?.reset(testSeed(req.limits.determinism.seed, test.id));

  let outcome: Outcome;
  let result: unknown;
  let threw = false;
  try {
    result = compiled.fn.apply(undefined, args);
    // A pure function may legitimately be `async`. The host's per-test timer covers
    // the await: a promise that never settles gets this whole process killed.
    if (isThenable(result)) result = await result;
  } catch (err) {
    threw = true;
    result = err;
  }

  // Drain every microtask the call queued BEFORE reporting completion. Without this,
  // `Promise.resolve().then(() => { while (true) {} })` returns instantly, this
  // process reports success, and the hang lands on the NEXT test -- which then gets
  // blamed for a timeout it did not cause. setImmediate callbacks run only once the
  // microtask queue is empty, and user code has no setImmediate of its own (the vm
  // context has no timers), so this await resolves only when the call's deferred
  // work has fully finished.
  await new Promise<void>((resolve) => setImmediate(resolve));

  try {
    outcome = threw ? describeThrown(result, encodeBudget) : { type: 'return', value: encode(result, encodeBudget) };
  } catch (err) {
    outcome = { type: 'harness_error', detail: `result encode failed: ${String(err)}` };
  }

  // Encoded AFTER the call, from the same array object that was passed in, so a
  // function that mutates its arguments is visible in the report.
  let argsAfter: EncodedValue;
  try {
    argsAfter = encodeArgs(args, encodeBudget);
  } catch {
    argsAfter = { t: 'unsupported', kind: 'args-encode-failed' };
  }

  return reply(test.id, outcome, argsAfter, started, generation);
}

function reply(testId: string, outcome: Outcome, argsAfterCall: EncodedValue, started: number, generation: number): TestResult {
  return {
    testId,
    outcome,
    argsAfterCall,
    consoleOutput: takeConsole(),
    durationMs: Date.now() - started,
    workerGeneration: generation,
  };
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<number> {
  let req: SandboxRequest;
  try {
    req = readRequest();
  } catch (err) {
    process.stderr.write(`sandbox: bad request: ${String(err)}\n`);
    return 64;
  }

  const heartbeat = setInterval(() => {
    emit({ kind: 'heartbeat', rssBytes: process.memoryUsage.rss() });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  // An immediate one too: if the very first test hangs synchronously the moment it
  // starts, the event loop never gets back around to firing the interval above even
  // once, and the host (which distinguishes "still starting up" from "hung mid-test"
  // by whether it has EVER seen a line from this attempt -- src/host/supervise.ts)
  // would otherwise wait a much longer startup grace instead of the tight per-test one.
  emit({ kind: 'heartbeat', rssBytes: process.memoryUsage.rss() });

  let compiled: Compiled;
  try {
    compiled = compile(req);
  } catch (err) {
    const detail = normalizeErrorMessage(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    const emptyArgs = encodeArgs([]);
    for (const test of req.tests) {
      emit({
        kind: 'result',
        result: {
          testId: test.id,
          outcome: { type: 'harness_error', detail },
          argsAfterCall: emptyArgs,
          consoleOutput: '',
          durationMs: 0,
          workerGeneration: req.generation,
        },
      });
    }
    clearInterval(heartbeat);
    emit({ kind: 'pass-end', passId: req.passId, completed: req.tests.length });
    return 0;
  }

  let completed = 0;
  for (const test of req.tests) {
    const result = await runTest(compiled, test, req, req.generation);
    emit({ kind: 'result', result });
    completed += 1;
  }

  clearInterval(heartbeat);
  emit({ kind: 'pass-end', passId: req.passId, completed });
  return 0;
}

main().then(
  (code) => {
    // Untrusted code may have left handles behind; do not wait on them.
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`sandbox: fatal: ${String(err)}\n`);
    process.exit(70);
  },
);
