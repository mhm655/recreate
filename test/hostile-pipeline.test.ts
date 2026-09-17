/**
 * Hostile submissions, run through the whole pipeline: static screening ->
 * host-side transpile -> sandbox runner -> result channel -> reconciliation ->
 * ordered/shuffled comparison.
 *
 * Runner selection:
 *   default                   LocalRunner. No isolation, but exercises every
 *                             mechanism inside the sandbox boundary.
 *   TSBOX_TEST_RUNNER=docker  DockerRunner with gVisor. Needs a Linux host with
 *                             runsc registered and the image built (npm run image).
 *
 * Tamper tests always use LocalRunner, because they inject a preload script into the
 * sandbox process to attack the result fd from the inside.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { decode, encodeArgs, frame, newResultKey, parseChannel, type EncodedValue } from '../src/index';
import { DockerRunner } from '../src/host/docker-runner';
import { evaluate, reconcile, type SubmissionReport, type TestCase } from '../src/host/orchestrator';
import { LocalRunner, type RunnerResult, type SandboxRunner } from '../src/host/runner';
import { transpileSubmission } from '../src/transpile';
import { DEFAULT_LIMITS, PROTOCOL_VERSION, type Limits, type SandboxRequest, type TestResult } from '../src/protocol';
import * as H from './fixtures/hostile';

const USE_DOCKER = process.env.TSBOX_TEST_RUNNER === 'docker';
const runner: SandboxRunner = USE_DOCKER ? new DockerRunner() : new LocalRunner();

const LIMITS: Partial<Limits> = {
  perTestTimeoutMs: 1_000,
  passTimeoutMs: 30_000,
  submissionTimeoutMs: 120_000,
};

const run = (source: string, tests: TestCase[], extra: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({ source, tests, runner, limits: LIMITS, seed: 1234, ...extra });

const byId = (results: TestResult[]) => new Map(results.map((r) => [r.testId, r]));

function returned(r: TestResult | undefined): unknown {
  assert.ok(r, 'missing result');
  assert.equal(r.outcome.type, 'return', `expected a return, got ${JSON.stringify(r.outcome)}`);
  return decode((r.outcome as { value: EncodedValue }).value);
}

function explain(report: SubmissionReport): string {
  return JSON.stringify(
    { verdict: report.verdict, problems: report.problems, passes: report.passes.map((p) => ({ id: p.passId, status: p.status, problems: p.problems })) },
    null,
    2,
  );
}

before(async () => {
  const pre = await runner.preflight();
  if (!pre.ok) throw new Error(`runner unavailable: ${pre.detail}`);
});

// ---------------------------------------------------------------------------

describe('hostile: busy loop with no I/O', () => {
  it('is killed by worker termination within the per-test timeout, and the pass continues', async () => {
    const started = Date.now();
    const report = await run(H.BUSY_LOOP, [
      { id: 'spins', args: [true] },
      { id: 'returns', args: [false] },
    ]);

    assert.equal(report.passes.length, 2, explain(report));
    for (const pass of report.passes) {
      assert.equal(pass.status, 'ok', explain(report));
      const results = byId(pass.results);
      const spun = results.get('spins')!;
      assert.deepEqual(spun.outcome, { type: 'timeout', limitMs: 1_000 });
      assert.ok(spun.durationMs < 1_000 + 1_500, `took ${spun.durationMs}ms to kill`);
      assert.equal(returned(results.get('returns')), 'finished');
    }

    // In the ordered pass the spinner runs first, so a replacement worker must have
    // taken over for the second test.
    const passA = report.passes[0];
    assert.equal(passA.workerGenerations, 2);
    assert.equal(byId(passA.results).get('returns')!.workerGeneration, 2);

    // Both passes agree it times out, so this is a valid, deterministic run.
    assert.equal(report.verdict, 'ok', explain(report));
    assert.ok(Date.now() - started < 20_000);
  });

  it('attributes a hang queued as a microtask to the test that queued it, not the next one', async () => {
    const report = await run(H.DEFERRED_BUSY_LOOP, [
      { id: 'hangs-later', args: [true] },
      { id: 'innocent', args: [false] },
    ]);
    for (const pass of report.passes) {
      const results = byId(pass.results);
      assert.equal(results.get('hangs-later')!.outcome.type, 'timeout', explain(report));
      assert.equal(returned(results.get('innocent')), 'returned before hanging');
    }
    assert.equal(report.verdict, 'ok', explain(report));
  });
});

// ---------------------------------------------------------------------------

describe('hostile: memory bombs', () => {
  it('unbounded array growth hits the worker heap cap and is reported, not crashed', async () => {
    const report = await run(H.HEAP_BOMB, [
      { id: 'bomb', args: [true] },
      { id: 'after-bomb', args: [false] },
    ]);
    for (const pass of report.passes) {
      assert.equal(pass.status, 'ok', explain(report));
      const results = byId(pass.results);
      const bomb = results.get('bomb')!.outcome;
      assert.equal(bomb.type, 'resource_limit', JSON.stringify(bomb));
      assert.equal((bomb as { limit: string }).limit, 'memory');
      assert.equal(returned(results.get('after-bomb')), 'fine');
    }
    assert.equal(report.verdict, 'ok', explain(report));
  });

  it('off-heap growth that the V8 heap cap cannot see is caught by the RSS watchdog', async () => {
    const report = await run(H.OFF_HEAP_BOMB, [
      { id: 'bomb', args: [true] },
      { id: 'after-bomb', args: [false] },
    ]);
    for (const pass of report.passes) {
      assert.equal(pass.status, 'ok', explain(report));
      const results = byId(pass.results);
      const bomb = results.get('bomb')!.outcome;
      assert.equal(bomb.type, 'resource_limit', JSON.stringify(bomb));
      assert.equal((bomb as { limit: string }).limit, 'memory');
      assert.equal(returned(results.get('after-bomb')), 'fine');
    }
    // Regression: the watchdog's detail includes a run-specific RSS figure. Two passes
    // that both hit the cap must still count as agreeing.
    assert.equal(report.verdict, 'ok', explain(report));
  });

  it('off-heap growth at module scope, before any test runs, is also caught by the watchdog', async () => {
    // Every worker spawn re-runs this module-level loop during compile(), so every
    // test in the pass independently hits the cap and gets a fresh worker after.
    const report = await run(H.OFF_HEAP_BOMB_AT_MODULE_SCOPE, [
      { id: 'a', args: [] },
      { id: 'b', args: [] },
    ]);
    for (const pass of report.passes) {
      assert.equal(pass.status, 'ok', explain(report));
      for (const r of pass.results) {
        assert.equal(r.outcome.type, 'resource_limit', JSON.stringify(r.outcome));
        assert.equal((r.outcome as { limit: string }).limit, 'memory');
      }
    }
    assert.equal(report.verdict, 'ok', explain(report));
  });
});

// ---------------------------------------------------------------------------

describe('hostile: child_process / worker_threads', () => {
  class MustNotRun implements SandboxRunner {
    readonly name = 'must-not-run';
    readonly isolated = true;
    launched = 0;
    async preflight() {
      return { ok: true, detail: '' };
    }
    async run(): Promise<RunnerResult> {
      this.launched += 1;
      throw new Error('a sandbox was launched for source that should have been rejected statically');
    }
  }

  for (const [label, source] of Object.entries(H.STATICALLY_BLOCKED_ESCAPES)) {
    it(`static analysis rejects ${label} before any sandbox launches`, async () => {
      const spy = new MustNotRun();
      const report = await evaluate({ source, tests: [{ id: 't', args: [] }], runner: spy });
      assert.equal(report.verdict, 'rejected', explain(report));
      assert.ok(report.staticAnalysis.violations!.length > 0);
      assert.equal(spy.launched, 0);
      assert.equal(report.passes.length, 0);
    });
  }

  it('escapes that get past static analysis fail safely at runtime', async () => {
    const cases = ['Function constructor', 'arrow constructor chain', 'async function constructor'];
    const report = await run(H.RUNTIME_ESCAPES, [
      ...cases.map((c, i) => ({ id: `escape-${i}`, args: [c] })),
      { id: 'this', args: ['this at top level'] },
    ]);
    assert.equal(report.staticAnalysis.ok, true, `precondition: these must slip past static analysis\n${explain(report)}`);

    for (const pass of report.passes) {
      assert.equal(pass.status, 'ok', explain(report));
      const results = byId(pass.results);
      for (let i = 0; i < cases.length; i++) {
        const o = results.get(`escape-${i}`)!.outcome;
        assert.equal(o.type, 'thrown', `${cases[i]} did not throw: ${JSON.stringify(o)}`);
        // Code generation from strings is disabled for the context, so the
        // Function-constructor route to `process` dies before it starts.
        assert.equal((o as { errorClass: string }).errorClass, 'EvalError', `${cases[i]}: ${JSON.stringify(o)}`);
      }
      assert.equal(returned(results.get('this')), 'undefined');
    }
    assert.equal(JSON.stringify(report).includes('PWNED'), false);
  });

  it('the sandbox realm exposes no Node globals, timers or network', async () => {
    const [result] = await runDirect(H.GLOBAL_INVENTORY, 'inventory', [[]]);
    assert.equal(
      returned(result),
      'process:undefined,require:undefined,module:undefined,setTimeout:undefined,setImmediate:undefined,' +
        'queueMicrotask:undefined,fetch:undefined,Buffer:undefined,WebAssembly:object',
    );
  });

  it('even with static analysis bypassed entirely, require is unreachable at runtime', async () => {
    const results = await runDirect(H.RUNTIME_ONLY_REQUIRE, 'attempt', [[1], [2], [3], [4], [5]]);
    const outcomes = results.map((r) => r.outcome);
    for (const o of outcomes.slice(0, 4)) assert.equal(o.type, 'thrown', JSON.stringify(o));
    // Transpiled `import()` becomes `Promise.resolve().then(() => require(...))`, so it rejects.
    assert.equal(outcomes[4].type, 'thrown', JSON.stringify(outcomes[4]));
    assert.match((outcomes[0] as { message: string }).message, /not available inside the sandbox/);
    assert.match((outcomes[3] as { errorClass: string }).errorClass, /EvalError/);
    assert.equal(JSON.stringify(results).includes('PWNED'), false);
  });
});

// ---------------------------------------------------------------------------

describe('hostile: prototype pollution', () => {
  it('persists within a pass, never across passes, never into the host, and cannot hijack encoding', async () => {
    const report = await run(H.PROTOTYPE_POLLUTION, [
      { id: 'first', args: ['first'] },
      { id: 'second', args: ['second'] },
      { id: 'third', args: ['third'] },
    ]);

    for (const pass of report.passes) {
      assert.equal(pass.status, 'ok', explain(report));
      assert.equal(pass.workerGenerations, 1);
      const results = byId(pass.results);
      pass.order.forEach((id, position) => {
        const value = returned(results.get(id)) as { label: string; sawPollution: string | null; pair: string[] };
        // The encoder ignored the polluted toJSON and the hijacked Array.prototype.push.
        assert.deepEqual(value.pair, [id, id]);
        if (position === 0) {
          // Whatever runs first in EACH pass sees a clean realm: a fresh worker per pass.
          assert.equal(value.sawPollution, null, `pass ${pass.passId}: ${id} saw pollution`);
        } else {
          // Within a pass the worker is shared on purpose, and the leak is visible...
          assert.equal(value.sawPollution, `set by ${pass.order[position - 1]}`);
        }
      });
    }

    // ...which is exactly what the shuffled pass is there to catch.
    assert.equal(report.verdict, 'nondeterministic', explain(report));
    assert.ok(report.determinism.divergences.length > 0);
    assert.deepEqual(report.results, {});

    // Nothing reached the host realm.
    assert.equal(({} as Record<string, unknown>).pwned, undefined);
    assert.equal(typeof ([] as unknown[]).push, 'function');
  });
});

// ---------------------------------------------------------------------------

describe('hostile: values JSON cannot represent', () => {
  it('NaN, Infinity, -Infinity, -0 and undefined survive the trip out of the sandbox', async () => {
    const report = await run(H.SPECIAL_VALUES, [
      { id: 'nan', args: ['nan'] },
      { id: 'inf', args: ['inf'] },
      { id: 'ninf', args: ['ninf'] },
      { id: 'negzero', args: ['negzero'] },
      { id: 'undef', args: ['undef'] },
      { id: 'nested', args: ['nested'] },
      { id: 'throw-error', args: ['throw-error'] },
      { id: 'throw-string', args: ['throw-string'] },
    ]);
    assert.equal(report.verdict, 'ok', explain(report));
    const r = report.results;

    assert.ok(Number.isNaN(returned(r.nan)));
    assert.equal(returned(r.inf), Infinity);
    assert.equal(returned(r.ninf), -Infinity);
    assert.ok(Object.is(returned(r.negzero), -0));
    assert.deepEqual(r.undef.outcome, { type: 'return', value: { t: 'undefined' } });

    const nested = returned(r.nested) as Record<string, unknown>;
    assert.ok('a' in nested && nested.a === undefined);
    assert.ok(Number.isNaN(nested.b));
    assert.ok(Object.is((nested.c as number[])[0], -0));
    assert.equal((nested.c as number[])[1], Infinity);
    assert.equal((nested.d as Date).toISOString(), '1970-01-01T00:00:00.000Z');

    assert.deepEqual(r['throw-error'].outcome, { type: 'thrown', errorClass: 'RangeError', message: 'out of range' });
    const thrownString = r['throw-string'].outcome as { type: string; errorClass: string; value?: EncodedValue };
    assert.equal(thrownString.errorClass, 'NonError:string');
    assert.deepEqual(thrownString.value, { t: 'str', v: 'just a string' });
  });

  it('special values survive the trip INTO the sandbox as arguments', async () => {
    const report = await run(H.IDENTITY, [
      { id: 'nan', args: [NaN] },
      { id: 'negzero', args: [-0] },
      { id: 'undef', args: [undefined] },
      { id: 'map', args: [new Map([[NaN, -Infinity]])] },
    ]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.ok(Number.isNaN(returned(report.results.nan)));
    assert.ok(Object.is(returned(report.results.negzero), -0));
    assert.equal(returned(report.results.undef), undefined);
    assert.equal((returned(report.results.map) as Map<number, number>).get(NaN), -Infinity);
  });
});

// ---------------------------------------------------------------------------

describe('input truncation', () => {
  it('a test argument shortened by the encode budget is reported, not silently graded', async () => {
    const report = await run(
      'export function len(arr: number[]): number { return arr.length; }',
      [
        { id: 'small', args: [[1, 2, 3]] },
        { id: 'big', args: [Array.from({ length: 5_000 }, (_, i) => i)] },
      ],
      { limits: { ...LIMITS, encode: { ...DEFAULT_LIMITS.encode, maxCollectionEntries: 1_000 } } },
    );
    assert.equal(report.verdict, 'ok', explain(report));
    assert.ok(
      report.problems.some((p) => p.code === 'test_input_truncated' && p.detail.includes('big')),
      JSON.stringify(report.problems),
    );
    assert.equal(report.problems.some((p) => p.code === 'test_input_truncated' && p.detail.includes('small')), false);
    // The submission is graded against what actually arrived: the truncated array.
    assert.equal(returned(report.results.big), 1_000);
    assert.equal(returned(report.results.small), 3);
  });
});

describe('hostile: argument mutation', () => {
  it('argsAfterCall captures a function mutating its own inputs', async () => {
    const report = await run(H.MUTATES_ARGS, [{ id: 'mutate', args: [[3, 1, 2], {}] }]);
    assert.equal(report.verdict, 'ok', explain(report));
    const result = report.results.mutate;
    assert.equal(returned(result), 4);
    assert.deepEqual(decode(result.argsAfterCall), [[1, 2, 3, 999], { calls: 1, sorted: true }]);
  });

  it('argsAfterCall matches the input when nothing is mutated', async () => {
    const input = ['  Hello World  '];
    const report = await run(H.PURE, [{ id: 'pure', args: input }]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.deepEqual(report.results.pure.argsAfterCall, encodeArgs(input));
    assert.equal(returned(report.results.pure), 'hello-world');
  });
});

// ---------------------------------------------------------------------------

describe('hostile: state carried across calls', () => {
  const tests = ['a', 'b', 'c', 'd'].map((p) => ({ id: p, args: [p] }));

  it('a module-level counter is flagged as order-sensitive, not silently resolved', async () => {
    const report = await run(H.MODULE_COUNTER, tests);
    assert.equal(report.passes.every((p) => p.status === 'ok'), true, explain(report));
    assert.equal(report.verdict, 'nondeterministic', explain(report));
    assert.equal(report.determinism.deterministic, false);
    assert.ok(report.determinism.divergences.length > 0);
    assert.ok(report.determinism.divergences.every((d) => d.reason === 'order_sensitive'));
    assert.deepEqual(report.results, {}, 'no single answer should be recorded');
  });

  it('a memo cache is caught the same way', async () => {
    const report = await run(H.MEMO_CACHE, [
      { id: 'first-3', args: [3] },
      { id: 'again-3', args: [3] },
      { id: 'four', args: [4] },
    ]);
    assert.equal(report.verdict, 'nondeterministic', explain(report));
  });

  it('the shuffle is reproducible from the recorded seed', async () => {
    const one = await run(H.MODULE_COUNTER, tests, { seed: 99 });
    const two = await run(H.MODULE_COUNTER, tests, { seed: 99 });
    assert.deepEqual(one.passes[1].order, two.passes[1].order);
    assert.notDeepEqual(one.passes[1].order, one.passes[0].order);
    assert.deepEqual(one.determinism.divergences, two.determinism.divergences);
  });

  it('control: a pure function is deterministic', async () => {
    const report = await run(H.PURE, [
      { id: 'x', args: ['Hello World'] },
      { id: 'y', args: ['  Trim me!  '] },
      { id: 'z', args: ['already-a-slug'] },
    ]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.equal(report.determinism.deterministic, true);
    assert.equal(returned(report.results.y), 'trim-me');
  });
});

// ---------------------------------------------------------------------------

describe('hostile: writes straight to the result fd', { skip: USE_DOCKER && 'tamper tests inject a preload into a local process' }, () => {
  const preload = path.join(__dirname, 'fixtures', 'tamper-preload.js');
  const tamper = (mode: string) =>
    evaluate({
      source: H.PURE,
      tests: [
        { id: 't1', args: ['One'] },
        { id: 't2', args: ['Two'] },
      ],
      runner: new LocalRunner({ nodeArgs: ['--require', preload], env: { TAMPER_MODE: mode } }),
      limits: LIMITS,
      seed: 7,
    });

  const expectFailure = (report: SubmissionReport, passStatus: string, problemCode: string) => {
    assert.equal(report.verdict, 'failed', explain(report));
    assert.deepEqual(report.results, {}, 'a tampered run must not yield usable results');
    for (const pass of report.passes) {
      assert.equal(pass.status, passStatus, explain(report));
      assert.ok(pass.problems.some((p) => p.code === problemCode), `${problemCode} missing: ${explain(report)}`);
    }
  };

  it('control: the preload with no attack selected changes nothing', async () => {
    const report = await tamper('none');
    assert.equal(report.verdict, 'ok', explain(report));
  });

  it('rejects garbage lines interleaved with genuine results', async () => {
    const report = await tamper('garbage');
    expectFailure(report, 'integrity_violation', 'unsigned_channel_lines');
    // The genuine results still arrived alongside the junk; it is the junk that fails the run.
    for (const pass of report.passes) assert.equal(pass.results.length, 2, explain(report));
  });

  it('rejects a well-formed but unsigned forged result', async () => {
    const report = await tamper('forge-unsigned');
    expectFailure(report, 'integrity_violation', 'unsigned_channel_lines');
    assert.equal(JSON.stringify(report).includes('the answer the attacker wanted'), false);
  });

  it('rejects a result set with an entry missing', async () => {
    const report = await tamper('drop');
    expectFailure(report, 'incomplete', 'missing_results');
    // Guard against a false pass: a preload that crashed the process would also
    // produce "missing results". Exactly one of two results must have been dropped,
    // and the harness must have run to completion.
    for (const pass of report.passes) {
      assert.equal(pass.results.length, 1, explain(report));
      assert.equal(pass.problems.some((p) => p.code === 'no_pass_end'), false, explain(report));
    }
  });

  it('rejects duplicated (replayed) correctly-signed entries', async () => {
    const report = await tamper('duplicate');
    expectFailure(report, 'integrity_violation', 'duplicate_results');
    for (const pass of report.passes) assert.equal(pass.results.length, 2, explain(report));
  });

  it('rejects an extra entry even when the attacker holds the signing key', async () => {
    const report = await tamper('extra-signed');
    expectFailure(report, 'integrity_violation', 'unexpected_results');
    for (const pass of report.passes) {
      assert.ok(pass.problems.some((p) => p.detail.includes('phantom-test')), explain(report));
      // The forged line verified: signing alone would not have caught this.
      assert.equal(pass.problems.some((p) => p.code === 'unsigned_channel_lines'), false, explain(report));
    }
  });
});

// ---------------------------------------------------------------------------

describe('vendored dependencies', () => {
  const LODASH_CHUNK = `
    import { chunk } from 'lodash-es';
    export function firstPair(xs: number[]): number[] {
      return chunk(xs, 2)[0] ?? [];
    }
  `;

  it('runs a submission that imports a vendored module, end to end', async () => {
    const report = await run(LODASH_CHUNK, [
      { id: 'basic', args: [[1, 2, 3, 4]] },
      { id: 'empty', args: [[]] },
    ]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.deepEqual(returned(report.results.basic), [1, 2]);
    assert.deepEqual(returned(report.results.empty), []);
  });

  it('still rejects an import that is neither allowlisted nor vendored', async () => {
    const report = await run("import { z } from 'left-pad'; export function f() { return z; }", [
      { id: 't', args: [] },
    ]);
    assert.equal(report.verdict, 'rejected', explain(report));
  });

  it('runs a vendored ES module dependency (date-fns) end to end', async () => {
    const source = `
      import { addDays, formatISO } from 'date-fns';
      export function shiftDate(iso: string, days: number): string {
        return formatISO(addDays(new Date(iso), days), { representation: 'date' });
      }
    `;
    const report = await run(source, [
      { id: 'forward', args: ['2024-01-01', 10] },
      { id: 'backward', args: ['2024-12-25', -5] },
    ]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.equal(returned(report.results.forward), '2024-01-11');
    assert.equal(returned(report.results.backward), '2024-12-20');
  });

  it('runs a vendored legacy-CommonJS dependency (ms) via a default import', async () => {
    // Regression: `ms` exports via `module.exports = fn`, not a real ES module --
    // a default import of it used to transpile into code reading a `.default`
    // property that doesn't exist, throwing "is not a function" at runtime. Fixed
    // by enabling esModuleInterop in src/transpile.ts.
    const source = `
      import ms from 'ms';
      export function toSeconds(input: string): number {
        return ms(input) / 1000;
      }
    `;
    const report = await run(source, [
      { id: 'days', args: ['2 days'] },
      { id: 'hours', args: ['1h'] },
    ]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.equal(returned(report.results.days), 172_800);
    assert.equal(returned(report.results.hours), 3_600);
  });
});

describe('function and class-instance arguments', () => {
  const CALLS_ITS_CALLBACK = `
    export function callIt(cb: (x: number) => number): number {
      return cb(41);
    }
  `;

  it('a submission that actually calls a function argument gets a loud, attributable failure', async () => {
    const report = await run(CALLS_ITS_CALLBACK, [{ id: 't', args: [(x: number) => x + 1] }]);
    assert.equal(report.verdict, 'ok', explain(report));
    const outcome = report.results.t.outcome as { type: string; errorClass: string; message: string };
    assert.equal(outcome.type, 'thrown');
    assert.match(outcome.message, /cannot be reconstructed/);
  });

  const IGNORES_ITS_CALLBACK = `
    export function ignoresIt(_cb: () => number): string {
      return 'fine';
    }
  `;

  it('a submission that never calls its function argument is unaffected', async () => {
    const report = await run(IGNORES_ITS_CALLBACK, [{ id: 't', args: [() => 1] }]);
    assert.equal(report.verdict, 'ok', explain(report));
    assert.equal(returned(report.results.t), 'fine');
  });
});

describe('reconciliation edge cases (synthetic channel data)', () => {
  const limits = DEFAULT_LIMITS;
  const ok = (resultChannel: string, over: Partial<RunnerResult> = {}): RunnerResult => ({
    resultChannel, rawOutput: '', exitCode: 0, signal: null, hostTimedOut: false, oomKilled: false, wallMs: 1, ...over,
  });
  const line = (key: string, testId: string) =>
    frame(key, {
      kind: 'result',
      result: {
        testId, outcome: { type: 'return', value: { t: 'num', v: 1 } }, argsAfterCall: { t: 'array', i: 0, v: [] },
        consoleOutput: '', durationMs: 0, workerGeneration: 1,
      },
    });
  const end = (key: string) => frame(key, { kind: 'pass-end', passId: 'a', workerGenerations: 1, completed: 2 });

  it('accepts exactly the expected set', () => {
    const key = newResultKey();
    const pass = reconcile('a', ['t1', 't2'], key, ok(line(key, 't1') + line(key, 't2') + end(key)), limits);
    assert.equal(pass.status, 'ok');
  });

  it('a line signed for one pass is rejected by the other pass', () => {
    const keyA = newResultKey();
    const keyB = newResultKey();
    const parsed = parseChannel(keyB, line(keyA, 't1'), { maxBytes: 1_000_000 });
    assert.equal(parsed.accepted.length, 0);
    assert.equal(parsed.rejected[0].reason, 'bad-signature');
  });

  it('a container OOM kill is resource_limit_exceeded, not a crash or a partial pass', () => {
    const key = newResultKey();
    const pass = reconcile('a', ['t1', 't2'], key, ok(line(key, 't1'), { exitCode: 137, oomKilled: true }), limits);
    assert.equal(pass.status, 'resource_limit_exceeded');
    assert.ok(pass.problems.some((p) => p.code === 'container_oom'));
    assert.ok(pass.problems.some((p) => p.code === 'missing_results'));
  });

  it('a SIGKILL without OOM attribution (pids, host timeout) is still resource_limit_exceeded', () => {
    const key = newResultKey();
    const pass = reconcile('a', ['t1'], key, ok('', { exitCode: null, signal: 'SIGKILL' }), limits);
    assert.equal(pass.status, 'resource_limit_exceeded');
  });

  it('a final line cut off mid-write is truncation, not tampering', () => {
    const key = newResultKey();
    const partial = line(key, 't2').slice(0, 90);
    const pass = reconcile('a', ['t1', 't2'], key, ok(line(key, 't1') + partial, { exitCode: 137 }), limits);
    assert.equal(pass.status, 'resource_limit_exceeded');
    assert.equal(pass.problems.some((p) => p.code === 'unsigned_channel_lines'), false);
    assert.ok(pass.problems.some((p) => p.code === 'result_channel_cut_short'));
  });

  it('a payload over the byte cap fails the pass', () => {
    const key = newResultKey();
    const channel = line(key, 't1') + end(key);
    const pass = reconcile('a', ['t1'], key, ok(channel), { ...limits, maxResultBytes: 100 });
    assert.notEqual(pass.status, 'ok');
    assert.ok(pass.problems.some((p) => p.code === 'result_channel_truncated'));
  });

  it('a clean exit that never reports pass-end is incomplete', () => {
    const key = newResultKey();
    const pass = reconcile('a', ['t1'], key, ok(line(key, 't1')), limits);
    assert.equal(pass.status, 'incomplete');
  });

  it('an oversize line is checked only after its signature verifies, so it is never mistaken for tampering', () => {
    // Regression: 'oversize' used to be checked BEFORE signature verification, so a
    // garbage/forged huge line and a genuine, correctly-signed-but-too-large result
    // were indistinguishable -- both landed in the same 'forged' bucket.
    const key = newResultKey();
    const wrongKey = newResultKey();
    const tinyBudget = { maxBytes: 1_000_000, maxLineBytes: 10 };

    const genuine = parseChannel(key, line(key, 't1'), tinyBudget);
    assert.equal(genuine.accepted.length, 0);
    assert.equal(genuine.rejected[0].reason, 'oversize');

    const forged = parseChannel(wrongKey, line(key, 't1'), tinyBudget);
    assert.equal(forged.accepted.length, 0);
    assert.equal(forged.rejected[0].reason, 'bad-signature', 'a wrong-key line must fail on signature, not size');
  });

  it('a genuine oversized result is reported as missing, not as tampering', () => {
    const key = newResultKey();
    const hugeResult = frame(key, {
      kind: 'result',
      result: {
        testId: 't2',
        outcome: { type: 'return', value: { t: 'str', v: 'x'.repeat(4_300_000) } },
        argsAfterCall: { t: 'array', i: 0, v: [] },
        consoleOutput: '',
        durationMs: 0,
        workerGeneration: 1,
      },
    });
    const pass = reconcile('a', ['t1', 't2'], key, ok(line(key, 't1') + hugeResult + end(key)), limits);
    assert.equal(pass.status, 'incomplete', JSON.stringify(pass.problems));
    assert.ok(pass.problems.some((p) => p.code === 'result_line_too_large'), JSON.stringify(pass.problems));
    assert.ok(pass.problems.some((p) => p.code === 'missing_results'), JSON.stringify(pass.problems));
    assert.equal(pass.problems.some((p) => p.code === 'unsigned_channel_lines'), false, JSON.stringify(pass.problems));
  });
});

// ---------------------------------------------------------------------------

describe('hostile: host-side kill', { skip: USE_DOCKER && 'uses LocalRunner timing directly' }, () => {
  it('a sandbox that outlives the host budget is killed and reported as resource_limit_exceeded', async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, perTestTimeoutMs: 60_000, passTimeoutMs: 60_000 };
    const key = newResultKey();
    const request = buildRequest(H.BUSY_LOOP, 'spin', [[true]], limits, key);
    const started = Date.now();
    const raw = await new LocalRunner().run(request, 1_500);
    assert.ok(Date.now() - started < 10_000, 'host kill did not happen promptly');
    assert.equal(raw.hostTimedOut, true);
    const pass = reconcile('a', ['t1'], key, raw, limits);
    assert.equal(pass.status, 'resource_limit_exceeded');
    assert.ok(pass.problems.some((p) => p.code === 'host_timeout'));
  });
});

// ---------------------------------------------------------------------------

describe('container-level limits', { skip: !USE_DOCKER && 'set TSBOX_TEST_RUNNER=docker on a gVisor host' }, () => {
  let docker: DockerRunner;
  after(() => undefined);

  it('an allocation that outruns every in-sandbox cap is OOM-killed by the container and reported cleanly', async () => {
    docker = new DockerRunner({ memoryMb: 128 });
    const report = await evaluate({
      source: H.OFF_HEAP_BOMB,
      tests: [{ id: 'bomb', args: [true] }],
      runner: docker,
      // Watchdog disabled (cap far above the container limit) so the cgroup is what trips.
      limits: { ...LIMITS, maxProcessRssMb: 64_000 },
    });
    assert.equal(report.verdict, 'failed', explain(report));
    for (const pass of report.passes) assert.equal(pass.status, 'resource_limit_exceeded', explain(report));
  });
});

// --- helpers ---------------------------------------------------------------

function buildRequest(source: string, entryName: string, argLists: unknown[][], limits: Limits, key: string): SandboxRequest {
  const t = transpileSubmission(source);
  if (!t.ok) throw new Error(t.detail);
  return {
    protocolVersion: PROTOCOL_VERSION,
    runId: 'direct',
    passId: 'a',
    resultKey: key,
    entryName,
    code: t.code,
    tests: argLists.map((args, i) => ({ id: `t${i + 1}`, args: encodeArgs(args) })),
    limits,
  };
}

/** Run one pass with static analysis deliberately bypassed, to test the runtime layers alone. */
async function runDirect(source: string, entryName: string, argLists: unknown[][]): Promise<TestResult[]> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...LIMITS } as Limits;
  const key = newResultKey();
  const request = buildRequest(source, entryName, argLists, limits, key);
  const raw = await runner.run(request, 60_000);
  const pass = reconcile('a', request.tests.map((t) => t.id), key, raw, limits);
  assert.equal(pass.status, 'ok', JSON.stringify(pass.problems));
  return pass.results;
}
