import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectExactProcessBoundary,
  PROCESS_BOUNDARY_STATES,
  stopExactProcessBoundary,
} from '../mcp/v3/process-boundary.mjs';
import {
  classifySupervisorTerminalReceipt,
  cleanupLocalTaskLifecycle,
  projectSupervisorPublicState,
  projectSupervisorTerminalReceipt,
  settleLocalTaskLifecycle,
  supervisorStatus,
  taskStatus,
} from '../mcp/v3/supervisor.mjs';
import { createTask, readRuntimeRecord, readTask, writeRuntimeRecord } from '../mcp/v3/task-store.mjs';
import {
  createBoundaryHarness,
  gitSnapshot,
  incidentOneRuntime,
  incidentTwoRuntime,
  INCIDENT_1_TASK_ID,
  INCIDENT_2_TASK_ID,
  lifecycleReceipt,
  lockInspectReceipt,
  OTHER_UNIT,
  SHA,
  terminalTaskRecord,
} from './fixtures/r1-terminal-boundary-lifecycle-fixtures.mjs';

function lifecycleKeys(value) {
  return Object.keys(value);
}

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-lifecycle-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function storeTerminal(root, record, runtime) {
  await mkdir(record.cwd, { recursive: true });
  const stored = await createTask({
    root,
    prompt: 'keep this prompt private',
    record,
  });
  if (runtime) await writeRuntimeRecord(root, record.id, runtime);
  return stored;
}

function lockExecute(task, worktreePath, { inspect, clean } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (command, args) => {
      calls.push([command, args]);
      if (command === 'git') return { stdout: `${SHA}\n` };
      if (args[0] === 'lock' && args[1] === 'inspect') {
        if (typeof inspect === 'function') return inspect(args);
        return { stdout: JSON.stringify(inspect ?? lockInspectReceipt({ task: task.worktree_task ?? task.id, worktreePath, branch: task.branch, wrapperPid: 4242, startTicks: '100' })) };
      }
      if (args[0] === 'lock' && args[1] === 'clean') {
        if (typeof clean === 'function') return clean(args);
        return { stdout: JSON.stringify({ state: 'unlocked', cleaned: true, lock_id: args.at(-1) }) };
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    },
  };
}

function settleDeps(harness, extra = {}) {
  const snapshot = extra.git ?? gitSnapshot({ branch: extra.branch ?? 'codex/lifecycle-one' });
  return {
    adapter: harness.adapter,
    inspectBoundary: extra.inspectBoundary,
    stopExactBoundary: extra.stopExactBoundary,
    drainGraceMs: 0,
    sleep: async () => {},
    snapshotGit: extra.snapshotGit ?? (async () => snapshot),
    snapshotUnits: extra.snapshotUnits ?? (async () => structuredClone(harness.state.unrelated)),
    execute: extra.execute,
    ...extra,
  };
}

test('inspectExactProcessBoundary exposes only the tri-state vocabulary', async () => {
  const harness = createBoundaryHarness();
  const active = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(PROCESS_BOUNDARY_STATES.includes(active.state), true);
  assert.equal(active.state, 'active');
  assert.equal(active.stop_allowed, true);

  harness.state.activeState = 'inactive';
  harness.state.populated = false;
  const empty = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(empty.state, 'inactive_empty');
  assert.equal(empty.stop_allowed, false);
});

test('T2 unreadable /proc is unknown and refuses stop', async () => {
  const harness = createBoundaryHarness({ procErrors: { 4242: 'EPERM' } });
  const inspection = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(inspection.state, 'unknown');
  assert.equal(inspection.stop_allowed, false);
  assert.equal(inspection.code, 'worker_boundary_pid_visibility_unknown');
  await assert.rejects(
    stopExactProcessBoundary(harness.receipt, { adapter: harness.adapter, expectedLeader: harness.leader, timeoutMs: 100 }),
    (error) => error.code === 'worker_boundary_pid_visibility_unknown',
  );
  assert.equal(harness.state.actions.some((args) => args[1] === 'stop' || args.includes('stop')), false);
});

