/**
 * Deliberately hostile submissions. Each is a TypeScript source string, exactly as
 * a user would submit it.
 */

export const BUSY_LOOP = `
export function spin(forever: boolean): string {
  if (forever) {
    while (true) {}
  }
  return 'finished';
}
`;

/** Returns instantly, then hangs the thread from a microtask. */
export const DEFERRED_BUSY_LOOP = `
export function sneaky(hang: boolean): string {
  if (hang) Promise.resolve().then(() => { while (true) {} });
  return 'returned before hanging';
}
`;

export const HEAP_BOMB = `
export function grow(bomb: boolean): string {
  if (bomb) {
    const hoard: number[][] = [];
    while (true) hoard.push(new Array(100_000).fill(7));
  }
  return 'fine';
}
`;

/** ArrayBuffer backing stores live outside the V8 heap, so the heap cap cannot see this. */
export const OFF_HEAP_BOMB = `
export function grow(bomb: boolean): string {
  if (bomb) {
    const hoard: Uint8Array[] = [];
    while (true) hoard.push(new Uint8Array(32 * 1024 * 1024).fill(1));
  }
  return 'fine';
}
`;

/**
 * Same attack as OFF_HEAP_BOMB, but placed at module scope so it runs during
 * `compile()` -- before the worker ever posts 'ready' and before any test is
 * dispatched. Regression coverage for the RSS watchdog's `busy` gate, which used to
 * be `false` for this entire window.
 */
export const OFF_HEAP_BOMB_AT_MODULE_SCOPE = `
const hoard: Uint8Array[] = [];
while (true) hoard.push(new Uint8Array(32 * 1024 * 1024).fill(1));
export function grow(): string {
  return 'fine';
}
`;

/** Each of these must be stopped by static analysis before a sandbox exists. */
export const STATICALLY_BLOCKED_ESCAPES: Record<string, string> = {
  'plain require': `
    export function f() { return require('child_process').execSync('echo PWNED').toString(); }`,
  'import declaration': `
    import { execSync } from 'node:child_process';
    export function f() { return execSync('echo PWNED').toString(); }`,
  'worker_threads import': `
    import { Worker } from 'worker_threads';
    export function f() { return new Worker('while(true){}', { eval: true }); }`,
  'aliased require': `
    const load = require;
    export function f() { return load('child_process').execSync('echo PWNED').toString(); }`,
  'string-built require specifier': `
    export function f() { return require('child_' + 'process').execSync('echo PWNED').toString(); }`,
  'require via globalThis': `
    export function f() { return (globalThis as any)['req' + 'uire']('worker_threads'); }`,
  'computed dynamic import': `
    export async function f() { const m = 'node:' + 'child_process'; return (await import(m)).execSync('echo PWNED'); }`,
  'process.binding': `
    export function f() { return (process as any).binding('spawn_sync'); }`,
  'eval': `
    export function f() { return eval("require('child_process')"); }`,
};

/**
 * These get PAST static analysis (no flagged identifiers, no imports), so they
 * exercise the runtime layers: no Node globals in the vm context, and string code
 * generation disabled.
 */
export const RUNTIME_ESCAPES = `
export function attempt(which: string): unknown {
  switch (which) {
    case 'Function constructor':
      return (function () {}).constructor('return process')().mainModule.require('child_process').execSync('echo PWNED').toString();
    case 'arrow constructor chain':
      return (() => 0).constructor.constructor('return this.process')().pid;
    case 'async function constructor':
      return (async () => 0).constructor('return process')();
    case 'this at top level':
      return typeof (function (this: any) { return this; })();
    default:
      return 'no-op';
  }
}
`;

/** Lists what the sandbox realm actually exposes. Uses globalThis, so runs with the guard bypassed. */
export const GLOBAL_INVENTORY = `
export function inventory(): string {
  return ['process', 'require', 'module', 'setTimeout', 'setImmediate', 'queueMicrotask', 'fetch', 'Buffer', 'WebAssembly']
    .map((name) => name + ':' + typeof (globalThis as any)[name]).join(',');
}
`;

/** Runtime escapes that static analysis WOULD block -- run with the guard bypassed. */
export const RUNTIME_ONLY_REQUIRE = `
export function attempt(which: number): unknown {
  if (which === 1) return (require as any)('child_process').execSync('echo PWNED').toString();
  if (which === 2) return (globalThis as any)['req' + 'uire']('worker_threads');
  if (which === 3) return (module as any).require('fs');
  if (which === 4) return eval('1 + 1');
  if (which === 5) return import('node:child_process');
  return 'no-op';
}
`;

export const PROTOTYPE_POLLUTION = `
export function pollute(label: string) {
  const alreadyPolluted = ({} as any).pwned;
  (Object.prototype as any).pwned = 'set by ' + label;
  // Also try to sabotage the harness's own encoding path.
  (Object.prototype as any).toJSON = () => 'HIJACKED';
  (Array.prototype as any).push = () => { throw new Error('push hijacked'); };
  return { label, sawPollution: alreadyPolluted ?? null, pair: [label, label] };
}
`;

export const SPECIAL_VALUES = `
export function special(kind: string): unknown {
  switch (kind) {
    case 'nan': return NaN;
    case 'inf': return Infinity;
    case 'ninf': return -Infinity;
    case 'negzero': return -0;
    case 'undef': return undefined;
    case 'nested': return { a: undefined, b: NaN, c: [-0, Infinity], d: new Date(0) };
    case 'throw-error': throw new RangeError('out of range');
    case 'throw-string': throw 'just a string';
    default: return null;
  }
}
`;

export const IDENTITY = `
export function identity<T>(x: T): T { return x; }
`;

export const MUTATES_ARGS = `
export function sortAndTag(items: number[], meta: { calls?: number; sorted?: boolean }): number {
  items.sort((a, b) => a - b);
  items.push(999);
  meta.calls = (meta.calls ?? 0) + 1;
  meta.sorted = true;
  return items.length;
}
`;

export const MODULE_COUNTER = `
let calls = 0;
export function nextId(prefix: string): string {
  calls += 1;
  return prefix + '-' + calls;
}
`;

export const MEMO_CACHE = `
const cache = new Map<number, number>();
export function slowSquare(n: number): { value: number; cached: boolean } {
  if (cache.has(n)) return { value: cache.get(n)!, cached: true };
  const value = n * n;
  cache.set(n, value);
  return { value, cached: false };
}
`;

export const PURE = `
export function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
`;
