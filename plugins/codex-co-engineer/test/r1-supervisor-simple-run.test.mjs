import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisorRunToolAdapter, submitTask } from '../mcp/v3/supervisor.mjs';
import { createTask, updateTask } from '../mcp/v3/task-store.mjs';
import { parseChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  compileRunRequestV1,
  RUN_REQUEST_DEFAULT_CAPABILITIES,
} from '../mcp/v3/run-request-compiler.mjs';

const BASE_SHA = 'a'.repeat(40);
const OBSERVED = Object.freeze({
  base_sha: BASE_SHA,
  head_sha: BASE_SHA,
  tree_sha: 'b'.repeat(40),
  branch: 'main',
  clean: true,
  remote_present: true,
  remote_count: 1,
});

function request() {
  return {
    run_id: 'simple-supervisor',
    repo: '/tmp/fixture-repo',
    objective: 'Exercise the supervisor simple-run adapter.',
    assignments: [{
      assignment_id: 'implementation',
      provider: 'grok',
      role: 'implement',
      access: 'write',
      prompt: 'Implement the bounded slice.',
      expected_duration_ms: 60_000,
    }],
  };
}


test('default simple dispatch sends the compiled envelope with native workspace guidance and pins its workspace base', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-simple-dispatch-contract-'));
  const calls = [];
  try {
    const adapter = await createSupervisorRunToolAdapter({
      root,
      inProcess: true,
      execute: async () => ({ stdout: '' }),
      compile: (value) => compileRunRequestV1(value, { observeGit: async () => OBSERVED }),
      requestConsent: async () => ({ approved: true }),
      providerReady: async () => ({ ready: true }),
      processBoundaryReady: async () => ({ ready: true }),
      verifyRepository: async () => ({ verified: true }),
      prepareWorkspace: async ({ assignment }) => ({
        prepared: true,
        workspace: {
          task: assignment.task_id,
          status: 'ready',
          worktree_path: '/tmp/' + assignment.task_id,
          branch: 'codex/' + assignment.assignment_id,
          start_sha: BASE_SHA,
        },
      }),
      submitTask: async (input, dependencies) => {
        calls.push({ input, dependencies });
        return { task: { id: input.task_id } };
      },
      waitForDispatchEvidence: async (_stateRoot, taskId) => ({
        dispatched: true,
        prompt_dispatched: true,
        confidence: 'authoritative',
        session_ready: true,
        session_id: taskId + '-session',
        cursor: '0',
      }),
    });

    const submitted = await adapter.dispatch('delegate', { run_request: request() });
    assert.equal(submitted.phase, 'running');
    assert.equal(calls.length, 1);

    const compiled = await compileRunRequestV1(request(), { observeGit: async () => OBSERVED });
    const call = calls[0];
    const envelope = parseChildEnvelopeV1(call.input.prompt);
    assert.equal(call.input.run_id, 'simple-supervisor');
    assert.equal(call.input.assignment_id, 'implementation');
    assert.equal(call.input.provider, 'grok');
    assert.equal(call.input.model, 'grok-4');
    assert.equal(call.input.access, 'writer');
    assert.deepEqual(call.input.write_scope, ['**']);
    assert.deepEqual(call.input.capabilities, [...RUN_REQUEST_DEFAULT_CAPABILITIES]);
    assert.equal(call.input.child_envelope_digest, compiled.assignments[0].prompt_envelope_digest);
    assert.equal(call.input.prompt, compiled.assignments[0].child_envelope.envelope_text);
    assert.match(call.input.prompt, /^repository_path: \/tmp\/fixture-repo$/mu);
    assert.match(call.input.prompt, /^provider_workspace: work only in the current working directory \(assigned worktree\); repository_path is source identity, not a navigation target$/mu);
    assert.match(call.input.prompt, /^provider_guidance: .*honor an exact requested output and format exactly; required_evidence labels are controller metadata, not worker response sections; omit routine progress narration and repeated identity or report blocks unless the task prompt requests them, while surfacing blockers and necessary questions; do not seek receipt artifacts because the controller owns lifecycle and machine receipts$/mu);
    assert.equal(envelope.prompt, 'Implement the bounded slice.');
    assert.equal(envelope.execution.provider, 'grok');
    assert.equal(envelope.execution.model, 'grok-4');
    assert.equal(envelope.role, 'implement');
    assert.equal(envelope.access, 'writer');
    assert.deepEqual(envelope.write_scope, ['**']);
    assert.equal(call.dependencies.baseSha, BASE_SHA);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported live model overrides fail before task submission', async () => {
  await assert.rejects(
    submitTask({
      task_id: 'unsupported-model',
      provider: 'grok',
      model: 'grok/custom',
      repo: '/repo',
      prompt: 'must not dispatch',
    }),
    (error) => error.code === 'model_unattested',
  );
});

