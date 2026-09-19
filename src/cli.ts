#!/usr/bin/env node
/**
 * Command line entry point. Runs on the host.
 *
 *   tsbox run   --source fn.ts --tests cases.json [--runner docker|local]
 *   tsbox check --source fn.ts                       (static screening only)
 *   tsbox preflight [--runner docker]                (is the sandbox usable?)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describeEncoded } from './encoding';
import { analyzeIsolated } from './analyzer/isolated';
import type { FunctionAnalysis } from './analyzer/types';
import { checkSource } from './import-guard';
import { VENDORED_MODULES } from './bundle';
import { generateTests } from './generator/generate';
import { gradeSubmission, type GradeReport } from './evaluator/grade';
import { runMutationTests, type MutationTestReport } from './mutator/mutation-test';
import { captureChallenge } from './challenge/capture';
import { gradeAgainstChallenge, type ChallengeGradeReport } from './challenge/grade';
import { CHALLENGE_SCHEMA_VERSION, type Challenge } from './challenge/types';
import { DockerRunner } from './host/docker-runner';
import { LocalRunner, type SandboxRunner } from './host/runner';
import { evaluate, type SubmissionReport } from './host/orchestrator';
import type { Limits } from './protocol';
import type { TestCase } from './host/orchestrator';

const USAGE = `
tsbox -- sandboxed TypeScript execution harness

  tsbox run --source <file.ts> --tests <file.json> [options]
  tsbox check --source <file.ts> [--entry <name>]
  tsbox analyze --source <file.ts> [--entry <name>] [--json]
                                    static signature/type analysis (no execution)
  tsbox generate --source <file.ts> [--entry <name>] [--seed <n>] [--max-tests <n>]
                 [--json] [--out <file.json>]
                                    generate a test-input suite for the function
                                    (see "Static analyzer" / "Input generation" in
                                    README.md); prints a summary unless --json/--out
  tsbox grade --oracle <file.ts> --rewrite <file.ts> --tests <file.json> [options]
  tsbox grade --challenge <file.json> --rewrite <file.ts> [options]
                                    grade a rewrite against a captured oracle, or
                                    against a Challenge tsbox capture wrote (no
                                    oracle source needed in that case); see
                                    "Evaluator" in README.md. --tests may be a
                                    file 'generate --out' produced, or hand-written
  tsbox mutate --source <file.ts> --tests <file.json> [--max-mutants <n>] [--json]
                                    mutation-test a suite against its own oracle:
                                    is it strong enough to catch a wrong rewrite?
                                    (see "Mutation testing" in README.md)
  tsbox capture --source <file.ts> [--entry <name>] [--seed <n>] [--max-tests <n>]
                [--mutate] [--max-mutants <n>] [--min-mutation-score <pct>]
                [--json] [--out <file.json>]
                                    capture the function's behaviour as a fixed,
                                    self-contained Challenge (see "Challenge data
                                    model" in README.md); --mutate also records a
                                    mutation-testing summary on the challenge.
                                    --min-mutation-score <pct> (e.g. 90) refuses to
                                    capture below that score; implies --mutate
  tsbox preflight [--runner docker|local]
  tsbox verify-isolation            probe the container's isolation from inside it

Options
  --source <path>        TypeScript source containing the function under test
  --tests <path>         JSON file of test inputs (see below)
  --entry <name>         Entry point name, or 'default'. Inferred when omitted.
  --runner <kind>        'docker' (default) or 'local'
  --unsafe-local         Required to actually use --runner local
  --runtime <name>       Container runtime (default: runsc)
  --unsafe-runtime       Required to use a runtime other than runsc
  --image <ref>          Sandbox image (default: ts-sandbox-harness:latest)
  --seed <n>             Seed for the shuffled pass (recorded in the report)
  --per-test-timeout <ms>
  --pass-timeout <ms>
  --submission-timeout <ms>
  --memory-mb <n>        Container memory cap
  --seccomp <path>       Seccomp profile path, or 'default' / 'unconfined'
  --allow <mod>          Add a module to the import allowlist (repeatable)
  --json                 Emit the full report as JSON instead of a summary
  --help

Test input file
  { "entryName": "slugify",
    "tests": [ { "id": "t1", "args": ["Hello World"] } ] }

  A bare array of test cases is also accepted. Because the file is plain JSON,
  these sentinel strings stand in for values JSON cannot express:
    "@@NaN"  "@@Infinity"  "@@-Infinity"  "@@-0"  "@@undefined"
  Write "@@@@x" for a literal "@@x".
`;

export interface Args {
  command: string;
  flags: Map<string, string[]>;
}

const KNOWN_COMMANDS = new Set([
  'help', 'preflight', 'verify-isolation', 'grade', 'capture', 'analyze', 'generate', 'check', 'mutate', 'run',
]);

/** Flags that are pure presence switches (`has(args, k)`) and never take a value. */
const BOOLEAN_FLAGS = new Set(['help', 'json', 'mutate', 'unsafe-local', 'unsafe-runtime']);

