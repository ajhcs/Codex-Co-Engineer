// Adversarial worker-exit coverage: hanging close/handoff, hostile close
// errors, timeout/cancel/transport, and no replay after resource-close failure.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WORKER_CLEANUP_CODES,
  boundedWtbHandoff,
  closeRetainedAcpResources,
  emitWorkerTerminalStdout,
  persistWorkerTerminal,
  requestWorkerExit,
  runAcpTask,
  runAcpWorkerCli,
  workerSeamIncident,
} from '../mcp/v3/acp-worker.mjs';
import { createTask, readTask, updateTask, writeRuntimeRecord } from '../mcp/v3/task-store.mjs';
import {
  CONTENT_FREE,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_URL,
  contentFreeCleanup,
  hangingPromise,
  hangingRuntime,
  incidentReceipt,
  INCIDENT_1,
} from './fixtures/r1-terminal-worker-exit-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');

async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-worker-exit-adv-'));
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
      ...(extra.cliArgv ? { cli_argv: extra.cliArgv } : {}),
      timeout_ms: extra.timeoutMs ?? 5_000,
    },
  });
  return { root, cwd, taskId };
}

test('hanging ACP close times out at the bound and still records cleanup', async () => {
  const value = await fixture({ id: 'hanging-close' });
  const hung = hangingPromise();
  const runtime = hangingRuntime(() => hung.promise);
  const started = Date.now();
  const evidence = await closeRetainedAcpResources({
    runtime,
    handle: { sessionKey: 'hanging-close' },
    timeoutMs: 40,
  });
  const elapsed = Date.now() - started;
  hung.resolve();
  assert.equal(evidence.acp_close, 'timeout');
  assert.equal(evidence.codes[0], WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
  assert.ok(elapsed >= 40);
  assert.ok(elapsed < 400);
  const terminal = await persistWorkerTerminal(value.root, value.taskId, {
    status: 'completed',
    fallback_safe: false,
  }, evidence, { wtb_handoff: 'not_applicable' });
  assert.equal(terminal.cleanup.code, WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
  assert.equal(terminal.fallback_safe, false);
  assert.equal(workerSeamIncident(terminal), false);
});

test('throwing ACP close is failed, content-free, and never enables replay', async () => {
  const value = await fixture({ id: 'throwing-close' });
  const runtime = hangingRuntime(async () => {
    throw new Error(`provider failed for ${HOSTILE_SECRET} at ${HOSTILE_PATH} ${HOSTILE_URL}`);
  });
  const evidence = await closeRetainedAcpResources({
    runtime,
    handle: { sessionKey: 'throwing-close' },
  });
  assert.equal(evidence.acp_close, 'failed');
  assert.equal(evidence.codes[0], WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_FAILED);
  const terminal = await persistWorkerTerminal(value.root, value.taskId, {
    status: 'failed',
    error: { code: 'acp_worker_failed', message: 'ACP worker failed.' },
    fallback_safe: false,
  }, evidence, { wtb_handoff: 'not_applicable' });
  assert.equal(terminal.fallback_safe, false);
  assert.equal(contentFreeCleanup(terminal.cleanup), true);
  assert.match(terminal.cleanup.code, CONTENT_FREE);
  assert.equal(JSON.stringify(terminal.cleanup).includes(HOSTILE_SECRET), false);
  assert.equal(JSON.stringify(terminal.cleanup).includes(HOSTILE_PATH), false);
});

test('hanging WTB handoff records lock_release_unproven and still allows stdout', async () => {
  const value = await fixture({ id: 'hanging-handoff' });
  await persistWorkerTerminal(value.root, value.taskId, { status: 'completed' }, {
    acp_close: 'closed',
    codes: [],
  }, { wtb_handoff: 'not_applicable' });
  const hung = hangingPromise();
  const started = Date.now();
  const result = await boundedWtbHandoff({
    root: value.root,
    taskId: value.taskId,
    env: { WORKTREE_BOOTSTRAP_TASK: 'hanging-handoff' },
    cwd: value.cwd,
    timeoutMs: 40,
    runFileImpl: () => hung.promise,
  });
  const elapsed = Date.now() - started;
  hung.resolve({ stdout: '{}' });
  assert.equal(result.wtb_handoff, 'timeout');
  assert.equal(result.code, WORKER_CLEANUP_CODES.LOCK_RELEASE_UNPROVEN);
  assert.ok(elapsed >= 40);
  assert.ok(elapsed < 400);
  const writes = [];
  emitWorkerTerminalStdout(result.task, (chunk) => writes.push(chunk));
  assert.equal(JSON.parse(writes[0]).status, 'completed');
});

test('failed WTB handoff is cleanup_failed and content-free', async () => {
  const value = await fixture({ id: 'failed-handoff' });
  await persistWorkerTerminal(value.root, value.taskId, { status: 'completed' }, {
    acp_close: 'closed',
    codes: [],
  }, { wtb_handoff: 'not_applicable' });
  const result = await boundedWtbHandoff({
    root: value.root,
    taskId: value.taskId,
    env: { WORKTREE_BOOTSTRAP_TASK: 'failed-handoff' },
    cwd: value.cwd,
    runFileImpl: async () => {
      throw new Error(`handoff leaked ${HOSTILE_SECRET} ${HOSTILE_PATH}`);
    },
  });
  assert.equal(result.wtb_handoff, 'failed');
  assert.equal(result.code, WORKER_CLEANUP_CODES.CLEANUP_FAILED);
  assert.equal(contentFreeCleanup(result.task.cleanup), true);
  assert.equal(JSON.stringify(result.task.cleanup).includes(HOSTILE_SECRET), false);
});

test('CLI timeout of resource close still emits stdout and exits without replay', async () => {
  const value = await fixture({ id: 'cli-close-timeout' });
  await writeRuntimeRecord(value.root, value.taskId, { pid: process.pid });
  const requestPath = path.join(value.root, 'tasks', value.taskId, 'worker-request.json');
  await writeFile(requestPath, `${JSON.stringify({ root: value.root, task_id: value.taskId })}\n`);
  const writes = [];
  const exits = [];
  await runAcpWorkerCli(['--request', requestPath], {
    runAcpTaskImpl: async () => persistWorkerTerminal(value.root, value.taskId, {
      status: 'completed',
      fallback_safe: false,
    }, {
      acp_close: 'timeout',
      codes: [WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT],
    }, { wtb_handoff: 'not_applicable' }),
    handoffImpl: async () => {
      const current = (await readTask(value.root, value.taskId)).task;
      assert.equal(current.fallback_safe, false);
      assert.equal(current.cleanup.code, WORKER_CLEANUP_CODES.ACP_RESOURCE_CLOSE_TIMEOUT);
      return { attempted: false, wtb_handoff: 'not_applicable', task: current };
    },
    stdoutWrite: (chunk) => writes.push(chunk),
    stderrWrite() {},
    exit: (code) => exits.push(code),
  });
  assert.equal(exits[0], 0);
  assert.equal(JSON.parse(writes[0]).task_id, value.taskId);
  assert.equal((await readTask(value.root, value.taskId)).task.fallback_safe, false);
});

test('incident-shaped CLI success without cleanup is denied stdout', async () => {
  const value = await fixture({ id: 'incident-cli' });
  await writeRuntimeRecord(value.root, value.taskId, { pid: process.pid });
  const requestPath = path.join(value.root, 'tasks', value.taskId, 'worker-request.json');
  await writeFile(requestPath, `${JSON.stringify({ root: value.root, task_id: value.taskId })}\n`);
  const writes = [];
  const exits = [];
  await runAcpWorkerCli(['--request', requestPath], {
    runAcpTaskImpl: async () => incidentReceipt(INCIDENT_1, { id: value.taskId }),
    handoffImpl: async () => ({
      attempted: false,
      wtb_handoff: 'not_applicable',
      task: incidentReceipt(INCIDENT_1, { id: value.taskId }),
    }),
    stdoutWrite: (chunk) => writes.push(chunk),
    stderrWrite() {},
    exit: (code) => exits.push(code),
  });
  assert.equal(writes.length, 0);
  assert.equal(exits[0], 1);
});

test('timeout, cancel, and transport_lost keep their semantics and do not replay', async () => {
  const lost = await fixture({ id: 'transport-lost-exit' });
  await updateTask(lost.root, lost.taskId, { status: 'transport_lost' });
  await assert.rejects(
    runAcpTask({ root: lost.root, taskId: lost.taskId }),
    (error) => error.code === 'transport_lost',
  );
  assert.equal((await readTask(lost.root, lost.taskId)).task.status, 'transport_lost');

  const cancelled = await fixture({
    id: 'pre-aborted-exit',
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
  });
  const controller = new AbortController();
  controller.abort();
  const { runCliFallback } = await import('../mcp/v3/acp-worker.mjs');
  await assert.rejects(
    runCliFallback({
      root: cancelled.root,
      task: (await readTask(cancelled.root, cancelled.taskId)).task,
      prompt: 'private fallback prompt',
      signal: controller.signal,
    }),
    (error) => error.code === 'cancelled',
  );
  const cancelledTask = (await readTask(cancelled.root, cancelled.taskId)).task;
  assert.equal(cancelledTask.status, 'cancelled');
  assert.equal(cancelledTask.cleanup.status, 'pending');
  assert.equal(cancelledTask.fallback_safe, false);

  const timed = await fixture({ id: 'timeout-exit' });
  const timedTask = await persistWorkerTerminal(timed.root, timed.taskId, {
    status: 'timeout',
    error: { code: 'timeout', message: 'ACP task exceeded its recorded deadline.' },
    fallback_safe: false,
  }, { acp_close: 'closed', codes: [] }, { wtb_handoff: 'not_applicable' });
  assert.equal(timedTask.status, 'timeout');
  assert.equal(timedTask.cleanup.status, 'pending');
  assert.equal(timedTask.fallback_safe, false);
  assert.equal(workerSeamIncident(timedTask), false);
});

test('close timeout does not redispatch a provider prompt', async () => {
  const value = await fixture({
    id: 'no-replay-after-close',
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
  });
  const hung = hangingPromise();
  const evidence = await closeRetainedAcpResources({
    runtime: hangingRuntime(() => hung.promise),
    handle: { sessionKey: 'no-replay' },
    timeoutMs: 30,
  });
  hung.resolve();
  const terminal = await persistWorkerTerminal(value.root, value.taskId, {
    status: 'completed',
    prompt_dispatched: true,
    fallback_safe: false,
  }, evidence, { wtb_handoff: 'not_applicable' });
  assert.equal(terminal.prompt_dispatched, true);
  assert.equal(terminal.fallback_safe, false);
  assert.notEqual(terminal.result, 'SHOULD_NOT_RUN');
});

test('blocked worker exit still fires the 1s watchdog', async () => {
  const exits = [];
  let blocked = true;
  requestWorkerExit(3, {
    exitMs: 20,
    exit: (code) => {
      if (blocked) {
        blocked = false;
        return;
      }
      exits.push(code);
    },
    setTimeoutFn: (fn, ms) => {
      assert.equal(ms, 20);
      fn();
      return { unref() {} };
    },
  });
  assert.deepEqual(exits, [3]);
});
