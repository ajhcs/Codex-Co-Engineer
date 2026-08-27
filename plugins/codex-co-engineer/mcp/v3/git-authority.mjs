// GitAuthorityPolicyV1 — closed immutable Git authority policy (P28;
// ADR 0001 `codex_only_final_acceptance`, `run_owned_candidate_ref_namespace`,
// `gate_a_no_protected_ref_mutation`).
//
// Additive v3 static law: protected/default refs, the allowed task-branch
// namespace, credential-free repository/ref identity, tri-class
// classification, and operation authority. External agents never merge,
// rebase, push, create PRs, mutate protected/default refs, create
// tags/releases, or obtain credential/remote mutation authority. No Git
// mutation, no P29 credential/remote I/O, no P30 audit. Policy plus
// detection is not containment. Receipts never echo repository paths,
// URLs, credentials, provider text, or hostile refs.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  CAPABILITY_RECORD_ALLOWED_KEYS,
  CREATE_PR_POSTURES,
  MERGE_AUTHORITIES,
  PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID,
} from './capability-bridge.mjs';
import { capturedFreeze, capturedIncludes, capturedTest, isKnownProvider } from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  RunContractV1Error,
  assertBaseSha,
  assertRepositoryPath,
  assertRunId,
  isAssignmentId,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  freezeData,
  hasOwn,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';

export const GIT_AUTHORITY_SCHEMA_ID = 'codex-co-engineer.git-authority.v1';
export const GIT_AUTHORITY_POLICY_SCHEMA_ID = 'codex-co-engineer.git-authority-policy.v1';
export const GIT_AUTHORITY_VERSION = 1;

export const REF_CLASS_VALUES = capturedFreeze([
  'platform_run_owned', 'unclassified', 'user_protected', 'worker_lane',
]);
export const ACTOR_VALUES = capturedFreeze(['codex', 'platform', 'worker']);
export const AUTHORITY_VERDICTS = capturedFreeze(['allowed', 'denied']);
export const ALLOWED_OPERATIONS = capturedFreeze([
  'commit_on_lane_branch', 'compose_candidate_non_authoritative',
  'create_lane_branch', 'read_only_inspect',
]);
export const DENIED_OPERATIONS = capturedFreeze([
  'create_pr', 'credential_helper', 'delete_ref', 'fetch', 'force_push',
  'merge', 'merge_pr', 'protected_ref_update', 'pull', 'push', 'rebase',
  'release_create', 'remote_mutate', 'tag_create', 'tag_delete',
]);
export const GIT_OPERATIONS = capturedFreeze([...ALLOWED_OPERATIONS, ...DENIED_OPERATIONS]);
export const MAX_AUTHORITY_OBJECT_KEYS = 32;
export const MAX_AUTHORITY_KEY_BYTES = 128;
export const MAX_REF_BYTES = 200;
export const MAX_REF_SEGMENTS = 8;
export const MAX_HISTORY_COMMITS = 256;
export const MAX_PARENT_COUNT = 16;
export const LANE_DIGEST_PREFIX_LENGTH = 16;
export const MANIFEST_DIGEST_HEX_LENGTH = 64;
export const DEFAULT_BRANCH_NAMES = capturedFreeze(['main', 'master']);
export const LANE_BRANCH_NAMESPACE = 'codex/run-';
export const LANE_REF_PREFIX = 'refs/heads/codex/run-';
export const CANDIDATE_REF_NAMESPACE = 'refs/codex-co-engineer/runs/';
export const CANDIDATE_REF_LEAF = 'candidate';
export const HEADS_PREFIX = 'refs/heads/';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const BRANCH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LANE_BRANCH_PATTERN = /^codex\/run-[0-9a-f]{16}\/[a-z][a-z0-9-]{0,63}$/u;
const LANE_REF_PATTERN = /^refs\/heads\/codex\/run-[0-9a-f]{16}\/[a-z][a-z0-9-]{0,63}$/u;
const CANDIDATE_REF_PATTERN = /^refs\/codex-co-engineer\/runs\/[a-z][a-z0-9-]{2,63}\/candidate$/u;
const SAFE_REF_PATTERN = /^refs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,7}$/u;
const SHA40_PATTERN = /^[0-9a-f]{40}$/u;

