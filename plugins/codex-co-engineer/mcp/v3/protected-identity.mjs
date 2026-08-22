// ProtectedIdentityV1 — closed exact run, child, provider-run, workspace, and
// Git identity schemas (ADR 0001 identifiers `exact_identities`,
// `immutable_repo_base_identity`, `no_direct_mode_for_run_submissions`,
// `run_cloud_lane_requires_pinned_starting_ref`, `bounded_evidence`,
// `no_post_dispatch_fallback_or_replay`; Gate A
// `gate_a_exact_run_child_provider_workspace_git_identity`,
// `gate_a_idempotent_submission`).
//
// Additive v3 module. It owns canonical, bounded identity records only:
//
//   - GitIdentityV1 is the immutable repository path + base SHA shared by
//     every assignment in the run (P03 label `workspace-anchor.v1`);
//   - WorkspaceIdentityV1 is one assignment's managed worktree/branch/lock
//     or Cloud pin, never direct mode (P03 label `workspace-identity.v1`);
//   - RunIdentityV1 / ChildIdentityV1 / DispatchAttemptV1 / ProviderRunIdentityV1
//     bind those surfaces through the P03 closed label registry;
//   - request idempotency is derived through IDENTITY_LABELS.REQUEST_IDEMPOTENCY
//     over a dispatch-request tuple, distinct from P05 SelectionRequestV1.
//
// Digests use the P03 authority (`identityBoundDigest` / `identityDigestV1`).
// P03 hex digests and P05 `sha256:<hex>` capability/lane digests bind as
// recorded facts; this module never re-resolves, ranks, or substitutes a
// provider, model, workspace, or Git identity. Outputs are detached and
// deeply frozen. There is no filesystem, network, process, credential, or
// provider-driver implementation.

import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedJoin,
  capturedTest,
  isKnownProvider,
  isModelId,
  knownProvidersJoined,
  modelIdGrammarSource,
  sortedCapturedKeys,
} from './grammar.mjs';
import { IDENTITY_LABELS } from './identity.mjs';
import {
  ASSIGNMENT_ID_PATTERN,
  RunContractV1Error,
  SHA40_PATTERN,
  assertBaseSha,
  assertRepositoryPath,
  assertRunId,
  isAssignmentId,
  utf8ByteLength,
} from './run-manifest.mjs';
import {
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  assertPlainObject,
  canonicalSelectionJson,
  fail,
  freezeData,
  identityBoundDigest,
  ownDataValue,
} from './selection-json.mjs';

export const GIT_IDENTITY_SCHEMA_ID = 'codex-co-engineer.git-identity.v1';
export const WORKSPACE_IDENTITY_SCHEMA_ID = 'codex-co-engineer.workspace-identity.v1';
export const RUN_IDENTITY_SCHEMA_ID = 'codex-co-engineer.run-identity.v1';
export const CHILD_IDENTITY_SCHEMA_ID = 'codex-co-engineer.child-identity.v1';
export const DISPATCH_ATTEMPT_SCHEMA_ID = 'codex-co-engineer.dispatch-attempt.v1';
export const PROVIDER_RUN_IDENTITY_SCHEMA_ID = 'codex-co-engineer.provider-run-identity.v1';
export const DISPATCH_REQUEST_SCHEMA_ID = 'codex-co-engineer.dispatch-request.v1';

export const WORKSPACE_SEMANTICS = capturedFreeze([
  'local_managed_worktree', 'remote_provider_managed',
]);
export const WORKSPACE_STARTING_POINTS = capturedFreeze([
  'run_base_sha', 'pinned_pushed_sha',
]);

export const MIN_DISPATCH_ATTEMPT = 1;
export const MAX_DISPATCH_ATTEMPT = 4;
export const BRANCH_NAME_MAX_BYTES = 128;
export const LOCK_ID_MIN_BYTES = 8;
export const LOCK_ID_MAX_BYTES = 128;