test('run request reports an actionable incomplete-runtime failure before workspace preparation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-run-runtime-preflight-'));
  const calls = [];
  try {
    const adapter = await createSupervisorRunToolAdapter({
      root,
      inProcess: true,
      compile: (value) => compileRunRequestV1(value, { observeGit: async () => OBSERVED }),
      requestConsent: async () => ({ approved: true }),
      preflightRuntime: async (provider) => {
        calls.push(['runtime', provider]);
        throw Object.assign(new Error('/deleted/cache/acp-worker.mjs?token=secret'), {
          code: 'runtime_install_incomplete',
        });
      },
      processBoundaryReady: async () => { calls.push(['boundary']); return { ready: true }; },
      verifyRepository: async () => { calls.push(['repository']); return { verified: true }; },
      prepareWorkspace: async () => { calls.push(['workspace']); throw new Error('must not prepare'); },
      createSession: async () => { calls.push(['session']); throw new Error('must not create session'); },
      dispatchPrompt: async () => { calls.push(['prompt']); throw new Error('must not dispatch'); },
    });

    const receipt = await adapter.dispatch('delegate', { run_request: request() });
    assert.equal(receipt.phase, 'failed');
    assert.equal(receipt.error.code, 'runtime_install_incomplete');
    assert.equal(receipt.error.message, 'The installed Codex-Co-Engineer runtime is incomplete. Reinstall the plugin, then restart Codex.');
    assert.equal(receipt.lanes[0].error.code, 'runtime_install_incomplete');
    assert.notEqual(receipt.lanes[0].prepared, true);
    assert.equal(receipt.lanes[0].prompt_dispatched, false);
    assert.deepEqual(calls, [['runtime', 'grok']]);
    assert.doesNotMatch(JSON.stringify(receipt), /deleted|cache|token|PRIVATE_PROMPT/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor wires run_request through admission while preserving bounded receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-simple-run-'));
  const calls = [];
  try {
    const adapterOptions = {
      root,
      inProcess: true,
      compile: (value) => compileRunRequestV1(value, { observeGit: async () => OBSERVED }),
      requestConsent: async () => ({ approved: true }),
      providerReady: async () => ({ ready: true }),
      processBoundaryReady: async () => ({ ready: true }),
      verifyRepository: async () => ({ verified: true }),
      prepareWorkspace: async ({ assignment }) => ({
        prepared: true,
        workspace: {
          task: assignment.task_id,
          status: 'ready',
          worktree_path: `/tmp/${assignment.task_id}`,
          branch: `codex/${assignment.assignment_id}`,
          start_sha: BASE_SHA,
        },
      }),
      createSession: async ({ assignment }) => ({ ready: true, session_id: `${assignment.task_id}-session` }),
      dispatchPrompt: async ({ assignment }) => {
        calls.push(assignment.assignment_id);
        return {
          dispatched: true,
          confidence: 'authoritative',
          session_ready: true,
          session_id: `${assignment.task_id}-session`,
          cursor: '0',
        };
      },
      inspectLane: async () => ({ status: 'running', cursor: '0' }),
      cancelLane: async () => ({ confirmed: true, cancelled: true }),
      inspectWorkspace: async () => ({ current_head: BASE_SHA, clean: true, changed_files: [], commits: [] }),
    };
    const adapter = await createSupervisorRunToolAdapter(adapterOptions);

    const submitted = await adapter.dispatch('delegate', { run_request: request() });
    assert.equal(submitted.mode, 'run');
    assert.equal(submitted.phase, 'running');
    assert.equal(submitted.authoritative_required_dispatch, true);
    assert.equal(submitted.lanes[0].prompt_dispatched, true);
    assert.deepEqual(calls, ['implementation']);
    assert.equal(JSON.stringify(submitted).includes('Implement the bounded slice.'), false);

    const status = await adapter.dispatch('task', { run_id: 'simple-supervisor' });
    assert.equal(status.phase, 'running');
    assert.equal(status.lanes[0].prompt_dispatched, true);
    assert.equal(Object.hasOwn(status, 'telemetry'), false);

    const restarted = await createSupervisorRunToolAdapter(adapterOptions);
    const recovered = await restarted.dispatch('task', { run_id: 'simple-supervisor' });
    assert.equal(recovered.phase, 'running');
    assert.equal(calls.length, 1, 'a restarted adapter must not dispatch the prompt again');

    const waited = await adapter.dispatch('tasks', {
      run_id: 'simple-supervisor',
      wait_until: 'decision_or_attention',
      wait_ms: 0,
    });
    assert.equal(waited.phase, 'running');

    const cancelled = await adapter.dispatch('cancel', { run_id: 'simple-supervisor' });
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.lanes[0].status, 'cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production supervisor observation carries a safe provider failure into the native run receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-provider-error-'));
  let dispatches = 0;
  try {
    const adapter = await createSupervisorRunToolAdapter({
      root,
      inProcess: true,
      compile: (value) => compileRunRequestV1(value, { observeGit: async () => OBSERVED }),
      requestConsent: async () => ({ approved: true }),
      providerReady: async () => ({ ready: true }),
      processBoundaryReady: async () => ({ ready: true }),
      verifyRepository: async () => ({ verified: true }),
      prepareWorkspace: async ({ assignment }) => ({
        prepared: true,
        workspace: { task: assignment.task_id, worktree_path: root, branch: 'codex/provider-error', start_sha: BASE_SHA },
      }),
      createSession: async () => ({ ready: true, session_id: 'provider-error-session' }),
      dispatchPrompt: async ({ assignment }) => {
        dispatches += 1;
        await createTask({
          root,
          prompt: 'PRIVATE_PROMPT',
          record: {
            id: assignment.task_id, provider: 'dsh', status: 'failed', cwd: root,
            workspace_kind: 'direct', prompt_dispatched: true,
            error: { code: 'provider_billing_required', message: 'PRIVATE_CREDENTIAL' },
          },
        });
        return { dispatched: true, confidence: 'authoritative', cursor: '0' };
      },
      inspectWorkspace: async () => ({ current_head: BASE_SHA, clean: true, changed_files: [], commits: [] }),
    });
    await adapter.dispatch('delegate', { run_request: request() });
    const receipt = await adapter.dispatch('task', { run_id: 'simple-supervisor' });
    assert.equal(receipt.phase, 'degraded');
    assert.equal(receipt.lanes[0].error.code, 'provider_billing_required');
    assert.match(receipt.lanes[0].error.message, /billing/);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_PROMPT|PRIVATE_CREDENTIAL/);
    await adapter.dispatch('task', { run_id: 'simple-supervisor' });
    assert.equal(dispatches, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production dispatch wait keeps a delayed acknowledgement active and reconciles late success without replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-delayed-dispatch-'));
  let now = 0;
  let dispatches = 0;
  let taskId;
  try {
    const adapter = await createSupervisorRunToolAdapter({
      root,
      inProcess: true,
      execute: async () => ({ stdout: '' }),
      compile: (value) => compileRunRequestV1(value, { observeGit: async () => OBSERVED }),
      requestConsent: async () => ({ approved: true }),
      providerReady: async () => ({ ready: true }),
      processBoundaryReady: async () => ({ ready: true }),
      verifyRepository: async () => ({ verified: true }),
      prepareWorkspace: async ({ assignment }) => ({
        prepared: true,
        workspace: {
          task: assignment.task_id,
          status: 'ready',
          worktree_path: root,
          branch: 'codex/delayed-dispatch',
          start_sha: BASE_SHA,
        },
      }),
      submitTask: async (input) => {
        dispatches += 1;
        taskId = input.task_id;
        return createTask({
          root,
          prompt: 'PRIVATE_PROMPT',
          record: {
            id: input.task_id,
            provider: 'dsh',
            status: 'running',
            cwd: root,
            workspace_kind: 'direct',
            dispatch_intent: true,
            dispatch_uncertain: true,
            prompt_dispatched: false,
            provider_run_id: 'delayed-session',
          },
        });
      },
      dispatchEvidenceTimeoutMs: 5_000,
      dispatchEvidenceNow: () => now,
      dispatchEvidenceSleep: async (milliseconds) => { now += milliseconds; },
      inspectWorkspace: async () => ({
        current_head: BASE_SHA,
        clean: true,
        changed_files: [],
        commits: [],
      }),
    });

    const pending = await adapter.dispatch('delegate', { run_request: request() });
    assert.equal(now, 5_000, 'the bounded wait elapsed without terminating the lane');
    assert.equal(pending.phase, 'dispatching');
    assert.equal(pending.lanes[0].status, 'session_ready');
    assert.equal(pending.lanes[0].prompt_dispatched, false);
    assert.equal(pending.lanes[0].dispatch_confidence, 'uncertain');
    assert.equal(dispatches, 1);

    await updateTask(root, taskId, {
      status: 'completed',
      prompt_dispatched: true,
      dispatch_evidence: 'authoritative',
      dispatch_uncertain: false,
      result: { summary: 'late success' },
    });
    const completed = await adapter.dispatch('task', { run_id: 'simple-supervisor' });
    assert.equal(completed.phase, 'completed');
    assert.equal(completed.lanes[0].prompt_dispatched, true);
    assert.deepEqual(completed.lanes[0].result, { summary: 'late success' });
    assert.equal(dispatches, 1, 'late success must reconcile the original task without replay');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
