#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_SCHEMA_VERSION,
  MCP_PROTOCOL_VERSION,
  SERVER_IDENTITY,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  TARGET_SCHEMA_VERSION,
  toolSetDigest,
} from './preflight.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_HOME = process.env.HOME ?? '';
const XDG_STATE_ROOT = process.env.XDG_STATE_HOME
  ?? path.join(USER_HOME, '.local', 'state');
const STATE_DIR = path.resolve(
  process.env.CODEX_CO_ENGINEER_STATE_DIR
    ?? process.env.PLUMBOB_HARNESS_STATE_DIR
    ?? path.join(XDG_STATE_ROOT, 'codex-co-engineer'),
);
const SOCKET_FILE = path.join(STATE_DIR, 'control.sock');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');
const DAEMON = path.join(PLUGIN_ROOT, 'mcp', 'daemon.mjs');
let negotiatedProtocolVersion = MCP_PROTOCOL_VERSION;

class DaemonError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonEnvironment() {
  const names = [
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'PATH',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'MODEL_API_KEY',
    'CODEX_CO_ENGINEER_RUNTIME_WORKSPACE',
    'CODEX_CO_ENGINEER_ALLOWED_ROOTS',
    'CODEX_CO_ENGINEER_STATE_DIR',
    'CODEX_CO_ENGINEER_DAEMON_IDLE_SECONDS',
    'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE',
    'CODEX_CO_ENGINEER_ENABLE_PRIME_AGENT',
    'CODEX_CO_ENGINEER_DSH_COMMAND',
    'CODEX_CO_ENGINEER_PRIME_COMMAND',
    'CODEX_CO_ENGINEER_PRIME_AGENT_COMMAND',
    'CODEX_CO_ENGINEER_PRIME_AGENT_MODELS',
    'PLUMBOB_HARNESS_WORKSPACE',
    'PLUMBOB_HARNESS_ALLOWED_ROOTS',
    'PLUMBOB_HARNESS_STATE_DIR',
    'PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS',
    'PLUMBOB_HARNESS_MODEL_API_KEY_FILE',
    'PLUMBOB_HARNESS_ENABLE_PRIME_AGENT',
  ];
  return Object.fromEntries(
    names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
  );
}

