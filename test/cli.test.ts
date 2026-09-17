import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs, liftSentinels, modulesFrom } from '../src/cli';
import { VENDORED_MODULES } from '../src/bundle';

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

/** Runs the built CLI as a real subprocess and captures stdout/stderr/exit code. */
function runCli(argv: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

function withTempFile(name: string, content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tsbox-cli-test-')), name);
  fs.writeFileSync(file, content);
  return file;
}

describe('parseArgs', () => {
  it('takes the first non-flag token as the command', () => {
    const args = parseArgs(['run', '--source', 'f.ts']);
    assert.equal(args.command, 'run');
    assert.deepEqual(args.flags.get('source'), ['f.ts']);
  });

  it('defaults to help when no command is given', () => {
    assert.equal(parseArgs([]).command, 'help');
  });

  it('defaults to help when the first token is a flag', () => {
    assert.equal(parseArgs(['--help']).command, 'help');
  });

  it('accumulates repeatable flags in order', () => {
    const args = parseArgs(['check', '--source', 'f.ts', '--allow', 'a', '--allow', 'b']);
    assert.deepEqual(args.flags.get('allow'), ['a', 'b']);
  });

  it('treats a negative number as a value, not a flag', () => {
    const args = parseArgs(['run', '--source', 'f.ts', '--seed', '-5']);
    assert.deepEqual(args.flags.get('seed'), ['-5']);
  });

  for (const flag of ['help', 'json', 'mutate', 'unsafe-local', 'unsafe-runtime']) {
    it(`treats --${flag} as a presence-only switch, never consuming the next token as its value`, () => {
      const args = parseArgs(['capture', '--source', 'f.ts', `--${flag}`, '--seed', '3']);
      assert.deepEqual(args.flags.get(flag), ['true']);
      assert.deepEqual(args.flags.get('seed'), ['3']);
    });
  }

  it('rejects a value-taking flag with nothing after it, instead of silently taking the literal string "true"', () => {
    // Regression: this used to make `modulesFrom` return `["true"]` as the module
    // allowlist, silently rejecting every real module with a confusing
    // "(allowed: true)" error instead of a clear complaint about --allow itself.
    assert.throws(() => parseArgs(['check', '--source', 'f.ts', '--allow']), /--allow requires a value/);
  });

  it('rejects a value-taking flag immediately followed by another flag', () => {
    assert.throws(() => parseArgs(['analyze', '--source', 'f.ts', '--entry', '--json']), /--entry requires a value/);
  });
});

describe('modulesFrom', () => {
  it('defaults to exactly the vendored modules when --allow is absent', () => {
    assert.deepEqual(modulesFrom({ command: 'check', flags: new Map() }), [...VENDORED_MODULES]);
  });

  it('extends the vendored defaults rather than replacing them', () => {
    // Regression: USAGE documents --allow as "Add a module to the import allowlist
    // (repeatable)", but it used to replace VENDORED_MODULES wholesale -- a user
    // adding one extra module they needed silently lost permission for
    // lodash-es/date-fns/ms too.
    const flags = new Map([['allow', ['some-extra-module']]]);
    const result = modulesFrom({ command: 'check', flags });
    for (const m of VENDORED_MODULES) assert.ok(result.includes(m), `expected ${m} to still be allowed`);
    assert.ok(result.includes('some-extra-module'));
  });
});

describe('CLI process behaviour', () => {
  it('reports an unknown command as such, not as a misleading "--source is required"', () => {
    // Regression: the command-name check used to run AFTER the shared --source
    // requirement, so a typo'd command with no --source was misdiagnosed.
    const result = runCli(['frobnicate']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command 'frobnicate'/);
  });

  it('rejects a test file whose "args" is present but not an array, instead of silently treating it as []', () => {
    const source = withTempFile('f.ts', 'export function add(a: number, b: number): number { return a + b; }');
    const tests = withTempFile('tests.json', JSON.stringify({ tests: [{ id: 't1', args: { not: 'an array' } }] }));
    const result = runCli(['run', '--source', source, '--tests', tests, '--runner', 'local', '--unsafe-local']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /test 't1' has an "args" that is not an array/);
  });

  it('exits 0 for `mutate` on a function with nothing mutable, matching captureChallenge\'s own no_mutants gate', () => {
    // Regression: this used to exit 1 even though captureChallenge's minMutationScore
    // gate treats the identical "nothing to mutate" condition as passing.
    const source = withTempFile('f.ts', "export function greet(): string { return 'hi'; }");
    const tests = withTempFile('tests.json', JSON.stringify({ tests: [{ id: 't1', args: [] }] }));
    const result = runCli(['mutate', '--source', source, '--tests', tests, '--runner', 'local', '--unsafe-local']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /mutation score : n\/a/);
  });
});

describe('liftSentinels', () => {
  it('converts the five documented sentinels', () => {
    assert.equal(liftSentinels('@@NaN'), NaN);
    assert.equal(liftSentinels('@@Infinity'), Infinity);
    assert.equal(liftSentinels('@@-Infinity'), -Infinity);
    assert.ok(Object.is(liftSentinels('@@-0'), -0));
    assert.equal(liftSentinels('@@undefined'), undefined);
  });

  it('passes through an ordinary string unchanged', () => {
    assert.equal(liftSentinels('hello'), 'hello');
  });

  it('passes through a string that merely starts with @@ but is not a recognised sentinel', () => {
    assert.equal(liftSentinels('@@weird'), '@@weird');
  });

  it('unescapes @@@@ to a literal @@ prefix', () => {
    assert.equal(liftSentinels('@@@@literal'), '@@literal');
    assert.equal(liftSentinels('@@@@NaN'), '@@NaN');
  });

  it('recurses into arrays and plain objects', () => {
    assert.deepEqual(liftSentinels(['@@NaN', { x: '@@undefined' }]), [NaN, { x: undefined }]);
  });

  it('leaves numbers, booleans, and null untouched', () => {
    assert.equal(liftSentinels(42), 42);
    assert.equal(liftSentinels(true), true);
    assert.equal(liftSentinels(null), null);
  });
});
