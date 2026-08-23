// VerificationPolicyV1 — versioned immutable trusted verification-policy
// schema plus the bounded owner-authored policy loader (ADR 0001 identifiers
// `verification_policy_v1_only_executable_catalog`,
// `codex_selects_approved_command_ids_only`,
// `manifests_carry_command_ids_not_argv`,
// `trusted_verification_policy_command_catalog`,
// `profiles_data_only`,
// `provider_commands_evidence_never_auto_executed`,
// `read_only_verification`,
// `gate_a_constrained_trusted_policy_command_execution`).
//
// Additive v3 module for W14-P16A. It owns one fail-closed question: is this
// a trusted owner-authored VerificationPolicyV1, or a command-id plus typed
// parameters selection that untrusted profiles/manifests/provider reports
// are allowed to name? It answers nothing else. This module never invokes a shell,
// never resolves PATH, never executes a command, never opens a network
// socket, never mutates a candidate, and does not implement the P16B
// approved-command resolver or the P16C runner.
//
// Owner policy binds each stable command ID to an absolute executable path,
// a fixed argv template, typed/bounded parameter domains, and explicit
// network, environment, mutation, timeout, and output policies. Absent
// capabilities materialize as exact default-deny receipts: no network, empty
// environment, no persistent mutation, and finite time/output caps. Identity
// is the validator-owned canonical snapshot, so omitting a capability and
// writing the deny receipt produce the same digest.
//
// Untrusted inputs may carry only `command_id` and typed parameters. Any
// executable path, argv fragment/template, shell text, environment name or
// value, network target, mutation permission, or resource limit is denied
// before values are interpreted. Failures are typed and content-free: they
// never echo attacker values, keys, paths, URLs, secrets, native messages,
// or stacks as diagnostics.
//
// Parsed results are fresh-owned, deeply frozen, detached snapshots.
// Callers' objects are neither mutated nor frozen.

import { Buffer as NodeBuffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, open } from 'node:fs/promises';

import {
  capturedCreate,
  capturedDescriptor,
  capturedFreeze,
  capturedGetPrototypeOf,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedTest,
  capturedUtf8ByteLength,
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
  COMMAND_ID_MAX,
  MAX_TIMEOUT_MS,
  MIN_DURATION_MS,
  PARAMS_MAX_KEYS,
  PARAM_VALUE_MAX_BYTES,
  RunContractV1Error,
  isCommandId,
  isParamKey,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  hasOwn,
  optOwn,
} from './selection-json.mjs';

export const VERIFICATION_POLICY_SCHEMA_ID = 'codex-co-engineer.verification-policy.v1';
export const VERIFICATION_POLICY_VERSION = 1;
export const VERIFICATION_POLICY_DIGEST_LABEL = IDENTITY_LABELS.VERIFICATION_POLICY;
export const VERIFICATION_COMMAND_DIGEST_LABEL = IDENTITY_LABELS.VERIFICATION_COMMAND_DESCRIPTOR;
export const DIGEST_ALGORITHM = 'sha256';
export const POLICY_DIGEST_HEX_LENGTH = 64;

export const OWNER_POLICY_DIRNAME = 'codex-co-engineer';
export const OWNER_POLICY_FILENAME = 'verification-policy.json';

export const MAX_POLICY_BYTES = 64 * 1024;
export const MAX_POLICY_DEPTH = 16;
export const MAX_POLICY_NODES = 1024;
export const MAX_POLICY_OBJECT_KEYS = 64;
export const MAX_POLICY_TOTAL_STRING_BYTES = 32_768;
export const MAX_POLICY_CANONICAL_BYTES = 65_536;
export const MAX_COMMANDS = 32;
export const MAX_ARGV_TOKENS = 32;
export const MAX_PARAMETERS = PARAMS_MAX_KEYS;
export const MAX_ENV_ENTRIES = 16;
export const MAX_NETWORK_HOSTS = 8;
export const MAX_ENUM_VALUES = 16;
export const MAX_EXECUTABLE_BYTES = 4096;
export const MAX_EXECUTABLE_SEGMENTS = 32;
export const MAX_ARGV_TOKEN_BYTES = 256;
export const MAX_ENV_NAME_BYTES = 64;
export const MAX_ENV_VALUE_BYTES = PARAM_VALUE_MAX_BYTES;
export const MAX_HOST_BYTES = 253;
export const MAX_PARAM_STRING_BYTES = PARAM_VALUE_MAX_BYTES;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_OUTPUT_BYTES = 65_536;
export const DEFAULT_ERROR_BYTES = 65_536;
export const MAX_OUTPUT_BYTES = 1_048_576;
export const MAX_ERROR_BYTES = 1_048_576;

export const NETWORK_MODES = capturedFreeze(['allowlist', 'deny']);
export const MUTATION_WORKSPACES = capturedFreeze(['ephemeral', 'none']);
export const PARAMETER_TYPES = capturedFreeze([
  'boolean', 'enum', 'integer', 'path_segment', 'string',
]);

export const POLICY_ALLOWED_KEYS = capturedFreeze(['schema', 'version', 'commands']);
export const POLICY_REQUIRED_KEYS = POLICY_ALLOWED_KEYS;
export const COMMAND_ALLOWED_KEYS = capturedFreeze([
  'argv_template', 'command_id', 'environment', 'executable', 'mutation',
  'network', 'parameters', 'resources', 'timeout_ms',
]);
export const COMMAND_REQUIRED_KEYS = capturedFreeze([
  'argv_template', 'command_id', 'executable',
]);
export const COMMAND_RECEIPT_KEYS = capturedFreeze([
  'argv_template', 'command_id', 'environment', 'executable', 'mutation',
  'network', 'parameters', 'resources', 'timeout_ms',
]);
export const UNTRUSTED_COMMAND_ALLOWED_KEYS = capturedFreeze(['command_id', 'parameters']);
export const NETWORK_ALLOWED_KEYS = capturedFreeze(['hosts', 'mode']);
export const ENVIRONMENT_ALLOWED_KEYS = capturedFreeze(['entries']);
export const ENV_ENTRY_ALLOWED_KEYS = capturedFreeze(['name', 'value']);
export const MUTATION_ALLOWED_KEYS = capturedFreeze(['persistent', 'workspace']);
export const RESOURCES_ALLOWED_KEYS = capturedFreeze(['max_error_bytes', 'max_output_bytes']);
export const STRING_DOMAIN_KEYS = capturedFreeze(['max_bytes', 'type']);
export const INTEGER_DOMAIN_KEYS = capturedFreeze(['max', 'min', 'type']);
export const BOOLEAN_DOMAIN_KEYS = capturedFreeze(['type']);
export const ENUM_DOMAIN_KEYS = capturedFreeze(['type', 'values']);
export const PATH_SEGMENT_DOMAIN_KEYS = capturedFreeze(['max_bytes', 'type']);
export const LOADER_OPTION_KEYS = capturedFreeze(['env', 'ownerConfigDir']);
export const LOADER_ENV_KEYS = capturedFreeze(['HOME', 'XDG_CONFIG_HOME']);

