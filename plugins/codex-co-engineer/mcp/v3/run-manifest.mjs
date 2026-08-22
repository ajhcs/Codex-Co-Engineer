// RunManifestV1 — strict run-envelope contract for bounded R1 runs (ADR 0001,
// identifiers `bounded_run_1_to_8`, `immutable_repo_base_identity`,
// `disjoint_writer_scopes`, `no_direct_mode_for_run_submissions`,
// `manifests_carry_command_ids_not_argv`).
//
// Additive v3 module; it imports 3.2.1 deadline math from contract.mjs and
// edits no existing runtime surface. This file validates the run ENVELOPE:
//   - exact schema identity and git-ref-safe run IDs;
//   - one immutable repository path + 40-hex lowercase base SHA per run;
//   - 1..8 independent assignments (no dependency edges of any shape);
//   - strict unknown-key rejection at every object depth, with precise
//     denial codes for dependency, executable-content, credential,
//     merge/push/create-PR-authority, replay/fallback, and direct-mode keys;
//   - disjoint writer scopes across assignments (conservative static-prefix
//     intersection; glob metacharacters terminate the comparable prefix);
//   - the verified-decision return contract (artifact addressing mandatory);
//   - mandatory composition with the deep assignment and policy validators.
//
// Deep AssignmentManifestV1 and RunPolicyV1 value semantics live in
// assignment-manifest.mjs and run-policy.mjs. Compose the full contract via
// validateRunManifestV1() / validateCompleteRunManifestV1() in run-policy.mjs.
// The exported envelope composer rejects absent hooks. Validation is fail-fast
// with a fixed pipeline and sorted key iteration, so identical inputs always
// produce identical first errors.

import { types as utilTypes } from 'node:util';

import {
  MAX_EXPECTED_DURATION_MS,
  MAX_TIMEOUT_MS,
  MIN_DURATION_MS,
} from './contract.mjs';

export const RUN_MANIFEST_SCHEMA_ID = 'codex-co-engineer.run.v1';
export const ASSIGNMENT_SCHEMA_ID = 'codex-co-engineer.assignment.v1';
export const POLICY_SCHEMA_ID = 'codex-co-engineer.policy.v1';

export const MIN_ASSIGNMENTS = 1;
export const MAX_ASSIGNMENTS = 8;

export const RUN_ID_MIN = 3;
export const RUN_ID_MAX = 64;
export const ASSIGNMENT_ID_MAX = 64;
export const PROFILE_NAME_MAX = 64;
export const MODEL_ID_MAX = 128;
export const COMMAND_ID_MAX = 64;

export const OBJECTIVE_MIN_BYTES = 1;
export const OBJECTIVE_MAX_BYTES = 4096;
export const PROMPT_MIN_BYTES = 1;
export const PROMPT_MAX_BYTES = 16_384;

export const SCOPE_MAX_PATTERNS = 16;
export const SCOPE_PATTERN_MAX_BYTES = 256;
export const SCOPE_SEGMENT_MAX_BYTES = 128;
export const SCOPE_MAX_SEGMENTS = 16;

export const ACCEPTANCE_MAX_COMMANDS = 8;
export const PARAMS_MAX_KEYS = 8;
export const PARAM_VALUE_MAX_BYTES = 256;
export const MAX_MANIFEST_DEPTH = 32;
export const MAX_MANIFEST_NODES = 2048;
export const MAX_MANIFEST_OBJECT_KEYS = 64;
export const MAX_MANIFEST_TOTAL_STRING_BYTES = 524_288;
export const MAX_MANIFEST_KEY_BYTES = 128;

export const MIN_TIMEOUT_MS = MIN_DURATION_MS;
export { MAX_EXPECTED_DURATION_MS, MAX_TIMEOUT_MS, MIN_DURATION_MS };

