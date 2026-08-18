import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDirectory } from './state.mjs';

/**
 * The DSH adapter owns only the launcher/profile boundary.  It never reads a
 * provider credential; MODEL_API_KEY is inherited only by the actual managed
 * worker after this local readiness check succeeds.
 */
export const TESTED_DSH_VERSION = '0.1.0-rc.6';
export const DSH_PROFILE = 'headless';

/**
 * The managed headless overlay currently ships one explicitly declared Muse
 * route.  Keep these facts beside the launcher rather than duplicating them
 * in the MCP server: this is the adapter's effective capability contract.
 *
 * The headless bundle also mounts DSH's delegation tools.  They are useful
 * inside one provider process, but the outer runner is one-shot, so a child
 * cannot be followed up after the parent process exits.  That distinction is
 * intentionally represented in the profile below.
 */
export const DSH_MODEL = 'muse-spark-1.2-contributor';
export const DSH_MODEL_PROVIDER = 'meta';
export const DSH_MODEL_NAME = 'Muse Spark 1.2 Contributor';
export const DSH_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const DSH_MAX_OUTPUT_TOKENS = 131_072;
export const DSH_DEFAULT_TOOL_MODE = 'native';
export const DSH_TOOL_MODES = Object.freeze(['native', 'code', 'both']);
export const DSH_MAX_RALPH_ROUNDS = 64;

const DSH_CAPABILITIES = Object.freeze({
  model: Object.freeze({
    provider: DSH_MODEL_PROVIDER,
    id: DSH_MODEL,
    name: DSH_MODEL_NAME,
    context_window_tokens: DSH_CONTEXT_WINDOW_TOKENS,
    max_output_tokens: DSH_MAX_OUTPUT_TOKENS,
    model_input_modalities: Object.freeze(['text', 'image']),
    connector_input_modalities: Object.freeze(['text']),
  }),
  tools: Object.freeze({
    default_mode: DSH_DEFAULT_TOOL_MODE,
    modes: DSH_TOOL_MODES,
    code_runtime: 'typescript',
  }),
  delegation: Object.freeze({
    subagent: Object.freeze({
      available: true,
      tool_name: 'subagent',
      background_mode: 'continuable',
      foreground_override: true,
      external_followup: false,
      survives_headless_exit: false,
    }),
    fork: Object.freeze({
      available: true,
      tool_name: 'subagent_fork',
      background_mode: 'one-shot',
      foreground_default: true,
      inherits_parent_context: true,
      survives_headless_exit: false,
    }),
    workflow: Object.freeze({
      available: true,
      tool_name: 'workflow',
      foreground_only: true,
    }),
    ralph: Object.freeze({
      available: true,
      tool_name: 'ralph',
      foreground_only: true,
      max_rounds: DSH_MAX_RALPH_ROUNDS,
    }),
  }),
  execution: Object.freeze({
    runner: 'one-shot',
    interactive_followup: false,
    external_child_collection: false,
    image_input_exposed: false,
  }),
});

function cloneCapabilities(value) {
  if (Array.isArray(value)) return value.map(cloneCapabilities);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneCapabilities(entry)]));
  }
  return value;
}

/**
 * Return the adapter-owned, provider-free DSH capability profile.  A fresh
 * value prevents callers from mutating the constants that readiness and
 * effective-configuration code rely on.
 */
export function dshCapabilityProfile(options = {}) {
  const normalized = normalizeDshOptions(options);
  const profile = cloneCapabilities(DSH_CAPABILITIES);
  profile.tools.effective_mode = normalized.tool_mode;
  profile.model.effective_max_output_tokens = normalized.max_tokens;
  return profile;
}

/**
 * Validate the small set of DSH options the managed overlay can actually
 * enforce.  Arbitrary model ids, tool names, provider routes, and token
 * values are deliberately not accepted: the overlay has one trusted Muse
 * route and the upstream bundle owns the tool catalog.
 */
export function normalizeDshOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('DSH options must be an object.');
  }
  const allowed = new Set(['model', 'tool_mode', 'max_tokens']);
  const unknown = Object.keys(options).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`dsh_options.${unknown} is not supported.`);
  const model = options.model ?? DSH_MODEL;
  if (model !== DSH_MODEL) {
    throw new TypeError(`The managed DSH profile supports only ${DSH_MODEL}.`);
  }
  const toolMode = options.tool_mode ?? DSH_DEFAULT_TOOL_MODE;
  if (!DSH_TOOL_MODES.includes(toolMode)) {
    throw new TypeError(`DSH tool mode must be one of ${DSH_TOOL_MODES.join(', ')}.`);
  }
  const maxTokens = options.max_tokens ?? DSH_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > DSH_MAX_OUTPUT_TOKENS) {
    throw new TypeError(`DSH max_tokens must be an integer from 1 to ${DSH_MAX_OUTPUT_TOKENS}.`);
  }
  return {
    model,
    tool_mode: toolMode,
    max_tokens: maxTokens,
  };
}

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DSH_PATCH_FILE = path.join(ADAPTER_ROOT, 'assets', 'dsh-headless.patch.yml');
export const DSH_HEADLESS_USAGE_RUNNER_FILE = 'dsh-headless-usage-runner.mjs';
export const DEFAULT_DSH_HEADLESS_USAGE_RUNNER_FILE = path.join(
  ADAPTER_ROOT,
  'assets',
  DSH_HEADLESS_USAGE_RUNNER_FILE,
);

const DSH_HEADLESS_USAGE_RUNNER_MODE = 0o600;
export const DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES = 64 * 1024;
const DSH_HEADLESS_USAGE_RUNNER_SCOPE = 'managed-state';

