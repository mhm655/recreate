/**
 * A small literal format for test inputs written by something other than this
 * program -- an LLM, in practice -- plus a checker that holds those inputs to the
 * function's declared types.
 *
 * The format is plain JSON with a handful of tags for values JSON cannot express,
 * chosen to be easy to write by hand (the CLI's sentinel strings are a subset):
 *
 *   "@@NaN" "@@Infinity" "@@-Infinity" "@@-0" "@@undefined"
 *   {"@@date": "2024-02-29T00:00:00.000Z"}   {"@@bigint": "123"}
 *   {"@@map": [[key, value], ...]}           {"@@set": [value, ...]}
 *   {"@@regexp": ["source", "flags"]}
 *   "@@@@x" for a literal string "@@x"
 *
 * Everything here treats its input as untrusted data: parsing is JSON.parse plus a
 * size cap, lifting only ever constructs inert values, and nothing is evaluated.
 */

import type { ParamInfo, SignatureInfo, TypeShape } from '../analyzer/types';

export const MAX_LITERAL_BYTES = 64 * 1024;
const MAX_DEPTH = 24;

export class LiteralError extends Error {}

/** Parse a JSON array of arguments in the literal format into real values. */
export function parseArgsLiteral(json: string): unknown[] {
  if (Buffer.byteLength(json, 'utf8') > MAX_LITERAL_BYTES) throw new LiteralError('arguments exceed the size cap');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new LiteralError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) throw new LiteralError('arguments must be a JSON array');
  return raw.map((v) => lift(v, 0));
}

