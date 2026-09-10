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

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  openAttentionRoot,
  validateAttentionItemsV1,
} from './attention-batch.mjs';
import { MCP_PENDING_CALL_BUDGET_MS } from './contract.mjs';
import { submitReply } from './mailbox.mjs';
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
import { canonicalJsonStringify } from './identity.mjs';
import {
  findProfile,
  loadProfileCatalogSnapshot,
} from './profile.mjs';
import {
  PROVIDER_REGISTRY_SLOTS,
  describeProviderRegistryV1,
  isRegistrySlotV1,
  requireRegistrySlotV1,
  resolveRegistrySelectionV1,
} from './provider-registry.mjs';
import { createRunArtifactBridge } from './run-artifact-bridge.mjs';
import {
  createAggregateRunJournal,
  createRunJournal,
  openAggregateRunJournal,
  openRunJournal,
} from './run-journal.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  RUN_ID_PATTERN,
  RunContractV1Error,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  RUN_REQUEST_ALLOWED_KEYS,
  RUN_REQUEST_DERIVED_KEYS,
} from './run-request-compiler.mjs';
import { RUN_ADMISSION_METHODS } from './run-admission.mjs';
import {
  RUN_RUNTIME_METHODS,
  createRunRuntime,
} from './run-runtime.mjs';
import { createRunScheduler } from './run-scheduler.mjs';
import { openRunStore } from './run-store.mjs';
import { boundProviderResult, utf8Head } from './compact-task.mjs';
import { inspectDelegationPreferencesV1 } from './delegation-preferences.mjs';
import {
  parseOwnedRevisionRequestV1,
  OWNED_REVISION_REQUEST_KEYS,
} from './owned-delegation.mjs';
import { projectRunCoordinationResponseV1 } from './run-coordination-response.mjs';
import { projectExperience } from './response.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';

const semanticRunExperiences = new WeakMap();

export function experienceForRunToolResult(value) {
  if (!value || typeof value !== 'object') return null;
  return semanticRunExperiences.get(value) ?? value.experience ?? null;
}

export const RUN_TOOL_ADAPTER_SCHEMA_ID = 'codex-co-engineer.run-tool-adapter.v1';
export const RUN_TOOL_ADAPTER_VERSION = 1;
export const RUN_TOOL_ADAPTER_RECEIPT_SCHEMA_ID = 'codex-co-engineer.run-tool-receipt.v1';

export const PUBLIC_MCP_CATALOG = capturedFreeze([
  'status', 'delegate', 'task', 'tasks', 'cancel',
]);
export const RUN_TOOL_OPERATIONS = capturedFreeze([
  'submit', 'status', 'wait', 'attention', 'reply', 'revision', 'cancel', 'cleanup',
]);
export const RUN_TOOL_MODES = capturedFreeze(['legacy', 'run']);
export const ADDITIVE_WAIT_UNTIL = 'decision_or_attention';
export const WAIT_UNTIL_VALUES = capturedFreeze([
  'progress', 'terminal', ADDITIVE_WAIT_UNTIL,
]);

export const ADDITIVE_STATUS_KEYS = capturedFreeze(['run_id']);
export const ADDITIVE_DELEGATE_KEYS = capturedFreeze(['run', 'run_request']);
export const ADDITIVE_TASK_KEYS = capturedFreeze([
  'run_id', 'assignment_id', 'attention', 'run_reply', 'revision',
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
  'approval_ref', 'batch_id', 'expected_revision', 'reply', 'request_consent',
]);
export const REVISION_REQUEST_KEYS = OWNED_REVISION_REQUEST_KEYS;
export const RUN_TOOL_RECEIPT_KEYS = capturedFreeze([
  'assignment_count', 'attention', 'audience', 'candidate', 'checks',
  'cleanup', 'complete_candidate_blocked', 'decision_or_attention',
  'dispatch_uncertain_assignment_ids', 'dispatched_assignment_ids',
  'consent', 'coordination', 'cursor', 'error', 'experience', 'handoff', 'lanes', 'mode', 'operation', 'phase',
  'revision',
  'remote_mutated', 'run_id', 'schema', 'side_effects', 'status', 'tool',
  'undispatched_assignment_ids', 'version', 'wait_until', 'waited_ms', 'wake',
  'result',
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
export const SIMPLE_RUN_RECEIPT_STRUCTURED_BYTES_MAX = 72 * 1024;
export const SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX = 24 * 1024;

export const MAX_ADAPTER_DIAGNOSTIC_BYTES = 160;
export const RUN_ID_SCHEMA_PATTERN = RUN_ID_PATTERN.source;
export const MAX_RUN_TOOL_WAIT_MS = MCP_PENDING_CALL_BUDGET_MS;
export const RUN_TOOL_WAIT_POLL_MS = 25;
export const OWNER_ONLY_EVIDENCE_KEYS = capturedFreeze([
  'raw', 'bytes', 'secret', 'secrets', 'credential', 'credentials',
]);
export const ACTIONABLE_LANE_STATUSES = capturedFreeze([
  'needs_attention', 'completed', 'failed', 'cancelled', 'unresolved',
  'timeout', 'transport_lost', 'environment_blocked', 'failed_pre_prompt',
  'partial_handoff', 'unrecoverable_post_prompt',
]);

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
  durable_state_mismatch: 'Durable run state is stale, partial, or mismatched.',
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
  simple_runtime_unavailable: 'The 3.4.2 simple run runtime is unavailable.',
  preferred_provider_unavailable: 'The preferred provider is unknown or unavailable; supply an explicit provider.',
  revision_producer_active: 'A revision requires a completed, certain producer.',
  revision_producer_dirty: 'A revision requires a clean producer worktree.',
  revision_producer_stale: 'expected_head does not match the exact producer HEAD.',
  revision_identity_mismatch: 'expected_idempotency_key does not match the producer request identity.',
  revision_producer_not_found: 'The named producer assignment is not known.',
  revision_unsupported: 'Owned revision requires the supervisor reviseRun capability.',
  revision_workspace_unsupported: 'Remote candidate revision is not supported; a local inspectable HEAD is required.',
  revision_workspace_uninspectable: 'A revision requires a fresh successful workspace inspection.',
  revision_lifecycle_unfinal: 'A revision requires proven terminal lifecycle; unresolved cleanup is not a completed producer.',
});

export const RUN_TOOL_ADAPTER_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'aliased_reference_denied',
  'candidate_authority_denied',
  'catalog_sixth_tool_denied',
  'cleanup_unproven',
  'direct_mode_rejected',
  'durable_state_mismatch',
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
  'simple_runtime_unavailable',
  'preferred_provider_unavailable',
  'revision_producer_active',
  'revision_producer_dirty',
  'revision_producer_stale',
  'revision_identity_mismatch',
  'revision_producer_not_found',
  'revision_unsupported',
  'revision_workspace_unsupported',
  'revision_workspace_uninspectable',
  'revision_lifecycle_unfinal',
]);

const ADAPTER_DEPENDENCY_KEYS = capturedFreeze([
  'attention', 'classifyLaneTask', 'projectLaneTask', 'rememberSubmitContext',
  'runtime', 'simpleRuntime',
]);
const RUNTIME_METHODS = RUN_RUNTIME_METHODS;
const ATTENTION_METHODS = capturedFreeze(['get', 'reply']);
const SCHEDULER_PLAN_SCHEMA = 'codex-co-engineer.run-scheduler-plan.v1';
const CATALOG_SNAPSHOT_SCHEMA = 'codex-co-engineer.run-catalog-snapshot.v1';
const RECONSTRUCT_LANE_STATUSES = capturedFreeze([
  'dispatched', 'running', ...ACTIONABLE_LANE_STATUSES,
]);
const pendingRunCatalogSnapshots = new Map();
const pendingRunExperienceContext = new Map();
const SIMPLE_RUN_REQUEST_KEYS = capturedFreeze([
  ...RUN_REQUEST_ALLOWED_KEYS,
  ...RUN_REQUEST_DERIVED_KEYS,
]);

function rememberExperienceContext(runId, patch) {
  if (typeof runId !== 'string' || runId.length === 0) return;
  const current = pendingRunExperienceContext.get(runId) ?? {};
  pendingRunExperienceContext.set(runId, { ...current, ...patch });
}

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

function emptyChecks(observed) {
  const checks = {};
  for (const name of RUN_TOOL_ADAPTER_CHECKS) checks[name] = null;
  if (observed && typeof observed === 'object' && !capturedIsArray(observed)) {
    for (const name of RUN_TOOL_ADAPTER_CHECKS) {
      if (capturedHasOwn(observed, name) && typeof observed[name] === 'boolean') {
        checks[name] = observed[name];
      }
    }
  }
  return checks;
}

function providerResultFor(value) {
  if (value === undefined || value === null || typeof value !== 'object') return undefined;
  if (capturedHasOwn(value, 'result')) return value.result;
  if (capturedHasOwn(value, 'provider_result')) return value.provider_result;
  if (value.task && typeof value.task === 'object') {
    if (capturedHasOwn(value.task, 'result')) return value.task.result;
    if (capturedHasOwn(value.task, 'provider_result')) return value.task.provider_result;
  }
  return undefined;
}

function boundedProviderResult(raw) {
  return raw === undefined ? undefined : boundProviderResult(raw).value;
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

function delayMs(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('abort');
      return;
    }
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      resolve('timeout');
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('timeout');
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve('abort');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseWaitMs(args) {
  const value = optionalValue(args, 'wait_ms', 'wait_ms');
  if (value === undefined) return MAX_RUN_TOOL_WAIT_MS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_RUN_TOOL_WAIT_MS) {
    failAdapter('invalid_format', 'wait_ms', CONTENT_FREE.invalid_format);
  }
  return value;
}

function ownerOnlyKey(key) {
  return typeof key === 'string' && capturedIncludes(OWNER_ONLY_EVIDENCE_KEYS, key);
}

function sanitizeModelFacing(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  if (depth > 16) return null;
  if (IS_PROXY(value)) return freezeData({});
  if (ARRAY_IS_ARRAY(value) || capturedIsArray(value)) {
    return freezeData(value.map((entry) => sanitizeModelFacing(entry, depth + 1)));
  }
  const copy = {};
  let keys;
  try {
    keys = REFLECT_OWN_KEYS(value);
  } catch {
    return freezeData({});
  }
  for (const key of keys) {
    if (typeof key !== 'string' || ownerOnlyKey(key)) continue;
    copy[key] = sanitizeModelFacing(value[key], depth + 1);
  }
  return freezeData(copy);
}

function actionableDecision(receipt) {
  const attention = receipt?.attention;
  if (attention && (attention.status === 'open' || attention.status === 'reply_committed')) {
    return true;
  }
  const lanes = ARRAY_IS_ARRAY(receipt?.lanes) ? receipt.lanes : [];
  for (const lane of lanes) {
    if (typeof lane?.status === 'string' && capturedIncludes(ACTIONABLE_LANE_STATUSES, lane.status)) {
      return true;
    }
  }
  return receipt?.journal?.terminal === true;
}

function cursorsFromReceipt(receipt) {
  const lanes = ARRAY_IS_ARRAY(receipt?.lanes) ? receipt.lanes : [];
  const cursors = [];
  for (const lane of lanes) {
    if (typeof lane?.assignment_id !== 'string' || typeof lane?.task_id !== 'string') continue;
    const raw = lane.cursor;
    const eventCursor = typeof raw === 'string'
      ? raw
      : (raw && typeof raw === 'object' && typeof raw.event_cursor === 'string' ? raw.event_cursor : null);
    if (typeof eventCursor !== 'string' || !capturedTest(/^[0-9]{1,16}$/u, eventCursor)) continue;
    cursors.push({
      assignment_id: lane.assignment_id,
      task_id: lane.task_id,
      event_cursor: eventCursor,
    });
  }
  return cursors;
}

