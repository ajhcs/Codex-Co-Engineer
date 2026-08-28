// LunaPmHostAdapterV1 — deterministic Codex Desktop task-tool
// request/validation layer.
//
// Codex skill is the host executor. It calls the real Desktop tools:
//   create_thread
//   send_message_to_thread
//   wait_threads (or read_thread)
//   set_thread_archived
//   set_thread_pinned
// This module plans and validates those call shapes. It does not invoke
// host callbacks, does not simulate the Desktop host, and is not a sixth
// Co-Engineer MCP tool. Co-Engineer MCP cannot call these host-only tools.
//
// Live wait_threads contract: each target MUST include threadId and MAY
// include hostId and afterCursor. Do not drop threadId. Do not substitute
// clientThreadId for threadId.
//
// A create_thread result that contains only clientThreadId is
// setup_pending / resume_needed: not usable, do not send or wait, until
// the host supplies a real threadId and hostId.
// Invented cancel/archive/pin aliases are rejected. The host has no
// cancel_thread primitive, so this adapter never claims cancellation.

import { classifyGitOperationV1 } from './git-authority.mjs';

export const LUNA_PM_HOST_ADAPTER_SCHEMA = 'codex-co-engineer.luna-pm-host-adapter.v1';
export const LUNA_PM_HOST_ADAPTER_VERSION = 1;

export const HOST_TASK_REQUIRED_TOOLS = Object.freeze([
  'create_thread',
  'send_message_to_thread',
]);
export const HOST_TASK_WAIT_TOOLS = Object.freeze(['wait_threads', 'read_thread']);
export const HOST_TASK_OPTIONAL_TOOLS = Object.freeze([
  'set_thread_archived',
  'set_thread_pinned',
]);
export const HOST_TASK_TOOL_ACTIONS = Object.freeze([
  'create_thread',
  'send_message_to_thread',
  'wait_threads',
  'read_thread',
]);
export const HOST_TASK_EXECUTOR = 'codex_skill';
export const HOST_TASK_SEQUENCE = Object.freeze([
  'create_thread',
  'bind_usable_thread',
  'set_thread_pinned',
  'send_message_to_thread',
  'wait_threads',
  'set_thread_archived',
]);
export const FICTIONAL_HOST_ALIASES = Object.freeze([
  'create', 'resume', 'message', 'wait',
  'create_task', 'resume_task', 'message_task', 'wait_task',
  'task_create', 'task_resume', 'task_message', 'task_wait',
  'cancel_thread', 'archive_thread', 'pin_thread',
  'cancel', 'archive', 'pin',
]);

export const WAIT_THREADS_TIMEOUT_MIN_MS = 1_000;
export const WAIT_THREADS_TIMEOUT_MAX_MS = 60_000;
export const WAIT_THREADS_TIMEOUT_DEFAULT_MS = 15_000;
export const HOST_PROMPT_MAX_BYTES = 4_096;
export const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const THREAD_ID_PATTERN = HOST_ID_PATTERN;
export const CURSOR_PATTERN = /^[0-9]{1,16}$/u;

export const LIVE_WAIT_THREADS_TARGET_SCHEMA = Object.freeze({
  required: Object.freeze(['threadId']),
  optional: Object.freeze(['hostId', 'afterCursor']),
});
export const LIVE_HOST_CALL_SCHEMAS = Object.freeze({
  create_thread: Object.freeze({
    request_required: Object.freeze(['model']),
    usable_result_required: Object.freeze(['threadId', 'hostId']),
    setup_pending_result: Object.freeze(['clientThreadId']),
  }),
  send_message_to_thread: Object.freeze({
    required: Object.freeze(['threadId', 'prompt']),
  }),
  wait_threads: Object.freeze({
    required: Object.freeze(['targets', 'timeoutMs']),
    target_required: LIVE_WAIT_THREADS_TARGET_SCHEMA.required,
    target_optional: LIVE_WAIT_THREADS_TARGET_SCHEMA.optional,
  }),
  read_thread: Object.freeze({
    required: Object.freeze(['threadId', 'afterCursor']),
  }),
  set_thread_pinned: Object.freeze({
    required: Object.freeze(['threadId', 'pinned']),
  }),
  set_thread_archived: Object.freeze({
    required: Object.freeze(['threadId', 'archived']),
  }),
});

