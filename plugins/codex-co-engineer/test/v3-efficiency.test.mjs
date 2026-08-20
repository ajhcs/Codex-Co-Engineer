import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VERSION } from '../mcp/v3/contract.mjs';
import {
  RESPONSE_MODE_STRUCTURED,
  TEXT_FALLBACK_MAX_BYTES,
  TEXT_FALLBACK_SCHEMA,
  buildTextFallback,
  buildToolResult,
  resolveTextFallbackMaxBytes,
  sanitizeToolPayload,
} from '../mcp/v3/response.mjs';
import { createTask, waitForTaskProgress } from '../mcp/v3/task-store.mjs';
import {
  BASELINE_VERSION,
  STATUS_TASK_LIMIT,
  STRUCTURED_TRANSPORT_VERSION,
  TASK_COUNTS,
  WAIT_DURATION_MS,
  measureFixture,
  measureResponse,
  publicPayloads,
} from './fixtures/v3-efficiency-fixtures.mjs';

const SHAPES_PATH = new URL('./fixtures/v3-public-response-shapes.json', import.meta.url);
const BASELINE_PATH = new URL('./fixtures/v3-efficiency-baseline.json', import.meta.url);
const SHAPES = JSON.parse(readFileSync(SHAPES_PATH, 'utf8'));
const RECORDED_BASELINE = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const IMMUTABLE_DUPLICATION_BASELINE = Object.freeze(
  JSON.parse(JSON.stringify(RECORDED_BASELINE.duplication_baseline)),
);

function keys(value) {
  return Object.keys(value);
}

function parseTextFallback(response) {
  const text = response.result.content[0].text;
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'text content must never be empty');
  const fallback = JSON.parse(text);
  assert.equal(fallback.schema, TEXT_FALLBACK_SCHEMA);
  assert.equal(fallback.authoritative, 'structuredContent');
  assert.equal(fallback.receipt_in_text, false);
  assert.equal(fallback.text_max_bytes, TEXT_FALLBACK_MAX_BYTES);
  assert.equal(typeof fallback.structured_bytes, 'number');
  assert.equal(typeof fallback.truncated, 'boolean');
  assert.equal(typeof fallback.summary, 'object');
  return fallback;
}

function assertLegacyDuplication(response, name, payload) {
  const expected = sanitizeToolPayload(payload);
  assert.deepEqual(keys(response), SHAPES.jsonrpc, `${name} JSON-RPC envelope changed`);
  assert.deepEqual(keys(response.result), SHAPES.result, `${name} MCP result changed`);
  assert.deepEqual(keys(response.result.content[0]), SHAPES.content_item, `${name} text content changed`);
  assert.equal(response.result.content[0].type, 'text');
  assert.deepEqual(keys(response.result.structuredContent), SHAPES.responses[name], `${name} public keys changed`);
  assert.deepEqual(
    response.result.structuredContent,
    expected,
    `${name} structuredContent must deep-equal the fixture sanitizer payload`,
  );
  assert.equal(
    response.result.content[0].text,
    JSON.stringify(response.result.structuredContent),
    `${name} omitted/default text must equal JSON.stringify(structuredContent)`,
  );
  assert.equal(
    response.result.content[0].text,
    JSON.stringify(expected),
    `${name} omitted/default text must equal the canonical sanitized fixture serialization`,
  );
}

function assertStructuredFallback(response, name, payload) {
  const expected = sanitizeToolPayload(payload);
  assert.deepEqual(keys(response.result.structuredContent), SHAPES.responses[name], `${name} public keys changed`);
  assert.deepEqual(
    response.result.structuredContent,
    expected,
    `${name} structuredContent must deep-equal the fixture sanitizer payload`,
  );
  const fallback = parseTextFallback(response);
  assert.notEqual(
    response.result.content[0].text,
    JSON.stringify(response.result.structuredContent),
    `${name} structured mode must not duplicate the full receipt in text`,
  );
  assert.ok(
    Buffer.byteLength(response.result.content[0].text, 'utf8') <= TEXT_FALLBACK_MAX_BYTES,
    `${name} text fallback exceeds ${TEXT_FALLBACK_MAX_BYTES} bytes`,
  );
  assert.equal(fallback.structured_bytes, Buffer.byteLength(JSON.stringify(response.result.structuredContent), 'utf8'));
  assert.equal(Buffer.from(response.result.content[0].text, 'utf8').toString('utf8'), response.result.content[0].text);
}

