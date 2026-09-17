/**
 * Tagged value encoding.
 *
 * Why this exists: `JSON.stringify`/`JSON.parse` is *lossy* in ways that matter
 * enormously when the original implementation of a function is being used as a
 * correctness oracle:
 *
 *   NaN        -> null          (a wrong answer and a right answer become equal)
 *   Infinity   -> null
 *   -0         -> 0             (matters for sign-preserving arithmetic)
 *   undefined  -> dropped       ({a: undefined} and {} become indistinguishable)
 *   Date       -> string        (a function returning an ISO string would "pass")
 *   cycles     -> throws
 *
 * Every value therefore carries an explicit tag. Decoding is a plain switch over
 * that tag, so a malformed/attacker-supplied payload can only ever produce an
 * inert value or a decode error -- never behaviour.
 *
 * Two properties of the encoder are load-bearing for security/correctness:
 *
 *  1. REALM-AGNOSTIC READS. The values being encoded come out of a `vm` context
 *     that untrusted code has been running in, and that code may have polluted
 *     `Object.prototype`, replaced `Array`, etc. So detection never uses
 *     `instanceof` (cross-realm false negatives) and never trusts inherited
 *     properties -- only `Object.prototype.toString.call` and *own* property
 *     descriptors, read through this realm's intrinsics.
 *
 *  2. NO USER CODE RUNS DURING ENCODING. Own accessor properties are reported as
 *     `{t:'accessor'}` rather than invoked. A getter that mutates state while being
 *     encoded would corrupt `argsAfterCall` (the snapshot would no longer describe
 *     what the call left behind), and one that throws or hangs would have its
 *     effects blamed on the encoder rather than on the function under test.
 */

export type EncodedValue =
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  /** Finite, non -0 number. */
  | { t: 'num'; v: number }
  /** The four numeric values JSON cannot represent. */
  | { t: 'special'; v: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'str'; v: string; trunc?: number }
  | { t: 'bigint'; v: string }
  /** Symbols round-trip by description only; identity is deliberately not preserved. */
  | { t: 'symbol'; v: string }
  | { t: 'fn'; i: number; name: string; cls: boolean; recorded?: RecordedCallEntry[] }
  | {
      t: 'array';
      i: number;
      v: EncodedValue[];
      /** Indices that are holes in a sparse array (distinct from `undefined` elements). */
      holes?: number[];
      /** Non-index own string keys hung off the array. */
      props?: Array<[string, EncodedValue]>;
    }
  | { t: 'object'; i: number; v: Array<[string, EncodedValue]>; ctor?: string; proto?: 'null' }
  /** `v === null` means an Invalid Date. */
  | { t: 'date'; i: number; v: string | null }
  | { t: 'regexp'; i: number; source: string; flags: string }
  | { t: 'error'; i: number; name: string; message: string; props?: Array<[string, EncodedValue]> }
  | { t: 'map'; i: number; v: Array<[EncodedValue, EncodedValue]> }
  | { t: 'set'; i: number; v: EncodedValue[] }
  | { t: 'typedarray'; i: number; kind: string; b64: string; trunc?: number }
  | { t: 'arraybuffer'; i: number; b64: string; trunc?: number }
  /** Back-reference to an earlier node index; this is how cycles survive. */
  | { t: 'ref'; v: number }
  /** An own accessor property. Deliberately not invoked -- see module docblock. */
  | { t: 'accessor' }
  | { t: 'unsupported'; kind: string }
  | { t: 'truncated'; reason: 'depth' | 'nodes' | 'keys' };

export interface EncodeBudget {
  maxNodes: number;
  maxDepth: number;
  maxStringLength: number;
  maxKeys: number;
  maxCollectionEntries: number;
}

/**
 * One recorded call: the arguments it was called with, and what happened. Reuses
 * the encoder's own tagged forms rather than protocol.ts's `Outcome` -- encoding.ts
 * sits below protocol.ts in the dependency order (protocol.ts imports from here),
 * so it can't import that type back without a cycle, and this is a small enough
 * shape that duplicating it isn't a real cost.
 */
export type RecordedCallEntry = {
  args: EncodedValue;
} & ({ type: 'return'; value: EncodedValue } | { type: 'thrown'; errorClass: string; message: string });

export const DEFAULT_ENCODE_BUDGET: EncodeBudget = {
  maxNodes: 20_000,
  maxDepth: 32,
  maxStringLength: 16_384,
  maxKeys: 1_000,
  maxCollectionEntries: 1_000,
};

/** Intrinsics of a target realm, snapshotted before untrusted code can replace them. */
export interface Realm {
  Object: any;
  Array: any;
  Date: any;
  RegExp: any;
  Map: any;
  Set: any;
  ArrayBuffer: any;
  Uint8Array: any;
  Error: any;
  errors: Record<string, any>;
  typedArrays: Record<string, any>;
}

const ERROR_NAMES = [
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
];
const TYPED_ARRAY_NAMES = [
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];

