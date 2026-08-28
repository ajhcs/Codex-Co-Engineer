// Provider-neutral declarative JSONL/event rule engine.
//
// Additive v3 library. Explicit configured JSON Pointers and exact type
// tokens map provider events onto bounded text/tool/thinking/usage/
// question/error facts. Caller provider/session/task/attempt identity is
// the only identity authority; attempt values fence a generation of facts
// to that caller identity. Question capability is exposed only when a live
// structured reply bridge is present. Receipts are immutable evidence:
// provider prose is never completion, verification, merge, or scoring
// authority.
//
// Wake taxonomy is first-class: completed, blocked, failed, question,
// timeout, user_update, and merge_ready. Routine progress never wakes.
// Hostile accessors and Proxies are rejected from descriptors/isProxy
// without invoking getters or traps. The 256 KiB source bound applies to
// object-form events as well as JSONL text. UTF-8 truncation is linear in
// the kept prefix.
//
// Fail closed on ambiguous matches, malformed JSON, prototype keys,
// excessive depth/bytes, unknown required rules, and identity mismatch.
// This module does not import, wrap, or substitute a provider driver,
// router, billing surface, or scorer. JSON Pointer matching follows the
// public RFC 6901 pattern; this file does not copy third-party event-rule
// implementations.

import { Buffer as NodeBuffer } from 'node:buffer';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  capturedDescriptor,
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedJoin,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownProvider,
  knownProvidersJoined,
  sortedCapturedKeys,
} from './grammar.mjs';
import { isPlainObject } from './run-manifest.mjs';
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

export const PROVIDER_EVENT_RULES_SCHEMA_ID = 'codex-co-engineer.provider-event-rules.v1';
export const PROVIDER_EVENT_RECEIPT_SCHEMA_ID = 'codex-co-engineer.provider-event-receipt.v1';
export const PROVIDER_EVENT_RULES_VERSION = 1;

export const PROVIDER_EVENT_FACT_KINDS = capturedFreeze([
  'error', 'question', 'text', 'thinking', 'tool', 'usage',
]);
export const PROVIDER_EVENT_SIGNALS = capturedFreeze([
  'blocked', 'completed', 'failed', 'merge_ready', 'progress', 'question',
  'timeout', 'user_update',
]);
export const PROVIDER_EVENT_WAKE_SIGNALS = capturedFreeze([
  'blocked', 'completed', 'failed', 'merge_ready', 'question', 'timeout',
  'user_update',
]);
export const PROVIDER_EVENT_ROUTINE_SIGNAL = 'progress';
export const PROVIDER_EVENT_AUTHORITY = 'evidence_only';
export const PROVIDER_EVENT_REDACTION_MARKER = '[redacted]';

export const MAX_PROVIDER_EVENT_RULES = 32;
export const MAX_PROVIDER_EVENT_RULE_ID_BYTES = 64;
export const MAX_PROVIDER_EVENT_TYPE_BYTES = 64;
export const MAX_PROVIDER_EVENT_PATH_BYTES = 128;
export const MAX_PROVIDER_EVENT_PATH_SEGMENTS = 8;
export const MAX_PROVIDER_EVENT_SOURCE_BYTES = 256 * 1024;
export const MAX_PROVIDER_EVENT_LINE_BYTES = 32 * 1024;
export const MAX_PROVIDER_EVENT_COUNT = 256;
export const MAX_PROVIDER_EVENT_DEPTH = 8;
export const MAX_PROVIDER_EVENT_NODES = 256;
export const MAX_PROVIDER_EVENT_OBJECT_KEYS = 32;
export const MAX_PROVIDER_EVENT_KEY_BYTES = 128;
export const MAX_PROVIDER_EVENT_FACT_TEXT_BYTES = 4 * 1024;
export const MAX_PROVIDER_EVENT_SESSION_ID_BYTES = 128;
export const MAX_PROVIDER_EVENT_TASK_ID_BYTES = 80;
export const MIN_PROVIDER_EVENT_ATTEMPT = 1;
export const MAX_PROVIDER_EVENT_ATTEMPT = 4;

export const PROVIDER_EVENT_DOCUMENT_KEYS = capturedFreeze(['rules', 'schema', 'version']);
export const PROVIDER_EVENT_RULE_KEYS = capturedFreeze([
  'id', 'kind', 'match_path', 'match_value', 'name_path', 'question_id_path',
  'required', 'signal', 'type', 'type_path', 'value_path',
]);
export const PROVIDER_EVENT_IDENTITY_KEYS = capturedFreeze([
  'attempt', 'provider', 'session_id', 'task_id',
]);
export const PROVIDER_EVENT_APPLY_KEYS = capturedFreeze([
  'identity', 'reply_bridge', 'require', 'rules', 'source',
]);
export const PROVIDER_EVENT_CREATE_KEYS = capturedFreeze([
  'identity', 'reply_bridge', 'require', 'rules',
]);
export const PROVIDER_EVENT_BRIDGE_KEYS = capturedFreeze(['submit']);
export const PROVIDER_EVENT_ENGINE_KEYS = capturedFreeze(['apply', 'schema', 'version']);
export const PROVIDER_EVENT_RECEIPT_KEYS = capturedFreeze([
  'authority', 'capabilities', 'event_count', 'facts', 'identity',
  'matched_rule_ids', 'redaction_count', 'schema', 'signal', 'truncated',
  'verified_success', 'version',
]);
export const PROVIDER_EVENT_FACT_KEYS = capturedFreeze([
  'answerable', 'error_code', 'index', 'kind', 'question_id',
  'redaction_count', 'rule_id', 'signal', 'text', 'tool_name', 'truncated',
  'type', 'usage',
]);
export const PROVIDER_EVENT_USAGE_KEYS = capturedFreeze([
  'cache_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
]);
export const PROVIDER_EVENT_CAPABILITY_KEYS = capturedFreeze(['question']);
export const PROVIDER_EVENT_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'ambiguous_match',
  'ambiguous_rule', 'duplicate_rule_id', 'event_count_exceeded',
  'exotic_prototype_denied', 'identity_mismatch', 'invalid_array',
  'invalid_format', 'invalid_json_type', 'invalid_json_value',
  'invalid_path', 'invalid_reply_bridge', 'invalid_type', 'invalid_usage',
  'malformed_json', 'missing_key', 'non_enumerable_property_denied',
  'out_of_range', 'own_undefined_denied', 'path_unresolved',
  'prototype_key_denied', 'proxy_denied', 'required_rule_unmatched',
  'source_too_complex', 'source_too_large', 'symbol_key_denied',
  'unknown_key', 'unknown_required_rule', 'value_depth_exceeded',
]);

