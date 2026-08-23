// Approved verification-command resolver — ExecutionIntent / ApprovedCommand
// receipt for W15-P16B (ADR 0001 identifiers
// `verification_policy_v1_only_executable_catalog`,
// `codex_selects_approved_command_ids_only`,
// `manifests_carry_command_ids_not_argv`,
// `provider_commands_evidence_never_auto_executed`,
// `read_only_verification`,
// `gate_a_constrained_trusted_policy_command_execution`).
//
// Additive v3 module. It owns one fail-closed question: given an immutable
// trusted VerificationPolicyV1 from P16A and a closed Codex/owner selection
// of command_id plus typed parameter values, what is the fresh frozen
// bounded resolution receipt? It answers nothing else.
// This module never invokes a shell, never resolves PATH, and never executes a command.
// It never opens a network socket, never reads arbitrary workspace files, never
// mutates a candidate, and does not implement the P16C runner.
//
// Authority provenance is only the closed selection input. A provider,
// profile, or manifest reported or requested command is evidence only: even
// exact matching command-id / argv / executable text cannot authorize
// resolution. Untrusted input may carry only command_id and typed
// parameters. Executable path, argv fragments, shell text, environment,
// network, mutation, and resource overrides are denied before expansion.
//
// Expansion substitutes only owner-authored whole-token `{name}`
// placeholders with validated canonical parameter values. There is no
// interpolation, substitution, globbing, option smuggling, or PATH lookup.
// Inherited P16A constraints are copied, never overridden. Failures are
// typed and content-free. Receipts are fresh-owned, deeply frozen, and
// detached. Callers' objects are neither mutated nor frozen.

import { Buffer as NodeBuffer } from 'node:buffer';

import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedObjectIs,
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
  assertDirectJsonClosure,
  assertNotProxy,
  assertPlainObject,
  fail,
  hasOwn,
  optOwn,
} from './selection-json.mjs';
import {
  COMMAND_RECEIPT_KEYS,
  DEFAULT_ENVIRONMENT_RECEIPT,
  DEFAULT_ERROR_BYTES,
  DEFAULT_MUTATION_RECEIPT,
  DEFAULT_NETWORK_RECEIPT,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_RESOURCES_RECEIPT,
  DEFAULT_TIMEOUT_MS,
  DIGEST_ALGORITHM,
  ENV_ENTRY_ALLOWED_KEYS,
  ENVIRONMENT_ALLOWED_KEYS,
  MAX_ARGV_TOKEN_BYTES,
  MAX_PARAMETERS,
  MAX_POLICY_OBJECT_KEYS,
  MUTATION_ALLOWED_KEYS,
  NETWORK_ALLOWED_KEYS,
  PARAMETER_TYPES,
  PLACEHOLDER_PATTERN,
  RESOURCES_ALLOWED_KEYS,
  UNTRUSTED_COMMAND_ALLOWED_KEYS,
  VERIFICATION_COMMAND_DIGEST_LABEL,
  VERIFICATION_POLICY_DIGEST_LABEL,
  parseUntrustedCommandReferenceV1,
  parseVerificationPolicyV1,
} from './trusted-verification-policy.mjs';

export const APPROVED_VERIFICATION_COMMAND_SCHEMA_ID =
  'codex-co-engineer.approved-verification-command.v1';
export const APPROVED_VERIFICATION_COMMAND_VERSION = 1;
export const APPROVED_COMMAND_DIGEST_LABEL = IDENTITY_LABELS.VERIFICATION_COMMAND_PLAN;
export const EXECUTABLE_CLOSURE_DIGEST_LABEL = IDENTITY_LABELS.VERIFICATION_EXECUTABLE_CLOSURE;

