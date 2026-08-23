// Constrained verification runner — ExecutionIntent execution receipt for
// W16-P16C (ADR 0001 identifiers
// `verification_policy_v1_only_executable_catalog`,
// `codex_selects_approved_command_ids_only`,
// `provider_commands_evidence_never_auto_executed`,
// `read_only_verification`,
// `bounded_evidence`,
// `gate_a_constrained_trusted_policy_command_execution`,
// `gate_a_safe_per_run_cleanup`,
// `gate_a_no_protected_ref_mutation`).
//
// Additive v3 module. It owns one fail-closed question: given a genuine
// immutable P16B ExecutionIntent receipt plus trusted P16A policy and a
// candidate identity, execute that exact owner-approved command once under
// host-available constraints in a disposable workspace and return bounded
// sanitized content-free outcome/evidence compatible with P13. It answers
// nothing else.
// This module never consults PATH, never uses a shell, never opens a remote
// network socket, never merges, rebases, pushes, opens a pull request, or
// mutates a protected ref. It does not import or integrate the MCP server,
// supervisor, scheduler, or process-boundary worker launcher, and it does
// not dispatch a provider. Provider-reported PASS is never treated as a fact.
//
// The only executable and argv that may run are the exact values bound by
// re-resolving the trusted policy against the intent's command_id and typed
// parameters. The child environment is empty by default and receives only
// policy-authorized bounded entries. Network default/deny is enforced; an
// allowlist cannot be enforced here and is denied. Temporary cleanup deletes
// only the exact workspace this invocation created.

import { Buffer as NodeBuffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  APPROVED_VERIFICATION_COMMAND_SCHEMA_ID,
  APPROVED_VERIFICATION_COMMAND_VERSION,
  RECEIPT_KEYS,
  resolveApprovedVerificationCommandV1,
} from './approved-verification-command.mjs';
import {
  FACT_AUTHORITIES,
  FACT_CODES,
  FACT_KINDS,
  FACT_METHODS,
  FACT_STATUSES,
  REPORTED_RESULTS,
} from './evidence-bundle.mjs';
import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import {
  IDENTITY_DOMAIN,
  IDENTITY_LABELS,
  IDENTITY_VERSION,
  canonicalJsonStringify,
  identityDigestV1,
} from './identity.mjs';
import {
  assertBaseSha,
  assertRepositoryPath,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  hasOwn,
  optOwn,
} from './selection-json.mjs';
import {
  DENIED_ENV_NAMES,
  DIGEST_ALGORITHM,
  MAX_POLICY_OBJECT_KEYS,
} from './trusted-verification-policy.mjs';

export const CONSTRAINED_VERIFICATION_SCHEMA_ID =
  'codex-co-engineer.constrained-verification.v1';
export const CONSTRAINED_VERIFICATION_VERSION = 1;
export const VERIFICATION_EXECUTION_DIGEST_LABEL = IDENTITY_LABELS.VERIFICATION_EXECUTION_RECEIPT;

export const GIT_EXECUTABLE = '/usr/bin/git';
export const UNSHARE_EXECUTABLE = '/usr/bin/unshare';
export const WORKSPACE_NAME_PREFIX = 'codex-co-engineer-p16c-';
export const KILL_GRACE_MS = 1_000;
export const STUCK_GRACE_MS = 100;
export const GIT_AUDIT_TIMEOUT_MS = 5_000;
export const GIT_AUDIT_MAX_BYTES = 65_536;
export const WORKSPACE_MODE = 0o700;

export const REQUEST_ALLOWED_KEYS = capturedFreeze(['candidate', 'intent', 'policy']);
export const REQUEST_REQUIRED_KEYS = REQUEST_ALLOWED_KEYS;
export const CANDIDATE_ALLOWED_KEYS = capturedFreeze([
  'expected_base_sha', 'expected_head_sha', 'repository',
]);
export const CANDIDATE_REQUIRED_KEYS = capturedFreeze(['repository']);
export const OPTION_ALLOWED_KEYS = capturedFreeze(['adapter']);
export const ADAPTER_ALLOWED_KEYS = capturedFreeze([
  'killProcessGroup', 'listDescendants', 'lstat', 'mkdir', 'nowMs',
  'randomId', 'readGitIdentity', 'realpath', 'rmdirExact', 'spawn', 'tmpRoot',
]);
export const RECEIPT_BODY_KEYS = capturedFreeze([
  'candidate_audit', 'cleanup', 'command_id', 'facts', 'intent_identity',
  'observations', 'outcome', 'policy_identity', 'schema', 'version',
]);
export const RECEIPT_RESULT_KEYS = capturedFreeze([
  'candidate_audit', 'cleanup', 'command_id', 'execution_identity', 'facts',
  'intent_identity', 'observations', 'outcome', 'policy_identity', 'schema',
  'version',
]);
export const OUTCOME_KEYS = capturedFreeze([
  'duration_ms', 'exit_code', 'result', 'signal', 'stderr_bytes',
  'stderr_digest', 'stderr_truncated', 'stdout_bytes', 'stdout_digest',
  'stdout_truncated', 'termination',
]);
export const CANDIDATE_AUDIT_KEYS = capturedFreeze([
  'base_sha', 'config_digest', 'filesystem_digest', 'head_sha', 'refs_digest',
  'status_digest', 'unchanged', 'worktrees_digest',
]);
export const CLEANUP_KEYS = capturedFreeze(['status']);
export const OBSERVATION_KEYS = capturedFreeze(['acceptance', 'git_identity']);
export const ACCEPTANCE_OBSERVATION_KEYS = capturedFreeze([
  'authority', 'code', 'duration_ms', 'exit_code', 'fact_kind', 'input_digest',
  'method', 'output_digest', 'payload', 'payload_digest', 'status', 'subject',
  'truncated',
]);
export const GIT_OBSERVATION_KEYS = capturedFreeze([
  'authority', 'code', 'duration_ms', 'exit_code', 'fact_kind', 'input_digest',
  'method', 'output_digest', 'payload', 'payload_digest', 'status', 'subject',
  'truncated',
]);
export const IDENTITY_RECEIPT_KEYS = capturedFreeze([
  'algorithm', 'digest', 'domain', 'input_bytes', 'label', 'version',
]);
export const TERMINATION_REASONS = capturedFreeze(['exited']);
export const CLEANUP_STATUSES = capturedFreeze(['removed']);
export const WORKSPACE_ID_PATTERN = /^[0-9a-f]{32}$/u;

