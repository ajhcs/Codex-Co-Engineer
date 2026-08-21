import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readFileSync } from 'node:fs';
import {
  WAIT_ANY_PROGRESS_DETAIL_HINT,
  WAIT_ANY_PROGRESS_EVENT_BYTES_MAX,
  WAIT_ANY_PROGRESS_STRUCTURED_BYTES_MAX,
  WAIT_ANY_RESPONSE_STRUCTURED_BYTES_MAX,
  WAIT_ANY_TASK_STRUCTURED_BYTES_MAX,
} from '../mcp/v3/compact-task.mjs';
import { appendTaskEvent, createTask, writeRuntimeRecord } from '../mcp/v3/task-store.mjs';

function currentRuntime() {
  const proc = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return {
    pid: process.pid,
    process_group: process.pid,
    process_start_ticks: proc.slice(proc.lastIndexOf(')') + 2).trim().split(/\s+/u)[19],
  };
}

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3', 'server.mjs');

async function withServer(callback, environment = process.env) {
  const state = await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-server-'));
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...environment,
      CODEX_CO_ENGINEER_STATE_DIR: state,
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
  const notify = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  try {
    return await callback({ state, request, notify });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    lines.close();
    await rm(state, { recursive: true, force: true });
  }
}

async function conversation(messages, environment = process.env) {
  return withServer(async ({ request }) => {
    const values = [];
    for (const message of messages) values.push(await request(message));
    return values;
  }, environment);
}

test('advertises only the thin public tool surface', async () => {
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert.equal(values[0].result.serverInfo.name, 'codex-co-engineer');
  assert.equal(values[0].result.serverInfo.title, 'Codex-Co-Engineer');
  assert.equal(values[0].result.serverInfo.version, '3.2.1');
  assert.deepEqual(values[1].result.tools.map((tool) => tool.name), ['status', 'delegate', 'task', 'tasks', 'cancel']);
  const statusTool = values[1].result.tools.find((tool) => tool.name === 'status');
  assert.deepEqual(Object.keys(statusTool.inputSchema.properties), [
    'detail', 'task_limit', 'include_tasks', 'response_mode',
  ]);
  const taskTool = values[1].result.tools.find((tool) => tool.name === 'task');
  assert.deepEqual(Object.keys(taskTool.inputSchema.properties), [
    'task_id', 'wait_ms', 'wait_until', 'wake_on_needs_attention', 'view', 'cursor', 'max_bytes',
    'extend_expected_duration_ms', 'extend_reason', 'reply', 'response_mode',
  ]);
  assert.equal(taskTool.inputSchema.properties.wait_ms.maximum, 14400000);
  assert.equal(taskTool.inputSchema.properties.wait_until.enum[1], 'terminal');
  assert.deepEqual(taskTool.inputSchema.properties.response_mode.enum, ['structured']);
  const tasksTool = values[1].result.tools.find((tool) => tool.name === 'tasks');
  assert.deepEqual(Object.keys(tasksTool.inputSchema.properties), [
    'detail', 'limit', 'cursor', 'provider', 'state', 'status', 'response_mode',
    'task_ids', 'cursors', 'wait_ms', 'wait_until', 'wake_on_needs_attention',
  ]);
  for (const tool of values[1].result.tools) {
    assert.deepEqual(tool.inputSchema.properties.response_mode.enum, ['structured']);
    assert.match(tool.description, /response_mode="structured"/u);
  }
  const delegateTool = values[1].result.tools.find((tool) => tool.name === 'delegate');
  assert.match(delegateTool.description, /property named repo/u);
  assert.deepEqual(delegateTool.inputSchema.required, ['task_id', 'provider', 'repo', 'prompt']);
  assert.match(delegateTool.inputSchema.properties.repo.description, /Required property named repo/u);
  assert.match(delegateTool.inputSchema.properties.repo.description, /\/absolute\/path\/to\/git-worktree/u);
  assert.match(delegateTool.inputSchema.properties.repo.description, /Do not rename this property to git_root/u);
  assert.match(delegateTool.inputSchema.properties.starting_ref.description, /Cursor Cloud only/u);
  assert.match(delegateTool.inputSchema.properties.starting_ref.description, /does not replace the required repo/u);
  assert.deepEqual(delegateTool.inputSchema.properties.dsh_model.enum, [
    'muse-spark-1.2-contributor',
    'stealth/ox-alpha',
  ]);
  assert.match(delegateTool.inputSchema.properties.dsh_model.description, /DSH only/u);
  assert.equal(Object.hasOwn(delegateTool.inputSchema.properties, 'git_root'), false);
  assert.ok(Object.hasOwn(delegateTool.inputSchema.properties, 'expected_duration_ms'));
  assert.equal(delegateTool.inputSchema.properties.expected_duration_ms.maximum, 86400000);
  assert.equal(delegateTool.inputSchema.properties.timeout_ms.maximum, 103680000);
  assert.deepEqual(delegateTool.inputSchema.anyOf, [
    { required: ['expected_duration_ms'] },
    { required: ['timeout_ms'] },
  ]);
  assert.match(taskTool.description, /event_cursor/u);
  assert.match(taskTool.description, /Unsolicited stdio callbacks/u);
  assert.match(taskTool.description, /view=compact/u);
  assert.deepEqual(taskTool.inputSchema.properties.view.enum, ['summary', 'diagnostics', 'compact']);
  assert.equal(tasksTool.inputSchema.properties.task_ids.minItems, 1);
  assert.equal(tasksTool.inputSchema.properties.task_ids.maxItems, 8);
  assert.equal(tasksTool.inputSchema.properties.wait_ms.maximum, 14400000);
  assert.deepEqual(tasksTool.inputSchema.properties.wait_until.enum, ['progress', 'terminal']);
  assert.equal(tasksTool.inputSchema.allOf[0].then.required[0], 'task_ids');
});

