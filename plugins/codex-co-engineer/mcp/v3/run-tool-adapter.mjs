// RunToolAdapterV1 — R-CUTOVER five-tool wiring (ADR 0001 identifiers
// `additive_3_2_1_compatibility`, `bounded_run_1_to_8`,
// `decision_or_attention`, `deterministic_explicit_or_profile_resolution`,
// `no_direct_mode_for_run_submissions`, `no_post_dispatch_fallback_or_replay`,
// `gate_a_no_protected_ref_mutation`).
//
// Additive v3 adapter. It maps submit/status/wait/attention/reply/cancel/
// cleanup onto the frozen five-tool catalog through Sol-frozen additive
// parameters and modes. There is no sixth MCP tool. Omitted additive fields
// keep the exact 3.2.1 direct/single-task path. Parsing or validation
// failure produces zero provider dispatch, replay, fallback, ref creation,
// or cleanup. Provider/model is explicit or a caller-named profile; P22 is
// conformance evidence never a slot; P33/P34/P35 remain the authority for
// runtime, attention, and candidate refs. MCP output is model-facing and
// therefore sanitized.

import { types as utilTypes } from 'node:util';

import {
  denyRunRemoteMutationV1,
} from './run-orchestration.mjs';
import {
  CANDIDATE_REF_NAMESPACE,
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  expectedCandidateRefV1,
  isRunOwnedCandidateRefV1,
  classifyGitOperationV1,
} from './git-authority.mjs';
import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  isKnownProvider,
  isModelId,
  isProfileName,
  knownProvidersJoined,
} from './grammar.mjs';
import {
  FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID,
  FUTURE_HARNESS_TEMPLATE_SCHEMA_ID,
} from './future-harness.mjs';
import {
  PROVIDER_REGISTRY_SLOTS,
  describeProviderRegistryV1,
  isRegistrySlotV1,
  requireRegistrySlotV1,
  resolveRegistrySelectionV1,
} from './provider-registry.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  RUN_ID_PATTERN,
  RunContractV1Error,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  RUN_RUNTIME_METHODS,
  createRunRuntime,
} from './run-runtime.mjs';
import { createRunScheduler } from './run-scheduler.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

export const RUN_TOOL_ADAPTER_SCHEMA_ID = 'codex-co-engineer.run-tool-adapter.v1';
export const RUN_TOOL_ADAPTER_VERSION = 1;
export const RUN_TOOL_ADAPTER_RECEIPT_SCHEMA_ID = 'codex-co-engineer.run-tool-receipt.v1';

export const PUBLIC_MCP_CATALOG = capturedFreeze([
  'status', 'delegate', 'task', 'tasks', 'cancel',
]);
export const RUN_TOOL_OPERATIONS = capturedFreeze([
  'submit', 'status', 'wait', 'attention', 'reply', 'cancel', 'cleanup',
]);
export const RUN_TOOL_MODES = capturedFreeze(['legacy', 'run']);
export const ADDITIVE_WAIT_UNTIL = 'decision_or_attention';
export const WAIT_UNTIL_VALUES = capturedFreeze([
  'progress', 'terminal', ADDITIVE_WAIT_UNTIL,
]);

export const ADDITIVE_STATUS_KEYS = capturedFreeze(['run_id']);
export const ADDITIVE_DELEGATE_KEYS = capturedFreeze(['run']);
export const ADDITIVE_TASK_KEYS = capturedFreeze([
  'run_id', 'assignment_id', 'attention', 'run_reply',
]);
export const ADDITIVE_TASKS_KEYS = capturedFreeze(['run_id']);
export const ADDITIVE_CANCEL_KEYS = capturedFreeze([
  'run_id', 'assignment_ids', 'cleanup',
]);

export const RUN_SUBMIT_KEYS = capturedFreeze([
  'assignments', 'git', 'identity', 'objective', 'profile', 'provenance',
  'request_idempotency_key', 'run_id', 'telemetry',
]);
export const RUN_SUBMIT_REQUIRED_KEYS = capturedFreeze([
  'assignments', 'git', 'identity', 'provenance', 'request_idempotency_key',
  'run_id', 'telemetry',
]);
export const RUN_ASSIGNMENT_KEYS = capturedFreeze([
  'access', 'assignment_id', 'expected_duration_ms', 'model', 'profile',
  'prompt', 'provider', 'required', 'role', 'starting_ref', 'task_id',
  'write_scope',
]);
export const RUN_ASSIGNMENT_RUNTIME_KEYS = capturedFreeze([
  'access', 'assignment_id', 'model', 'provider', 'required', 'role',
  'starting_ref', 'task_id', 'write_scope',
]);
export const ATTENTION_REQUEST_KEYS = capturedFreeze(['expected_revision', 'items']);
export const RUN_REPLY_KEYS = capturedFreeze([
  'batch_id', 'expected_revision', 'reply',
]);
export const RUN_TOOL_RECEIPT_KEYS = capturedFreeze([
  'assignment_count', 'attention', 'audience', 'candidate', 'checks',
  'cleanup', 'complete_candidate_blocked', 'decision_or_attention',
  'lanes', 'mode', 'operation', 'remote_mutated', 'run_id', 'schema',
  'side_effects', 'status', 'tool', 'version', 'wake',
]);

export const RUN_TOOL_ADAPTER_CHECKS = capturedFreeze([
  'catalog_five_tools',
  'omission_preserves_3_2_1',
  'validation_before_side_effects',
  'assignment_count_1_to_8',
  'explicit_or_profile_provider_model',
  'four_slot_registry',
  'p22_not_a_provider',
  'no_learned_routing',
  'decision_or_attention',
  'exactly_once_reply',
  'unresolved_required_blocks',
  'owner_raw_vs_model_sanitized',
  'lifecycle_cleanup_authority',
  'p35_candidate_ref_authority',
  'remote_mutation_denied',
]);
export const RUN_TOOL_ADAPTER_SIDE_EFFECTS = capturedFreeze([
  'provider_dispatched',
  'replay',
  'fallback',
  'ref_created',
  'cleanup_executed',
  'candidate_composed',
  'remote_mutated',
  'sixth_tool_exposed',
]);
export const RUN_TOOL_ADAPTER_ALWAYS_FALSE_SIDE_EFFECTS = capturedFreeze([
  'replay',
  'fallback',
  'ref_created',
  'candidate_composed',
  'remote_mutated',
  'sixth_tool_exposed',
]);

