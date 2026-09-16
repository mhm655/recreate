/**
 * Static analysis of a function under test. Runs on the HOST and never executes
 * the source.
 *
 * The compiler sees exactly two kinds of file: the submission, held in memory, and
 * TypeScript's bundled ES2022 lib declarations. The compiler host refuses every other
 * path, so an `import` cannot pull a file off the analysing machine into the
 * program: imported types simply come back as unresolved.
 *
 * Type checking cannot run code, but a hostile source can still make the checker
 * work very hard (deeply instantiated generic types). For sources you did not write,
 * use `analyzeIsolated` (./isolated.ts), which runs this in a worker thread with a
 * timeout and a heap cap.
 */

import * as path from 'node:path';
import * as ts from 'typescript';

import { checkSource, type GuardOptions } from '../import-guard';
import { ShapeBuilder } from './type-shape';
import type {
  AnalysisResult,
  FunctionAnalysis,
  Generatability,
  ModuleStateHint,
  NondeterminismKind,
  NondeterminismSource,
  ParamInfo,
  SignatureInfo,
  SourceLocation,
  TypeShape,
} from './types';

export interface AnalyzeOptions {
  /** Entry point name, or 'default'. Inferred with the same rules as the harness when omitted. */
  entryName?: string;
  allowedModules?: GuardOptions['allowedModules'];
}

const SUBMISSION_PATH = '/submission/submission.ts';

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  // No DOM and no @types/node: those globals do not exist in the sandbox realm
  // either, so a type error for `performance` or `process` is accurate information.
  lib: ['lib.es2022.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  types: [],
  skipLibCheck: true,
  isolatedModules: true,
};

const normalize = (p: string) => p.replace(/\\/g, '/');
const LIB_DIR = normalize(path.dirname(ts.getDefaultLibFilePath(COMPILER_OPTIONS)));

/** Lib declarations are immutable and expensive to parse; share them across analyses. */
const libCache = new Map<string, ts.SourceFile>();

function isLibFile(fileName: string): boolean {
  const f = normalize(fileName);
  return path.posix.dirname(f) === LIB_DIR && /^lib\.[\w.]+\.d\.ts$/.test(path.posix.basename(f));
}

function createHost(source: string): ts.CompilerHost {
  return {
    getSourceFile(fileName, languageVersion) {
      if (fileName === SUBMISSION_PATH) {
        return ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS);
      }
      if (!isLibFile(fileName)) return undefined;
      const key = normalize(fileName);
      let sf = libCache.get(key);
      if (!sf) {
        const text = ts.sys.readFile(fileName);
        if (text === undefined) return undefined;
        sf = ts.createSourceFile(fileName, text, languageVersion, false, ts.ScriptKind.TS);
        libCache.set(key, sf);
      }
      return sf;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    writeFile: () => undefined,
    getCurrentDirectory: () => '/submission',
    getDirectories: () => [],
    directoryExists: (dir) => normalize(dir) === LIB_DIR || dir === '/submission',
    fileExists: (f) => f === SUBMISSION_PATH || (isLibFile(f) && ts.sys.fileExists(f)),
    readFile: (f) => (f === SUBMISSION_PATH ? source : isLibFile(f) ? ts.sys.readFile(f) : undefined),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
}

export function analyzeFunction(source: string, options: AnalyzeOptions = {}): AnalysisResult {
  // Same screening and entry-point rules as the harness, so the analyzer never
  // describes a function the sandbox would refuse to run, or a different function
  // from the one it would run.
  const guard = checkSource(source, { entryName: options.entryName, allowedModules: options.allowedModules });
  if (!guard.ok) {
    return {
      ok: false,
      errors: guard.violations.map((v) => ({ code: v.code, message: v.message, line: v.line, column: v.column })),
    };
  }

  const program = ts.createProgram({ rootNames: [SUBMISSION_PATH], options: COMPILER_OPTIONS, host: createHost(source) });
  const sf = program.getSourceFile(SUBMISSION_PATH);
  if (!sf) return { ok: false, errors: [{ code: 'internal', message: 'submission missing from program' }] };
  const checker = program.getTypeChecker();

  const decl = findEntryDeclaration(sf, guard.entryName, guard.entryIsDefaultExport);
  if (!decl) {
    return { ok: false, errors: [{ code: 'entry-point-not-found', message: `could not locate '${guard.entryName}'` }] };
  }

  const shapes = new ShapeBuilder(checker, program, decl);
  const fnType = checker.getTypeAtLocation(decl);
  const isAsync = (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Async) !== 0;
  const isGenerator = !!(decl as ts.FunctionLikeDeclarationBase).asteriskToken;

  const signatures: SignatureInfo[] = checker
    .getSignaturesOfType(fnType, ts.SignatureKind.Call)
    .map((sig) => describeSignature(sig, checker, shapes, isAsync));

  const analysis: FunctionAnalysis = {
    entryName: guard.entryName,
    isDefaultExport: guard.entryIsDefaultExport,
    isAsync,
    isGenerator,
    signatures,
    nondeterminism: findNondeterminism(sf, checker, program),
    moduleState: findModuleState(sf, checker),
    generatability: assessGeneratability(signatures, isGenerator),
    typeErrors: [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
      .slice(0, 5)
      .map((d) => formatDiagnostic(sf, d)),
  };
  return { ok: true, analysis };
}

// --- entry point ----------------------------------------------------------

type EntryDeclaration = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function findEntryDeclaration(sf: ts.SourceFile, name: string, isDefault: boolean): EntryDeclaration | undefined {
  const isFn = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression =>
    !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

  let found: EntryDeclaration | undefined;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      const hasDefault = (ts.getCombinedModifierFlags(stmt) & ts.ModifierFlags.Default) !== 0;
      const matches = stmt.name ? stmt.name.text === name : isDefault && hasDefault && name === 'default';
      // Prefer the implementation over overload declarations; the checker reports
      // the overload signatures from the symbol either way.
      if (matches && (!found || stmt.body)) found = stmt;
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && isFn(d.initializer)) found = d.initializer;
      }
    } else if (ts.isExportAssignment(stmt) && name === 'default' && isFn(stmt.expression)) {
      found = stmt.expression;
    }
  }
  return found;
}

