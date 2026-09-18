import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';

import { bundleSubmission, VENDORED_MODULES } from '../src/bundle';
import { checkSource } from '../src/import-guard';
import { transpileSubmission } from '../src/transpile';

describe('bundleSubmission', () => {
  it('is a no-op when nothing was referenced', async () => {
    const code = '"use strict";\nexports.f = function () { return 1; };';
    const result = await bundleSubmission(code, []);
    assert.deepEqual(result, { ok: true, code });
  });

  it('every vendored module is actually installed', () => {
    for (const spec of VENDORED_MODULES) {
      assert.doesNotThrow(() => require.resolve(spec), `VENDORED_MODULES lists '${spec}' but it is not installed`);
    }
  });

  it('inlines a vendored dependency into a single self-contained script', async () => {
    const source = `
      import { chunk } from 'lodash-es';
      export function firstPair(xs: number[]): number[] {
        return chunk(xs, 2)[0] ?? [];
      }
    `;
    const guard = checkSource(source, { allowedModules: VENDORED_MODULES });
    assert.equal(guard.ok, true);
    if (!guard.ok) return;

    const transpiled = transpileSubmission(source);
    assert.equal(transpiled.ok, true);
    if (!transpiled.ok) return;

    const bundled = await bundleSubmission(transpiled.code, guard.referencedModules);
    assert.equal(bundled.ok, true);
    if (!bundled.ok) return;

    // No remaining require() of the vendored package: it must be inlined, not left
    // for a runtime `require` that the sandbox doesn't provide.
    assert.ok(!/require\(\s*["']lodash-es["']\s*\)/.test(bundled.code));

    // The bundle runs standalone in a vm context configured the same way as the
    // sandbox's (see src/sandbox/harness.ts): no string code generation, `exports`
    // and `module.exports` are the same object until reassigned, no real require.
    const moduleObj = { exports: {} as { firstPair?: (xs: number[]) => number[] } };
    const context = vm.createContext(
      { module: moduleObj, exports: moduleObj.exports },
      { codeGeneration: { strings: false, wasm: false } },
    );
    vm.runInContext('globalThis.global = globalThis', context);
    vm.runInContext(bundled.code, context);
    // Array.from: the result is a cross-realm array (this vm context has its own
    // Array.prototype), so assert.deepEqual's identity checks don't apply to it.
    assert.deepEqual(Array.from(moduleObj.exports.firstPair?.([1, 2, 3, 4]) ?? []), [1, 2]);
  });

  it('inlines a legacy-CommonJS vendored dependency (ms) accessed via a default import', async () => {
    const source = `
      import ms from 'ms';
      export function toSeconds(input: string): number {
        return ms(input) / 1000;
      }
    `;
    const guard = checkSource(source, { allowedModules: VENDORED_MODULES });
    assert.equal(guard.ok, true);
    if (!guard.ok) return;

    const transpiled = transpileSubmission(source);
    assert.equal(transpiled.ok, true);
    if (!transpiled.ok) return;

    const bundled = await bundleSubmission(transpiled.code, guard.referencedModules);
    assert.equal(bundled.ok, true);
    if (!bundled.ok) return;
    assert.ok(!/require\(\s*["']ms["']\s*\)/.test(bundled.code));

    const moduleObj = { exports: {} as { toSeconds?: (input: string) => number } };
    const context = vm.createContext(
      { module: moduleObj, exports: moduleObj.exports },
      { codeGeneration: { strings: false, wasm: false } },
    );
    vm.runInContext('globalThis.global = globalThis', context);
    vm.runInContext(bundled.code, context);
    assert.equal(moduleObj.exports.toSeconds?.('2 days'), 172_800);
  });

  it('rejects a specifier outside the allowlist before bundling is ever reached', () => {
    const guard = checkSource("import { z } from 'left-pad'; export function f() { return z; }", {
      allowedModules: VENDORED_MODULES,
    });
    assert.equal(guard.ok, false);
  });
});
