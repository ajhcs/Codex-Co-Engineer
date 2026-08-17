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
    'DSH_HOME',
    'CODEX_CO_ENGINEER_DSH_HOME',
    'MODEL_API_KEY',
    'XAI_API_KEY',
    'CODEX_CO_ENGINEER_RUNTIME_WORKSPACE',
    'CODEX_CO_ENGINEER_ALLOWED_ROOTS',
    'CODEX_CO_ENGINEER_STATE_DIR',
    'CODEX_CO_ENGINEER_DAEMON_IDLE_SECONDS',
    'CODEX_CO_ENGINEER_MODEL_API_KEY_FILE',
    'CODEX_CO_ENGINEER_DSH_COMMAND',
    'CODEX_CO_ENGINEER_GROK_COMMAND',
    'PLUMBOB_HARNESS_WORKSPACE',
    'PLUMBOB_HARNESS_ALLOWED_ROOTS',
    'PLUMBOB_HARNESS_STATE_DIR',
    'PLUMBOB_HARNESS_DAEMON_IDLE_SECONDS',
    'PLUMBOB_HARNESS_MODEL_API_KEY_FILE',
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

const GROK_CONFIGURATION_PROPERTIES = {
  model: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[^\\u0000-\\u001f\\u007f-][^\\u0000-\\u001f\\u007f]{0,199}$',
    description: 'Optional Grok model ID; it is passed as -m/--model.',
  },
  output_format: {
    type: 'string',
    enum: ['plain', 'json', 'streaming-json', 'streaming-messages-json'],
    default: 'streaming-json',
    description: 'Grok headless output format. streaming-json is the default for durable logs.',
  },
  json_schema: {
    oneOf: [
      { type: 'boolean' },
      { type: 'object', maxProperties: 256 },
    ],
    description: 'Bounded JSON Schema object or boolean for structured output; implies output_format=json and is capped at 16 KiB after serialization.',
  },
  verbatim: {
    type: 'boolean',
    default: false,
    description: 'Pass Grok --verbatim so the prompt is sent exactly as supplied.',
  },
  include_partial_messages: {
    type: 'boolean',
    default: false,
    description: 'Pass --include-partial-messages; valid only with streaming-messages-json.',
  },
  session_id: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
    description: 'Valid UUID for a new session; resume/continue require fork_session when combined.',
  },
  resume: {
    oneOf: [
      { const: true },
      { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000-\\u001f\\u007f-][^\\u0000-\\u001f\\u007f]{0,127}$' },
    ],
    description: 'Pass --resume, optionally with a session ID/title; mutually exclusive with continue_session.',
  },
  continue_session: {
    type: 'boolean',
    default: false,
    description: 'Continue the most recent session in the target directory; mutually exclusive with session_id and resume.',
  },
  reasoning_effort: {
    type: 'string',
    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    description: 'Maps to stable --reasoning-effort (with --effort as the CLI alias).',
  },
  max_turns: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: 'Maximum Grok agent turns.',
  },
  sandbox_profile: {
    type: 'string',
    enum: ['off', 'workspace', 'devbox', 'read-only', 'strict'],
    description: 'Built-in Grok sandbox profile. Unverifiable custom profiles are rejected by the connector.',
  },
  permission_mode: {
    type: 'string',
    enum: ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'],
    description: 'Role-dependent Grok permission mode. Review/verify accept only default or plan and force plan at runtime; implement defaults to and requires noninteractive auto.',
  },
  rules: {
    type: 'string',
    minLength: 1,
    maxLength: 8000,
    pattern: '^[^\\u0000-\\u001f\\u007f-][^\\u0000-\\u001f\\u007f]{0,7999}$',
    description: 'Extra Grok rules appended to the system prompt; system-prompt override is intentionally unavailable.',
  },
  allowed_tools: {
    type: 'array',
    maxItems: 32,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$' },
    description: 'Typed Grok built-in tool names mapped to --tools comma-list.',
  },
  disallowed_tools: {
    type: 'array',
    maxItems: 32,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$' },
    description: 'Typed Grok built-in tool names mapped to --disallowed-tools comma-list.',
  },
  allow_rules: {
    type: 'array',
    maxItems: 32,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^\\u0000-\\u001f\\u007f-][^\\u0000-\\u001f\\u007f]{0,239}$' },
    description: 'Repeatable Grok --allow rules; deny rules still win and role ceilings are enforced.',
  },
  deny_rules: {
    type: 'array',
    maxItems: 32,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[^\\u0000-\\u001f\\u007f-][^\\u0000-\\u001f\\u007f]{0,239}$' },
    description: 'Repeatable Grok --deny rules; useful for narrowing a role policy.',
  },
  always_approve: {
    type: 'boolean',
    default: false,
    description: 'Explicitly request --always-approve for an implement run; rejected for review/verify.',
  },
  no_auto_update: {
    type: 'boolean',
    default: true,
    description: 'Suppress Grok background update checks; defaults true for managed jobs.',
  },
  no_plan: { type: 'boolean', default: false, description: 'Pass Grok --no-plan for implement only; review/verify retain the forced plan policy.' },
  no_subagents: { type: 'boolean', default: false, description: 'Pass Grok --no-subagents.' },
  no_memory: { type: 'boolean', default: false, description: 'Pass Grok --no-memory.' },
  disable_web_search: { type: 'boolean', default: false, description: 'Pass Grok --disable-web-search.' },
  experimental_memory: { type: 'boolean', default: false, description: 'Pass Grok --experimental-memory; mutually exclusive with no_memory.' },
  fork_session: { type: 'boolean', default: false, description: 'Pass Grok --fork-session when resuming or continuing a session.' },
};