function describeSignature(sig: ts.Signature, checker: ts.TypeChecker, shapes: ShapeBuilder, isAsync: boolean): SignatureInfo {
  const params: ParamInfo[] = sig.getParameters().map((sym) => {
    const decl = sym.valueDeclaration;
    if (!decl || !ts.isParameter(decl)) {
      return { name: sym.name, optional: false, rest: false, type: { kind: 'unknown', reason: 'unsupported', text: '?' } };
    }
    const type = checker.getTypeOfSymbolAtLocation(sym, decl);
    const rest = !!decl.dotDotDotToken;
    const optional = !rest && (!!decl.questionToken || !!decl.initializer || checker.isOptionalParameter(decl));
    const info: ParamInfo = {
      name: decl.name.getText(),
      optional,
      rest,
      type: optional ? shapes.shapeOptional(type) : shapes.shape(type),
    };
    if (decl.initializer) info.defaultText = decl.initializer.getText();
    return info;
  });

  const declaredReturn = checker.getReturnTypeOfSignature(sig);
  const returnType = isAsync ? (checker.getAwaitedType(declaredReturn) ?? declaredReturn) : declaredReturn;

  return {
    typeParameters: (sig.getTypeParameters() ?? []).map((tp) => checker.typeToString(tp)),
    params,
    returnType: shapes.shape(returnType),
  };
}

// --- nondeterminism -------------------------------------------------------

function findNondeterminism(sf: ts.SourceFile, checker: ts.TypeChecker, program: ts.Program): NondeterminismSource[] {
  const found: NondeterminismSource[] = [];

  // `Date` and `Math` only count when they are the real globals, not a local shadow.
  const isGlobal = (id: ts.Expression): boolean => {
    if (!ts.isIdentifier(id)) return false;
    const sym = checker.getSymbolAtLocation(id);
    if (!sym) return true; // e.g. `performance`/`crypto`: not in the ES lib, so unresolved but global
    return (sym.declarations ?? []).every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()));
  };

  const add = (kind: NondeterminismKind, node: ts.Node) => found.push({ kind, ...locate(sf, node) });

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && isGlobal(callee.expression)) {
        const key = `${(callee.expression as ts.Identifier).text}.${callee.name.text}`;
        switch (key) {
          case 'Date.now':
          case 'Math.random':
          case 'performance.now':
          case 'crypto.randomUUID':
          case 'crypto.getRandomValues':
            add(key, node);
            break;
          default:
            break;
        }
      } else if (ts.isIdentifier(callee) && callee.text === 'Date' && isGlobal(callee)) {
        add('Date()', node);
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      (node.arguments?.length ?? 0) === 0 &&
      isGlobal(node.expression)
    ) {
      add('new Date()', node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

// --- module-level state ---------------------------------------------------

const MUTATING_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'set', 'add', 'delete', 'clear',
]);

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Top-level bindings that some function body writes to. Only writes from inside a
 * function count: `const table = new Map(); table.set('a', 1)` at module scope runs
 * once and is configuration, not state carried between calls.
 */