export const PROVIDERS = Object.freeze(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
export const ASSIGNMENT_ROLES = Object.freeze(['implement', 'review', 'verify']);
export const ACCESS_MODES = Object.freeze(['writer', 'read_only']);
export const ROLE_ACCESS = Object.freeze({
  implement: 'writer',
  review: 'read_only',
  verify: 'read_only',
});
export const EVIDENCE_KINDS = Object.freeze([
  'provider_report',
  'git_identity',
  'git_diff',
  'acceptance_results',
]);

export const RUN_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/u;
export const ASSIGNMENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
export const COMMAND_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
export const SHA40_PATTERN = /^[0-9a-f]{40}$/u;
export const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
export const GLOB_SEGMENT_PATTERN = /^\*\*$|^[A-Za-z0-9._*?\[\]-]{1,128}$/u;

// Closed vocabularies. Any key outside them is rejected; keys listed in
// FORBIDDEN_KEY_CLASSES additionally get a precise denial code wherever they
// appear, at any depth. Policy safety keys are permitted solely inside
// RunPolicyV1, where they are required as exact safe literals.
export const ROOT_ALLOWED_KEYS = Object.freeze([
  'schema', 'run_id', 'repository', 'objective', 'assignments', 'policy', 'return_contract',
]);
export const REPOSITORY_ALLOWED_KEYS = Object.freeze(['path', 'base_sha']);
export const RETURN_CONTRACT_ALLOWED_KEYS = Object.freeze(['mode', 'include_artifact_refs']);
export const POLICY_ALLOWED_KEYS = Object.freeze([
  'max_concurrency', 'require_same_base', 'require_disjoint_writer_scopes',
  'allow_post_dispatch_fallback', 'allow_merge', 'allow_create_pr',
  'attention_mode', 'completion_mode',
]);
export const ASSIGNMENT_ALLOWED_KEYS = Object.freeze([
  'assignment_id', 'role', 'access', 'prompt', 'execution', 'write_scope',
  'acceptance', 'expected_duration_ms', 'required_evidence', 'starting_ref',
]);
export const EXECUTION_ALLOWED_KEYS = Object.freeze(['profile', 'provider', 'model']);
export const ACCEPTANCE_ALLOWED_KEYS = Object.freeze(['command_id', 'parameters', 'timeout_ms']);

const FORBIDDEN_KEY_CLASSES = new Map([
  // No dependency edges, no general DAG (`general_dag_or_branch_inheritance`).
  ['depends_on', 'dependency_not_allowed'], ['dependencies', 'dependency_not_allowed'],
  ['blocked_by', 'dependency_not_allowed'], ['blocking', 'dependency_not_allowed'],
  ['requires', 'dependency_not_allowed'], ['needs', 'dependency_not_allowed'],
  ['after', 'dependency_not_allowed'], ['before', 'dependency_not_allowed'],
  ['prerequisites', 'dependency_not_allowed'], ['waits_for', 'dependency_not_allowed'],
  ['parent', 'dependency_not_allowed'], ['parents', 'dependency_not_allowed'],
  ['children', 'dependency_not_allowed'],
  ['dag', 'dependency_not_allowed'], ['edges', 'dependency_not_allowed'],
  // Merge/push/create-PR/protected-ref authority stays outside the platform.
  ['allow_merge', 'merge_authority_denied'], ['merge', 'merge_authority_denied'],
  ['merges', 'merge_authority_denied'], ['allow_push', 'merge_authority_denied'],
  ['push', 'merge_authority_denied'], ['force_push', 'merge_authority_denied'],
  ['push_branch', 'merge_authority_denied'], ['allow_create_pr', 'merge_authority_denied'],
  ['create_pr', 'merge_authority_denied'],
  ['auto_create_pr', 'merge_authority_denied'], ['create_pull_request', 'merge_authority_denied'],
  ['open_pr', 'merge_authority_denied'], ['merge_pr', 'merge_authority_denied'],
  // Manifests carry approved command IDs, never executable content.
  ['command', 'executable_content_denied'], ['commands', 'executable_content_denied'],
  ['argv', 'executable_content_denied'], ['executable', 'executable_content_denied'],
  ['exec', 'executable_content_denied'], ['shell', 'executable_content_denied'],
  ['script', 'executable_content_denied'], ['scripts', 'executable_content_denied'],
  ['cmdline', 'executable_content_denied'], ['binary', 'executable_content_denied'],
  ['interpreter', 'executable_content_denied'], ['entrypoint', 'executable_content_denied'],
  ['env', 'executable_content_denied'], ['environ', 'executable_content_denied'],
  ['environment', 'executable_content_denied'], ['working_directory', 'executable_content_denied'],
  // No credentials or secret material in manifests, at any depth.
  ['credentials', 'credential_content_denied'], ['credential', 'credential_content_denied'],
  ['secret', 'credential_content_denied'], ['secrets', 'credential_content_denied'],
  ['token', 'credential_content_denied'], ['tokens', 'credential_content_denied'],
  ['api_key', 'credential_content_denied'], ['api_keys', 'credential_content_denied'],
  ['password', 'credential_content_denied'], ['passphrase', 'credential_content_denied'],
  ['private_key', 'credential_content_denied'], ['ssh_key', 'credential_content_denied'],
  ['auth_header', 'credential_content_denied'], ['authorization', 'credential_content_denied'],
  // Post-dispatch fallback and replay can never be enabled.
  ['allow_post_dispatch_fallback', 'replay_or_fallback_denied'],
  ['fallback', 'replay_or_fallback_denied'], ['fallbacks', 'replay_or_fallback_denied'],
  ['allow_fallback', 'replay_or_fallback_denied'], ['fallback_provider', 'replay_or_fallback_denied'],
  ['fallback_model', 'replay_or_fallback_denied'], ['allow_replay', 'replay_or_fallback_denied'],
  ['replay', 'replay_or_fallback_denied'], ['resend', 'replay_or_fallback_denied'],
  ['redrive', 'replay_or_fallback_denied'], ['retry_dispatch', 'replay_or_fallback_denied'],
  // Run submissions are always managed; direct mode is not expressible.
  ['workspace_mode', 'direct_mode_rejected'], ['direct_mode', 'direct_mode_rejected'],
]);

export class RunContractV1Error extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'RunContractV1Error';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  // Proxy reflection is trap-dispatched: a Proxy can lie about descriptors or
  // throw from an otherwise side-effect-free inspection. R1 accepts JSON data,
  // never executable Proxy surfaces, so reject them before invoking any trap.
  if (utilTypes.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function utf8ByteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function sortedKeys(object) {
  return Object.keys(object).sort();
}

export function hasOwn(object, key) {
  return Object.hasOwn(object, key);
}

// Direct JavaScript callers can supply values that JSON can never produce.
// Reject accessors, symbols, non-enumerable payload keys, and custom
// prototypes so inherited or hidden executable fields cannot bypass checks.
// Frozen data remains valid because data properties need not be writable.
export function assertJsonDataObject(object, path) {
  if (!isPlainObject(object)) {
    fail('invalid_type', path, `${path} must be a plain JSON data object.`);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(object);
  } catch {
    fail('invalid_object', path, `${path} keys could not be inspected safely.`);
  }
  if (keys.length > MAX_MANIFEST_OBJECT_KEYS) {
    fail('manifest_too_complex', path,
      `${path} exceeds ${MAX_MANIFEST_OBJECT_KEYS} object keys.`);
  }
  const entries = [];
  for (const key of keys) {
    if (typeof key !== 'string') {
      fail('invalid_object', path, `${path} must not contain symbol keys.`);
    }
  }
  keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const key of keys) {
    // Inspect the byte bound before the key is interpolated into a diagnostic
    // path. This keeps a hostile direct-JavaScript key from turning one typed
    // rejection into an attacker-sized error object.
    if (utf8ByteLength(key) > MAX_MANIFEST_KEY_BYTES) {
      fail(
        'manifest_too_large',
        path,
        `An object key at ${path} exceeds the ${MAX_MANIFEST_KEY_BYTES}-byte manifest-key limit.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid_object', `${path}.${key}`, `${path}.${key} must be an enumerable data property.`);
    }
    entries.push({ key, value: descriptor.value });
  }
  return entries;
}

function isCanonicalArrayIndex(key, length) {
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

export function assertDenseJsonArray(value, path) {
  if (typeof value !== 'object' || value === null) {
    fail('invalid_type', path, `${path} must be an array.`);
  }
  if (utilTypes.isProxy(value)) {
    fail('invalid_array', path, `${path} must be a concrete JSON array, not a Proxy.`);
  }
  if (!Array.isArray(value)) fail('invalid_type', path, `${path} must be an array.`);
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail('invalid_array', path, `${path} prototype could not be inspected safely.`);
  }
  if (prototype !== Array.prototype && prototype !== null) {
    fail('invalid_array', path, `${path} must use the standard or null array prototype.`);
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      fail('invalid_array', path, `${path} must not inherit enumerable array properties.`);
    }
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail('invalid_array', path, `${path} keys could not be inspected safely.`);
  }
  let indexCount = 0;
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
      fail('invalid_array', path, `${path} must be a dense JSON array without extra or symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('invalid_array', `${path}[${key}]`, `${path}[${key}] must be an enumerable data element.`);
    }
    indexCount += 1;
  }
  if (indexCount !== value.length) {
    fail('invalid_array', path, `${path} must be dense; sparse arrays are not JSON manifest values.`);
  }
}

// Bound direct-JS abuse before sorted-key and character-level scans. The
// limits leave ample room for the maximum valid eight-lane manifest.
export function assertManifestComplexity(root) {
  const stack = [{ value: root, path: '$', depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  let stringBytes = 0;
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop();
    nodes += 1;
    if (nodes > MAX_MANIFEST_NODES) {
      fail('manifest_too_complex', path, `Manifest exceeds ${MAX_MANIFEST_NODES} values.`);
    }
    if (typeof value === 'string') {
      if (value.length > MAX_MANIFEST_TOTAL_STRING_BYTES) {
        fail('manifest_too_large', path, `Manifest string content exceeds ${MAX_MANIFEST_TOTAL_STRING_BYTES} bytes.`);
      }
      stringBytes += utf8ByteLength(value);
      if (stringBytes > MAX_MANIFEST_TOTAL_STRING_BYTES) {
        fail('manifest_too_large', path, `Manifest string content exceeds ${MAX_MANIFEST_TOTAL_STRING_BYTES} bytes.`);
      }
      continue;
    }
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue;
    if (typeof value === 'function') fail('invalid_type', path, `${path} is not a JSON manifest value.`);
    if (depth > MAX_MANIFEST_DEPTH) {
      const reportedPath = path.startsWith('$.') ? path.slice(2) : path;
      fail('depth_exceeded', reportedPath, `${reportedPath} exceeds the maximum manifest depth of ${MAX_MANIFEST_DEPTH}.`);
    }
    if (seen.has(value)) fail('invalid_json_value', path, `${path} contains a cyclic or aliased object value.`);
    seen.add(value);
    if (utilTypes.isProxy(value)) {
      // Array.isArray performs the ECMAScript IsArray operation, which throws
      // for a revoked Proxy. Normalize every Proxy surface before that native
      // boundary so direct-JavaScript inputs always fail with a bounded
      // RunContractV1Error rather than leaking a raw TypeError.
      let proxyIsArray = false;
      try {
        proxyIsArray = Array.isArray(value);
      } catch {
        fail('invalid_type', path, `${path} must be concrete JSON data, not a revoked Proxy.`);
      }
      fail(proxyIsArray ? 'invalid_array' : 'invalid_type', path,
        `${path} must be concrete JSON data, not a Proxy.`);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_MANIFEST_NODES) {
        fail('manifest_too_complex', path,
          `${path} exceeds ${MAX_MANIFEST_NODES} array elements.`);
      }
      assertDenseJsonArray(value, path);
      for (let i = value.length - 1; i >= 0; i -= 1) {
        stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }
    const entries = assertJsonDataObject(value, path).sort((left, right) => (
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    ));
    let ownEnumerableCount = 0;
    for (const { key } of entries) {
      ownEnumerableCount += 1;
      if (ownEnumerableCount > MAX_MANIFEST_OBJECT_KEYS) {
        fail('manifest_too_complex', path,
          `${path} exceeds ${MAX_MANIFEST_OBJECT_KEYS} object keys.`);
      }
      stringBytes += utf8ByteLength(key);
      if (stringBytes > MAX_MANIFEST_TOTAL_STRING_BYTES) {
        fail('manifest_too_large', path,
          `Manifest string content exceeds ${MAX_MANIFEST_TOTAL_STRING_BYTES} bytes.`);
      }
    }
    // The traversal stack is LIFO. Push reverse-sorted children so invalid
    // equivalent objects always visit the same lowest code-unit key first,
    // independent of caller insertion order.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const { key, value: childValue } = entries[index];
      stack.push({ value: childValue, path: `${path}.${key}`, depth: depth + 1 });
    }
  }
}

function classCodeForKey(key, allowed) {
  if (allowed.has(key)) return null;
  return FORBIDDEN_KEY_CLASSES.get(key) ?? null;
}

// Strict unknown-key rejection for one object depth. Keys are inspected in
// sorted order so the reported offender never depends on input insertion
// order. Forbidden-class keys win over the generic unknown_key code.
export function assertAllowedKeys(object, allowedKeys, path) {
  assertJsonDataObject(object, path);
  const allowed = new Set(allowedKeys);
  for (const key of sortedKeys(object)) {
    if (allowed.has(key)) continue;
    const cls = FORBIDDEN_KEY_CLASSES.get(key);
    if (cls) {
      fail(cls, `${path}.${key}`, `${path}.${key} is forbidden (${cls}); the platform does not accept it in any run manifest.`);
    }
    fail('unknown_key', `${path}.${key}`, `${path}.${key} is not part of the closed ${path} vocabulary.`);
  }
}

// Recursive forbidden-key scan for payloads whose full schema lives in a
// sibling module (assignment subtrees before their schema hook runs).
export function assertNoForbiddenKeysDeep(value, path, depth = 0) {
  if (depth > MAX_MANIFEST_DEPTH) {
    fail('depth_exceeded', path, `${path} exceeds the maximum manifest depth of ${MAX_MANIFEST_DEPTH}.`);
  }
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    if (utilTypes.isProxy(value)) {
      fail('invalid_type', path, `${path} must be concrete JSON data, not a Proxy.`);
    }
  }
  if (Array.isArray(value)) {
    assertDenseJsonArray(value, path);
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenKeysDeep(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  assertJsonDataObject(value, path);
  for (const key of sortedKeys(value)) {
    const cls = FORBIDDEN_KEY_CLASSES.get(key);
    if (cls) fail(cls, `${path}.${key}`, `${path}.${key} is forbidden (${cls}).`);
    assertNoForbiddenKeysDeep(value[key], `${path}.${key}`, depth + 1);
  }
}

// Bounded UTF-8 text: byte-counted (never code-unit counted), well-formed
// (no lone surrogates), free of control characters except \n and \t, and
// not blank.
export function assertBoundedText(value, {
  min, max, path, label, allowBlank = false,
}) {
  if (typeof value !== 'string') fail('invalid_type', path, `${label} must be a string.`);
  if (value.length > max) fail('out_of_range', path, `${label} exceeds the ${max}-byte maximum.`);
  if (!allowBlank && value.trim().length === 0) fail('empty_text', path, `${label} must not be empty or whitespace-only.`);
  const bytes = utf8ByteLength(value);
  if (bytes < min) fail('out_of_range', path, `${label} is ${bytes} bytes; minimum is ${min}.`);
  if (bytes > max) fail('out_of_range', path, `${label} is ${bytes} bytes; maximum is ${max}.`);
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      fail('invalid_format', path, `${label} contains a lone surrogate at byte-boundary-invalid position; prompts must be well-formed UTF-8.`);
    }
    const isControl = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    if (isControl && cp !== 0x0a && cp !== 0x09) {
      fail('invalid_format', path, `${label} contains control character U+${cp.toString(16).padStart(4, '0')}; only \\n and \\t are permitted.`);
    }
  }
}

function assertPattern(value, pattern, code, path, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(code, path, `${label} violates the required grammar ${String(pattern)}.`);
  }
}

