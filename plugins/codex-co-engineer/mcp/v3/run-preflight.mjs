// RunPreflightV1 — launch-side preflight validation gate (P26).
//
// Additive v3 module. It sits between an authored run submission and any
// later launch surface and validates ONLY: a passing preflight creates no
// workspace, no branch or ref, no task dispatch, no credential projection,
// no remote mutation, and no reservation; a failing preflight leaves even
// less. The module performs no filesystem write of any kind, and its only
// process spawns are read-only git observations (`rev-parse`, `cat-file -t`,
// `for-each-ref`) run argv-only under the accepted closed git environment
// with `--no-replace-objects --no-optional-locks`, disabled fsmonitor and
// hooks, so even advisory lock files cannot appear as an observation
// side effect.
//
// What one preflight validates, in a fixed fail-fast pipeline:
//   1. hostile-input quarantine of the whole request (Proxies, symbols,
//      non-enumerables, aliases, exotic prototypes) before any byte is
//      interpreted;
//   2. the complete accepted P02 run contract through
//      `parseRunManifestV1()` — envelope, deep AssignmentManifestV1,
//      RunPolicyV1 literals, and overlapping-writer-scope detection — so
//      every upstream denial code keeps its accepted meaning;
//   3. exact canonical repository/base identity observed on the host: the
//      submitted path must be a real directory identical to its own
//      realpath (never a symlink alias or alternate spelling), inside a
//      work tree, not bare, with a trusted `.git` layout whose resolved
//      target equals the observed git directory, and the submitted base
//      must exist in that repository as exactly one commit object with no
//      replace refs shadowing object identity;
//   4. a detached, deeply frozen receipt carrying the observed facts plus
//      a P03-bound GitIdentityV1 for direct P24 run-store compatibility.
//
// Composition stays additive: manifest/policy semantics belong to the P02
// modules, the GitIdentityV1 digest binding belongs to the P03 authority,
// selection resolution stays behind the P05 resolver (never invoked here),
// provider composition stays behind the P23 registry (never invoked here),
// and durable submission stays behind the P24 store (nothing is written
// here). There is no supervisor/server cutover, no scheduling, no dispatch,
// no workspace provisioning, and no cleanup ownership.

import { spawn as nodeSpawn } from 'node:child_process';
import { lstat as nodeLstat, readFile as nodeReadFile, realpath as nodeRealpath } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
} from './grammar.mjs';
import {
  GIT_CLOSED_ENV,
  GIT_EXECUTABLE,
  MAX_GIT_ARG_BYTES,
  MAX_GIT_ARGS,
  MAX_GIT_OUTPUT_BYTES,
  MAX_GIT_TIME_MS,
  MAX_GIT_TOTAL_TIME_MS,
} from './git-identity.mjs';
import { buildGitIdentityV1 } from './protected-identity.mjs';
import {
  RunContractV1Error,
  isPlainObject,
  writerScopesOverlap,
} from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  optOwn,
  ownDataValue,
} from './selection-json.mjs';
import { parseRunManifestV1 } from './run-policy.mjs';

export const RUN_PREFLIGHT_SCHEMA_ID = 'codex-co-engineer.run-preflight.v1';
export const RUN_PREFLIGHT_VERSION = 1;

// The launch boundary owns its child bounds as frozen literals. They are
// deliberately NOT derived from any quota, plan, or grammar constant, so a
// routine quota change anywhere else can never widen this invariant.
export const PREFLIGHT_MIN_CHILDREN = 1;
export const PREFLIGHT_MAX_CHILDREN = 8;

// Deterministic capacity model: every concurrently running child is
// guaranteed a schedulable CPU slot and a private RAM floor.
export const PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD = 268_435_456;

export const PREFLIGHT_REQUEST_ALLOWED_KEYS = capturedFreeze(['manifest']);
export const PREFLIGHT_OPTIONS_ALLOWED_KEYS = capturedFreeze(['host', 'spawn']);
export const PREFLIGHT_HOST_FACTS_ALLOWED_KEYS = capturedFreeze([
  'cpu_parallelism', 'total_ram_bytes', 'available_ram_bytes',
]);

