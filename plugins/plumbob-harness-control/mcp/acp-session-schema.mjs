/*
 * Public contract for the future local ACP session tool.
 *
 * This module is intentionally unwired. It owns only validation and compact
 * response projection; provider processes, durable state, and target
 * resolution remain outside this boundary.
 */

import { createHash } from 'node:crypto';

export const ACP_SESSION_SCHEMA_VERSION = 'codex-co-engineer.config.v1';

export const ACP_SESSION_ACTIONS = Object.freeze([
  'create',
  'prompt',
  'stream',
  'cancel',
  'resume',
  'config',
  'close',
]);

export const ACP_SESSION_PROVIDERS = Object.freeze([
  'grok-local-acp',
  'cursor-local-acp',
]);

export const ACP_SESSION_MUTATIONS = Object.freeze([
  'create',
  'prompt',
  'cancel',
  'resume',
  'config',
  'close',
]);

export const ACP_SESSION_LIMITS = Object.freeze({
  prompt_bytes: 64 * 1024,
  prompt_lines: 2_000,
  stream_events: 200,
  stream_bytes: 64 * 1024,
  event_text_bytes: 16 * 1024,
  id_bytes: 128,
});

const ACTIONS = new Set(ACP_SESSION_ACTIONS);
const PROVIDERS = new Set(ACP_SESSION_PROVIDERS);
const MUTATIONS = new Set(ACP_SESSION_MUTATIONS);
const ROLES = new Set(['review', 'verify', 'implement']);
const GROK_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PUBLIC_STATES = new Set(['creating', 'ready', 'prompting', 'cancelling', 'uncertain', 'completed', 'closed', 'failed']);
const PUBLIC_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_target_context',
  'target_fingerprint_mismatch',
  'unsupported_provider',
  'unsupported_capability',
  'provider_unavailable',
  'provider_failed',
  'timeout',
  'cancelled',
  'uncertain',
  'state_unavailable',
  'internal_error',
]);
const PUBLIC_EVENT_TYPES = new Set(['status', 'text', 'tool', 'usage', 'error', 'control']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$/u;
const SAFE_TOOL = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,95}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TARGET_SCHEMA_VERSION = 'codex-co-engineer.target.v1';