export const REQUEST_ALLOWED_KEYS = capturedFreeze(['policy', 'selection']);
export const REQUEST_REQUIRED_KEYS = REQUEST_ALLOWED_KEYS;
export const SELECTION_ALLOWED_KEYS = UNTRUSTED_COMMAND_ALLOWED_KEYS;
export const RECEIPT_BODY_KEYS = capturedFreeze([
  'argv', 'command_id', 'command_identity', 'environment', 'executable',
  'executable_closure_identity', 'mutation', 'network', 'parameters',
  'policy_identity', 'resources', 'schema', 'timeout_ms', 'version',
]);
export const RECEIPT_KEYS = capturedFreeze([
  'argv', 'command_id', 'command_identity', 'environment', 'executable',
  'executable_closure_identity', 'mutation', 'network', 'parameters',
  'plan_identity', 'policy_identity', 'resources', 'schema', 'timeout_ms',
  'version',
]);
export const IDENTITY_RECEIPT_KEYS = capturedFreeze([
  'algorithm', 'digest', 'domain', 'input_bytes', 'label', 'version',
]);

export const APPROVED_COMMAND_ERROR_CODES = capturedFreeze([
  'accessor_property_denied', 'aliased_reference_denied', 'ambiguous_id_denied',
  'authority_denied', 'control_character_denied', 'duplicate_id',
  'duplicate_parameter', 'env_name_denied', 'executable_content_denied',
  'exotic_prototype_denied', 'invalid_array', 'invalid_encoding',
  'invalid_format', 'invalid_json_type', 'invalid_json_value', 'invalid_type',
  'missing_key', 'mutation_permission_denied', 'network_content_denied',
  'non_enumerable_property_denied', 'option_smuggling_denied',
  'own_undefined_denied', 'out_of_range', 'placeholder_unbound',
  'proxy_denied', 'resource_limit_denied', 'shell_content_denied',
  'symbol_key_denied', 'unknown_command', 'unknown_key',
  'value_depth_exceeded',
]);

const PRIVATE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._+-]+$/u;
const PRIVATE_LITERAL_PATTERN = /^[A-Za-z0-9._+/=:,@%-]+$/u;
const PRIVATE_PLACEHOLDER_PATTERN = /^\{[a-z][a-z0-9_-]{0,31}\}$/u;

const MESSAGES = capturedFreeze(Object.assign(capturedCreate(null), {
  accessor_property_denied: 'An accessor property was denied; getters are never invoked.',
  aliased_reference_denied: 'Aliased or cyclic references are denied.',
  ambiguous_id_denied: 'Ambiguous Unicode, compatibility, or confusable identity text is denied.',
  authority_denied: 'Provider, profile, and manifest commands are evidence only and cannot authorize resolution.',
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
  option_smuggling_denied: 'A parameter value attempted to smuggle an option or argv fragment.',
  own_undefined_denied: 'Own undefined values are denied; omit the field instead.',
  out_of_range: 'A bounded integer, count, or size was exceeded.',
  placeholder_unbound: 'An argv placeholder is not bound to a declared parameter.',
  proxy_denied: 'Live and revoked Proxies are denied.',
  resource_limit_denied: 'Untrusted input must not contribute resource limits.',
  shell_content_denied: 'Shell text, interpolation, or metacharacters are denied.',
  symbol_key_denied: 'Symbol keys are denied.',
  unknown_command: 'The selected command is not in the trusted catalog.',
  unknown_key: 'A key is outside the closed vocabulary.',
  value_depth_exceeded: 'Nesting exceeds the bounded policy depth.',
}));

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
const AUTHORITY_FOLDS = capturedFreeze([
  'acceptance', 'assignment', 'attention', 'catalog', 'claim', 'evidence',
  'manifest', 'profile', 'profiles', 'provider', 'providercommand',
  'providerreport', 'providers', 'report', 'reported', 'requested',
  'requestedcommand', 'suggestion', 'untrusted', 'worker',
]);