export const DENIED_ENV_NAMES = capturedFreeze([
  'BASH_ENV', 'CDPATH', 'ENV', 'GCONV_PATH', 'HOSTALIASES', 'IFS',
  'LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'LOCALDOMAIN', 'NODE_OPTIONS',
  'NODE_PATH', 'PATH', 'PERL5LIB', 'PYTHONPATH', 'SSLKEYLOGFILE',
  'SHELLOPTS', 'TERMINFO', 'TERMPATH',
]);

export const VERIFICATION_POLICY_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'ambiguous_id_denied',
  'control_character_denied', 'duplicate_id', 'duplicate_parameter',
  'env_name_denied', 'executable_content_denied', 'exotic_prototype_denied',
  'invalid_array', 'invalid_encoding', 'invalid_format', 'invalid_json_type',
  'invalid_json_value', 'invalid_type', 'missing_key',
  'mutation_permission_denied', 'network_content_denied',
  'non_enumerable_property_denied', 'own_undefined_denied', 'out_of_range',
  'placeholder_unbound', 'policy_catalog_changed_during_read',
  'policy_catalog_not_owner_controlled', 'policy_catalog_not_regular',
  'policy_catalog_too_large', 'policy_catalog_unreadable',
  'policy_options_denied', 'proxy_denied', 'resource_limit_denied',
  'shell_content_denied', 'symbol_key_denied', 'unknown_key',
  'value_depth_exceeded',
]);

const PRIVATE_COMMAND_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const PRIVATE_PARAM_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const PRIVATE_PLACEHOLDER_PATTERN = /^\{[a-z][a-z0-9_-]{0,31}\}$/u;
const PRIVATE_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/u;
const PRIVATE_HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PRIVATE_SEGMENT_PATTERN = /^[A-Za-z0-9._+-]+$/u;
const PRIVATE_LITERAL_PATTERN = /^[A-Za-z0-9._+/=:,@%-]+$/u;
const PRIVATE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._+-]+$/u;
const PRIVATE_ENUM_VALUE_PATTERN = /^[A-Za-z0-9._+-]+$/u;

export const COMMAND_ID_PATTERN = new RegExp(
  PRIVATE_COMMAND_ID_PATTERN.source, PRIVATE_COMMAND_ID_PATTERN.flags,
);
export const PLACEHOLDER_PATTERN = new RegExp(
  PRIVATE_PLACEHOLDER_PATTERN.source, PRIVATE_PLACEHOLDER_PATTERN.flags,
);

const MESSAGES = capturedFreeze(Object.assign(capturedCreate(null), {
  accessor_property_denied: 'An accessor property was denied; getters are never invoked.',
  aliased_reference_denied: 'Aliased or cyclic references are denied.',
  ambiguous_id_denied: 'Ambiguous Unicode, compatibility, or confusable identity text is denied.',
  control_character_denied: 'Control, invisible, or bidi characters are denied.',
  duplicate_id: 'A duplicate identity was denied instead of collapsed.',
  duplicate_parameter: 'A duplicate parameter or placeholder binding was denied.',
  env_name_denied: 'An environment name is outside the closed allowlist.',
  executable_content_denied: 'Untrusted input must not contribute executable content.',
  exotic_prototype_denied: 'Exotic prototypes are denied.',
  invalid_array: 'Arrays must be dense JSON arrays without extended metadata.',
  invalid_encoding: 'Text must be well-formed NFC/NFKC Unicode.',
  invalid_format: 'A field violates the closed grammar.',
  invalid_json_type: 'A non-JSON value was denied.',
  invalid_json_value: 'A non-canonical JSON number or value was denied.',
  invalid_type: 'A field has the wrong JSON type.',
  missing_key: 'A required field is missing; trusted policy has no hidden grants.',
  mutation_permission_denied: 'Untrusted input must not contribute mutation permissions.',
  network_content_denied: 'Untrusted input must not contribute network targets.',
  non_enumerable_property_denied: 'Non-enumerable properties are denied.',
  own_undefined_denied: 'Own undefined values are denied; omit the field instead.',
  out_of_range: 'A bounded integer, count, or size was exceeded.',
  placeholder_unbound: 'An argv placeholder is not bound to a declared parameter.',
  policy_catalog_changed_during_read: 'The owner policy catalog changed while it was read.',
  policy_catalog_not_owner_controlled: 'The owner policy catalog must be owner-controlled.',
  policy_catalog_not_regular: 'The owner policy catalog must be a regular non-symlink file.',
  policy_catalog_too_large: 'The owner policy catalog exceeds the bounded size.',
  policy_catalog_unreadable: 'The owner policy catalog could not be read safely.',
  policy_options_denied: 'Loader options must be a closed direct-JSON object.',
  proxy_denied: 'Live and revoked Proxies are denied.',
  resource_limit_denied: 'Untrusted input must not contribute resource limits.',
  shell_content_denied: 'Shell text, interpolation, or metacharacters are denied.',
  symbol_key_denied: 'Symbol keys are denied.',
  unknown_key: 'A key is outside the closed vocabulary.',
  value_depth_exceeded: 'Nesting exceeds the bounded policy depth.',
}));

const INVISIBLE_RANGES = capturedFreeze([
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
]);
const SEPARATOR_LOOKALIKES = capturedFreeze([
  0x2044, 0x2215, 0x27cb, 0x27cd, 0x29f8, 0xfe68, 0xff0f, 0xff3c,
]);
const CONFUSABLE_HYPHENS = capturedFreeze([
  0x00ad, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d,
]);