export const MAX_ADAPTER_DIAGNOSTIC_BYTES = 160;
export const RUN_ID_SCHEMA_PATTERN = RUN_ID_PATTERN.source;

const IS_PROXY = utilTypes.isProxy;
const STRING = String;
const ARRAY_IS_ARRAY = Array.isArray;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const IDEMPOTENCY_KEY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const P22_PROVIDER_ALIASES = capturedFreeze([
  'p22', 'future-harness', 'future_harness', 'conformance',
  'provider-driver-template', 'harness',
]);
const LEARNED_ROUTING_KEYS = capturedFreeze([
  'router', 'routing', 'rank', 'score', 'cost', 'learned', 'predict',
  'fallback_provider', 'fallback_model', 'preference_walk',
]);
const FORBIDDEN_KEY_CODES = capturedFreeze({
  allow_fallback: 'replay_or_fallback_denied',
  allow_post_dispatch_fallback: 'replay_or_fallback_denied',
  allow_replay: 'replay_or_fallback_denied',
  fallback: 'replay_or_fallback_denied',
  fallback_model: 'replay_or_fallback_denied',
  fallback_provider: 'replay_or_fallback_denied',
  fallbacks: 'replay_or_fallback_denied',
  redrive: 'replay_or_fallback_denied',
  replay: 'replay_or_fallback_denied',
  resend: 'replay_or_fallback_denied',
  retry: 'replay_or_fallback_denied',
  retry_dispatch: 'replay_or_fallback_denied',
  direct_mode: 'direct_mode_rejected',
  workspace_mode: 'direct_mode_rejected',
  allow_create_pr: 'merge_authority_denied',
  allow_merge: 'merge_authority_denied',
  allow_push: 'merge_authority_denied',
  create_pr: 'merge_authority_denied',
  create_pull_request: 'merge_authority_denied',
  force_push: 'merge_authority_denied',
  merge: 'merge_authority_denied',
  merge_pr: 'merge_authority_denied',
  merges: 'merge_authority_denied',
  open_pr: 'merge_authority_denied',
  push: 'merge_authority_denied',
  push_branch: 'merge_authority_denied',
  github: 'remote_mutation_denied',
  remote: 'remote_mutation_denied',
  candidate: 'candidate_authority_denied',
  compose: 'candidate_authority_denied',
  router: 'learned_routing_denied',
  routing: 'learned_routing_denied',
  rank: 'learned_routing_denied',
  score: 'learned_routing_denied',
  cost: 'learned_routing_denied',
  learned: 'learned_routing_denied',
});

const TOOL_ADDITIVE = capturedFreeze({
  status: ADDITIVE_STATUS_KEYS,
  delegate: ADDITIVE_DELEGATE_KEYS,
  task: ADDITIVE_TASK_KEYS,
  tasks: ADDITIVE_TASKS_KEYS,
  cancel: ADDITIVE_CANCEL_KEYS,
});

const CONTENT_FREE = capturedFreeze({
  accessor_property_denied: 'Accessor properties are denied.',
  aliased_reference_denied: 'Aliased references are denied.',
  candidate_authority_denied: 'Candidate composition stays on the P35 seam.',
  catalog_sixth_tool_denied: 'The public catalog remains five tools.',
  cleanup_unproven: 'Cleanup requires P33 proof-bound finality.',
  direct_mode_rejected: 'Run submissions reject direct mode.',
  duplicate_assignment_id: 'Assignment ids in a run must be unique.',
  duplicate_task_id: 'Task ids in a run must be unique.',
  exotic_prototype_denied: 'Exotic prototypes are denied.',
  injected_dependency_invalid: 'createRunToolAdapter requires the closed injected seams.',
  invalid_format: 'A run-tool field is not in the required format.',
  invalid_type: 'A run-tool field is not the required JSON type.',
  learned_routing_denied: 'Provider selection is explicit or a named profile.',
  merge_authority_denied: 'Merge, push, and pull-request authority is denied.',
  missing_key: 'A required run-tool field is missing.',
  mixed_run_operation: 'One tool call maps to exactly one run operation.',
  mixed_tool_mode: 'Run parameters cannot mix with 3.2.1 single-task fields.',
  own_undefined_denied: 'Own undefined values are denied.',
  out_of_range: 'A run-tool collection is outside the closed 1-8 bound.',
  p22_not_a_provider: 'P22 is conformance evidence and never a provider slot.',
  proxy_denied: 'Proxy values are denied.',
  remote_mutation_denied: 'Remote mutation is denied.',
  replay_or_fallback_denied: 'Replay and fallback are denied.',
  selection_unresolved: 'Provider and model must be explicit or profile-selected.',
  symbol_key_denied: 'Symbol keys are denied.',
  unknown_key: 'A run-tool field is outside the closed vocabulary.',
  unknown_operation: 'The tool arguments do not map to a frozen run operation.',
  unknown_provider: 'The provider is not an accepted four-slot registry entry.',
  unknown_tool: 'The public catalog remains status, delegate, task, tasks, cancel.',
});