function initialBundledRunnerDigest() {
  const metadata = lstatSync(DEFAULT_DSH_HEADLESS_USAGE_RUNNER_FILE);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES) {
    throw new Error('The bundled DSH usage runner is missing, invalid, or too large.');
  }
  const bytes = readFileSync(DEFAULT_DSH_HEADLESS_USAGE_RUNNER_FILE);
  if (bytes.length > DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES) {
    throw new Error('The bundled DSH usage runner exceeds the fixed size limit.');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

// The package asset is trusted at module load, but it is still size-checked
// before this initial digest read.  Later reads are independently bounded and
// compared with this load-time digest.
export const DSH_HEADLESS_USAGE_RUNNER_SHA256 = initialBundledRunnerDigest();

const ENVIRONMENT_NAMES = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
]);
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const NOFOLLOW_FLAG = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = Number.isInteger(constants.O_DIRECTORY) ? constants.O_DIRECTORY : 0;
const PROC_FD_ROOT = process.platform === 'linux' ? '/proc/self/fd' : null;

function cleanOutput(value, maximum = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function explicitHome(env) {
  const value = env.CODEX_CO_ENGINEER_DSH_HOME ?? env.DSH_HOME;
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { path: null, source: 'invalid', reason: 'configured DSH_HOME is empty.' };
  }
  if (!path.isAbsolute(value)) {
    return { path: null, source: 'invalid', reason: 'configured DSH_HOME must be absolute.' };
  }
  return {
    path: path.resolve(value),
    source: env.CODEX_CO_ENGINEER_DSH_HOME !== undefined
      ? 'explicit-codex'
      : 'explicit-dsh',
    reason: null,
  };
}

/** Resolve a stable DSH home without falling back to the protected user home. */
export function resolveDshHome({ env = process.env, stateDirectory } = {}) {
  const configured = explicitHome(env);
  if (configured) return configured;
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) {
    return {
      path: null,
      source: 'unconfigured',
      reason: 'No absolute Co-Engineer state directory is available for the managed DSH home.',
    };
  }
  return {
    path: path.join(path.resolve(stateDirectory), 'dsh-home'),
    source: 'managed-state',
    reason: null,
  };
}

/**
 * Reconstruct the control plane's effective state directory from configuration
 * rather than trusting the DSH home supplied to inspectDsh.  The control
 * caller currently passes the process environment, so keeping this fallback
 * here preserves that call shape while still giving the runner an independent
 * managed-home anchor.
 */
function effectiveStateDirectory(env, stateDirectory) {
  if (stateDirectory !== undefined && stateDirectory !== null) {
    if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) return null;
    return path.resolve(stateDirectory);
  }
  return resolveStateDirectory(env).directory;
}

function derivedManagedDshConfig(env, stateDirectory) {
  const effective = effectiveStateDirectory(env, stateDirectory);
  if (!effective) return { stateDirectory: null, home: null, source: 'invalid' };
  const resolved = resolveDshHome({ env, stateDirectory: effective });
  return {
    stateDirectory: effective,
    home: resolved.source === 'managed-state' ? resolved.path : null,
    source: resolved.source,
  };
}

export function dshBaseEnvironment(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new TypeError('A resolved absolute DSH home is required.');
  }
  return {
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: 'DISABLED',
  };
}

export function dshChildEnvironment(home, options = {}) {
  const normalized = normalizeDshOptions(options);
  return {
    ...dshBaseEnvironment(home),
    DSH_TOOLS_MODE: normalized.tool_mode,
    CODEX_CO_ENGINEER_DSH_MODEL: normalized.model,
    CODEX_CO_ENGINEER_DSH_MAX_TOKENS: String(normalized.max_tokens),
  };
}

function probeEnvironment(env, home) {
  return {
    ...safeEnvironment(env),
    ...dshBaseEnvironment(home),
  };
}

function safeEnvironment(env) {
  return Object.fromEntries(
    ENVIRONMENT_NAMES
      .filter((name) => env?.[name] !== undefined)
      .map((name) => [name, env[name]]),
  );
}

function executableProbe(command, commandPrefix, env) {
  const result = spawnSync(command, [...commandPrefix, '--version'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 32 * 1024,
  });
  const output = cleanOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.status === 0 && !result.error && output) {
    return {
      state: 'installed',
      version: output || null,
      compatible: output.includes(TESTED_DSH_VERSION),
      detail: null,
    };
  }
  if (result.error?.code === 'ENOENT') {
    return {
      state: 'missing',
      version: null,
      compatible: false,
      detail: 'The dsh executable was not found on PATH.',
    };
  }
  return {
    state: 'unavailable',
    version: output || null,
    compatible: false,
    detail: cleanOutput(result.error?.message ?? output ?? 'dsh --version failed.'),
  };
}

export function dshVersionProbe(command = 'dsh', env = process.env, home = null) {
  const childEnv = typeof home === 'string' && path.isAbsolute(home)
    ? probeEnvironment(env, home)
    : safeEnvironment(env);
  return executableProbe(command, [], childEnv);
}

