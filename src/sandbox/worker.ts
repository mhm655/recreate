/**
 * The worker thread. Runs INSIDE the container.
 *
 * SECURITY MODEL -- read this before changing anything here.
 *
 *   This file is NOT a security boundary. A worker thread shares an OS process
 *   with its parent: the same file descriptors, the same address space, the same
 *   signal disposition. Code that escapes the `vm` context below is, for security
 *   purposes, code running as the container's user.
 *
 *   The worker thread exists for exactly one reason: INTERRUPTIBILITY. A
 *   synchronous infinite loop (`while (true) {}`) never yields to the event loop,
 *   so a `setTimeout` scheduled on the same thread can never fire, and nothing in
 *   single-threaded JavaScript can stop it. Running untrusted code on a separate
 *   thread lets the parent call `worker.terminate()`, which tears down that
 *   thread's isolate from the outside. That is the whole job.
 *
 *   The actual security boundary is the gVisor (`runsc`) container around this
 *   process: no network, read-only root filesystem, dropped capabilities,
 *   non-root user, seccomp, and cgroup limits on CPU/memory/pids.
 *
 * The `vm` context is a third thing again, and also not a security boundary. It is
 * REALM HYGIENE. Untrusted code gets a fresh set of intrinsics, so that when it does
 * `Object.prototype.x = 1` or `Array = evil`, the damage is confined to that realm
 * and cannot corrupt the encoder, the message plumbing, or the argument decoder --
 * all of which run in this module's realm and would otherwise be reading through a
 * poisoned prototype chain while reporting results.
 *
 * Note what is deliberately absent from the context: `require`, `process`, `fs`,
 * timers, `fetch`. A bare vm context has JS intrinsics and nothing else; the only
 * global added is a capturing `console`.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as vm from 'node:vm';

import {
  captureRealm,
  decode,
  encode,
  encodeArgs,
  normalizeErrorMessage,
  type EncodedValue,
  type Realm,
} from '../encoding';
import type { FromWorker, Limits, Outcome, ToWorker } from '../protocol';

interface WorkerInit {
  /** CommonJS JavaScript, transpiled on the host. */
  code: string;
  entryName: string;
  limits: Limits;
}

// The HMAC key for the result channel is deliberately NOT part of workerData.
// Untrusted code runs in this thread; anything reachable from here is reachable
// by it. See src/channel.ts.
const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error('worker must be started with a parentPort');

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// A rejected promise from untrusted code must not take the worker down; it would
// look like a resource failure and cost the rest of the pass.
process.on('unhandledRejection', () => {});

// --- console capture ------------------------------------------------------

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

function captureLine(parts: unknown[]): void {
  if (consoleTruncated) return;
  let line: string;
  try {
    line = parts.map(formatForConsole).join(' ');
  } catch {
    line = '[unformattable console arguments]';
  }
  const chunk = `${line}\n`;
  const size = Buffer.byteLength(chunk, 'utf8');
  if (consoleBytes + size > init.limits.maxConsoleBytesPerTest) {
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

// --- context setup --------------------------------------------------------

interface Compiled {
  fn: (...args: unknown[]) => unknown;
  realm: Realm;
}

function compile(): Compiled {
  const context = vm.createContext(Object.create(null), {
    name: 'submission',
    codeGeneration: {
      // `eval` and `new Function` inside the context are pointless to allow and
      // would only widen what static screening has to reason about.
      strings: false,
      wasm: false,
    },
  });

  // Snapshot intrinsics NOW, before any untrusted code runs, so that a later
  // `globalThis.Array = attacker` cannot influence how arguments are constructed.
  const realm = captureRealm(vm.runInContext('globalThis', context));

  const shimConsole = vm.runInContext('({})', context) as Record<string, unknown>;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const) {
    shimConsole[method] = (...args: unknown[]) => captureLine(args);
  }
  vm.runInContext('globalThis.console = undefined', context);
  (vm.runInContext('globalThis', context) as Record<string, unknown>).console = shimConsole;

  // entryName is spliced into generated source below, so it is re-validated here
  // rather than trusting that the host checked it: an entry name of
  // `x; doSomethingElse(); x` would otherwise be code injection into our own wrapper.
  const name = init.entryName;
  if (name !== 'default' && !IDENTIFIER.test(name)) {
    throw new Error('entry name is not a valid identifier');
  }
  const byIdentifier =
    IDENTIFIER.test(name) && name !== 'default'
      ? `try { if (typeof ${name} === 'function') return ${name}; } catch (e) { /* TDZ */ }`
      : '';

  const body = [
    '"use strict";',
    init.code,
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
  return { fn: fn as (...args: unknown[]) => unknown, realm };
}

let compiled: Compiled | undefined;
try {
  compiled = compile();
  const ready: FromWorker = { kind: 'ready' };
  port.postMessage(ready);
} catch (err) {
  const failed: FromWorker = {
    kind: 'init-failed',
    detail: normalizeErrorMessage(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
  };
  port.postMessage(failed);
}

// --- per-test execution ---------------------------------------------------

function describeThrown(thrown: unknown): Outcome {
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
    value: encode(thrown, init.limits.encode),
  };
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as PromiseLike<unknown>).then === 'function'
  );
}

