import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAcpTask } from '../plugins/codex-co-engineer/mcp/v3/acp-worker.mjs';
import { nextDeadlineExtension } from '../plugins/codex-co-engineer/mcp/v3/deadline.mjs';
import { createTask, readTask, updateTask } from '../plugins/codex-co-engineer/mcp/v3/task-store.mjs';

async function writeDeadlineAgent(root, behavior) {
  const agentPath = path.join(root, `deadline-agent-${behavior}.mjs`);
  await writeFile(agentPath, `import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const behavior = ${JSON.stringify(behavior)};
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
function response(id, result) { send({ jsonrpc: '2.0', id, result }); }
const pending = new Map();
async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    return response(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'session/new') return response(id, { sessionId: 'deadline-session-' + behavior });
  if (method === 'session/close') {
    await writeFile(join(process.cwd(), '.acpx-fake-close.json'), JSON.stringify(params) + '\\n');
    return response(id, {});
  }
  if (method === 'session/cancel') {
    for (const [promptId, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      response(promptId, { stopReason: 'cancelled' });
      pending.delete(promptId);
    }
    return;
  }
  if (method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'partial-before-timeout' },
        },
      },
    });
    if (behavior === 'extend-complete') {
      const timer = setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '+done-after-extend' },
            },
          },
        });
        response(id, { stopReason: 'end_turn' });
        pending.delete(id);
      }, 1_500);
      pending.set(id, { timer });
      return;
    }
    if (behavior === 'slow-cooperative') {
      const timer = setTimeout(() => {
        response(id, { stopReason: 'end_turn' });
        pending.delete(id);
      }, 8_000);
      pending.set(id, { timer });
      return;
    }
    pending.set(id, { timer: null });
    return;
  }
}
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  handle(JSON.parse(trimmed)).catch((error) => {
    process.stderr.write(String(error) + '\\n');
  });
});
`);
  return agentPath;
}

test('deadline extension is audited and refuses a silent roll after expiry', () => {
  const task = {
    status: 'running',
    expected_duration_ms: 1000,
    timeout_ms: 1200,
    deadline_at: new Date(1_200).toISOString(),
    deadline_source: 'margin',
    deadline_extensions: [],
  };
  const extended = nextDeadlineExtension(task, {
    expected_duration_ms: 3000,
    reason: 'provider still making progress on tests',
    now: 200,
  });
  assert.equal(extended.deadline_source, 'extended');
  assert.equal(extended.timeout_ms, 3600);
  assert.equal(Date.parse(extended.deadline_at), 3800);
  assert.equal(extended.deadline_extensions.length, 1);

  assert.throws(
    () => nextDeadlineExtension(task, { expected_duration_ms: 5000, reason: 'too late', now: 3800 }),
    (error) => error.code === 'deadline_expired',
  );
  assert.throws(
    () => nextDeadlineExtension(task, { expected_duration_ms: 5000, now: 300 }),
    (error) => error.code === 'invalid_extend_reason',
  );
  assert.throws(
    () => nextDeadlineExtension({ ...task, deadline_at: new Date(3800).toISOString() }, {
      expected_duration_ms: 1000,
      reason: 'would shrink the recorded deadline',
      now: 300,
    }),
    (error) => error.code === 'deadline_not_extended',
  );
});

test('an in-flight turn is governed by the extended deadline, not the original inner timer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ce-qual-deadline-extend-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  const agent = await writeDeadlineAgent(root, 'extend-complete');
  const now = Date.now();
  const taskId = 'deadline-extend-complete';
  await createTask({
    root,
    prompt: 'finish after extension',
    record: {
      id: taskId,
      status: 'accepted',
      provider: 'grok',
      cwd,
      agent_argv: [process.execPath, agent],
      timeout_ms: 700,
      deadline_at: new Date(now + 700).toISOString(),
    },
  });
  setTimeout(() => {
    updateTask(root, taskId, {
      deadline_at: new Date(Date.now() + 2_500).toISOString(),
      timeout_ms: 2_500,
      deadline_source: 'extended',
      deadline_extensions: [{ reason: 'provider still making progress', at: new Date().toISOString() }],
    }).catch(() => {});
  }, 250);
  const terminal = await runAcpTask({ root, taskId });
  assert.equal(terminal.status, 'completed');
  assert.equal(String(terminal.result).includes('done-after-extend'), true);
});