const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_IS_FINITE = Number.isFinite;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt);
const STRING_SLICE = Function.prototype.call.bind(String.prototype.slice);
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith);
const STRING_REPLACE = Function.prototype.call.bind(String.prototype.replace);
const STRING_TO_LOWER_CASE = Function.prototype.call.bind(String.prototype.toLowerCase);
const ARRAY_PUSH = Array.prototype.push;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);

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
  if (key === 'policy' || key === 'selection') return null;
  const folded = foldKey(key);
  if (folded === 'policy' || folded === 'selection') return 'unknown_key';
  if (capturedIncludes(AUTHORITY_FOLDS, folded)) return 'authority_denied';
  if (capturedIncludes(EXECUTABLE_FOLDS, folded)) return 'executable_content_denied';
  if (capturedIncludes(ENVIRONMENT_FOLDS, folded)) return 'executable_content_denied';
  if (capturedIncludes(NETWORK_FOLDS, folded)) return 'network_content_denied';
  if (capturedIncludes(MUTATION_FOLDS, folded)) return 'mutation_permission_denied';
  if (capturedIncludes(RESOURCE_FOLDS, folded)) return 'resource_limit_denied';
  return 'unknown_key';
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

function isDotOnly(segment) {
  if (typeof segment !== 'string' || segment.length === 0) return false;
  for (let index = 0; index < segment.length; index += 1) {
    if (STRING_CHAR_CODE_AT(segment, index) !== 0x2e) return false;
  }
  return true;
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

function findCommand(policy, commandId) {
  const commands = policy.commands;
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (command.command_id === commandId) return command;
  }
  return undefined;
}

function placeholderName(token) {
  return STRING_SLICE(token, 1, token.length - 1);
}

function requiredParameterNames(command) {
  const required = [];
  const seen = new SET_CTOR();
  const template = command.argv_template;
  for (let index = 0; index < template.length; index += 1) {
    const token = template[index];
    if (!capturedTest(PRIVATE_PLACEHOLDER_PATTERN, token)
      && !capturedTest(PLACEHOLDER_PATTERN, token)) {
      continue;
    }
    const name = placeholderName(token);
    if (SET_HAS.call(seen, name)) deny('duplicate_parameter', 'request.selection.parameters');
    SET_ADD.call(seen, name);
    ARRAY_PUSH.call(required, name);
  }
  return required;
}

function assertCanonicalInteger(value, path, min, max) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value) || !NUMBER_IS_FINITE(value)
    || capturedObjectIs(value, -0)) {
    deny('invalid_type', path);
  }
  if (value < min || value > max) deny('out_of_range', path);
  return value;
}

function assertCanonicalStringToken(value, path, maxBytes, pattern) {
  if (typeof value !== 'string') deny('invalid_type', path);
  const bytes = capturedUtf8ByteLength(value);
  if (bytes < 1 || bytes > maxBytes) deny('out_of_range', path);
  if (!capturedTest(pattern, value)) deny('invalid_format', path);
  if (STRING_STARTS_WITH(value, '-')) deny('option_smuggling_denied', path);
  return value;
}

function validateParameterValue(value, domain, path) {
  const type = domain.type;
  if (!capturedIncludes(PARAMETER_TYPES, type)) deny('invalid_format', path);
  if (type === 'boolean') {
    if (value !== true && value !== false) deny('invalid_type', path);
    return value;
  }
  if (type === 'integer') {
    return assertCanonicalInteger(value, path, domain.min, domain.max);
  }
  if (type === 'enum') {
    if (typeof value !== 'string') deny('invalid_type', path);
    const values = domain.values;
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] === value) return value;
    }
    deny('invalid_format', path);
  }
  if (type === 'path_segment') {
    const token = assertCanonicalStringToken(
      value, path, domain.max_bytes, PRIVATE_PATH_SEGMENT_PATTERN,
    );
    if (isDotOnly(token)) deny('invalid_format', path);
    return token;
  }
  return assertCanonicalStringToken(value, path, domain.max_bytes, PRIVATE_LITERAL_PATTERN);
}

function canonicalArgvToken(value, type) {
  if (type === 'boolean') return value === true ? 'true' : 'false';
  if (type === 'integer') return STRING(value);
  return value;
}