// Read-only git observations are the only spawns this boundary may issue,
// under the accepted isolation flags. Anything else is a defect, not an
// extension point.
export const RUN_PREFLIGHT_READONLY_GIT_COMMANDS = capturedFreeze([
  'rev-parse', 'cat-file', 'for-each-ref',
]);

const PRIVATE_GIT_ISOLATION_FLAGS = capturedFreeze([
  '--no-replace-objects',
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c', 'core.useReplaceRefs=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'gc.auto=0',
  '-c', 'advice.detachedHead=false',
  '-c', 'log.showSignature=false',
  '-c', 'core.fsmonitor=',
  '-c', 'core.useBuiltinFSMonitor=false',
  '-c', 'core.untrackedCache=false',
]);

const PRIVATE_MAX_LAYOUT_FILE_BYTES = 4096;
const PRIVATE_MAX_GIT_COMMANDS = 8;
const PRIVATE_BASE_TYPE = 'commit';
const PRIVATE_TRUE_FALSE_PATTERN = /^(?:true|false)$/u;
const PRIVATE_SINGLE_LINE_PATTERN = /^[^\n\r\0]*$/u;
const PRIVATE_GITDIR_LINE_PATTERN = /^gitdir: (\/[^\n\r\0]*)$/u;

export const RUN_PREFLIGHT_CHECKS = capturedFreeze([
  'request_quarantine',
  'complete_run_manifest',
  'canonical_repository',
  'exact_base_commit',
  'no_replace_refs',
]);

export const RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS = capturedFreeze([
  'workspace_created',
  'branch_or_ref_created',
  'task_dispatched',
  'credentials_projected',
  'remote_mutated',
  'reservation_held',
]);

// Closed vocabulary of the codes this boundary owns. Upstream codes raised
// by the composed accepted validators pass through unchanged and stay
// authoritative for their surfaces.
export const RUN_PREFLIGHT_ERROR_CODES = capturedFreeze([
  'spawn_invalid',
  'host_facts_invalid',
  'observation_failed',
  'repository_missing',
  'repository_not_canonical',
  'repository_layout_invalid',
  'base_identity_invalid',
  'replace_refs_denied',
  'bounds_exceeded',
]);

const PRIVATE_RECEIPT_KEYS = capturedFreeze([
  'schema', 'version', 'status', 'run_id', 'children', 'capacity', 'repository',
  'checks', 'side_effects', 'git_identity',
]);
const PRIVATE_CHILD_SUMMARY_KEYS = capturedFreeze([
  'count', 'minimum', 'maximum', 'independent', 'concurrency', 'assignment_ids',
]);
const PRIVATE_CAPACITY_SUMMARY_KEYS = capturedFreeze([
  'source', 'cpu_parallelism', 'total_ram_bytes', 'available_ram_bytes',
  'required_ram_bytes', 'cpu_ok', 'ram_ok',
]);
const PRIVATE_REPOSITORY_FACTS_KEYS = capturedFreeze([
  'path', 'base_sha', 'object_type', 'git_dir',
]);

function failPreflight(code, path, message) {
  fail(code, path, message);
}

function contractError(code, path, message) {
  return new RunContractV1Error(code, path, message);
}

function sortedOwnKeys(value) {
  const keys = capturedOwnKeys(value);
  const sorted = [...keys];
  sorted.sort();
  return sorted;
}

function assertClosedKeySet(value, allowedKeys, path) {
  for (const key of sortedOwnKeys(value)) {
    if (!capturedIncludes(allowedKeys, key)) {
      failPreflight('invalid_format', `${path}.${key}`,
        `${path} carries a key outside the closed preflight vocabulary.`);
    }
  }
}

function requiredKey(value, key, path) {
  if (!hasOwn(value, key)) {
    failPreflight('missing_key', `${path}.${key}`,
      `${path}.${key} is required (${RUN_PREFLIGHT_SCHEMA_ID}); preflight requests have no hidden defaults.`);
  }
  return ownDataValue(value, key, `${path}.${key}`);
}

function defaultSpawn() {
  return nodeSpawn;
}