test('task returns a compact live snapshot and can wait for the next event', async () => {
  await withServer(async ({ state, request }) => {
    await createTask({
      root: state,
      prompt: 'do not return this prompt',
      record: {
        id: 'server-wait',
        status: 'running',
        provider: 'grok',
        agent_argv: ['grok', 'agent'],
      },
    });
    await appendTaskEvent(state, 'server-wait', {
      type: 'provider',
      event: { type: 'text_delta', text: 'first-visible', pid: 12, argv: ['secret-argv'] },
    });
    const immediate = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'task', arguments: { task_id: 'server-wait' } },
    });
    const first = immediate.result.structuredContent;
    assert.equal(first.task.last_event.text, 'first-visible');
    assert.equal(first.task.agent_argv, undefined);
    assert.equal(first.progress.last_event.pid, undefined);
    assert.equal(first.progress.wait_reason, 'current');
    assert.doesNotMatch(JSON.stringify(first), /do not return this prompt|secret-argv/u);

    const pending = request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'task',
        arguments: { task_id: 'server-wait', wait_ms: 1000, cursor: first.progress.event_cursor },
      },
    });
    setTimeout(() => {
      appendTaskEvent(state, 'server-wait', {
        type: 'provider',
        event: { type: 'tool_call', title: 'read', text: 'second-visible' },
      }).catch(() => {});
    }, 20);
    const waited = (await pending).result.structuredContent;
    assert.equal(waited.progress.wait_reason, 'progress');
    assert.equal(waited.progress.last_event.text, 'second-visible');
    assert.ok(waited.progress.event_cursor !== first.progress.event_cursor);

    const invalid = await request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'task', arguments: { task_id: 'server-wait', cursor: 'nope' } },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.structuredContent.error.code, 'invalid_event_cursor');
  });
});

test('cancelling a pending task wait does not terminate provider work', async () => {
  await withServer(async ({ state, request, notify }) => {
    await createTask({
      root: state,
      prompt: 'keep running',
      record: { id: 'server-disconnect', status: 'running', provider: 'grok' },
    });
    await writeRuntimeRecord(state, 'server-disconnect', currentRuntime());
    const pending = request({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'task', arguments: { task_id: 'server-disconnect', wait_until: 'terminal', wait_ms: 2000 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    notify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7 },
    });
    const disconnected = await pending;
    assert.equal(disconnected.result.structuredContent.progress.wait_reason, 'disconnected');
    assert.equal(disconnected.result.structuredContent.task.status, 'running');
    assert.equal(disconnected.result.structuredContent.state, 'running');
  });
});