function validateParameters(command, provided, path) {
  const domain = command.parameters;
  const declared = sortedCapturedKeys(domain);
  const providedKeys = sortedCapturedKeys(provided);
  if (providedKeys.length > MAX_PARAMETERS) deny('out_of_range', path);
  const seen = new SET_CTOR();
  const values = {};
  for (let index = 0; index < providedKeys.length; index += 1) {
    const key = providedKeys[index];
    if (SET_HAS.call(seen, key)) deny('duplicate_parameter', path);
    SET_ADD.call(seen, key);
    if (!capturedHasOwn(domain, key)) deny('unknown_key', path);
    values[key] = validateParameterValue(provided[key], domain[key], `${path}.${key}`);
  }
  const required = requiredParameterNames(command);
  for (let index = 0; index < required.length; index += 1) {
    const name = required[index];
    if (!SET_HAS.call(seen, name)) deny('missing_key', `${path}.${name}`);
  }
  for (let index = 0; index < declared.length; index += 1) {
    const name = declared[index];
    if (SET_HAS.call(seen, name)) continue;
    deny('missing_key', `${path}.${name}`);
  }
  return freezeRecord(sortedCapturedKeys(values), values);
}

function expandArgv(command, parameters, path) {
  const template = command.argv_template;
  const argv = [];
  const used = new SET_CTOR();
  for (let index = 0; index < template.length; index += 1) {
    const token = template[index];
    const entryPath = `${path}[${index}]`;
    if (capturedTest(PRIVATE_PLACEHOLDER_PATTERN, token)
      || capturedTest(PLACEHOLDER_PATTERN, token)) {
      const name = placeholderName(token);
      if (!capturedHasOwn(parameters, name)) deny('placeholder_unbound', entryPath);
      if (SET_HAS.call(used, name)) deny('duplicate_parameter', entryPath);
      SET_ADD.call(used, name);
      const domain = command.parameters[name];
      const expanded = canonicalArgvToken(parameters[name], domain.type);
      if (typeof expanded !== 'string' || capturedUtf8ByteLength(expanded) > MAX_ARGV_TOKEN_BYTES) {
        deny('out_of_range', entryPath);
      }
      if (!capturedTest(PRIVATE_LITERAL_PATTERN, expanded)
        && !capturedTest(PRIVATE_PATH_SEGMENT_PATTERN, expanded)) {
        deny('shell_content_denied', entryPath);
      }
      ARRAY_PUSH.call(argv, expanded);
      continue;
    }
    ARRAY_PUSH.call(argv, token);
  }
  return freezeList(argv);
}

function cloneHosts(hosts) {
  const clone = [];
  for (let index = 0; index < hosts.length; index += 1) {
    ARRAY_PUSH.call(clone, hosts[index]);
  }
  return freezeList(clone);
}

function cloneEnvironment(environment) {
  const entries = [];
  const source = environment.entries;
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    ARRAY_PUSH.call(entries, freezeRecord(ENV_ENTRY_ALLOWED_KEYS, {
      name: entry.name,
      value: entry.value,
    }));
  }
  return freezeRecord(ENVIRONMENT_ALLOWED_KEYS, { entries: freezeList(entries) });
}

function inheritConstraints(command) {
  return {
    network: freezeRecord(NETWORK_ALLOWED_KEYS, {
      mode: command.network.mode,
      hosts: cloneHosts(command.network.hosts),
    }),
    environment: cloneEnvironment(command.environment),
    mutation: freezeRecord(MUTATION_ALLOWED_KEYS, {
      persistent: command.mutation.persistent === true,
      workspace: command.mutation.workspace,
    }),
    timeout_ms: command.timeout_ms,
    resources: freezeRecord(RESOURCES_ALLOWED_KEYS, {
      max_output_bytes: command.resources.max_output_bytes,
      max_error_bytes: command.resources.max_error_bytes,
    }),
  };
}

function assertTrustedPolicyShape(value, path) {
  assertPlainObject(value, 'invalid_type', path, path);
  if (capturedIsArray(value)) deny('invalid_type', path);
}

function cloneStringList(values) {
  const clone = [];
  for (let index = 0; index < values.length; index += 1) {
    ARRAY_PUSH.call(clone, values[index]);
  }
  return clone;
}

function reconstructDomain(domain) {
  const type = domain.type;
  if (type === 'integer') return { type, min: domain.min, max: domain.max };
  if (type === 'enum') return { type, values: cloneStringList(domain.values) };
  if (type === 'boolean') return { type };
  return { type, max_bytes: domain.max_bytes };
}