function parseOptions(options) {
  if (options === undefined) {
    return capturedFreeze({ host: null, spawn: defaultSpawn() });
  }
  assertNotProxy(options, 'options');
  if (!isPlainObject(options)) {
    failPreflight('invalid_type', 'options', 'options must be a plain JSON data object.');
  }
  assertClosedKeySet(options, PREFLIGHT_OPTIONS_ALLOWED_KEYS, 'options');
  // The spawn seam is a trusted process handle, not JSON data: it is
  // validated directly and kept out of the JSON closure walk.
  let spawn = defaultSpawn();
  if (hasOwn(options, 'spawn')) {
    spawn = ownDataValue(options, 'spawn', 'options.spawn');
    if (typeof spawn !== 'function') {
      failPreflight('invalid_type', 'options.spawn', 'options.spawn must be a spawn function.');
    }
    assertNotProxy(spawn, 'options.spawn');
  }
  let host = null;
  if (hasOwn(options, 'host')) {
    host = parseHostFacts(ownDataValue(options, 'host', 'options.host'));
  }
  return capturedFreeze({ host, spawn });
}

function ambientHostFacts() {
  const os = nodeOs;
  let parallelism;
  try {
    parallelism = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  } catch {
    parallelism = 0;
  }
  let total;
  try {
    total = os.totalmem();
  } catch {
    total = 0;
  }
  let available;
  try {
    available = os.freemem();
  } catch {
    available = 0;
  }
  return capturedFreeze({
    cpu_parallelism: parallelism,
    total_ram_bytes: total,
    available_ram_bytes: available,
  });
}

function parseHostFacts(value) {
  assertNotProxy(value, 'options.host');
  if (!isPlainObject(value)) {
    failPreflight('invalid_type', 'options.host', 'options.host must be a plain JSON data object.');
  }
  assertDirectJsonClosure(value, 'options.host');
  assertClosedKeySet(value, PREFLIGHT_HOST_FACTS_ALLOWED_KEYS, 'options.host');
  const facts = {};
  for (const key of PREFLIGHT_HOST_FACTS_ALLOWED_KEYS) {
    const factValue = requiredKey(value, key, 'options.host');
    if (typeof factValue !== 'number' || !Number.isSafeInteger(factValue) || factValue < 0) {
      failPreflight('host_facts_invalid', `options.host.${key}`,
        'Injected host facts must be non-negative safe integers.');
    }
    facts[key] = factValue;
  }
  return capturedFreeze(facts);
}

function parseRequest(request) {
  if (request === undefined || request === null) {
    failPreflight('invalid_type', 'request', 'A preflight request must be a plain JSON data object.');
  }
  assertDirectJsonClosure(request, 'request');
  assertNotProxy(request, 'request');
  if (!isPlainObject(request)) {
    failPreflight('invalid_type', 'request', 'A preflight request must be a plain JSON data object.');
  }
  assertClosedKeySet(request, PREFLIGHT_REQUEST_ALLOWED_KEYS, 'request');
  const manifest = requiredKey(request, 'manifest', 'request');
  return manifest;
}

function summarizeChildren(snapshot) {
  const assignments = snapshot.assignments;
  const ids = [];
  for (let index = 0; index < assignments.length; index += 1) {
    ids.push(assignments[index].assignment_id);
  }
  return capturedFreeze({
    count: assignments.length,
    minimum: PREFLIGHT_MIN_CHILDREN,
    maximum: PREFLIGHT_MAX_CHILDREN,
    independent: true,
    concurrency: snapshot.policy.max_concurrency,
    assignment_ids: capturedFreeze(ids),
  });
}

// Defense-in-depth at the launch boundary: the parsed snapshot is detached
// and frozen, so this pairwise recheck cannot race a caller mutation. The
// comparison is the accepted conservative static-prefix intersection.
function assertSnapshotDisjointWriterScopes(snapshot) {
  const assignments = snapshot.assignments;
  const scopes = [];
  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index];
    if (!assignment || assignment.access !== 'writer') continue;
    scopes.push({
      index,
      assignment_id: assignment.assignment_id,
      patterns: assignment.write_scope,
    });
  }
  for (let left = 0; left < scopes.length; left += 1) {
    for (let right = left + 1; right < scopes.length; right += 1) {
      const leftScope = scopes[left];
      const rightScope = scopes[right];
      for (let leftIndex = 0; leftIndex < leftScope.patterns.length; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < rightScope.patterns.length; rightIndex += 1) {
          if (writerScopesOverlap(leftScope.patterns[leftIndex], rightScope.patterns[rightIndex])) {
            failPreflight('overlapping_writer_scope', `assignments[${right}].write_scope`,
              'Two child assignments declare overlapping writer scopes; concurrent writers must own disjoint paths.');
          }
        }
      }
    }
  }
}