const FORBIDDEN_MESSAGE_OPERATIONS = Object.freeze([
  'force_push', 'merge', 'merge_pr', 'rebase', 'tag_create', 'tag_delete',
  'release_create', 'delete_ref', 'protected_ref_update',
]);

function freeze(value) {
  if (value !== null && typeof value === 'object') Object.freeze(value);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function fail(code, extras = {}) {
  return freeze({
    schema: LUNA_PM_HOST_ADAPTER_SCHEMA,
    version: LUNA_PM_HOST_ADAPTER_VERSION,
    ok: false,
    code,
    action: extras.action ?? 'reject_host_call',
    host_calls: Object.freeze([]),
    binding: null,
    cancellation_supported: false,
    executor: HOST_TASK_EXECUTOR,
    invokes_host_callbacks: false,
    ...extras,
  });
}

function ok(fields) {
  return freeze({
    schema: LUNA_PM_HOST_ADAPTER_SCHEMA,
    version: LUNA_PM_HOST_ADAPTER_VERSION,
    ok: true,
    code: null,
    action: fields.action,
    host_calls: Object.freeze([...(fields.host_calls ?? [])].map(freeze)),
    binding: fields.binding ? freeze(fields.binding) : null,
    cancellation_supported: false,
    executor: HOST_TASK_EXECUTOR,
    invokes_host_callbacks: false,
    result: fields.result === undefined ? null : freeze(fields.result),
    ...fields.extras,
  });
}

export function detectHostTaskTools(available) {
  const names = new Set(
    (Array.isArray(available) ? available : [])
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const rejected_aliases = FICTIONAL_HOST_ALIASES.filter((alias) => names.has(alias));
  const present = [];
  const missing = [];
  const resolved = {};
  for (const tool of HOST_TASK_REQUIRED_TOOLS) {
    if (names.has(tool)) {
      present.push(tool);
      resolved[tool] = tool;
    } else missing.push(tool);
  }
  const waitTool = HOST_TASK_WAIT_TOOLS.find((tool) => names.has(tool)) ?? null;
  if (waitTool) {
    present.push(waitTool);
    resolved.wait = waitTool;
  } else missing.push('wait_threads');
  const optional = HOST_TASK_OPTIONAL_TOOLS.filter((tool) => names.has(tool));
  for (const tool of optional) resolved[tool] = tool;
  return freeze({
    complete: missing.length === 0,
    present: Object.freeze(present),
    missing: Object.freeze(missing),
    optional: Object.freeze(optional),
    rejected_aliases: Object.freeze(rejected_aliases),
    resolved: freeze(resolved),
    cancellation_supported: false,
    executor: HOST_TASK_EXECUTOR,
    invokes_host_callbacks: false,
  });
}

export function hostApiGap(host) {
  return host.complete ? null : freeze({
    required: HOST_TASK_TOOL_ACTIONS,
    present: host.present,
    missing: host.missing,
    rejected_aliases: host.rejected_aliases,
    cancellation_supported: false,
    executor: HOST_TASK_EXECUTOR,
    invokes_host_callbacks: false,
  });
}

function requireId(value, code) {
  if (typeof value !== 'string' || !THREAD_ID_PATTERN.test(value)) return code;
  return null;
}

function requireCursor(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && CURSOR_PATTERN.test(value)) return value;
  return null;
}

function boundedTimeout(value) {
  if (value == null) return WAIT_THREADS_TIMEOUT_DEFAULT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < WAIT_THREADS_TIMEOUT_MIN_MS || value > WAIT_THREADS_TIMEOUT_MAX_MS) return null;
  return value;
}

function allowedTargetKeys(target) {
  return Object.keys(target).every((key) => (
    LIVE_WAIT_THREADS_TARGET_SCHEMA.required.includes(key)
    || LIVE_WAIT_THREADS_TARGET_SCHEMA.optional.includes(key)
  ));
}

export function waitThreadsTarget(input = {}) {
  if (!plainObject(input)) return null;
  if (!allowedTargetKeys(input)) return null;
  if (requireId(input.threadId, 'wrong_thread_identity')) return null;
  const target = { threadId: input.threadId };
  if (input.hostId !== undefined) {
    if (requireId(input.hostId, 'wrong_thread_identity')) return null;
    target.hostId = input.hostId;
  }
  if (input.afterCursor !== undefined) {
    const afterCursor = requireCursor(input.afterCursor);
    if (afterCursor == null) return null;
    target.afterCursor = afterCursor;
  }
  return freeze(target);
}

