import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { analyzeFunction } from '../src/analyzer/analyze';
import { analyzeIsolated } from '../src/analyzer/isolated';
import type { FunctionAnalysis, ParamInfo, TypeShape } from '../src/analyzer/types';

function analyze(source: string, entryName?: string): FunctionAnalysis {
  const r = analyzeFunction(source, { entryName });
  assert.ok(r.ok, JSON.stringify(r));
  return r.analysis;
}

function params(source: string, entryName?: string): ParamInfo[] {
  return analyze(source, entryName).signatures[0].params;
}

/** Compact structural rendering of a shape, so expectations stay readable. */
function sketch(s: TypeShape): string {
  switch (s.kind) {
    case 'literal': return JSON.stringify(s.value);
    case 'array': return `${s.readonly ? 'readonly ' : ''}${sketch(s.element)}[]`;
    case 'tuple': return `[${s.elements.map((e) => `${e.rest ? '...' : ''}${sketch(e.type)}${e.optional ? '?' : ''}`).join(', ')}]`;
    case 'union': return s.members.map(sketch).join(' | ');
    case 'object': {
      const props = s.properties.map((p) => `${p.readonly ? 'readonly ' : ''}${p.name}${p.optional ? '?' : ''}: ${sketch(p.type)}`);
      const index = (s.index ?? []).map((i) => `[${i.key}]: ${sketch(i.value)}`);
      return `{ ${[...props, ...index].join('; ')} }`;
    }
    case 'map': return `Map<${sketch(s.key)}, ${sketch(s.value)}>`;
    case 'set': return `Set<${sketch(s.element)}>`;
    case 'promise': return `Promise<${sketch(s.value)}>`;
    case 'typedarray': return s.name;
    case 'typeParameter': return `typeParam ${s.name}`;
    case 'recursive': return `recursive ${s.text}`;
    case 'unknown': return `unknown(${s.reason})`;
    default: return s.kind;
  }
}

describe('analyzer: parameters', () => {
  it('describes primitives, optional, default and rest parameters', () => {
    const ps = params('export function f(a: string, b?: number, c = true, ...d: bigint[]) {}');
    assert.deepEqual(
      ps.map((p) => [p.name, sketch(p.type), p.optional, p.rest, p.defaultText]),
      [
        ['a', 'string', false, false, undefined],
        ['b', 'number', true, false, undefined],
        ['c', 'boolean', true, false, 'true'],
        ['d', 'bigint[]', false, true, undefined],
      ],
    );
  });

  it('infers the type of an unannotated parameter from its default value', () => {
    const [p] = params('export function f(limit = 48) { return limit; }');
    assert.equal(sketch(p.type), 'number');
  });

  it('resolves interfaces, aliases, literal unions and optional properties', () => {
    const [p] = params(`
      type Status = 'open' | 'closed';
      interface Ticket { readonly id: number; status: Status; assignee?: string; labels: string[] }
      export function f(t: Ticket) {}`);
    assert.equal(sketch(p.type), '{ readonly id: number; status: "open" | "closed"; assignee?: string; labels: string[] }');
  });

  it('expands utility types the way the compiler does', () => {
    const ps = params(`
      interface User { id: number; name: string; email: string }
      export function f(a: Partial<Pick<User, 'id' | 'name'>>, b: Record<string, number>) {}`);
    assert.equal(sketch(ps[0].type), '{ id?: number; name?: string }');
    assert.equal(sketch(ps[1].type), '{ [string]: number }');
  });

  it('collapses true | false back into boolean inside unions', () => {
    const [p] = params('export function f(x: string | boolean | null) {}');
    assert.deepEqual((p.type as Extract<TypeShape, { kind: 'union' }>).members.map(sketch).sort(), ['boolean', 'null', 'string']);
  });

  it('describes enums as unions of their literal values', () => {
    const [p] = params("enum Dir { Up = 'UP', Down = 'DOWN' } export function f(d: Dir) {}");
    assert.equal(sketch(p.type), '"UP" | "DOWN"');
  });

  it('describes tuples, including optional and rest elements', () => {
    const [p] = params('export function f(t: [number, string?, ...boolean[]]) {}');
    // A rest element carries the type of each repeated element, flagged rest.
    assert.equal(sketch(p.type), '[number, string?, ...boolean]');
  });

  it('recognises built-in container and value types', () => {
    const ps = params(`export function f(a: Date, b: RegExp, c: Map<string, number[]>, d: ReadonlySet<number>,
      e: Uint8Array, f: readonly number[]) {}`);
    assert.deepEqual(ps.map((p) => sketch(p.type)), [
      'date', 'regexp', 'Map<string, number[]>', 'Set<number>', 'Uint8Array', 'readonly number[]',
    ]);
  });

  it('marks self-referential types instead of expanding forever', () => {
    const [p] = params('interface TreeNode { value: number; children: TreeNode[] } export function f(n: TreeNode) {}');
    assert.equal(sketch(p.type), '{ value: number; children: recursive TreeNode[] }');
  });

  it('uses a generic constraint as the type, and flags unconstrained generics', () => {
    const a = analyze('export function f<K extends string, V>(key: K, value: V) {}');
    const [key, value] = a.signatures[0].params;
    assert.equal(sketch(key.type), 'string');
    assert.equal(sketch(value.type), 'typeParam V');
    assert.deepEqual(a.signatures[0].typeParameters, ['K', 'V']);
    assert.equal(a.generatability.generatable, true);
    assert.deepEqual(a.generatability.weaklyTyped, ['value (unconstrained V)']);
  });
});

