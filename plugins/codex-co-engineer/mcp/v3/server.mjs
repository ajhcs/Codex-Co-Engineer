#!/usr/bin/env node

import readline from 'node:readline';

import { listTasks, stateRoot } from './task-store.mjs';
import { cancelTask, submitTask, supervisorStatus, taskStatus } from './supervisor.mjs';

const PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
let negotiated = '2025-11-25';

const TOOLS = [
  {
    name: 'status',
    description: 'Show the local Co-Engineer supervisor and recent task state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delegate',
    description: 'Delegate a review or implementation task to Grok, Cursor Local, Cursor Cloud, or DSH. Local tasks use a managed worktree by default; direct mode is explicit.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
        provider: { type: 'string', enum: ['grok', 'cursor-local', 'cursor-cloud', 'dsh'] },
        repo: { type: 'string', description: 'Absolute Git worktree root.' },
        prompt: { type: 'string', minLength: 1, maxLength: 262144 },
        role: { type: 'string', enum: ['review', 'implement'], default: 'implement' },
        workspace_mode: { type: 'string', enum: ['managed', 'direct'], default: 'managed' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 86400000 },
        create_pr: { type: 'boolean', default: false, description: 'Cursor Cloud only.' },
        starting_ref: { type: 'string', pattern: '^[a-fA-F0-9]{40}$', description: 'Optional immutable Cursor Cloud commit SHA.' },
      },
      required: ['task_id', 'provider', 'repo', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'task',
    description: 'Inspect one task receipt, a compact live progress snapshot, and an event_cursor. Optional wait_ms long-polls until meaningful progress or a terminal state. Unsolicited stdio callbacks across assistant turns are not available.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 60000,
          description: 'Optional bounded long-poll. Returns immediately on meaningful progress, terminal state, or timeout. 0 is a non-blocking snapshot.',
        },
        cursor: {
          type: 'string',
          pattern: '^[0-9]{1,16}$',
          description: 'Opaque event_cursor from a previous task result. Wait for events after this boundary instead of hammering empty polls.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'tasks',
    description: 'List recent task receipts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel',
    description: 'Cancel one owned local process group or Cursor Cloud run.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
];

function publicTask(task) {
  if (!task) return task;
  const {
    agent_argv: _agentArgv,
    cli_argv: _cliArgv,
    provider_process_group: _providerProcessGroup,
    provider_process_start_ticks: _providerProcessStartTicks,
    ...receipt
  } = task;
  return receipt;
}

function result(value) {
  const safe = JSON.parse(JSON.stringify(value, (_key, nested) => nested === undefined ? null : nested));
  return {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
  };
}

function errorResult(error) {
  const code = typeof error?.code === 'string' ? error.code : 'co_engineer_error';
  const message = error instanceof Error ? error.message : 'Co-Engineer request failed.';
  return { isError: true, ...result({ error: { code, message } }) };
}

async function callTool(name, args = {}) {
  const root = stateRoot();
  if (name === 'status') {
    const value = await supervisorStatus(root);
    return result({ ...value, tasks: value.tasks.map(publicTask) });
  }
  if (name === 'delegate') {
    const value = await submitTask(args, { root });
    return result({ task: publicTask(value.task), runtime: value.runtime });
  }
  if (name === 'task') {
    const value = await taskStatus(root, args.task_id, {
      cursor: args.cursor,
      wait_ms: args.wait_ms,
    });
    return result({
      task: publicTask(value.task),
      runtime: value.runtime,
      progress: value.progress,
    });
  }
  if (name === 'tasks') return result({ tasks: (await listTasks(root)).map(publicTask) });
  if (name === 'cancel') return result({ task: publicTask(await cancelTask(root, args.task_id)) });
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'unknown_tool' });
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    negotiated = PROTOCOLS.has(requested) ? requested : '2025-11-25';
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'codex-co-engineer', title: 'Codex-Co-Engineer', version: '3.0.2' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    let response;
    try {
      response = await callTool(message.params?.name, message.params?.arguments ?? {});
    } catch (error) {
      response = errorResult(error);
    }
    send({ jsonrpc: '2.0', id: message.id, result: response });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
// A newly spawned stdio server can otherwise exit before its parent has time
// to write the first JSON-RPC frame when the pipe is initially empty.
process.stdin.resume();
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message).catch((error) => {
    if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message ?? 'Internal error' } });
  });
});