/**
 * Snapshot the intrinsics of `g`. MUST be called on a fresh context, before any
 * untrusted code runs in it -- otherwise `globalThis.Array = attackerFn` would be
 * picked up here and used to construct decoded arguments.
 */
export function captureRealm(g: any = globalThis): Realm {
  const errors: Record<string, any> = {};
  for (const n of ERROR_NAMES) if (typeof g[n] === 'function') errors[n] = g[n];
  const typedArrays: Record<string, any> = {};
  for (const n of TYPED_ARRAY_NAMES) if (typeof g[n] === 'function') typedArrays[n] = g[n];
  return {
    Object: g.Object, Array: g.Array, Date: g.Date, RegExp: g.RegExp,
    Map: g.Map, Set: g.Set, ArrayBuffer: g.ArrayBuffer, Uint8Array: g.Uint8Array,
    Error: g.Error, errors, typedArrays,
  };
}

// --- recorded calls (bounded callback/method support) ---------------------

/**
 * Marks a function as carrying a replay table, checked for during encoding
 * (below). Module-private on purpose: the only supported way to attach one is
 * `recordCalls`, which guarantees the table's `args`/outcome actually came from
 * calling the real function -- never fabricated data pretending to be a recording.
 */
const RECORDED_CALLS = Symbol('recordedCalls');

interface RawRecordedCall {
  args: unknown[];
  outcome: { type: 'return'; value: unknown } | { type: 'thrown'; errorClass: string; message: string };
}

/**
 * A live, real function still cannot cross into the sandbox -- there is no channel
 * to call back out to it (see README, "Decisions for the next layers" #6). What
 * CAN cross is a bounded, pre-computed record of exactly what it did for a known
 * set of inputs, decided and captured entirely on the HOST, before the sandbox
 * ever runs.
 *
 * `recordCalls(fn, inputs)` calls `fn` once per entry in `inputs` right now (on the
 * host) and returns a function that, once encoded as a test argument and decoded
 * inside the sandbox, replays the matching recorded outcome for a call whose
 * arguments match (compared structurally, via `canonical()`) -- and throws a clear,
 * attributable error for any call outside that table, rather than silently
 * fabricating a plausible-looking answer. This is the harness's answer to
 * "callbacks as arguments" for the one case that's actually safe to support: the
 * caller already knows exactly what the callback will be called with (e.g. every
 * element of an array the submission is also given), which covers `map`/`filter`/
 * `forEach`-style callback parameters without needing a live channel out of the
 * sandbox.
 *
 * Matching is on however many arguments EACH recorded entry has, not full arity:
 * `recordCalls(f, [[1], [2]])` matches a live call of `f(1)` just as much as
 * `f(1, 0, [1, 2])` -- `Array.prototype.map`/`forEach`/`filter` all call their
 * callback as `(element, index, array)`, and recording just the element is
 * normally what's meant. Record longer tuples (`[[1, 0], [2, 1]]`) to also pin
 * down the index. A submission that calls the callback with something not
 * matching any recorded entry still gets the same loud failure a bare callback
 * argument always has.
 *
 * The returned function still calls straight through to `fn` when invoked for
 * real (outside the sandbox) -- recording does not change its behaviour, only
 * what travels with it when it's encoded.
 */
export function recordCalls<A extends unknown[], R>(fn: (...args: A) => R, inputs: readonly A[]): (...args: A) => R {
  const calls: RawRecordedCall[] = inputs.map((args) => {
    try {
      return { args, outcome: { type: 'return', value: fn(...args) } };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'NonError';
      const message = err instanceof Error ? err.message : String(err);
      return { args, outcome: { type: 'thrown', errorClass: name, message } };
    }
  });
  const wrapped = ((...args: A): R => fn(...args)) as ((...args: A) => R) & { [RECORDED_CALLS]?: RawRecordedCall[] };
  wrapped[RECORDED_CALLS] = calls;
  try {
    // Otherwise the wrapper's own binding name ('wrapped') would shadow the real
    // function's name in every diagnostic message the decoded proxy can produce.
    Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  } catch {
    /* non-configurable name on fn; keep the wrapper's own */
  }
  return wrapped;
}

// --- encoding -------------------------------------------------------------

const toStringTag = Object.prototype.toString;
const ownKeys = Object.getOwnPropertyNames;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const isArray = Array.isArray;

class Encoder {
  private nodes = 0;
  private nextIndex = 0;
  private readonly seen = new Map<unknown, number>();
  constructor(private readonly budget: EncodeBudget) {}

