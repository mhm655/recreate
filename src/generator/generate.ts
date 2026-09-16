/**
 * Turns a `FunctionAnalysis` (src/analyzer) into a list of test inputs for
 * `evaluate()` (src/host/orchestrator.ts). Runs on the HOST and never executes the
 * submission or the original -- it only reads the analyzer's structural description.
 *
 * Strategy: one-at-a-time (OAT) sweep, not a full cross product. For n parameters
 * with |V_i| representative values each, a cross product is prod(|V_i|) tests --
 * unusable for anything past two or three parameters. OAT instead fixes every
 * parameter at a single "typical" value and varies one parameter at a time through
 * its whole value set, giving sum(|V_i|) tests. That misses interactions between
 * two edge cases in different parameters, but this is a fixed-suite oracle grader,
 * not a fuzzer: the ordered/shuffled double run in the harness is what actually
 * proves correctness, and a bigger suite only means a slower one.
 */

import type { FunctionAnalysis, ParamInfo, SignatureInfo } from '../analyzer/types';
import { Rng } from './rng';
import { DEFAULT_VALUE_BUDGET, valuesFor, type ValueBudget } from './values';

export interface GenerateOptions {
  seed?: number;
  /** Hard cap on the number of test cases returned, across all signatures. */
  maxTests?: number;
  budget?: Partial<ValueBudget>;
}

export interface GeneratedTest {
  id: string;
  args: unknown[];
}

export type GenerateResult =
  | { ok: true; entryName: string; tests: GeneratedTest[] }
  | { ok: false; reason: string };

const DEFAULT_MAX_TESTS = 60;

export function generateTests(analysis: FunctionAnalysis, options: GenerateOptions = {}): GenerateResult {
  if (!analysis.generatability.generatable) {
    return { ok: false, reason: `not generatable: ${analysis.generatability.blockers.join('; ')}` };
  }

  const rng = new Rng(options.seed ?? 1);
  const budget: ValueBudget = { ...DEFAULT_VALUE_BUDGET, ...options.budget };
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;

  const multiSig = analysis.signatures.length > 1;
  const tests: GeneratedTest[] = [];
  for (let s = 0; s < analysis.signatures.length; s++) {
    const prefix = multiSig ? `sig${s}-` : '';
    for (const t of generateForSignature(analysis.signatures[s], rng, budget)) {
      tests.push({ id: `${prefix}${t.id}`, args: t.args });
    }
  }

  const deduped = dedupeById(tests);
  const limited = deduped.length > maxTests ? sampleKeepingCoverage(deduped, maxTests, rng) : deduped;
  return { ok: true, entryName: analysis.entryName, tests: limited };
}

function generateForSignature(sig: SignatureInfo, rng: Rng, budget: ValueBudget): GeneratedTest[] {
  const fixed = sig.params.filter((p) => !p.rest);
  const restParam = sig.params.find((p) => p.rest);

  if (fixed.length === 0 && !restParam) return [{ id: 'no-args', args: [] }];

  const valueSets = fixed.map((p) => valuesFor(p.type, rng, budget));
  const typicalIndex = fixed.map((_p, i) => Math.min(Math.floor(valueSets[i].length / 2), valueSets[i].length - 1));
  const typicalArgs = () => fixed.map((_p, i) => valueSets[i][typicalIndex[i]]);

  const tests: GeneratedTest[] = [];

  // One call with every fixed param at its typical value, trailing optionals filled.
  tests.push({ id: 'typical', args: typicalArgs() });

  // A second "minimal" call: same typical values, but every trailing optional
  // omitted, so a rewrite that forgot a default is exercised at least once.
  const minimalLen = lastRequiredIndex(fixed) + 1;
  if (minimalLen < fixed.length) {
    tests.push({ id: 'minimal', args: typicalArgs().slice(0, minimalLen) });
  }

  // Sweep: for each parameter, hold the others at typical and vary this one through
  // every representative value it has.
  for (let i = 0; i < fixed.length; i++) {
    for (let v = 0; v < valueSets[i].length; v++) {
      const args = typicalArgs();
      args[i] = valueSets[i][v];
      tests.push({ id: `p${i}-${fixed[i].name}-${v}`, args: trimTrailingOptional(args, fixed) });
    }
  }

  if (restParam) {
    const restEl = restElementShapeValues(restParam, rng, budget);
    const base = fixed.length ? typicalArgs() : [];
    tests.push({ id: 'rest-none', args: base });
    tests.push({ id: 'rest-one', args: [...base, rng.pick(restEl)] });
    tests.push({ id: 'rest-many', args: [...base, ...rng.sample(restEl, Math.min(3, restEl.length)), rng.pick(restEl)] });
  }

  return tests;
}

/** Index of the last non-optional fixed parameter, or -1 if all are optional. */
function lastRequiredIndex(params: readonly ParamInfo[]): number {
  let last = -1;
  for (let i = 0; i < params.length; i++) if (!params[i].optional) last = i;
  return last;
}

/**
 * A sweep test that only varies a trailing optional parameter is redundant with
 * `typical`/`minimal` at every other index; trimming keeps the sweep to what it's
 * actually testing.
 */
function trimTrailingOptional(args: unknown[], params: readonly ParamInfo[]): unknown[] {
  let end = args.length;
  while (end > 0 && params[end - 1]?.optional && args[end - 1] === undefined) end--;
  return args.slice(0, end);
}

function restElementShapeValues(restParam: ParamInfo, rng: Rng, budget: ValueBudget): unknown[] {
  const shape = restParam.type;
  const elementShape = shape.kind === 'array' ? shape.element : shape;
  return valuesFor(elementShape, rng, budget);
}

function dedupeById(tests: readonly GeneratedTest[]): GeneratedTest[] {
  const seen = new Set<string>();
  const out: GeneratedTest[] = [];
  for (const t of tests) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * Prefers 'typical'/'minimal' tests, then fills the rest of the cap by sampling the
 * remainder -- but `max` is a hard cap (see GenerateOptions.maxTests), so even the
 * preferred set is itself sampled down to `max` when there are more of them than
 * that (e.g. an overloaded function contributes one 'typical' per signature).
 */
function sampleKeepingCoverage(tests: readonly GeneratedTest[], max: number, rng: Rng): GeneratedTest[] {
  const priority = tests.filter((t) => t.id.endsWith('typical') || t.id.endsWith('minimal'));
  const rest = tests.filter((t) => !priority.includes(t));
  const kept = rng.sample(priority, Math.min(priority.length, max));
  return [...kept, ...rng.sample(rest, Math.max(0, max - kept.length))];
}
