// Isolated P33 run-runtime fixtures. Tests own the assertions.
// Scoped stubs implement the frozen injected seams without importing
// scheduler, artifact-bridge, worker, process-boundary, or supervisor.

import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRunRuntime } from '../../mcp/v3/run-runtime.mjs';
import { RunContractV1Error } from '../../mcp/v3/run-manifest.mjs';
import { BASE_SHA } from './r1-protected-identity-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  RUN_ID,
  makePrivateRoot as makeStoreRoot,
  makeSubmission,
} from './r1-run-store-fixtures.mjs';

export { ASSIGNMENT_ID, BASE_SHA, RUN_ID, makeStoreRoot, makeSubmission };

export const TASK_ID = 'task-writer-0';
export const HOSTILE_SECRET = 'sk-live-ATTACKER-SECRET';
export const HOSTILE_PATH = '/tmp/hostile-repo';
export const HOSTILE_TOKEN = 'github_pat_hostile';
export const NOW = '2026-08-25T22:00:00Z';

export async function makePrivateRoot(prefix = 'r1-p33-runtime-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

export function makeAssignment({
  assignmentId = ASSIGNMENT_ID,
  taskId = TASK_ID,
  role = 'implement',
  access = 'writer',
  provider = 'grok',
  model = 'grok-4',
  writeScope = ['src/**'],
  required = true,
  startingRef = null,
} = {}) {
  const assignment = {
    assignment_id: assignmentId,
    task_id: taskId,
    role,
    access,
    provider,
    model,
    write_scope: writeScope,
    required,
  };
  if (startingRef !== null) assignment.starting_ref = startingRef;
  return assignment;
}

export function makeVerifier(assignmentId = 'review-lane') {
  return makeAssignment({
    assignmentId,
    taskId: `task-${assignmentId}`,
    role: 'review',
    access: 'read_only',
    writeScope: [],
    required: false,
  });
}

export function makeSubmitRequest({
  runId = RUN_ID,
  assignments = [makeAssignment()],
  submission = makeSubmission({ runId, assignmentId: assignments[0].assignment_id }),
} = {}) {
  return {
    run_id: runId,
    request_idempotency_key: submission.request_idempotency_key,
    identity: submission.identity,
    git: submission.git,
    provenance: submission.provenance,
    telemetry: submission.telemetry,
    assignments,
  };
}

function failStub(code, field, message) {
  throw new RunContractV1Error(code, field, message);
}

export function createMemoryRunStore() {
  const byId = new Map();
  const byKey = new Map();
  return {
    async submit(input) {
      const existing = byId.get(input.run_id);
      if (existing) {
        if (existing.request_idempotency_key !== input.request_idempotency_key
          || existing.identity?.digest !== input.identity?.digest) {
          failStub('run_identity_conflict', 'run_id', 'Run id already binds a different body.');
        }
        return { record: existing, created: false };
      }
      if (byKey.has(input.request_idempotency_key)) {
        failStub('run_idempotency_conflict', 'request_idempotency_key',
          'Request idempotency key already binds a different canonical body.');
      }
      const record = {
        schema: 'codex-co-engineer.run-store-record.v1',
        run_id: input.run_id,
        request_idempotency_key: input.request_idempotency_key,
        identity: input.identity,
        git: input.git,
        provenance: input.provenance,
        telemetry: input.telemetry,
        canonical_digest: input.request_idempotency_key,
      };
      byId.set(input.run_id, record);
      byKey.set(input.request_idempotency_key, input.run_id);
      return { record, created: true };
    },
    async getByRunId(runId) {
      const record = byId.get(runId);
      if (!record) failStub('run_store_not_found', 'run_id', 'No run record exists.');
      return record;
    },
    async getByIdempotencyKey(key) {
      const runId = byKey.get(key);
      if (!runId) failStub('run_store_not_found', 'request_idempotency_key', 'No run record exists.');
      return byId.get(runId);
    },
    _byId: byId,
  };
}

function emptyJournalState() {
  return {
    schema: 'codex-co-engineer.run-journal-state.v1',
    revision: 0,
    head_hash: 'codex-co-engineer.run-journal.genesis.v1',
    run_opened: false,
    children: [],
    child_count: 0,
    event_counts: {
      run_opened: 0, child_started: 0, child_progress: 0, child_artifact: 0,
      child_terminal: 0, run_terminal: 0,
    },
    artifacts_total: 0,
    artifact_bytes_total: 0,
    run_outcome: null,
    terminal: false,
  };
}

function createJournalHandle() {
  const events = [];
  const state = emptyJournalState();
  return {
    events,
    async currentState() {
      return { ...state, children: state.children.map((child) => ({ ...child })) };
    },
    async append(event) {
      const kind = event.kind;
      const data = event.data ?? {};
      if (kind === 'run_opened') state.run_opened = true;
      if (kind === 'child_started') {
        if (!state.children.some((child) => child.assignment_id === data.assignment_id)) {
          state.children.push({ assignment_id: data.assignment_id, outcome: null });
          state.child_count = state.children.length;
        }
      }
      if (kind === 'child_progress') {
        const child = state.children.find((row) => row.assignment_id === data.assignment_id);
        if (child) child.note = data.note;
      }
      if (kind === 'child_terminal') {
        const child = state.children.find((row) => row.assignment_id === data.assignment_id);
        if (child) child.outcome = data.outcome;
      }
      if (kind === 'run_terminal') {
        state.terminal = true;
        state.run_outcome = data.outcome;
      }
      state.event_counts[kind] = (state.event_counts[kind] ?? 0) + 1;
      state.revision += 1;
      state.head_hash = `sha256:${String(state.revision).padStart(64, 'a')}`;
      events.push({ ...event, seq: state.revision });
      return { seq: state.revision, state: { ...state } };
    },
    async cursorAfter(seq) {
      return {
        seq,
        head_hash: seq === 0
          ? 'codex-co-engineer.run-journal.genesis.v1'
          : `sha256:${String(seq).padStart(64, 'a')}`,
        cursor: `cursor:${seq}`,
      };
    },
    async readPage() {
      return { events: [...events], next_cursor: null };
    },
  };
}

export function createMemoryRunJournal() {
  const handles = new Map();
  function obtain(runId, create) {
    if (handles.has(runId)) {
      if (create) failStub('run_journal_already_exists', 'run_id', 'Journal exists.');
      return handles.get(runId);
    }
    if (!create) failStub('run_journal_not_found', 'run_id', 'Journal missing.');
    const handle = createJournalHandle();
    handles.set(runId, handle);
    return handle;
  }
  return {
    async create(options) { return obtain(options.run_id, true); },
    async open(options) { return obtain(options.run_id, false); },
    async createAggregate(options) { return obtain(options.run_id, true); },
    async openAggregate(options) { return obtain(options.run_id, false); },
    _handles: handles,
  };
}

export function createMemoryAggregateAnchor({
  phaseByRun = new Map(),
} = {}) {
  return {
    async getCoordination(runId) {
      if (!phaseByRun.has(runId)) {
        failStub('aggregate_run_not_found', 'run_id', 'No aggregate run exists.');
      }
      return {
        schema: 'codex-co-engineer.aggregate-run-coordination.v1',
        run_id: runId,
        phase: phaseByRun.get(runId),
        revision: phaseByRun.get(runId) === 'resolution_ready' ? 2 : 0,
      };
    },
    phaseByRun,
  };
}

export function createMemoryAttentionBatch() {
  const batches = new Map();
  const calls = { latch: 0, reply: 0, get: 0, cancelled: [] };
  return {
    calls,
    async latch(options) {
      calls.latch += 1;
      const items = options.items ?? [];
      for (const item of items) {
        if (item.reply_capability === 'unsupported' && typeof options.cancel === 'function') {
          await options.cancel({ assignment_id: item.assignment_id });
          calls.cancelled.push(item.assignment_id);
        }
      }
      const record = {
        schema: 'codex-co-engineer.attention-batch.v1',
        run_id: options.run_id,
        batch_id: `att-${options.run_id}`,
        revision: 1,
        status: 'open',
        source: options.source,
        items,
        complete_candidate_blocked: items.some((item) => item.required !== false
          && item.reply_capability === 'unsupported'),
        wake: false,
      };
      batches.set(options.run_id, record);
      return record;
    },
    async reply(options) {
      calls.reply += 1;
      const record = batches.get(options.run_id);
      if (!record) failStub('attention_batch_not_found', 'run_id', 'No attention batch.');
      record.status = 'resolved';
      record.reply = options.reply;
      return record;
    },
    async get(runId) {
      calls.get += 1;
      return batches.get(runId) ?? null;
    },
  };
}

function laneFromAssignment(assignment, extra = {}) {
  return {
    access: assignment.access,
    assignment_id: assignment.assignment_id,
    attention: extra.attention ?? null,
    cancel_confirmed: extra.cancel_confirmed ?? null,
    cursor: extra.cursor ?? null,
    dispatched: extra.dispatched !== false,
    fallback: false,
    model: assignment.model,
    provider: assignment.provider,
    replayed: false,
    required: assignment.required !== false,
    role: assignment.role,
    starting_ref: assignment.starting_ref ?? null,
    status: extra.status ?? 'dispatched',
    task_id: assignment.task_id,
    unresolved: extra.unresolved ?? null,
    write_scope: assignment.write_scope,
  };
}

export function createMemoryScheduler({
  inspectStatusByAssignment = new Map(),
  cancelConfirmed = true,
  delegateErrorFor = new Set(),
} = {}) {
  const runs = new Map();
  const calls = {
    submit: 0,
    resume: 0,
    cancel: 0,
    delegate: [],
  };
  return {
    calls,
    inspectStatusByAssignment,
    async submitAssignments(request) {
      calls.submit += 1;
      const existing = runs.get(request.run_id);
      if (existing) {
        return {
          schema: 'codex-co-engineer.run-scheduler-receipt.v1',
          status: 'idempotent',
          run_id: request.run_id,
          base_sha: existing.base_sha,
          created: false,
          lanes: existing.lanes,
          complete_candidate_blocked: existing.lanes.some((lane) => lane.required
            && lane.status === 'unresolved'),
          wake: false,
          remote_mutated: false,
        };
      }
      const lanes = [];
      for (const assignment of request.assignments) {
        calls.delegate.push(assignment.assignment_id);
        if (delegateErrorFor.has(assignment.assignment_id)) {
          lanes.push(laneFromAssignment(assignment, {
            dispatched: false,
            status: 'unresolved',
            unresolved: { code: 'dispatch_failed' },
          }));
        } else {
          lanes.push(laneFromAssignment(assignment));
        }
      }
      runs.set(request.run_id, {
        run_id: request.run_id,
        base_sha: request.base_sha,
        assignments: request.assignments,
        lanes,
      });
      const failed = lanes.some((lane) => lane.status === 'unresolved');
      return {
        schema: 'codex-co-engineer.run-scheduler-receipt.v1',
        status: failed ? 'partial' : 'dispatched',
        run_id: request.run_id,
        base_sha: request.base_sha,
        created: true,
        lanes,
        complete_candidate_blocked: lanes.some((lane) => lane.required
          && lane.status === 'unresolved'),
        wake: false,
        remote_mutated: false,
      };
    },
    async resumeAssignments(request) {
      calls.resume += 1;
      const record = runs.get(request.run_id);
      if (!record) failStub('scheduler_run_unknown', 'run_id', 'Scheduler run unknown.');
      for (const lane of record.lanes) {
        if (inspectStatusByAssignment.has(lane.assignment_id)) {
          lane.status = inspectStatusByAssignment.get(lane.assignment_id);
        }
        const cursor = (request.cursors ?? []).find((row) => row.assignment_id === lane.assignment_id);
        if (cursor) {
          if (cursor.task_id !== lane.task_id) {
            failStub('cursor_identity_mismatch', 'cursors', 'Cursor identity mismatch.');
          }
          lane.cursor = cursor;
        }
      }
      return {
        schema: 'codex-co-engineer.run-scheduler-receipt.v1',
        status: 'inspected',
        run_id: request.run_id,
        base_sha: record.base_sha,
        created: false,
        lanes: record.lanes,
        complete_candidate_blocked: record.lanes.some((lane) => lane.required
          && (lane.status === 'unresolved' || lane.status === 'failed')),
        wake: false,
        remote_mutated: false,
      };
    },
    async cancelAssignments(request) {
      calls.cancel += 1;
      const record = runs.get(request.run_id);
      if (!record) failStub('scheduler_run_unknown', 'run_id', 'Scheduler run unknown.');
      for (const assignmentId of request.assignment_ids) {
        const lane = record.lanes.find((row) => row.assignment_id === assignmentId);
        if (!lane) failStub('runtime_assignment_unknown', 'assignment_ids', 'Unknown assignment.');
        lane.status = 'cancelled';
        lane.cancel_confirmed = cancelConfirmed;
        if (!cancelConfirmed) {
          lane.unresolved = { code: 'safe_cancel_unconfirmed' };
        }
      }
      return {
        schema: 'codex-co-engineer.run-scheduler-receipt.v1',
        status: 'cancelled',
        run_id: request.run_id,
        base_sha: record.base_sha,
        created: false,
        lanes: record.lanes,
        complete_candidate_blocked: false,
        wake: false,
        remote_mutated: false,
      };
    },
    _runs: runs,
  };
}

export function createMemoryArtifactBridge() {
  const artifacts = new Map();
  const calls = { capture: 0, project: 0, cleanup: [] };
  const keyOf = (runId, assignmentId) => `${runId}:${assignmentId}`;
  return {
    calls,
    async captureAssignmentArtifacts(input) {
      calls.capture += 1;
      artifacts.set(keyOf(input.run_id, input.assignment_id), {
        run_id: input.run_id,
        assignment_id: input.assignment_id,
        relative_path: input.relative_path,
      });
      return {
        schema: 'codex-co-engineer.run-artifact-bridge-capture.v1',
        run_id: input.run_id,
        assignment_id: input.assignment_id,
        created: true,
      };
    },
    async projectAssignmentArtifacts(input) {
      calls.project += 1;
      const record = artifacts.get(keyOf(input.run_id, input.assignment_id));
      return {
        schema: 'codex-co-engineer.run-artifact-bridge-projection.v1',
        run_id: input.run_id,
        assignment_id: input.assignment_id,
        artifacts: record ? [record] : [],
      };
    },
    async cleanupRunArtifacts(input) {
      calls.cleanup.push(input);
      if (input.proof?.run_id !== input.run_id) {
        failStub('artifact_bridge_cleanup_unproven', 'proof', 'Proof run id mismatch.');
      }
      let removed = 0;
      for (const [key, record] of [...artifacts.entries()]) {
        if (record.run_id !== input.run_id) continue;
        if (input.proof.assignment_ids
          && !input.proof.assignment_ids.includes(record.assignment_id)) {
          continue;
        }
        artifacts.delete(key);
        removed += 1;
      }
      return {
        schema: 'codex-co-engineer.run-artifact-bridge-cleanup.v1',
        run_id: input.run_id,
        cleaned: true,
        removed,
        remaining: [...artifacts.values()].filter((row) => row.run_id === input.run_id).length,
        unresolved: [],
      };
    },
  };
}

export function createLifecycleFns({
  final = true,
  cleanupStatus = 'normal',
  reason = null,
  settleCalls = [],
  cleanupCalls = [],
  failSettle = false,
  leakSecret = false,
} = {}) {
  const settleLocalTaskLifecycle = async (root, task, runtime, dependencies) => {
    settleCalls.push({ root, task, runtime, dependencies });
    if (failSettle) throw new Error(HOSTILE_SECRET);
    const record = {
      version: 1,
      task_id: task.id,
      stored_status: 'completed',
      projected_status: final ? 'succeeded' : 'transport_lost',
      public_state: final ? 'succeeded' : 'transport_lost',
      final,
      cleanup: { status: cleanupStatus, code: reason },
      boundary: { status: final ? 'inactive_empty' : 'active' },
      lock: { status: final ? 'unlocked' : 'active' },
      reason,
    };
    if (leakSecret) record.secret = HOSTILE_SECRET;
    return record;
  };
  const cleanupLocalTaskLifecycle = async (root, task, runtime, dependencies) => {
    cleanupCalls.push({ root, task, runtime, dependencies });
    return settleLocalTaskLifecycle(root, task, runtime, dependencies);
  };
  return {
    settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle,
    settleCalls,
    cleanupCalls,
  };
}

export function createClock(now = NOW) {
  return () => now;
}

export function createRuntime(overrides = {}) {
  const runStore = overrides.runStore ?? createMemoryRunStore();
  const runJournal = overrides.runJournal ?? createMemoryRunJournal();
  const aggregateAnchor = overrides.aggregateAnchor ?? createMemoryAggregateAnchor();
  const attentionBatch = overrides.attentionBatch ?? createMemoryAttentionBatch();
  const scheduler = overrides.scheduler ?? createMemoryScheduler();
  const artifactBridge = overrides.artifactBridge ?? createMemoryArtifactBridge();
  const lifecycle = overrides.lifecycle ?? createLifecycleFns();
  const clock = overrides.clock ?? createClock();
  const runtime = createRunRuntime({
    runStore,
    runJournal,
    aggregateAnchor,
    attentionBatch,
    scheduler,
    artifactBridge,
    settleLocalTaskLifecycle: lifecycle.settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: lifecycle.cleanupLocalTaskLifecycle,
    clock,
  });
  return {
    runtime,
    runStore,
    runJournal,
    aggregateAnchor,
    attentionBatch,
    scheduler,
    artifactBridge,
    lifecycle,
    clock,
  };
}