export const RUN_TOOL_ADAPTER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'candidate_authority_denied',
  'catalog_sixth_tool_denied',
  'cleanup_unproven',
  'direct_mode_rejected',
  'duplicate_assignment_id',
  'duplicate_task_id',
  'exotic_prototype_denied',
  'injected_dependency_invalid',
  'invalid_format',
  'invalid_type',
  'learned_routing_denied',
  'merge_authority_denied',
  'missing_key',
  'mixed_run_operation',
  'mixed_tool_mode',
  'own_undefined_denied',
  'out_of_range',
  'p22_not_a_provider',
  'proxy_denied',
  'remote_mutation_denied',
  'replay_or_fallback_denied',
  'selection_unresolved',
  'symbol_key_denied',
  'unknown_key',
  'unknown_operation',
  'unknown_provider',
  'unknown_tool',
]);

const ADAPTER_DEPENDENCY_KEYS = capturedFreeze([
  'attention', 'classifyLaneTask', 'projectLaneTask', 'rememberSubmitContext',
  'runtime',
]);
const RUNTIME_METHODS = RUN_RUNTIME_METHODS;
const ATTENTION_METHODS = capturedFreeze(['get', 'reply']);

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_ADAPTER_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_ADAPTER_DIAGNOSTIC_BYTES);
}

function failAdapter(code, field, message) {
  fail(code, field, diagnostic(message ?? CONTENT_FREE[code] ?? CONTENT_FREE.invalid_format));
}

function emptySideEffects() {
  const sideEffects = {};
  for (const claim of RUN_TOOL_ADAPTER_SIDE_EFFECTS) sideEffects[claim] = false;
  return sideEffects;
}

function emptyChecks() {
  const checks = {};
  for (const name of RUN_TOOL_ADAPTER_CHECKS) checks[name] = true;
  return checks;
}

function ownKeySet(value, field) {
  assertNotProxy(value, field);
  let keys;
  try {
    keys = capturedOwnKeys(value);
  } catch {
    failAdapter('invalid_type', field, CONTENT_FREE.invalid_type);
  }
  for (const key of keys) {
    if (typeof key === 'symbol') {
      failAdapter('symbol_key_denied', field, CONTENT_FREE.symbol_key_denied);
    }
  }
  return keys.filter((key) => typeof key === 'string');
}

function hasOwnAdditive(args, keys) {
  if (args === undefined || args === null) return false;
  if (typeof args !== 'object' && typeof args !== 'function') return false;
  if (IS_PROXY(args)) return true;
  for (const key of keys) {
    if (capturedHasOwn(args, key)) return true;
  }
  return false;
}

function waitUntilValue(args) {
  if (args === undefined || args === null || typeof args !== 'object') return undefined;
  if (IS_PROXY(args)) return undefined;
  if (!capturedHasOwn(args, 'wait_until')) return undefined;
  try {
    return args.wait_until;
  } catch {
    return undefined;
  }
}

export function classifyRunToolCall(tool, args) {
  if (!capturedIncludes(PUBLIC_MCP_CATALOG, tool)) {
    return freezeData({
      mode: 'run',
      tool: typeof tool === 'string' ? tool : null,
      operation: null,
      additive: true,
    });
  }
  const additiveKeys = TOOL_ADDITIVE[tool];
  const additive = hasOwnAdditive(args, additiveKeys)
    || waitUntilValue(args) === ADDITIVE_WAIT_UNTIL;
  if (!additive) {
    return freezeData({
      mode: 'legacy',
      tool,
      operation: null,
      additive: false,
    });
  }
  return freezeData({
    mode: 'run',
    tool,
    operation: null,
    additive: true,
  });
}

function denyForbiddenTree(value, path) {
  if (value === null || typeof value !== 'object') return;
  if (IS_PROXY(value)) failAdapter('proxy_denied', path, CONTENT_FREE.proxy_denied);
  const keys = REFLECT_OWN_KEYS(value);
  for (const key of keys) {
    if (typeof key !== 'string') {
      failAdapter('symbol_key_denied', path, CONTENT_FREE.symbol_key_denied);
    }
    if (capturedHasOwn(FORBIDDEN_KEY_CODES, key)) {
      failAdapter(FORBIDDEN_KEY_CODES[key], `${path}.${key}`, CONTENT_FREE[FORBIDDEN_KEY_CODES[key]]);
    }
    if (capturedIncludes(LEARNED_ROUTING_KEYS, key)) {
      failAdapter('learned_routing_denied', `${path}.${key}`, CONTENT_FREE.learned_routing_denied);
    }
  }
  if (ARRAY_IS_ARRAY(value)) {
    for (let index = 0; index < value.length; index += 1) {
      denyForbiddenTree(value[index], `${path}[${index}]`);
    }
    return;
  }
  for (const key of keys) {
    if (typeof key === 'string') denyForbiddenTree(value[key], `${path}.${key}`);
  }
}

function quarantineObject(value, field, allowed) {
  if (value === undefined || value === null) {
    failAdapter('invalid_type', field, CONTENT_FREE.invalid_type);
  }
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'The run-tool object');
  assertDirectJsonClosure(value, field);
  denyForbiddenTree(value, field);
  const keys = ownKeySet(value, field);
  for (const key of keys) {
    if (!capturedIncludes(allowed, key)) {
      failAdapter('unknown_key', `${field}.${key}`, CONTENT_FREE.unknown_key);
    }
  }
  freezeData(value);
  return value;
}

function requireString(object, key, field, predicate, code = 'invalid_format') {
  if (!hasOwn(object, key)) failAdapter('missing_key', field, CONTENT_FREE.missing_key);
  const value = ownDataValue(object, key, field);
  if (typeof value !== 'string' || (predicate && !predicate(value))) {
    failAdapter(code, field, CONTENT_FREE[code] ?? CONTENT_FREE.invalid_format);
  }
  return value;
}

function optionalValue(object, key, field) {
  if (!hasOwn(object, key)) return undefined;
  return ownDataValue(object, key, field);
}

function assertClosedTool(tool) {
  if (!capturedIncludes(PUBLIC_MCP_CATALOG, tool)) {
    failAdapter(
      tool == null ? 'unknown_tool' : 'catalog_sixth_tool_denied',
      'tool',
      CONTENT_FREE.unknown_tool,
    );
  }
  return tool;
}