export function assertRunId(value, path = 'run_id') {
  assertPattern(value, RUN_ID_PATTERN, 'invalid_format', path,
    `run_id must match ${RUN_ID_PATTERN.source} (lowercase, git-ref-safe, ${RUN_ID_MIN}-${RUN_ID_MAX} chars)`);
}

export function assertBaseSha(value, path) {
  assertPattern(value, SHA40_PATTERN, 'invalid_format', path,
    `${path} must be an exact immutable 40-character lowercase hex commit SHA`);
}

export function assertRepositoryPath(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_type', path, `${path} must be an absolute repository path string.`);
  }
  if (!value.startsWith('/')) fail('invalid_format', path, `${path} must be an absolute path.`);
  if (value.endsWith('/')) fail('invalid_format', path, `${path} must not end with '/'.`);
  if (value.includes('\\')) fail('invalid_format', path, `${path} must use '/' separators.`);
  const segments = value.slice(1).split('/');
  for (const segment of segments) {
    if (segment.length === 0) fail('invalid_format', path, `${path} contains an empty path segment.`);
    if (segment === '.' || segment === '..') fail('invalid_format', path, `${path} contains '.' or '..' segments.`);
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0xd800 && cp <= 0xdfff)
        || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
        || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
        fail('invalid_format', path, `${path} contains a control, bidi-control, or lone-surrogate character.`);
      }
    }
    if (segment.normalize('NFC') !== segment) fail('invalid_format', path, `${path} must use NFC-normalized path segments.`);
  }
  if (utf8ByteLength(value) > 4096) fail('out_of_range', path, `${path} exceeds 4096 bytes.`);
}

