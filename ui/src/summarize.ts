import type { EncodedValue, Outcome } from './types';

const RESERVED_MARKER_KEYS = new Set(['__truncatedLength', '__truncatedKeys', '__droppedSymbolKeys']);

/**
 * Human-readable rendering of a tagged EncodedValue (the harness's wire format --
 * see ts-sandbox-harness's src/encoding.ts, which this mirrors). Used to render
 * `Outcome.value` instead of `JSON.stringify`-ing it directly, which just dumps the
 * wire-format tags verbatim (e.g. `{"t":"str","v":"x"}` instead of `"x"`).
 * Deliberately reimplemented here rather than imported from the harness package:
 * that package is server-only (touches Node's Buffer) and this file is bundled for
 * the browser -- see the note atop ./types.ts.
 */
function describeEncoded(enc: EncodedValue, seen: Set<number> = new Set()): string {
  const i = typeof enc.i === 'number' ? enc.i : undefined;
  if (i !== undefined && seen.has(i)) return '<circular reference>';
  const next = i !== undefined ? new Set(seen).add(i) : seen;

  switch (enc.t) {
    case 'undefined':
      return 'undefined';
    case 'null':
      return 'null';
    case 'bool':
    case 'num':
      return String(enc.v);
    case 'special':
      return String(enc.v);
    case 'str':
      return enc.trunc !== undefined ? `${JSON.stringify(enc.v)}... (truncated from ${enc.trunc} chars)` : JSON.stringify(enc.v);
    case 'bigint':
      return `${enc.v}n`;
    case 'symbol':
      return `Symbol(${String(enc.v)})`;
    case 'fn':
      return enc.name ? `${enc.cls ? 'class' : 'function'} ${enc.name}` : enc.cls ? 'an anonymous class' : 'an anonymous function';
    case 'ref':
      return '<circular reference>';
    case 'accessor':
      return '<getter>';
    case 'truncated':
      return `<truncated: ${enc.reason} limit reached>`;
    case 'unsupported':
      return `<unsupported: ${String(enc.kind)}>`;
    case 'date':
      return enc.v === null ? 'Invalid Date' : new Date(enc.v as string).toISOString();
    case 'regexp':
      return `/${enc.source}/${enc.flags}`;
    case 'typedarray':
      return `${enc.kind}(${enc.trunc !== undefined ? `truncated from ${enc.trunc} bytes` : `base64 ${(enc.b64 as string).length} chars`})`;
    case 'arraybuffer':
      return `ArrayBuffer(${enc.trunc !== undefined ? `truncated from ${enc.trunc} bytes` : `${(enc.b64 as string).length} base64 chars`})`;
    case 'array': {
      const items = ((enc.v as EncodedValue[]) ?? []).map((v) => describeEncoded(v, next));
      const extra = ((enc.props as Array<[string, EncodedValue]>) ?? [])
        .filter(([k]) => !RESERVED_MARKER_KEYS.has(k))
        .map(([k, v]) => `${k}: ${describeEncoded(v, next)}`);
      return `[${[...items, ...extra].join(', ')}]`;
    }
    case 'object': {
      const entries = ((enc.v as Array<[string, EncodedValue]>) ?? [])
        .filter(([k]) => !RESERVED_MARKER_KEYS.has(k))
        .map(([k, v]) => `${k}: ${describeEncoded(v, next)}`);
      const prefix = enc.ctor && enc.ctor !== 'Object' ? `${enc.ctor} ` : '';
      return `${prefix}{${entries.join(', ')}}`;
    }
    case 'error': {
      const extra = ((enc.props as Array<[string, EncodedValue]>) ?? [])
        .filter(([k]) => !RESERVED_MARKER_KEYS.has(k))
        .map(([k, v]) => `${k}: ${describeEncoded(v, next)}`);
      return `${enc.name}(${JSON.stringify(enc.message)})${extra.length ? ` {${extra.join(', ')}}` : ''}`;
    }
    case 'map': {
      const entries = ((enc.v as Array<[EncodedValue, EncodedValue]>) ?? []).map(([k, v]) => `${describeEncoded(k, next)} => ${describeEncoded(v, next)}`);
      return `Map{${entries.join(', ')}}`;
    }
    case 'set': {
      return `Set{${((enc.v as EncodedValue[]) ?? []).map((v) => describeEncoded(v, next)).join(', ')}}`;
    }
    default:
      return 'unknown value';
  }
}

/** Pure, so it's unit-testable (summarize.test.ts) without rendering anything. */
export function summarizeOutcome(o: Outcome): string {
  switch (o.type) {
    case 'return':
      return o.value ? `returned ${describeEncoded(o.value)}` : 'returned';
    case 'thrown':
      return `threw ${o.errorClass}: ${o.message}`;
    case 'timeout':
      return `timed out after ${o.limitMs}ms`;
    case 'resource_limit':
      return `resource limit (${o.limit}): ${o.detail}`;
    case 'harness_error':
      return `harness error: ${o.detail}`;
    default:
      return 'unknown outcome';
  }
}