export const POLICY_ALLOWED_KEYS = capturedFreeze([
  'candidate_ref_leaf', 'candidate_ref_namespace', 'default_branch_names',
  'lane_branch_namespace', 'lane_digest_prefix_length', 'lane_ref_prefix',
  'manifest_digest_hex_length', 'max_history_commits', 'max_parent_count',
  'max_ref_bytes', 'max_ref_segments', 'schema', 'user_protected_ref_prefixes',
  'version',
]);
export const IDENTITY_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'head_sha', 'repository_path', 'run_id',
]);
export const IDENTITY_REQUIRED_KEYS = capturedFreeze([
  'assignment_id', 'base_sha', 'repository_path', 'run_id',
]);
export const REF_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'default_branch', 'identity', 'init_default_branch', 'manifest_digest_hex',
  'origin_head_branch', 'ref',
]);
export const BRANCH_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'assignment_id', 'manifest_digest_hex', 'run_id',
]);
export const HISTORY_ALLOWED_KEYS = capturedFreeze(['parent_counts']);
export const POSTURE_ALLOWED_KEYS = capturedFreeze([...CAPABILITY_RECORD_ALLOWED_KEYS, 'schema']);
export const OPERATION_REQUEST_ALLOWED_KEYS = capturedFreeze([
  'actor', 'capability', 'default_branch', 'history', 'identity',
  'init_default_branch', 'manifest_digest_hex', 'operation',
  'origin_head_branch', 'ref', 'schema', 'version',
]);
export const OPERATION_REQUEST_REQUIRED_KEYS = capturedFreeze([
  'actor', 'identity', 'operation', 'schema', 'version',
]);
export const EVIDENCE_CONTEXT_ALLOWED_KEYS = capturedFreeze([
  'discrepancy_id', 'fact_id', 'sequence',
]);
export const RECEIPT_KEYS = capturedFreeze([
  'actor', 'assignment_id', 'base_sha', 'code', 'default_branch_target',
  'message', 'operation', 'path', 'ref_class', 'run_id', 'schema',
  'verdict', 'version',
]);
export const RECEIPT_REQUIRED_KEYS = RECEIPT_KEYS;

export const GIT_AUTHORITY_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied',
  'authority_identity_invalid', 'authority_posture_mismatch',
  'branch_namespace_violation', 'credential_content_denied',
  'default_branch_target_denied', 'exotic_prototype_denied',
  'invalid_format', 'invalid_type', 'merge_authority_denied',
  'merge_history_denied', 'missing_key', 'non_enumerable_property_denied',
  'out_of_range', 'own_undefined_denied', 'protected_ref_write_denied',
  'proxy_denied', 'push_authority_denied', 'symbol_key_denied',
  'unknown_git_operation', 'unknown_key', 'value_depth_exceeded',
]);

const DEFINE = Object.defineProperty;
const OBJECT_IS = Object.is;
const IS_INT = Number.isSafeInteger;
const STRING = String;
const BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const IS_ARRAY = Array.isArray;
const OWN_KEYS = Reflect.ownKeys;
const SET_CTOR = Set;
const HASH = createHash;
const HASH_DIGEST = Object.getPrototypeOf(HASH('sha256')).digest;
const HASH_UPDATE = Object.getPrototypeOf(HASH('sha256')).update;
const WEAKSET_CTOR = WeakSet;
const TRUSTED_POLICY_RECEIPTS = new WEAKSET_CTOR();
const WEAKSET_ADD = WEAKSET_CTOR.prototype.add;
const WEAKSET_HAS = WEAKSET_CTOR.prototype.has;

const DENIED_OPERATION_CODES = capturedFreeze({
  create_pr: 'merge_authority_denied',
  credential_helper: 'credential_content_denied',
  delete_ref: 'protected_ref_write_denied',
  fetch: 'push_authority_denied',
  force_push: 'push_authority_denied',
  merge: 'merge_authority_denied',
  merge_pr: 'merge_authority_denied',
  protected_ref_update: 'protected_ref_write_denied',
  pull: 'push_authority_denied',
  push: 'push_authority_denied',
  rebase: 'merge_authority_denied',
  release_create: 'protected_ref_write_denied',
  remote_mutate: 'push_authority_denied',
  tag_create: 'protected_ref_write_denied',
  tag_delete: 'protected_ref_write_denied',
});
const ACTOR_OPERATIONS = capturedFreeze({
  worker: capturedFreeze(['commit_on_lane_branch', 'create_lane_branch', 'read_only_inspect']),
  platform: capturedFreeze(['compose_candidate_non_authoritative', 'read_only_inspect']),
  codex: capturedFreeze(['read_only_inspect']),
});
const RECORD_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const MSG = capturedFreeze({
  accessor_property_denied: 'GitAuthorityPolicyV1 denies accessor inputs.',
  aliased_reference_denied: 'GitAuthorityPolicyV1 denies aliased inputs.',
  authority_identity_invalid: 'GitAuthorityPolicyV1 rejected the credential-free repository identity.',
  authority_posture_mismatch: 'GitAuthorityPolicyV1 rejected the merge or create-PR capability posture.',
  branch_namespace_violation: 'GitAuthorityPolicyV1 rejected a branch namespace or ref-grammar attack.',
  credential_content_denied: 'GitAuthorityPolicyV1 denies credentials and remote mutation material.',
  default_branch_target_denied: 'GitAuthorityPolicyV1 denies default-branch and protected-target assignments.',
  exotic_prototype_denied: 'GitAuthorityPolicyV1 denies exotic prototypes.',
  invalid_format: 'GitAuthorityPolicyV1 rejected a value that violates a closed grammar.',
  invalid_type: 'GitAuthorityPolicyV1 rejected a non-JSON authority value.',
  merge_authority_denied: 'GitAuthorityPolicyV1 denies merge rebase and create-PR authority.',
  merge_history_denied: 'GitAuthorityPolicyV1 denies merge commits and merge histories.',
  missing_key: 'GitAuthorityPolicyV1 requires every canonical authority key.',
  non_enumerable_property_denied: 'GitAuthorityPolicyV1 denies non-enumerable properties.',
  out_of_range: 'GitAuthorityPolicyV1 rejected a value outside closed bounds.',
  own_undefined_denied: 'GitAuthorityPolicyV1 denies own undefined values.',
  protected_ref_write_denied: 'GitAuthorityPolicyV1 denies writes to protected or default refs.',
  proxy_denied: 'GitAuthorityPolicyV1 denies Proxy inputs.',
  push_authority_denied: 'GitAuthorityPolicyV1 denies push and remote mutation authority.',
  symbol_key_denied: 'GitAuthorityPolicyV1 denies symbol keys.',
  unknown_git_operation: 'GitAuthorityPolicyV1 denies unknown git operations.',
  unknown_key: 'GitAuthorityPolicyV1 rejects keys outside the closed vocabulary.',
  value_depth_exceeded: 'GitAuthorityPolicyV1 rejected nested input that exceeds closed depth.',
  authority_ok: 'GitAuthorityPolicyV1 permits the requested git operation.',
});

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!Object.hasOwn(values, key)) continue;
    DEFINE(snapshot, key, { value: values[key], enumerable: true, writable: false, configurable: false });
  }
  return capturedFreeze(snapshot);
}

