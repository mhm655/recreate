/**
 * TypeScript checker types -> generator-friendly `TypeShape`s.
 *
 * Uses the type checker rather than reading type annotations syntactically, so
 * aliases, interfaces, enums, generic constraints, utility types (`Partial`, `Pick`,
 * `Record`) and types inferred from default values (`n = 10`) all resolve the way
 * the compiler sees them.
 */

import * as ts from 'typescript';

import type { IndexShape, PropertyShape, TupleElement, TypeShape } from './types';

const MAX_DEPTH = 12;
const MAX_PROPERTIES = 100;
const MAX_UNION_MEMBERS = 50;

const TYPED_ARRAYS = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);

export class ShapeBuilder {
  /** Types currently being expanded; re-entering one means the type is recursive. */
  private readonly inProgress: ts.Type[] = [];

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly program: ts.Program,
    /** Node used to resolve property types in context. */
    private readonly location: ts.Node,
  ) {}

  shape(type: ts.Type, depth = 0): TypeShape {
    const c = this.checker;
    const text = c.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    const f = type.flags;

    if (f & ts.TypeFlags.Any) {
      // An unresolved import or reference surfaces as the checker's `error` type,
      // which is flagged Any; tell the two apart so the report says why.
      const unresolved = (type as { intrinsicName?: string }).intrinsicName === 'error';
      return { kind: 'unknown', reason: unresolved ? 'unresolved' : 'any', text };
    }
    if (f & ts.TypeFlags.Unknown) return { kind: 'unknown', reason: 'unknown', text };
    if (f & ts.TypeFlags.Never) return { kind: 'unknown', reason: 'never', text };
    if (f & ts.TypeFlags.StringLiteral) {
      return { kind: 'literal', value: (type as ts.StringLiteralType).value, text };
    }
    if (f & ts.TypeFlags.NumberLiteral) {
      return { kind: 'literal', value: (type as ts.NumberLiteralType).value, text };
    }
    if (f & ts.TypeFlags.BooleanLiteral) return { kind: 'literal', value: text === 'true', text };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
      return { kind: 'string', text };
    }
    if (f & ts.TypeFlags.Number) return { kind: 'number', text };
    if (f & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return { kind: 'bigint', text };
    // `boolean` is internally the union `true | false`; catch it before the union branch.
    if (f & ts.TypeFlags.Boolean) return { kind: 'boolean', text };
    if (f & ts.TypeFlags.Null) return { kind: 'null', text };
    if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { kind: 'undefined', text };

    if (depth > MAX_DEPTH) return { kind: 'unknown', reason: 'depth-limit', text };
    if (this.inProgress.includes(type)) return { kind: 'recursive', text };

    this.inProgress.push(type);
    try {
      if (f & ts.TypeFlags.Union) return this.union(type as ts.UnionType, depth, text);
      if (f & ts.TypeFlags.TypeParameter) return this.typeParameter(type, depth, text);
      if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) return this.object(type, depth, text);
      return { kind: 'unknown', reason: 'unsupported', text };
    } finally {
      this.inProgress.pop();
    }
  }

  /** Shape for an optional slot: `T | undefined` is reported as `T`, optionality recorded separately. */
  shapeOptional(type: ts.Type, depth = 0): TypeShape {
    return withoutUndefined(this.shape(type, depth));
  }

  private union(type: ts.UnionType, depth: number, text: string): TypeShape {
    const members = type.types;
    const hasTrue = members.some((m) => m.flags & ts.TypeFlags.BooleanLiteral && this.checker.typeToString(m) === 'true');
    const hasFalse = members.some((m) => m.flags & ts.TypeFlags.BooleanLiteral && this.checker.typeToString(m) === 'false');
    const collapseBoolean = hasTrue && hasFalse;

    const shapes: TypeShape[] = [];
    if (collapseBoolean) shapes.push({ kind: 'boolean', text: 'boolean' });
    for (const m of members.slice(0, MAX_UNION_MEMBERS)) {
      if (collapseBoolean && m.flags & ts.TypeFlags.BooleanLiteral) continue;
      shapes.push(this.shape(m, depth + 1));
    }
    return { kind: 'union', members: shapes, text };
  }

  private typeParameter(type: ts.Type, depth: number, text: string): TypeShape {
    const constraint = this.checker.getBaseConstraintOfType(type);
    if (constraint && constraint !== type && !(constraint.flags & ts.TypeFlags.Unknown)) {
      // `T extends string` is, for input generation, a string.
      return this.shape(constraint, depth + 1);
    }
    return { kind: 'typeParameter', name: type.symbol?.name ?? text, text };
  }

  private object(type: ts.Type, depth: number, text: string): TypeShape {
    const c = this.checker;

    if (c.isTupleType(type)) {
      const target = (type as ts.TypeReference).target as ts.TupleType;
      const args = c.getTypeArguments(type as ts.TypeReference);
      const elements: TupleElement[] = args.map((arg, i) => {
        const flags = target.elementFlags[i] ?? ts.ElementFlags.Required;
        const rest = !!(flags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic));
        return {
          type: flags & ts.ElementFlags.Optional ? this.shapeOptional(arg, depth + 1) : this.shape(arg, depth + 1),
          optional: !!(flags & ts.ElementFlags.Optional),
          rest,
        };
      });
      return { kind: 'tuple', elements, text };
    }

    if (c.isArrayType(type)) {
      const [element] = c.getTypeArguments(type as ts.TypeReference);
      const readonly = type.symbol?.name === 'ReadonlyArray';
      return {
        kind: 'array',
        element: element ? this.shape(element, depth + 1) : { kind: 'unknown', reason: 'unsupported', text: 'unknown' },
        readonly,
        text,
      };
    }

    const symbol = type.getSymbol();
    if (symbol && this.isLibSymbol(symbol)) {
      const args = (type as ts.TypeReference).target ? c.getTypeArguments(type as ts.TypeReference) : [];
      const arg = (i: number): TypeShape =>
        args[i] ? this.shape(args[i], depth + 1) : { kind: 'unknown', reason: 'unsupported', text: 'unknown' };
      switch (symbol.name) {
        case 'Date':
          return { kind: 'date', text };
        case 'RegExp':
          return { kind: 'regexp', text };
        case 'Map':
        case 'ReadonlyMap':
          return { kind: 'map', key: arg(0), value: arg(1), text };
        case 'Set':
        case 'ReadonlySet':
          return { kind: 'set', element: arg(0), text };
        case 'Promise':
        case 'PromiseLike':
          return { kind: 'promise', value: arg(0), text };
        default:
          if (TYPED_ARRAYS.has(symbol.name)) return { kind: 'typedarray', name: symbol.name, text };
      }
    }

    const properties = c.getPropertiesOfType(type);
    if (c.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 && properties.length === 0) {
      return { kind: 'function', text };
    }

    // Instances of user-defined classes cannot be produced by the generator yet:
    // the sandbox encoding rebuilds them as plain objects, losing the prototype.
    if (symbol && symbol.flags & ts.SymbolFlags.Class && !this.isLibSymbol(symbol)) {
      return { kind: 'unknown', reason: 'class-instance', text };
    }

    const props: PropertyShape[] = [];
    for (const prop of properties.slice(0, MAX_PROPERTIES)) {
      const optional = !!(prop.flags & ts.SymbolFlags.Optional);
      const propType = c.getTypeOfSymbolAtLocation(prop, this.location);
      props.push({
        name: prop.name,
        optional,
        readonly: isReadonlyProperty(prop),
        type: optional ? this.shapeOptional(propType, depth + 1) : this.shape(propType, depth + 1),
      });
    }

    const index: IndexShape[] = c.getIndexInfosOfType(type).map((info) => ({
      key:
        info.keyType.flags & ts.TypeFlags.String ? 'string'
          : info.keyType.flags & ts.TypeFlags.Number ? 'number'
            : info.keyType.flags & ts.TypeFlags.ESSymbol ? 'symbol'
              : 'other',
      value: this.shape(info.type, depth + 1),
    }));

    const shape: TypeShape = { kind: 'object', properties: props, text };
    if (index.length) shape.index = index;
    return shape;
  }

  private isLibSymbol(symbol: ts.Symbol): boolean {
    return (symbol.declarations ?? []).some((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }
}

function isReadonlyProperty(prop: ts.Symbol): boolean {
  return (prop.declarations ?? []).some(
    (d) => (ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0,
  );
}

export function withoutUndefined(shape: TypeShape): TypeShape {
  if (shape.kind !== 'union') return shape;
  const members = shape.members.filter((m) => m.kind !== 'undefined');
  if (members.length === shape.members.length) return shape;
  if (members.length === 1) return members[0];
  return { kind: 'union', members, text: members.map((m) => m.text).join(' | ') };
}