const EXECUTABLE_FOLDS = capturedFreeze([
  'args', 'argument', 'arguments', 'argv', 'argvtemplate', 'bin', 'binary',
  'cmd', 'cmdline', 'command', 'commandcatalog', 'commands', 'cwd',
  'entrypoint', 'exec', 'executable', 'interpreter', 'run', 'runner',
  'runnercommand', 'script', 'scripts', 'shell', 'shellcommand', 'template',
  'templates', 'verificationcommand', 'verificationpolicy',
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

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_IS = Object.is;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_IS_FINITE = Number.isFinite;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt);
const STRING_CODE_POINT_AT = Function.prototype.call.bind(String.prototype.codePointAt);
const STRING_NORMALIZE = Function.prototype.call.bind(String.prototype.normalize);
const STRING_SLICE = Function.prototype.call.bind(String.prototype.slice);
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith);
const STRING_ENDS_WITH = Function.prototype.call.bind(String.prototype.endsWith);
const STRING_SPLIT = Function.prototype.call.bind(String.prototype.split);
const STRING_TO_LOWER_CASE = Function.prototype.call.bind(String.prototype.toLowerCase);
const STRING_REPLACE = Function.prototype.call.bind(String.prototype.replace);
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort);
const ARRAY_PROTOTYPE = Array.prototype;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const JSON_PARSE = JSON.parse;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const TEXT_DECODER = TextDecoder;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const PATH_JOIN = path.join;
const PATH_RESOLVE = path.resolve;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const OS_HOMEDIR = homedir;
const FS_OPEN = open;
const FS_LSTAT = lstat;

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

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function foldKey(key) {
  return STRING_REPLACE(STRING_TO_LOWER_CASE(STRING(key)), /[-_ ]+/gu, '');
}

function inRangeList(ranges, codePoint) {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (codePoint >= range[0] && codePoint <= range[1]) return true;
  }
  return false;
}

function includesCode(list, codePoint) {
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === codePoint) return true;
  }
  return false;
}

function assertSafeText(value, path) {
  if (typeof value !== 'string') deny('invalid_type', path);
  let index = 0;
  while (index < value.length) {
    const codePoint = STRING_CODE_POINT_AT(value, index);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) deny('invalid_encoding', path);
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      deny('control_character_denied', path);
    }
    if (inRangeList(INVISIBLE_RANGES, codePoint)) deny('control_character_denied', path);
    if (includesCode(SEPARATOR_LOOKALIKES, codePoint)) deny('ambiguous_id_denied', path);
    if (includesCode(CONFUSABLE_HYPHENS, codePoint)) deny('ambiguous_id_denied', path);
    if (codePoint > 0x7e) deny('ambiguous_id_denied', path);
    index += codePoint > 0xffff ? 2 : 1;
  }
  let nfc;
  let nfkc;
  try {
    nfc = STRING_NORMALIZE(value, 'NFC');
    nfkc = STRING_NORMALIZE(value, 'NFKC');
  } catch {
    deny('invalid_encoding', path);
  }
  if (nfc !== value || nfkc !== value) deny('ambiguous_id_denied', path);
  return value;
}

function assertBoundedString(value, path, maxBytes) {
  assertSafeText(value, path);
  const bytes = capturedUtf8ByteLength(value);
  if (bytes < 1 || bytes > maxBytes) deny('out_of_range', path);
  return value;
}

function assertCommandId(value, path) {
  assertSafeText(value, path);
  if (!isCommandId(value) || capturedUtf8ByteLength(value) > COMMAND_ID_MAX
    || !capturedTest(PRIVATE_COMMAND_ID_PATTERN, value)) {
    deny('invalid_format', path);
  }
  return value;
}

function assertParamName(value, path) {
  assertSafeText(value, path);
  if (!isParamKey(value) || !capturedTest(PRIVATE_PARAM_KEY_PATTERN, value)) {
    deny('invalid_format', path);
  }
  return value;
}

function assertSafeInteger(value, path, min, max) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value) || !NUMBER_IS_FINITE(value)
    || OBJECT_IS(value, -0)) {
    deny('invalid_type', path);
  }
  if (value < min || value > max) deny('out_of_range', path);
  return value;
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

function classifyUntrustedKey(key) {
  if (key === 'command_id' || key === 'parameters') return null;
  const folded = foldKey(key);
  if (folded === 'commandid' || folded === 'parameters') return 'unknown_key';
  if (capturedIncludes(EXECUTABLE_FOLDS, folded)) return 'executable_content_denied';
  if (capturedIncludes(ENVIRONMENT_FOLDS, folded)) return 'executable_content_denied';
  if (capturedIncludes(NETWORK_FOLDS, folded)) return 'network_content_denied';
  if (capturedIncludes(MUTATION_FOLDS, folded)) return 'mutation_permission_denied';
  if (capturedIncludes(RESOURCE_FOLDS, folded)) return 'resource_limit_denied';
  return 'unknown_key';
}

function assertExactKeys(value, allowed, required, path) {
  const allowedSet = new SET_CTOR(allowed);
  const keys = ownKeysOrDeny(value, path);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (!SET_HAS.call(allowedSet, key)) deny('unknown_key', path);
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!hasOwn(value, required[index])) deny('missing_key', `${path}.${required[index]}`);
  }
  if (keys.length > MAX_POLICY_OBJECT_KEYS) deny('out_of_range', path);
}

function assertDenseArray(value, path, maxLength) {
  assertNotProxy(value, path);
  if (!capturedIsArray(value)) deny('invalid_type', path);
  let prototype;
  try {
    prototype = capturedGetPrototypeOf(value);
  } catch {
    deny('exotic_prototype_denied', path);
  }
  if (prototype !== ARRAY_PROTOTYPE && prototype !== null) deny('exotic_prototype_denied', path);
  const lengthDescriptor = capturedDescriptor(value, 'length');
  if (!lengthDescriptor || lengthDescriptor.enumerable
    || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined
    || typeof lengthDescriptor.value !== 'number'
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    deny('invalid_array', `${path}.length`);
  }
  const length = lengthDescriptor.value;
  if (length > maxLength) deny('out_of_range', path);
  const keys = ownKeysOrDeny(value, path);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (key === 'length') continue;
    const numeric = Number(key);
    if (!NUMBER_IS_SAFE_INTEGER(numeric) || STRING(numeric) !== key || numeric < 0 || numeric >= length) {
      deny('invalid_array', path);
    }
  }
  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(value, STRING(index))) deny('invalid_array', `${path}[${index}]`);
  }
  return length;
}

