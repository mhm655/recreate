import type { Outcome } from './types';

/** Pure, so it's unit-testable (summarize.test.ts) without rendering anything. */
export function summarizeOutcome(o: Outcome): string {
  switch (o.type) {
    case 'return':
      return `returned ${JSON.stringify(o.value)}`;
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