// Conservative deterministic scope intersection: the comparable prefix of a
// pattern is its leading segments up to the first glob metacharacter; a
// pattern whose prefix is empty (e.g. leading '**') may match anywhere.
// Prefixes sharing every compared segment are treated as overlapping. The
// check may over-approximate overlap; it never under-approximates it.
export function scopeStaticPrefix(pattern) {
  const prefix = [];
  for (const segment of String(pattern).split('/')) {
    if (/[*?[]/u.test(segment)) break;
    prefix.push(segment.toLowerCase());
  }
  return prefix;
}

export function writerScopesOverlap(patternA, patternB) {
  const a = scopeStaticPrefix(patternA);
  const b = scopeStaticPrefix(patternB);
  if (a.length === 0 || b.length === 0) return true;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function assertDisjointWriterScopes(writerScopes) {
  for (let i = 0; i < writerScopes.length; i += 1) {
    for (let j = i + 1; j < writerScopes.length; j += 1) {
      const left = writerScopes[i];
      const right = writerScopes[j];
      // Valid JSON arrays may intentionally have a null prototype. Walk by
      // index so validation never depends on an inherited iterator.
      for (let leftIndex = 0; leftIndex < left.patterns.length; leftIndex += 1) {
        const patternL = left.patterns[leftIndex];
        for (let rightIndex = 0; rightIndex < right.patterns.length; rightIndex += 1) {
          const patternR = right.patterns[rightIndex];
          if (writerScopesOverlap(patternL, patternR)) {
            fail(
              'overlapping_writer_scope',
              `assignments[${left.index}].write_scope`,
              `Writer scopes of "${left.assignment_id}" ("${patternL}") and "${right.assignment_id}" ("${patternR}") overlap; concurrent writers must own disjoint paths.`,
            );
          }
        }
      }
    }
  }
}

export function assertWriteScopePatterns(value, path, { minPatterns, maxPatterns = SCOPE_MAX_PATTERNS }) {
  assertDenseJsonArray(value, path);
  if (value.length < minPatterns) {
    fail('out_of_range', path, `${path} needs at least ${minPatterns} pattern(s) for a writer lane.`);
  }
  if (value.length > maxPatterns) {
    fail('out_of_range', path, `${path} exceeds ${maxPatterns} patterns.`);
  }
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    const entryPath = `${path}[${i}]`;
    const entry = value[i];
    if (typeof entry !== 'string') fail('invalid_type', entryPath, `${entryPath} must be a string pattern.`);
    if (entry.length === 0 || entry.startsWith('/') || entry.includes('\\') || entry.endsWith('/')) {
      fail('invalid_format', entryPath, `${entryPath} must be a relative repository glob.`);
    }
    const segments = entry.split('/');
    if (segments.length > SCOPE_MAX_SEGMENTS) {
      fail('out_of_range', entryPath, `${entryPath} exceeds ${SCOPE_MAX_SEGMENTS} path segments.`);
    }
    for (const segment of segments) {
      if (segment === '.' || segment === '..') {
        fail('invalid_format', entryPath, `${entryPath} must not contain '.' or '..' path aliases.`);
      }
      if (utf8ByteLength(segment) > SCOPE_SEGMENT_MAX_BYTES) {
        fail('out_of_range', entryPath,
          `${entryPath} contains a segment exceeding ${SCOPE_SEGMENT_MAX_BYTES} bytes.`);
      }
      if (!GLOB_SEGMENT_PATTERN.test(segment)) {
        fail('invalid_format', entryPath, `${entryPath} segment "${segment}" violates the glob grammar ${GLOB_SEGMENT_PATTERN.source}.`);
      }
    }
    if (utf8ByteLength(entry) > SCOPE_PATTERN_MAX_BYTES) {
      fail('out_of_range', entryPath, `${entryPath} exceeds ${SCOPE_PATTERN_MAX_BYTES} bytes.`);
    }
    if (seen.has(entry)) fail('duplicate_scope_pattern', entryPath, `${entryPath} repeats pattern "${entry}".`);
    seen.add(entry);
  }
}

function assertIntegerInRange(value, min, max, code, path, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('invalid_type', path, `${label} must be an integer number of milliseconds.`);
  }
  if (value < min || value > max) {
    fail(code, path, `${label} is ${value}; allowed range is ${min}..${max}.`);
  }
}