function assertPolicyBounds(value, path) {
  let nodes = 0;
  let stringBytes = 0;
  const walk = (node, depth, nodePath) => {
    nodes += 1;
    if (nodes > MAX_POLICY_NODES) deny('out_of_range', nodePath);
    if (depth > MAX_POLICY_DEPTH) deny('value_depth_exceeded', nodePath);
    if (typeof node === 'string') {
      stringBytes += BUFFER_BYTE_LENGTH(node, 'utf8');
      if (stringBytes > MAX_POLICY_TOTAL_STRING_BYTES) deny('out_of_range', nodePath);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (capturedIsArray(node)) {
      if (node.length > MAX_POLICY_OBJECT_KEYS && nodePath !== `${path}.commands`) {
        if (node.length > MAX_ARGV_TOKENS && node.length > MAX_COMMANDS) deny('out_of_range', nodePath);
      }
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], depth + 1, `${nodePath}[${index}]`);
      }
      return;
    }
    const keys = sortedCapturedKeys(node);
    if (keys.length > MAX_POLICY_OBJECT_KEYS) deny('out_of_range', nodePath);
    for (let index = 0; index < keys.length; index += 1) {
      walk(node[keys[index]], depth + 1, `${nodePath}.${keys[index]}`);
    }
  };
  walk(value, 0, path);
}

function isDotOnly(segment) {
  if (segment.length === 0) return false;
  for (let index = 0; index < segment.length; index += 1) {
    if (STRING_CHAR_CODE_AT(segment, index) !== 0x2e) return false;
  }
  return true;
}

function assertExecutablePath(value, path) {
  assertBoundedString(value, path, MAX_EXECUTABLE_BYTES);
  if (!STRING_STARTS_WITH(value, '/')) deny('invalid_format', path);
  if (STRING_ENDS_WITH(value, '/')) deny('invalid_format', path);
  for (let index = 0; index < value.length; index += 1) {
    const unit = STRING_CHAR_CODE_AT(value, index);
    if (unit === 0x5c || unit === 0x3a) deny('invalid_format', path);
  }
  const segments = STRING_SPLIT(value, '/');
  if (segments.length < 2 || segments.length > MAX_EXECUTABLE_SEGMENTS) deny('out_of_range', path);
  if (segments[0] !== '') deny('invalid_format', path);
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0 || isDotOnly(segment) || !capturedTest(PRIVATE_SEGMENT_PATTERN, segment)) {
      deny('invalid_format', path);
    }
  }
  return value;
}

function parseParameterDomain(input, path) {
  assertPlainObject(input, 'invalid_type', path, path);
  if (!hasOwn(input, 'type')) deny('missing_key', `${path}.type`);
  const type = optOwn(input, 'type');
  if (!capturedIncludes(PARAMETER_TYPES, type)) deny('invalid_format', `${path}.type`);
  if (type === 'string') {
    assertExactKeys(input, STRING_DOMAIN_KEYS, STRING_DOMAIN_KEYS, path);
    return freezeRecord(STRING_DOMAIN_KEYS, {
      type,
      max_bytes: assertSafeInteger(optOwn(input, 'max_bytes'), `${path}.max_bytes`, 1, MAX_PARAM_STRING_BYTES),
    });
  }
  if (type === 'path_segment') {
    assertExactKeys(input, PATH_SEGMENT_DOMAIN_KEYS, PATH_SEGMENT_DOMAIN_KEYS, path);
    return freezeRecord(PATH_SEGMENT_DOMAIN_KEYS, {
      type,
      max_bytes: assertSafeInteger(optOwn(input, 'max_bytes'), `${path}.max_bytes`, 1, 128),
    });
  }
  if (type === 'integer') {
    assertExactKeys(input, INTEGER_DOMAIN_KEYS, INTEGER_DOMAIN_KEYS, path);
    const min = assertSafeInteger(optOwn(input, 'min'), `${path}.min`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const max = assertSafeInteger(optOwn(input, 'max'), `${path}.max`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (min > max) deny('out_of_range', path);
    return freezeRecord(INTEGER_DOMAIN_KEYS, { type, min, max });
  }
  if (type === 'boolean') {
    assertExactKeys(input, BOOLEAN_DOMAIN_KEYS, BOOLEAN_DOMAIN_KEYS, path);
    return freezeRecord(BOOLEAN_DOMAIN_KEYS, { type });
  }
  assertExactKeys(input, ENUM_DOMAIN_KEYS, ENUM_DOMAIN_KEYS, path);
  const valuesInput = optOwn(input, 'values');
  const length = assertDenseArray(valuesInput, `${path}.values`, MAX_ENUM_VALUES);
  if (length < 1) deny('out_of_range', `${path}.values`);
  const seen = new SET_CTOR();
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}.values[${index}]`;
    const value = optOwn(valuesInput, STRING(index));
    assertBoundedString(value, entryPath, MAX_PARAM_STRING_BYTES);
    if (!capturedTest(PRIVATE_ENUM_VALUE_PATTERN, value)) deny('invalid_format', entryPath);
    if (SET_HAS.call(seen, value)) deny('duplicate_id', entryPath);
    SET_ADD.call(seen, value);
    ARRAY_PUSH.call(values, value);
  }
  ARRAY_SORT(values, compareText);
  return freezeRecord(ENUM_DOMAIN_KEYS, { type, values: freezeList(values) });
}

function parseParameters(input, path) {
  if (input === undefined) return freezeRecord([], {});
  assertPlainObject(input, 'invalid_type', path, path);
  const keys = sortedCapturedKeys(input);
  if (keys.length > MAX_PARAMETERS) deny('out_of_range', path);
  const seen = new SET_CTOR();
  const values = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    assertParamName(key, `${path}.${key}`);
    if (SET_HAS.call(seen, key)) deny('duplicate_parameter', path);
    SET_ADD.call(seen, key);
    values[key] = parseParameterDomain(optOwn(input, key), `${path}.${key}`);
  }
  return freezeRecord(keys, values);
}

function parseArgvTemplate(input, parameters, path) {
  const length = assertDenseArray(input, path, MAX_ARGV_TOKENS);
  if (length < 1) deny('out_of_range', path);
  const tokens = [];
  const used = new SET_CTOR();
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const token = optOwn(input, STRING(index));
    assertBoundedString(token, entryPath, MAX_ARGV_TOKEN_BYTES);
    if (capturedTest(PRIVATE_PLACEHOLDER_PATTERN, token)) {
      const name = STRING_SLICE(token, 1, token.length - 1);
      if (!capturedHasOwn(parameters, name)) deny('placeholder_unbound', entryPath);
      if (SET_HAS.call(used, name)) deny('duplicate_parameter', entryPath);
      SET_ADD.call(used, name);
      ARRAY_PUSH.call(tokens, token);
      continue;
    }
    if (!capturedTest(PRIVATE_LITERAL_PATTERN, token)) deny('shell_content_denied', entryPath);
    ARRAY_PUSH.call(tokens, token);
  }
  return freezeList(tokens);
}

function parseNetwork(input, path) {
  if (input === undefined) {
    return freezeRecord(NETWORK_ALLOWED_KEYS, { mode: 'deny', hosts: freezeList([]) });
  }
  assertPlainObject(input, 'invalid_type', path, path);
  if (!hasOwn(input, 'mode')) deny('missing_key', `${path}.mode`);
  const mode = optOwn(input, 'mode');
  if (!capturedIncludes(NETWORK_MODES, mode)) deny('invalid_format', `${path}.mode`);
  if (mode === 'deny') {
    assertExactKeys(input, capturedFreeze(['mode']), capturedFreeze(['mode']), path);
    return freezeRecord(NETWORK_ALLOWED_KEYS, { mode: 'deny', hosts: freezeList([]) });
  }
  assertExactKeys(input, NETWORK_ALLOWED_KEYS, NETWORK_ALLOWED_KEYS, path);
  const hostsInput = optOwn(input, 'hosts');
  const length = assertDenseArray(hostsInput, `${path}.hosts`, MAX_NETWORK_HOSTS);
  if (length < 1) deny('out_of_range', `${path}.hosts`);
  const seen = new SET_CTOR();
  const hosts = [];
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}.hosts[${index}]`;
    const host = optOwn(hostsInput, STRING(index));
    assertBoundedString(host, entryPath, MAX_HOST_BYTES);
    if (!capturedTest(PRIVATE_HOST_PATTERN, host)) deny('invalid_format', entryPath);
    if (SET_HAS.call(seen, host)) deny('duplicate_id', entryPath);
    SET_ADD.call(seen, host);
    ARRAY_PUSH.call(hosts, host);
  }
  ARRAY_SORT(hosts, compareText);
  return freezeRecord(NETWORK_ALLOWED_KEYS, { mode: 'allowlist', hosts: freezeList(hosts) });
}