test('tasks wait-any keeps the five-tool catalog and returns safe compact snapshots', async () => {
  await withServer(async ({ state, request }) => {
    await createTask({ root: state, prompt: 'one', record: { id: 'server-any-a', status: 'running', provider: 'grok' } });
    await createTask({
      root: state,
      prompt: 'two',
      record: {
        id: 'server-any-b',
        status: 'running',
        provider: 'grok',
        last_event: { type: 'status', text: 'stale-task-json-event' },
      },
    });
    const baseline = await request({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'tasks', arguments: { task_ids: ['server-any-a', 'server-any-b'], wait_ms: 0 } },
    });
    const cursors = Object.fromEntries(baseline.result.structuredContent.tasks
      .map((entry) => [entry.task_id, entry.progress.event_cursor]));
    const pending = request({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'tasks',
        arguments: {
          task_ids: ['server-any-a', 'server-any-b'],
          cursors,
          wait_until: 'progress',
          wait_ms: 1_000,
        },
      },
    });
    setTimeout(() => appendTaskEvent(state, 'server-any-b', {
      type: 'provider',
      event: { type: 'tool_call', text: 'server-any-progress' },
    }).catch(() => {}), 20);
    const waited = (await pending).result.structuredContent;
    assert.equal(waited.wait_reason, 'progress');
    assert.equal(waited.triggered_task_id, 'server-any-b');
    assert.equal(waited.tasks.length, 2);
    const updated = waited.tasks.find((entry) => entry.task_id === 'server-any-b');
    assert.equal(updated.progress.last_event.text, 'server-any-progress');
    assert.equal(updated.task.view, 'compact');
    assert.equal(updated.task.task_id, 'server-any-b');
    assert.equal(updated.task.last_event, undefined);
    assert.equal(updated.task.id, undefined);
    assert.equal(updated.task.agent_argv, undefined);
    assert.equal(updated.progress.detail_hint, WAIT_ANY_PROGRESS_DETAIL_HINT);
    assert.doesNotMatch(JSON.stringify(updated.task), /stale-task-json-event|server-any-progress/u);
    assert.ok(Buffer.byteLength(JSON.stringify(updated.task), 'utf8') <= WAIT_ANY_TASK_STRUCTURED_BYTES_MAX);
    assert.ok(Buffer.byteLength(JSON.stringify(updated.progress.last_event), 'utf8') <= WAIT_ANY_PROGRESS_EVENT_BYTES_MAX);
    assert.ok(Buffer.byteLength(JSON.stringify(updated.progress), 'utf8') <= WAIT_ANY_PROGRESS_STRUCTURED_BYTES_MAX);

    const invalidArgs = await request({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'tasks', arguments: { wait_ms: 0 } },
    });
    assert.equal(invalidArgs.result.isError, true);
    assert.equal(invalidArgs.result.structuredContent.error.code, 'invalid_task_ids');
    assert.match(invalidArgs.result.structuredContent.error.message, /task_ids/u);

    const mixedModes = await request({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'tasks',
        arguments: { task_ids: ['server-any-a'], wait_ms: 0, detail: 'compact' },
      },
    });
    assert.equal(mixedModes.result.isError, true);
    assert.equal(mixedModes.result.structuredContent.error.code, 'invalid_tasks_mode');
    assert.match(mixedModes.result.structuredContent.error.message, /cannot be combined/u);

    const missing = await request({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'tasks', arguments: { task_ids: ['does-not-exist'], wait_ms: 0 } },
    });
    const serialized = JSON.stringify(missing);
    assert.equal(missing.result.structuredContent.wait_reason, 'task_not_found');
    assert.doesNotMatch(serialized, /ENOENT|\/tmp\/|task\.json/u);
  });
});