export const CONSTRAINED_VERIFICATION_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'authority_denied',
  'candidate_identity_mismatch', 'candidate_mutated', 'candidate_not_regular',
  'candidate_race', 'candidate_unreadable', 'cleanup_uncertain', 'clock_denied',
  'control_character_denied', 'duplicate_id', 'env_name_denied',
  'escaped_descendants', 'executable_content_denied', 'executable_not_runnable',
  'exotic_prototype_denied', 'git_identity_unverified', 'git_unavailable',
  'intent_not_genuine', 'invalid_array', 'invalid_encoding', 'invalid_format',
  'invalid_json_type', 'invalid_json_value', 'invalid_type', 'missing_key',
  'mutation_permission_denied', 'network_allowlist_unsupported',
  'network_content_denied', 'network_isolation_unavailable',
  'non_enumerable_property_denied', 'one_execution_only',
  'option_smuggling_denied', 'out_of_range', 'output_flood',
  'own_undefined_denied', 'placeholder_unbound', 'policy_intent_mismatch',
  'proxy_denied', 'resource_bound_unavailable', 'resource_limit_denied',
  'shell_content_denied', 'signal_ambiguous', 'special_file_denied',
  'symbol_key_denied', 'symlink_denied', 'timeout', 'unknown_command',
  'unknown_key', 'value_depth_exceeded', 'workspace_overlap_denied',
  'workspace_unreadable',
]);

const MESSAGES = capturedFreeze(Object.assign(capturedCreate(null), {
  accessor_property_denied: 'An accessor property was denied; getters are never invoked.',
  aliased_reference_denied: 'Aliased or cyclic references are denied.',
  authority_denied: 'Provider, profile, and manifest commands are evidence only and cannot authorize execution.',
  candidate_identity_mismatch: 'The candidate Git identity does not match the pinned expectation.',
  candidate_mutated: 'The candidate Git identity or filesystem changed during verification.',
  candidate_not_regular: 'The candidate must be a regular directory without a symlink root.',
  candidate_race: 'The candidate changed while it was being inspected.',
  candidate_unreadable: 'The candidate could not be inspected safely.',
  cleanup_uncertain: 'Temporary cleanup could not be proven exact; the path was not deleted.',
  clock_denied: 'The host clock moved backwards or produced a non-canonical duration.',
  control_character_denied: 'Control, invisible, or bidi characters are denied.',
  duplicate_id: 'A duplicate identity was denied instead of collapsed.',
  env_name_denied: 'An environment name is outside the closed allowlist.',
  escaped_descendants: 'A descendant process remained after the single execution ended.',
  executable_content_denied: 'Untrusted input must not contribute executable content.',
  executable_not_runnable: 'The owner-approved executable is not a regular runnable file.',
  exotic_prototype_denied: 'Exotic prototypes are denied.',
  git_identity_unverified: 'Candidate Git identity could not be verified as a closed read-only snapshot.',
  git_unavailable: 'The host Git executable required for candidate audit is unavailable.',
  intent_not_genuine: 'The execution intent is not a genuine immutable P16B receipt for the trusted policy.',
  invalid_array: 'Arrays must be dense JSON arrays without extended metadata.',
  invalid_encoding: 'Text must be well-formed NFC/NFKC Unicode.',
  invalid_format: 'A field violates the closed grammar.',
  invalid_json_type: 'A non-JSON value was denied.',
  invalid_json_value: 'A non-canonical JSON number or value was denied.',
  invalid_type: 'A field has the wrong JSON type.',
  missing_key: 'A required field is missing; trusted execution has no hidden grants.',
  mutation_permission_denied: 'Untrusted input must not contribute mutation permissions.',
  network_allowlist_unsupported: 'Network allowlists cannot be enforced and are denied.',
  network_content_denied: 'Untrusted input must not contribute network targets.',
  network_isolation_unavailable: 'Host network-deny isolation is required and was not available.',
  non_enumerable_property_denied: 'Non-enumerable properties are denied.',
  one_execution_only: 'The approved command may execute once; retry and fallback are denied.',
  option_smuggling_denied: 'A parameter value attempted to smuggle an option or argv fragment.',
  out_of_range: 'A bounded integer, count, or size was exceeded.',
  output_flood: 'Stdout or stderr exceeded the owner-authorized byte cap.',
  own_undefined_denied: 'Own undefined values are denied; omit the field instead.',
  placeholder_unbound: 'An argv placeholder is not bound to a declared parameter.',
  policy_intent_mismatch: 'The execution intent does not belong to the supplied trusted policy.',
  proxy_denied: 'Live and revoked Proxies are denied.',
  resource_bound_unavailable: 'A required host resource bound could not be applied.',
  resource_limit_denied: 'Untrusted input must not contribute resource limits.',
  shell_content_denied: 'Shell text, interpolation, or metacharacters are denied.',
  signal_ambiguous: 'Process termination was ambiguous between exit status and signal.',
  special_file_denied: 'Special files, devices, and non-regular executables are denied.',
  symbol_key_denied: 'Symbol keys are denied.',
  symlink_denied: 'Symbolic links are denied on the executable, candidate, and workspace.',
  timeout: 'The approved command exceeded the owner-authorized timeout.',
  unknown_command: 'The selected command is not in the trusted catalog.',
  unknown_key: 'A key is outside the closed vocabulary.',
  value_depth_exceeded: 'Nesting exceeds the bounded policy depth.',
  workspace_overlap_denied: 'The disposable workspace must be disjoint from the candidate.',
  workspace_unreadable: 'The disposable workspace could not be created or proven exact.',
}));