test('identity mismatch never stops another unit', async () => {
  const harness = createBoundaryHarness({ invocationId: 'ffffffffffffffffffffffffffffffff' });
  const inspection = await inspectExactProcessBoundary(harness.receipt, {
    adapter: harness.adapter,
    expectedLeader: harness.leader,
  });
  assert.equal(inspection.state, 'unknown');
  assert.equal(inspection.code, 'worker_boundary_identity_mismatch');
  await assert.rejects(
    stopExactProcessBoundary(harness.receipt, { adapter: harness.adapter, expectedLeader: harness.leader, timeoutMs: 100 }),
    (error) => error.code === 'worker_boundary_identity_mismatch',
  );
  assert.equal(harness.state.stopCalls, 0);
  assert.equal(harness.state.actions.some((args) => args.includes(OTHER_UNIT) && args[1] === 'stop'), false);
});

test('T1 completed receipt plus populated cgroup does not project succeeded', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness();
    const taskRecord = terminalTaskRecord({ id: 't1-live', cwd, worktree_task: 't1-live' });
    await storeTerminal(root, taskRecord, {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    });
    const { execute, calls } = lockExecute(taskRecord, cwd);
    const inspected = await taskStatus(root, 't1-live', settleDeps(harness, {
      execute,
      snapshotUnits: async () => null,
    }));
    assert.notEqual(inspected.state, 'succeeded');
    assert.equal(inspected.state, 'transport_lost');
    assert.equal(inspected.task.status, 'transport_lost');
    assert.equal(inspected.task.result, undefined);
    assert.equal(inspected.task.handoff, undefined);
    assert.equal(inspected.task.finished_at, undefined);
    assert.equal(inspected.task.stop_reason, undefined);
    assert.doesNotMatch(JSON.stringify(inspected), /keep this prompt private/u);
    const stored = (await readTask(root, 't1-live')).task;
    assert.equal(stored.status, 'completed');
    assert.equal(stored.result, 'ok');
    assert.equal(stored.cleanup.status, 'unknown');
    assert.equal(harness.state.populated, true);
    assert.equal(harness.state.stopCalls, 0);
    assert.equal(calls.some((entry) => entry[1]?.[1] === 'clean'), false);
  });
});

test('incident 1: namespace-abandoned live lock is not cleaned until exact empty proof', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const runtime = incidentOneRuntime();
    const harness = createBoundaryHarness({
      receipt: runtime.process_boundary,
      leaderPid: runtime.pid,
      workerPid: 1818350,
      startTicks: runtime.process_start_ticks,
      workerTicks: '579125378',
    });
    const taskRecord = terminalTaskRecord({
      id: INCIDENT_1_TASK_ID,
      cwd,
      branch: 'codex/r1-w25b-rtruth-server-tasks-classifier-repair-grok-20260825',
      worktree_task: INCIDENT_1_TASK_ID,
    });
    await storeTerminal(root, taskRecord, runtime);
    let cleanedBeforeEmpty = false;
    const { execute, calls } = lockExecute(taskRecord, cwd, {
      inspect: lockInspectReceipt({
        task: INCIDENT_1_TASK_ID,
        worktreePath: cwd,
        branch: taskRecord.branch,
        wrapperPid: runtime.pid,
        startTicks: runtime.process_start_ticks,
      }),
      clean: (args) => {
        if (harness.state.populated) cleanedBeforeEmpty = true;
        return { stdout: JSON.stringify({ state: 'unlocked', lock_id: args.at(-1) }) };
      },
    });
    const first = await settleLocalTaskLifecycle(root, (await readTask(root, INCIDENT_1_TASK_ID)).task, runtime, settleDeps(harness, {
      execute,
      git: gitSnapshot({ branch: taskRecord.branch }),
    }));
    assert.equal(first.final, true);
    assert.equal(first.cleanup, 'recovered');
    assert.equal(first.boundary, 'inactive_empty');
    assert.equal(first.lock, 'cleaned');
    assert.deepEqual(lifecycleKeys(first), [
      'version', 'task_id', 'stored_status', 'projected_status', 'public_state', 'final', 'cleanup', 'boundary', 'lock', 'reason',
    ]);
    assert.equal(cleanedBeforeEmpty, false);
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(calls.filter((entry) => entry[1]?.[1] === 'clean').length, 1);
    const projected = projectSupervisorTerminalReceipt((await readTask(root, INCIDENT_1_TASK_ID)).task);
    assert.equal(projectSupervisorPublicState((await readTask(root, INCIDENT_1_TASK_ID)).task), 'succeeded');
    assert.equal(projected.status, 'completed');
    assert.equal(projected.result, 'ok');
    const second = await cleanupLocalTaskLifecycle(root, (await readTask(root, INCIDENT_1_TASK_ID)).task, runtime, settleDeps(harness, { execute }));
    assert.equal(second.cleanup, 'recovered');
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(calls.filter((entry) => entry[1]?.[1] === 'clean').length, 1);
  });
});

