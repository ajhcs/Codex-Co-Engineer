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
    description: 'Delegate a review or implementation task to Grok, Cursor Local, or DSH. Implementation tasks receive a managed worktree and branch.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
        provider: { type: 'string', enum: ['grok', 'cursor-local', 'cursor-cloud', 'dsh'] },
        repo: { type: 'string', description: 'Absolute Git worktree root.' },
        prompt: { type: 'string', minLength: 1, maxLength: 262144 },
        role: { type: 'string', enum: ['review', 'implement'], default: 'implement' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 86400000 },
        create_pr: { type: 'boolean', default: false },
        starting_ref: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['task_id', 'provider', 'repo', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'task',
    description: 'Inspect one task receipt and its local worker identity.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' } },
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
    description: 'Cancel one owned local task and its process group.',
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
  const { agent_argv: _agentArgv, ...receipt } = task;
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
  if (name === 'status') return result(await supervisorStatus(root));
  if (name === 'delegate') {
    const value = await submitTask(args, { root });
    return result({ task: publicTask(value.task), runtime: value.runtime });
  }
  if (name === 'task') {
    const value = await taskStatus(root, args.task_id);
    return result({ task: publicTask(value.task), runtime: value.runtime });
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
        serverInfo: { name: 'codex-co-engineer', title: 'Codex-Co-Engineer', version: '3.0.0' },
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
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message).catch((error) => {
    if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message ?? 'Internal error' } });
  });
});
