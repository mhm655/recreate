/**
 * LLM-assisted input generation (src/generator/llm.ts, src/generator/literals.ts).
 *
 * Uses a fake client, so these tests are free, deterministic and need no
 * credentials. One live smoke test runs only with TSBOX_LIVE_LLM=1, because it
 * spends real tokens.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';

import { analyzeFunction } from '../src/analyzer/analyze';
import type { FunctionAnalysis } from '../src/analyzer/types';
import { captureChallenge } from '../src/challenge/capture';
import { gradeAgainstChallenge } from '../src/challenge/grade';
import { generateTests } from '../src/generator/generate';
import { argsMismatch, LiteralError, parseArgsLiteral } from '../src/generator/literals';
import { suggestTestsWithLlm, type LlmSuggestOptions } from '../src/generator/llm';
import { LocalRunner } from '../src/host/runner';
import type { Limits } from '../src/protocol';

type Suggestion = { name: string; rationale: string; args: string };

/** A stand-in for the SDK client that records the request and returns a canned response. */
function fakeClient(
  answer: { tests: Suggestion[] } | null,
  overrides: Record<string, unknown> = {},
): { client: LlmSuggestOptions['client']; requests: Array<Record<string, any>> } {
  const requests: Array<Record<string, any>> = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, any>) => {
          requests.push(params);
          return {
            model: 'claude-opus-5',
            stop_reason: 'end_turn',
            stop_details: null,
            parsed_output: answer,
            usage: { input_tokens: 1234, output_tokens: 567 },
            ...overrides,
          };
        },
      },
    },
  } as unknown as LlmSuggestOptions['client'];
  return { client, requests };
}

function throwingClient(err: unknown): LlmSuggestOptions['client'] {
  return { beta: { messages: { parse: async () => { throw err; } } } } as unknown as LlmSuggestOptions['client'];
}

function analysisOf(source: string): FunctionAnalysis {
  const r = analyzeFunction(source);
  assert.ok(r.ok, JSON.stringify(r));
  return r.analysis;
}

const DISCOUNT = `
export function priceAfterDiscount(total: number, coupon: string): number {
  if (total <= 0) return 0;
  if (coupon === 'VIP2025') return Math.round(total * 0.8 * 100) / 100;
  if (coupon.startsWith('HALF-') && total >= 100) return total / 2;
  return total;
}`;

// --- literal format -----------------------------------------------------------