function assertTaskShape(task) {
  assert.deepEqual(keys(task), SHAPES.task, 'public task receipt keys changed');
  for (const key of SHAPES.forbidden_task_keys) assert.equal(Object.hasOwn(task, key), false, `raw task key leaked: ${key}`);
}

function assertTerminalTaskShape(task) {
  assert.deepEqual(keys(task), SHAPES.terminal_task, 'terminal public task receipt keys changed');
  for (const key of SHAPES.forbidden_task_keys) assert.equal(Object.hasOwn(task, key), false, `raw task key leaked: ${key}`);
}

function assertStructuredSummaryCompatibility(name, payload, response) {
  const fallback = parseTextFallback(response);
  const structured = response.result.structuredContent;
  if (name === 'status') {
    assert.equal(fallback.summary.kind, 'status');
    assert.equal(fallback.summary.version, structured.version);
    assert.equal(fallback.summary.healthy, structured.healthy);
    assert.equal(fallback.summary.active, structured.active);
    assert.equal(fallback.summary.task_count, structured.tasks.length);
  } else if (name === 'tasks') {
    assert.equal(fallback.summary.kind, 'tasks');
    assert.equal(fallback.summary.task_count, structured.tasks.length);
  } else if (name === 'task') {
    assert.equal(fallback.summary.kind, 'task');
    assert.equal(fallback.summary.task.id, structured.task.id);
    assert.equal(fallback.summary.state, structured.state);
    assert.equal(fallback.summary.view, structured.view);
  } else if (name === 'delegate') {
    assert.equal(fallback.summary.kind, 'delegate');
    assert.equal(fallback.summary.task.id, structured.task.id);
    assert.equal(fallback.summary.state, structured.state);
  } else if (name === 'cancel') {
    assert.equal(fallback.summary.kind, 'cancel');
    assert.equal(fallback.summary.task.id, structured.task.id);
  }
  assert.deepEqual(structured, sanitizeToolPayload(payload));
}

test('3.1.1 public MCP response shapes remain backward compatible by default', () => {
  assert.equal(BASELINE_VERSION, SHAPES.baseline_version);
  assert.match(VERSION, /^3\.\d+\.\d+$/u, 'runtime version must remain compatible with the 3.x public contract');
  for (const taskCount of TASK_COUNTS) {
    const payloads = publicPayloads(taskCount);
    for (const [name, payload] of Object.entries(payloads)) {
      const { response } = measureResponse(payload);
      assertLegacyDuplication(response, name, payload);
      if (name === 'status') {
        assert.equal(response.result.structuredContent.tasks.length, Math.min(taskCount, STATUS_TASK_LIMIT));
      }
      if (name === 'tasks') {
        assert.equal(response.result.structuredContent.tasks.length, taskCount);
      }
    }
    const task = payloads.task.task;
    assertTaskShape(task);
    assert.deepEqual(keys(payloads.task.progress), SHAPES.progress, 'task progress keys changed');
    assertTaskShape(payloads.delegate.task);
    assertTaskShape(payloads.cancel.task);
    const terminalTasks = payloads.tasks.tasks.filter((entry) => entry.status !== 'running');
    if (taskCount > 1) assert.ok(terminalTasks.length > 0, `${taskCount}-task fixture should include terminal receipts`);
    for (const terminalTask of terminalTasks) assertTerminalTaskShape(terminalTask);
  }
});

test('response_mode structured opts into bounded fallback across all five tools', () => {
  for (const taskCount of TASK_COUNTS) {
    const payloads = publicPayloads(taskCount);
    assert.deepEqual(Object.keys(payloads).sort(), ['cancel', 'delegate', 'status', 'task', 'tasks']);
    for (const [name, payload] of Object.entries(payloads)) {
      const legacy = buildToolResult(payload);
      const result = buildToolResult(payload, { responseMode: RESPONSE_MODE_STRUCTURED });
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      assert.equal(legacy.content[0].text, JSON.stringify(legacy.structuredContent));
      assert.deepEqual(result.structuredContent, sanitizeToolPayload(payload));
      assert.deepEqual(result.structuredContent, legacy.structuredContent);
      const fallback = JSON.parse(result.content[0].text);
      assert.equal(fallback.schema, TEXT_FALLBACK_SCHEMA);
      assert.equal(fallback.authoritative, 'structuredContent');
      assert.equal(fallback.receipt_in_text, false);
      assert.notDeepEqual(fallback, result.structuredContent);
      assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') < Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'));
      const { response } = measureResponse(payload, 1, { responseMode: RESPONSE_MODE_STRUCTURED });
      assertStructuredFallback(response, name, payload);
      assertStructuredSummaryCompatibility(name, payload, response);
    }
  }
});