const EXECUTABLE_FOLDS = capturedFreeze([
  'args', 'argument', 'arguments', 'argv', 'argvtemplate', 'bin', 'binary',
  'cmd', 'cmdline', 'command', 'commandcatalog', 'commands', 'cwd',
  'entrypoint', 'exec', 'executable', 'interpreter', 'run', 'runner',
  'runnercommand', 'script', 'scripts', 'selection', 'shell', 'shellcommand',
  'template', 'templates', 'verificationcommand', 'verificationpolicy',
  'verificationpolicyv1', 'workingdirectory',
]);
const ENVIRONMENT_FOLDS = capturedFreeze([
  'dotenv', 'env', 'environ', 'environment', 'environmentallowlist',
  'envfile', 'envvar', 'envvars',
]);
const NETWORK_FOLDS = capturedFreeze([
  'endpoint', 'host', 'hostname', 'hosts', 'network', 'uri', 'url',
]);
const MUTATION_FOLDS = capturedFreeze([
  'filesystem', 'mutate', 'mutation', 'persist', 'persistent', 'write',
]);
const RESOURCE_FOLDS = capturedFreeze([
  'cpulimit', 'maxerrorbytes', 'maxoutputbytes', 'memorylimit', 'pidslimit',
  'resource', 'resources', 'timeout', 'timeoutms', 'ulimit',
]);
const AUTHORITY_FOLDS = capturedFreeze([
  'acceptance', 'assignment', 'attention', 'catalog', 'claim', 'evidence',
  'manifest', 'profile', 'profiles', 'provider', 'providercommand',
  'providerreport', 'providers', 'report', 'reported', 'requested',
  'requestedcommand', 'suggestion', 'untrusted', 'worker',
]);
const GIT_AUDIT_COMMANDS = capturedFreeze([
  capturedFreeze(['rev-parse', '--verify', 'HEAD']),
  capturedFreeze(['status', '--porcelain=v1', '--untracked-files=all']),
  capturedFreeze(['show-ref', '--head']),
  capturedFreeze(['config', '--local', '--list']),
  capturedFreeze(['worktree', 'list', '--porcelain']),
  capturedFreeze(['rev-parse', '--absolute-git-dir']),
]);

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING = String;
const STRING_REPLACE = Function.prototype.call.bind(String.prototype.replace);
const STRING_TO_LOWER_CASE = Function.prototype.call.bind(String.prototype.toLowerCase);
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith);
const ARRAY_PUSH = Array.prototype.push;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_CONCAT = NodeBuffer.concat.bind(NodeBuffer);
const BUFFER_ALLOC = NodeBuffer.alloc.bind(NodeBuffer);
const TIMING_SAFE_EQUAL = timingSafeEqual;
const CRYPTO_CREATE_HASH = createHash;
const HASH_PROTOTYPE = Object.getPrototypeOf(CRYPTO_CREATE_HASH(DIGEST_ALGORITHM));
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const PATH_JOIN = path.join;
const PATH_RESOLVE = path.resolve;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_RELATIVE = path.relative;
const PATH_DIRNAME = path.dirname;
const OS_TMPDIR = tmpdir;
const FS_LSTAT = lstat;
const FS_MKDIR = mkdir;
const FS_REALPATH = realpath;
const FS_RM = rm;
const PROCESS_KILL = process.kill.bind(process);
const RANDOM_BYTES = randomBytes;
const NODE_SPAWN = nodeSpawn;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;

function deny(code, path) {
  fail(code, path, MESSAGES[code] ?? MESSAGES.invalid_format);
}

function freezeRecord(keys, values) {
  const snapshot = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!capturedHasOwn(values, key)) continue;
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      value: values[key], enumerable: true, writable: false, configurable: false,
    });
  }
  return capturedFreeze(snapshot);
}

function freezeList(values) {
  const clone = [];
  for (let index = 0; index < values.length; index += 1) {
    ARRAY_PUSH.call(clone, values[index]);
  }
  return capturedFreeze(clone);
}

function foldKey(key) {
  return STRING_REPLACE(STRING_TO_LOWER_CASE(STRING(key)), /[-_ ]+/gu, '');
}

function ownKeysOrDeny(value, path) {
  let keys;
  try {
    keys = REFLECT_OWN_KEYS(value);
  } catch {
    deny('invalid_type', path);
  }
  return keys;
}

function classifyRequestKey(key) {
  if (key === 'policy' || key === 'intent' || key === 'candidate') return null;
  const folded = foldKey(key);
  if (folded === 'policy' || folded === 'intent' || folded === 'candidate') return 'unknown_key';
  if (capturedIncludes(AUTHORITY_FOLDS, folded)) return 'authority_denied';
  if (capturedIncludes(EXECUTABLE_FOLDS, folded)) return 'executable_content_denied';
  if (capturedIncludes(ENVIRONMENT_FOLDS, folded)) return 'executable_content_denied';
  if (capturedIncludes(NETWORK_FOLDS, folded)) return 'network_content_denied';
  if (capturedIncludes(MUTATION_FOLDS, folded)) return 'mutation_permission_denied';
  if (capturedIncludes(RESOURCE_FOLDS, folded)) return 'resource_limit_denied';
  return 'unknown_key';
}

function assertClosedOwnKeys(value, allowed, path) {
  const keys = ownKeysOrDeny(value, path);
  if (keys.length > MAX_POLICY_OBJECT_KEYS) deny('out_of_range', path);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (!capturedIncludes(allowed, key)) deny('unknown_key', path);
  }
}

function assertRequestKeys(value, path) {
  const keys = ownKeysOrDeny(value, path);
  if (keys.length > MAX_POLICY_OBJECT_KEYS) deny('out_of_range', path);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    const code = classifyRequestKey(key);
    if (code !== null) deny(code, path);
  }
  for (let index = 0; index < REQUEST_REQUIRED_KEYS.length; index += 1) {
    const key = REQUEST_REQUIRED_KEYS[index];
    if (!hasOwn(value, key)) deny('missing_key', `${path}.${key}`);
  }
}

function sha256Hex(bytes) {
  const hash = CRYPTO_CREATE_HASH(DIGEST_ALGORITHM);
  HASH_UPDATE.call(hash, bytes);
  return HASH_DIGEST.call(hash, 'hex');
}

function digestOf(label, snapshot) {
  const canonical = canonicalJsonStringify(snapshot);
  const canonicalBytes = BUFFER_FROM(canonical, 'utf8');
  const descriptor = identityDigestV1(label, [canonicalBytes]);
  return freezeRecord(IDENTITY_RECEIPT_KEYS, {
    algorithm: DIGEST_ALGORITHM,
    domain: IDENTITY_DOMAIN,
    version: IDENTITY_VERSION,
    label,
    input_bytes: canonicalBytes.length,
    digest: descriptor.digest,
  });
}

function payloadDigestOf(payload) {
  return sha256Hex(BUFFER_FROM(canonicalJsonStringify(payload), 'utf8'));
}

function equalCanonical(left, right) {
  const leftBytes = BUFFER_FROM(left, 'utf8');
  const rightBytes = BUFFER_FROM(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return TIMING_SAFE_EQUAL(leftBytes, rightBytes) === true;
}

function equalDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  return TIMING_SAFE_EQUAL(BUFFER_FROM(left, 'utf8'), BUFFER_FROM(right, 'utf8')) === true;
}

function cloneParameters(parameters) {
  const keys = sortedCapturedKeys(parameters);
  const values = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    values[key] = parameters[key];
  }
  return values;
}

function selectionFromIntent(intent) {
  const selection = { command_id: intent.command_id };
  const parameters = cloneParameters(intent.parameters);
  if (sortedCapturedKeys(parameters).length > 0) selection.parameters = parameters;
  return selection;
}