function createSession(spawnFn) {
  return {
    spawn: spawnFn,
    commands: 0,
    startedAt: Date.now(),
    deadlineAt: Date.now() + MAX_GIT_TOTAL_TIME_MS,
  };
}

function assertSessionBounds(session, path) {
  if (session.commands >= PRIVATE_MAX_GIT_COMMANDS) {
    failPreflight('bounds_exceeded', path, 'The preflight exceeded its git command budget.');
  }
  if (Date.now() >= session.deadlineAt) {
    failPreflight('bounds_exceeded', path, 'The preflight exceeded its git wall-clock budget.');
  }
}

function decodeUtf8(bytes, path) {
  let text;
  try {
    text = bytes.toString('utf8');
  } catch {
    failPreflight('observation_failed', path, 'A git observation produced an invalid encoding.');
  }
  let roundtrip;
  try {
    roundtrip = Buffer.from(text, 'utf8');
  } catch {
    failPreflight('observation_failed', path, 'A git observation produced an invalid encoding.');
  }
  if (roundtrip.length !== bytes.length || !roundtrip.equals(bytes)) {
    failPreflight('observation_failed', path, 'A git observation produced a non-UTF-8 response.');
  }
  return text;
}

async function runObservation(session, args, pathLabel) {
  if (!capturedIsArray(args)) {
    failPreflight('observation_failed', pathLabel, 'The preflight observation argv is malformed.');
  }
  assertSessionBounds(session, pathLabel);
  session.commands += 1;
  const argv = [...PRIVATE_GIT_ISOLATION_FLAGS, ...args];
  if (argv.length > MAX_GIT_ARGS) {
    failPreflight('bounds_exceeded', pathLabel, 'The preflight observation exceeds the git argv cap.');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')
      || Buffer.byteLength(arg, 'utf8') > MAX_GIT_ARG_BYTES) {
      failPreflight('observation_failed', pathLabel, 'The preflight observation argv is malformed.');
    }
  }
  const spawnOptions = {
    cwd: '/',
    env: GIT_CLOSED_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
  const remainingMs = session.deadlineAt - Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = session.spawn(GIT_EXECUTABLE, argv, spawnOptions);
    } catch {
      resolve(contractError('observation_failed', pathLabel,
        'The preflight could not start a git observation.'));
      return;
    }
    if (!child || (typeof child !== 'object' && typeof child !== 'function')) {
      resolve(contractError('observation_failed', pathLabel,
        'The preflight could not start a git observation.'));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) resolve(error);
      else resolve(result);
    };
    const exceed = () => {
      if (exceeded) return;
      exceeded = true;
      try {
        child.kill('SIGKILL');
      } catch { /* already exited */ }
      finish(contractError('bounds_exceeded', pathLabel,
        'The preflight observation exceeded an output or wall-clock bound.'));
    };
    timer = setTimeout(exceed, Math.min(MAX_GIT_TIME_MS, remainingMs));
    const onChunk = (target, getSize, setSize) => (chunk) => {
      if (exceeded) return;
      const owned = Buffer.isBuffer(chunk) ? chunk : Buffer.from([]);
      const next = getSize() + owned.length;
      setSize(next);
      if (next > MAX_GIT_OUTPUT_BYTES) {
        exceed();
        return;
      }
      target.push(owned);
    };
    try {
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', onChunk(stdoutChunks, () => stdoutBytes, (value) => { stdoutBytes = value; }));
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', onChunk(stderrChunks, () => stderrBytes, (value) => { stderrBytes = value; }));
      }
      child.once('error', () => {
        finish(contractError('observation_failed', pathLabel,
          'The preflight could not complete a git observation.'));
      });
      child.once('close', (code, signal) => {
        if (exceeded) return;
        if (Date.now() >= session.deadlineAt) {
          finish(contractError('bounds_exceeded', pathLabel,
            'The preflight exceeded its git wall-clock budget.'));
          return;
        }
        if (signal !== null && signal !== undefined) {
          finish(contractError('observation_failed', pathLabel,
            'The preflight could not complete a git observation.'));
          return;
        }
        finish(null, {
          exit_code: typeof code === 'number' ? code : 1,
          stdout: decodeUtf8(Buffer.concat(stdoutChunks), pathLabel),
          stderr: decodeUtf8(Buffer.concat(stderrChunks), pathLabel),
        });
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch { /* already exited */ }
      finish(contractError('observation_failed', pathLabel,
        'The preflight could not complete a git observation.'));
    }
  });
}

