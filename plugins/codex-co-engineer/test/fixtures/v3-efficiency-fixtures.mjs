import { compactSummary, diagnosticEnvelope, sanitizePublicReceipt } from '../../mcp/v3/diagnostics.mjs';
import {
  VERSION,
  MCP_PENDING_CALL_BUDGET_MS,
  providerCapabilities,
  publicState,
  mcpPendingCallReport,
} from '../../mcp/v3/contract.mjs';
import { deadlineProjection } from '../../mcp/v3/deadline.mjs';

export const BASELINE_VERSION = '3.1.1';
export const TASK_COUNTS = Object.freeze([1, 20, 54]);
export const STATUS_TASK_LIMIT = 20;
export const WAIT_DURATION_MS = 25;

const PROVIDERS = Object.freeze(['grok', 'cursor-local', 'dsh', 'cursor-cloud']);
const FIXTURE_TIMESTAMP = '2026-08-20T00:00:00.000Z';
const FIXTURE_DEADLINE = '2026-01-01T00:00:00.000Z';
const ACTIVE_STATUSES = new Set(['accepted', 'starting', 'running', 'cancelling', 'transport_lost', 'needs_attention']);
const FIXTURE_BOUNDARY = Object.freeze({
  ready: true,
  status: 'prerequisites_ready',
  provider_started: false,
  boundary: 'systemd-user-service-cgroup',
});

function assertTaskCount(taskCount) {
  if (!TASK_COUNTS.includes(taskCount)) {
    throw new RangeError(`taskCount must be one of ${TASK_COUNTS.join(', ')}.`);
  }
}

function fixtureStatus(index) {
  if (index === 0 || index % 2 === 1) return 'running';
  return index % 5 === 0 ? 'failed' : 'completed';
}

function fixtureSha(index) {
  return ((index % 16).toString(16)).repeat(40);
}

function terminalOutput(taskId) {
  return Array.from(
    { length: 96 },
    (_, step) => `[${taskId}] completed synthetic step ${String(step + 1).padStart(3, '0')}`,
  ).join('\n');
}

function rawTask(index) {
  const taskId = `fixture-${String(index + 1).padStart(2, '0')}`;
  const status = fixtureStatus(index);
  const branch = `codex/${taskId}`;
  const startSha = fixtureSha(index + 1);
  const task = {
    id: taskId,
    status,
    provider: PROVIDERS[index % PROVIDERS.length],
    revision: 1,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
    branch,
    start_sha: startSha,
    expected_duration_ms: 60_000,
    duration_margin: 1.20,
    timeout_ms: 72_000,
    deadline_at: FIXTURE_DEADLINE,
    deadline_source: 'margin',
    deadline_extensions: [],
    prompt_dispatched: true,
    last_lifecycle_stage: status === 'running' ? 'running' : 'terminal',
    last_event: {
      at: FIXTURE_TIMESTAMP,
      type: status === 'running' ? 'tool_call' : 'terminal',
      title: status === 'running' ? 'synthetic progress' : 'synthetic terminal result',
      status,
      text: status === 'running'
        ? `active synthetic step for ${taskId}`
        : terminalOutput(taskId).slice(0, 512),
    },
  };
  if (status !== 'running') {
    task.finished_at = FIXTURE_DEADLINE;
    task.stop_reason = status === 'completed' ? 'completed' : 'provider_failure';
    task.result = {
      summary: status === 'completed'
        ? `Synthetic task ${taskId} completed.`
        : `Synthetic task ${taskId} stopped after a provider failure.`,
      output: terminalOutput(taskId),
    };
    task.handoff = {
      branch,
      head: fixtureSha(index + 7),
      validation: {
        status: status === 'completed' ? 'passed' : 'failed',
        checks: ['synthetic-unit', 'synthetic-contract'],
      },
    };
    task.error = {
      code: status === 'completed' ? 'ok' : 'provider_failure',
      message: status === 'completed'
        ? 'The synthetic delegated task completed.'
        : 'The synthetic provider failed after dispatch.',
    };
  }
  return task;
}

function publicTask(task) {
  return sanitizePublicReceipt({
    ...task,
    state: publicState(task.status),
    deadline: deadlineProjection(task),
  });
}

