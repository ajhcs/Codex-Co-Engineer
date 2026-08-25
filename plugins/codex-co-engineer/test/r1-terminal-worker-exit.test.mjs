// Worker-exit seam: close retained ACP resources, bound WTB handoff, emit
// terminal stdout only after close evidence, then exit. Reconstructs both
// live-cgroup terminal-receipt incidents without touching systemd or WTB.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACP_RESOURCE_CLOSE_MS,
  WTB_HANDOFF_MS,
  WORKER_EXIT_MS,
  WORKER_CLEANUP_CODES,
  boundedWtbHandoff,
  closeRetainedAcpResources,
  composeWorkerCleanup,
  emitWorkerTerminalStdout,
  persistWorkerTerminal,
  requestWorkerExit,
  runAcpTask,
  runAcpWorkerCli,
  workerSeamIncident,
} from '../mcp/v3/acp-worker.mjs';
import { createTask, readTask, writeRuntimeRecord } from '../mcp/v3/task-store.mjs';
import {
  INCIDENT_1,
  INCIDENT_2,
  hangingPromise,
  hangingRuntime,
  incidentReceipt,
} from './fixtures/r1-terminal-worker-exit-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');

async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-worker-exit-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  const taskId = extra.id ?? 'task-1';
  await createTask({
    root,
    prompt: extra.prompt ?? 'review this repository',
    record: {
      id: taskId,
      status: extra.status ?? 'accepted',
      provider: extra.provider ?? 'grok',
      cwd,
      agent_argv: extra.agentArgv ?? [process.execPath, FAKE_AGENT, '--mode', extra.mode ?? 'normal'],
      timeout_ms: extra.timeoutMs ?? 5_000,
    },
  });
  return { root, cwd, taskId };
}

test('bounds are the frozen Wave26A worker-exit timeouts', () => {
  assert.equal(ACP_RESOURCE_CLOSE_MS, 3_000);
  assert.equal(WTB_HANDOFF_MS, 5_000);
  assert.equal(WORKER_EXIT_MS, 1_000);
});

test('incident 1 and 2 receipts are live-worker hazards at the worker seam', () => {
  const first = incidentReceipt(INCIDENT_1);
  const second = incidentReceipt(INCIDENT_2);
  assert.equal(workerSeamIncident(first), true);
  assert.equal(workerSeamIncident(second), true);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.ok(first.finished_at);
  assert.ok(second.finished_at);
});

test('incident receipts cannot emit terminal stdout without close evidence', () => {
  const writes = [];
  for (const incident of [INCIDENT_1, INCIDENT_2]) {
    assert.throws(
      () => emitWorkerTerminalStdout(incidentReceipt(incident), (chunk) => writes.push(chunk)),
      (error) => error.code === WORKER_CLEANUP_CODES.CLEANUP_FAILED,
    );
  }
  assert.equal(writes.length, 0);
});

test('close then persist then stdout is the required worker-seam order', async () => {
  const value = await fixture({ id: 'order-1' });
  const closeCalls = [];
  const runtime = hangingRuntime(async (input) => { closeCalls.push(input); });
  const closeEvidence = await closeRetainedAcpResources({
    runtime,
    handle: { sessionKey: 'order-1' },
  });
  assert.equal(closeEvidence.acp_close, 'closed');
  assert.equal(closeCalls[0].discardPersistentState, false);
  assert.equal(closeCalls[0].reason, 'worker_exit');
  const terminal = await persistWorkerTerminal(value.root, value.taskId, {
    status: 'completed',
    result: 'ok',
  }, closeEvidence, { wtb_handoff: 'not_applicable' });
  assert.equal(workerSeamIncident(terminal), false);
  assert.equal(terminal.cleanup.status, 'pending');
  assert.equal(terminal.cleanup.acp_close, 'closed');
  const writes = [];
  emitWorkerTerminalStdout(terminal, (chunk) => writes.push(chunk));
  assert.deepEqual(JSON.parse(writes[0]), { task_id: value.taskId, status: 'completed' });
});

