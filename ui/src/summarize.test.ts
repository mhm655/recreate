import { describe, it, expect } from 'vitest';
import { summarizeOutcome } from './summarize';

describe('summarizeOutcome', () => {
  it('formats a return outcome with its encoded value', () => {
    expect(summarizeOutcome({ type: 'return', value: { t: 'num', v: 42 } })).toBe(
      'returned {"t":"num","v":42}',
    );
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
