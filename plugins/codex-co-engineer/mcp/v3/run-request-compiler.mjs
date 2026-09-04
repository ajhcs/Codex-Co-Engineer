// SimpleRunRequestV1 compiler.
//
// This is the small public ingress for 3.4.1 run submissions. Callers supply
// only semantic intent; all protected identities, model defaults, task IDs,
// prompt-envelope digests, and telemetry-safe facts are derived here. The
// existing full RunManifestV1 / protected run envelope remains a separate
// compatibility path and is intentionally not rewritten by this module.

import { execFile as nodeExecFile } from 'node:child_process';
import { realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  capturedTest,
  isKnownProvider,
  isKnownRole,
  isModelId,
  knownProvidersJoined,
  requiredAccessForRole,
} from './grammar.mjs';
import {
  childEnvelopeDigestV1,
  IDENTITY_LABELS,
  runManifestDigestV1,
} from './identity.mjs';
import {
  buildChildIdentityV1,
  buildDispatchAttemptV1,
  buildGitIdentityV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
} from './protected-identity.mjs';
import { resolveRegistrySelectionV1 } from './provider-registry.mjs';
import { compileChildEnvelopeV1 } from './prompt-compiler.mjs';
import {
  MAX_ASSIGNMENTS,
  MIN_ASSIGNMENTS,
  PROMPT_MAX_BYTES,
  PROMPT_MIN_BYTES,
  RUN_ID_PATTERN,
  RunContractV1Error,
  assertBaseSha,
  assertBoundedText,
  assertExpectedDurationMs,
  assertRepositoryPath,
  assertRunId,
  assertWriteScopePatterns,
  isAssignmentId,
} from './run-manifest.mjs';
import { parseRunManifestV1 } from './run-policy.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  freezeData,
  identityBoundDigest,
  ownDataValue,
} from './selection-json.mjs';
import { GIT_CLOSED_ENV, GIT_EXECUTABLE } from './git-identity.mjs';

const execFile = promisify(nodeExecFile);
const REALPATH = nodeRealpath;

export const RUN_REQUEST_SCHEMA_ID = 'codex-co-engineer.run-request.v1';
export const RUN_REQUEST_VERSION = 1;
export const RUN_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'run_id', 'repo', 'objective', 'base_sha', 'assignments',
]);
export const RUN_REQUEST_ASSIGNMENT_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'provider', 'model', 'role', 'access', 'prompt',
  'expected_duration_ms', 'write_scope', 'required', 'capabilities',
]);
export const RUN_REQUEST_DERIVED_KEYS = capturedFreeze([
  'identity', 'git', 'provenance', 'telemetry', 'request_idempotency_key',
  'task_id', 'workspace', 'dispatch', 'child_id', 'manifest_digest',
  'prompt_envelope_digest', 'capability_snapshot_digest', 'child_identity',
  'dispatch_identity', 'provider_run_identity', 'workspace_identity',
  'child_identities', 'dispatch_identities', 'provider_run_identities',
  'workspace_identities',
]);
export const RUN_REQUEST_CAPABILITIES = capturedFreeze([
  'read_run_receipts', 'read_provider_logs', 'read_own_worktree',
]);
export const RUN_REQUEST_DEFAULT_CAPABILITIES = RUN_REQUEST_CAPABILITIES;
export const RUN_REQUEST_DEFAULT_MODELS = capturedFreeze({
  grok: 'grok-4',
  'cursor-local': 'composer-1',
  'cursor-cloud': 'claude-sonnet-4-5',
  dsh: 'muse-spark-1.2-contributor',
});
export const RUN_REQUEST_RUN_POLICY = capturedFreeze({
  max_concurrency: MAX_ASSIGNMENTS,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});
