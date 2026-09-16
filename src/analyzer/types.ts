/**
 * Output of the static analyzer: a JSON-serialisable description of a function's
 * signature, shaped for the input generator rather than for humans.
 *
 * Every shape carries `text`, the checker's own rendering of the type, so a
 * generator (or an LLM prompt) always has the precise original to fall back on when
 * the structured form is lossy.
 */

export type TypeShape =
  | { kind: 'string'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'boolean'; text: string }
  | { kind: 'bigint'; text: string }
  | { kind: 'null'; text: string }
  | { kind: 'undefined'; text: string }
  | { kind: 'literal'; value: string | number | boolean | null; text: string }
  | { kind: 'array'; element: TypeShape; readonly: boolean; text: string }
  | { kind: 'tuple'; elements: TupleElement[]; text: string }
  | { kind: 'object'; properties: PropertyShape[]; index?: IndexShape[]; text: string }
  | { kind: 'union'; members: TypeShape[]; text: string }
  | { kind: 'date'; text: string }
  | { kind: 'regexp'; text: string }
  | { kind: 'map'; key: TypeShape; value: TypeShape; text: string }
  | { kind: 'set'; element: TypeShape; text: string }
  | { kind: 'typedarray'; name: string; text: string }
  | { kind: 'promise'; value: TypeShape; text: string }
  /** Callbacks. Not generatable yet: functions cannot cross the sandbox encoding. */
  | { kind: 'function'; text: string }
  /** A generic with no usable constraint. */
  | { kind: 'typeParameter'; name: string; text: string }
  /** A type that refers back to itself; `text` names it. */
  | { kind: 'recursive'; text: string }
  /** `any`, `unknown`, unresolved imports, or a construct not modelled here. */
  | { kind: 'unknown'; reason: UnknownReason; text: string };

export type UnknownReason =
  | 'any'
  | 'unknown'
  | 'never'
  | 'unresolved'
  | 'depth-limit'
  | 'class-instance'
  | 'unsupported';

export interface TupleElement {
  /** For a rest element (`...boolean[]`) this is the type of each repeated element (`boolean`). */
  type: TypeShape;
  optional: boolean;
  rest: boolean;
}

export interface PropertyShape {
  name: string;
  optional: boolean;
  readonly: boolean;
  type: TypeShape;
}

export interface IndexShape {
  key: 'string' | 'number' | 'symbol' | 'other';
  value: TypeShape;
}

export interface ParamInfo {
  /** Identifier, or the source text of a destructuring pattern. */
  name: string;
  optional: boolean;
  rest: boolean;
  /** Source text of the default value, when there is one. */
  defaultText?: string;
  type: TypeShape;
}

export interface SignatureInfo {
  typeParameters: string[];
  params: ParamInfo[];
  /** For async functions this is the awaited type; see `isAsync`. */
  returnType: TypeShape;
}

export type NondeterminismKind =
  | 'Date.now'
  | 'new Date()'
  | 'Date()'
  | 'Math.random'
  | 'performance.now'
  | 'crypto.randomUUID'
  | 'crypto.getRandomValues';

export interface SourceLocation {
  line: number;
  column: number;
  snippet: string;
}

export interface NondeterminismSource extends SourceLocation {
  kind: NondeterminismKind;
}

export interface ModuleStateHint extends SourceLocation {
  name: string;
  /** `let`/`var` binding, or a `const` holding a mutable container. */
  reason: 'mutable-binding' | 'mutable-container';
}

export interface Generatability {
  /** False when at least one parameter cannot be produced as a test input. */
  generatable: boolean;
  /** Blocking problems, one per offending required parameter. */
  blockers: string[];
  /**
   * Optional parameters whose type cannot be generated (e.g. an optional callback).
   * Not blocking: the generator must simply always leave them out.
   */
  omitted: string[];
  /** Parameters the generator can only fill with untyped fallback values. */
  weaklyTyped: string[];
}

export interface FunctionAnalysis {
  entryName: string;
  isDefaultExport: boolean;
  isAsync: boolean;
  isGenerator: boolean;
  /** More than one entry means the function is overloaded; the implementation signature is excluded. */
  signatures: SignatureInfo[];
  /**
   * Calls whose results change between runs. Project decision: these are to be
   * frozen/seeded inside the sandbox so such functions become testable. That is not
   * implemented yet; until it is, the harness flags them as nondeterministic.
   */
  nondeterminism: NondeterminismSource[];
  /**
   * Static hints that the function may carry state across calls. Hints only: the
   * harness's ordered/shuffled double run is the authoritative check, and an
   * original that fails it is rejected as an oracle.
   */
  moduleState: ModuleStateHint[];
  generatability: Generatability;
  /** First few type errors in the source. Types reported above may be unreliable when present. */
  typeErrors: string[];
}

export type AnalysisResult =
  | { ok: true; analysis: FunctionAnalysis }
  | { ok: false; errors: Array<{ code: string; message: string; line?: number; column?: number }> };
