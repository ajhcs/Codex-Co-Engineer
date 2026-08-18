import { spawnSync } from 'node:child_process';

/**
 * The Grok Build CLI is intentionally kept behind this small adapter.  The
 * control plane passes an argv vector to spawn(2); it never joins these
 * values into a shell command.
 */
export const GROK_OUTPUT_FORMATS = Object.freeze([
  'plain',
  'json',
  'streaming-json',
  'streaming-messages-json',
]);
export const GROK_REASONING_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const GROK_SANDBOX_PROFILES = Object.freeze([
  'off',
  'workspace',
  'devbox',
  'read-only',
  'strict',
]);
export const GROK_PERMISSION_MODES = Object.freeze([
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]);
export const GROK_DELEGATION_MODES = Object.freeze(['enabled', 'disabled']);
// Grok's headless `auto` mode lets a noninteractive run continue when a tool
// call is blocked. Review/verify additionally require the CLI-managed
// read-only sandbox, a non-writable target root, and runner postflight checks;
// the adapter does not claim the built-in profile alone is a universal hard
// boundary. `default` and `plan` remain accepted as compatibility aliases for
// callers of the earlier connector contract; receipts record effective mode.
export const GROK_READ_ONLY_PERMISSION_MODE = 'auto';
// The headless CLI keeps MCP meta-tools available even when a built-in tool
// allowlist is supplied.  Review/verify runs must not be able to turn that
// escape hatch into an external side effect, so the adapter always adds this
// deny rule after caller-supplied rules.
export const GROK_READ_ONLY_MCP_DENY_RULE = 'MCPTool';

/**
 * The small capability surface callers can use without copying the CLI's
 * complete configuration. Inline custom definition JSON is not included
 * because the current connector cannot receipt-redact arbitrary definition
 * prompts. ACP output formats are not the issue; ACP transport itself is not
 * exposed until the same target and lifecycle guarantees can be preserved.
 */
export const GROK_CAPABILITY_PROFILE = Object.freeze({
  transport: Object.freeze({ selected: 'direct-headless', acp: 'not_exposed' }),
  output_formats: GROK_OUTPUT_FORMATS,
  reasoning_efforts: GROK_REASONING_EFFORTS,
  sessions: Object.freeze({ resume: true, continue: true, fork: true }),
  main_session_profile: Object.freeze({
    selection: 'named',
    effective: 'unknown',
    resolution: 'grok_cli_project_user_or_bundled',
    custom_or_shadowed: 'possible',
    definition_paths: 'not_exposed',
  }),
  delegation: Object.freeze({
    supported: true,
    modes: GROK_DELEGATION_MODES,
    enabled_by_default: true,
    custom_definitions: 'not_exposed',
    restriction_inheritance: 'connector_process_boundary',
    effective: 'unknown',
  }),
  execution: Object.freeze({
    final_response: true,
    target_workspace_write: 'requires_verified_read_only_sandbox_and_runner_check',
    permission_mode: GROK_READ_ONLY_PERMISSION_MODE,
    mcp_meta_tools: 'denied_for_review_verify',
  }),
});

function cloneCapability(value) {
  if (Array.isArray(value)) return value.map(cloneCapability);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneCapability(entry)]));
  }
  return value;
}

const MAX_TEXT = 8000;
const MAX_TOKEN = 128;
const MAX_RULE = 240;
const MAX_RULES = 32;
const MAX_JSON_SCHEMA_BYTES = 16_384;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$/;
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RULE = /^[^\u0000-\u001f\u007f]{1,240}$/;
const CONTROL_FREE_TEXT = /^[^\u0000-\u001f\u007f]{1,8000}$/;
const WRITE_WORDS = /(?:^|[\s:()[\],])(?:bash|shell|exec|command|edit|write|delete|remove|move|copy|mkdir|apply_patch|patch)(?:$|[\s:()[\],])/i;
const MCP_TOOL_RULE = /MCPTool/i;
const SANDBOX_FALLBACK_WARNING = /(?:\b(?:warning|warn)\b[^\n]{0,240}\b(?:sandbox|landlock|seatbelt|bubblewrap)\b[^\n]{0,240}\b(?:without\s+enforcement|not\s+applied|could\s+not\s+be\s+applied|cannot\s+be\s+applied|failed\s+to\s+(?:apply|enforce)|continu(?:e|ing)\s+without)|\b(?:sandbox|landlock|seatbelt|bubblewrap)\b[^\n]{0,240}\b(?:could\s+not\s+be\s+applied|cannot\s+be\s+applied|failed\s+to\s+(?:apply|enforce)|continu(?:e|ing)\s+without\s+(?:sandbox|enforcement)|without\s+enforcement)\b)/i;
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'find',
  'webfetch',
  'websearch',
]);

