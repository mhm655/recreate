import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';

import {
  canonical,
  captureRealm,
  decode,
  DecodeError,
  describeEncoded,
  encode,
  encodeArgs,
  hasTruncation,
  normalizeErrorMessage,
  recordCalls,
  type EncodedValue,
} from '../src/encoding';

/** Encode, push through real JSON text (the wire), decode. */
function roundTrip(value: unknown): unknown {
  const wire = JSON.stringify(encode(value));
  return decode(JSON.parse(wire) as EncodedValue);
}

describe('encoding: values plain JSON gets wrong', () => {
  it('shows why this module exists: JSON.stringify is lossy', () => {
    const lossy = JSON.parse(JSON.stringify({ a: NaN, b: Infinity, c: -0, d: undefined }));
    assert.deepEqual(lossy, { a: null, b: null, c: 0 });
    assert.equal('d' in lossy, false);
  });

  it('round-trips NaN', () => {
    assert.ok(Number.isNaN(roundTrip(NaN)));
  });

  it('round-trips Infinity and -Infinity', () => {
    assert.equal(roundTrip(Infinity), Infinity);
    assert.equal(roundTrip(-Infinity), -Infinity);
  });

  it('round-trips -0 as -0, not 0', () => {
    assert.ok(Object.is(roundTrip(-0), -0));
    assert.ok(Object.is(roundTrip(0), 0));
    assert.notEqual(canonical(encode(-0)), canonical(encode(0)));
  });

  it('round-trips a bare undefined', () => {
    assert.equal(roundTrip(undefined), undefined);
    assert.deepEqual(encode(undefined), { t: 'undefined' });
  });

  it('keeps keys whose value is undefined', () => {
    const out = roundTrip({ a: undefined, b: 1 }) as Record<string, unknown>;
    assert.ok('a' in out);
    assert.equal(out.a, undefined);
    assert.notEqual(canonical(encode({ a: undefined })), canonical(encode({})));
  });

  it('round-trips special numbers nested inside structures', () => {
    const out = roundTrip({ list: [NaN, -0, Infinity, undefined], nested: { x: -Infinity } }) as any;
    assert.ok(Number.isNaN(out.list[0]));
    assert.ok(Object.is(out.list[1], -0));
    assert.equal(out.list[2], Infinity);
    assert.equal(out.list.length, 4);
    assert.ok(3 in out.list);
    assert.equal(out.nested.x, -Infinity);
  });

  it('distinguishes array holes from explicit undefined', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    const explicit = [1, undefined, 3];
    const a = roundTrip(sparse) as unknown[];
    const b = roundTrip(explicit) as unknown[];
    assert.equal(1 in a, false);
    assert.equal(1 in b, true);
    assert.notEqual(canonical(encode(sparse)), canonical(encode(explicit)));
  });

  it('round-trips bigint, which JSON.stringify throws on', () => {
    assert.throws(() => JSON.stringify(10n));
    assert.equal(roundTrip(12345678901234567890n), 12345678901234567890n);
  });
});