export function matchesLiveWaitThreadsSchema(args) {
  if (!plainObject(args) || !Array.isArray(args.targets) || args.targets.length < 1) {
    return false;
  }
  const timeoutMs = boundedTimeout(args.timeoutMs);
  if (timeoutMs == null) return false;
  return args.targets.every((target) => {
    const normalized = waitThreadsTarget(target);
    return normalized != null && typeof normalized.threadId === 'string';
  });
}

export function bindCreateThreadResult(result) {
  if (!plainObject(result)) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  const threadId = typeof result.threadId === 'string' ? result.threadId : null;
  const clientThreadId = typeof result.clientThreadId === 'string' ? result.clientThreadId : null;
  const hostId = typeof result.hostId === 'string' ? result.hostId : null;
  const rawCursor = result.afterCursor ?? result.cursor;
  const afterCursor = rawCursor === undefined ? null : requireCursor(rawCursor);
  if (rawCursor !== undefined && afterCursor == null) {
    return fail('stale_event', { action: 'reject_identity' });
  }
  if (threadId && requireId(threadId, 'wrong_thread_identity')) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  if (hostId && requireId(hostId, 'wrong_thread_identity')) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  const usable = Boolean(
    threadId
    && !requireId(threadId, 'wrong_thread_identity')
    && hostId
    && !requireId(hostId, 'wrong_thread_identity'),
  );
  if (usable) {
    return ok({
      action: 'bind_thread',
      binding: freeze({
        threadId,
        clientThreadId: null,
        hostId,
        afterCursor: afterCursor ?? '0',
        queued: false,
        usable: true,
        binding: 'threadId',
      }),
    });
  }
  if (clientThreadId) {
    if (requireId(clientThreadId, 'wrong_thread_identity')) {
      return fail('wrong_thread_identity', { action: 'reject_identity' });
    }
    return fail('setup_pending', {
      action: 'resume_needed',
      resume_needed: true,
      clientThreadId,
      threadId: threadId || null,
      hostId,
      usable: false,
    });
  }
  if (threadId && !hostId) {
    return fail('setup_pending', {
      action: 'resume_needed',
      resume_needed: true,
      clientThreadId: null,
      threadId,
      hostId: null,
      usable: false,
    });
  }
  return fail('wrong_thread_identity', { action: 'reject_identity' });
}

export function planCreateThread(input = {}) {
  const model = typeof input.model === 'string' ? input.model : null;
  if (!model) return fail('invalid_host_call', { action: 'reject_host_call' });
  return ok({
    action: 'create_thread',
    host_calls: [freeze({
      tool: 'create_thread',
      model,
    })],
  });
}

export function planSendMessageToThread(input = {}) {
  const threadId = input.threadId;
  if (requireId(threadId, 'wrong_thread_identity')) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt : null;
  if (prompt == null || prompt.length === 0) {
    return fail('missing_prompt_body', { action: 'reject_host_call' });
  }
  if (utf8Bytes(prompt) > HOST_PROMPT_MAX_BYTES) {
    return fail('prompt_over_bound', { action: 'reject_host_call' });
  }
  return ok({
    action: 'send_message_to_thread',
    host_calls: [freeze({
      tool: 'send_message_to_thread',
      threadId,
      prompt,
    })],
  });
}

export function planWaitThreads(input = {}) {
  const timeoutMs = boundedTimeout(input.timeoutMs);
  if (timeoutMs == null) return fail('timeout_out_of_range', { action: 'reject_host_call' });
  const source = plainObject(input.targets?.[0])
    ? input.targets[0]
    : {
      threadId: input.threadId,
      ...(input.hostId !== undefined ? { hostId: input.hostId } : {}),
      ...(input.afterCursor !== undefined ? { afterCursor: input.afterCursor } : {}),
    };
  if (input.afterCursor !== undefined && requireCursor(input.afterCursor) == null) {
    return fail('stale_event', { action: 'reject_identity' });
  }
  if (plainObject(input.targets?.[0]) && input.targets[0].afterCursor !== undefined
    && requireCursor(input.targets[0].afterCursor) == null) {
    return fail('stale_event', { action: 'reject_identity' });
  }
  const target = waitThreadsTarget(source);
  if (target == null) return fail('wrong_thread_identity', { action: 'reject_identity' });
  return ok({
    action: 'wait_threads',
    host_calls: [freeze({
      tool: 'wait_threads',
      targets: Object.freeze([target]),
      timeoutMs,
    })],
  });
}