export const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const BRANCH_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
export const LOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export const GIT_IDENTITY_KEYS = capturedFreeze([
  'schema', 'repository_path', 'base_sha', 'digest',
]);
export const GIT_IDENTITY_INPUT_KEYS = capturedFreeze(['repository_path', 'base_sha']);
export const WORKSPACE_IDENTITY_KEYS = capturedFreeze([
  'schema', 'run_id', 'assignment_id', 'git', 'semantics', 'starting_point',
  'worktree_path', 'branch', 'lock_id', 'starting_ref', 'digest',
]);
export const WORKSPACE_IDENTITY_INPUT_KEYS = capturedFreeze([
  'run_id', 'assignment_id', 'git', 'semantics', 'starting_point',
  'worktree_path', 'branch', 'lock_id', 'starting_ref',
]);
export const RUN_IDENTITY_KEYS = capturedFreeze([
  'schema', 'run_id', 'git', 'manifest_digest', 'digest',
]);
export const RUN_IDENTITY_INPUT_KEYS = capturedFreeze(['run_id', 'git', 'manifest_digest']);
export const CHILD_IDENTITY_KEYS = capturedFreeze(['schema', 'run_id', 'assignment_id', 'digest']);
export const CHILD_IDENTITY_INPUT_KEYS = capturedFreeze(['run_id', 'assignment_id']);
export const DISPATCH_ATTEMPT_KEYS = capturedFreeze([
  'schema', 'run_id', 'assignment_id', 'attempt', 'digest',
]);
export const DISPATCH_ATTEMPT_INPUT_KEYS = capturedFreeze(['run_id', 'assignment_id', 'attempt']);
export const PROVIDER_RUN_IDENTITY_KEYS = capturedFreeze([
  'schema', 'run_id', 'assignment_id', 'attempt', 'provider', 'model', 'git',
  'manifest_digest', 'prompt_envelope_digest', 'resolved_lane_digest',
  'capability_snapshot_digest', 'request_idempotency_key', 'agent_id',
  'provider_run_id', 'digest',
]);
export const PROVIDER_RUN_IDENTITY_INPUT_KEYS = capturedFreeze([
  'run_id', 'assignment_id', 'attempt', 'provider', 'model', 'git',
  'manifest_digest', 'prompt_envelope_digest', 'resolved_lane_digest',
  'capability_snapshot_digest', 'agent_id', 'provider_run_id',
]);
export const LOGICAL_REQUEST_KEYS = capturedFreeze([
  'schema', 'run_id', 'assignment_id', 'attempt', 'provider', 'model',
  'git_digest', 'repository_path', 'base_sha', 'manifest_digest',
  'prompt_envelope_digest', 'resolved_lane_digest', 'capability_snapshot_digest',
]);
export const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u;
export const PROVIDER_REF_MIN_BYTES = 3;
export const PROVIDER_REF_MAX_BYTES = 128;

const CONTENT_KEY_CLASSES = capturedFreeze(Object.assign(capturedCreate(null), {
  prompt: 'prompt_content_denied',
  prompts: 'prompt_content_denied',
  instruction: 'prompt_content_denied',
  instructions: 'prompt_content_denied',
  message: 'prompt_content_denied',
  messages: 'prompt_content_denied',
  result: 'result_content_denied',
  results: 'result_content_denied',
  output: 'result_content_denied',
  stdout: 'result_content_denied',
  stderr: 'result_content_denied',
  diff: 'diff_content_denied',
  patch: 'diff_content_denied',
  credential: 'credential_content_denied',
  credentials: 'credential_content_denied',
  secret: 'credential_content_denied',
  secrets: 'credential_content_denied',
  token: 'credential_content_denied',
  tokens: 'credential_content_denied',
  password: 'credential_content_denied',
  apikey: 'credential_content_denied',
  privatekey: 'credential_content_denied',
  env: 'environment_content_denied',
  environment: 'environment_content_denied',
  argv: 'executable_content_denied',
  shell: 'executable_content_denied',
  script: 'executable_content_denied',
  executable: 'executable_content_denied',
  command: 'executable_content_denied',
  commands: 'executable_content_denied',
  workspace_mode: 'direct_mode_rejected',
  workspacemode: 'direct_mode_rejected',
  direct_mode: 'direct_mode_rejected',
  directmode: 'direct_mode_rejected',
}));