export function parseArgs(argv: string[]): Args {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags = new Map<string, string[]>();
  for (let i = command === 'help' ? 0 : 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    let value: string;
    if (BOOLEAN_FLAGS.has(key)) {
      value = 'true';
    } else {
      const next = argv[i + 1];
      // A missing or flag-shaped next token used to silently become the literal
      // string 'true' here -- e.g. a dangling `--allow` at the end of argv turned
      // into an allowlist of ["true"], rejecting every real module with a confusing
      // "(allowed: true)" message instead of a clear complaint about `--allow` itself.
      if (next === undefined || next.startsWith('--')) throw new Error(`--${key} requires a value`);
      value = next;
      i++;
    }
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  }
  return { command, flags };
}

const one = (a: Args, k: string): string | undefined => a.flags.get(k)?.[0];
const has = (a: Args, k: string): boolean => a.flags.has(k);
const num = (a: Args, k: string): number | undefined => {
  const v = one(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${k} must be a number, got '${v}'`);
  return n;
};

/**
 * Lift plain JSON into real JS values. Only the sentinel strings documented in the
 * usage text are special; everything else passes through untouched.
 */
export function liftSentinels(value: unknown): unknown {
  if (typeof value === 'string') {
    switch (value) {
      case '@@NaN': return NaN;
      case '@@Infinity': return Infinity;
      case '@@-Infinity': return -Infinity;
      case '@@-0': return -0;
      case '@@undefined': return undefined;
      default:
        return value.startsWith('@@@@') ? value.slice(2) : value;
    }
  }
  if (Array.isArray(value)) return value.map(liftSentinels);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = liftSentinels(v);
    return out;
  }
  return value;
}

function loadTests(file: string): { tests: TestCase[]; entryName?: string } {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const body = Array.isArray(parsed) ? { tests: parsed } : (parsed as { tests?: unknown; entryName?: string });
  if (!Array.isArray(body.tests)) throw new Error(`${file}: expected a "tests" array`);
  const tests = body.tests.map((raw, index) => {
    const t = raw as { id?: unknown; args?: unknown };
    const id = typeof t.id === 'string' ? t.id : `t${index + 1}`;
    // A missing "args" defaults to a zero-argument call, but a present-and-wrong-type
    // one (e.g. an object instead of an array, from a typo) used to be silently
    // coerced to the same [] -- turning a malformed test file into a confusing
    // wrong-answer report instead of a clear error naming the actual test id.
    if (t.args !== undefined && !Array.isArray(t.args)) {
      throw new Error(`${file}: test '${id}' has an "args" that is not an array`);
    }
    const args = Array.isArray(t.args) ? (liftSentinels(t.args) as unknown[]) : [];
    return { id, args };
  });
  return { tests, entryName: typeof body.entryName === 'string' ? body.entryName : undefined };
}

/** Enough shape checking to fail with a readable message instead of a bare "Cannot read properties of undefined" deep inside gradeAgainstChallenge. */
function loadChallenge(file: string): Challenge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const c = parsed as Partial<Challenge> | null;
  if (!c || typeof c !== 'object') throw new Error(`${file}: not a Challenge (expected a JSON object)`);
  if (typeof c.entryName !== 'string') throw new Error(`${file}: not a Challenge (missing "entryName")`);
  if (!Array.isArray(c.tests)) throw new Error(`${file}: not a Challenge (missing "tests" array)`);
  if (c.schemaVersion !== CHALLENGE_SCHEMA_VERSION) {
    throw new Error(`${file}: unsupported challenge schemaVersion ${String(c.schemaVersion)} (this tsbox expects ${CHALLENGE_SCHEMA_VERSION})`);
  }
  if (c.determinism !== undefined) {
    const d = c.determinism as Partial<NonNullable<Challenge['determinism']>> | null;
    const numeric = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!d || typeof d.enabled !== 'boolean' || !numeric(d.epochMs) || !numeric(d.tickMs) || !numeric(d.seed)) {
      throw new Error(`${file}: malformed "determinism" (expected { enabled, epochMs, tickMs, seed })`);
    }
  }
  return c as Challenge;
}

function buildRunner(a: Args): SandboxRunner {
  const kind = one(a, 'runner') ?? 'docker';
  if (kind === 'local') {
    if (!has(a, 'unsafe-local')) {
      throw new Error(
        'the local runner provides NO isolation: it runs submitted code as you, with your ' +
          'filesystem and network. Pass --unsafe-local if that is genuinely what you want.',
      );
    }
    return new LocalRunner();
  }
  if (kind !== 'docker') throw new Error(`unknown runner '${kind}'`);
  return new DockerRunner({
    image: one(a, 'image'),
    runtime: one(a, 'runtime'),
    allowUnsafeRuntime: has(a, 'unsafe-runtime'),
    memoryMb: num(a, 'memory-mb'),
    seccompProfile: one(a, 'seccomp'),
  });
}

/** USAGE documents --allow as "Add a module to the import allowlist (repeatable)" --
 * it must extend the vendored defaults, not replace them, or a user adding one
 * module they need silently loses permission for lodash-es/date-fns/ms too. */
export function modulesFrom(a: Args): string[] {
  const extra = a.flags.get('allow') ?? [];
  return [...new Set([...VENDORED_MODULES, ...extra])];
}

/** --min-mutation-score takes a percentage (e.g. 90), converted to the [0,1] fraction captureChallenge expects. */
function minMutationScoreFrom(a: Args): number | undefined {
  const pct = num(a, 'min-mutation-score');
  return pct === undefined ? undefined : pct / 100;
}

function limitsFrom(a: Args): Partial<Limits> {
  const limits: Partial<Limits> = {};
  const perTest = num(a, 'per-test-timeout');
  const pass = num(a, 'pass-timeout');
  const submission = num(a, 'submission-timeout');
  if (perTest !== undefined) limits.perTestTimeoutMs = perTest;
  if (pass !== undefined) limits.passTimeoutMs = pass;
  if (submission !== undefined) limits.submissionTimeoutMs = submission;
  return limits;
}

// --- rendering ------------------------------------------------------------

function renderAnalysis(a: FunctionAnalysis): string {
  const lines: string[] = [];
  const prefix = `${a.isAsync ? 'async ' : ''}${a.isGenerator ? 'function* ' : ''}`;
  for (const sig of a.signatures) {
    const tps = sig.typeParameters.length ? `<${sig.typeParameters.join(', ')}>` : '';
    const params = sig.params
      .map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional ? '?' : ''}: ${p.type.text}${p.defaultText ? ` = ${p.defaultText}` : ''}`)
      .join(', ');
    lines.push(`${prefix}${a.entryName}${tps}(${params}): ${sig.returnType.text}`);
  }
  if (a.signatures.length > 1) lines.push(`  (${a.signatures.length} overloads)`);

  const g = a.generatability;
  lines.push('', `generatable : ${g.generatable ? 'yes' : 'NO'}`);
  for (const b of g.blockers) lines.push(`  ! ${b}`);
  if (g.omitted.length) lines.push(`  always omitted: ${g.omitted.join('; ')}`);
  if (g.weaklyTyped.length) lines.push(`  weakly typed: ${g.weaklyTyped.join('; ')}`);

  if (a.nondeterminism.length) {
    lines.push('', 'time / randomness (frozen per test in the sandbox; a rewrite must read them in the same order):');
    for (const n of a.nondeterminism) lines.push(`  line ${n.line}:${n.column}  ${n.kind}  ${n.snippet}`);
  }
  if (a.moduleState.length) {
    lines.push('', 'module-level state written by the function (likely order-sensitive):');
    for (const s of a.moduleState) lines.push(`  line ${s.line}:${s.column}  ${s.name} (${s.reason})`);
  }
  if (a.typeErrors.length) {
    lines.push('', 'type errors (reported types may be unreliable):');
    for (const e of a.typeErrors) lines.push(`  ${e}`);
  }
  return lines.join('\n');
}