function assignmentNeedsNamedProfile(assignment) {
  if (assignment === undefined || assignment === null || typeof assignment !== 'object') return false;
  return capturedHasOwn(assignment, 'profile');
}

function submitNeedsCatalogSnapshot(run, assignments) {
  const profile = optionalValue(run, 'profile', 'run.profile');
  if (typeof profile === 'string') return true;
  if (!ARRAY_IS_ARRAY(assignments) && !capturedIsArray(assignments)) return false;
  for (const assignment of assignments) {
    if (assignmentNeedsNamedProfile(assignment)) return true;
  }
  return false;
}

async function loadBoundCatalogSnapshot(repositoryPath) {
  if (typeof repositoryPath !== 'string' || repositoryPath.length === 0 || !path.isAbsolute(repositoryPath)) {
    failAdapter('selection_unresolved', 'run.profile', CONTENT_FREE.selection_unresolved);
  }
  try {
    return await loadProfileCatalogSnapshot({ repositoryPath });
  } catch (error) {
    if (error instanceof RunContractV1Error && error.code === 'selection_unresolved') throw error;
    failAdapter('selection_unresolved', 'run.profile', CONTENT_FREE.selection_unresolved);
  }
  return null;
}

function lookupSnapshotDefinition(snapshot, name, field) {
  if (snapshot === null || snapshot === undefined) {
    failAdapter('selection_unresolved', field, CONTENT_FREE.selection_unresolved);
  }
  let found;
  try {
    found = findProfile(snapshot, name);
  } catch (error) {
    if (error instanceof RunContractV1Error && error.code === 'invalid_profile_name') {
      failAdapter('invalid_format', field, CONTENT_FREE.invalid_format);
    }
    failAdapter('selection_unresolved', field, CONTENT_FREE.selection_unresolved);
  }
  if (found === undefined || found === null || found.definition === undefined) {
    failAdapter('selection_unresolved', field, CONTENT_FREE.selection_unresolved);
  }
  return found.definition;
}

function resolveAssignmentSelection(assignment, path, runProfile, snapshot) {
  const provider = optionalValue(assignment, 'provider', `${path}.provider`);
  const model = optionalValue(assignment, 'model', `${path}.model`);
  const assignmentProfile = optionalValue(assignment, 'profile', `${path}.profile`);
  if (assignmentProfile !== undefined && (typeof assignmentProfile !== 'string' || !isProfileName(assignmentProfile))) {
    failAdapter('invalid_format', `${path}.profile`, CONTENT_FREE.invalid_format);
  }
  const named = typeof assignmentProfile === 'string' ? assignmentProfile : runProfile;
  let definition = null;
  if (typeof named === 'string') {
    definition = lookupSnapshotDefinition(snapshot, named, path);
  }
  let resolvedProvider = provider;
  let resolvedModel = model;
  if (definition !== null) {
    if (resolvedProvider !== undefined && definition.provider
      && resolvedProvider !== definition.provider) {
      failAdapter('selection_unresolved', `${path}.provider`, CONTENT_FREE.selection_unresolved);
    }
    if (resolvedModel !== undefined && definition.model
      && resolvedModel !== definition.model) {
      failAdapter('selection_unresolved', `${path}.model`, CONTENT_FREE.selection_unresolved);
    }
    if (resolvedProvider === undefined && typeof definition.provider === 'string') {
      resolvedProvider = definition.provider;
    }
    if (resolvedModel === undefined && typeof definition.model === 'string') {
      resolvedModel = definition.model;
    }
  }
  if (typeof resolvedProvider !== 'string') {
    failAdapter('selection_unresolved', `${path}.provider`, CONTENT_FREE.selection_unresolved);
  }
  assertRegistryProvider(resolvedProvider, resolvedModel, `${path}.provider`);
  return { provider: resolvedProvider, model: resolvedModel };
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
    const hasRevision = capturedHasOwn(args, 'revision');
    const waitUntil = waitUntilValue(args);
    const flagged = [hasAttention, hasReply, hasRevision, waitUntil === ADDITIVE_WAIT_UNTIL]
      .filter(Boolean).length;
    if (flagged > 1) {
      failAdapter('mixed_run_operation', 'task', CONTENT_FREE.mixed_run_operation);
    }
    if (hasAttention) return 'attention';
    if (hasReply) return 'reply';
    if (hasRevision) return 'revision';
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

function parseAssignments(value, runProfile, snapshot) {
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
    const assignmentPath = `run.assignments[${index}]`;
    const assignment = quarantineObject(value[index], assignmentPath, RUN_ASSIGNMENT_KEYS);
    const assignmentId = requireString(assignment, 'assignment_id', `${assignmentPath}.assignment_id`, isAssignmentId);
    if (seenIds.has(assignmentId)) {
      failAdapter('duplicate_assignment_id', `${assignmentPath}.assignment_id`, CONTENT_FREE.duplicate_assignment_id);
    }
    seenIds.add(assignmentId);
    const taskId = requireString(assignment, 'task_id', `${assignmentPath}.task_id`,
      (candidate) => capturedTest(TASK_ID_PATTERN, candidate));
    if (seenTasks.has(taskId)) {
      failAdapter('duplicate_task_id', `${assignmentPath}.task_id`, CONTENT_FREE.duplicate_task_id);
    }
    seenTasks.add(taskId);
    const resolved = resolveAssignmentSelection(
      assignment, assignmentPath, runProfile, snapshot,
    );
    const prompt = optionalValue(assignment, 'prompt', `${assignmentPath}.prompt`);
    if (prompt !== undefined) {
      if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 16384) {
        failAdapter('invalid_format', `${assignmentPath}.prompt`, CONTENT_FREE.invalid_format);
      }
      prompts[assignmentId] = prompt;
    }
    const duration = optionalValue(assignment, 'expected_duration_ms', `${assignmentPath}.expected_duration_ms`);
    if (duration !== undefined) durations[assignmentId] = duration;
    const stripped = stripAssignment(assignment);
    stripped.provider = resolved.provider;
    stripped.model = resolved.model;
    parsed.push(stripped);
  }
  return { assignments: parsed, prompts, durations };
}

async function parseSubmit(args) {
  if (mixLegacySingleTask('delegate', args)) {
    failAdapter('mixed_tool_mode', 'delegate', CONTENT_FREE.mixed_tool_mode);
  }
  const simpleRequest = optionalValue(args, 'run_request', 'run_request');
  if (simpleRequest !== undefined) {
    if (capturedHasOwn(args, 'run')) {
      failAdapter('mixed_run_operation', 'delegate', CONTENT_FREE.mixed_run_operation);
    }
    const request = quarantineObject(simpleRequest, 'run_request', SIMPLE_RUN_REQUEST_KEYS);
    const runId = requireString(request, 'run_id', 'run_request.run_id', (value) => {
      try { assertRunId(value, 'run_request.run_id'); return true; } catch { return false; }
    });
    const objective = optionalValue(request, 'objective', 'run_request.objective');
    return {
      runId,
      simpleRequest: request,
      context: freezeData({
        run_id: runId,
        objective: typeof objective === 'string' ? objective : null,
        profile: null,
        catalog_digest: null,
        prompts: {},
        durations: {},
        repository_path: typeof request.repo === 'string' ? request.repo : null,
        base_sha: typeof request.base_sha === 'string' ? request.base_sha : null,
      }),
      catalogSnapshot: null,
    };
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
  const git = ownDataValue(run, 'git', 'run.git');
  const repositoryPath = git && typeof git === 'object' ? git.repository_path ?? null : null;
  const rawAssignments = ownDataValue(run, 'assignments', 'run.assignments');
  const snapshot = submitNeedsCatalogSnapshot(run, rawAssignments)
    ? await loadBoundCatalogSnapshot(repositoryPath)
    : null;
  const { assignments, prompts, durations } = parseAssignments(
    rawAssignments,
    typeof profile === 'string' ? profile : undefined,
    snapshot,
  );
  const unresolved = assignments.some((assignment) => typeof assignment.provider !== 'string'
    || typeof assignment.model !== 'string');
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
      git,
      provenance: ownDataValue(run, 'provenance', 'run.provenance'),
      telemetry: ownDataValue(run, 'telemetry', 'run.telemetry'),
      assignments,
    }),
    context: freezeData({
      run_id: runId,
      objective: typeof objective === 'string' ? objective : null,
      profile: typeof profile === 'string' ? profile : null,
      catalog_digest: typeof snapshot?.catalog_digest === 'string' ? snapshot.catalog_digest : null,
      prompts,
      durations,
      repository_path: repositoryPath,
    }),
    catalogSnapshot: snapshot,
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

function projectCandidate(runId, runtimeCandidate) {
  const expectedRef = expectedCandidateRefV1({ run_id: runId });
  const actual = runtimeCandidate && typeof runtimeCandidate === 'object'
    && !capturedIsArray(runtimeCandidate)
    ? runtimeCandidate
    : null;
  const ref = actual && typeof actual.ref === 'string'
    && isRunOwnedCandidateRefV1(actual.ref, runId)
    ? actual.ref
    : expectedRef;
  const authoritative = actual?.authority === 'p35';
  return freezeData({
    ref,
    composed: actual?.composed === true,
    ready_for_codex_review: actual?.ready_for_codex_review === true,
    authority: 'p35',
    namespace: CANDIDATE_REF_NAMESPACE,
    accepted: authoritative && actual?.accepted === true
      && isRunOwnedCandidateRefV1(ref, runId),
  });
}

function providerResultExceededDefaultBound(raw) {
  if (raw === undefined) return false;
  try {
    return byteLength(raw) > 8_192;
  } catch {
    return false;
  }
}

function projectLane(lane, projectLaneTask, classifyLaneTask, reportTruncation = false) {
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
    copy.artifacts = sanitizeModelFacing(copy.artifacts);
  }
  const rawResult = providerResultFor(copy);
  if (rawResult !== undefined) {
    const bounded = boundProviderResult(rawResult);
    copy.result = bounded.value;
    if (reportTruncation === true
      && (bounded.truncated === true || providerResultExceededDefaultBound(rawResult))) {
      copy.result_truncated = true;
    }
    if (capturedHasOwn(copy, 'provider_result')) delete copy.provider_result;
  }
  return sanitizeModelFacing(copy);
}

function cancellationUnconfirmed(operation, lanes) {
  if (operation !== 'cancel' && operation !== 'cleanup') return false;
  for (const lane of lanes) {
    if (lane?.unresolved?.code === 'safe_cancel_unconfirmed') return true;
    if (lane?.cancel_confirmed === false) return true;
  }
  return false;
}

function attentionRecord(receipt) {
  if (receipt === undefined || receipt === null || typeof receipt !== 'object') return receipt;
  if (receipt.record !== undefined && receipt.record !== null && typeof receipt.record === 'object') {
    return {
      ...receipt.record,
      complete_candidate_blocked: receipt.complete_candidate_blocked === true
        || receipt.record.complete_candidate_blocked === true,
    };
  }
  return receipt;
}