function parseEnvironment(input, path) {
  if (input === undefined) {
    return freezeRecord(ENVIRONMENT_ALLOWED_KEYS, { entries: freezeList([]) });
  }
  assertPlainObject(input, 'invalid_type', path, path);
  assertExactKeys(input, ENVIRONMENT_ALLOWED_KEYS, capturedFreeze([]), path);
  if (!hasOwn(input, 'entries')) {
    return freezeRecord(ENVIRONMENT_ALLOWED_KEYS, { entries: freezeList([]) });
  }
  const entriesInput = optOwn(input, 'entries');
  const length = assertDenseArray(entriesInput, `${path}.entries`, MAX_ENV_ENTRIES);
  const seen = new SET_CTOR();
  const entries = [];
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}.entries[${index}]`;
    const entry = optOwn(entriesInput, STRING(index));
    assertPlainObject(entry, 'invalid_type', entryPath, entryPath);
    assertExactKeys(entry, ENV_ENTRY_ALLOWED_KEYS, ENV_ENTRY_ALLOWED_KEYS, entryPath);
    const name = optOwn(entry, 'name');
    assertBoundedString(name, `${entryPath}.name`, MAX_ENV_NAME_BYTES);
    if (!capturedTest(PRIVATE_ENV_NAME_PATTERN, name) || capturedIncludes(DENIED_ENV_NAMES, name)) {
      deny('env_name_denied', `${entryPath}.name`);
    }
    if (SET_HAS.call(seen, name)) deny('duplicate_id', `${entryPath}.name`);
    SET_ADD.call(seen, name);
    const value = optOwn(entry, 'value');
    assertBoundedString(value, `${entryPath}.value`, MAX_ENV_VALUE_BYTES);
    if (!capturedTest(PRIVATE_LITERAL_PATTERN, value)) deny('shell_content_denied', `${entryPath}.value`);
    ARRAY_PUSH.call(entries, freezeRecord(ENV_ENTRY_ALLOWED_KEYS, { name, value }));
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  return freezeRecord(ENVIRONMENT_ALLOWED_KEYS, { entries: freezeList(entries) });
}

function parseMutation(input, path) {
  if (input === undefined) {
    return freezeRecord(MUTATION_ALLOWED_KEYS, { persistent: false, workspace: 'none' });
  }
  assertPlainObject(input, 'invalid_type', path, path);
  assertExactKeys(input, MUTATION_ALLOWED_KEYS, capturedFreeze(['persistent']), path);
  const persistent = optOwn(input, 'persistent');
  if (persistent !== true && persistent !== false) deny('invalid_type', `${path}.persistent`);
  let workspace = 'none';
  if (hasOwn(input, 'workspace')) {
    workspace = optOwn(input, 'workspace');
    if (!capturedIncludes(MUTATION_WORKSPACES, workspace)) deny('invalid_format', `${path}.workspace`);
  }
  if (persistent === true && workspace === 'none') deny('invalid_format', `${path}.workspace`);
  return freezeRecord(MUTATION_ALLOWED_KEYS, { persistent, workspace });
}

function parseResources(input, path) {
  if (input === undefined) {
    return freezeRecord(RESOURCES_ALLOWED_KEYS, {
      max_output_bytes: DEFAULT_OUTPUT_BYTES,
      max_error_bytes: DEFAULT_ERROR_BYTES,
    });
  }
  assertPlainObject(input, 'invalid_type', path, path);
  assertExactKeys(input, RESOURCES_ALLOWED_KEYS, capturedFreeze([]), path);
  const maxOutput = hasOwn(input, 'max_output_bytes')
    ? assertSafeInteger(optOwn(input, 'max_output_bytes'), `${path}.max_output_bytes`, 1, MAX_OUTPUT_BYTES)
    : DEFAULT_OUTPUT_BYTES;
  const maxError = hasOwn(input, 'max_error_bytes')
    ? assertSafeInteger(optOwn(input, 'max_error_bytes'), `${path}.max_error_bytes`, 1, MAX_ERROR_BYTES)
    : DEFAULT_ERROR_BYTES;
  return freezeRecord(RESOURCES_ALLOWED_KEYS, {
    max_output_bytes: maxOutput,
    max_error_bytes: maxError,
  });
}

function parseTimeout(input, path) {
  if (input === undefined) return DEFAULT_TIMEOUT_MS;
  return assertSafeInteger(input, path, MIN_DURATION_MS, MAX_TIMEOUT_MS);
}

export const DEFAULT_NETWORK_RECEIPT = parseNetwork(undefined, 'network');
export const DEFAULT_ENVIRONMENT_RECEIPT = parseEnvironment(undefined, 'environment');
export const DEFAULT_MUTATION_RECEIPT = parseMutation(undefined, 'mutation');
export const DEFAULT_RESOURCES_RECEIPT = parseResources(undefined, 'resources');

function parseCommand(input, path) {
  assertPlainObject(input, 'invalid_type', path, path);
  assertExactKeys(input, COMMAND_ALLOWED_KEYS, COMMAND_REQUIRED_KEYS, path);
  const commandId = assertCommandId(optOwn(input, 'command_id'), `${path}.command_id`);
  const executable = assertExecutablePath(optOwn(input, 'executable'), `${path}.executable`);
  const parameters = parseParameters(
    hasOwn(input, 'parameters') ? optOwn(input, 'parameters') : undefined,
    `${path}.parameters`,
  );
  const argvTemplate = parseArgvTemplate(optOwn(input, 'argv_template'), parameters, `${path}.argv_template`);
  return freezeRecord(COMMAND_RECEIPT_KEYS, {
    command_id: commandId,
    executable,
    argv_template: argvTemplate,
    parameters,
    network: parseNetwork(hasOwn(input, 'network') ? optOwn(input, 'network') : undefined, `${path}.network`),
    environment: parseEnvironment(
      hasOwn(input, 'environment') ? optOwn(input, 'environment') : undefined,
      `${path}.environment`,
    ),
    mutation: parseMutation(hasOwn(input, 'mutation') ? optOwn(input, 'mutation') : undefined, `${path}.mutation`),
    timeout_ms: parseTimeout(hasOwn(input, 'timeout_ms') ? optOwn(input, 'timeout_ms') : undefined, `${path}.timeout_ms`),
    resources: parseResources(hasOwn(input, 'resources') ? optOwn(input, 'resources') : undefined, `${path}.resources`),
  });
}

export function parseVerificationCommandDescriptorV1(input, path = 'command') {
  assertPlainObject(input, 'invalid_type', path, path);
  assertDirectJsonClosure(input, path);
  assertPolicyBounds(input, path);
  return parseCommand(input, path);
}

function emptyPolicy() {
  return freezeRecord(POLICY_ALLOWED_KEYS, {
    schema: VERIFICATION_POLICY_SCHEMA_ID,
    version: VERIFICATION_POLICY_VERSION,
    commands: freezeList([]),
  });
}

export function parseVerificationPolicyV1(input, path = 'policy') {
  assertPlainObject(input, 'invalid_type', path, path);
  assertDirectJsonClosure(input, path);
  assertPolicyBounds(input, path);
  assertExactKeys(input, POLICY_ALLOWED_KEYS, POLICY_REQUIRED_KEYS, path);
  const schema = optOwn(input, 'schema');
  if (schema !== VERIFICATION_POLICY_SCHEMA_ID) deny('invalid_format', `${path}.schema`);
  const version = optOwn(input, 'version');
  if (version !== VERIFICATION_POLICY_VERSION) deny('invalid_format', `${path}.version`);
  const commandsInput = optOwn(input, 'commands');
  const length = assertDenseArray(commandsInput, `${path}.commands`, MAX_COMMANDS);
  const seen = new SET_CTOR();
  const commands = [];
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}.commands[${index}]`;
    const snapshot = parseCommand(optOwn(commandsInput, STRING(index)), entryPath);
    if (SET_HAS.call(seen, snapshot.command_id)) deny('duplicate_id', `${entryPath}.command_id`);
    SET_ADD.call(seen, snapshot.command_id);
    ARRAY_PUSH.call(commands, snapshot);
  }
  commands.sort((left, right) => compareText(left.command_id, right.command_id));
  const snapshot = freezeRecord(POLICY_ALLOWED_KEYS, {
    schema: VERIFICATION_POLICY_SCHEMA_ID,
    version: VERIFICATION_POLICY_VERSION,
    commands: freezeList(commands),
  });
  const canonical = canonicalJsonStringify(snapshot);
  if (BUFFER_FROM(canonical, 'utf8').length > MAX_POLICY_CANONICAL_BYTES) deny('out_of_range', path);
  return snapshot;
}