const COMMON_KEYS = Object.freeze(['schema_version', 'action', 'role']);
const ACTION_KEYS = Object.freeze({
  create: Object.freeze([...COMMON_KEYS, 'provider', 'request_id', 'target_context', 'expected_target_fingerprint', 'config']),
  prompt: Object.freeze([...COMMON_KEYS, 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint', 'prompt']),
  stream: Object.freeze([...COMMON_KEYS, 'session_id', 'turn_id', 'target_context', 'expected_target_fingerprint', 'after_seq', 'max_events', 'max_bytes']),
  cancel: Object.freeze([...COMMON_KEYS, 'session_id', 'turn_id', 'request_id', 'target_context', 'expected_target_fingerprint']),
  resume: Object.freeze([...COMMON_KEYS, 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint']),
  config: Object.freeze([...COMMON_KEYS, 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint', 'provider', 'config']),
  close: Object.freeze([...COMMON_KEYS, 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint']),
});

const ACTION_REQUIRED = Object.freeze({
  create: Object.freeze(['schema_version', 'action', 'provider', 'request_id', 'target_context', 'expected_target_fingerprint']),
  prompt: Object.freeze(['schema_version', 'action', 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint', 'prompt']),
  stream: Object.freeze(['schema_version', 'action', 'session_id', 'turn_id', 'target_context', 'expected_target_fingerprint', 'after_seq']),
  cancel: Object.freeze(['schema_version', 'action', 'session_id', 'turn_id', 'request_id', 'target_context', 'expected_target_fingerprint']),
  resume: Object.freeze(['schema_version', 'action', 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint']),
  config: Object.freeze(['schema_version', 'action', 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint', 'provider', 'config']),
  close: Object.freeze(['schema_version', 'action', 'session_id', 'request_id', 'target_context', 'expected_target_fingerprint']),
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function cloneAuthority(value, field = 'authoritative_target_context') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => cloneAuthority(entry, `${field}[${index}]`));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneAuthority(entry, `${field}.${key}`)]),
    );
  }
  fail('target_authority_required', `${field} must contain only JSON-compatible authority data.`, field);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export class AcpSessionSchemaError extends Error {
  constructor(code, message, field = null) {
    super(message);
    this.name = 'AcpSessionSchemaError';
    this.code = code;
    if (field !== null) this.field = field;
  }
}

function fail(code, message, field = null) {
  throw new AcpSessionSchemaError(code, message, field);
}

function exactKeys(value, allowed, field = 'request') {
  if (!isPlainObject(value)) fail('invalid_request', `${field} must be an object.`, field);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) fail('unknown_field', `${field}.${unknown} is not supported.`, `${field}.${unknown}`);
}

function requiredKeys(value, required) {
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) fail('missing_field', `${missing} is required for ${value.action}.`, missing);
}

function managedId(value, field) {
  if (typeof value !== 'string' || byteLength(value) > ACP_SESSION_LIMITS.id_bytes || !SAFE_ID.test(value)) {
    fail('invalid_id', `${field} must be an opaque 8 to 128 byte managed identifier.`, field);
  }
  return value;
}

function fingerprint(value, field = 'expected_target_fingerprint') {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('invalid_target_fingerprint', `${field} must be exactly sha256: followed by 64 lowercase hexadecimal characters.`, field);
  }
  return value;
}

function role(value, field = 'role') {
  if (typeof value !== 'string' || !ROLES.has(value)) {
    fail('invalid_role', `${field} must be review, verify, or implement.`, field);
  }
  return value;
}

function validateRawTargetContext(value) {
  if (!isPlainObject(value)) fail('invalid_target_context', 'target_context must be an object.', 'target_context');
  if (value.schema_version !== TARGET_SCHEMA_VERSION) {
    fail('invalid_target_context', `target_context.schema_version must be ${TARGET_SCHEMA_VERSION}.`, 'target_context.schema_version');
  }
  if (value.mode !== 'default' && value.mode !== 'explicit') {
    fail('invalid_target_context', 'target_context.mode must be default or explicit.', 'target_context.mode');
  }
  const allowed = value.mode === 'default'
    ? ['schema_version', 'mode', 'allowed_paths', 'role']
    : ['schema_version', 'mode', 'working_directory', 'expected_git_root', 'expected_head', 'allowed_paths', 'role'];
  exactKeys(value, allowed, 'target_context');
  if (value.mode === 'explicit') {
    for (const key of ['working_directory', 'expected_git_root', 'expected_head', 'allowed_paths', 'role']) {
      if (!Object.hasOwn(value, key)) fail('invalid_target_context', `target_context.${key} is required in explicit mode.`, `target_context.${key}`);
    }
    if (typeof value.working_directory !== 'string' || value.working_directory.length === 0
      || typeof value.expected_git_root !== 'string' || value.expected_git_root.length === 0) {
      fail('invalid_target_context', 'explicit target paths must be non-empty strings.', 'target_context');
    }
    if (typeof value.expected_head !== 'string' || !/^[a-f0-9]{40}$/iu.test(value.expected_head)) {
      fail('invalid_target_context', 'target_context.expected_head must be a full Git revision.', 'target_context.expected_head');
    }
  }
  const requestedRole = value.role ?? 'review';
  if (value.mode === 'default' && requestedRole === 'implement') {
    fail('invalid_target_context', 'default target_context cannot request implement.', 'target_context.role');
  }
  role(requestedRole, 'target_context.role');
  const allowedPaths = value.allowed_paths ?? ['.'];
  if (!Array.isArray(allowedPaths) || allowedPaths.length < 1 || allowedPaths.length > 200
    || allowedPaths.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail('invalid_target_context', 'target_context.allowed_paths must contain 1 to 200 non-empty strings.', 'target_context.allowed_paths');
  }
  if (new Set(allowedPaths).size !== allowedPaths.length) {
    fail('invalid_target_context', 'target_context.allowed_paths must not contain duplicates.', 'target_context.allowed_paths');
  }
  return deepFreeze({ ...value, role: requestedRole, allowed_paths: [...allowedPaths] });
}

function authoritativeTarget(requestTarget, authoritative, expectedFingerprint, requestedRole) {
  if (!isPlainObject(authoritative) || !Object.hasOwn(authoritative, 'role')) {
    fail('target_authority_required', 'separately validated authoritative target_context with role is required.', 'authoritative_target_context');
  }
  const effective = role(authoritative.role, 'authoritative_target_context.role');
  if (requestedRole !== undefined && role(requestedRole) !== effective) {
    fail('role_escalation', 'request role must be omitted or exactly match authoritative target_context.role.', 'role');
  }
  const requestBinding = {
    schema_version: requestTarget.schema_version,
    mode: requestTarget.mode,
    role: requestTarget.role,
    allowed_paths: requestTarget.allowed_paths,
    ...(requestTarget.mode === 'explicit' ? {
      working_directory: requestTarget.working_directory,
      expected_git_root: requestTarget.expected_git_root,
      expected_head: requestTarget.expected_head.toLowerCase(),
    } : {}),
  };
  const authorityBinding = {
    schema_version: authoritative.schema_version,
    mode: authoritative.mode,
    role: effective,
    allowed_paths: authoritative.allowed_paths,
    ...(requestTarget.mode === 'explicit' ? {
      working_directory: authoritative.working_directory,
      expected_git_root: authoritative.expected_git_root,
      expected_head: typeof authoritative.expected_head === 'string'
        ? authoritative.expected_head.toLowerCase()
        : authoritative.expected_head,
    } : {}),
  };
  if (stableJson(requestBinding) !== stableJson(authorityBinding)) {
    fail('target_authority_mismatch', 'supplied target_context does not match separately validated target authority.', 'target_context');
  }
  if (!Object.hasOwn(authoritative, 'target_fingerprint')) {
    fail('target_authority_required', 'authoritative target_context must include its validated target_fingerprint.', 'authoritative_target_context.target_fingerprint');
  }
  const authoritativeFingerprint = fingerprint(
    authoritative.target_fingerprint,
    'authoritative_target_context.target_fingerprint',
  );
  if (authoritativeFingerprint !== expectedFingerprint) {
    fail('target_fingerprint_mismatch', 'expected_target_fingerprint does not match authoritative target identity.', 'expected_target_fingerprint');
  }
  return {
    role: effective,
    // Discard the caller's copy. All downstream target fields, including
    // resolved repository identity, come exclusively from preflight output.
    context: deepFreeze(cloneAuthority(authoritative)),
  };
}

function safeModel(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || byteLength(value) > 128 || !SAFE_MODEL.test(value)) {
    fail('invalid_config', 'config.model is not a supported bounded model identifier.', 'config.model');
  }
  return value;
}

function validateGrokConfig(input) {
  exactKeys(input, ['model', 'reasoning_effort', 'delegation'], 'config');
  if (input.reasoning_effort !== undefined
    && (typeof input.reasoning_effort !== 'string' || !GROK_REASONING.has(input.reasoning_effort))) {
    fail('invalid_config', 'config.reasoning_effort is not supported.', 'config.reasoning_effort');
  }
  if (input.delegation !== undefined && typeof input.delegation !== 'boolean') {
    fail('invalid_config', 'config.delegation must be a boolean.', 'config.delegation');
  }
  return Object.freeze({
    model: safeModel(input.model),
    reasoning_effort: input.reasoning_effort ?? null,
    delegation: input.delegation ?? null,
  });
}

function validateCursorConfig(input) {
  exactKeys(input, ['model', 'allowed_tools', 'max_turns'], 'config');
  let allowedTools = [];
  if (input.allowed_tools !== undefined) {
    if (!Array.isArray(input.allowed_tools) || input.allowed_tools.length > 32) {
      fail('invalid_config', 'config.allowed_tools must contain at most 32 tool identifiers.', 'config.allowed_tools');
    }
    allowedTools = input.allowed_tools.map((tool, index) => {
      if (typeof tool !== 'string' || byteLength(tool) > 96 || !SAFE_TOOL.test(tool)) {
        fail('invalid_config', `config.allowed_tools[${index}] is invalid.`, `config.allowed_tools[${index}]`);
      }
      return tool;
    });
    if (new Set(allowedTools).size !== allowedTools.length) {
      fail('invalid_config', 'config.allowed_tools must not contain duplicates.', 'config.allowed_tools');
    }
  }
  if (input.max_turns !== undefined
    && (!Number.isSafeInteger(input.max_turns) || input.max_turns < 1 || input.max_turns > 64)) {
    fail('invalid_config', 'config.max_turns must be an integer from 1 to 64.', 'config.max_turns');
  }
  return deepFreeze({
    model: safeModel(input.model),
    allowed_tools: allowedTools,
    max_turns: input.max_turns ?? null,
  });
}

export function validateAcpProviderConfig(provider, input = {}) {
  if (!PROVIDERS.has(provider)) fail('unsupported_provider', 'provider is not a supported local ACP profile.', 'provider');
  if (!isPlainObject(input)) fail('invalid_config', 'config must be an object.', 'config');
  return provider === 'grok-local-acp' ? validateGrokConfig(input) : validateCursorConfig(input);
}

function prompt(value) {
  if (typeof value !== 'string' || value.length === 0 || hasUnpairedSurrogate(value)) {
    fail('invalid_prompt', 'prompt must be non-empty valid Unicode text.', 'prompt');
  }
  if (value.includes('\u0000')) fail('invalid_prompt', 'prompt must not contain NUL.', 'prompt');
  if (byteLength(value) > ACP_SESSION_LIMITS.prompt_bytes) {
    fail('prompt_too_large', `prompt exceeds ${ACP_SESSION_LIMITS.prompt_bytes} UTF-8 bytes.`, 'prompt');
  }
  // CRLF is one physical line break; bare CR and bare LF each count as one.
  // Count code units directly so a line-count check cannot amplify memory.
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\r') {
      lines += 1;
      if (value[index + 1] === '\n') index += 1;
    } else if (value[index] === '\n') {
      lines += 1;
    }
  }
  if (lines > ACP_SESSION_LIMITS.prompt_lines) {
    fail('prompt_too_many_lines', `prompt exceeds ${ACP_SESSION_LIMITS.prompt_lines} lines.`, 'prompt');
  }
  return value;
}

function boundedInteger(value, field, minimum, maximum, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('invalid_page', `${field} must be an integer from ${minimum} to ${maximum}.`, field);
  }
  return value;
}

/** Validate one action request against separately resolved target authority. */
export function validateAcpSessionRequest(input, targetContext) {
  if (!isPlainObject(input)) fail('invalid_request', 'request must be an object.', 'request');
  if (input.schema_version !== ACP_SESSION_SCHEMA_VERSION) {
    fail('unsupported_schema', `schema_version must be ${ACP_SESSION_SCHEMA_VERSION}.`, 'schema_version');
  }
  if (typeof input.action !== 'string' || !ACTIONS.has(input.action)) {
    fail('unsupported_action', 'action is not supported.', 'action');
  }
  const action = input.action;
  exactKeys(input, ACTION_KEYS[action]);
  requiredKeys(input, ACTION_REQUIRED[action]);
  const requestTarget = validateRawTargetContext(input.target_context);
  const expectedFingerprint = fingerprint(input.expected_target_fingerprint);
  const authority = authoritativeTarget(requestTarget, targetContext, expectedFingerprint, input.role);
  const normalized = {
    schema_version: ACP_SESSION_SCHEMA_VERSION,
    action,
    role: authority.role,
    target_context: authority.context,
    expected_target_fingerprint: expectedFingerprint,
  };

  if (Object.hasOwn(input, 'provider')) {
    if (!PROVIDERS.has(input.provider)) fail('unsupported_provider', 'provider is not supported.', 'provider');
    normalized.provider = input.provider;
  }
  for (const field of ['session_id', 'turn_id', 'request_id']) {
    if (Object.hasOwn(input, field)) normalized[field] = managedId(input[field], field);
  }
  if (action === 'create' || action === 'config') {
    normalized.config = validateAcpProviderConfig(input.provider, input.config ?? {});
  }
  if (action === 'prompt') normalized.prompt = prompt(input.prompt);
  if (action === 'stream') {
    normalized.after_seq = boundedInteger(input.after_seq, 'after_seq', 0, Number.MAX_SAFE_INTEGER);
    normalized.max_events = boundedInteger(input.max_events, 'max_events', 1, ACP_SESSION_LIMITS.stream_events, ACP_SESSION_LIMITS.stream_events);
    normalized.max_bytes = boundedInteger(input.max_bytes, 'max_bytes', 1, ACP_SESSION_LIMITS.stream_bytes, ACP_SESSION_LIMITS.stream_bytes);
  }
  return deepFreeze(normalized);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Produce replay/deduplication material without retaining prompt text.
 * Callers persist only the returned fingerprint/material. The ephemeral
 * normalized request must be discarded after dispatch.
 */
export function acpSessionRequestFingerprint(input) {
  if (!isPlainObject(input) || !ACTIONS.has(input.action)) {
    fail('invalid_request', 'a validated ACP session request is required for fingerprinting.');
  }
  // request_id selects the idempotency slot; it does not change provider
  // behavior. Every other normalized field is effect-bearing and therefore
  // participates. Prompt text is replaced with its digest before material is
  // returned, so callers never need to persist the ephemeral body.
  const material = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'request_id' && key !== 'prompt'),
  );
  if (input.action === 'prompt') material.prompt_digest = sha256Text(input.prompt);
  return deepFreeze({
    fingerprint: sha256Text(stableJson(material)),
    material,
  });
}

export function isAcpSessionMutation(value) {
  const action = typeof value === 'string' ? value : value?.action;
  return typeof action === 'string' && MUTATIONS.has(action);
}

const ID_SCHEMA = Object.freeze({ type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' });
const DIGEST_SCHEMA = Object.freeze({ type: 'string', pattern: '^sha256:[a-f0-9]{64}$' });
const ROLE_SCHEMA = Object.freeze({ type: 'string', enum: Object.freeze(['review', 'verify', 'implement']) });
const ALLOWED_PATHS_SCHEMA = deepFreeze({
  type: 'array',
  minItems: 1,
  maxItems: 200,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
});
export const ACP_TARGET_CONTEXT_INPUT_SCHEMA = deepFreeze({
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { const: TARGET_SCHEMA_VERSION },
        mode: { const: 'default' },
        allowed_paths: ALLOWED_PATHS_SCHEMA,
        role: { type: 'string', enum: ['review', 'verify'] },
      },
      required: ['schema_version', 'mode'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema_version: { const: TARGET_SCHEMA_VERSION },
        mode: { const: 'explicit' },
        working_directory: { type: 'string', minLength: 1 },
        expected_git_root: { type: 'string', minLength: 1 },
        expected_head: { type: 'string', pattern: '^[a-fA-F0-9]{40}$' },
        allowed_paths: ALLOWED_PATHS_SCHEMA,
        role: ROLE_SCHEMA,
      },
      required: ['schema_version', 'mode', 'working_directory', 'expected_git_root', 'expected_head', 'allowed_paths', 'role'],
    },
  ],
  description: 'Existing Co-Engineer target_context v1 contract. The normal target preflight remains authoritative for path and Git identity validation.',
});
const MODEL_SCHEMA = Object.freeze({ type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$' });
const GROK_CONFIG_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    model: MODEL_SCHEMA,
    reasoning_effort: { type: 'string', enum: [...GROK_REASONING] },
    delegation: { type: 'boolean' },
  },
});
const CURSOR_CONFIG_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    model: MODEL_SCHEMA,
    allowed_tools: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 96, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,95}$' },
    },
    max_turns: { type: 'integer', minimum: 1, maximum: 64 },
  },
});