describe('encoding: primitives and built-ins', () => {
  it('round-trips primitives exactly', () => {
    for (const v of [null, true, false, 0, 1.5, -42, 'hello', '', 'unicode ✓']) {
      assert.deepEqual(roundTrip(v), v);
    }
  });

  it('round-trips Date, including Invalid Date', () => {
    const d = roundTrip(new Date('2024-02-29T12:00:00.000Z')) as Date;
    assert.equal(d.toISOString(), '2024-02-29T12:00:00.000Z');
    assert.ok(Number.isNaN((roundTrip(new Date('nope')) as Date).getTime()));
  });

  it('round-trips RegExp with flags', () => {
    const r = roundTrip(/a+b/gi) as RegExp;
    assert.equal(r.source, 'a+b');
    assert.equal(r.flags, 'gi');
  });

  it('round-trips Map and Set, including non-string keys', () => {
    const key = { k: 1 };
    const m = roundTrip(new Map<unknown, unknown>([[key, 'obj'], [NaN, 'nan']])) as Map<unknown, unknown>;
    assert.equal(m.size, 2);
    assert.equal(m.get(NaN), 'nan');
    const s = roundTrip(new Set([1, -0, 'x'])) as Set<unknown>;
    assert.deepEqual([...s], [1, 0, 'x']);
  });

  it('round-trips typed arrays and ArrayBuffers', () => {
    const f = roundTrip(new Float64Array([1.5, NaN, -0])) as Float64Array;
    assert.ok(f instanceof Float64Array);
    assert.equal(f[0], 1.5);
    assert.ok(Number.isNaN(f[1]));
    assert.ok(Object.is(f[2], -0));
    const ab = roundTrip(new Uint8Array([1, 2, 3]).buffer) as ArrayBuffer;
    assert.deepEqual([...new Uint8Array(ab)], [1, 2, 3]);
  });

  it('round-trips null-prototype objects', () => {
    const o = Object.create(null);
    o.x = 1;
    const out = roundTrip(o) as object;
    assert.equal(Object.getPrototypeOf(out), null);
  });

  it('records the constructor name of class instances', () => {
    class Point {
      constructor(public x: number, public y: number) {}
    }
    const enc = encode(new Point(1, 2));
    assert.equal(enc.t, 'object');
    assert.equal((enc as any).ctor, 'Point');
  });

  it('tags dropped symbol-keyed properties instead of silently losing them', () => {
    const sym = Symbol('secret');
    const obj = { visible: 1, [sym]: 'hidden' };
    const enc = encode(obj) as Extract<EncodedValue, { t: 'object' }>;
    assert.equal(enc.t, 'object');
    assert.equal(enc.droppedSymbolKeys, 1);

    const decoded = decode(enc) as Record<string, unknown>;
    assert.equal(decoded.visible, 1);

    const arr: unknown[] = [1, 2];
    (arr as unknown as Record<symbol, unknown>)[sym] = 'hidden';
    const arrEnc = encode(arr) as Extract<EncodedValue, { t: 'array' }>;
    assert.equal(arrEnc.droppedSymbolKeys, 1);
    const decodedArr = decode(arrEnc) as unknown[];
    assert.deepEqual(decodedArr, [1, 2]);
  });

  it('a real own property named like a reserved marker key survives round-trip intact -- it is not a real marker', () => {
    // Regression: truncation/drop bookkeeping used to be embedded as fake
    // [key, value] entries directly inside the same array that held real
    // properties (`__truncatedKeys`, `__truncatedLength`, `__droppedSymbolKeys`),
    // indistinguishable in the wire format from a real property of the same name.
    // decode() unconditionally skipped any entry with one of those exact keys, so
    // a submission's own property that happened to share a name silently
    // vanished. Those markers are now dedicated fields on the node instead.
    const obj = { __truncatedKeys: 'a real value', __droppedSymbolKeys: 42, __truncatedLength: 'also real' };
    assert.deepEqual(decode(encode(obj)), obj);

    const arr: unknown[] = [1, 2];
    (arr as unknown as Record<string, unknown>).__truncatedKeys = 'still real';
    assert.equal((decode(encode(arr)) as unknown as Record<string, unknown>).__truncatedKeys, 'still real');

    const err = new Error('boom') as Error & Record<string, unknown>;
    err.__droppedSymbolKeys = 'also still real';
    assert.equal((decode(encode(err)) as unknown as Record<string, unknown>).__droppedSymbolKeys, 'also still real');
  });

  it('records array length/key truncation as dedicated node fields, not entries mixed into real data', () => {
    const budget = { maxNodes: 1000, maxDepth: 32, maxStringLength: 100, maxKeys: 2, maxCollectionEntries: 3 };
    const big = Array.from({ length: 10 }, (_, i) => i);
    (big as unknown as Record<string, number>).a = 1;
    (big as unknown as Record<string, number>).b = 2;
    (big as unknown as Record<string, number>).c = 3;
    const enc = encode(big, budget) as Extract<EncodedValue, { t: 'array' }>;
    assert.equal(enc.truncatedLength, 10);
    assert.equal(enc.v.length, 3);
    assert.equal(enc.truncatedKeys, true);
    assert.equal(enc.props?.length, 2);
    assert.ok(hasTruncation(enc));
  });

  it('marks functions without trying to serialise their code', () => {
    const enc = encode(function namedThing() {});
    assert.deepEqual(enc, { t: 'fn', i: 0, name: 'namedThing', cls: false });
    assert.equal((encode(class K {}) as any).cls, true);
  });

  it('decodes a function to a placeholder that throws when called, not a silent no-op', () => {
    const decoded = decode(encode(function namedThing() {})) as (...a: unknown[]) => unknown;
    assert.equal(typeof decoded, 'function');
    assert.equal(decoded.name, 'namedThing');
    assert.throws(() => decoded(), /namedThing.*cannot be reconstructed/);
  });

  it('a decoded class placeholder also throws, including when called with `new`', () => {
    const decoded = decode(encode(class Widget {})) as new (...a: unknown[]) => unknown;
    assert.throws(() => new decoded(), /Widget.*cannot be reconstructed/);
  });
});

