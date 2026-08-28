// Declarative provider-event-rules focused coverage: wake taxonomy, identity
// and attempt fencing, redaction provenance, immutable evidence receipts,
// question-capability gating, and fail-closed ambiguity.

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  MAX_PROVIDER_EVENT_FACT_TEXT_BYTES,
  PROVIDER_EVENT_AUTHORITY,
  PROVIDER_EVENT_RECEIPT_SCHEMA_ID,
  PROVIDER_EVENT_REDACTION_MARKER,
  PROVIDER_EVENT_ROUTINE_SIGNAL,
  PROVIDER_EVENT_RULES_SCHEMA_ID,
  PROVIDER_EVENT_RULES_VERSION,
  PROVIDER_EVENT_WAKE_SIGNALS,
  applyProviderEventRulesV1,
  compileProviderEventRulesV1,
  createProviderEventRulesEngineV1,
  describeProviderEventRulesV1,
  parseProviderEventIdentityV1,
} from '../mcp/v3/provider-event-rules.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  HOSTILE_BEARER,
  HOSTILE_ENV,
  HOSTILE_TOKEN,
  HOSTILE_URL,
  IDENTITY,
  IDENTITY_ATTEMPT_2,
  applyInput,
  assistantEvent,
  errorRule,
  event,
  jsonl,
  liveReplyBridge,
  progressRules,
  questionRule,
  rulesDocument,
  textRule,
} from './fixtures/r1-provider-event-rules-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value),
    'returned records must be frozen');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

test('inventory is a frozen v1 evidence engine with an explicit wake taxonomy', () => {
  const inventory = describeProviderEventRulesV1();
  const again = describeProviderEventRulesV1();
  assert.equal(inventory.schema, PROVIDER_EVENT_RULES_SCHEMA_ID);
  assert.equal(inventory.version, PROVIDER_EVENT_RULES_VERSION);
  assert.equal(inventory.routine_signal, PROVIDER_EVENT_ROUTINE_SIGNAL);
  assert.equal(inventory.authority, PROVIDER_EVENT_AUTHORITY);
  assert.equal(inventory.verified_success, false);
  assert.equal(inventory.question_capability, 'live_structured_reply_bridge_only');
  assert.deepEqual([...inventory.wake_signals], [...PROVIDER_EVENT_WAKE_SIGNALS]);
  assert.deepEqual([...inventory.wake_signals], [
    'blocked', 'completed', 'failed', 'merge_ready', 'question', 'timeout',
    'user_update',
  ]);
  assert.equal(inventory.wake_signals.includes(PROVIDER_EVENT_ROUTINE_SIGNAL), false);
  assert.deepEqual(inventory.drivers, []);
  assert.deepEqual(inventory.billing, []);
  assert.deepEqual(inventory.scoring, []);
  assert.deepEqual(inventory.substitution, []);
  assertFrozenTree(inventory);
  assert.equal(canonicalJsonStringify(inventory), canonicalJsonStringify(again));
});

test('JSONL and object-form sources project identical progress facts', () => {
  const objectReceipt = applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: [assistantEvent('lane progress')],
  }));
  const jsonlReceipt = applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: jsonl([assistantEvent('lane progress')]),
  }));
  assert.equal(objectReceipt.signal, PROVIDER_EVENT_ROUTINE_SIGNAL);
  assert.equal(jsonlReceipt.signal, PROVIDER_EVENT_ROUTINE_SIGNAL);
  assert.equal(objectReceipt.verified_success, false);
  assert.equal(objectReceipt.authority, PROVIDER_EVENT_AUTHORITY);
  assert.equal(objectReceipt.schema, PROVIDER_EVENT_RECEIPT_SCHEMA_ID);
  assert.equal(objectReceipt.facts.length, 1);
  assert.equal(objectReceipt.facts[0].kind, 'text');
  assert.equal(objectReceipt.facts[0].text, 'lane progress');
  assert.equal(objectReceipt.facts[0].truncated, false);
  assert.equal(objectReceipt.capabilities.question, false);
  assert.deepEqual(objectReceipt.identity, IDENTITY);
  assert.equal(canonicalJsonStringify(objectReceipt), canonicalJsonStringify(jsonlReceipt));
  assertFrozenTree(objectReceipt);
});