function looksLikeIntentSnapshot(value, path) {
  if (value === undefined || value === null || typeof value !== 'object') return false;
  if (capturedIsArray(value)) return false;
  const keys = ownKeysOrDeny(value, path);
  if (keys.length !== RECEIPT_KEYS.length) return false;
  for (let index = 0; index < RECEIPT_KEYS.length; index += 1) {
    if (!hasOwn(value, RECEIPT_KEYS[index])) return false;
  }
  return optOwn(value, 'schema') === APPROVED_VERIFICATION_COMMAND_SCHEMA_ID
    && optOwn(value, 'version') === APPROVED_VERIFICATION_COMMAND_VERSION;
}

function consumeGenuineIntent(policyInput, intentInput, path) {
  if (!looksLikeIntentSnapshot(intentInput, path)) deny('intent_not_genuine', path);
  let resolved;
  try {
    resolved = resolveApprovedVerificationCommandV1({
      policy: policyInput,
      selection: selectionFromIntent(intentInput),
    });
  } catch (error) {
    if (error && error.name === 'RunContractV1Error' && typeof error.path === 'string'
      && STRING_STARTS_WITH(error.path, 'request.policy')) {
      throw error;
    }
    deny('intent_not_genuine', path);
  }
  if (!equalCanonical(canonicalJsonStringify(resolved), canonicalJsonStringify(intentInput))) {
    deny('intent_not_genuine', path);
  }
  return resolved;
}

function parseCandidate(input, path) {
  assertPlainObject(input, 'invalid_type', path, path);
  assertClosedOwnKeys(input, CANDIDATE_ALLOWED_KEYS, path);
  for (let index = 0; index < CANDIDATE_REQUIRED_KEYS.length; index += 1) {
    const key = CANDIDATE_REQUIRED_KEYS[index];
    if (!hasOwn(input, key)) deny('missing_key', `${path}.${key}`);
  }
  const repository = optOwn(input, 'repository');
  assertRepositoryPath(repository, `${path}.repository`);
  if (PATH_RESOLVE(repository) !== repository) deny('invalid_format', `${path}.repository`);
  let expectedHead;
  let expectedBase;
  if (hasOwn(input, 'expected_head_sha')) {
    expectedHead = optOwn(input, 'expected_head_sha');
    assertBaseSha(expectedHead, `${path}.expected_head_sha`);
  }
  if (hasOwn(input, 'expected_base_sha')) {
    expectedBase = optOwn(input, 'expected_base_sha');
    assertBaseSha(expectedBase, `${path}.expected_base_sha`);
  }
  return freezeRecord(CANDIDATE_ALLOWED_KEYS, {
    repository,
    expected_head_sha: expectedHead,
    expected_base_sha: expectedBase,
  });
}

function parseRequest(input, path) {
  assertNotProxy(input, path);
  assertPlainObject(input, 'invalid_type', path, path);
  assertDirectJsonClosure(input, path);
  assertRequestKeys(input, path);
  const policyInput = optOwn(input, 'policy');
  const intentInput = optOwn(input, 'intent');
  assertPlainObject(policyInput, 'invalid_type', `${path}.policy`, `${path}.policy`);
  assertPlainObject(intentInput, 'invalid_type', `${path}.intent`, `${path}.intent`);
  const intent = consumeGenuineIntent(policyInput, intentInput, `${path}.intent`);
  const candidate = parseCandidate(optOwn(input, 'candidate'), `${path}.candidate`);
  if (intent.network.mode !== 'deny') deny('network_allowlist_unsupported', `${path}.intent.network`);
  return { policyInput, intent, candidate };
}

function defaultNowMs() {
  return Date.now();
}

function defaultRandomId() {
  return RANDOM_BYTES(16).toString('hex');
}

function defaultTmpRoot() {
  const root = PATH_RESOLVE(OS_TMPDIR());
  if (!PATH_IS_ABSOLUTE(root) || root !== PATH_RESOLVE(root)) deny('workspace_unreadable', 'workspace');
  return root;
}

function defaultKillProcessGroup(pid, signal) {
  if (!NUMBER_IS_SAFE_INTEGER(pid) || pid <= 0) return;
  try {
    PROCESS_KILL(-pid, signal);
  } catch {
    try {
      PROCESS_KILL(pid, signal);
    } catch {
      // ESRCH and equivalent races are inspected by listDescendants.
    }
  }
}

async function defaultListDescendants(pid) {
  if (!NUMBER_IS_SAFE_INTEGER(pid) || pid <= 0) return freezeList([]);
  let dir;
  try {
    dir = await readdir('/proc');
  } catch {
    return freezeList([]);
  }
  const leftover = [];
  for (let index = 0; index < dir.length; index += 1) {
    const name = dir[index];
    if (!/^[0-9]+$/u.test(name)) continue;
    const other = Number(name);
    if (other === pid || !NUMBER_IS_SAFE_INTEGER(other)) continue;
    let stat;
    try {
      stat = await readFile(`/proc/${other}/stat`, 'utf8');
    } catch {
      continue;
    }
    const close = stat.indexOf(')');
    if (close < 0) continue;
    const rest = stat.slice(close + 2).split(' ');
    const ppid = Number(rest[1]);
    const pgid = Number(rest[2]);
    if (ppid === pid || pgid === pid) ARRAY_PUSH.call(leftover, other);
  }
  return freezeList(leftover);
}