const KEY_TOKEN_PATTERN = /[a-z0-9]+/gu;
const STRING = String;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const JSON_PARSE = JSON.parse;

function snapshotRecord(record) {
  return freezeData(JSON_PARSE(canonicalSelectionJson(record)));
}

function bindDigest(label, record) {
  return snapshotRecord({ ...record, digest: identityBoundDigest(label, record) });
}

function keyTokens(key) {
  return STRING(key).toLowerCase().match(KEY_TOKEN_PATTERN) ?? [];
}

function denyForbiddenKey(key, path, allowed) {
  if (capturedIncludes(allowed, key)) return;
  const lower = STRING(key).toLowerCase();
  const collapsed = lower.replace(/[^a-z0-9]+/gu, '');
  const code = CONTENT_KEY_CLASSES[lower] ?? CONTENT_KEY_CLASSES[collapsed];
  if (code) {
    fail(code, `${path}.${key}`,
      `${path}.${key} is denied (${code}); protected identity records carry exact identifiers and digests only.`);
  }
  for (const token of keyTokens(key)) {
    const tokenCode = CONTENT_KEY_CLASSES[token];
    if (tokenCode) {
      fail(tokenCode, `${path}.${key}`,
        `${path}.${key} is denied (${tokenCode}); protected identity records carry exact identifiers and digests only.`);
    }
  }
}