function mixLegacySingleTask(tool, args) {
  if (tool === 'delegate') {
    return capturedHasOwn(args, 'task_id')
      || capturedHasOwn(args, 'provider')
      || capturedHasOwn(args, 'repo')
      || capturedHasOwn(args, 'prompt')
      || capturedHasOwn(args, 'workspace_mode')
      || capturedHasOwn(args, 'create_pr')
      || capturedHasOwn(args, 'dsh_model');
  }
  if (tool === 'task') {
    return capturedHasOwn(args, 'task_id') || capturedHasOwn(args, 'reply');
  }
  if (tool === 'cancel') return capturedHasOwn(args, 'task_id');
  if (tool === 'tasks') {
    return capturedHasOwn(args, 'detail')
      || capturedHasOwn(args, 'limit')
      || capturedHasOwn(args, 'provider')
      || capturedHasOwn(args, 'state')
      || capturedHasOwn(args, 'status')
      || capturedHasOwn(args, 'task_ids')
      || (capturedHasOwn(args, 'cursor') && !capturedHasOwn(args, 'run_id'));
  }
  return false;
}

function resolveOperation(tool, args) {
  if (tool === 'delegate') return 'submit';
  if (tool === 'status') return 'status';
  if (tool === 'cancel') {
    return optionalValue(args, 'cleanup', 'cleanup') === true ? 'cleanup' : 'cancel';
  }
  if (tool === 'tasks') return 'wait';
  if (tool === 'task') {
    const hasAttention = capturedHasOwn(args, 'attention');
    const hasReply = capturedHasOwn(args, 'run_reply');
    const waitUntil = waitUntilValue(args);
    const flagged = [hasAttention, hasReply, waitUntil === ADDITIVE_WAIT_UNTIL]
      .filter(Boolean).length;
    if (flagged > 1) {
      failAdapter('mixed_run_operation', 'task', CONTENT_FREE.mixed_run_operation);
    }
    if (hasAttention) return 'attention';
    if (hasReply) return 'reply';
    if (waitUntil === ADDITIVE_WAIT_UNTIL || capturedHasOwn(args, 'wait_ms')) return 'wait';
    return 'status';
  }
  failAdapter('unknown_operation', 'tool', CONTENT_FREE.unknown_operation);
  return null;
}

function denyP22(provider, field) {
  if (typeof provider === 'string' && capturedIncludes(P22_PROVIDER_ALIASES, provider)) {
    failAdapter('p22_not_a_provider', field, CONTENT_FREE.p22_not_a_provider);
  }
  if (provider === FUTURE_HARNESS_TEMPLATE_SCHEMA_ID
    || provider === FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID) {
    failAdapter('p22_not_a_provider', field, CONTENT_FREE.p22_not_a_provider);
  }
}

function assertRegistryProvider(provider, model, field) {
  denyP22(provider, field);
  if (!isKnownProvider(provider) || !isRegistrySlotV1(provider)) {
    failAdapter('unknown_provider', field, CONTENT_FREE.unknown_provider);
  }
  requireRegistrySlotV1(provider);
  if (typeof model !== 'string' || !isModelId(model)) {
    failAdapter('invalid_format', `${field}.model`, CONTENT_FREE.invalid_format);
  }
  resolveRegistrySelectionV1({ provider, model });
}

function stripAssignment(assignment) {
  const stripped = {};
  for (const key of RUN_ASSIGNMENT_RUNTIME_KEYS) {
    if (capturedHasOwn(assignment, key)) stripped[key] = assignment[key];
  }
  return stripped;
}

function parseAssignments(value) {
  if (!ARRAY_IS_ARRAY(value) && !capturedIsArray(value)) {
    failAdapter('invalid_type', 'run.assignments', CONTENT_FREE.invalid_type);
  }
  if (value.length < MIN_ASSIGNMENTS || value.length > MAX_ASSIGNMENTS) {
    failAdapter('out_of_range', 'run.assignments', CONTENT_FREE.out_of_range);
  }
  const seenIds = new Set();
  const seenTasks = new Set();
  const parsed = [];
  const prompts = {};
  const durations = {};
  for (let index = 0; index < value.length; index += 1) {
    const path = `run.assignments[${index}]`;
    const assignment = quarantineObject(value[index], path, RUN_ASSIGNMENT_KEYS);
    const assignmentId = requireString(assignment, 'assignment_id', `${path}.assignment_id`, isAssignmentId);
    if (seenIds.has(assignmentId)) {
      failAdapter('duplicate_assignment_id', `${path}.assignment_id`, CONTENT_FREE.duplicate_assignment_id);
    }
    seenIds.add(assignmentId);
    const taskId = requireString(assignment, 'task_id', `${path}.task_id`,
      (candidate) => capturedTest(TASK_ID_PATTERN, candidate));
    if (seenTasks.has(taskId)) {
      failAdapter('duplicate_task_id', `${path}.task_id`, CONTENT_FREE.duplicate_task_id);
    }
    seenTasks.add(taskId);
    const provider = optionalValue(assignment, 'provider', `${path}.provider`);
    const model = optionalValue(assignment, 'model', `${path}.model`);
    const profile = optionalValue(assignment, 'profile', `${path}.profile`);
    if (provider === undefined && model === undefined) {
      if (typeof profile !== 'string' || !isProfileName(profile)) {
        failAdapter('selection_unresolved', path, CONTENT_FREE.selection_unresolved);
      }
    } else {
      if (typeof provider !== 'string') {
        failAdapter('selection_unresolved', `${path}.provider`, CONTENT_FREE.selection_unresolved);
      }
      assertRegistryProvider(provider, model, `${path}.provider`);
    }
    const prompt = optionalValue(assignment, 'prompt', `${path}.prompt`);
    if (prompt !== undefined) {
      if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 16384) {
        failAdapter('invalid_format', `${path}.prompt`, CONTENT_FREE.invalid_format);
      }
      prompts[assignmentId] = prompt;
    }
    const duration = optionalValue(assignment, 'expected_duration_ms', `${path}.expected_duration_ms`);
    if (duration !== undefined) durations[assignmentId] = duration;
    parsed.push(stripAssignment(assignment));
  }
  return { assignments: parsed, prompts, durations };
}

