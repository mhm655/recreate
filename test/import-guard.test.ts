import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkSource, DEFAULT_ALLOWED_MODULES, type GuardResult, type ViolationCode } from '../src/import-guard';

function codes(result: GuardResult): ViolationCode[] {
  return result.ok ? [] : result.violations.map((v) => v.code);
}

function assertRejected(source: string, expected: ViolationCode, opts = {}) {
  const result = checkSource(source, opts);
  assert.equal(result.ok, false, `expected rejection for:\n${source}`);
  assert.ok(
    codes(result).includes(expected),
    `expected '${expected}', got [${codes(result).join(', ')}] for:\n${source}`,
  );
}

describe('import guard: allowlist', () => {
  it('ships with an empty allowlist', () => {
    assert.deepEqual([...DEFAULT_ALLOWED_MODULES], []);
  });

  it('accepts a pure function with no imports', () => {
    const r = checkSource('export function add(a: number, b: number): number { return a + b; }');
    assert.deepEqual(r, { ok: true, entryName: 'add', entryIsDefaultExport: false, referencedModules: [] });
  });

  for (const [label, source] of [
    ['default import', "import fs from 'fs'; export function f() { return fs; }"],
    ['named import from node:', "import { execSync } from 'node:child_process'; export function f() { return execSync; }"],
    ['namespace import', "import * as wt from 'worker_threads'; export function f() { return wt; }"],
    ['side-effect import', "import 'net'; export function f() { return 1; }"],
    ['re-export', "export * from 'http'; export function f() { return 1; }"],
    ['import = require', "import cp = require('child_process'); export function f() { return cp; }"],
    ['static require', "export function f() { return require('child_process'); }"],
    ['require with template literal', 'export function f() { return require(`child_process`); }'],
    ['literal dynamic import', "export async function f() { return import('node:fs'); }"],
  ] as const) {
    it(`rejects ${label}`, () => assertRejected(source, 'disallowed-import'));
  }

  it('permits exactly the modules added to the allowlist, with no subpath implied', () => {
    const ok = checkSource("import { chunk } from 'lodash-es'; export function f(x: number[]) { return chunk(x, 2); }", {
      allowedModules: ['lodash-es'],
    });
    assert.equal(ok.ok, true);
    assertRejected("import fp from 'lodash-es/fp'; export function f() { return fp; }", 'disallowed-import', {
      allowedModules: ['lodash-es'],
    });
  });

  it('still enforces the module allowlist when global heuristics are switched off', () => {
    assertRejected("import fs from 'fs'; export function f() { return fs; }", 'disallowed-import', {
      skipGlobalHeuristics: true,
    });
  });
});

describe('import guard: disguised and dynamic module loading', () => {
  it('rejects a computed require specifier', () => {
    assertRejected("export function f() { return require('child_' + 'process'); }", 'dynamic-require');
  });

  it('rejects require called through an alias', () => {
    assertRejected("const r = require; export function f() { return r('child_process'); }", 'indirect-require');
  });

  it('rejects require passed around as a value', () => {
    assertRejected("export function f() { return [require][0]('worker_threads'); }", 'indirect-require');
  });

  it('rejects a computed dynamic import', () => {
    assertRejected("export async function f(m: string) { return import(m); }", 'dynamic-import');
  });

  it('rejects import.meta', () => {
    assertRejected('export function f() { return import.meta.url; }', 'import-meta');
  });

  it('rejects reaching require through globalThis', () => {
    assertRejected("export function f() { return (globalThis as any)['req' + 'uire']('fs'); }", 'dangerous-global');
  });

  it('rejects process, eval and module references', () => {
    assertRejected('export function f() { return process.env.HOME; }', 'dangerous-global');
    assertRejected("export function f() { return eval('1 + 1'); }", 'dangerous-global');
    assertRejected("export function f() { return (module as any).require('fs'); }", 'dangerous-global');
  });

  it('does not flag locals or properties that merely share a dangerous name', () => {
    const r = checkSource(`
      export function f(input: { process: string; require: boolean }) {
        const process = input.process.trim();
        const module = { name: 'm' };
        type T = { eval: number };
        return process + module.name + String(input.require);
      }`);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe('import guard: entry point resolution', () => {
  it('prefers the default export', () => {
    const r = checkSource('function helper() { return 1; } export default function main() { return helper(); }');
    assert.equal(r.ok && r.entryName, 'main');
    assert.equal(r.ok && r.entryIsDefaultExport, true);
  });

  it('handles an anonymous default export', () => {
    const r = checkSource('export default function (x: number) { return x * 2; }');
    assert.equal(r.ok && r.entryName, 'default');
  });

  it('handles `export default <identifier>`', () => {
    const r = checkSource('const double = (x: number) => x * 2; export default double;');
    assert.equal(r.ok && r.entryName, 'double');
  });

  it('uses the single exported function when there are private helpers', () => {
    const r = checkSource('function helper() { return 1; } export const run = () => helper();');
    assert.equal(r.ok && r.entryName, 'run');
  });

  it('uses a sole unexported top-level function', () => {
    const r = checkSource('function slugify(s: string) { return s.toLowerCase(); }');
    assert.equal(r.ok && r.entryName, 'slugify');
  });

  it('treats overload declarations and their implementation as one function', () => {
    const r = checkSource(`
      export function pad(s: string): string;
      export function pad(n: number, width: number): string;
      export function pad(x: string | number, width = 2): string { return String(x).padStart(width); }`);
    assert.equal(r.ok && r.entryName, 'pad', JSON.stringify(r));
  });

  it('rejects ambiguity instead of guessing', () => {
    assertRejected('export function a() {} export function b() {}', 'ambiguous-entry-point');
  });

  it('honours an explicit entry name', () => {
    const r = checkSource('export function a() {} export function b() {}', { entryName: 'b' });
    assert.equal(r.ok && r.entryName, 'b');
  });

  it('rejects an explicit entry name that does not exist', () => {
    assertRejected('export function a() {}', 'entry-point-not-found', { entryName: 'zzz' });
  });

  it('rejects an entry name that is not an identifier (it is spliced into generated code)', () => {
    assertRejected('export function a() {}', 'invalid-entry-name', { entryName: 'a; globalThis.x = 1; a' });
  });

  it('rejects source with no function at all', () => {
    assertRejected('export const n = 42;', 'no-entry-point');
  });
});

describe('import guard: input hygiene', () => {
  it('rejects unparseable source', () => {
    assertRejected('export function f( { return 1 }', 'parse-error');
  });

  it('rejects oversized source', () => {
    assertRejected(`export function f() { return 1; }\n//${'x'.repeat(300 * 1024)}`, 'source-too-large');
  });

  it('reports line and column for violations', () => {
    const r = checkSource("export function f() {\n  return require('fs');\n}");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.violations[0].line, 2);
      assert.equal(r.violations[0].column, 10);
    }
  });
});
