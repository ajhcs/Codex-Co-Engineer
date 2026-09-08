import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSupervisorRunToolAdapter } from '../mcp/v3/supervisor.mjs';
import { createTask, taskPaths } from '../mcp/v3/task-store.mjs';

const REVIEW = 'Fixture review completed: the documented launch flow is clear.';

async function fixture(exercise, taskFields = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cce-native-lifecycle-'));
  const repo = path.join(directory, 'repository');
  const root = path.join(directory, 'state');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '--quiet');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Synthetic repository.\n');
  git('add', 'README.md');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture');
  const base = git('rev-parse', 'HEAD').toString().trim();
  let dispatches = 0;
  const options = {
    root,
    requestConsent: async () => ({ approved: true }),
    providerReady: async () => ({ ready: true }),
    processBoundaryReady: async () => ({ ready: true }),
    prepareWorkspace: async ({ assignment }) => ({ prepared: true, workspace: {
      task: assignment.task_id, worktree_path: repo, branch: 'fixture', start_sha: base,
    } }),
    // Simulate the provider boundary only. Inspection, reconciliation, task-store
    // reads, output projection and durable reopening use the production bridge.
    dispatchPrompt: async ({ assignment }) => {
      dispatches += 1;
      await createTask({ root, prompt: 'Synthetic review request.', record: {
        id: assignment.task_id, provider: 'cursor-local', role: 'review',
        status: 'completed', prompt_dispatched: true, dispatch_evidence: 'authoritative',
        stop_reason: 'end_turn', finished_at: new Date().toISOString(),
        result: REVIEW, repo, start_sha: base, worktree_path: repo,
        ...taskFields,
      } });
      return { dispatched: true, confidence: 'authoritative', session_id: 'fixture-session' };
    },
  };
  try {
    const adapter = await createSupervisorRunToolAdapter(options);
    const submitted = await adapter.dispatch('delegate', { run_request: {
      run_id: 'native-lifecycle', repo, objective: 'Review a synthetic repository.',
      assignments: [{ assignment_id: 'review', provider: 'cursor-local', role: 'review',
        prompt: 'Read the README and report your assessment.', expected_duration_ms: 60000 }],
    } });
    await exercise({ adapter, options, submitted, root, dispatches: () => dispatches });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('native run returns actual task output through the production bridge and after restart', async () => {
  await fixture(async ({ adapter, options, submitted, dispatches }) => {
    const result = await adapter.dispatch('task', {
      run_id: submitted.run_id, cursor: submitted.cursor, wait_until: 'decision_or_attention', wait_ms: 0,
    });
    assert.equal(result.phase, 'completed');
    assert.ok(JSON.stringify(result).includes(REVIEW), 'normal run result must carry the provider answer');
    const reopened = await createSupervisorRunToolAdapter(options);
    const recovered = await reopened.dispatch('status', { run_id: submitted.run_id });
    assert.equal(recovered.phase, 'completed');
    assert.equal(recovered.cursor, result.cursor);
    assert.ok(JSON.stringify(recovered).includes(REVIEW));
    assert.equal(dispatches(), 1);
  });
});

test('an observation failure can recover the same task without another dispatch', async () => {
  await fixture(async ({ adapter, submitted, root, dispatches }) => {
    const record = taskPaths(root, submitted.lanes[0].task_id).record;
    const hidden = `${record}.temporarily-unavailable`;
    await rename(record, hidden);
    const uncertain = await adapter.dispatch('status', { run_id: submitted.run_id });
    assert.notEqual(uncertain.phase, 'completed');
    assert.equal(uncertain.blockers.verification, true);
    const uncertainDiagnostics = await adapter.dispatch('task', {
      run_id: submitted.run_id, view: 'diagnostics', wait_ms: 0,
    });
    assert.equal(uncertainDiagnostics.complete_candidate_blocked, true);
    await rename(hidden, record);
    const recovered = await adapter.dispatch('status', { run_id: submitted.run_id });
    assert.equal(recovered.phase, 'completed');
    assert.ok(JSON.stringify(recovered).includes(REVIEW));
    assert.equal(dispatches(), 1);
  });
});

for (const status of ['cancelled', 'failed', 'environment_blocked']) {
  test(`a required ${status} task cannot become a successful run`, async () => {
    await fixture(async ({ adapter, submitted, dispatches }) => {
      const result = await adapter.dispatch('status', { run_id: submitted.run_id });
      assert.notEqual(result.phase, 'completed');
      assert.equal(result.blockers.verification, true);
      assert.notEqual(result.candidate?.accepted, true);
      const expectedLaneStatus = status === 'cancelled' ? 'cancelled' : 'partial_handoff';
      assert.equal(result.lanes[0].status, expectedLaneStatus);
      const diagnostics = await adapter.dispatch('task', {
        run_id: submitted.run_id, view: 'diagnostics', wait_ms: 0,
      });
      assert.equal(diagnostics.complete_candidate_blocked, true);
      assert.equal(diagnostics.lanes[0].task_final, true);
      assert.equal(diagnostics.experience.card, 'final');
      assert.equal(dispatches(), 1);
    }, { status, result: null, stop_reason: status });
  });
}