export function assertExpectedDurationMs(value, path) {
  assertIntegerInRange(value, MIN_DURATION_MS, MAX_EXPECTED_DURATION_MS, 'out_of_range', path,
    `${path} must be between ${MIN_DURATION_MS} and ${MAX_EXPECTED_DURATION_MS} ms`);
}

export function assertTimeoutMs(value, path) {
  assertIntegerInRange(value, MIN_DURATION_MS, MAX_TIMEOUT_MS, 'out_of_range', path,
    `${path} must be between ${MIN_DURATION_MS} and ${MAX_TIMEOUT_MS} ms`);
}

function extractWriterScopes(assignments) {
  const writerScopes = [];
  for (let i = 0; i < assignments.length; i += 1) {
    const assignment = assignments[i];
    const patterns = assignment?.write_scope;
    let allPatternsAreStrings = Array.isArray(patterns);
    if (allPatternsAreStrings) {
      for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
        if (typeof patterns[patternIndex] !== 'string') {
          allPatternsAreStrings = false;
          break;
        }
      }
    }
    if (allPatternsAreStrings && assignment.access === 'writer') {
      writerScopes.push({ index: i, assignment_id: assignment.assignment_id, patterns });
    }
  }
  return writerScopes;
}

function extractUnresolvedProfileAssignmentIds(assignments) {
  const unresolved = [];
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index];
    if (isPlainObject(assignment.execution)
      && Object.hasOwn(assignment.execution, 'profile')) {
      unresolved.push(assignment.assignment_id);
    }
  }
  return unresolved;
}

