/**
 * Generates mutants of a TypeScript source: small, syntactic, single-site edits
 * (an operator swapped, a boolean flipped, a literal off by one) that a *correct*
 * implementation would behave differently under. Runs on the HOST and never
 * executes the source -- same discipline as the import guard and analyzer.
 *
 * This is the input to mutation testing (src/mutator/mutation-test.ts): if a
 * generated test suite can't tell a mutant from the real function, the suite has a
 * gap, regardless of how many tests it has.
 *
 * Mutation is done by splicing the original source text at a single token's
 * [start, end) span, not by re-printing a transformed AST. That keeps every mutant
 * textually identical to the original except for the one change, which is both
 * simpler and avoids the transpiler ever seeing a shape the printer might render
 * subtly differently from what a human -- or the import guard -- would expect.
 */

import * as ts from 'typescript';
import { Rng } from '../generator/rng';

export interface Mutant {
  id: string;
  /** Human-readable description of the single change, e.g. "'<' -> '<='". */
  description: string;
  line: number;
  column: number;
  mutatedSource: string;
}

interface MutationSite {
  start: number;
  end: number;
  replacement: string;
  description: string;
  line: number;
  column: number;
}

/** Relational, equality, arithmetic and logical operators with an obvious "one step off" swap. */
const BINARY_MUTATIONS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.LessThanToken, '<='],
  [ts.SyntaxKind.LessThanEqualsToken, '<'],
  [ts.SyntaxKind.GreaterThanToken, '>='],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>'],
  [ts.SyntaxKind.EqualsEqualsToken, '!='],
  [ts.SyntaxKind.ExclamationEqualsToken, '=='],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '==='],
  [ts.SyntaxKind.PlusToken, '-'],
  [ts.SyntaxKind.MinusToken, '+'],
  [ts.SyntaxKind.AsteriskToken, '/'],
  [ts.SyntaxKind.SlashToken, '*'],
  [ts.SyntaxKind.PercentToken, '*'],
  [ts.SyntaxKind.AmpersandAmpersandToken, '||'],
  [ts.SyntaxKind.BarBarToken, '&&'],
]);

function findMutationSites(sf: ts.SourceFile): MutationSite[] {
  const sites: MutationSite[] = [];
  const locate = (pos: number) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, column: character + 1 };
  };
  const add = (start: number, end: number, replacement: string, description: string) => {
    sites.push({ start, end, replacement, description, ...locate(start) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const replacement = BINARY_MUTATIONS.get(node.operatorToken.kind);
      if (replacement) {
        const opText = node.operatorToken.getText(sf);
        add(node.operatorToken.getStart(sf), node.operatorToken.getEnd(), replacement, `'${opText}' -> '${replacement}'`);
      }
    } else if (
      node.kind === ts.SyntaxKind.PrefixUnaryExpression &&
      (node as ts.PrefixUnaryExpression).operator === ts.SyntaxKind.ExclamationToken
    ) {
      // `!x` -> `x`: drop just the operator token, not the operand.
      const start = node.getStart(sf);
      add(start, start + 1, '', 'removed logical negation !');
    } else if (node.kind === ts.SyntaxKind.TrueKeyword && !ts.isTypeNode(node.parent)) {
      add(node.getStart(sf), node.getEnd(), 'false', "'true' -> 'false'");
    } else if (node.kind === ts.SyntaxKind.FalseKeyword && !ts.isTypeNode(node.parent)) {
      add(node.getStart(sf), node.getEnd(), 'true', "'false' -> 'true'");
    } else if (ts.isNumericLiteral(node) && !ts.isTypeNode(node.parent)) {
      const n = Number(node.text);
      if (Number.isFinite(n)) {
        const replacement = String(n + 1);
        add(node.getStart(sf), node.getEnd(), replacement, `${node.text} -> ${replacement}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

export interface GenerateMutantsOptions {
  /** Caps the number of mutants returned; the rest are sampled away deterministically. */
  maxMutants?: number;
  seed?: number;
}

/**
 * One mutant per mutation site (the classic approach: each mutant differs from the
 * original by exactly one edit, so a failure to catch it points at exactly one
 * thing the suite missed). Source is parsed, never executed.
 */
export function generateMutants(source: string, options: GenerateMutantsOptions = {}): Mutant[] {
  const sf = ts.createSourceFile('submission.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const sites = findMutationSites(sf);

  const rng = new Rng(options.seed ?? 1);
  const chosen =
    options.maxMutants !== undefined && sites.length > options.maxMutants
      ? rng.sample(sites, options.maxMutants)
      : sites;

  return chosen.map((site, i) => ({
    id: `m${i}`,
    description: site.description,
    line: site.line,
    column: site.column,
    mutatedSource: source.slice(0, site.start) + site.replacement + source.slice(site.end),
  }));
}