function parseSubmit(args) {
  if (mixLegacySingleTask('delegate', args)) {
    failAdapter('mixed_tool_mode', 'delegate', CONTENT_FREE.mixed_tool_mode);
  }
  const run = quarantineObject(optionalValue(args, 'run', 'run') ?? failAdapter('missing_key', 'run', CONTENT_FREE.missing_key),
    'run', RUN_SUBMIT_KEYS);
  for (const key of RUN_SUBMIT_REQUIRED_KEYS) {
    if (!hasOwn(run, key)) failAdapter('missing_key', `run.${key}`, CONTENT_FREE.missing_key);
  }
  const runId = requireString(run, 'run_id', 'run.run_id', (value) => {
    try { assertRunId(value, 'run.run_id'); return true; } catch { return false; }
  });
  const idempotency = requireString(run, 'request_idempotency_key', 'run.request_idempotency_key',
    (value) => capturedTest(IDEMPOTENCY_KEY_PATTERN, value));
  const profile = optionalValue(run, 'profile', 'run.profile');
  if (profile !== undefined && (typeof profile !== 'string' || !isProfileName(profile))) {
    failAdapter('invalid_format', 'run.profile', CONTENT_FREE.invalid_format);
  }
  const { assignments, prompts, durations } = parseAssignments(ownDataValue(run, 'assignments', 'run.assignments'));
  const unresolved = assignments.some((assignment) => assignment.provider === undefined
    || assignment.model === undefined);
  if (unresolved && (typeof profile !== 'string' || !isProfileName(profile))) {
    failAdapter('selection_unresolved', 'run.assignments', CONTENT_FREE.selection_unresolved);
  }
  if (unresolved) {
    failAdapter('selection_unresolved', 'run.assignments', CONTENT_FREE.selection_unresolved);
  }
  const objective = optionalValue(run, 'objective', 'run.objective');
  return {
    runId,
    runtimeRequest: freezeData({
      run_id: runId,
      request_idempotency_key: idempotency,
      identity: ownDataValue(run, 'identity', 'run.identity'),
      git: ownDataValue(run, 'git', 'run.git'),
      provenance: ownDataValue(run, 'provenance', 'run.provenance'),
      telemetry: ownDataValue(run, 'telemetry', 'run.telemetry'),
      assignments,
    }),
    context: freezeData({
      run_id: runId,
      objective: typeof objective === 'string' ? objective : null,
      profile: typeof profile === 'string' ? profile : null,
      prompts,
      durations,
      repository_path: run.git && typeof run.git === 'object' ? run.git.repository_path ?? null : null,
    }),
  };
}

function requireRunId(args, field = 'run_id') {
  const runId = requireString(args, 'run_id', field, (value) => {
    try { assertRunId(value, field); return true; } catch { return false; }
  });
  return runId;
}

function parseAssignmentIds(value, field) {
  if (value === undefined) return undefined;
  if (!ARRAY_IS_ARRAY(value) && !capturedIsArray(value)) {
    failAdapter('invalid_type', field, CONTENT_FREE.invalid_type);
  }
  if (value.length < MIN_ASSIGNMENTS || value.length > MAX_ASSIGNMENTS) {
    failAdapter('out_of_range', field, CONTENT_FREE.out_of_range);
  }
  const ids = [];
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    if (!isAssignmentId(id)) failAdapter('invalid_format', `${field}[${index}]`, CONTENT_FREE.invalid_format);
    ids.push(id);
  }
  return ids;
}

function projectCandidate(runId) {
  const ref = expectedCandidateRefV1({ run_id: runId });
  return freezeData({
    ref,
    composed: false,
    ready_for_codex_review: false,
    authority: 'p35',
    namespace: CANDIDATE_REF_NAMESPACE,
    accepted: isRunOwnedCandidateRefV1(ref, runId),
  });
}

function projectLane(lane, projectLaneTask, classifyLaneTask) {
  if (lane === undefined || lane === null || typeof lane !== 'object') return lane;
  const copy = { ...lane };
  if (copy.task && typeof copy.task === 'object') {
    if (typeof classifyLaneTask === 'function') {
      copy.truth = classifyLaneTask(copy.task);
    }
    copy.task = typeof projectLaneTask === 'function'
      ? projectLaneTask(copy.task)
      : copy.task;
  }
  if (copy.artifacts && typeof copy.artifacts === 'object') {
    const artifacts = { ...copy.artifacts };
    if (capturedHasOwn(artifacts, 'raw')) delete artifacts.raw;
    if (capturedHasOwn(artifacts, 'bytes')) delete artifacts.bytes;
    copy.artifacts = artifacts;
  }
  return freezeData(copy);
}

