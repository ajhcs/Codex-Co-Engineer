// Supervisor result truthfulness — focused and adversarial coverage of the
// terminal-receipt classifier. Stored task.v1 bytes are compared, not rewritten.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { denyWorkerRemoteMutation } from '../mcp/v3/credential-boundary.mjs';
import { publicState } from '../mcp/v3/contract.mjs';
import { COMPACT_VIEW } from '../mcp/v3/compact-task.mjs';
import {
  SUPERVISOR_FALSE_SUCCESS_REASON,
  SUPERVISOR_UNANSWERABLE_ATTENTION_REASON,
  cancelTask,
  classifySupervisorTerminalReceipt,
  projectSupervisorPublicState,
  projectSupervisorTaskRecords,
  projectSupervisorTerminalReceipt,
  supervisorStatus,
  taskStatus,
} from '../mcp/v3/supervisor.mjs';
import { TASK_SCHEMA, createTask, listTasks, listTasksPage, readTask, taskPaths } from '../mcp/v3/task-store.mjs';
import {
  observedUnsupportedQuestionReceipt,
  quotedUnsupportedQuestionInSuccessfulResultReceipt,
} from './fixtures/r1-grok-attention-bridge-fixtures.mjs';
import {
  AUTHORITATIVE_PING_TIMEOUT,
  COMPACT_CARD_KEYS,
  COMPACT_OMITTED_TASKS_KEYS,
  CONTENT_FREE,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_URL,
  LEGACY_STATUS_KEYS,
  PUBLIC_STATE_VOCABULARY,
  STORED_STATUS_VOCABULARY,
  TASKS_LIST_KEYS,
  TASKS_PAGED_KEYS,
  TASK_STATUS_KEYS,
  WAIT_ANY_ENTRY_KEYS,
  WAIT_ANY_KEYS,
  countingProxy,
  envelopeOnlyCompletedReceipt,
  legitimateCancelledReceipt,
  legitimateCompletedReceipt,
  legitimateEnvironmentBlockedReceipt,
  legitimateFailedReceipt,
  legitimateTimeoutReceipt,
  legitimateTransportLostReceipt,
  quotedPingInSuccessfulResultReceipt,
  readyBoundary,
  readyProviderReadiness,
  structuredWholeResultErrorReceipt,
  terminalReceipt,
  throwingGetterReceipt,
  wholeResultPingTimeoutReceipt,
  zeroWorkPingTimeoutReceipt,
} from './fixtures/r1-supervisor-result-truthfulness-fixtures.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3', 'server.mjs');

function assertContentFreeReason(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(AUTHORITATIVE_PING_TIMEOUT), false);
  assert.equal(text.includes('RetriableError'), false);
  assert.equal(text.includes('PING timed out'), false);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes(HOSTILE_PATH), false);
  assert.equal(text.includes(HOSTILE_URL), false);
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

function assertVocabulary(status, state) {
  if (status != null) assert.equal(STORED_STATUS_VOCABULARY.includes(status), true, status);
  if (state != null) assert.equal(PUBLIC_STATE_VOCABULARY.includes(state), true, state);
}

function assertNotSucceeded(state) {
  assert.notEqual(state, 'succeeded');
}

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-rtruth-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function storeReceipt(root, receipt, prompt = 'keep this prompt private') {
  const { task, paths } = await createTask({
    root,
    prompt,
    record: receipt,
  });
  const stored = await readFile(paths.record, 'utf8');
  return { task, paths, stored };
}

async function statusOf(root) {
  return supervisorStatus(root, {
    probeBoundary: async () => readyBoundary(),
    readProviderReadiness: async () => readyProviderReadiness(),
  });
}

async function withServerAt(root, fn) {
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...process.env,
      CODEX_CO_ENGINEER_STATE_DIR: root,
      CODEX_CO_ENGINEER_GROK_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_CURSOR_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_ACPX_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_ACP_COMMAND: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const nextValue = () => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  });
  lines.on('line', (line) => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(JSON.parse(line));
  });
  child.once('error', (error) => {
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`MCP server exited (${code ?? signal}): ${stderr}`);
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  const request = async (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return nextValue();
  };
  try {
    return await fn({ request });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    lines.close();
  }
}