export function canonicalVerificationPolicyJsonV1(input, path = 'policy') {
  return canonicalJsonStringify(parseVerificationPolicyV1(input, path));
}

export function canonicalVerificationCommandJsonV1(input, path = 'command') {
  return canonicalJsonStringify(parseVerificationCommandDescriptorV1(input, path));
}

function digestOf(label, snapshot) {
  const canonical = canonicalJsonStringify(snapshot);
  const canonicalBytes = BUFFER_FROM(canonical, 'utf8');
  const descriptor = identityDigestV1(label, [canonicalBytes]);
  return capturedFreeze({
    algorithm: DIGEST_ALGORITHM,
    domain: IDENTITY_DOMAIN,
    version: IDENTITY_VERSION,
    label,
    input_bytes: canonicalBytes.length,
    digest: descriptor.digest,
  });
}

export function verificationPolicyDigestV1(input, path = 'policy') {
  return digestOf(VERIFICATION_POLICY_DIGEST_LABEL, parseVerificationPolicyV1(input, path));
}

export function verificationCommandDigestV1(input, path = 'command') {
  return digestOf(VERIFICATION_COMMAND_DIGEST_LABEL, parseVerificationCommandDescriptorV1(input, path));
}

export function verifyVerificationPolicyDigestV1(input, expectedDigestHex, path = 'policy') {
  if (typeof expectedDigestHex !== 'string'
    || expectedDigestHex.length !== POLICY_DIGEST_HEX_LENGTH
    || !capturedTest(PRIVATE_SHA256_PATTERN, expectedDigestHex)) {
    return false;
  }
  const actual = verificationPolicyDigestV1(input, path).digest;
  return TIMING_SAFE_EQUAL(BUFFER_FROM(actual, 'hex'), BUFFER_FROM(expectedDigestHex, 'hex')) === true;
}