function rawRequest(name, args = {}, timeoutMilliseconds = 62000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_FILE);
    const id = `${process.pid}-${Date.now()}`;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMilliseconds);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, name, args })}\n`);
    });
    socket.once('timeout', () => finish(new DaemonError('daemon_timeout', 'The control daemon did not respond in time.')));
    socket.once('error', (error) => finish(error));
    const input = readline.createInterface({ input: socket, crlfDelay: Infinity });
    input.on('error', () => {});
    input.once('line', (line) => {
      try {
        const response = JSON.parse(line);
        if (response.error) {
          finish(new DaemonError(response.error.code, response.error.message));
        } else {
          finish(null, response.result);
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function daemonReady() {
  try {
    await rawRequest('__ping', {}, 400);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  if (await daemonReady()) return;

  let launcher = false;
  try {
    const lock = await open(LOCK_FILE, 'wx', 0o600);
    await lock.writeFile(`${process.pid}\n`);
    await lock.close();
    launcher = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  if (launcher) {
    const logFd = openSync(DAEMON_LOG, 'a', 0o600);
    try {
      const daemon = spawn(process.execPath, ['--no-warnings', DAEMON], {
        detached: true,
        env: daemonEnvironment(),
        stdio: ['ignore', logFd, logFd],
      });
      daemon.unref();
    } finally {
      closeSync(logFd);
    }
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await daemonReady()) return;
    await sleep(100);
  }

  let lockPid = 0;
  try { lockPid = Number.parseInt(await readFile(LOCK_FILE, 'utf8'), 10); } catch {}
  if (!isAlive(lockPid)) await unlink(LOCK_FILE).catch(() => {});
  throw new DaemonError('daemon_start_failed', 'The local control daemon did not become ready.');
}

async function requestDaemon(name, args) {
  await ensureDaemon();
  return rawRequest(name, args);
}

const TARGET_CONTEXT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        schema_version: { const: TARGET_SCHEMA_VERSION },
        mode: { const: 'default' },
        allowed_paths: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: { type: 'string' },
        },
        role: { type: 'string', enum: ['review', 'verify'] },
      },
      required: ['schema_version', 'mode'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        schema_version: { const: TARGET_SCHEMA_VERSION },
        mode: { const: 'explicit' },
        working_directory: { type: 'string', description: 'Absolute target cwd; symlinks are rejected.' },
        expected_git_root: { type: 'string', description: 'Absolute Git root.' },
        expected_head: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{40}$',
          description: 'Exact 40-character Git HEAD.' ,
        },
        allowed_paths: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: { type: 'string' },
        },
        role: { type: 'string', enum: ['review', 'implement', 'verify'] },
      },
      required: [
        'schema_version',
        'mode',
        'working_directory',
        'expected_git_root',
        'expected_head',
        'allowed_paths',
        'role',
      ],
      additionalProperties: false,
    },
  ],
};

const TOOLS = [
  {
    name: 'preflight',
    description: 'Resolve and attest exactly one target/configuration before dispatch. The caller must supply expected_target_fingerprint; a mismatch is fatal.',
    inputSchema: {
      type: 'object',
      properties: {
        schema_version: { const: CONFIG_SCHEMA_VERSION },
        kind: { type: 'string', enum: ['preflight', 'deepseek_agent', 'prime_agent', 'prime_eval'], default: 'preflight' },
        request_id: { type: 'string', minLength: 8, maxLength: 128 },
        prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'Hashed for the configuration digest; never returned.' },
        autonomy: { type: 'string', enum: ['standard', 'high'], default: 'high' },
        timeout_seconds: { type: 'integer', minimum: 60, maximum: 21600, default: 3600 },
        target_context: TARGET_CONTEXT_SCHEMA,
        expected_target_fingerprint: {
          type: 'string',
          pattern: '^(sha256:)?[0-9a-fA-F]{64}$',
          description: 'Caller assertion for the resolved target fingerprint.',
        },
      },
      required: ['schema_version', 'target_context', 'expected_target_fingerprint'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'status',
    description: 'Show compact DeepSeek, Prime Agent, Prime Lab, credential, UI, and recent-job status.',
    inputSchema: {
      type: 'object',
      properties: {
        recent_limit: { type: 'integer', minimum: 0, maximum: 15, default: 5 },
        diagnostics: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'runtime',
    description: 'Start a target-bound, deadline-bounded loopback DeepSeek UI or stop its exact plugin-owned job.',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            action: { const: 'start' },
            schema_version: { const: CONFIG_SCHEMA_VERSION },
            timeout_seconds: { type: 'integer', minimum: 60, maximum: 21600, default: 3600 },
            target_context: TARGET_CONTEXT_SCHEMA,
            expected_target_fingerprint: {
              type: 'string',
              pattern: '^(sha256:)?[0-9a-fA-F]{64}$',
            },
          },
          required: ['action', 'schema_version', 'target_context', 'expected_target_fingerprint'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { action: { const: 'stop' } },
          required: ['action'],
          additionalProperties: false,
        },
      ],
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run',
    description: 'Queue a kind-specific Co-Engineer task and return effective_configuration plus a stable job ID. DeepSeek accepts prompt, timeout_seconds, and optional review/verify target_context only; Prime Agent additionally accepts autonomy; Prime evaluation accepts environment, examples, rollouts, concurrency, and max_tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        schema_version: { const: CONFIG_SCHEMA_VERSION },
        kind: { type: 'string', enum: ['deepseek_agent', 'prime_agent', 'prime_eval'] },
        request_id: { type: 'string', minLength: 8, maxLength: 128 },
        prompt: { type: 'string', maxLength: 12000 },
        autonomy: {
          type: 'string',
          enum: ['standard', 'high'],
          default: 'high',
          description: 'Prime Agent only; rejected for DeepSeek and Prime evaluation.',
        },
        environment: {
          type: 'string',
          maxLength: 240,
          description: 'Prime evaluation only; rejected for agent runs.',
        },
        examples: {
          type: 'integer', minimum: 1, maximum: 100, default: 3,
          description: 'Prime evaluation only.',
        },
        rollouts: {
          type: 'integer', minimum: 1, maximum: 8, default: 1,
          description: 'Prime evaluation only.',
        },
        concurrency: {
          type: 'integer', minimum: 1, maximum: 16, default: 2,
          description: 'Prime evaluation only.',
        },
        max_tokens: {
          type: 'integer', minimum: 128, maximum: 32768, default: 2048,
          description: 'Prime evaluation only.',
        },
        timeout_seconds: {
          type: 'integer', minimum: 60, maximum: 21600, default: 3600,
          description: 'All kinds; wall-clock range 60–21600 seconds.',
        },
        target_context: TARGET_CONTEXT_SCHEMA,
        expected_target_fingerprint: {
          type: 'string',
          pattern: '^(sha256:)?[0-9a-fA-F]{64}$',
          description: 'Caller assertion for the resolved target fingerprint; mismatch is fatal.',
        },
      },
      required: ['schema_version', 'kind', 'request_id', 'target_context', 'expected_target_fingerprint'],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
  {
    name: 'jobs',
    description: 'Read-only list, inspect, cursor-page logs, or bounded-wait for background jobs. Wait/tail/cursor arguments are validated before any polling; use until=terminal for terminal-focused waits.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'wait', 'logs'] },
        job_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'list only: 1–25.' },
        tail_lines: { type: 'integer', minimum: 0, maximum: 120, default: 40, description: 'get/wait: 0–120 lines.' },
        wait_seconds: { type: 'integer', minimum: 1, maximum: 55, default: 30, description: 'wait only: 1–55 seconds.' },
        until: { type: 'string', enum: ['change', 'terminal'], default: 'change', description: 'wait only.' },
        after_cursor: { type: 'string', pattern: '^\\d{1,16}$', description: 'Log byte offset returned as next_cursor.' },
        limit_bytes: { type: 'integer', minimum: 1, maximum: 12000, default: 12000, description: 'logs only: bounded cursor page size.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'cancel',
    description: 'Request cancellation of one plugin-owned job.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function decoratePreflight(result) {
  if (!result || result.schema_version !== CONFIG_SCHEMA_VERSION) return result;
  return {
    ...result,
    transport: 'stdio',
    protocol_version: negotiatedProtocolVersion,
    server_identity: SERVER_IDENTITY,
    available_tools: TOOLS.map((tool) => tool.name),
    toolset_digest: toolSetDigest(TOOLS),
    progress_contract: {
      notification: 'notifications/progress',
      heartbeat_seconds: 15,
      absolute_deadline: true,
    },
  };
}

const TERMINAL_JOB_STATES = new Set([
  'completed',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
  'timed_out',
  'uncertain',
]);

function lifecycleStage(status) {
  if (status === 'succeeded') return 'completed';
  if (status === 'timed_out') return 'timeout';
  if (status === 'uncertain') return 'failed';
  if (status === 'queued') return 'accepted';
  if (status === 'starting') return 'started';
  if (status === 'running' || status === 'cancelling') return 'working';
  return status;
}

function sendJobProgress(progressToken, sequence, job) {
  if (progressToken === undefined || progressToken === null || !job) return;
  const stage = lifecycleStage(job.status);
  send({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken,
      progress: sequence,
      message: `job ${job.id} ${stage}`,
      _meta: {
        job_id: job.id,
        stage,
        status: job.status,
        last_activity_at: job.last_activity_at ?? null,
        deadline_at: job.deadline_at ?? null,
        heartbeat: job.heartbeat ?? null,
      },
    },
  });
}

async function requestJobsWithProgress(name, args, progressToken) {
  if (name !== 'jobs' || args.action !== 'wait' || progressToken === undefined || progressToken === null) {
    return requestDaemon(name, args);
  }
  const maxSeconds = args.wait_seconds ?? 30;
  const startedAt = Date.now();
  const initial = await requestDaemon('jobs', {
    action: 'get',
    job_id: args.job_id,
    tail_lines: 0,
    after_cursor: args.after_cursor,
  });
  const baseline = initial.job;
  let sequence = 0;
  let result = initial;
  while (Date.now() - startedAt < maxSeconds * 1000) {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const slice = Math.max(1, Math.min(15, Math.ceil(maxSeconds - elapsedSeconds)));
    result = await requestDaemon('jobs', {
      ...args,
      wait_seconds: slice,
      tail_lines: args.tail_lines,
    });
    sequence += 1;
    sendJobProgress(progressToken, sequence, result.job);
    if (TERMINAL_JOB_STATES.has(result.job?.status)) return result;
    const changed = result.job?.status !== baseline?.status
      || result.job?.updated_at !== baseline?.updated_at
      || result.job?.log_bytes !== baseline?.log_bytes;
    if ((args.until ?? 'change') === 'change' && changed) return result;
  }
  if (sequence === 0) {
    sequence += 1;
    sendJobProgress(progressToken, sequence, result.job);
  }
  return result;
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.id === undefined) return;

  try {
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      negotiatedProtocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: negotiatedProtocolVersion,
          capabilities: {
            tools: { listChanged: false },
            experimental: {
              'codex-co-engineer': {
                progressHeartbeatSeconds: 15,
                absoluteDeadline: true,
              },
            },
          },
          serverInfo: SERVER_IDENTITY,
        },
      });
      return;
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;
    }
    if (message.method === 'tools/call') {
      try {
        const result = decoratePreflight(
          await requestJobsWithProgress(
            message.params?.name,
            message.params?.arguments ?? {},
            message.params?._meta?.progressToken,
          ),
        );
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          },
        });
      } catch (error) {
        const failureClass = error instanceof DaemonError ? 'tool_error' : 'protocol_error';
        const body = {
          ok: false,
          code: error instanceof DaemonError ? error.code : 'internal_error',
          failure_class: failureClass,
          error: error instanceof Error ? error.message : String(error),
        };
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] },
        });
      }
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const inflight = new Set();
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const request = handle(JSON.parse(line));
    inflight.add(request);
    void request.finally(() => inflight.delete(request));
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
});
input.on('close', () => {
  void Promise.allSettled([...inflight]);
});
