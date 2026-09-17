/**
 * The orchestrator. Runs on the HOST, outside the container.
 *
 * Everything that comes back from a sandbox is treated as attacker-influenced:
 *
 *   - lines are HMAC verified before being parsed at all;
 *   - parsing is plain `JSON.parse` under a byte cap, nothing more capable;
 *   - the returned test-id multiset must match the expected one exactly. Not a
 *     subset, not a superset, no duplicates. A submission that returns results for
 *     nine of ten tests has not passed nine tests -- it has failed the run;
 *   - a container that was killed is reported as `resource_limit_exceeded`, never
 *     surfaced as a crash or an empty pass.
 *
 * The whole test list is then run a second time in a shuffled order, in a second
 * fresh container. Any test whose outcome differs between the two passes means the
 * function carries state across calls -- a module-level counter, a memo cache, a
 * polluted prototype -- and that is reported as non-determinism rather than being
 * resolved by picking one of the two answers.
 */

import { randomUUID } from 'node:crypto';

import { parseChannel } from '../channel';
import { canonical, encodeArgs, hasTruncation, type EncodedValue } from '../encoding';
import { checkSource, type Violation } from '../import-guard';
import { mulberry32 } from '../rng';
import {
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  type Limits,
  type Outcome,
  type ResultLine,
  type SandboxRequest,
  type TestInput,
  type TestResult,
} from '../protocol';
import { newResultKey } from '../channel';
import { transpileSubmission } from '../transpile';
import { bundleSubmission, VENDORED_MODULES } from '../bundle';
import type { RunnerResult, SandboxRunner } from './runner';

export interface TestCase {
  id: string;
  /** Plain values; encoded here, once, and reused for both passes. */
  args: unknown[];
}

export interface EvaluateOptions {
  source: string;
  tests: TestCase[];
  entryName?: string;
  allowedModules?: readonly string[];
  skipGlobalHeuristics?: boolean;
  limits?: Partial<Limits>;
  runner: SandboxRunner;
  /** Seed for the shuffled pass. Recorded in the report so a run can be replayed. */
  seed?: number;
  runId?: string;
}

export type PassStatus =
  | 'ok'
  | 'integrity_violation'
  | 'incomplete'
  | 'resource_limit_exceeded'
  | 'sandbox_error';

export interface Problem {
  code: string;
  detail: string;
}

export interface PassReport {
  passId: string;
  status: PassStatus;
  /** Execution order for this pass. */
  order: string[];
  results: TestResult[];
  problems: Problem[];
  /** Number of worker instances used. >1 means a worker was killed mid-pass. */
  workerGenerations: number;
  consoleOutput: string;
  exitCode: number | null;
  signal: string | null;
  wallMs: number;
}

export interface Divergence {
  testId: string;
  field: 'outcome' | 'argsAfterCall' | 'presence';
  /**
   * `order_sensitive` means the two runs genuinely disagree about the answer.
   * `flaky_resource` means at least one side hit a timeout or memory cap, which is
   * a weaker signal -- it may be load on the host rather than a property of the code.
   */
  reason: 'order_sensitive' | 'flaky_resource';
  ordered: string;
  shuffled: string;
}

export type Verdict = 'ok' | 'rejected' | 'nondeterministic' | 'failed';

export interface SubmissionReport {
  runId: string;
  verdict: Verdict;
  runner: { name: string; isolated: boolean };
  staticAnalysis: {
    ok: boolean;
    entryName?: string;
    referencedModules?: string[];
    violations?: Violation[];
  };
  determinism: {
    deterministic: boolean;
    seed: number;
    divergences: Divergence[];
  };
  passes: PassReport[];
  /**
   * Per-test results from the ordered pass. Present only when both passes agreed;
   * when they did not, there is no single correct answer to record.
   */
  results: Record<string, TestResult>;
  problems: Problem[];
  wallMs: number;
}

/** Grace period on top of the in-sandbox pass budget, to cover container startup. */
const STARTUP_GRACE_MS = { isolated: 30_000, local: 8_000 };