function lift(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new LiteralError('nesting too deep');
  if (typeof value === 'string') {
    switch (value) {
      case '@@NaN': return NaN;
      case '@@Infinity': return Infinity;
      case '@@-Infinity': return -Infinity;
      case '@@-0': return -0;
      case '@@undefined': return undefined;
      default:
        if (value.startsWith('@@@@')) return value.slice(2);
        if (value.startsWith('@@')) throw new LiteralError(`unknown tag ${JSON.stringify(value.slice(0, 40))}`);
        return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => lift(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const keys = Object.keys(value);
  const tag = keys.length === 1 && keys[0].startsWith('@@') ? keys[0] : undefined;
  const body = tag ? (value as Record<string, unknown>)[tag] : undefined;
  switch (tag) {
    case undefined:
      break;
    case '@@date': {
      const d = new Date(String(body));
      if (typeof body !== 'string' || Number.isNaN(d.getTime())) throw new LiteralError('@@date needs an ISO date string');
      return d;
    }
    case '@@bigint':
      if (typeof body !== 'string' || !/^-?\d{1,400}$/.test(body)) throw new LiteralError('@@bigint needs a string of digits');
      return BigInt(body);
    case '@@map':
      if (!Array.isArray(body) || !body.every((e) => Array.isArray(e) && e.length === 2)) {
        throw new LiteralError('@@map needs an array of [key, value] pairs');
      }
      return new Map(body.map(([k, v]) => [lift(k, depth + 1), lift(v, depth + 1)]));
    case '@@set':
      if (!Array.isArray(body)) throw new LiteralError('@@set needs an array');
      return new Set(body.map((v) => lift(v, depth + 1)));
    case '@@regexp':
      if (!Array.isArray(body) || body.length !== 2 || typeof body[0] !== 'string' || typeof body[1] !== 'string') {
        throw new LiteralError('@@regexp needs ["source", "flags"]');
      }
      try {
        return new RegExp(body[0], body[1]);
      } catch (err) {
        throw new LiteralError(`invalid @@regexp: ${err instanceof Error ? err.message : String(err)}`);
      }
    default:
      throw new LiteralError(`unknown tag ${JSON.stringify(tag.slice(0, 40))}`);
  }

  // Plain object. Keys go in through defineProperty rather than assignment, so a key
  // such as "__proto__" becomes an ordinary own property instead of a prototype swap.
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    Object.defineProperty(out, k, {
      value: lift((value as Record<string, unknown>)[k], depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// --- conformance -------------------------------------------------------------

/**
 * Why the arguments do not fit any of the function's signatures, or `undefined` if
 * they fit one. Suggestions that don't fit are dropped: a test outside the declared
 * contract characterises behaviour nobody promised, and a rewrite that differs there
 * would be failed for no good reason.
 */
export function argsMismatch(args: readonly unknown[], signatures: readonly SignatureInfo[]): string | undefined {
  const reasons: string[] = [];
  for (const sig of signatures) {
    const reason = signatureMismatch(args, sig.params);
    if (reason === undefined) return undefined;
    reasons.push(reason);
  }
  return reasons.length === 1 ? reasons[0] : `fits no overload (${reasons.join('; ')})`;
}

function signatureMismatch(args: readonly unknown[], params: readonly ParamInfo[]): string | undefined {
  const fixed = params.filter((p) => !p.rest);
  const rest = params.find((p) => p.rest);
  const required = fixed.filter((p) => !p.optional).length;
  if (args.length < required) return `expected at least ${required} argument(s), got ${args.length}`;
  if (!rest && args.length > fixed.length) return `expected at most ${fixed.length} argument(s), got ${args.length}`;

  for (let i = 0; i < args.length; i++) {
    if (i < fixed.length) {
      const p = fixed[i];
      if (p.optional && args[i] === undefined) continue;
      const why = mismatch(args[i], p.type, 0);
      if (why) return `argument '${p.name}': ${why}`;
    } else if (rest) {
      const element = rest.type.kind === 'array' ? rest.type.element : rest.type;
      const why = mismatch(args[i], element, 0);
      if (why) return `rest argument ${i - fixed.length}: ${why}`;
    }
  }
  return undefined;
}

function mismatch(value: unknown, shape: TypeShape, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const expected = () => `expected ${shape.text}, got ${describe(value)}`;
  switch (shape.kind) {
    case 'string':
      return typeof value === 'string' ? undefined : expected();
    case 'number':
      return typeof value === 'number' ? undefined : expected();
    case 'boolean':
      return typeof value === 'boolean' ? undefined : expected();
    case 'bigint':
      return typeof value === 'bigint' ? undefined : expected();
    case 'null':
      return value === null ? undefined : expected();
    case 'undefined':
      return value === undefined ? undefined : expected();
    case 'literal':
      return Object.is(value, shape.value) ? undefined : expected();
    case 'date':
      return value instanceof Date ? undefined : expected();
    case 'regexp':
      return value instanceof RegExp ? undefined : expected();
    case 'array': {
      if (!Array.isArray(value)) return expected();
      for (let i = 0; i < value.length; i++) {
        const why = mismatch(value[i], shape.element, depth + 1);
        if (why) return `[${i}]: ${why}`;
      }
      return undefined;
    }
    case 'tuple': {
      if (!Array.isArray(value)) return expected();
      const fixed = shape.elements.filter((e) => !e.rest);
      const rest = shape.elements.find((e) => e.rest);
      const required = fixed.filter((e) => !e.optional).length;
      if (value.length < required || (!rest && value.length > fixed.length)) return expected();
      for (let i = 0; i < value.length; i++) {
        const el = i < fixed.length ? fixed[i] : rest!;
        if (el.optional && value[i] === undefined) continue;
        const why = mismatch(value[i], el.type, depth + 1);
        if (why) return `[${i}]: ${why}`;
      }
      return undefined;
    }
    case 'map': {
      if (!(value instanceof Map)) return expected();
      for (const [k, v] of value) {
        const why = mismatch(k, shape.key, depth + 1) ?? mismatch(v, shape.value, depth + 1);
        if (why) return `map entry: ${why}`;
      }
      return undefined;
    }
    case 'set': {
      if (!(value instanceof Set)) return expected();
      for (const v of value) {
        const why = mismatch(v, shape.element, depth + 1);
        if (why) return `set element: ${why}`;
      }
      return undefined;
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date ||
          value instanceof Map || value instanceof Set || value instanceof RegExp) {
        return expected();
      }
      const record = value as Record<string, unknown>;
      const declared = new Set(shape.properties.map((p) => p.name));
      for (const p of shape.properties) {
        const present = Object.prototype.hasOwnProperty.call(record, p.name) && record[p.name] !== undefined;
        if (!present) {
          if (p.optional) continue;
          return `missing property '${p.name}'`;
        }
        const why = mismatch(record[p.name], p.type, depth + 1);
        if (why) return `.${p.name}: ${why}`;
      }
      for (const key of Object.keys(record)) {
        if (declared.has(key)) continue;
        const index = shape.index?.find((i) => i.key === 'string' || (i.key === 'number' && /^-?\d+(\.\d+)?$/.test(key)));
        if (!index) return `unexpected property '${key}' (not in ${shape.text})`;
        const why = mismatch(record[key], index.value, depth + 1);
        if (why) return `['${key}']: ${why}`;
      }
      return undefined;
    }
    case 'union':
      return shape.members.some((m) => mismatch(value, m, depth + 1) === undefined) ? undefined : expected();
    // Nothing checkable: any/unknown/unconstrained generics accept any value, and a
    // recursive reference was already checked one level up.
    case 'typeParameter':
    case 'recursive':
      return undefined;
    case 'unknown':
      return shape.reason === 'any' || shape.reason === 'unknown' || shape.reason === 'unresolved' ||
        shape.reason === 'depth-limit'
        ? undefined
        : `${shape.text} cannot be supplied as a test input`;
    // Not expressible in the literal format, and not generatable anyway.
    case 'typedarray':
    case 'promise':
    case 'function':
      return `${shape.text} cannot be supplied as a test input`;
    default:
      return 'unsupported type';
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'Date';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return typeof value;
}