function reconstructCommand(command) {
  const raw = {
    command_id: command.command_id,
    executable: command.executable,
    argv_template: cloneStringList(command.argv_template),
  };
  const paramNames = sortedCapturedKeys(command.parameters);
  if (paramNames.length > 0) {
    const parameters = {};
    for (let index = 0; index < paramNames.length; index += 1) {
      const name = paramNames[index];
      parameters[name] = reconstructDomain(command.parameters[name]);
    }
    raw.parameters = parameters;
  }
  const network = command.network;
  if (network !== undefined && network.mode === 'allowlist') {
    raw.network = { mode: 'allowlist', hosts: cloneStringList(network.hosts) };
  }
  const entries = command.environment === undefined ? [] : command.environment.entries;
  if (entries.length > 0) {
    const copied = [];
    for (let index = 0; index < entries.length; index += 1) {
      ARRAY_PUSH.call(copied, { name: entries[index].name, value: entries[index].value });
    }
    raw.environment = { entries: copied };
  }
  const mutation = command.mutation;
  if (mutation !== undefined && (mutation.persistent === true || mutation.workspace !== 'none')) {
    raw.mutation = { persistent: mutation.persistent === true, workspace: mutation.workspace };
  }
  if (command.timeout_ms !== DEFAULT_TIMEOUT_MS) raw.timeout_ms = command.timeout_ms;
  const resources = command.resources;
  if (resources !== undefined) {
    const maxOutput = resources.max_output_bytes;
    const maxError = resources.max_error_bytes;
    if (maxOutput !== DEFAULT_OUTPUT_BYTES || maxError !== DEFAULT_ERROR_BYTES) {
      raw.resources = {};
      if (maxOutput !== DEFAULT_OUTPUT_BYTES) raw.resources.max_output_bytes = maxOutput;
      if (maxError !== DEFAULT_ERROR_BYTES) raw.resources.max_error_bytes = maxError;
    }
  }
  return raw;
}

function looksLikePolicySnapshot(value, path) {
  if (!hasOwn(value, 'commands')) return false;
  const commands = optOwn(value, 'commands');
  if (!capturedIsArray(commands) || commands.length < 1) return false;
  for (let index = 0; index < commands.length; index += 1) {
    const command = optOwn(commands, STRING(index));
    if (command === undefined || command === null || typeof command !== 'object') return false;
    const keys = ownKeysOrDeny(command, `${path}.commands[${index}]`);
    if (keys.length !== COMMAND_RECEIPT_KEYS.length) return false;
    for (let keyIndex = 0; keyIndex < COMMAND_RECEIPT_KEYS.length; keyIndex += 1) {
      if (!hasOwn(command, COMMAND_RECEIPT_KEYS[keyIndex])) return false;
    }
    const network = optOwn(command, 'network');
    if (network === undefined || typeof network !== 'object' || capturedIsArray(network)) {
      return false;
    }
    if (!hasOwn(network, 'hosts') || !hasOwn(network, 'mode')) return false;
  }
  return true;
}

function consumeTrustedPolicy(input, path) {
  if (looksLikePolicySnapshot(input, path)) {
    const commandsInput = optOwn(input, 'commands');
    const commands = [];
    for (let index = 0; index < commandsInput.length; index += 1) {
      ARRAY_PUSH.call(commands, reconstructCommand(optOwn(commandsInput, STRING(index))));
    }
    const reconstructed = {
      schema: optOwn(input, 'schema'),
      version: optOwn(input, 'version'),
      commands,
    };
    const parsed = parseVerificationPolicyV1(reconstructed, path);
    if (canonicalJsonStringify(parsed) !== canonicalJsonStringify(input)) {
      deny('invalid_format', path);
    }
    return parsed;
  }
  return parseVerificationPolicyV1(input, path);
}