describe('analyzer: function shape', () => {
  it('reports the awaited return type of async functions', () => {
    const a = analyze('export async function f(): Promise<number[]> { return []; }');
    assert.equal(a.isAsync, true);
    assert.equal(sketch(a.signatures[0].returnType), 'number[]');
  });

  it('reports every overload signature and not the implementation signature', () => {
    const a = analyze(`
      export function pad(s: string): string;
      export function pad(n: number, width: number): string;
      export function pad(x: string | number, width = 2): string { return String(x).padStart(width); }`);
    assert.equal(a.signatures.length, 2);
    assert.deepEqual(a.signatures.map((s) => s.params.map((p) => sketch(p.type))), [['string'], ['number', 'number']]);
  });

  it('handles arrow functions, anonymous default exports and explicit entry names', () => {
    assert.equal(analyze('export const double = (n: number) => n * 2;').entryName, 'double');
    const anon = analyze('export default function (s: string) { return s; }');
    assert.equal(anon.entryName, 'default');
    assert.equal(sketch(anon.signatures[0].params[0].type), 'string');
    const chosen = analyze('export function a(x: number) {} export function b(y: string) {}', 'b');
    assert.equal(sketch(chosen.signatures[0].params[0].type), 'string');
  });
});

describe('analyzer: generatability', () => {
  it('blocks callbacks, class instances, promises and generators', () => {
    const cb = analyze('export function f(xs: number[], pick: (n: number) => boolean) {}');
    assert.equal(cb.generatability.generatable, false);
    assert.match(cb.generatability.blockers[0], /'pick' takes a callback/);

    const cls = analyze('class Money { constructor(public cents: number) {} } export function f(m: Money) {}');
    assert.match(cls.generatability.blockers[0], /class instance \(Money\)/);

    const nested = analyze('export function f(opts: { onDone?: () => void }) {}');
    assert.equal(nested.generatability.generatable, false, 'callbacks nested in objects count too');

    assert.equal(analyze('export function f(p: Promise<number>) {}').generatability.generatable, false);

    const optionalCb = analyze('export function f(n: number, onLog?: (m: string) => void) {}');
    assert.equal(optionalCb.generatability.generatable, true, 'an optional callback can simply be left out');
    assert.deepEqual(optionalCb.generatability.blockers, []);
    assert.match(optionalCb.generatability.omitted[0], /^onLog \(takes a callback/);
    assert.equal(analyze('export function* f(n: number) { yield n; }').generatability.generatable, false);
  });

  it('flags any and unknown parameters as weakly typed without blocking', () => {
    const a = analyze('export function f(a: any, b: unknown, c) { return [a, b, c]; }');
    assert.equal(a.generatability.generatable, true);
    assert.deepEqual(a.generatability.weaklyTyped, ['a (any)', 'b (unknown)', 'c (any)']);
  });
});

describe('analyzer: time and randomness', () => {
  it('finds every supported source of nondeterminism', () => {
    const a = analyze(`
      export function f() {
        return [Date.now(), new Date(), Date(), Math.random(), performance.now(), crypto.randomUUID()];
      }`);
    assert.deepEqual(a.nondeterminism.map((n) => n.kind), [
      'Date.now', 'new Date()', 'Date()', 'Math.random', 'performance.now', 'crypto.randomUUID',
    ]);
    assert.equal(a.nondeterminism[0].line, 3);
  });

  it('ignores deterministic uses and local shadows', () => {
    const a = analyze(`
      export function f(ms: number) {
        const Math = { random: () => 4 };
        return [new Date(ms).toISOString(), new Date(2020, 1, 1), Math.random()];
      }`);
    assert.deepEqual(a.nondeterminism, []);
  });
});

describe('analyzer: module-level state', () => {
  it('flags top-level bindings and containers that the function writes to', () => {
    const a = analyze(`
      let calls = 0;
      const seen = new Set<string>();
      const memo: Record<string, number> = {};
      export function f(k: string) {
        calls++;
        seen.add(k);
        memo[k] = calls;
        return calls;
      }`);
    assert.deepEqual(a.moduleState.map((s) => [s.name, s.reason]), [
      ['calls', 'mutable-binding'],
      ['seen', 'mutable-container'],
      ['memo', 'mutable-container'],
    ]);
  });

  it('does not flag read-only tables, module initialisation, locals or unused lets', () => {
    const a = analyze(`
      const VOWELS = ['a', 'e', 'i', 'o', 'u'];
      const lookup = new Map<string, number>();
      lookup.set('one', 1);
      let neverReassigned = 3;
      export function f(word: string) {
        const lookup = new Map<string, number>();
        lookup.set(word, 1);
        return [...word].filter((c) => VOWELS.includes(c)).length + neverReassigned;
      }`);
    assert.deepEqual(a.moduleState, []);
  });
});

describe('analyzer: input hygiene', () => {
  it('applies the same static screening as the harness', () => {
    const r = analyzeFunction("import { readFileSync } from 'fs'; export function f() { return readFileSync; }");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.errors.some((e) => e.code === 'disallowed-import'));
  });

  it('never reads files off disk, even for an allowlisted import', () => {
    // A real file in this repository. The compiler host must refuse to load it, so
    // the imported type is unresolved rather than expanded.
    const real = path.resolve(__dirname, '..', '..', 'src', 'protocol.ts').replace(/\\/g, '/');
    const r = analyzeFunction(`import type { Limits } from '${real}'; export function f(l: Limits) {}`, {
      allowedModules: [real],
    });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.analysis.signatures[0].params[0];
    assert.equal(sketch(p.type), 'unknown(unresolved)');
    assert.ok(r.analysis.typeErrors.some((e) => /Cannot find module/.test(e)), r.analysis.typeErrors.join('\n'));
  });

  it('reports type errors, including globals the sandbox does not provide', () => {
    const a = analyze('export function f(): number { return performance.now(); }');
    assert.ok(a.typeErrors.some((e) => /Cannot find name 'performance'/.test(e)), a.typeErrors.join('\n'));
  });
});

describe('analyzer: isolation', () => {
  it('returns the same analysis from a worker thread', async () => {
    const source = 'export function f(xs: readonly number[], n = 2): number[] { return xs.slice(0, n); }';
    assert.deepEqual(await analyzeIsolated(source), analyzeFunction(source));
  });

  it('terminates analysis that exceeds its time budget', async () => {
    const r = await analyzeIsolated('export function f(x: number) { return x; }', {}, { timeoutMs: 1 });
    assert.deepEqual(r.ok ? 'ok' : r.errors[0].code, 'analysis-timeout');
  });
});