test('routine progress never wakes and later progress cannot clear a wake', () => {
  const progressOnly = applyProviderEventRulesV1(applyInput({
    source: [
      assistantEvent('tick 1'),
      assistantEvent('tick 2'),
    ],
  }));
  assert.equal(progressOnly.signal, PROVIDER_EVENT_ROUTINE_SIGNAL);
  assert.equal(progressOnly.facts.length, 2);

  const completedThenProgress = applyProviderEventRulesV1(applyInput({
    source: [
      event('completed', { text: 'done' }),
      assistantEvent('late tick'),
    ],
  }));
  assert.equal(completedThenProgress.signal, 'completed');
  assert.equal(completedThenProgress.facts[0].signal, 'completed');
  assert.equal(completedThenProgress.facts[1].signal, PROVIDER_EVENT_ROUTINE_SIGNAL);
});

test('each wake signal is modeled directly and latches over progress', () => {
  for (const signal of PROVIDER_EVENT_WAKE_SIGNALS) {
    const type = signal === 'question' ? 'question' : signal;
    const source = type === 'question'
      ? [event('question', { text: 'need a choice', question_id: 'q-wake-1' })]
      : type === 'failed' || type === 'error'
        ? [event('error', { error: 'lane failed' })]
        : [event(type, { text: signal })];
    const receipt = applyProviderEventRulesV1(applyInput({ source }));
    assert.equal(receipt.signal, signal, `${signal} must wake`);
    assert.equal(receipt.facts.some((fact) => fact.signal === signal), true);
  }
});

test('caller identity is the only identity authority and fences attempt generations', () => {
  const parsed = parseProviderEventIdentityV1(IDENTITY);
  assert.deepEqual(parsed, IDENTITY);
  assertFrozenTree(parsed);

  const mismatch = errorOf(() => applyProviderEventRulesV1(applyInput({
    source: [assistantEvent('hello', { attempt: 2 })],
  })));
  assert.equal(mismatch.code, 'identity_mismatch');

  const engine = createProviderEventRulesEngineV1({
    rules: progressRules(),
    identity: IDENTITY,
  });
  const first = engine.apply([assistantEvent('gen-1')]);
  const second = engine.apply(jsonl([assistantEvent('gen-1-again')]));
  assert.equal(first.identity.attempt, 1);
  assert.equal(second.identity.attempt, 1);
  assert.notEqual(first, second);

  const drifted = errorOf(() => engine.apply([assistantEvent('nope', { attempt: 2 })]));
  assert.equal(drifted.code, 'identity_mismatch');

  const generationTwo = applyProviderEventRulesV1(applyInput({
    identity: { ...IDENTITY_ATTEMPT_2 },
    source: [assistantEvent('retry', { attempt: 2 })],
    rules: progressRules(),
  }));
  assert.equal(generationTwo.identity.attempt, 2);
  assert.equal(generationTwo.facts[0].text, 'retry');
});

test('redaction provenance is counted on facts and receipts', () => {
  const receipt = applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: [assistantEvent(`${HOSTILE_URL} ${HOSTILE_BEARER} ${HOSTILE_TOKEN} ${HOSTILE_ENV}`)],
  }));
  const fact = receipt.facts[0];
  assert.equal(fact.truncated, false);
  assert.ok(fact.redaction_count >= 4, `expected redactions, got ${fact.redaction_count}`);
  assert.equal(receipt.redaction_count, fact.redaction_count);
  assert.equal(fact.text.includes('hunter2'), false);
  assert.equal(fact.text.includes('supersecrettokenvalue'), false);
  assert.equal(fact.text.includes(HOSTILE_TOKEN), false);
  assert.equal(fact.text.includes('super-secret-value'), false);
  assert.equal(fact.text.includes(PROVIDER_EVENT_REDACTION_MARKER), true);
});

test('receipts stay immutable evidence and never claim verified success', () => {
  const receipt = applyProviderEventRulesV1(applyInput());
  assertFrozenTree(receipt);
  assert.equal(receipt.verified_success, false);
  assert.throws(() => {
    receipt.signal = 'completed';
  });
  assert.throws(() => {
    receipt.facts.push({ kind: 'text' });
  });
  assert.throws(() => {
    receipt.identity.attempt = 4;
  });
  assert.equal(receipt.signal, PROVIDER_EVENT_ROUTINE_SIGNAL);
});