function homeWritable(home) {
  try {
    accessSync(home, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fileIdentity(metadata) {
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

function sameIdentity(left, right) {
  return Boolean(left && right
    && left.device === right.device
    && left.inode === right.inode);
}

function pathComponents(absolute) {
  const components = [];
  let component = path.resolve(absolute);
  while (true) {
    components.unshift(component);
    const parent = path.dirname(component);
    if (parent === component) break;
    component = parent;
  }
  return components;
}

function filesystemError(error, target) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
    return {
      reason: 'home_unwritable',
      detail: `The managed DSH path cannot be inspected or created (${target}).`,
    };
  }
  if (error?.code === 'ENOTDIR') {
    return {
      reason: 'home_not_directory',
      detail: `The managed DSH path contains a non-directory component (${target}).`,
    };
  }
  return {
    reason: 'home_unavailable',
    detail: `The managed DSH path cannot be inspected (${target}).`,
  };
}

function directoryShapeError(component, metadata, final) {
  if (metadata.isSymbolicLink()) {
    return {
      reason: final ? 'home_symlink' : 'home_ancestor_symlink',
      detail: `The managed DSH path contains a symlink (${component}).`,
    };
  }
  if (!metadata.isDirectory()) {
    return {
      reason: final ? 'home_not_directory' : 'home_ancestor_not_directory',
      detail: `The managed DSH path requires real directories (${component}).`,
    };
  }
  return null;
}

function ownerOnlyError(component, metadata, kind) {
  const uid = currentUid();
  if (uid !== null && metadata.uid !== uid) {
    return {
      reason: `${kind}_owner_mismatch`,
      detail: `The managed DSH ${kind} must be owned by the MCP process user (${component}).`,
    };
  }
  const expectedMode = ['home', 'profile', 'runner_parent'].includes(kind)
    ? OWNER_ONLY_DIRECTORY_MODE
    : OWNER_ONLY_FILE_MODE;
  if ((metadata.mode & 0o7777) !== expectedMode) {
    return {
      reason: `${kind}_permissions`,
      detail: `The managed DSH ${kind} must have exact mode ${expectedMode.toString(8).padStart(4, '0')} (${component}).`,
    };
  }
  return null;
}

function runnerFailure(reason, detail, runnerPath = null) {
  return {
    ok: false,
    path: runnerPath,
    created: false,
    sha256: null,
    reason,
    detail,
  };
}

function runnerScopeAllowed(source, patchFile, home, trustedManagedHome, stateDirectory) {
  if (source !== DSH_HEADLESS_USAGE_RUNNER_SCOPE || patchFile !== DEFAULT_DSH_PATCH_FILE) {
    return false;
  }
  if (typeof trustedManagedHome !== 'string' || !path.isAbsolute(trustedManagedHome)) {
    return false;
  }
  if (path.resolve(home) !== path.resolve(trustedManagedHome)) return false;
  if (stateDirectory !== undefined && stateDirectory !== null) {
    if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) return false;
    const expectedManagedHome = path.join(path.resolve(stateDirectory), 'dsh-home');
    if (path.resolve(home) !== expectedManagedHome) return false;
  }
  return true;
}

function runnerParentStatus(home, profileRoot, runnerPath) {
  if (!pathWithin(home, profileRoot) || !pathWithin(home, runnerPath)) {
    return runnerFailure(
      'runner_outside_home',
      'The managed DSH usage runner must remain beneath the exact configured DSH home.',
      runnerPath,
    );
  }
  const parents = [];
  for (const component of pathComponents(profileRoot)) {
    if (!pathWithin(home, component)) continue;
    let metadata;
    try {
      metadata = lstatSync(component);
    } catch (error) {
      return runnerFailure(
        error?.code === 'ENOENT' ? 'runner_profile_missing' : 'runner_parent_unavailable',
        error?.code === 'ENOENT'
          ? 'The DSH headless profile was not created before runner materialization.'
          : 'The DSH headless profile cannot be inspected before runner materialization.',
        runnerPath,
      );
    }
    if (metadata.isSymbolicLink()) {
      return runnerFailure(
        'runner_parent_symlink',
        'The DSH headless profile path may not contain a symlink.',
        runnerPath,
      );
    }
    if (!metadata.isDirectory()) {
      return runnerFailure(
        'runner_parent_not_directory',
        'The DSH headless profile path requires real directories.',
        runnerPath,
      );
    }
    const ownerError = ownerOnlyError(component, metadata, 'runner_parent');
    if (ownerError) return runnerFailure(ownerError.reason, ownerError.detail, runnerPath);
    parents.push({
      path: component,
      identity: fileIdentity(metadata),
      mode: metadata.mode & 0o7777,
    });
  }
  return { ok: true, path: runnerPath, parents };
}

function runnerParentRevalidated(snapshot, runnerPath = snapshot?.path) {
  if (!snapshot?.ok || !Array.isArray(snapshot.parents)) {
    return runnerFailure('runner_parent_unavailable', 'The DSH headless profile parents could not be revalidated.', runnerPath);
  }
  for (const parent of snapshot.parents) {
    let metadata;
    try {
      metadata = lstatSync(parent.path);
    } catch {
      return runnerFailure(
        'runner_parent_replaced',
        'A DSH headless profile parent disappeared while the usage runner was being materialized.',
        runnerPath,
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return runnerFailure(
        metadata.isSymbolicLink() ? 'runner_parent_symlink' : 'runner_parent_not_directory',
        'The DSH headless profile path changed while the usage runner was being materialized.',
        runnerPath,
      );
    }
    const ownerError = ownerOnlyError(parent.path, metadata, 'runner_parent');
    if (ownerError) return runnerFailure(ownerError.reason, ownerError.detail, runnerPath);
    if (!sameIdentity(fileIdentity(metadata), parent.identity)) {
      return runnerFailure(
        'runner_parent_replaced',
        'A DSH headless profile parent changed while the usage runner was being materialized.',
        runnerPath,
      );
    }
    if ((metadata.mode & 0o7777) !== parent.mode) {
      return runnerFailure(
        'runner_parent_permissions',
        'A DSH headless profile parent mode changed while the usage runner was being materialized.',
        runnerPath,
      );
    }
  }
  return { ok: true, path: runnerPath, parents: snapshot.parents };
}

function runnerDirectoryHandle(profileRoot, snapshot, runnerPath) {
  if (!PROC_FD_ROOT || NOFOLLOW_FLAG === 0 || DIRECTORY_FLAG === 0) {
    return runnerFailure(
      'runner_secure_io_unavailable',
      'The managed DSH usage runner requires Linux directory-handle support for safe materialization.',
      runnerPath,
    );
  }
  let descriptor;
  try {
    descriptor = openSync(profileRoot, constants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG);
    const metadata = fstatSync(descriptor);
    const expected = snapshot.parents.find((parent) => parent.path === profileRoot);
    if (!expected || !metadata.isDirectory()) {
      closeSync(descriptor);
      return runnerFailure(
        'runner_parent_replaced',
        'The DSH headless profile changed while the usage runner was being materialized.',
        runnerPath,
      );
    }
    const ownerError = ownerOnlyError(profileRoot, metadata, 'runner_parent');
    if (ownerError || !sameIdentity(fileIdentity(metadata), expected.identity)
      || (metadata.mode & 0o7777) !== expected.mode) {
      closeSync(descriptor);
      return runnerFailure(
        ownerError?.reason ?? 'runner_parent_replaced',
        ownerError?.detail ?? 'The DSH headless profile changed while the usage runner was being materialized.',
        runnerPath,
      );
    }
    return { ok: true, descriptor, path: runnerPath, directoryPath: path.join(PROC_FD_ROOT, String(descriptor)) };
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    return runnerFailure(
      'runner_secure_io_unavailable',
      'The managed DSH usage runner directory could not be opened securely.',
      runnerPath,
    );
  }
}

function writeBoundedDescriptor(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(count) || count <= 0) throw new Error('short runner write');
    offset += count;
  }
}