function render(report: SubmissionReport): string {
  const lines: string[] = [];
  const mark = { ok: 'PASS', rejected: 'REJECTED', nondeterministic: 'NON-DETERMINISTIC', failed: 'FAILED' };
  lines.push(`verdict : ${mark[report.verdict]}`);
  lines.push(`run     : ${report.runId}`);
  lines.push(`runner  : ${report.runner.name}${report.runner.isolated ? '' : '   <-- NOT ISOLATED'}`);
  lines.push(`elapsed : ${report.wallMs}ms`);

  if (report.staticAnalysis.violations?.length) {
    lines.push('', 'static analysis rejected the submission:');
    for (const v of report.staticAnalysis.violations) {
      const where = v.line ? ` (line ${v.line}:${v.column})` : '';
      lines.push(`  - [${v.code}]${where} ${v.message}`);
      if (v.snippet) lines.push(`      ${v.snippet}`);
    }
    return lines.join('\n');
  }

  if (report.staticAnalysis.entryName) {
    lines.push(`entry   : ${report.staticAnalysis.entryName}`);
  }

  for (const pass of report.passes) {
    lines.push('', `pass ${pass.passId} (${pass.status}) -- ${pass.results.length} result(s), ${pass.workerGenerations} sandbox attempt(s), ${pass.wallMs}ms`);
    for (const r of pass.results) {
      lines.push(`  ${r.testId.padEnd(16)} ${summarize(r.outcome)}`);
    }
    for (const p of pass.problems) lines.push(`  ! ${p.code}: ${p.detail}`);
  }

  if (report.determinism.divergences.length) {
    lines.push('', `order sensitivity (seed ${report.determinism.seed}):`);
    for (const d of report.determinism.divergences) {
      lines.push(`  ${d.testId} [${d.field}/${d.reason}]`);
      lines.push(`      ordered : ${d.ordered}`);
      lines.push(`      shuffled: ${d.shuffled}`);
    }
  }

  if (report.problems.length) {
    lines.push('', 'problems:');
    for (const p of report.problems) lines.push(`  - ${p.code}: ${p.detail}`);
  }

  return lines.join('\n');
}