function closedObject(value, path, allowed, required = allowed) {
  if (value === undefined || value === null) {
    fail('invalid_type', path, `${path} must be a plain JSON data object.`);
  }
  assertDirectJsonClosure(value, path);
  assertPlainObject(value, 'invalid_type', path, path);
  const snapshot = capturedCreate(null);
  for (const key of sortedCapturedKeys(value)) {
    denyForbiddenKey(key, path, allowed);
    if (!capturedIncludes(allowed, key)) {
      fail('unknown_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed ${path} vocabulary.`);
    }
    snapshot[key] = ownDataValue(value, key, `${path}.${key}`);
  }
  for (const key of required) {
    if (!capturedHasOwn(snapshot, key)) {
      fail('missing_key', `${path}.${key}`,
        `${path}.${key} is required; protected identity records have no hidden defaults.`);
    }
  }
  return snapshot;
}

function assertAssignmentId(value, path) {
  if (!isAssignmentId(value)) {
    fail('invalid_format', path, `${path} must match ${ASSIGNMENT_ID_PATTERN.source}.`);
  }
}

export function assertHexDigest(value, path) {
  if (typeof value !== 'string' || !capturedTest(DIGEST_HEX_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a lowercase 64-hex SHA-256 digest.`);
  }
}

export function assertBoundDigest(value, path) {
  if (typeof value !== 'string' || !capturedTest(SHA256_DIGEST_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a sha256:<64 hex> digest.`);
  }
}

function assertAttempt(value, path) {
  if (!NUMBER_IS_SAFE_INTEGER(value) || value < MIN_DISPATCH_ATTEMPT || value > MAX_DISPATCH_ATTEMPT) {
    fail('out_of_range', path,
      `${path} must be a safe integer in ${MIN_DISPATCH_ATTEMPT}..${MAX_DISPATCH_ATTEMPT}.`);
  }
}

function assertProvider(value, path) {
  if (!isKnownProvider(value)) {
    fail('unknown_provider', path, `${path} must be exactly one of ${knownProvidersJoined()}.`);
  }
}

function assertModel(value, path) {
  if (!isModelId(value)) {
    fail('invalid_format', path, `${path} must match ${modelIdGrammarSource()}.`);
  }
}

function assertNullableProviderRef(value, path) {
  if (value === null) return;
  if (typeof value !== 'string' || !capturedTest(PROVIDER_REF_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be null or a bounded provider identifier.`);
  }
  const bytes = utf8ByteLength(value);
  if (bytes < PROVIDER_REF_MIN_BYTES || bytes > PROVIDER_REF_MAX_BYTES) {
    fail('out_of_range', path,
      `${path} must be ${PROVIDER_REF_MIN_BYTES}..${PROVIDER_REF_MAX_BYTES} UTF-8 bytes.`);
  }
}

function assertBranchName(value, path) {
  if (typeof value !== 'string' || !capturedTest(BRANCH_NAME_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a bounded git-ref-safe branch name.`);
  }
  if (utf8ByteLength(value) > BRANCH_NAME_MAX_BYTES) {
    fail('out_of_range', path, `${path} exceeds ${BRANCH_NAME_MAX_BYTES} bytes.`);
  }
  if (value.includes('..') || value.includes('//') || value.includes('@{')
    || value.includes('/.') || value.endsWith('.lock') || value.normalize('NFC') !== value) {
    fail('invalid_format', path, `${path} must be a bounded git-ref-safe branch name.`);
  }
}

function assertLockId(value, path) {
  if (typeof value !== 'string' || !capturedTest(LOCK_ID_PATTERN, value)) {
    fail('invalid_format', path, `${path} must be a bounded writer-lock identifier.`);
  }
  const bytes = utf8ByteLength(value);
  if (bytes < LOCK_ID_MIN_BYTES || bytes > LOCK_ID_MAX_BYTES) {
    fail('out_of_range', path,
      `${path} must be ${LOCK_ID_MIN_BYTES}..${LOCK_ID_MAX_BYTES} UTF-8 bytes.`);
  }
}

function assertRecordDigest(record, label, path) {
  if (!capturedHasOwn(record, 'digest')) {
    fail('missing_key', `${path}.digest`, `${path}.digest is required.`);
  }
  assertBoundDigest(record.digest, `${path}.digest`);
  const payload = capturedCreate(null);
  for (const key of sortedCapturedKeys(record)) {
    if (key === 'digest') continue;
    payload[key] = record[key];
  }
  const expected = identityBoundDigest(label, payload);
  if (record.digest !== expected) {
    fail('identity_mismatch', `${path}.digest`,
      `${path}.digest does not match the P03 identity digest of its canonical form.`);
  }
}

function gitPayload(record) {
  return {
    schema: GIT_IDENTITY_SCHEMA_ID,
    repository_path: record.repository_path,
    base_sha: record.base_sha,
  };
}

function parseGitIdentity(value, path = 'git') {
  const record = closedObject(value, path, GIT_IDENTITY_KEYS);
  if (record.schema !== GIT_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`, `Git identity schema must be exactly "${GIT_IDENTITY_SCHEMA_ID}".`);
  }
  assertRepositoryPath(record.repository_path, `${path}.repository_path`);
  assertBaseSha(record.base_sha, `${path}.base_sha`);
  assertRecordDigest(record, IDENTITY_LABELS.WORKSPACE_ANCHOR, path);
  return snapshotRecord(gitPayload(record));
}

export function validateGitIdentityV1(value, path = 'git') {
  const payload = parseGitIdentity(value, path);
  return bindDigest(IDENTITY_LABELS.WORKSPACE_ANCHOR, payload);
}

export function buildGitIdentityV1(input) {
  const fields = closedObject(input, 'git_input', GIT_IDENTITY_INPUT_KEYS);
  assertRepositoryPath(fields.repository_path, 'git_input.repository_path');
  assertBaseSha(fields.base_sha, 'git_input.base_sha');
  return bindDigest(IDENTITY_LABELS.WORKSPACE_ANCHOR, gitPayload(fields));
}

export function assertSharedGitIdentityV1(left, right, path = 'git') {
  const first = validateGitIdentityV1(left);
  const second = validateGitIdentityV1(right);
  if (first.digest !== second.digest
    || first.repository_path !== second.repository_path
    || first.base_sha !== second.base_sha) {
    fail('identity_mismatch', path,
      `${path} does not share the immutable repository/base identity.`);
  }
  return first;
}

function readNestedGit(value, path) {
  if (value === undefined || value === null) {
    fail('invalid_type', path, `${path} must be a GitIdentityV1 object.`);
  }
  return validateGitIdentityV1(value, path);
}

function assertWorkspaceFields(record, git, path) {
  if (!capturedIncludes(WORKSPACE_SEMANTICS, record.semantics)) {
    fail('invalid_format', `${path}.semantics`,
      `${path}.semantics must be exactly one of ${capturedJoin(WORKSPACE_SEMANTICS, ', ')}.`);
  }
  if (!capturedIncludes(WORKSPACE_STARTING_POINTS, record.starting_point)) {
    fail('invalid_format', `${path}.starting_point`,
      `${path}.starting_point must be exactly one of ${capturedJoin(WORKSPACE_STARTING_POINTS, ', ')}.`);
  }
  if (record.semantics === 'local_managed_worktree') {
    if (record.starting_point !== 'run_base_sha') {
      fail('identity_mismatch', `${path}.starting_point`,
        `${path}.starting_point must be "run_base_sha" for a local managed worktree.`);
    }
    if (record.starting_ref !== null) {
      fail('starting_ref_forbidden_local', `${path}.starting_ref`,
        `${path}.starting_ref is only valid for cursor-cloud workspaces; local lanes start at the run base SHA.`);
    }
    assertRepositoryPath(record.worktree_path, `${path}.worktree_path`);
    if (record.worktree_path === git.repository_path) {
      fail('direct_mode_rejected', `${path}.worktree_path`,
        `${path}.worktree_path must be a managed worktree distinct from the immutable repository path.`);
    }
    assertBranchName(record.branch, `${path}.branch`);
    assertLockId(record.lock_id, `${path}.lock_id`);
    return;
  }
  if (record.starting_point !== 'pinned_pushed_sha') {
    fail('identity_mismatch', `${path}.starting_point`,
      `${path}.starting_point must be "pinned_pushed_sha" for a remote provider-managed workspace.`);
  }
  if (record.worktree_path !== null || record.branch !== null || record.lock_id !== null) {
    fail('identity_mismatch', `${path}.worktree_path`,
      'A remote provider-managed workspace cannot carry a local worktree, branch, or lock.');
  }
  if (typeof record.starting_ref !== 'string' || !capturedTest(SHA40_PATTERN, record.starting_ref)) {
    fail('cloud_starting_ref_required', `${path}.starting_ref`,
      `${path}.starting_ref must be the exact already-pushed 40-hex SHA pinned for a Cloud lane.`);
  }
  if (record.starting_ref !== git.base_sha) {
    fail('identity_mismatch', `${path}.starting_ref`,
      `${path}.starting_ref must equal the run's immutable base SHA.`);
  }
}

function workspacePayload(record, git) {
  return {
    schema: WORKSPACE_IDENTITY_SCHEMA_ID,
    run_id: record.run_id,
    assignment_id: record.assignment_id,
    git,
    semantics: record.semantics,
    starting_point: record.starting_point,
    worktree_path: record.worktree_path ?? null,
    branch: record.branch ?? null,
    lock_id: record.lock_id ?? null,
    starting_ref: record.starting_ref ?? null,
  };
}

function parseWorkspaceIdentity(value, path = 'workspace') {
  const record = closedObject(value, path, WORKSPACE_IDENTITY_KEYS);
  if (record.schema !== WORKSPACE_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Workspace identity schema must be exactly "${WORKSPACE_IDENTITY_SCHEMA_ID}".`);
  }
  assertRunId(record.run_id, `${path}.run_id`);
  assertAssignmentId(record.assignment_id, `${path}.assignment_id`);
  const git = readNestedGit(record.git, `${path}.git`);
  assertWorkspaceFields(record, git, path);
  const payload = workspacePayload(record, git);
  assertRecordDigest({ ...payload, digest: record.digest }, IDENTITY_LABELS.WORKSPACE_IDENTITY, path);
  return payload;
}

export function validateWorkspaceIdentityV1(value, path = 'workspace') {
  return bindDigest(IDENTITY_LABELS.WORKSPACE_IDENTITY, parseWorkspaceIdentity(value, path));
}

export function buildWorkspaceIdentityV1(input) {
  const optional = ['worktree_path', 'branch', 'lock_id', 'starting_ref'];
  const required = WORKSPACE_IDENTITY_INPUT_KEYS.filter((key) => !optional.includes(key));
  const fields = closedObject(input, 'workspace_input', WORKSPACE_IDENTITY_INPUT_KEYS, required);
  assertRunId(fields.run_id, 'workspace_input.run_id');
  assertAssignmentId(fields.assignment_id, 'workspace_input.assignment_id');
  const git = readNestedGit(fields.git, 'workspace_input.git');
  const payload = workspacePayload(fields, git);
  assertWorkspaceFields(payload, git, 'workspace_input');
  return bindDigest(IDENTITY_LABELS.WORKSPACE_IDENTITY, payload);
}

function runPayload(record, git) {
  return {
    schema: RUN_IDENTITY_SCHEMA_ID,
    run_id: record.run_id,
    git,
    manifest_digest: record.manifest_digest,
  };
}

function parseRunIdentity(value, path = 'run') {
  const record = closedObject(value, path, RUN_IDENTITY_KEYS);
  if (record.schema !== RUN_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`, `Run identity schema must be exactly "${RUN_IDENTITY_SCHEMA_ID}".`);
  }
  assertRunId(record.run_id, `${path}.run_id`);
  const git = readNestedGit(record.git, `${path}.git`);
  assertHexDigest(record.manifest_digest, `${path}.manifest_digest`);
  const payload = runPayload(record, git);
  assertRecordDigest({ ...payload, digest: record.digest }, IDENTITY_LABELS.RUN_IDENTITY, path);
  return payload;
}