const RULE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const JSON_POINTER_SEGMENT_PATTERN = /^[^/]+$/u;
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]{0,5})$/u;
const PROTOTYPE_KEYS = capturedFreeze(['__proto__', 'constructor', 'prototype']);

const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]{0,32}:\/\/)([^\s/@:]{1,256}):([^\s/@]{1,256})@/gi;
const BEARER_PATTERN = /\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{8,512}/gi;
const CREDENTIAL_FORMAT_PATTERN = /\b(?:sk|xai)-[A-Za-z0-9_-]{8,256}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,256}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bcrsr_[A-Za-z0-9_-]{12,256}\b/g;
const ENV_ASSIGNMENT_PATTERN = /\b((?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|credential|password|secret|token|private[_-]?key))(\s*[:=]\s*)(?:"[^"]{0,512}"|'[^']{0,512}'|[^\s,;'"&]{1,512})/gi;

const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_PUSH = ARRAY_PROTOTYPE.push;
const BUFFER_BYTE_LENGTH = NodeBuffer.byteLength.bind(NodeBuffer);
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const IS_PROXY = utilTypes.isProxy;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;
const TIMING_SAFE_EQUAL = cryptoTimingSafeEqual;

const UNRESOLVED = capturedFreeze({ unresolved: true });

function isPrototypeKey(key) {
  return capturedIncludes(PROTOTYPE_KEYS, key);
}

function isWakeSignal(signal) {
  return capturedIncludes(PROVIDER_EVENT_WAKE_SIGNALS, signal);
}

function readDenseArrayLength(value, path) {
  assertNotProxy(value, path);
  if (!capturedIsArray(value)) {
    fail('invalid_array', path, `${path} must be a dense JSON array.`);
  }
  const lengthDescriptor = capturedDescriptor(value, 'length');
  if (!lengthDescriptor || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail('invalid_array', `${path}.length`,
      `${path} length is not a dense JSON array length.`);
  }
  const length = lengthDescriptor.value;
  let ownKeys;
  try {
    ownKeys = REFLECT_OWN_KEYS(value);
  } catch {
    fail('invalid_type', path, `${path} keys could not be inspected safely.`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', path, `${path} carries a symbol-keyed property.`);
    }
    if (key === 'length') continue;
    const offset = Number(key);
    if (!NUMBER_IS_SAFE_INTEGER(offset) || offset < 0 || offset >= length || STRING(offset) !== key) {
      fail('invalid_array', `${path}.${key}`,
        `${path} carries named properties beyond dense indices.`);
    }
    const descriptor = capturedDescriptor(value, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail('accessor_property_denied', `${path}[${key}]`,
        `${path}[${key}] is an accessor property; getters are never invoked.`);
    }
  }
  return length;
}

function addAccountedBytes(state, path, extra) {
  if (!state.accountBytes) return;
  if (!NUMBER_IS_SAFE_INTEGER(extra) || extra < 0) {
    fail('invalid_json_value', path, `${path} byte size could not be accounted.`);
  }
  state.bytes += extra;
  if (state.bytes > MAX_PROVIDER_EVENT_LINE_BYTES) {
    fail('source_too_large', path, `${path} exceeds the bounded event byte limit.`);
  }
  if (state.totalBytes + state.bytes > MAX_PROVIDER_EVENT_SOURCE_BYTES) {
    fail('source_too_large', path, `${path} exceeds the bounded event source byte limit.`);
  }
}

function assertAllowedKeys(object, allowedKeys, path) {
  const allowed = new SET_CTOR(allowedKeys);
  const keys = sortedCapturedKeys(object);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (isPrototypeKey(key)) {
      fail('prototype_key_denied', `${path}.${key}`,
        `${path} rejects prototype-chain keys.`);
    }
    if (!SET_HAS.call(allowed, key)) {
      fail('unknown_key', `${path}.${key}`,
        `${path}.${key} is not part of the closed ${path} vocabulary.`);
    }
  }
}

