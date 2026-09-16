import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';

import {
  canonical,
  captureRealm,
  decode,
  DecodeError,
  encode,
  encodeArgs,
  normalizeErrorMessage,
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
