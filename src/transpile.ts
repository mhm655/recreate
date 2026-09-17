/**
 * TypeScript -> JavaScript, on the HOST.
 *
 * Why here and not inside the sandbox: the host already parses the untrusted source
 * with the TypeScript compiler for the import allowlist check, so emitting JS from
 * that parse adds essentially no new attack surface on the host. Doing it here buys
 * three things inside the sandbox:
 *
 *   - the image ships no `node_modules` at all -- the harness uses only Node
 *     built-ins, so there is less code inside the boundary for an escape to use;
 *   - the worker's V8 heap cap is spent on the submission, not on loading a 10 MB
 *     compiler, and a restarted worker comes up in milliseconds;
 *   - a transpile failure is reported as a rejection before any container starts.
 *
 * Types are erased, never checked. A submission that fails typechecking still has
 * behaviour, and behaviour is what this layer characterises.
 */

import * as ts from 'typescript';

export type TranspileResult = { ok: true; code: string } | { ok: false; detail: string };

export function transpileSubmission(source: string): TranspileResult {
  try {
    const out = ts.transpileModule(source, {
      fileName: 'submission.ts',
      reportDiagnostics: true,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
        sourceMap: false,
        inlineSourceMap: false,
        // Without this, `import x from 'mod'` compiles to code that reads
        // `mod_1.default`, which only exists on a real ES module. A legacy
        // CommonJS dependency (`module.exports = fn`, no `.default`) -- like the
        // vendored `ms` package -- would transpile fine and then throw
        // "is not a function" at runtime. esModuleInterop wraps a plain CJS
        // export in `{ default: ... }` via TS's standard `__importDefault`
        // helper, exactly as any real-world TS project consuming both ESM and
        // CJS dependencies already needs.
        esModuleInterop: true,
      },
    });
    const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
      return { ok: false, detail: ts.flattenDiagnosticMessageText(errors[0].messageText, ' ') };
    }
    return { ok: true, code: out.outputText };
  } catch (err) {
    // Pathological input (e.g. nesting deep enough to overflow the parser's stack).
    return { ok: false, detail: `transpile failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