// Infrastructure failures (spawn start, streams) stay `observation_failed`.
// A child that actually ran and reported failure is reclassified through
// `exitFailureCode` so semantic denials stay precise at this boundary.
async function mustObserve(session, args, pathLabel, options = {}) {
  const outcome = await runObservation(session, args, pathLabel);
  if (outcome instanceof RunContractV1Error) throw outcome;
  if (outcome.exit_code !== 0) {
    const { exitFailureCode = 'observation_failed', exitMessage = 'The preflight could not complete a git observation.' } = options;
    failPreflight(exitFailureCode, pathLabel, exitMessage);
  }
  const expectedArgsLength = options.lineCount;
  const unexpectedMessage = options.unexpectedMessage
    ?? 'A git observation produced an unexpected response.';
  let text = outcome.stdout;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.includes('\0') || text.includes('\r')) {
    failPreflight('observation_failed', pathLabel,
      'A git observation produced an unexpected response.');
  }
  const lines = text.split('\n');
  if (expectedArgsLength !== undefined && lines.length !== expectedArgsLength) {
    failPreflight('observation_failed', pathLabel, unexpectedMessage);
  }
  return lines;
}

async function readBoundedText(filePath, pathLabel) {
  let bytes;
  try {
    bytes = await nodeReadFile(filePath);
  } catch {
    failPreflight('repository_layout_invalid', pathLabel,
      'The repository layout is not a trusted git worktree layout.');
  }
  if (bytes.length > PRIVATE_MAX_LAYOUT_FILE_BYTES) {
    failPreflight('repository_layout_invalid', pathLabel,
      'The repository layout is not a trusted git worktree layout.');
  }
  return decodeUtf8(bytes, pathLabel);
}

async function assertCanonicalDirectory(candidatePath, pathLabel, missingCode) {
  let metadata;
  try {
    metadata = await nodeLstat(candidatePath);
  } catch {
    failPreflight(missingCode, pathLabel,
      'The submitted repository path does not identify an accessible directory.');
  }
  if (typeof metadata?.isDirectory !== 'function' || !metadata.isDirectory()
    || (typeof metadata.isSymbolicLink === 'function' && metadata.isSymbolicLink())) {
    failPreflight('repository_not_canonical', pathLabel,
      'The submitted repository path must be a real directory, never a symlink alias.');
  }
  let resolved;
  try {
    resolved = await nodeRealpath(candidatePath);
  } catch {
    failPreflight(missingCode, pathLabel,
      'The submitted repository path does not identify an accessible directory.');
  }
  if (resolved !== candidatePath) {
    failPreflight('repository_not_canonical', pathLabel,
      'The submitted repository path must equal its own canonical realpath spelling.');
  }
  return resolved;
}