describe('encoding: recordCalls (bounded callback support)', () => {
  it('still calls straight through to the real function outside the sandbox', () => {
    const wrapped = recordCalls((x: number) => x * 2, [[1], [2]]);
    assert.equal(wrapped(21), 42);
  });

  it('replays a recorded return value for matching arguments, after a full JSON round-trip', () => {
    const wrapped = recordCalls((x: number, y: string) => `${y}:${x}`, [[1, 'a'], [2, 'b']]);
    const decoded = roundTrip(wrapped) as (x: number, y: string) => string;
    assert.equal(decoded(1, 'a'), 'a:1');
    assert.equal(decoded(2, 'b'), 'b:2');
  });

  it('replays a recorded thrown outcome, as the same error class and message', () => {
    const risky = (x: number) => {
      if (x < 0) throw new RangeError('negative');
      return x;
    };
    const decoded = roundTrip(recordCalls(risky, [[-1], [5]])) as (x: number) => number;
    assert.equal(decoded(5), 5);
    assert.throws(() => decoded(-1), (err: unknown) => err instanceof RangeError && (err as Error).message === 'negative');
  });

  it('matches arguments structurally, not by reference -- NaN and -0 included', () => {
    const wrapped = recordCalls((x: number) => x, [[NaN], [-0]]);
    const decoded = roundTrip(wrapped) as (x: number) => number;
    assert.ok(Number.isNaN(decoded(NaN)));
    assert.ok(Object.is(decoded(-0), -0));
  });

  it('throws a clear, attributable error for a call outside the recorded set -- never a plausible-looking guess', () => {
    const decoded = roundTrip(recordCalls((x: number) => x * 2, [[1], [2]])) as (x: number) => number;
    assert.throws(() => decoded(999), /never recorded for it/);
  });

  it('preserves the original function\'s name for diagnostics, not the wrapper\'s own binding name', () => {
    function double(x: number): number {
      return x * 2;
    }
    const wrapped = recordCalls(double, [[1]]);
    assert.equal(wrapped.name, 'double');
    const decoded = roundTrip(wrapped) as (x: number) => number;
    assert.throws(() => decoded(999), /function 'double' was called/);
  });

  it('caps the recorded table at the encode budget instead of growing the payload unbounded', () => {
    const inputs = Array.from({ length: 5 }, (_, i) => [i] as [number]);
    const wrapped = recordCalls((x: number) => x, inputs);
    const enc = encode(wrapped, { maxNodes: 20_000, maxDepth: 32, maxStringLength: 16_384, maxKeys: 1_000, maxCollectionEntries: 2 });
    assert.equal((enc as { recorded?: unknown[] }).recorded?.length, 2);
  });

  it('a bare (unrecorded) function argument still throws exactly as before -- recordCalls is opt-in, not a behaviour change', () => {
    const decoded = roundTrip(function bareCallback() {}) as () => void;
    assert.throws(() => decoded(), /cannot be reconstructed inside the sandbox/);
  });

  it('each recorded entry\'s args draws from the SAME node budget as the rest of the document, not a fresh one per entry', () => {
    // Regression: each recorded entry's `args` used to be encoded by a brand-new
    // Encoder with its own untouched maxNodes allowance (needed for its own
    // independent index numbering -- see the code comment where this is built),
    // so a recordCalls table could do up to maxCollectionEntries times as much
    // encoding work as maxNodes is meant to cap for the WHOLE document. A tiny
    // shared budget makes the fix observable directly: the fn node itself and the
    // first couple of entries consume it, and every entry after that shows up
    // truncated -- which could never happen if each entry got a fresh budget.
    const budget = { maxNodes: 5, maxDepth: 32, maxStringLength: 100, maxKeys: 100, maxCollectionEntries: 10 };
    const inputs = Array.from({ length: 5 }, (_, i) => [i] as [number]);
    const wrapped = recordCalls((x: number) => x, inputs);
    const enc = encode(wrapped, budget) as Extract<EncodedValue, { t: 'fn' }>;
    const recorded = enc.recorded!;
    assert.equal(recorded.length, 5);
    assert.equal(recorded[0].args.t, 'array', 'the first entry should still encode fully');
    assert.ok(
      recorded.some((entry) => entry.args.t === 'truncated'),
      `expected at least one entry to run out of the shared budget: ${JSON.stringify(recorded)}`,
    );
  });
});

