export const MAX_PROMPT_CHARS = 40_000;
export const MAX_NAME_CHARS = 100;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGES = 5;
export const MAX_REPOS = 20;
export const MAX_ENV_VARS = 50;
export const MAX_MCP_SERVERS = 50;
export const MAX_MCP_SCOPES = 50;
export const MAX_SUBAGENTS = 20;
export const MAX_PAGE_SIZE = 100;
export const AGENT_ID_PATTERN = /^bc-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const RUN_ID_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
export const RESERVED_SUBAGENT_NAMES = Object.freeze([
  'explore',
  'shell',
  'debug',
  'computerUse',
  'cursorGuide',
]);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
// OAuth 2.0 scope-token: printable ASCII except DQUOTE and backslash. The
// reference schema still carries only environment variable names; this check
// applies after the MCP process resolves each value.
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/;

export class InputError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, details) {
  throw new InputError('invalid_input', message, details);
}

function object(value, path = 'arguments') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
  return value;
}

function unknown(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not supported for this action.`);
  }
}

function required(value, fields, path = 'arguments') {
  for (const field of fields) {
    if (value[field] === undefined || value[field] === null) fail(`${path}.${field} is required.`);
  }
}

function string(value, path, { min = 0, max = 1000, pattern, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${path} must be a string of ${min}-${max} characters.`);
  }
  if (pattern && !pattern.test(value)) fail(`${path} has an invalid format.`);
  return value;
}

function boolean(value, path, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') fail(`${path} must be a boolean.`);
  return value;
}

