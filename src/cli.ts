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

import { analyzeIsolated } from './analyzer/isolated';
import type { FunctionAnalysis } from './analyzer/types';
import { checkSource } from './import-guard';
import { VENDORED_MODULES } from './bundle';
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

interface Args {
  command: string;
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags = new Map<string, string[]>();
  for (let i = command === 'help' ? 0 : 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? (i++, next) : 'true';
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
    const args = Array.isArray(t.args) ? (liftSentinels(t.args) as unknown[]) : [];
    return { id, args };
  });
  return { tests, entryName: typeof body.entryName === 'string' ? body.entryName : undefined };
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
    lines.push('', 'time / randomness (results vary between runs):');
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
    lines.push('', `pass ${pass.passId} (${pass.status}) -- ${pass.results.length} result(s), ${pass.workerGenerations} worker(s), ${pass.wallMs}ms`);
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
    case 'return': return `returned ${JSON.stringify(outcome.value)}`.slice(0, 160);
    case 'thrown': return `threw ${outcome.errorClass}: ${outcome.message}`.slice(0, 160);
    case 'timeout': return `TIMEOUT after ${outcome.limitMs}ms (worker terminated)`;
    case 'resource_limit': return `RESOURCE LIMIT (${outcome.limit}): ${outcome.detail}`;
    case 'harness_error': return `HARNESS ERROR: ${outcome.detail}`;
    default: return 'unknown outcome';
  }
}

// --- commands -------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help' || has(args, 'help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

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

  const sourcePath = one(args, 'source');
  if (!sourcePath) throw new Error('--source is required');
  const source = fs.readFileSync(path.resolve(sourcePath), 'utf8');

  if (args.command === 'analyze') {
    const result = await analyzeIsolated(source, {
      entryName: one(args, 'entry'),
      allowedModules: args.flags.get('allow') ?? VENDORED_MODULES,
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

  if (args.command === 'check') {
    const guard = checkSource(source, {
      entryName: one(args, 'entry'),
      allowedModules: args.flags.get('allow') ?? VENDORED_MODULES,
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

  if (args.command !== 'run') throw new Error(`unknown command '${args.command}'`);

  const testsPath = one(args, 'tests');
  if (!testsPath) throw new Error('--tests is required');
  const { tests, entryName } = loadTests(path.resolve(testsPath));

  const report = await evaluate({
    source,
    tests,
    entryName: one(args, 'entry') ?? entryName,
    allowedModules: args.flags.get('allow') ?? VENDORED_MODULES,
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