  encode(value: unknown, depth = 0): EncodedValue {
    if (this.nodes++ >= this.budget.maxNodes) return { t: 'truncated', reason: 'nodes' };

    switch (typeof value) {
      case 'undefined':
        return { t: 'undefined' };
      case 'boolean':
        return { t: 'bool', v: value };
      case 'number':
        return encodeNumber(value);
      case 'string':
        return this.encodeString(value);
      case 'bigint':
        return { t: 'bigint', v: value.toString() };
      case 'symbol':
        return { t: 'symbol', v: String((value as symbol).description ?? '') };
      case 'function':
      case 'object':
        break;
      default:
        return { t: 'unsupported', kind: typeof value };
    }

    if (value === null) return { t: 'null' };

    const prior = this.seen.get(value);
    if (prior !== undefined) return { t: 'ref', v: prior };
    if (depth >= this.budget.maxDepth) return { t: 'truncated', reason: 'depth' };

    const i = this.nextIndex++;
    this.seen.set(value, i);

    if (typeof value === 'function') {
      let name = '';
      let cls = false;
      try {
        name = String((value as any).name ?? '');
        cls = /^class[\s{]/.test(Function.prototype.toString.call(value));
      } catch {
        /* exotic/proxied function: keep the defaults above */
      }
      const node: EncodedValue = { t: 'fn', i, name: clamp(name, 200), cls };
      const raw = (value as { [RECORDED_CALLS]?: RawRecordedCall[] })[RECORDED_CALLS];
      if (raw?.length) {
        // Capped, not truncated-with-a-marker like other collections: this list
        // came from the caller explicitly, not from walking arbitrary submission
        // output, so silently keeping only the first N is enough -- a call outside
        // the cap gets the same clear "no recorded result" failure as one the
        // caller never recorded at all.
        (node as { recorded?: RecordedCallEntry[] }).recorded = raw.slice(0, this.budget.maxCollectionEntries).map((call) => ({
          // encodeArgs, NOT this.encode: it's compared later via canonical() against
          // a call's live arguments, ALSO encoded via a fresh encodeArgs() call (see
          // the decoder's 'fn' case below). canonical()'s output embeds each node's
          // index, which is only stable within one standalone encode -- reusing
          // this ambient, already-partway-through-the-document encoder here would
          // give the same logical arguments a different index purely because of
          // where in the document this entry happens to sit, and the comparison
          // would never match even for genuinely identical arguments.
          args: encodeArgs(call.args, this.budget),
          ...(call.outcome.type === 'return'
            ? { type: 'return' as const, value: this.encode(call.outcome.value, depth + 1) }
            : { type: 'thrown' as const, errorClass: clamp(call.outcome.errorClass, 200), message: normalizeErrorMessage(call.outcome.message) }),
        }));
      }
      return node;
    }

    const tag = safeTag(value);

    if (isArray(value)) return this.encodeArray(value as unknown[], i, depth);

    switch (tag) {
      case '[object Date]': {
        const ms = safeDateValue(value);
        return {
          t: 'date',
          i,
          v: ms === null || Number.isNaN(ms) ? null : new Date(ms).toISOString(),
        };
      }
      case '[object RegExp]': {
        const { source, flags } = safeRegExpParts(value);
        return { t: 'regexp', i, source, flags };
      }
      case '[object Error]':
        return this.encodeError(value, i, depth);
      case '[object Map]':
        return this.encodeMap(value, i, depth);
      case '[object Set]':
        return this.encodeSet(value, i, depth);
      case '[object ArrayBuffer]': {
        const { b64, truncatedFrom } = safeBufferToBase64(value);
        return { t: 'arraybuffer', i, b64, ...(truncatedFrom !== undefined ? { trunc: truncatedFrom } : {}) };
      }
      case '[object Promise]':
        return { t: 'unsupported', kind: 'Promise' };
      case '[object WeakMap]':
      case '[object WeakSet]':
        return { t: 'unsupported', kind: tag.slice(8, -1) };
      case '[object Number]':
      case '[object String]':
      case '[object Boolean]':
      case '[object Symbol]':
      case '[object BigInt]':
        return { t: 'unsupported', kind: `boxed:${tag.slice(8, -1)}` };
      default:
        break;
    }

    const taKind = tag.slice(8, -1);
    if (TYPED_ARRAY_NAMES.indexOf(taKind) !== -1) {
      const { b64, truncatedFrom } = safeBufferToBase64(value);
      return { t: 'typedarray', i, kind: taKind, b64, ...(truncatedFrom !== undefined ? { trunc: truncatedFrom } : {}) };
    }

    return this.encodeObject(value as object, i, depth, tag);
  }

  private encodeString(s: string): EncodedValue {
    if (s.length > this.budget.maxStringLength) {
      return { t: 'str', v: s.slice(0, this.budget.maxStringLength), trunc: s.length };
    }
    return { t: 'str', v: s };
  }

  private encodeArray(arr: unknown[], i: number, depth: number): EncodedValue {
    const out: EncodedValue[] = [];
    const holes: number[] = [];
    let len = 0;
    try {
      len = arr.length >>> 0;
    } catch {
      /* exotic length getter */
    }
    const limit = Math.min(len, this.budget.maxCollectionEntries);
    for (let k = 0; k < limit; k++) {
      const d = safeDescriptor(arr, String(k));
      if (d === undefined) {
        holes.push(k);
        out.push({ t: 'undefined' });
      } else if (!('value' in d)) {
        out.push({ t: 'accessor' });
      } else {
        out.push(this.encode(d.value, depth + 1));
      }
    }

    const props: Array<[string, EncodedValue]> = [];
    if (len > limit) props.push(['__truncatedLength', { t: 'num', v: len }]);

    // Non-index own string keys (e.g. `const a = [1]; a.tag = 'x'`).
    for (const key of safeOwnKeys(arr)) {
      if (key === 'length') continue;
      if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < len) continue;
      if (props.length >= this.budget.maxKeys) {
        props.push(['__truncatedKeys', { t: 'truncated', reason: 'keys' }]);
        break;
      }
      props.push([key, this.encodeProperty(arr, key, depth)]);
    }
    const symbolKeys = safeOwnSymbolKeys(arr).length;
    if (symbolKeys) props.push(['__droppedSymbolKeys', { t: 'num', v: symbolKeys }]);

    const node: any = { t: 'array', i, v: out };
    if (holes.length) node.holes = holes;
    if (props.length) node.props = props;
    return node as EncodedValue;
  }