function boundedFileRead(filePath, maximum, expectedIdentity = null) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | NOFOLLOW_FLAG);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) return { ok: false, reason: 'not_regular' };
    if (metadata.size > maximum) return { ok: false, reason: 'too_large' };
    if (expectedIdentity && !sameIdentity(fileIdentity(metadata), expectedIdentity)) {
      return { ok: false, reason: 'replaced' };
    }
    const bytes = Buffer.allocUnsafe(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximum || metadata.size > maximum) return { ok: false, reason: 'too_large' };
    const finalMetadata = fstatSync(descriptor);
    if (!finalMetadata.isFile()) return { ok: false, reason: 'not_regular' };
    if (!sameIdentity(fileIdentity(finalMetadata), fileIdentity(metadata))) {
      return { ok: false, reason: 'replaced' };
    }
    if (finalMetadata.size > maximum || offset > maximum) return { ok: false, reason: 'too_large' };
    return { ok: true, bytes: bytes.subarray(0, offset), metadata: finalMetadata };
  } catch (error) {
    return { ok: false, reason: error?.code === 'EFBIG' ? 'too_large' : 'unavailable' };
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function bundledRunner() {
  let metadata;
  try {
    metadata = lstatSync(DEFAULT_DSH_HEADLESS_USAGE_RUNNER_FILE);
  } catch {
    return runnerFailure('runner_asset_missing', 'The bundled DSH usage runner is missing.');
  }
  if (metadata.isSymbolicLink()) {
    return runnerFailure('runner_asset_symlink', 'The bundled DSH usage runner may not be a symlink.');
  }
  if (!metadata.isFile()) {
    return runnerFailure('runner_asset_not_regular', 'The bundled DSH usage runner must be a regular file.');
  }
  if (metadata.size > DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES) {
    return runnerFailure('runner_asset_too_large', 'The bundled DSH usage runner exceeds the fixed size limit.');
  }
  const bounded = boundedFileRead(
    DEFAULT_DSH_HEADLESS_USAGE_RUNNER_FILE,
    DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES,
    fileIdentity(metadata),
  );
  if (!bounded.ok) {
    return runnerFailure(
      bounded.reason === 'too_large' ? 'runner_asset_too_large' : 'runner_asset_unavailable',
      bounded.reason === 'too_large'
        ? 'The bundled DSH usage runner exceeds the fixed size limit.'
        : 'The bundled DSH usage runner cannot be read.',
    );
  }
  const bytes = bounded.bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== DSH_HEADLESS_USAGE_RUNNER_SHA256) {
    return runnerFailure('runner_asset_changed', 'The bundled DSH usage runner changed after adapter load.');
  }
  return { ok: true, bytes, sha256 };
}

function validateRunnerFile(runnerPath, expected) {
  let metadata;
  try {
    metadata = lstatSync(runnerPath);
  } catch (error) {
    return runnerFailure(
      error?.code === 'ENOENT' ? 'runner_missing' : 'runner_unavailable',
      error?.code === 'ENOENT'
        ? 'The managed DSH usage runner is missing from the headless profile.'
        : 'The managed DSH usage runner cannot be inspected.',
      runnerPath,
    );
  }
  if (metadata.isSymbolicLink()) {
    return runnerFailure('runner_symlink', 'The managed DSH usage runner may not be a symlink.', runnerPath);
  }
  if (!metadata.isFile()) {
    return runnerFailure('runner_not_regular', 'The managed DSH usage runner must be a regular file.', runnerPath);
  }
  const ownerError = ownerOnlyError(runnerPath, metadata, 'usage_runner');
  if (ownerError?.reason === 'usage_runner_owner_mismatch') {
    return runnerFailure(ownerError.reason, ownerError.detail, runnerPath);
  }
  if (metadata.size > DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES) {
    return runnerFailure('runner_too_large', 'The managed DSH usage runner exceeds the fixed size limit.', runnerPath);
  }
  const bounded = boundedFileRead(
    runnerPath,
    DSH_HEADLESS_USAGE_RUNNER_MAX_BYTES,
    fileIdentity(metadata),
  );
  if (!bounded.ok) {
    return runnerFailure(
      bounded.reason === 'too_large' ? 'runner_too_large' : 'runner_unavailable',
      bounded.reason === 'too_large'
        ? 'The managed DSH usage runner exceeds the fixed size limit.'
        : 'The managed DSH usage runner cannot be read.',
      runnerPath,
    );
  }
  metadata = bounded.metadata;
  const bytes = bounded.bytes;
  const finalOwnerError = ownerOnlyError(runnerPath, metadata, 'usage_runner');
  if (finalOwnerError?.reason === 'usage_runner_owner_mismatch') {
    return runnerFailure(finalOwnerError.reason, finalOwnerError.detail, runnerPath);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.sha256 || !bytes.equals(expected.bytes)) {
    return runnerFailure('runner_tampered', 'The managed DSH usage runner does not match the bundled asset.', runnerPath);
  }
  if (ownerError || finalOwnerError) {
    // Do not chmod an already-existing path: a replacement between lstat and
    // chmod could make the adapter modify an attacker-selected file.  New
    // materializations are created with the exact mode below.
    return runnerFailure('runner_permissions', (finalOwnerError ?? ownerError).detail, runnerPath);
  }
  if ((metadata.mode & 0o7777) !== DSH_HEADLESS_USAGE_RUNNER_MODE) {
    return runnerFailure(
      'runner_permissions',
      'The managed DSH usage runner must have exact owner-read/write mode 0600.',
      runnerPath,
    );
  }
  return { ok: true, path: runnerPath, created: false, sha256 };
}