export function validateRunIdentityV1(value, path = 'run') {
  return bindDigest(IDENTITY_LABELS.RUN_IDENTITY, parseRunIdentity(value, path));
}

export function buildRunIdentityV1(input) {
  const fields = closedObject(input, 'run_input', RUN_IDENTITY_INPUT_KEYS);
  assertRunId(fields.run_id, 'run_input.run_id');
  const git = readNestedGit(fields.git, 'run_input.git');
  assertHexDigest(fields.manifest_digest, 'run_input.manifest_digest');
  return bindDigest(IDENTITY_LABELS.RUN_IDENTITY, runPayload(fields, git));
}

function childPayload(record) {
  return {
    schema: CHILD_IDENTITY_SCHEMA_ID,
    run_id: record.run_id,
    assignment_id: record.assignment_id,
  };
}

function parseChildIdentity(value, path = 'child') {
  const record = closedObject(value, path, CHILD_IDENTITY_KEYS);
  if (record.schema !== CHILD_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`, `Child identity schema must be exactly "${CHILD_IDENTITY_SCHEMA_ID}".`);
  }
  assertRunId(record.run_id, `${path}.run_id`);
  assertAssignmentId(record.assignment_id, `${path}.assignment_id`);
  assertRecordDigest(record, IDENTITY_LABELS.CHILD_IDENTITY, path);
  return childPayload(record);
}

export function validateChildIdentityV1(value, path = 'child') {
  return bindDigest(IDENTITY_LABELS.CHILD_IDENTITY, parseChildIdentity(value, path));
}

export function buildChildIdentityV1(input) {
  const fields = closedObject(input, 'child_input', CHILD_IDENTITY_INPUT_KEYS);
  assertRunId(fields.run_id, 'child_input.run_id');
  assertAssignmentId(fields.assignment_id, 'child_input.assignment_id');
  return bindDigest(IDENTITY_LABELS.CHILD_IDENTITY, childPayload(fields));
}

function dispatchPayload(record) {
  return {
    schema: DISPATCH_ATTEMPT_SCHEMA_ID,
    run_id: record.run_id,
    assignment_id: record.assignment_id,
    attempt: record.attempt,
  };
}

function parseDispatchAttempt(value, path = 'dispatch') {
  const record = closedObject(value, path, DISPATCH_ATTEMPT_KEYS);
  if (record.schema !== DISPATCH_ATTEMPT_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Dispatch attempt schema must be exactly "${DISPATCH_ATTEMPT_SCHEMA_ID}".`);
  }
  assertRunId(record.run_id, `${path}.run_id`);
  assertAssignmentId(record.assignment_id, `${path}.assignment_id`);
  assertAttempt(record.attempt, `${path}.attempt`);
  assertRecordDigest(record, IDENTITY_LABELS.DISPATCH_ATTEMPT, path);
  return dispatchPayload(record);
}