export class GrokBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalid(field, message) {
  throw new GrokBuildError('invalid_grok_configuration', `${field} ${message}`);
}

function boundedText(value, field, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    invalid(field, `must contain 1 to ${maximum} characters.`);
  }
  const pattern = maximum <= MAX_RULE ? SAFE_RULE : CONTROL_FREE_TEXT;
  if (!pattern.test(value)) invalid(field, 'contains a control character or invalid empty value.');
  if (value.startsWith('-')) invalid(field, 'must not start with a dash.');
  return value;
}

function optionalText(value, field, maximum = MAX_TOKEN) {
  if (value === undefined || value === null) return null;
  return boundedText(value, field, maximum);
}

function optionalAgentName(value, field = 'agent') {
  if (value === undefined || value === null) return null;
  const name = boundedText(value, field, MAX_TOKEN);
  if (!SAFE_AGENT_NAME.test(name)) {
    invalid(field, 'must be an agent name, not a path or a name with unsupported characters.');
  }
  return name;
}

function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    invalid(field, `must contain at most ${MAX_RULES} values.`);
  }
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > MAX_RULE
      || !SAFE_RULE.test(item) || item.startsWith('-')) {
      invalid(`${field}[${index}]`, `must be 1 to ${MAX_RULE} characters without control characters or a leading dash.`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) invalid(field, 'must not contain duplicates.');
  return result;
}

function tools(value, field) {
  const result = list(value, field);
  for (const item of result) {
    if (!SAFE_TOKEN.test(item)) invalid(`${field} item`, 'contains unsupported characters.');
  }
  return result;
}

function normalizeJsonSchema(value) {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('json_schema', 'must be a JSON Schema object or boolean.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid('json_schema', 'must be JSON-serializable.');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_JSON_SCHEMA_BYTES) {
    invalid('json_schema', `must serialize to at most ${MAX_JSON_SCHEMA_BYTES} bytes.`);
  }
  try {
    return JSON.parse(serialized);
  } catch {
    invalid('json_schema', 'must be JSON-serializable.');
  }
}

function hasWriteCapability(value) {
  return WRITE_WORDS.test(value);
}

function hasMcpToolRule(value) {
  return MCP_TOOL_RULE.test(value);
}

function readOnlyToolList(value) {
  return value.every((item) => READ_ONLY_TOOLS.has(item.toLowerCase().replaceAll('_', '')));
}

/**
 * Validate and normalize the Grok-specific MCP fields.  The returned object
 * is safe to persist in a receipt (it contains no prompt or credential).
 */