function projectReceipt(tool, operation, runtimeReceipt, projectLaneTask, classifyLaneTask) {
  const runId = runtimeReceipt?.run_id;
  const lanes = ARRAY_IS_ARRAY(runtimeReceipt?.lanes)
    ? runtimeReceipt.lanes.map((lane) => projectLane(lane, projectLaneTask, classifyLaneTask))
    : [];
  const blocked = runtimeReceipt?.complete_candidate_blocked === true
    || lanes.some((lane) => lane?.required !== false && (
      lane.status === 'unresolved'
      || lane.status === 'failed'
      || lane.status === 'lifecycle_pending'
      || lane.status === 'transport_lost'
    ));
  const sideEffects = emptySideEffects();
  if (runtimeReceipt?.side_effects?.task_dispatched === true) sideEffects.provider_dispatched = true;
  if (runtimeReceipt?.side_effects?.task_cancelled === true
    || (runtimeReceipt?.cleanup && runtimeReceipt.cleanup.cleaned === true)) {
    sideEffects.cleanup_executed = runtimeReceipt?.cleanup?.cleaned === true;
  }
  const attention = runtimeReceipt?.attention ?? freezeData({
    batch_id: null, status: null, revision: null, wake: false,
    complete_candidate_blocked: blocked,
  });
  return freezeData({
    schema: RUN_TOOL_ADAPTER_RECEIPT_SCHEMA_ID,
    version: RUN_TOOL_ADAPTER_VERSION,
    mode: 'run',
    tool,
    operation,
    status: runtimeReceipt?.status ?? 'inspected',
    run_id: runId,
    assignment_count: runtimeReceipt?.assignment_count ?? lanes.length,
    lanes,
    attention,
    cleanup: runtimeReceipt?.cleanup ?? freezeData({
      cleaned: false, proof_bound: true, removed: 0, remaining: null, unresolved: [],
    }),
    decision_or_attention: freezeData({
      wake: false,
      attention: attention?.status === 'open' || lanes.some((lane) => lane?.status === 'needs_attention'),
      unresolved_required_blocks: blocked,
      exactly_once_reply: attention?.status === 'reply_committed' || attention?.status === 'resolved',
    }),
    candidate: runId ? projectCandidate(runId) : null,
    complete_candidate_blocked: blocked,
    checks: emptyChecks(),
    side_effects: sideEffects,
    audience: 'model',
    wake: false,
    remote_mutated: false,
  });
}

function assertFunctionMap(value, field, methods) {
  assertPlainObject(value, 'injected_dependency_invalid', field, 'The injected seam');
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      failAdapter('injected_dependency_invalid', `${field}.${method}`,
        CONTENT_FREE.injected_dependency_invalid);
    }
    assertNotProxy(value[method], `${field}.${method}`);
  }
  return value;
}

export function denyRunToolRemoteMutationV1(operation) {
  return denyRunRemoteMutationV1(operation);
}

export function describeRunToolAdapterV1() {
  const registry = describeProviderRegistryV1();
  return freezeData({
    schema: RUN_TOOL_ADAPTER_SCHEMA_ID,
    version: RUN_TOOL_ADAPTER_VERSION,
    receipt_schema: RUN_TOOL_ADAPTER_RECEIPT_SCHEMA_ID,
    catalog: PUBLIC_MCP_CATALOG,
    operations: RUN_TOOL_OPERATIONS,
    modes: RUN_TOOL_MODES,
    additive: capturedFreeze({
      status: ADDITIVE_STATUS_KEYS,
      delegate: ADDITIVE_DELEGATE_KEYS,
      task: ADDITIVE_TASK_KEYS,
      tasks: ADDITIVE_TASKS_KEYS,
      cancel: ADDITIVE_CANCEL_KEYS,
      wait_until: ADDITIVE_WAIT_UNTIL,
    }),
    wait_until: WAIT_UNTIL_VALUES,
    registry_slots: [...PROVIDER_REGISTRY_SLOTS],
    registry_rule: registry.selection_rule,
    p22: capturedFreeze({
      provider_slot: registry.future_harness?.provider_slot ?? null,
      composable: false,
      surface: 'conformance_evidence',
    }),
    checks: RUN_TOOL_ADAPTER_CHECKS,
    side_effects: RUN_TOOL_ADAPTER_SIDE_EFFECTS,
    error_codes: RUN_TOOL_ADAPTER_ERROR_CODES,
    bounds: capturedFreeze({
      assignments: capturedFreeze({ min: MIN_ASSIGNMENTS, max: MAX_ASSIGNMENTS }),
    }),
    candidate_ref_authority: 'p35',
    lifecycle_authority: 'p33',
    attention_authority: 'p34',
    truth_projection: 'r-truth',
    wake: false,
    remote_mutated: false,
    sixth_tool: false,
  });
}