function assertUntrustedStringParameter(value, path) {
  assertBoundedString(value, path, PARAM_VALUE_MAX_BYTES);
  if (!capturedTest(PRIVATE_LITERAL_PATTERN, value) && !capturedTest(PRIVATE_PATH_SEGMENT_PATTERN, value)) {
    deny('shell_content_denied', path);
  }
  return value;
}

function parseUntrustedParameters(input, path) {
  if (input === undefined) return freezeRecord([], {});
  assertPlainObject(input, 'invalid_type', path, path);
  const keys = sortedCapturedKeys(input);
  if (keys.length > MAX_PARAMETERS) deny('out_of_range', path);
  const seen = new SET_CTOR();
  const values = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const code = classifyUntrustedKey(key);
    if (code !== null && code !== 'unknown_key') deny(code, path);
    assertParamName(key, `${path}.${key}`);
    if (SET_HAS.call(seen, key)) deny('duplicate_parameter', path);
    SET_ADD.call(seen, key);
    const value = optOwn(input, key);
    if (typeof value === 'string') {
      values[key] = assertUntrustedStringParameter(value, `${path}.${key}`);
    } else if (typeof value === 'number') {
      values[key] = assertSafeInteger(value, `${path}.${key}`, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    } else if (value === true || value === false) {
      values[key] = value;
    } else {
      deny('invalid_type', `${path}.${key}`);
    }
  }
  return freezeRecord(keys, values);
}

export function rejectUntrustedExecutableContentV1(input, path = 'untrusted') {
  assertNotProxy(input, path);
  if (input === null || typeof input !== 'object') return;
  assertDirectJsonClosure(input, path);
  const walk = (node, nodePath) => {
    if (node === null || typeof node !== 'object') return;
    if (capturedIsArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], `${nodePath}[${index}]`);
      }
      return;
    }
    const keys = ownKeysOrDeny(node, nodePath);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key === 'symbol') deny('symbol_key_denied', nodePath);
      const code = classifyUntrustedKey(key);
      if (code !== null && code !== 'unknown_key') deny(code, nodePath);
      walk(optOwn(node, key), `${nodePath}.${key}`);
    }
  };
  walk(input, path);
}

export function parseUntrustedCommandReferenceV1(input, path = 'untrusted_command') {
  assertPlainObject(input, 'invalid_type', path, path);
  assertDirectJsonClosure(input, path);
  assertPolicyBounds(input, path);
  rejectUntrustedExecutableContentV1(input, path);
  const keys = ownKeysOrDeny(input, path);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') deny('symbol_key_denied', path);
    if (key !== 'command_id' && key !== 'parameters') {
      deny(classifyUntrustedKey(key) ?? 'unknown_key', path);
    }
  }
  if (!hasOwn(input, 'command_id')) deny('missing_key', `${path}.command_id`);
  const commandId = assertCommandId(optOwn(input, 'command_id'), `${path}.command_id`);
  const parameters = parseUntrustedParameters(
    hasOwn(input, 'parameters') ? optOwn(input, 'parameters') : undefined,
    `${path}.parameters`,
  );
  return freezeRecord(UNTRUSTED_COMMAND_ALLOWED_KEYS, {
    command_id: commandId,
    parameters,
  });
}

function requireNormalizedAbsolute(value, path) {
  if (typeof value !== 'string') deny('policy_options_denied', path);
  assertSafeText(value, path);
  if (!PATH_IS_ABSOLUTE(value) || PATH_RESOLVE(value) !== value) deny('policy_options_denied', path);
  return value;
}

function readEnvironment(env, path) {
  const source = env === undefined ? process.env : env;
  assertNotProxy(source, path);
  if (typeof source !== 'object' || source === null || capturedIsArray(source)) {
    deny('policy_options_denied', path);
  }
  const read = (key) => {
    let descriptor;
    try {
      descriptor = capturedDescriptor(source, key);
    } catch {
      deny('policy_options_denied', path);
    }
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      deny('policy_options_denied', path);
    }
    return descriptor.value;
  };
  return { xdgConfigHome: read('XDG_CONFIG_HOME'), home: read('HOME') };
}

function defaultOwnerConfigDir(environment) {
  if (typeof environment.xdgConfigHome === 'string' && environment.xdgConfigHome.length > 0
    && PATH_IS_ABSOLUTE(environment.xdgConfigHome)
    && PATH_RESOLVE(environment.xdgConfigHome) === environment.xdgConfigHome) {
    return environment.xdgConfigHome;
  }
  const home = typeof environment.home === 'string' && environment.home.length > 0
    && PATH_IS_ABSOLUTE(environment.home) && PATH_RESOLVE(environment.home) === environment.home
    ? environment.home
    : OS_HOMEDIR();
  requireNormalizedAbsolute(home, 'options.env.HOME');
  return PATH_JOIN(home, '.config');
}

