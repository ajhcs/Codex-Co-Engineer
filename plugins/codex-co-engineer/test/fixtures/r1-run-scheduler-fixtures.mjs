// Neutral builders and scoped task stubs for RunSchedulerV1 tests.
// Tests own the assertions. Nothing here ranks, defaults, or substitutes
// a provider, and the stubs never import supervisor, server, runtime,
// artifact, lifecycle, or candidate surfaces.

import {
  createRunScheduler,
} from '../../mcp/v3/run-scheduler.mjs';

export const RUN_ID = 'run-scheduler-main';
export const BASE_SHA = '9e4d3cbdb1175f92da9979a7125e29e43b9aa699';
export const OTHER_BASE_SHA = 'ce174375ee7e0c83b3db4f874e88edbf932649ee';
export const ASSIGNMENT_A = 'lane-alpha';
export const ASSIGNMENT_B = 'lane-beta';
export const ASSIGNMENT_C = 'lane-verify';
export const TASK_A = 'task-alpha';
export const TASK_B = 'task-beta';
export const TASK_C = 'task-verify';
export const NOW = '2026-08-25T22:12:00.000Z';
export const HOSTILE_SECRET = 'sk-live-ATTACKER-SECRET';
export const HOSTILE_PATH = '/tmp/hostile-repo';
export const HOSTILE_TOKEN = 'github_pat_hostile';

export function writerAssignment({
  assignmentId = ASSIGNMENT_A,
  taskId = TASK_A,
  provider = 'grok',
  model = 'grok-4',
  writeScope = ['src/alpha/**'],
  required = true,
  startingRef,
} = {}) {
  const assignment = {
    assignment_id: assignmentId,
    task_id: taskId,
    role: 'implement',
    access: 'writer',
    provider,
    model,
    write_scope: writeScope,
    required,
  };
  if (startingRef !== undefined) assignment.starting_ref = startingRef;
  return assignment;
}

export function verifierAssignment({
  assignmentId = ASSIGNMENT_C,
  taskId = TASK_C,
  provider = 'cursor-local',
  model = 'composer-1',
  role = 'verify',
  required = true,
} = {}) {
  return {
    assignment_id: assignmentId,
    task_id: taskId,
    role,
    access: 'read_only',
    provider,
    model,
    write_scope: [],
    required,
  };
}

export function reviewerAssignment(overrides = {}) {
  return verifierAssignment({
    assignmentId: ASSIGNMENT_B,
    taskId: TASK_B,
    provider: 'grok',
    model: 'grok-4',
    role: 'review',
    ...overrides,
  });
}

export function twoWriterRequest(overrides = {}) {
  return {
    run_id: overrides.runId ?? RUN_ID,
    base_sha: overrides.baseSha ?? BASE_SHA,
    assignments: overrides.assignments ?? [
      writerAssignment(),
      writerAssignment({
        assignmentId: ASSIGNMENT_B,
        taskId: TASK_B,
        writeScope: ['src/beta/**'],
        provider: 'cursor-local',
        model: 'composer-1',
      }),
    ],
  };
}

export function mixedLaneRequest(overrides = {}) {
  return {
    run_id: overrides.runId ?? RUN_ID,
    base_sha: overrides.baseSha ?? BASE_SHA,
    assignments: overrides.assignments ?? [
      writerAssignment(),
      writerAssignment({
        assignmentId: ASSIGNMENT_B,
        taskId: TASK_B,
        writeScope: ['src/beta/**'],
        provider: 'dsh',
        model: 'meta/muse-spark-1.3-contributor',
      }),
      verifierAssignment(),
    ],
  };
}

export function eightLaneRequest(overrides = {}) {
  const assignments = [];
  for (let index = 0; index < 8; index += 1) {
    assignments.push(writerAssignment({
      assignmentId: `lane-${String(index).padStart(2, '0')}`,
      taskId: `task-${String(index).padStart(2, '0')}`,
      writeScope: [`src/area-${index}/**`],
    }));
  }
  return {
    run_id: overrides.runId ?? RUN_ID,
    base_sha: overrides.baseSha ?? BASE_SHA,
    assignments,
  };
}

export function countingProxy(target) {
  const counts = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0, apply: 0 };
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      counts.get += 1;
      return Reflect.get(inner, property, receiver);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    has(inner, property) {
      counts.has += 1;
      return Reflect.has(inner, property);
    },
    apply() {
      counts.apply += 1;
      throw new Error('proxy apply must never run');
    },
  });
  return { proxy, counts };
}

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}

export function createScopedStubs(options = {}) {
  const delegateCalls = [];
  const inspectCalls = [];
  const cancelCalls = [];
  const tasks = new Map();
  const failDelegateFor = new Set(options.failDelegateFor ?? []);
  const mismatchDelegateFor = new Set(options.mismatchDelegateFor ?? []);
  const failInspectFor = new Set(options.failInspectFor ?? []);
  const failCancelFor = new Set(options.failCancelFor ?? []);
  const attentionByTask = new Map(Object.entries(options.attentionByTask ?? {}));
  const inspectStatusByTask = new Map(Object.entries(options.inspectStatusByTask ?? {}));
  let cursorSeq = 0;
  const now = options.now ?? NOW;

  const delegateTask = async (plan) => {
    delegateCalls.push(plan);
    if (failDelegateFor.has(plan.assignment_id)) {
      throw new Error(`${HOSTILE_SECRET} injected delegate failure`);
    }
    if (mismatchDelegateFor.has(plan.assignment_id)) {
      return { task_id: 'forged-task', cursor: '0', status: 'running' };
    }
    const cursor = STRING_CURSOR(++cursorSeq);
    const record = {
      task_id: plan.task_id,
      assignment_id: plan.assignment_id,
      status: 'running',
      cursor,
      attention: attentionByTask.get(plan.task_id) ?? null,
    };
    tasks.set(plan.task_id, record);
    return { task_id: plan.task_id, cursor, status: 'running' };
  };

  const inspectTask = async (plan) => {
    inspectCalls.push(plan);
    if (failInspectFor.has(plan.assignment_id)) {
      throw new Error(`${HOSTILE_PATH} injected inspect failure`);
    }
    const record = tasks.get(plan.task_id);
    if (!record) return { task_id: plan.task_id, status: 'failed', cursor: plan.cursor };
    if (inspectStatusByTask.has(plan.task_id)) {
      record.status = inspectStatusByTask.get(plan.task_id);
    }
    const attention = attentionByTask.get(plan.task_id) ?? record.attention;
    record.attention = attention;
    const nextCursor = STRING_CURSOR(Number(record.cursor) + 8);
    record.cursor = nextCursor;
    return {
      task_id: record.task_id,
      status: record.status,
      cursor: record.cursor,
      attention,
    };
  };

  const cancelTask = async (plan) => {
    cancelCalls.push(plan);
    if (failCancelFor.has(plan.assignment_id)) {
      throw new Error(`${HOSTILE_TOKEN} injected cancel failure`);
    }
    const record = tasks.get(plan.task_id);
    if (record) {
      record.status = 'cancelled';
      record.attention = null;
    }
    return { task_id: plan.task_id, cancelled: true };
  };

  const clock = () => now;

  return {
    delegateTask,
    inspectTask,
    cancelTask,
    clock,
    delegateCalls,
    inspectCalls,
    cancelCalls,
    tasks,
    scheduler: createRunScheduler({ delegateTask, inspectTask, cancelTask, clock }),
  };
}

function STRING_CURSOR(value) {
  return String(value);
}

export function createScheduler(options = {}) {
  return createScopedStubs(options);
}