/**
 * Materialize the one trusted DSH usage runner only inside the managed
 * headless profile.  Custom DSH homes are intentionally rejected before any
 * filesystem operation.  Existing files are byte/hash checked; a missing
 * file is created only during initialization using an atomic hard-link.
 */
export function materializeDshHeadlessUsageRunner({
  home,
  source,
  patchFile,
  trustedManagedHome,
  stateDirectory,
  initialize = true,
  // Test-only synchronous seam.  Production callers omit this.  The parent
  // snapshot is always revalidated after each hook and before link(2).
  onBeforeTemporary,
  onBeforeLink,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    return runnerFailure('runner_invalid_home', 'A resolved absolute DSH home is required.');
  }
  const profileRoot = path.join(home, 'profiles', DSH_PROFILE);
  const runnerPath = path.join(profileRoot, DSH_HEADLESS_USAGE_RUNNER_FILE);
  if (!runnerScopeAllowed(source, patchFile, home, trustedManagedHome, stateDirectory)) {
    return runnerFailure(
      'runner_untrusted_scope',
      'The DSH usage runner may be materialized only for the managed state home with the exact bundled patch.',
      runnerPath,
    );
  }
  const parent = runnerParentStatus(home, profileRoot, runnerPath);
  if (!parent.ok) return parent;
  const expected = bundledRunner();
  if (!expected.ok) return { ...expected, path: runnerPath };

  const existing = validateRunnerFile(runnerPath, expected);
  if (existing.ok) {
    const unchanged = runnerParentRevalidated(parent, runnerPath);
    return unchanged.ok ? existing : unchanged;
  }
  if (existing.reason !== 'runner_missing' || !initialize) return existing;

  // Keep every create/link operation relative to a directory descriptor that
  // was opened with O_DIRECTORY|O_NOFOLLOW and checked against the snapshot.
  // A lexical path recheck alone still leaves a window where a replaced
  // profile parent could receive the temporary file before the next lstat.
  const beforeDirectory = runnerParentRevalidated(parent, runnerPath);
  if (!beforeDirectory.ok) return beforeDirectory;
  const directory = runnerDirectoryHandle(profileRoot, parent, runnerPath);
  if (!directory.ok) return directory;
  const temporaryName = `${DSH_HEADLESS_USAGE_RUNNER_FILE}.tmp-${process.pid}-${randomUUID()}`;
  const temporary = path.join(directory.directoryPath, temporaryName);
  const destination = path.join(directory.directoryPath, DSH_HEADLESS_USAGE_RUNNER_FILE);
  let temporaryDescriptor;
  let temporaryIdentity = null;
  try {
    if (typeof onBeforeTemporary === 'function') onBeforeTemporary();
    temporaryDescriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
      DSH_HEADLESS_USAGE_RUNNER_MODE,
    );
    fchmodSync(temporaryDescriptor, DSH_HEADLESS_USAGE_RUNNER_MODE);
    writeBoundedDescriptor(temporaryDescriptor, expected.bytes);
    const temporaryMetadata = fstatSync(temporaryDescriptor);
    if (!temporaryMetadata.isFile()
      || (temporaryMetadata.mode & 0o7777) !== DSH_HEADLESS_USAGE_RUNNER_MODE
      || temporaryMetadata.size !== expected.bytes.length
      || (currentUid() !== null && temporaryMetadata.uid !== currentUid())) {
      return runnerFailure('runner_materialize_failed', 'The managed DSH usage runner could not be materialized safely.', runnerPath);
    }
    temporaryIdentity = fileIdentity(temporaryMetadata);
    if (typeof onBeforeLink === 'function') onBeforeLink();
    const beforeLink = runnerParentRevalidated(parent, runnerPath);
    if (!beforeLink.ok) return beforeLink;
    let created = true;
    try {
      // Both paths are anchored through the already-open directory handle.
      // link(2) creates the destination atomically without replacing a file,
      // while a later parent replacement cannot redirect either operation.
      linkSync(temporary, destination);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return runnerFailure('runner_materialize_failed', 'The managed DSH usage runner could not be materialized.', runnerPath);
      }
      created = false;
    }
    const afterLink = runnerParentRevalidated(parent, runnerPath);
    if (!afterLink.ok) return afterLink;
    const materialized = validateRunnerFile(runnerPath, expected);
    return materialized.ok
      ? { ...materialized, created }
      : materialized;
  } catch {
    return runnerFailure('runner_materialize_failed', 'The managed DSH usage runner could not be materialized.', runnerPath);
  } finally {
    if (temporaryDescriptor !== undefined) {
      if (temporaryIdentity) {
        try {
          const temporaryMetadata = fstatSync(temporaryDescriptor);
          if (temporaryMetadata.isFile()
            && sameIdentity(fileIdentity(temporaryMetadata), temporaryIdentity)) {
            unlinkSync(temporary);
          }
        } catch {}
      }
      try { closeSync(temporaryDescriptor); } catch {}
    }
    try { closeSync(directory.descriptor); } catch {}
  }
}

/**
 * Inspect every lexical home component without following symlinks.  Public
 * ancestors such as /tmp may be root-owned; a group/world-writable ancestor
 * is accepted only when it has the sticky bit.  The final DSH home is always
 * owned by this process and has no group/world permission bits.
 */