function deny(code, path) {
  fail(code, path, MSG[code] ?? MSG.invalid_format);
}

function publicCode(error) {
  if (error instanceof RunContractV1Error && capturedIncludes(GIT_AUTHORITY_ERROR_CODES, error.code)) {
    return error.code;
  }
  return 'invalid_type';
}

function remap(error, path) {
  deny(publicCode(error), path);
}

function assertClosedObject(input, allowed, path) {
  if (input === undefined || input === null) deny('invalid_type', path);
  if (typeof input === 'object' || typeof input === 'function') {
    try { assertNotProxy(input, path); } catch (error) { remap(error, path); }
  }
  if (typeof input !== 'object') deny('invalid_type', path);
  try {
    assertPlainObject(input, 'invalid_type', path, path);
  } catch (error) { remap(error, path); }
  let keys;
  try { keys = OWN_KEYS(input); } catch { deny('invalid_type', path); }
  if (keys.length > MAX_AUTHORITY_OBJECT_KEYS) deny('out_of_range', path);
  const allowedSet = new SET_CTOR(allowed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (typeof key !== 'string' || BYTE_LENGTH(key, 'utf8') > MAX_AUTHORITY_KEY_BYTES) deny('out_of_range', path);
    if (!allowedSet.has(key)) deny('unknown_key', path);
  }
  try {
    assertDirectJsonClosure(input, path);
  } catch (error) { remap(error, path); }
  return input;
}

function requireKeys(input, keys, path) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasOwn(input, keys[i])) deny('missing_key', path);
  }
}

function assertExact(value, expected, path) {
  if (IS_ARRAY(expected)) {
    try { assertNotProxy(value, path); } catch (error) { remap(error, path); }
    if (!IS_ARRAY(value) || value.length !== expected.length) deny('invalid_format', path);
    for (let i = 0; i < expected.length; i += 1) {
      let item;
      try { item = ownDataValue(value, STRING(i), path); } catch (error) { remap(error, path); }
      if (item !== expected[i]) deny('invalid_format', path);
    }
    return;
  }
  if (value !== expected) deny('invalid_format', path);
}

function refGrammarDenied(value) {
  if (typeof value !== 'string') return true;
  const bytes = BYTE_LENGTH(value, 'utf8');
  if (bytes === 0 || bytes > MAX_REF_BYTES || value.normalize('NFC') !== value) return true;
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.includes('@')) return true;
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return true;
  if (/[ \\~^:?*[]/.test(value)) return true;
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > MAX_REF_SEGMENTS || segments[0] !== 'refs') return true;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.length === 0 || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock')) {
      return true;
    }
    if (i > 0 && !capturedTest(BRANCH_SEGMENT_PATTERN, segment)) return true;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return true;
  }
  return !capturedTest(SAFE_REF_PATTERN, value);
}

function assertAsciiSegment(value, path) {
  if (typeof value !== 'string') deny('invalid_type', path);
  const bytes = BYTE_LENGTH(value, 'utf8');
  if (bytes === 0 || bytes > MAX_REF_BYTES || value.normalize('NFC') !== value) deny('out_of_range', path);
  if (!capturedTest(BRANCH_SEGMENT_PATTERN, value)) deny('branch_namespace_violation', path);
  return value;
}