test('incident 2: second host reproduction recovers only the exact unit', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const runtime = incidentTwoRuntime();
    const harness = createBoundaryHarness({
      receipt: runtime.process_boundary,
      leaderPid: runtime.pid,
      workerPid: 2394670,
      startTicks: runtime.process_start_ticks,
      workerTicks: '579387336',
    });
    const taskRecord = terminalTaskRecord({
      id: INCIDENT_2_TASK_ID,
      cwd,
      branch: 'codex/r1-w25b-rtruth-task-store-filter-final-closure-grok-20260825',
      worktree_task: INCIDENT_2_TASK_ID,
    });
    await storeTerminal(root, taskRecord, runtime);
    const { execute } = lockExecute(taskRecord, cwd, {
      inspect: lockInspectReceipt({
        task: INCIDENT_2_TASK_ID,
        lockId: 'b85a6979d2c04cf1887c526be640dfa4',
        worktreePath: cwd,
        branch: taskRecord.branch,
        wrapperPid: runtime.pid,
        startTicks: runtime.process_start_ticks,
      }),
    });
    const settled = await settleLocalTaskLifecycle(root, (await readTask(root, INCIDENT_2_TASK_ID)).task, runtime, settleDeps(harness, {
      execute,
      git: gitSnapshot({ branch: taskRecord.branch }),
    }));
    assert.equal(settled.final, true);
    assert.equal(settled.stored_status, 'completed');
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(harness.state.actions.some((args) => args.includes(OTHER_UNIT) && args[1] === 'stop'), false);
    assert.equal((await readTask(root, INCIDENT_2_TASK_ID)).task.status, 'completed');
  });
});

test('T3 cleanup refusal records a content-free exit-code class', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness({ activeState: 'inactive', populated: false });
    const taskRecord = terminalTaskRecord({ id: 't3-lock', cwd, worktree_task: 't3-lock' });
    const runtime = {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    };
    await storeTerminal(root, taskRecord, runtime);
    const { execute } = lockExecute(taskRecord, cwd, {
      inspect: lockInspectReceipt({
        task: 't3-lock',
        worktreePath: cwd,
        branch: taskRecord.branch,
        wrapperPid: 4242,
        startTicks: '100',
      }),
      clean: () => {
        throw Object.assign(new Error('dead-local policy does not apply: active'), { status: 5 });
      },
    });
    const settled = await settleLocalTaskLifecycle(root, (await readTask(root, 't3-lock')).task, runtime, settleDeps(harness, { execute }));
    assert.equal(settled.final, false);
    assert.equal(settled.lock, 'unknown');
    const events = await readFile(path.join(root, 'tasks', 't3-lock', 'events.jsonl'), 'utf8');
    assert.match(events, /"exit_code_class":"exit_5"/u);
    assert.doesNotMatch(events, /dead-local policy does not apply/u);
    assert.doesNotMatch(events, /keep this prompt private/u);
  });
});

