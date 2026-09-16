/**
 * Static screening, run on the host *before* a container is ever launched.
 *
 * Two jobs:
 *   1. Reject any module reference outside an explicit allowlist (default-deny).
 *   2. Work out which function in the source is the entry point.
 *
 * On the allowlist vs blocklist question: the module check below is a true
 * allowlist -- an empty `allowedModules` means "no imports at all", and the only way
 * to permit something is to add it to one short array. A blocklist of scary module
 * names would silently permit the next one nobody thought of.
 *
 * The `DANGEROUS_GLOBALS` check further down is a different animal and is labelled
 * as such: it is a *blocklist*, and it is trivially defeated (`this['pro'+'cess']`,
 * `Reflect.get(globalThis, x)`, and so on). It exists to give a submitter a clear,
 * early, readable error instead of a confusing sandbox failure. It is NOT relied on
 * for security. Anything that slips past it meets the sandbox: a `vm` context with
 * no Node globals in it, inside a gVisor container with no network, a read-only
 * filesystem, and dropped capabilities.
 *
 * This module never evaluates the source. It only parses it.
 */

import * as ts from 'typescript';

/**
 * The allowlist. Audit target: this array and nothing else decides which modules a
 * submitted function may reference.
 *
 * Empty by default, because the MVP grades pure functions -- they need no imports.
 * To extend, add the exact specifier string, e.g.:
 *
 *     export const DEFAULT_ALLOWED_MODULES = ['lodash-es'];
 *
 * Entries are matched exactly. Subpaths are not implied: allowing 'lodash-es' does
 * not allow 'lodash-es/fp'. There is no wildcard support, on purpose.
 */
export const DEFAULT_ALLOWED_MODULES: readonly string[] = [];

/**
 * Best-effort readability check only -- see module docblock. Not a security control.
 */
const DANGEROUS_GLOBALS: readonly string[] = [
  'require', 'process', 'module', 'exports', '__dirname', '__filename',
  'globalThis', 'eval', 'WebAssembly', 'SharedArrayBuffer', 'Atomics',
  'fetch', 'XMLHttpRequest', 'Deno', 'Bun',
];

const MAX_SOURCE_BYTES = 256 * 1024;

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'let', 'static', 'await', 'implements', 'interface', 'package', 'private',
  'protected', 'public',
]);

export type ViolationCode =
  | 'source-too-large'
  | 'parse-error'
  | 'disallowed-import'
  | 'dynamic-import'
  | 'dynamic-require'
  | 'indirect-require'
  | 'import-meta'
  | 'dangerous-global'
  | 'no-entry-point'
  | 'ambiguous-entry-point'
  | 'entry-point-not-found'
  | 'invalid-entry-name';

export interface Violation {
  code: ViolationCode;
  message: string;
  line?: number;
  column?: number;
  snippet?: string;
}

export type GuardResult =
  | { ok: true; entryName: string; entryIsDefaultExport: boolean; referencedModules: string[] }
  | { ok: false; violations: Violation[] };

export interface GuardOptions {
  allowedModules?: readonly string[];
  /** Explicit entry point. `'default'` selects the default export. */
  entryName?: string;
  /** Skip the best-effort global-identifier blocklist (the module allowlist still applies). */
  skipGlobalHeuristics?: boolean;
  fileName?: string;
}