test('question facts are answerable only with a live structured reply bridge', () => {
  const questionEvent = event('question', {
    text: 'Which provider?',
    question_id: 'q-choice-1',
  });
  const gated = applyProviderEventRulesV1(applyInput({
    source: [questionEvent],
  }));
  assert.equal(gated.signal, 'question');
  assert.equal(gated.capabilities.question, false);
  assert.equal(gated.facts[0].answerable, false);
  assert.equal(gated.facts[0].question_id, 'q-choice-1');

  const live = applyProviderEventRulesV1(applyInput({
    source: [questionEvent],
    reply_bridge: liveReplyBridge(),
  }));
  assert.equal(live.capabilities.question, true);
  assert.equal(live.facts[0].answerable, true);

  const prose = errorOf(() => applyProviderEventRulesV1(applyInput({
    source: [questionEvent],
    reply_bridge: { submit: 'function submit() {}' },
  })));
  assert.equal(prose.code, 'invalid_reply_bridge');
});

test('ambiguous selectors fail closed at compile time and apply time', () => {
  const compileError = errorOf(() => compileProviderEventRulesV1(rulesDocument([
    textRule({ id: 'one' }),
    textRule({ id: 'two' }),
  ])));
  assert.equal(compileError.code, 'ambiguous_rule');

  const applyError = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: rulesDocument([
      textRule({ id: 'plain' }),
      textRule({ id: 'also', match_path: '/channel', match_value: 'main' }),
    ]),
    source: [assistantEvent('hello', { channel: 'main' })],
  })));
  assert.equal(applyError.code, 'ambiguous_match');
});

test('tool, usage, thinking, and error facts keep bounded projections', () => {
  const receipt = applyProviderEventRulesV1(applyInput({
    source: [
      event('thinking', { text: 'considering options' }),
      event('tool', { tool: { name: 'read_file', text: 'src/a.ts' } }),
      event('usage', { usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } }),
      event('error', { error: { message: 'provider timeout', code: 'timeout' } }),
    ],
  }));
  assert.equal(receipt.facts[0].kind, 'thinking');
  assert.equal(receipt.facts[1].kind, 'tool');
  assert.equal(receipt.facts[1].tool_name, 'read_file');
  assert.equal(receipt.facts[2].kind, 'usage');
  assert.equal(receipt.facts[2].usage.total_tokens, 8);
  assert.equal(receipt.facts[3].kind, 'error');
  assert.equal(receipt.facts[3].error_code, 'timeout');
  assert.equal(receipt.signal, 'failed');
});

test('UTF-8 fact truncation does not split a multi-byte character', () => {
  const glyph = '😀';
  const text = glyph.repeat((MAX_PROVIDER_EVENT_FACT_TEXT_BYTES / 2) + 8);
  const receipt = applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    source: [assistantEvent(text)],
  }));
  const fact = receipt.facts[0];
  assert.equal(fact.truncated, true);
  assert.ok(Buffer.byteLength(fact.text, 'utf8') <= MAX_PROVIDER_EVENT_FACT_TEXT_BYTES);
  assert.equal(fact.text.includes('\uFFFD'), false);
  assert.equal(fact.text.endsWith(glyph), true);
});

test('required rules and unknown require ids fail closed', () => {
  const unmatched = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: rulesDocument([textRule({ id: 'need-me', required: true })]),
    source: [event('usage', { usage: 1 })],
  })));
  assert.equal(unmatched.code, 'required_rule_unmatched');

  const unknown = errorOf(() => applyProviderEventRulesV1(applyInput({
    rules: progressRules(),
    require: ['missing-rule'],
  })));
  assert.equal(unknown.code, 'unknown_required_rule');
});

test('question_id_path is valid only on question facts', () => {
  const extra = errorOf(() => compileProviderEventRulesV1(rulesDocument([
    textRule({ question_id_path: '/question_id' }),
  ])));
  assert.equal(extra.code, 'unknown_key');

  const rule = questionRule();
  delete rule.question_id_path;
  const missing = errorOf(() => compileProviderEventRulesV1(rulesDocument([rule])));
  assert.equal(missing.code, 'missing_key');
});

test('error rules without an explicit signal still fail-wake', () => {
  const rule = errorRule();
  delete rule.signal;
  const receipt = applyProviderEventRulesV1(applyInput({
    rules: rulesDocument([rule]),
    source: [event('error', { error: 'nope' })],
  }));
  assert.equal(receipt.signal, 'failed');
});