export function validateDispatchAttemptV1(value, path = 'dispatch') {
  return bindDigest(IDENTITY_LABELS.DISPATCH_ATTEMPT, parseDispatchAttempt(value, path));
}

export function buildDispatchAttemptV1(input) {
  const fields = closedObject(input, 'dispatch_input', DISPATCH_ATTEMPT_INPUT_KEYS);
  assertRunId(fields.run_id, 'dispatch_input.run_id');
  assertAssignmentId(fields.assignment_id, 'dispatch_input.assignment_id');
  assertAttempt(fields.attempt, 'dispatch_input.attempt');
  return bindDigest(IDENTITY_LABELS.DISPATCH_ATTEMPT, dispatchPayload(fields));
}

function logicalRequestOf(record, git) {
  return {
    schema: DISPATCH_REQUEST_SCHEMA_ID,
    run_id: record.run_id,
    assignment_id: record.assignment_id,
    attempt: record.attempt,
    provider: record.provider,
    model: record.model,
    git_digest: git.digest,
    repository_path: git.repository_path,
    base_sha: git.base_sha,
    manifest_digest: record.manifest_digest,
    prompt_envelope_digest: record.prompt_envelope_digest,
    resolved_lane_digest: record.resolved_lane_digest,
    capability_snapshot_digest: record.capability_snapshot_digest,
  };
}