export async function evaluate(options: EvaluateOptions): Promise<SubmissionReport> {
  const startedAt = Date.now();
  const runId = options.runId ?? randomUUID();
  const seed = options.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits, encode: { ...DEFAULT_LIMITS.encode, ...options.limits?.encode } };
  const runner = options.runner;

  const base = (verdict: Verdict, extra: Partial<SubmissionReport>): SubmissionReport => ({
    runId,
    verdict,
    runner: { name: runner.name, isolated: runner.isolated },
    staticAnalysis: { ok: false },
    determinism: { deterministic: false, seed, divergences: [] },
    passes: [],
    results: {},
    problems: [],
    wallMs: Date.now() - startedAt,
    ...extra,
  });

  // --- input validation (ours, not the sandbox's) -------------------------
  const idProblems = validateTestIds(options.tests);
  if (idProblems.length) return base('failed', { problems: idProblems });

  // --- static screening, before a container exists -------------------------
  const guard = checkSource(options.source, {
    allowedModules: options.allowedModules ?? VENDORED_MODULES,
    entryName: options.entryName,
    skipGlobalHeuristics: options.skipGlobalHeuristics,
  });
  if (!guard.ok) {
    return base('rejected', {
      staticAnalysis: { ok: false, violations: guard.violations },
      problems: [{ code: 'static_analysis_rejected', detail: `${guard.violations.length} violation(s)` }],
    });
  }

  const transpiled = transpileSubmission(options.source);
  if (!transpiled.ok) {
    return base('rejected', {
      staticAnalysis: {
        ok: false,
        violations: [{ code: 'parse-error', message: transpiled.detail }],
      },
      problems: [{ code: 'transpile_failed', detail: transpiled.detail }],
    });
  }

  const staticAnalysis = {
    ok: true as const,
    entryName: guard.entryName,
    referencedModules: guard.referencedModules,
  };

  // Inline any vendored dependency (e.g. lodash-es) so the code handed to the worker
  // is once again self-contained and requires nothing at runtime. No-op when the
  // submission has no imports.
  const bundled = await bundleSubmission(transpiled.code, guard.referencedModules);
  if (!bundled.ok) {
    return base('rejected', {
      staticAnalysis,
      problems: [{ code: 'bundle_failed', detail: bundled.detail }],
    });
  }

  // --- encode arguments once, reuse for both passes ------------------------
  let encodedTests: TestInput[];
  let truncatedInputIds: string[];
  try {
    encodedTests = options.tests.map((t) => ({ id: t.id, args: encodeArgs(t.args, limits.encode) }));
    // The encode budget (limits.encode) can silently shorten what the caller
    // actually specified -- e.g. an array truncated past maxCollectionEntries --
    // before it ever reaches the sandbox. That's invisible downstream (the
    // submission is simply graded against the shortened input), so surface it here
    // rather than let a caller assume their test input arrived intact.
    truncatedInputIds = encodedTests.filter((t) => hasTruncation(t.args)).map((t) => t.id);
  } catch (err) {
    return base('failed', {
      staticAnalysis,
      problems: [{ code: 'argument_encode_failed', detail: String(err) }],
    });
  }

  const preflight = await runner.preflight();
  if (!preflight.ok) {
    return base('failed', {
      staticAnalysis,
      problems: [{ code: 'runner_unavailable', detail: preflight.detail }],
    });
  }

  const grace = runner.isolated ? STARTUP_GRACE_MS.isolated : STARTUP_GRACE_MS.local;
  const perPassHostTimeout = limits.passTimeoutMs + grace;

  // Pass B's test order doesn't depend on pass A's results -- only on the seed,
  // computed up front -- so nothing here needs A to finish before B can start.
  // Each pass is independently bounded by its own hostTimeoutMs (enforced by the
  // runner: it kills the container rather than let `run()` hang), so running them
  // concurrently via Promise.all roughly halves wall-clock time in the common case
  // instead of paying the sum of both passes.
  const setupElapsed = Date.now() - startedAt;
  const remaining = limits.submissionTimeoutMs - setupElapsed;
  if (remaining <= 1_000) {
    return base('failed', {
      staticAnalysis,
      problems: [{
        code: 'submission_timeout',
        detail: `submission budget of ${limits.submissionTimeoutMs}ms was exhausted before either pass could start`,
      }],
    });
  }
  const perPassBudget = Math.min(perPassHostTimeout, remaining);

  const shuffled = shuffle(encodedTests, seed);
  const [passA, passB] = await Promise.all([
    runPass({
      runId, passId: 'a', tests: encodedTests, entryName: guard.entryName,
      code: bundled.code, limits, runner, hostTimeoutMs: perPassBudget,
    }),
    runPass({
      runId, passId: 'b', tests: shuffled, entryName: guard.entryName,
      code: bundled.code, limits, runner, hostTimeoutMs: perPassBudget,
    }),
  ]);

  // --- compare -------------------------------------------------------------
  const problems: Problem[] = [];
  if (truncatedInputIds.length) {
    problems.push({
      code: 'test_input_truncated',
      detail:
        `${truncatedInputIds.length} test(s) had an argument shortened by the encode budget before ` +
        `reaching the sandbox, and were graded against that shortened input: ${truncatedInputIds.slice(0, 10).join(', ')}`,
    });
  }
  if (!runner.isolated) {
    problems.push({
      code: 'no_isolation',
      detail: 'run with the local development runner; results are not security-meaningful',
    });
  }

  const passesOk = passA.status === 'ok' && passB.status === 'ok';
  const divergences = passesOk || (passA.results.length && passB.results.length)
    ? compare(passA, passB)
    : [];

  const deterministic = passesOk && divergences.length === 0;

  let verdict: Verdict;
  if (!passesOk) {
    verdict = 'failed';
    for (const p of [passA, passB]) {
      if (p.status !== 'ok') problems.push({ code: `pass_${p.passId}_${p.status}`, detail: describePass(p) });
    }
  } else if (!deterministic) {
    verdict = 'nondeterministic';
    problems.push({
      code: 'order_sensitive',
      detail:
        `${divergences.length} test(s) produced different results when the order changed; ` +
        'the function carries state across calls',
    });
  } else {
    verdict = 'ok';
  }

  const results: Record<string, TestResult> = {};
  if (verdict === 'ok') for (const r of passA.results) results[r.testId] = r;

  return {
    runId,
    verdict,
    runner: { name: runner.name, isolated: runner.isolated },
    staticAnalysis,
    determinism: { deterministic, seed, divergences },
    passes: [passA, passB],
    results,
    problems,
    wallMs: Date.now() - startedAt,
  };
}