test('text fallback redacts secrets and never reintroduces raw prompts', () => {
  const payload = {
    task: {
      id: 'secret-task',
      status: 'failed',
      state: 'failed',
      provider: 'grok',
      result: 'done with sk-result-secret-1234567890',
      error: { code: 'provider_failed', message: 'boom sk-error-secret-1234567890' },
      prompt: 'do not leak sk-prompt-secret-1234567890',
    },
    state: 'failed',
    summary: {
      message: 'provider failed with sk-summary-secret-1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9.secret',
    },
    view: 'summary',
    progress: { wait_reason: 'current', event_cursor: '12' },
  };
  const legacy = buildToolResult(payload);
  const result = buildToolResult(payload, { responseMode: RESPONSE_MODE_STRUCTURED });
  for (const serialized of [JSON.stringify(legacy), JSON.stringify(result)]) {
    for (const secret of [
      'sk-result-secret-1234567890',
      'sk-error-secret-1234567890',
      'sk-prompt-secret-1234567890',
      'sk-summary-secret-1234567890',
      'eyJhbGciOiJIUzI1NiJ9.secret',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
  }
  assert.equal(legacy.content[0].text, JSON.stringify(legacy.structuredContent));
  assert.match(result.content[0].text, /\[REDACTED\]/u);
  assert.equal(Object.hasOwn(result.structuredContent.task, 'prompt'), false);
  const fallback = JSON.parse(result.content[0].text);
  assert.equal(fallback.summary.kind, 'task');
  assert.match(fallback.summary.message, /\[REDACTED\]/u);
});

test('text fallback hard-cap still returns required non-empty valid JSON/UTF-8 content', () => {
  const huge = {
    tasks: Array.from({ length: 200 }, (_, index) => ({
      id: `task-${index}`,
      status: 'running',
      state: 'running',
      provider: 'grok',
      note: 'x'.repeat(512),
    })),
  };
  const requested = 180;
  const effective = resolveTextFallbackMaxBytes(requested);
  const text = buildTextFallback(huge, { maxBytes: requested });
  assert.ok(text.length > 0);
  assert.ok(Buffer.byteLength(text, 'utf8') <= effective);
  const parsed = JSON.parse(text);
  assert.equal(parsed.authoritative, 'structuredContent');
  assert.equal(parsed.receipt_in_text, false);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.text_max_bytes, effective);
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text);
});