function ensureSecureHome(home) {
  const components = pathComponents(home);
  const root = components[0];
  let homeMetadata = null;
  for (const component of components) {
    let metadata;
    try {
      metadata = lstatSync(component);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, ...filesystemError(error, component) };
      try {
        mkdirSync(component, { mode: OWNER_ONLY_DIRECTORY_MODE });
        // mkdir honours umask, so enforce the intended mode explicitly.
        chmodSync(component, OWNER_ONLY_DIRECTORY_MODE);
        metadata = lstatSync(component);
      } catch (createError) {
        return { ok: false, ...filesystemError(createError, component) };
      }
    }
    const shapeError = directoryShapeError(component, metadata, component === home);
    if (shapeError) return { ok: false, ...shapeError };
    const isRoot = component === root;
    const isFinal = component === home;
    if (!isRoot && !isFinal && (metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) {
      return {
        ok: false,
        reason: 'home_ancestor_permissions',
        detail: `The managed DSH path has a group/world-writable ancestor without a sticky bit (${component}).`,
      };
    }
    if (isFinal) {
      const securityError = ownerOnlyError(component, metadata, 'home');
      if (securityError) return { ok: false, ...securityError };
      homeMetadata = metadata;
    }
  }
  if (!homeMetadata) {
    return {
      ok: false,
      reason: 'home_unavailable',
      detail: 'The managed DSH home could not be inspected.',
    };
  }
  if (!homeWritable(home)) {
    return {
      ok: false,
      reason: 'home_unwritable',
      detail: 'The configured DSH home is not writable by the task process.',
    };
  }
  return { ok: true, identity: fileIdentity(homeMetadata) };
}

function profileFailure(reason, detail, profileIdentity = null, packageIdentity = null) {
  return {
    ok: false,
    reason,
    detail,
    identity: { profile: profileIdentity, package: packageIdentity },
  };
}