function validateReturnContract(returnContract) {
  const path = 'return_contract';
  if (!isPlainObject(returnContract)) fail('invalid_type', path, 'return_contract must be an object.');
  assertAllowedKeys(returnContract, RETURN_CONTRACT_ALLOWED_KEYS, path);
  for (const key of RETURN_CONTRACT_ALLOWED_KEYS) {
    if (!Object.hasOwn(returnContract, key)) fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
  }
  if (returnContract.mode !== 'verified_decision') {
    fail('invalid_format', `${path}.mode`, 'return_contract.mode must be exactly "verified_decision".');
  }
  if (returnContract.include_artifact_refs !== true) {
    fail('invalid_format', `${path}.include_artifact_refs`,
      'return_contract.include_artifact_refs must be explicitly true; evidence stays artifact-addressable.');
  }
}

function validatePolicyEnvelope(policy) {
  const path = 'policy';
  if (!isPlainObject(policy)) fail('invalid_type', path, 'policy must be an object.');
  for (const key of POLICY_ALLOWED_KEYS) {
    if (!Object.hasOwn(policy, key)) {
      fail('missing_key', `${path}.${key}`, `policy.${key} is required; run policies have no hidden defaults.`);
    }
  }
  assertAllowedKeys(policy, POLICY_ALLOWED_KEYS, path);
}