function readiness() {
  return {
    grok: { installed: true, ready: true, transport: 'acp' },
    'cursor-local': { installed: true, ready: true, transport: 'acp' },
    dsh: { installed: true, ready: true, transport: 'acpx' },
    'cursor-cloud': { installed: true, ready: true, transport: 'cursor-sdk' },
  };
}

function statusPayload(tasks) {
  return {
    version: VERSION,
    healthy: true,
    active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
    providers: [...PROVIDERS],
    capabilities: {
      grok: providerCapabilities('grok'),
      'cursor-local': providerCapabilities('cursor-local'),
      dsh: providerCapabilities('dsh'),
      'cursor-cloud': providerCapabilities('cursor-cloud'),
    },
    mcp_pending_call: mcpPendingCallReport(),
    local_boundary: FIXTURE_BOUNDARY,
    readiness: readiness(),
    // supervisorStatus intentionally caps this public list at 20 records.
    tasks: tasks.slice(0, STATUS_TASK_LIMIT),
  };
}

function taskPayload(task) {
  const progress = {
    event_cursor: '512',
    last_event: task.last_event,
    new_event_count: 0,
    more_events: false,
    waited_ms: WAIT_DURATION_MS,
    wait_reason: 'timeout',
    wait_until: 'progress',
  };
  const runtime = null;
  return {
    task,
    runtime,
    progress,
    state: publicState('running'),
    summary: compactSummary(task, progress, runtime, {
      wait_reason: progress.wait_reason,
      event_cursor: progress.event_cursor,
      last_event: progress.last_event,
    }),
    diagnostic: diagnosticEnvelope(task, runtime, {
      wait_reason: progress.wait_reason,
      last_event: progress.last_event,
    }),
    diagnostics: null,
    capabilities: providerCapabilities(task.provider),
    view: 'summary',
  };
}

/**
 * Build sanitized public payloads without starting the MCP server. These
 * fixtures deliberately contain no prompt text, paths, process identities, or
 * credentials; the result builder below still applies the production redaction
 * routine before serializing them.
 */
export function publicPayloads(taskCount) {
  assertTaskCount(taskCount);
  const tasks = Array.from({ length: taskCount }, (_, index) => publicTask(rawTask(index)));
  const task = tasks[0];
  return {
    status: statusPayload(tasks),
    delegate: {
      task,
      runtime: null,
      state: publicState('running'),
      deadline: deadlineProjection(rawTask(0)),
    },
    task: taskPayload(task),
    tasks: { tasks },
    cancel: { task },
  };
}

/**
 * This mirrors server.mjs's result() envelope in a test-only helper. Keeping
 * the mirror here avoids changing the runtime just to expose a benchmark hook.
 */
export function buildJsonRpcResponse(value, id = 1) {
  const sanitized = sanitizePublicReceipt(value) ?? {};
  const safe = JSON.parse(JSON.stringify(sanitized, (_key, nested) => (
    nested === undefined ? null : nested
  )));
  const text = JSON.stringify(safe);
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: safe,
    },
  };
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function measureResponse(value, id = 1) {
  const started = process.hrtime.bigint();
  const response = buildJsonRpcResponse(value, id);
  const constructionNs = process.hrtime.bigint() - started;
  const contentText = response.result.content[0].text;
  return {
    response,
    metrics: {
      text_content_bytes: Buffer.byteLength(contentText, 'utf8'),
      structured_content_bytes: byteLength(response.result.structuredContent),
      jsonrpc_bytes: byteLength(response),
      // Timing is observed for diagnostics, not used as a byte-baseline gate.
      response_construction_ms: Number(constructionNs) / 1_000_000,
    },
  };
}

export function measureFixture(taskCount) {
  const payloads = publicPayloads(taskCount);
  const responses = {};
  let responseConstructionMs = 0;
  for (const [name, payload] of Object.entries(payloads)) {
    const measured = measureResponse(payload);
    responses[name] = measured.metrics;
    responseConstructionMs += measured.metrics.response_construction_ms;
  }
  return {
    baseline_version: BASELINE_VERSION,
    task_count: taskCount,
    responses,
    response_construction_ms: responseConstructionMs,
    // The workload constructs the five public tool responses once, then makes
    // one deterministic task wait call in the companion test.
    call_count: Object.keys(payloads).length + 1,
    wait_duration_ms: WAIT_DURATION_MS,
    pending_call_budget_ms: MCP_PENDING_CALL_BUDGET_MS,
  };
}