test('timeout after partial output is not promoted to a completed end_turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ce-qual-deadline-partial-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  const agent = await writeDeadlineAgent(root, 'partial-hostile');
  const now = Date.now();
  const taskId = 'deadline-extend-expire';
  await createTask({
    root,
    prompt: 'expire at the new deadline',
    record: {
      id: taskId,
      status: 'accepted',
      provider: 'grok',
      cwd,
      agent_argv: [process.execPath, agent],
      timeout_ms: 500,
      deadline_at: new Date(now + 500).toISOString(),
    },
  });
  setTimeout(() => {
    updateTask(root, taskId, {
      deadline_at: new Date(Date.now() + 800).toISOString(),
      timeout_ms: 800,
      deadline_source: 'extended',
    }).catch(() => {});
  }, 200);
  const started = Date.now();
  await assert.rejects(
    runAcpTask({ root, taskId }),
    (error) => error.code === 'timeout',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 700, `expected expiry near the extended deadline, got ${elapsed}ms`);
  assert.ok(elapsed < 2_500, `deadline watch should not wait on the original fixed turn timer drain (${elapsed}ms)`);
  const { task } = await readTask(root, taskId);
  assert.equal(task.status, 'timeout');
  assert.notEqual(task.status, 'completed');
  const events = await readFile(path.join(root, 'tasks', taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /partial-before-timeout/u);
  assert.doesNotMatch(events, /"status":"completed"/u);
});

test('concurrent turns keep independent cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ce-qual-deadline-concurrent-'));
  const cwdA = path.join(root, 'worktree-a');
  const cwdB = path.join(root, 'worktree-b');
  await mkdir(cwdA);
  await mkdir(cwdB);
  const agentA = await writeDeadlineAgent(root, 'slow-cooperative');
  const agentBDir = path.join(root, 'b-agent');
  await mkdir(agentBDir);
  const agentB = await writeDeadlineAgent(agentBDir, 'slow-cooperative');
  await createTask({
    root,
    prompt: 'turn A',
    record: {
      id: 'turn-a',
      status: 'accepted',
      provider: 'grok',
      cwd: cwdA,
      agent_argv: [process.execPath, agentA],
      timeout_ms: 8_000,
      deadline_at: new Date(Date.now() + 8_000).toISOString(),
    },
  });
  await createTask({
    root,
    prompt: 'turn B',
    record: {
      id: 'turn-b',
      status: 'accepted',
      provider: 'grok',
      cwd: cwdB,
      agent_argv: [process.execPath, agentB],
      timeout_ms: 8_000,
      deadline_at: new Date(Date.now() + 8_000).toISOString(),
    },
  });
  const abortA = new AbortController();
  const abortB = new AbortController();
  const runningA = runAcpTask({ root, taskId: 'turn-a', signal: abortA.signal });
  const runningB = runAcpTask({ root, taskId: 'turn-b', signal: abortB.signal });
  await new Promise((resolve) => setTimeout(resolve, 250));
  abortA.abort();
  await assert.rejects(runningA, (error) => error.code === 'cancelled');
  const { task: taskB } = await readTask(root, 'turn-b');
  assert.notEqual(taskB.status, 'cancelled');
  abortB.abort();
  try {
    await runningB;
  } catch {
    // Turn B may still be running; abort is cleanup, not the assertion.
  }
});

test('a pre-aborted signal cancels', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ce-qual-deadline-preabort-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  const agent = await writeDeadlineAgent(root, 'slow-cooperative');
  await createTask({
    root,
    prompt: 'already cancelled',
    record: {
      id: 'pre-abort',
      status: 'accepted',
      provider: 'grok',
      cwd,
      agent_argv: [process.execPath, agent],
      timeout_ms: 5_000,
      deadline_at: new Date(Date.now() + 5_000).toISOString(),
    },
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runAcpTask({ root, taskId: 'pre-abort', signal: abort.signal }),
    (error) => error.code === 'cancelled',
  );
});
