import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

// ProfileV1 (ADR 0001: deterministic_explicit_or_profile_resolution,
// profiles_data_only). Profiles are owner-authored, data-only selection
// records. They never carry executables, argv, credentials, environment
// values, moving refs, direct-mode configuration, or merge/push/PR
// authority; VerificationPolicyV1 remains the only executable command
// catalog. This module loads and validates profile data only. Assignment
// resolution, defaults, and selection questions belong to the resolver.

export const PROFILE_SCHEMA = 'codex-co-engineer.profile.v1';
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const PROJECT_PROFILE_DIRNAME = '.codex';
export const PROJECT_PROFILE_FILENAME = 'co-engineer-profiles.json';
export const OWNER_PROFILE_DIRNAME = 'codex-co-engineer';
export const OWNER_PROFILE_FILENAME = 'profiles.json';

export const MAX_PROFILE_CATALOG_BYTES = 64 * 1024;
export const MAX_PROFILES_PER_CATALOG = 64;

// Mirrors the supervisor provider routes and DSH model identifiers without
// importing launch logic. Preflight attests the actual provider/model later;
// a profile only names a data selection.
export const PROFILE_PROVIDERS = Object.freeze(['dsh', 'grok', 'cursor-local', 'cursor-cloud']);
export const PROFILE_DSH_MODELS = Object.freeze(['muse-spark-1.2-contributor', 'stealth/ox-alpha']);
export const PROFILE_ROLES = Object.freeze(['review', 'implement']);
export const MIN_PROFILE_EXPECTED_DURATION_MS = 1_000;
export const MAX_PROFILE_EXPECTED_DURATION_MS = 86_400_000;

const SCOPES = Object.freeze(['project', 'owner']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function requireNormalizedAbsolute(value, code, label) {
  if (typeof value !== 'string' || value.length === 0 || path.resolve(value) !== value) {
    fail(code, `${label} must be an absolute, normalized path.`);
  }
  return value;
}

function defaultOwnerConfigDir(env) {
  if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0) {
    return path.resolve(env.XDG_CONFIG_HOME);
  }
  const home = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir();
  return path.join(home, '.config');
}

// Explicit roots: exactly one catalog path per scope, so lookup never depends
// on filesystem enumeration order.
export function profileRoots({ repositoryPath, ownerConfigDir, env = process.env } = {}) {
  const repo = requireNormalizedAbsolute(repositoryPath, 'invalid_profile_repository_path', 'repositoryPath');
  const ownerDir = ownerConfigDir === undefined
    ? defaultOwnerConfigDir(env)
    : requireNormalizedAbsolute(ownerConfigDir, 'invalid_profile_owner_config_dir', 'ownerConfigDir');
  return Object.freeze({
    project: Object.freeze({
      scope: 'project',
      dir: path.join(repo, PROJECT_PROFILE_DIRNAME),
      file: path.join(repo, PROJECT_PROFILE_DIRNAME, PROJECT_PROFILE_FILENAME),
    }),
    owner: Object.freeze({
      scope: 'owner',
      dir: path.join(ownerDir, OWNER_PROFILE_DIRNAME),
      file: path.join(ownerDir, OWNER_PROFILE_DIRNAME, OWNER_PROFILE_FILENAME),
    }),
  });
}

export function isValidProfileName(value) {
  return typeof value === 'string' && PROFILE_NAME_PATTERN.test(value);
}

// Rejects duplicate object keys anywhere in the document. JSON.parse alone
// silently keeps the last duplicate, which could quietly change selection
// data such as the provider named by a profile.
export function assertNoDuplicateCatalogKeys(text) {
  const scopes = [{ object: false, keys: new Set() }];
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
          while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
          if (text[cursor] === ':') {
            let key;
            try {
              key = JSON.parse(text.slice(stringStart - 1, index + 1));
            } catch {
              fail('invalid_profile_catalog_json', 'Profile catalog contains an invalid key string.');
            }
            if (scope.keys.has(key)) {
              fail('duplicate_profile_key', `Profile catalog defines "${key}" more than once.`);
            }
            scope.keys.add(key);
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
    if (char === '{') scopes.push({ object: true, keys: new Set() });
    else if (char === '[') scopes.push({ object: false, keys: new Set() });
    else if (char === '}' || char === ']') {
      scopes.pop();
      if (scopes.length === 0) fail('invalid_profile_catalog_json', 'Profile catalog JSON is unbalanced.');
    }
  }
  if (inString || scopes.length !== 1) {
    fail('invalid_profile_catalog_json', 'Profile catalog JSON is incomplete.');
  }
}

async function readCatalogText(file, label) {
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    if (error && error.code === 'ENOTDIR') {
      fail('profile_catalog_not_regular', `The ${label} profile catalog path is not a regular file location.`);
    }
    fail('profile_catalog_unreadable', `The ${label} profile catalog could not be inspected.`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail('profile_catalog_not_regular', `The ${label} profile catalog must be a regular non-symlink file.`);
  }
  if (entry.size > MAX_PROFILE_CATALOG_BYTES) {
    fail('profile_catalog_too_large', `The ${label} profile catalog exceeds ${MAX_PROFILE_CATALOG_BYTES} bytes.`);
  }
  return (await readFile(file)).toString('utf8');
}

