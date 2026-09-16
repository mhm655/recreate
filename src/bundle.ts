/**
 * Inlines vetted dependencies into a submission, on the HOST, after transpilation.
 *
 * The sandbox image ships no `node_modules` (see docker/Dockerfile) and the worker's
 * `require` throws unconditionally (see src/sandbox/worker.ts) -- both on purpose, to
 * keep the code inside the isolation boundary to a minimum. Supporting a dependency
 * like `lodash-es` without touching either of those means resolving and inlining its
 * code on the host, where the TypeScript compiler already runs for the import
 * allowlist check, so the submission that reaches the worker is once again a single
 * self-contained script with no `require` of anything.
 *
 * This only ever runs on modules that `checkSource` already accepted, i.e. modules
 * present in `VENDORED_MODULES` below. It does not widen what a submission may
 * reference; it changes how an already-allowed reference is satisfied.
 */

import * as path from 'node:path';
import * as esbuild from 'esbuild';

/**
 * Vetted dependencies available to submissions, keyed by the exact specifier a
 * submission may `import`/`require`. Each entry must be a real dependency in
 * package.json -- `checkVendoredModulesInstalled` (called from tests) verifies that,
 * so this list can't silently drift from what's actually vendored into the host's
 * node_modules.
 *
 * Adding an entry here is a supply-chain decision: the package's code runs, inlined,
 * as part of every submission that imports it. Vet the package (and its own
 * dependencies, since esbuild will pull those in too) before adding it.
 */
export const VENDORED_MODULES: readonly string[] = ['lodash-es'];

export type BundleResult = { ok: true; code: string } | { ok: false; detail: string };

/**
 * Bundles `code` (already transpiled to CommonJS by transpileSubmission) together
 * with any of `referencedModules` that are vendored, producing a single script with
 * no remaining `require()` of an external package.
 *
 * Skips esbuild entirely when nothing was referenced, so a submission with no
 * imports pays no bundling cost.
 */
export async function bundleSubmission(
  code: string,
  referencedModules: readonly string[],
): Promise<BundleResult> {
  if (referencedModules.length === 0) return { ok: true, code };

  try {
    const result = await esbuild.build({
      stdin: {
        contents: code,
        loader: 'js',
        resolveDir: path.resolve(__dirname, '..', '..'), // repository root: where node_modules lives
        sourcefile: 'submission.js',
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      // Nothing is external: the whole point is that the worker sees one script and
      // never calls a real `require`. Anything not vendored would fail to resolve
      // here -- but checkSource already rejected any specifier outside the allowlist
      // before this function is reached, so that path is unreachable in practice.
      external: [],
      logLevel: 'silent',
    });
    const out = result.outputFiles?.[0]?.text;
    if (!out) return { ok: false, detail: 'esbuild produced no output' };
    return { ok: true, code: out };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `dependency bundling failed: ${message}` };
  }
}