async function runTest(msg: ToWorker): Promise<void> {
  const started = Date.now();
  resetConsole();

  if (!compiled) {
    reply(msg.testId, { type: 'harness_error', detail: 'compile failed' }, encodeArgs([]), started);
    return;
  }

  // Decode into the sandbox realm so that `x instanceof Array` etc. behave the way
  // the function's author expects; cross-realm objects would silently fail those.
  let args: unknown[];
  try {
    const decoded = decode(msg.args, compiled.realm);
    args = Array.isArray(decoded) ? (decoded as unknown[]) : [decoded];
  } catch (err) {
    reply(
      msg.testId,
      { type: 'harness_error', detail: `argument decode failed: ${String(err)}` },
      encodeArgs([]),
      started,
    );
    return;
  }

  let outcome: Outcome;
  let result: unknown;
  let threw = false;
  try {
    result = compiled.fn.apply(undefined, args);
    // A pure function may legitimately be `async`. The per-test timer in the parent
    // covers the await: a promise that never settles is killed by terminate().
    if (isThenable(result)) result = await result;
  } catch (err) {
    threw = true;
    result = err;
  }

  // Drain every microtask the call queued BEFORE reporting completion. Without this,
  // `Promise.resolve().then(() => { while (true) {} })` returns instantly, the
  // parent disarms this test's timer, and the hang lands on the NEXT test -- which
  // then gets blamed for a timeout it did not cause. setImmediate callbacks run only
  // once the microtask queue is empty, and user code has no setImmediate of its own
  // (the vm context has no timers), so this await resolves only when the call's
  // deferred work has fully finished.
  await new Promise<void>((resolve) => setImmediate(resolve));

  try {
    outcome = threw ? describeThrown(result) : { type: 'return', value: encode(result, init.limits.encode) };
  } catch (err) {
    outcome = { type: 'harness_error', detail: `result encode failed: ${String(err)}` };
  }

  // Encoded AFTER the call, from the same array object that was passed in, so a
  // function that mutates its arguments is visible in the report.
  let argsAfter: EncodedValue;
  try {
    argsAfter = encodeArgs(args, init.limits.encode);
  } catch {
    argsAfter = { t: 'unsupported', kind: 'args-encode-failed' };
  }

  reply(msg.testId, outcome, argsAfter, started);
}

function reply(testId: string, outcome: Outcome, argsAfterCall: EncodedValue, started: number): void {
  const message: FromWorker = {
    kind: 'done',
    testId,
    outcome,
    argsAfterCall,
    consoleOutput: takeConsole(),
    durationMs: Date.now() - started,
  };
  port!.postMessage(message);
}

port.on('message', (msg: ToWorker) => {
  if (!msg || msg.kind !== 'run') return;
  void runTest(msg).catch((err) => {
    reply(
      msg.testId,
      { type: 'harness_error', detail: normalizeErrorMessage(String(err)) },
      encodeArgs([]),
      Date.now(),
    );
  });
});