function bindOrThrow(label, path, fn) {
  try { return fn(); } catch { deny(label, path); }
}

function optionalSegment(input, key, path) {
  if (!hasOwn(input, key)) return undefined;
  return assertAsciiSegment(optOwn(input, key), `${path}.${key}`);
}

export const GIT_AUTHORITY_POLICY_V1 = freezeData({
  schema: GIT_AUTHORITY_POLICY_SCHEMA_ID,
  version: GIT_AUTHORITY_VERSION,
  default_branch_names: [...DEFAULT_BRANCH_NAMES],
  user_protected_ref_prefixes: capturedFreeze([
    `${HEADS_PREFIX}main`, `${HEADS_PREFIX}master`, 'refs/tags/', 'refs/notes/', 'refs/remotes/',
  ]),
  lane_branch_namespace: LANE_BRANCH_NAMESPACE,
  lane_ref_prefix: LANE_REF_PREFIX,
  lane_digest_prefix_length: LANE_DIGEST_PREFIX_LENGTH,
  candidate_ref_namespace: CANDIDATE_REF_NAMESPACE,
  candidate_ref_leaf: CANDIDATE_REF_LEAF,
  manifest_digest_hex_length: MANIFEST_DIGEST_HEX_LENGTH,
  max_ref_bytes: MAX_REF_BYTES,
  max_ref_segments: MAX_REF_SEGMENTS,
  max_history_commits: MAX_HISTORY_COMMITS,
  max_parent_count: MAX_PARENT_COUNT,
});
export const GitAuthorityPolicyV1 = GIT_AUTHORITY_POLICY_V1;
const POLICY_CANONICAL = canonicalJsonStringify(GIT_AUTHORITY_POLICY_V1);

export function parseGitAuthorityPolicyV1(input) {
  const path = 'policy';
  const object = assertClosedObject(input, POLICY_ALLOWED_KEYS, path);
  requireKeys(object, POLICY_ALLOWED_KEYS, path);
  for (const key of POLICY_ALLOWED_KEYS) {
    assertExact(optOwn(object, key), GIT_AUTHORITY_POLICY_V1[key], `${path}.${key}`);
  }
  if (canonicalJsonStringify(object) !== POLICY_CANONICAL) deny('invalid_format', path);
  return GIT_AUTHORITY_POLICY_V1;
}

export function bindAuthorityIdentityV1(input) {
  const path = 'identity';
  const object = assertClosedObject(input, IDENTITY_ALLOWED_KEYS, path);
  requireKeys(object, IDENTITY_REQUIRED_KEYS, path);
  bindOrThrow('authority_identity_invalid', `${path}.repository_path`,
    () => assertRepositoryPath(optOwn(object, 'repository_path'), `${path}.repository_path`));
  const baseSha = optOwn(object, 'base_sha');
  bindOrThrow('authority_identity_invalid', `${path}.base_sha`, () => assertBaseSha(baseSha, `${path}.base_sha`));
  const runId = optOwn(object, 'run_id');
  bindOrThrow('authority_identity_invalid', `${path}.run_id`, () => assertRunId(runId, `${path}.run_id`));
  const assignmentId = optOwn(object, 'assignment_id');
  if (!isAssignmentId(assignmentId)) deny('authority_identity_invalid', `${path}.assignment_id`);
  const values = {
    schema: GIT_AUTHORITY_SCHEMA_ID, version: GIT_AUTHORITY_VERSION, repository_bound: true,
    base_sha: baseSha, run_id: runId, assignment_id: assignmentId,
  };
  if (hasOwn(object, 'head_sha')) {
    const headSha = optOwn(object, 'head_sha');
    if (typeof headSha !== 'string' || !capturedTest(SHA40_PATTERN, headSha)) {
      deny('authority_identity_invalid', `${path}.head_sha`);
    }
    values.head_sha = headSha;
  }
  return freezeRecord(
    ['schema', 'version', 'repository_bound', 'base_sha', 'run_id', 'assignment_id', 'head_sha'],
    values,
  );
}

function assertBranchRequest(input) {
  const path = 'branch';
  const object = assertClosedObject(input, BRANCH_REQUEST_ALLOWED_KEYS, path);
  requireKeys(object, BRANCH_REQUEST_ALLOWED_KEYS, path);
  bindOrThrow('invalid_format', `${path}.run_id`, () => assertRunId(optOwn(object, 'run_id'), `${path}.run_id`));
  const assignmentId = optOwn(object, 'assignment_id');
  if (!isAssignmentId(assignmentId)) deny('invalid_format', `${path}.assignment_id`);
  const digest = optOwn(object, 'manifest_digest_hex');
  if (typeof digest !== 'string' || !capturedTest(DIGEST_PATTERN, digest)) deny('invalid_format', `${path}.manifest_digest_hex`);
  return { assignmentId, digest };
}