test('authoritative zero-work PING timeout cannot project state=succeeded', () => {
  const receipt = zeroWorkPingTimeoutReceipt();
  const classified = classifySupervisorTerminalReceipt(receipt);
  assert.equal(classified.stored_status, 'completed');
  assert.equal(classified.projected_status, 'failed');
  assert.equal(classified.public_state, 'failed');
  assert.equal(classified.corrected, true);
  assert.equal(classified.reason, SUPERVISOR_FALSE_SUCCESS_REASON.code);
  assert.equal(projectSupervisorPublicState(receipt), 'failed');
  assert.notEqual(publicState(receipt.status), 'failed');
  assert.equal(publicState(classified.projected_status), 'failed');
  assertContentFreeReason(classified.error);
  assertContentFreeReason(classified.reason);
  assertVocabulary(classified.projected_status, classified.public_state);
  const projected = projectSupervisorTerminalReceipt(receipt);
  assert.equal(projected.status, 'failed');
  assert.equal(projected.error.code, SUPERVISOR_FALSE_SUCCESS_REASON.code);
  assert.equal(receipt.status, 'completed');
  assertNotSucceeded(projectSupervisorPublicState(receipt));
});

test('explicit whole-result terminal transport error cannot project succeeded', () => {
  for (const receipt of [
    wholeResultPingTimeoutReceipt(),
    structuredWholeResultErrorReceipt(),
    envelopeOnlyCompletedReceipt(),
    terminalReceipt({
      id: 'nested-result-error',
      result: { error: { code: 'unavailable', message: AUTHORITATIVE_PING_TIMEOUT } },
      error: null,
    }),
  ]) {
    const classified = classifySupervisorTerminalReceipt(receipt);
    assert.equal(classified.corrected, true, receipt.id);
    assert.equal(classified.public_state, 'failed', receipt.id);
    assertNotSucceeded(classified.public_state);
    assertContentFreeReason(classified.error);
  }
});

test('succeeded is only for completed receipts without a terminal error', () => {
  const clean = legitimateCompletedReceipt();
  const classified = classifySupervisorTerminalReceipt(clean);
  assert.equal(classified.corrected, false);
  assert.equal(classified.projected_status, 'completed');
  assert.equal(classified.public_state, 'succeeded');
  assert.equal(classified.reason, null);
  assert.equal(projectSupervisorTerminalReceipt(clean), clean);

  const quoted = quotedPingInSuccessfulResultReceipt();
  const quotedClassified = classifySupervisorTerminalReceipt(quoted);
  assert.equal(quotedClassified.corrected, false);
  assert.equal(quotedClassified.public_state, 'succeeded');
});

test('structured Grok unsupported-question completed receipt is never succeeded', () => {
  const receipt = observedUnsupportedQuestionReceipt();
  const classified = classifySupervisorTerminalReceipt(receipt);
  assert.equal(classified.corrected, true);
  assert.equal(classified.projected_status, 'failed');
  assert.equal(classified.public_state, 'failed');
  assert.equal(classified.reason, SUPERVISOR_UNANSWERABLE_ATTENTION_REASON.code);
  assertContentFreeReason(classified.error);
  assertNotSucceeded(classified.public_state);
  const quoted = quotedUnsupportedQuestionInSuccessfulResultReceipt();
  const quotedClassified = classifySupervisorTerminalReceipt(quoted);
  assert.equal(quotedClassified.corrected, false);
  assert.equal(quotedClassified.public_state, 'succeeded');
});

test('transport_lost remains nonterminal reconciliation uncertainty', () => {
  const receipt = terminalReceipt({
    id: 'rtruth-transport-lost',
    status: 'transport_lost',
    error: { code: 'worker_not_running', message: 'Recorded worker is not running.' },
    result: AUTHORITATIVE_PING_TIMEOUT,
  });
  const classified = classifySupervisorTerminalReceipt(receipt);
  assert.equal(classified.corrected, false);
  assert.equal(classified.stored_status, 'transport_lost');
  assert.equal(classified.projected_status, 'transport_lost');
  assert.equal(classified.public_state, 'transport_lost');
  assert.equal(projectSupervisorTerminalReceipt(receipt), receipt);
});