describe('encoding: errors', () => {
  it('captures error class and message', () => {
    const e = roundTrip(new TypeError('bad input')) as TypeError;
    assert.ok(e instanceof TypeError);
    assert.equal(e.name, 'TypeError');
    assert.equal(e.message, 'bad input');
  });

  it('keeps custom error names and extra own properties, but not the stack', () => {
    class ValidationError extends Error {
      code = 'E_VALID';
      constructor(msg: string) {
        super(msg);
        this.name = 'ValidationError';
      }
    }
    const enc = encode(new ValidationError('nope')) as Extract<EncodedValue, { t: 'error' }>;
    assert.equal(enc.name, 'ValidationError');
    assert.deepEqual(enc.props, [['code', { t: 'str', v: 'E_VALID' }]]);
    assert.equal(JSON.stringify(enc).includes('stack'), false);
  });

  it('normalises environment noise out of messages', () => {
    assert.equal(
      normalizeErrorMessage('ENOENT: no such file, open \'/home/runner/work/app/x.json\' at 0x7ffd1234'),
      "ENOENT: no such file, open '<path>' at <hex>",
    );
    assert.equal(normalizeErrorMessage('failed at C:\\Users\\dev\\proj\\a.ts'), 'failed at <path>');
    assert.equal(normalizeErrorMessage('  lots   of\n\nwhitespace '), 'lots of whitespace');
  });
});

describe('encoding: references, cycles and aliasing', () => {
  it('survives cycles', () => {
    const o: any = { name: 'root' };
    o.self = o;
    o.list = [o];
    const out = roundTrip(o) as any;
    assert.equal(out.self, out);
    assert.equal(out.list[0], out);
  });

  it('preserves aliasing between arguments', () => {
    const shared = { n: 1 };
    const decoded = decode(JSON.parse(JSON.stringify(encodeArgs([shared, shared])))) as any[];
    assert.equal(decoded[0], decoded[1]);
  });

  it('encodes the same structure to the same canonical form every time', () => {
    const make = () => ({ a: [1, { b: NaN }], c: new Map([['k', -0]]) });
    assert.equal(canonical(encode(make())), canonical(encode(make())));
  });

  it('captures mutation when an argument list is encoded before and after a call', () => {
    const args: unknown[] = [[3, 1, 2], { count: 0 }];
    const before = canonical(encodeArgs(args));
    ((xs: number[], o: { count: number }) => {
      xs.sort();
      o.count++;
    })(args[0] as number[], args[1] as { count: number });
    const after = canonical(encodeArgs(args));
    assert.notEqual(before, after);
    assert.deepEqual(decode(JSON.parse(after)), [[1, 2, 3], { count: 1 }]);
  });
});

describe('encoding: hostile values', () => {
  it('does not invoke getters while encoding', () => {
    let calls = 0;
    const o = {
      get sneaky() {
        calls++;
        throw new Error('getter ran');
      },
    };
    const enc = encode(o) as Extract<EncodedValue, { t: 'object' }>;
    assert.equal(calls, 0);
    assert.deepEqual(enc.v, [['sneaky', { t: 'accessor' }]]);
  });

  it('ignores inherited (polluted) properties', () => {
    const proto = { injected: 'from prototype' };
    const o = Object.create(proto);
    o.own = 1;
    const enc = encode(o) as Extract<EncodedValue, { t: 'object' }>;
    assert.deepEqual(enc.v.map(([k]) => k), ['own']);
  });

  it('is not fooled by a Proxy that throws on every trap', () => {
    const p = new Proxy({}, {
      ownKeys() { throw new Error('trap'); },
      getOwnPropertyDescriptor() { throw new Error('trap'); },
      getPrototypeOf() { throw new Error('trap'); },
    });
    assert.doesNotThrow(() => encode(p));
  });

  it('truncates excessive depth', () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 100; i++) deep = deep.next = {};
    const json = JSON.stringify(encode(root, { maxNodes: 10_000, maxDepth: 8, maxStringLength: 100, maxKeys: 100, maxCollectionEntries: 100 }));
    assert.ok(json.includes('"reason":"depth"'));
  });

  it('truncates excessive node counts', () => {
    const wide = Array.from({ length: 500 }, (_, i) => ({ i }));
    const json = JSON.stringify(encode(wide, { maxNodes: 50, maxDepth: 32, maxStringLength: 100, maxKeys: 100, maxCollectionEntries: 1000 }));
    assert.ok(json.includes('"reason":"nodes"'));
  });

  it('truncates long strings and records the original length', () => {
    const enc = encode('x'.repeat(1000), { maxNodes: 10, maxDepth: 4, maxStringLength: 10, maxKeys: 10, maxCollectionEntries: 10 });
    assert.deepEqual(enc, { t: 'str', v: 'x'.repeat(10), trunc: 1000 });
  });
});