export const RUN_REQUEST_RETURN_CONTRACT = capturedFreeze({
  mode: 'verified_decision',
  include_artifact_refs: true,
});

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024;
const TASK_ID_MAX = 80;
const TASK_ID_PREFIX = 'ce-';
const WRITE_ACCESS_ALIASES = capturedFreeze({
  write: 'writer',
  writer: 'writer',
  read: 'read_only',
  read_only: 'read_only',
});
const DERIVED_KEY_SET = new Set(RUN_REQUEST_DERIVED_KEYS);
const ASSIGNMENT_KEY_SET = new Set(RUN_REQUEST_ASSIGNMENT_ALLOWED_KEYS);
const REQUEST_KEY_SET = new Set(RUN_REQUEST_ALLOWED_KEYS);

function compilerError(code, field, message = 'The run request is invalid.') {
  throw new RunContractV1Error(code, field, message);
}

function rejectUnknownKeys(value, allowed, field) {
  for (const key of capturedOwnKeys(value)) {
    if (typeof key !== 'string') compilerError('symbol_key_denied', field);
    if (!allowed.has(key)) {
      if (DERIVED_KEY_SET.has(key)) {
        compilerError('derived_field_denied', `${field}.${key}`,
          'Derived run identity and provenance fields are server-owned.');
      }
      compilerError('unknown_key', `${field}.${key}`, 'The run request field is outside the closed vocabulary.');
    }
  }
}

function readRequired(value, key, field) {
  if (!capturedHasOwn(value, key)) compilerError('missing_key', field, 'A required run request field is missing.');
  return ownDataValue(value, key, field);
}

function readOptional(value, key, field) {
  if (!capturedHasOwn(value, key)) return undefined;
  return ownDataValue(value, key, field);
}

function assertArray(value, field, min, max) {
  if (!capturedIsArray(value)) compilerError('invalid_type', field, 'The run request collection must be an array.');
  if (value.length < min || value.length > max) {
    compilerError('out_of_range', field, 'The run request collection is outside the supported bound.');
  }
}

function normalizeAccess(value, field) {
  if (typeof value !== 'string' || !capturedHasOwn(WRITE_ACCESS_ALIASES, value)) {
    compilerError('unknown_access', field, 'access must be write, writer, read, or read_only.');
  }
  return WRITE_ACCESS_ALIASES[value];
}

function validateCapabilities(value, field) {
  if (value === undefined) return [...RUN_REQUEST_DEFAULT_CAPABILITIES];
  assertArray(value, field, 0, RUN_REQUEST_CAPABILITIES.length);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const capability = value[index];
    if (typeof capability !== 'string' || !capturedIncludes(RUN_REQUEST_CAPABILITIES, capability)) {
      compilerError('unknown_capability', `${field}[${index}]`, 'The capability is not safe for Co-Engineer-owned artifacts.');
    }
    if (seen.has(capability)) compilerError('duplicate_capability', `${field}[${index}]`, 'Capabilities must be unique.');
    seen.add(capability);
    result.push(capability);
  }
  return result;
}

function defaultEvidence(role) {
  if (role === 'verify') return ['provider_report', 'git_identity', 'acceptance_results'];
  if (role === 'review') return ['provider_report', 'git_identity'];
  return ['provider_report', 'git_identity', 'git_diff'];
}

function taskIdFor(runId, assignmentId, requestKey) {
  const runPart = runId.slice(0, 24);
  const assignmentPart = assignmentId.slice(0, 24);
  const digestPart = requestKey.slice('sha256:'.length, 'sha256:'.length + 12);
  const assignmentDigest = identityBoundDigest(IDENTITY_LABELS.CHILD_IDENTITY, {
    run_id: runId,
    assignment_id: assignmentId,
  }).slice('sha256:'.length, 'sha256:'.length + 8);
  const candidate = `${TASK_ID_PREFIX}${runPart}-${assignmentPart}-${digestPart}-${assignmentDigest}`;
  return candidate.length <= TASK_ID_MAX ? candidate : candidate.slice(0, TASK_ID_MAX);
}

