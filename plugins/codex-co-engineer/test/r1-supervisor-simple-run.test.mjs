import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisorRunToolAdapter } from '../mcp/v3/supervisor.mjs';
import { compileRunRequestV1 } from '../mcp/v3/run-request-compiler.mjs';

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
    assert.deepEqual(submitted.dispatched_assignment_ids, ['implementation']);
    assert.deepEqual(calls, ['implementation']);
    assert.equal(JSON.stringify(submitted).includes('Implement the bounded slice.'), false);

    const status = await adapter.dispatch('task', { run_id: 'simple-supervisor' });
    assert.equal(status.phase, 'running');
    assert.equal(status.lanes[0].session_ready, true);

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