  private encodeObject(value: object, i: number, depth: number, tag: string): EncodedValue {
    const entries: Array<[string, EncodedValue]> = [];
    for (const key of safeOwnKeys(value)) {
      if (entries.length >= this.budget.maxKeys) {
        entries.push(['__truncatedKeys', { t: 'truncated', reason: 'keys' }]);
        break;
      }
      entries.push([key, this.encodeProperty(value, key, depth)]);
    }
    // Object.getOwnPropertyNames (safeOwnKeys) never returns symbol-keyed
    // properties. Every other lossy path here (accessor/unsupported/truncated)
    // carries an explicit tag; this one gets a count instead of vanishing silently.
    const symbolKeys = safeOwnSymbolKeys(value).length;
    if (symbolKeys) entries.push(['__droppedSymbolKeys', { t: 'num', v: symbolKeys }]);
    const node: any = { t: 'object', i, v: entries };
    let proto: unknown;
    try {
      proto = getProto(value);
    } catch {
      proto = undefined;
    }
    if (proto === null) node.proto = 'null';
    const ctor = safeConstructorName(proto);
    if (ctor && ctor !== 'Object') node.ctor = ctor;
    else if (!ctor && proto !== null && tag !== '[object Object]') node.ctor = tag.slice(8, -1);
    return node as EncodedValue;
  }

  private encodeError(value: unknown, i: number, depth: number): EncodedValue {
    const e = value as any;
    let name = 'Error';
    let message = '';
    try {
      name = typeof e.name === 'string' ? e.name : safeConstructorName(getProto(e)) || 'Error';
    } catch {
      /* keep default */
    }
    try {
      message = typeof e.message === 'string' ? e.message : String(e.message ?? '');
    } catch {
      /* keep default */
    }
    const node: any = {
      t: 'error',
      i,
      name: clamp(name, 200),
      message: normalizeErrorMessage(message),
    };
    // Own extras (e.g. `err.code`), minus the noisy standard fields. `stack` is
    // excluded on purpose: it embeds absolute paths and line numbers, so including
    // it would make every run look different from every other run.
    const props: Array<[string, EncodedValue]> = [];
    const keys = safeOwnKeys(value as object).filter((k) => k !== 'stack' && k !== 'message' && k !== 'name');
    for (const key of keys) {
      if (props.length >= this.budget.maxKeys) {
        props.push(['__truncatedKeys', { t: 'truncated', reason: 'keys' }]);
        break;
      }
      props.push([key, this.encodeProperty(value as object, key, depth)]);
    }
    const symbolKeys = safeOwnSymbolKeys(value as object).length;
    if (symbolKeys) props.push(['__droppedSymbolKeys', { t: 'num', v: symbolKeys }]);
    if (props.length) node.props = props;
    return node as EncodedValue;
  }

  private encodeMap(value: unknown, i: number, depth: number): EncodedValue {
    const out: Array<[EncodedValue, EncodedValue]> = [];
    try {
      const entries = Map.prototype.entries.call(value as Map<unknown, unknown>);
      let n = 0;
      for (const pair of entries as IterableIterator<[unknown, unknown]>) {
        if (n++ >= this.budget.maxCollectionEntries) break;
        out.push([this.encode(pair[0], depth + 1), this.encode(pair[1], depth + 1)]);
      }
    } catch {
      return { t: 'unsupported', kind: 'Map' };
    }
    return { t: 'map', i, v: out };
  }

  private encodeSet(value: unknown, i: number, depth: number): EncodedValue {
    const out: EncodedValue[] = [];
    try {
      const values = Set.prototype.values.call(value as Set<unknown>);
      let n = 0;
      for (const v of values as IterableIterator<unknown>) {
        if (n++ >= this.budget.maxCollectionEntries) break;
        out.push(this.encode(v, depth + 1));
      }
    } catch {
      return { t: 'unsupported', kind: 'Set' };
    }
    return { t: 'set', i, v: out };
  }