function summarize(outcome: SubmissionReport['passes'][number]['results'][number]['outcome']): string {
  switch (outcome.type) {
    case 'return': return `returned ${describeEncoded(outcome.value)}`.slice(0, 160);
    case 'thrown': return `threw ${outcome.errorClass}: ${outcome.message}`.slice(0, 160);
    case 'timeout': return `TIMEOUT after ${outcome.limitMs}ms (sandbox terminated)`;
    case 'resource_limit': return `RESOURCE LIMIT (${outcome.limit}): ${outcome.detail}`;
    case 'harness_error': return `HARNESS ERROR: ${outcome.detail}`;
    default: return 'unknown outcome';
  }
}

function renderGrade(report: GradeReport): string {
  const lines: string[] = [];
  const mark = { passed: 'PASSED', failed: 'FAILED', oracle_invalid: 'ORACLE INVALID', rewrite_invalid: 'REWRITE INVALID' };
  lines.push(`verdict : ${mark[report.verdict]}`);
  lines.push(`score   : ${(report.score * 100).toFixed(1)}% (${report.tests.filter((t) => t.result === 'match').length}/${report.tests.length})`);
  if (report.droppedTestIds.length) {
    lines.push(`dropped : ${report.droppedTestIds.length} test(s) the oracle couldn't produce a real answer for (timeout/resource limit): ${report.droppedTestIds.join(', ')}`);
  }
  for (const p of report.problems) lines.push(`  ! ${p.code}: ${p.detail}`);
  for (const t of report.tests) {
    if (t.result === 'match') continue;
    lines.push(`  MISMATCH ${t.testId}: ${t.reason}`);
    lines.push(`      oracle : ${summarize(t.oracle.outcome)}`);
    lines.push(`      rewrite: ${summarize(t.rewrite.outcome)}`);
  }
  return lines.join('\n');
}