async function observeCanonicalRepository(session, repositoryPath, pathLabel) {
  await assertCanonicalDirectory(repositoryPath, `${pathLabel}.path`, 'repository_missing');
  const lines = await mustObserve(
    session,
    ['-C', repositoryPath, 'rev-parse', '--path-format=absolute',
      '--is-inside-work-tree', '--is-bare-repository', '--show-toplevel', '--absolute-git-dir'],
    `${pathLabel}.work_tree`,
    {
      lineCount: 4,
      // Only a child that actually ran and reported failure lands here;
      // spawn/stream infrastructure failures stay `observation_failed`.
      exitFailureCode: 'repository_not_canonical',
      exitMessage: 'The submitted repository path must identify a canonical non-bare git work tree root.',
    },
  );
  const [inside, bare, toplevel, gitDir] = lines;
  if (!PRIVATE_TRUE_FALSE_PATTERN.test(inside) || inside !== 'true'
    || !PRIVATE_TRUE_FALSE_PATTERN.test(bare) || bare !== 'false') {
    failPreflight('repository_not_canonical', `${pathLabel}.path`,
      'The submitted repository path must identify a non-bare git work tree root.');
  }
  if (toplevel !== repositoryPath) {
    failPreflight('repository_not_canonical', `${pathLabel}.path`,
      'The submitted repository path must equal the observed git work tree toplevel.');
  }
  if (gitDir.length === 0 || !gitDir.startsWith('/') || nodePath.resolve(gitDir) !== gitDir
    || !PRIVATE_SINGLE_LINE_PATTERN.test(gitDir)) {
    failPreflight('repository_layout_invalid', `${pathLabel}.path`,
      'The repository did not yield a trusted absolute git directory.');
  }
  await assertTrustedGitLayout(repositoryPath, gitDir, pathLabel);
  return gitDir;
}

async function assertTrustedGitLayout(repositoryPath, observedGitDir, pathLabel) {
  const gitEntryPath = nodePath.join(repositoryPath, '.git');
  let metadata;
  try {
    metadata = await nodeLstat(gitEntryPath);
  } catch {
    failPreflight('repository_layout_invalid', `${pathLabel}.path`,
      'The repository layout is not a trusted git worktree layout.');
  }
  if ((typeof metadata.isSymbolicLink === 'function' && metadata.isSymbolicLink())) {
    failPreflight('repository_layout_invalid', `${pathLabel}.path`,
      'The repository layout is not a trusted git worktree layout.');
  }
  let entryTarget;
  if (typeof metadata.isDirectory === 'function' && metadata.isDirectory()) {
    try {
      entryTarget = await nodeRealpath(gitEntryPath);
    } catch {
      entryTarget = null;
    }
  } else if (typeof metadata.isFile === 'function' && metadata.isFile()) {
    const text = await readBoundedText(gitEntryPath, `${pathLabel}.path`);
    const match = PRIVATE_GITDIR_LINE_PATTERN.exec(text.replace(/\n$/u, ''));
    if (!match) {
      failPreflight('repository_layout_invalid', `${pathLabel}.path`,
        'The repository layout is not a trusted git worktree layout.');
    }
    const declared = nodePath.isAbsolute(match[1]) ? match[1] : nodePath.resolve(repositoryPath, match[1]);
    try {
      entryTarget = await nodeRealpath(declared);
    } catch {
      entryTarget = null;
    }
  } else {
    failPreflight('repository_layout_invalid', `${pathLabel}.path`,
      'The repository layout is not a trusted git worktree layout.');
  }
  let observedTarget;
  try {
    observedTarget = await nodeRealpath(observedGitDir);
  } catch {
    observedTarget = null;
  }
  if (entryTarget === null || observedTarget === null || entryTarget !== observedTarget) {
    failPreflight('repository_layout_invalid', `${pathLabel}.path`,
      'The repository layout is not a trusted git worktree layout.');
  }
}

async function observeExactBaseCommit(session, repositoryPath, baseSha, pathLabel) {
  const typeOutcome = await runObservation(
    session,
    ['-C', repositoryPath, 'cat-file', '-t', baseSha],
    `${pathLabel}.base_sha`,
  );
  if (typeOutcome instanceof RunContractV1Error) throw typeOutcome;
  if (typeOutcome.exit_code !== 0 || typeOutcome.stdout.trim() !== PRIVATE_BASE_TYPE) {
    failPreflight('base_identity_invalid', `${pathLabel}.base_sha`,
      'The submitted base must exist as exactly one immutable commit object.');
  }
  const replaceLines = await mustObserve(
    session,
    ['-C', repositoryPath, 'for-each-ref', '--format=%(refname)', '--', 'refs/replace'],
    `${pathLabel}.base_sha`,
  );
  const replaceText = replaceLines[0] ?? '';
  if (replaceLines.length !== 1 || replaceText.length > 0) {
    failPreflight('replace_refs_denied', `${pathLabel}.base_sha`,
      'The repository carries replace refs; object identity cannot be proven exact.');
  }
}