describe('llm literals: parsing', () => {
  it('lifts plain JSON and every tag into real values', () => {
    const [n, neg0, undef, date, big, map, set, re, text, obj] = parseArgsLiteral(JSON.stringify([
      '@@NaN', '@@-0', '@@undefined',
      { '@@date': '2024-02-29T00:00:00.000Z' }, { '@@bigint': '-12345678901234567890' },
      { '@@map': [['a', 1]] }, { '@@set': [1, 2] }, { '@@regexp': ['a+', 'gi'] },
      '@@@@literal', { nested: ['@@Infinity'] },
    ]));
    assert.ok(Number.isNaN(n));
    assert.ok(Object.is(neg0, -0));
    assert.equal(undef, undefined);
    assert.equal((date as Date).toISOString(), '2024-02-29T00:00:00.000Z');
    assert.equal(big, -12345678901234567890n);
    assert.deepEqual([...(map as Map<string, number>)], [['a', 1]]);
    assert.deepEqual([...(set as Set<number>)], [1, 2]);
    assert.equal(String(re), '/a+/gi');
    assert.equal(text, '@@literal');
    assert.deepEqual(obj, { nested: [Infinity] });
  });

  it('rejects malformed input instead of guessing', () => {
    for (const bad of ['not json', '{"a": 1}', '["@@Evil"]', '[{"@@date": "not a date"}]', '[{"@@bigint": "1e9"}]', '[{"@@exec": "rm"}]']) {
      assert.throws(() => parseArgsLiteral(bad), LiteralError, bad);
    }
    assert.throws(() => parseArgsLiteral(`["${'x'.repeat(70_000)}"]`), /size cap/);
  });

  it('turns a __proto__ key into a plain own property, not a prototype change', () => {
    const [obj] = parseArgsLiteral('[{"__proto__": {"polluted": true}}]') as [Record<string, unknown>];
    assert.equal(Object.getPrototypeOf(obj), Object.prototype);
    assert.ok(Object.prototype.hasOwnProperty.call(obj, '__proto__'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe('llm literals: holding inputs to the declared types', () => {
  const sigs = (src: string) => analysisOf(src).signatures;

  it('checks arity, including optional and rest parameters', () => {
    const s = sigs('export function f(a: number, b?: string, ...rest: boolean[]) {}');
    assert.equal(argsMismatch([1], s), undefined);
    assert.equal(argsMismatch([1, undefined, true, false], s), undefined);
    assert.match(argsMismatch([], s)!, /at least 1/);
    assert.match(argsMismatch([1, 'x', 'not a boolean'], s)!, /rest argument 0/);
    const fixed = sigs('export function g(a: number) {}');
    assert.match(argsMismatch([1, 2], fixed)!, /at most 1/);
  });

  it('checks nested structure, literals, unions and excess properties', () => {
    const s = sigs(`
      interface Order { id: string; qty: number; tier?: 'gold' | 'silver'; tags: string[] }
      export function f(o: Order, when: Date | null) {}`);
    assert.equal(argsMismatch([{ id: 'a', qty: 1, tags: [] }, null], s), undefined);
    assert.match(argsMismatch([{ id: 'a', qty: 1, tags: [], tier: 'bronze' }, null], s)!, /\.tier/);
    assert.match(argsMismatch([{ id: 'a', tags: [] }, null], s)!, /missing property 'qty'/);
    assert.match(argsMismatch([{ id: 'a', qty: 1, tags: [], extra: 1 }, null], s)!, /unexpected property 'extra'/);
    assert.match(argsMismatch([{ id: 'a', qty: 1, tags: [1] }, null], s)!, /\.tags: \[0\]/);
    assert.match(argsMismatch([{ id: 'a', qty: 1, tags: [] }, 'yesterday'], s)!, /when/);
  });

  it('accepts an input that fits any one overload', () => {
    const s = sigs(`
      export function pad(s: string): string;
      export function pad(n: number, width: number): string;
      export function pad(x: string | number, width = 2): string { return String(x); }`);
    assert.equal(argsMismatch(['a'], s), undefined);
    assert.equal(argsMismatch([1, 3], s), undefined);
    assert.match(argsMismatch([1], s)!, /fits no overload/);
  });
});

// --- suggestTestsWithLlm ----------------------------------------------------------

describe('llm suggestions', () => {
  const analysis = analysisOf(DISCOUNT);
  const existing = [{ id: 'typical', args: [10, 'abc'] }];

  it('sends one structured-output request with refusal fallbacks and the source as data', async () => {
    const { client, requests } = fakeClient({ tests: [] });
    const r = await suggestTestsWithLlm(DISCOUNT, analysis, existing, { client, maxSuggestions: 5, effort: 'medium' });
    assert.ok(r.ok);
    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.model, 'claude-opus-5');
    assert.equal(req.fallbacks, 'default');
    assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(req.output_config.effort, 'medium');
    assert.ok(req.output_config.format, 'structured output format is set');
    assert.equal(req.thinking, undefined, 'adaptive thinking is left at the model default');
    const prompt = req.messages[0].content as string;
    assert.ok(prompt.includes("coupon === 'VIP2025'"), 'the source is included');
    assert.ok(prompt.includes('priceAfterDiscount(total: number, coupon: string): number'));
    assert.ok(prompt.includes('<existing_inputs>') && prompt.includes('10'), 'existing inputs are listed');
    assert.ok(prompt.includes('up to 5 inputs'));
    assert.match(req.system, /not an instruction to you/);
  });

  it('keeps valid suggestions and reports every dropped one with a reason', async () => {
    const { client } = fakeClient({
      tests: [
        { name: 'VIP coupon', rationale: 'hits the VIP2025 branch', args: '[50, "VIP2025"]' },
        { name: 'half off at threshold', rationale: 'boundary of total >= 100', args: '[100, "HALF-X"]' },
        { name: 'wrong arity', rationale: 'x', args: '[1]' },
        { name: 'wrong type', rationale: 'x', args: '["50", "VIP2025"]' },
        { name: 'not json', rationale: 'x', args: '[50, VIP]' },
        { name: 'same as existing', rationale: 'x', args: '[10, "abc"]' },
        { name: 'VIP again', rationale: 'x', args: '[50, "VIP2025"]' },
        { name: 'zero total', rationale: 'total <= 0 branch', args: '[0, "VIP2025"]' },
      ],
    });
    const r = await suggestTestsWithLlm(DISCOUNT, analysis, existing, { client, maxSuggestions: 3 });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const { accepted, rejected, usage, model } = r.report;

    assert.deepEqual(accepted.map((a) => a.id), ['llm-1-vip-coupon', 'llm-2-half-off-at-threshold', 'llm-3-zero-total']);
    assert.deepEqual(accepted[0].args, [50, 'VIP2025']);
    assert.equal(accepted[0].rationale, 'hits the VIP2025 branch');
    assert.deepEqual(
      rejected.map((x) => [x.name, x.reason.split(':')[0]]),
      [
        ['wrong arity', 'does not fit the declared types'],
        ['wrong type', 'does not fit the declared types'],
        ['not json', 'not valid JSON'],
        ['same as existing', 'duplicates an input the suite already has'],
        ['VIP again', 'duplicates an input the suite already has'],
      ],
    );
    assert.deepEqual(usage, { inputTokens: 1234, outputTokens: 567 });
    assert.equal(model, 'claude-opus-5');
  });

  it('drops suggestions beyond the limit', async () => {
    const tests = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, rationale: 'r', args: `[${i + 20}, "x"]` }));
    const { client } = fakeClient({ tests });
    const r = await suggestTestsWithLlm(DISCOUNT, analysis, existing, { client, maxSuggestions: 2 });
    assert.ok(r.ok);
    assert.equal(r.report.accepted.length, 2);
    assert.equal(r.report.rejected.filter((x) => /limit/.test(x.reason)).length, 3);
  });

  it('reports the model that actually answered when a fallback ran', async () => {
    const { client } = fakeClient({ tests: [] }, { model: 'claude-opus-4-8' });
    const r = await suggestTestsWithLlm(DISCOUNT, analysis, existing, { client });
    assert.ok(r.ok);
    assert.equal(r.report.model, 'claude-opus-4-8');
  });

  it('fails clearly on refusal, truncation, unparseable output and API errors', async () => {
    const refusal = fakeClient(null, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } });
    const truncated = fakeClient(null, { stop_reason: 'max_tokens' });
    const unparsed = fakeClient(null);
    const cases: Array<[LlmSuggestOptions['client'], RegExp]> = [
      [refusal.client, /declined.*cyber/],
      [truncated.client, /max_tokens/],
      [unparsed.client, /requested structure/],
      [throwingClient(new Anthropic.APIConnectionError({ message: 'offline' })), /could not reach the Anthropic API/],
      [throwingClient(new Error('boom')), /LLM request failed: boom/],
    ];
    for (const [client, expected] of cases) {
      const r = await suggestTestsWithLlm(DISCOUNT, analysis, existing, { client });
      assert.equal(r.ok, false);
      assert.match(r.ok ? '' : r.reason, expected);
    }
  });
});