export function normalizeGrokConfiguration(input = {}, role = 'review') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('grok configuration', 'must be an object.');
  }
  const allowed = new Set([
    'model',
    'output_format',
    'json_schema',
    'verbatim',
    'include_partial_messages',
    'session_id',
    'resume',
    'continue_session',
    'reasoning_effort',
    'max_turns',
    'sandbox_profile',
    'permission_mode',
    'rules',
    'allowed_tools',
    'disallowed_tools',
    'allow_rules',
    'deny_rules',
    'always_approve',
    'no_auto_update',
    'no_plan',
    'no_subagents',
    'no_memory',
    'disable_web_search',
    'experimental_memory',
    'fork_session',
    'agent',
    'delegation',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`grok.${key}`, 'is not supported.');
  }

  const model = optionalText(input.model, 'model', 200);
  const hasJsonSchema = Object.hasOwn(input, 'json_schema');
  const jsonSchema = hasJsonSchema ? normalizeJsonSchema(input.json_schema) : null;
  const requestedOutputFormat = input.output_format ?? null;
  const outputFormat = requestedOutputFormat ?? (jsonSchema !== null ? 'json' : 'streaming-json');
  if (!GROK_OUTPUT_FORMATS.includes(outputFormat)) {
    invalid('output_format', `must be one of ${GROK_OUTPUT_FORMATS.join(', ')}.`);
  }
  if (jsonSchema !== null && outputFormat !== 'json') {
    invalid('output_format', 'must be json when json_schema is provided.');
  }
  const sessionId = optionalText(input.session_id, 'session_id', MAX_TOKEN);
  if (sessionId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    invalid('session_id', 'must be a valid UUID for a new Grok session.');
  }
  const resume = input.resume === undefined || input.resume === null
    ? null
    : input.resume === true
      ? true
      : input.resume === false
        ? invalid('resume', 'must be true or a session ID/title string when provided.')
        : optionalText(input.resume, 'resume', MAX_TOKEN);
  const continueSession = input.continue_session === true;
  if (input.continue_session !== undefined && typeof input.continue_session !== 'boolean') {
    invalid('continue_session', 'must be a boolean.');
  }
  const forkSession = input.fork_session === true;
  if (sessionId !== null && (resume !== null || continueSession) && !forkSession) {
    invalid('session_id', 'can combine with resume or continue_session only when fork_session is true.');
  }
  if (resume !== null && continueSession) {
    invalid('resume', 'cannot be combined with continue_session.');
  }
  const reasoningEffort = input.reasoning_effort ?? null;
  if (reasoningEffort !== null && !GROK_REASONING_EFFORTS.includes(reasoningEffort)) {
    invalid('reasoning_effort', `must be one of ${GROK_REASONING_EFFORTS.join(', ')}.`);
  }
  const maxTurns = input.max_turns === undefined || input.max_turns === null
    ? null
    : input.max_turns;
  if (maxTurns !== null && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) {
    invalid('max_turns', 'must be an integer from 1 to 100.');
  }
  const sandboxProfile = input.sandbox_profile ?? null;
  if (sandboxProfile !== null && !GROK_SANDBOX_PROFILES.includes(sandboxProfile)) {
    invalid('sandbox_profile', `must be one of ${GROK_SANDBOX_PROFILES.join(', ')}; custom profiles are not verifiable by the connector.`);
  }
  const permissionMode = input.permission_mode ?? null;
  if (permissionMode !== null && !GROK_PERMISSION_MODES.includes(permissionMode)) {
    invalid('permission_mode', `must be one of ${GROK_PERMISSION_MODES.join(', ')}.`);
  }
  const rules = input.rules === undefined || input.rules === null
    ? null
    : boundedText(input.rules, 'rules', MAX_TEXT);
  const allowedTools = tools(input.allowed_tools, 'allowed_tools');
  const disallowedTools = tools(input.disallowed_tools, 'disallowed_tools');
  const allowRules = list(input.allow_rules, 'allow_rules');
  const denyRules = list(input.deny_rules, 'deny_rules');
  const alwaysApprove = input.always_approve === undefined ? false : input.always_approve;
  if (typeof alwaysApprove !== 'boolean') invalid('always_approve', 'must be a boolean.');
  const noAutoUpdate = input.no_auto_update === undefined ? true : input.no_auto_update;
  if (typeof noAutoUpdate !== 'boolean') invalid('no_auto_update', 'must be a boolean.');
  const bools = [
    'no_plan', 'no_subagents', 'no_memory', 'disable_web_search',
    'experimental_memory', 'fork_session', 'verbatim', 'include_partial_messages',
  ];
  for (const field of bools) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') invalid(field, 'must be a boolean.');
  }
  if (input.experimental_memory === true && input.no_memory === true) {
    invalid('experimental_memory', 'cannot be combined with no_memory.');
  }
  const includePartialMessages = input.include_partial_messages === true;
  if (includePartialMessages && outputFormat !== 'streaming-messages-json') {
    invalid('include_partial_messages', 'is only valid with output_format=streaming-messages-json.');
  }
  const noPlan = input.no_plan === true;
  if (forkSession && resume === null && !continueSession) {
    invalid('fork_session', 'requires resume or continue_session.');
  }

  const agent = optionalAgentName(input.agent);
  const delegation = input.delegation;
  if (delegation !== undefined && delegation !== null
    && (!delegation || typeof delegation !== 'object' || Array.isArray(delegation))) {
    invalid('delegation', 'must be an object when provided.');
  }
  if (delegation) {
    for (const key of Object.keys(delegation)) {
      if (key !== 'enabled') {
        invalid(`delegation.${key}`, 'is not supported.');
      }
    }
    if (!Object.hasOwn(delegation, 'enabled')) {
      invalid('delegation.enabled', 'is required when delegation is provided.');
    }
    if (delegation.enabled !== undefined && typeof delegation.enabled !== 'boolean') {
      invalid('delegation.enabled', 'must be a boolean.');
    }
  }
  const delegationEnabled = delegation?.enabled ?? !input.no_subagents;
  if (Object.hasOwn(input, 'no_subagents') && delegation?.enabled !== undefined
    && delegation.enabled !== !input.no_subagents) {
    invalid('delegation.enabled', 'conflicts with no_subagents.');
  }

  const effectiveRole = role ?? 'review';
  if (!['review', 'verify', 'implement'].includes(effectiveRole)) invalid('role', 'is unsupported.');
  const requestedSandbox = sandboxProfile;
  if (effectiveRole === 'review' || effectiveRole === 'verify') {
    if (noPlan) {
      invalid('no_plan', 'review and verify roles must retain the connector-managed analysis policy.');
    }
    if (alwaysApprove) {
      invalid('always_approve', 'read-only roles cannot enable automatic approval.');
    }
    if (permissionMode !== null && !['default', 'plan', 'auto'].includes(permissionMode)) {
      invalid('permission_mode', 'read-only roles accept omitted, default, plan, or auto; write-capable approval modes are rejected.');
    }
    if (requestedSandbox && requestedSandbox !== 'read-only') {
      invalid('sandbox_profile', 'review and verify roles require the read-only sandbox; strict still permits CWD writes.');
    }
    if (outputFormat === 'plain') {
      invalid('output_format', 'review and verify roles require a structured output format so sandbox fallback and terminal outcomes can be classified fail-closed.');
    }
    if (allowedTools.length > 0 && !readOnlyToolList(allowedTools)) {
      invalid('allowed_tools', 'read-only roles may only allow read-only tools.');
    }
    if (allowRules.some(hasWriteCapability)) {
      invalid('allow_rules', 'read-only roles cannot allow write-capable tools or commands.');
    }
    if (allowRules.some(hasMcpToolRule) || denyRules.some(hasMcpToolRule)) {
      invalid('permission_rules', 'read-only roles cannot customize MCPTool permissions; MCP meta-tools are denied by the connector.');
    }
  } else {
    if (['dontAsk', 'bypassPermissions'].includes(permissionMode)) {
      invalid('permission_mode', 'implement roles cannot bypass the bounded permission policy.');
    }
    if (permissionMode !== null && permissionMode !== 'auto') {
      invalid('permission_mode', 'headless implement roles require auto so workspace edits cannot stall or be cancelled waiting for an unavailable approval channel.');
    }
    if (requestedSandbox === 'off' || requestedSandbox === 'devbox') {
      invalid('sandbox_profile', 'implement roles cannot widen the bounded workspace sandbox.');
    }
  }
  const effectiveSandbox = effectiveRole === 'review' || effectiveRole === 'verify'
    ? 'read-only'
    : requestedSandbox ?? 'workspace';
  const effectivePermission = effectiveRole === 'review' || effectiveRole === 'verify'
    ? GROK_READ_ONLY_PERMISSION_MODE
    : permissionMode ?? 'auto';

  return Object.freeze({
    model,
    output_format: outputFormat,
    json_schema: jsonSchema,
    verbatim: input.verbatim === true,
    include_partial_messages: includePartialMessages,
    session_id: sessionId,
    resume,
    continue_session: continueSession,
    reasoning_effort: reasoningEffort,
    max_turns: maxTurns,
    sandbox_profile: effectiveSandbox,
    permission_mode: effectivePermission,
    rules,
    allowed_tools: allowedTools,
    disallowed_tools: disallowedTools,
    allow_rules: allowRules,
    deny_rules: denyRules,
    always_approve: alwaysApprove,
    no_auto_update: noAutoUpdate,
    no_plan: noPlan,
    no_subagents: !delegationEnabled,
    no_memory: input.no_memory === true,
    disable_web_search: input.disable_web_search === true,
    experimental_memory: input.experimental_memory === true,
    fork_session: forkSession,
    ...(agent === null ? {} : { agent }),
    ...(delegation === undefined || delegation === null
      ? {}
      : { delegation: Object.freeze({ enabled: delegationEnabled }) }),
    role: effectiveRole,
  });
}