async function collectChildOutput(child, timeoutMs) {
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const onOut = (chunk) => {
    const buf = NodeBuffer.isBuffer(chunk) ? chunk : BUFFER_FROM(chunk);
    ARRAY_PUSH.call(stdoutChunks, buf);
    stdoutBytes += buf.length;
  };
  const onErr = (chunk) => {
    const buf = NodeBuffer.isBuffer(chunk) ? chunk : BUFFER_FROM(chunk);
    ARRAY_PUSH.call(stderrChunks, buf);
    stderrBytes += buf.length;
  };
  if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', onOut);
  if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', onErr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }, timeoutMs);
  let closePromise = Promise.resolve();
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (child.stdout && typeof child.stdout.end === 'function') {
      closePromise = closePromise.then(() => new Promise((resolve) => {
        child.stdout.once('end', resolve);
        child.stdout.resume?.();
      }));
    }
    if (child.stderr && typeof child.stderr.end === 'function') {
      closePromise = closePromise.then(() => new Promise((resolve) => {
        child.stderr.once('end', resolve);
        child.stderr.resume?.();
      }));
    }
    await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 25))]);
    if (timedOut) deny('git_identity_unverified', 'candidate');
    if (exit.signal !== null && exit.signal !== undefined) deny('git_identity_unverified', 'candidate');
    if (exit.code !== 0 && exit.code !== 1) deny('git_identity_unverified', 'candidate');
    const stdout = BUFFER_CONCAT(stdoutChunks);
    const stderr = BUFFER_CONCAT(stderrChunks);
    if (stdout.length > GIT_AUDIT_MAX_BYTES || stderr.length > GIT_AUDIT_MAX_BYTES) {
      deny('git_identity_unverified', 'candidate');
    }
    return { code: exit.code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultReadGitIdentity(repository) {
  let gitStat;
  try {
    gitStat = await FS_LSTAT(GIT_EXECUTABLE, { bigint: true });
  } catch {
    deny('git_unavailable', 'candidate');
  }
  if (gitStat.isSymbolicLink() || !gitStat.isFile()) deny('git_unavailable', 'candidate');
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  const outputs = {};
  const names = ['head', 'status', 'refs', 'config', 'worktrees', 'gitdir'];
  for (let index = 0; index < GIT_AUDIT_COMMANDS.length; index += 1) {
    const args = ['-C', repository, '--no-optional-locks'];
    const command = GIT_AUDIT_COMMANDS[index];
    for (let argIndex = 0; argIndex < command.length; argIndex += 1) {
      ARRAY_PUSH.call(args, command[argIndex]);
    }
    let child;
    try {
      child = NODE_SPAWN(GIT_EXECUTABLE, args, {
        cwd: PATH_DIRNAME(repository),
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      deny('git_identity_unverified', 'candidate');
    }
    const result = await collectChildOutput(child, GIT_AUDIT_TIMEOUT_MS);
    if (names[index] === 'head' && result.code !== 0) deny('git_identity_unverified', 'candidate');
    outputs[names[index]] = result.stdout.toString('utf8');
  }
  const head = STRING_REPLACE(outputs.head, /\s+/gu, '');
  assertBaseSha(head, 'candidate.head_sha');
  return freezeRecord(capturedFreeze([
    'config', 'gitdir', 'head_sha', 'refs', 'status', 'worktrees',
  ]), {
    head_sha: head,
    status: outputs.status,
    refs: outputs.refs,
    config: outputs.config,
    worktrees: outputs.worktrees,
    gitdir: STRING_REPLACE(outputs.gitdir, /\s+$/gu, ''),
  });
}

function defaultSpawn(file, args, options) {
  if (options.shell !== false) deny('shell_content_denied', 'execution');
  if (options.networkMode !== 'deny') deny('network_allowlist_unsupported', 'execution.network');
  const confinementArgs = [
    '--user', '--pid', '--fork', '--net', '--', file,
  ];
  for (let index = 0; index < args.length; index += 1) {
    ARRAY_PUSH.call(confinementArgs, args[index]);
  }
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  };
  return NODE_SPAWN(UNSHARE_EXECUTABLE, confinementArgs, spawnOptions);
}

async function defaultRmdirExact(record) {
  await FS_RM(record.path, { recursive: true, force: false });
}

function defaultAdapter() {
  return {
    nowMs: defaultNowMs,
    randomId: defaultRandomId,
    tmpRoot: defaultTmpRoot,
    lstat: (target, options) => FS_LSTAT(target, options ?? { bigint: true }),
    mkdir: (target, options) => FS_MKDIR(target, options),
    realpath: (target) => FS_REALPATH(target),
    rmdirExact: defaultRmdirExact,
    spawn: defaultSpawn,
    killProcessGroup: defaultKillProcessGroup,
    listDescendants: defaultListDescendants,
    readGitIdentity: defaultReadGitIdentity,
  };
}

function resolveAdapter(options, path) {
  if (options === undefined) return defaultAdapter();
  assertNotProxy(options, path);
  assertPlainObject(options, 'invalid_type', path, path);
  assertClosedOwnKeys(options, OPTION_ALLOWED_KEYS, path);
  if (!hasOwn(options, 'adapter')) return defaultAdapter();
  const adapter = optOwn(options, 'adapter');
  assertNotProxy(adapter, `${path}.adapter`);
  if (adapter === null || typeof adapter !== 'object' || capturedIsArray(adapter)) {
    deny('invalid_type', `${path}.adapter`);
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(adapter);
  } catch {
    deny('exotic_prototype_denied', `${path}.adapter`);
  }
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    deny('exotic_prototype_denied', `${path}.adapter`);
  }
  assertClosedOwnKeys(adapter, ADAPTER_ALLOWED_KEYS, `${path}.adapter`);
  const resolved = defaultAdapter();
  const keys = sortedCapturedKeys(adapter);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = optOwn(adapter, key);
    if (typeof value !== 'function') deny('invalid_type', `${path}.adapter.${key}`);
    resolved[key] = value;
  }
  return resolved;
}

function isPathInside(parent, child) {
  if (parent === child) return true;
  const relative = PATH_RELATIVE(parent, child);
  return relative !== '' && !STRING_STARTS_WITH(relative, '..') && !PATH_IS_ABSOLUTE(relative);
}

function encodeFsEntry(entry) {
  return freezeRecord(capturedFreeze([
    'dev', 'ino', 'mode', 'nlink', 'size', 'mtime_ns', 'ctime_ns', 'kind',
  ]), {
    dev: STRING(entry.dev),
    ino: STRING(entry.ino),
    mode: STRING(entry.mode),
    nlink: STRING(entry.nlink),
    size: STRING(entry.size),
    mtime_ns: STRING(entry.mtimeNs),
    ctime_ns: STRING(entry.ctimeNs),
    kind: entry.isSymbolicLink() ? 'symlink'
      : entry.isFile() ? 'file'
        : entry.isDirectory() ? 'directory'
          : 'special',
  });
}

async function lstatOrDeny(adapter, target, path, code) {
  let entry;
  try {
    entry = await adapter.lstat(target, { bigint: true });
  } catch {
    deny(code, path);
  }
  return entry;
}

async function assertExecutableSafe(adapter, executable) {
  const entry = await lstatOrDeny(adapter, executable, 'request.intent.executable', 'executable_not_runnable');
  if (entry.isSymbolicLink()) deny('symlink_denied', 'request.intent.executable');
  if (!entry.isFile()) deny('special_file_denied', 'request.intent.executable');
  const mode = typeof entry.mode === 'bigint' ? Number(entry.mode & 0o111n) : entry.mode & 0o111;
  if (mode === 0) deny('executable_not_runnable', 'request.intent.executable');
}

