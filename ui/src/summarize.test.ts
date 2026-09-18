import { describe, it, expect } from 'vitest';
import { summarizeOutcome } from './summarize';

describe('summarizeOutcome', () => {
  it('formats a return outcome with its encoded value', () => {
    // Regression: this used to assert the raw wire-format dump
    // ('returned {"t":"num","v":42}') as correct -- exactly the bug it now guards
    // against. A person reading a mismatch report wants the value, not the tags.
    expect(summarizeOutcome({ type: 'return', value: { t: 'num', v: 42 } })).toBe('returned 42');
  });

  it('formats a string return value quoted, not as its wire-format tags', () => {
    expect(summarizeOutcome({ type: 'return', value: { t: 'str', v: 'hello' } })).toBe('returned "hello"');
  });

  it('formats an array/object return value structurally, recursing into nested values', () => {
    expect(
      summarizeOutcome({
        type: 'return',
        value: { t: 'array', i: 0, v: [{ t: 'num', v: 1 }, { t: 'str', v: 'x' }] },
      }),
    ).toBe('returned [1, "x"]');
    expect(
      summarizeOutcome({
        type: 'return',
        value: { t: 'object', i: 0, v: [['a', { t: 'num', v: 1 }]] },
      }),
    ).toBe('returned {a: 1}');
  });

  it('formats a Map return value, and never infinitely recurses on a cyclic one', () => {
    expect(
      summarizeOutcome({ type: 'return', value: { t: 'map', i: 0, v: [[{ t: 'str', v: 'k' }, { t: 'num', v: 1 }]] } }),
    ).toBe('returned Map{"k" => 1}');
    expect(summarizeOutcome({ type: 'return', value: { t: 'array', i: 0, v: [{ t: 'ref', v: 0 }] } })).toBe(
      'returned [<circular reference>]',
    );
  });

  it('notes truncation/dropped-key fields as dedicated markers, and still shows a real property of the same name', () => {
    // These fields (truncatedLength/truncatedKeys/droppedSymbolKeys) used to be
    // faked as ordinary [key, value] entries mixed into the real ones, making a
    // real property of the same name indistinguishable from the marker. They are
    // now dedicated fields on the node, so a real one just renders like any other.
    expect(
      summarizeOutcome({
        type: 'return',
        value: { t: 'array', i: 0, v: [{ t: 'num', v: 1 }], truncatedLength: 5, droppedSymbolKeys: 2 },
      }),
    ).toBe('returned [1] (showing first 1 of 5, 2 symbol key(s) dropped)');
    expect(
      summarizeOutcome({
        type: 'return',
        value: { t: 'object', i: 0, v: [['__truncatedKeys', { t: 'str', v: 'a real value' }]] },
      }),
    ).toBe('returned {__truncatedKeys: "a real value"}');
  });

  it('formats a thrown outcome with class and message', () => {
    expect(summarizeOutcome({ type: 'thrown', errorClass: 'RangeError', message: 'out of range' })).toBe(
      'threw RangeError: out of range',
    );
  });

  it('formats a timeout with its limit', () => {
    expect(summarizeOutcome({ type: 'timeout', limitMs: 1000 })).toBe('timed out after 1000ms');
  });

  it('formats a resource_limit with its kind and detail', () => {
    expect(summarizeOutcome({ type: 'resource_limit', limit: 'memory', detail: 'RSS exceeded cap' })).toBe(
      'resource limit (memory): RSS exceeded cap',
    );
  });

  it('formats a harness_error with its detail', () => {
    expect(summarizeOutcome({ type: 'harness_error', detail: 'compile failed' })).toBe(
      'harness error: compile failed',
    );
  });
});