function compactAdmissionHandoff(handoff) {
  if (handoff === undefined || handoff === null || typeof handoff !== 'object' || Array.isArray(handoff)) return null;
  return {
    schema: handoff.schema ?? 'codex-co-engineer.partial-handoff.v1',
    assignment_id: handoff.assignment_id ?? null,
    worktree: typeof handoff.worktree === 'string' ? handoff.worktree.slice(0, 512) : null,
    branch: typeof handoff.branch === 'string' ? handoff.branch.slice(0, 256) : null,
    starting_sha: handoff.starting_sha ?? null,
    current_head: handoff.current_head ?? null,
    clean: typeof handoff.clean === 'boolean' ? handoff.clean : null,
    changed_files: Array.isArray(handoff.changed_files) ? handoff.changed_files.slice(0, 16) : [],
    commits: Array.isArray(handoff.commits) ? handoff.commits.slice(0, 16) : [],
    no_commit: handoff.no_commit === true,
    partial_diff: handoff.partial_diff === true,
    last_acknowledged_provider_event: handoff.last_acknowledged_provider_event ?? null,
    recovery_classification: handoff.recovery_classification ?? null,
    safe_next_actions: Array.isArray(handoff.safe_next_actions) ? handoff.safe_next_actions.slice(0, 3) : [],
    diagnostics: 'Use the run-scoped diagnostics/provenance view for full handoff evidence.',
  };
}

function compactAdmissionLane(lane) {
  if (lane === undefined || lane === null || typeof lane !== 'object' || Array.isArray(lane)) return lane;
  const rawResult = providerResultFor(lane);
  const bounded = rawResult === undefined ? null : boundProviderResult(rawResult);
  const result = bounded?.value;
  return {
    assignment_id: lane.assignment_id ?? null,
    task_id: lane.task_id ?? null,
    provider: lane.provider ?? null,
    model: lane.model ?? null,
    role: lane.role ?? null,
    access: lane.access ?? null,
    required: lane.required !== false,
    phase: lane.phase ?? lane.status ?? null,
    status: lane.status ?? lane.phase ?? null,
    prepared: lane.prepared === true,
    session_ready: lane.session_ready === true,
    prompt_attempted: lane.prompt_attempted === true,
    prompt_dispatched: lane.prompt_dispatched === true,
    dispatch_confidence: lane.dispatch_confidence ?? null,
    session_id: lane.session_id ?? null,
    cursor: lane.cursor ?? null,
    child_identity_digest: lane.child_identity_digest ?? null,
    dispatch_identity_digest: lane.dispatch_identity_digest ?? null,
    provider_run_identity_digest: lane.provider_run_identity_digest ?? null,
    workspace_identity_digest: lane.workspace_identity_digest
      ?? lane.workspace_identity?.digest
      ?? null,
    error: lane.error ?? null,
    recovery_classification: lane.recovery_classification ?? null,
    cancel_confirmed: lane.cancel_confirmed ?? null,
    task_final: lane.task_final ?? null,
    result_truncated: lane.result_truncated === true || bounded?.truncated === true,
    handoff: compactAdmissionHandoff(lane.handoff),
    ...(rawResult !== undefined ? { result } : {}),
  };
}

function compactSemanticHandoff(handoff) {
  if (handoff === null || typeof handoff !== 'object' || Array.isArray(handoff)) return null;
  return {
    ...(typeof handoff.worktree === 'string' ? { worktree: handoff.worktree } : {}),
    ...(typeof handoff.branch === 'string' ? { branch: handoff.branch } : {}),
    ...(typeof handoff.current_head === 'string' ? { head: handoff.current_head } : {}),
    ...(typeof handoff.clean === 'boolean' ? { clean: handoff.clean } : {}),
    ...(handoff.partial_diff === true ? { partial: true } : {}),
  };
}

function compactSemanticLane(lane) {
  const projected = {
    assignment_id: lane.assignment_id ?? null,
    task_id: lane.task_id ?? null,
    provider: lane.provider ?? null,
    ...(typeof lane.role === 'string' ? { role: lane.role } : {}),
    status: lane.status ?? lane.phase ?? null,
    required: lane.required !== false,
    prompt_dispatched: lane.prompt_dispatched === true,
  };
  if (lane.dispatch_confidence != null) projected.dispatch_confidence = lane.dispatch_confidence;
  if (lane.result != null) projected.result = lane.result;
  if (lane.result_truncated === true) projected.result_truncated = true;
  if (lane.error != null) projected.error = lane.error;
  if (lane.recovery_classification != null) {
    projected.recovery_classification = lane.recovery_classification;
  }
  const handoff = compactSemanticHandoff(lane.handoff);
  if (handoff) projected.artifacts = handoff;
  return projected;
}

function cleanupNeedsAttention(receipt, unconfirmed) {
  const cleanup = receipt.cleanup;
  return unconfirmed === true
    || receipt.phase === 'lifecycle_pending'
    || cleanup?.proof_bound === false
    || (Array.isArray(cleanup?.unresolved) && cleanup.unresolved.length > 0)
    || (Number.isSafeInteger(cleanup?.remaining) && cleanup.remaining > 0)
    || (receipt.operation === 'cleanup' && cleanup?.cleaned !== true)
    || receipt.lanes.some((lane) => lane?.status === 'lifecycle_pending'
      || (lane?.task_final === false && ['cancelled', 'unresolved'].includes(lane?.status)));
}

function compactSha(value) {
  return typeof value === 'string' && capturedTest(/^[0-9a-fA-F]{40}$/u, value)
    ? value.toLowerCase()
    : null;
}

function compactSemanticCandidate(runtimeReceipt, projectedCandidate) {
  const source = runtimeReceipt?.candidate;
  const handoff = runtimeReceipt?.handoff;
  const hasSource = source && typeof source === 'object' && !Array.isArray(source);
  const hasHandoff = handoff && typeof handoff === 'object' && !Array.isArray(handoff);
  if (!hasSource && !hasHandoff) return null;
  const authoritative = source?.authority === 'p35';
  const head = compactSha(source?.head) ?? compactSha(handoff?.current_head);
  const tree = compactSha(source?.tree);
  const candidate = {
    ...(hasSource && isRunOwnedCandidateRefV1(source.ref, runtimeReceipt.run_id)
      ? { ref: projectedCandidate?.ref ?? null }
      : {}),
    ...(head ? { head } : {}),
    ...(tree ? { tree } : {}),
    ...(authoritative && projectedCandidate?.ready_for_codex_review === true
      ? { ready_for_codex_review: true }
      : {}),
    ...(projectedCandidate?.accepted === true ? { accepted: true } : {}),
  };
  return Object.keys(candidate).length > 0 ? candidate : null;
}

function compactOverflowReceipt(compact, simpleResponseCap) {
  const fallback = {
    schema: compact.schema,
    version: compact.version,
    mode: compact.mode,
    tool: compact.tool,
    operation: compact.operation,
    run_id: compact.run_id,
    status: compact.status,
    phase: compact.phase,
    cursor: compact.cursor,
    revision: compact.revision,
    assignment_count: compact.assignment_count,
    authoritative_required_dispatch: compact.authoritative_required_dispatch === true,
    lanes: compact.lanes.map((lane) => ({
      assignment_id: lane.assignment_id,
      task_id: lane.task_id,
      status: lane.status,
      required: lane.required,
      prompt_dispatched: lane.prompt_dispatched,
      ...(lane.result !== undefined ? { result_omitted: true } : {}),
      ...(lane.error?.code ? { error: { code: utf8Head(lane.error.code, 128) } } : {}),
    })),
    ...(compact.attention ? { attention: {
      status: compact.attention.status ?? null,
      batch_id: compact.attention.batch_id ?? null,
      revision: compact.attention.revision ?? null,
      details_omitted: true,
      reply_blocked: true,
    } } : {}),
    ...(compact.consent ? { consent: {
      status: compact.consent.status ?? compact.consent.consent?.status ?? null,
      details_omitted: true,
      decision_blocked: true,
    } } : {}),
    ...(compact.error?.code ? { error: { code: utf8Head(compact.error.code, 128) } } : {}),
    ...(compact.result !== undefined ? { result_omitted: true } : {}),
    ...(compact.candidate ? { candidate: compact.candidate } : {}),
    ...(compact.blockers ? { blockers: compact.blockers } : {}),
    diagnostics: {
      view: 'diagnostics',
      details_omitted: true,
      reason: 'response_size_limit',
      instruction: 'Repeat task with this run_id and view="diagnostics" before replying or accepting.',
    },
  };
  if (byteLength(fallback) <= simpleResponseCap) return fallback;
  return {
    schema: compact.schema,
    version: compact.version,
    mode: compact.mode,
    run_id: utf8Head(compact.run_id, 64),
    status: 'unresolved',
    phase: 'unresolved',
    cursor: utf8Head(compact.cursor, 256),
    error: { code: 'response_projection_overflow' },
    diagnostics: fallback.diagnostics,
  };
}

function projectSemanticRunReceipt(receipt, runtimeReceipt, {
  unconfirmed,
  simpleResponseCap,
  topLevelResultTruncated,
}) {
  const lanes = receipt.lanes.map(compactSemanticLane);
  const terminal = [
    'completed', 'failed', 'cancelled', 'degraded', 'unresolved',
    'partial_handoff', 'unrecoverable_post_prompt', 'lifecycle_pending',
  ].includes(receipt.phase);
  const verificationBlocked = terminal && receipt.complete_candidate_blocked === true;
  const cleanupBlocked = cleanupNeedsAttention(receipt, unconfirmed);
  const attention = receipt.attention;
  const attentionRequired = attention?.status === 'open'
    || attention?.status === 'blocked'
    || lanes.some((lane) => lane.status === 'needs_attention');
  const candidate = compactSemanticCandidate(runtimeReceipt, receipt.candidate);
  const verification = runtimeReceipt?.verification?.authority === 'p35'
    ? sanitizeModelFacing(runtimeReceipt.verification)
    : null;
  const topLevelResult = lanes.some((lane) => lane.result != null)
    ? undefined
    : receipt.result;
  const compact = {
    schema: receipt.schema,
    version: receipt.version,
    mode: receipt.mode,
    tool: receipt.tool,
    operation: receipt.operation,
    run_id: receipt.run_id,
    status: receipt.status,
    phase: receipt.phase,
    cursor: receipt.cursor,
    revision: receipt.revision,
    assignment_count: receipt.assignment_count,
    authoritative_required_dispatch: receipt.authoritative_required_dispatch === true,
    ...(runtimeReceipt?.persisted === false ? { persisted: false } : {}),
    ...(runtimeReceipt?.correction ? { correction: sanitizeModelFacing(runtimeReceipt.correction) } : {}),
    lanes,
    ...(attentionRequired || attention?.status === 'reply_committed' || attention?.status === 'resolved'
      ? { attention }
      : {}),
    ...(receipt.consent != null ? { consent: receipt.consent } : {}),
    ...(receipt.error != null ? { error: receipt.error } : {}),
    ...(topLevelResult !== undefined ? { result: topLevelResult } : {}),
    ...(topLevelResult !== undefined && topLevelResultTruncated === true
      ? { result_truncated: true }
      : {}),
    ...(candidate ? { candidate } : {}),
    coordination: projectRunCoordinationResponseV1(runtimeReceipt),
    ...(verification ? { verification } : {}),
    ...(receipt.operation === 'wait' ? {
      wait_until: receipt.wait_until,
      ...(Number.isSafeInteger(receipt.waited_ms) ? { waited_ms: receipt.waited_ms } : {}),
      wake: receipt.wake === true,
    } : {}),
    ...((verificationBlocked || cleanupBlocked) ? {
      blockers: {
        ...(verificationBlocked ? { verification: true } : {}),
        ...(cleanupBlocked ? { cleanup: true } : {}),
      },
    } : {}),
    ...(cleanupBlocked || receipt.operation === 'cleanup'
      ? { cleanup: receipt.cleanup }
      : {}),
    diagnostics: {
      view: 'diagnostics',
    },
  };
  if (byteLength(compact) > simpleResponseCap) {
    const resultCount = lanes.filter((lane) => lane.result !== undefined).length
      + (topLevelResult !== undefined ? 1 : 0);
    const resultFree = {
      ...compact,
      lanes: compact.lanes.map(({ result: _result, ...lane }) => lane),
      ...(topLevelResult !== undefined ? { result: undefined } : {}),
    };
    const available = Math.max(128, simpleResponseCap - byteLength(resultFree) - 2_048);
    const perResultBytes = Math.max(128, Math.floor(available / Math.max(1, resultCount)));
    const topBounded = topLevelResult !== undefined
      ? boundProviderResult(topLevelResult, perResultBytes)
      : null;
    const boundedCompact = {
      ...compact,
      lanes: lanes.map((lane) => {
        if (lane.result === undefined) return lane;
        const bounded = boundProviderResult(lane.result, perResultBytes);
        return {
          ...lane,
          result: bounded.value,
          result_truncated: lane.result_truncated === true || bounded.truncated === true,
        };
      }),
      ...(topBounded ? {
        result: topBounded.value,
        ...(topBounded.truncated === true ? { result_truncated: true } : {}),
      } : {}),
    };
    if (byteLength(boundedCompact) <= simpleResponseCap) return boundedCompact;
    return compactOverflowReceipt(compact, simpleResponseCap);
  }
  return compact;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compactProviderResult(result, taskId) {
  if (result === undefined) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = null;
  }
  return {
    truncated: true,
    detail_task_id: typeof taskId === 'string' ? taskId : null,
    preview: utf8Head(serialized ?? '', 768),
  };
}