export function expectedRunBranchNameV1(input) {
  const { assignmentId, digest } = assertBranchRequest(input);
  return `codex/run-${digest.slice(0, LANE_DIGEST_PREFIX_LENGTH)}/${assignmentId}`;
}

export function expectedLaneRefV1(input) {
  return `${HEADS_PREFIX}${expectedRunBranchNameV1(input)}`;
}

export function expectedCandidateRefV1(input) {
  const path = 'candidate';
  const object = typeof input === 'string'
    ? assertClosedObject({ run_id: input }, ['run_id'], path)
    : assertClosedObject(input, ['run_id'], path);
  requireKeys(object, ['run_id'], path);
  const runId = optOwn(object, 'run_id');
  bindOrThrow('invalid_format', `${path}.run_id`, () => assertRunId(runId, `${path}.run_id`));
  return `${CANDIDATE_REF_NAMESPACE}${runId}/${CANDIDATE_REF_LEAF}`;
}

export function isValidRunBranchNameV1(name) {
  return typeof name === 'string'
    && BYTE_LENGTH(name, 'utf8') <= MAX_REF_BYTES
    && name.normalize('NFC') === name
    && capturedTest(LANE_BRANCH_PATTERN, name)
    && !refGrammarDenied(`${HEADS_PREFIX}${name}`);
}

export function isRunOwnedCandidateRefV1(ref, runId) {
  if (typeof ref !== 'string' || typeof runId !== 'string') return false;
  try { assertRunId(runId, 'run_id'); } catch { return false; }
  return !refGrammarDenied(ref)
    && ref === `${CANDIDATE_REF_NAMESPACE}${runId}/${CANDIDATE_REF_LEAF}`
    && capturedTest(CANDIDATE_REF_PATTERN, ref);
}

export function classifyRefV1(input) {
  const path = 'ref_request';
  const object = assertClosedObject(input, REF_REQUEST_ALLOWED_KEYS, path);
  requireKeys(object, ['ref'], path);
  const refValue = optOwn(object, 'ref');
  if (typeof refValue !== 'string') deny('invalid_type', `${path}.ref`);
  const identity = hasOwn(object, 'identity') ? bindAuthorityIdentityV1(optOwn(object, 'identity')) : undefined;
  const protectedNames = new SET_CTOR(DEFAULT_BRANCH_NAMES);
  for (const key of ['default_branch', 'origin_head_branch', 'init_default_branch']) {
    const extra = optionalSegment(object, key, path);
    if (extra !== undefined) protectedNames.add(extra);
  }
  let ownLaneRef;
  if (hasOwn(object, 'manifest_digest_hex') && identity !== undefined) {
    const digest = optOwn(object, 'manifest_digest_hex');
    if (typeof digest !== 'string' || !capturedTest(DIGEST_PATTERN, digest)) deny('invalid_format', `${path}.manifest_digest_hex`);
    ownLaneRef = `${LANE_REF_PREFIX}${digest.slice(0, LANE_DIGEST_PREFIX_LENGTH)}/${identity.assignment_id}`;
  }

  const result = {
    schema: GIT_AUTHORITY_SCHEMA_ID, version: GIT_AUTHORITY_VERSION,
    ref_class: 'user_protected', protected: true, default_branch_target: false,
    code: 'protected_ref_write_denied',
  };
  if (refGrammarDenied(refValue)) {
    result.ref_class = 'unclassified';
    result.code = 'branch_namespace_violation';
  } else if (capturedTest(CANDIDATE_REF_PATTERN, refValue)) {
    result.ref_class = 'platform_run_owned';
    result.code = identity !== undefined
      && refValue === `${CANDIDATE_REF_NAMESPACE}${identity.run_id}/${CANDIDATE_REF_LEAF}`
      ? 'protected_ref_write_denied' : 'branch_namespace_violation';
  } else if (capturedTest(LANE_REF_PATTERN, refValue)) {
    if (ownLaneRef !== undefined && OBJECT_IS(refValue, ownLaneRef)) {
      result.ref_class = 'worker_lane';
      result.protected = false;
      result.code = 'authority_ok';
    } else {
      result.code = 'branch_namespace_violation';
    }
  } else if (refValue.startsWith('refs/tags/') || refValue.startsWith('refs/notes/')
    || refValue.startsWith('refs/remotes/')) {
    result.code = 'protected_ref_write_denied';
  } else if (refValue.startsWith(HEADS_PREFIX) && protectedNames.has(refValue.slice(HEADS_PREFIX.length))) {
    result.default_branch_target = true;
    result.code = 'default_branch_target_denied';
  } else if (!refValue.startsWith(HEADS_PREFIX)) {
    result.ref_class = 'unclassified';
    result.code = 'branch_namespace_violation';
  }
  return freezeRecord(
    ['schema', 'version', 'ref_class', 'protected', 'default_branch_target', 'code'],
    result,
  );
}