function findModuleState(sf: ts.SourceFile, checker: ts.TypeChecker): ModuleStateHint[] {
  const candidates = new Map<ts.Symbol, { decl: ts.VariableDeclaration; mutableBinding: boolean }>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const init = decl.initializer;
      // Functions assigned to consts are the code itself, not state.
      if (isConst && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
      const sym = checker.getSymbolAtLocation(decl.name);
      if (sym) candidates.set(sym, { decl, mutableBinding: !isConst });
    }
  }
  if (candidates.size === 0) return [];

  const rootIdentifier = (expr: ts.Expression): ts.Identifier | undefined => {
    let e = expr;
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isParenthesizedExpression(e)) {
      e = e.expression;
    }
    return ts.isIdentifier(e) ? e : undefined;
  };

  const hits = new Map<ts.Symbol, ModuleStateHint['reason']>();
  const record = (target: ts.Expression, direct: boolean) => {
    const id = direct && ts.isIdentifier(target) ? target : rootIdentifier(target);
    if (!id) return;
    const sym = checker.getSymbolAtLocation(id);
    const candidate = sym && candidates.get(sym);
    if (!sym || !candidate) return;
    const reassigned = direct && ts.isIdentifier(target);
    if (reassigned && !candidate.mutableBinding) return;
    if (!hits.has(sym)) hits.set(sym, reassigned ? 'mutable-binding' : 'mutable-container');
  };

  const visit = (node: ts.Node, insideFunction: boolean): void => {
    const inFn = insideFunction || ts.isFunctionLike(node);
    if (inFn) {
      if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
        record(node.left, true);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        record(node.operand, true);
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        MUTATING_METHODS.has(node.expression.name.text)
      ) {
        record(node.expression.expression, false);
      } else if (ts.isDeleteExpression(node)) {
        record(node.expression, false);
      }
    }
    ts.forEachChild(node, (child) => visit(child, inFn));
  };
  ts.forEachChild(sf, (child) => visit(child, false));

  return [...hits.entries()].map(([sym, reason]) => {
    const { decl } = candidates.get(sym)!;
    return { name: sym.name, reason, ...locate(sf, decl) };
  });
}

// --- generatability -------------------------------------------------------

function assessGeneratability(signatures: SignatureInfo[], isGenerator: boolean): Generatability {
  const blockers: string[] = [];
  const omitted: string[] = [];
  const weaklyTyped: string[] = [];
  if (isGenerator) blockers.push('generator functions return iterators, which the sandbox cannot encode');

  for (const sig of signatures) {
    for (const p of sig.params) {
      const problems = new Set<string>();
      const weak = new Set<string>();
      walkShape(p.type, (s) => {
        if (s.kind === 'function') problems.add('takes a callback (functions cannot be passed into the sandbox)');
        if (s.kind === 'promise') problems.add('takes a Promise');
        if (s.kind === 'unknown' && s.reason === 'class-instance') problems.add(`takes a class instance (${s.text})`);
        if (s.kind === 'unknown' && s.reason === 'never') problems.add('has type never');
        if (s.kind === 'unknown' && (s.reason === 'any' || s.reason === 'unknown' || s.reason === 'unresolved')) {
          weak.add(s.reason);
        }
        if (s.kind === 'typeParameter') weak.add(`unconstrained ${s.name}`);
      });
      if (problems.size && p.optional) {
        omitted.push(`${p.name} (${[...problems].join('; ')})`);
      } else {
        for (const problem of problems) blockers.push(`parameter '${p.name}' ${problem}`);
      }
      if (weak.size) weaklyTyped.push(`${p.name} (${[...weak].join(', ')})`);
    }
  }
  return {
    generatable: blockers.length === 0,
    blockers,
    omitted: [...new Set(omitted)],
    weaklyTyped: [...new Set(weaklyTyped)],
  };
}

function walkShape(shape: TypeShape, visit: (s: TypeShape) => void): void {
  visit(shape);
  switch (shape.kind) {
    case 'array':
      walkShape(shape.element, visit);
      break;
    case 'set':
      walkShape(shape.element, visit);
      break;
    case 'promise':
      walkShape(shape.value, visit);
      break;
    case 'map':
      walkShape(shape.key, visit);
      walkShape(shape.value, visit);
      break;
    case 'tuple':
      for (const e of shape.elements) walkShape(e.type, visit);
      break;
    case 'union':
      for (const m of shape.members) walkShape(m, visit);
      break;
    case 'object':
      for (const p of shape.properties) walkShape(p.type, visit);
      for (const i of shape.index ?? []) walkShape(i.value, visit);
      break;
    default:
      break;
  }
}

// --- helpers --------------------------------------------------------------

function locate(sf: ts.SourceFile, node: ts.Node): SourceLocation {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const text = node.getText(sf).replace(/\s+/g, ' ');
  return { line: line + 1, column: character + 1, snippet: text.length > 80 ? `${text.slice(0, 80)}...` : text };
}

function formatDiagnostic(sf: ts.SourceFile, d: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  if (d.start === undefined) return message;
  const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
  return `${line + 1}:${character + 1} ${message}`;
}
