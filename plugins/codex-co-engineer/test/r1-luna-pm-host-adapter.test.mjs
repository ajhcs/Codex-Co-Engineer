import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FICTIONAL_HOST_ALIASES,
  HOST_TASK_EXECUTOR,
  HOST_TASK_SEQUENCE,
  LIVE_HOST_CALL_SCHEMAS,
  LIVE_WAIT_THREADS_TARGET_SCHEMA,
  WAIT_THREADS_TIMEOUT_DEFAULT_MS,
  WAIT_THREADS_TIMEOUT_MAX_MS,
  bindCreateThreadResult,
  cancellationSupported,
  detectHostTaskTools,
  hostArgs,
  materializeBoundCalls,
  matchesLiveWaitThreadsSchema,
  planCreateThread,
  planSendMessageToThread,
  planSetThreadArchived,
  planSetThreadPinned,
  planSolMergeReady,
  planWaitThreads,
  validateHostCall,
} from '../mcp/v3/luna-pm-host-adapter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.join(HERE, 'fixtures', 'v3-luna-pm-relay', 'live-host-schemas.json');
const THREAD = 'thr_host_luna_1';
const HOST_ID = 'codex-desktop';

test('create_thread binds only a usable threadId plus hostId', () => {
  const bound = bindCreateThreadResult({
    threadId: THREAD, hostId: HOST_ID, afterCursor: '0',
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.binding.threadId, THREAD);
  assert.equal(bound.binding.hostId, HOST_ID);
  assert.equal(bound.binding.usable, true);
  assert.equal(bound.invokes_host_callbacks, false);
  assert.equal(bound.executor, HOST_TASK_EXECUTOR);
});

test('create_thread with only clientThreadId is setup_pending and not usable', () => {
  const queued = bindCreateThreadResult({
    clientThreadId: 'client_luna_queued', hostId: HOST_ID, afterCursor: '1',
  });
  assert.equal(queued.ok, false);
  assert.equal(queued.code, 'setup_pending');
  assert.equal(queued.action, 'resume_needed');
  assert.equal(queued.resume_needed, true);
  assert.equal(queued.usable, false);
  assert.equal(queued.binding, null);
  assert.equal(queued.host_calls.length, 0);
  assert.equal(bindCreateThreadResult({}).ok, false);
  const threadOnly = bindCreateThreadResult({ threadId: THREAD, afterCursor: '0' });
  assert.equal(threadOnly.code, 'setup_pending');
  assert.equal(threadOnly.resume_needed, true);
});

test('wait_threads live schema requires threadId and may include hostId and afterCursor', async () => {
  const live = JSON.parse(await readFile(LIVE, 'utf8'));
  assert.deepEqual(live.wait_threads.target_required, ['threadId']);
  assert.deepEqual(live.wait_threads.target_optional, ['hostId', 'afterCursor']);
  assert.deepEqual(LIVE_WAIT_THREADS_TARGET_SCHEMA.required, live.wait_threads.target_required);
  assert.deepEqual(LIVE_WAIT_THREADS_TARGET_SCHEMA.optional, live.wait_threads.target_optional);
  assert.deepEqual(LIVE_HOST_CALL_SCHEMAS.wait_threads.target_required, ['threadId']);

  const threadOnly = planWaitThreads({ threadId: THREAD, timeoutMs: 5_000 });
  assert.equal(threadOnly.ok, true, threadOnly.code);
  assert.deepEqual(Object.keys(threadOnly.host_calls[0].targets[0]), ['threadId']);
  assert.equal(threadOnly.host_calls[0].targets[0].threadId, THREAD);
  assert.equal(matchesLiveWaitThreadsSchema(threadOnly.host_calls[0]), true);

  const withOptional = planWaitThreads({
    threadId: THREAD, hostId: HOST_ID, afterCursor: '4',
  });
  assert.equal(withOptional.ok, true);
  assert.deepEqual(withOptional.host_calls[0].targets, [{
    threadId: THREAD, hostId: HOST_ID, afterCursor: '4',
  }]);
  assert.equal(withOptional.host_calls[0].timeoutMs, WAIT_THREADS_TIMEOUT_DEFAULT_MS);
  assert.equal(matchesLiveWaitThreadsSchema(withOptional.host_calls[0]), true);

  assert.equal(planWaitThreads({ hostId: HOST_ID, afterCursor: '4' }).ok, false);
  assert.equal(planWaitThreads({
    threadId: THREAD, hostId: HOST_ID, afterCursor: '4', timeoutMs: 0,
  }).code, 'timeout_out_of_range');
  assert.equal(planWaitThreads({
    threadId: THREAD, timeoutMs: WAIT_THREADS_TIMEOUT_MAX_MS + 1,
  }).code, 'timeout_out_of_range');
});

test('send_message_to_thread requires threadId plus a real prompt body', () => {
  const planned = planSendMessageToThread({ threadId: THREAD, prompt: '{"kind":"completed"}' });
  assert.equal(planned.ok, true);
  assert.equal(planned.host_calls[0].threadId, THREAD);
  assert.equal(planned.host_calls[0].prompt, '{"kind":"completed"}');
  assert.equal(planSendMessageToThread({ threadId: THREAD }).code, 'missing_prompt_body');
  assert.equal(planSendMessageToThread({ prompt: 'hello' }).code, 'wrong_thread_identity');
});

test('optional archive and pin tools are set_thread_archived and set_thread_pinned', () => {
  assert.equal(planSetThreadPinned({ threadId: THREAD }).host_calls[0].tool, 'set_thread_pinned');
  assert.equal(planSetThreadArchived({ threadId: THREAD }).host_calls[0].tool, 'set_thread_archived');
  assert.equal(detectHostTaskTools([
    'create_thread', 'send_message_to_thread', 'wait_threads', 'pin_thread', 'cancel_thread',
  ]).optional.length, 0);
  assert.ok(FICTIONAL_HOST_ALIASES.includes('cancel_thread'));
  assert.ok(FICTIONAL_HOST_ALIASES.includes('pin_thread'));
  assert.equal(cancellationSupported({ cancel_thread: true }), false);
});

test('adapter validates live call shapes and does not invoke host callbacks', async () => {
  const live = JSON.parse(await readFile(LIVE, 'utf8'));
  assert.equal(live.executor, 'codex_skill');
  assert.equal(live.invokes_host_callbacks, false);
  assert.equal(live.sixth_mcp_tool, false);
  assert.deepEqual(live.sequence, HOST_TASK_SEQUENCE);

  const created = validateHostCall(planCreateThread({ model: 'luna-max' }).host_calls[0]);
  assert.equal(created.ok, true);
  assert.deepEqual(created.host_calls[0], { tool: 'create_thread', model: 'luna-max' });
  assert.equal(created.invokes_host_callbacks, false);

  const sent = validateHostCall({
    tool: 'send_message_to_thread', threadId: THREAD, prompt: '{"kind":"blocked"}',
  });
  assert.equal(sent.ok, true);
  assert.deepEqual(hostArgs(sent.host_calls[0]), { threadId: THREAD, prompt: '{"kind":"blocked"}' });

  const waited = validateHostCall(planWaitThreads({
    threadId: THREAD, hostId: HOST_ID, afterCursor: '3', timeoutMs: 5_000,
  }).host_calls[0]);
  assert.equal(waited.ok, true);
  assert.deepEqual(waited.host_calls[0], {
    tool: 'wait_threads',
    targets: [{ threadId: THREAD, hostId: HOST_ID, afterCursor: '3' }],
    timeoutMs: 5_000,
  });
  assert.equal(hostArgs({ tool: 'cancel_thread', threadId: THREAD }), null);
  assert.equal(validateHostCall({ tool: 'cancel_thread', threadId: THREAD }).code, 'fictional_host_alias');
});

test('Sol merge_ready follow-up materializes send and wait only after a usable thread bind', () => {
  const planned = planSolMergeReady('sol-high', '{"kind":"merge_ready"}', '8');
  assert.equal(planned.host_calls[0].tool, 'create_thread');
  assert.equal(planned.host_calls[1].bind_created_thread, true);
  assert.equal(planned.host_calls[2].tool, 'wait_threads');

  const pending = materializeBoundCalls(planned.host_calls, {
    clientThreadId: 'client_sol_pending',
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'setup_pending');
  assert.equal(pending.host_calls.length, 0);

  const executed = materializeBoundCalls(planned.host_calls, {
    threadId: 'thr_sol_1', hostId: HOST_ID, afterCursor: '0',
  });
  assert.equal(executed.ok, true, executed.code);
  assert.equal(executed.host_calls[0].tool, 'create_thread');
  assert.deepEqual(executed.host_calls[0], { tool: 'create_thread', model: 'sol-high' });
  assert.equal(executed.host_calls[1].tool, 'send_message_to_thread');
  assert.equal(executed.host_calls[1].threadId, 'thr_sol_1');
  assert.equal(executed.host_calls[1].prompt, '{"kind":"merge_ready"}');
  assert.deepEqual(executed.host_calls[2].targets[0], {
    threadId: 'thr_sol_1', hostId: HOST_ID, afterCursor: '8',
  });
  assert.equal(executed.host_calls[2].targets[0].threadId, 'thr_sol_1');
  assert.equal(executed.invokes_host_callbacks, false);
});