test('exact stored and public vocabularies pass through without correction', () => {
  const storedToPublic = {
    completed: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
    timeout: 'timed_out',
    environment_blocked: 'environment_blocked',
    transport_lost: 'transport_lost',
    needs_attention: 'needs_attention',
    accepted: 'accepted',
    starting: 'starting',
    running: 'running',
    cancelling: 'cancelling',
  };
  for (const status of STORED_STATUS_VOCABULARY) {
    const classified = classifySupervisorTerminalReceipt(terminalReceipt({
      id: `vocab-${status}`,
      status,
      result: status === 'completed' ? 'ok' : null,
      error: status === 'completed' ? null : { code: status, message: 'bounded' },
    }));
    assert.equal(classified.projected_status, status);
    assert.equal(classified.public_state, storedToPublic[status]);
    assert.equal(classified.corrected, false);
    assertVocabulary(classified.projected_status, classified.public_state);
  }
  for (const state of PUBLIC_STATE_VOCABULARY) {
    assert.equal(PUBLIC_STATE_VOCABULARY.includes(state), true);
  }
});

test('status, task, tasks, and cancel share the classifier without rewriting stored bytes', async () => {
  await withRoot(async (root) => {
    const { paths, stored } = await storeReceipt(root, zeroWorkPingTimeoutReceipt({
      cwd: root,
    }));
    assert.match(stored, /"schema": "codex-co-engineer.task.v1"/u);
    assert.match(stored, /"status": "completed"/u);

    const inspected = await taskStatus(root, 'rtruth-ping-timeout');
    assert.deepEqual(Object.keys(inspected).filter((key) => key !== 'diagnostics'), [...TASK_STATUS_KEYS]);
    assert.equal(inspected.state, 'failed');
    assert.equal(inspected.task.status, 'failed');
    assert.equal(inspected.task.error.code, SUPERVISOR_FALSE_SUCCESS_REASON.code);
    assert.equal(inspected.summary.state, 'failed');
    assert.equal(inspected.diagnostic.state, 'failed');
    assertContentFreeReason(inspected.task.error);
    assertContentFreeReason(inspected.diagnostic.message);
    assertNotSucceeded(inspected.state);

    const compact = await taskStatus(root, 'rtruth-ping-timeout', { view: COMPACT_VIEW });
    assert.equal(compact.view, COMPACT_VIEW);
    assert.equal(compact.state, 'failed');
    assert.equal(compact.status, 'failed');
    assertNotSucceeded(compact.state);

    const status = await statusOf(root);
    assert.deepEqual(Object.keys(status), [...LEGACY_STATUS_KEYS]);
    assert.equal(status.tasks.length, 1);
    assert.equal(status.tasks[0].status, 'failed');
    assert.equal(status.tasks[0].error.code, SUPERVISOR_FALSE_SUCCESS_REASON.code);

    const listed = projectSupervisorTaskRecords(await listTasks(root));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'failed');
    assert.equal(listed[0].error.code, SUPERVISOR_FALSE_SUCCESS_REASON.code);

    const cancelled = await cancelTask(root, 'rtruth-ping-timeout');
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.error.code, SUPERVISOR_FALSE_SUCCESS_REASON.code);
    assertNotSucceeded(projectSupervisorPublicState(cancelled));

    const after = await readFile(paths.record, 'utf8');
    assert.equal(after, stored);
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.status, 'completed');
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.schema, TASK_SCHEMA);
    assert.equal(paths.record, taskPaths(root, 'rtruth-ping-timeout').record);
  });
});

test('whole-result PING timeout is failed across supervisor surfaces and leaves bytes unchanged', async () => {
  await withRoot(async (root) => {
    const { stored } = await storeReceipt(root, wholeResultPingTimeoutReceipt({
      id: 'rtruth-whole-result-ping',
      cwd: root,
    }));
    const inspected = await taskStatus(root, 'rtruth-whole-result-ping');
    assert.equal(inspected.state, 'failed');
    assert.equal(inspected.task.status, 'failed');
    const status = await statusOf(root);
    assert.equal(status.tasks[0].status, 'failed');
    const listed = projectSupervisorTaskRecords(await listTasks(root));
    assert.equal(listed[0].status, 'failed');
    const cancelled = await cancelTask(root, 'rtruth-whole-result-ping');
    assert.equal(cancelled.status, 'failed');
    assert.equal((await readTask(root, 'rtruth-whole-result-ping')).task.status, 'completed');
    assert.equal(await readFile(taskPaths(root, 'rtruth-whole-result-ping').record, 'utf8'), stored);
  });
});