export function createRunToolAdapter(dependencies) {
  if (dependencies === undefined || dependencies === null) {
    failAdapter('injected_dependency_invalid', 'dependencies', CONTENT_FREE.injected_dependency_invalid);
  }
  assertNotProxy(dependencies, 'dependencies');
  assertPlainObject(dependencies, 'injected_dependency_invalid', 'dependencies',
    'createRunToolAdapter dependencies');
  for (const key of ownKeySet(dependencies, 'dependencies')) {
    if (!capturedIncludes(ADAPTER_DEPENDENCY_KEYS, key)) {
      failAdapter('unknown_key', `dependencies.${key}`, CONTENT_FREE.unknown_key);
    }
  }
  const runtime = assertFunctionMap(
    ownDataValue(dependencies, 'runtime', 'dependencies.runtime'),
    'dependencies.runtime',
    RUNTIME_METHODS,
  );
  const attention = hasOwn(dependencies, 'attention')
    ? assertFunctionMap(ownDataValue(dependencies, 'attention', 'dependencies.attention'),
      'dependencies.attention', ATTENTION_METHODS)
    : null;
  const rememberSubmitContext = hasOwn(dependencies, 'rememberSubmitContext')
    ? ownDataValue(dependencies, 'rememberSubmitContext', 'dependencies.rememberSubmitContext')
    : null;
  if (rememberSubmitContext !== null && typeof rememberSubmitContext !== 'function') {
    failAdapter('injected_dependency_invalid', 'dependencies.rememberSubmitContext',
      CONTENT_FREE.injected_dependency_invalid);
  }
  const projectLaneTask = hasOwn(dependencies, 'projectLaneTask')
    ? ownDataValue(dependencies, 'projectLaneTask', 'dependencies.projectLaneTask')
    : null;
  const classifyLaneTask = hasOwn(dependencies, 'classifyLaneTask')
    ? ownDataValue(dependencies, 'classifyLaneTask', 'dependencies.classifyLaneTask')
    : null;
  if (projectLaneTask !== null && typeof projectLaneTask !== 'function') {
    failAdapter('injected_dependency_invalid', 'dependencies.projectLaneTask',
      CONTENT_FREE.injected_dependency_invalid);
  }
  if (classifyLaneTask !== null && typeof classifyLaneTask !== 'function') {
    failAdapter('injected_dependency_invalid', 'dependencies.classifyLaneTask',
      CONTENT_FREE.injected_dependency_invalid);
  }

  const counters = {
    submit: 0, inspect: 0, resume: 0, cancel: 0, reply: 0,
  };

  async function dispatch(tool, args) {
    const classified = classifyRunToolCall(tool, args);
    if (classified.mode === 'legacy') return classified;
    assertClosedTool(tool);
    if (args === undefined || args === null || typeof args !== 'object') {
      failAdapter('invalid_type', 'arguments', CONTENT_FREE.invalid_type);
    }
    assertNotProxy(args, 'arguments');
    assertDirectJsonClosure(args, 'arguments');
    denyForbiddenTree(args, 'arguments');
    const operation = resolveOperation(tool, args);
    if ((tool === 'task' || tool === 'cancel' || tool === 'delegate' || tool === 'tasks')
      && mixLegacySingleTask(tool, args) && tool !== 'tasks') {
      failAdapter('mixed_tool_mode', tool, CONTENT_FREE.mixed_tool_mode);
    }
    if (tool === 'tasks' && mixLegacySingleTask('tasks', args) && capturedHasOwn(args, 'run_id')) {
      failAdapter('mixed_tool_mode', 'tasks', CONTENT_FREE.mixed_tool_mode);
    }

    let runtimeReceipt;
    if (operation === 'submit') {
      const parsed = parseSubmit(args);
      if (rememberSubmitContext) rememberSubmitContext(parsed.context);
      counters.submit += 1;
      runtimeReceipt = await runtime.submitRun(parsed.runtimeRequest);
    } else if (operation === 'status') {
      const runId = requireRunId(args);
      const assignmentId = optionalValue(args, 'assignment_id', 'assignment_id');
      if (assignmentId !== undefined && !isAssignmentId(assignmentId)) {
        failAdapter('invalid_format', 'assignment_id', CONTENT_FREE.invalid_format);
      }
      counters.inspect += 1;
      runtimeReceipt = await runtime.inspectRun({
        run_id: runId,
        ...(assignmentId !== undefined ? { assignment_id: assignmentId } : {}),
      });
    } else if (operation === 'wait') {
      const runId = requireRunId(args);
      const waitUntil = waitUntilValue(args);
      if (waitUntil !== undefined && !capturedIncludes(WAIT_UNTIL_VALUES, waitUntil)) {
        failAdapter('invalid_format', 'wait_until', CONTENT_FREE.invalid_format);
      }
      counters.inspect += 1;
      runtimeReceipt = await runtime.inspectRun({ run_id: runId });
    } else if (operation === 'attention') {
      const runId = requireRunId(args);
      const attentionRequest = quarantineObject(
        ownDataValue(args, 'attention', 'attention'),
        'attention',
        ATTENTION_REQUEST_KEYS,
      );
      const items = ownDataValue(attentionRequest, 'items', 'attention.items');
      if (!ARRAY_IS_ARRAY(items) || items.length < MIN_ASSIGNMENTS || items.length > MAX_ASSIGNMENTS) {
        failAdapter('out_of_range', 'attention.items', CONTENT_FREE.out_of_range);
      }
      counters.resume += 1;
      runtimeReceipt = await runtime.resumeRun({
        run_id: runId,
        attention_items: items,
      });
    } else if (operation === 'reply') {
      const runId = requireRunId(args);
      if (attention === null) {
        failAdapter('injected_dependency_invalid', 'attention', CONTENT_FREE.injected_dependency_invalid);
      }
      const replyRequest = quarantineObject(
        ownDataValue(args, 'run_reply', 'run_reply'),
        'run_reply',
        RUN_REPLY_KEYS,
      );
      counters.reply += 1;
      const attentionReceipt = await attention.reply({
        run_id: runId,
        batch_id: ownDataValue(replyRequest, 'batch_id', 'run_reply.batch_id'),
        expected_revision: optionalValue(replyRequest, 'expected_revision', 'run_reply.expected_revision'),
        reply: ownDataValue(replyRequest, 'reply', 'run_reply.reply'),
      });
      counters.inspect += 1;
      runtimeReceipt = await runtime.inspectRun({ run_id: runId });
      runtimeReceipt = freezeData({
        ...runtimeReceipt,
        attention: attentionReceipt,
      });
    } else if (operation === 'cancel' || operation === 'cleanup') {
      const runId = requireRunId(args);
      let assignmentIds = parseAssignmentIds(
        optionalValue(args, 'assignment_ids', 'assignment_ids'),
        'assignment_ids',
      );
      if (assignmentIds === undefined) {
        counters.inspect += 1;
        const inspected = await runtime.inspectRun({ run_id: runId });
        assignmentIds = ARRAY_IS_ARRAY(inspected?.lanes)
          ? inspected.lanes.map((lane) => lane.assignment_id).filter((id) => typeof id === 'string')
          : [];
        if (assignmentIds.length < MIN_ASSIGNMENTS) {
          failAdapter('missing_key', 'assignment_ids', CONTENT_FREE.missing_key);
        }
      }
      counters.cancel += 1;
      runtimeReceipt = await runtime.cancelRun({
        run_id: runId,
        assignment_ids: assignmentIds,
        cleanup: operation === 'cleanup',
      });
    } else {
      failAdapter('unknown_operation', 'tool', CONTENT_FREE.unknown_operation);
    }

    const projected = projectReceipt(
      tool, operation, runtimeReceipt, projectLaneTask, classifyLaneTask,
    );
    return projected;
  }

  return capturedFreeze({
    classify: classifyRunToolCall,
    dispatch,
    describe: describeRunToolAdapterV1,
    counters,
  });
}