export function resolveApprovedVerificationCommandV1(input, path = 'request') {
  assertNotProxy(input, path);
  assertPlainObject(input, 'invalid_type', path, path);
  assertDirectJsonClosure(input, path);
  assertRequestKeys(input, path);
  const policyInput = optOwn(input, 'policy');
  assertTrustedPolicyShape(policyInput, `${path}.policy`);
  const policy = consumeTrustedPolicy(policyInput, `${path}.policy`);
  const selectionInput = optOwn(input, 'selection');
  const selection = parseUntrustedCommandReferenceV1(selectionInput, `${path}.selection`);
  const command = findCommand(policy, selection.command_id);
  if (command === undefined) deny('unknown_command', `${path}.selection.command_id`);
  const parameters = validateParameters(
    command,
    selection.parameters,
    `${path}.selection.parameters`,
  );
  const argv = expandArgv(command, parameters, `${path}.selection`);
  const constraints = inheritConstraints(command);
  const policyIdentity = digestOf(VERIFICATION_POLICY_DIGEST_LABEL, policy);
  const commandIdentity = digestOf(VERIFICATION_COMMAND_DIGEST_LABEL, command);
  const executableClosureIdentity = digestOf(
    EXECUTABLE_CLOSURE_DIGEST_LABEL,
    freezeRecord(capturedFreeze(['argv', 'executable']), {
      executable: command.executable,
      argv,
    }),
  );
  const body = freezeRecord(RECEIPT_BODY_KEYS, {
    schema: APPROVED_VERIFICATION_COMMAND_SCHEMA_ID,
    version: APPROVED_VERIFICATION_COMMAND_VERSION,
    command_id: command.command_id,
    parameters,
    executable: command.executable,
    argv,
    network: constraints.network,
    environment: constraints.environment,
    mutation: constraints.mutation,
    timeout_ms: constraints.timeout_ms,
    resources: constraints.resources,
    policy_identity: policyIdentity,
    command_identity: commandIdentity,
    executable_closure_identity: executableClosureIdentity,
  });
  const planIdentity = digestOf(APPROVED_COMMAND_DIGEST_LABEL, body);
  return freezeRecord(RECEIPT_KEYS, {
    schema: body.schema,
    version: body.version,
    command_id: body.command_id,
    parameters: body.parameters,
    executable: body.executable,
    argv: body.argv,
    network: body.network,
    environment: body.environment,
    mutation: body.mutation,
    timeout_ms: body.timeout_ms,
    resources: body.resources,
    policy_identity: body.policy_identity,
    command_identity: body.command_identity,
    executable_closure_identity: body.executable_closure_identity,
    plan_identity: planIdentity,
  });
}

export function canonicalApprovedVerificationCommandJsonV1(input, path = 'request') {
  return canonicalJsonStringify(resolveApprovedVerificationCommandV1(input, path));
}

export function approvedVerificationCommandDigestV1(input, path = 'request') {
  return resolveApprovedVerificationCommandV1(input, path).plan_identity;
}

export const APPROVED_VERIFICATION_COMMAND_CONTRACT_DESCRIPTOR = capturedFreeze({
  schema: APPROVED_VERIFICATION_COMMAND_SCHEMA_ID,
  version: APPROVED_VERIFICATION_COMMAND_VERSION,
  label: APPROVED_COMMAND_DIGEST_LABEL,
  closure_label: EXECUTABLE_CLOSURE_DIGEST_LABEL,
  request_keys: REQUEST_ALLOWED_KEYS,
  selection_keys: SELECTION_ALLOWED_KEYS,
  receipt_keys: RECEIPT_KEYS,
  default_deny: capturedFreeze({
    network: DEFAULT_NETWORK_RECEIPT,
    environment: DEFAULT_ENVIRONMENT_RECEIPT,
    mutation: DEFAULT_MUTATION_RECEIPT,
    resources: DEFAULT_RESOURCES_RECEIPT,
    timeout_ms: DEFAULT_TIMEOUT_MS,
  }),
});

capturedFreeze(resolveApprovedVerificationCommandV1);
capturedFreeze(canonicalApprovedVerificationCommandJsonV1);
capturedFreeze(approvedVerificationCommandDigestV1);