test('wait-any bounds eight live events, compact snapshots, and the canonical response', async () => {
  await withServer(async ({ state, request }) => {
    const taskIds = Array.from({ length: 8 }, (_, index) => `server-any-live-${index}`);
    const eventSecret = 'sk-event-secret-1234567890';
    const eventText = `${'A'.repeat(3_800)} ${eventSecret} LIVE-END`;
    for (const [index, id] of taskIds.entries()) {
      await createTask({
        root: state,
        prompt: `live wait-any task ${index}`,
        record: {
          id,
          status: 'running',
          provider: 'grok',
          agent_argv: ['grok', '--private-arg'],
        },
      });
      await appendTaskEvent(state, id, {
        type: 'provider',
        event: {
          type: 'tool_call',
          at: new Date().toISOString(),
          state: 'running',
          status: 'running',
          reason: 'live event includes a bounded diagnostic preview',
          text: eventText,
          apiKey: eventSecret,
        },
      });
    }

    const response = await request({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: {
        name: 'tasks',
        arguments: { task_ids: taskIds, wait_until: 'progress', wait_ms: 0, response_mode: 'structured' },
      },
    });
    const value = response.result.structuredContent;
    assert.equal(value.tasks.length, 8);
    for (const entry of value.tasks) {
      assert.equal(entry.task.view, 'compact');
      assert.equal(entry.task.task_id, entry.task_id);
      assert.equal(entry.progress.detail_hint, WAIT_ANY_PROGRESS_DETAIL_HINT);
      assert.equal(entry.progress.last_event.type, 'tool_call');
      assert.equal(entry.progress.last_event.state, 'running');
      assert.equal(entry.progress.last_event.status, 'running');
      assert.equal(entry.progress.last_event.text.endsWith('LIVE-END'), true);
      assert.match(entry.progress.last_event.text, /\[REDACTED\]/u);
      assert.ok(Buffer.byteLength(JSON.stringify(entry.task), 'utf8') <= WAIT_ANY_TASK_STRUCTURED_BYTES_MAX);
      assert.ok(Buffer.byteLength(JSON.stringify(entry.progress.last_event), 'utf8') <= WAIT_ANY_PROGRESS_EVENT_BYTES_MAX);
      assert.ok(Buffer.byteLength(JSON.stringify(entry.progress), 'utf8') <= WAIT_ANY_PROGRESS_STRUCTURED_BYTES_MAX);
      assert.doesNotMatch(JSON.stringify(entry.task), /private-arg|"prompt"|source_repo|worktree_path|agent_argv/u);
    }
    const aggregateBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    assert.ok(aggregateBytes <= WAIT_ANY_RESPONSE_STRUCTURED_BYTES_MAX, `wait-any aggregate was ${aggregateBytes} bytes`);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(eventSecret, 'u'));
    assert.doesNotMatch(JSON.stringify(response), /apiKey|private-arg/u);
  });
});

test('status works without starting a daemon or provider', async () => {
  const [value] = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ]);
  assert.equal(
    value.result.structuredContent.healthy,
    value.result.structuredContent.local_boundary.ready,
  );
  assert.equal(value.result.structuredContent.active, 0);
});