export function planReadThread(input = {}) {
  const threadId = input.threadId;
  const afterCursor = requireCursor(input.afterCursor);
  if (requireId(threadId, 'wrong_thread_identity')) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  if (afterCursor == null) return fail('stale_event', { action: 'reject_identity' });
  return ok({
    action: 'read_thread',
    host_calls: [freeze({
      tool: 'read_thread',
      threadId,
      afterCursor,
    })],
  });
}

export function planSetThreadPinned(input = {}) {
  const threadId = input.threadId;
  if (requireId(threadId, 'wrong_thread_identity')) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  return ok({
    action: 'set_thread_pinned',
    host_calls: [freeze({
      tool: 'set_thread_pinned',
      threadId,
      pinned: input.pinned !== false,
    })],
  });
}

export function planSetThreadArchived(input = {}) {
  const threadId = input.threadId;
  if (requireId(threadId, 'wrong_thread_identity')) {
    return fail('wrong_thread_identity', { action: 'reject_identity' });
  }
  return ok({
    action: 'set_thread_archived',
    host_calls: [freeze({
      tool: 'set_thread_archived',
      threadId,
      archived: input.archived !== false,
    })],
  });
}

export function planMessageAndWait(session, prompt, extras = {}) {
  if (session?.queued_thread === true || session?.host_bound !== true) {
    return fail('setup_pending', {
      action: 'resume_needed',
      resume_needed: true,
      usable: false,
    });
  }
  const send = planSendMessageToThread({
    threadId: session?.thread_id ?? session?.threadId,
    prompt,
  });
  if (!send.ok) return send;
  const waitTool = session?.wait_tool ?? extras.wait_tool ?? 'wait_threads';
  const afterCursor = extras.afterCursor ?? session?.last_cursor;
  const hostId = session?.host_id ?? session?.hostId ?? extras.hostId;
  const wait = waitTool === 'read_thread'
    ? planReadThread({
      threadId: session?.thread_id ?? session?.threadId,
      afterCursor: afterCursor ?? '0',
    })
    : planWaitThreads({
      threadId: session?.thread_id ?? session?.threadId,
      ...(hostId !== undefined && hostId !== null ? { hostId } : {}),
      ...(afterCursor !== undefined && afterCursor !== null ? { afterCursor } : {}),
      timeoutMs: extras.timeoutMs,
    });
  if (!wait.ok) return wait;
  return ok({
    action: 'bind_and_forward',
    host_calls: [...send.host_calls, ...wait.host_calls],
  });
}

export function hostArgs(call) {
  if (!plainObject(call) || typeof call.tool !== 'string') return null;
  if (call.tool === 'create_thread') {
    if (typeof call.model !== 'string' || call.model.length === 0) return null;
    return freeze({ model: call.model });
  }
  if (call.tool === 'send_message_to_thread') {
    if (requireId(call.threadId, 'wrong_thread_identity')) return null;
    if (typeof call.prompt !== 'string' || call.prompt.length === 0) return null;
    return freeze({ threadId: call.threadId, prompt: call.prompt });
  }
  if (call.tool === 'wait_threads') {
    const targets = Array.isArray(call.targets) ? call.targets : [];
    if (targets.length !== 1 || !plainObject(targets[0])) return null;
    const target = waitThreadsTarget(targets[0]);
    if (target == null) return null;
    const timeoutMs = boundedTimeout(call.timeoutMs);
    if (timeoutMs == null) return null;
    return freeze({
      targets: Object.freeze([target]),
      timeoutMs,
    });
  }
  if (call.tool === 'read_thread') {
    if (requireId(call.threadId, 'wrong_thread_identity')) return null;
    const afterCursor = requireCursor(call.afterCursor);
    if (afterCursor == null) return null;
    return freeze({ threadId: call.threadId, afterCursor });
  }
  if (call.tool === 'set_thread_pinned') {
    if (requireId(call.threadId, 'wrong_thread_identity')) return null;
    return freeze({ threadId: call.threadId, pinned: call.pinned === true });
  }
  if (call.tool === 'set_thread_archived') {
    if (requireId(call.threadId, 'wrong_thread_identity')) return null;
    return freeze({ threadId: call.threadId, archived: call.archived === true });
  }
  return null;
}