async function assertCandidateSafe(adapter, candidate) {
  const entry = await lstatOrDeny(
    adapter, candidate.repository, 'request.candidate.repository', 'candidate_unreadable',
  );
  if (entry.isSymbolicLink()) deny('symlink_denied', 'request.candidate.repository');
  if (!entry.isDirectory()) deny('candidate_not_regular', 'request.candidate.repository');
  const gitPath = PATH_JOIN(candidate.repository, '.git');
  const gitEntry = await lstatOrDeny(adapter, gitPath, 'request.candidate.repository', 'candidate_unreadable');
  if (gitEntry.isSymbolicLink()) deny('symlink_denied', 'request.candidate.repository');
  if (!gitEntry.isDirectory() && !gitEntry.isFile()) {
    deny('candidate_not_regular', 'request.candidate.repository');
  }
  return { root: encodeFsEntry(entry), git: encodeFsEntry(gitEntry) };
}

async function snapshotCandidate(adapter, candidate, filesystem, pinExpectations) {
  const git = await adapter.readGitIdentity(candidate.repository);
  if (pinExpectations === true && candidate.expected_head_sha !== undefined
    && !equalDigest(candidate.expected_head_sha, git.head_sha)) {
    deny('candidate_identity_mismatch', 'request.candidate.expected_head_sha');
  }
  const baseSha = candidate.expected_base_sha ?? git.head_sha;
  if (pinExpectations === true && candidate.expected_base_sha !== undefined) {
    assertBaseSha(baseSha, 'request.candidate.expected_base_sha');
  }
  return freezeRecord(capturedFreeze([
    'base_sha', 'config_digest', 'filesystem_digest', 'gitdir', 'head_sha',
    'refs_digest', 'status_digest', 'worktrees_digest',
  ]), {
    head_sha: git.head_sha,
    base_sha: baseSha,
    status_digest: sha256Hex(BUFFER_FROM(git.status, 'utf8')),
    refs_digest: sha256Hex(BUFFER_FROM(git.refs, 'utf8')),
    config_digest: sha256Hex(BUFFER_FROM(git.config, 'utf8')),
    worktrees_digest: sha256Hex(BUFFER_FROM(git.worktrees, 'utf8')),
    filesystem_digest: sha256Hex(BUFFER_FROM(canonicalJsonStringify(filesystem), 'utf8')),
    gitdir: git.gitdir,
  });
}

function assertUnchanged(before, after) {
  const fields = [
    'head_sha', 'base_sha', 'status_digest', 'refs_digest', 'config_digest',
    'worktrees_digest', 'filesystem_digest', 'gitdir',
  ];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!equalDigest(STRING(before[field]), STRING(after[field]))) {
      deny(field === 'filesystem_digest' || field === 'head_sha' ? 'candidate_mutated' : 'candidate_race',
        'candidate');
    }
  }
}

function buildChildEnvironment(environment) {
  const env = {};
  const entries = environment.entries;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const name = entry.name;
    if (capturedIncludes(DENIED_ENV_NAMES, name) || name === 'PATH') {
      deny('env_name_denied', 'request.intent.environment');
    }
    env[name] = entry.value;
  }
  return env;
}

async function createWorkspace(adapter, candidate) {
  const root = adapter.tmpRoot();
  if (typeof root !== 'string' || !PATH_IS_ABSOLUTE(root) || PATH_RESOLVE(root) !== root) {
    deny('workspace_unreadable', 'workspace');
  }
  const rootEntry = await lstatOrDeny(adapter, root, 'workspace', 'workspace_unreadable');
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) deny('symlink_denied', 'workspace');
  const id = adapter.randomId();
  if (typeof id !== 'string' || !capturedTest(WORKSPACE_ID_PATTERN, id)) {
    deny('workspace_unreadable', 'workspace');
  }
  const workspacePath = PATH_JOIN(root, `${WORKSPACE_NAME_PREFIX}${id}`);
  if (PATH_RESOLVE(workspacePath) !== workspacePath) deny('workspace_unreadable', 'workspace');
  if (isPathInside(candidate.repository, workspacePath)
    || isPathInside(workspacePath, candidate.repository)
    || workspacePath === root || workspacePath === '/' || workspacePath === candidate.repository) {
    deny('workspace_overlap_denied', 'workspace');
  }
  try {
    await adapter.mkdir(workspacePath, { recursive: false, mode: WORKSPACE_MODE });
  } catch {
    deny('workspace_unreadable', 'workspace');
  }
  const entry = await lstatOrDeny(adapter, workspacePath, 'workspace', 'workspace_unreadable');
  if (entry.isSymbolicLink()) deny('symlink_denied', 'workspace');
  if (!entry.isDirectory()) deny('special_file_denied', 'workspace');
  let resolved;
  try {
    resolved = await adapter.realpath(workspacePath);
  } catch {
    deny('workspace_unreadable', 'workspace');
  }
  if (resolved !== workspacePath) deny('symlink_denied', 'workspace');
  return capturedFreeze({
    path: workspacePath,
    root,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
  });
}

function assertExactWorkspace(record, entry, resolved) {
  if (record.path === '/' || record.path === record.root) deny('cleanup_uncertain', 'cleanup');
  if (!isPathInside(record.root, record.path) || record.path === record.root) {
    deny('cleanup_uncertain', 'cleanup');
  }
  if (PATH_RELATIVE(record.root, record.path).includes('..')) deny('cleanup_uncertain', 'cleanup');
  if (entry.isSymbolicLink() || !entry.isDirectory()) deny('cleanup_uncertain', 'cleanup');
  if (entry.dev !== record.dev || entry.ino !== record.ino) deny('cleanup_uncertain', 'cleanup');
  if (resolved !== record.path) deny('cleanup_uncertain', 'cleanup');
}

async function removeExactWorkspace(adapter, record) {
  if (record === undefined || typeof record.path !== 'string' || !PATH_IS_ABSOLUTE(record.path)) {
    deny('cleanup_uncertain', 'cleanup');
  }
  if (PATH_RESOLVE(record.path) !== record.path) deny('cleanup_uncertain', 'cleanup');
  const entry = await lstatOrDeny(adapter, record.path, 'cleanup', 'cleanup_uncertain');
  let resolved;
  try {
    resolved = await adapter.realpath(record.path);
  } catch {
    deny('cleanup_uncertain', 'cleanup');
  }
  assertExactWorkspace(record, entry, resolved);
  try {
    await adapter.rmdirExact(record);
  } catch (error) {
    if (error && error.name === 'RunContractV1Error') throw error;
    deny('cleanup_uncertain', 'cleanup');
  }
}

function waitStreamEnded(stream) {
  if (!stream || typeof stream.once !== 'function') return Promise.resolve();
  if (stream.readableEnded === true) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once('end', done);
    stream.once('close', done);
    stream.once('error', done);
    if (typeof stream.resume === 'function') stream.resume();
  });
}