describe('encoding: realms', () => {
  it('recognises arrays, errors and dates created in another realm', () => {
    const ctx = vm.createContext({});
    const foreign = vm.runInContext('({ arr: [1, 2], err: new RangeError("r"), when: new Date(0) })', ctx);
    assert.equal(foreign.arr instanceof Array, false, 'precondition: cross-realm instanceof fails');
    const enc = encode(foreign) as Extract<EncodedValue, { t: 'object' }>;
    const byKey = Object.fromEntries(enc.v);
    assert.equal(byKey.arr.t, 'array');
    assert.equal(byKey.err.t, 'error');
    assert.equal(byKey.when.t, 'date');
  });

  it('decodes into a target realm so instanceof works for the function under test', () => {
    const ctx = vm.createContext({});
    const realm = captureRealm(vm.runInContext('globalThis', ctx));
    const value = decode(encode({ list: [1, 2], when: new Date(0) }), realm);
    (ctx as any).value = value;
    assert.equal(vm.runInContext('value.list instanceof Array', ctx), true);
    assert.equal(vm.runInContext('value.when instanceof Date', ctx), true);
    assert.equal(vm.runInContext('value instanceof Object', ctx), true);
  });

  it('uses intrinsics snapshotted before untrusted code could replace them', () => {
    const ctx = vm.createContext({});
    const realm = captureRealm(vm.runInContext('globalThis', ctx));
    vm.runInContext('globalThis.Array = function Evil() { throw new Error("hijacked") }', ctx);
    assert.doesNotThrow(() => decode(encode([1, 2, 3]), realm));
  });
});

describe('decoding: malformed input', () => {
  it('rejects non-objects and unknown tags', () => {
    assert.throws(() => decode(null as any), DecodeError);
    assert.throws(() => decode({ t: 'exec', v: 'rm -rf /' } as any), DecodeError);
    assert.throws(() => decode({ t: 'special', v: 'Evil' } as any), DecodeError);
  });

  it('rejects dangling references', () => {
    assert.throws(() => decode({ t: 'ref', v: 99 }), DecodeError);
  });

  it('decodes lossy markers to undefined rather than a plausible substitute', () => {
    assert.equal(decode({ t: 'accessor' }), undefined);
    assert.equal(decode({ t: 'truncated', reason: 'depth' }), undefined);
    assert.equal(decode({ t: 'unsupported', kind: 'Promise' }), undefined);
  });
});

describe('describeEncoded: human-readable rendering for reports', () => {
  // Regression: a CLI/UI mismatch report used to render `outcome.value` via
  // `JSON.stringify` directly on the TAGGED node -- e.g. `{"t":"str","v":"x"}`
  // instead of `"x"` -- because that node is what the wire protocol carries, not
  // the real decoded value. describeEncoded renders it the way the real value
  // would print, without decode()'s "must be safe to execute against" constraints.
  it('renders primitives the way they would actually print', () => {
    assert.equal(describeEncoded(encode(42)), '42');
    assert.equal(describeEncoded(encode('hello')), '"hello"');
    assert.equal(describeEncoded(encode(true)), 'true');
    assert.equal(describeEncoded(encode(null)), 'null');
    assert.equal(describeEncoded(encode(undefined)), 'undefined');
    assert.equal(describeEncoded(encode(NaN)), 'NaN');
    assert.equal(describeEncoded(encode(-0)), '-0');
    assert.equal(describeEncoded(encode(10n)), '10n');
  });

  it('recurses into arrays, objects, maps and sets instead of dumping their tagged form', () => {
    assert.equal(describeEncoded(encode([1, 'x', true])), '[1, "x", true]');
    assert.equal(describeEncoded(encode({ a: 1, b: 'y' })), '{a: 1, b: "y"}');
    assert.equal(describeEncoded(encode(new Map([['k', 1]]))), 'Map{"k" => 1}');
    assert.equal(describeEncoded(encode(new Set([1, 2]))), 'Set{1, 2}');
  });

  it('renders a cyclic structure without ever infinitely recursing', () => {
    const cyclic: any = { name: 'root' };
    cyclic.self = cyclic;
    assert.equal(describeEncoded(encode(cyclic)), '{name: "root", self: <circular reference>}');
  });

  it('notes truncation instead of silently showing only the shortened value', () => {
    const enc = encode('x'.repeat(50), { maxNodes: 100, maxDepth: 5, maxStringLength: 10, maxKeys: 10, maxCollectionEntries: 10 });
    assert.equal(describeEncoded(enc), `${JSON.stringify('x'.repeat(10))}... (truncated from 50 chars)`);
  });

  it('renders an Error with its class and message, not a JSON blob', () => {
    assert.equal(describeEncoded(encode(new RangeError('bad'))), 'RangeError("bad")');
  });
});