export function validateHostCall(call) {
  if (!plainObject(call) || typeof call.tool !== 'string') {
    return fail('invalid_host_call');
  }
  if (FICTIONAL_HOST_ALIASES.includes(call.tool)) {
    return fail('fictional_host_alias');
  }
  const args = hostArgs(call);
  if (args == null) return fail('invalid_host_call');
  if (call.tool === 'wait_threads' && !matchesLiveWaitThreadsSchema(args)) {
    return fail('invalid_host_call');
  }
  return ok({
    action: call.tool,
    host_calls: [freeze({ tool: call.tool, ...args })],
  });
}

function resolveBoundCall(call, binding) {
  if (!plainObject(call)) return call;
  if (call.bind_created_thread !== true || !plainObject(binding) || binding.usable !== true) {
    return call;
  }
  const threadId = binding.threadId;
  const hostId = call.hostId ?? binding.hostId;
  if (call.tool === 'send_message_to_thread') {
    return freeze({ ...call, threadId, bind_created_thread: undefined });
  }
  if (call.tool === 'wait_threads') {
    const afterCursor = call.afterCursor ?? call.targets?.[0]?.afterCursor;
    const target = waitThreadsTarget({
      threadId,
      ...(hostId !== undefined && hostId !== null ? { hostId } : {}),
      ...(afterCursor !== undefined ? { afterCursor } : {}),
    });
    if (target == null) return call;
    return freeze({
      tool: 'wait_threads',
      targets: Object.freeze([target]),
      timeoutMs: call.timeoutMs ?? WAIT_THREADS_TIMEOUT_DEFAULT_MS,
    });
  }
  if (call.tool === 'read_thread' || call.tool === 'set_thread_pinned' || call.tool === 'set_thread_archived') {
    return freeze({ ...call, threadId, bind_created_thread: undefined });
  }
  return call;
}

export function materializeBoundCalls(calls, createResult) {
  const bound = bindCreateThreadResult(createResult);
  if (!bound.ok) return bound;
  const materialized = [];
  for (const planned of Array.isArray(calls) ? calls : []) {
    if (planned?.tool === 'create_thread') {
      const validated = validateHostCall(planned);
      if (!validated.ok) return validated;
      materialized.push(...validated.host_calls);
      continue;
    }
    const resolved = resolveBoundCall(planned, bound.binding);
    const validated = validateHostCall(resolved);
    if (!validated.ok) return validated;
    materialized.push(...validated.host_calls);
  }
  return ok({
    action: 'materialize_host_calls',
    host_calls: materialized,
    binding: bound.binding,
  });
}

export function planSolMergeReady(adjudicator, prompt, afterCursor) {
  const create = planCreateThread({ model: adjudicator });
  if (!create.ok) return create;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return fail('missing_prompt_body');
  }
  const waitInput = {
    bind_created_thread: true,
    timeoutMs: WAIT_THREADS_TIMEOUT_DEFAULT_MS,
  };
  if (afterCursor !== undefined && afterCursor !== null) {
    const cursor = requireCursor(afterCursor);
    if (cursor == null) return fail('stale_event', { action: 'reject_identity' });
    waitInput.afterCursor = cursor;
  }
  return ok({
    action: 'wake_sol_merge_ready',
    host_calls: [
      ...create.host_calls,
      freeze({
        tool: 'send_message_to_thread',
        bind_created_thread: true,
        prompt,
      }),
      freeze({
        tool: 'wait_threads',
        ...waitInput,
      }),
    ],
  });
}

export function denyMessageGitOverride(request) {
  if (request == null) return null;
  if (!plainObject(request)) return freeze({ ok: false, code: 'invalid_git_operation' });
  const operation = request.operation;
  if (typeof operation === 'string' && FORBIDDEN_MESSAGE_OPERATIONS.includes(operation)) {
    return freeze({
      ok: false,
      code: 'git_override_denied',
      operation,
      verdict: 'denied',
    });
  }
  try {
    const classified = classifyGitOperationV1(request);
    if (classified.verdict === 'denied') {
      return freeze({
        ok: false,
        code: classified.code,
        operation: classified.operation,
        verdict: 'denied',
      });
    }
    return freeze({ ok: true, code: null, verdict: classified.verdict, receipt: classified });
  } catch {
    return freeze({ ok: false, code: 'invalid_git_operation' });
  }
}

export function cancellationSupported(_host) {
  return false;
}
