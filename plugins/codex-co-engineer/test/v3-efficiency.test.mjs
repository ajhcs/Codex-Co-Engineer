import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VERSION } from '../mcp/v3/contract.mjs';
import { createTask, waitForTaskProgress } from '../mcp/v3/task-store.mjs';
import {
  BASELINE_VERSION,
  STATUS_TASK_LIMIT,
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

function keys(value) {
  return Object.keys(value);
}

function assertResponseShape(response, name) {
  assert.deepEqual(keys(response), SHAPES.jsonrpc, `${name} JSON-RPC envelope changed`);
  assert.deepEqual(keys(response.result), SHAPES.result, `${name} MCP result changed`);
  assert.deepEqual(keys(response.result.content[0]), SHAPES.content_item, `${name} text content changed`);
  assert.equal(response.result.content[0].type, 'text');
  assert.equal(typeof response.result.content[0].text, 'string');
  assert.deepEqual(keys(response.result.structuredContent), SHAPES.responses[name], `${name} public keys changed`);
}

function assertTaskShape(task) {
  assert.deepEqual(keys(task), SHAPES.task, 'public task receipt keys changed');
  for (const key of SHAPES.forbidden_task_keys) assert.equal(Object.hasOwn(task, key), false, `raw task key leaked: ${key}`);
}

function assertTerminalTaskShape(task) {
  assert.deepEqual(keys(task), SHAPES.terminal_task, 'terminal public task receipt keys changed');
  for (const key of SHAPES.forbidden_task_keys) assert.equal(Object.hasOwn(task, key), false, `raw task key leaked: ${key}`);
}

test('3.1.1 public MCP response shapes remain backward compatible', () => {
  assert.equal(BASELINE_VERSION, SHAPES.baseline_version);
  assert.match(VERSION, /^3\.\d+\.\d+$/u, 'runtime version must remain compatible with the 3.x public contract');
  for (const taskCount of TASK_COUNTS) {
    const payloads = publicPayloads(taskCount);
    for (const [name, payload] of Object.entries(payloads)) {
      const { response } = measureResponse(payload);
      assertResponseShape(response, name);
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

test('sanitized efficiency fixtures contain no raw prompt or credential material', () => {
  for (const taskCount of TASK_COUNTS) {
    const payloads = publicPayloads(taskCount);
    const serialized = JSON.stringify(payloads);
    assert.doesNotMatch(serialized, /\/home\/|\/mnt\//u);
    assert.doesNotMatch(serialized, /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/iu);
    assert.doesNotMatch(serialized, /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/iu);
    assert.doesNotMatch(serialized, /\bcrsr_[A-Za-z0-9_-]{8,}\b/iu);
    assert.doesNotMatch(serialized, /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu);
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

test('efficiency harness records deterministic 1/20/54 task baselines', async () => {
  assert.deepEqual(RECORDED_BASELINE.task_counts, TASK_COUNTS);
  assert.equal(RECORDED_BASELINE.baseline_version, BASELINE_VERSION);
  assert.equal(RECORDED_BASELINE.call_count, 6);
  assert.equal(RECORDED_BASELINE.wait_call_count, 1);
  assert.equal(RECORDED_BASELINE.wait_duration_ms, WAIT_DURATION_MS);
  assert.equal(RECORDED_BASELINE.wait_reason, 'timeout');
  const measurements = [];
  for (const taskCount of TASK_COUNTS) {
    const measured = measureFixture(taskCount);
    const wait = await measureWait(taskCount);
    assert.equal(measured.wait_duration_ms, WAIT_DURATION_MS);
    assert.equal(measured.call_count, 6);
    assert.equal(wait.wait_duration_ms, WAIT_DURATION_MS);
    assert.equal(wait.wait_reason, 'timeout');
    assert.equal(wait.call_count, 1);
    assert.deepEqual(
      Object.fromEntries(Object.entries(measured.responses).map(([name, metrics]) => [name, {
        text_content_bytes: metrics.text_content_bytes,
        structured_content_bytes: metrics.structured_content_bytes,
        jsonrpc_bytes: metrics.jsonrpc_bytes,
      }])),
      RECORDED_BASELINE.responses[String(taskCount)],
      `3.1.1 byte baseline changed for ${taskCount} tasks`,
    );
    assert.ok(Number.isFinite(measured.response_construction_ms));
    assert.ok(measured.response_construction_ms >= 0);
    measurements.push({
      ...measured,
      wait: wait,
    });
  }
  // Keep runtime timing visible to the focused test without making it a
  // machine-dependent pass/fail threshold.
  process.stdout.write(`${JSON.stringify({ baseline_version: BASELINE_VERSION, measurements })}\n`);
});