test('T4 exact stop failure records cgroup_not_empty verbatim', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness();
    const taskRecord = terminalTaskRecord({ id: 't4-empty', cwd, worktree_task: 't4-empty' });
    const runtime = {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    };
    await storeTerminal(root, taskRecord, runtime);
    const { execute } = lockExecute(taskRecord, cwd);
    const settled = await settleLocalTaskLifecycle(root, (await readTask(root, 't4-empty')).task, runtime, settleDeps(harness, {
      execute,
      stopExactBoundary: async () => {
        throw Object.assign(new Error('Owned systemd process boundary still has descendants after exact unit stop.'), { code: 'cgroup_not_empty' });
      },
    }));
    assert.equal(settled.final, false);
    assert.equal(settled.reason, 'boundary_not_empty');
    const stored = (await readTask(root, 't4-empty')).task;
    assert.equal(stored.status, 'completed');
    assert.equal(stored.cleanup.code, 'cgroup_not_empty');
    const events = await readFile(path.join(root, 'tasks', 't4-empty', 'events.jsonl'), 'utf8');
    assert.match(events, /"code":"cgroup_not_empty"/u);
    assert.match(events, /"forced":true/u);
  });
});

test('T5 dead-local clean is refused without inactive_empty proof', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness({ procErrors: { 4300: 'EPERM' } });
    const taskRecord = terminalTaskRecord({ id: 't5-unknown', cwd, worktree_task: 't5-unknown' });
    const runtime = {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    };
    await storeTerminal(root, taskRecord, runtime);
    const { execute, calls } = lockExecute(taskRecord, cwd);
    const settled = await settleLocalTaskLifecycle(root, (await readTask(root, 't5-unknown')).task, runtime, settleDeps(harness, { execute }));
    assert.equal(settled.final, false);
    assert.equal(settled.boundary, 'unknown');
    assert.equal(settled.public_state, 'transport_lost');
    assert.equal(harness.state.stopCalls, 0);
    assert.equal(calls.some((entry) => entry[1]?.[1] === 'clean'), false);
    const classified = classifySupervisorTerminalReceipt((await readTask(root, 't5-unknown')).task);
    assert.equal(classified.projected_status, 'transport_lost');
    assert.equal(classified.corrected, false);
  });
});

test('T6 post-terminal writes are additive and leave stored status immutable', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness();
    const taskRecord = terminalTaskRecord({
      id: 't6-immutable',
      cwd,
      result: 'ok',
      finished_at: '2026-08-25T21:16:29.745Z',
    });
    const runtime = {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    };
    const { paths } = await storeTerminal(root, taskRecord, runtime);
    const before = JSON.parse(await readFile(paths.record, 'utf8'));
    const { execute } = lockExecute(taskRecord, cwd);
    await settleLocalTaskLifecycle(root, (await readTask(root, 't6-immutable')).task, runtime, settleDeps(harness, { execute }));
    const after = JSON.parse(await readFile(paths.record, 'utf8'));
    assert.equal(after.status, 'completed');
    assert.equal(after.schema, 'codex-co-engineer.task.v1');
    assert.equal(after.result, before.result);
    assert.equal(after.finished_at, before.finished_at);
    assert.equal(after.stop_reason, before.stop_reason);
    assert.equal(typeof after.cleanup, 'object');
    assert.notEqual(after.revision, before.revision);
  });
});

