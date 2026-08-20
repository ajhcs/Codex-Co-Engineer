import assert from 'node:assert/strict';
import test from 'node:test';

import { extractedCliResult } from '../mcp/v3/acp-worker.mjs';
import {
  boundedProviderResult,
  boundedProviderValue,
  createProviderResultAccumulator,
  providerCharCount,
  tailText,
} from '../mcp/v3/provider-result.mjs';

test('bounded provider results retain the tail and truthful source size', () => {
  const source = `${'prefix '.repeat(700)}VERDICT: PASS`;
  const bounded = boundedProviderResult(source, { limit: 128 });
  assert.match(bounded.value, /VERDICT: PASS$/u);
  assert.equal(bounded.value[0], '…');
  assert.equal(bounded.result_truncated, true);
  assert.equal(bounded.result_original_chars, source.length);
  assert.equal(bounded.value.length, 128);
});

test('short provider results do not claim truncation', () => {
  const bounded = boundedProviderResult('VERDICT: PASS');
  assert.deepEqual(bounded, { value: 'VERDICT: PASS' });
});

test('incremental provider results preserve conclusions across chunk boundaries', () => {
  const source = `${'x'.repeat(3_000)}${'y'.repeat(2_000)}\nVERDICT: PASS`;
  const accumulator = createProviderResultAccumulator({ limit: 128 });
  accumulator.append(source.slice(0, 3_000));
  accumulator.append(source.slice(3_000, 5_000));
  accumulator.append(source.slice(5_000));
  const bounded = accumulator.finish();
  assert.match(bounded.value, /VERDICT: PASS$/u);
  assert.equal(bounded.value[0], '…');
  assert.equal(bounded.result_truncated, true);
  assert.equal(bounded.result_original_chars, source.length);
  assert.equal(bounded.value.length, 128);
});

test('unknown clipped transport sources omit an untruthful original size', () => {
  const bounded = boundedProviderResult('tail verdict', { limit: 6, sourceTruncated: true });
  assert.deepEqual(bounded, { value: '…rdict', result_truncated: true });
});

test('structured results mark a clipped source without inventing its result size', () => {
  const accumulator = createProviderResultAccumulator({ limit: 32 });
  accumulator.append('tail verdict');
  assert.deepEqual(accumulator.finish({ sourceTruncated: true }), {
    value: '…tail verdict',
    result_truncated: true,
  });
});

test('accumulator keeps a final verdict while marking the exact hard limit', () => {
  const accumulator = createProviderResultAccumulator({ limit: 20 });
  accumulator.append(`${'x'.repeat(50)}VERDICT: PASS`);
  const bounded = accumulator.finish();
  assert.equal(bounded.value.length, 20);
  assert.equal(bounded.value[0], '…');
  assert.match(bounded.value, /VERDICT: PASS$/u);
});

test('accumulator uses the marker alone at a one-character limit', () => {
  const accumulator = createProviderResultAccumulator({ limit: 1 });
  accumulator.append('long output VERDICT: PASS');
  const bounded = accumulator.finish();
  assert.deepEqual(bounded.value, '…');
  assert.equal(bounded.value.length, 1);
});

test('tailText places its marker before retained provider text', () => {
  assert.equal(tailText('0123456789', 5), '…6789');
});

test('provider limits count code points and never split an emoji', () => {
  const source = `${'😀'.repeat(8)}VERDICT: PASS`;
  const bounded = boundedProviderResult(source, { limit: 14 });
  assert.equal(providerCharCount(source), 21);
  assert.equal(providerCharCount(bounded.value), 14);
  assert.equal(bounded.value.isWellFormed(), true);
  assert.match(bounded.value, /VERDICT: PASS$/u);
  assert.equal(bounded.result_original_chars, 21);
});

test('accumulator joins an emoji split across input chunks before tail slicing', () => {
  const accumulator = createProviderResultAccumulator({ limit: 14 });
  accumulator.append('prefix \uD83D');
  accumulator.append('\uDE00VERDICT: PASS');
  const bounded = accumulator.finish();
  assert.equal(bounded.value.isWellFormed(), true);
  assert.match(bounded.value, /VERDICT: PASS$/u);
  assert.equal(bounded.result_original_chars, providerCharCount('prefix 😀VERDICT: PASS'));
});

test('accumulator sanitizes split credentials from a combined bounded window', () => {
  const secret = 'sk-live-split-token-1234567890';
  const accumulator = createProviderResultAccumulator({
    sanitize: (text) => text.replaceAll(secret, '[REDACTED]'),
  });
  accumulator.append('work output sk-live-split-');
  accumulator.append('token-1234567890\nVERDICT: PASS');
  const bounded = accumulator.finish();
  assert.doesNotMatch(bounded.value, /sk-live-split|token-1234567890/u);
  assert.match(bounded.value, /VERDICT: PASS$/u);
});

test('accumulator keeps bounded overlap for a split credential before a huge delta', () => {
  const secret = 'sk-huge-split-token-1234567890';
  const accumulator = createProviderResultAccumulator({
    sanitize: (text) => text.replaceAll(secret, '[REDACTED]'),
  });
  accumulator.append(`work output ${secret.slice(0, 9)}`);
  accumulator.append(`${secret.slice(9)}${'x'.repeat(20_000)}\nVERDICT: HUGE PASS`);
  const bounded = accumulator.finish();
  assert.doesNotMatch(bounded.value, /sk-huge-split|token-1234567890/u);
  assert.match(bounded.value, /VERDICT: HUGE PASS$/u);
});

test('CLI JSONL chooses one prioritized candidate per record', () => {
  const result = extractedCliResult([
    JSON.stringify({ result: 'result candidate', text: 'secondary text', content: { text: 'content text' } }),
    JSON.stringify({ text: 'next chunk' }),
  ].join('\n'), 'prompt');
  assert.equal(result.value, 'result candidatenext chunk');
});

test('CLI plaintext preserves line separators and ignores a clipped partial first line', () => {
  const result = extractedCliResult('{"text":"clipped prefix\nVERDICT: CLI PASS', 'prompt', { sourceTruncated: true });
  assert.match(result.value, /^…VERDICT: CLI PASS$/u);
  const plain = extractedCliResult('first line\nsecond line', 'prompt');
  assert.equal(plain.value, 'first line\nsecond line');
  assert.equal(extractedCliResult('first line\n\nsecond line', 'prompt').value, 'first line\n\nsecond line');
});

test('recursive provider values tail-bound nested strings within byte/item limits', () => {
  const secret = 'private-nested-secret';
  const source = {
    progress: 'x'.repeat(5_000),
    nested: { final: `${'y'.repeat(5_000)}\nVERDICT: OBJECT PASS` },
    secret,
    extra: Array.from({ length: 100 }, (_, index) => `entry-${index}`),
  };
  const bounded = boundedProviderValue(source, {
    sanitize: (text) => text.replaceAll(secret, '[REDACTED]'),
    maxItems: 8,
    maxBytes: 16 * 1024,
  });
  assert.match(bounded.value.nested.final, /VERDICT: OBJECT PASS$/u);
  assert.doesNotMatch(JSON.stringify(bounded.value), /private-nested-secret/u);
  assert.equal(Buffer.byteLength(JSON.stringify(bounded.value), 'utf8') <= 16 * 1024, true);
  assert.equal(bounded.result_truncated, true);
  assert.equal(bounded.result_original_chars, undefined);
});