function normalizeRepoInput(value) {
  if (typeof value !== 'string') compilerError('invalid_type', 'run_request.repo', 'repo must be an absolute path.');
  try {
    assertRepositoryPath(value, 'run_request.repo');
  } catch (error) {
    throw error;
  }
  return value;
}

function normalizeBaseSha(value) {
  if (value === undefined) return undefined;
  assertBaseSha(value, 'run_request.base_sha');
  return value;
}

function normalizeModel(provider, value, field) {
  const model = value === undefined ? RUN_REQUEST_DEFAULT_MODELS[provider] : value;
  if (typeof model !== 'string' || !isModelId(model)) {
    compilerError('invalid_model', field, 'The selected model is not in the provider model grammar.');
  }
  try {
    resolveRegistrySelectionV1({ provider, model });
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    compilerError('invalid_model', field, 'The selected model is not accepted by the provider registry.');
  }
  return model;
}

function assertSemanticRequestShape(request) {
  assertNotProxy(request, 'run_request');
  assertPlainObject(request, 'invalid_type', 'run_request', 'run_request');
  assertDirectJsonClosure(request, 'run_request');
  rejectUnknownKeys(request, REQUEST_KEY_SET, 'run_request');
}

function assertAssignmentShape(value, index) {
  const field = `run_request.assignments[${index}]`;
  assertNotProxy(value, field);
  assertPlainObject(value, 'invalid_type', field, 'assignment');
  assertDirectJsonClosure(value, field);
  rejectUnknownKeys(value, ASSIGNMENT_KEY_SET, field);
}

function normalizeAssignment(value, index, baseSha) {
  const field = `run_request.assignments[${index}]`;
  assertAssignmentShape(value, index);
  const assignmentId = readRequired(value, 'assignment_id', `${field}.assignment_id`);
  if (typeof assignmentId !== 'string' || !isAssignmentId(assignmentId)) {
    compilerError('invalid_format', `${field}.assignment_id`, 'assignment_id is not valid.');
  }
  const provider = readRequired(value, 'provider', `${field}.provider`);
  if (typeof provider !== 'string' || !isKnownProvider(provider)) {
    compilerError('unknown_provider', `${field}.provider`, `provider must be one of ${knownProvidersJoined()}.`);
  }
  const role = readRequired(value, 'role', `${field}.role`);
  if (typeof role !== 'string' || !isKnownRole(role)) {
    compilerError('unknown_role', `${field}.role`, 'role must be implement, review, or verify.');
  }
  const requestedAccess = readOptional(value, 'access', `${field}.access`);
  const access = requestedAccess === undefined
    ? requiredAccessForRole(role)
    : normalizeAccess(requestedAccess, `${field}.access`);
  if (access !== requiredAccessForRole(role)) {
    compilerError('role_access_mismatch', `${field}.access`, 'The selected role and access do not match.');
  }
  const prompt = readRequired(value, 'prompt', `${field}.prompt`);
  assertBoundedText(prompt, {
    min: PROMPT_MIN_BYTES,
    max: PROMPT_MAX_BYTES,
    path: `${field}.prompt`,
    label: `${field}.prompt`,
  });
  const expectedDuration = readRequired(value, 'expected_duration_ms', `${field}.expected_duration_ms`);
  assertExpectedDurationMs(expectedDuration, `${field}.expected_duration_ms`);
  const required = readOptional(value, 'required', `${field}.required`);
  if (required !== undefined && typeof required !== 'boolean') {
    compilerError('invalid_type', `${field}.required`, 'required must be a boolean.');
  }
  const model = normalizeModel(
    provider,
    readOptional(value, 'model', `${field}.model`),
    `${field}.model`,
  );
  const requestedScope = readOptional(value, 'write_scope', `${field}.write_scope`);
  if (access === 'read_only') {
    if (requestedScope !== undefined) {
      assertArray(requestedScope, `${field}.write_scope`, 0, 0);
    }
  } else if (requestedScope !== undefined) {
    assertWriteScopePatterns(requestedScope, `${field}.write_scope`, { minPatterns: 1 });
  }
  const capabilities = validateCapabilities(
    readOptional(value, 'capabilities', `${field}.capabilities`),
    `${field}.capabilities`,
  );
  const startingRef = provider === 'cursor-cloud' ? baseSha : undefined;
  return {
    assignment_id: assignmentId,
    role,
    access,
    prompt,
    expected_duration_ms: expectedDuration,
    required: required ?? true,
    provider,
    model,
    ...(requestedScope !== undefined ? { requested_write_scope: [...requestedScope] } : {}),
    capabilities,
    ...(startingRef !== undefined ? { starting_ref: startingRef } : {}),
  };
}