function validateAssignmentsEnvelope(assignments, hooks) {
  const path = 'assignments';
  assertDenseJsonArray(assignments, path);
  if (assignments.length < MIN_ASSIGNMENTS || assignments.length > MAX_ASSIGNMENTS) {
    fail('out_of_range', path, `A run carries between ${MIN_ASSIGNMENTS} and ${MAX_ASSIGNMENTS} assignments; received ${assignments.length}.`);
  }
  const seenIds = new Set();
  for (let i = 0; i < assignments.length; i += 1) {
    const assignmentPath = `${path}[${i}]`;
    const assignment = assignments[i];
    if (!isPlainObject(assignment)) fail('invalid_type', assignmentPath, `${assignmentPath} must be an object.`);
    const idPath = `${assignmentPath}.assignment_id`;
    if (!Object.hasOwn(assignment, 'assignment_id')) {
      fail('missing_key', idPath, `${idPath} is required.`);
    }
    assertPattern(assignment.assignment_id, ASSIGNMENT_ID_PATTERN, 'invalid_format', idPath,
      `assignment_id must match ${ASSIGNMENT_ID_PATTERN.source}`);
    if (seenIds.has(assignment.assignment_id)) {
      fail('duplicate_assignment_id', idPath, `assignment_id "${assignment.assignment_id}" is not unique within the run.`);
    }
    seenIds.add(assignment.assignment_id);
    assertNoForbiddenKeysDeep(assignment, assignmentPath, 1);
    hooks.validateAssignment(assignment, i);
  }
  return seenIds;
}