export function isProtectedRefV1(input) {
  return classifyRefV1(input).protected === true;
}

export function classifyLaneHistoryV1(input) {
  const path = 'history';
  const object = assertClosedObject(input, HISTORY_ALLOWED_KEYS, path);
  requireKeys(object, HISTORY_ALLOWED_KEYS, path);
  const counts = optOwn(object, 'parent_counts');
  assertNotProxy(counts, `${path}.parent_counts`);
  if (!IS_ARRAY(counts) || counts.length < 1 || counts.length > MAX_HISTORY_COMMITS) {
    deny('out_of_range', `${path}.parent_counts`);
  }
  let merge = false;
  for (let i = 0; i < counts.length; i += 1) {
    const count = ownDataValue(counts, STRING(i), `${path}.parent_counts[${i}]`);
    if (typeof count !== 'number' || !IS_INT(count) || count < 0 || count > MAX_PARENT_COUNT) {
      deny('out_of_range', `${path}.parent_counts`);
    }
    if (count >= 2) merge = true;
  }
  return freezeRecord(['schema', 'version', 'verdict', 'code', 'path', 'message'], {
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    verdict: merge ? 'denied' : 'allowed',
    code: merge ? 'merge_history_denied' : 'authority_ok',
    path: 'history',
    message: MSG[merge ? 'merge_history_denied' : 'authority_ok'],
  });
}

export function assertAuthorityPostureV1(input) {
  const path = 'capability';
  const object = assertClosedObject(input, POSTURE_ALLOWED_KEYS, path);
  if (!hasOwn(object, 'merge_authority') || !hasOwn(object, 'create_pr_posture')) {
    deny('missing_key', path);
  }
  if (hasOwn(object, 'schema')
    && optOwn(object, 'schema') !== PROVIDER_CAPABILITIES_BRIDGE_SCHEMA_ID) {
    deny('authority_posture_mismatch', `${path}.schema`);
  }
  const mergeAuthority = optOwn(object, 'merge_authority');
  if (!capturedIncludes(MERGE_AUTHORITIES, mergeAuthority)) {
    deny('authority_posture_mismatch', `${path}.merge_authority`);
  }
  const createPr = optOwn(object, 'create_pr_posture');
  if (!capturedIncludes(CREATE_PR_POSTURES, createPr)) {
    deny('authority_posture_mismatch', `${path}.create_pr_posture`);
  }
  let provider;
  if (hasOwn(object, 'provider')) {
    provider = optOwn(object, 'provider');
    if (!isKnownProvider(provider)) deny('authority_posture_mismatch', `${path}.provider`);
  }
  if (createPr === 'non_authoritative_cloud_only' && provider !== 'cursor-cloud') {
    deny('authority_posture_mismatch', `${path}.create_pr_posture`);
  }
  return freezeRecord(['merge_authority', 'create_pr_posture', 'provider'], {
    merge_authority: mergeAuthority,
    create_pr_posture: createPr,
    provider,
  });
}

function classifyRefFromOperation(object, identity) {
  if (!hasOwn(object, 'ref')) return undefined;
  const refRequest = { ref: optOwn(object, 'ref') };
  if (identity !== undefined) refRequest.identity = {
    repository_path: optOwn(optOwn(object, 'identity'), 'repository_path'),
    base_sha: identity.base_sha,
    run_id: identity.run_id,
    assignment_id: identity.assignment_id,
  };
  for (const key of ['default_branch', 'origin_head_branch', 'init_default_branch', 'manifest_digest_hex']) {
    if (hasOwn(object, key)) refRequest[key] = optOwn(object, key);
  }
  return classifyRefV1(refRequest);
}

function receipt(values) {
  const minted = freezeRecord(RECEIPT_KEYS, {
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    message: MSG[values.code] ?? MSG.invalid_format,
    ref_class: null,
    default_branch_target: false,
    ...values,
  });
  WEAKSET_ADD.call(TRUSTED_POLICY_RECEIPTS, minted);
  return minted;
}

function assertReceiptIdentity(object, path) {
  const runId = optOwn(object, 'run_id');
  bindOrThrow('authority_identity_invalid', path, () => assertRunId(runId, path));
  const assignmentId = optOwn(object, 'assignment_id');
  if (!isAssignmentId(assignmentId)) deny('authority_identity_invalid', path);
  const baseSha = optOwn(object, 'base_sha');
  bindOrThrow('authority_identity_invalid', path, () => assertBaseSha(baseSha, path));
  return { runId, assignmentId, baseSha };
}