/** Return the compact, non-sensitive capability/profile view for a request. */
export function grokCapabilityProfile(configuration = {}, roleOverride = null) {
  const role = roleOverride ?? configuration?.role ?? 'review';
  const hasDelegation = Boolean(configuration && typeof configuration === 'object'
    && Object.hasOwn(configuration, 'delegation')
    && configuration.delegation !== undefined
    && configuration.delegation !== null);
  const hasLegacyPolicy = Boolean(configuration && typeof configuration === 'object'
    && Object.hasOwn(configuration, 'no_subagents'));
  const normalizedInput = configuration && typeof configuration === 'object'
    ? Object.fromEntries(Object.entries(configuration)
      .filter(([key, value]) => key !== 'role' && !(key === 'json_schema' && value === null)))
    : configuration;
  const normalized = normalizeGrokConfiguration(normalizedInput, role);
  const profile = cloneCapability(GROK_CAPABILITY_PROFILE);
  profile.main_session_profile.requested = normalized.agent ?? null;
  profile.execution = {
    ...profile.execution,
    role: normalized.role,
    sandbox_profile: normalized.sandbox_profile,
    permission_mode: normalized.permission_mode,
    target_workspace_write: normalized.role === 'implement'
      ? 'bounded_by_target_contract'
      : 'requires_verified_read_only_sandbox_and_runner_check',
    mcp_meta_tools: normalized.role === 'implement'
      ? 'provider_policy'
      : 'denied_for_review_verify',
    ...(normalized.always_approve
      ? {
        effective_permission_mode: 'bypassPermissions',
        approval_precedence: 'always_approve_overrides_auto',
      }
      : {}),
  };
  profile.delegation = {
    ...profile.delegation,
    requested: hasDelegation || hasLegacyPolicy
      ? (normalized.no_subagents ? 'disabled' : 'enabled')
      : 'cli-default',
    effective: 'unknown',
  };
  return profile;
}