test('sanitized efficiency fixtures contain no raw prompt or credential material', () => {
  for (const taskCount of TASK_COUNTS) {
    const payloads = publicPayloads(taskCount);
    const serialized = JSON.stringify(payloads);
    assert.doesNotMatch(serialized, /\/home\/|\/mnt\//u);
    assert.doesNotMatch(serialized, /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/iu);
    assert.doesNotMatch(serialized, /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/iu);
    assert.doesNotMatch(serialized, /\bcrsr_[A-Za-z0-9_-]{8,}\b/iu);
    assert.doesNotMatch(serialized, /\bBearer\s+[A-Za-z0-9._~+\/=-]+/iu);
    assert.doesNotMatch(serialized, /"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|password|secret|credential|private[_-]?key)"\s*:/iu);
    assert.doesNotMatch(serialized, /"prompt"\s*:/iu);
    assert.doesNotMatch(serialized, /"prompt_sha256"\s*:/iu);
    assert.equal(serialized.includes('provider_process_group'), false);
    for (const task of payloads.tasks.tasks) {
      assert.equal(Object.hasOwn(task, 'prompt'), false);
      assert.equal(Object.hasOwn(task, 'prompt_sha256'), false);
    }
  }
});

async function measureWait(taskCount) {
  const root = await mkdtemp(path.join(tmpdir(), `co-engineer-efficiency-${taskCount}-`));
  const taskId = `wait-${taskCount}`;
  let clock = 0;
  let delayCalls = 0;
  try {
    for (let index = 0; index < taskCount; index += 1) {
      await createTask({
        root,
        prompt: 'sanitized efficiency fixture',
        record: {
          id: index === 0 ? taskId : `${taskId}-${index}`,
          status: 'running',
          provider: 'grok',
        },
      });
    }
    const waited = await waitForTaskProgress(root, taskId, {
      wait_ms: WAIT_DURATION_MS,
      now: () => clock,
      watch: () => ({ close() {} }),
      delay: async (milliseconds) => {
        delayCalls += 1;
        clock += milliseconds;
        return 'timeout';
      },
      fallback_ms: WAIT_DURATION_MS,
    });
    return {
      wait_duration_ms: waited.progress.waited_ms,
      wait_reason: waited.progress.wait_reason,
      call_count: delayCalls,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('efficiency harness preserves 3.1.1 duplication_baseline and measures structured opt-in reduction', async () => {
  assert.deepEqual(RECORDED_BASELINE.task_counts, TASK_COUNTS);
  assert.equal(RECORDED_BASELINE.baseline_version, BASELINE_VERSION);
  assert.equal(RECORDED_BASELINE.structured_transport_version, STRUCTURED_TRANSPORT_VERSION);
  assert.equal(RECORDED_BASELINE.call_count, 6);
  assert.equal(RECORDED_BASELINE.wait_call_count, 1);
  assert.equal(RECORDED_BASELINE.wait_duration_ms, WAIT_DURATION_MS);
  assert.equal(RECORDED_BASELINE.wait_reason, 'timeout');
  assert.deepEqual(
    RECORDED_BASELINE.duplication_baseline,
    IMMUTABLE_DUPLICATION_BASELINE,
    '3.1.1 duplication_baseline must remain immutable',
  );

  const measurements = [];
  for (const taskCount of TASK_COUNTS) {
    const legacyMeasured = measureFixture(taskCount, { responseMode: null });
    const measured = measureFixture(taskCount, { responseMode: RESPONSE_MODE_STRUCTURED });
    const wait = await measureWait(taskCount);
    assert.equal(measured.wait_duration_ms, WAIT_DURATION_MS);
    assert.equal(measured.call_count, 6);
    assert.equal(wait.wait_duration_ms, WAIT_DURATION_MS);
    assert.equal(wait.wait_reason, 'timeout');
    assert.equal(wait.call_count, 1);

    const legacyCurrent = Object.fromEntries(Object.entries(legacyMeasured.responses).map(([name, metrics]) => [name, {
      text_content_bytes: metrics.text_content_bytes,
      structured_content_bytes: metrics.structured_content_bytes,
      jsonrpc_bytes: metrics.jsonrpc_bytes,
    }]));
    assert.deepEqual(
      legacyCurrent,
      RECORDED_BASELINE.duplication_baseline[String(taskCount)],
      `default/omitted mode must match immutable 3.1.1 duplication_baseline for ${taskCount} tasks`,
    );

    const current = Object.fromEntries(Object.entries(measured.responses).map(([name, metrics]) => [name, {
      text_content_bytes: metrics.text_content_bytes,
      structured_content_bytes: metrics.structured_content_bytes,
      jsonrpc_bytes: metrics.jsonrpc_bytes,
    }]));
    assert.deepEqual(
      current,
      RECORDED_BASELINE.responses[String(taskCount)],
      `structured opt-in byte baseline changed for ${taskCount} tasks`,
    );

    const duplication = RECORDED_BASELINE.duplication_baseline[String(taskCount)];
    let totalBefore = 0;
    let totalAfter = 0;
    for (const [name, metrics] of Object.entries(current)) {
      const before = duplication[name];
      assert.equal(metrics.structured_content_bytes, before.structured_content_bytes, `${name} structured payload changed`);
      assert.ok(metrics.text_content_bytes < before.text_content_bytes, `${name} text must shrink vs 3.1.1 duplication`);
      assert.ok(metrics.jsonrpc_bytes < before.jsonrpc_bytes, `${name} JSON-RPC must shrink vs 3.1.1 duplication`);
      assert.ok(
        metrics.text_content_bytes < metrics.structured_content_bytes,
        `${name} text must stay smaller than authoritative structuredContent`,
      );
      totalBefore += before.jsonrpc_bytes;
      totalAfter += metrics.jsonrpc_bytes;
    }
    const savedRatio = (totalBefore - totalAfter) / totalBefore;
    assert.ok(savedRatio >= 0.30, `${taskCount}-task aggregate JSON-RPC reduction ${savedRatio} below 30%`);
    // Timing is observational only; no robust bound is enforced.
    assert.ok(Number.isFinite(measured.response_construction_ms));
    assert.ok(measured.response_construction_ms >= 0);
    measurements.push({
      ...measured,
      wait,
      jsonrpc_bytes_before: totalBefore,
      jsonrpc_bytes_after: totalAfter,
      jsonrpc_bytes_saved: totalBefore - totalAfter,
      jsonrpc_reduction_ratio: savedRatio,
    });
  }
  process.stdout.write(`${JSON.stringify({
    baseline_version: BASELINE_VERSION,
    structured_transport_version: STRUCTURED_TRANSPORT_VERSION,
    measurements,
  })}\n`);
});