function assertRequiredKeys(object, requiredKeys, path) {
  for (let index = 0; index < requiredKeys.length; index += 1) {
    const key = requiredKeys[index];
    if (!hasOwn(object, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
}

function assertBoundedId(value, pattern, maxBytes, path, label) {
  if (typeof value !== 'string' || !capturedTest(pattern, value)
    || capturedUtf8ByteLength(value) > maxBytes) {
    fail('invalid_format', path, `${path} must be a bounded ${label}.`);
  }
  return value;
}

function identitiesEqual(left, right) {
  if (typeof left !== typeof right) return false;
  if (typeof left === 'number') return left === right;
  if (typeof left !== 'string') return left === right;
  if (left.length !== right.length) return false;
  const leftBytes = BUFFER_FROM(left, 'utf8');
  const rightBytes = BUFFER_FROM(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return TIMING_SAFE_EQUAL(leftBytes, rightBytes);
}

function decodePointerSegment(raw, path) {
  if (typeof raw !== 'string' || raw.length === 0 || !capturedTest(JSON_POINTER_SEGMENT_PATTERN, raw)) {
    fail('invalid_path', path, `${path} must use non-empty JSON Pointer segments.`);
  }
  const decoded = raw.replaceAll('~1', '/').replaceAll('~0', '~');
  if (decoded.length === 0 || isPrototypeKey(decoded)) {
    fail('prototype_key_denied', path, `${path} rejects prototype JSON Pointer segments.`);
  }
  if (capturedUtf8ByteLength(decoded) > MAX_PROVIDER_EVENT_KEY_BYTES) {
    fail('invalid_path', path, `${path} exceeds the path-segment byte bound.`);
  }
  return decoded;
}

function compileJsonPointer(pointer, path) {
  if (typeof pointer !== 'string' || pointer.length === 0 || pointer[0] !== '/') {
    fail('invalid_path', path, `${path} must be a JSON Pointer starting with /.`);
  }
  if (capturedUtf8ByteLength(pointer) > MAX_PROVIDER_EVENT_PATH_BYTES) {
    fail('invalid_path', path, `${path} exceeds the path byte bound.`);
  }
  if (pointer === '/') {
    fail('invalid_path', path, `${path} must not address the event root.`);
  }
  const rawSegments = pointer.split('/');
  const segments = [];
  for (let index = 1; index < rawSegments.length; index += 1) {
    ARRAY_PUSH.call(segments, decodePointerSegment(rawSegments[index], path));
  }
  if (segments.length === 0 || segments.length > MAX_PROVIDER_EVENT_PATH_SEGMENTS) {
    fail('invalid_path', path, `${path} exceeds the path-segment bound.`);
  }
  return OBJECT_FREEZE(segments);
}

function tryReadPath(root, segments, path) {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    if (current === null || typeof current !== 'object') return UNRESOLVED;
    assertNotProxy(current, path);
    const segment = segments[index];
    if (capturedIsArray(current) && !capturedTest(ARRAY_INDEX_PATTERN, segment)) return UNRESOLVED;
    if (!hasOwn(current, segment)) return UNRESOLVED;
    const descriptor = capturedDescriptor(current, segment);
    if (!descriptor) return UNRESOLVED;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      fail('accessor_property_denied', path,
        `${path} is an accessor property; getters are never invoked.`);
    }
    if (descriptor.value === undefined) return UNRESOLVED;
    current = descriptor.value;
  }
  return current === undefined ? UNRESOLVED : current;
}

function readConfiguredPath(root, segments, path) {
  const value = tryReadPath(root, segments, path);
  if (value === UNRESOLVED) {
    fail('path_unresolved', path, `${path} could not be resolved on the matched event.`);
  }
  return value;
}

function jsonScalarEqual(left, right) {
  if (left === right) return left !== 0 || 1 / left === 1 / right;
  return false;
}

function cloneRegExp(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

function wellFormedText(value) {
  const text = STRING(value ?? '');
  if (typeof text.toWellFormed === 'function') return text.toWellFormed();
  return text;
}

function utf8Prefix(text, maxBytes) {
  const raw = typeof text === 'string' ? text : STRING(text ?? '');
  if (maxBytes <= 0) return { text: '', truncated: raw.length > 0 };
  // Encode at most maxBytes code units: each unit is at least one UTF-8 byte,
  // so this prefix is sufficient and the work is O(min(n, maxBytes)).
  const unitLimit = raw.length < maxBytes ? raw.length : maxBytes;
  const candidate = wellFormedText(unitLimit === raw.length ? raw : raw.slice(0, unitLimit));
  const encoded = BUFFER_FROM(candidate, 'utf8');
  if (encoded.length <= maxBytes) {
    return { text: candidate, truncated: unitLimit < raw.length };
  }
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

function redactText(text) {
  let output = wellFormedText(text);
  let redactionCount = 0;
  const mark = () => {
    redactionCount += 1;
    return PROVIDER_EVENT_REDACTION_MARKER;
  };
  output = output.replace(cloneRegExp(URL_CREDENTIAL_PATTERN), (match, protocol) => {
    redactionCount += 1;
    return `${protocol}${PROVIDER_EVENT_REDACTION_MARKER}@`;
  });
  output = output.replace(cloneRegExp(BEARER_PATTERN), (match) => {
    redactionCount += 1;
    return `${match.split(/[ \t]/u, 1)[0]} ${PROVIDER_EVENT_REDACTION_MARKER}`;
  });
  output = output.replace(cloneRegExp(CREDENTIAL_FORMAT_PATTERN), mark);
  output = output.replace(cloneRegExp(ENV_ASSIGNMENT_PATTERN), (_match, name, separator) => {
    redactionCount += 1;
    return `${name}${separator}${PROVIDER_EVENT_REDACTION_MARKER}`;
  });
  const capped = utf8Prefix(output, MAX_PROVIDER_EVENT_FACT_TEXT_BYTES);
  return {
    text: capped.text,
    truncated: capped.truncated,
    redaction_count: redactionCount,
  };
}

function boundedScalarText(value, path) {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' && NUMBER_IS_FINITE(value)) return redactText(STRING(value));
  if (typeof value === 'boolean' || value === null) return redactText(STRING(value));
  fail('invalid_type', path, `${path} must resolve to a JSON scalar.`);
}

function projectUsage(value, path) {
  if (typeof value === 'number') {
    if (!NUMBER_IS_SAFE_INTEGER(value) || value < 0) {
      fail('invalid_usage', path, `${path} usage counters must be non-negative safe integers.`);
    }
    return freezeData({
      cache_tokens: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: value,
    });
  }
  if (!isPlainObject(value)) {
    fail('invalid_usage', path, `${path} must be a usage object or a non-negative integer.`);
  }
  const usage = {
    cache_tokens: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
  };
  let found = false;
  const keys = sortedCapturedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!capturedIncludes(PROVIDER_EVENT_USAGE_KEYS, key)) continue;
    const child = ownDataValue(value, key, `${path}.${key}`);
    if (typeof child !== 'number' || !NUMBER_IS_SAFE_INTEGER(child) || child < 0) {
      fail('invalid_usage', `${path}.${key}`, `${path}.${key} must be a non-negative safe integer.`);
    }
    usage[key] = child;
    found = true;
  }
  if (!found) {
    fail('invalid_usage', path, `${path} carries no recognized usage counters.`);
  }
  return freezeData(usage);
}

function projectTool(value, nameFromPath, path) {
  let toolName = nameFromPath;
  let rawText = '';
  if (typeof value === 'string') {
    rawText = value;
  } else if (isPlainObject(value)) {
    if (hasOwn(value, 'name')) {
      const name = ownDataValue(value, 'name', `${path}.name`);
      if (typeof name !== 'string') fail('invalid_type', `${path}.name`, `${path}.name must be a string.`);
      toolName = toolName ?? name;
    }
    if (hasOwn(value, 'text')) {
      const text = ownDataValue(value, 'text', `${path}.text`);
      if (typeof text !== 'string') fail('invalid_type', `${path}.text`, `${path}.text must be a string.`);
      rawText = text;
    } else if (hasOwn(value, 'input')) {
      rawText = JSON_STRINGIFY(ownDataValue(value, 'input', `${path}.input`)) ?? '';
    } else if (hasOwn(value, 'arguments')) {
      rawText = JSON_STRINGIFY(ownDataValue(value, 'arguments', `${path}.arguments`)) ?? '';
    }
  } else {
    fail('invalid_type', path, `${path} must be a tool string or object.`);
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    fail('invalid_type', path, `${path} must name the tool.`);
  }
  const redactedName = redactText(toolName);
  const redactedText = redactText(rawText);
  return {
    tool_name: redactedName.text,
    text: redactedText.text,
    truncated: redactedName.truncated || redactedText.truncated,
    redaction_count: redactedName.redaction_count + redactedText.redaction_count,
  };
}

function projectError(value, path) {
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return { ...redacted, error_code: null };
  }
  if (!isPlainObject(value)) {
    fail('invalid_type', path, `${path} must be an error string or object.`);
  }
  let message = '';
  let errorCode = null;
  if (hasOwn(value, 'message')) {
    const child = ownDataValue(value, 'message', `${path}.message`);
    if (typeof child !== 'string') fail('invalid_type', `${path}.message`, `${path}.message must be a string.`);
    message = child;
  }
  if (hasOwn(value, 'code')) {
    const child = ownDataValue(value, 'code', `${path}.code`);
    if (typeof child !== 'string' || !capturedTest(ERROR_CODE_PATTERN, child)) {
      fail('invalid_format', `${path}.code`, `${path}.code must be a closed error token.`);
    }
    errorCode = child;
  }
  const redacted = redactText(message);
  return { ...redacted, error_code: errorCode };
}

function defaultSignalForKind(kind) {
  if (kind === 'question') return 'question';
  if (kind === 'error') return 'failed';
  return PROVIDER_EVENT_ROUTINE_SIGNAL;
}

function parseRequireList(value, path, knownIds) {
  if (value === undefined) return [];
  const length = readDenseArrayLength(value, path);
  const ids = [];
  const seen = new SET_CTOR();
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const id = ownDataValue(value, STRING(index), entryPath);
    assertBoundedId(id, RULE_ID_PATTERN, MAX_PROVIDER_EVENT_RULE_ID_BYTES, entryPath, 'rule id');
    if (!SET_HAS.call(knownIds, id)) {
      fail('unknown_required_rule', entryPath, `${entryPath} names a required rule that is not configured.`);
    }
    if (!SET_HAS.call(seen, id)) {
      SET_ADD.call(seen, id);
      ARRAY_PUSH.call(ids, id);
    }
  }
  ids.sort();
  return ids;
}

