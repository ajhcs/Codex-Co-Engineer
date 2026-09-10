import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CredentialBoundaryError,
  materializeProviderEnvironment,
  projectProviderEnvironment,
} from './credential-boundary.mjs';

import {
  ACTIVE_STATUSES,
  STORED_TERMINAL,
  VERSION,
  mcpPendingCallReport,
  providerCapabilities,
  publicState,
} from './contract.mjs';
import { COMPACT_VIEW, projectCompactTask, resolveTaskView } from './compact-task.mjs';
import { deadlineReached, nextDeadlineExtension, resolveTaskDeadline } from './deadline.mjs';
import { compactSummary, compactTaskCard, diagnosticEnvelope, projectCompactStatus, readTaskDiagnostics } from './diagnostics.mjs';
import { completedWithoutLiveQuestionIdentity } from './grok-question-bridge.mjs';
import { readAttention, submitReply } from './mailbox.mjs';
import {
  appendTaskEvent,
  clearTaskLaunchReservation,
  createLaunchReservation,
  createTask,
  launchReservationActive,
  listTasks,
  listTasksPage,
  parseStatusIncludeTasks,
  parseStatusTaskLimit,
  projectLiveLastEvent,
  readRuntimeRecord,
  readTask,
  requireTaskId,
  reserveTaskLaunch,
  stateRoot,
  taskPaths,
  updateTask,
  waitForAnyTaskProgress,
  waitForTaskProgress,
  writeRuntimeRecord,
} from './task-store.mjs';
import {
  cancelCursorCloudTask,
  loadCursorApiKey,
  loadCursorSdk,
  preflightCursorCloudOrigin,
  reconcileCursorCloudTask,
} from './cursor-cloud-worker.mjs';
import { reconnectAcpTask } from './acp-worker.mjs';
import {
  inspectExactProcessBoundary,
  launchProcessBoundary,
  probeProcessBoundary,
  PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS,
  stopExactProcessBoundary,
  stopProcessBoundary,
} from './process-boundary.mjs';
import {
  classifyRunToolCall,
  createDurableRunSeams,
  createInProcessRunSeams,
  createRunToolAdapter,
  deliverSupervisorSameSessionReplyV1,
  cancelSupervisorSameSessionReplyV1,
} from './run-tool-adapter.mjs';
import { createRunAdmissionRuntime } from './run-admission.mjs';
import { RunContractV1Error } from './run-manifest.mjs';
import { createRunAdmissionStore } from './run-admission-store.mjs';
import {
  compileRunRequestV1,
  RUN_REQUEST_DEFAULT_MODELS,
} from './run-request-compiler.mjs';
import {
  assertOwnedRevisionProducerV1,
  deriveOwnedRevisionRequestV1,
  parseOwnedRevisionRequestV1,
  projectOwnedProducerCandidateV1,
} from './owned-delegation.mjs';
import { loadReadinessSnapshot, saveReadinessSnapshot } from './readiness-snapshot.mjs';
import { buildGitIdentityV1, buildWorkspaceIdentityV1 } from './protected-identity.mjs';
import { assertRuntimeEntrypoints } from './runtime-entrypoints.mjs';
import { BUNDLED_WORKTREE_BOOTSTRAP } from './worktree-bootstrap-runtime.mjs';

const execFile = promisify(nodeExecFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acp-worker.mjs');
const CLOUD_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cursor-cloud-worker.mjs');
const ACTIVE = new Set(ACTIVE_STATUSES);
const PROVIDERS = new Set(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
const DEFAULT_DSH_MODEL = 'meta/muse-spark-1.3-contributor';
const DSH_MODELS = Object.freeze({
  [DEFAULT_DSH_MODEL]: Object.freeze({
    configEnv: 'CODEX_CO_ENGINEER_DSH_ACP_CONFIG',
    configFile: 'dsh-acp.yml',
    credentialEnv: 'OPENROUTER_API_KEY',
    credentialFileEnv: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credentialFile: 'openrouter-api-key',
  }),
  'stealth/ox-alpha': Object.freeze({
    configEnv: 'CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG',
    configFile: 'dsh-acp-ox-alpha.yml',
    credentialEnv: 'OPENROUTER_API_KEY',
    credentialFileEnv: 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
    credentialFile: 'openrouter-api-key',
  }),
});
const WORKSPACE_MODES = new Set(['managed', 'direct']);
const WORKTREE_CREATE_MAX_BUFFER = 16 * 1024 * 1024;
const SIMPLE_DISPATCH_EVIDENCE_TIMEOUT_MS = 5_000;
const SIMPLE_DISPATCH_EVIDENCE_POLL_MS = 25;
const PROVIDER_READINESS_TTL_MS = 30_000;
const PROVIDER_READINESS_PROBE_TIMEOUT_MS = 2_000;
const PUBLIC_STARTUP_MESSAGES = Object.freeze({
  credential_permissions: 'Provider credential configuration is invalid.',
  dsh_acp_not_configured: 'DSH ACP configuration is invalid.',
  invalid_credential_file: 'Provider credential configuration is invalid.',
  invalid_state_dir: 'Co-Engineer state configuration is invalid.',
  invalid_worktree: 'The provider worktree is invalid.',
  invalid_repo: 'The supplied repository worktree is invalid.',
  workspace_missing: 'The requested workspace is missing.',
  workspace_invalid: 'The requested workspace is invalid.',
  workspace_branch_missing: 'The requested workspace is not attached to a branch.',
  workspace_branch_mismatch: 'The requested workspace branch does not match its receipt.',
  workspace_start_ref_missing: 'The requested workspace did not provide an immutable starting commit.',
  workspace_start_ref_invalid: 'The requested workspace has an invalid starting commit.',
  workspace_head_mismatch: 'The requested workspace changed before provider launch.',
  workspace_root_mismatch: 'The requested workspace path is not its Git worktree root.',
  workspace_dirty: 'The source worktree has uncommitted changes; clean it before managed delegation.',
  worktree_create_failed: 'The managed worktree could not be prepared.',
  worktree_bootstrap_exact_sha_unsupported: 'The installed worktree-bootstrap does not support exact local-SHA creation; upgrade worktree-bootstrap before retrying.',
  worker_boundary_uncertain: 'The worker boundary could not be stopped; reconcile or cancel this task.',
  worker_boundary_pending: 'The worker process boundary is not yet final.',
  worker_boundary_missing: 'The worker process boundary receipt is missing.',
  worker_boundary_inspect_failed: 'The worker process boundary could not be inspected.',
  worker_boundary_identity_mismatch: 'The worker process boundary identity did not match this task.',
  worker_boundary_pid_visibility_unknown: 'The worker process boundary process visibility is unknown.',
  worker_boundary_membership_unknown: 'The worker process boundary membership is unknown.',
  worker_boundary_stop_failed: 'The worker process boundary could not be stopped.',
  worker_boundary_not_empty: 'The worker process boundary still has descendants.',
  worktree_lock_inspect_failed: 'The worktree lock could not be inspected.',
  worktree_lock_identity_mismatch: 'The worktree lock identity did not match this task.',
  worktree_lock_liveness_unknown: 'The worktree lock liveness could not be proven.',
  worktree_lock_cleanup_failed: 'The worktree lock could not be cleaned.',
  worktree_git_changed_during_recovery: 'The worktree Git identity changed during recovery.',
  boundary_visibility_unknown: 'The worker process boundary could not be proven idle or empty.',
  boundary_identity_mismatch: 'The worker process boundary identity did not match this task.',
  boundary_not_empty: 'The worker process boundary still has descendants.',
  lock_release_unproven: 'The worktree lock release could not be proven.',
  lock_cleanup_refused: 'The worktree lock cleanup was refused.',
  cleanup_failed: 'Task lifecycle cleanup failed.',
  cgroup_not_empty: 'Owned systemd process boundary still has descendants after exact unit stop.',
  cancelled: 'The task was cancelled before worker startup.',
  provider_startup_failed: 'Provider startup could not be prepared.',
  model_unattested: 'The configured provider route cannot select the requested model.',
  prompt_envelope_missing: 'The compiled child prompt envelope is missing.',
  task_launch_busy: 'Another worker already owns this task launch.',
  local_boundary_unavailable: 'The local systemd/cgroup process boundary is unavailable.',
  systemd_user_manager_unavailable: 'The local systemd user manager is unavailable.',
  systemd_user_cgroup_unverifiable: 'The local systemd user-manager cgroup could not be verified.',
  systemd_run_unavailable: 'The local systemd-run client is unavailable.',
  systemd_too_old: 'The local systemd version is too old.',
  cgroup_v2_unavailable: 'The local unified cgroup v2 hierarchy is unavailable.',
  linux_required: 'Local providers require Linux.',
  posix_uid_required: 'Local providers require a normal Linux user identity.',
  boundary_probe_failed: 'The local process boundary could not be checked.',
  systemd_run_failed: 'systemd-run could not queue the local worker service.',
  worker_start_failed: 'The worker failed to start.',
  cursor_cloud_workspace_missing: 'Cursor Cloud requires an existing Git workspace.',
  cursor_cloud_workspace_invalid: 'Cursor Cloud requires a valid Git workspace.',
  cursor_cloud_workspace_dirty: 'Cursor Cloud requires a clean local checkout before dispatch.',
  cursor_cloud_workspace_changed: 'Cursor Cloud checkout state changed after preflight; retry from the pinned commit.',
  cursor_cloud_origin_changed: 'Cursor Cloud origin changed after preflight; retry from the pinned provider origin.',
  cursor_cloud_origin_missing: 'Cursor Cloud requires a provider-visible Git origin or an explicit provider repository override.',
  cursor_cloud_origin_invalid: 'Cursor Cloud requires a valid provider-visible Git origin.',
  cursor_cloud_origin_credentials: 'Cursor Cloud origin credentials are not accepted; configure a credential-free origin or provider repository override.',
  cursor_cloud_origin_unsupported: 'Cursor Cloud does not support this repository origin format.',
  cursor_cloud_repo_invalid: 'Cursor Cloud requires a valid provider repository URL.',
  cursor_cloud_repo_credentials: 'Cursor Cloud provider repository URLs cannot contain credentials, query, or fragment data.',
  cursor_cloud_repo_override_conflict: 'Cursor Cloud accepts one provider repository override.',
  cursor_cloud_repo_identity_invalid: 'Cursor Cloud could not determine a canonical repository identity.',
  cursor_cloud_start_ref_unavailable: 'Cursor Cloud requires an immutable starting commit.',
  cursor_cloud_start_ref_invalid: 'Cursor Cloud requires a full 40-character commit starting reference.',
  invalid_provider_repo: 'provider_repo_url is supported only for Cursor Cloud tasks.',
  runtime_install_incomplete: 'The installed Codex-Co-Engineer runtime is incomplete. Reinstall the plugin, then restart Codex.',
});

export class SupervisorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'SupervisorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SupervisorError(code, message);
}

function publicStartupError(error, fallbackCode = 'worker_start_failed') {
  const mapped = error instanceof CredentialBoundaryError
    ? (PUBLIC_STARTUP_MESSAGES[error.code] ? error.code : (error.code === 'credential_too_large' || error.code === 'credential_empty' || error.code === 'credential_file_changed' || error.code === 'credential_hardlink_denied' || error.code === 'credential_owner_denied' || error.code === 'credential_symlink_denied' || error.code === 'credential_unreadable' || error.code === 'invalid_credential_path' || error.code === 'invalid_handoff' ? 'invalid_credential_file' : error.code))
    : (typeof error?.code === 'string' ? error.code : fallbackCode);
  const rawCode = typeof mapped === 'string' ? mapped : fallbackCode;
  const code = /^[A-Za-z0-9._-]{1,96}$/u.test(rawCode) ? rawCode : fallbackCode;
  const message = PUBLIC_STARTUP_MESSAGES[code] ?? PUBLIC_STARTUP_MESSAGES[fallbackCode] ?? 'The worker failed to start.';
  // Startup failures cross the MCP boundary. Keep the public error bounded and
  // do not retain a provider path, stderr, or credential-bearing cause object.
  return new SupervisorError(code, message);
}

function normalizedAbsolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`invalid_${field}`, `${field} must be an absolute, normalized path.`);
  }
  return value;
}

function resolveDshModel(value) {
  const model = value ?? DEFAULT_DSH_MODEL;
  if (!Object.hasOwn(DSH_MODELS, model)) {
    fail('invalid_dsh_model', `dsh_model must be one of ${Object.keys(DSH_MODELS).join(', ')}.`);
  }
  return model;
}

// The live Grok, Cursor Local, and Cursor Cloud transports currently expose
// only their configured provider defaults. Keep semantic model overrides from
// being presented as effective selections until a provider-specific control
// can select and attest them. DSH is routed through its existing config
// selection below.
function assertProviderModelDispatchable(provider, model) {
  if (provider === 'dsh') {
    resolveDshModel(model);
    return;
  }
  if (model !== RUN_REQUEST_DEFAULT_MODELS[provider]) {
    fail('model_unattested', 'The configured provider route cannot select the requested model.');
  }
}

function resolveTaskModel(provider, model, dshModel) {
  if (model === undefined) return undefined;
  if (provider === 'dsh') {
    const resolved = resolveDshModel(model);
    if (dshModel !== undefined && dshModel !== resolved) {
      fail('invalid_dsh_model', 'The DSH model selections do not agree.');
    }
    return resolved;
  }
  assertProviderModelDispatchable(provider, model);
  return model;
}

function providerArgv(provider, env = process.env, dshModel) {
  if (provider === 'grok') return [env.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok', 'agent', '--always-approve', 'stdio'];
  if (provider === 'cursor-local') return [env.CODEX_CO_ENGINEER_CURSOR_COMMAND ?? 'cursor-agent', 'acp'];
  if (provider === 'dsh') {
    const model = resolveDshModel(dshModel);
    const selection = DSH_MODELS[model];
    const config = env[selection.configEnv] ?? path.join(
      env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config'),
      'codex-co-engineer',
      selection.configFile,
    );
    if (!path.isAbsolute(config)) fail('dsh_acp_not_configured', 'DSH ACP config path must be absolute.');
    return [env.CODEX_CO_ENGINEER_DSH_ACP_COMMAND ?? 'dsh-acp-demo', '--config', path.resolve(config)];
  }
  fail('unsupported_provider', `Unsupported provider: ${provider}`);
}

async function workerEnvironment(provider, source = process.env, dshModel) {
  try {
    return await materializeProviderEnvironment({
      provider,
      source,
      dshModel: provider === 'dsh' ? resolveDshModel(dshModel) : undefined,
      operation: 'lane',
    });
  } catch (error) {
    if (error instanceof CredentialBoundaryError) {
      const code = PUBLIC_STARTUP_MESSAGES[error.code] ? error.code : 'invalid_credential_file';
      fail(code === 'credential_permissions' ? 'credential_permissions' : 'invalid_credential_file', error.message);
    }
    throw error;
  }
}

async function localBoundaryReadiness(probe = probeProcessBoundary) {
  try {
    const boundary = await probe();
    if (boundary && typeof boundary === 'object' && typeof boundary.ready === 'boolean') return boundary;
  } catch {
    // Return a bounded public result rather than leaking a host command error.
  }
  return Object.freeze({
    ready: false,
    status: 'unavailable',
    reason: 'boundary_probe_failed',
    action: 'Inspect the local systemd user-manager and unified cgroup v2 prerequisites.',
    provider_started: false,
  });
}

function requireLocalBoundary(boundary) {
  if (boundary.ready) return boundary;
  const error = new SupervisorError(
    typeof boundary.reason === 'string' ? boundary.reason : 'local_boundary_unavailable',
    'The local process boundary is unavailable.',
  );
  throw publicStartupError(error, 'local_boundary_unavailable');
}

function parseJsonSuffix(stdout) {
  const text = String(stdout ?? '').trim();
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Bootstrap commands may write arbitrary text before the final receipt.
    }
  }
  return null;
}