function preferenceAttentionReceipt(runId, request, preferenceView) {
  void request;
  const items = ARRAY_IS_ARRAY(preferenceView?.attention?.items)
    ? preferenceView.attention.items
    : [];
  return {
    schema: 'codex-co-engineer.run-admission.v1',
    version: 1,
    run_id: runId,
    persisted: false,
    phase: 'not_admitted',
    status: 'not_admitted',
    revision: 0,
    cursor: '0',
    assignment_count: 0,
    lanes: [],
    complete_candidate_blocked: true,
    error: {
      code: 'preferred_provider_unavailable',
      message: CONTENT_FREE.preferred_provider_unavailable,
    },
    attention: {
      status: 'blocked',
      code: 'preferred_provider_unavailable',
      next_action: 'supply_explicit_provider',
      items,
      wake: false,
    },
    consent: null,
    admission: null,
    dispatched_assignment_ids: [],
    undispatched_assignment_ids: [],
    dispatch_uncertain_assignment_ids: [],
    authoritative_required_dispatch: false,
    already_terminal: false,
    telemetry: null,
    cleanup: null,
  };
}

function malformedRuntimeReceipt(runId) {
  return {
    schema: 'codex-co-engineer.run-admission.v1',
    version: 1,
    run_id: typeof runId === 'string' ? runId : null,
    phase: 'unresolved',
    status: 'unresolved',
    revision: null,
    cursor: null,
    assignment_count: 0,
    lanes: [],
    complete_candidate_blocked: true,
    error: {
      code: 'durable_state_mismatch',
      message: CONTENT_FREE.durable_state_mismatch,
    },
    attention: null,
    consent: null,
    admission: null,
    dispatched_assignment_ids: [],
    undispatched_assignment_ids: [],
    dispatch_uncertain_assignment_ids: [],
    authoritative_required_dispatch: false,
    already_terminal: false,
    telemetry: null,
    cleanup: null,
  };
}

