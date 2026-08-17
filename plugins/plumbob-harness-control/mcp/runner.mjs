#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  opendir,
  readFile,
  readlink,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  getStoredJob,
  openStore,
  recordHeartbeat,
  terminalizeJob,
  transitionJob,
  updateJob,
} from './store.mjs';
import { grokBuildFailure } from './grok-build.mjs';
import { TARGET_SCHEMA_VERSION } from './preflight.mjs';

const specPath = process.argv[2];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(file) {
  try { return (await stat(file)).size; } catch { return 0; }
}

function elapsedSeconds(startedAt, finishedAt) {
  return Math.max(0, Math.round(((finishedAt - startedAt) / 1000) * 1000) / 1000);
}

const HEARTBEAT_INTERVAL_MS = 15000;
// `git status --ignored=matching` intentionally reports an ignored directory
// as one entry. Hashing only that directory's metadata misses edits to files
// already inside it, while recursively walking without a bound lets a model
// turn target verification into an unbounded resource operation. Keep the
// integrity walk deliberately small and fail closed when the cap is reached.
const MAX_IGNORED_INTEGRITY_ENTRIES = 1024;
const MAX_IGNORED_INTEGRITY_BYTES = 16 * 1024 * 1024;

class IgnoredIntegrityLimitError extends Error {
  constructor(relativePath, limit, unit) {
    super(`ignored integrity snapshot exceeds the bounded ${unit} limit of ${limit}: ${relativePath}`);
    this.name = 'IgnoredIntegrityLimitError';
    this.code = 'IGNORED_INTEGRITY_LIMIT';
  }
}

function outputRedactions(spec) {
  const values = [
    ...(Array.isArray(spec.redactions) ? spec.redactions : []),
    process.env.MODEL_API_KEY ?? '',
    process.env.XAI_API_KEY ?? '',
  ];
  const fragments = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    fragments.add(value);
    fragments.add(JSON.stringify(value).slice(1, -1));
    for (const line of value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
      fragments.add(line);
      fragments.add(JSON.stringify(line).slice(1, -1));
    }
  }
  return [...fragments].sort((left, right) => right.length - left.length);
}

function sanitizeOutput(value, fragments) {
  let clean = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const fragment of fragments) clean = clean.split(fragment).join('[REDACTED]');
  return clean
    .replace(/((?:api[_-]?key|authorization|bearer|access[_-]?token|secret)\s*[:=]\s*)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

function captureSanitizedLines(stream, writer, fragments) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    input.on('line', (line) => writer.write(`${sanitizeOutput(line, fragments)}\n`));
    input.on('close', resolve);
    input.on('error', resolve);
  });
}

function fixedDeadlineMs(spec, acceptedJob) {
  const persisted = Date.parse(acceptedJob?.deadline_at ?? '');
  if (Number.isFinite(persisted)) return persisted;
  const acceptedAt = Date.parse(acceptedJob?.created_at ?? '');
  const timeoutSeconds = Number(spec.timeout_seconds ?? acceptedJob?.timeout_seconds);
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return null;
  return acceptedAt + timeoutSeconds * 1000;
}

function failureClassFor(reason, outcome) {
  if (outcome === 'completed') return null;
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'cancelled') return 'cancelled';
  if (reason === 'no_workspace_change') return 'contract_violation';
  if (reason === 'adapter_error' || reason === 'target_preflight_failed'
    || reason === 'scope_verification_failed' || reason === 'scope_violation'
    || reason === 'ignored_file_change' || reason === 'read_only_violation'
    || reason === 'patch_capture_failed') return 'tool_error';
  if (reason === 'protocol_error') return 'protocol_error';
  return 'process_failure';
}

function gitCommand(cwd, args, preserveWhitespace = false) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    ok: result.status === 0,
    output: preserveWhitespace ? (result.stdout ?? '') : (result.stdout ?? '').trim(),
    error: result.error?.message ?? (result.stderr ?? '').trim(),
  };
}

function gitStatusMap(raw) {
  const entries = new Map();
  const records = raw.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const value = entry.slice(3);
    if (!value) continue;
    entries.set(value, status);
    // With porcelain -z, rename/copy paths are separate NUL-delimited
    // records rather than a `source -> destination` string.
    if ((status[0] === 'R' || status[0] === 'C') && records[index + 1]) {
      entries.set(records[index + 1], status);
      index += 1;
    }
  }
  return entries;
}