  private encodeProperty(obj: object, key: string, depth: number): EncodedValue {
    const d = safeDescriptor(obj, key);
    if (d === undefined) return { t: 'undefined' };
    if (!('value' in d)) return { t: 'accessor' };
    return this.encode(d.value, depth + 1);
  }
}

function encodeNumber(n: number): EncodedValue {
  if (Number.isNaN(n)) return { t: 'special', v: 'NaN' };
  if (n === Infinity) return { t: 'special', v: 'Infinity' };
  if (n === -Infinity) return { t: 'special', v: '-Infinity' };
  if (Object.is(n, -0)) return { t: 'special', v: '-0' };
  return { t: 'num', v: n };
}

function safeTag(v: unknown): string {
  try {
    return toStringTag.call(v);
  } catch {
    return '[object Unknown]';
  }
}

function safeOwnKeys(o: object): string[] {
  try {
    return ownKeys(o);
  } catch {
    return [];
  }
}

function safeOwnSymbolKeys(o: object): symbol[] {
  try {
    return Object.getOwnPropertySymbols(o);
  } catch {
    return [];
  }
}

function safeDescriptor(o: object, key: string): PropertyDescriptor | undefined {
  try {
    return ownDescriptor(o, key);
  } catch {
    return undefined;
  }
}

function safeConstructorName(proto: unknown): string | undefined {
  if (proto === null || proto === undefined) return undefined;
  try {
    const d = ownDescriptor(proto as object, 'constructor');
    const c = d && 'value' in d ? (d.value as any) : undefined;
    const n = c && typeof c.name === 'string' ? c.name : undefined;
    return n ? clamp(n, 200) : undefined;
  } catch {
    return undefined;
  }
}

function safeDateValue(v: unknown): number | null {
  try {
    return Date.prototype.valueOf.call(v as Date);
  } catch {
    return null;
  }
}

function safeRegExpParts(v: unknown): { source: string; flags: string } {
  try {
    const s = String((v as RegExp).source ?? '');
    const f = String((v as RegExp).flags ?? '');
    return { source: clamp(s, 4096), flags: clamp(f, 16) };
  } catch {
    return { source: '', flags: '' };
  }
}

/** `truncatedFrom`, when present, is the original byte length -- same convention as `str`'s `trunc`. */
function safeBufferToBase64(v: unknown): { b64: string; truncatedFrom?: number } {
  const MAX_BYTES = 64 * 1024;
  try {
    const anyV = v as any;
    const view =
      safeTag(v) === '[object ArrayBuffer]'
        ? new Uint8Array(anyV as ArrayBuffer)
        : new Uint8Array(anyV.buffer, anyV.byteOffset, anyV.byteLength);
    const b64 = Buffer.from(view.slice(0, MAX_BYTES)).toString('base64');
    return view.byteLength > MAX_BYTES ? { b64, truncatedFrom: view.byteLength } : { b64 };
  } catch {
    try {
      // Cross-realm buffers can reject the fast path; copy byte-by-byte instead.
      const total = Number((v as any).byteLength) || 0;
      const len = Math.min(total, MAX_BYTES);
      const bytes = new Uint8Array(len);
      for (let k = 0; k < len; k++) bytes[k] = Number((v as any)[k]) || 0;
      const b64 = Buffer.from(bytes).toString('base64');
      return total > MAX_BYTES ? { b64, truncatedFrom: total } : { b64 };
    } catch {
      return { b64: '' };
    }
  }
}

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Error messages are compared across two independent runs (and, later, between an
 * oracle and a submission), so environment-specific noise has to come out: absolute
 * paths, hex addresses and whitespace differences would otherwise make identical
 * failures look different. Deliberately normalised, not verbatim.
 */
export function normalizeErrorMessage(message: string): string {
  let m = clamp(String(message ?? ''), 2000);
  m = m.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
  m = m.replace(/(?:\/[\w.@+-]+){2,}/g, '<path>');
  m = m.replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>');
  m = m.replace(/\s+/g, ' ').trim();
  return clamp(m, 500);
}

export function encode(value: unknown, budget: EncodeBudget = DEFAULT_ENCODE_BUDGET): EncodedValue {
  return new Encoder(budget).encode(value);
}

/**
 * Encode an argument list as a single node, so that aliasing *between* arguments
 * (`f(x, x)`) survives the round trip as a `ref` rather than becoming two
 * independent copies.
 */
export function encodeArgs(values: readonly unknown[], budget: EncodeBudget = DEFAULT_ENCODE_BUDGET): EncodedValue {
  return new Encoder(budget).encode(values.slice());
}

// --- decoding -------------------------------------------------------------

export class DecodeError extends Error {}

