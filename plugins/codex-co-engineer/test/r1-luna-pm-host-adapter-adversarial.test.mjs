import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindCreateThreadResult,
  denyMessageGitOverride,
  detectHostTaskTools,
  hostArgs,
  materializeBoundCalls,
  planSendMessageToThread,
  planWaitThreads,
  validateHostCall,
} from '../mcp/v3/luna-pm-host-adapter.mjs';
import {
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
} from '../mcp/v3/git-authority.mjs';

test('invented cancel archive and pin tools never become host calls', () => {
  for (const tool of ['cancel_thread', 'archive_thread', 'pin_thread']) {
    const result = validateHostCall({ tool, threadId: 'thr_1' });
    assert.equal(result.ok, false, tool);
    assert.equal(result.code, 'fictional_host_alias', tool);
    assert.equal(result.cancellation_supported, false);
    assert.equal(result.invokes_host_callbacks, false);
    assert.equal(hostArgs({ tool, threadId: 'thr_1' }), null, tool);
  }
  const detected = detectHostTaskTools(['cancel_thread', 'archive_thread', 'pin_thread']);
  assert.equal(detected.complete, false);
  assert.equal(detected.cancellation_supported, false);
  assert.ok(detected.rejected_aliases.includes('cancel_thread'));
  assert.equal(detected.invokes_host_callbacks, false);
});

test('create_thread without threadId or clientThreadId cannot bind', () => {
  assert.equal(bindCreateThreadResult({ id: 'synthesized' }).ok, false);
  assert.equal(bindCreateThreadResult({ thread_id: 'thr_snake' }).ok, false);
  assert.equal(bindCreateThreadResult({ threadId: '' }).code, 'wrong_thread_identity');
  assert.equal(bindCreateThreadResult(null).code, 'wrong_thread_identity');
});

test('wait_threads rejects missing threadId, invalid cursor, or unbounded timeout', () => {
  assert.equal(planWaitThreads({
    hostId: 'codex-desktop', afterCursor: '0', timeoutMs: 15_000,
  }).ok, false);
  assert.equal(planWaitThreads({
    threadId: 'thr_1', timeoutMs: 15_000,
  }).ok, true);
  assert.equal(planWaitThreads({
    threadId: 'thr_1', hostId: 'codex-desktop', afterCursor: 'abc',
  }).code, 'stale_event');
  assert.equal(planWaitThreads({
    threadId: 'thr_1', hostId: 'codex-desktop', afterCursor: '0', timeoutMs: 99_000,
  }).code, 'timeout_out_of_range');
});

test('send_message_to_thread rejects empty or oversized prompt bodies', () => {
  assert.equal(planSendMessageToThread({ threadId: 'thr_1', prompt: '' }).code, 'missing_prompt_body');
  assert.equal(planSendMessageToThread({
    threadId: 'thr_1', prompt: 'x'.repeat(5_000),
  }).code, 'prompt_over_bound');
});

test('setup_pending create results never materialize send or wait calls', () => {
  const pending = materializeBoundCalls([
    { tool: 'create_thread', model: 'luna-max' },
    { tool: 'send_message_to_thread', bind_created_thread: true, prompt: 'hello' },
    { tool: 'wait_threads', bind_created_thread: true, afterCursor: '0', timeoutMs: 15_000 },
  ], { clientThreadId: 'client_only' });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'setup_pending');
  assert.equal(pending.action, 'resume_needed');
  assert.equal(pending.host_calls.length, 0);
  assert.equal(pending.invokes_host_callbacks, false);
});

test('message git overrides cannot force-push merge rebase tag release or delete refs', () => {
  for (const operation of [
    'force_push', 'merge', 'merge_pr', 'rebase', 'tag_create', 'release_create', 'delete_ref',
  ]) {
    const denied = denyMessageGitOverride({
      schema: GIT_AUTHORITY_SCHEMA_ID,
      version: GIT_AUTHORITY_VERSION,
      operation,
    });
    assert.equal(denied.ok, false, operation);
    assert.equal(denied.code, 'git_override_denied', operation);
  }
});