function normalizedRepoPath(value) {
  if (typeof value !== 'string' || path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

function pathAllowed(changedPath, allowedPaths) {
  const normalized = normalizedRepoPath(changedPath);
  if (!normalized) return false;
  return allowedPaths.some((scope) => scope === '.'
    || normalized === scope
    || normalized.startsWith(`${scope.replace(/\/$/, '')}/`));
}

async function symlinkInPath(root, relativePath) {
  const normalized = normalizedRepoPath(relativePath);
  if (!normalized || normalized === '.') {
    if (normalized === '.') return null;
    return 'path escapes Git root';
  }
  let current = root;
  for (const component of normalized.split('/').filter((part) => part && part !== '.')) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) return current;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  return null;
}

function changedPaths(before, after, beforeEvidence = new Map(), afterEvidence = new Map()) {
  const paths = new Set([
    ...before.keys(),
    ...after.keys(),
    ...beforeEvidence.keys(),
    ...afterEvidence.keys(),
  ]);
  return [...paths].filter((changedPath) => before.get(changedPath) !== after.get(changedPath)
    || beforeEvidence.get(changedPath) !== afterEvidence.get(changedPath)).sort();
}

function fileEvidence(file) {
  return new Promise((resolve) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', () => resolve(`file:${digest.digest('hex')}`));
    stream.on('error', (error) => resolve(`unreadable:${error?.code ?? error?.message ?? 'unknown'}`));
  });
}

function boundedFileEvidence(file, relativePath, budget) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    let bytes = 0;
    let rejected = false;
    const rejectLimit = () => {
      if (rejected) return;
      rejected = true;
      stream.destroy();
      reject(new IgnoredIntegrityLimitError(relativePath, MAX_IGNORED_INTEGRITY_BYTES, 'byte'));
    };
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (budget.bytes + bytes > MAX_IGNORED_INTEGRITY_BYTES) {
        rejectLimit();
        return;
      }
      digest.update(chunk);
    });
    stream.on('end', () => {
      if (rejected) return;
      budget.bytes += bytes;
      resolve(`file:${digest.digest('hex')}`);
    });
    stream.on('error', (error) => {
      if (rejected) return;
      reject(error);
    });
  });
}

async function pathEvidence(root, relativePath) {
  const normalized = normalizedRepoPath(relativePath);
  if (!normalized || normalized === '.') return 'invalid';
  const file = path.join(root, normalized);
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      return `symlink:${await readlink(file).catch(() => '<unreadable>')}`;
    }
    if (info.isFile()) {
      const digest = await fileEvidence(file);
      return `${digest}:mode:${info.mode.toString(8)}`;
    }
    return `${info.isDirectory() ? 'directory' : 'special'}:${info.size}:${info.mtimeNs ?? info.mtimeMs}`;
  } catch (error) {
    return `missing:${error?.code ?? error?.message ?? 'unknown'}`;
  }
}