function addFlag(args, flag, value) {
  if (value === undefined || value === null || value === false) return;
  if (value === true) args.push(flag);
  else args.push(flag, String(value));
}

/** Build the exact, shell-free argv passed to the official grok executable. */
export function buildGrokArgs({ prompt, cwd, configuration }) {
  if (typeof prompt !== 'string' || prompt.length < 1) throw new TypeError('prompt is required.');
  if (typeof cwd !== 'string' || cwd.length < 1) throw new TypeError('cwd is required.');
  if (/[\u0000\u007f]/.test(prompt)) throw new TypeError('prompt contains an unsupported control character.');
  if (/[\u0000\u007f]/.test(cwd)) throw new TypeError('cwd contains an unsupported control character.');
  const requestedRole = configuration?.role;
  const normalizedInput = configuration && typeof configuration === 'object'
    ? Object.fromEntries(Object.entries(configuration)
      .filter(([key, value]) => key !== 'role' && !(key === 'json_schema' && value === null)))
    : configuration;
  const config = normalizeGrokConfiguration(normalizedInput, requestedRole ?? 'review');
  const args = [];
  if (config.no_auto_update) args.push('--no-auto-update');
  addFlag(args, '--agent', config.agent);
  args.push('-p', prompt, '--cwd', cwd, '--output-format', config.output_format);
  if (config.json_schema !== null) args.push('--json-schema', JSON.stringify(config.json_schema));
  if (config.verbatim) args.push('--verbatim');
  if (config.include_partial_messages) args.push('--include-partial-messages');
  addFlag(args, '-m', config.model);
  addFlag(args, '-s', config.session_id);
  if (config.resume !== null) addFlag(args, '--resume', config.resume);
  if (config.continue_session) args.push('--continue');
  if (config.fork_session) args.push('--fork-session');
  addFlag(args, '--reasoning-effort', config.reasoning_effort);
  addFlag(args, '--max-turns', config.max_turns);

  const role = config.role;
  const sandbox = config.sandbox_profile
    ?? (role === 'implement' ? 'workspace' : 'read-only');
  args.push('--sandbox', sandbox);
  const permission = config.permission_mode ?? 'auto';
  args.push('--permission-mode', permission);
  if (config.always_approve && role === 'implement') args.push('--always-approve');
  addFlag(args, '--rules', config.rules);
  if (config.allowed_tools.length > 0) args.push('--tools', config.allowed_tools.join(','));
  if (config.disallowed_tools.length > 0) args.push('--disallowed-tools', config.disallowed_tools.join(','));
  for (const rule of config.allow_rules) args.push('--allow', rule);
  for (const rule of config.deny_rules) args.push('--deny', rule);
  if (role === 'review' || role === 'verify') {
    // This is deliberately appended after caller rules.  Grok evaluates deny
    // rules by severity rather than argv order, but keeping the adapter-owned
    // rule last makes the effective policy obvious in the receipt.
    args.push('--deny', GROK_READ_ONLY_MCP_DENY_RULE);
  }
  if (config.no_plan) args.push('--no-plan');
  if (config.no_subagents) args.push('--no-subagents');
  if (config.no_memory) args.push('--no-memory');
  if (config.disable_web_search) args.push('--disable-web-search');
  if (config.experimental_memory) args.push('--experimental-memory');
  return args;
}