async function requireRealDirectoryOrMissing(dir, label) {
  const entry = await lstat(dir).catch((error) => {
    if (error && error.code === 'ENOENT') return undefined;
    fail('profile_catalog_unreadable', `The ${label} profile directory could not be inspected.`);
  });
  if (entry !== undefined && (entry.isSymbolicLink() || !entry.isDirectory())) {
    fail('profile_catalog_not_regular', `The ${label} profile directory must be a real non-symlink directory.`);
  }
  return entry;
}

function parseCatalog(text, label) {
  assertNoDuplicateCatalogKeys(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid_profile_catalog_json', `The ${label} profile catalog is not valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    fail('invalid_profile_catalog_shape', `The ${label} profile catalog must be a JSON object keyed by profile name.`);
  }
  const names = Object.keys(parsed);
  if (names.length > MAX_PROFILES_PER_CATALOG) {
    fail('profile_catalog_too_many_entries', `The ${label} profile catalog exceeds ${MAX_PROFILES_PER_CATALOG} profiles.`);
  }
  return parsed;
}

// Structural validation shared by loading and later linting. Field-level
// policy/provider/model validation is layered on top of this check.
export function validateProfileDefinition(name, raw) {
  if (!isValidProfileName(name)) {
    fail('invalid_profile_name', `Profile name "${String(name)}" must match ${PROFILE_NAME_PATTERN.source}.`);
  }
  if (!isPlainObject(raw)) {
    fail('invalid_profile_definition', `Profile "${name}" must be a JSON object.`);
  }
  if (raw.schema !== PROFILE_SCHEMA) {
    fail('invalid_profile_schema', `Profile "${name}" must declare schema "${PROFILE_SCHEMA}".`);
  }
  return { ...raw };
}

export function canonicalProfileJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalProfileJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalProfileJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Stable provenance digest over validated canonical data. Scope and source
// path are recorded beside the digest so the same content synced across
// scopes keeps one content identity while remaining traceable to origin.
export function profileProvenanceDigest({ name, definition }) {
  if (!isValidProfileName(name)) fail('invalid_profile_name', 'Profile name is invalid.');
  if (!isPlainObject(definition)) fail('invalid_profile_definition', 'Profile definition must be validated data.');
  const payload = canonicalProfileJson({ definition, name, schema: PROFILE_SCHEMA });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function buildRecord(name, raw, scope, source) {
  const definition = Object.freeze(validateProfileDefinition(name, raw));
  return Object.freeze({
    name,
    scope,
    source,
    definition,
    digest: profileProvenanceDigest({ name, definition }),
  });
}

// Deterministic load: project first, then owner. A name defined in both
// scopes resolves to the project record; the owner record is reported as
// deterministically shadowed instead of silently dropped. This is file
// precedence only; assignment/run resolution stays in the resolver.
export async function loadProfiles(options = {}) {
  const roots = profileRoots(options);
  const catalogs = new Map();
  for (const scope of SCOPES) {
    const root = roots[scope];
    await requireRealDirectoryOrMissing(root.dir, scope);
    const text = await readCatalogText(root.file, scope);
    catalogs.set(scope, text === undefined ? {} : parseCatalog(text, scope));
  }

  const primary = new Map();
  const shadowed = [];
  for (const scope of SCOPES) {
    const root = roots[scope];
    const catalog = catalogs.get(scope);
    for (const name of Object.keys(catalog).sort()) {
      const record = buildRecord(name, catalog[name], scope, root.file);
      if (primary.has(name)) {
        shadowed.push(Object.freeze({
          ...record,
          reason: 'project_scope_precedence',
          primary_digest: primary.get(name).digest,
        }));
      } else {
        primary.set(name, record);
      }
    }
  }

  const profiles = [...primary.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Object.freeze({
    roots,
    profiles: Object.freeze(profiles),
    shadowed: Object.freeze(shadowed),
    sources: Object.freeze(SCOPES.map((scope) => Object.freeze({ scope, file: roots[scope].file, loaded: catalogs.get(scope) !== undefined && 'profiles' in catalogs.get(scope) }))),
  });
}

// Exact-name lookup only. There are no fuzzy matches, defaults, or fallbacks
// here; unresolved choices are surfaced by the resolver, not guessed.
export function findProfile(loaded, name) {
  if (loaded === undefined || loaded === null || !Array.isArray(loaded.profiles)) {
    fail('invalid_profile_load_result', 'loadProfiles() result is required.');
  }
  if (!isValidProfileName(name)) {
    fail('invalid_profile_name', `Profile name "${String(name)}" must match ${PROFILE_NAME_PATTERN.source}.`);
  }
  return loaded.profiles.find((record) => record.name === name);
}
