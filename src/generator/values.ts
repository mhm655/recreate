/**
 * Turns a single `TypeShape` (from the static analyzer, src/analyzer/types.ts) into
 * a small set of representative JS values: not one "valid" value, but a handful of
 * edge cases and one typical case, since the whole point of grading against a fixed
 * suite is to catch a rewrite that only handles the easy inputs.
 *
 * Runs on the HOST and never executes the submission -- same discipline as the
 * analyzer it consumes. It only ever sees shapes that `assessGeneratability`
 * (src/analyzer/analyze.ts) has already walked and approved: a required parameter
 * with a `function`, `promise`, class-instance or `never` anywhere in its shape tree
 * is a blocker and generation is never attempted for it (see generate.ts). What
 * remains here -- `unknown`, an unconstrained type parameter, or `recursive` (a
 * self-reference the analyzer cuts off rather than a real blocker) -- gets a
 * best-effort fallback value rather than being refused, because refusing here would
 * silently narrow what the harness can grade beyond what the analyzer itself decided.
 */

import type { TypeShape } from '../analyzer/types';
import type { Rng } from './rng';

export interface ValueBudget {
  /** Caps recursion into array/tuple/object/map/set element types. */
  maxDepth: number;
  /** Caps how many representative values a leaf type contributes. */
  maxPerShape: number;
  /** Caps element/property count inside a generated array, tuple, object, map or set. */
  maxContainerSize: number;
}

export const DEFAULT_VALUE_BUDGET: ValueBudget = {
  maxDepth: 4,
  maxPerShape: 5,
  maxContainerSize: 3,
};

const FALLBACK_VALUES: readonly unknown[] = [undefined, null, 0, '', false, {}, []];

/** Representative values for `shape`, capped by `budget.maxPerShape`. Never empty. */
export function valuesFor(shape: TypeShape, rng: Rng, budget: ValueBudget = DEFAULT_VALUE_BUDGET, depth = 0): unknown[] {
  if (depth >= budget.maxDepth) return cap(rng, FALLBACK_VALUES, budget);

  switch (shape.kind) {
    case 'string':
      return cap(rng, ['', 'a', 'hello world', 'a'.repeat(64), '  spaced  \t\n', "quote's\"and\\backslash", 'émoji 🎉'], budget);
    case 'number':
      return cap(rng, [0, 1, -1, 42, -0.5, 3.14159, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, NaN, Infinity, -Infinity], budget);
    case 'boolean':
      return [true, false];
    case 'bigint':
      return cap(rng, [0n, 1n, -1n, 9_007_199_254_740_993n], budget);
    case 'null':
      return [null];
    case 'undefined':
      return [undefined];
    case 'literal':
      return [shape.value];
    case 'date':
      return cap(rng, [new Date(0), new Date(), new Date(NaN), new Date('2020-01-01T00:00:00.000Z')], budget);
    case 'regexp':
      return cap(rng, [/^$/, /a+/gi, /\d{3}-\d{4}/], budget);
    case 'typedarray':
      return cap(rng, [makeTypedArray(shape.name, []), makeTypedArray(shape.name, [0, 1, 2])], budget);

    case 'array': {
      const el = valuesFor(shape.element, rng, budget, depth + 1);
      const sizes = uniqueSizes(budget.maxContainerSize);
      return cap(
        rng,
        sizes.map((n) => Array.from({ length: n }, () => rng.pick(el))),
        budget,
      );
    }

    case 'tuple': {
      // Value set per element computed ONCE, then picked from twice -- same pattern
      // as array/map/set below. Building it inline here (rather than reusing
      // buildTuple twice) avoids recursing into every element's shape a second time.
      const elementSets = shape.elements.map((el) => valuesFor(el.type, rng, budget, depth + 1));
      const build = () =>
        shape.elements.flatMap((el, idx) => {
          if (el.rest) {
            const vals = elementSets[idx];
            return [rng.pick(vals), rng.pick(vals)];
          }
          if (el.optional && rng.next() < 0.3) return [];
          return [rng.pick(elementSets[idx])];
        });
      return cap(rng, [build(), build()], budget);
    }

    case 'object': {
      const propSets = shape.properties.map((p) => valuesFor(p.type, rng, budget, depth + 1));
      const build = (includeOptional: boolean): Record<string, unknown> => {
        const obj: Record<string, unknown> = {};
        shape.properties.forEach((p, idx) => {
          if (p.optional && !includeOptional) return;
          obj[p.name] = rng.pick(propSets[idx]);
        });
        return obj;
      };
      return cap(rng, [build(true), build(false)], budget);
    }

    case 'union': {
      const perMember = Math.max(1, Math.floor(budget.maxPerShape / Math.max(1, shape.members.length)));
      const memberBudget: ValueBudget = { ...budget, maxPerShape: perMember };
      const out: unknown[] = [];
      for (const member of shape.members) out.push(...valuesFor(member, rng, memberBudget, depth + 1));
      return cap(rng, out.length ? out : FALLBACK_VALUES, budget);
    }

    case 'map': {
      const keys = valuesFor(shape.key, rng, budget, depth + 1);
      const vals = valuesFor(shape.value, rng, budget, depth + 1);
      const empty = new Map();
      const one = new Map([[rng.pick(keys), rng.pick(vals)]]);
      return [empty, one];
    }

    case 'set': {
      const el = valuesFor(shape.element, rng, budget, depth + 1);
      const empty = new Set();
      const one = new Set([rng.pick(el)]);
      return [empty, one];
    }

    // Not blockers, but nothing meaningful can be constructed: a self-reference the
    // analyzer cut off, or a type this codebase doesn't model structurally.
    case 'recursive':
    case 'typeParameter':
    case 'unknown':
      return cap(rng, FALLBACK_VALUES, budget);

    // Reachable only if a caller generates for a shape the analyzer would have
    // blocked -- see the module docblock. Fail loudly rather than emit a value that
    // looks plausible but isn't (a decoded function placeholder, say).
    case 'function':
    case 'promise':
      throw new Error(`valuesFor called on a non-generatable shape: ${shape.kind} (${shape.text})`);

    default: {
      // Exhaustiveness guard, not a real fallback: every TypeShape kind is handled
      // above. If this fires, TypeScript's own check below already failed to catch a
      // new kind added to the union without a case here -- fail loudly rather than
      // silently emit a plausible-looking fallback value for it.
      const exhaustive: never = shape;
      throw new Error(`valuesFor: unhandled TypeShape kind '${(exhaustive as TypeShape).kind}'`);
    }
  }
}

function cap(rng: Rng, values: readonly unknown[], budget: ValueBudget): unknown[] {
  return rng.sample(values, budget.maxPerShape);
}

function uniqueSizes(max: number): number[] {
  const sizes = new Set([0, 1, max]);
  return [...sizes].filter((n) => n >= 0);
}

const TYPED_ARRAY_CTORS: Record<string, new (values: number[]) => unknown> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array,
  BigInt64Array: class extends BigInt64Array {
    constructor(values: number[]) {
      super(values.map(BigInt));
    }
  },
  BigUint64Array: class extends BigUint64Array {
    constructor(values: number[]) {
      super(values.map(BigInt));
    }
  },
};

function makeTypedArray(kind: string, values: number[]): unknown {
  const Ctor = TYPED_ARRAY_CTORS[kind];
  return Ctor ? new Ctor(values) : new Uint8Array(values);
}
