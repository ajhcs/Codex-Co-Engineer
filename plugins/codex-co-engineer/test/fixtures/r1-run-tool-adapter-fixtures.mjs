// Isolated R-CUTOVER run-tool-adapter fixtures. Tests own the assertions.

import { attentionQuestionDigestV1 } from '../../mcp/v3/attention-batch.mjs';
import { denyWorkerRemoteMutation } from '../../mcp/v3/credential-boundary.mjs';
import {
  classifySupervisorTerminalReceipt,
  projectSupervisorTerminalReceipt,
} from '../../mcp/v3/supervisor.mjs';
import {
  createInProcessRunSeams,
  createRunToolAdapter,
} from '../../mcp/v3/run-tool-adapter.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  HOSTILE_SECRET,
  NOW,
  RUN_ID,
  TASK_ID,
  createClock,
  createLifecycleFns,
  createMemoryAttentionBatch,
  createMemoryScheduler,
  createRuntime,
  makeAssignment,
  makeSubmitRequest,
  makeVerifier,
} from './r1-run-runtime-fixtures.mjs';
import { makeSubmission } from './r1-run-store-fixtures.mjs';
import {
  legitimateCompletedReceipt,
  zeroWorkPingTimeoutReceipt,
} from './r1-supervisor-result-truthfulness-fixtures.mjs';

export {
  ASSIGNMENT_ID,
  BASE_SHA,
  HOSTILE_SECRET,
  NOW,
  RUN_ID,
  TASK_ID,
  legitimateCompletedReceipt,
  makeAssignment,
  makeSubmitRequest,
  makeVerifier,
  zeroWorkPingTimeoutReceipt,
};

export const HOSTILE_PATH = '/tmp/hostile-repo';
export const HOSTILE_TOKEN = 'github_pat_hostile';
export const HOSTILE_ENV = 'MODEL_API_KEY=sk-live-ATTACKER-SECRET';
export const CONTENT_FREE = /^[A-Za-z0-9 ._/-]{1,160}$/u;

export function countingProxy(target = {}) {
  const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
  const proxy = new Proxy(target, {
    get(obj, key) {
      traps.get += 1;
      if (key === 'run_id') return RUN_ID;
      return obj[key];
    },
    getOwnPropertyDescriptor(obj, key) {
      traps.getOwnPropertyDescriptor += 1;
      return Object.getOwnPropertyDescriptor(obj, key);
    },
    ownKeys(obj) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(obj);
    },
  });
  return { proxy, traps };
}

export function makeRunArgs(overrides = {}) {
  const request = makeSubmitRequest(overrides);
  return {
    run: {
      ...request,
      objective: overrides.objective ?? 'implement the bounded assignment',
      ...(overrides.profile ? { profile: overrides.profile } : {}),
    },
  };
}

export function createCountingRuntime(options = {}) {
  const created = createRuntime({
    scheduler: options.scheduler ?? createMemoryScheduler(options.schedulerOptions),
    attentionBatch: options.attentionBatch ?? createMemoryAttentionBatch(),
    lifecycle: options.lifecycle ?? createLifecycleFns(options.lifecycleOptions),
    clock: options.clock ?? createClock(),
    ...options.runtimeOverrides,
  });
  const calls = {
    submit: [],
    inspect: [],
    resume: [],
    cancel: [],
  };
  const runtime = {
    async submitRun(request) {
      calls.submit.push(request);
      if (typeof options.beforeSubmit === 'function') options.beforeSubmit(request);
      return created.runtime.submitRun(request);
    },
    async inspectRun(request) {
      calls.inspect.push(request);
      const receipt = await created.runtime.inspectRun(request);
      if (typeof options.decorateInspect === 'function') {
        return options.decorateInspect(receipt);
      }
      return receipt;
    },
    async resumeRun(request) {
      calls.resume.push(request);
      const receipt = await created.runtime.resumeRun(request);
      if (typeof options.decorateInspect === 'function') {
        return options.decorateInspect(receipt);
      }
      return receipt;
    },
    async cancelRun(request) {
      calls.cancel.push(request);
      return created.runtime.cancelRun(request);
    },
  };
  return { ...created, runtime, calls };
}

export function createAdapter(options = {}) {
  const counting = options.runtime
    ? { runtime: options.runtime, attentionBatch: options.attention, calls: options.calls ?? {} }
    : createCountingRuntime(options);
  const dependencies = {
    runtime: counting.runtime,
    attention: options.attention ?? counting.attentionBatch,
    projectLaneTask: options.projectLaneTask ?? projectSupervisorTerminalReceipt,
    classifyLaneTask: options.classifyLaneTask ?? classifySupervisorTerminalReceipt,
  };
  if (typeof options.rememberSubmitContext === 'function') {
    dependencies.rememberSubmitContext = options.rememberSubmitContext;
  }
  const adapter = createRunToolAdapter(dependencies);
  return { adapter, ...counting };
}

export function denyRemote(operation) {
  return denyWorkerRemoteMutation(operation);
}

export function makeAttentionItem({
  assignmentId = ASSIGNMENT_ID,
  taskId = TASK_ID,
  provider = 'grok',
  required = true,
  sessionId = 'sess-1',
  questionId = 'q-1',
  eventCursor = '0',
  prompt = 'Choose the next writer step',
  options = ['continue', 'stop'],
} = {}) {
  const replyCapability = provider === 'dsh' || provider === 'cursor-cloud'
    ? 'unsupported'
    : 'same_session';
  const item = {
    assignment_id: assignmentId,
    task_id: taskId,
    provider,
    required,
    session_id: sessionId,
    question_id: questionId,
    event_cursor: eventCursor,
    question_digest: 'sha256:' + '00'.repeat(32),
    prompt,
    options: replyCapability === 'unsupported' ? null : options,
    reply_capability: replyCapability,
    disposition: 'pending',
    deadline_at: null,
  };
  item.question_digest = attentionQuestionDigestV1(item);
  return item;
}

export function createSeamAdapter(options = {}) {
  const lifecycle = options.lifecycle ?? createLifecycleFns(options.lifecycleOptions);
  const seams = createInProcessRunSeams({
    delegateTask: options.delegateTask ?? (async (plan) => ({
      task_id: plan.task_id, status: 'dispatched', cursor: '0',
    })),
    inspectTask: options.inspectTask ?? (async (plan) => ({
      task_id: plan.task_id, status: 'running', cursor: plan.cursor ?? '0',
    })),
    cancelTask: options.cancelTask ?? (async (plan) => ({
      task_id: plan.task_id, status: 'cancelled', cancelled: true,
    })),
    settleLocalTaskLifecycle: lifecycle.settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: lifecycle.cleanupLocalTaskLifecycle,
    clock: options.clock ?? createClock(),
  });
  const adapter = createRunToolAdapter({
    runtime: seams.runtime,
    attention: seams.attention,
    projectLaneTask: options.projectLaneTask ?? projectSupervisorTerminalReceipt,
    classifyLaneTask: options.classifyLaneTask ?? classifySupervisorTerminalReceipt,
  });
  return { adapter, seams, lifecycle };
}