function assertTrustedPolicyReceipt(verdict, path) {
  const object = assertClosedObject(verdict, RECEIPT_KEYS, path);
  requireKeys(object, RECEIPT_REQUIRED_KEYS, path);
  if (optOwn(object, 'schema') !== GIT_AUTHORITY_SCHEMA_ID) deny('invalid_format', path);
  if (optOwn(object, 'version') !== GIT_AUTHORITY_VERSION) deny('invalid_format', path);
  const actor = optOwn(object, 'actor');
  if (!capturedIncludes(ACTOR_VALUES, actor)) deny('invalid_format', path);
  const operation = optOwn(object, 'operation');
  if (!capturedIncludes(GIT_OPERATIONS, operation)) deny('invalid_format', path);
  const verdictValue = optOwn(object, 'verdict');
  if (!capturedIncludes(AUTHORITY_VERDICTS, verdictValue)) deny('invalid_format', path);
  const code = optOwn(object, 'code');
  if (typeof code !== 'string' || !hasOwn(MSG, code)) deny('invalid_format', path);
  if (optOwn(object, 'message') !== MSG[code]) deny('invalid_format', path);
  const refClass = optOwn(object, 'ref_class');
  if (refClass !== null && !capturedIncludes(REF_CLASS_VALUES, refClass)) deny('invalid_format', path);
  const defaultTarget = optOwn(object, 'default_branch_target');
  if (typeof defaultTarget !== 'boolean') deny('invalid_type', path);
  const receiptPath = optOwn(object, 'path');
  if (typeof receiptPath !== 'string' || BYTE_LENGTH(receiptPath, 'utf8') > MAX_AUTHORITY_KEY_BYTES) {
    deny('invalid_format', path);
  }
  const identity = assertReceiptIdentity(object, path);
  let trusted = false;
  try { trusted = WEAKSET_HAS.call(TRUSTED_POLICY_RECEIPTS, object); } catch { deny('invalid_type', path); }
  if (trusted !== true) deny('invalid_type', path);
  return {
    actor, operation, verdict: verdictValue, code, ref_class: refClass, ...identity,
  };
}

function assertEvidenceContext(context, path) {
  const object = assertClosedObject(context, EVIDENCE_CONTEXT_ALLOWED_KEYS, path);
  const factId = hasOwn(object, 'fact_id') ? optOwn(object, 'fact_id') : 'f-authority';
  const discrepancyId = hasOwn(object, 'discrepancy_id') ? optOwn(object, 'discrepancy_id') : 'd-authority';
  const sequence = hasOwn(object, 'sequence') ? optOwn(object, 'sequence') : 0;
  if (typeof factId !== 'string' || !capturedTest(RECORD_ID_PATTERN, factId)) deny('invalid_format', path);
  if (typeof discrepancyId !== 'string' || !capturedTest(RECORD_ID_PATTERN, discrepancyId)) {
    deny('invalid_format', path);
  }
  if (typeof sequence !== 'number' || !IS_INT(sequence) || sequence < 0 || sequence > 65535) {
    deny('out_of_range', path);
  }
  return { factId, discrepancyId, sequence };
}

export function classifyGitOperationV1(input) {
  const path = 'request';
  const object = assertClosedObject(input, OPERATION_REQUEST_ALLOWED_KEYS, path);
  requireKeys(object, OPERATION_REQUEST_REQUIRED_KEYS, path);
  if (optOwn(object, 'schema') !== GIT_AUTHORITY_SCHEMA_ID) deny('invalid_format', `${path}.schema`);
  if (optOwn(object, 'version') !== GIT_AUTHORITY_VERSION) deny('invalid_format', `${path}.version`);
  const actor = optOwn(object, 'actor');
  if (!capturedIncludes(ACTOR_VALUES, actor)) deny('invalid_format', `${path}.actor`);
  const operation = optOwn(object, 'operation');
  if (typeof operation !== 'string') deny('invalid_type', `${path}.operation`);
  if (!capturedIncludes(GIT_OPERATIONS, operation)) deny('unknown_git_operation', `${path}.operation`);
  const identity = bindAuthorityIdentityV1(optOwn(object, 'identity'));
  if (hasOwn(object, 'capability')) assertAuthorityPostureV1(optOwn(object, 'capability'));

  const deniedCode = DENIED_OPERATION_CODES[operation];
  if (deniedCode !== undefined) {
    return receipt({
      verdict: 'denied', code: deniedCode, path: 'operation', actor, operation,
      run_id: identity.run_id, assignment_id: identity.assignment_id, base_sha: identity.base_sha,
    });
  }
  if (!capturedIncludes(ACTOR_OPERATIONS[actor], operation)) {
    return receipt({
      verdict: 'denied', code: 'authority_posture_mismatch', path: 'actor', actor, operation,
      run_id: identity.run_id, assignment_id: identity.assignment_id, base_sha: identity.base_sha,
    });
  }
  if (hasOwn(object, 'history')) {
    const history = classifyLaneHistoryV1(optOwn(object, 'history'));
    if (history.verdict === 'denied') {
      return receipt({
        verdict: 'denied', code: 'merge_history_denied', path: 'history', actor, operation,
        run_id: identity.run_id, assignment_id: identity.assignment_id, base_sha: identity.base_sha,
      });
    }
  }

  const write = operation !== 'read_only_inspect';
  if (write && !hasOwn(object, 'ref')) deny('missing_key', `${path}.ref`);
  const classified = classifyRefFromOperation(object, identity);
  if (classified !== undefined && write) {
    const allowedClass = operation === 'compose_candidate_non_authoritative'
      ? 'platform_run_owned' : 'worker_lane';
    const allowed = operation === 'compose_candidate_non_authoritative'
      ? classified.ref_class === 'platform_run_owned' && classified.code === 'protected_ref_write_denied'
      : classified.ref_class === 'worker_lane' && classified.code === 'authority_ok';
    if (!allowed) {
      return receipt({
        verdict: 'denied',
        code: classified.default_branch_target ? 'default_branch_target_denied' : classified.code,
        path: 'ref', actor, operation, ref_class: classified.ref_class,
        default_branch_target: classified.default_branch_target,
        run_id: identity.run_id, assignment_id: identity.assignment_id, base_sha: identity.base_sha,
      });
    }
    return receipt({
      verdict: 'allowed', code: 'authority_ok', path: 'operation', actor, operation,
      ref_class: allowedClass, run_id: identity.run_id, assignment_id: identity.assignment_id,
      base_sha: identity.base_sha,
    });
  }
  return receipt({
    verdict: 'allowed', code: 'authority_ok', path: 'operation', actor, operation,
    ref_class: classified === undefined ? null : classified.ref_class,
    default_branch_target: classified === undefined ? false : classified.default_branch_target,
    run_id: identity.run_id, assignment_id: identity.assignment_id, base_sha: identity.base_sha,
  });
}

