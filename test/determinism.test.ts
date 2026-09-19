/**
 * Frozen time and seeded randomness inside the sandbox (README decision #2).
 *
 * These run through the whole pipeline with LocalRunner: the shims live inside the
 * sandbox's vm context, so only an end-to-end run proves what a submission sees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { captureChallenge } from '../src/challenge/capture';
import { gradeAgainstChallenge } from '../src/challenge/grade';
import { decode, type EncodedValue } from '../src/encoding';
import { evaluate, type SubmissionReport, type TestCase } from '../src/host/orchestrator';
import { LocalRunner } from '../src/host/runner';
import { DEFAULT_LIMITS, type Limits } from '../src/protocol';

const runner = new LocalRunner();
const LIMITS: Partial<Limits> = { perTestTimeoutMs: 2_000, passTimeoutMs: 30_000 };
const EPOCH = DEFAULT_LIMITS.determinism.epochMs;

async function run(source: string, tests: TestCase[], limits: Partial<Limits> = {}): Promise<SubmissionReport> {
  return evaluate({ source, tests, runner, limits: { ...LIMITS, ...limits }, seed: 7 });
}

function returned(report: SubmissionReport, id: string): unknown {
  const r = report.results[id];
  assert.ok(r, `no result for ${id}: ${JSON.stringify(report.problems)}`);
  assert.equal(r.outcome.type, 'return', JSON.stringify(r.outcome));
  return decode((r.outcome as { value: EncodedValue }).value);
}

const CLOCK_AND_DICE = `
export function sample(label: string) {
  return {
    label,
    now: Date.now(),
    constructed: new Date().getTime(),
    called: Date(),
    rolls: [Math.random(), Math.random(), Math.random()],
  };
}`;

describe('determinism: frozen time and seeded randomness', () => {
  it('makes a time- and randomness-dependent function deterministic', async () => {
    const tests = ['a', 'b', 'c', 'd'].map((id) => ({ id, args: [id] }));
    const report = await run(CLOCK_AND_DICE, tests);
    // Without freezing, the ordered and shuffled passes would disagree on every test.
    assert.equal(report.verdict, 'ok', JSON.stringify(report.problems));

    const a = returned(report, 'a') as { now: number; constructed: number; called: string; rolls: number[] };
    // The clock starts at the epoch for every test and advances one tick per read.
    assert.equal(a.now, EPOCH);
    assert.equal(a.constructed, EPOCH + 1);
    // Rendered in the sandbox's pinned UTC, not this test process's local zone.
    assert.match(a.called, /^Wed Jan 01 2025 00:00:00 GMT\+0000/);
    for (const r of a.rolls) assert.ok(r >= 0 && r < 1, `out of range: ${r}`);
    assert.equal(new Set(a.rolls).size, 3, 'successive rolls within a test differ');
  });

  it('gives each test id its own random sequence, reproducible across runs', async () => {
    const tests = [{ id: 'x', args: ['x'] }, { id: 'y', args: ['y'] }];
    const first = await run(CLOCK_AND_DICE, tests);
    const again = await run(CLOCK_AND_DICE, [...tests].reverse());
    const rolls = (r: SubmissionReport, id: string) => (returned(r, id) as { rolls: number[] }).rolls;
    assert.notDeepEqual(rolls(first, 'x'), rolls(first, 'y'));
    assert.deepEqual(rolls(first, 'x'), rolls(again, 'x'));
    assert.deepEqual(rolls(first, 'y'), rolls(again, 'y'));
  });

  it('lets elapsed-time loops finish instead of spinning until the timeout', async () => {
    const report = await run(
      `export function wait(ms: number) {
         const start = Date.now();
         let spins = 0;
         while (Date.now() - start < ms) spins++;
         return spins;
       }`,
      [{ id: 'wait', args: [50] }],
    );
    assert.equal(report.verdict, 'ok', JSON.stringify(report.problems));
    assert.equal(returned(report, 'wait'), 49);
  });

  it('freezes module-scope reads too, not just reads inside the call', async () => {
    const report = await run(
      `const LOADED_AT = Date.now();
       export function age() { return Date.now() - LOADED_AT; }`,
      [{ id: 'age', args: [] }],
    );
    assert.equal(report.verdict, 'ok', JSON.stringify(report.problems));
    assert.equal(returned(report, 'age'), 0);
  });

  it('keeps Date behaving like Date', async () => {
    const report = await run(
      `export function probe(d: Date) {
         class Stamp extends Date { label() { return 'stamp'; } }
         const s = new Stamp();
         return {
           argIsDate: d instanceof Date,
           newIsDate: new Date() instanceof Date,
           explicit: new Date(0).toISOString(),
           viaConstructor: new (new Date(5).constructor as DateConstructor)().getTime(),
           subclass: [s instanceof Stamp, s instanceof Date, s.label(), s.getTime()],
           utc: Date.UTC(2000, 0, 1),
           parse: Date.parse('2000-01-01T00:00:00Z'),
           formatted: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' }).format(),
         };
       }`,
      [{ id: 'probe', args: [new Date(123)] }],
    );
    assert.equal(report.verdict, 'ok', JSON.stringify(report.problems));
    assert.deepEqual(returned(report, 'probe'), {
      argIsDate: true,
      newIsDate: true,
      explicit: '1970-01-01T00:00:00.000Z',
      // `new (date.constructor)()` reaches the frozen clock too, not the real one.
      viaConstructor: EPOCH + 2, // reads: new Stamp() first, then new Date(), then this
      subclass: [true, true, 'stamp', EPOCH],
      utc: Date.UTC(2000, 0, 1),
      parse: Date.UTC(2000, 0, 1),
      formatted: String(new Date(EPOCH).getUTCFullYear()),
    });
  });

  it('pins local time to UTC so results do not depend on the machine', async () => {
    const report = await run(
      'export function local(ms: number) { return [new Date(ms).getHours(), new Date(ms).getTimezoneOffset()]; }',
      [{ id: 'local', args: [0] }],
    );
    assert.deepEqual(returned(report, 'local'), [0, 0]);
  });

  it('can be switched off, which brings the nondeterminism back', async () => {
    const report = await run(
      'export function roll(n: number) { return Math.random() + n; }',
      ['a', 'b', 'c'].map((id) => ({ id, args: [1] })),
      { determinism: { ...DEFAULT_LIMITS.determinism, enabled: false } },
    );
    assert.equal(report.verdict, 'nondeterministic');
  });
});

describe('determinism: challenges', () => {
  const ORACLE = `
    export function ticket(prefix: string): string {
      return prefix + '-' + Math.floor(Math.random() * 1e6) + '@' + new Date().toISOString();
    }`;

  it('records the settings at capture, so a correct rewrite passes', async () => {
    const captured = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1, maxTests: 6 });
    assert.ok(captured.ok, captured.ok ? '' : captured.reason);
    const challenge = captured.challenge;
    assert.deepEqual(challenge.determinism, DEFAULT_LIMITS.determinism);

    const rewrite = `
      export function ticket(prefix: string): string {
        const n = Math.floor(Math.random() * 1_000_000);
        const when = new Date();
        return \`\${prefix}-\${n}@\${when.toISOString()}\`;
      }`;
    const graded = await gradeAgainstChallenge(challenge, { rewriteSource: rewrite, runner, limits: LIMITS });
    assert.equal(graded.verdict, 'passed', JSON.stringify(graded.tests.filter((t) => t.result !== 'match')));
  });

  it('grades under the captured settings even if the grader asks for others', async () => {
    const captured = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1, maxTests: 4 });
    assert.ok(captured.ok, captured.ok ? '' : captured.reason);
    const graded = await gradeAgainstChallenge(captured.challenge, {
      rewriteSource: ORACLE,
      runner,
      limits: { ...LIMITS, determinism: { ...DEFAULT_LIMITS.determinism, seed: 999, epochMs: 0 } },
    });
    assert.equal(graded.verdict, 'passed');
  });

  it('a rewrite that ignores the random sequence fails', async () => {
    const captured = await captureChallenge({ oracleSource: ORACLE, runner, limits: LIMITS, seed: 1, maxTests: 4 });
    assert.ok(captured.ok, captured.ok ? '' : captured.reason);
    const graded = await gradeAgainstChallenge(captured.challenge, {
      rewriteSource: "export function ticket(p: string) { return p + '-0@' + new Date().toISOString(); }",
      runner,
      limits: LIMITS,
    });
    assert.equal(graded.verdict, 'failed');
  });
});