export function checkSource(source: string, options: GuardOptions = {}): GuardResult {
  const allowed = new Set(options.allowedModules ?? DEFAULT_ALLOWED_MODULES);
  const violations: Violation[] = [];
  const referencedModules = new Set<string>();

  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      violations: [{
        code: 'source-too-large',
        message: `source exceeds ${MAX_SOURCE_BYTES} bytes`,
      }],
    };
  }

  const fileName = options.fileName ?? 'submission.ts';
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  // ts.createSourceFile is error-tolerant; surface hard syntax errors rather than
  // shipping something unparseable to the sandbox.
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of syntactic.slice(0, 5)) {
    violations.push({
      code: 'parse-error',
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      ...positionOf(sf, d.start ?? 0),
    });
  }
  if (violations.length) return { ok: false, violations };

  const declaredNames = collectDeclaredNames(sf);

  const report = (code: ViolationCode, message: string, node: ts.Node) => {
    violations.push({
      code,
      message,
      ...positionOf(sf, node.getStart(sf)),
      snippet: snippetOf(sf, node),
    });
  };

  const checkSpecifier = (spec: ts.Expression | undefined, node: ts.Node, what: string) => {
    if (!spec || !ts.isStringLiteralLike(spec)) {
      report('dynamic-import', `${what} with a non-literal specifier cannot be statically screened`, node);
      return;
    }
    const name = spec.text;
    referencedModules.add(name);
    if (!allowed.has(name)) {
      report(
        'disallowed-import',
        `module '${name}' is not in the allowlist${allowed.size ? ` (allowed: ${[...allowed].join(', ')})` : ' (the allowlist is empty)'}`,
        node,
      );
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      checkSpecifier(node.moduleSpecifier, node, 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      checkSpecifier(node.moduleSpecifier, node, 're-export');
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        checkSpecifier(node.moduleReference.expression, node, 'import =');
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(arg, node, 'dynamic import()');
        else report('dynamic-import', 'dynamic import() with a computed specifier is rejected', node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(arg, node, 'require()');
        else {
          report(
            'dynamic-require',
            'require() with a computed specifier is rejected; the target cannot be screened statically',
            node,
          );
        }
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report('import-meta', 'import.meta is not available to submitted functions', node);
    }

    if (ts.isIdentifier(node) && !isNonReferencePosition(node)) {
      const name = node.text;
      if (name === 'require' && !declaredNames.has('require')) {
        const parent = node.parent;
        const isDirectCall = parent && ts.isCallExpression(parent) && parent.expression === node;
        if (!isDirectCall) {
          // `const r = require; r('fs')` and friends.
          report('indirect-require', 'indirect reference to require is rejected', node);
        }
      } else if (
        !options.skipGlobalHeuristics &&
        name !== 'require' &&
        DANGEROUS_GLOBALS.indexOf(name) !== -1 &&
        !declaredNames.has(name)
      ) {
        report(
          'dangerous-global',
          `reference to '${name}' is rejected (best-effort readability check; the sandbox does not expose it either)`,
          node,
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  const entry = resolveEntryPoint(sf, options.entryName);
  if (!entry.ok) violations.push(entry.violation);

  if (violations.length) return { ok: false, violations: dedupe(violations) };
  if (!entry.ok) throw new Error('unreachable');

  return {
    ok: true,
    entryName: entry.entryName,
    entryIsDefaultExport: entry.isDefaultExport,
    referencedModules: [...referencedModules],
  };
}

// --- entry point resolution ----------------------------------------------

type EntryResolution =
  | { ok: true; entryName: string; isDefaultExport: boolean }
  | { ok: false; violation: Violation };

interface Candidate {
  name: string;
  exported: boolean;
  isDefault: boolean;
}

function resolveEntryPoint(sf: ts.SourceFile, requested?: string): EntryResolution {
  const candidates: Candidate[] = [];
  let hasAnonymousDefault = false;

  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) ?? [] : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name) {
        // Overload declarations and their implementation share one name: one function.
        const existing = candidates.find((c) => c.name === stmt.name!.text);
        if (existing) {
          existing.exported ||= exported;
          existing.isDefault ||= isDefault;
        } else {
          candidates.push({ name: stmt.name.text, exported, isDefault });
        }
      } else if (isDefault) hasAnonymousDefault = true;
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          candidates.push({ name: decl.name.text, exported, isDefault: false });
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      // `export default foo` / `export = foo`
      if (ts.isIdentifier(stmt.expression)) {
        const existing = candidates.find((c) => c.name === (stmt.expression as ts.Identifier).text);
        if (existing) {
          existing.isDefault = true;
          existing.exported = true;
        } else {
          candidates.push({ name: stmt.expression.text, exported: true, isDefault: true });
        }
      } else {
        hasAnonymousDefault = true;
      }
    }
  }

  if (requested !== undefined) {
    if (requested !== 'default' && !isValidIdentifier(requested)) {
      return {
        ok: false,
        violation: { code: 'invalid-entry-name', message: `'${requested}' is not a valid identifier` },
      };
    }
    if (requested === 'default') {
      if (!hasAnonymousDefault && !candidates.some((c) => c.isDefault)) {
        return {
          ok: false,
          violation: { code: 'entry-point-not-found', message: 'no default export found' },
        };
      }
      const named = candidates.find((c) => c.isDefault);
      return named
        ? { ok: true, entryName: named.name, isDefaultExport: true }
        : { ok: true, entryName: 'default', isDefaultExport: true };
    }
    if (!candidates.some((c) => c.name === requested)) {
      return {
        ok: false,
        violation: {
          code: 'entry-point-not-found',
          message: `no top-level function named '${requested}' (found: ${candidates.map((c) => c.name).join(', ') || 'none'})`,
        },
      };
    }
    return { ok: true, entryName: requested, isDefaultExport: false };
  }

  const byDefault = candidates.filter((c) => c.isDefault);
  if (byDefault.length === 1) return { ok: true, entryName: byDefault[0].name, isDefaultExport: true };
  if (hasAnonymousDefault && candidates.length === 0) {
    return { ok: true, entryName: 'default', isDefaultExport: true };
  }

  const exported = candidates.filter((c) => c.exported);
  if (exported.length === 1) return { ok: true, entryName: exported[0].name, isDefaultExport: false };
  if (exported.length > 1) {
    return {
      ok: false,
      violation: {
        code: 'ambiguous-entry-point',
        message: `multiple exported functions (${exported.map((c) => c.name).join(', ')}); specify one explicitly`,
      },
    };
  }

  if (candidates.length === 1) return { ok: true, entryName: candidates[0].name, isDefaultExport: false };
  if (candidates.length > 1) {
    return {
      ok: false,
      violation: {
        code: 'ambiguous-entry-point',
        message: `multiple top-level functions (${candidates.map((c) => c.name).join(', ')}); specify one explicitly`,
      },
    };
  }

  return {
    ok: false,
    violation: { code: 'no-entry-point', message: 'no top-level function declaration found' },
  };
}

export function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name);
}