// Compose the RunManifestV1 envelope with mandatory deep validators. There is
// deliberately no hook-less mode: dispatch-facing callers use the safe
// validateRunManifestV1 alias from run-policy.mjs, while advanced composition
// cannot accidentally skip AssignmentManifestV1 or RunPolicyV1 checks.
export function validateRunManifestEnvelopeV1(manifest, hooks) {
  if (!hooks || typeof hooks.validateAssignment !== 'function'
    || typeof hooks.validatePolicy !== 'function') {
    fail('incomplete_validator', '$', 'RunManifestV1 requires assignment and policy validators; use validateRunManifestV1 from run-policy.mjs.');
  }
  assertManifestComplexity(manifest);
  if (!isPlainObject(manifest)) fail('invalid_type', '$', 'A run manifest must be a JSON object.');
  assertAllowedKeys(manifest, ROOT_ALLOWED_KEYS, '$');
  for (const key of ROOT_ALLOWED_KEYS) {
    if (!Object.hasOwn(manifest, key)) {
      fail('missing_key', `$.${key}`, `$.${key} is required; run manifests have no hidden defaults.`);
    }
  }
  if (manifest.schema !== RUN_MANIFEST_SCHEMA_ID) {
    fail('invalid_format', '$.schema', `schema must be exactly "${RUN_MANIFEST_SCHEMA_ID}".`);
  }
  assertRunId(manifest.run_id);
  const repository = manifest.repository;
  if (!isPlainObject(repository)) fail('invalid_type', 'repository', 'repository must be an object.');
  assertAllowedKeys(repository, REPOSITORY_ALLOWED_KEYS, 'repository');
  for (const key of REPOSITORY_ALLOWED_KEYS) {
    if (!Object.hasOwn(repository, key)) fail('missing_key', `repository.${key}`, `repository.${key} is required.`);
  }
  assertRepositoryPath(repository.path, 'repository.path');
  assertBaseSha(repository.base_sha, 'repository.base_sha');
  assertBoundedText(manifest.objective, {
    min: OBJECTIVE_MIN_BYTES, max: OBJECTIVE_MAX_BYTES, path: 'objective', label: 'objective',
  });
  validateReturnContract(manifest.return_contract);
  validatePolicyEnvelope(manifest.policy);
  hooks.validatePolicy(manifest.policy);
  const assignmentIds = validateAssignmentsEnvelope(manifest.assignments, hooks);
  assertDisjointWriterScopes(extractWriterScopes(manifest.assignments));
  const unresolvedProfileAssignmentIds = extractUnresolvedProfileAssignmentIds(manifest.assignments);
  return Object.freeze({
    run_id: manifest.run_id,
    assignment_count: manifest.assignments.length,
    assignment_ids: Object.freeze([...assignmentIds]),
    validation_depth: 'complete',
    profile_resolution_required: unresolvedProfileAssignmentIds.length > 0,
    unresolved_profile_assignment_ids: Object.freeze(unresolvedProfileAssignmentIds),
  });
}