function parseWorktreeResult(stdout, taskId) {
  const value = parseJsonSuffix(stdout);
  if (value?.status !== 'ready'
    || value.task !== taskId
    || typeof value.worktree_path !== 'string'
    || !path.isAbsolute(value.worktree_path)
    || path.resolve(value.worktree_path) !== value.worktree_path
    || typeof value.branch !== 'string'
    || value.branch.length === 0) {
    fail('worktree_create_failed', 'worktree-bootstrap did not return a valid ready receipt.');
  }
  return value;
}

function managedSourceDirty(stdout) {
  // `git status --porcelain=v1` starts every changed entry with two status
  // columns. Keep the parser deliberately narrow so a mocked or noisy git
  // command cannot turn an unrelated line into a dirty-worktree failure.
  return String(stdout ?? '').split(/\r?\n/u).some((line) => /^[ MADRCU?!]{2}\s*\S/u.test(line));
}

function missingWorkspaceError(error) {
  if (error?.code === 'ENOENT') return true;
  return /(?:no such file|cannot change to|does not exist)/iu.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`);
}

async function validateManagedSource({ repo, baseSha, execute = execFile }) {
  normalizedAbsolute(repo, 'repo');
  let branchOutput;
  let statusOutput;
  let headOutput;
  try {
    const checks = await Promise.all([
      execute('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }),
      execute('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }),
      ...(baseSha ? [execute('git', ['-C', repo, 'rev-parse', '--verify', `${baseSha}^{commit}`], { encoding: 'utf8' })] : []),
    ]);
    ({ stdout: branchOutput } = checks[0]);
    ({ stdout: statusOutput } = checks[1]);
    if (baseSha) ({ stdout: headOutput } = checks[2]);
  } catch (error) {
    const code = missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid';
    throw new SupervisorError(code, code === 'workspace_missing'
      ? 'The source workspace does not exist.'
      : 'The source workspace is not a valid Git worktree.', { cause: error });
  }
  const branch = String(branchOutput ?? '').trim();
  if (!branch && !baseSha) fail('workspace_branch_missing', 'The source workspace must be attached to a branch.');
  if (managedSourceDirty(statusOutput)) {
    fail('workspace_dirty', 'The source worktree must be clean before managed delegation.');
  }
  if (baseSha) {
    if (!/^[0-9a-f]{40}$/iu.test(baseSha)) fail('workspace_start_ref_invalid', 'The exact local base must be a full commit SHA.');
    if (String(headOutput ?? '').trim().toLowerCase() !== baseSha.toLowerCase()) {
      fail('workspace_start_ref_invalid', 'The exact local base could not be resolved to the requested commit.');
    }
  }
  return { branch, base_sha: baseSha ?? null };
}

async function validateWorkspaceContract(workspace, taskId, {
  execute = execFile,
  checkPath = stat,
  expectedStartSha,
} = {}) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    fail('workspace_missing', 'Managed delegation did not return a workspace.');
  }
  if (workspace.status !== undefined && workspace.status !== 'ready') {
    fail('workspace_invalid', 'Managed delegation returned a workspace that is not ready.');
  }
  const workspaceTask = workspace.task ?? workspace.worktree_task;
  const worktreePath = workspace.worktree_path ?? workspace.cwd;
  if (typeof workspaceTask !== 'string' || workspaceTask.length === 0 || workspaceTask !== taskId) {
    fail('workspace_invalid', 'Managed delegation returned an invalid workspace identity.');
  }
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath) {
    fail('workspace_invalid', 'Managed delegation returned an invalid workspace path.');
  }
  if (typeof workspace.branch !== 'string' || workspace.branch.trim().length === 0) {
    fail('workspace_branch_missing', 'Managed delegation returned a workspace without a branch.');
  }
  if (typeof workspace.start_sha !== 'string' || workspace.start_sha.length === 0) {
    fail('workspace_start_ref_missing', 'Managed delegation returned a workspace without an immutable starting commit.');
  }
  if (!/^[0-9a-f]{40}$/iu.test(workspace.start_sha)) {
    fail('workspace_start_ref_invalid', 'Managed delegation returned an invalid starting commit.');
  }
  if (expectedStartSha !== undefined && workspace.start_sha.toLowerCase() !== String(expectedStartSha).toLowerCase()) {
    fail('workspace_start_ref_invalid', 'Managed delegation returned a workspace at the wrong exact starting commit.');
  }
  let metadata;
  try {
    metadata = await checkPath(worktreePath);
  } catch (error) {
    const code = missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid';
    fail(code, code === 'workspace_missing'
      ? 'Managed delegation returned a workspace path that does not exist.'
      : 'Managed delegation returned a workspace path that cannot be inspected.');
  }
  if (typeof metadata?.isDirectory !== 'function' || !metadata.isDirectory()) {
    fail('workspace_invalid', 'Managed delegation returned a workspace path that is not a directory.');
  }
  let outputs;
  try {
    outputs = await Promise.all([
      execute('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
      execute('git', ['-C', worktreePath, 'branch', '--show-current'], { encoding: 'utf8' }),
      execute('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    ]);
  } catch (error) {
    const code = missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid';
    fail(code, code === 'workspace_missing'
      ? 'Managed delegation returned a path that is not an accessible Git worktree.'
      : 'Managed delegation returned a path that is not a valid Git worktree.');
  }
  const [{ stdout: rootOutput }, { stdout: branchOutput }, { stdout: headOutput }] = outputs;
  const root = String(rootOutput ?? '').trim();
  if (!path.isAbsolute(root) || path.resolve(root) !== worktreePath) {
    fail('workspace_root_mismatch', 'Managed delegation returned a path that is not its Git worktree root.');
  }
  const branch = String(branchOutput ?? '').trim();
  if (!branch) fail('workspace_branch_missing', 'Managed delegation returned a detached workspace.');
  if (branch !== workspace.branch.trim()) {
    fail('workspace_branch_mismatch', 'Managed delegation returned a branch that does not match its Git worktree.');
  }
  const head = String(headOutput ?? '').trim();
  if (!/^[0-9a-f]{40}$/iu.test(head) || head.toLowerCase() !== workspace.start_sha.toLowerCase()) {
    fail('workspace_head_mismatch', 'Managed delegation workspace HEAD does not match its recorded starting commit.');
  }
  return {
    ...workspace,
    task: workspaceTask,
    worktree_path: worktreePath,
    branch,
    start_sha: workspace.start_sha.toLowerCase(),
  };
}

export async function createWriterWorkspace({ taskId, repo, baseSha, execute = execFile, checkPath = stat }) {
  requireTaskId(taskId);
  const source = await validateManagedSource({ repo, baseSha, execute });
  try {
    const exactSha = baseSha ?? null;
    const base = exactSha ?? source.branch;
    if (!base) fail('workspace_branch_missing', 'Writer source must be attached to a branch.');
    const argv = ['create', taskId, '--repo', repo, '--base', base];
    // Exact-SHA creation is deliberately delegated to the official
    // worktree-bootstrap capability. There is no raw `git worktree` fallback:
    // the bootstrap owns locks, branch identity, and handoff semantics.
    if (exactSha) argv.push('--local-only');
    let result;
    try {
      result = await execute(BUNDLED_WORKTREE_BOOTSTRAP, argv, {
      encoding: 'utf8',
      maxBuffer: WORKTREE_CREATE_MAX_BUFFER,
      });
    } catch (error) {
      if (exactSha && /(?:unknown option|unrecognized option|invalid option|local-only)/iu.test(`${error?.message ?? ''} ${error?.stderr ?? ''}`)) {
        throw new SupervisorError('worktree_bootstrap_exact_sha_unsupported', 'The installed worktree-bootstrap does not support exact local-SHA creation.', { cause: error });
      }
      throw error;
    }
    return await validateWorkspaceContract(parseWorktreeResult(result.stdout, taskId), taskId, {
      execute,
      checkPath,
      ...(exactSha ? { expectedStartSha: exactSha } : {}),
    });
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    throw new SupervisorError('worktree_create_failed', error?.stderr?.trim() || error?.message || 'worktree-bootstrap failed.', { cause: error });
  }
}

async function readerWorkspace(repo, execute = execFile) {
  normalizedAbsolute(repo, 'repo');
  let resolved;
  try {
    resolved = await realpath(repo);
  } catch (error) {
    throw new SupervisorError(missingWorkspaceError(error) ? 'workspace_missing' : 'workspace_invalid',
      missingWorkspaceError(error) ? 'The source workspace does not exist.' : 'The source workspace is invalid.', { cause: error });
  }
  let outputs;
  try {
    outputs = await Promise.all([
      execute('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }),
      execute('git', ['-C', resolved, 'branch', '--show-current'], { encoding: 'utf8' }),
      execute('git', ['-C', resolved, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    ]);
  } catch (error) {
    throw new SupervisorError('workspace_invalid', 'The source workspace is not a valid Git worktree.', { cause: error });
  }
  const [{ stdout: rootOutput }, { stdout: branchOutput }, { stdout: shaOutput }] = outputs;
  const root = path.resolve(rootOutput.trim());
  if (root !== resolved) fail('invalid_repo', 'repo must identify the Git worktree root.');
  return {
    worktree_path: resolved,
    branch: branchOutput.trim() || null,
    start_sha: shaOutput.trim() || null,
    task: null,
    status: 'ready',
  };
}

function resolveWorkspaceMode(provider, requested) {
  const value = requested ?? 'managed';
  if (!WORKSPACE_MODES.has(value)) {
    fail('invalid_workspace_mode', 'workspace_mode must be managed or direct.');
  }
  // Cursor Cloud owns the remote workspace/branch. It never receives a local
  // worktree, so normalize its effective mode to direct while retaining the
  // simple managed/direct public vocabulary for local providers.
  return provider === 'cursor-cloud' ? 'direct' : value;
}

function workspaceReference(workspace, taskId) {
  const task = workspace?.task ?? workspace?.worktree_task ?? taskId;
  const worktreePath = workspace?.worktree_path ?? workspace?.cwd;
  if (typeof task !== 'string' || typeof worktreePath !== 'string'
    || !path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath) {
    return null;
  }
  return { task, worktree_path: worktreePath };
}

/**
 * Remove only a provably abandoned worktree-bootstrap writer lock. The
 * worktree and branch are intentionally retained for inspection/merge; this
 * helper never performs destructive Git cleanup and treats every failure as a
 * warning for the task receipt.
 */
export async function cleanupManagedWorkspace({ workspace, taskId, execute = execFile } = {}) {
  const reference = workspaceReference(workspace, taskId);
  if (!reference) return { state: 'unavailable', cleaned: false };
  try {
    const { stdout } = await execute(BUNDLED_WORKTREE_BOOTSTRAP, [
      'lock', 'inspect', reference.task, '--repo', reference.worktree_path,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const lock = parseJsonSuffix(stdout);
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
      throw Object.assign(new Error('worktree-bootstrap lock inspect did not return a JSON receipt.'), {
        code: 'worktree_cleanup_failed',
      });
    }
    if (lock.state === 'unlocked') return { state: 'unlocked', cleaned: false };
    const health = lock.health;
    if (!health || typeof health !== 'object' || Array.isArray(health) || typeof health.state !== 'string') {
      throw Object.assign(new Error('worktree-bootstrap lock inspect returned an invalid lock receipt.'), {
        code: 'worktree_cleanup_failed',
      });
    }
    if (health.state !== 'abandoned' || typeof lock.lock_id !== 'string' || lock.lock_id.length === 0) {
      return { state: health.state ?? lock.state ?? 'unknown', cleaned: false };
    }
    await execute(BUNDLED_WORKTREE_BOOTSTRAP, [
      'lock', 'clean', reference.task,
      '--repo', reference.worktree_path,
      '--policy', 'dead-local',
      '--lock-id', lock.lock_id,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return { state: 'cleaned', cleaned: true, lock_id: lock.lock_id };
  } catch (error) {
    const exitCode = Number.isInteger(error?.status) ? error.status : (Number.isInteger(error?.code) ? error.code : undefined);
    return {
      state: 'cleanup_failed',
      cleaned: false,
      exit_code: exitCode,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'worktree_cleanup_failed',
        message: 'Worktree lock cleanup failed.',
      },
    };
  }
}

function cleanupEventFields(result) {
  const exitCode = Number.isInteger(result?.exit_code) ? result.exit_code : undefined;
  let code;
  if (result?.error?.code) code = result.error.code;
  else if (result?.cleaned) code = null;
  else if (result?.state === 'unlocked') code = null;
  else code = 'lock_cleanup_refused';
  return {
    type: result?.error ? 'cleanup_warning' : 'cleanup',
    code,
    cleaned: result?.cleaned === true,
    ...(exitCode !== undefined ? { exit_code_class: `exit_${exitCode}` } : {}),
  };
}

async function recordManagedCleanup(root, task, execute, options = {}) {
  if (task?.workspace_kind !== 'managed-worktree') return null;
  if (options.requireInactiveEmpty && options.boundaryState !== 'inactive_empty') {
    const result = {
      state: options.boundaryState ?? 'unknown',
      cleaned: false,
      error: {
        code: 'worktree_lock_liveness_unknown',
        message: 'Worktree lock cleanup requires exact inactive empty boundary proof.',
      },
    };
    await appendTaskEvent(root, task.id, cleanupEventFields(result)).catch(() => {});
    return result;
  }
  const result = await cleanupManagedWorkspace({
    workspace: task,
    taskId: task.worktree_task ?? task.id,
    execute,
  });
  await appendTaskEvent(root, task.id, cleanupEventFields(result)).catch(() => {});
  return result;
}

async function writeRequest(root, taskId) {
  const paths = taskPaths(root, taskId);
  const handle = await open(paths.request, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ root, task_id: taskId })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return paths;
}

function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)[19] ?? null;
  } catch {
    return null;
  }
}

export async function launchWorker({
  root,
  taskId,
  cwd,
  writer,
  provider,
  env: sourceEnv = process.env,
  spawn = nodeSpawn,
  launchBoundary = launchProcessBoundary,
  stopBoundary = stopProcessBoundary,
  writeRuntime = writeRuntimeRecord,
} = {}) {
  const initial = (await readTask(root, taskId)).task;
  if (initial.status !== 'accepted') {
    fail('cancelled', `Task cannot launch from ${initial.status}.`);
  }
  const launchReservation = launchReservationActive(initial)
    ? initial.launch_reservation
    : await reserveTaskLaunch(root, taskId);
  const paths = await writeRequest(root, taskId);
  const log = await open(paths.log, 'a', 0o600);
  const worker = provider === 'cursor-cloud' ? CLOUD_WORKER : WORKER;
  const workerArgv = [process.execPath, '--no-warnings', worker, '--request', paths.request];
  const command = writer ? BUNDLED_WORKTREE_BOOTSTRAP : workerArgv.shift();
  const args = writer
    ? ['launch', taskId, '--repo', cwd, '--', ...workerArgv]
    : workerArgv;
  let child;
  let boundary;
  try {
    const env = await workerEnvironment(provider, sourceEnv, initial.dsh_model);
    if (provider === 'cursor-cloud') {
      child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } else {
      boundary = await launchBoundary({
        command,
        args,
        cwd,
        env,
        stdio: ['ignore', log.fd, log.fd],
        logPath: paths.log,
        taskId,
      });
      child = boundary.child;
    }
  } finally {
    await log.close();
  }
  child.unref();
  try {
    const current = (await readTask(root, taskId)).task;
    if (current.status !== 'accepted' || current.launch_reservation?.token !== launchReservation.token) {
      if (boundary?.handle) await stopBoundary(boundary.handle);
      fail('cancelled', `Task launch reservation is no longer valid (${current.status}).`);
    }
    const runtime = await writeRuntime(root, taskId, {
      pid: child.pid,
      process_group: boundary ? null : child.pid,
      process_start_ticks: processStartTicks(child.pid),
      command: writer ? BUNDLED_WORKTREE_BOOTSTRAP : process.execPath,
      ...(boundary ? { process_boundary: boundary.receipt } : {}),
    });
    await appendTaskEvent(root, taskId, { type: 'worker', state: 'spawned', pid: child.pid });
    await clearTaskLaunchReservation(root, taskId, launchReservation.token).catch(() => {});
    return runtime;
  } catch (error) {
    if (boundary?.handle) {
      try {
        await stopBoundary(boundary.handle);
      } catch (stopError) {
        const recovery = {
          task_id: taskId,
          pid: child.pid,
          process_group: null,
          process_start_ticks: processStartTicks(child.pid),
          command: writer ? BUNDLED_WORKTREE_BOOTSTRAP : process.execPath,
          process_boundary: boundary.receipt,
          updated_at: new Date().toISOString(),
        };
        const uncertain = new SupervisorError(
          'worker_boundary_uncertain',
          'Worker launch failed and its owned process boundary could not be stopped; reconcile or cancel this task.',
          { cause: stopError },
        );
        await updateTask(root, taskId, {
          status: 'transport_lost',
          error: { code: uncertain.code, message: uncertain.message },
          runtime_recovery: recovery,
        }).catch(() => {});
        await clearTaskLaunchReservation(root, taskId, launchReservation.token).catch(() => {});
        throw uncertain;
      }
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
    }
    await clearTaskLaunchReservation(root, taskId, launchReservation.token).catch(() => {});
    throw error;
  }
}

export async function submitTask(input, dependencies = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request', 'Task input must be an object.');
  const id = requireTaskId(input.task_id);
  if (!PROVIDERS.has(input.provider)) fail('unsupported_provider', `Unsupported provider: ${input.provider}`);
  if (input.provider !== 'dsh' && input.dsh_model !== undefined) {
    fail('invalid_dsh_model', 'dsh_model is supported only for DSH tasks.');
  }
  const dshModel = input.provider === 'dsh' ? resolveDshModel(input.dsh_model) : undefined;
  const taskModel = resolveTaskModel(input.provider, input.model, dshModel);
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) fail('invalid_prompt', 'prompt must be non-empty text.');
  const role = input.role ?? 'implement';
  if (!['review', 'implement'].includes(role)) fail('invalid_role', 'role must be review or implement.');
  if (input.provider !== 'cursor-cloud' && input.create_pr === true) {
    fail('invalid_create_pr', 'create_pr is supported only for Cursor Cloud tasks.');
  }
  if (input.provider !== 'cursor-cloud' && input.starting_ref !== undefined) {
    fail('invalid_starting_ref', 'starting_ref is supported only for Cursor Cloud tasks.');
  }
  if (input.provider !== 'cursor-cloud' && (input.provider_repo_url !== undefined || input.provider_repo !== undefined)) {
    fail('invalid_provider_repo', 'provider_repo_url is supported only for Cursor Cloud tasks.');
  }
  if (input.provider === 'cursor-cloud' && input.provider_repo_url !== undefined
    && input.provider_repo !== undefined && input.provider_repo_url !== input.provider_repo) {
    fail('cursor_cloud_repo_override_conflict', 'Provide only one provider repository override.');
  }
  const workspaceMode = resolveWorkspaceMode(input.provider, input.workspace_mode);
  const deadline = resolveTaskDeadline(input);
  if (input.silence_timeout_ms !== undefined && input.silence_timeout_ms !== null) {
    if (!Number.isInteger(input.silence_timeout_ms) || input.silence_timeout_ms < 5_000 || input.silence_timeout_ms > 86_400_000) {
      fail('invalid_silence_timeout_ms', 'silence_timeout_ms must be an integer from 5000 to 86400000.');
    }
  }
  const root = dependencies.root ?? stateRoot();
  try {
    await readTask(root, id);
    fail('task_exists', `Task ${id} already exists.`);
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await (dependencies.preflightRuntime ?? assertRuntimeEntrypoints)(input.provider);
  } catch {
    throw publicStartupError(
      new SupervisorError('runtime_install_incomplete', 'The installed runtime is incomplete.'),
      'runtime_install_incomplete',
    );
  }
  if (input.provider !== 'cursor-cloud') {
    requireLocalBoundary(await localBoundaryReadiness(dependencies.probeBoundary));
  }
  let launchEnv;
  try {
    launchEnv = await workerEnvironment(input.provider, dependencies.env ?? process.env, dshModel);
  } catch (error) {
    throw publicStartupError(error, 'provider_startup_failed');
  }
  const managed = input.provider !== 'cursor-cloud' && workspaceMode === 'managed';
  const writer = managed;
  let workspace = null;
  let cloudPreflight = null;
  let taskCreated = false;
  try {
    const preparedWorkspace = dependencies.preparedWorkspace;
    if (preparedWorkspace !== undefined) {
      workspace = preparedWorkspace;
      if (managed) {
        workspace = await validateWorkspaceContract(workspace, id, {
          execute: dependencies.execute,
          checkPath: dependencies.checkPath,
          expectedStartSha: dependencies.baseSha,
        });
      } else {
        const verified = await readerWorkspace(input.repo, dependencies.execute);
        if (workspace?.worktree_path !== verified.worktree_path
          || workspace?.start_sha?.toLowerCase() !== verified.start_sha?.toLowerCase()) {
          fail('workspace_invalid', 'The prepared provider workspace changed before launch.');
        }
        workspace = verified;
      }
    } else {
      workspace = managed
        ? await (dependencies.createWorkspace ?? createWriterWorkspace)({
          taskId: id,
          repo: input.repo,
          ...(dependencies.baseSha !== undefined ? { baseSha: dependencies.baseSha } : {}),
          ...(dependencies.createWorkspace ? {} : { execute: dependencies.execute, checkPath: dependencies.checkPath }),
        })
        : await readerWorkspace(input.repo, dependencies.execute);
    }
    // The built-in bootstrap already returns a verified contract. Re-verify
    // only injected workspace factories so normal dispatch does not repeat a
    // stat plus three Git subprocesses on every managed task.
    if (managed && dependencies.createWorkspace) workspace = await validateWorkspaceContract(workspace, id, {
      execute: dependencies.execute,
      checkPath: dependencies.checkPath,
    });
    if (input.provider === 'cursor-cloud') {
      const preflight = dependencies.preflightCloudOrigin ?? preflightCursorCloudOrigin;
      const readGit = dependencies.readGit ?? (dependencies.execute
        ? async (cwd, args) => {
          const result = await dependencies.execute('git', ['-C', cwd, ...args], { encoding: 'utf8' });
          return String(result?.stdout ?? '').trim();
        }
        : undefined);
      cloudPreflight = await preflight({
        cwd: workspace.worktree_path,
        providerRepoUrl: input.provider_repo_url ?? input.provider_repo,
        startingRef: input.starting_ref,
        ...(readGit ? { readGit } : {}),
      });
    }
    const agentArgv = input.provider === 'cursor-cloud'
      ? undefined
      : providerArgv(input.provider, dependencies.env ?? process.env, dshModel);
    const { task } = await createTask({
      root,
      prompt: input.prompt,
      record: {
        id,
        status: 'accepted',
        provider: input.provider,
        ...(dshModel ? { dsh_model: dshModel } : {}),
        ...(taskModel ? { model: taskModel } : {}),
        ...(typeof input.run_id === 'string' ? { run_id: input.run_id } : {}),
        ...(typeof input.assignment_id === 'string' ? { assignment_id: input.assignment_id } : {}),
        ...(typeof input.access === 'string' ? { access: input.access } : {}),
        ...(Array.isArray(input.write_scope) ? { write_scope: [...input.write_scope] } : {}),
        ...(Array.isArray(input.capabilities) ? { capabilities: [...input.capabilities] } : {}),
        ...(typeof input.child_envelope_digest === 'string'
          ? { child_envelope_digest: input.child_envelope_digest }
          : {}),
        role,
        source_repo: input.repo,
        cwd: workspace.worktree_path,
        branch: workspace.branch,
        start_sha: workspace.start_sha,
        worktree_task: workspace.task,
        workspace_mode: workspaceMode,
        workspace_kind: input.provider === 'cursor-cloud'
          ? 'provider-managed'
          : managed ? 'managed-worktree' : 'direct',
        ...(cloudPreflight ? {
          provider_repo_url: cloudPreflight.provider_repo_url,
          provider_repo_source: cloudPreflight.provider_repo_source,
          provider_repo_identity: cloudPreflight.provider_repo_identity,
          provider_origin_kind: cloudPreflight.provider_origin_kind,
        } : {}),
        ...(agentArgv ? { agent_argv: agentArgv } : {}),
        launch_reservation: createLaunchReservation(),
        starting_ref: cloudPreflight?.starting_ref ?? input.starting_ref,
        timeout_ms: deadline.timeout_ms,
        expected_duration_ms: deadline.expected_duration_ms,
        duration_margin: deadline.duration_margin,
        deadline_at: deadline.deadline_at,
        deadline_source: deadline.deadline_source,
        deadline_extensions: [],
        silence_timeout_ms: input.silence_timeout_ms ?? null,
        create_pr: input.create_pr === true,
      },
    });
    taskCreated = true;
    await appendTaskEvent(root, id, { type: 'accepted', provider: input.provider, role });
    const runtime = await (dependencies.launch ?? launchWorker)({
      root,
      taskId: id,
      cwd: task.cwd,
      writer,
      provider: input.provider,
      env: launchEnv,
    });
    return { task: (await readTask(root, id)).task, runtime };
  } catch (error) {
    if (taskCreated) {
      const current = (await readTask(root, id)).task;
      if (!['transport_lost', 'cancelling'].includes(current.status)) {
        const safe = publicStartupError(error);
        await updateTask(root, id, {
          status: 'failed',
          error: { code: safe.code, message: safe.message },
          finished_at: new Date().toISOString(),
        }).catch(() => {});
      }
      await clearTaskLaunchReservation(root, id, current.launch_reservation?.token).catch(() => {});
      await recordManagedCleanup(root, (await readTask(root, id)).task, dependencies.execute);
    } else if (managed) {
      await cleanupManagedWorkspace({
        workspace,
        taskId: id,
        execute: dependencies.execute,
      });
    }
    throw taskCreated ? publicStartupError(error) : publicStartupError(error, 'provider_startup_failed');
  }
}

function processIdentity(pid, processGroup, expectedTicks) {
  if (!Number.isInteger(pid) || pid < 2 || !Number.isInteger(processGroup) || processGroup < 2) return null;
  const ticks = processStartTicks(pid);
  if (!ticks || ticks !== expectedTicks) return null;
  return { pid, process_group: processGroup, process_start_ticks: ticks };
}

function currentProcessIdentity(runtime) {
  return processIdentity(runtime?.pid, runtime?.process_group, runtime?.process_start_ticks);
}

function expectedLeaderFromRuntime(runtime) {
  const pid = Number(runtime?.pid);
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  if (typeof runtime.process_start_ticks !== 'string' || runtime.process_start_ticks.length === 0) return null;
  return { pid, process_start_ticks: runtime.process_start_ticks };
}

function rememberedIdentitiesFromRuntime(runtime) {
  const remembered = [];
  if (Array.isArray(runtime?.remembered_process_identities)) {
    remembered.push(...runtime.remembered_process_identities);
  }
  const leader = expectedLeaderFromRuntime(runtime);
  if (leader) remembered.push(leader);
  return remembered;
}

async function inspectRuntimeBoundary(runtime, dependencies = {}) {
  if (!runtime?.process_boundary) return null;
  const inspect = dependencies.inspectBoundary ?? inspectExactProcessBoundary;
  try {
    return await inspect(runtime.process_boundary, {
      adapter: dependencies.adapter,
      expectedLeader: expectedLeaderFromRuntime(runtime),
      rememberedIdentities: rememberedIdentitiesFromRuntime(runtime),
    });
  } catch {
    return Object.freeze({
      state: 'unknown',
      stop_allowed: false,
      identity_matched: false,
      code: 'worker_boundary_inspect_failed',
    });
  }
}

async function runtimeActive(runtime, dependencies = {}) {
  if (runtime?.process_boundary) {
    const inspection = await inspectRuntimeBoundary(runtime, dependencies);
    return inspection?.state === 'active';
  }
  return Boolean(currentProcessIdentity(runtime));
}

function taskRuntime(runtime, task) {
  return runtime ?? task?.runtime_recovery ?? null;
}

async function stopRuntimeBoundary(runtime, dependencies = {}) {
  if (!runtime?.process_boundary) return null;
  return (dependencies.stopExactBoundary ?? stopExactProcessBoundary)(runtime.process_boundary, {
    adapter: dependencies.adapter,
    expectedLeader: expectedLeaderFromRuntime(runtime),
    rememberedIdentities: rememberedIdentitiesFromRuntime(runtime),
    timeoutMs: dependencies.stopTimeoutMs,
  });
}

function boundaryIsInactiveEmpty(inspection) {
  return inspection?.state === 'inactive_empty' && inspection.empty !== false;
}

function currentProviderIdentity(task) {
  return processIdentity(task?.provider_process_group, task?.provider_process_group, task?.provider_process_start_ticks);
}

export async function extendTaskDeadline(root, taskId, { expected_duration_ms, reason } = {}) {
  const { task } = await readTask(root, taskId);
  const changes = nextDeadlineExtension(task, { expected_duration_ms, reason });
  const next = await updateTask(root, taskId, changes);
  await appendTaskEvent(root, taskId, {
    type: 'deadline_extended',
    reason: reason?.trim?.().slice(0, 512) ?? null,
    previous_deadline_at: task.deadline_at ?? null,
    deadline_at: next.deadline_at,
    expected_duration_ms: next.expected_duration_ms,
  });
  return next;
}

export const LOCAL_TASK_LIFECYCLE_VERSION = 1;
const CLEANUP_FINAL = new Set(['normal', 'recovered']);
const PUBLIC_LIFECYCLE_CODE = Object.freeze({
  worker_boundary_pid_visibility_unknown: 'boundary_visibility_unknown',
  worker_boundary_membership_unknown: 'boundary_visibility_unknown',
  worker_boundary_inspect_failed: 'boundary_visibility_unknown',
  worker_boundary_identity_mismatch: 'boundary_identity_mismatch',
  worker_boundary_not_empty: 'boundary_not_empty',
  worker_boundary_stop_failed: 'boundary_not_empty',
  cgroup_not_empty: 'boundary_not_empty',
  worktree_lock_liveness_unknown: 'lock_release_unproven',
  worktree_lock_identity_mismatch: 'lock_cleanup_refused',
  worktree_lock_cleanup_failed: 'lock_cleanup_refused',
  worktree_lock_inspect_failed: 'lock_cleanup_refused',
});

function publicLifecycleCode(code) {
  if (typeof code !== 'string' || code.length === 0) return 'worker_boundary_pending';
  return PUBLIC_LIFECYCLE_CODE[code] ?? (PUBLIC_STARTUP_MESSAGES[code] ? code : 'cleanup_failed');
}

function lifecycleBlocksFinalProjection(task) {
  let status;
  let cleanup;
  try {
    status = task?.status;
    cleanup = task?.cleanup;
  } catch {
    return false;
  }
  if (!STORED_TERMINAL.includes(status)) return false;
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) return false;
  return !CLEANUP_FINAL.has(cleanup.status);
}

function freezeLocalTaskLifecycle(values) {
  return Object.freeze({
    version: LOCAL_TASK_LIFECYCLE_VERSION,
    task_id: values.task_id,
    stored_status: values.stored_status ?? null,
    projected_status: values.projected_status ?? null,
    public_state: values.public_state ?? publicState(values.projected_status ?? undefined),
    final: values.final === true,
    cleanup: values.cleanup,
    boundary: values.boundary,
    lock: values.lock,
    reason: values.reason ?? null,
  });
}

function localTaskLifecycleFrom(task, fields) {
  const overlay = fields.cleanupRecord ? { ...task, cleanup: fields.cleanupRecord } : task;
  const classified = classifySupervisorTerminalReceipt(overlay);
  return freezeLocalTaskLifecycle({
    task_id: task.id,
    stored_status: task.status,
    projected_status: classified.projected_status,
    public_state: classified.public_state,
    final: fields.final === true,
    cleanup: fields.cleanup,
    boundary: fields.boundary,
    lock: fields.lock,
    reason: fields.reason ?? classified.reason ?? null,
  });
}

async function persistLifecycleEvidence(root, task, cleanup, extra = {}) {
  const next = await updateTask(root, task.id, { cleanup });
  await appendTaskEvent(root, task.id, {
    type: 'cleanup',
    status: cleanup.status,
    boundary: cleanup.boundary,
    lock: cleanup.lock,
    code: cleanup.code ?? null,
    ...(extra.forced ? { forced: true } : {}),
    ...(extra.exit_code_class ? { exit_code_class: extra.exit_code_class } : {}),
  }).catch(() => {});
  if (extra.runtime) {
    await writeRuntimeRecord(root, task.id, {
      ...extra.runtime,
      lifecycle_proof: {
        status: cleanup.status,
        boundary: cleanup.boundary,
        lock: cleanup.lock,
        code: cleanup.code ?? null,
        recovered: extra.recovered === true,
        git: extra.git ?? null,
      },
    }).catch(() => {});
  }
  return next;
}

function gitIdentity(outputs) {
  return Object.freeze({
    head: String(outputs.head ?? '').trim(),
    tree: String(outputs.tree ?? '').trim(),
    branch: String(outputs.branch ?? '').trim(),
    clean: String(outputs.porcelain ?? '').trim() === '',
  });
}

async function snapshotTaskGit(task, dependencies = {}) {
  const cwd = task?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  if (typeof dependencies.snapshotGit === 'function') return dependencies.snapshotGit(task);
  const execute = dependencies.execute ?? execFile;
  try {
    const [head, tree, branch, status] = await Promise.all([
      execute('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      execute('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }),
      execute('git', ['-C', cwd, 'branch', '--show-current'], { encoding: 'utf8' }),
      execute('git', ['-C', cwd, 'status', '--porcelain=v1'], { encoding: 'utf8' }),
    ]);
    return gitIdentity({
      head: head.stdout,
      tree: tree.stdout,
      branch: branch.stdout,
      porcelain: status.stdout,
    });
  } catch {
    return null;
  }
}

function sameGitIdentity(before, after) {
  return Boolean(before && after
    && before.head === after.head
    && before.tree === after.tree
    && before.branch === after.branch
    && before.clean === after.clean);
}

async function snapshotUnrelatedUnits(receipt, dependencies = {}) {
  if (typeof dependencies.snapshotUnits === 'function') return dependencies.snapshotUnits(receipt);
  const exec = dependencies.adapter?.execFile ?? (dependencies.execute
    ? (command, args, options) => dependencies.execute(command, args, options)
    : null);
  if (typeof exec !== 'function') return null;
  try {
    const listed = await exec('/usr/bin/systemctl', [
      '--user', 'list-units', '--all', '--no-legend', '--plain', '--no-pager', 'codex-co-engineer-*.service',
    ], { encoding: 'utf8', timeout: 3_000, maxBuffer: 64 * 1024 });
    const units = Object.create(null);
    for (const line of String(listed?.stdout ?? '').split(/\r?\n/u)) {
      const unit = line.trim().split(/\s+/u)[0];
      if (!unit || unit === receipt.unit || !/^codex-co-engineer-[a-f0-9]{32}\.service$/u.test(unit)) continue;
      const shown = await exec('/usr/bin/systemctl', [
        '--user', 'show', unit, '--no-pager', '--property=Id', '--property=ActiveState',
        '--property=InvocationID', '--property=MainPID',
      ], { encoding: 'utf8', timeout: 3_000, maxBuffer: 16 * 1024 });
      const properties = Object.create(null);
      for (const row of String(shown?.stdout ?? '').split(/\r?\n/u)) {
        const separator = row.indexOf('=');
        if (separator > 0) properties[row.slice(0, separator)] = row.slice(separator + 1);
      }
      units[unit] = Object.freeze({
        ActiveState: properties.ActiveState ?? null,
        InvocationID: properties.InvocationID ?? null,
        MainPID: properties.MainPID ?? null,
      });
    }
    return Object.freeze(units);
  } catch {
    return null;
  }
}

function sameUnrelatedUnits(before, after) {
  if (!before || !after) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const left = before[key];
    const right = after[key];
    if (!left || !right) return false;
    if (left.ActiveState !== right.ActiveState || left.InvocationID !== right.InvocationID || left.MainPID !== right.MainPID) {
      return false;
    }
  }
  return true;
}

function lockIdentityMatches(lock, task, runtime) {
  const taskId = task.worktree_task ?? task.id;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false;
  if (typeof lock.lock_id !== 'string' || lock.lock_id.length === 0) return false;
  if (lock.task != null && lock.task !== taskId) return false;
  if (lock.schema != null && lock.schema !== 'worktree-bootstrap/v1') return false;
  const worktree = task.cwd ?? task.worktree_path;
  if (lock.worktree_path && worktree && path.resolve(String(lock.worktree_path)) !== path.resolve(worktree)) return false;
  if (lock.branch && task.branch && lock.branch !== task.branch) return false;
  if (lock.start_sha && task.start_sha && String(lock.start_sha).toLowerCase() !== String(task.start_sha).toLowerCase()) return false;
  const wrapperPid = lock.wrapper_pid ?? lock.writer_pid;
  if (runtime?.pid != null && wrapperPid != null && Number(wrapperPid) !== Number(runtime.pid)) return false;
  if (runtime?.process_start_ticks && lock.process_start_ticks
    && String(lock.process_start_ticks) !== String(runtime.process_start_ticks)) return false;
  if (runtime?.command && Array.isArray(lock.command) && lock.command[0] && lock.command[0] !== runtime.command) return false;
  return true;
}

async function inspectManagedLockState(task, runtime, dependencies = {}) {
  if (task.workspace_kind !== 'managed-worktree') {
    return { lock: 'not_applicable', cleaned: false };
  }
  const reference = workspaceReference(task, task.worktree_task ?? task.id);
  if (!reference) return { lock: 'unknown', code: 'worktree_lock_inspect_failed', cleaned: false };
  const execute = dependencies.execute ?? execFile;
  try {
    const { stdout } = await execute(BUNDLED_WORKTREE_BOOTSTRAP, [
      'lock', 'inspect', reference.task, '--repo', reference.worktree_path,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const lock = parseJsonSuffix(stdout);
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
      return { lock: 'unknown', code: 'worktree_lock_inspect_failed', cleaned: false };
    }
    if (lock.state === 'unlocked') return { lock: 'unlocked', cleaned: false, receipt: lock };
    if (!lockIdentityMatches(lock, task, runtime)) {
      return { lock: 'unknown', code: 'worktree_lock_identity_mismatch', cleaned: false, receipt: lock };
    }
    return { lock: 'active', cleaned: false, receipt: lock };
  } catch {
    return { lock: 'unknown', code: 'worktree_lock_inspect_failed', cleaned: false };
  }
}

async function cleanManagedLockAfterBoundary(task, runtime, dependencies = {}) {
  const inspected = await inspectManagedLockState(task, runtime, dependencies);
  if (inspected.lock === 'not_applicable' || inspected.lock === 'unlocked') return inspected;
  if (inspected.lock !== 'active' || !inspected.receipt?.lock_id) return inspected;
  const reference = workspaceReference(task, task.worktree_task ?? task.id);
  const execute = dependencies.execute ?? execFile;
  try {
    await execute(BUNDLED_WORKTREE_BOOTSTRAP, [
      'lock', 'clean', reference.task,
      '--repo', reference.worktree_path,
      '--policy', 'dead-local',
      '--lock-id', inspected.receipt.lock_id,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return { lock: 'cleaned', cleaned: true, receipt: inspected.receipt };
  } catch (error) {
    const exitCode = Number.isInteger(error?.status) ? error.status : (Number.isInteger(error?.code) ? error.code : undefined);
    return {
      lock: 'unknown',
      cleaned: false,
      code: 'worktree_lock_cleanup_failed',
      exit_code: exitCode,
      receipt: inspected.receipt,
    };
  }
}

function cleanupRecord({ status, boundary, lock, code, recoveryAttempted }) {
  return {
    status,
    boundary,
    lock,
    ...(code ? { code } : {}),
    ...(recoveryAttempted ? { recovery_attempted: true } : {}),
  };
}

export async function settleLocalTaskLifecycle(root, task, runtime, dependencies = {}) {
  const current = task && typeof task === 'object' && !Array.isArray(task) && typeof task.id === 'string'
    ? task
    : (await readTask(root, requireTaskId(task))).task;
  const boundRuntime = taskRuntime(runtime, current);
  if (!STORED_TERMINAL.includes(current.status)) {
    const inspection = boundRuntime?.process_boundary
      ? await inspectRuntimeBoundary(boundRuntime, dependencies)
      : null;
    return localTaskLifecycleFrom(current, {
      final: false,
      cleanup: 'pending',
      boundary: inspection?.state ?? 'not_applicable',
      lock: current.workspace_kind === 'managed-worktree' ? 'pending' : 'not_applicable',
      reason: null,
    });
  }
  if (!boundRuntime?.process_boundary) {
    return localTaskLifecycleFrom(current, {
      final: true,
      cleanup: current.cleanup?.status ?? 'normal',
      boundary: 'not_applicable',
      lock: current.workspace_kind === 'managed-worktree' ? (current.cleanup?.lock ?? 'not_applicable') : 'not_applicable',
    });
  }
  if (CLEANUP_FINAL.has(current.cleanup?.status)) {
    return localTaskLifecycleFrom(current, {
      final: true,
      cleanup: current.cleanup.status,
      boundary: current.cleanup.boundary ?? 'inactive_empty',
      lock: current.cleanup.lock ?? 'unlocked',
      reason: current.cleanup.code ?? null,
    });
  }

  const sleep = dependencies.sleep ?? wait;
  // Grant the natural worker/lock drain once, on the first terminal
  // reconciliation. Only supervisor boundary/lock evidence proves that a
  // prior reconciliation already waited; worker ACP/handoff cleanup does not. Repeating the grace on every
  // readiness/status call made retained unknown receipts add two seconds
  // apiece before any fresh inspection.
  const reconciled = Object.hasOwn(current.cleanup ?? {}, 'boundary')
    && Object.hasOwn(current.cleanup ?? {}, 'lock');
  const drainMs = reconciled
    ? 0
    : Number.isFinite(dependencies.drainGraceMs)
      ? dependencies.drainGraceMs
      : PROCESS_BOUNDARY_LIFECYCLE_BOUNDS_MS.natural_boundary_and_lock_drain;
  if (drainMs > 0) await sleep(drainMs);

  let inspection = await inspectRuntimeBoundary(boundRuntime, dependencies);
  let recovered = false;
  let gitBefore = null;
  let unrelatedBefore = null;
  const recoveryAttempted = current.cleanup?.recovery_attempted === true;
  if (inspection?.state === 'active' && inspection.stop_allowed && !recoveryAttempted) {
    gitBefore = await snapshotTaskGit(current, dependencies);
    unrelatedBefore = await snapshotUnrelatedUnits(boundRuntime.process_boundary, dependencies);
    if (!gitBefore || !unrelatedBefore) {
      inspection = {
        ...inspection,
        state: 'unknown',
        stop_allowed: false,
        code: 'worker_boundary_inspect_failed',
      };
    } else {
      try {
        await (dependencies.stopExactBoundary ?? stopExactProcessBoundary)(boundRuntime.process_boundary, {
          adapter: dependencies.adapter,
          expectedLeader: expectedLeaderFromRuntime(boundRuntime),
          rememberedIdentities: rememberedIdentitiesFromRuntime(boundRuntime),
          timeoutMs: dependencies.stopTimeoutMs,
        });
        recovered = true;
        inspection = await inspectRuntimeBoundary(boundRuntime, dependencies);
      } catch (error) {
        const code = error?.code === 'cgroup_not_empty' ? 'cgroup_not_empty' : (error?.code ?? 'worker_boundary_stop_failed');
        const cleanup = cleanupRecord({
          status: 'failed',
          boundary: code === 'cgroup_not_empty' ? 'active' : 'unknown',
          lock: 'active',
          code,
          recoveryAttempted: true,
        });
        const next = await persistLifecycleEvidence(root, current, cleanup, {
          runtime: boundRuntime,
          forced: error?.code === 'cgroup_not_empty',
        });
        return localTaskLifecycleFrom(next, {
          final: false,
          cleanup: cleanup.status,
          boundary: cleanup.boundary,
          lock: cleanup.lock,
          reason: publicLifecycleCode(code),
          cleanupRecord: cleanup,
        });
      }
    }
  }

  if (inspection?.state !== 'inactive_empty') {
    const code = inspection?.code ?? (inspection?.state === 'active' ? 'worker_boundary_pending' : 'worker_boundary_inspect_failed');
    const cleanup = cleanupRecord({
      status: inspection?.state === 'active' ? 'pending' : (code.includes('mismatch') ? 'unknown' : 'unknown'),
      boundary: inspection?.state === 'active' ? 'active' : 'unknown',
      lock: 'pending',
      code,
      recoveryAttempted: recovered || recoveryAttempted,
    });
    const next = await persistLifecycleEvidence(root, current, cleanup, { runtime: boundRuntime });
    return localTaskLifecycleFrom(next, {
      final: false,
      cleanup: cleanup.status,
      boundary: cleanup.boundary,
      lock: cleanup.lock,
      reason: publicLifecycleCode(code === 'worker_boundary_pending' ? 'worker_boundary_pending' : code),
      cleanupRecord: cleanup,
    });
  }

  if (recovered) {
    const gitAfter = await snapshotTaskGit(current, dependencies);
    const unrelatedAfter = await snapshotUnrelatedUnits(boundRuntime.process_boundary, dependencies);
    if (!sameGitIdentity(gitBefore, gitAfter)) {
      const cleanup = cleanupRecord({
        status: 'failed',
        boundary: 'inactive_empty',
        lock: 'unknown',
        code: 'worktree_git_changed_during_recovery',
        recoveryAttempted: true,
      });
      const next = await persistLifecycleEvidence(root, current, cleanup, { runtime: boundRuntime, git: gitAfter });
      return localTaskLifecycleFrom(next, {
        final: false,
        cleanup: cleanup.status,
        boundary: cleanup.boundary,
        lock: cleanup.lock,
        reason: 'worktree_git_changed_during_recovery',
        cleanupRecord: cleanup,
      });
    }
    if (!sameUnrelatedUnits(unrelatedBefore, unrelatedAfter)) {
      const cleanup = cleanupRecord({
        status: 'failed',
        boundary: 'inactive_empty',
        lock: 'unknown',
        code: 'worker_boundary_identity_mismatch',
        recoveryAttempted: true,
      });
      const next = await persistLifecycleEvidence(root, current, cleanup, { runtime: boundRuntime, git: gitAfter });
      return localTaskLifecycleFrom(next, {
        final: false,
        cleanup: cleanup.status,
        boundary: cleanup.boundary,
        lock: cleanup.lock,
        reason: 'boundary_identity_mismatch',
        cleanupRecord: cleanup,
      });
    }
  }

  let lockResult = await inspectManagedLockState(current, boundRuntime, dependencies);
  if (lockResult.lock === 'active') {
    lockResult = await cleanManagedLockAfterBoundary(current, boundRuntime, dependencies);
  }
  if (lockResult.lock === 'unknown' || lockResult.lock === 'active') {
    const code = lockResult.code ?? 'worktree_lock_liveness_unknown';
    const cleanup = cleanupRecord({
      status: 'unknown',
      boundary: 'inactive_empty',
      lock: lockResult.lock,
      code,
      recoveryAttempted: recovered || recoveryAttempted,
    });
    const next = await persistLifecycleEvidence(root, current, cleanup, {
      runtime: boundRuntime,
      recovered,
      git: gitBefore,
      exit_code_class: Number.isInteger(lockResult.exit_code) ? `exit_${lockResult.exit_code}` : undefined,
    });
    return localTaskLifecycleFrom(next, {
      final: false,
      cleanup: cleanup.status,
      boundary: cleanup.boundary,
      lock: cleanup.lock,
      reason: publicLifecycleCode(code),
      cleanupRecord: cleanup,
    });
  }

  const cleanup = cleanupRecord({
    status: recovered ? 'recovered' : 'normal',
    boundary: 'inactive_empty',
    lock: lockResult.lock,
    recoveryAttempted: recovered || recoveryAttempted,
  });
  const next = await persistLifecycleEvidence(root, current, cleanup, {
    runtime: boundRuntime,
    recovered,
    git: gitBefore,
  });
  return localTaskLifecycleFrom(next, {
    final: true,
    cleanup: cleanup.status,
    boundary: cleanup.boundary,
    lock: cleanup.lock,
    cleanupRecord: cleanup,
  });
}

export async function cleanupLocalTaskLifecycle(root, task, runtime, dependencies = {}) {
  return settleLocalTaskLifecycle(root, task, runtime, dependencies);
}

async function reconcileInactiveTask(root, task, runtime, dependencies = {}) {
  const boundRuntime = taskRuntime(runtime, task);
  if (STORED_TERMINAL.includes(task.status) && boundRuntime?.process_boundary) {
    await settleLocalTaskLifecycle(root, task, boundRuntime, dependencies);
    return (await readTask(root, task.id)).task;
  }
  if (!ACTIVE.has(task.status) || launchReservationActive(task)) return task;
  if (boundRuntime?.process_boundary) {
    const inspection = await inspectRuntimeBoundary(boundRuntime, dependencies);
    if (inspection?.state === 'active' || inspection?.state === 'unknown') return task;
  } else if (await runtimeActive(boundRuntime, dependencies)) {
    return task;
  }
  if (deadlineReached(task)) {
    const timedOut = await updateTask(root, task.id, {
      status: 'timeout',
      launch_reservation: null,
      error: {
        code: 'deadline_reached',
        message: 'The recorded task deadline was reached and the worker is no longer running.',
      },
      failed_stage: 'deadline',
      finished_at: new Date().toISOString(),
    });
    await appendTaskEvent(root, task.id, { type: 'terminal', status: 'timeout', reason: 'deadline_reached' }).catch(() => {});
    await recordManagedCleanup(root, timedOut, dependencies.execute, {
      requireInactiveEmpty: Boolean(boundRuntime?.process_boundary),
      boundaryState: boundRuntime?.process_boundary ? 'inactive_empty' : undefined,
    });
    return timedOut;
  }

  if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
    try {
      return await reconcileCursorCloudTask({ root, taskId: task.id });
    } catch (error) {
      return updateTask(root, task.id, {
        status: 'transport_lost',
        launch_reservation: null,
        error: { code: error?.code ?? 'cursor_reconcile_failed', message: 'Cursor Cloud state could not be reconciled.' },
      });
    }
  }

  let boundaryStopped = false;
  if (boundRuntime?.process_boundary) {
    try {
      await (dependencies.stopBoundary ?? stopExactProcessBoundary)(boundRuntime.process_boundary, {
        adapter: dependencies.adapter,
        expectedLeader: expectedLeaderFromRuntime(boundRuntime),
        rememberedIdentities: rememberedIdentitiesFromRuntime(boundRuntime),
      });
      const inspection = await inspectRuntimeBoundary(boundRuntime, dependencies);
      boundaryStopped = boundaryIsInactiveEmpty(inspection);
    } catch {
      // Keep the task reconcilable when exact cgroup cleanup cannot be proven.
    }
  }
  const reconciled = await updateTask(root, task.id, {
    status: 'transport_lost',
    launch_reservation: null,
    error: {
      code: boundaryStopped ? 'worker_not_running' : 'worker_boundary_uncertain',
      message: boundaryStopped
        ? 'Recorded worker stopped; its owned cgroup was emptied without replaying the task.'
        : 'Recorded worker is not running; inspect or cancel this task without replaying it.',
    },
  });
  await recordManagedCleanup(root, reconciled, dependencies.execute, {
    requireInactiveEmpty: Boolean(boundRuntime?.process_boundary),
    boundaryState: boundaryStopped ? 'inactive_empty' : (boundRuntime?.process_boundary ? 'unknown' : undefined),
  });
  return reconciled;
}

function processGroupAlive(processGroup) {
  if (!Number.isInteger(processGroup) || processGroup < 2) return false;
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const SUPERVISOR_FALSE_SUCCESS_REASON = Object.freeze({
  code: 'completed_with_terminal_error',
  message: 'Completed receipt carried a terminal error.',
});

export const SUPERVISOR_UNANSWERABLE_ATTENTION_REASON = Object.freeze({
  code: 'completed_with_unanswerable_attention',
  message: 'Completed receipt had no live question identity.',
});

const WHOLE_RESULT_TERMINAL_TEXT = /^(?:[A-Za-z][\w.]*Error\s+)?(?:\[[A-Za-z0-9._-]{1,64}\]\s+)?PING timed out\.?$/u;
const TERMINAL_TRANSPORT_PROVIDER_CODES = new Set([
  'unavailable',
  'retriable',
  'retriable_error',
  'ping_timeout',
  'ping_timed_out',
  'transport_error',
  'provider_error',
  'provider_unavailable',
  'connection_lost',
  'etimedout',
  'econnreset',
  'econnrefused',
]);

function classificationError(reason) {
  if (reason === SUPERVISOR_UNANSWERABLE_ATTENTION_REASON.code) {
    return Object.freeze({ ...SUPERVISOR_UNANSWERABLE_ATTENTION_REASON });
  }
  if (reason === SUPERVISOR_FALSE_SUCCESS_REASON.code) {
    return Object.freeze({ ...SUPERVISOR_FALSE_SUCCESS_REASON });
  }
  return null;
}

function freezeTerminalClassification({
  stored_status,
  projected_status,
  public_state,
  corrected,
  reason = null,
}) {
  return Object.freeze({
    stored_status,
    projected_status,
    public_state,
    corrected,
    reason,
    error: classificationError(reason),
  });
}

function isWholeResultTerminalText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0 || text.length > 256) return false;
  return WHOLE_RESULT_TERMINAL_TEXT.test(text);
}

function explicitTerminalErrorEnvelope(error) {
  if (error == null) return false;
  if (typeof error === 'string') {
    const text = error.trim();
    return text.length > 0 && text !== 'ok';
  }
  if (typeof error !== 'object' || Array.isArray(error)) return false;
  let code;
  let name;
  let message;
  try {
    code = error.code;
    name = error.name;
    message = error.message;
  } catch {
    return true;
  }
  if (typeof code === 'string' && code.length > 0 && code !== 'ok') return true;
  if (typeof name === 'string' && /error$/iu.test(name.trim())) return true;
  if (typeof message === 'string' && isWholeResultTerminalText(message)) return true;
  return false;
}

function wholeResultTerminalError(result) {
  if (result == null) return false;
  if (typeof result === 'string') return isWholeResultTerminalText(result);
  if (typeof result !== 'object' || Array.isArray(result)) return false;
  let code;
  let name;
  let message;
  let nested;
  let text;
  try {
    code = result.code;
    name = result.name;
    message = result.message;
    nested = result.error;
    text = result.text ?? result.result ?? result.output ?? result.value;
  } catch {
    return true;
  }
  if (typeof name === 'string' && /error$/iu.test(name.trim())) return true;
  if (typeof code === 'string' && TERMINAL_TRANSPORT_PROVIDER_CODES.has(code.trim().toLowerCase())) return true;
  if (typeof message === 'string' && isWholeResultTerminalText(message)) return true;
  if (explicitTerminalErrorEnvelope(nested)) {
    if (text == null || text === '') return true;
    if (typeof text === 'string' && isWholeResultTerminalText(text)) return true;
    return false;
  }
  return typeof text === 'string' && isWholeResultTerminalText(text);
}

/**
 * Deterministic terminal-receipt classifier at the supervisor projection
 * seam. Callers map `projected_status` through `publicState` and must not
 * write the overlay back onto `codex-co-engineer.task.v1` stored bytes.
 */
export function classifySupervisorTerminalReceipt(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return freezeTerminalClassification({
      stored_status: null,
      projected_status: null,
      public_state: publicState(undefined),
      corrected: false,
    });
  }
  let storedStatus = null;
  try {
    storedStatus = typeof task.status === 'string' ? task.status : null;
  } catch {
    return freezeTerminalClassification({
      stored_status: null,
      projected_status: null,
      public_state: publicState(undefined),
      corrected: false,
    });
  }
  if (storedStatus === 'transport_lost') {
    return freezeTerminalClassification({
      stored_status: 'transport_lost',
      projected_status: 'transport_lost',
      public_state: publicState('transport_lost'),
      corrected: false,
    });
  }
  if (lifecycleBlocksFinalProjection(task)) {
    const code = publicLifecycleCode(task.cleanup?.code ?? 'worker_boundary_pending');
    return Object.freeze({
      stored_status: storedStatus,
      projected_status: 'transport_lost',
      public_state: publicState('transport_lost'),
      corrected: false,
      reason: code,
      error: Object.freeze({
        code,
        message: PUBLIC_STARTUP_MESSAGES[code] ?? PUBLIC_STARTUP_MESSAGES.worker_boundary_pending,
      }),
    });
  }
  const wouldSucceed = storedStatus === 'completed' || storedStatus === 'succeeded';
  if (wouldSucceed) {
    let envelope = false;
    let whole = false;
    try {
      envelope = explicitTerminalErrorEnvelope(task.error);
    } catch {
      envelope = true;
    }
    try {
      whole = wholeResultTerminalError(task.result);
    } catch {
      whole = true;
    }
    if (envelope || whole) {
      return freezeTerminalClassification({
        stored_status: storedStatus,
        projected_status: 'failed',
        public_state: publicState('failed'),
        corrected: true,
        reason: SUPERVISOR_FALSE_SUCCESS_REASON.code,
      });
    }
    let unanswered = false;
    try {
      unanswered = completedWithoutLiveQuestionIdentity(task);
    } catch {
      unanswered = true;
    }
    if (unanswered) {
      return freezeTerminalClassification({
        stored_status: storedStatus,
        projected_status: 'failed',
        public_state: publicState('failed'),
        corrected: true,
        reason: SUPERVISOR_UNANSWERABLE_ATTENTION_REASON.code,
      });
    }
  }
  return freezeTerminalClassification({
    stored_status: storedStatus,
    projected_status: storedStatus,
    public_state: publicState(storedStatus ?? undefined),
    corrected: false,
  });
}

export function projectSupervisorPublicState(task) {
  return classifySupervisorTerminalReceipt(task).public_state;
}

function suppressUnfinalTerminalProjection(task, classified) {
  const code = publicLifecycleCode(classified.reason ?? task?.cleanup?.code ?? 'worker_boundary_pending');
  const message = PUBLIC_STARTUP_MESSAGES[code] ?? PUBLIC_STARTUP_MESSAGES.worker_boundary_pending;
  try {
    const overlay = {
      ...task,
      status: 'transport_lost',
      error: Object.freeze({ code, message }),
    };
    delete overlay.result;
    delete overlay.handoff;
    delete overlay.stop_reason;
    delete overlay.finished_at;
    return overlay;
  } catch {
    return {
      status: 'transport_lost',
      error: Object.freeze({ code, message }),
    };
  }
}

export function projectSupervisorTerminalReceipt(task) {
  const classified = classifySupervisorTerminalReceipt(task);
  if (lifecycleBlocksFinalProjection(task)) {
    return suppressUnfinalTerminalProjection(task, classified);
  }
  if (!classified.corrected) return task;
  try {
    return {
      ...task,
      status: classified.projected_status,
      error: classified.error,
    };
  } catch {
    return {
      status: classified.projected_status,
      error: classified.error,
    };
  }
}

export function projectSupervisorTaskRecords(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map((task) => projectSupervisorTerminalReceipt(task));
}

async function verifySimpleRunRepository({ git, execute = execFile } = {}) {
  const repository = git?.repository_path;
  if (typeof repository !== 'string' || !path.isAbsolute(repository) || path.resolve(repository) !== repository) {
    return { verified: false, reason: 'repository_invalid' };
  }
  try {
    const read = (args) => execute('git', ['-C', repository, ...args], { encoding: 'utf8' });
    const [root, head, tree, base, status] = await Promise.all([
      read(['rev-parse', '--show-toplevel']),
      read(['rev-parse', '--verify', 'HEAD^{commit}']),
      read(['rev-parse', '--verify', 'HEAD^{tree}']),
      read(['rev-parse', '--verify', `${git.base_sha}^{commit}`]),
      read(['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    const rootValue = String(root?.stdout ?? '').trim();
    const headValue = String(head?.stdout ?? '').trim().toLowerCase();
    const treeValue = String(tree?.stdout ?? '').trim().toLowerCase();
    const baseValue = String(base?.stdout ?? '').trim().toLowerCase();
    const clean = String(status?.stdout ?? '').trim() === '';
    const verified = rootValue === repository
      && clean
      && headValue === String(git.head_sha ?? '').toLowerCase()
      && treeValue === String(git.tree_sha ?? '').toLowerCase()
      && baseValue === String(git.base_sha ?? '').toLowerCase();
    return {
      verified,
      ...(verified ? {} : { reason: clean ? 'repository_identity_changed' : 'repository_dirty' }),
    };
  } catch {
    return { verified: false, reason: 'repository_invalid' };
  }
}

function simpleChangedFiles(status) {
  return String(status ?? '').split(/\r?\n/u)
    .filter((line) => line.length > 2)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .slice(0, 64);
}

function simpleSilenceTimeout(role) {
  return role === 'implement' ? 600_000 : 300_000;
}

async function inspectSimpleWorkspace({ root, task_id: taskId, workspace, execute = execFile } = {}) {
  const cwd = workspace?.worktree_path;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd) return {};
  const read = (args) => execute('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  try {
    const startSha = typeof workspace.start_sha === 'string' ? workspace.start_sha : null;
    const [head, branch, status, commits] = await Promise.all([
      read(['rev-parse', 'HEAD']),
      read(['branch', '--show-current']),
      read(['status', '--porcelain=v1', '--untracked-files=all']),
      startSha ? read(['log', '--format=%H', `${startSha}..HEAD`]).catch(() => ({ stdout: '' })) : Promise.resolve({ stdout: '' }),
    ]);
    const currentHead = String(head?.stdout ?? '').trim();
    const changed = simpleChangedFiles(status?.stdout);
    const commitValues = String(commits?.stdout ?? '').split(/\r?\n/u).filter(Boolean).slice(0, 64);
    const task = typeof taskId === 'string'
      ? await readTask(root ?? stateRoot(), taskId).then((result) => result.task).catch(() => null)
      : null;
    return {
      current_head: currentHead || null,
      branch: String(branch?.stdout ?? '').trim() || (workspace.branch ?? null),
      clean: changed.length === 0,
      changed_files: changed,
      commits: commitValues,
      partial_diff: changed.length > 0 || (startSha !== null && currentHead.toLowerCase() !== startSha.toLowerCase()),
      last_acknowledged_provider_event: task?.dispatch_evidence === 'authoritative'
        ? 'prompt_dispatched'
        : (typeof task?.last_event === 'string' ? task.last_event : null),
    };
  } catch {
    return {};
  }
}

async function workspaceLockId(workspace, execute) {
  if (typeof workspace?.task !== 'string' || typeof workspace?.worktree_path !== 'string') return null;
  try {
    const result = await execute(BUNDLED_WORKTREE_BOOTSTRAP, [
      'lock', 'inspect', workspace.task, '--repo', workspace.worktree_path,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    const lock = parseJsonSuffix(result?.stdout);
    if (lock?.state !== 'active' || typeof lock.lock_id !== 'string' || lock.lock_id.length < 8) return null;
    return lock.lock_id;
  } catch {
    return null;
  }
}

async function buildSimpleWorkspaceIdentity({ run_id: runId, assignment, git, workspace, execute }) {
  try {
    const cloud = assignment.provider === 'cursor-cloud';
    const lockId = cloud ? null : await workspaceLockId(workspace, execute);
    if (!cloud && lockId === null) return null;
    return buildWorkspaceIdentityV1({
      run_id: runId,
      assignment_id: assignment.assignment_id,
      git,
      semantics: cloud ? 'remote_provider_managed' : 'local_managed_worktree',
      starting_point: cloud ? 'pinned_pushed_sha' : 'run_base_sha',
      worktree_path: cloud ? null : workspace?.worktree_path,
      branch: cloud ? null : workspace?.branch,
      lock_id: cloud ? null : lockId,
      starting_ref: cloud ? (assignment.starting_ref ?? git.base_sha) : null,
    });
  } catch {
    // Workspace identity is protected telemetry. The launch path has already
    // re-verified the worktree contract; an unavailable lock observation must
    // not fabricate an identity or replay a prompt.
    return null;
  }
}

async function waitForSimpleDispatchEvidence(root, taskId, {
  timeoutMs = SIMPLE_DISPATCH_EVIDENCE_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
} = {}) {
  const deadline = now() + Math.max(0, timeoutMs);
  let current = null;
  while (true) {
    current = (await readTask(root, taskId)).task;
    const sessionId = current.acp_session_id ?? current.provider_run_id ?? current.provider_agent_id ?? null;
    if (current.dispatch_evidence === 'authoritative') {
      return {
        dispatched: true,
        prompt_dispatched: true,
        confidence: 'authoritative',
        session_ready: true,
        session_id: typeof sessionId === 'string' ? sessionId : null,
        cursor: '0',
      };
    }
    if (['failed', 'timeout', 'cancelled', 'transport_lost'].includes(current.status)
      && current.dispatch_intent !== true && current.prompt_dispatched !== true) {
      return {
        dispatched: false,
        confidence: 'authoritative',
        error: current.error ?? { code: 'provider_start_failed' },
      };
    }
    if (['completed', 'succeeded', 'failed', 'timeout', 'cancelled', 'transport_lost'].includes(current.status)) {
      return {
        dispatched: false,
        dispatch_uncertain: true,
        terminal: true,
        confidence: 'uncertain',
        sent: current.dispatch_intent === true || current.prompt_dispatched === true,
        session_ready: Boolean(sessionId),
        session_id: typeof sessionId === 'string' ? sessionId : null,
        ...(typeof current.error?.code === 'string' ? { error: { code: current.error.code } } : {}),
      };
    }
    if (now() >= deadline) {
      const active = ['running', 'starting', 'accepted', 'needs_attention'].includes(current.status);
      return {
        dispatched: false,
        ...(active ? { dispatch_pending: true } : { terminal: true }),
        dispatch_uncertain: true,
        confidence: 'uncertain',
        sent: current.dispatch_intent === true || current.prompt_dispatched === true,
        session_ready: Boolean(sessionId),
        session_id: typeof sessionId === 'string' ? sessionId : null,
      };
    }
    await sleep(Math.min(SIMPLE_DISPATCH_EVIDENCE_POLL_MS, Math.max(1, deadline - now())));
  }
}

function childEnvelopePrompt(assignment) {
  const envelopeText = assignment?.child_envelope?.envelope_text;
  if (typeof envelopeText !== 'string' || envelopeText.length === 0) {
    fail('prompt_envelope_missing', 'The compiled child prompt envelope is missing.');
  }
  return envelopeText;
}

function stalledTaskAttention(task) {
  const sessionId = task?.acp_session_id ?? task?.provider_run_id ?? task?.provider_agent_id ?? `local-${task?.id}`;
  return {
    session_id: String(sessionId).slice(0, 128),
    question_id: `stalled-${task.id}`,
    stage: 'stalled',
    prompt: 'No meaningful provider event was observed before the configured silence threshold.',
    required: true,
  };
}

async function waitForSupervisorRunProgress(root, { task_ids, cursors, wait_ms, wait_until, signal } = {}) {
  if (!Array.isArray(task_ids) || task_ids.length === 0) {
    const delayMs = Number.isFinite(wait_ms) && wait_ms > 0 ? wait_ms : 0;
    await new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      if (signal?.aborted || delayMs === 0) {
        finish();
        return;
      }
      timer = setTimeout(finish, delayMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
    return { wait_reason: signal?.aborted ? 'disconnected' : 'timeout' };
  }
  try {
    return await waitForAnyTaskProgress(root, {
      task_ids,
      cursors,
      wait_ms,
      wait_until: wait_until === 'terminal' ? 'terminal' : 'progress',
      signal,
    });
  } catch (error) {
    return { wait_reason: 'observation_uncertain', error: { code: error?.code ?? 'task_observation_unavailable' } };
  }
}

async function inspectSupervisorLane(root, taskId) {
  // The run bridge needs the authoritative task result and lifecycle overlay.
  // Compact task projection intentionally omits legacy `completed` results.
  const result = await inspectTask(root, { task_id: taskId, view: 'summary', wait_ms: 0 });
  let task = result.task ?? result;
  const waitReason = result.progress?.wait_reason;
  if (waitReason === 'silence' && task.status !== 'needs_attention'
    && !['completed', 'succeeded', 'failed', 'timeout', 'timed_out', 'cancelled',
      'transport_lost', 'environment_blocked', 'cancelling'].includes(task.status)) {
    const attention = stalledTaskAttention(task);
    task = await updateTask(root, taskId, { status: 'needs_attention', attention });
    await appendTaskEvent(root, taskId, {
      type: 'stalled',
      session_id: attention.session_id,
      question_id: attention.question_id,
      silence_threshold: task.silence_timeout_ms ?? null,
    }).catch(() => {});
  }
  let attention = null;
  if (task.status === 'needs_attention') {
    attention = await readAttention(root, taskId).catch(() => null) ?? task.attention ?? null;
  }
  return { result, task, waitReason, attention };
}

function createSupervisorRunAdmissionRuntime(options = {}) {
  const root = options.root ?? stateRoot();
  const execute = options.execute ?? execFile;
  const env = options.env ?? process.env;
  const checkPath = options.checkPath ?? stat;
  const admissionStore = options.admissionStore ?? createRunAdmissionStore(root);
  const submitTaskFn = options.submitTask ?? submitTask;
  const waitForDispatchEvidence = options.waitForDispatchEvidence
    ?? ((stateRootValue, taskId) => waitForSimpleDispatchEvidence(stateRootValue, taskId, {
      ...(options.dispatchEvidenceTimeoutMs !== undefined
        ? { timeoutMs: options.dispatchEvidenceTimeoutMs } : {}),
      ...(options.dispatchEvidenceSleep ? { sleep: options.dispatchEvidenceSleep } : {}),
      ...(options.dispatchEvidenceNow ? { now: options.dispatchEvidenceNow } : {}),
    }));
  const simpleDeps = {
    compile: options.compile ?? compileRunRequestV1,
    ...(options.requestConsent ? { requestConsent: options.requestConsent } : {}),
    ...(options.verifyConsent ? { verifyConsent: options.verifyConsent } : {}),
    providerReady: options.providerReady ?? (async ({ assignment }) => {
      assertProviderModelDispatchable(assignment.provider, assignment.model);
      await (options.preflightRuntime ?? assertRuntimeEntrypoints)(assignment.provider);
      try {
        await workerEnvironment(assignment.provider, env, assignment.provider === 'dsh' ? assignment.model : undefined);
        return { ready: true };
      } catch (error) {
        return { ready: false, reason: error?.code ?? 'provider_not_ready' };
      }
    }),
    processBoundaryReady: options.processBoundaryReady ?? (() => localBoundaryReadiness(options.probeBoundary)),
    verifyRepository: options.verifyRepository ?? ((request) => verifySimpleRunRepository({ ...request, execute })),
    prepareWorkspace: options.prepareWorkspace ?? (async ({ assignment, git }) => {
      try {
        const repository = git.repository_path;
        if (assignment.provider === 'cursor-cloud') {
          return { prepared: true, workspace: await readerWorkspace(repository, execute) };
        }
        const baseSha = git.base_sha;
        const workspace = await createWriterWorkspace({
          taskId: assignment.task_id,
          repo: repository,
          ...(baseSha ? { baseSha } : {}),
          execute,
          checkPath,
        });
        return { prepared: true, workspace };
      } catch (error) {
        return { prepared: false, error };
      }
    }),
    cleanupWorkspace: options.cleanupWorkspace ?? (({ workspace, assignment_id: assignmentId }) => cleanupManagedWorkspace({
      workspace,
      taskId: workspace?.task ?? assignmentId,
      execute,
    })),
    // The current provider workers create/attach the persistent session as
    // part of launch. The dispatch barrier still records this reservation,
    // then replaces the placeholder with the worker's session identity once
    // authoritative prompt evidence is durable.
    createSession: options.createSession ?? (async () => ({ ready: true, session_id: null })),
    dispatchPrompt: options.dispatchPrompt ?? (async ({ run_id: runId, assignment, workspace, git }) => {
      const input = {
        task_id: assignment.task_id,
        run_id: runId,
        assignment_id: assignment.assignment_id,
        provider: assignment.provider,
        model: assignment.model,
        repo: git.repository_path,
        prompt: childEnvelopePrompt(assignment),
        role: assignment.role === 'verify' ? 'review' : assignment.role,
        access: assignment.access,
        write_scope: [...assignment.write_scope],
        capabilities: [...assignment.capabilities],
        child_envelope_digest: assignment.prompt_envelope_digest,
        expected_duration_ms: assignment.expected_duration_ms,
        silence_timeout_ms: simpleSilenceTimeout(assignment.role),
        workspace_mode: assignment.provider === 'cursor-cloud' ? 'direct' : 'managed',
      };
      assertProviderModelDispatchable(assignment.provider, assignment.model);
      if (assignment.provider === 'dsh') input.dsh_model = assignment.model;
      if (assignment.provider === 'cursor-cloud' && assignment.starting_ref) input.starting_ref = assignment.starting_ref;
      const submitted = await submitTaskFn(input, {
        root,
        env,
        execute,
        checkPath,
        preparedWorkspace: workspace,
        ...(assignment.provider !== 'cursor-cloud' ? { baseSha: git.base_sha } : {}),
      });
      const evidence = await waitForDispatchEvidence(root, submitted.task.id);
      const workspaceIdentity = await buildSimpleWorkspaceIdentity({
        run_id: runId,
        assignment,
        git: buildGitIdentityV1({
          repository_path: git.repository_path,
          base_sha: git.base_sha,
        }),
        workspace,
        execute,
      });
      return {
        ...evidence,
        ...(workspaceIdentity ? { workspace_identity: workspaceIdentity } : {}),
      };
    }),
    replyAttention: options.replyAttention ?? (async ({ task_id: taskId, attention, reply, capability_satisfied: capabilitySatisfied }) => {
      const items = Array.isArray(attention?.items)
        ? attention.items
        : (attention ? [attention] : []);
      const answers = Array.isArray(reply?.answers)
        ? reply.answers
        : (Array.isArray(reply?.reply?.answers)
          ? reply.reply.answers
          : (reply?.question_id ? [reply] : []));
      let delivered = 0;
      const deliveredQuestions = new Set();
      for (const item of items) {
        const targets = Array.isArray(item?.targets) && item.targets.length > 0
          ? item.targets
          : [item];
        const canonicalAnswer = answers.find((candidate) => (
          (candidate?.task_id === item?.task_id && candidate?.question_id === item?.question_id)
          || (candidate?.assignment_id === item?.assignment_id && candidate?.question_id === item?.question_id)
        ));
        for (const target of targets) {
          const answer = answers.find((candidate) => (
            (candidate?.task_id === target?.task_id && candidate?.question_id === target?.question_id)
            || (candidate?.assignment_id === target?.assignment_id && candidate?.question_id === target?.question_id)
          )) ?? canonicalAnswer;
          if (!answer || typeof target?.task_id !== 'string') continue;
          const sessionId = answer.session_id ?? target.session_id ?? item.session_id;
          const questionId = answer.question_id ?? target.question_id ?? item.question_id;
          const response = answer.response
            ?? (capabilitySatisfied === true ? {
              outcome: 'allow_once',
              capability: item.capability,
              resource: item.resource,
              action: item.action,
            } : undefined);
          if (typeof sessionId !== 'string' || typeof questionId !== 'string' || response === undefined) continue;
          const key = `${target.task_id}\u0000${questionId}`;
          if (deliveredQuestions.has(key)) continue;
          deliveredQuestions.add(key);
          try {
            await submitReply(root, target.task_id, {
              session_id: sessionId,
              question_id: questionId,
              response,
            });
            delivered += 1;
          } catch (error) {
            if (error?.code === 'reply_already_recorded') delivered += 1;
          }
        }
      }
      const expected = items.reduce((count, item) => count + (
        Array.isArray(item?.targets) && item.targets.length > 0 ? item.targets.length : 1
      ), 0);
      return { delivered: expected > 0 && delivered === expected };
    }),
    waitForProgress: options.waitForProgress ?? ((request) => waitForSupervisorRunProgress(root, request)),
    inspectLane: options.inspectLane ?? (async ({ task_id: taskId }) => {
      const inspected = await inspectSupervisorLane(root, taskId);
      const { result, task } = inspected;
      const status = task?.status;
      if (typeof status !== 'string') {
        throw Object.assign(new Error('Supervisor task observation is malformed.'), { code: 'task_observation_invalid' });
      }
      const cursor = typeof result?.progress?.event_cursor === 'string'
        ? result.progress.event_cursor : '0';
      const observedTaskId = task.id ?? task.task_id;
      if (observedTaskId !== undefined && observedTaskId !== taskId) {
        throw Object.assign(new Error('Supervisor task observation identity did not match the requested task.'), {
          code: 'task_observation_identity_mismatch',
        });
      }
      const observed = {
        task_id: observedTaskId ?? taskId,
        cursor,
        ...(task.dispatch_evidence === 'authoritative'
          ? { dispatch_evidence: 'authoritative' } : {}),
        ...(task.prompt_dispatched === true ? { prompt_dispatched: true } : {}),
        ...(task.dispatch_uncertain === true ? { dispatch_uncertain: true } : {}),
        ...((task.acp_session_id ?? task.provider_run_id ?? task.provider_agent_id) !== undefined
          ? { session_id: task.acp_session_id ?? task.provider_run_id ?? task.provider_agent_id } : {}),
        ...(typeof task.last_event === 'string' ? { last_event: task.last_event } : {}),
        ...(task.result !== undefined && task.result !== null
          ? { result: task.result } : {}),
      };
      if (status === 'completed' || status === 'succeeded') return { ...observed, status: 'completed' };
      if (status === 'needs_attention') return { ...observed, status: 'needs_attention', attention: inspected.attention };
      if (status === 'cancelled') return { ...observed, status: 'cancelled' };
      if (status === 'timeout' || status === 'timed_out') return { ...observed, status: 'timeout' };
      if (status === 'transport_lost') return { ...observed, status: 'transport_lost' };
      if (status === 'environment_blocked') return { ...observed, status: 'environment_blocked' };
      if (status === 'failed') return { ...observed, status: 'failed', error: { code: task.error?.code } };
      if (status === 'running' || status === 'starting' || status === 'accepted' || status === 'cancelling') return { ...observed, status: 'running' };
      throw Object.assign(new Error('Supervisor task observation has an unknown status.'), { code: 'task_observation_invalid' });
    }),
    reconnectLane: options.reconnectLane ?? (async ({ task_id: taskId }) => {
      const { task } = await readTask(root, taskId);
      if (task.provider === 'grok' || task.provider === 'cursor-local') {
        return reconnectAcpTask({ root, taskId });
      }
      if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
        try {
          const current = await reconcileCursorCloudTask({ root, taskId });
          return {
            reconnected: !['failed', 'timeout', 'cancelled', 'transport_lost'].includes(current?.status),
            session_id: task.provider_agent_id,
          };
        } catch {
          return { reconnected: false, reason: 'provider_run_reconnect_failed' };
        }
      }
      return { reconnected: false, reason: 'provider_transport_no_resume' };
    }),
    cancelLane: options.cancelLane ?? (async ({ task_id: taskId }) => {
      const task = await cancelTask(root, taskId);
      return {
        confirmed: task?.status === 'cancelled',
        cancelled: task?.status === 'cancelled',
        task_id: task?.id ?? taskId,
        status: task?.status ?? null,
      };
    }),
    inspectWorkspace: options.inspectWorkspace ?? ((request) => inspectSimpleWorkspace({ ...request, execute })),
    buildHandoff: options.buildHandoff ?? (async ({ fallback }) => fallback),
    verifyRun: options.verifyRun ?? (async ({ lanes }) => ({
      verified: Array.isArray(lanes) && lanes.length > 0
        && lanes.every((lane) => lane.phase === 'completed' || lane.phase === 'cancelled')
        && lanes.filter((lane) => lane.required !== false).every((lane) => lane.phase === 'completed'),
    })),
    loadRecord: options.loadRecord ?? admissionStore.load,
    persistRecord: options.persistRecord ?? admissionStore.save,
  };
  const runtime = createRunAdmissionRuntime(simpleDeps);
  const loadRecord = simpleDeps.loadRecord;
  const inspectWorkspace = simpleDeps.inspectWorkspace;
  async function reviseRun(request, reviseOptions = {}) {
    const runId = request?.run_id;
    const revision = parseOwnedRevisionRequestV1(request?.revision, 'revision');
    let record = await loadRecord(runId);
    if (!record) {
      throw new RunContractV1Error(
        'revision_producer_not_found',
        'run_id',
        'The named producer assignment is not known.',
      );
    }
    await runtime.inspectRun({ run_id: runId });
    record = await loadRecord(runId);
    const assignment = record.compiled?.assignments?.find((entry) => entry.assignment_id === revision.assignment_id);
    const lane = record.lanes?.find((entry) => entry.assignment_id === revision.assignment_id);
    if (!assignment || !lane) {
      throw new RunContractV1Error(
        'revision_producer_not_found',
        'revision.assignment_id',
        'The named producer assignment is not known.',
      );
    }
    let workspace;
    try {
      workspace = await inspectWorkspace({
        root,
        run_id: runId,
        assignment_id: revision.assignment_id,
        task_id: lane.task_id,
        workspace: lane.workspace,
      });
    } catch {
      workspace = null;
    }
    const producer = projectOwnedProducerCandidateV1({ record, assignment, lane, workspace });
    assertOwnedRevisionProducerV1(producer, revision);
    if (typeof lane.task_id !== 'string' || lane.task_id.length === 0) {
      throw new RunContractV1Error(
        'revision_lifecycle_unfinal',
        'revision',
        'A revision requires proven terminal lifecycle; a missing task is not a completed producer.',
      );
    }
    let task;
    try {
      ({ task } = await readTask(root, lane.task_id));
    } catch {
      throw new RunContractV1Error(
        'revision_lifecycle_unfinal',
        'revision',
        'A revision requires proven terminal lifecycle; a missing task is not a completed producer.',
      );
    }
    if (!task || typeof task !== 'object' || Array.isArray(task)
      || task.id !== lane.task_id
      || task.run_id !== record.run_id
      || task.assignment_id !== assignment.assignment_id) {
      throw new RunContractV1Error(
        'revision_lifecycle_unfinal',
        'revision',
        'A revision requires proven terminal lifecycle; unresolved cleanup is not a completed producer.',
      );
    }
    const classified = classifySupervisorTerminalReceipt(task);
    if (classified.projected_status !== 'completed' && classified.projected_status !== 'succeeded') {
      throw new RunContractV1Error(
        'revision_lifecycle_unfinal',
        'revision',
        'A revision requires proven terminal lifecycle; unresolved cleanup is not a completed producer.',
      );
    }
    const derived = deriveOwnedRevisionRequestV1(producer, revision);
    if (typeof runtime.submitOwnedRevision === 'function') {
      return runtime.submitOwnedRevision(record.run_id, derived, reviseOptions);
    }
    return runtime.submitRunRequest(derived.run_request, {
      ...reviseOptions,
      correction: derived.correction,
    });
  }
  return Object.freeze({
    ...runtime,
    reviseRun,
  });
}

const AUTHENTICATION_FAILURE_PATTERN = /not signed in|not authenticated|log ?in required|unauthori[sz]ed/iu;
const GROK_EXPLICIT_LOGGED_IN_PATTERN = /(?:^|\r?\n)\s*you are logged in(?:\s+with [^\r\n]+)?\.?\s*(?=\r?\n|$)/iu;
const GROK_EXPLICIT_LOGGED_OUT_PATTERN = /(?:^|\r?\n)\s*(?:you are\s+)?(?:not logged in|not signed in|not authenticated|log ?in required|login required|authentication required)\b/iu;

export function classifyGrokReadinessOutput(stdout = '', stderr = '') {
  const standardOutput = String(stdout);
  const standardError = String(stderr);
  const output = `${standardOutput}\n${standardError}`;
  if (GROK_EXPLICIT_LOGGED_OUT_PATTERN.test(output)
    || AUTHENTICATION_FAILURE_PATTERN.test(standardOutput)) {
    return { ready: false, reason: 'needs_login' };
  }
  if (GROK_EXPLICIT_LOGGED_IN_PATTERN.test(standardOutput)) return { ready: true };
  if (AUTHENTICATION_FAILURE_PATTERN.test(standardError)) {
    return { ready: false, reason: 'needs_login' };
  }
  return { ready: true };
}

function classifyReadinessProbeFailure(error) {
  return {
    installed: error?.code !== 'ENOENT',
    ready: false,
    reason: error?.code === 'ENOENT' ? 'not_installed' : 'probe_failed',
  };
}

async function probeCommand(command, args, authenticatedPattern, env, timeoutMs = PROVIDER_READINESS_PROBE_TIMEOUT_MS, outputClassifier = null, execute = execFile) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execute(command, args, {
      cwd: '/tmp', encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024,
      env,
    });
    if (outputClassifier) {
      return {
        installed: true,
        ...outputClassifier(stdout, stderr),
        probe_duration_ms: Date.now() - started,
      };
    }
    const output = `${stdout}${stderr}`;
    if (AUTHENTICATION_FAILURE_PATTERN.test(output)) {
      return { installed: true, ready: false, reason: 'needs_login', probe_duration_ms: Date.now() - started };
    }
    return { installed: true, ready: authenticatedPattern ? authenticatedPattern.test(output) : true, probe_duration_ms: Date.now() - started };
  } catch (error) {
    return { ...classifyReadinessProbeFailure(error), probe_duration_ms: Date.now() - started };
  }
}

export async function probeGrokReadiness(command, env, options = {}) {
  return probeCommand(
    command,
    ['models'],
    undefined,
    env,
    options.timeoutMs ?? PROVIDER_READINESS_PROBE_TIMEOUT_MS,
    classifyGrokReadinessOutput,
    options.execute ?? execFile,
  );
}

async function providerReadiness(env = process.env) {
  const grokEnv = projectProviderEnvironment({ provider: 'grok', source: env, operation: 'readiness' });
  const cursorLocalEnv = projectProviderEnvironment({ provider: 'cursor-local', source: env, operation: 'readiness' });
  const dshProbeEnv = projectProviderEnvironment({ provider: 'dsh', source: env, dshModel: DEFAULT_DSH_MODEL, operation: 'readiness_probe' });
  const grokCommand = grokEnv.CODEX_CO_ENGINEER_GROK_COMMAND ?? 'grok';
  const cursorCommand = cursorLocalEnv.CODEX_CO_ENGINEER_CURSOR_COMMAND ?? 'cursor-agent';
  const dshCommand = dshProbeEnv.CODEX_CO_ENGINEER_DSH_COMMAND ?? 'dsh';
  const acpxCommand = dshProbeEnv.CODEX_CO_ENGINEER_ACPX_COMMAND ?? 'acpx';
  const dshAcpCommand = dshProbeEnv.CODEX_CO_ENGINEER_DSH_ACP_COMMAND ?? 'dsh-acp-demo';
  const [grok, cursorLocal, dshCli, acpx, dshAcp, dshMuseCredential, dshOxCredential, cursorCloud] = await Promise.all([
    probeGrokReadiness(grokCommand, grokEnv),
    probeCommand(cursorCommand, ['status'], /logged in|authenticated|access token/iu, cursorLocalEnv),
    probeCommand(dshCommand, ['--version'], undefined, dshProbeEnv),
    probeCommand(acpxCommand, ['--version'], undefined, dshProbeEnv),
    probeCommand('which', [dshAcpCommand], undefined, dshProbeEnv),
    workerEnvironment('dsh', env, DEFAULT_DSH_MODEL).then(() => ({ ready: true })).catch((error) => ({ ready: false, reason: error?.code ?? 'credentials_missing' })),
    workerEnvironment('dsh', env, 'stealth/ox-alpha').then(() => ({ ready: true })).catch((error) => ({ ready: false, reason: error?.code ?? 'credentials_missing' })),
    Promise.all([loadCursorApiKey(env), loadCursorSdk()])
      .then(() => ({ installed: true, ready: true }))
      .catch((error) => ({ installed: error?.code !== 'cursor_sdk_missing', ready: false, reason: error?.code ?? 'not_configured' })),
  ]);
  return {
    grok: { ...grok, transport: 'acp' },
    'cursor-local': { ...cursorLocal, transport: 'acp' },
    dsh: {
      installed: dshCli.installed && acpx.installed && dshAcp.installed,
      ready: dshCli.ready && acpx.ready && dshAcp.ready && dshMuseCredential.ready,
      transport: 'acpx',
      default_model: DEFAULT_DSH_MODEL,
      model_options: {
        [DEFAULT_DSH_MODEL]: dshMuseCredential,
        'stealth/ox-alpha': dshOxCredential,
      },
      ...(!dshMuseCredential.ready ? { reason: dshMuseCredential.reason } : {}),
    },
    'cursor-cloud': { ...cursorCloud, transport: 'cursor-sdk' },
  };
}

let providerReadinessCache = null;
let providerReadinessCacheExpiresAt = 0;
let providerReadinessInFlight = null;
let providerReadinessCacheRoot = null;

function cloneReadiness(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

async function cachedProviderReadiness(env = process.env, { refresh = false, root = null } = {}) {
  const now = Date.now();
  if (providerReadinessCacheRoot !== root) {
    providerReadinessCache = null;
    providerReadinessCacheExpiresAt = 0;
    providerReadinessInFlight = null;
    providerReadinessCacheRoot = root;
  }
  if (!refresh && providerReadinessCache !== null && providerReadinessCacheExpiresAt > now) {
    return cloneReadiness(providerReadinessCache);
  }
  if (!refresh && root) {
    const snapshot = await loadReadinessSnapshot(root);
    const observedAt = Date.parse(snapshot?.observed_at ?? '');
    if (snapshot && Number.isFinite(observedAt) && observedAt + PROVIDER_READINESS_TTL_MS > now) {
      providerReadinessCache = cloneReadiness(snapshot.readiness);
      providerReadinessCacheExpiresAt = observedAt + PROVIDER_READINESS_TTL_MS;
      return cloneReadiness(providerReadinessCache);
    }
  }
  if (providerReadinessInFlight !== null) {
    return cloneReadiness(await providerReadinessInFlight);
  }
  const started = Date.now();
  const pending = providerReadiness(env);
  providerReadinessInFlight = pending;
  try {
    const value = await pending;
    providerReadinessCache = cloneReadiness(value);
    providerReadinessCacheExpiresAt = Date.now() + PROVIDER_READINESS_TTL_MS;
    if (root) {
      await saveReadinessSnapshot(root, value, {
        observed_at: new Date().toISOString(),
        probe_duration_ms: Date.now() - started,
      }).catch(() => {});
    }
    return cloneReadiness(value);
  } finally {
    if (providerReadinessInFlight === pending) providerReadinessInFlight = null;
  }
}

export async function cancelTask(root, taskId, dependencies = {}) {
  const { task } = await readTask(root, taskId);
  if (!ACTIVE.has(task.status)) {
    const runtime = taskRuntime(await readRuntimeRecord(root, taskId), task);
    if (runtime?.process_boundary) {
      await settleLocalTaskLifecycle(root, task, runtime, dependencies);
      return projectSupervisorTerminalReceipt((await readTask(root, taskId)).task);
    }
    return projectSupervisorTerminalReceipt(task);
  }
  if (task.provider === 'cursor-cloud' && task.provider_agent_id) {
    const runtime = await readRuntimeRecord(root, taskId);
    await updateTask(root, taskId, { status: 'cancelling' });
    await clearTaskLaunchReservation(root, taskId, task.launch_reservation?.token).catch(() => {});
    const terminal = await (dependencies.cancelCloud ?? cancelCursorCloudTask)({
      root,
      taskId,
      sdk: dependencies.sdk,
      apiKey: dependencies.apiKey,
    });
    const identity = currentProcessIdentity(runtime);
    if (identity) {
      try { process.kill(-identity.process_group, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    return projectSupervisorTerminalReceipt(terminal);
  }
  const runtime = taskRuntime(await readRuntimeRecord(root, taskId), task);
  const identity = currentProcessIdentity(runtime);
  const providerIdentity = currentProviderIdentity(task);
  await updateTask(root, taskId, { status: 'cancelling' });
  await clearTaskLaunchReservation(root, taskId, task.launch_reservation?.token).catch(() => {});
  if (runtime?.process_boundary) {
    try {
      await (dependencies.stopBoundary ?? ((bound) => stopRuntimeBoundary(bound, dependencies)))(runtime);
    } catch (error) {
      await recordManagedCleanup(root, task, dependencies.execute, {
        requireInactiveEmpty: true,
        boundaryState: 'unknown',
      });
      return projectSupervisorTerminalReceipt(await updateTask(root, taskId, {
        status: 'transport_lost',
        error: { code: error?.code ?? 'cancel_incomplete', message: 'The owned local task cgroup could not be proven empty.' },
      }));
    }
    const inspection = await inspectRuntimeBoundary(runtime, dependencies);
    if (!boundaryIsInactiveEmpty(inspection)) {
      await recordManagedCleanup(root, task, dependencies.execute, {
        requireInactiveEmpty: true,
        boundaryState: inspection?.state === 'active' ? 'active' : 'unknown',
      });
      return projectSupervisorTerminalReceipt(await updateTask(root, taskId, {
        status: 'transport_lost',
        error: {
          code: inspection?.code ?? 'cancel_incomplete',
          message: 'The owned local task cgroup could not be proven empty.',
        },
      }));
    }
    await recordManagedCleanup(root, task, dependencies.execute, {
      requireInactiveEmpty: true,
      boundaryState: 'inactive_empty',
    });
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', boundary: runtime.process_boundary.boundary });
    return projectSupervisorTerminalReceipt(await updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() }));
  }
  if (!identity && !providerIdentity) {
    await recordManagedCleanup(root, task, dependencies.execute);
    await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled', reason: 'worker_not_running' });
    return projectSupervisorTerminalReceipt(await updateTask(root, taskId, {
      status: 'cancelled',
      error: { code: 'worker_not_running', message: 'Recorded worker was not running; no owned process remained to signal.' },
      finished_at: new Date().toISOString(),
    }));
  }
  for (const owned of [providerIdentity, identity].filter(Boolean)) {
    try { process.kill(-owned.process_group, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  for (let index = 0; index < 20 && identity && processGroupAlive(identity.process_group); index += 1) await wait(100);
  for (let index = 0; index < 20 && providerIdentity && processGroupAlive(providerIdentity.process_group); index += 1) await wait(100);
  if (identity && processGroupAlive(identity.process_group)) {
    try { process.kill(-identity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    for (let index = 0; index < 20 && processGroupAlive(identity.process_group); index += 1) await wait(100);
  }
  if (providerIdentity && processGroupAlive(providerIdentity.process_group)) {
    try { process.kill(-providerIdentity.process_group, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    for (let index = 0; index < 20 && processGroupAlive(providerIdentity.process_group); index += 1) await wait(100);
  }
  if ((identity && processGroupAlive(identity.process_group)) || (providerIdentity && processGroupAlive(providerIdentity.process_group))) {
    await recordManagedCleanup(root, task, dependencies.execute);
    return projectSupervisorTerminalReceipt(await updateTask(root, taskId, {
      status: 'transport_lost',
      error: { code: 'cancel_incomplete', message: 'Owned process group remained after SIGKILL.' },
    }));
  }
  await recordManagedCleanup(root, task, dependencies.execute);
  await appendTaskEvent(root, taskId, { type: 'terminal', status: 'cancelled' });
  return projectSupervisorTerminalReceipt(await updateTask(root, taskId, { status: 'cancelled', finished_at: new Date().toISOString() }));
}

export async function taskStatus(root, taskId, options = {}) {
  const dependencies = options.dependencies ?? options;
  const { task: initialTask } = await readTask(root, taskId);
  const runtime = taskRuntime(await readRuntimeRecord(root, taskId), initialTask);
  await reconcileInactiveTask(root, initialTask, runtime, dependencies);
  const view = resolveTaskView(options.view);
  const waited = await waitForTaskProgress(root, taskId, {
    cursor: options.cursor,
    wait_ms: view === 'diagnostics' ? 0 : options.wait_ms,
    wait_until: options.wait_until,
    wake_on_needs_attention: options.wake_on_needs_attention,
    signal: options.signal,
  });
  const latestRuntime = taskRuntime(await readRuntimeRecord(root, taskId), waited.task);
  const task = projectSupervisorTerminalReceipt(await projectLiveLastEvent(
    root,
    await reconcileInactiveTask(root, waited.task, latestRuntime, dependencies),
  ));
  const progress = {
    ...waited.progress,
    last_event: task.last_event ?? waited.progress.last_event,
  };
  const extras = {
    wait_reason: progress.wait_reason,
    last_event: progress.last_event,
    event_cursor: progress.event_cursor,
  };
  if (view === COMPACT_VIEW) {
    return projectCompactTask({
      task,
      progress,
      runtime: latestRuntime,
      extras,
    });
  }
  const result = {
    task,
    runtime: latestRuntime,
    progress,
    state: publicState(task.status),
    summary: compactSummary(task, progress, latestRuntime, extras),
    diagnostic: diagnosticEnvelope(task, latestRuntime, extras),
    capabilities: providerCapabilities(task.provider),
    view,
  };
  if (view === 'diagnostics') {
    result.diagnostics = await readTaskDiagnostics(root, taskId, {
      cursor: options.cursor,
      max_bytes: options.max_bytes,
      runtime: latestRuntime,
      progress,
    });
  }
  return result;
}

export async function inspectTask(root, args = {}, options = {}) {
  if (args.extend_expected_duration_ms != null || args.extend_reason) {
    await extendTaskDeadline(root, args.task_id, {
      expected_duration_ms: args.extend_expected_duration_ms,
      reason: args.extend_reason,
    });
  }
  if (args.reply) {
    await submitReply(root, args.task_id, args.reply);
  }
  return taskStatus(root, args.task_id, { ...args, ...options });
}

export async function supervisorStatus(root = stateRoot(), dependencies = {}, options = {}) {
  // Allow calling as supervisorStatus(root, opts) for backward compat in tests.
  const hasDepsShape = dependencies && typeof dependencies === 'object' && ('probeBoundary' in dependencies || 'readProviderReadiness' in dependencies);
  const looksLikeOpts = dependencies && typeof dependencies === 'object' && ('detail' in dependencies || 'task_limit' in dependencies || 'include_tasks' in dependencies || 'taskLimit' in dependencies || 'includeTasks' in dependencies || 'refresh' in dependencies);
  if (!hasDepsShape && looksLikeOpts) {
    options = dependencies;
    dependencies = {};
  }
  const hasOptions = options && typeof options === 'object' && (options.detail !== undefined || options.task_limit !== undefined || options.taskLimit !== undefined || options.include_tasks !== undefined || options.includeTasks !== undefined || options.refresh !== undefined);
  const readReadiness = dependencies.readProviderReadiness
    ? () => dependencies.readProviderReadiness()
    : () => cachedProviderReadiness(process.env, {
      refresh: options.refresh === true,
      root,
    });
  // Legacy no-arg path: must preserve exact 3.2 shape and reconcile ALL tasks before slicing (active/task values are durable truth).
  if (!hasOptions) {
    const tasksAll = await listTasks(root);
    for (let index = 0; index < tasksAll.length; index += 1) {
      const task = tasksAll[index];
      const runtime = taskRuntime(await readRuntimeRecord(root, task.id), task);
      if (!ACTIVE.has(task.status) && !(STORED_TERMINAL.includes(task.status) && runtime?.process_boundary)) continue;
      tasksAll[index] = await reconcileInactiveTask(root, task, runtime, dependencies);
    }
    const boundary = await localBoundaryReadiness(dependencies.probeBoundary);
    const readiness = await readReadiness();
    for (const provider of ['grok', 'cursor-local', 'dsh']) {
      if (!boundary.ready) readiness[provider] = {
        ...readiness[provider],
        ready: false,
        reason: boundary.reason ?? 'local_boundary_unavailable',
      };
    }
    return {
      version: VERSION,
      healthy: boundary.ready,
      active: tasksAll.filter((task) => ACTIVE.has(task.status)).length,
      providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
      capabilities: {
        grok: providerCapabilities('grok'),
        'cursor-local': providerCapabilities('cursor-local'),
        dsh: providerCapabilities('dsh'),
        'cursor-cloud': providerCapabilities('cursor-cloud'),
      },
      mcp_pending_call: mcpPendingCallReport(),
      local_boundary: boundary,
      readiness,
      tasks: projectSupervisorTaskRecords(await Promise.all(tasksAll.slice(0, 20).map((task) => projectLiveLastEvent(root, task)))),
    };
  }
  const detail = options.detail ?? 'full';
  if (detail !== 'full' && detail !== 'compact') {
    throw Object.assign(new Error('detail must be full or compact.'), { code: 'invalid_detail' });
  }
  const includeTasksRaw = options.include_tasks !== undefined ? options.include_tasks : options.includeTasks;
  const includeTasks = parseStatusIncludeTasks(includeTasksRaw);
  const taskLimitRaw = options.task_limit !== undefined ? options.task_limit : options.taskLimit;
  let taskLimit;
  if (includeTasks) {
    taskLimit = taskLimitRaw !== undefined ? parseStatusTaskLimit(taskLimitRaw) : 20;
  } else {
    // Deterministic semantics: when include_tasks is false, task_limit is validated if provided but ignored (forced to 0).
    // Documented in tool description: "Ignored when include_tasks is false." Validation ensures caller typos are surfaced.
    if (taskLimitRaw !== undefined) parseStatusTaskLimit(taskLimitRaw);
    taskLimit = 0;
  }
  // Preserve reconciliation semantics: reconcile ALL tasks before slicing. Slice is presentation-only.
  // This ensures legacy active/reconciled values are not skewed by the limit window.
  const allTasks = await listTasks(root);
  const totalTasks = allTasks.length;
  for (let index = 0; index < allTasks.length; index += 1) {
    const task = allTasks[index];
    const runtime = taskRuntime(await readRuntimeRecord(root, task.id), task);
    if (!ACTIVE.has(task.status) && !(STORED_TERMINAL.includes(task.status) && runtime?.process_boundary)) continue;
    allTasks[index] = await reconcileInactiveTask(root, task, runtime, dependencies);
  }
  const boundary = await localBoundaryReadiness(dependencies.probeBoundary);
  const readiness = await readReadiness();
  for (const provider of ['grok', 'cursor-local', 'dsh']) {
    if (!boundary.ready) readiness[provider] = {
      ...readiness[provider],
      ready: false,
      reason: boundary.reason ?? 'local_boundary_unavailable',
    };
  }
  const totalActive = allTasks.filter((task) => ACTIVE.has(task.status)).length;
  let windowTasks = [];
  if (includeTasks && taskLimit > 0) {
    windowTasks = allTasks.slice(0, taskLimit);
    // Compact/readiness paths avoid constructing/projecting omitted full public receipts.
    // Full detail projects live last_event (event-log I/O); compact skips that overlay.
    if (detail === 'full') {
      windowTasks = await Promise.all(windowTasks.map((task) => projectLiveLastEvent(root, task)));
    }
    windowTasks = projectSupervisorTaskRecords(windowTasks);
  }
  const result = {
    version: VERSION,
    healthy: boundary.ready,
    active: totalActive,
    providers: ['grok', 'cursor-local', 'dsh', 'cursor-cloud'],
    capabilities: {
      grok: providerCapabilities('grok'),
      'cursor-local': providerCapabilities('cursor-local'),
      dsh: providerCapabilities('dsh'),
      'cursor-cloud': providerCapabilities('cursor-cloud'),
    },
    mcp_pending_call: mcpPendingCallReport(),
    local_boundary: boundary,
    readiness,
    detail,
    task_count: totalTasks,
    returned_tasks: windowTasks.length,
    task_limit: taskLimit,
    include_tasks: includeTasks,
    total: totalTasks,
    limit: taskLimit,
    tasks: detail === 'compact' ? windowTasks.map((t) => compactTaskCard(t)) : windowTasks,
  };
  return detail === 'compact' ? projectCompactStatus(result) : result;
}

const runToolAdapters = new Map();

function liveTaskFns(root, contextByRun) {
  return {
    delegateTask: async (plan) => {
      const ctx = contextByRun.get(plan.run_id) ?? {};
      const prompt = ctx.prompts?.[plan.assignment_id] ?? ctx.objective;
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        fail('invalid_prompt', 'prompt must be non-empty text.');
      }
      const role = plan.role === 'verify' ? 'review' : plan.role;
      const input = {
        task_id: plan.task_id,
        provider: plan.provider,
        model: plan.model,
        run_id: plan.run_id,
        assignment_id: plan.assignment_id,
        repo: ctx.repository_path,
        prompt,
        role,
        expected_duration_ms: Number.isInteger(ctx.durations?.[plan.assignment_id])
          ? ctx.durations[plan.assignment_id]
          : 60_000,
        workspace_mode: 'managed',
      };
      if (plan.provider === 'dsh'
        && (plan.model === 'stealth/ox-alpha' || plan.model === DEFAULT_DSH_MODEL)) {
        input.dsh_model = plan.model;
      }
      if (plan.provider === 'cursor-cloud' && typeof plan.starting_ref === 'string') {
        input.starting_ref = plan.starting_ref;
      }
      const result = await submitTask(input, { root, ...(ctx.base_sha ? { baseSha: ctx.base_sha } : {}) });
      return {
        task_id: result.task.id,
        status: result.task.status,
        cursor: '0',
      };
    },
    inspectTask: async (plan) => {
      const result = await inspectTask(root, {
        task_id: plan.task_id,
        ...(typeof plan.cursor === 'string' ? { cursor: plan.cursor } : {}),
      });
      const projected = projectSupervisorTerminalReceipt(result.task);
      return {
        task_id: projected.id,
        status: projected.status,
        cursor: result.progress?.event_cursor ?? plan.cursor ?? '0',
        attention: projected.status === 'needs_attention' ? (projected.attention ?? null) : null,
      };
    },
    cancelTask: async (plan) => {
      const task = await cancelTask(root, plan.task_id);
      const projected = projectSupervisorTerminalReceipt(task);
      return {
        task_id: projected.id,
        status: projected.status,
        cancelled: projected.status === 'cancelled',
      };
    },
  };
}

export async function createSupervisorRunToolAdapter(options = {}) {
  if (options.adapter) return options.adapter;
  const contextByRun = options.contextByRun ?? new Map();
  const root = options.root;
  const fns = liveTaskFns(root, contextByRun);
  const taskFns = {
    delegateTask: options.delegateTask ?? fns.delegateTask,
    inspectTask: options.inspectTask ?? fns.inspectTask,
    cancelTask: options.cancelTaskFn ?? fns.cancelTask,
    settleLocalTaskLifecycle: options.settleLocalTaskLifecycle ?? settleLocalTaskLifecycle,
    cleanupLocalTaskLifecycle: options.cleanupLocalTaskLifecycle ?? cleanupLocalTaskLifecycle,
    clock: options.clock ?? (() => new Date().toISOString()),
  };
  const deliverSameSessionReply = options.deliverSameSessionReply
    ?? ((identity) => deliverSupervisorSameSessionReplyV1(root, identity));
  const cancelSameSessionReply = options.cancelSameSessionReply
    ?? ((identity) => cancelSupervisorSameSessionReplyV1(taskFns.cancelTask, identity));
  const seamOptions = {
    ...taskFns,
    deliverSameSessionReply,
    cancelSameSessionReply,
  };
  const seams = options.seams ?? (
    options.inProcess === true
      ? createInProcessRunSeams(seamOptions)
      : await createDurableRunSeams({ root, ...seamOptions })
  );
  const attention = seams.attention && typeof seams.attention.reply === 'function'
    ? {
      get: (...args) => seams.attention.get(...args),
      ...(typeof seams.attention.latch === 'function'
        ? { latch: (...args) => seams.attention.latch(...args) }
        : {}),
      reply: async (request) => seams.attention.reply({
        run_id: request.run_id,
        batch_id: request.batch_id,
        expected_revision: request.expected_revision,
        reply: request.reply,
        ...(request.now !== undefined ? { now: request.now } : {}),
        deliver: request.deliver ?? deliverSameSessionReply,
        cancel: request.cancel ?? cancelSameSessionReply,
      }),
    }
    : seams.attention;
  const simpleRuntime = options.simpleRuntime
    ?? createSupervisorRunAdmissionRuntime({
      root,
      env: options.env,
      execute: options.execute,
      checkPath: options.checkPath,
      probeBoundary: options.probeBoundary,
      requestConsent: options.requestConsent,
      verifyConsent: options.verifyConsent,
      providerReady: options.providerReady,
      processBoundaryReady: options.processBoundaryReady,
      preflightRuntime: options.preflightRuntime,
      verifyRepository: options.verifyRepository,
      prepareWorkspace: options.prepareWorkspace,
      cleanupWorkspace: options.cleanupWorkspace,
      createSession: options.createSession,
      dispatchPrompt: options.dispatchPrompt,
      replyAttention: options.replyAttention,
      inspectLane: options.inspectLane,
      reconnectLane: options.reconnectLane,
      cancelLane: options.cancelLane,
      inspectWorkspace: options.inspectWorkspace,
      buildHandoff: options.buildHandoff,
      verifyRun: options.verifyRun,
      submitTask: options.submitTask,
      waitForDispatchEvidence: options.waitForDispatchEvidence,
      dispatchEvidenceTimeoutMs: options.dispatchEvidenceTimeoutMs,
      dispatchEvidenceSleep: options.dispatchEvidenceSleep,
      dispatchEvidenceNow: options.dispatchEvidenceNow,
      compile: options.compile,
      admissionStore: options.admissionStore,
      loadRecord: options.loadRecord,
      persistRecord: options.persistRecord,
      waitForProgress: options.waitForProgress,
    });
  return createRunToolAdapter({
    runtime: seams.runtime,
    simpleRuntime,
    attention,
    projectLaneTask: projectSupervisorTerminalReceipt,
    classifyLaneTask: classifySupervisorTerminalReceipt,
    rememberSubmitContext: (context) => {
      contextByRun.set(context.run_id, context);
    },
  });
}

export async function supervisorRunToolAdapter(root, options = {}) {
  if (options.adapter) return options.adapter;
  const key = typeof root === 'string' ? root : '';
  let adapter = runToolAdapters.get(key);
  if (!adapter) {
    adapter = await createSupervisorRunToolAdapter({ root, ...options });
    runToolAdapters.set(key, adapter);
  }
  return adapter;
}

export async function invokeRunTool(root, name, args, options = {}) {
  const classified = classifyRunToolCall(name, args);
  if (classified.mode === 'legacy') return classified;
  const adapter = await supervisorRunToolAdapter(root, options);
  return adapter.dispatch(name, args, { signal: options.signal });
}

export { classifyRunToolCall };