// --- helpers --------------------------------------------------------------

/**
 * Every name bound anywhere in the file. Used to suppress the global blocklist when
 * the identifier is obviously a local. Intentionally an over-approximation: a name
 * bound in one function suppresses the warning everywhere. That errs towards fewer
 * false rejections, which is the right direction for a check that is not a security
 * control in the first place.
 */
function collectDeclaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName | undefined) => {
    if (!name) return;
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBinding(el.name);
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBinding(node.name);
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
    } else if (ts.isImportClause(node)) {
      if (node.name) names.add(node.name.text);
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      names.add(node.name.text);
    } else if (ts.isCatchClause(node)) {
      addBinding(node.variableDeclaration?.name);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

/** True when the identifier is a property name, label, or declaration name rather than a value reference. */
function isNonReferencePosition(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (ts.isQualifiedName(p) && p.right === node) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  if (ts.isPropertyDeclaration(p) && p.name === node) return true;
  if (ts.isMethodDeclaration(p) && p.name === node) return true;
  if (ts.isMethodSignature(p) && p.name === node) return true;
  if (ts.isGetAccessorDeclaration(p) && p.name === node) return true;
  if (ts.isSetAccessorDeclaration(p) && p.name === node) return true;
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) return false;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
  if (ts.isLabeledStatement(p) && p.label === node) return true;
  if (ts.isBreakOrContinueStatement(p) && p.label === node) return true;
  // Type positions never execute.
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return true;
  return false;
}

function positionOf(sf: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

function snippetOf(sf: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(sf);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = `${v.code}:${v.line}:${v.column}:${v.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