test('T7 repeated settlement is idempotent and stops at most once', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness();
    const taskRecord = terminalTaskRecord({ id: 't7-once', cwd, worktree_task: 't7-once' });
    const runtime = {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    };
    await storeTerminal(root, taskRecord, runtime);
    const { execute, calls } = lockExecute(taskRecord, cwd);
    const deps = settleDeps(harness, { execute });
    const first = await settleLocalTaskLifecycle(root, (await readTask(root, 't7-once')).task, runtime, deps);
    const second = await settleLocalTaskLifecycle(root, (await readTask(root, 't7-once')).task, await readRuntimeRecord(root, 't7-once'), deps);
    const third = await cleanupLocalTaskLifecycle(root, (await readTask(root, 't7-once')).task, await readRuntimeRecord(root, 't7-once'), deps);
    assert.equal(first.final, true);
    assert.equal(second.final, true);
    assert.equal(third.cleanup, first.cleanup);
    assert.equal(harness.state.stopCalls, 1);
    assert.equal(calls.filter((entry) => entry[1]?.[1] === 'clean').length, 1);
  });
});

test('R-TRUTH classifier runs only after lifecycle finality', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    const harness = createBoundaryHarness();
    const taskRecord = terminalTaskRecord({
      id: 'rtruth-after-final',
      cwd,
      result: 'RetriableError [unavailable] PING timed out',
    });
    const runtime = {
      pid: 4242,
      process_start_ticks: '100',
      command: 'worktree-bootstrap',
      process_boundary: harness.receipt,
    };
    await storeTerminal(root, taskRecord, runtime);
    const pending = classifySupervisorTerminalReceipt({
      ...taskRecord,
      cleanup: { status: 'pending', boundary: 'active', lock: 'active', code: 'worker_boundary_pending' },
    });
    assert.equal(pending.projected_status, 'transport_lost');
    assert.equal(pending.public_state, 'transport_lost');
    assert.equal(pending.corrected, false);
    const projectedPending = projectSupervisorTerminalReceipt({
      ...taskRecord,
      cleanup: { status: 'pending', boundary: 'active', lock: 'active', code: 'worker_boundary_pending' },
    });
    assert.equal(projectedPending.result, undefined);
    assert.equal(projectedPending.finished_at, undefined);
    const { execute } = lockExecute(taskRecord, cwd);
    const settled = await settleLocalTaskLifecycle(root, (await readTask(root, 'rtruth-after-final')).task, runtime, settleDeps(harness, { execute }));
    assert.equal(settled.final, true);
    assert.equal(settled.projected_status, 'failed');
    assert.equal(settled.public_state, 'failed');
    assert.equal((await readTask(root, 'rtruth-after-final')).task.status, 'completed');
    const status = await supervisorStatus(root, {
      probeBoundary: async () => ({ ready: true, status: 'prerequisites_ready', provider_started: false }),
      readProviderReadiness: async () => ({
        grok: { installed: true, ready: true, transport: 'acp' },
        'cursor-local': { installed: true, ready: true, transport: 'acp' },
        dsh: { installed: true, ready: true, transport: 'acpx' },
        'cursor-cloud': { installed: true, ready: true, transport: 'cursor-sdk' },
      }),
      adapter: harness.adapter,
      drainGraceMs: 0,
      sleep: async () => {},
      snapshotGit: async () => gitSnapshot(),
      snapshotUnits: async () => structuredClone(harness.state.unrelated),
      execute,
    });
    assert.equal(status.tasks[0].status, 'failed');
    assert.equal(status.tasks[0].error.code, 'completed_with_terminal_error');
  });
});

test('legacy terminal receipts without a local boundary stay on the R-TRUTH seam', async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, 'worktree');
    await storeTerminal(root, terminalTaskRecord({
      id: 'legacy-no-boundary',
      cwd,
      workspace_kind: 'direct',
      result: 'ok',
    }));
    const inspected = await taskStatus(root, 'legacy-no-boundary');
    assert.equal(inspected.state, 'succeeded');
    assert.equal((await readTask(root, 'legacy-no-boundary')).task.cleanup, undefined);
  });
});