export function deriveRequestIdempotencyKeyV1(input) {
  const record = closedObject(input, 'logical_request', LOGICAL_REQUEST_KEYS);
  assertRunId(record.run_id, 'logical_request.run_id');
  assertAssignmentId(record.assignment_id, 'logical_request.assignment_id');
  assertAttempt(record.attempt, 'logical_request.attempt');
  assertProvider(record.provider, 'logical_request.provider');
  assertModel(record.model, 'logical_request.model');
  assertBoundDigest(record.git_digest, 'logical_request.git_digest');
  assertRepositoryPath(record.repository_path, 'logical_request.repository_path');
  assertBaseSha(record.base_sha, 'logical_request.base_sha');
  assertHexDigest(record.manifest_digest, 'logical_request.manifest_digest');
  assertHexDigest(record.prompt_envelope_digest, 'logical_request.prompt_envelope_digest');
  assertBoundDigest(record.resolved_lane_digest, 'logical_request.resolved_lane_digest');
  assertBoundDigest(record.capability_snapshot_digest, 'logical_request.capability_snapshot_digest');
  if (record.schema !== DISPATCH_REQUEST_SCHEMA_ID) {
    fail('invalid_format', 'logical_request.schema',
      `Logical request schema must be exactly "${DISPATCH_REQUEST_SCHEMA_ID}".`);
  }
  return identityBoundDigest(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, record);
}

function providerRunPayload(record, git, requestKey) {
  return {
    schema: PROVIDER_RUN_IDENTITY_SCHEMA_ID,
    run_id: record.run_id,
    assignment_id: record.assignment_id,
    attempt: record.attempt,
    provider: record.provider,
    model: record.model,
    git,
    manifest_digest: record.manifest_digest,
    prompt_envelope_digest: record.prompt_envelope_digest,
    resolved_lane_digest: record.resolved_lane_digest,
    capability_snapshot_digest: record.capability_snapshot_digest,
    request_idempotency_key: requestKey,
    agent_id: record.agent_id ?? null,
    provider_run_id: record.provider_run_id ?? null,
  };
}