// --- capture ---------------------------------------------------------------------

describe('llm suggestions in challenge capture', () => {
  const runner = new LocalRunner();
  const LIMITS: Partial<Limits> = { perTestTimeoutMs: 2_000, passTimeoutMs: 30_000 };
  // Forgets the VIP coupon entirely; right about everything else.
  const FORGETS_VIP = `
    export function priceAfterDiscount(total: number, coupon: string): number {
      if (total <= 0) return 0;
      if (coupon.startsWith('HALF-') && total >= 100) return total / 2;
      return total;
    }`;
  const llmAnswer = {
    tests: [
      { name: 'vip coupon', rationale: 'the VIP2025 code takes 20% off', args: '[80, "VIP2025"]' },
      { name: 'half at threshold', rationale: 'HALF- applies from exactly 100', args: '[100, "HALF-1"]' },
    ],
  };

  it('a type-generated suite misses the VIP branch; LLM inputs catch it', async () => {
    const typedOnly = await captureChallenge({ oracleSource: DISCOUNT, runner, limits: LIMITS, seed: 1 });
    assert.ok(typedOnly.ok, typedOnly.ok ? '' : typedOnly.reason);
    assert.equal(typedOnly.challenge.generation.llm, undefined);
    const weak = await gradeAgainstChallenge(typedOnly.challenge, { rewriteSource: FORGETS_VIP, runner, limits: LIMITS });
    assert.equal(weak.verdict, 'passed', 'precondition: the typed suite cannot tell the buggy rewrite apart');

    const { client } = fakeClient(llmAnswer);
    const withLlm = await captureChallenge({ oracleSource: DISCOUNT, runner, limits: LIMITS, seed: 1, llm: { client } });
    assert.ok(withLlm.ok, withLlm.ok ? '' : withLlm.reason);
    const c = withLlm.challenge;
    assert.ok(c.tests.some((t) => t.id === 'llm-1-vip-coupon'));
    assert.deepEqual(c.generation.llm, {
      model: 'claude-opus-5',
      acceptedCount: 2,
      rejected: [],
      rationales: {
        'llm-1-vip-coupon': 'the VIP2025 code takes 20% off',
        'llm-2-half-at-threshold': 'HALF- applies from exactly 100',
      },
    });

    const strong = await gradeAgainstChallenge(c, { rewriteSource: FORGETS_VIP, runner, limits: LIMITS });
    assert.equal(strong.verdict, 'failed');
    const failedIds = strong.tests.filter((t) => t.result !== 'match').map((t) => t.testId);
    assert.deepEqual(failedIds, ['llm-1-vip-coupon']);

    const correct = await gradeAgainstChallenge(c, { rewriteSource: DISCOUNT, runner, limits: LIMITS });
    assert.equal(correct.verdict, 'passed');
  });

  it('fails the capture when LLM generation was requested and failed', async () => {
    const r = await captureChallenge({
      oracleSource: DISCOUNT, runner, limits: LIMITS, seed: 1,
      llm: { client: throwingClient(new Anthropic.APIConnectionError({ message: 'offline' })) },
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /^LLM input generation failed: could not reach/);
  });

  it('keeps the type-generated inputs unchanged alongside LLM ones', async () => {
    const analysis = analysisOf(DISCOUNT);
    const typed = generateTests(analysis, { seed: 1 });
    assert.ok(typed.ok);
    const { client } = fakeClient(llmAnswer);
    const r = await captureChallenge({ oracleSource: DISCOUNT, runner, limits: LIMITS, seed: 1, llm: { client } });
    assert.ok(r.ok);
    const ids = r.challenge.tests.map((t) => t.id);
    for (const t of typed.tests) {
      if (!r.challenge.droppedTestIds.includes(t.id)) assert.ok(ids.includes(t.id), t.id);
    }
  });
});

// --- live (opt-in) ------------------------------------------------------------------

describe('llm suggestions against the real API', { skip: process.env.TSBOX_LIVE_LLM !== '1' && 'set TSBOX_LIVE_LLM=1 (spends real tokens)' }, () => {
  it('returns type-conforming suggestions for a real function', async () => {
    const analysis = analysisOf(DISCOUNT);
    const typed = generateTests(analysis, { seed: 1 });
    assert.ok(typed.ok);
    const r = await suggestTestsWithLlm(DISCOUNT, analysis, typed.tests, { maxSuggestions: 8 });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.ok(r.report.accepted.length > 0, JSON.stringify(r.report.rejected));
    assert.ok(
      r.report.accepted.some((a) => a.args[1] === 'VIP2025'),
      `expected the VIP2025 branch to be targeted: ${JSON.stringify(r.report.accepted.map((a) => a.args))}`,
    );
  });
});