function renderMutation(report: MutationTestReport): string {
  const lines: string[] = [];
  lines.push(
    report.mutationScore === undefined
      ? 'mutation score : n/a'
      : `mutation score : ${(report.mutationScore * 100).toFixed(1)}% (${report.killedCount} killed / ${report.killedCount + report.survivedCount} scoreable)`,
  );
  if (report.inconclusiveCount) lines.push(`inconclusive   : ${report.inconclusiveCount} (mutant itself never ran; doesn't count either way)`);
  if (report.droppedTestIds.length) {
    lines.push(`dropped        : ${report.droppedTestIds.length} test(s) the oracle couldn't produce a real answer for (timeout/resource limit): ${report.droppedTestIds.join(', ')}`);
  }
  for (const p of report.problems) lines.push(`  ! ${p.code}: ${p.detail}`);
  for (const m of report.mutants) {
    if (m.status !== 'survived') continue;
    lines.push(`  SURVIVED (line ${m.line}:${m.column}): ${m.description}`);
  }
  return lines.join('\n');
}

function renderChallengeGrade(report: ChallengeGradeReport): string {
  const lines: string[] = [];
  const mark = { passed: 'PASSED', failed: 'FAILED', rewrite_invalid: 'REWRITE INVALID' };
  lines.push(`verdict : ${mark[report.verdict]}`);
  lines.push(`score   : ${(report.score * 100).toFixed(1)}% (${report.tests.filter((t) => t.result === 'match').length}/${report.tests.length})`);
  for (const p of report.problems) lines.push(`  ! ${p.code}: ${p.detail}`);
  for (const t of report.tests) {
    if (t.result === 'match') continue;
    lines.push(`  MISMATCH ${t.testId}: ${t.reason}`);
    lines.push(`      expected: ${summarize(t.expected)}`);
    lines.push(`      rewrite : ${summarize(t.rewrite)}`);
  }
  return lines.join('\n');
}