export function verificationPolicyRoots(options = {}) {
  assertNotProxy(options, 'options');
  if (typeof options !== 'object' || options === null || capturedIsArray(options)) {
    deny('policy_options_denied', 'options');
  }
  const optionKeys = ownKeysOrDeny(options, 'options');
  for (let index = 0; index < optionKeys.length; index += 1) {
    const key = optionKeys[index];
    if (typeof key === 'symbol') deny('symbol_key_denied', 'options');
    if (!capturedIncludes(LOADER_OPTION_KEYS, key)) deny('unknown_key', 'options');
  }
  const ownerConfigDir = hasOwn(options, 'ownerConfigDir')
    ? requireNormalizedAbsolute(optOwn(options, 'ownerConfigDir'), 'options.ownerConfigDir')
    : defaultOwnerConfigDir(readEnvironment(
      hasOwn(options, 'env') ? optOwn(options, 'env') : undefined,
      'options.env',
    ));
  const dir = PATH_JOIN(ownerConfigDir, OWNER_POLICY_DIRNAME);
  const file = PATH_JOIN(dir, OWNER_POLICY_FILENAME);
  return capturedFreeze({
    scope: 'owner',
    dir,
    file,
  });
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function requireOwnerControl(entry, kindPath) {
  const effectiveUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : undefined;
  if ((effectiveUid !== undefined && entry.uid !== effectiveUid) || (entry.mode & 0o022n) !== 0n) {
    deny('policy_catalog_not_owner_controlled', kindPath);
  }
}

function catalogOpenFlags() {
  return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
}

function assertNoDuplicateJsonKeys(text) {
  const scopes = [{ object: false, keys: new SET_CTOR() }];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        const scope = scopes[scopes.length - 1];
        if (scope.object) {
          let cursor = index + 1;
          while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\n'
            || text[cursor] === '\r' || text[cursor] === '\t')) {
            cursor += 1;
          }
          if (text[cursor] === ':') {
            let key;
            try {
              key = JSON_PARSE(STRING_SLICE(text, stringStart - 1, index + 1));
            } catch {
              deny('invalid_encoding', 'policy');
            }
            if (SET_HAS.call(scope.keys, key)) deny('duplicate_id', 'policy');
            SET_ADD.call(scope.keys, key);
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      stringStart = index + 1;
      continue;
    }
    if (char === '{') ARRAY_PUSH.call(scopes, { object: true, keys: new SET_CTOR() });
    else if (char === '[') ARRAY_PUSH.call(scopes, { object: false, keys: new SET_CTOR() });
    else if (char === '}' || char === ']') {
      scopes.pop();
      if (scopes.length === 0) deny('invalid_encoding', 'policy');
    }
  }
  if (inString || scopes.length !== 1) deny('invalid_encoding', 'policy');
}

function parsePolicyText(text) {
  assertNoDuplicateJsonKeys(text);
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    deny('invalid_encoding', 'policy');
  }
  return parseVerificationPolicyV1(parsed, 'policy');
}

async function readOwnerPolicyFile(file) {
  let handle;
  try {
    handle = await FS_OPEN(file, catalogOpenFlags());
  } catch (error) {
    if (error && error.code === 'ENOENT') return { present: false, text: undefined };
    if (error && (error.code === 'ENOTDIR' || error.code === 'ELOOP')) {
      deny('policy_catalog_not_regular', 'policy');
    }
    deny('policy_catalog_unreadable', 'policy');
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) deny('policy_catalog_not_regular', 'policy');
    requireOwnerControl(before, 'policy');
    if (before.size > BigInt(MAX_POLICY_BYTES)) deny('policy_catalog_too_large', 'policy');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameEntry(before, after)) deny('policy_catalog_changed_during_read', 'policy');
    if (bytes.byteLength > MAX_POLICY_BYTES) deny('policy_catalog_too_large', 'policy');
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      deny('invalid_encoding', 'policy');
    }
    try {
      return {
        present: true,
        text: REFLECT_APPLY(TEXT_DECODER_DECODE, new TEXT_DECODER('utf-8', { fatal: true }), [bytes]),
      };
    } catch {
      deny('invalid_encoding', 'policy');
    }
  } catch (error) {
    if (error instanceof RunContractV1Error) throw error;
    deny('policy_catalog_unreadable', 'policy');
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function loadOwnerVerificationPolicyV1(options = {}) {
  const roots = verificationPolicyRoots(options);
  const dirEntry = await FS_LSTAT(roots.dir, { bigint: true }).catch((error) => {
    if (error && error.code === 'ENOENT') return undefined;
    deny('policy_catalog_unreadable', 'policy');
  });
  if (dirEntry !== undefined) {
    if (dirEntry.isSymbolicLink() || !dirEntry.isDirectory()) deny('policy_catalog_not_regular', 'policy');
    requireOwnerControl(dirEntry, 'policy');
  }
  const catalog = await readOwnerPolicyFile(roots.file);
  if (dirEntry !== undefined) {
    const afterDir = await FS_LSTAT(roots.dir, { bigint: true }).catch(() => {
      deny('policy_catalog_changed_during_read', 'policy');
    });
    if (!sameEntry(dirEntry, afterDir)) deny('policy_catalog_changed_during_read', 'policy');
  }
  const policy = catalog.present ? parsePolicyText(catalog.text) : emptyPolicy();
  const digest = digestOf(VERIFICATION_POLICY_DIGEST_LABEL, policy);
  return capturedFreeze({
    schema: VERIFICATION_POLICY_SCHEMA_ID,
    version: VERIFICATION_POLICY_VERSION,
    source: capturedFreeze({
      scope: 'owner',
      present: catalog.present === true,
      file: roots.file,
    }),
    policy,
    digest,
  });
}

export const VERIFICATION_POLICY_CONTRACT_DESCRIPTOR = capturedFreeze({
  schema: VERIFICATION_POLICY_SCHEMA_ID,
  version: VERIFICATION_POLICY_VERSION,
  label: VERIFICATION_POLICY_DIGEST_LABEL,
  command_label: VERIFICATION_COMMAND_DIGEST_LABEL,
  bounds: capturedFreeze({
    max_depth: MAX_POLICY_DEPTH,
    max_nodes: MAX_POLICY_NODES,
    max_commands: MAX_COMMANDS,
    max_argv_tokens: MAX_ARGV_TOKENS,
    max_parameters: MAX_PARAMETERS,
    max_canonical_bytes: MAX_POLICY_CANONICAL_BYTES,
    default_timeout_ms: DEFAULT_TIMEOUT_MS,
    default_output_bytes: DEFAULT_OUTPUT_BYTES,
    default_error_bytes: DEFAULT_ERROR_BYTES,
  }),
  default_deny: capturedFreeze({
    network: DEFAULT_NETWORK_RECEIPT,
    environment: DEFAULT_ENVIRONMENT_RECEIPT,
    mutation: DEFAULT_MUTATION_RECEIPT,
    resources: DEFAULT_RESOURCES_RECEIPT,
    timeout_ms: DEFAULT_TIMEOUT_MS,
  }),
});

capturedFreeze(parseVerificationPolicyV1);
capturedFreeze(parseVerificationCommandDescriptorV1);
capturedFreeze(parseUntrustedCommandReferenceV1);
capturedFreeze(rejectUntrustedExecutableContentV1);
capturedFreeze(canonicalVerificationPolicyJsonV1);
capturedFreeze(verificationPolicyDigestV1);
capturedFreeze(loadOwnerVerificationPolicyV1);
capturedFreeze(verificationPolicyRoots);