function isRuntimeReceipt(value, expectedRunId) {
  if (value === undefined || value === null || typeof value !== 'object'
    || ARRAY_IS_ARRAY(value) || IS_PROXY(value)) return false;
  if (value.persisted === false) {
    if (typeof value.run_id !== 'string'
      || (typeof expectedRunId === 'string' && value.run_id !== expectedRunId)) return false;
    return typeof value.phase === 'string' || typeof value.status === 'string';
  }
  if (typeof value.run_id !== 'string'
    || (typeof expectedRunId === 'string' && value.run_id !== expectedRunId)) return false;
  if (!ARRAY_IS_ARRAY(value.lanes)
    || value.lanes.length < MIN_ASSIGNMENTS
    || value.lanes.length > MAX_ASSIGNMENTS) return false;
  for (const lane of value.lanes) {
    if (lane === null || typeof lane !== 'object'
      || ARRAY_IS_ARRAY(lane) || IS_PROXY(lane)
      || typeof lane.assignment_id !== 'string'
      || lane.assignment_id.length === 0
      || typeof lane.task_id !== 'string'
      || lane.task_id.length === 0
      || (lane.status !== undefined && typeof lane.status !== 'string')
      || (lane.phase !== undefined && typeof lane.phase !== 'string')
      || (lane.status === undefined && lane.phase === undefined)) return false;
  }
  if (value.assignment_count !== undefined
    && (!Number.isSafeInteger(value.assignment_count)
      || value.assignment_count < 0
      || value.assignment_count !== value.lanes.length)) return false;
  if (value.status !== undefined && (typeof value.status !== 'string' || value.status.length === 0)) return false;
  if (value.phase !== undefined && (typeof value.phase !== 'string' || value.phase.length === 0)) return false;
  if (value.status === undefined && value.phase === undefined) return false;
  if (value.revision !== undefined && value.revision !== null
    && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return false;
  if (value.cursor !== undefined && value.cursor !== null
    && typeof value.cursor !== 'string'
    && (typeof value.cursor !== 'object' || ARRAY_IS_ARRAY(value.cursor) || IS_PROXY(value.cursor))) return false;
  if (value.schema === 'codex-co-engineer.run-admission.v1'
    && typeof value.cursor === 'string'
    && !/^\d{1,16}$/u.test(value.cursor)) return false;
  return true;
}

function projectReceipt(tool, operation, runtimeReceipt, projectLaneTask, classifyLaneTask,
  wakeRequested = false, expectedRunId = null, view = null) {
  if (!isRuntimeReceipt(runtimeReceipt, expectedRunId)) {
    runtimeReceipt = malformedRuntimeReceipt(expectedRunId);
  }
  const runId = runtimeReceipt?.run_id;
  const simpleAdmission = runtimeReceipt?.schema === 'codex-co-engineer.run-admission.v1';
  let lanes = ARRAY_IS_ARRAY(runtimeReceipt?.lanes)
    ? runtimeReceipt.lanes.map((lane) => projectLane(
      lane, projectLaneTask, classifyLaneTask, simpleAdmission,
    ))
    : [];
  const simpleResponseCap = operation === 'status'
    ? SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX
    : SIMPLE_RUN_RECEIPT_STRUCTURED_BYTES_MAX;
  if (simpleAdmission) lanes = lanes.map(compactAdmissionLane);
  const unconfirmed = cancellationUnconfirmed(operation, lanes);
  if (unconfirmed === true) {
    lanes = lanes.map((lane) => {
      if (lane?.unresolved?.code === 'safe_cancel_unconfirmed' || lane?.cancel_confirmed === false) {
        return { ...lane, status: 'unresolved' };
      }
      return lane;
    });
  }
  const blocked = unconfirmed === true
    || runtimeReceipt?.complete_candidate_blocked === true
    || [
      'awaiting_consent', 'degraded', 'failed', 'cancelled', 'needs_attention',
      'validating', 'preparing_workspaces', 'dispatching', 'verifying', 'unresolved',
      'partial_handoff', 'unrecoverable_post_prompt', 'lifecycle_pending',
    ].includes(runtimeReceipt?.phase)
    || lanes.some((lane) => lane?.required !== false && (
      lane.status === 'unresolved'
      || lane.status === 'failed'
      || lane.status === 'lifecycle_pending'
      || lane.status === 'transport_lost'
      || lane.status === 'failed_pre_prompt'
      || lane.status === 'partial_handoff'
      || lane.status === 'unrecoverable_post_prompt'
    ));
  const sideEffects = emptySideEffects();
  if (runtimeReceipt?.side_effects?.task_dispatched === true
    || (ARRAY_IS_ARRAY(runtimeReceipt?.dispatched_assignment_ids)
      && runtimeReceipt.dispatched_assignment_ids.length > 0)) {
    sideEffects.provider_dispatched = true;
  }
  const cleanupSource = runtimeReceipt?.cleanup ?? freezeData({
    cleaned: false, proof_bound: true, removed: 0, remaining: null, unresolved: [],
  });
  const cleanup = unconfirmed === true
    ? freezeData({
      ...cleanupSource,
      cleaned: false,
      proof_bound: true,
    })
    : cleanupSource;
  if (runtimeReceipt?.side_effects?.task_cancelled === true
    || cleanup.cleaned === true) {
    sideEffects.cleanup_executed = cleanup.cleaned === true;
  }
  const ctx = typeof runId === 'string' ? pendingRunExperienceContext.get(runId) ?? {} : {};
  let attention = sanitizeModelFacing(attentionRecord(runtimeReceipt?.attention) ?? freezeData({
    batch_id: null, status: null, revision: null, wake: false,
    complete_candidate_blocked: blocked,
  }));
  if ((!ARRAY_IS_ARRAY(attention?.items) || attention.items.length === 0)
    && ARRAY_IS_ARRAY(ctx.attention_items) && ctx.attention_items.length > 0) {
    attention = {
      ...attention,
      items: sanitizeModelFacing(ctx.attention_items),
    };
  }
  const actionable = actionableDecision({ ...runtimeReceipt, lanes, attention });
  const wake = wakeRequested === true && actionable === true;
  const status = unconfirmed === true
    ? 'unresolved'
    : (runtimeReceipt?.status ?? runtimeReceipt?.phase ?? 'inspected');
  const phase = runtimeReceipt?.phase ?? status;
  const rawResult = providerResultFor(runtimeReceipt);
  const boundedResult = rawResult === undefined ? null : boundProviderResult(rawResult);
  const result = boundedResult?.value;
  const receiptBody = {
    schema: RUN_TOOL_ADAPTER_RECEIPT_SCHEMA_ID,
    version: RUN_TOOL_ADAPTER_VERSION,
    mode: 'run',
    tool,
    operation,
    status,
    phase,
    run_id: runId,
    assignment_count: runtimeReceipt?.assignment_count ?? lanes.length,
    revision: Number.isSafeInteger(runtimeReceipt?.revision) ? runtimeReceipt.revision : null,
    cursor: typeof runtimeReceipt?.cursor === 'string' ? runtimeReceipt.cursor : null,
    lanes,
    attention,
    cleanup: sanitizeModelFacing(cleanup),
    decision_or_attention: freezeData({
      wake,
      attention: attention?.status === 'open' || lanes.some((lane) => lane?.status === 'needs_attention'),
      unresolved_required_blocks: blocked,
      exactly_once_reply: attention?.status === 'reply_committed' || attention?.status === 'resolved',
    }),
    candidate: runId ? projectCandidate(runId, runtimeReceipt?.candidate) : null,
    complete_candidate_blocked: blocked,
    consent: sanitizeModelFacing(runtimeReceipt?.consent ?? null),
    admission: sanitizeModelFacing(runtimeReceipt?.admission ?? null),
    dispatched_assignment_ids: sanitizeModelFacing(runtimeReceipt?.dispatched_assignment_ids ?? []),
    undispatched_assignment_ids: sanitizeModelFacing(runtimeReceipt?.undispatched_assignment_ids ?? []),
    dispatch_uncertain_assignment_ids: sanitizeModelFacing(runtimeReceipt?.dispatch_uncertain_assignment_ids ?? []),
    authoritative_required_dispatch: runtimeReceipt?.authoritative_required_dispatch === true,
    already_terminal: runtimeReceipt?.already_terminal === true,
    error: sanitizeModelFacing(runtimeReceipt?.error ?? null),
    telemetry: sanitizeModelFacing(runtimeReceipt?.telemetry ?? null),
    ...(operation === 'wait' ? {
      wait_until: capturedIncludes(WAIT_UNTIL_VALUES, runtimeReceipt?.wait_until)
        ? runtimeReceipt.wait_until
        : ADDITIVE_WAIT_UNTIL,
      ...(Number.isSafeInteger(runtimeReceipt?.waited_ms) && runtimeReceipt.waited_ms >= 0
        ? { waited_ms: runtimeReceipt.waited_ms }
        : {}),
    } : {}),
    checks: emptyChecks(runtimeReceipt?.checks),
    ...(result !== undefined ? { result } : {}),
    side_effects: sideEffects,
    audience: 'model',
    wake,
    remote_mutated: false,
  };
  const experience = projectExperience({
    ...receiptBody,
    objective: ctx.objective ?? runtimeReceipt?.objective ?? null,
    base_sha: typeof runtimeReceipt?.base_sha === 'string'
      ? runtimeReceipt.base_sha
      : (typeof ctx.base_sha === 'string' ? ctx.base_sha : null),
    git: {
      base_sha: typeof runtimeReceipt?.base_sha === 'string'
        ? runtimeReceipt.base_sha
        : (typeof ctx.base_sha === 'string' ? ctx.base_sha : null),
      digest: typeof ctx.digest === 'string' ? ctx.digest : (runtimeReceipt?.git?.digest ?? null),
    },
    journal: runtimeReceipt?.journal ?? null,
    evidence: runtimeReceipt?.evidence ?? null,
    candidate: runtimeReceipt?.candidate ?? receiptBody.candidate,
  });
  if (simpleAdmission && view !== 'diagnostics') {
    const compact = freezeData(projectSemanticRunReceipt(receiptBody, runtimeReceipt, {
      unconfirmed,
      simpleResponseCap,
      topLevelResultTruncated: boundedResult?.truncated === true,
    }));
    semanticRunExperiences.set(compact, experience);
    return compact;
  }
  if (simpleAdmission && byteLength(receiptBody) > simpleResponseCap) {
    receiptBody.attention = receiptBody.attention && {
      ...receiptBody.attention,
      items: Array.isArray(receiptBody.attention.items)
        ? receiptBody.attention.items.map((item) => ({
          ...item,
          prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 512) : item.prompt,
          options: Array.isArray(item.options) ? item.options.slice(0, 4) : item.options,
        }))
        : receiptBody.attention.items,
    };
    receiptBody.lanes = receiptBody.lanes.map((lane) => ({
      ...lane,
      handoff: lane.handoff ? { ...lane.handoff, changed_files: [], commits: [], safe_next_actions: [] } : null,
    }));
  }
  if (simpleAdmission && byteLength(receiptBody) > simpleResponseCap) {
    receiptBody.lanes = receiptBody.lanes.map(({ handoff: _handoff, ...lane }) => lane);
  }
  let projected = {
    ...receiptBody,
    experience,
  };
  if (simpleAdmission && byteLength(projected) > simpleResponseCap) {
    projected = {
      ...projected,
      attention: projected.attention && {
        ...projected.attention,
        items: Array.isArray(projected.attention.items)
          ? projected.attention.items.slice(0, 2).map((item) => ({
            assignment_id: item.assignment_id ?? null,
            task_id: item.task_id ?? null,
            provider: item.provider ?? null,
            question_id: item.question_id ?? null,
            capability: item.capability ?? null,
            resource: item.resource ?? null,
            action: item.action ?? null,
            prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 256) : null,
          }))
          : projected.attention.items,
      },
      lanes: projected.lanes.map(({ handoff: _handoff, ...lane }) => lane),
      telemetry: projected.telemetry && {
        admission_duration_ms: projected.telemetry.admission_duration_ms ?? null,
        dispatch_duration_ms: projected.telemetry.dispatch_duration_ms ?? null,
        dispatch_confidence: projected.telemetry.dispatch_confidence ?? null,
        handoff_class: projected.telemetry.handoff_class ?? null,
      },
    };
    if (byteLength(projected) > simpleResponseCap) {
      projected = {
        ...projected,
        lanes: projected.lanes.slice(0, 8).map((lane) => {
          const result = compactProviderResult(lane.result, lane.task_id);
          return {
            assignment_id: lane.assignment_id ?? null,
            task_id: lane.task_id ?? null,
            provider: lane.provider ?? null,
            model: lane.model ?? null,
            phase: lane.phase ?? null,
            status: lane.status ?? null,
            prompt_dispatched: lane.prompt_dispatched === true,
            dispatch_confidence: lane.dispatch_confidence ?? null,
            task_final: lane.task_final ?? null,
            ...(result !== undefined ? { result } : {}),
          };
        }),
        experience: projectExperience({
          ...projected,
          lanes: [],
          assignment_count: projected.assignment_count,
        }),
      };
    }
  }
  return freezeData(projected);
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
  const simpleRuntime = hasOwn(dependencies, 'simpleRuntime')
    ? assertFunctionMap(ownDataValue(dependencies, 'simpleRuntime', 'dependencies.simpleRuntime'),
      'dependencies.simpleRuntime', RUN_ADMISSION_METHODS)
    : null;
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
  const simpleRunIds = new Set();

  function isSimpleRun(runId) {
    if (simpleRunIds.has(runId)) return true;
    if (simpleRuntime && typeof simpleRuntime.hasRun === 'function') {
      try {
        if (simpleRuntime.hasRun(runId) === true) {
          simpleRunIds.add(runId);
          return true;
        }
      } catch {
        // A failed lookup must not make a legacy run appear simple.
      }
    }
    return false;
  }

  async function resolveSimpleRun(runId) {
    if (isSimpleRun(runId)) return true;
    if (simpleRuntime && typeof simpleRuntime.hasRunAsync === 'function') {
      try {
        if (await simpleRuntime.hasRunAsync(runId)) {
          simpleRunIds.add(runId);
          return true;
        }
      } catch {
        // Fall through to the legacy runtime when the simple store cannot
        // prove ownership of this run id.
      }
    }
    return false;
  }

  async function inspectLive(runId, previous) {
    if (await resolveSimpleRun(runId)) {
      counters.inspect += 1;
      return simpleRuntime.inspectRun({ run_id: runId });
    }
    const cursors = cursorsFromReceipt(previous);
    if (cursors.length > 0) {
      counters.resume += 1;
      return runtime.resumeRun({ run_id: runId, cursors });
    }
    counters.inspect += 1;
    return runtime.inspectRun({ run_id: runId });
  }

  async function waitForDecision(runId, args, signal) {
    const waitMs = parseWaitMs(args);
    const started = Date.now();
    let receipt = await inspectLive(runId, null);
    if (actionableDecision(receipt) || waitMs === 0) return receipt;
    const deadline = started + waitMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return receipt;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delayMs(Math.min(RUN_TOOL_WAIT_POLL_MS, remaining), signal);
      if (signal?.aborted) return receipt;
      receipt = await inspectLive(runId, receipt);
      if (actionableDecision(receipt)) return receipt;
    }
    return receipt;
  }

  async function dispatch(tool, args, options = {}) {
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
    const requestedView = tool === 'task' && capturedHasOwn(args, 'view')
      ? optionalValue(args, 'view', 'view')
      : null;
    if (requestedView !== null
      && !capturedIncludes(['summary', 'compact', 'diagnostics'], requestedView)) {
      failAdapter('invalid_format', 'view', CONTENT_FREE.invalid_format);
    }
    if ((tool === 'task' || tool === 'cancel' || tool === 'delegate' || tool === 'tasks')
      && mixLegacySingleTask(tool, args) && tool !== 'tasks') {
      failAdapter('mixed_tool_mode', tool, CONTENT_FREE.mixed_tool_mode);
    }
    if (tool === 'tasks' && mixLegacySingleTask('tasks', args) && capturedHasOwn(args, 'run_id')) {
      failAdapter('mixed_tool_mode', 'tasks', CONTENT_FREE.mixed_tool_mode);
    }

    const signal = options && typeof options === 'object' ? options.signal : undefined;
    let runtimeReceipt;
    let requestedRunId = null;
    if (operation === 'submit') {
      const parsed = await parseSubmit(args);
      requestedRunId = parsed.runId;
      if (parsed.simpleRequest !== undefined) {
        if (simpleRuntime === null) {
          failAdapter('simple_runtime_unavailable', 'run_request', CONTENT_FREE.simple_runtime_unavailable);
        }
        if (rememberSubmitContext) rememberSubmitContext(parsed.context);
        rememberExperienceContext(parsed.runId, {
          objective: parsed.context.objective,
          base_sha: parsed.context.base_sha,
          digest: null,
        });
        const preferenceView = inspectDelegationPreferencesV1(parsed.simpleRequest);
        if (preferenceView.attention) {
          runtimeReceipt = preferenceAttentionReceipt(
            parsed.runId, parsed.simpleRequest, preferenceView,
          );
        } else {
          counters.submit += 1;
          runtimeReceipt = await simpleRuntime.submitRunRequest(parsed.simpleRequest, { signal });
          simpleRunIds.add(parsed.runId);
        }
      } else {
      if (parsed.catalogSnapshot !== null && parsed.catalogSnapshot !== undefined) {
        pendingRunCatalogSnapshots.set(parsed.runId, parsed.catalogSnapshot);
      }
      if (rememberSubmitContext) rememberSubmitContext(parsed.context);
      rememberExperienceContext(parsed.runId, {
        objective: parsed.context.objective,
        base_sha: parsed.runtimeRequest?.git?.base_sha ?? null,
        digest: parsed.runtimeRequest?.git?.digest ?? null,
      });
      counters.submit += 1;
      runtimeReceipt = await runtime.submitRun(parsed.runtimeRequest);
      }
    } else if (operation === 'status') {
      const runId = requireRunId(args);
      requestedRunId = runId;
      const assignmentId = optionalValue(args, 'assignment_id', 'assignment_id');
      if (assignmentId !== undefined && !isAssignmentId(assignmentId)) {
        failAdapter('invalid_format', 'assignment_id', CONTENT_FREE.invalid_format);
      }
      counters.inspect += 1;
      runtimeReceipt = await ((await resolveSimpleRun(runId)) ? simpleRuntime.inspectRun({ run_id: runId }) : runtime.inspectRun({
        run_id: runId,
        ...(assignmentId !== undefined ? { assignment_id: assignmentId } : {}),
      }));
    } else if (operation === 'wait') {
      const runId = requireRunId(args);
      requestedRunId = runId;
      const waitUntil = waitUntilValue(args);
      if (waitUntil !== undefined && !capturedIncludes(WAIT_UNTIL_VALUES, waitUntil)) {
        failAdapter('invalid_format', 'wait_until', CONTENT_FREE.invalid_format);
      }
      runtimeReceipt = (await resolveSimpleRun(runId))
        ? await simpleRuntime.waitRun({
          run_id: runId,
          ...(waitUntil !== undefined ? { wait_until: waitUntil } : {}),
          ...(capturedHasOwn(args, 'wait_ms') ? { wait_ms: optionalValue(args, 'wait_ms', 'wait_ms') } : {}),
          ...(capturedHasOwn(args, 'cursor') ? { cursor: optionalValue(args, 'cursor', 'cursor') } : {}),
        }, { signal })
        : await waitForDecision(runId, args, signal);
    } else if (operation === 'attention') {
      const runId = requireRunId(args);
      requestedRunId = runId;
      const attentionRequest = quarantineObject(
        ownDataValue(args, 'attention', 'attention'),
        'attention',
        ATTENTION_REQUEST_KEYS,
      );
      const items = ownDataValue(attentionRequest, 'items', 'attention.items');
      if (!ARRAY_IS_ARRAY(items) || items.length < MIN_ASSIGNMENTS || items.length > MAX_ASSIGNMENTS) {
        failAdapter('out_of_range', 'attention.items', CONTENT_FREE.out_of_range);
      }
      validateAttentionItemsV1(items, 'attention.items');
      rememberExperienceContext(runId, { attention_items: items });
      counters.resume += 1;
      runtimeReceipt = (await resolveSimpleRun(runId))
        ? await simpleRuntime.replyRun({ run_id: runId, attention_reply: { items } }, { signal })
        : await runtime.resumeRun({ run_id: runId, attention_items: items });
    } else if (operation === 'reply') {
      const runId = requireRunId(args);
      requestedRunId = runId;
      const replyRequest = quarantineObject(
        ownDataValue(args, 'run_reply', 'run_reply'),
        'run_reply',
        RUN_REPLY_KEYS,
      );
      const requestConsentAgain = capturedHasOwn(replyRequest, 'request_consent');
      if (requestConsentAgain && ownDataValue(replyRequest, 'request_consent', 'run_reply.request_consent') !== true) {
        failAdapter('invalid_format', 'run_reply.request_consent', CONTENT_FREE.invalid_format);
      }
      if (requestConsentAgain && (
        capturedHasOwn(replyRequest, 'approval_ref')
        || capturedHasOwn(replyRequest, 'batch_id')
        || capturedHasOwn(replyRequest, 'expected_revision')
        || capturedHasOwn(replyRequest, 'reply')
      )) {
        failAdapter('mixed_run_operation', 'run_reply', CONTENT_FREE.mixed_run_operation);
      }
      counters.reply += 1;
      if (await resolveSimpleRun(runId)) {
        const simpleReply = { run_id: runId };
        if (capturedHasOwn(replyRequest, 'approval_ref')) {
          simpleReply.approval_ref = ownDataValue(replyRequest, 'approval_ref', 'run_reply.approval_ref');
        }
        if (requestConsentAgain) {
          simpleReply.request_consent = true;
        } else if (!capturedHasOwn(replyRequest, 'approval_ref')
          || capturedHasOwn(replyRequest, 'batch_id')
          || capturedHasOwn(replyRequest, 'expected_revision')
          || capturedHasOwn(replyRequest, 'reply')) {
          simpleReply.attention_reply = {
            ...(capturedHasOwn(replyRequest, 'batch_id')
              ? { batch_id: ownDataValue(replyRequest, 'batch_id', 'run_reply.batch_id') }
              : {}),
            ...(capturedHasOwn(replyRequest, 'expected_revision')
              ? { expected_revision: optionalValue(replyRequest, 'expected_revision', 'run_reply.expected_revision') }
              : {}),
            ...(capturedHasOwn(replyRequest, 'reply')
              ? { reply: ownDataValue(replyRequest, 'reply', 'run_reply.reply') }
              : {}),
          };
        }
        runtimeReceipt = await simpleRuntime.replyRun(simpleReply, { signal });
      } else {
      if (requestConsentAgain) {
        failAdapter('simple_runtime_unavailable', 'run_reply.request_consent', CONTENT_FREE.simple_runtime_unavailable);
      }
      if (attention === null) {
        failAdapter('injected_dependency_invalid', 'attention', CONTENT_FREE.injected_dependency_invalid);
      }
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
        attention: attentionRecord(attentionReceipt),
      });
      }
    } else if (operation === 'cancel' || operation === 'cleanup') {
      const runId = requireRunId(args);
      requestedRunId = runId;
      let assignmentIds = parseAssignmentIds(
        optionalValue(args, 'assignment_ids', 'assignment_ids'),
        'assignment_ids',
      );
      if (assignmentIds === undefined) {
        if (await resolveSimpleRun(runId)) {
          counters.cancel += 1;
          runtimeReceipt = await simpleRuntime.cancelRun({ run_id: runId });
          const projected = projectReceipt(
            tool, operation, runtimeReceipt, projectLaneTask, classifyLaneTask,
            operation === 'wait',
            runId,
          );
          return projected;
        }
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
      runtimeReceipt = await ((await resolveSimpleRun(runId)) ? simpleRuntime.cancelRun({ run_id: runId }) : runtime.cancelRun({
        run_id: runId,
        assignment_ids: assignmentIds,
        cleanup: operation === 'cleanup',
      }));
    } else if (operation === 'revision') {
      if (simpleRuntime === null) {
        failAdapter('simple_runtime_unavailable', 'revision', CONTENT_FREE.simple_runtime_unavailable);
      }
      const runId = requireRunId(args);
      requestedRunId = runId;
      const revision = parseOwnedRevisionRequestV1(
        quarantineObject(ownDataValue(args, 'revision', 'revision'), 'revision', REVISION_REQUEST_KEYS),
        'revision',
      );
      if (typeof simpleRuntime.reviseRun !== 'function') {
        failAdapter('revision_unsupported', 'revision', CONTENT_FREE.revision_unsupported);
      }
      counters.submit += 1;
      runtimeReceipt = await simpleRuntime.reviseRun({ run_id: runId, revision }, { signal });
      if (typeof runtimeReceipt?.run_id === 'string') {
        simpleRunIds.add(runtimeReceipt.run_id);
        requestedRunId = runtimeReceipt.run_id;
      }
    } else {
      failAdapter('unknown_operation', 'tool', CONTENT_FREE.unknown_operation);
    }

    const projected = projectReceipt(
      tool, operation, runtimeReceipt, projectLaneTask, classifyLaneTask,
      operation === 'wait',
      requestedRunId,
      requestedView,
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

function echoReplyIdentity(identity, outcome) {
  return freezeData({
    outcome,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
    task_id: identity.task_id,
    session_id: identity.session_id,
    question_id: identity.question_id,
  });
}

export async function deliverSupervisorSameSessionReplyV1(root, identity) {
  try {
    await submitReply(root, identity.task_id, {
      session_id: identity.session_id,
      question_id: identity.question_id,
      response: identity.response,
    });
    return echoReplyIdentity(identity, 'delivered');
  } catch (error) {
    if (error?.code === 'reply_already_recorded') {
      return echoReplyIdentity(identity, 'already_delivered');
    }
    throw error;
  }
}

export async function cancelSupervisorSameSessionReplyV1(cancelTask, identity) {
  try {
    const inspected = await cancelTask({
      run_id: identity.run_id,
      assignment_id: identity.assignment_id,
      task_id: identity.task_id,
      role: identity.role,
      provider: identity.provider,
    });
    const confirmed = inspected?.cancelled === true
      && inspected?.status === 'cancelled'
      && inspected?.task_id === identity.task_id;
    return echoReplyIdentity(identity, confirmed ? 'confirmed' : 'unconfirmed');
  } catch {
    return echoReplyIdentity(identity, 'unconfirmed');
  }
}

function bindAttentionReplyDelivery(attention, options = {}) {
  if (attention === undefined || attention === null || typeof attention.reply !== 'function') {
    return attention;
  }
  const deliver = typeof options.deliver === 'function' ? options.deliver : null;
  const cancel = typeof options.cancel === 'function' ? options.cancel : null;
  const bound = {
    async get(runId) {
      return attention.get(runId);
    },
    async reply(request) {
      const payload = {
        run_id: request.run_id,
        batch_id: request.batch_id,
        expected_revision: request.expected_revision,
        reply: request.reply,
      };
      if (request.now !== undefined) payload.now = request.now;
      const deliverFn = request.deliver ?? deliver;
      const cancelFn = request.cancel ?? cancel;
      if (typeof deliverFn === 'function') payload.deliver = deliverFn;
      if (typeof cancelFn === 'function') payload.cancel = cancelFn;
      return attention.reply(payload);
    },
  };
  if (typeof attention.latch === 'function') {
    bound.latch = async (request) => attention.latch(request);
  }
  return capturedFreeze(bound);
}

function assertLatchedReplyIdentities(items, reply, runId) {
  const answers = reply?.answers;
  if (!ARRAY_IS_ARRAY(items) || !ARRAY_IS_ARRAY(answers)) {
    fail('attention_batch_identity_mismatch', 'reply.answers', CONTENT_FREE.invalid_format);
  }
  const pending = items.filter((item) => item.disposition === 'pending'
    && item.reply_capability === 'same_session');
  if (answers.length !== pending.length) {
    fail('attention_batch_identity_mismatch', 'reply.answers', CONTENT_FREE.invalid_format);
  }
  const byAssignment = Object.create(null);
  for (const item of pending) byAssignment[item.assignment_id] = item;
  for (const answer of answers) {
    const item = byAssignment[answer.assignment_id];
    if (item === undefined
      || item.task_id !== answer.task_id
      || item.session_id !== answer.session_id
      || item.question_id !== answer.question_id
      || (item.run_id !== undefined && item.run_id !== runId)) {
      fail('attention_batch_identity_mismatch', 'reply.answers', CONTENT_FREE.invalid_format);
    }
  }
}

async function deliverInProcessAnswers(deliver, items, reply, runId) {
  if (typeof deliver !== 'function') return;
  const byAssignment = Object.create(null);
  for (const item of items ?? []) byAssignment[item.assignment_id] = item;
  for (const answer of reply?.answers ?? []) {
    const item = byAssignment[answer.assignment_id];
    const identity = {
      run_id: runId,
      assignment_id: answer.assignment_id,
      task_id: answer.task_id,
      session_id: answer.session_id,
      question_id: answer.question_id,
      response: answer.response,
      provider: item?.provider,
      role: item?.role,
    };
    const result = await deliver(identity);
    if (result === undefined || result === null || typeof result !== 'object') {
      fail('attention_batch_identity_mismatch', 'deliver', CONTENT_FREE.invalid_format);
    }
    for (const key of ['run_id', 'assignment_id', 'task_id', 'session_id', 'question_id']) {
      if (capturedHasOwn(result, key) && result[key] !== identity[key]) {
        fail('attention_batch_identity_mismatch', `deliver.${key}`, CONTENT_FREE.invalid_format);
      }
    }
  }
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
      if (request.batch_id !== undefined && request.batch_id !== existing.batch_id) {
        fail('attention_batch_identity_mismatch', 'batch_id', CONTENT_FREE.invalid_format);
      }
      const expectedRevision = request.expected_revision;
      if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
        fail('attention_batch_revision_conflict', 'expected_revision', CONTENT_FREE.invalid_format);
      }
      assertLatchedReplyIdentities(existing.items, request.reply, request.run_id);
      if (existing.reply !== null || existing.status === 'resolved' || existing.status === 'reply_committed') {
        if (canonicalJsonStringify(existing.reply) === canonicalJsonStringify(request.reply)) {
          return existing;
        }
        fail('attention_batch_reply_conflict', 'reply', CONTENT_FREE.invalid_format);
      }
      await deliverInProcessAnswers(request.deliver, existing.items, request.reply, request.run_id);
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
  const attention = bindAttentionReplyDelivery(attentionBatch, {
    deliver: typeof options.deliverSameSessionReply === 'function'
      ? options.deliverSameSessionReply
      : null,
    cancel: typeof options.cancelSameSessionReply === 'function'
      ? options.cancelSameSessionReply
      : null,
  });
  const runtime = createRunRuntime({
    runStore,
    runJournal,
    aggregateAnchor,
    attentionBatch: attention,
    scheduler,
    artifactBridge,
    settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle,
    clock,
  });
  return capturedFreeze({
    runtime,
    attention,
    scheduler,
    runStore,
    artifactBridge,
  });
}

async function ensurePrivateRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.length === 0 || !path.isAbsolute(rootPath)) {
    failAdapter('injected_dependency_invalid', 'root', CONTENT_FREE.injected_dependency_invalid);
  }
  const resolved = path.resolve(rootPath);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700);
  return resolved;
}