test('legitimate completed receipts still project succeeded', async () => {
  await withRoot(async (root) => {
    await storeReceipt(root, legitimateCompletedReceipt({ cwd: root }));
    const inspected = await taskStatus(root, 'rtruth-legitimate-completed');
    assert.equal(inspected.state, 'succeeded');
    assert.equal(inspected.task.status, 'completed');
    const status = await statusOf(root);
    assert.equal(status.tasks[0].status, 'completed');
    const cancelled = await cancelTask(root, 'rtruth-legitimate-completed');
    assert.equal(cancelled.status, 'completed');
    assert.equal((await readTask(root, 'rtruth-legitimate-completed')).task.status, 'completed');
  });
});

test('legacy omitted-mode status and compact include_tasks=false shapes are preserved', async () => {
  await withRoot(async (root) => {
    await storeReceipt(root, legitimateCompletedReceipt({ id: 'shape-one', cwd: root }));
    await storeReceipt(root, zeroWorkPingTimeoutReceipt({ id: 'shape-two', cwd: root }));
    const legacy = await statusOf(root);
    assert.deepEqual(Object.keys(legacy), [...LEGACY_STATUS_KEYS]);
    assert.equal('detail' in legacy, false);
    assert.equal('task_count' in legacy, false);
    assert.equal('include_tasks' in legacy, false);
    assert.equal(legacy.tasks.length, 2);

    const omitted = await supervisorStatus(root, {
      probeBoundary: async () => readyBoundary(),
      readProviderReadiness: async () => readyProviderReadiness(),
    }, {
      detail: 'compact',
      include_tasks: false,
    });
    assert.deepEqual(Object.keys(omitted).sort(), [...COMPACT_OMITTED_TASKS_KEYS].sort());
    assert.equal(omitted.detail, 'compact');
    assert.equal(omitted.include_tasks, false);
    assert.equal(omitted.task_limit, 0);
    assert.equal(omitted.returned_tasks, 0);
    assert.deepEqual(omitted.tasks, []);
    assert.equal(omitted.task_count, 2);
  });
});

test('compact status cards use classified state for false-success receipts', async () => {
  await withRoot(async (root) => {
    await storeReceipt(root, zeroWorkPingTimeoutReceipt({ cwd: root }));
    const compact = await supervisorStatus(root, {
      probeBoundary: async () => readyBoundary(),
      readProviderReadiness: async () => readyProviderReadiness(),
    }, {
      detail: 'compact',
      include_tasks: true,
      task_limit: 20,
    });
    assert.equal(compact.detail, 'compact');
    assert.equal(compact.tasks.length, 1);
    assert.equal(compact.tasks[0].state, 'failed');
    assertNotSucceeded(compact.tasks[0].state);
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.status, 'completed');
  });
});

test('hostile accessors cannot force a completed receipt to succeeded', () => {
  const throwingError = throwingGetterReceipt('error', { result: AUTHORITATIVE_PING_TIMEOUT });
  const classifiedError = classifySupervisorTerminalReceipt(throwingError);
  assert.equal(classifiedError.public_state, 'failed');
  assertContentFreeReason(classifiedError.error);

  const throwingResult = throwingGetterReceipt('result', {
    result: AUTHORITATIVE_PING_TIMEOUT,
    error: null,
  });
  const classifiedResult = classifySupervisorTerminalReceipt(throwingResult);
  assert.equal(classifiedResult.public_state, 'failed');

  const throwingStatus = throwingGetterReceipt('status');
  const classifiedStatus = classifySupervisorTerminalReceipt(throwingStatus);
  assert.notEqual(classifiedStatus.public_state, 'succeeded');

  const { proxy, counts } = countingProxy(zeroWorkPingTimeoutReceipt());
  const classifiedProxy = classifySupervisorTerminalReceipt(proxy);
  assert.equal(classifiedProxy.public_state, 'failed');
  assert.equal(counts.apply, 0);
  assert.ok(counts.get > 0);
});

test('classifier ignores non-receipt values and does not invent succeeded', () => {
  for (const value of [null, undefined, 1, 'completed', true, false, [], Object.create(null)]) {
    const classified = classifySupervisorTerminalReceipt(value);
    assert.equal(classified.corrected, false);
    assert.notEqual(classified.public_state, 'succeeded');
  }
  assert.equal(projectSupervisorTaskRecords(null).length, 0);
  assert.equal(projectSupervisorTaskRecords(undefined).length, 0);
  assert.deepEqual(projectSupervisorTaskRecords([legitimateCompletedReceipt()]).map((task) => task.status), ['completed']);
});

