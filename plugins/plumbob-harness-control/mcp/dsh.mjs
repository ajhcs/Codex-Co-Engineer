import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The DSH adapter owns only the launcher/profile boundary.  It never reads a
 * provider credential; MODEL_API_KEY is inherited only by the actual managed
 * worker after this local readiness check succeeds.
 */
export const TESTED_DSH_VERSION = '0.1.0-rc.6';
export const DSH_PROFILE = 'headless';

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DSH_PATCH_FILE = path.join(ADAPTER_ROOT, 'assets', 'dsh-headless.patch.yml');

const ENVIRONMENT_NAMES = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
]);
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

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

export function dshChildEnvironment(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new TypeError('A resolved absolute DSH home is required.');
  }
  return {
    DSH_HOME: home,
    DSH_TELEMETRY_MODE: 'DISABLED',
  };
}

function probeEnvironment(env, home) {
  return {
    ...safeEnvironment(env),
    ...dshChildEnvironment(home),
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
  if ((metadata.mode & 0o077) !== 0) {
    return {
      reason: `${kind}_permissions`,
      detail: `The managed DSH ${kind} must be owner-only (${component}).`,
    };
  }
  return null;
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
  const profileIdentity = fileIdentity(rootMetadata);
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
  return {
    ok: true,
    identity: { profile: profileIdentity, package: fileIdentity(packageMetadata) },
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
  const profile = inspectProfileTree(home, profileRoot, profilePackage, { repair: initialize });
  if (!profile.ok) {
    return {
      ...base,
      reason: profile.reason,
      detail: profile.detail,
      identity: { home: homeIdentity, ...profile.identity },
    };
  }
  const actualIdentity = { home: homeIdentity, ...profile.identity };
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