function parseProviderRunIdentity(value, path = 'provider_run') {
  const record = closedObject(value, path, PROVIDER_RUN_IDENTITY_KEYS);
  if (record.schema !== PROVIDER_RUN_IDENTITY_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`,
      `Provider-run identity schema must be exactly "${PROVIDER_RUN_IDENTITY_SCHEMA_ID}".`);
  }
  assertRunId(record.run_id, `${path}.run_id`);
  assertAssignmentId(record.assignment_id, `${path}.assignment_id`);
  assertAttempt(record.attempt, `${path}.attempt`);
  assertProvider(record.provider, `${path}.provider`);
  assertModel(record.model, `${path}.model`);
  const git = readNestedGit(record.git, `${path}.git`);
  assertHexDigest(record.manifest_digest, `${path}.manifest_digest`);
  assertHexDigest(record.prompt_envelope_digest, `${path}.prompt_envelope_digest`);
  assertBoundDigest(record.resolved_lane_digest, `${path}.resolved_lane_digest`);
  assertBoundDigest(record.capability_snapshot_digest, `${path}.capability_snapshot_digest`);
  assertNullableProviderRef(record.agent_id, `${path}.agent_id`);
  assertNullableProviderRef(record.provider_run_id, `${path}.provider_run_id`);
  const expectedKey = deriveRequestIdempotencyKeyV1(logicalRequestOf(record, git));
  if (record.request_idempotency_key !== expectedKey) {
    fail('identity_mismatch', `${path}.request_idempotency_key`,
      `${path}.request_idempotency_key does not bind the exact logical request.`);
  }
  const payload = providerRunPayload(record, git, expectedKey);
  assertRecordDigest({ ...payload, digest: record.digest }, IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, path);
  return payload;
}

export function validateProviderRunIdentityV1(value, path = 'provider_run') {
  return bindDigest(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, parseProviderRunIdentity(value, path));
}

export function buildProviderRunIdentityV1(input) {
  const optional = ['agent_id', 'provider_run_id'];
  const required = PROVIDER_RUN_IDENTITY_INPUT_KEYS.filter((key) => !optional.includes(key));
  const fields = closedObject(input, 'provider_run_input', PROVIDER_RUN_IDENTITY_INPUT_KEYS, required);
  assertRunId(fields.run_id, 'provider_run_input.run_id');
  assertAssignmentId(fields.assignment_id, 'provider_run_input.assignment_id');
  assertAttempt(fields.attempt, 'provider_run_input.attempt');
  assertProvider(fields.provider, 'provider_run_input.provider');
  assertModel(fields.model, 'provider_run_input.model');
  const git = readNestedGit(fields.git, 'provider_run_input.git');
  assertHexDigest(fields.manifest_digest, 'provider_run_input.manifest_digest');
  assertHexDigest(fields.prompt_envelope_digest, 'provider_run_input.prompt_envelope_digest');
  assertBoundDigest(fields.resolved_lane_digest, 'provider_run_input.resolved_lane_digest');
  assertBoundDigest(fields.capability_snapshot_digest, 'provider_run_input.capability_snapshot_digest');
  assertNullableProviderRef(fields.agent_id ?? null, 'provider_run_input.agent_id');
  assertNullableProviderRef(fields.provider_run_id ?? null, 'provider_run_input.provider_run_id');
  const requestKey = deriveRequestIdempotencyKeyV1(logicalRequestOf(fields, git));
  return bindDigest(IDENTITY_LABELS.PROVIDER_RUN_IDENTITY, providerRunPayload(fields, git, requestKey));
}

export {
  IDENTITY_LABELS,
  RunContractV1Error,
  SHA256_DIGEST_PATTERN,
  bindDigest,
  canonicalSelectionJson,
  closedObject,
  fail,
  snapshotRecord,
};

capturedFreeze(buildGitIdentityV1);
capturedFreeze(validateGitIdentityV1);
capturedFreeze(assertSharedGitIdentityV1);
capturedFreeze(buildWorkspaceIdentityV1);
capturedFreeze(validateWorkspaceIdentityV1);
capturedFreeze(buildRunIdentityV1);
capturedFreeze(validateRunIdentityV1);
capturedFreeze(buildChildIdentityV1);
capturedFreeze(validateChildIdentityV1);
capturedFreeze(buildDispatchAttemptV1);
capturedFreeze(validateDispatchAttemptV1);
capturedFreeze(deriveRequestIdempotencyKeyV1);
capturedFreeze(buildProviderRunIdentityV1);
capturedFreeze(validateProviderRunIdentityV1);