// --- one pass -------------------------------------------------------------

async function runPass(args: {
  runId: string;
  passId: string;
  tests: TestInput[];
  entryName: string;
  code: string;
  limits: Limits;
  runner: SandboxRunner;
  hostTimeoutMs: number;
}): Promise<PassReport> {
  // A fresh key per pass: a key recovered from one container is useless against the
  // other, so forged results cannot be replayed between passes.
  const resultKey = newResultKey();
  const request: SandboxRequest = {
    protocolVersion: PROTOCOL_VERSION,
    runId: args.runId,
    passId: args.passId,
    resultKey,
    entryName: args.entryName,
    code: args.code,
    tests: args.tests,
    limits: args.limits,
  };

  const raw = await args.runner.run(request, args.hostTimeoutMs);
  return reconcile(args.passId, args.tests.map((t) => t.id), resultKey, raw, args.limits);
}

/**
 * Turn the untrusted bytes on the result channel into either a complete, verified
 * result set or a clearly-labelled failure. There is no middle ground on purpose:
 * a partially-returned result set is a failed run, because "the tests that came
 * back all passed" is exactly the property an attacker would engineer.
 */
export function reconcile(
  passId: string,
  expectedIds: string[],
  resultKey: string,
  raw: RunnerResult,
  limits: Limits,
): PassReport {
  const problems: Problem[] = [];
  const parsed = parseChannel<ResultLine>(resultKey, raw.resultChannel, {
    maxBytes: limits.maxResultBytes,
  });

  // 'oversize' is deliberately excluded: src/channel.ts only applies that check
  // after a line's signature verifies, so it means a genuine, correctly-signed
  // result that was too large to accept -- not tampering.
  const forged = parsed.rejected.filter(
    (r) => r.reason === 'bad-signature' || r.reason === 'malformed' || r.reason === 'bad-json',
  );
  const oversized = parsed.rejected.filter((r) => r.reason === 'oversize');
  const truncatedLines = parsed.rejected.filter((r) => r.reason === 'incomplete-line');

  if (forged.length) {
    problems.push({
      code: 'unsigned_channel_lines',
      detail:
        `${forged.length} line(s) on the result channel failed verification ` +
        `(first: ${forged[0].reason} "${forged[0].preview}"). Untrusted code wrote to the result fd.`,
    });
  }
  if (oversized.length) {
    problems.push({
      code: 'result_line_too_large',
      detail:
        `${oversized.length} signed result(s) exceeded the per-line size limit and were not accepted ` +
        `(first: "${oversized[0].preview}..."). Not tampering -- the encoded result was simply too large; ` +
        'the affected test(s) will show up as missing.',
    });
  }
  if (parsed.truncated) {
    problems.push({ code: 'result_channel_truncated', detail: `payload exceeded ${limits.maxResultBytes} bytes` });
  }
  if (truncatedLines.length) {
    problems.push({ code: 'result_channel_cut_short', detail: 'final line was incomplete; the sandbox was killed mid-write' });
  }

  // Sort accepted lines into buckets.
  const byId = new Map<string, TestResult[]>();
  let passEnd: Extract<ResultLine, { kind: 'pass-end' }> | undefined;
  const unexpectedShapes: string[] = [];

  for (const line of parsed.accepted) {
    if (!line || typeof line !== 'object' || typeof (line as ResultLine).kind !== 'string') {
      unexpectedShapes.push('non-object line');
      continue;
    }
    if (line.kind === 'result') {
      const r = line.result;
      if (!r || typeof r.testId !== 'string' || !r.outcome || typeof r.outcome.type !== 'string') {
        unexpectedShapes.push('malformed result');
        continue;
      }
      const list = byId.get(r.testId) ?? [];
      list.push(r);
      byId.set(r.testId, list);
    } else if (line.kind === 'pass-end') {
      passEnd = line;
    } else if (line.kind === 'fatal') {
      problems.push({ code: `sandbox_${line.reason}`, detail: line.detail });
    }
  }
  if (unexpectedShapes.length) {
    problems.push({ code: 'malformed_results', detail: `${unexpectedShapes.length} line(s): ${unexpectedShapes[0]}` });
  }

  // Exact test-id set reconciliation.
  const expected = new Set(expectedIds);
  const duplicates = [...byId.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
  const extras = [...byId.keys()].filter((id) => !expected.has(id));
  const missing = expectedIds.filter((id) => !byId.has(id));

  if (duplicates.length) {
    problems.push({ code: 'duplicate_results', detail: `duplicate test ids: ${duplicates.slice(0, 10).join(', ')}` });
  }
  if (extras.length) {
    problems.push({ code: 'unexpected_results', detail: `results for unknown test ids: ${extras.slice(0, 10).join(', ')}` });
  }
  if (missing.length) {
    problems.push({ code: 'missing_results', detail: `no result for: ${missing.slice(0, 10).join(', ')}` });
  }

  if (raw.startupError) problems.push({ code: 'sandbox_startup_failed', detail: raw.startupError });
  if (raw.hostTimedOut) {
    problems.push({ code: 'host_timeout', detail: 'the host killed the sandbox for exceeding its wall-clock budget' });
  }
  if (raw.oomKilled) problems.push({ code: 'container_oom', detail: 'the container was OOM-killed by the kernel' });
  if (!passEnd && !raw.startupError) {
    problems.push({ code: 'no_pass_end', detail: 'the sandbox did not report completing the pass' });
  }

  // Status precedence: tampering first (most specific and most serious), then
  // "the sandbox was killed", then "results are missing for some other reason".
  let status: PassStatus;
  if (raw.startupError) {
    status = 'sandbox_error';
  } else if (forged.length || duplicates.length || extras.length || unexpectedShapes.length) {
    status = 'integrity_violation';
  } else if (raw.oomKilled || raw.hostTimedOut || raw.signal === 'SIGKILL' || raw.exitCode === 137) {
    status = 'resource_limit_exceeded';
  } else if (missing.length || !passEnd || parsed.truncated) {
    status = 'incomplete';
  } else if (raw.exitCode !== 0) {
    status = 'sandbox_error';
    problems.push({ code: 'nonzero_exit', detail: `sandbox exited with code ${String(raw.exitCode)}` });
  } else {
    status = 'ok';
  }

  const results = expectedIds
    .map((id) => byId.get(id)?.[0])
    .filter((r): r is TestResult => r !== undefined);

  return {
    passId,
    status,
    order: expectedIds,
    results,
    problems,
    workerGenerations: passEnd?.workerGenerations ?? 0,
    consoleOutput: raw.rawOutput,
    exitCode: raw.exitCode,
    signal: raw.signal,
    wallMs: raw.wallMs,
  };
}

// --- comparison -----------------------------------------------------------

function compare(a: PassReport, b: PassReport): Divergence[] {
  const byIdA = new Map(a.results.map((r) => [r.testId, r]));
  const byIdB = new Map(b.results.map((r) => [r.testId, r]));
  const divergences: Divergence[] = [];

  for (const id of a.order) {
    const ra = byIdA.get(id);
    const rb = byIdB.get(id);
    if (!ra || !rb) {
      divergences.push({
        testId: id,
        field: 'presence',
        reason: 'flaky_resource',
        ordered: ra ? 'present' : 'absent',
        shuffled: rb ? 'present' : 'absent',
      });
      continue;
    }

    // consoleOutput is deliberately excluded: it is diagnostic only and never part
    // of the correctness verdict. durationMs and workerGeneration likewise.
    const oa = comparableOutcome(ra.outcome);
    const ob = comparableOutcome(rb.outcome);
    if (oa !== ob) {
      divergences.push({
        testId: id,
        field: 'outcome',
        reason: isResourceOutcome(ra.outcome) || isResourceOutcome(rb.outcome) ? 'flaky_resource' : 'order_sensitive',
        ordered: summarizeOutcome(ra.outcome),
        shuffled: summarizeOutcome(rb.outcome),
      });
      continue;
    }

    const aa = canonical(ra.argsAfterCall);
    const ab = canonical(rb.argsAfterCall);
    if (aa !== ab) {
      divergences.push({
        testId: id,
        field: 'argsAfterCall',
        reason: 'order_sensitive',
        ordered: clip(aa),
        shuffled: clip(ab),
      });
    }
  }
  return divergences;
}

/**
 * The part of an outcome that is a property of the CODE rather than of the run.
 * Resource failures carry human-readable detail such as the RSS reading at the moment
 * the watchdog fired; that number varies run to run, and comparing it would flag
 * every memory-hungry function as order-sensitive. Two passes that both hit the
 * memory cap agree.
 */
function comparableOutcome(o: Outcome): string {
  switch (o.type) {
    case 'timeout':
      return JSON.stringify({ type: o.type });
    case 'resource_limit':
      return JSON.stringify({ type: o.type, limit: o.limit });
    default:
      return JSON.stringify(o);
  }
}

function isResourceOutcome(o: Outcome): boolean {
  return o.type === 'timeout' || o.type === 'resource_limit';
}

export function summarizeOutcome(o: Outcome): string {
  switch (o.type) {
    case 'return':
      return `return ${clip(canonical(o.value))}`;
    case 'thrown':
      return `throw ${o.errorClass}: ${clip(o.message, 120)}`;
    case 'timeout':
      return `timeout after ${o.limitMs}ms`;
    case 'resource_limit':
      return `resource_limit(${o.limit}): ${clip(o.detail, 120)}`;
    case 'harness_error':
      return `harness_error: ${clip(o.detail, 120)}`;
    default:
      return 'unknown';
  }
}

function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function describePass(p: PassReport): string {
  const first = p.problems[0];
  return first ? `${first.code}: ${first.detail}` : `status=${p.status}`;
}

// --- helpers --------------------------------------------------------------

function validateTestIds(tests: TestCase[]): Problem[] {
  const problems: Problem[] = [];
  if (!Array.isArray(tests) || tests.length === 0) {
    return [{ code: 'no_tests', detail: 'at least one test input is required' }];
  }
  const seen = new Set<string>();
  for (const t of tests) {
    if (typeof t.id !== 'string' || t.id.length === 0 || t.id.length > 200) {
      problems.push({ code: 'bad_test_id', detail: `test ids must be non-empty strings under 200 chars: ${String(t.id)}` });
      continue;
    }
    if (seen.has(t.id)) {
      problems.push({ code: 'duplicate_test_id', detail: `duplicate test id in the input list: ${t.id}` });
    }
    seen.add(t.id);
    if (!Array.isArray(t.args)) {
      problems.push({ code: 'bad_test_args', detail: `test '${t.id}': args must be an array` });
    }
  }
  return problems;
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // A shuffle that happens to be the identity would silently weaken the check;
  // with more than one element, rotate so the orders genuinely differ.
  if (out.length > 1 && out.every((v, i) => v === items[i])) {
    out.push(out.shift() as T);
  }
  return out;
}

export type { EncodedValue };