let cachedDefaultRealm: Realm | undefined;
function defaultRealm(): Realm {
  if (!cachedDefaultRealm) cachedDefaultRealm = captureRealm(globalThis);
  return cachedDefaultRealm;
}

/**
 * Rebuild a value from its tagged form.
 *
 * `realm` decides *which* realm's intrinsics the rebuilt objects belong to. When
 * decoding test arguments for untrusted code, pass the vm context's realm so that
 * `arr instanceof Array` behaves the way the function author expects. Those
 * intrinsics must have been snapshotted before untrusted code ran -- see
 * `captureRealm`.
 *
 * `budget` must match whatever budget the ENCODE side of this exact wire message
 * used (typically the caller's `Limits.encode`) when the value can contain a
 * `recordCalls` replay table: matching a live call against a recorded one compares
 * `canonical()` of two independently-produced `encodeArgs()` calls (see the 'fn'
 * case below), and `canonical()`'s output depends on the budget the same way it
 * depends on encode order -- two different budgets can shape identical arguments
 * differently and make a genuinely recorded call stop matching. Defaults to
 * `DEFAULT_ENCODE_BUDGET` for callers that never touch a non-default budget.
 */
export function decode(enc: EncodedValue, realm: Realm = defaultRealm(), budget: EncodeBudget = DEFAULT_ENCODE_BUDGET): unknown {
  return new Decoder(realm, budget).decode(enc);
}

class Decoder {
  private readonly byIndex = new Map<number, any>();
  constructor(
    private readonly realm: Realm,
    private readonly budget: EncodeBudget = DEFAULT_ENCODE_BUDGET,
  ) {}