function inspectProfileTree(home, profileRoot, profilePackage, { repair = false } = {}) {
  if (!pathWithin(home, profileRoot) || !pathWithin(home, profilePackage)) {
    return profileFailure(
      'profile_outside_home',
      'The materialized DSH profile must remain beneath the exact configured DSH home.',
    );
  }
  const fixPermissions = (candidate, metadata, directory) => {
    const securityError = ownerOnlyError(candidate, metadata, directory ? 'profile' : 'profile_file');
    if (!securityError) return { metadata, error: null };
    if (!repair || (currentUid() !== null && metadata.uid !== currentUid())) {
      return { metadata, error: securityError };
    }
    try {
      chmodSync(candidate, directory ? OWNER_ONLY_DIRECTORY_MODE : OWNER_ONLY_FILE_MODE);
      const repaired = lstatSync(candidate);
      return { metadata: repaired, error: ownerOnlyError(candidate, repaired, directory ? 'profile' : 'profile_file') };
    } catch {
      return {
        metadata,
        error: {
          reason: directory ? 'profile_permissions' : 'profile_file_permissions',
          detail: `The materialized DSH ${directory ? 'profile directory' : 'profile file'} could not be made owner-only.`,
        },
      };
    }
  };
  const profileContainer = path.dirname(profileRoot);
  let containerMetadata;
  try {
    containerMetadata = lstatSync(profileContainer);
  } catch (error) {
    return profileFailure(
      error?.code === 'ENOENT' ? 'profile_missing' : 'profile_unavailable',
      error?.code === 'ENOENT'
        ? 'DSH did not expose a profiles directory.'
        : `The DSH profiles directory cannot be inspected (${profileContainer}).`,
    );
  }
  const containerShapeError = directoryShapeError(profileContainer, containerMetadata, true);
  if (containerShapeError) {
    return profileFailure(
      containerShapeError.reason === 'home_symlink' ? 'profile_symlink' : 'profile_not_directory',
      containerShapeError.detail,
    );
  }
  const containerPermission = fixPermissions(profileContainer, containerMetadata, true);
  if (containerPermission.error) {
    return profileFailure(containerPermission.error.reason, containerPermission.error.detail);
  }
  containerMetadata = containerPermission.metadata;
  let rootMetadata;
  try {
    rootMetadata = lstatSync(profileRoot);
  } catch (error) {
    return profileFailure(
      error?.code === 'ENOENT' ? 'profile_missing' : 'profile_unavailable',
      error?.code === 'ENOENT'
        ? 'DSH did not expose a headless profile.'
        : `The DSH profile cannot be inspected (${profileRoot}).`,
    );
  }
  const rootShapeError = directoryShapeError(profileRoot, rootMetadata, true);
  if (rootShapeError) {
    return profileFailure(
      rootShapeError.reason === 'home_symlink' ? 'profile_symlink' : 'profile_not_directory',
      rootShapeError.detail,
    );
  }
  const rootPermission = fixPermissions(profileRoot, rootMetadata, true);
  if (rootPermission.error) {
    return profileFailure(rootPermission.error.reason, rootPermission.error.detail);
  }
  rootMetadata = rootPermission.metadata;
  const profileIdentity = fileIdentity(rootMetadata);
  let packageMetadata = null;
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return profileFailure('profile_unavailable', `The DSH profile cannot be read (${directory}).`, profileIdentity, packageMetadata && fileIdentity(packageMetadata));
    }
    for (const entry of entries) {
      const candidate = path.resolve(directory, entry.name);
      if (!pathWithin(home, candidate)) {
        return profileFailure('profile_outside_home', 'A materialized DSH profile path escaped the exact configured home.', profileIdentity, packageMetadata && fileIdentity(packageMetadata));
      }
      let metadata;
      try {
        metadata = lstatSync(candidate);
      } catch {
        return profileFailure('profile_unavailable', `A materialized DSH profile entry disappeared (${candidate}).`, profileIdentity, packageMetadata && fileIdentity(packageMetadata));
      }
      if (metadata.isSymbolicLink()) {
        return profileFailure('profile_file_symlink', 'Materialized DSH profile entries may not be symlinks.', profileIdentity, packageMetadata && fileIdentity(packageMetadata));
      }
      if (metadata.isDirectory()) {
        const permission = fixPermissions(candidate, metadata, true);
        if (permission.error) return profileFailure(permission.error.reason, permission.error.detail, profileIdentity, packageMetadata && fileIdentity(packageMetadata));
        const nestedError = visit(candidate);
        if (nestedError) return nestedError;
        continue;
      }
      if (!metadata.isFile()) {
        return profileFailure('profile_file_not_regular', 'Materialized DSH profile entries must be regular files.', profileIdentity, packageMetadata && fileIdentity(packageMetadata));
      }
      const permission = fixPermissions(candidate, metadata, false);
      if (permission.error) return profileFailure(permission.error.reason, permission.error.detail, profileIdentity, packageMetadata && fileIdentity(packageMetadata));
      metadata = permission.metadata;
      if (candidate === profilePackage) packageMetadata = metadata;
    }
    return null;
  };
  const treeError = visit(profileRoot);
  if (treeError) return treeError;
  if (!packageMetadata) {
    try {
      packageMetadata = lstatSync(profilePackage);
    } catch {
      return profileFailure('profile_missing', 'DSH exited successfully but did not expose a headless profile.', profileIdentity, null);
    }
    if (packageMetadata.isSymbolicLink() || !packageMetadata.isFile()) {
      return profileFailure('profile_file_not_regular', 'The DSH profile package must be a regular file.', profileIdentity, null);
    }
  }
  const packageSecurityError = ownerOnlyError(profilePackage, packageMetadata, 'profile_file');
  if (packageSecurityError) return profileFailure(packageSecurityError.reason, packageSecurityError.detail, profileIdentity, fileIdentity(packageMetadata));
  let finalPackageMetadata = packageMetadata;
  try {
    const finalContainer = lstatSync(profileContainer);
    const finalRoot = lstatSync(profileRoot);
    const finalPackage = lstatSync(profilePackage);
    if (finalContainer.isSymbolicLink() || !finalContainer.isDirectory()
      || finalRoot.isSymbolicLink() || !finalRoot.isDirectory()
      || finalPackage.isSymbolicLink() || !finalPackage.isFile()
      || !sameIdentity(fileIdentity(finalContainer), fileIdentity(containerMetadata))
      || !sameIdentity(fileIdentity(finalRoot), profileIdentity)
      || !sameIdentity(fileIdentity(finalPackage), fileIdentity(packageMetadata))) {
      return profileFailure(
        'profile_replaced',
        'The materialized DSH profile changed while the profile tree was being checked.',
        profileIdentity,
        fileIdentity(packageMetadata),
      );
    }
    const containerSecurityError = ownerOnlyError(profileContainer, finalContainer, 'profile');
    if (containerSecurityError) {
      return profileFailure(containerSecurityError.reason, containerSecurityError.detail, profileIdentity, fileIdentity(packageMetadata));
    }
    const rootSecurityError = ownerOnlyError(profileRoot, finalRoot, 'profile');
    if (rootSecurityError) {
      return profileFailure(rootSecurityError.reason, rootSecurityError.detail, profileIdentity, fileIdentity(packageMetadata));
    }
    const finalPackageSecurityError = ownerOnlyError(profilePackage, finalPackage, 'profile_file');
    if (finalPackageSecurityError) {
      return profileFailure(finalPackageSecurityError.reason, finalPackageSecurityError.detail, profileIdentity, fileIdentity(finalPackage));
    }
    finalPackageMetadata = finalPackage;
  } catch {
    return profileFailure(
      'profile_replaced',
      'The materialized DSH profile directories could not be revalidated.',
      profileIdentity,
      fileIdentity(packageMetadata),
    );
  }
  return {
    ok: true,
    identity: { profile: profileIdentity, package: fileIdentity(finalPackageMetadata) },
  };
}

function expectedIdentityError(actual, expected) {
  if (!expected) return null;
  if (!sameIdentity(actual?.home, expected.home)) {
    return { reason: 'home_replaced', detail: 'The configured DSH home changed after readiness was established.' };
  }
  if (!sameIdentity(actual?.profile, expected.profile)
    || !sameIdentity(actual?.package, expected.package)) {
    return { reason: 'profile_replaced', detail: 'The materialized DSH profile changed after readiness was established.' };
  }
  return null;
}

/**
 * Resolve and, when needed, materialize the local headless profile.  The
 * command is a bounded, provider-free `dsh --dump-config` call; no prompt or
 * credential is supplied.  A failed filesystem/profile check is returned to
 * the caller so dispatch can fail before a worker is submitted.
 */