function assertLiveStructuredReplyBridge(value, path) {
  assertNotProxy(value, path);
  if (typeof value !== 'object' || value === null || capturedIsArray(value)) {
    fail('invalid_reply_bridge', path,
      `${path} must be a live structured reply bridge object.`);
  }
  assertAllowedKeys(value, PROVIDER_EVENT_BRIDGE_KEYS, path);
  if (!hasOwn(value, 'submit')) {
    fail('invalid_reply_bridge', `${path}.submit`, `${path}.submit is required.`);
  }
  const submit = ownDataValue(value, 'submit', `${path}.submit`);
  if (typeof submit !== 'function' || IS_PROXY(submit)) {
    fail('invalid_reply_bridge', `${path}.submit`,
      `${path}.submit must be a live function; prose and serialized functions are not a reply bridge.`);
  }
  return value;
}

export function parseProviderEventIdentityV1(identity, path = 'identity') {
  assertNotProxy(identity, path);
  assertPlainObject(identity, 'invalid_type', path, path);
  assertDirectJsonClosure(identity, path);
  assertAllowedKeys(identity, PROVIDER_EVENT_IDENTITY_KEYS, path);
  assertRequiredKeys(identity, PROVIDER_EVENT_IDENTITY_KEYS, path);
  const provider = ownDataValue(identity, 'provider', `${path}.provider`);
  if (!isKnownProvider(provider)) {
    fail('invalid_format', `${path}.provider`,
      `${path}.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  const sessionId = ownDataValue(identity, 'session_id', `${path}.session_id`);
  assertBoundedId(sessionId, SESSION_ID_PATTERN, MAX_PROVIDER_EVENT_SESSION_ID_BYTES,
    `${path}.session_id`, 'session id');
  const taskId = ownDataValue(identity, 'task_id', `${path}.task_id`);
  assertBoundedId(taskId, TASK_ID_PATTERN, MAX_PROVIDER_EVENT_TASK_ID_BYTES,
    `${path}.task_id`, 'task id');
  const attempt = ownDataValue(identity, 'attempt', `${path}.attempt`);
  if (typeof attempt !== 'number' || !NUMBER_IS_SAFE_INTEGER(attempt)
    || attempt < MIN_PROVIDER_EVENT_ATTEMPT || attempt > MAX_PROVIDER_EVENT_ATTEMPT) {
    fail('invalid_format', `${path}.attempt`,
      `${path}.attempt must be an integer in ${MIN_PROVIDER_EVENT_ATTEMPT}..${MAX_PROVIDER_EVENT_ATTEMPT}.`);
  }
  return freezeData({
    provider,
    session_id: sessionId,
    task_id: taskId,
    attempt,
  });
}

function compileRule(rule, path, seenIds, seenMatches) {
  assertNotProxy(rule, path);
  assertPlainObject(rule, 'invalid_type', path, path);
  assertAllowedKeys(rule, PROVIDER_EVENT_RULE_KEYS, path);
  assertRequiredKeys(rule, ['id', 'kind', 'type', 'type_path', 'value_path'], path);
  const id = assertBoundedId(
    ownDataValue(rule, 'id', `${path}.id`),
    RULE_ID_PATTERN,
    MAX_PROVIDER_EVENT_RULE_ID_BYTES,
    `${path}.id`,
    'rule id',
  );
  if (SET_HAS.call(seenIds, id)) {
    fail('duplicate_rule_id', `${path}.id`, `${path}.id repeats a rule id.`);
  }
  SET_ADD.call(seenIds, id);
  const type = assertBoundedId(
    ownDataValue(rule, 'type', `${path}.type`),
    EVENT_TYPE_PATTERN,
    MAX_PROVIDER_EVENT_TYPE_BYTES,
    `${path}.type`,
    'event type',
  );
  const kind = ownDataValue(rule, 'kind', `${path}.kind`);
  if (!capturedIncludes(PROVIDER_EVENT_FACT_KINDS, kind)) {
    fail('invalid_format', `${path}.kind`,
      `${path}.kind must be one of ${capturedJoin(PROVIDER_EVENT_FACT_KINDS, ', ')}.`);
  }
  let signal = defaultSignalForKind(kind);
  if (hasOwn(rule, 'signal')) {
    signal = ownDataValue(rule, 'signal', `${path}.signal`);
    if (!capturedIncludes(PROVIDER_EVENT_SIGNALS, signal)) {
      fail('invalid_format', `${path}.signal`,
        `${path}.signal must be one of ${capturedJoin(PROVIDER_EVENT_SIGNALS, ', ')}.`);
    }
  }
  let required = false;
  if (hasOwn(rule, 'required')) {
    required = ownDataValue(rule, 'required', `${path}.required`);
    if (required !== true && required !== false) {
      fail('invalid_type', `${path}.required`, `${path}.required must be an exact boolean.`);
    }
  }
  const typePath = compileJsonPointer(ownDataValue(rule, 'type_path', `${path}.type_path`), `${path}.type_path`);
  const valuePath = compileJsonPointer(ownDataValue(rule, 'value_path', `${path}.value_path`), `${path}.value_path`);
  let matchPath = null;
  let matchValue = undefined;
  if (hasOwn(rule, 'match_path') || hasOwn(rule, 'match_value')) {
    if (!hasOwn(rule, 'match_path') || !hasOwn(rule, 'match_value')) {
      fail('missing_key', `${path}.match_value`,
        `${path} must pair match_path with match_value.`);
    }
    matchPath = compileJsonPointer(ownDataValue(rule, 'match_path', `${path}.match_path`), `${path}.match_path`);
    matchValue = ownDataValue(rule, 'match_value', `${path}.match_value`);
    const matchType = typeof matchValue;
    if (matchValue !== null && matchType !== 'string' && matchType !== 'number' && matchType !== 'boolean') {
      fail('invalid_type', `${path}.match_value`, `${path}.match_value must be a JSON scalar.`);
    }
  }
  let questionIdPath = null;
  if (kind === 'question') {
    if (!hasOwn(rule, 'question_id_path')) {
      fail('missing_key', `${path}.question_id_path`,
        `${path}.question_id_path is required for question facts.`);
    }
    questionIdPath = compileJsonPointer(
      ownDataValue(rule, 'question_id_path', `${path}.question_id_path`),
      `${path}.question_id_path`,
    );
  } else if (hasOwn(rule, 'question_id_path')) {
    fail('unknown_key', `${path}.question_id_path`,
      `${path}.question_id_path is valid only for question facts.`);
  }
  let namePath = null;
  if (hasOwn(rule, 'name_path')) {
    if (kind !== 'tool') {
      fail('unknown_key', `${path}.name_path`, `${path}.name_path is valid only for tool facts.`);
    }
    namePath = compileJsonPointer(ownDataValue(rule, 'name_path', `${path}.name_path`), `${path}.name_path`);
  }
  const matchKey = JSON_STRINGIFY({
    type,
    type_path: typePath,
    match_path: matchPath,
    match_value: matchValue === undefined ? null : matchValue,
    has_match: matchPath !== null,
  });
  if (SET_HAS.call(seenMatches, matchKey)) {
    fail('ambiguous_rule', path,
      `${path} collides with another rule on the same type/path selector.`);
  }
  SET_ADD.call(seenMatches, matchKey);
  return freezeData({
    id,
    type,
    kind,
    signal,
    required,
    type_path: typePath,
    value_path: valuePath,
    match_path: matchPath,
    match_value: matchValue === undefined ? null : matchValue,
    has_match: matchPath !== null,
    question_id_path: questionIdPath,
    name_path: namePath,
  });
}

export function compileProviderEventRulesV1(document, path = 'rules') {
  assertNotProxy(document, path);
  assertPlainObject(document, 'invalid_type', path, path);
  assertDirectJsonClosure(document, path);
  assertAllowedKeys(document, PROVIDER_EVENT_DOCUMENT_KEYS, path);
  assertRequiredKeys(document, PROVIDER_EVENT_DOCUMENT_KEYS, path);
  const schema = ownDataValue(document, 'schema', `${path}.schema`);
  if (schema !== PROVIDER_EVENT_RULES_SCHEMA_ID) {
    fail('invalid_format', `${path}.schema`, `${path}.schema must be ${PROVIDER_EVENT_RULES_SCHEMA_ID}.`);
  }
  const version = ownDataValue(document, 'version', `${path}.version`);
  if (version !== PROVIDER_EVENT_RULES_VERSION) {
    fail('invalid_format', `${path}.version`, `${path}.version must be ${PROVIDER_EVENT_RULES_VERSION}.`);
  }
  const rules = ownDataValue(document, 'rules', `${path}.rules`);
  const ruleCount = readDenseArrayLength(rules, `${path}.rules`);
  if (ruleCount === 0 || ruleCount > MAX_PROVIDER_EVENT_RULES) {
    fail('out_of_range', `${path}.rules`,
      `${path}.rules must contain 1-${MAX_PROVIDER_EVENT_RULES} rules.`);
  }
  const compiled = [];
  const seenIds = new SET_CTOR();
  const seenMatches = new SET_CTOR();
  for (let index = 0; index < ruleCount; index += 1) {
    ARRAY_PUSH.call(
      compiled,
      compileRule(ownDataValue(rules, STRING(index), `${path}.rules[${index}]`), `${path}.rules[${index}]`, seenIds, seenMatches),
    );
  }
  return freezeData({
    schema: PROVIDER_EVENT_RULES_SCHEMA_ID,
    version: PROVIDER_EVENT_RULES_VERSION,
    rules: compiled,
    ids: freezeData([...seenIds].sort()),
  });
}

function createEventTreeState(accountBytes, totalBytes) {
  return {
    seen: new SET_CTOR(),
    nodes: 0,
    bytes: 0,
    totalBytes: totalBytes ?? 0,
    accountBytes: accountBytes === true,
  };
}

function assertEventTree(value, path, depth, state) {
  if (depth > MAX_PROVIDER_EVENT_DEPTH) {
    fail('value_depth_exceeded', path,
      `${path} exceeds the bounded event nesting depth of ${MAX_PROVIDER_EVENT_DEPTH}.`);
  }
  if (value === undefined) {
    fail('own_undefined_denied', path, `${path} is undefined.`);
  }
  if (value === null) {
    addAccountedBytes(state, path, 4);
    return;
  }
  if (typeof value === 'boolean') {
    addAccountedBytes(state, path, value === true ? 4 : 5);
    return;
  }
  if (typeof value === 'string') {
    const size = BUFFER_BYTE_LENGTH(value, 'utf8');
    if (state.accountBytes && size > MAX_PROVIDER_EVENT_SOURCE_BYTES) {
      fail('source_too_large', path, `${path} exceeds the bounded event source byte limit.`);
    }
    addAccountedBytes(state, path, size);
    return;
  }
  if (typeof value === 'number') {
    if (!NUMBER_IS_FINITE(value)) {
      fail('invalid_json_value', path, `${path} must be a finite JSON number.`);
    }
    addAccountedBytes(state, path, BUFFER_BYTE_LENGTH(STRING(value), 'utf8'));
    return;
  }
  if (typeof value !== 'object') {
    fail('invalid_json_type', path, `${path} must be direct JSON data.`);
  }
  assertNotProxy(value, path);
  if (SET_HAS.call(state.seen, value)) {
    fail('aliased_reference_denied', path, `${path} repeats an earlier object or array reference.`);
  }
  SET_ADD.call(state.seen, value);
  state.nodes += 1;
  if (state.nodes > MAX_PROVIDER_EVENT_NODES) {
    fail('source_too_complex', path, `${path} exceeds the bounded event node count.`);
  }
  addAccountedBytes(state, path, 2);
  let ownKeys;
  try {
    ownKeys = REFLECT_OWN_KEYS(value);
  } catch {
    fail('invalid_type', path, `${path} keys could not be inspected safely.`);
  }
  const isArray = capturedIsArray(value);
  if (ownKeys.length > MAX_PROVIDER_EVENT_OBJECT_KEYS + (isArray ? 1 : 0)) {
    fail('source_too_complex', path, `${path} exceeds the bounded event key count.`);
  }
  if (isArray) {
    const length = readDenseArrayLength(value, path);
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key === 'symbol') {
        fail('symbol_key_denied', path, `${path} carries a symbol-keyed property.`);
      }
      if (key === 'length') continue;
      const offset = Number(key);
      if (!NUMBER_IS_SAFE_INTEGER(offset) || offset < 0 || offset >= length || STRING(offset) !== key) {
        fail('invalid_array', `${path}.${key}`,
          `${path} carries named properties beyond dense indices.`);
      }
    }
    for (let index = 0; index < length; index += 1) {
      const child = ownDataValue(value, STRING(index), `${path}[${index}]`);
      assertEventTree(child, `${path}[${index}]`, depth + 1, state);
    }
    return;
  }
  if (!isPlainObject(value)) {
    fail('exotic_prototype_denied', path, `${path} must use a standard or null object prototype.`);
  }
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', path, `${path} carries a symbol-keyed property.`);
    }
    if (isPrototypeKey(key)) {
      fail('prototype_key_denied', `${path}.${key}`, `${path} rejects prototype-chain keys.`);
    }
    const keyBytes = capturedUtf8ByteLength(key);
    if (keyBytes > MAX_PROVIDER_EVENT_KEY_BYTES) {
      fail('source_too_complex', `${path}.${key}`, `${path} exceeds the bounded event key size.`);
    }
    addAccountedBytes(state, path, keyBytes);
    const child = ownDataValue(value, key, `${path}.${key}`);
    assertEventTree(child, `${path}.${key}`, depth + 1, state);
  }
}

function parseJsonLine(line, path) {
  let parsed;
  try {
    parsed = JSON_PARSE(line);
  } catch {
    fail('malformed_json', path, `${path} is not well-formed JSON.`);
  }
  assertNotProxy(parsed, path);
  if (!isPlainObject(parsed)) {
    fail('invalid_type', path, `${path} must be a JSON object.`);
  }
  assertEventTree(parsed, path, 0, createEventTreeState(false, 0));
  return parsed;
}

function splitJsonl(source, path) {
  if (typeof source !== 'string') {
    fail('invalid_type', path, `${path} must be a JSONL string or a dense array of events.`);
  }
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (BUFFER_BYTE_LENGTH(text, 'utf8') > MAX_PROVIDER_EVENT_SOURCE_BYTES) {
    fail('source_too_large', path, `${path} exceeds the bounded event source byte limit.`);
  }
  const rawLines = text.split(/\r?\n/u);
  const events = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (line.trim().length === 0) continue;
    if (BUFFER_BYTE_LENGTH(line, 'utf8') > MAX_PROVIDER_EVENT_LINE_BYTES) {
      fail('source_too_large', `${path}.line[${index}]`,
        `${path}.line[${index}] exceeds the bounded event byte limit.`);
    }
    ARRAY_PUSH.call(events, parseJsonLine(line, `${path}.line[${index}]`));
  }
  if (events.length > MAX_PROVIDER_EVENT_COUNT) {
    fail('event_count_exceeded', path, `${path} exceeds the bounded event count.`);
  }
  return events;
}

function parseSource(source, path) {
  if (typeof source === 'string') return splitJsonl(source, path);
  const length = readDenseArrayLength(source, path);
  if (length > MAX_PROVIDER_EVENT_COUNT) {
    fail('event_count_exceeded', path, `${path} exceeds the bounded event count.`);
  }
  const events = [];
  let totalBytes = 0;
  for (let index = 0; index < length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = ownDataValue(source, STRING(index), entryPath);
    if (typeof entry === 'string') {
      const size = BUFFER_BYTE_LENGTH(entry, 'utf8');
      if (size > MAX_PROVIDER_EVENT_LINE_BYTES) {
        fail('source_too_large', entryPath, `${entryPath} exceeds the bounded event byte limit.`);
      }
      totalBytes += size;
      if (totalBytes > MAX_PROVIDER_EVENT_SOURCE_BYTES) {
        fail('source_too_large', path, `${path} exceeds the bounded event source byte limit.`);
      }
      ARRAY_PUSH.call(events, parseJsonLine(entry, entryPath));
      continue;
    }
    assertNotProxy(entry, entryPath);
    if (!isPlainObject(entry)) {
      fail('invalid_type', entryPath, `${entryPath} must be a JSON object.`);
    }
    const treeState = createEventTreeState(true, totalBytes);
    assertEventTree(entry, entryPath, 0, treeState);
    totalBytes += treeState.bytes;
    if (totalBytes > MAX_PROVIDER_EVENT_SOURCE_BYTES) {
      fail('source_too_large', path, `${path} exceeds the bounded event source byte limit.`);
    }
    ARRAY_PUSH.call(events, entry);
  }
  return events;
}

function assertEventIdentity(event, identity, path) {
  for (let index = 0; index < PROVIDER_EVENT_IDENTITY_KEYS.length; index += 1) {
    const key = PROVIDER_EVENT_IDENTITY_KEYS[index];
    if (!hasOwn(event, key)) continue;
    const value = ownDataValue(event, key, `${path}.${key}`);
    if (!identitiesEqual(value, identity[key])) {
      fail('identity_mismatch', `${path}.${key}`,
        `${path}.${key} does not match the caller identity.`);
    }
  }
}

function matchRules(event, compiledRules, path) {
  const matches = [];
  for (let index = 0; index < compiledRules.length; index += 1) {
    const rule = compiledRules[index];
    const typeValue = tryReadPath(event, rule.type_path, `${path}.type`);
    if (typeValue !== rule.type) continue;
    if (rule.has_match) {
      const matched = tryReadPath(event, rule.match_path, `${path}.match`);
      if (matched === UNRESOLVED || !jsonScalarEqual(matched, rule.match_value)) continue;
    }
    ARRAY_PUSH.call(matches, rule);
  }
  return matches;
}

function extractFact(event, rule, index, questionCapable, path) {
  const value = readConfiguredPath(event, rule.value_path, `${path}.value`);
  let text = '';
  let truncated = false;
  let redactionCount = 0;
  let toolName = null;
  let usage = null;
  let questionId = null;
  let answerable = null;
  let errorCode = null;
  if (rule.kind === 'text' || rule.kind === 'thinking') {
    const projected = boundedScalarText(value, `${path}.value`);
    text = projected.text;
    truncated = projected.truncated;
    redactionCount = projected.redaction_count;
  } else if (rule.kind === 'usage') {
    usage = projectUsage(value, `${path}.value`);
  } else if (rule.kind === 'tool') {
    let nameFromPath = null;
    if (rule.name_path) {
      const named = readConfiguredPath(event, rule.name_path, `${path}.name`);
      if (typeof named !== 'string' || named.length === 0) {
        fail('invalid_type', `${path}.name`, `${path}.name must be a nonempty string.`);
      }
      nameFromPath = named;
    }
    const projected = projectTool(value, nameFromPath, `${path}.value`);
    text = projected.text;
    toolName = projected.tool_name;
    truncated = projected.truncated;
    redactionCount = projected.redaction_count;
  } else if (rule.kind === 'question') {
    const identifier = readConfiguredPath(event, rule.question_id_path, `${path}.question_id`);
    if (typeof identifier !== 'string' || !capturedTest(TASK_ID_PATTERN, identifier)) {
      fail('invalid_format', `${path}.question_id`, `${path}.question_id must be a bounded question id.`);
    }
    const projected = boundedScalarText(value, `${path}.value`);
    text = projected.text;
    truncated = projected.truncated;
    redactionCount = projected.redaction_count;
    questionId = identifier;
    answerable = questionCapable === true;
  } else if (rule.kind === 'error') {
    const projected = projectError(value, `${path}.value`);
    text = projected.text;
    truncated = projected.truncated;
    redactionCount = projected.redaction_count;
    errorCode = projected.error_code;
  }
  return freezeData({
    index,
    rule_id: rule.id,
    kind: rule.kind,
    type: rule.type,
    signal: rule.signal,
    text,
    truncated,
    redaction_count: redactionCount,
    tool_name: toolName,
    usage,
    question_id: questionId,
    answerable,
    error_code: errorCode,
  });
}

function parseReplyBridge(options, path) {
  if (!hasOwn(options, 'reply_bridge')) return null;
  const bridge = optOwn(options, 'reply_bridge');
  if (bridge === undefined) {
    fail('own_undefined_denied', `${path}.reply_bridge`,
      `${path}.reply_bridge is undefined; omit the field instead of writing undefined.`);
  }
  return assertLiveStructuredReplyBridge(bridge, `${path}.reply_bridge`);
}

function assertRequestRecord(options, path, allowedKeys) {
  assertNotProxy(options, path);
  assertPlainObject(options, 'invalid_type', path, path);
  assertAllowedKeys(options, allowedKeys, path);
  let ownKeys;
  try {
    ownKeys = REFLECT_OWN_KEYS(options);
  } catch {
    fail('invalid_type', path, `${path} keys could not be inspected safely.`);
  }
  const jsonOnly = {};
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', path, `${path} carries a symbol-keyed property.`);
    }
    const memberPath = `${path}.${key}`;
    const descriptor = capturedDescriptor(options, key);
    if (!descriptor || !descriptor.enumerable) {
      fail('non_enumerable_property_denied', memberPath,
        `${memberPath} could not be described as an own enumerable data property.`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      fail('accessor_property_denied', memberPath,
        `${memberPath} is an accessor property; getters are never invoked.`);
    }
    if (descriptor.value === undefined) {
      fail('own_undefined_denied', memberPath,
        `${memberPath} is undefined; omit the field instead of writing undefined.`);
    }
    if (key === 'reply_bridge' || key === 'source') continue;
    jsonOnly[key] = descriptor.value;
  }
  assertDirectJsonClosure(jsonOnly, path);
}

function bindRequest(options, path, allowedKeys) {
  assertRequestRecord(options, path, allowedKeys);
  const requiredKeys = allowedKeys === PROVIDER_EVENT_APPLY_KEYS
    ? ['rules', 'identity', 'source']
    : ['rules', 'identity'];
  assertRequiredKeys(options, requiredKeys, path);
  const compiled = compileProviderEventRulesV1(ownDataValue(options, 'rules', `${path}.rules`), `${path}.rules`);
  const identity = parseProviderEventIdentityV1(ownDataValue(options, 'identity', `${path}.identity`), `${path}.identity`);
  const knownIds = new SET_CTOR(compiled.ids);
  const required = parseRequireList(optOwn(options, 'require'), `${path}.require`, knownIds);
  const requiredSet = new SET_CTOR(required);
  for (let index = 0; index < compiled.rules.length; index += 1) {
    if (compiled.rules[index].required) SET_ADD.call(requiredSet, compiled.rules[index].id);
  }
  const replyBridge = parseReplyBridge(options, path);
  return { compiled, identity, required: [...requiredSet].sort(), replyBridge };
}

function evaluateEvents(source, compiled, identity, requiredIds, replyBridge, sourcePath) {
  const events = parseSource(source, sourcePath);
  const questionCapable = replyBridge !== null;
  const facts = [];
  const matched = new SET_CTOR();
  let overallSignal = PROVIDER_EVENT_ROUTINE_SIGNAL;
  let truncated = false;
  let redactionCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const path = `${sourcePath}.event[${index}]`;
    const event = events[index];
    assertEventIdentity(event, identity, path);
    const matches = matchRules(event, compiled.rules, path);
    if (matches.length > 1) {
      fail('ambiguous_match', path, `${path} matched more than one configured rule.`);
    }
    if (matches.length === 0) continue;
    const fact = extractFact(event, matches[0], index, questionCapable, path);
    ARRAY_PUSH.call(facts, fact);
    SET_ADD.call(matched, fact.rule_id);
    if (isWakeSignal(fact.signal)) overallSignal = fact.signal;
    truncated = truncated || fact.truncated === true;
    redactionCount += fact.redaction_count;
  }
  for (let index = 0; index < requiredIds.length; index += 1) {
    const id = requiredIds[index];
    if (!SET_HAS.call(matched, id)) {
      fail('required_rule_unmatched', 'rules',
        'A required rule did not match any event.');
    }
  }
  const matchedIds = [...matched];
  matchedIds.sort();
  return freezeData({
    schema: PROVIDER_EVENT_RECEIPT_SCHEMA_ID,
    version: PROVIDER_EVENT_RULES_VERSION,
    identity: freezeData({ ...identity }),
    signal: overallSignal,
    facts,
    capabilities: freezeData({ question: questionCapable }),
    matched_rule_ids: freezeData(matchedIds),
    event_count: events.length,
    truncated,
    redaction_count: redactionCount,
    verified_success: false,
    authority: PROVIDER_EVENT_AUTHORITY,
  });
}

export function describeProviderEventRulesV1() {
  return freezeData({
    schema: PROVIDER_EVENT_RULES_SCHEMA_ID,
    version: PROVIDER_EVENT_RULES_VERSION,
    fact_kinds: PROVIDER_EVENT_FACT_KINDS,
    signals: PROVIDER_EVENT_SIGNALS,
    wake_signals: PROVIDER_EVENT_WAKE_SIGNALS,
    routine_signal: PROVIDER_EVENT_ROUTINE_SIGNAL,
    identity_keys: PROVIDER_EVENT_IDENTITY_KEYS,
    question_capability: 'live_structured_reply_bridge_only',
    authority: PROVIDER_EVENT_AUTHORITY,
    verified_success: false,
    drivers: freezeData([]),
    billing: freezeData([]),
    scoring: freezeData([]),
    substitution: freezeData([]),
  });
}

export function applyProviderEventRulesV1(options) {
  const path = 'options';
  const bound = bindRequest(options, path, PROVIDER_EVENT_APPLY_KEYS);
  const source = ownDataValue(options, 'source', `${path}.source`);
  return evaluateEvents(source, bound.compiled, bound.identity, bound.required, bound.replyBridge, `${path}.source`);
}

export function createProviderEventRulesEngineV1(options) {
  const path = 'options';
  const bound = bindRequest(options, path, PROVIDER_EVENT_CREATE_KEYS);
  const engine = {
    schema: PROVIDER_EVENT_RULES_SCHEMA_ID,
    version: PROVIDER_EVENT_RULES_VERSION,
    apply(source) {
      return evaluateEvents(source, bound.compiled, bound.identity, bound.required, bound.replyBridge, 'source');
    },
  };
  return freezeData(engine);
}

capturedFreeze(parseProviderEventIdentityV1);
capturedFreeze(compileProviderEventRulesV1);
capturedFreeze(describeProviderEventRulesV1);
capturedFreeze(applyProviderEventRulesV1);
capturedFreeze(createProviderEventRulesEngineV1);