test('public MCP receipts redact secrets from result, errors, handoff, and events', async () => {
  await withServer(async ({ state, request }) => {
    const secrets = [
      'sk-result-secret-1234567890',
      'sk-error-secret-1234567890',
      'xai-provider-secret-99999999',
      'sk-handoff-secret-1234567890',
      'sk-nested-secret-1234567890',
      'sk-event-secret-1234567890',
    ];
    await createTask({
      root: state,
      prompt: 'do not leak sk-prompt-secret-1234567890',
      record: {
        id: 'server-secrets',
        status: 'completed',
        provider: 'grok',
        prompt_dispatched: true,
        result: `done with ${secrets[0]}`,
        error: { code: 'provider_failed', message: `boom ${secrets[1]}` },
        provider_error: { message: `provider ${secrets[2]}`, apiKey: secrets[2] },
        handoff: {
          head: 'a'.repeat(40),
          validation: {
            output: `failed ${secrets[3]}`,
            apiKey: secrets[4],
            nested: { note: secrets[3] },
          },
        },
      },
    });
    await appendTaskEvent(state, 'server-secrets', {
      type: 'provider',
      event: { type: 'tool_call', title: 'read', text: `chunk ${secrets[5]}`, apiKey: secrets[5] },
    });
    const calls = [
      { name: 'status', arguments: {} },
      { name: 'task', arguments: { task_id: 'server-secrets' } },
      { name: 'task', arguments: { task_id: 'server-secrets', view: 'diagnostics' } },
      { name: 'tasks', arguments: {} },
      { name: 'cancel', arguments: { task_id: 'server-secrets' } },
    ];
    for (const [index, call] of calls.entries()) {
      const response = await request({
        jsonrpc: '2.0',
        id: 20 + index,
        method: 'tools/call',
        params: call,
      });
      const serialized = JSON.stringify(response);
      for (const secret of [...secrets, 'sk-prompt-secret-1234567890']) {
        assert.doesNotMatch(serialized, new RegExp(secret, 'u'), `${call.name} leaked ${secret}`);
      }
      assert.equal(response.result.content[0].type, 'text');
      assert.equal(
        response.result.content[0].text,
        JSON.stringify(response.result.structuredContent),
        `${call.name} default text must duplicate sanitized structuredContent`,
      );
      if (call.name === 'task') {
        assert.equal(response.result.structuredContent.task.result.includes('[REDACTED]'), true);
        assert.equal(response.result.structuredContent.task.prompt_dispatched, true);
        assert.equal(Object.hasOwn(response.result.structuredContent.task, 'prompt'), false);
      }
    }
    const compact = await request({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'task', arguments: { task_id: 'server-secrets', view: 'compact' } },
    });
    const compactBody = compact.result.structuredContent;
    assert.equal(compactBody.view, 'compact');
    assert.equal(Object.hasOwn(compactBody, 'task'), false);
    assert.equal(Object.hasOwn(compactBody, 'runtime'), false);
    assert.equal(compactBody.prompt_dispatched, true);
    const compactText = JSON.stringify(compact);
    for (const secret of [...secrets, 'sk-prompt-secret-1234567890']) {
      assert.doesNotMatch(compactText, new RegExp(secret, 'u'), `compact leaked ${secret}`);
    }
  });
});

test('live MCP tool results use structured-first text fallback when response_mode is structured', async () => {
  await withServer(async ({ state, request }) => {
    await createTask({
      root: state,
      prompt: 'structured transport prompt',
      record: { id: 'structured-live', status: 'running', provider: 'grok' },
    });
    const toolsList = await request({ jsonrpc: '2.0', id: 39, method: 'tools/list' });
    for (const tool of toolsList.result.tools) {
      assert.equal(tool.inputSchema.properties.response_mode.enum[0], 'structured');
      assert.match(tool.description, /response_mode="structured"/u);
    }
    for (const [index, call] of [
      { name: 'status', arguments: { response_mode: 'structured' } },
      { name: 'task', arguments: { task_id: 'structured-live', response_mode: 'structured' } },
      { name: 'tasks', arguments: { response_mode: 'structured' } },
      { name: 'cancel', arguments: { task_id: 'structured-live', response_mode: 'structured' } },
    ].entries()) {
      const response = await request({
        jsonrpc: '2.0',
        id: 40 + index,
        method: 'tools/call',
        params: call,
      });
      assert.deepEqual(Object.keys(response.result).sort(), ['content', 'structuredContent'].sort());
      assert.equal(response.result.content.length, 1);
      assert.equal(response.result.content[0].type, 'text');
      assert.ok(response.result.content[0].text.length > 0);
      const fallback = JSON.parse(response.result.content[0].text);
      assert.equal(fallback.schema, 'co_engineer.mcp_text_fallback.v1');
      assert.equal(fallback.authoritative, 'structuredContent');
      assert.equal(fallback.receipt_in_text, false);
      assert.equal(typeof response.result.structuredContent, 'object');
      assert.notEqual(response.result.content[0].text, JSON.stringify(response.result.structuredContent));
    }

    const legacy = await request({
      jsonrpc: '2.0',
      id: 50,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    });
    assert.equal(
      legacy.result.content[0].text,
      JSON.stringify(legacy.result.structuredContent),
      'omitted response_mode must preserve full text duplication',
    );
  });
});

test('status fails local providers closed when the MCP environment lacks the user-bus locator', async () => {
  const environment = { ...process.env };
  delete environment.XDG_RUNTIME_DIR;
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  const [value] = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ], environment);
  const status = value.result.structuredContent;
  assert.equal(status.healthy, false);
  assert.equal(status.local_boundary.ready, false);
  for (const provider of ['grok', 'cursor-local', 'dsh']) assert.equal(status.readiness[provider].ready, false);
});
