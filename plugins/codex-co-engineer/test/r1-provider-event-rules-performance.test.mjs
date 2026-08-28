// Performance-regression coverage for provider-event-rules: the 256 KiB
// source bound must apply to object-form events, and UTF-8 truncation must
// stay linear. Conservative runtime assertions catch quadratic fallbacks
// without flaking on loaded hosts.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PROVIDER_EVENT_FACT_TEXT_BYTES,
  MAX_PROVIDER_EVENT_SOURCE_BYTES,
  applyProviderEventRulesV1,
} from '../mcp/v3/provider-event-rules.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  applyInput,
  assistantEvent,
  jsonl,
  progressRules,
} from './fixtures/r1-provider-event-rules-fixtures.mjs';

const CONSERVATIVE_BOUND_MS = 1000;
const PAYLOAD_BYTES = 300 * 1024;

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

test('a 300 KiB object-form payload is rejected within a conservative bound', () => {
  const payload = assistantEvent('a'.repeat(PAYLOAD_BYTES));
  assert.ok(Buffer.byteLength(payload.text, 'utf8') > MAX_PROVIDER_EVENT_SOURCE_BYTES);
  const started = process.hrtime.bigint();
  const error = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: [payload],
  })));
  const took = elapsedMs(started);
  assert.equal(error.code, 'source_too_large');
  assert.ok(took < CONSERVATIVE_BOUND_MS,
    `300 KiB object-form bound exceeded conservative runtime: ${took}ms`);
});

test('a 300 KiB JSONL payload is rejected within a conservative bound', () => {
  const line = JSON.stringify(assistantEvent('a'.repeat(PAYLOAD_BYTES)));
  assert.ok(Buffer.byteLength(line, 'utf8') > MAX_PROVIDER_EVENT_SOURCE_BYTES);
  const started = process.hrtime.bigint();
  const error = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: line,
  })));
  const took = elapsedMs(started);
  assert.equal(error.code, 'source_too_large');
  assert.ok(took < CONSERVATIVE_BOUND_MS,
    `300 KiB JSONL bound exceeded conservative runtime: ${took}ms`);
});

test('object-form aggregate bytes respect the same 256 KiB source bound', () => {
  const chunk = 'b'.repeat(30 * 1024);
  const events = Array.from({ length: 10 }, () => assistantEvent(chunk));
  const started = process.hrtime.bigint();
  const error = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: events,
  })));
  const took = elapsedMs(started);
  assert.equal(error.code, 'source_too_large');
  assert.ok(took < CONSERVATIVE_BOUND_MS,
    `object-form aggregate bound exceeded conservative runtime: ${took}ms`);
});

test('UTF-8 truncation of a near-limit legal payload stays bounded and linear', () => {
  const text = 'é'.repeat(10 * 1024);
  const source = jsonl([assistantEvent(text)]);
  assert.ok(Buffer.byteLength(source, 'utf8') < MAX_PROVIDER_EVENT_SOURCE_BYTES);
  const started = process.hrtime.bigint();
  const receipt = applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source,
  }));
  const took = elapsedMs(started);
  assert.equal(receipt.facts[0].truncated, true);
  assert.ok(Buffer.byteLength(receipt.facts[0].text, 'utf8') <= MAX_PROVIDER_EVENT_FACT_TEXT_BYTES);
  assert.ok(took < CONSERVATIVE_BOUND_MS,
    `UTF-8 truncation exceeded conservative runtime: ${took}ms`);
});