function attachCappedStream(stream, maxBytes, onFlood) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  const handle = (chunk) => {
    if (truncated) return;
    const buf = NodeBuffer.isBuffer(chunk) ? chunk : BUFFER_FROM(chunk);
    const room = maxBytes - size;
    if (buf.length > room) {
      if (room > 0) ARRAY_PUSH.call(chunks, buf.subarray(0, room));
      size = maxBytes;
      truncated = true;
      onFlood();
      return;
    }
    ARRAY_PUSH.call(chunks, buf);
    size += buf.length;
  };
  if (stream && typeof stream.on === 'function') stream.on('data', handle);
  return {
    bytes: () => size,
    truncated: () => truncated,
    digest: () => sha256Hex(size === 0 ? BUFFER_ALLOC(0) : BUFFER_CONCAT(chunks)),
  };
}

async function runApprovedOnce(adapter, intent, cwd, env, markSpawned) {
  if (intent.timeout_ms < KILL_GRACE_MS) deny('out_of_range', 'request.intent.timeout_ms');
  const argv = [];
  for (let index = 0; index < intent.argv.length; index += 1) {
    ARRAY_PUSH.call(argv, intent.argv[index]);
  }
  markSpawned();
  let child;
  try {
    child = adapter.spawn(intent.executable, argv, {
      cwd,
      env,
      shell: false,
      networkMode: 'deny',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    });
  } catch {
    deny('resource_bound_unavailable', 'execution');
  }
  if (!child || typeof child.on !== 'function') deny('resource_bound_unavailable', 'execution');
  let flooded = false;
  let timedOut = false;
  let killGrace;
  const stdoutCap = attachCappedStream(child.stdout, intent.resources.max_output_bytes, () => {
    flooded = true;
    try { adapter.killProcessGroup(child.pid, 'SIGKILL'); } catch { /* already dead */ }
  });
  const stderrCap = attachCappedStream(child.stderr, intent.resources.max_error_bytes, () => {
    flooded = true;
    try { adapter.killProcessGroup(child.pid, 'SIGKILL'); } catch { /* already dead */ }
  });
  const timer = setTimeout(() => {
    timedOut = true;
    try { adapter.killProcessGroup(child.pid, 'SIGTERM'); } catch { /* already dead */ }
    killGrace = setTimeout(() => {
      try { adapter.killProcessGroup(child.pid, 'SIGKILL'); } catch { /* already dead */ }
    }, KILL_GRACE_MS);
  }, intent.timeout_ms);
  let exit;
  let stuckTimer;
  try {
    exit = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once('error', reject);
      child.once('exit', (code, signal) => finish({ code, signal }));
      stuckTimer = setTimeout(() => {
        timedOut = true;
        finish({ code: null, signal: null, stuck: true });
      }, intent.timeout_ms + KILL_GRACE_MS + STUCK_GRACE_MS);
    });
    await Promise.race([
      Promise.all([waitStreamEnded(child.stdout), waitStreamEnded(child.stderr)]),
      new Promise((resolve) => setTimeout(resolve, STUCK_GRACE_MS)),
    ]);
  } catch {
    deny('resource_bound_unavailable', 'execution');
  } finally {
    clearTimeout(timer);
    if (killGrace !== undefined) clearTimeout(killGrace);
    if (stuckTimer !== undefined) clearTimeout(stuckTimer);
  }
  const leftovers = await adapter.listDescendants(child.pid);
  if (capturedIsArray(leftovers) && leftovers.length > 0) {
    for (let index = 0; index < leftovers.length; index += 1) {
      try { adapter.killProcessGroup(leftovers[index], 'SIGKILL'); } catch { /* best effort */ }
    }
    const still = await adapter.listDescendants(child.pid);
    if (capturedIsArray(still) && still.length > 0) deny('escaped_descendants', 'execution');
    deny('escaped_descendants', 'execution');
  }
  if (flooded || stdoutCap.truncated() || stderrCap.truncated()) deny('output_flood', 'execution');
  if (timedOut) deny('timeout', 'execution');
  const code = exit.code;
  const signal = exit.signal;
  const hasCode = code !== null && code !== undefined;
  const hasSignal = signal !== null && signal !== undefined;
  if (hasCode === hasSignal) deny('signal_ambiguous', 'execution');
  if (hasSignal) deny('signal_ambiguous', 'execution');
  if (typeof code !== 'number' || !NUMBER_IS_SAFE_INTEGER(code) || code < 0 || code > 255) {
    deny('signal_ambiguous', 'execution');
  }
  return {
    exit_code: code,
    signal: null,
    stdout_bytes: stdoutCap.bytes(),
    stderr_bytes: stderrCap.bytes(),
    stdout_digest: stdoutCap.digest(),
    stderr_digest: stderrCap.digest(),
    stdout_truncated: false,
    stderr_truncated: false,
  };
}

function requireEnum(allowed, value, path) {
  if (!capturedIncludes(allowed, value)) deny('invalid_format', path);
  return value;
}

function resultForExit(code) {
  return requireEnum(REPORTED_RESULTS, code === 0 ? 'pass' : 'fail', 'outcome.result');
}

function freezeAcceptanceObservation(intent, run, durationMs) {
  const payload = freezeRecord(capturedFreeze(['command_id', 'result']), {
    command_id: intent.command_id,
    result: resultForExit(run.exit_code),
  });
  const outputDigest = sha256Hex(BUFFER_FROM(`${run.stdout_digest}:${run.stderr_digest}`, 'utf8'));
  return freezeRecord(ACCEPTANCE_OBSERVATION_KEYS, {
    fact_kind: requireEnum(FACT_KINDS, 'acceptance_results', 'facts.acceptance.fact_kind'),
    status: requireEnum(FACT_STATUSES, 'verified', 'facts.acceptance.status'),
    code: requireEnum(FACT_CODES, 'host_observed', 'facts.acceptance.code'),
    subject: intent.command_id,
    authority: requireEnum(FACT_AUTHORITIES, 'platform_acceptance_runner', 'facts.acceptance.authority'),
    method: requireEnum(FACT_METHODS, 'approved_command_execution', 'facts.acceptance.method'),
    input_digest: intent.plan_identity.digest,
    output_digest: outputDigest,
    exit_code: run.exit_code,
    duration_ms: durationMs,
    truncated: false,
    payload,
    payload_digest: payloadDigestOf(payload),
  });
}