async function snapshotIgnoredDirectory(root, relativePath, evidence, status, budget) {
  const pending = [{ absolutePath: path.join(root, relativePath), relativePath }];
  while (pending.length > 0) {
    const current = pending.pop();
    let directory;
    try {
      directory = await opendir(current.absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        evidence.set(current.relativePath, `missing:${error.code}`);
        continue;
      }
      throw error;
    }
    try {
      for await (const entry of directory) {
        const childRelativePath = path.posix.join(current.relativePath, entry.name);
        const childAbsolutePath = path.join(root, childRelativePath);
        budget.entries += 1;
        if (budget.entries > MAX_IGNORED_INTEGRITY_ENTRIES) {
          throw new IgnoredIntegrityLimitError(
            childRelativePath,
            MAX_IGNORED_INTEGRITY_ENTRIES,
            'entry',
          );
        }
        let info;
        try {
          info = await lstat(childAbsolutePath);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            evidence.set(childRelativePath, `missing:${error.code}`);
            status.set(childRelativePath, '!!');
            continue;
          }
          throw error;
        }
        status.set(childRelativePath, '!!');
        if (info.isDirectory()) {
          evidence.set(
            childRelativePath,
            `directory:${info.size}:${info.mtimeNs ?? info.mtimeMs}`,
          );
          pending.push({ absolutePath: childAbsolutePath, relativePath: childRelativePath });
        } else if (info.isFile()) {
          if (budget.bytes + info.size > MAX_IGNORED_INTEGRITY_BYTES) {
            throw new IgnoredIntegrityLimitError(
              childRelativePath,
              MAX_IGNORED_INTEGRITY_BYTES,
              'byte',
            );
          }
          evidence.set(
            childRelativePath,
            `${await boundedFileEvidence(childAbsolutePath, childRelativePath, budget)}:mode:${info.mode.toString(8)}`,
          );
        } else if (info.isSymbolicLink()) {
          evidence.set(
            childRelativePath,
            `symlink:${await readlink(childAbsolutePath).catch(() => '<unreadable>')}`,
          );
        } else {
          evidence.set(
            childRelativePath,
            `special:${info.size}:${info.mtimeNs ?? info.mtimeMs}`,
          );
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }
}

async function snapshotEvidence(root, status) {
  const evidence = new Map();
  const budget = { entries: 0, bytes: 0 };
  for (const relativePath of [...status.keys()]) {
    const normalized = normalizedRepoPath(relativePath);
    const absolutePath = normalized ? path.join(root, normalized) : null;
    if (status.get(relativePath) === '!!' && absolutePath) {
      const info = await lstat(absolutePath).catch(() => null);
      if (info?.isDirectory()) {
        await snapshotIgnoredDirectory(root, normalized, evidence, status, budget);
        continue;
      }
    }
    evidence.set(relativePath, await pathEvidence(root, relativePath));
  }
  return evidence;
}

async function symlinkInScope(root, relativePath, budget) {
  const normalized = normalizedRepoPath(relativePath);
  if (!normalized) return 'path escapes Git root';
  const absolutePath = path.join(root, normalized);
  const info = await lstat(absolutePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isDirectory()) return null;

  // Reuse the bounded integrity walker. It uses lstat before deciding whether
  // to recurse, so symlinked directories are recorded and never followed.
  const evidence = new Map();
  const status = new Map([[normalized, '!!']]);
  await snapshotIgnoredDirectory(root, normalized, evidence, status, budget);
  for (const [candidate, value] of evidence) {
    if (value.startsWith('symlink:')) return `${candidate} (${value})`;
  }
  return null;
}

async function gitCommonDirectory(cwd) {
  const common = gitCommand(cwd, ['rev-parse', '--git-common-dir']);
  if (!common.ok || !common.output) return null;
  // Git emits a relative path relative to the command's working directory
  // (for example, `../../.git` from a nested checkout directory), not the
  // repository root. Resolve it against the same cwd used for rev-parse.
  return realpath(path.resolve(cwd, common.output)).catch(() => null);
}

async function gitSnapshot(cwd) {
  const root = gitCommand(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return { ok: false, error: root.error || 'Git root detection failed.' };
  const head = gitCommand(cwd, ['rev-parse', 'HEAD']);
  if (!head.ok) return { ok: false, error: head.error || 'Git HEAD detection failed.' };
  const common = await gitCommonDirectory(cwd);
  if (!common) return { ok: false, error: 'Git common directory detection failed.' };
  const status = gitCommand(cwd, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching',
  ], true);
  if (!status.ok) return { ok: false, error: status.error || 'Git status failed.' };
  const statusMap = gitStatusMap(status.output);
  let evidence;
  try {
    evidence = await snapshotEvidence(root.output, statusMap);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof IgnoredIntegrityLimitError
        ? error.message
        : `Ignored integrity snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    root: root.output,
    common,
    head: head.output.toLowerCase(),
    status: statusMap,
    evidence,
  };
}

function normalizedDirectoryIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const device = typeof value.device === 'string' || typeof value.device === 'number'
    ? String(value.device)
    : '';
  const inode = typeof value.inode === 'string' || typeof value.inode === 'number'
    ? String(value.inode)
    : '';
  if (!device || !inode) return null;
  return { device, inode };
}

function targetIdentityExpectation(target) {
  const hasWorkspaceIdentity = Object.hasOwn(target, 'workspace_identity');
  const hasCwdIdentity = Object.hasOwn(target, 'cwd_identity');
  if (!hasWorkspaceIdentity && !hasCwdIdentity) {
    // Runner specs written before identity fields were introduced remain
    // readable. Current control-generated target contexts must carry both
    // identities so a replacement checkout at the same path cannot pass.
    if (target.schema_version === TARGET_SCHEMA_VERSION) {
      return {
        ok: false,
        error: 'target_context is missing workspace_identity and cwd_identity.',
      };
    }
    return { ok: true, required: false };
  }
  if (!hasWorkspaceIdentity || !hasCwdIdentity) {
    return {
      ok: false,
      error: 'target_context must include both workspace_identity and cwd_identity.',
    };
  }
  const workspace = normalizedDirectoryIdentity(target.workspace_identity);
  const cwd = normalizedDirectoryIdentity(target.cwd_identity);
  if (!workspace || !cwd) {
    return {
      ok: false,
      error: 'target_context workspace_identity and cwd_identity must contain device and inode values.',
    };
  }
  return { ok: true, required: true, workspace, cwd };
}

async function directoryIdentity(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error('path is not a directory');
  return { device: String(info.dev), inode: String(info.ino) };
}

function identityLabel(identity) {
  return `${identity.device}:${identity.inode}`;
}

async function verifyTargetIdentities(target) {
  const expected = targetIdentityExpectation(target);
  if (!expected.ok || !expected.required) return expected;
  let actual;
  try {
    actual = {
      workspace: await directoryIdentity(target.expected_git_root),
      cwd: await directoryIdentity(target.working_directory),
    };
  } catch (error) {
    return {
      ok: false,
      error: `target directory identity could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  const mismatches = [];
  if (identityLabel(expected.workspace) !== identityLabel(actual.workspace)) {
    mismatches.push(`workspace expected ${identityLabel(expected.workspace)}, found ${identityLabel(actual.workspace)}`);
  }
  if (identityLabel(expected.cwd) !== identityLabel(actual.cwd)) {
    mismatches.push(`cwd expected ${identityLabel(expected.cwd)}, found ${identityLabel(actual.cwd)}`);
  }
  if (mismatches.length > 0) {
    return { ok: false, error: `target directory identity mismatch: ${mismatches.join('; ')}.` };
  }
  return { ok: true, required: true, actual };
}

async function preflightTarget(spec) {
  const target = spec.target_context;
  if (!target) return { ok: true, target: null };
  if (!['review', 'verify', 'implement'].includes(target.role)) {
    return { ok: false, error: 'Target preflight refused: role must be review, verify, or implement.' };
  }
  if (spec.cwd !== target.working_directory) {
    return { ok: false, error: 'Target preflight refused: spec cwd differs from working_directory.' };
  }
  const resolvedCwd = await realpath(spec.cwd).catch(() => null);
  const resolvedRoot = await realpath(target.expected_git_root).catch(() => null);
  if (resolvedCwd !== spec.cwd || resolvedRoot !== target.expected_git_root) {
    return { ok: false, error: 'Target preflight refused: target paths resolve through a symlink.' };
  }
  const snapshot = await gitSnapshot(spec.cwd);
  if (!snapshot.ok) return { ok: false, error: `Target preflight refused: ${snapshot.error}` };
  if (snapshot.root !== target.expected_git_root) {
    return {
      ok: false,
      error: `Target preflight refused: expected Git root ${target.expected_git_root}, found ${snapshot.root}.`,
    };
  }
  if (!snapshot.head.startsWith(target.expected_head.toLowerCase())) {
    return {
      ok: false,
      error: `Target preflight refused: expected HEAD ${target.expected_head}, found ${snapshot.head}.`,
    };
  }
  if (target.git_common_directory && snapshot.common !== target.git_common_directory) {
    return {
      ok: false,
      error: `Target preflight refused: expected Git common directory ${target.git_common_directory}, found ${snapshot.common}.`,
    };
  }
  const identityCheck = await verifyTargetIdentities(target);
  if (!identityCheck.ok) {
    return { ok: false, error: `Target preflight refused: ${identityCheck.error}` };
  }
  const recheckedCwd = await realpath(spec.cwd).catch(() => null);
  const recheckedRoot = await realpath(target.expected_git_root).catch(() => null);
  if (recheckedCwd !== spec.cwd || recheckedRoot !== target.expected_git_root) {
    return { ok: false, error: 'Target preflight refused: target paths changed during preflight.' };
  }
  const recheckedIdentity = await verifyTargetIdentities(target);
  if (!recheckedIdentity.ok) {
    return { ok: false, error: `Target preflight refused: ${recheckedIdentity.error} during preflight.` };
  }
  const scopeBudget = { entries: 0, bytes: 0 };
  for (const allowedPath of target.allowed_paths ?? []) {
    const symlink = await symlinkInPath(target.expected_git_root, allowedPath);
    if (symlink) {
      return {
        ok: false,
        error: `Target preflight refused: allowed path ${allowedPath} contains a symlink or escapes the Git root (${symlink}).`,
      };
    }
    const nestedSymlink = await symlinkInScope(target.expected_git_root, allowedPath, scopeBudget);
    if (nestedSymlink) {
      return {
        ok: false,
        error: `Target preflight refused: allowed path ${allowedPath} contains a symlink or escapes the Git root (${nestedSymlink}).`,
      };
    }
  }
  return { ok: true, target, snapshot };
}

async function capturePatch(spec, allowedPaths) {
  if (!spec.patch_artifact) return false;
  const verified = await gitSnapshot(spec.cwd);
  const target = spec.target_context;
  if (!verified.ok
    || verified.root !== target.expected_git_root
    || !verified.head.startsWith(target.expected_head.toLowerCase())
    || (target.git_common_directory && verified.common !== target.git_common_directory)) {
    return false;
  }
  for (const allowedPath of allowedPaths) {
    if (await symlinkInPath(target.expected_git_root, allowedPath)) return false;
  }
  // Compare against HEAD so staged and unstaged tracked edits are both
  // recoverable; plain `git diff` would silently omit staged model changes.
  // `allowedPaths` are always Git-root-relative. Run the pathspec commands
  // from the root as well, because Git resolves pathspecs relative to the
  // `-C` directory when the model's working directory is nested.
  const gitRoot = verified.root;
  const tracked = gitCommand(gitRoot, ['diff', 'HEAD', '--no-ext-diff', '--binary', '--', ...allowedPaths]);
  if (!tracked.ok) return false;
  const fragments = tracked.output ? [tracked.output] : [];
  const untracked = gitCommand(
    gitRoot,
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...allowedPaths],
    true,
  );
  if (untracked.ok) {
    for (const relativePath of untracked.output.split('\0').filter(Boolean)) {
      const result = spawnSync('git', [
        '-C', gitRoot,
        'diff', '--no-index', '--no-ext-diff', '--binary', '--', '/dev/null', relativePath,
      ], { cwd: gitRoot, encoding: 'utf8', timeout: 15000 });
      if ((result.status === 0 || result.status === 1) && result.stdout) {
        fragments.push(result.stdout.trim());
      }
    }
  }
  const patch = fragments.filter(Boolean).join('\n');
  if (!patch) return false;
  await writeFile(spec.patch_artifact, `${patch}\n`, { mode: 0o600 });
  return true;
}

async function main() {
  if (!specPath || !path.isAbsolute(specPath)) {
    process.exitCode = 2;
    return;
  }

  let spec;
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8'));
  } catch {
    process.exitCode = 2;
    return;
  }
  await unlink(specPath).catch(() => {});

  let database;
  try {
    database = openStore(spec.database_file);
  } catch {
    process.exitCode = 1;
    return;
  }
  const acceptedJob = getStoredJob(database, spec.id);
  if (!acceptedJob) {
    database.close();
    process.exitCode = 1;
    return;
  }
  const acceptedAt = Date.parse(acceptedJob.created_at ?? '') || Date.now();
  const deadlineMs = fixedDeadlineMs(spec, acceptedJob);
  const deadlineAt = deadlineMs === null ? null : new Date(deadlineMs).toISOString();
  const patchJob = (patch) => updateJob(database, spec.id, {
    ...patch,
    updated_at: new Date().toISOString(),
  });
  const currentTerminal = acceptedJob.terminal_state
    ?? (['completed', 'failed', 'cancelled', 'timeout'].includes(acceptedJob.lifecycle_state)
      ? acceptedJob.lifecycle_state
      : null);
  if (currentTerminal) {
    database.close();
    return;
  }

  let child;
  let logWriter;
  let timeoutTimer;
  let forceTimer;
  let heartbeatTimer;
  let timedOut = false;
  let timedOutAt = null;
  let signalSent = null;
  let forcedKill = false;
  let lastLogBytes = 0;
  let lastOutputAt = null;
  let currentPhase = 'started';
  let terminalStateCommitted = false;
  let childExitAt = null;

  const deadlineExpired = () => deadlineMs !== null && Date.now() >= deadlineMs;
  const finishTerminal = (outcome, patch, payload = null) => {
    const result = terminalizeJob(database, spec.id, outcome, patch, payload);
    terminalStateCommitted = Boolean(result.changed || result.job?.terminal_state);
    return result;
  };
  const updateHeartbeat = async (details = {}) => {
    const currentBytes = await fileSize(spec.log_file);
    const now = Date.now();
    if (currentBytes !== lastLogBytes) {
      lastLogBytes = currentBytes;
      lastOutputAt = new Date(now).toISOString();
    }
    recordHeartbeat(database, spec.id, {
      at: new Date(now).toISOString(),
      output_at: lastOutputAt,
      log_bytes: currentBytes,
      details: {
        elapsed_seconds: elapsedSeconds(acceptedAt, now),
        deadline_at: deadlineAt,
        ...details,
      },
    });
  };
  const forward = (signal) => {
    signalSent = signal;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The child may have already exited.
    }
  };
  const onDeadline = () => {
    if (timedOut || terminalStateCommitted) return;
    timedOut = true;
    timedOutAt = Date.now();
    signalSent = 'SIGTERM';
    void updateHeartbeat({ deadline_reached: true }).catch(() => {});
    forward('SIGTERM');
    forceTimer = setTimeout(() => {
      forcedKill = true;
      signalSent = 'SIGKILL';
      forward('SIGKILL');
    }, 5000);
  };

  try {
    const startedAt = Date.now();
    const started = transitionJob(database, spec.id, 'started', {
      runner_pid: process.pid,
      started_at: new Date(startedAt).toISOString(),
      finished_at: null,
      exit_code: null,
      signal: null,
      signal_sent: null,
      forced_kill: 0,
      deadline_at: deadlineAt,
      elapsed_seconds: null,
      termination_reason: null,
      last_activity_at: new Date(startedAt).toISOString(),
      last_heartbeat_at: new Date(startedAt).toISOString(),
      last_output_at: null,
      partial_output_available: 0,
      workspace_changed: null,
      changed_paths: JSON.stringify([]),
      heartbeat: JSON.stringify({ phase: 'started', deadline_at: deadlineAt }),
      stalled: 0,
      log_bytes: 0,
      error: null,
    }, { deadline_at: deadlineAt });
    if (!started.changed && started.job?.terminal_state) return;

    heartbeatTimer = setInterval(() => { void updateHeartbeat().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
    await updateHeartbeat();
    if (deadlineMs !== null) {
      timeoutTimer = setTimeout(onDeadline, Math.max(0, deadlineMs - Date.now()));
    }

    let preflight;
    try {
      preflight = await preflightTarget(spec);
    } catch (error) {
      preflight = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (deadlineExpired() || timedOut) {
      timedOut = true;
      timedOutAt ??= Date.now();
      finishTerminal('timeout', {
        finished_at: new Date(timedOutAt).toISOString(),
        elapsed_seconds: elapsedSeconds(acceptedAt, timedOutAt),
        termination_reason: 'wall_clock_timeout',
        failure_class: 'timeout',
        error: `Exceeded the wall-clock deadline${deadlineAt ? ` at ${deadlineAt}` : ''}.`,
        partial_output_available: 0,
        log_bytes: 0,
        workspace_tainted: preflight?.target ? 1 : null,
        heartbeat: JSON.stringify({ phase: 'timeout', deadline_at: deadlineAt }),
      }, { deadline_at: deadlineAt });
      return;
    }
    if (!preflight.ok) {
      const finishedAt = Date.now();
      finishTerminal('failed', {
        finished_at: new Date(finishedAt).toISOString(),
        elapsed_seconds: elapsedSeconds(acceptedAt, finishedAt),
        termination_reason: 'target_preflight_failed',
        failure_class: 'tool_error',
        error: preflight.error || 'Target preflight failed.',
        partial_output_available: 0,
        log_bytes: 0,
        workspace_tainted: null,
      }, { reason: 'target_preflight_failed' });
      return;
    }

    if (deadlineExpired()) {
      onDeadline();
      finishTerminal('timeout', {
        finished_at: new Date(deadlineMs).toISOString(),
        elapsed_seconds: elapsedSeconds(acceptedAt, deadlineMs),
        termination_reason: 'wall_clock_timeout',
        failure_class: 'timeout',
        error: `Exceeded the wall-clock deadline${deadlineAt ? ` at ${deadlineAt}` : ''}.`,
        partial_output_available: 0,
        log_bytes: 0,
        workspace_tainted: preflight.target ? 1 : null,
      }, { deadline_at: deadlineAt });
      return;
    }

    const fragments = outputRedactions(spec);
    logWriter = createWriteStream(spec.log_file, { flags: 'a', mode: 0o600 });

    const inheritedNames = [
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'PATH',
      'LANG',
      'LC_ALL',
      'TERM',
      'TMPDIR',
      ...(spec.kind === 'grok_build'
        ? ['XAI_API_KEY']
        : spec.kind === 'deepseek_agent' || spec.kind === 'dsh_web'
          ? ['MODEL_API_KEY', 'DSH_HOME']
          : []),
    ];
    const inheritedEnvironment = Object.fromEntries(
      inheritedNames
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    );
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      env: {
        ...inheritedEnvironment,
        ...spec.env,
        PLUMBOB_CONTROL_JOB_ID: spec.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const outputCaptured = Promise.all([
      captureSanitizedLines(child.stdout, logWriter, fragments),
      captureSanitizedLines(child.stderr, logWriter, fragments),
    ]);

    const resultPromise = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const workingAt = Date.now();
    const working = transitionJob(database, spec.id, 'working', {
      child_pid: child.pid ?? null,
      finished_at: null,
      exit_code: null,
      signal: null,
      signal_sent: null,
      forced_kill: 0,
      last_activity_at: new Date(workingAt).toISOString(),
      last_heartbeat_at: new Date(workingAt).toISOString(),
      error: null,
    }, { child_pid: child.pid ?? null });
    if (!working.changed && working.job?.terminal_state) {
      forward('SIGTERM');
      return;
    }
    currentPhase = 'working';
    process.on('SIGTERM', () => forward('SIGTERM'));
    process.on('SIGINT', () => forward('SIGINT'));
    await updateHeartbeat();

    const result = await resultPromise;
    await outputCaptured;
    await new Promise((resolve) => logWriter.end(resolve));
    logWriter = null;
    childExitAt = Date.now();
    const cancelTimestamp = await readFile(spec.cancel_file, 'utf8')
      .then((value) => Date.parse(value.trim().split(/\r?\n/, 1)[0]))
      .catch(() => Number.NaN);
    const cancellationRequested = Number.isFinite(cancelTimestamp) || await exists(spec.cancel_file);
    const cancellationBeforeExit = cancellationRequested
      && (!Number.isFinite(cancelTimestamp) || cancelTimestamp <= childExitAt);
    const cancellationWins = cancellationBeforeExit && (!timedOut
      || timedOutAt === null || !Number.isFinite(cancelTimestamp) || cancelTimestamp <= timedOutAt);
    const semanticError = (spec.result_format === 'grok_streaming_json' || spec.result_format === 'grok_json')
      && !cancellationWins && !timedOut
      ? grokBuildFailure((await readFile(spec.log_file, 'utf8').catch(() => '')).slice(-1_048_576))
      : null;
    const bytes = await fileSize(spec.log_file);
    if (bytes !== lastLogBytes) {
      lastLogBytes = bytes;
      lastOutputAt = new Date(childExitAt).toISOString();
    }
    let outcome;
    let terminationReason;
    let error = result.error?.message ?? semanticError ?? null;
    if (cancellationWins) {
      outcome = 'cancelled';
      terminationReason = 'cancelled_by_user';
      error = 'Cancellation was requested before the child completed the job.';
    } else if (timedOut || deadlineExpired()) {
      outcome = 'timeout';
      terminationReason = 'wall_clock_timeout';
      timedOut = true;
      timedOutAt ??= deadlineMs ?? childExitAt;
      error = `Exceeded the wall-clock deadline${deadlineAt ? ` at ${deadlineAt}` : ''}.`;
    } else if (result.error) {
      outcome = 'failed';
      terminationReason = 'spawn_error';
      error = result.error.message;
    } else if (semanticError) {
      outcome = 'failed';
      terminationReason = 'adapter_error';
      error = semanticError;
    } else if (result.signal) {
      outcome = 'failed';
      terminationReason = 'child_signal';
      error = `Child terminated by ${result.signal}.`;
    } else if (result.code !== 0) {
      outcome = 'failed';
      terminationReason = 'nonzero_exit';
      error = `Child exited with code ${result.code}.`;
    } else {
      outcome = 'completed';
      terminationReason = 'completed';
    }

    let workspaceChanged = null;
    let workspaceTainted = outcome === 'timeout' || outcome === 'cancelled' ? true : null;
    let changed = [];
    let patchAvailable = false;
    if (preflight.target) {
      const postflight = await gitSnapshot(spec.cwd);
      const postflightIdentity = postflight.ok
        ? await verifyTargetIdentities(preflight.target)
        : { ok: false, error: 'target directory identity could not be verified.' };
      if (!postflight.ok && outcome !== 'timeout' && outcome !== 'cancelled') {
        outcome = 'failed';
        terminationReason = 'scope_verification_failed';
        error = `Target scope verification failed: ${postflight.error}`;
      } else if (postflight.ok && !postflightIdentity.ok && outcome !== 'timeout' && outcome !== 'cancelled') {
        outcome = 'failed';
        terminationReason = 'scope_verification_failed';
        error = `Target scope verification failed: ${postflightIdentity.error}`;
      } else if (postflight.ok) {
        changed = changedPaths(
          preflight.snapshot.status,
          postflight.status,
          preflight.snapshot.evidence,
          postflight.evidence,
        );
        workspaceChanged = changed.length > 0;
        const ignoredChanges = changed.filter((changedPath) =>
          preflight.snapshot.status.get(changedPath) === '!!'
          || postflight.status.get(changedPath) === '!!');
        const outOfScope = changed.filter((changedPath) => !ignoredChanges.includes(changedPath)
          && !pathAllowed(changedPath, preflight.target.allowed_paths));
        const rootOrHeadChanged = postflight.root !== preflight.target.expected_git_root
          || (preflight.target.git_common_directory
            && postflight.common !== preflight.target.git_common_directory)
          || !postflight.head.startsWith(preflight.target.expected_head.toLowerCase());
        const symlinkedPaths = [];
        for (const changedPath of changed) {
          const symlink = await symlinkInPath(preflight.target.expected_git_root, changedPath);
          if (symlink) symlinkedPaths.push(`${changedPath} (${symlink})`);
        }
        const scopeSafe = !rootOrHeadChanged
          && symlinkedPaths.length === 0
          && outOfScope.length === 0
          && ignoredChanges.length === 0;
        if (outcome === 'completed' && rootOrHeadChanged) {
          outcome = 'failed';
          terminationReason = 'scope_verification_failed';
          error = 'Target scope verification failed: Git root or HEAD changed during execution.';
        } else if (outcome === 'completed' && symlinkedPaths.length > 0) {
          outcome = 'failed';
          terminationReason = 'scope_violation';
          error = `Target scope violation: changed paths contain symlinks: ${symlinkedPaths.join(', ')}.`;
        } else if (outcome === 'completed' && outOfScope.length > 0) {
          outcome = 'failed';
          terminationReason = 'scope_violation';
          error = `Target scope violation: changed paths outside the allowlist: ${outOfScope.join(', ')}.`;
        } else if (outcome === 'completed' && ignoredChanges.length > 0) {
          outcome = 'failed';
          terminationReason = 'ignored_file_change';
          error = `Target scope verification found ignored-file changes; refusing to report success or emit an artifact: ${ignoredChanges.join(', ')}.`;
        } else if (outcome === 'completed' && preflight.target.role !== 'implement' && changed.length > 0) {
          outcome = 'failed';
          terminationReason = 'read_only_violation';
          error = `Target ${preflight.target.role} run changed files: ${changed.join(', ')}.`;
        } else if (outcome === 'completed' && preflight.target.role === 'implement' && !workspaceChanged) {
          outcome = 'failed';
          terminationReason = 'no_workspace_change';
          error = 'Target implement run completed without changing any allowed workspace path.';
        }
        if (scopeSafe && outcome === 'completed' && preflight.target.role === 'implement' && workspaceChanged
          && !deadlineExpired()) {
          patchAvailable = await capturePatch(spec, preflight.target.allowed_paths).catch(() => false);
          if (!patchAvailable) {
            outcome = 'failed';
            terminationReason = 'patch_capture_failed';
            error = 'Target changes were verified but a safe recoverable patch could not be captured.';
          }
        }
      }
    }
    if (deadlineExpired() && outcome !== 'cancelled') {
      outcome = 'timeout';
      terminationReason = 'wall_clock_timeout';
      timedOut = true;
      timedOutAt ??= deadlineMs ?? Date.now();
      error = `Exceeded the wall-clock deadline${deadlineAt ? ` at ${deadlineAt}` : ''}.`;
      patchAvailable = false;
    }
    if (workspaceTainted) {
      error = `${error ? `${error} ` : ''}The target checkout may contain partial changes; no patch artifact is trustworthy and it requires inspection before reuse.`;
    }

    await updateHeartbeat({ terminal_candidate: outcome });
    const finishedAt = Date.now();
    const terminalTime = outcome === 'timeout' && deadlineMs !== null
      ? new Date(deadlineMs).toISOString()
      : new Date(finishedAt).toISOString();
    finishTerminal(outcome, {
      finished_at: terminalTime,
      exit_code: result.code ?? null,
      signal: result.signal ?? null,
      signal_sent: signalSent ?? (cancellationRequested ? 'SIGTERM' : null),
      forced_kill: forcedKill || result.signal === 'SIGKILL' ? 1 : 0,
      elapsed_seconds: elapsedSeconds(acceptedAt, finishedAt),
      termination_reason: terminationReason,
      failure_class: failureClassFor(terminationReason, outcome),
      last_activity_at: new Date(finishedAt).toISOString(),
      last_heartbeat_at: new Date(finishedAt).toISOString(),
      last_output_at: lastOutputAt,
      partial_output_available: bytes > 0 ? 1 : 0,
      workspace_changed: workspaceChanged === null ? null : workspaceChanged ? 1 : 0,
      workspace_tainted: workspaceTainted === null ? null : workspaceTainted ? 1 : 0,
      changed_paths: JSON.stringify(changed),
      patch_artifact: patchAvailable ? spec.patch_artifact : null,
      log_bytes: bytes,
      stalled: 0,
      heartbeat: JSON.stringify({
        phase: outcome,
        elapsed_seconds: elapsedSeconds(acceptedAt, finishedAt),
        last_activity_at: new Date(finishedAt).toISOString(),
        last_output_at: lastOutputAt,
        deadline_at: deadlineAt,
      }),
      error,
    }, {
      termination_reason: terminationReason,
      failure_class: failureClassFor(terminationReason, outcome),
      deadline_at: deadlineAt,
    });
  } catch (error) {
    const finishedAt = Date.now();
    const bytes = await fileSize(spec.log_file);
    const outcome = timedOut || deadlineExpired() ? 'timeout' : 'failed';
    const terminationReason = outcome === 'timeout' ? 'wall_clock_timeout' : 'runner_error';
    try {
      finishTerminal(outcome, {
        finished_at: outcome === 'timeout' && deadlineMs !== null
          ? new Date(deadlineMs).toISOString()
          : new Date(finishedAt).toISOString(),
        elapsed_seconds: elapsedSeconds(acceptedAt, finishedAt),
        termination_reason: terminationReason,
        failure_class: failureClassFor(terminationReason, outcome),
        error: outcome === 'timeout'
          ? `Exceeded the wall-clock deadline${deadlineAt ? ` at ${deadlineAt}` : ''}.`
          : (error instanceof Error ? error.message : String(error)),
        partial_output_available: bytes > 0 ? 1 : 0,
        log_bytes: bytes,
        workspace_tainted: outcome === 'timeout' ? 1 : null,
      }, { termination_reason: terminationReason });
    } catch {
      // A competing terminal writer owns the immutable outcome.
    }
    process.exitCode = 1;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (logWriter) logWriter.end();
    database.close();
  }
}

await main();