test('ACP success records cleanup.pending after retained-resource close', async () => {
  const value = await fixture({ id: 'acp-success-cleanup' });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.cleanup.status, 'pending');
  assert.equal(terminal.cleanup.acp_close, 'closed');
  assert.equal(terminal.cleanup.wtb_handoff, 'not_applicable');
  assert.equal(workerSeamIncident(terminal), false);
  assert.equal(terminal.prompt_dispatched, true);
  assert.equal(terminal.fallback_safe, false);
});

test('provider failure still closes, stays non-replayable, and records cleanup', async () => {
  const value = await fixture({ prompt: 'provider-failure', id: 'acp-fail-cleanup' });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.cleanup.status, 'pending');
  assert.equal(terminal.prompt_dispatched, true);
  assert.equal(terminal.fallback_safe, false);
  assert.equal(workerSeamIncident(terminal), false);
});

test('bounded WTB handoff records the payload while the worker still owns the task', async () => {
  const value = await fixture({ id: 'wtb-recorded' });
  await persistWorkerTerminal(value.root, value.taskId, { status: 'completed' }, {
    acp_close: 'closed',
    codes: [],
  }, { wtb_handoff: 'not_applicable' });
  const handoff = { branch: 'codex/example', head: '9e4d3cbdb1175f92da9979a7125e29e43b9aa699' };
  const result = await boundedWtbHandoff({
    root: value.root,
    taskId: value.taskId,
    env: { WORKTREE_BOOTSTRAP_TASK: 'example-task' },
    cwd: value.cwd,
    runFileImpl: async () => ({ stdout: JSON.stringify(handoff) }),
  });
  assert.equal(result.wtb_handoff, 'recorded');
  assert.equal(result.task.handoff.head, handoff.head);
  assert.equal(result.task.cleanup.wtb_handoff, 'recorded');
  assert.equal(result.task.cleanup.status, 'pending');
});

test('CLI emits stdout only after close and handoff evidence, then exits', async () => {
  const value = await fixture({ id: 'cli-stdout' });
  await writeRuntimeRecord(value.root, value.taskId, { pid: process.pid });
  const requestPath = path.join(value.root, 'tasks', value.taskId, 'worker-request.json');
  await writeFile(requestPath, `${JSON.stringify({ root: value.root, task_id: value.taskId })}\n`);
  const writes = [];
  const exits = [];
  const handoffCalls = [];
  await runAcpWorkerCli(['--request', requestPath], {
    env: { WORKTREE_BOOTSTRAP_TASK: 'cli-stdout' },
    cwd: value.cwd,
    runFileImpl: async () => ({ stdout: '{}' }),
    handoffImpl: async (input) => {
      handoffCalls.push(input);
      const current = (await readTask(value.root, value.taskId)).task;
      assert.equal(current.cleanup.status, 'pending');
      return {
        attempted: true,
        wtb_handoff: 'recorded',
        task: { ...current, cleanup: { ...current.cleanup, wtb_handoff: 'recorded' } },
      };
    },
    stdoutWrite: (chunk) => writes.push(chunk),
    stderrWrite() {},
    exit: (code) => exits.push(code),
  });
  assert.equal(handoffCalls.length, 1);
  assert.equal(exits[0], 0);
  assert.deepEqual(JSON.parse(writes[0]), { task_id: value.taskId, status: 'completed' });
});

test('worker exit is requested immediately and again within the 1s bound', () => {
  const exits = [];
  requestWorkerExit(0, {
    exitMs: 25,
    exit: (code) => exits.push(code),
  });
  assert.deepEqual(exits, [0]);
});

test('composeWorkerCleanup never enables replay and stays on pending', () => {
  const cleanup = composeWorkerCleanup(
    { acp_close: 'timeout', codes: [WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT] },
    { wtb_handoff: 'timeout' },
  );
  assert.equal(cleanup.status, 'pending');
  assert.equal(cleanup.code, WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
  assert.equal(cleanup.wtb_handoff, 'timeout');
});