  decode(enc: EncodedValue): unknown {
    if (enc === null || typeof enc !== 'object' || typeof (enc as any).t !== 'string') {
      throw new DecodeError('malformed encoded node');
    }
    const R = this.realm;
    switch (enc.t) {
      case 'undefined':
        return undefined;
      case 'null':
        return null;
      case 'bool':
        return !!enc.v;
      case 'num':
        return Number(enc.v);
      case 'special': {
        const which = enc.v as string;
        switch (which) {
          case 'NaN':
            return NaN;
          case 'Infinity':
            return Infinity;
          case '-Infinity':
            return -Infinity;
          case '-0':
            return -0;
          default:
            throw new DecodeError(`unknown special number: ${String(which)}`);
        }
      }
      case 'str':
        return String(enc.v);
      case 'bigint':
        return BigInt(enc.v);
      case 'symbol':
        return Symbol(enc.v);
      case 'fn': {
        // A live function still cannot cross into the sandbox (see README,
        // "Decisions for the next layers" #6): there is no channel to call back out
        // to whatever real function the original argument was. A no-op placeholder
        // would let a submission that actually invokes a callback argument silently
        // get `undefined` back and carry on -- indistinguishable from a callback
        // that legitimately returned nothing. Throwing on call instead turns that
        // into a loud, attributable failure of the call, not a wrong answer.
        //
        // `enc.recorded`, when present, is the one exception: a bounded, exact
        // replay table built on the host by `recordCalls` BEFORE this ever reached
        // the sandbox (see that function's docs). A call matching one of those
        // recorded argument lists replays the real outcome; anything else still
        // gets the same loud failure as an unrecorded callback.
        const name = typeof enc.name === 'string' ? enc.name : '';
        const label = name ? `${enc.cls ? 'class' : 'function'} '${name}'` : `an anonymous ${enc.cls ? 'class' : 'function'}`;
        const recorded = enc.recorded;
        const fn = recorded?.length
          ? (...callArgs: unknown[]): unknown => {
              // Matches on however many arguments EACH recorded entry has,
              // ignoring anything past that in the real call -- not a strict
              // full-arity match. `Array.prototype.map`/`forEach`/`filter` all call
              // their callback as `(element, index, array)`, not just `(element)`;
              // recording `[[1], [2], [3]]` and having it match a live `cb(1, 0,
              // [1,2,3])` call is the whole point, not a loophole. A caller who
              // does care about the index/array can record `[1, 0]`-shaped tuples
              // and get that stricter match instead.
              const match = recorded.find((entry) => {
                const arity = entry.args.t === 'array' ? entry.args.v.length : 0;
                // Must use the SAME budget `entry.args` was originally encoded with
                // (this.budget, threaded in from decode()'s caller) -- see decode()'s
                // doc comment. A mismatched budget can shape identical arguments
                // differently and make a genuinely recorded call stop matching.
                return canonical(entry.args) === canonical(encodeArgs(callArgs.slice(0, arity), this.budget));
              });
              if (!match) {
                throw new R.Error(
                  `${label} was called with arguments that were never recorded for it: ${JSON.stringify(callArgs)}`,
                );
              }
              if (match.type === 'thrown') {
                const Ctor = R.errors[match.errorClass] ?? R.Error;
                const err = new Ctor(match.message);
                try {
                  err.name = match.errorClass;
                } catch {
                  /* ignore */
                }
                throw err;
              }
              return this.decode(match.value);
            }
          : function decodedFunctionPlaceholder(): never {
              throw new R.Error(`${label} was passed as an argument but functions cannot be reconstructed inside the sandbox`);
            };
        try {
          Object.defineProperty(fn, 'name', { value: name });
        } catch {
          /* non-configurable name */
        }
        return this.register(enc.i, fn);
      }
      case 'ref': {
        if (!this.byIndex.has(enc.v)) throw new DecodeError(`dangling ref ${enc.v}`);
        return this.byIndex.get(enc.v);
      }
      case 'array': {
        const arr = this.register(enc.i, new R.Array());
        const holes = new Set(enc.holes ?? []);
        for (let k = 0; k < enc.v.length; k++) {
          if (holes.has(k)) {
            arr.length = k + 1;
            continue;
          }
          arr[k] = this.decode(enc.v[k]);
        }
        for (const [key, val] of enc.props ?? []) {
          if (key === '__truncatedLength' || key === '__truncatedKeys' || key === '__droppedSymbolKeys') continue;
          arr[key] = this.decode(val);
        }
        return arr;
      }
      case 'object': {
        const obj = this.register(
          enc.i,
          enc.proto === 'null' ? R.Object.create(null) : new R.Object(),
        );
        for (const [key, val] of enc.v) {
          if (key === '__truncatedKeys' || key === '__droppedSymbolKeys') continue;
          try {
            obj[key] = this.decode(val);
          } catch {
            /* frozen or exotic target */
          }
        }
        return obj;
      }
      case 'date':
        return this.register(enc.i, enc.v === null ? new R.Date(NaN) : new R.Date(enc.v));
      case 'regexp':
        return this.register(enc.i, new R.RegExp(enc.source, enc.flags));
      case 'error': {
        const Ctor = R.errors[enc.name] ?? R.Error;
        const err = new Ctor(enc.message);
        try {
          err.name = enc.name;
        } catch {
          /* ignore */
        }
        this.register(enc.i, err);
        for (const [key, val] of enc.props ?? []) {
          if (key === '__truncatedKeys' || key === '__droppedSymbolKeys') continue;
          try {
            err[key] = this.decode(val);
          } catch {
            /* ignore */
          }
        }
        return err;
      }
      case 'map': {
        const m = this.register(enc.i, new R.Map());
        for (const [k, v] of enc.v) m.set(this.decode(k), this.decode(v));
        return m;
      }
      case 'set': {
        const s = this.register(enc.i, new R.Set());
        for (const v of enc.v) s.add(this.decode(v));
        return s;
      }
      case 'arraybuffer': {
        const bytes = Buffer.from(enc.b64, 'base64');
        const ab = new R.ArrayBuffer(bytes.byteLength);
        new R.Uint8Array(ab).set(bytes);
        return this.register(enc.i, ab);
      }
      case 'typedarray': {
        const Ctor = R.typedArrays[enc.kind];
        if (!Ctor) throw new DecodeError(`unknown typed array kind: ${enc.kind}`);
        const bytes = Buffer.from(enc.b64, 'base64');
        const ab = new R.ArrayBuffer(bytes.byteLength);
        new R.Uint8Array(ab).set(bytes);
        return this.register(enc.i, new Ctor(ab));
      }
      // Markers for values that cannot be faithfully reproduced. They decode to
      // `undefined` so a consumer is never silently handed a plausible-looking
      // substitute; the tag itself stays visible in the encoded form.
      case 'accessor':
      case 'unsupported':
      case 'truncated':
        return undefined;
      default:
        throw new DecodeError(`unknown tag: ${String((enc as any).t)}`);
    }
  }

  private register<T>(i: number, value: T): T {
    if (typeof i === 'number') this.byIndex.set(i, value);
    return value;
  }
}

/**
 * Stable string form of an encoded value, used for equality comparison between the
 * ordered and shuffled passes. Node indices are assigned in a deterministic
 * traversal order, so structurally identical values stringify identically.
 */
export function canonical(enc: EncodedValue): string {
  return JSON.stringify(enc);
}

/**
 * True if any node in `enc` lost data to a budget cap: a `{t:'truncated'}` marker,
 * a string/typed-array/arraybuffer cut short (`trunc` set), or a
 * `__truncatedLength`/`__truncatedKeys` marker hung off an array/object/error. Used
 * on the INPUT side (test arguments encoded before being sent into the sandbox) to
 * detect when the encode budget silently shortened what the caller actually
 * specified -- see src/host/orchestrator.ts.
 */