function renderChallengeSummary(challenge: Challenge): string {
  const lines: string[] = [];
  lines.push(`challenge '${challenge.id}' for '${challenge.entryName}'`);
  lines.push(`  tests   : ${challenge.tests.length}`);
  if (challenge.droppedTestIds.length) lines.push(`  dropped : ${challenge.droppedTestIds.length} (oracle couldn't answer -- timeout/resource limit): ${challenge.droppedTestIds.join(', ')}`);
  if (challenge.mutationTesting) {
    const m = challenge.mutationTesting;
    lines.push(`  mutation score : ${m.mutationScore === undefined ? 'n/a' : `${(m.mutationScore * 100).toFixed(1)}%`} (${m.killedCount} killed / ${m.killedCount + m.survivedCount} scoreable)`);
    for (const s of m.survived) lines.push(`    SURVIVED (line ${s.line}:${s.column}): ${s.description}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- generate: plain-JSON conversion ---------------------------------------

function sentinelForSpecialNumber(n: number): string | undefined {
  if (Number.isNaN(n)) return '@@NaN';
  if (n === Infinity) return '@@Infinity';
  if (n === -Infinity) return '@@-Infinity';
  if (Object.is(n, -0)) return '@@-0';
  return undefined;
}

/**
 * Converts one generated argument into the plain-JSON `--tests` format (see USAGE).
 * That format only round-trips what `liftSentinels` understands: primitives, plain
 * arrays/objects, and the four sentinel-able numeric specials plus `undefined`.
 * `Date`, `Map`, `Set`, `RegExp`, typed arrays and `bigint` -- all things the
 * generator can legitimately produce -- have no representation there, so this
 * reports failure instead of silently writing something misleading; the caller
 * skips that test and points at the JS API (`generateTests` + `evaluate()`) instead.
 */
function toCliJson(value: unknown): { ok: true; json: unknown } | { ok: false } {
  if (value === undefined) return { ok: true, json: '@@undefined' };
  if (value === null) return { ok: true, json: null };
  const t = typeof value;
  if (t === 'boolean') return { ok: true, json: value };
  if (t === 'number') {
    const s = sentinelForSpecialNumber(value as number);
    return { ok: true, json: s ?? value };
  }
  if (t === 'string') return { ok: true, json: (value as string).startsWith('@@') ? `@@${value}` : value };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const el of value) {
      const r = toCliJson(el);
      if (!r.ok) return r;
      out.push(r.json);
    }
    return { ok: true, json: out };
  }
  if (t === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = toCliJson(v);
      if (!r.ok) return r;
      out[k] = r.json;
    }
    return { ok: true, json: out };
  }
  return { ok: false };
}

// --- commands -------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || has(args, 'help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  // Checked up front so a typo'd command (e.g. `tsbox frobnicate`) is reported as
  // such, rather than as a misleading "--source is required" from the fallthrough
  // path below when no --source happens to be given either.
  if (!KNOWN_COMMANDS.has(args.command)) throw new Error(`unknown command '${args.command}'`);

  if (args.command === 'preflight') {
    const runner = buildRunner(args);
    const result = await runner.preflight();
    process.stdout.write(`${runner.name}\n${result.ok ? 'OK' : 'UNAVAILABLE'}: ${result.detail}\n`);
    return result.ok ? 0 : 1;
  }

  if (args.command === 'verify-isolation') {
    const runner = buildRunner(args);
    if (!(runner instanceof DockerRunner)) throw new Error('verify-isolation only applies to --runner docker');
    const pre = await runner.preflight();
    if (!pre.ok) {
      process.stdout.write(`UNAVAILABLE: ${pre.detail}\n`);
      return 1;
    }
    const checks = await runner.verifyIsolation();
    let failed = 0;
    for (const c of checks) {
      // Heuristic checks warn rather than fail: they infer rather than observe.
      const heuristic = c.check.includes('heuristic');
      const label = c.ok ? 'PASS' : heuristic ? 'WARN' : 'FAIL';
      if (!c.ok && !heuristic) failed += 1;
      process.stdout.write(`${label.padEnd(5)} ${c.check}\n      ${c.detail}\n`);
    }
    process.stdout.write(failed ? `\n${failed} isolation check(s) FAILED\n` : '\nall isolation checks passed\n');
    return failed ? 1 : 0;
  }

  if (args.command === 'grade') {
    const rewritePath = one(args, 'rewrite');
    if (!rewritePath) throw new Error('--rewrite is required');
    const rewriteSource = fs.readFileSync(path.resolve(rewritePath), 'utf8');

    const challengePath = one(args, 'challenge');
    if (challengePath) {
      const challenge = loadChallenge(path.resolve(challengePath));
      const report = await gradeAgainstChallenge(challenge, {
        rewriteSource,
        entryName: one(args, 'entry'),
        allowedModules: args.flags.get('allow'),
        limits: limitsFrom(args),
        runner: buildRunner(args),
        seed: num(args, 'seed'),
      });
      process.stdout.write(has(args, 'json') ? `${JSON.stringify(report, null, 2)}\n` : `${renderChallengeGrade(report)}\n`);
      return report.verdict === 'passed' ? 0 : 1;
    }

    const oraclePath = one(args, 'oracle');
    const testsPath = one(args, 'tests');
    if (!oraclePath) throw new Error('--oracle or --challenge is required');
    if (!testsPath) throw new Error('--tests is required');

    const oracleSource = fs.readFileSync(path.resolve(oraclePath), 'utf8');
    const { tests, entryName } = loadTests(path.resolve(testsPath));

    const report = await gradeSubmission({
      oracleSource,
      rewriteSource,
      tests,
      entryName: one(args, 'entry') ?? entryName,
      allowedModules: modulesFrom(args),
      limits: limitsFrom(args),
      runner: buildRunner(args),
      seed: num(args, 'seed'),
    });

    process.stdout.write(has(args, 'json') ? `${JSON.stringify(report, null, 2)}\n` : `${renderGrade(report)}\n`);
    return report.verdict === 'passed' ? 0 : 1;
  }

  if (args.command === 'capture') {
    const oraclePath = one(args, 'source');
    if (!oraclePath) throw new Error('--source is required');
    const oracleSource = fs.readFileSync(path.resolve(oraclePath), 'utf8');

    const result = await captureChallenge({
      oracleSource,
      entryName: one(args, 'entry'),
      allowedModules: modulesFrom(args),
      limits: limitsFrom(args),
      runner: buildRunner(args),
      seed: num(args, 'seed'),
      maxTests: num(args, 'max-tests'),
      mutationTest: has(args, 'mutate') ? { maxMutants: num(args, 'max-mutants'), seed: num(args, 'seed') } : false,
      minMutationScore: minMutationScoreFrom(args),
    });

    if (!result.ok) {
      process.stdout.write(`cannot capture challenge: ${result.reason}\n`);
      return 1;
    }

    const outPath = one(args, 'out');
    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(result.challenge, null, 2)}\n`);
      process.stdout.write(`wrote challenge '${result.challenge.id}' (${result.challenge.tests.length} test(s)) to ${outPath}\n`);
    } else if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(result.challenge, null, 2)}\n`);
    } else {
      process.stdout.write(renderChallengeSummary(result.challenge));
    }
    return 0;
  }

  const sourcePath = one(args, 'source');
  if (!sourcePath) throw new Error('--source is required');
  const source = fs.readFileSync(path.resolve(sourcePath), 'utf8');

  if (args.command === 'analyze') {
    const result = await analyzeIsolated(source, {
      entryName: one(args, 'entry'),
      allowedModules: modulesFrom(args),
    });
    if (has(args, 'json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (!result.ok) {
      for (const e of result.errors) {
        const where = e.line ? ` (line ${e.line}:${e.column})` : '';
        process.stdout.write(`REJECTED [${e.code}]${where} ${e.message}\n`);
      }
    } else {
      process.stdout.write(`${renderAnalysis(result.analysis)}\n`);
    }
    return result.ok ? 0 : 1;
  }

  if (args.command === 'generate') {
    const analyzed = await analyzeIsolated(source, {
      entryName: one(args, 'entry'),
      allowedModules: modulesFrom(args),
    });
    if (!analyzed.ok) {
      for (const e of analyzed.errors) {
        const where = e.line ? ` (line ${e.line}:${e.column})` : '';
        process.stdout.write(`REJECTED [${e.code}]${where} ${e.message}\n`);
      }
      return 1;
    }

    const generated = generateTests(analyzed.analysis, {
      seed: num(args, 'seed'),
      maxTests: num(args, 'max-tests'),
    });
    if (!generated.ok) {
      process.stdout.write(`cannot generate inputs: ${generated.reason}\n`);
      return 1;
    }

    const testsOut: TestCase[] = [];
    const skipped: string[] = [];
    for (const t of generated.tests) {
      const converted: unknown[] = [];
      let ok = true;
      for (const a of t.args) {
        const r = toCliJson(a);
        if (!r.ok) { ok = false; break; }
        converted.push(r.json);
      }
      if (ok) testsOut.push({ id: t.id, args: converted });
      else skipped.push(t.id);
    }

    const payload = { entryName: generated.entryName, tests: testsOut };
    const outPath = one(args, 'out');
    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(payload, null, 2)}\n`);
    }
    if (has(args, 'json') && !outPath) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (!outPath) {
      process.stdout.write(`generated ${testsOut.length} test(s) for '${generated.entryName}'\n`);
      for (const t of testsOut) process.stdout.write(`  ${t.id.padEnd(24)} ${JSON.stringify(t.args)}\n`);
    }
    if (skipped.length) {
      process.stdout.write(
        `\n${skipped.length} generated test(s) use a value with no plain-JSON representation ` +
          `(Date/Map/Set/RegExp/typed array/bigint) and were left out of the file: ${skipped.join(', ')}\n` +
          `Use the JS API (generateTests + evaluate) to run those directly.\n`,
      );
    }
    if (outPath) process.stdout.write(`wrote ${testsOut.length} test(s) to ${outPath}\n`);
    // A script relying on the exit code alone should be able to tell "generated
    // nothing usable" from success, even though the file/stdout payload alone
    // (an empty tests array) looks the same either way.
    return testsOut.length === 0 && skipped.length > 0 ? 1 : 0;
  }

  if (args.command === 'check') {
    const guard = checkSource(source, {
      entryName: one(args, 'entry'),
      allowedModules: modulesFrom(args),
    });
    if (guard.ok) {
      process.stdout.write(`OK  entry='${guard.entryName}'  modules=[${guard.referencedModules.join(', ')}]\n`);
      return 0;
    }
    for (const v of guard.violations) {
      const where = v.line ? ` (line ${v.line}:${v.column})` : '';
      process.stdout.write(`REJECTED [${v.code}]${where} ${v.message}\n`);
    }
    return 1;
  }

  if (args.command === 'mutate') {
    const testsPath = one(args, 'tests');
    if (!testsPath) throw new Error('--tests is required');
    const { tests, entryName } = loadTests(path.resolve(testsPath));

    const report = await runMutationTests({
      oracleSource: source,
      tests,
      entryName: one(args, 'entry') ?? entryName,
      allowedModules: modulesFrom(args),
      limits: limitsFrom(args),
      runner: buildRunner(args),
      seed: num(args, 'seed'),
      mutants: { maxMutants: num(args, 'max-mutants'), seed: num(args, 'seed') },
    });

    process.stdout.write(has(args, 'json') ? `${JSON.stringify(report, null, 2)}\n` : `${renderMutation(report)}\n`);
    // 'no_mutants' (nothing in the oracle was mutable) isn't a failure: captureChallenge's
    // own minMutationScore gate treats the same condition as passing -- there is
    // nothing for the suite to have missed. Any OTHER problem still fails the command.
    const hardProblems = report.problems.filter((p) => p.code !== 'no_mutants');
    return hardProblems.length === 0 && report.survivedCount === 0 ? 0 : 1;
  }

  // Only 'run' can reach here: every other name in KNOWN_COMMANDS returned above,
  // and anything not in KNOWN_COMMANDS was already rejected up front.

  const testsPath = one(args, 'tests');
  if (!testsPath) throw new Error('--tests is required');
  const { tests, entryName } = loadTests(path.resolve(testsPath));

  const report = await evaluate({
    source,
    tests,
    entryName: one(args, 'entry') ?? entryName,
    allowedModules: modulesFrom(args),
    limits: limitsFrom(args),
    runner: buildRunner(args),
    seed: num(args, 'seed'),
  });

  process.stdout.write(has(args, 'json') ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  return report.verdict === 'ok' ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`tsbox: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