export function grokVersionProbe(command, cwd, env = process.env) {
  const result = spawnSync(command, ['--version'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Some sandboxed hosts attach an EPERM diagnostic even when the child ran
  // to completion and returned status 0. A successful exit plus version
  // output is authoritative; genuine spawn failures have no successful exit.
  if (result.status === 0) {
    return {
      executable_state: 'installed',
      version: output || null,
      exit_code: 0,
      detail: null,
    };
  }
  if (result.error?.code === 'ENOENT') {
    return { executable_state: 'missing', version: null, exit_code: null, detail: 'grok executable was not found on PATH.' };
  }
  if (result.error) {
    return { executable_state: 'unavailable', version: null, exit_code: result.status ?? null, detail: result.error.message };
  }
  return {
    executable_state: 'unavailable',
    version: output || null,
    exit_code: result.status,
    detail: output || 'grok --version failed.',
  };
}

/**
 * Parse only explicit failures from streaming-json.  Grok has intentionally
 * left event names extensible; unknown and incomplete records are retained in
 * the bounded log and do not turn a successful process into an adapter error.
 */
export function grokBuildFailure(text) {
  const source = String(text ?? '');
  if (SANDBOX_FALLBACK_WARNING.test(source)) {
    return 'Grok sandbox enforcement was not proven: the CLI reported a sandbox fallback or unenforced profile.';
  }
  let failure = null;
  let blockedToolFailure = null;
  let sawText = false;
  let sawTerminalEvent = false;
  let terminalFailure = null;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const type = String(event?.type ?? '').toLowerCase();
    if (type === 'text' || type === 'message' || type === 'assistant') sawText = true;
    const isTerminal = type === 'end' || type === 'result';
    const error = event?.error ?? event?.failure ?? event?.exception;
    const status = String(event?.status ?? event?.state ?? event?.stopReason
      ?? event?.stop_reason ?? event?.type ?? '').toLowerCase();
    const detailFor = (value = null) => {
      if (value) return typeof value === 'string'
        ? value
        : value.message ?? value.detail ?? JSON.stringify(value);
      const fallback = event.message ?? event.detail ?? event.reason ?? event.rawOutput ?? status;
      return typeof fallback === 'string' ? fallback : JSON.stringify(fallback);
    };
    const isFailureStatus = status === 'error' || status === 'failed' || status === 'failure'
      || status === 'exception' || status === 'fatal' || status === 'blocked'
      || status.endsWith('.error') || status.endsWith('_error');
    if (isTerminal) {
      sawTerminalEvent = true;
      if (error) {
        terminalFailure ??= String(detailFor(error)).slice(0, 2000);
      } else if (isFailureStatus || status === 'cancelled' || status === 'canceled') {
        terminalFailure ??= String(detailFor()).slice(0, 2000);
      }
      continue;
    }
    // A failed/blocked tool call is recoverable: the model can receive the
    // denial and produce a normal final response.  Hold it until the final
    // session outcome is known instead of turning it into adapter_error.
    if (type === 'tool_call_update' || type === 'tool_call') {
      if (error || isFailureStatus) {
        blockedToolFailure ??= String(detailFor(error)).slice(0, 2000);
      }
      continue;
    }
    if (error) {
      failure ??= String(detailFor(error)).slice(0, 2000);
    } else if (isFailureStatus) {
      failure ??= String(detailFor()).slice(0, 2000);
    }
  }
  if (sawTerminalEvent) return terminalFailure;
  if (failure) return failure;
  // A stream without an `end` event is incomplete.  A normal text response
  // still proves the model recovered from a blocked tool call; leave the
  // process exit code to classify genuinely incomplete provider sessions.
  return sawText ? null : blockedToolFailure;
}