export function createInProcessRunSeams(options = {}) {
  assertPlainObject(options, 'injected_dependency_invalid', 'options',
    'In-process run seams');
  const delegateTask = options.delegateTask;
  const inspectTask = options.inspectTask;
  const cancelTask = options.cancelTask;
  const settleLocalTaskLifecycle = options.settleLocalTaskLifecycle;
  const cleanupLocalTaskLifecycle = options.cleanupLocalTaskLifecycle;
  const clock = options.clock ?? (() => new Date().toISOString());
  if (typeof delegateTask !== 'function' || typeof inspectTask !== 'function'
    || typeof cancelTask !== 'function' || typeof settleLocalTaskLifecycle !== 'function'
    || typeof cleanupLocalTaskLifecycle !== 'function') {
    failAdapter('injected_dependency_invalid', 'options', CONTENT_FREE.injected_dependency_invalid);
  }
  const byId = new Map();
  const byKey = new Map();
  const runStore = {
    async submit(input) {
      const existing = byId.get(input.run_id);
      if (existing) {
        if (existing.request_idempotency_key !== input.request_idempotency_key) {
          failAdapter('invalid_format', 'run_id', CONTENT_FREE.invalid_format);
        }
        return { record: existing, created: false };
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
      if (!record) fail('run_store_not_found', 'run_id', CONTENT_FREE.invalid_format);
      return record;
    },
  };
  const journals = new Map();
  function journalHandle() {
    const state = {
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
    return {
      async currentState() {
        return { ...state, children: state.children.map((child) => ({ ...child })) };
      },
      async append(event) {
        const kind = event.kind;
        const data = event.data ?? {};
        if (kind === 'run_opened') state.run_opened = true;
        if (kind === 'child_started'
          && !state.children.some((child) => child.assignment_id === data.assignment_id)) {
          state.children.push({ assignment_id: data.assignment_id, outcome: null });
          state.child_count = state.children.length;
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
        state.head_hash = `sha256:${STRING(state.revision).padStart(64, 'a')}`;
        return { seq: state.revision, state: { ...state } };
      },
      async cursorAfter(seq) {
        return { seq, head_hash: state.head_hash, cursor: `cursor:${seq}` };
      },
      async readPage() {
        return { events: [], next_cursor: null };
      },
    };
  }
  const runJournal = {
    async create(request) {
      const handle = journalHandle();
      journals.set(request.run_id, handle);
      return handle;
    },
    async open(request) {
      const handle = journals.get(request.run_id);
      if (!handle) fail('run_journal_not_found', 'run_id', CONTENT_FREE.invalid_format);
      return handle;
    },
    async createAggregate(request) { return this.create(request); },
    async openAggregate(request) { return this.open(request); },
  };
  const aggregateAnchor = {
    async getCoordination() {
      fail('aggregate_run_not_found', 'run_id', CONTENT_FREE.invalid_format);
    },
  };
  const batches = new Map();
  const attentionBatch = {
    async latch(request) {
      const record = freezeData({
        schema: 'codex-co-engineer.attention-batch.v1',
        run_id: request.run_id,
        batch_id: `att-${request.run_id}`,
        revision: 1,
        status: 'open',
        source: request.source,
        items: request.items ?? [],
        reply: null,
        unresolved: [],
        complete_candidate_blocked: (request.items ?? []).some((item) => item.required !== false
          && item.reply_capability === 'unsupported'),
        wake: false,
      });
      batches.set(request.run_id, record);
      return record;
    },
    async reply(request) {
      const existing = batches.get(request.run_id);
      if (!existing) fail('attention_batch_not_found', 'run_id', CONTENT_FREE.invalid_format);
      const record = freezeData({
        ...existing,
        status: 'resolved',
        revision: (existing.revision ?? 1) + 1,
        reply: request.reply,
      });
      batches.set(request.run_id, record);
      return record;
    },
    async get(runId) {
      return batches.get(runId) ?? null;
    },
  };
  const artifactBridge = {
    async captureAssignmentArtifacts() {
      return freezeData({ schema: 'codex-co-engineer.run-artifact-bridge-capture.v1', created: false });
    },
    async projectAssignmentArtifacts(input) {
      return freezeData({
        schema: 'codex-co-engineer.run-artifact-bridge-projection.v1',
        run_id: input.run_id,
        assignment_id: input.assignment_id,
        artifacts: [],
      });
    },
    async cleanupRunArtifacts(input) {
      return freezeData({
        schema: 'codex-co-engineer.run-artifact-bridge-cleanup.v1',
        run_id: input.run_id,
        cleaned: true,
        proof_bound: true,
        removed: 0,
        remaining: 0,
        unresolved: [],
      });
    },
  };
  const scheduler = createRunScheduler({
    delegateTask,
    inspectTask,
    cancelTask,
    clock,
  });
  const runtime = createRunRuntime({
    runStore,
    runJournal,
    aggregateAnchor,
    attentionBatch,
    scheduler,
    artifactBridge,
    settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle,
    clock,
  });
  return capturedFreeze({
    runtime,
    attention: attentionBatch,
    scheduler,
    runStore,
    artifactBridge,
  });
}

export function classifyDeniedGitOperationV1(runId, operation) {
  return classifyGitOperationV1({
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'platform',
    operation,
    identity: {
      run_id: runId,
      assignment_id: 'platform-lane',
      base_sha: 'a'.repeat(40),
      repository_path: '/run-tool-adapter/repository',
    },
  });
}

capturedFreeze(denyRunToolRemoteMutationV1);
capturedFreeze(classifyRunToolCall);
capturedFreeze(describeRunToolAdapterV1);
capturedFreeze(createRunToolAdapter);
capturedFreeze(createInProcessRunSeams);
capturedFreeze(classifyDeniedGitOperationV1);