test('stored succeeded with a terminal error is also corrected to failed', () => {
  const receipt = zeroWorkPingTimeoutReceipt({ status: 'succeeded' });
  const classified = classifySupervisorTerminalReceipt(receipt);
  assert.equal(classified.stored_status, 'succeeded');
  assert.equal(classified.projected_status, 'failed');
  assert.equal(classified.public_state, 'failed');
});

test('empty error objects and oversized transcripts do not false-fail', () => {
  const emptyError = classifySupervisorTerminalReceipt(terminalReceipt({
    id: 'empty-error',
    error: {},
    result: 'implemented',
  }));
  assert.equal(emptyError.public_state, 'succeeded');

  const okCode = classifySupervisorTerminalReceipt(terminalReceipt({
    id: 'ok-error',
    error: { code: 'ok', message: 'ok' },
    result: 'implemented',
  }));
  assert.equal(okCode.public_state, 'succeeded');

  const longTranscript = classifySupervisorTerminalReceipt(terminalReceipt({
    id: 'long-transcript',
    error: null,
    result: `${'x'.repeat(300)} PING timed out`,
  }));
  assert.equal(longTranscript.public_state, 'succeeded');
});

test('classifier is pure, content-free, and does not mutate remotes', () => {
  assert.throws(() => denyWorkerRemoteMutation('push'), (error) => error.code === 'remote_mutation_denied');
  assert.throws(() => denyWorkerRemoteMutation('create_pr'), (error) => error.code === 'remote_mutation_denied');
  const classified = classifySupervisorTerminalReceipt(zeroWorkPingTimeoutReceipt());
  assert.equal(Object.isFrozen(classified), true);
  assert.equal(Object.isFrozen(classified.error), true);
  assertContentFreeReason(classified);
  assertContentFreeReason(SUPERVISOR_FALSE_SUCCESS_REASON);
  const json = JSON.stringify(classified);
  assert.equal(json.includes('git@'), false);
  assert.equal(json.includes('push'), false);
  assert.equal(json.includes(HOSTILE_SECRET), false);
});