function actionJsonSchema(action) {
  const properties = {
    schema_version: { const: ACP_SESSION_SCHEMA_VERSION },
    action: { const: action },
    role: ROLE_SCHEMA,
  };
  for (const key of ACTION_KEYS[action]) {
    if (Object.hasOwn(properties, key)) continue;
    if (['session_id', 'turn_id', 'request_id'].includes(key)) properties[key] = ID_SCHEMA;
    else if (key === 'provider') properties[key] = { type: 'string', enum: ACP_SESSION_PROVIDERS };
    else if (key === 'target_context') properties[key] = ACP_TARGET_CONTEXT_INPUT_SCHEMA;
    else if (key === 'expected_target_fingerprint') properties[key] = DIGEST_SCHEMA;
    else if (key === 'prompt') properties[key] = {
      type: 'string',
      minLength: 1,
      // JSON Schema maxLength counts Unicode characters, not encoded bytes.
      // This is a necessary conservative ceiling; the model-visible metadata
      // below names the authoritative runtime checks explicitly.
      maxLength: ACP_SESSION_LIMITS.prompt_bytes,
      contentMediaType: 'text/plain; charset=utf-8',
      description: 'Ephemeral prompt. validateAcpSessionRequest is authoritative and enforces non-empty valid Unicode, no NUL or unpaired surrogate, at most 65536 UTF-8 bytes, and at most 2000 physical lines (CRLF is one break; CR or LF is one break).',
      'x-content-encoding': 'utf-8',
      'x-authoritative-validator': 'validateAcpSessionRequest',
      'x-max-utf8-bytes': ACP_SESSION_LIMITS.prompt_bytes,
      'x-max-physical-lines': ACP_SESSION_LIMITS.prompt_lines,
      'x-reject-nul': true,
      'x-reject-unpaired-surrogates': true,
    };
    else if (key === 'config') properties[key] = { type: 'object' };
    else if (key === 'after_seq') properties[key] = { type: 'integer', minimum: 0 };
    else if (key === 'max_events') properties[key] = { type: 'integer', minimum: 1, maximum: ACP_SESSION_LIMITS.stream_events };
    else if (key === 'max_bytes') properties[key] = { type: 'integer', minimum: 1, maximum: ACP_SESSION_LIMITS.stream_bytes };
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...ACTION_REQUIRED[action]],
  };
  if (action === 'create' || action === 'config') {
    schema.allOf = [
      {
        if: { properties: { provider: { const: 'grok-local-acp' } }, required: ['provider'] },
        then: { properties: { config: GROK_CONFIG_SCHEMA } },
      },
      {
        if: { properties: { provider: { const: 'cursor-local-acp' } }, required: ['provider'] },
        then: { properties: { config: CURSOR_CONFIG_SCHEMA } },
      },
    ];
  }
  return schema;
}