function integer(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${path} must be an integer between ${min} and ${max}.`);
  return value;
}

function url(value, path, { github = false } = {}) {
  string(value, path, { min: 1, max: 2048 });
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${path} must be a valid URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail(`${path} must be an http(s) URL without embedded credentials.`);
  }
  if (github && parsed.hostname.toLowerCase() !== 'github.com') {
    fail(`${path} must point to github.com.`);
  }
  if (github && (parsed.search || parsed.hash)) {
    fail(`${path} must not include a query or fragment.`);
  }
  return parsed.toString();
}

function id(value, path, kind = 'agent') {
  const pattern = kind === 'run' ? RUN_ID_PATTERN : AGENT_ID_PATTERN;
  return string(value, path, { min: 3, max: 128, pattern });
}

function requestId(value, path = 'arguments.requestId', optional = true) {
  return string(value, path, { min: 8, max: 128, pattern: REQUEST_ID_PATTERN, optional });
}

function pageFields(value, { includeArchived = false } = {}) {
  const allowed = includeArchived ? ['action', 'limit', 'cursor', 'prUrl', 'includeArchived'] : ['action', 'limit', 'cursor'];
  unknown(value, allowed, 'arguments');
  integer(value.limit, 'arguments.limit', { min: 1, max: MAX_PAGE_SIZE, optional: true });
  string(value.cursor, 'arguments.cursor', { min: 1, max: 512, optional: true });
  if (includeArchived) {
    if (value.prUrl !== undefined) url(value.prUrl, 'arguments.prUrl', { github: true });
    boolean(value.includeArchived, 'arguments.includeArchived', true);
  }
}

function image(value, path) {
  object(value, path);
  unknown(value, ['data', 'mimeType', 'url', 'dimension'], path);
  const hasData = value.data !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasData === hasUrl) fail(`${path} must contain exactly one of data or url.`);
  if (hasData) {
    string(value.data, `${path}.data`, { min: 4, max: Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 });
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value.data)) fail(`${path}.data must be base64 data.`);
    string(value.mimeType, `${path}.mimeType`, { min: 1, max: 100 });
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.mimeType)) {
      fail(`${path}.mimeType is not supported.`);
    }
  } else {
    if (value.mimeType !== undefined) fail(`${path}.mimeType must be omitted when url is provided.`);
    url(value.url, `${path}.url`);
  }
  if (value.dimension !== undefined) {
    object(value.dimension, `${path}.dimension`);
    unknown(value.dimension, ['width', 'height'], `${path}.dimension`);
    required(value.dimension, ['width', 'height'], `${path}.dimension`);
    integer(value.dimension.width, `${path}.dimension.width`, { min: 1 });
    integer(value.dimension.height, `${path}.dimension.height`, { min: 1 });
  }
}

function prompt(value, path = 'arguments.prompt') {
  object(value, path);
  unknown(value, ['text', 'images'], path);
  required(value, ['text'], path);
  string(value.text, `${path}.text`, { min: 1, max: MAX_PROMPT_CHARS });
  if (value.images !== undefined) {
    if (!Array.isArray(value.images) || value.images.length > MAX_IMAGES) fail(`${path}.images must contain at most ${MAX_IMAGES} images.`);
    value.images.forEach((entry, index) => image(entry, `${path}.images[${index}]`));
  }
}

function model(value, path = 'arguments.model', optional = true) {
  if (value === undefined && optional) return;
  object(value, path);
  unknown(value, ['id', 'params'], path);
  required(value, ['id'], path);
  string(value.id, `${path}.id`, { min: 1, max: 200 });
  if (value.params !== undefined) {
    if (!Array.isArray(value.params) || value.params.length > 50) fail(`${path}.params must contain at most 50 entries.`);
    const seen = new Set();
    value.params.forEach((entry, index) => {
      object(entry, `${path}.params[${index}]`);
      unknown(entry, ['id', 'value'], `${path}.params[${index}]`);
      required(entry, ['id', 'value'], `${path}.params[${index}]`);
      string(entry.id, `${path}.params[${index}].id`, { min: 1, max: 100 });
      string(entry.value, `${path}.params[${index}].value`, { min: 1, max: 1000 });
      if (seen.has(entry.id)) fail(`${path}.params contains a duplicate id.`);
      seen.add(entry.id);
    });
  }
}

function envVars(value, path = 'arguments.envVars') {
  if (value === undefined) return;
  object(value, path);
  const names = Object.keys(value);
  if (names.length > MAX_ENV_VARS) fail(`${path} may contain at most ${MAX_ENV_VARS} entries.`);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name) || name.startsWith('CURSOR_')) {
      fail(`${path} contains an invalid or reserved variable name.`);
    }
    string(value[name], `${path}.${name}`, { min: 1, max: 4096 });
  }
}

function safeHeaderName(value, path) {
  string(value, path, { min: 1, max: 128 });
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) fail(`${path} is not a valid header name.`);
  if (/authorization|cookie|token|secret|password|api[-_]?key/i.test(value)) {
    fail(`${path} is a credential-bearing header and cannot be supplied.`);
  }
}

function headerName(value, path) {
  string(value, path, { min: 1, max: 128 });
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) fail(`${path} is not a valid header name.`);
  return value;
}

function envReference(value, path) {
  string(value, path, { min: 1, max: 255, pattern: ENV_NAME_PATTERN });
  if (value.startsWith('CURSOR_')) fail(`${path} uses a reserved environment variable name.`);
  return value;
}

function authEnv(value, path) {
  object(value, path);
  unknown(value, ['CLIENT_ID', 'CLIENT_SECRET', 'scopes'], path);
  required(value, ['CLIENT_ID'], path);
  envReference(value.CLIENT_ID, `${path}.CLIENT_ID`);
  if (value.CLIENT_SECRET !== undefined) envReference(value.CLIENT_SECRET, `${path}.CLIENT_SECRET`);
  if (value.scopes !== undefined) {
    if (!Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > MAX_MCP_SCOPES) {
      fail(`${path}.scopes must contain 1-${MAX_MCP_SCOPES} environment variable references.`);
    }
    value.scopes.forEach((scope, index) => envReference(scope, `${path}.scopes[${index}]`));
  }
}

function headerEnv(value, path) {
  object(value, path);
  const names = Object.keys(value);
  if (names.length > 50) fail(`${path} is too large.`);
  const seen = new Set();
  for (const [headerNameValue, envName] of Object.entries(value)) {
    headerName(headerNameValue, `${path}.${headerNameValue}`);
    const normalized = headerNameValue.toLowerCase();
    if (seen.has(normalized)) fail(`${path} contains duplicate header names.`);
    seen.add(normalized);
    envReference(envName, `${path}.${headerNameValue}`);
  }
}

function mcpEnvironmentReferences(entry, path) {
  const refs = new Set();
  const add = (value, refPath) => {
    if (refs.has(value)) fail(`${refPath} duplicates another secret environment reference.`);
    refs.add(value);
  };
  if (entry.authEnv) {
    add(entry.authEnv.CLIENT_ID, `${path}.authEnv.CLIENT_ID`);
    if (entry.authEnv.CLIENT_SECRET !== undefined) add(entry.authEnv.CLIENT_SECRET, `${path}.authEnv.CLIENT_SECRET`);
    for (const [index, scope] of (entry.authEnv.scopes ?? []).entries()) add(scope, `${path}.authEnv.scopes[${index}]`);
  }
  for (const [headerNameValue, envName] of Object.entries(entry.headerEnv ?? {})) {
    add(envName, `${path}.headerEnv.${headerNameValue}`);
  }
}

function mcpServers(value, path = 'arguments.mcpServers') {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) fail(`${path} must contain at most ${MAX_MCP_SERVERS} servers.`);
  const names = new Set();
  value.forEach((entry, index) => {
    const base = `${path}[${index}]`;
    object(entry, base);
    unknown(entry, ['name', 'type', 'url', 'command', 'args', 'env', 'headers', 'authEnv', 'headerEnv'], base);
    required(entry, ['name'], base);
    string(entry.name, `${base}.name`, { min: 1, max: 100 });
    if (names.has(entry.name)) fail(`${base}.name must be unique.`);
    names.add(entry.name);
    const type = entry.type ?? (entry.url ? 'http' : 'stdio');
    if (!['http', 'sse', 'stdio'].includes(type)) fail(`${base}.type must be http, sse, or stdio.`);
    if (type === 'stdio') {
      required(entry, ['command'], base);
      string(entry.command, `${base}.command`, { min: 1, max: 512 });
      if (entry.url !== undefined) fail(`${base}.url is not valid for a stdio server.`);
      if (entry.headers !== undefined) fail(`${base}.headers is not valid for a stdio server.`);
      if (entry.authEnv !== undefined) fail(`${base}.authEnv is not valid for a stdio server.`);
      if (entry.headerEnv !== undefined) fail(`${base}.headerEnv is not valid for a stdio server.`);
      if (entry.args !== undefined) {
        if (!Array.isArray(entry.args) || entry.args.length > 100) fail(`${base}.args is too large.`);
        entry.args.forEach((arg, argIndex) => string(arg, `${base}.args[${argIndex}]`, { max: 1000 }));
      }
      if (entry.env !== undefined) envVars(entry.env, `${base}.env`);
    } else {
      required(entry, ['url'], base);
      url(entry.url, `${base}.url`);
      if (entry.command !== undefined || entry.args !== undefined || entry.env !== undefined) {
        fail(`${base} remote servers cannot include stdio fields.`);
      }
      if (entry.headers !== undefined) {
        object(entry.headers, `${base}.headers`);
        if (Object.keys(entry.headers).length > 50) fail(`${base}.headers is too large.`);
        const literalHeaderNames = new Set();
        for (const [headerName, headerValue] of Object.entries(entry.headers)) {
          safeHeaderName(headerName, `${base}.headers.${headerName}`);
          const normalizedHeaderName = headerName.toLowerCase();
          if (literalHeaderNames.has(normalizedHeaderName)) fail(`${base}.headers contains duplicate header names.`);
          literalHeaderNames.add(normalizedHeaderName);
          string(headerValue, `${base}.headers.${headerName}`, { max: 4096 });
          if (/bearer\s|basic\s|token|secret|password|api[-_]?key|crsr_/i.test(headerValue)) {
            fail(`${base}.headers contains a likely credential.`);
          }
        }
      }
      if (entry.authEnv !== undefined) authEnv(entry.authEnv, `${base}.authEnv`);
      if (entry.headerEnv !== undefined) {
        headerEnv(entry.headerEnv, `${base}.headerEnv`);
        const literalHeaders = new Set(Object.keys(entry.headers ?? {}).map((name) => name.toLowerCase()));
        for (const headerNameValue of Object.keys(entry.headerEnv)) {
          if (literalHeaders.has(headerNameValue.toLowerCase())) {
            fail(`${base}.headerEnv.${headerNameValue} conflicts with a literal header.`);
          }
        }
      }
      if (entry.authEnv !== undefined || entry.headerEnv !== undefined) mcpEnvironmentReferences(entry, base);
    }
  });
}

function resolveEnvironmentValue(name, env, path) {
  const value = env?.[name];
  if (typeof value !== 'string' || !value.trim()) fail(`${path} references a missing or empty environment variable.`);
  return value;
}

function resolveScopeValue(name, env, path) {
  const value = resolveEnvironmentValue(name, env, path);
  if (!SCOPE_PATTERN.test(value)) fail(`${path} resolved to an invalid OAuth scope.`);
  return value;
}

/**
 * Resolve the intentionally small secret-reference wrapper into Cursor's
 * documented remote MCP shape. The input is already structurally validated;
 * this function only reads the MCP process environment and returns a copy.
 */
export function materializeMcpServers(value, env = process.env) {
  if (value === undefined) return { servers: undefined, secrets: [] };
  const secrets = [];
  const addSecret = (secret) => { if (!secrets.includes(secret)) secrets.push(secret); };
  const servers = value.map((entry, index) => {
    const base = `arguments.mcpServers[${index}]`;
    if (entry.type === 'stdio' || (!entry.type && !entry.url)) return { ...entry };
    const materialized = { ...entry };
    delete materialized.authEnv;
    delete materialized.headerEnv;
    if (entry.authEnv !== undefined) {
      const auth = {
        CLIENT_ID: resolveEnvironmentValue(entry.authEnv.CLIENT_ID, env, `${base}.authEnv.CLIENT_ID`),
      };
      addSecret(auth.CLIENT_ID);
      if (entry.authEnv.CLIENT_SECRET !== undefined) {
        auth.CLIENT_SECRET = resolveEnvironmentValue(entry.authEnv.CLIENT_SECRET, env, `${base}.authEnv.CLIENT_SECRET`);
        addSecret(auth.CLIENT_SECRET);
      }
      if (entry.authEnv.scopes !== undefined) {
        auth.scopes = entry.authEnv.scopes.map((name, scopeIndex) => {
          const scope = resolveScopeValue(name, env, `${base}.authEnv.scopes[${scopeIndex}]`);
          addSecret(scope);
          return scope;
        });
      }
      materialized.auth = auth;
    }
    if (entry.headerEnv !== undefined) {
      materialized.headers = { ...(entry.headers ?? {}) };
      for (const [headerNameValue, envName] of Object.entries(entry.headerEnv)) {
        const headerValue = resolveEnvironmentValue(envName, env, `${base}.headerEnv.${headerNameValue}`);
        addSecret(headerValue);
        materialized.headers[headerNameValue] = headerValue;
      }
    }
    return materialized;
  });
  return { servers, secrets };
}

function repo(value, path) {
  object(value, path);
  unknown(value, ['url', 'startingRef', 'prUrl'], path);
  required(value, ['url'], path);
  url(value.url, `${path}.url`, { github: true });
  if (value.startingRef !== undefined) string(value.startingRef, `${path}.startingRef`, { min: 1, max: 200 });
  if (value.prUrl !== undefined) url(value.prUrl, `${path}.prUrl`, { github: true });
}

function repos(value, path = 'arguments.repos') {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_REPOS) fail(`${path} must contain at most ${MAX_REPOS} repositories.`);
  value.forEach((entry, index) => repo(entry, `${path}[${index}]`));
}

function subagents(value, path = 'arguments.customSubagents') {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_SUBAGENTS) fail(`${path} must contain at most ${MAX_SUBAGENTS} entries.`);
  const names = new Set();
  const reserved = new Set(RESERVED_SUBAGENT_NAMES);
  value.forEach((entry, index) => {
    const base = `${path}[${index}]`;
    object(entry, base);
    unknown(entry, ['name', 'description', 'prompt', 'model'], base);
    required(entry, ['name', 'description', 'prompt'], base);
    string(entry.name, `${base}.name`, { min: 1, max: 100 });
    if (reserved.has(entry.name) || names.has(entry.name)) fail(`${base}.name is reserved or duplicated.`);
    names.add(entry.name);
    string(entry.description, `${base}.description`, { min: 1, max: 1000 });
    string(entry.prompt, `${base}.prompt`, { min: 1, max: 8192 });
    if (entry.model !== undefined) {
      if (entry.model === 'inherit') string(entry.model, `${base}.model`, { min: 7, max: 7 });
      else if (typeof entry.model === 'string') string(entry.model, `${base}.model`, { min: 1, max: 200 });
      else model(entry.model, `${base}.model`, false);
    }
  });
}

function validateCreate(value) {
  const allowed = [
    'action', 'requestId', 'prompt', 'model', 'name', 'env', 'repos',
    'workOnCurrentBranch', 'autoCreatePR', 'skipReviewerRequest', 'envVars',
    'mcpServers', 'customSubagents', 'mode', 'agentId',
  ];
  unknown(value, allowed, 'arguments');
  required(value, ['requestId', 'prompt'], 'arguments');
  prompt(value.prompt);
  model(value.model);
  if (value.name !== undefined) string(value.name, 'arguments.name', { min: 1, max: MAX_NAME_CHARS });
  if (value.env !== undefined) {
    object(value.env, 'arguments.env');
    unknown(value.env, ['type', 'name'], 'arguments.env');
    required(value.env, ['type'], 'arguments.env');
    if (!['cloud', 'pool', 'machine'].includes(value.env.type)) fail('arguments.env.type must be cloud, pool, or machine.');
    if (value.env.name !== undefined) string(value.env.name, 'arguments.env.name', { min: 1, max: 200 });
  }
  repos(value.repos);
  if (value.env?.type === 'cloud' && value.env.name !== undefined && value.repos !== undefined) {
    fail('A named Cursor-hosted cloud environment cannot be combined with explicit repos.');
  }
  boolean(value.workOnCurrentBranch, 'arguments.workOnCurrentBranch', true);
  boolean(value.autoCreatePR, 'arguments.autoCreatePR', true);
  boolean(value.skipReviewerRequest, 'arguments.skipReviewerRequest', true);
  envVars(value.envVars);
  mcpServers(value.mcpServers);
  subagents(value.customSubagents);
  if (value.mode !== undefined && !['agent', 'plan'].includes(value.mode)) fail('arguments.mode must be agent or plan.');
  if (value.agentId !== undefined) id(value.agentId, 'arguments.agentId');
  requestId(value.requestId);
  if (value.skipReviewerRequest !== undefined && value.autoCreatePR !== true) {
    fail('arguments.skipReviewerRequest is only valid when autoCreatePR is true.');
  }
  if (value.agentId !== undefined && value.envVars !== undefined) {
    fail('arguments.agentId cannot be combined with envVars according to the Cursor API.');
  }
  if (value.repos !== undefined && (value.mode ?? 'plan') === 'agent') {
    for (const [index, entry] of value.repos.entries()) {
      if (entry.prUrl !== undefined) {
        fail(`arguments.repos[${index}].prUrl cannot be used for mode agent because Cursor ignores startingRef for PR targets; use plan mode or an immutable repository ref.`);
      }
      if (!COMMIT_PATTERN.test(entry.startingRef ?? '')) {
        fail(`arguments.repos[${index}].startingRef must be an immutable 40-character commit when mode is agent.`);
      }
    }
  }
  return value;
}

function validateFollowup(value) {
  const allowed = ['action', 'requestId', 'agentId', 'prompt', 'mcpServers', 'mode'];
  unknown(value, allowed, 'arguments');
  required(value, ['requestId', 'agentId', 'prompt'], 'arguments');
  id(value.agentId, 'arguments.agentId');
  prompt(value.prompt);
  mcpServers(value.mcpServers);
  if (value.mode !== undefined && !['agent', 'plan'].includes(value.mode)) fail('arguments.mode must be agent or plan.');
  requestId(value.requestId);
  return value;
}

function validateAction(value, actions, path = 'arguments.action') {
  if (!actions.includes(value.action)) fail(`${path} must be one of ${actions.join(', ')}.`);
}

const IMAGE_DIMENSION_SCHEMA = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  },
  required: ['width', 'height'],
  additionalProperties: false,
};

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    data: { type: 'string', minLength: 4, maxLength: Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8, pattern: '^[A-Za-z0-9+/=_-]+$' },
    mimeType: { type: 'string', minLength: 1, maxLength: 100, enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    dimension: IMAGE_DIMENSION_SCHEMA,
  },
  oneOf: [
    { required: ['data', 'mimeType'], not: { required: ['url'] } },
    { required: ['url'], not: { anyOf: [{ required: ['data'] }, { required: ['mimeType'] }] } },
  ],
  additionalProperties: false,
};

const PROMPT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CHARS },
    images: { type: 'array', maxItems: MAX_IMAGES, items: IMAGE_SCHEMA },
  },
  required: ['text'],
  additionalProperties: false,
};

const MODEL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    params: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          value: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['id', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['id'],
  additionalProperties: false,
};

const ENV_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['cloud', 'pool', 'machine'] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['type'],
  additionalProperties: false,
};

const REPO_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    startingRef: { type: 'string', minLength: 1, maxLength: 200 },
    prUrl: { type: 'string', format: 'uri', maxLength: 2048 },
  },
  required: ['url'],
  additionalProperties: false,
};

const ENV_VARS_SCHEMA = {
  type: 'object',
  maxProperties: MAX_ENV_VARS,
  patternProperties: { '^[A-Za-z_][A-Za-z0-9_]{0,254}$': { type: 'string', minLength: 1, maxLength: 4096 } },
  additionalProperties: false,
};

const HEADER_SCHEMA = {
  type: 'object',
  maxProperties: 50,
  patternProperties: { "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$": { type: 'string', maxLength: 4096 } },
  additionalProperties: false,
};

const ENV_REFERENCE_SCHEMA = { type: 'string', minLength: 1, maxLength: 255, pattern: ENV_NAME_PATTERN.source };

const AUTH_ENV_SCHEMA = {
  type: 'object',
  properties: {
    CLIENT_ID: ENV_REFERENCE_SCHEMA,
    CLIENT_SECRET: ENV_REFERENCE_SCHEMA,
    scopes: { type: 'array', minItems: 1, maxItems: MAX_MCP_SCOPES, items: ENV_REFERENCE_SCHEMA },
  },
  required: ['CLIENT_ID'],
  additionalProperties: false,
};

const HEADER_ENV_SCHEMA = {
  type: 'object',
  maxProperties: 50,
  patternProperties: { "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$": ENV_REFERENCE_SCHEMA },
  additionalProperties: false,
};

const MCP_SERVER_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    type: { type: 'string', enum: ['http', 'sse', 'stdio'] },
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    command: { type: 'string', minLength: 1, maxLength: 512 },
    args: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
    env: ENV_VARS_SCHEMA,
    headers: HEADER_SCHEMA,
    authEnv: AUTH_ENV_SCHEMA,
    headerEnv: HEADER_ENV_SCHEMA,
  },
  required: ['name'],
  additionalProperties: false,
};

const MODEL_REFERENCE_SCHEMA = {
  anyOf: [
    { type: 'string', minLength: 1, maxLength: 200 },
    MODEL_SCHEMA,
  ],
};

const SUBAGENT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    prompt: { type: 'string', minLength: 1, maxLength: 8192 },
    model: MODEL_REFERENCE_SCHEMA,
  },
  required: ['name', 'description', 'prompt'],
  not: { properties: { name: { enum: RESERVED_SUBAGENT_NAMES } } },
  additionalProperties: false,
};

const REPOS_SCHEMA = { type: 'array', maxItems: MAX_REPOS, items: REPO_SCHEMA };
const MCP_SERVERS_SCHEMA = { type: 'array', maxItems: MAX_MCP_SERVERS, items: MCP_SERVER_SCHEMA };
const SUBAGENTS_SCHEMA = { type: 'array', maxItems: MAX_SUBAGENTS, items: SUBAGENT_SCHEMA };

export const TOOL_SCHEMAS = Object.freeze({
  status: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['local', 'identity', 'models', 'repositories'] },
      limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
      detail: { type: 'boolean' },
      refresh: { type: 'boolean' },
    },
    oneOf: [
      { properties: { action: { const: 'local' } }, required: [], additionalProperties: false },
      { properties: { action: { const: 'identity' } }, required: ['action'], additionalProperties: false },
      { properties: { action: { const: 'models' }, limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }, detail: { type: 'boolean' }, refresh: { type: 'boolean' } }, required: ['action'], additionalProperties: false },
      { properties: { action: { const: 'repositories' }, limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE } }, required: ['action'], additionalProperties: false },
    ],
    additionalProperties: false,
    description: 'Local configuration or safe read-only identity/model/repository discovery. Defaults to local.',
  },
  agents: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create'] },
      requestId: { type: 'string', pattern: REQUEST_ID_PATTERN.source },
      agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source },
      prompt: PROMPT_SCHEMA, model: MODEL_SCHEMA, name: { type: 'string', maxLength: 100 },
      env: ENV_SCHEMA, repos: REPOS_SCHEMA,
      workOnCurrentBranch: { type: 'boolean' }, autoCreatePR: { type: 'boolean' }, skipReviewerRequest: { type: 'boolean' },
      envVars: ENV_VARS_SCHEMA, mcpServers: MCP_SERVERS_SCHEMA,
      customSubagents: SUBAGENTS_SCHEMA, mode: { type: 'string', enum: ['agent', 'plan'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', minLength: 1, maxLength: 512 },
      prUrl: { type: 'string', format: 'uri' }, includeArchived: { type: 'boolean' },
    },
    oneOf: [
      { properties: { action: { const: 'list' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', minLength: 1, maxLength: 512 }, prUrl: { type: 'string', format: 'uri' }, includeArchived: { type: 'boolean' } }, required: ['action'], additionalProperties: false },
      { properties: { action: { const: 'get' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source } }, required: ['action', 'agentId'], additionalProperties: false },
      { properties: { action: { const: 'create' }, requestId: { type: 'string', pattern: REQUEST_ID_PATTERN.source }, prompt: PROMPT_SCHEMA, model: MODEL_SCHEMA, name: { type: 'string', maxLength: 100 }, env: ENV_SCHEMA, repos: REPOS_SCHEMA, workOnCurrentBranch: { type: 'boolean' }, autoCreatePR: { type: 'boolean' }, skipReviewerRequest: { type: 'boolean' }, envVars: ENV_VARS_SCHEMA, mcpServers: MCP_SERVERS_SCHEMA, customSubagents: SUBAGENTS_SCHEMA, mode: { type: 'string', enum: ['agent', 'plan'] }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source } }, required: ['action', 'requestId', 'prompt'], additionalProperties: false },
    ],
    additionalProperties: false,
  },
  runs: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'followup', 'wait', 'stream', 'cancel'] },
      requestId: { type: 'string', pattern: REQUEST_ID_PATTERN.source }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source },
      runId: { type: 'string', pattern: RUN_ID_PATTERN.source }, prompt: PROMPT_SCHEMA,
      mcpServers: MCP_SERVERS_SCHEMA, mode: { type: 'string', enum: ['agent', 'plan'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', minLength: 1, maxLength: 512 },
      timeoutMs: { type: 'integer', minimum: 250, maximum: 60000 }, pollMs: { type: 'integer', minimum: 250, maximum: 10000 },
      lastEventId: { type: 'string', minLength: 1, maxLength: 512 }, maxEvents: { type: 'integer', minimum: 1, maximum: 500 },
      maxBytes: { type: 'integer', minimum: 1024, maximum: 2_000_000 },
    },
    oneOf: [
      { properties: { action: { const: 'list' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['action', 'agentId'], additionalProperties: false },
      { properties: { action: { const: 'get' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, runId: { type: 'string', pattern: RUN_ID_PATTERN.source } }, required: ['action', 'agentId', 'runId'], additionalProperties: false },
      { properties: { action: { const: 'followup' }, requestId: { type: 'string', pattern: REQUEST_ID_PATTERN.source }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, prompt: PROMPT_SCHEMA, mcpServers: MCP_SERVERS_SCHEMA, mode: { type: 'string', enum: ['agent', 'plan'] } }, required: ['action', 'requestId', 'agentId', 'prompt'], additionalProperties: false },
      { properties: { action: { const: 'wait' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, runId: { type: 'string', pattern: RUN_ID_PATTERN.source }, timeoutMs: { type: 'integer', minimum: 250, maximum: 60000 }, pollMs: { type: 'integer', minimum: 250, maximum: 10000 } }, required: ['action', 'agentId', 'runId'], additionalProperties: false },
      { properties: { action: { const: 'stream' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, runId: { type: 'string', pattern: RUN_ID_PATTERN.source }, lastEventId: { type: 'string', minLength: 1, maxLength: 512 }, timeoutMs: { type: 'integer', minimum: 250, maximum: 60000 }, maxEvents: { type: 'integer', minimum: 1, maximum: 500 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 2_000_000 } }, required: ['action', 'agentId', 'runId'], additionalProperties: false },
      { properties: { action: { const: 'cancel' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, runId: { type: 'string', pattern: RUN_ID_PATTERN.source } }, required: ['action', 'agentId', 'runId'], additionalProperties: false },
    ],
    additionalProperties: false,
  },
  artifacts: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'download'] }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source },
      path: { type: 'string', minLength: 1, maxLength: 1024 }, destination: { type: 'string', minLength: 1, maxLength: 512 },
      overwrite: { type: 'boolean' },
    },
    oneOf: [
      { properties: { action: { const: 'list' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source } }, required: ['action', 'agentId'], additionalProperties: false },
      { properties: { action: { const: 'download' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, path: { type: 'string', minLength: 1, maxLength: 1024 }, destination: { type: 'string', minLength: 1, maxLength: 512 }, overwrite: { type: 'boolean' } }, required: ['action', 'agentId', 'path', 'destination'], additionalProperties: false },
    ],
    additionalProperties: false,
  },
  usage: {
    type: 'object',
    properties: { agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, runId: { type: 'string', pattern: RUN_ID_PATTERN.source } },
    required: ['agentId'],
    additionalProperties: false,
  },
  lifecycle: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['archive', 'unarchive', 'delete'] }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source },
      confirmation: { type: 'string', minLength: 1, maxLength: 256 },
    },
    oneOf: [
      { properties: { action: { const: 'archive' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source } }, required: ['action', 'agentId'], additionalProperties: false },
      { properties: { action: { const: 'unarchive' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source } }, required: ['action', 'agentId'], additionalProperties: false },
      { properties: { action: { const: 'delete' }, agentId: { type: 'string', pattern: AGENT_ID_PATTERN.source }, confirmation: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['action', 'agentId', 'confirmation'], additionalProperties: false },
    ],
    additionalProperties: false,
  },
});

export function validateToolInput(toolName, raw) {
  const value = object(raw ?? {});
  if (toolName === 'status') {
    value.action ??= 'local';
    validateAction(value, ['local', 'identity', 'models', 'repositories']);
    if (value.action === 'models') {
      unknown(value, ['action', 'limit', 'detail', 'refresh'], 'arguments');
      integer(value.limit, 'arguments.limit', { min: 1, max: MAX_PAGE_SIZE, optional: true });
      boolean(value.detail, 'arguments.detail', true);
      boolean(value.refresh, 'arguments.refresh', true);
    } else if (value.action === 'repositories') {
      unknown(value, ['action', 'limit'], 'arguments');
      integer(value.limit, 'arguments.limit', { min: 1, max: MAX_PAGE_SIZE, optional: true });
    } else {
      unknown(value, ['action'], 'arguments');
    }
    return value;
  }
  if (toolName === 'agents') {
    required(value, ['action']);
    validateAction(value, ['list', 'get', 'create']);
    if (value.action === 'list') { pageFields(value, { includeArchived: true }); return value; }
    if (value.action === 'get') { unknown(value, ['action', 'agentId'], 'arguments'); id(value.agentId, 'arguments.agentId'); return value; }
    return validateCreate(value);
  }
  if (toolName === 'runs') {
    required(value, ['action']);
    validateAction(value, ['list', 'get', 'followup', 'wait', 'stream', 'cancel']);
    if (value.action === 'list') {
      unknown(value, ['action', 'agentId', 'limit', 'cursor'], 'arguments');
      id(value.agentId, 'arguments.agentId'); pageFields({ limit: value.limit, cursor: value.cursor }); return value;
    }
    if (value.action === 'get' || value.action === 'cancel') {
      unknown(value, ['action', 'agentId', 'runId'], 'arguments');
      id(value.agentId, 'arguments.agentId'); id(value.runId, 'arguments.runId', 'run'); return value;
    }
    if (value.action === 'followup') return validateFollowup(value);
    if (value.action === 'wait') {
      unknown(value, ['action', 'agentId', 'runId', 'timeoutMs', 'pollMs'], 'arguments');
      id(value.agentId, 'arguments.agentId'); id(value.runId, 'arguments.runId', 'run');
      integer(value.timeoutMs, 'arguments.timeoutMs', { min: 250, max: 60000, optional: true });
      integer(value.pollMs, 'arguments.pollMs', { min: 250, max: 10000, optional: true }); return value;
    }
    unknown(value, ['action', 'agentId', 'runId', 'lastEventId', 'timeoutMs', 'maxEvents', 'maxBytes'], 'arguments');
    id(value.agentId, 'arguments.agentId'); id(value.runId, 'arguments.runId', 'run');
    string(value.lastEventId, 'arguments.lastEventId', { min: 1, max: 512, optional: true });
    integer(value.timeoutMs, 'arguments.timeoutMs', { min: 250, max: 60000, optional: true });
    integer(value.maxEvents, 'arguments.maxEvents', { min: 1, max: 500, optional: true });
    integer(value.maxBytes, 'arguments.maxBytes', { min: 1024, max: 2_000_000, optional: true });
    return value;
  }
  if (toolName === 'artifacts') {
    required(value, ['action']);
    validateAction(value, ['list', 'download']);
    id(value.agentId, 'arguments.agentId');
    if (value.action === 'list') { unknown(value, ['action', 'agentId'], 'arguments'); return value; }
    unknown(value, ['action', 'agentId', 'path', 'destination', 'overwrite'], 'arguments');
    string(value.path, 'arguments.path', { min: 1, max: 1024 });
    string(value.destination, 'arguments.destination', { min: 1, max: 512 });
    boolean(value.overwrite, 'arguments.overwrite', true);
    return value;
  }
  if (toolName === 'usage') {
    unknown(value, ['agentId', 'runId'], 'arguments');
    id(value.agentId, 'arguments.agentId');
    if (value.runId !== undefined) id(value.runId, 'arguments.runId', 'run');
    return value;
  }
  if (toolName === 'lifecycle') {
    required(value, ['action', 'agentId']);
    validateAction(value, ['archive', 'unarchive', 'delete']);
    id(value.agentId, 'arguments.agentId');
    if (value.action === 'delete') {
      unknown(value, ['action', 'agentId', 'confirmation'], 'arguments');
      string(value.confirmation, 'arguments.confirmation', { min: 1, max: 256 });
      if (value.confirmation !== `delete:${value.agentId}`) {
        throw new InputError('confirmation_required', `Deletion requires confirmation exactly equal to delete:${value.agentId}.`);
      }
    } else unknown(value, ['action', 'agentId'], 'arguments');
    return value;
  }
  throw new InputError('unknown_tool', `Unknown tool ${toolName}.`);
}

export function isTerminalRunStatus(status) {
  return ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'].includes(status);
}

export function assertSafeArtifactPath(value) {
  string(value, 'arguments.path', { min: 1, max: 1024 });
  if (!value.startsWith('artifacts/') || value.includes('\\') || value.includes('\0')) {
    throw new InputError('unsafe_artifact_path', 'Artifact path must be a relative path below artifacts/.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new InputError('unsafe_artifact_path', 'Artifact path contains an unsafe segment.');
  }
  return value;
}

export function assertSafeRelativeDestination(value) {
  string(value, 'arguments.destination', { min: 1, max: 512 });
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new InputError('unsafe_destination', 'Destination must be a safe relative path.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new InputError('unsafe_destination', 'Destination contains an unsafe segment.');
  }
  return value;
}