function assignWriterScopes(assignments) {
  const writers = assignments.filter((assignment) => assignment.access === 'writer');
  if (writers.length > 1 && writers.some((assignment) => !assignment.requested_write_scope)) {
    compilerError('write_scope_required', 'run_request.assignments',
      'Every writer in a multi-writer run must declare an explicit disjoint write_scope.');
  }
  return assignments.map((assignment) => {
    if (assignment.access === 'read_only') return { ...assignment, write_scope: [] };
    return {
      ...assignment,
      write_scope: assignment.requested_write_scope
        ? [...assignment.requested_write_scope]
        : ['**'],
    };
  });
}

function manifestAssignment(assignment) {
  return {
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    access: assignment.access,
    prompt: assignment.prompt,
    execution: { provider: assignment.provider, model: assignment.model },
    write_scope: [...assignment.write_scope],
    acceptance: [],
    expected_duration_ms: assignment.expected_duration_ms,
    required_evidence: defaultEvidence(assignment.role),
    ...(assignment.starting_ref !== undefined ? { starting_ref: assignment.starting_ref } : {}),
  };
}

async function runGit(execute, repository, args) {
  try {
    const result = await execute(GIT_EXECUTABLE, ['-C', repository, ...args], {
      encoding: 'utf8',
      env: GIT_CLOSED_ENV,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return String(result?.stdout ?? '').trim();
  } catch {
    compilerError('repository_invalid', 'run_request.repo', 'Git repository observation failed.');
  }
}

async function observeGit(repository, requestedBaseSha, execute = execFile) {
  const [root, headSha, treeSha, branch, status, remotes] = await Promise.all([
    runGit(execute, repository, ['rev-parse', '--show-toplevel']),
    runGit(execute, repository, ['rev-parse', '--verify', 'HEAD^{commit}']),
    runGit(execute, repository, ['rev-parse', '--verify', 'HEAD^{tree}']),
    runGit(execute, repository, ['branch', '--show-current']),
    runGit(execute, repository, ['status', '--porcelain=v1', '--untracked-files=all']),
    runGit(execute, repository, ['remote']),
  ]);
  if (path.resolve(root) !== repository) {
    compilerError('repository_alias_denied', 'run_request.repo', 'repo must identify the Git worktree root exactly.');
  }
  if (status.length > 0) {
    compilerError('repository_dirty', 'run_request.repo', 'The source Git worktree must be clean before admission.');
  }
  const baseSha = requestedBaseSha ?? headSha;
  assertBaseSha(baseSha, 'run_request.base_sha');
  const verifiedBase = await runGit(execute, repository, [
    'rev-parse', '--verify', `${baseSha}^{commit}`,
  ]);
  if (verifiedBase !== baseSha) {
    compilerError('base_sha_mismatch', 'run_request.base_sha', 'The exact base SHA was not observed in the repository.');
  }
  return freezeData({
    repository_path: repository,
    base_sha: baseSha,
    head_sha: headSha,
    tree_sha: treeSha,
    branch: branch || null,
    clean: true,
    remote_present: remotes.length > 0,
    remote_count: remotes.length > 0 ? remotes.split(/\r?\n/u).filter(Boolean).length : 0,
  });
}

function buildRequestIdempotencyKey({ request, manifest, git, assignments }) {
  return identityBoundDigest(IDENTITY_LABELS.REQUEST_IDEMPOTENCY, {
    schema: RUN_REQUEST_SCHEMA_ID,
    run_id: request.run_id,
    repository: manifest.repository,
    objective: manifest.objective,
    assignments: assignments.map((assignment) => ({
      assignment_id: assignment.assignment_id,
      role: assignment.role,
      access: assignment.access,
      provider: assignment.provider,
      model: assignment.model,
      prompt: assignment.prompt,
      expected_duration_ms: assignment.expected_duration_ms,
      required: assignment.required,
      write_scope: assignment.write_scope,
      capabilities: assignment.capabilities,
    })),
    source_head_sha: git.head_sha,
    source_tree_sha: git.tree_sha,
  });
}

function buildCapabilityDigest(capabilities) {
  return identityBoundDigest(IDENTITY_LABELS.PROVIDER_CAPABILITY, {
    schema: 'codex-co-engineer.assignment-capabilities.v1',
    capabilities: [...capabilities].sort(),
  });
}

function buildLaneDigest({ runId, assignment, manifestDigest, childEnvelopeDigest, capabilityDigest }) {
  return identityBoundDigest(IDENTITY_LABELS.RESOLVED_LANE_BINDING, {
    schema: 'codex-co-engineer.resolved-lane-binding.v1',
    run_id: runId,
    assignment_id: assignment.assignment_id,
    provider: assignment.provider,
    model: assignment.model,
    role: assignment.role,
    access: assignment.access,
    write_scope: assignment.write_scope,
    required: assignment.required,
    manifest_digest: manifestDigest,
    prompt_envelope_digest: childEnvelopeDigest,
    capability_snapshot_digest: capabilityDigest,
  });
}

function makeManifest(request, assignments, baseSha) {
  return parseRunManifestV1({
    schema: 'codex-co-engineer.run.v1',
    run_id: request.run_id,
    repository: { path: request.repo, base_sha: baseSha },
    objective: request.objective,
    assignments: assignments.map(manifestAssignment),
    policy: {
      ...RUN_REQUEST_RUN_POLICY,
      max_concurrency: assignments.length,
    },
    return_contract: RUN_REQUEST_RETURN_CONTRACT,
  });
}

function makePublicSummary(compiled) {
  return freezeData({
    schema: RUN_REQUEST_SCHEMA_ID,
    version: RUN_REQUEST_VERSION,
    run_id: compiled.run_id,
    repository_path: compiled.git.repository_path,
    base_sha: compiled.git.base_sha,
    manifest_digest: compiled.manifest_digest,
    request_idempotency_key: compiled.request_idempotency_key,
    assignment_count: compiled.assignments.length,
    assignments: compiled.assignments.map((assignment) => ({
      assignment_id: assignment.assignment_id,
      task_id: assignment.task_id,
      provider: assignment.provider,
      model: assignment.model,
      role: assignment.role,
      access: assignment.access,
      required: assignment.required,
      write_scope: [...assignment.write_scope],
      capability_digest: assignment.capability_digest,
      prompt_envelope_digest: assignment.prompt_envelope_digest,
      lane_digest: assignment.lane_digest,
      dispatch_digest: assignment.dispatch_identity.digest,
      provider_run_digest: assignment.provider_run_identity.digest,
    })),
  });
}

/**
 * Compile a server-owned simple run request into a frozen dispatch snapshot.
 * `options.observeGit` is an internal test/host seam; the public request never
 * supplies observations or derived identities.
 */
export async function compileRunRequestV1(request, options = {}) {
  assertSemanticRequestShape(request);
  const runId = readRequired(request, 'run_id', 'run_request.run_id');
  assertRunId(runId, 'run_request.run_id');
  if (!capturedTest(RUN_ID_PATTERN, runId)) compilerError('invalid_format', 'run_request.run_id');
  const repo = normalizeRepoInput(readRequired(request, 'repo', 'run_request.repo'));
  const objective = readRequired(request, 'objective', 'run_request.objective');
  assertBoundedText(objective, {
    min: 1,
    max: 4096,
    path: 'run_request.objective',
    label: 'run_request.objective',
  });
  const requestedBaseSha = normalizeBaseSha(readOptional(request, 'base_sha', 'run_request.base_sha'));
  const rawAssignments = readRequired(request, 'assignments', 'run_request.assignments');
  assertArray(rawAssignments, 'run_request.assignments', MIN_ASSIGNMENTS, MAX_ASSIGNMENTS);
  const observed = typeof options.observeGit === 'function'
    ? await options.observeGit(repo, requestedBaseSha)
    : await (async () => {
      let canonicalRepo = repo;
      try {
        canonicalRepo = await REALPATH(repo);
      } catch {
        compilerError('repository_invalid', 'run_request.repo', 'The repository path could not be resolved.');
      }
      if (canonicalRepo !== repo) {
        compilerError('repository_alias_denied', 'run_request.repo', 'repo must be the canonical Git worktree path.');
      }
      return observeGit(canonicalRepo, requestedBaseSha, options.executeGit ?? execFile);
    })();
  if (!observed || typeof observed !== 'object') {
    compilerError('repository_invalid', 'run_request.repo', 'Git observation did not return a valid identity.');
  }
  const git = freezeData({
    repository_path: repo,
    base_sha: observed.base_sha,
    head_sha: observed.head_sha,
    tree_sha: observed.tree_sha,
    branch: observed.branch ?? null,
    clean: observed.clean === true,
    remote_present: observed.remote_present === true,
    remote_count: observed.remote_count ?? 0,
  });
  assertBaseSha(git.base_sha, 'git.base_sha');
  assertBaseSha(git.head_sha, 'git.head_sha');
  if (git.clean !== true) compilerError('repository_dirty', 'run_request.repo', 'The source Git worktree must be clean before admission.');

  const normalized = [];
  const seenIds = new Set();
  for (let index = 0; index < rawAssignments.length; index += 1) {
    const assignment = normalizeAssignment(rawAssignments[index], index, git.base_sha);
    if (seenIds.has(assignment.assignment_id)) {
      compilerError('duplicate_assignment_id', `run_request.assignments[${index}].assignment_id`, 'Assignment IDs must be unique.');
    }
    seenIds.add(assignment.assignment_id);
    normalized.push(assignment);
  }
  const assignments = assignWriterScopes(normalized);
  // makeManifest -> parseRunManifestV1 performs the authoritative
  // conservative overlap check. Keep one implementation of the glob-prefix
  // rule so disjoint scopes such as src/api/** and src/ui/** are not rejected
  // by a divergent preflight parser.
  const manifest = makeManifest({ run_id: runId, repo, objective }, assignments, git.base_sha);
  const manifestDigestDescriptor = runManifestDigestV1(manifest);
  const manifestDigest = manifestDigestDescriptor.digest;
  const gitIdentity = buildGitIdentityV1({
    repository_path: repo,
    base_sha: git.base_sha,
  });
  const runIdentity = buildRunIdentityV1({
    run_id: runId,
    git: gitIdentity,
    manifest_digest: manifestDigest,
  });
  const childIdentities = [];
  const dispatchIdentities = [];
  const providerRunIdentities = [];
  const compiledAssignments = [];
  const semanticRequest = { run_id: runId, repo, objective, assignments };
  const provisionalRequestKey = buildRequestIdempotencyKey({
    request: semanticRequest,
    manifest,
    git,
    assignments,
  });
  for (let index = 0; index < manifest.assignments.length; index += 1) {
    const manifestAssignmentSnapshot = manifest.assignments[index];
    const assignment = assignments[index];
    const childIdentity = buildChildIdentityV1({
      run_id: runId,
      assignment_id: assignment.assignment_id,
    });
    const dispatchIdentity = buildDispatchAttemptV1({
      run_id: runId,
      assignment_id: assignment.assignment_id,
      attempt: 1,
    });
    const envelope = compileChildEnvelopeV1(manifest, assignment.assignment_id);
    const envelopeDigest = childEnvelopeDigestV1(envelope).digest;
    const capabilityDigest = buildCapabilityDigest(assignment.capabilities);
    const laneDigest = buildLaneDigest({
      runId,
      assignment,
      manifestDigest,
      childEnvelopeDigest: envelopeDigest,
      capabilityDigest,
    });
    const providerRunIdentity = buildProviderRunIdentityV1({
      run_id: runId,
      assignment_id: assignment.assignment_id,
      attempt: 1,
      provider: assignment.provider,
      model: assignment.model,
      git: gitIdentity,
      manifest_digest: manifestDigest,
      prompt_envelope_digest: envelopeDigest,
      resolved_lane_digest: laneDigest,
      capability_snapshot_digest: capabilityDigest,
      agent_id: null,
      provider_run_id: null,
    });
    childIdentities.push(childIdentity);
    dispatchIdentities.push(dispatchIdentity);
    providerRunIdentities.push(providerRunIdentity);
    compiledAssignments.push({
      assignment_id: manifestAssignmentSnapshot.assignment_id,
      task_id: taskIdFor(runId, assignment.assignment_id, provisionalRequestKey),
      provider: assignment.provider,
      model: assignment.model,
      role: assignment.role,
      access: assignment.access,
      required: assignment.required,
      prompt: assignment.prompt,
      expected_duration_ms: assignment.expected_duration_ms,
      write_scope: [...assignment.write_scope],
      capabilities: [...assignment.capabilities],
      child_identity: childIdentity,
      dispatch_identity: dispatchIdentity,
      provider_run_identity: providerRunIdentity,
      child_envelope: envelope,
      prompt_envelope_digest: envelopeDigest,
      capability_digest: capabilityDigest,
      lane_digest: laneDigest,
      ...(assignment.starting_ref !== undefined ? { starting_ref: assignment.starting_ref } : {}),
    });
  }
  const requestIdempotencyKey = buildRequestIdempotencyKey({
    request: semanticRequest,
    manifest,
    git,
    assignments: compiledAssignments,
  });
  // Task IDs are derived from the final request key. Rebuild the bounded
  // assignment snapshots so a future change to the identity framing cannot
  // leave task IDs tied to a provisional key.
  const finalAssignments = compiledAssignments.map((assignment) => ({
    ...assignment,
    task_id: taskIdFor(runId, assignment.assignment_id, requestIdempotencyKey),
  }));
  const result = {
    schema: RUN_REQUEST_SCHEMA_ID,
    version: RUN_REQUEST_VERSION,
    run_id: runId,
    objective,
    repo,
    git,
    base_sha_explicit: requestedBaseSha !== undefined,
    manifest,
    manifest_digest: manifestDigest,
    git_identity: gitIdentity,
    run_identity: runIdentity,
    request_idempotency_key: requestIdempotencyKey,
    child_identities: childIdentities,
    dispatch_identities: dispatchIdentities,
    provider_run_identities: providerRunIdentities,
    assignments: finalAssignments,
    managed_workspace_policy: freezeData({
      mode: 'managed',
      source: 'server_default',
      local_sha_allowed: true,
      base_sha_explicit: requestedBaseSha !== undefined,
      direct_mode: false,
      remote_mutation: false,
    }),
    public_summary: null,
  };
  result.public_summary = makePublicSummary(result);
  return freezeData(result);
}

export function isSimpleRunRequest(value) {
  return value !== null && typeof value === 'object' && capturedHasOwn(value, 'run_id')
    && capturedHasOwn(value, 'repo') && capturedHasOwn(value, 'objective')
    && capturedHasOwn(value, 'assignments');
}

capturedFreeze(compileRunRequestV1);
capturedFreeze(isSimpleRunRequest);