export function hasTruncation(enc: EncodedValue): boolean {
  switch (enc.t) {
    case 'truncated':
      return true;
    case 'str':
    case 'typedarray':
    case 'arraybuffer':
      return enc.trunc !== undefined;
    case 'array':
      return (
        (enc.props?.some(([k]) => k === '__truncatedLength' || k === '__truncatedKeys') ?? false) ||
        enc.v.some(hasTruncation) ||
        (enc.props?.some(([, v]) => hasTruncation(v)) ?? false)
      );
    case 'object':
      return enc.v.some(([k, v]) => k === '__truncatedKeys' || hasTruncation(v));
    case 'error':
      return (
        (enc.props?.some(([k]) => k === '__truncatedKeys') ?? false) ||
        (enc.props?.some(([, v]) => hasTruncation(v)) ?? false)
      );
    case 'map':
      return enc.v.some(([k, v]) => hasTruncation(k) || hasTruncation(v));
    case 'set':
      return enc.v.some(hasTruncation);
    default:
      return false;
  }
}

const RESERVED_MARKER_KEYS = new Set(['__truncatedLength', '__truncatedKeys', '__droppedSymbolKeys']);

/**
 * Human-readable rendering of a tagged `EncodedValue`, for surfacing a test outcome
 * to a person (a CLI report, a UI mismatch panel) -- NOT for comparison or
 * round-tripping. `JSON.stringify(outcome.value)` used to be used for this
 * directly, which just dumps the wire-format tags verbatim (e.g. `{"t":"str","v":"x"}`
 * instead of `"x"`, or an unreadable blob for a Map/Date/typed array); this walks
 * the tagged structure the way `canonical()` and `decode()` already do and renders
 * it the way the corresponding real JS value would print.
 */
export function describeEncoded(enc: EncodedValue, seen: Set<number> = new Set()): string {
  switch (enc.t) {
    case 'undefined':
      return 'undefined';
    case 'null':
      return 'null';
    case 'bool':
    case 'num':
      return String(enc.v);
    case 'special':
      return enc.v;
    case 'str':
      return enc.trunc !== undefined ? `${JSON.stringify(enc.v)}... (truncated from ${enc.trunc} chars)` : JSON.stringify(enc.v);
    case 'bigint':
      return `${enc.v}n`;
    case 'symbol':
      return `Symbol(${enc.v})`;
    case 'fn':
      return enc.name ? `${enc.cls ? 'class' : 'function'} ${enc.name}` : `${enc.cls ? 'an anonymous class' : 'an anonymous function'}`;
    case 'ref':
      return '<circular reference>';
    case 'accessor':
      return '<getter>';
    case 'truncated':
      return `<truncated: ${enc.reason} limit reached>`;
    case 'unsupported':
      return `<unsupported: ${enc.kind}>`;
    case 'date':
      return enc.v === null ? 'Invalid Date' : new Date(enc.v).toISOString();
    case 'regexp':
      return `/${enc.source}/${enc.flags}`;
    case 'typedarray':
      return `${enc.kind}(${enc.trunc !== undefined ? `truncated from ${enc.trunc} bytes` : 'base64 ' + enc.b64.length + ' chars'})`;
    case 'arraybuffer':
      return `ArrayBuffer(${enc.trunc !== undefined ? `truncated from ${enc.trunc} bytes` : enc.b64.length + ' base64 chars'})`;
    case 'array': {
      if (seen.has(enc.i)) return '<circular reference>';
      const next = new Set(seen).add(enc.i);
      const items = enc.v.map((v) => describeEncoded(v, next));
      const extra = (enc.props ?? []).filter(([k]) => !RESERVED_MARKER_KEYS.has(k)).map(([k, v]) => `${k}: ${describeEncoded(v, next)}`);
      return `[${[...items, ...extra].join(', ')}]`;
    }
    case 'object': {
      if (seen.has(enc.i)) return '<circular reference>';
      const next = new Set(seen).add(enc.i);
      const entries = enc.v.filter(([k]) => !RESERVED_MARKER_KEYS.has(k)).map(([k, v]) => `${k}: ${describeEncoded(v, next)}`);
      const prefix = enc.ctor && enc.ctor !== 'Object' ? `${enc.ctor} ` : '';
      return `${prefix}{${entries.join(', ')}}`;
    }
    case 'error': {
      if (seen.has(enc.i)) return '<circular reference>';
      const next = new Set(seen).add(enc.i);
      const extra = (enc.props ?? []).filter(([k]) => !RESERVED_MARKER_KEYS.has(k)).map(([k, v]) => `${k}: ${describeEncoded(v, next)}`);
      return `${enc.name}(${JSON.stringify(enc.message)})${extra.length ? ` {${extra.join(', ')}}` : ''}`;
    }
    case 'map': {
      if (seen.has(enc.i)) return '<circular reference>';
      const next = new Set(seen).add(enc.i);
      const entries = enc.v.map(([k, v]) => `${describeEncoded(k, next)} => ${describeEncoded(v, next)}`);
      return `Map{${entries.join(', ')}}`;
    }
    case 'set': {
      if (seen.has(enc.i)) return '<circular reference>';
      const next = new Set(seen).add(enc.i);
      return `Set{${enc.v.map((v) => describeEncoded(v, next)).join(', ')}}`;
    }
    default:
      return 'unknown value';
  }
}