async function observeRepositoryAndBase(manifest, spawnFn) {
  const repositoryPath = manifest.repository.path;
  const baseSha = manifest.repository.base_sha;
  const pathLabel = 'repository';
  const session = createSession(spawnFn);
  const gitDir = await observeCanonicalRepository(session, repositoryPath, pathLabel);
  await observeExactBaseCommit(session, repositoryPath, baseSha, pathLabel);
  return capturedFreeze({
    path: repositoryPath,
    base_sha: baseSha,
    object_type: PRIVATE_BASE_TYPE,
    git_dir: gitDir,
  });
}

function buildReceipt(manifest, summary, repositoryFacts, hostFacts) {
  const concurrency = manifest.policy.max_concurrency;
  const sideEffects = {};
  for (const claim of RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS) {
    sideEffects[claim] = false;
  }
  return capturedFreeze({
    schema: RUN_PREFLIGHT_SCHEMA_ID,
    version: RUN_PREFLIGHT_VERSION,
    status: 'ready',
    run_id: manifest.run_id,
    children: summary,
    capacity: capturedFreeze({
      source: hostFacts.source,
      cpu_parallelism: hostFacts.cpu_parallelism,
      total_ram_bytes: hostFacts.total_ram_bytes,
      available_ram_bytes: hostFacts.available_ram_bytes,
      required_ram_bytes: concurrency * PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD,
      cpu_ok: true,
      ram_ok: true,
    }),
    repository: repositoryFacts,
    checks: RUN_PREFLIGHT_CHECKS,
    side_effects: capturedFreeze(sideEffects),
    git_identity: buildGitIdentityV1({
      repository_path: repositoryFacts.path,
      base_sha: repositoryFacts.base_sha,
    }),
  });
}

export async function validateRunPreflightV1(request, options) {
  const parsedOptions = parseOptions(options);
  const manifestInput = parseRequest(request);
  const snapshot = parseRunManifestV1(manifestInput);
  const childrenSummary = summarizeChildren(snapshot);
  assertSnapshotDisjointWriterScopes(snapshot);
  const hostFactsSource = parsedOptions.host ?? ambientHostFacts();
  const hostFacts = capturedFreeze({
    source: parsedOptions.host ? 'injected' : 'ambient',
    cpu_parallelism: hostFactsSource.cpu_parallelism,
    total_ram_bytes: hostFactsSource.total_ram_bytes,
    available_ram_bytes: hostFactsSource.available_ram_bytes,
  });
  const repositoryFacts = await observeRepositoryAndBase(snapshot, parsedOptions.spawn);
  return buildReceipt(snapshot, childrenSummary, repositoryFacts, hostFacts);
}

export function describeRunPreflightV1() {
  const inventory = capturedFreeze({
    schema: RUN_PREFLIGHT_SCHEMA_ID,
    version: RUN_PREFLIGHT_VERSION,
    rule: 'validate_only_no_launch_side_effect',
    min_children: PREFLIGHT_MIN_CHILDREN,
    max_children: PREFLIGHT_MAX_CHILDREN,
    ram_floor_bytes_per_child: PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD,
    readonly_git_commands: RUN_PREFLIGHT_READONLY_GIT_COMMANDS,
    git_spawn_posture: 'argv_only_closed_env_no_optional_locks',
    checks: RUN_PREFLIGHT_CHECKS,
    error_codes: RUN_PREFLIGHT_ERROR_CODES,
    side_effect_nonclaims: RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS,
    composed_surfaces: capturedFreeze({
      run_contract: 'P02 run-manifest/run-policy via parseRunManifestV1',
      git_identity_binding: 'P03 protected-identity buildGitIdentityV1',
      selection_resolution: 'P05 resolver owns resolution; not invoked here',
      provider_composition: 'P23 registry owns composition; not invoked here',
      durable_submission: 'P24 run store owns writes; nothing written here',
    }),
  });
  return freezeData(inventory);
}

capturedFreeze(validateRunPreflightV1);
capturedFreeze(describeRunPreflightV1);