function digestOf(value) {
  const hash = HASH('sha256');
  HASH_UPDATE.call(hash, canonicalJsonStringify(value));
  return HASH_DIGEST.call(hash, 'hex');
}

function evidenceMethod(code) {
  if (code === 'merge_history_denied') return 'merge_commit_absence';
  if (code === 'default_branch_target_denied' || code === 'protected_ref_write_denied'
    || code === 'branch_namespace_violation') {
    return 'protected_ref_snapshot_compare';
  }
  return 'ancestry_check';
}

export function projectAuthorityEvidenceV1(verdict, context = {}) {
  const path = 'evidence';
  try {
    const receipt = assertTrustedPolicyReceipt(verdict, path);
    const { factId, discrepancyId, sequence } = assertEvidenceContext(context, `${path}.context`);
    const denied = receipt.verdict === 'denied';
    const payload = { base_sha: receipt.baseSha, head_sha: receipt.baseSha };
    const fact = freezeData({
      fact_id: factId,
      fact_kind: 'git_identity',
      status: denied ? 'failed' : 'verified',
      code: 'host_observed',
      run_id: receipt.runId,
      assignment_id: receipt.assignmentId,
      sequence,
      subject: 'git-authority',
      authority: 'platform_git',
      method: evidenceMethod(receipt.code),
      input_digest: digestOf({
        actor: receipt.actor, operation: receipt.operation, ref_class: receipt.ref_class,
      }),
      output_digest: digestOf({ verdict: receipt.verdict, code: receipt.code }),
      exit_code: denied ? 1 : 0,
      duration_ms: 0,
      truncated: false,
      payload,
      artifact_digests: [],
    });
    const discrepancy = denied ? freezeData({
      discrepancy_id: discrepancyId,
      discrepancy_kind: 'security',
      status: 'recorded',
      code: 'security_boundary',
      run_id: receipt.runId,
      assignment_id: receipt.assignmentId,
      sequence,
      claim_ids: [],
      fact_ids: [factId],
      artifact_digests: [],
    }) : null;
    return freezeData({
      schema: GIT_AUTHORITY_SCHEMA_ID,
      version: GIT_AUTHORITY_VERSION,
      facts: [fact],
      discrepancies: discrepancy === null ? [] : [discrepancy],
    });
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    deny('invalid_type', path);
  }
}

capturedFreeze(parseGitAuthorityPolicyV1);
capturedFreeze(bindAuthorityIdentityV1);
capturedFreeze(expectedRunBranchNameV1);
capturedFreeze(expectedLaneRefV1);
capturedFreeze(expectedCandidateRefV1);
capturedFreeze(isValidRunBranchNameV1);
capturedFreeze(isRunOwnedCandidateRefV1);
capturedFreeze(classifyRefV1);
capturedFreeze(isProtectedRefV1);
capturedFreeze(classifyLaneHistoryV1);
capturedFreeze(assertAuthorityPostureV1);
capturedFreeze(classifyGitOperationV1);
capturedFreeze(projectAuthorityEvidenceV1);