test('server tasks list, paged full/compact, and wait-any cannot project PING-timeout as succeeded', async () => {
  await withRoot(async (root) => {
    const { paths, stored } = await storeReceipt(root, zeroWorkPingTimeoutReceipt({ cwd: root }));
    await storeReceipt(root, legitimateCompletedReceipt({ cwd: root }));
    await withServerAt(root, async ({ request }) => {
      const catalog = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.deepEqual(catalog.result.tools.map((tool) => tool.name), [
        'status', 'delegate', 'task', 'tasks', 'cancel',
      ]);

      const listed = (await request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'tasks', arguments: {} },
      })).result.structuredContent;
      assert.deepEqual(Object.keys(listed), [...TASKS_LIST_KEYS]);
      const pingListed = listed.tasks.find((task) => task.id === 'rtruth-ping-timeout');
      const legitListed = listed.tasks.find((task) => task.id === 'rtruth-legitimate-completed');
      assert.equal(pingListed.status, 'failed');
      assert.equal(pingListed.state, 'failed');
      assert.equal(pingListed.error.code, SUPERVISOR_FALSE_SUCCESS_REASON.code);
      assertNotSucceeded(pingListed.state);
      assertContentFreeReason(pingListed.error);
      assert.equal(legitListed.status, 'completed');
      assert.equal(legitListed.state, 'succeeded');

      const fullPage = (await request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { detail: 'full', limit: 20 } },
      })).result.structuredContent;
      assert.deepEqual(Object.keys(fullPage).sort(), [...TASKS_PAGED_KEYS].sort());
      assert.equal(fullPage.detail, 'full');
      const pingFull = fullPage.tasks.find((task) => task.id === 'rtruth-ping-timeout');
      const legitFull = fullPage.tasks.find((task) => task.id === 'rtruth-legitimate-completed');
      assert.equal(pingFull.state, 'failed');
      assert.equal(pingFull.status, 'failed');
      assertNotSucceeded(pingFull.state);
      assert.equal(legitFull.state, 'succeeded');

      const compactPage = (await request({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { detail: 'compact', limit: 20 } },
      })).result.structuredContent;
      assert.deepEqual(Object.keys(compactPage).sort(), [...TASKS_PAGED_KEYS].sort());
      assert.equal(compactPage.detail, 'compact');
      for (const card of compactPage.tasks) {
        assert.deepEqual(Object.keys(card).sort(), [...COMPACT_CARD_KEYS].sort());
      }
      const pingCompact = compactPage.tasks.find((task) => task.id === 'rtruth-ping-timeout');
      const legitCompact = compactPage.tasks.find((task) => task.id === 'rtruth-legitimate-completed');
      assert.equal(pingCompact.state, 'failed');
      assertNotSucceeded(pingCompact.state);
      assert.equal(legitCompact.state, 'succeeded');

      const waitAny = (await request({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'tasks',
          arguments: {
            task_ids: ['rtruth-ping-timeout', 'rtruth-legitimate-completed'],
            wait_ms: 0,
            wait_until: 'terminal',
          },
        },
      })).result.structuredContent;
      assert.deepEqual(Object.keys(waitAny).sort(), [...WAIT_ANY_KEYS].sort());
      assert.equal(waitAny.tasks.length, 2);
      for (const entry of waitAny.tasks) {
        assert.deepEqual(Object.keys(entry).sort(), [...WAIT_ANY_ENTRY_KEYS].sort());
      }
      const pingWait = waitAny.tasks.find((entry) => entry.task_id === 'rtruth-ping-timeout');
      const legitWait = waitAny.tasks.find((entry) => entry.task_id === 'rtruth-legitimate-completed');
      assert.equal(pingWait.state, 'failed');
      assert.equal(pingWait.task.state, 'failed');
      assert.equal(pingWait.task.status, 'failed');
      assertNotSucceeded(pingWait.state);
      assertNotSucceeded(pingWait.task.state);
      assert.equal(pingWait.task.summary.error_code, SUPERVISOR_FALSE_SUCCESS_REASON.code);
      assertContentFreeReason(pingWait.task.summary.error_code);
      assertContentFreeReason(pingWait.task.diagnostic);
      assert.equal(legitWait.state, 'succeeded');
      assert.equal(legitWait.task.state, 'succeeded');
      assert.equal(legitWait.task.status, 'completed');
    });

    assert.throws(() => denyWorkerRemoteMutation('push'), (error) => error.code === 'remote_mutation_denied');
    const after = await readFile(paths.record, 'utf8');
    assert.equal(after, stored);
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.status, 'completed');
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.schema, TASK_SCHEMA);
  });
});