export const ACP_SESSION_INPUT_SCHEMA = deepFreeze({
  description: 'Strict ACP session action union. validateAcpSessionRequest is the authoritative boundary validator for exact keys, UTF-8 byte and physical-line limits, Unicode validity, role authority, and provider-discriminated configuration.',
  'x-authoritative-validator': 'validateAcpSessionRequest',
  oneOf: ACP_SESSION_ACTIONS.map(actionJsonSchema),
});

function publicEvent(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.seq) || value.seq < 0) {
    fail('invalid_response', 'stream events must have a non-negative safe integer seq.', 'events');
  }
  const event = {
    seq: value.seq,
    type: typeof value.type === 'string' && PUBLIC_EVENT_TYPES.has(value.type) ? value.type : 'status',
  };
  // Provider-originated text is intentionally not projected by this generic
  // boundary. A later integration may expose separately normalized/redacted
  // content, but syntax checks are not a credential or path privacy boundary.
  if (typeof value.truncated === 'boolean') event.truncated = value.truncated;
  return event;
}

/** Project internal results onto a bounded, provider-opaque public response. */
export function projectAcpSessionResponse(action, value = {}) {
  if (!ACTIONS.has(action) || !isPlainObject(value)) fail('invalid_response', 'response projection requires a supported action and object.');
  const output = { schema_version: ACP_SESSION_SCHEMA_VERSION, action };
  for (const field of ['session_id', 'turn_id', 'request_id']) {
    if (value[field] !== undefined) output[field] = managedId(value[field], field);
  }
  for (const field of ['state', 'status']) {
    if (PUBLIC_STATES.has(value[field])) output[field] = value[field];
  }
  if (PUBLIC_ERROR_CODES.has(value.error_code)) output.error_code = value.error_code;
  if (value.provider !== undefined) {
    if (!PROVIDERS.has(value.provider)) {
      fail('invalid_response', 'response provider must be a supported public provider identifier.', 'provider');
    }
    output.provider = value.provider;
  }
  if (action === 'stream') {
    output.after_seq = boundedInteger(value.after_seq ?? 0, 'after_seq', 0, Number.MAX_SAFE_INTEGER);
    const sourceEvents = Array.isArray(value.events) ? value.events : [];
    let previousSeq = output.after_seq;
    for (let index = 0; index < sourceEvents.length; index += 1) {
      const candidate = sourceEvents[index];
      if (!isPlainObject(candidate) || !Number.isSafeInteger(candidate.seq) || candidate.seq < 0) {
        fail('invalid_response', `events[${index}] must have a non-negative safe integer seq.`, `events[${index}].seq`);
      }
      if (candidate.seq <= previousSeq) {
        fail(
          'invalid_response_cursor',
          `events[${index}].seq must be greater than after_seq and strictly increasing.`,
          `events[${index}].seq`,
        );
      }
      previousSeq = candidate.seq;
    }
    const upstreamNextSeq = boundedInteger(value.next_seq ?? previousSeq, 'next_seq', 0, Number.MAX_SAFE_INTEGER);
    if (upstreamNextSeq < previousSeq || upstreamNextSeq < output.after_seq) {
      fail('invalid_response_cursor', 'next_seq must not precede after_seq or the final event seq.', 'next_seq');
    }
    output.has_more = value.has_more === true
      || sourceEvents.length > ACP_SESSION_LIMITS.stream_events
      || upstreamNextSeq > previousSeq;
    output.events = [];
    for (const candidate of sourceEvents.slice(0, ACP_SESSION_LIMITS.stream_events)) {
      const event = publicEvent(candidate);
      output.events.push(event);
      if (byteLength(JSON.stringify(output)) > ACP_SESSION_LIMITS.stream_bytes) {
        output.events.pop();
        output.has_more = true;
        break;
      }
    }
    // Never expose an upstream cursor beyond events actually returned. A
    // client may safely pass this value back without skipping truncated data.
    output.next_seq = output.events.at(-1)?.seq ?? output.after_seq;
    if (output.next_seq < upstreamNextSeq || output.events.length < sourceEvents.length) {
      output.has_more = true;
    }
  }
  return deepFreeze(output);
}