function freezeGitObservation(snapshot, durationMs, inputDigest) {
  const payload = freezeRecord(capturedFreeze(['base_sha', 'head_sha']), {
    base_sha: snapshot.base_sha,
    head_sha: snapshot.head_sha,
  });
  return freezeRecord(GIT_OBSERVATION_KEYS, {
    fact_kind: requireEnum(FACT_KINDS, 'git_identity', 'facts.git_identity.fact_kind'),
    status: requireEnum(FACT_STATUSES, 'verified', 'facts.git_identity.status'),
    code: requireEnum(FACT_CODES, 'host_observed', 'facts.git_identity.code'),
    subject: 'repository',
    authority: requireEnum(FACT_AUTHORITIES, 'platform_git', 'facts.git_identity.authority'),
    method: requireEnum(FACT_METHODS, 'read_only_no_changes', 'facts.git_identity.method'),
    input_digest: inputDigest,
    output_digest: snapshot.filesystem_digest,
    exit_code: null,
    duration_ms: durationMs,
    truncated: false,
    payload,
    payload_digest: payloadDigestOf(payload),
  });
}

function cloneObservation(observation, keys) {
  const payloadKeys = sortedCapturedKeys(observation.payload);
  const payloadValues = {};
  for (let index = 0; index < payloadKeys.length; index += 1) {
    const key = payloadKeys[index];
    payloadValues[key] = observation.payload[key];
  }
  const values = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    values[key] = key === 'payload' ? freezeRecord(payloadKeys, payloadValues) : observation[key];
  }
  return freezeRecord(keys, values);
}

function freezeFacts(acceptance, git) {
  return freezeList([
    cloneObservation(acceptance, ACCEPTANCE_OBSERVATION_KEYS),
    cloneObservation(git, GIT_OBSERVATION_KEYS),
  ]);
}

function freezeOutcome(run, durationMs) {
  return freezeRecord(OUTCOME_KEYS, {
    result: resultForExit(run.exit_code),
    exit_code: run.exit_code,
    signal: null,
    termination: 'exited',
    duration_ms: durationMs,
    stdout_bytes: run.stdout_bytes,
    stderr_bytes: run.stderr_bytes,
    stdout_digest: run.stdout_digest,
    stderr_digest: run.stderr_digest,
    stdout_truncated: false,
    stderr_truncated: false,
  });
}

function freezeCandidateAudit(snapshot) {
  return freezeRecord(CANDIDATE_AUDIT_KEYS, {
    head_sha: snapshot.head_sha,
    base_sha: snapshot.base_sha,
    unchanged: true,
    status_digest: snapshot.status_digest,
    refs_digest: snapshot.refs_digest,
    config_digest: snapshot.config_digest,
    worktrees_digest: snapshot.worktrees_digest,
    filesystem_digest: snapshot.filesystem_digest,
  });
}

export async function executeConstrainedVerificationV1(input, options = {}) {
  const request = parseRequest(input, 'request');
  const adapter = resolveAdapter(options, 'options');
  const intent = request.intent;
  const candidate = request.candidate;
  await assertExecutableSafe(adapter, intent.executable);
  const filesystemBefore = await assertCandidateSafe(adapter, candidate);
  const before = await snapshotCandidate(adapter, candidate, filesystemBefore, true);
  let workspace;
  let spawned = false;
  const markSpawned = () => {
    if (spawned) deny('one_execution_only', 'execution');
    spawned = true;
  };
  try {
    workspace = await createWorkspace(adapter, candidate);
    const env = buildChildEnvironment(intent.environment);
    const started = adapter.nowMs();
    if (typeof started !== 'number' || !NUMBER_IS_SAFE_INTEGER(started) || started < 0) {
      deny('clock_denied', 'execution');
    }
    const run = await runApprovedOnce(adapter, intent, workspace.path, env, markSpawned);
    const ended = adapter.nowMs();
    if (typeof ended !== 'number' || !NUMBER_IS_SAFE_INTEGER(ended) || ended < started) {
      deny('clock_denied', 'execution');
    }
    const durationMs = ended - started;
    const filesystemAfter = await assertCandidateSafe(adapter, candidate);
    const after = await snapshotCandidate(adapter, candidate, filesystemAfter, false);
    assertUnchanged(before, after);
    await removeExactWorkspace(adapter, workspace);
    workspace = undefined;
    const acceptance = freezeAcceptanceObservation(intent, run, durationMs);
    const git = freezeGitObservation(after, durationMs, intent.plan_identity.digest);
    const observations = freezeRecord(OBSERVATION_KEYS, { acceptance, git_identity: git });
    const body = freezeRecord(RECEIPT_BODY_KEYS, {
      schema: CONSTRAINED_VERIFICATION_SCHEMA_ID,
      version: CONSTRAINED_VERIFICATION_VERSION,
      command_id: intent.command_id,
      intent_identity: intent.plan_identity,
      policy_identity: intent.policy_identity,
      outcome: freezeOutcome(run, durationMs),
      candidate_audit: freezeCandidateAudit(after),
      cleanup: freezeRecord(CLEANUP_KEYS, { status: 'removed' }),
      observations,
      facts: freezeFacts(acceptance, git),
    });
    const executionIdentity = digestOf(VERIFICATION_EXECUTION_DIGEST_LABEL, body);
    return freezeRecord(RECEIPT_RESULT_KEYS, {
      schema: body.schema,
      version: body.version,
      command_id: body.command_id,
      intent_identity: body.intent_identity,
      policy_identity: body.policy_identity,
      execution_identity: executionIdentity,
      outcome: body.outcome,
      candidate_audit: body.candidate_audit,
      cleanup: body.cleanup,
      observations: body.observations,
      facts: body.facts,
    });
  } catch (error) {
    if (workspace !== undefined) {
      try {
        await removeExactWorkspace(adapter, workspace);
      } catch (cleanupError) {
        if (cleanupError && cleanupError.name === 'RunContractV1Error') throw cleanupError;
        deny('cleanup_uncertain', 'cleanup');
      }
    }
    throw error;
  }
}

export const CONSTRAINED_VERIFICATION_CONTRACT_DESCRIPTOR = capturedFreeze({
  schema: CONSTRAINED_VERIFICATION_SCHEMA_ID,
  version: CONSTRAINED_VERIFICATION_VERSION,
  label: VERIFICATION_EXECUTION_DIGEST_LABEL,
  request_keys: REQUEST_ALLOWED_KEYS,
  candidate_keys: CANDIDATE_ALLOWED_KEYS,
  receipt_keys: RECEIPT_RESULT_KEYS,
  git_executable: GIT_EXECUTABLE,
  unshare_executable: UNSHARE_EXECUTABLE,
  reported_results: REPORTED_RESULTS,
  fact_kinds: capturedFreeze(['acceptance_results', 'git_identity']),
  default_deny: capturedFreeze({
    shell: false,
    env: capturedFreeze({}),
    network: 'deny',
    executions: 1,
  }),
});

capturedFreeze(executeConstrainedVerificationV1);