export function inspectDsh({
  command = 'dsh',
  commandPrefix = [],
  home,
  source = 'configured',
  patchFile = null,
  env = process.env,
  cwd = process.cwd(),
  initialize = true,
  expectedIdentity = null,
  stateDirectory,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    return {
      ok: false,
      configured: false,
      usable: false,
      source,
      home: home ?? null,
      profile: DSH_PROFILE,
      reason: 'unconfigured_home',
      detail: 'The managed DSH home is not an absolute path.',
      executable_state: 'unknown',
      version: null,
      identity: null,
    };
  }
  const childEnv = probeEnvironment(env, home);
  const executable = executableProbe(command, commandPrefix, childEnv);
  const base = {
    ok: false,
    configured: executable.compatible,
    usable: false,
    source,
    home,
    profile: DSH_PROFILE,
    reason: null,
    detail: null,
    executable_state: executable.state,
    version: executable.version,
    identity: null,
  };
  if (executable.state === 'missing') {
    return { ...base, reason: 'executable_missing', detail: executable.detail };
  }
  if (executable.state !== 'installed') {
    return { ...base, reason: 'executable_unavailable', detail: executable.detail };
  }
  if (!executable.compatible) {
    return {
      ...base,
      reason: 'unsupported_version',
      detail: `DeepSeek Harness ${TESTED_DSH_VERSION} is required.`,
    };
  }
  if (patchFile) {
    try {
      const patchMetadata = lstatSync(patchFile);
      if (patchMetadata.isSymbolicLink() || !patchMetadata.isFile()) throw new Error('invalid patch');
    } catch {
      return { ...base, reason: 'profile_patch_missing', detail: 'The managed headless profile patch is missing.' };
    }
  }

  const managedDsh = derivedManagedDshConfig(env, stateDirectory);
  const trustedManagedHome = managedDsh.source === 'managed-state' ? managedDsh.home : null;
  const runnerScope = runnerScopeAllowed(
    source,
    patchFile,
    home,
    trustedManagedHome,
    managedDsh.stateDirectory,
  );
  if (source === DSH_HEADLESS_USAGE_RUNNER_SCOPE && patchFile === DEFAULT_DSH_PATCH_FILE && !runnerScope) {
    return {
      ...base,
      reason: 'runner_untrusted_scope',
      detail: 'The managed DSH usage runner may be materialized only for the independently configured managed state home.',
    };
  }

  const secureHome = ensureSecureHome(home);
  if (!secureHome.ok) return { ...base, ...secureHome };
  const homeIdentity = secureHome.identity;
  if (expectedIdentity && !sameIdentity(homeIdentity, expectedIdentity.home)) {
    return {
      ...base,
      reason: 'home_replaced',
      detail: 'The configured DSH home changed after readiness was established.',
      identity: { home: homeIdentity },
    };
  }

  const profilePackage = path.join(home, 'profiles', DSH_PROFILE, 'package.json');
  const profileRoot = path.dirname(profilePackage);
  if (initialize) {
    const args = ['--profile', DSH_PROFILE];
    if (patchFile) args.push('--patch', patchFile);
    args.push('--dump-config');
    const result = spawnSync(command, [...commandPrefix, ...args], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 256 * 1024,
    });
    if (result.status !== 0) {
      return {
        ...base,
        identity: { home: homeIdentity },
        reason: 'profile_unavailable',
        detail: 'The DSH headless profile could not be materialized in the configured home.',
      };
    }
  }

  // Re-check the home after the child exits.  A replacement or symlink race
  // must never be promoted into the readiness cache.
  const finalHome = ensureSecureHome(home);
  if (!finalHome.ok) return { ...base, ...finalHome, identity: { home: homeIdentity } };
  if (!sameIdentity(homeIdentity, finalHome.identity)) {
    return {
      ...base,
      reason: 'home_replaced',
      detail: 'The configured DSH home changed while readiness was being checked.',
      identity: { home: finalHome.identity },
    };
  }
  // DSH may emit conventional 0775/0664 profile modes.  Harden
  // and verify the complete generated tree (including profiles/ and the
  // headless root) before the runner's stricter parent checks and writes.
  const preparedProfile = inspectProfileTree(home, profileRoot, profilePackage, { repair: initialize });
  if (!preparedProfile.ok) {
    return {
      ...base,
      reason: preparedProfile.reason,
      detail: preparedProfile.detail,
      identity: { home: homeIdentity, ...preparedProfile.identity },
    };
  }
  const preparedIdentity = { home: homeIdentity, ...preparedProfile.identity };
  const preparedIdentityError = expectedIdentityError(preparedIdentity, expectedIdentity);
  if (preparedIdentityError) {
    return { ...base, ...preparedIdentityError, identity: preparedIdentity };
  }
  if (runnerScope) {
    const runner = materializeDshHeadlessUsageRunner({
      home,
      source,
      patchFile,
      trustedManagedHome,
      stateDirectory: managedDsh.stateDirectory,
      initialize,
    });
    if (!runner.ok) {
      return {
        ...base,
        reason: runner.reason,
        detail: runner.detail,
        identity: { home: homeIdentity },
      };
    }
  }
  // Revalidate both the home and the now-complete profile without repairing
  // anything.  This makes runner installation part of the identity window and
  // ensures a replacement cannot be promoted into readiness.
  const completedHome = ensureSecureHome(home);
  if (!completedHome.ok) return { ...base, ...completedHome, identity: preparedIdentity };
  if (!sameIdentity(homeIdentity, completedHome.identity)) {
    return {
      ...base,
      reason: 'home_replaced',
      detail: 'The configured DSH home changed while the usage runner was being materialized.',
      identity: { ...preparedIdentity, home: completedHome.identity },
    };
  }
  const profile = inspectProfileTree(home, profileRoot, profilePackage, { repair: false });
  if (!profile.ok) {
    return {
      ...base,
      reason: profile.reason,
      detail: profile.detail,
      identity: { home: homeIdentity, ...profile.identity },
    };
  }
  const actualIdentity = { home: homeIdentity, ...profile.identity };
  const materializationIdentityError = expectedIdentityError(actualIdentity, preparedIdentity);
  if (materializationIdentityError) {
    return { ...base, ...materializationIdentityError, identity: actualIdentity };
  }
  const identityError = expectedIdentityError(actualIdentity, expectedIdentity);
  if (identityError) return { ...base, ...identityError, identity: actualIdentity };
  return {
    ...base,
    ok: true,
    usable: true,
    reason: null,
    detail: null,
    identity: actualIdentity,
  };
}

export function dshReadinessMessage(status) {
  if (status?.ok === true) return null;
  const reason = status?.reason ?? 'unavailable';
  const detail = status?.detail ? ` ${status.detail}` : '';
  return `DeepSeek Harness is not ready (${reason}).${detail} Set CODEX_CO_ENGINEER_DSH_HOME to a writable absolute path or repair the configured task state root before dispatch.`;
}