function missingAggregateAnchor() {
  return {
    async getCoordination() {
      fail('aggregate_run_not_found', 'run_id', CONTENT_FREE.invalid_format);
    },
  };
}

function wrapDurableJournal({ journalRoot, store, anchor }) {
  return {
    async create(options) {
      return createRunJournal({ root: journalRoot, store, run_id: options.run_id });
    },
    async open(options) {
      return openRunJournal({ root: journalRoot, store, run_id: options.run_id });
    },
    async createAggregate(options) {
      return createAggregateRunJournal({
        root: journalRoot, anchor, run_id: options.run_id,
      });
    },
    async openAggregate(options) {
      return openAggregateRunJournal({
        root: journalRoot, anchor, run_id: options.run_id,
      });
    },
  };
}

function secondPrecisionNow(clock) {
  const raw = typeof clock === 'function' ? clock() : new Date().toISOString();
  if (typeof raw === 'string') return raw.replace(/\.\d{3}Z$/u, 'Z');
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

async function persistAtomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700).catch(() => {});
  const tmp = `${filePath}.${process.pid}.${STRING(Date.now())}.tmp`;
  try {
    await writeFile(tmp, `${canonicalJsonStringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(tmp, 0o600);
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    if (error instanceof RunContractV1Error) throw error;
    failAdapter('durable_state_mismatch', 'state', CONTENT_FREE.durable_state_mismatch);
  }
}

async function loadAtomicJson(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, value: null };
    failAdapter('durable_state_mismatch', 'state', CONTENT_FREE.durable_state_mismatch);
  }
  if (typeof text !== 'string' || text.trim().length === 0 || text.includes('\0')) {
    failAdapter('durable_state_mismatch', 'state', CONTENT_FREE.durable_state_mismatch);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    failAdapter('durable_state_mismatch', 'state', CONTENT_FREE.durable_state_mismatch);
  }
  if (parsed === null || typeof parsed !== 'object' || ARRAY_IS_ARRAY(parsed)) {
    failAdapter('durable_state_mismatch', 'state', CONTENT_FREE.durable_state_mismatch);
  }
  return { missing: false, value: parsed };
}

function encodeArtifactName(relativePath) {
  return Buffer.from(STRING(relativePath)).toString('base64url');
}

function durableArtifactBridge(clock, artifactRoot) {
  const rawStore = {
    async publish({ artifact_ref, bytes, source_truncated }) {
      const payload = {
        artifact_ref: { ...artifact_ref },
        bytes: Buffer.from(bytes).toString('base64'),
        source_truncated: source_truncated === true,
      };
      const filePath = path.join(
        artifactRoot,
        artifact_ref.run_id,
        artifact_ref.assignment_id,
        `${encodeArtifactName(artifact_ref.relative_path)}.json`,
      );
      await persistAtomicJson(filePath, payload);
      const readback = await this.get({
        run_id: artifact_ref.run_id,
        assignment_id: artifact_ref.assignment_id,
        relative_path: artifact_ref.relative_path,
      });
      if (readback === null
        || readback.artifact_ref.run_id !== artifact_ref.run_id
        || readback.artifact_ref.assignment_id !== artifact_ref.assignment_id
        || readback.artifact_ref.relative_path !== artifact_ref.relative_path) {
        failAdapter('durable_state_mismatch', 'artifact', CONTENT_FREE.durable_state_mismatch);
      }
      return { artifact_ref: { ...readback.artifact_ref } };
    },
    async get({ run_id, assignment_id, relative_path }) {
      const filePath = path.join(
        artifactRoot, run_id, assignment_id, `${encodeArtifactName(relative_path)}.json`,
      );
      const loaded = await loadAtomicJson(filePath);
      if (loaded.missing) return null;
      const record = loaded.value;
      if (record.artifact_ref?.run_id !== run_id
        || record.artifact_ref?.assignment_id !== assignment_id
        || record.artifact_ref?.relative_path !== relative_path
        || typeof record.bytes !== 'string') {
        failAdapter('durable_state_mismatch', 'artifact', CONTENT_FREE.durable_state_mismatch);
      }
      return {
        artifact_ref: { ...record.artifact_ref },
        bytes: Buffer.from(record.bytes, 'base64'),
        source_truncated: record.source_truncated === true,
      };
    },
    async list({ run_id }) {
      const listed = [];
      const runDir = path.join(artifactRoot, run_id);
      let assignments;
      try {
        assignments = await readdir(runDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return listed;
        failAdapter('durable_state_mismatch', 'artifact', CONTENT_FREE.durable_state_mismatch);
      }
      for (const assignmentDir of assignments) {
        if (!assignmentDir.isDirectory()) continue;
        const files = await readdir(path.join(runDir, assignmentDir.name), { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith('.json')) continue;
          const loaded = await loadAtomicJson(path.join(runDir, assignmentDir.name, file.name));
          if (loaded.missing) continue;
          if (loaded.value.artifact_ref?.run_id !== run_id) {
            failAdapter('durable_state_mismatch', 'artifact', CONTENT_FREE.durable_state_mismatch);
          }
          listed.push({
            artifact_ref: { ...loaded.value.artifact_ref },
            bytes: Buffer.from(loaded.value.bytes, 'base64'),
            source_truncated: loaded.value.source_truncated === true,
          });
        }
      }
      return listed;
    },
    async remove({ run_id, assignment_id, relative_path }) {
      const filePath = path.join(
        artifactRoot, run_id, assignment_id, `${encodeArtifactName(relative_path)}.json`,
      );
      try {
        await unlink(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          failAdapter('durable_state_mismatch', 'artifact', CONTENT_FREE.durable_state_mismatch);
        }
      }
    },
  };
  const sanitizer = {
    async sanitize({ artifact_ref, source }) {
      const bytes = Buffer.from(source);
      return {
        sanitized_ref: {
          ...artifact_ref,
          artifact_class: 'sanitized',
        },
        bytes,
        redaction_count: 0,
        sanitizer_version: 1,
        source_truncated: false,
        complete: true,
      };
    },
  };
  const evidence = [];
  const evidenceBundle = {
    async append(event) {
      evidence.push(event);
      return { appended: true };
    },
    async list() {
      return [...evidence];
    },
  };
  return createRunArtifactBridge({
    rawStore,
    sanitizer,
    evidenceBundle,
    clock: { now: () => secondPrecisionNow(clock) },
  });
}

function planPath(schedulerRoot, runId) {
  return path.join(schedulerRoot, `${runId}.json`);
}

function catalogSnapshotPath(schedulerRoot, runId) {
  return path.join(schedulerRoot, `${runId}.catalog.json`);
}

function schedulerPlanIdentity(request) {
  const digest = createHash('sha256')
    .update(canonicalJsonStringify({
      assignments: request.assignments,
      base_sha: request.base_sha,
      run_id: request.run_id,
    }))
    .digest('hex');
  return `sha256:${digest}`;
}

function boundCatalogSnapshotPayload(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  return {
    schema: CATALOG_SNAPSHOT_SCHEMA,
    catalog_digest: snapshot.catalog_digest,
    profiles: ARRAY_IS_ARRAY(snapshot.profiles)
      ? snapshot.profiles.map((record) => ({
        name: record.name,
        scope: record.scope,
        digest: record.digest,
        definition: record.definition,
      }))
      : [],
  };
}

function assignmentDispatchFacts(assignments, dispatchedById = null) {
  if (!ARRAY_IS_ARRAY(assignments)) {
    failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
  }
  const facts = [];
  const seen = new Set();
  for (const assignment of assignments) {
    const assignmentId = assignment?.assignment_id;
    if (typeof assignmentId !== 'string' || seen.has(assignmentId)) {
      failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
    }
    seen.add(assignmentId);
    facts.push({
      assignment_id: assignmentId,
      dispatched: dispatchedById instanceof Map
        ? dispatchedById.get(assignmentId) === true
        : false,
    });
  }
  return facts;
}

function dispatchFactsFromReceipt(assignments, receipt) {
  const byId = new Map();
  if (ARRAY_IS_ARRAY(receipt?.lanes)) {
    for (const lane of receipt.lanes) {
      if (lane === null || typeof lane !== 'object' || ARRAY_IS_ARRAY(lane) || IS_PROXY(lane)) {
        continue;
      }
      if (typeof lane.assignment_id === 'string') {
        byId.set(lane.assignment_id, lane.dispatched === true);
      }
    }
  }
  return assignmentDispatchFacts(assignments, byId);
}

function boundAssignmentDispatch(plan) {
  const facts = plan.assignment_dispatch;
  if (!ARRAY_IS_ARRAY(facts) || facts.length !== plan.assignments.length) {
    failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
  }
  const bound = [];
  const seen = new Set();
  for (let index = 0; index < plan.assignments.length; index += 1) {
    const assignmentId = plan.assignments[index]?.assignment_id;
    const fact = facts[index];
    if (fact === null || typeof fact !== 'object' || ARRAY_IS_ARRAY(fact) || IS_PROXY(fact)
      || typeof assignmentId !== 'string'
      || fact.assignment_id !== assignmentId
      || typeof fact.dispatched !== 'boolean'
      || seen.has(assignmentId)) {
      failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
    }
    seen.add(assignmentId);
    bound.push({
      assignment_id: assignmentId,
      dispatched: fact.dispatched === true,
    });
  }
  const allDispatched = bound.every((fact) => fact.dispatched === true);
  if ((plan.dispatched === true) !== allDispatched) {
    failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
  }
  return bound;
}

async function persistSchedulerPlan(schedulerRoot, payload) {
  const assignmentDispatch = ARRAY_IS_ARRAY(payload.assignment_dispatch)
    ? payload.assignment_dispatch.map((fact) => ({
      assignment_id: fact.assignment_id,
      dispatched: fact.dispatched === true,
    }))
    : assignmentDispatchFacts(payload.assignments);
  const dispatched = assignmentDispatch.length > 0
    && assignmentDispatch.every((fact) => fact.dispatched === true);
  await persistAtomicJson(planPath(schedulerRoot, payload.run_id), {
    schema: SCHEDULER_PLAN_SCHEMA,
    run_id: payload.run_id,
    base_sha: payload.base_sha,
    assignments: payload.assignments,
    plan_identity: payload.plan_identity,
    catalog_digest: payload.catalog_digest ?? null,
    dispatched,
    assignment_dispatch: assignmentDispatch,
  });
  if (payload.catalog_snapshot !== null && payload.catalog_snapshot !== undefined) {
    await persistAtomicJson(catalogSnapshotPath(schedulerRoot, payload.run_id), payload.catalog_snapshot);
  }
}

async function loadSchedulerPlan(schedulerRoot, runId) {
  const loaded = await loadAtomicJson(planPath(schedulerRoot, runId));
  if (loaded.missing) return null;
  const parsed = loaded.value;
  if (parsed.schema !== SCHEDULER_PLAN_SCHEMA
    || parsed.run_id !== runId
    || typeof parsed.plan_identity !== 'string'
    || typeof parsed.base_sha !== 'string'
    || !ARRAY_IS_ARRAY(parsed.assignments)) {
    failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
  }
  const expected = schedulerPlanIdentity({
    run_id: parsed.run_id,
    base_sha: parsed.base_sha,
    assignments: parsed.assignments,
  });
  if (parsed.plan_identity !== expected) {
    failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
  }
  if (parsed.catalog_digest !== null && parsed.catalog_digest !== undefined) {
    const snapshot = await loadAtomicJson(catalogSnapshotPath(schedulerRoot, runId));
    if (snapshot.missing || snapshot.value.catalog_digest !== parsed.catalog_digest) {
      failAdapter('durable_state_mismatch', 'catalog', CONTENT_FREE.durable_state_mismatch);
    }
  }
  parsed.assignment_dispatch = boundAssignmentDispatch(parsed);
  return parsed;
}

function planWasDispatched(plan) {
  return plan?.dispatched === true;
}

function assignmentWasDispatched(plan, assignment) {
  const assignmentId = assignment?.assignment_id;
  if (!ARRAY_IS_ARRAY(plan?.assignment_dispatch) || typeof assignmentId !== 'string') {
    return false;
  }
  for (const fact of plan.assignment_dispatch) {
    if (fact?.assignment_id === assignmentId) return fact.dispatched === true;
  }
  return false;
}

function reconstructLane(assignment, inspected, {
  cancelAttempted = false, dispatched = false,
} = {}) {
  const required = assignment.required !== false;
  if (dispatched !== true) {
    return {
      access: assignment.access,
      assignment_id: assignment.assignment_id,
      attention: null,
      cancel_confirmed: cancelAttempted === true ? false : null,
      cursor: null,
      dispatched: false,
      fallback: false,
      model: assignment.model,
      provider: assignment.provider,
      replayed: false,
      required,
      role: assignment.role,
      starting_ref: assignment.starting_ref ?? null,
      status: 'unresolved',
      task_id: assignment.task_id,
      unresolved: {
        assignment_id: assignment.assignment_id,
        code: cancelAttempted === true ? 'safe_cancel_unconfirmed' : 'dispatch_failed',
        required,
      },
      write_scope: assignment.write_scope,
    };
  }
  if (cancelAttempted === true) {
    const confirmed = inspected?.cancelled === true
      && inspected?.status === 'cancelled'
      && inspected?.task_id === assignment.task_id;
    return {
      access: assignment.access,
      assignment_id: assignment.assignment_id,
      attention: null,
      cancel_confirmed: confirmed,
      cursor: inspected?.cursor ?? null,
      dispatched: true,
      fallback: false,
      model: assignment.model,
      provider: assignment.provider,
      replayed: false,
      required,
      role: assignment.role,
      starting_ref: assignment.starting_ref ?? null,
      status: confirmed ? 'cancelled' : 'unresolved',
      task_id: assignment.task_id,
      unresolved: confirmed ? null : {
        assignment_id: assignment.assignment_id,
        code: 'safe_cancel_unconfirmed',
        required,
      },
      write_scope: assignment.write_scope,
    };
  }
  const status = typeof inspected?.status === 'string' && capturedIncludes(RECONSTRUCT_LANE_STATUSES, inspected.status)
    ? inspected.status
    : 'unresolved';
  return {
    access: assignment.access,
    assignment_id: assignment.assignment_id,
    attention: inspected?.attention ?? null,
    cancel_confirmed: null,
    cursor: inspected?.cursor ?? null,
    dispatched: true,
    fallback: false,
    model: assignment.model,
    provider: assignment.provider,
    replayed: false,
    required,
    role: assignment.role,
    starting_ref: assignment.starting_ref ?? null,
    status,
    task_id: assignment.task_id,
    unresolved: status === 'unresolved'
      ? { assignment_id: assignment.assignment_id, code: 'inspect_failed', required }
      : null,
    write_scope: assignment.write_scope,
  };
}

async function inspectPlanLane(inspectTask, plan, assignment) {
  try {
    return await inspectTask({
      run_id: plan.run_id,
      assignment_id: assignment.assignment_id,
      task_id: assignment.task_id,
      role: assignment.role,
      provider: assignment.provider,
    });
  } catch {
    return { task_id: assignment.task_id, status: 'unresolved' };
  }
}

async function reconstructPlanReceipt(plan, inspectTask, clock, status = 'inspected') {
  const lanes = [];
  for (const assignment of plan.assignments) {
    const dispatched = assignmentWasDispatched(plan, assignment);
    const inspected = dispatched === true
      ? await inspectPlanLane(inspectTask, plan, assignment)
      : null;
    lanes.push(reconstructLane(assignment, inspected, { dispatched }));
  }
  return freezeData({
    schema: 'codex-co-engineer.run-scheduler-receipt.v1',
    status,
    run_id: plan.run_id,
    base_sha: plan.base_sha,
    created: false,
    lanes,
    complete_candidate_blocked: planWasDispatched(plan) !== true || lanes.some((lane) => lane.required
      && (lane.status === 'unresolved' || lane.status === 'failed')),
    wake: false,
    remote_mutated: false,
    observed_at: clock(),
  });
}

function wrapDurableScheduler({
  inner, schedulerRoot, inspectTask, cancelTask, clock, beforeProviderDispatch,
}) {
  return {
    async submitAssignments(request) {
      const identity = schedulerPlanIdentity(request);
      const existing = await loadSchedulerPlan(schedulerRoot, request.run_id);
      if (existing !== null) {
        if (existing.plan_identity !== identity || existing.base_sha !== request.base_sha) {
          failAdapter('durable_state_mismatch', 'plan', CONTENT_FREE.durable_state_mismatch);
        }
        return reconstructPlanReceipt(existing, inspectTask, clock, 'idempotent');
      }
      const snapshot = pendingRunCatalogSnapshots.get(request.run_id) ?? null;
      const catalogPayload = boundCatalogSnapshotPayload(snapshot);
      await persistSchedulerPlan(schedulerRoot, {
        run_id: request.run_id,
        base_sha: request.base_sha,
        assignments: request.assignments,
        plan_identity: identity,
        catalog_digest: catalogPayload?.catalog_digest ?? null,
        catalog_snapshot: catalogPayload,
        dispatched: false,
        assignment_dispatch: assignmentDispatchFacts(request.assignments),
      });
      pendingRunCatalogSnapshots.delete(request.run_id);
      if (typeof beforeProviderDispatch === 'function') {
        await beforeProviderDispatch(request);
      }
      const receipt = await inner.submitAssignments(request);
      const assignmentDispatch = dispatchFactsFromReceipt(request.assignments, receipt);
      await persistSchedulerPlan(schedulerRoot, {
        run_id: request.run_id,
        base_sha: request.base_sha,
        assignments: request.assignments,
        plan_identity: identity,
        catalog_digest: catalogPayload?.catalog_digest ?? null,
        catalog_snapshot: catalogPayload,
        dispatched: assignmentDispatch.every((fact) => fact.dispatched === true),
        assignment_dispatch: assignmentDispatch,
      });
      return receipt;
    },
    async resumeAssignments(request) {
      try {
        return await inner.resumeAssignments(request);
      } catch (error) {
        if (!(error instanceof RunContractV1Error) || error.code !== 'scheduler_run_unknown') {
          throw error;
        }
        const plan = await loadSchedulerPlan(schedulerRoot, request.run_id);
        if (plan === null) throw error;
        return reconstructPlanReceipt(plan, inspectTask, clock, 'inspected');
      }
    },
    async cancelAssignments(request) {
      try {
        return await inner.cancelAssignments(request);
      } catch (error) {
        if (!(error instanceof RunContractV1Error) || error.code !== 'scheduler_run_unknown') {
          throw error;
        }
        const plan = await loadSchedulerPlan(schedulerRoot, request.run_id);
        if (plan === null) throw error;
        const selected = new Set(request.assignment_ids ?? []);
        const lanes = [];
        let unconfirmed = false;
        for (const assignment of plan.assignments) {
          const selectedLane = selected.has(assignment.assignment_id);
          const dispatched = assignmentWasDispatched(plan, assignment);
          if (dispatched !== true) {
            const lane = reconstructLane(assignment, null, {
              cancelAttempted: selectedLane,
              dispatched: false,
            });
            if (selectedLane && lane.cancel_confirmed !== true) unconfirmed = true;
            lanes.push(lane);
            continue;
          }
          if (!selectedLane) {
            const inspected = await inspectPlanLane(inspectTask, plan, assignment);
            lanes.push(reconstructLane(assignment, inspected, { dispatched: true }));
            continue;
          }
          let inspected;
          try {
            inspected = await cancelTask({
              run_id: plan.run_id,
              assignment_id: assignment.assignment_id,
              task_id: assignment.task_id,
              role: assignment.role,
              provider: assignment.provider,
            });
          } catch {
            inspected = { task_id: assignment.task_id, status: 'unresolved', cancelled: false };
          }
          const lane = reconstructLane(assignment, inspected, {
            cancelAttempted: true,
            dispatched: true,
          });
          if (lane.cancel_confirmed !== true) unconfirmed = true;
          lanes.push(lane);
        }
        const blocked = unconfirmed || planWasDispatched(plan) !== true;
        return freezeData({
          schema: 'codex-co-engineer.run-scheduler-receipt.v1',
          status: blocked ? 'inspected' : 'cancelled',
          run_id: plan.run_id,
          base_sha: plan.base_sha,
          created: false,
          lanes,
          complete_candidate_blocked: blocked,
          wake: false,
          remote_mutated: false,
          observed_at: clock(),
        });
      }
    },
  };
}

export async function createDurableRunSeams(options = {}) {
  assertPlainObject(options, 'injected_dependency_invalid', 'options',
    'Durable run seams');
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
  const root = typeof options.root === 'string' ? options.root : null;
  const storeRoot = await ensurePrivateRoot(
    options.storeRoot ?? (root ? path.join(root, 'runs', 'store') : null),
  );
  const journalRoot = await ensurePrivateRoot(
    options.journalRoot ?? (root ? path.join(root, 'runs', 'journal') : null),
  );
  const attentionRoot = await ensurePrivateRoot(
    options.attentionRoot ?? (root ? path.join(root, 'runs', 'attention') : null),
  );
  const schedulerRoot = await ensurePrivateRoot(
    options.schedulerRoot ?? (root ? path.join(root, 'runs', 'scheduler') : null),
  );
  const artifactRoot = await ensurePrivateRoot(
    options.artifactRoot ?? (root ? path.join(root, 'runs', 'artifacts') : null),
  );
  const runStore = await openRunStore(storeRoot);
  const aggregateAnchor = options.aggregateAnchor ?? missingAggregateAnchor();
  const runJournal = wrapDurableJournal({
    journalRoot, store: runStore, anchor: aggregateAnchor,
  });
  const attentionBatch = await openAttentionRoot(attentionRoot);
  const deliverSameSessionReply = typeof options.deliverSameSessionReply === 'function'
    ? options.deliverSameSessionReply
    : (typeof root === 'string'
      ? (identity) => deliverSupervisorSameSessionReplyV1(root, identity)
      : null);
  const cancelSameSessionReply = typeof options.cancelSameSessionReply === 'function'
    ? options.cancelSameSessionReply
    : (identity) => cancelSupervisorSameSessionReplyV1(cancelTask, identity);
  const attention = bindAttentionReplyDelivery(attentionBatch, {
    deliver: deliverSameSessionReply,
    cancel: cancelSameSessionReply,
  });
  const artifactBridge = durableArtifactBridge(clock, artifactRoot);
  const innerScheduler = createRunScheduler({
    delegateTask,
    inspectTask,
    cancelTask,
    clock,
  });
  const scheduler = wrapDurableScheduler({
    inner: innerScheduler,
    schedulerRoot,
    inspectTask,
    cancelTask,
    clock,
    beforeProviderDispatch: options.beforeProviderDispatch,
  });
  const runtime = createRunRuntime({
    runStore,
    runJournal,
    aggregateAnchor,
    attentionBatch: attention,
    scheduler,
    artifactBridge,
    settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle,
    clock,
  });
  return capturedFreeze({
    runtime,
    attention,
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
capturedFreeze(createDurableRunSeams);
capturedFreeze(classifyDeniedGitOperationV1);
capturedFreeze(deliverSupervisorSameSessionReplyV1);
capturedFreeze(cancelSupervisorSameSessionReplyV1);