test('classifier-derived filter membership, totals, and page cursors exclude corrected PING-timeout from succeeded', async () => {
  await withRoot(async (root) => {
    const stamp = (second, receipt) => ({
      ...receipt,
      cwd: root,
      created_at: `2026-08-20T00:00:0${second}.000Z`,
      updated_at: `2026-08-20T00:00:0${second}.000Z`,
    });
    const { paths, stored } = await storeReceipt(root, zeroWorkPingTimeoutReceipt(stamp(5, {})));
    await storeReceipt(root, legitimateCompletedReceipt(stamp(4, { id: 'rtruth-legit-b' })));
    await storeReceipt(root, legitimateFailedReceipt(stamp(3, {})));
    await storeReceipt(root, legitimateCompletedReceipt(stamp(2, { id: 'rtruth-legit-a' })));
    await storeReceipt(root, legitimateCancelledReceipt(stamp(1, {})));
    await storeReceipt(root, legitimateTimeoutReceipt(stamp(0, {})));
    await storeReceipt(root, legitimateEnvironmentBlockedReceipt(stamp(6, {})));
    await storeReceipt(root, legitimateTransportLostReceipt(stamp(7, {})));

    const omitted = await listTasksPage(root, {});
    assert.equal(omitted.total, 8);
    assert.equal(omitted.tasks.some((task) => task.id === 'rtruth-ping-timeout'), true);
    assert.equal(omitted.tasks.find((task) => task.id === 'rtruth-ping-timeout').status, 'completed');

    const succeeded = await listTasksPage(root, { state: 'succeeded', limit: 1, detail: 'full' });
    assert.deepEqual(succeeded.tasks.map((task) => task.id), ['rtruth-legit-b']);
    assert.equal(succeeded.total, 2);
    assert.equal(succeeded.has_more, true);
    assert.equal(succeeded.tasks.some((task) => task.id === 'rtruth-ping-timeout'), false);
    const succeededPage2 = await listTasksPage(root, {
      state: 'succeeded',
      limit: 1,
      detail: 'full',
      cursor: succeeded.next_cursor,
    });
    assert.deepEqual(succeededPage2.tasks.map((task) => task.id), ['rtruth-legit-a']);
    assert.equal(succeededPage2.total, 2);
    assert.equal(succeededPage2.has_more, false);
    assert.equal(succeededPage2.next_cursor, null);

    const failed = await listTasksPage(root, { state: 'failed', limit: 1, detail: 'compact' });
    assert.deepEqual(failed.tasks.map((task) => task.id), ['rtruth-ping-timeout']);
    assert.equal(failed.total, 2);
    assert.equal(failed.has_more, true);
    assert.equal(failed.tasks[0].status, 'completed');
    const failedPage2 = await listTasksPage(root, {
      state: 'failed',
      limit: 1,
      detail: 'compact',
      cursor: failed.next_cursor,
    });
    assert.deepEqual(failedPage2.tasks.map((task) => task.id), ['rtruth-legitimate-failed']);
    assert.equal(failedPage2.total, 2);
    assert.equal(failedPage2.has_more, false);

    await withServerAt(root, async ({ request }) => {
      const succeededPage = (await request({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { detail: 'full', state: 'succeeded', limit: 1 } },
      })).result.structuredContent;
      assert.deepEqual(Object.keys(succeededPage).sort(), [...TASKS_PAGED_KEYS].sort());
      assert.deepEqual(succeededPage.tasks.map((task) => task.id), ['rtruth-legit-b']);
      assert.equal(succeededPage.tasks[0].state, 'succeeded');
      assert.equal(succeededPage.total, 2);
      assert.equal(succeededPage.has_more, true);
      assert.equal(succeededPage.tasks.some((task) => task.id === 'rtruth-ping-timeout'), false);

      const failedPage = (await request({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { detail: 'compact', state: 'failed', limit: 20 } },
      })).result.structuredContent;
      assert.deepEqual(Object.keys(failedPage).sort(), [...TASKS_PAGED_KEYS].sort());
      for (const card of failedPage.tasks) {
        assert.deepEqual(Object.keys(card).sort(), [...COMPACT_CARD_KEYS].sort());
      }
      assert.deepEqual(failedPage.tasks.map((task) => task.id), [
        'rtruth-ping-timeout',
        'rtruth-legitimate-failed',
      ]);
      assert.equal(failedPage.tasks[0].state, 'failed');
      assertNotSucceeded(failedPage.tasks[0].state);
      assert.equal(failedPage.total, 2);
      assert.equal(failedPage.has_more, false);

      const cancelledPage = (await request({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { state: 'cancelled' } },
      })).result.structuredContent;
      assert.deepEqual(cancelledPage.tasks.map((task) => task.id), ['rtruth-legitimate-cancelled']);
      const timedOutPage = (await request({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { state: 'timed_out' } },
      })).result.structuredContent;
      assert.deepEqual(timedOutPage.tasks.map((task) => task.id), ['rtruth-legitimate-timeout']);
      const blockedPage = (await request({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { state: 'environment_blocked' } },
      })).result.structuredContent;
      assert.deepEqual(blockedPage.tasks.map((task) => task.id), ['rtruth-legitimate-environment-blocked']);
      const lostPage = (await request({
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: { name: 'tasks', arguments: { state: 'transport_lost' } },
      })).result.structuredContent;
      assert.deepEqual(lostPage.tasks.map((task) => task.id), ['rtruth-legitimate-transport-lost']);
    });

    assert.throws(() => denyWorkerRemoteMutation('push'), (error) => error.code === 'remote_mutation_denied');
    assert.throws(() => denyWorkerRemoteMutation('create_pr'), (error) => error.code === 'remote_mutation_denied');
    const after = await readFile(paths.record, 'utf8');
    assert.equal(after, stored);
    assert.match(after, /"schema": "codex-co-engineer.task.v1"/u);
    assert.match(after, /"status": "completed"/u);
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.status, 'completed');
    assert.equal((await readTask(root, 'rtruth-ping-timeout')).task.schema, TASK_SCHEMA);
  });
});