// Keep the advertised schema aligned with normalizeGrokConfiguration. Grok
// fields remain visible at the top level for compact client forms, while this
// guard makes their presence conditional on kind=grok_build. This matters for
// DeepSeek/preflight callers because the runtime rejects those fields before
// dispatch rather than silently ignoring them.
const GROK_READ_ONLY_TOOL_PATTERN = '^(?:[Rr]_?[Ee]_?[Aa]_?[Dd]|[Gg]_?[Rr]_?[Ee]_?[Pp]|[Gg]_?[Ll]_?[Oo]_?[Bb]|[Ll]_?[Ss]|[Ff]_?[Ii]_?[Nn]_?[Dd]|[Ww]_?[Ee]_?[Bb]_?[Ff]_?[Ee]_?[Tt]_?[Cc]_?[Hh]|[Ww]_?[Ee]_?[Bb]_?[Ss]_?[Ee]_?[Aa]_?[Rr]_?[Cc]_?[Hh])$';

const GROK_ROLE_POLICY = {
  if: {
    required: ['target_context'],
    properties: {
      target_context: {
        properties: { role: { const: 'implement' } },
        required: ['role'],
      },
    },
  },
  then: {
    properties: {
      permission_mode: { const: 'auto' },
      sandbox_profile: { enum: ['workspace', 'read-only', 'strict'] },
    },
    description: 'Implement targets omit permission_mode or use noninteractive auto and remain within the workspace sandbox.',
  },
  else: {
    properties: {
      permission_mode: { enum: ['default', 'plan'] },
      sandbox_profile: { const: 'read-only' },
      allowed_tools: {
        items: { pattern: GROK_READ_ONLY_TOOL_PATTERN },
      },
      always_approve: { const: false },
      no_plan: { const: false },
    },
    description: 'Review and verify targets omit permission_mode or use default/plan, retain plan mode, and expose only read-only tools.',
  },
};

const GROK_KIND_FIELD_POLICY = {
  if: {
    properties: { kind: { const: 'grok_build' } },
    required: ['kind'],
  },
  then: GROK_ROLE_POLICY,
  else: {
    not: {
      anyOf: Object.keys(GROK_CONFIGURATION_PROPERTIES).map((field) => ({
        required: [field],
      })),
    },
    description: 'DeepSeek and generic preflight requests must omit Grok-only configuration fields.',
  },
};

const TOOLS = [
  {
    name: 'preflight',
    description: 'Resolve and attest exactly one target/configuration before dispatch. The caller must supply expected_target_fingerprint; a mismatch is fatal.',
    inputSchema: {
      type: 'object',
      allOf: [GROK_KIND_FIELD_POLICY],
      properties: {
        schema_version: { const: CONFIG_SCHEMA_VERSION },
        kind: { type: 'string', enum: ['preflight', 'deepseek_agent', 'grok_build'], default: 'preflight' },
        request_id: { type: 'string', minLength: 8, maxLength: 128 },
        prompt: { type: 'string', minLength: 1, maxLength: 12000, pattern: '^[^\\u0000\\u007f]*$', description: 'Hashed for the configuration digest; never returned.' },
        timeout_seconds: { type: 'integer', minimum: 60, maximum: 21600, default: 3600 },
        target_context: TARGET_CONTEXT_SCHEMA,
        expected_target_fingerprint: {
          type: 'string',
          pattern: '^(sha256:)?[0-9a-fA-F]{64}$',
          description: 'Caller assertion for the resolved target fingerprint.',
        },
        ...GROK_CONFIGURATION_PROPERTIES,
      },
      required: ['schema_version', 'target_context', 'expected_target_fingerprint'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'status',
    description: 'Show compact DeepSeek Harness, Grok Build, credential, UI, and recent-job status.',
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
    description: 'Queue a kind-specific Co-Engineer task and return effective_configuration plus a stable job ID. Grok Build uses the official direct headless CLI with typed model, session, reasoning, sandbox, permission, tool, and bounded policy controls.',
    inputSchema: {
      type: 'object',
      allOf: [GROK_KIND_FIELD_POLICY],
      properties: {
        schema_version: { const: CONFIG_SCHEMA_VERSION },
        kind: { type: 'string', enum: ['deepseek_agent', 'grok_build'] },
        request_id: { type: 'string', minLength: 8, maxLength: 128 },
        prompt: { type: 'string', maxLength: 12000, pattern: '^[^\\u0000\\u007f]*$' },
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
        ...GROK_CONFIGURATION_PROPERTIES,
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
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    await handle(JSON.parse(line));
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
}
