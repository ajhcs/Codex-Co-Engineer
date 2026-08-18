import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildGrokOuterSandboxArgv,
  cleanupGrokOuterSandbox,
  createGrokReviewInvocation,
  GROK_OUTER_SANDBOX_ENV,
  GROK_OUTER_TARGET_CONTRACT_SCHEMA_VERSION,
  GrokOuterSandboxError,
  prepareGrokOuterSandbox,
  spawnGrokOuterSandbox,
} from '../mcp/grok-outer-sandbox.mjs';
import { sha256Digest, TARGET_SCHEMA_VERSION, targetIdentityDigest } from '../mcp/preflight.mjs';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(TEST_ROOT, 'fixtures', 'grok-outer-fake.sh');
const STRICT_REAL_BWRAP = process.env.GROK_OUTER_REQUIRE_REAL === '1';
const PROBE_HOST_MARKER = '/tmp/grok-outer-probe-host-marker';
const CWD_MARKERS = [
  'grok-outer-target-write',
  'grok-outer-descendant-target',
  'grok-outer-common-write',
  'outside-marker',
].map((name) => path.join(process.cwd(), name));

async function assertCwdClean() {
  for (const marker of CWD_MARKERS) {
    await assert.rejects(lstat(marker), (error) => error?.code === 'ENOENT', `unexpected repository marker ${marker}`);
  }
}

before(async () => {
  await rm(PROBE_HOST_MARKER, { force: true });
  await assertCwdClean();
});

after(async () => {
  await assertCwdClean();
  await rm(PROBE_HOST_MARKER, { force: true });
});

async function sha256(source) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(source);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function authMetadata(source) {
  const entry = await lstat(source, { bigint: true });
  return {
    device: String(entry.dev),
    inode: String(entry.ino),
    size: String(entry.size),
    mtimeNs: String(entry.mtimeNs),
  };
}

function normalizeProbeOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function descriptor(source, format, extra = {}) {
  const canonical = await realpath(source);
  return { source: canonical, sha256: await sha256(canonical), format, ...extra };
}

function executableCandidates(command, environmentName, conventional) {
  const candidates = [];
  if (process.env[environmentName]) candidates.push(process.env[environmentName]);
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, command));
  }
  candidates.push(...conventional.map((directory) => path.join(directory, command)));
  return [...new Set(candidates)];
}

async function findRealBwrap() {
  const candidates = executableCandidates('bwrap', 'CODEX_TEST_BWRAP_PATH', [
    '/usr/local/bin', '/usr/bin', '/bin', '/opt/bin',
  ]);
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const entry = await lstat(canonical);
      if (!entry.isFile() || Number(entry.uid) !== process.getuid?.() || (entry.mode & 0o111) === 0) continue;
      const result = spawnSync(canonical, ['--version'], {
        cwd: '/', env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, shell: false,
        encoding: 'utf8', timeout: 3_000, maxBuffer: 16 * 1024,
      });
      if (result.status !== 0 || result.error) continue;
      return descriptor(canonical, 'static-elf', { version: normalizeProbeOutput(result) });
    } catch {
      // Try the next explicit or conventional canonical source.
    }
  }
  return null;
}

async function findRealBusybox() {
  const candidates = executableCandidates('busybox', 'CODEX_TEST_BUSYBOX_PATH', [
    '/usr/local/bin', '/usr/bin', '/bin', '/opt/bin',
  ]);
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const entry = await lstat(canonical);
      if (!entry.isFile() || (entry.mode & 0o111) === 0) continue;
      return descriptor(canonical, 'static-elf', { destination: '/usr/bin/busybox' });
    } catch {
      // Try the next explicit, PATH, or conventional canonical source.
    }
  }
  return null;
}

async function systemFileDescriptors() {
  const sources = {
    resolver: '/etc/resolv.conf',
    ca: '/etc/ssl/certs/ca-certificates.crt',
    passwd: '/etc/passwd',
    group: '/etc/group',
    services: '/etc/services',
    localtime: '/etc/localtime',
  };
  const result = {};
  for (const [name, source] of Object.entries(sources)) result[name] = await descriptor(source, 'data');
  return result;
}

function runGit(args, extraEnvironment = {}) {
  const result = spawnSync('git', args, {
    cwd: '/',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      ...extraEnvironment,
    },
    shell: false,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  assert.equal(result.status, 0, normalizeProbeOutput(result));
  return result.stdout.trim();
}

async function initializeGitTarget({ root, working, common }) {
  runGit(['init', '-q', `--separate-git-dir=${common}`, root]);
  // Keep the indirection relocatable so the same .git file resolves inside
  // the synthetic /workspace root.
  await writeFile(path.join(root, '.git'), 'gitdir: .git-common\n', { mode: 0o600 });
  const tracked = path.join(working, 'tracked.txt');
  await writeFile(tracked, 'tracked target fixture\n', { mode: 0o600 });
  runGit(['-C', root, 'add', path.relative(root, tracked)]);
  runGit([
    '-C', root,
    '-c', 'user.name=Grok Outer Test',
    '-c', 'user.email=grok-outer@example.invalid',
    'commit', '-qm', 'target fixture',
  ], {
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  });
  return runGit(['-C', working, 'rev-parse', '--verify', 'HEAD']);
}

async function makeTargetContract({ root, working, common }, {
  expectedHead,
  allowedPaths = ['.'],
  role = 'review',
} = {}) {
  assert.match(expectedHead, /^[a-f0-9]{40}$/);
  const rootEntry = await lstat(root, { bigint: true });
  const workingEntry = await lstat(working, { bigint: true });
  const workspaceIdentity = { device: String(rootEntry.dev), inode: String(rootEntry.ino) };
  const cwdIdentity = { device: String(workingEntry.dev), inode: String(workingEntry.ino) };
  const fingerprint = targetIdentityDigest({
    mode: 'explicit',
    resolved_workspace: root,
    resolved_cwd: working,
    git_common_directory: common,
    git_head: expectedHead,
    workspace_identity: workspaceIdentity,
    cwd_identity: cwdIdentity,
  });
  return {
    schema_version: TARGET_SCHEMA_VERSION,
    mode: 'explicit',
    working_directory: working,
    expected_git_root: root,
    resolved_workspace: root,
    resolved_cwd: working,
    git_common_directory: common,
    expected_head: expectedHead,
    observed_head: expectedHead,
    allowed_paths: [...allowedPaths],
    role,
    target_fingerprint: fingerprint,
    workspace_identity: workspaceIdentity,
    cwd_identity: cwdIdentity,
    isolation: 'read-only-process-contract',
  };
}

async function makeTree() {
  const base = await mkdtemp('/tmp/grok-outer-test-');
  const root = path.join(base, 'project');
  const working = path.join(root, 'review');
  const common = path.join(root, '.git-common');
  const jobs = path.join(base, 'jobs');
  const home = path.join(base, 'host-home');
  const grokHome = path.join(home, '.grok');
  const sessions = path.join(grokHome, 'sessions');
  const skills = path.join(grokHome, 'skills');
  const memory = path.join(grokHome, 'memory');
  const agents = path.join(grokHome, 'agents');
  await mkdir(working, { recursive: true, mode: 0o700 });
  const expectedHead = await initializeGitTarget({ root, working, common });
  await mkdir(jobs, { mode: 0o700 });
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(skills, { mode: 0o700 });
  await mkdir(memory, { mode: 0o700 });
  await mkdir(agents, { mode: 0o700 });
  await chmod(jobs, 0o700);
  // Ordinary user homes need not be owner-only; the consumed .grok subtree is.
  await chmod(home, 0o755);
  await chmod(grokHome, 0o700);
  await writeFile(path.join(grokHome, 'auth.json'), '{"token":"host-token"}\n', { mode: 0o600 });
  await writeFile(path.join(grokHome, 'agent_id'), 'host-agent\n', { mode: 0o600 });
  await writeFile(path.join(skills, 'skill-marker'), 'trusted native skill\n', { mode: 0o600 });
  const providerPath = path.join(base, 'fake-grok');
  await copyFile(FIXTURE, providerPath);
  await chmod(providerPath, 0o700);
  return {
    base, root, working, common, jobs, home, grokHome, sessions, skills, memory, agents, providerPath,
    target: await makeTargetContract({ root, working, common }, { expectedHead }),
  };
}

async function makeRealOptions(tree, bwrap, jobId, ttlMs = 10_000, providerPath = tree.providerPath, busybox,
  xaiApiKey = undefined) {
  const provider = await descriptor(providerPath, 'script', { version: 'fake-grok-outer 2.0' });
  const runtimeBusybox = busybox ?? await findRealBusybox();
  if (!runtimeBusybox) throw new Error('A host BusyBox executable is required for the real boundary fixture.');
  return {
    bwrap,
    provider,
    runtimeClosure: [runtimeBusybox],
    systemFiles: await systemFileDescriptors(),
    target: tree.target,
    jobsRoot: tree.jobs,
    hostHome: tree.home,
    nativeState: { sessions: true, memory: true, agents: true, user_skills: true },
    ...(xaiApiKey === undefined ? {} : { xaiApiKey }),
    jobId,
    ttlMs,
  };
}

function resultMap(stdout) {
  const result = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('RESULT ')) continue;
    const separator = line.indexOf('=', 7);
    if (separator > 7) result[line.slice(7, separator)] = line.slice(separator + 1);
  }
  return result;
}

function environmentKeys(stdout) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf('ENV-BEGIN');
  const end = lines.indexOf('ENV-END');
  assert.ok(start >= 0 && end > start, 'fixture did not emit its environment envelope');
  return lines.slice(start + 1, end).filter(Boolean).map((line) => line.split('=', 1)[0]).sort();
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('typed invocation maps the full normalized review contract and rejects raw authority', () => {
  const base = { operation: 'review', prompt: 'review the exact candidate' };
  const forbidden = [
    ['allow', ['*']], ['tools', ['shell']], ['permission_mode_raw', 'full'], ['sandbox', 'none'],
    ['config', '/tmp/config'], ['agent', '../agent'], ['prompt_file', '/tmp/prompt'],
    ['socket', '/run/user/1000/provider.sock'], ['cwd', '/'],
  ];
  for (const [key, value] of forbidden) {
    assert.throws(
      () => createGrokReviewInvocation({ ...base, [key]: value }),
      (error) => error instanceof GrokOuterSandboxError
        && ['unknown_field', 'invalid_invocation'].includes(error.code),
      `expected ${key} to be rejected`,
    );
  }
  assert.throws(
    () => createGrokReviewInvocation({ ...base, model: '*' }),
    (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_invocation',
  );
  assert.throws(
    () => createGrokReviewInvocation({ ...base, model: '../../provider' }),
    (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_invocation',
  );
  for (const reasoning_effort of ['low', 'medium', 'xhigh']) {
    assert.equal(createGrokReviewInvocation({ ...base, reasoning_effort }).configuration.reasoning_effort,
      reasoning_effort);
  }
  assert.throws(
    () => createGrokReviewInvocation({ ...base, output_format: 'stream-json' }),
    (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_invocation',
  );
  const invocation = createGrokReviewInvocation({
    ...base,
    model: 'grok-4.6',
    output_format: 'streaming-messages-json',
    include_partial_messages: true,
    verbatim: true,
    reasoning_effort: 'xhigh',
    max_turns: 100,
    session_id: '123e4567-e89b-42d3-a456-426614174000',
    resume: true,
    fork_session: true,
    agent: 'reviewer',
    rules: 'Read and verify only.',
    allowed_tools: ['Read', 'Grep'],
    disallowed_tools: ['Bash'],
    allow_rules: ['Read'],
    deny_rules: ['Bash'],
    no_subagents: false,
    experimental_memory: true,
  });
  assert.equal(Object.isFrozen(invocation), true);
  assert.equal(Object.isFrozen(invocation.configuration.allowed_tools), true);
  assert.equal(invocation.configuration.output_format, 'streaming-messages-json');
  assert.deepEqual(invocation.contract.forced, {
    no_auto_update: true,
    sandbox_profile: 'read-only',
    permission_mode: 'auto',
    denied_tools: ['MCPTool'],
  });
  assert.equal(invocation.contract.effective.memory, 'experimental');
  const schemaInvocation = createGrokReviewInvocation({
    ...base, json_schema: { type: 'object', additionalProperties: false }, verbatim: true,
  });
  assert.equal(schemaInvocation.configuration.output_format, 'json');
  assert.throws(
    () => buildGrokOuterSandboxArgv({ prepared: {}, invocation: { ...invocation } }),
    (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_prepared_state',
  );
});

test('the fake provider refuses the real user home before any probe or state write', async () => {
  await rm(PROBE_HOST_MARKER, { force: true });
  const result = spawnSync('/bin/sh', [FIXTURE, '--version'], {
    cwd: '/tmp',
    env: { ...process.env, HOME: homedir() },
    shell: false,
    encoding: 'utf8',
    timeout: 3_000,
  });
  assert.equal(result.status, 78);
  assert.match(normalizeProbeOutput(result), /RESULT fatal=unsafe-fixture-home/);
  await assert.rejects(lstat(PROBE_HOST_MARKER), (error) => error?.code === 'ENOENT');
  await assertCwdClean();
});

test('the fake provider accepts only a named temporary fixture home', async () => {
  const fixtureHome = await mkdtemp('/tmp/grok-outer-fixture-home-');
  try {
    await rm(PROBE_HOST_MARKER, { force: true });
    const result = spawnSync('/bin/sh', [FIXTURE, '--version'], {
      cwd: '/tmp',
      env: { ...process.env, HOME: fixtureHome },
      shell: false,
      encoding: 'utf8',
      timeout: 3_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'fake-grok-outer 2.0');
  } finally {
    await rm(PROBE_HOST_MARKER, { force: true });
    await rm(fixtureHome, { recursive: true, force: true });
  }
});

test('target contract is strict, canonical, and caller-fingerprint bound before provider access', async () => {
  const tree = await makeTree();
  const inertOptions = {
    bwrap: {
      source: path.join(tree.base, 'inert-bwrap'),
      sha256: '0'.repeat(64),
      format: 'static-elf',
      version: 'never-probed',
    },
    provider: {
      source: path.join(tree.base, 'inert-provider'),
      sha256: '0'.repeat(64),
      format: 'static-elf',
      version: 'never-probed',
    },
    runtimeClosure: [],
    systemFiles: {},
    jobsRoot: tree.jobs,
    hostHome: tree.home,
    jobId: 'target-contract',
    ttlMs: 1_000,
  };
  try {
    await assert.rejects(
      prepareGrokOuterSandbox({ ...inertOptions, target: { ...tree.target, unexpected: true } }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'unknown_field',
    );
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...inertOptions,
        target: { ...tree.target, expected_head: 'b'.repeat(40) },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'target_head_mismatch',
    );
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...inertOptions,
        target: { ...tree.target, target_fingerprint: '0'.repeat(64) },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'target_fingerprint_mismatch',
    );
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...inertOptions,
        target: { ...tree.target, role: 'implement' },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'unsupported_role',
    );
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...inertOptions,
        target: { ...tree.target, allowed_paths: ['../escape'] },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_target',
    );
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...inertOptions,
        target: { ...tree.target, allowed_paths: ['review'] },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'unsupported_allowed_paths',
    );
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...inertOptions,
        target: { ...tree.target, target_fingerprint: 'not-a-digest' },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_target_fingerprint',
    );
    await writeFile(path.join(tree.working, 'tracked.txt'), 'drifted target fixture\n');
    runGit(['-C', tree.root, 'add', 'review/tracked.txt']);
    runGit([
      '-C', tree.root,
      '-c', 'user.name=Grok Outer Test',
      '-c', 'user.email=grok-outer@example.invalid',
      'commit', '-qm', 'drift target',
    ], {
      GIT_AUTHOR_DATE: '2000-01-02T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-02T00:00:00Z',
    });
    await assert.rejects(
      prepareGrokOuterSandbox({ ...inertOptions, target: tree.target }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'target_head_mismatch',
    );
  } finally {
    await rm(tree.base, { recursive: true, force: true });
  }
});

test('target, hostile config, native mount, and both writable-overlap directions fail before any provider probe', async () => {
  const tree = await makeTree();
  const providerMarker = path.join(tree.base, 'provider-invoked');
  const markerProvider = path.join(tree.base, 'marker-provider');
  await writeFile(markerProvider, `#!/usr/bin/busybox sh\n/usr/bin/busybox touch '${providerMarker}'\nexit 1\n`, { mode: 0o700 });
  await chmod(markerProvider, 0o700);
  // These preflight cases must fail before executable validation or probing,
  // but still exercise the required provenance-shaped caller contract.
  const inertBwrapProvenance = {
    source: path.join(tree.base, 'inert-bwrap'),
    sha256: '0'.repeat(64),
    format: 'static-elf',
    version: 'never-probed',
  };
  const commonOptions = {
    bwrap: inertBwrapProvenance,
    provider: await descriptor(markerProvider, 'script', { version: 'never' }),
    runtimeClosure: [],
    systemFiles: {},
    target: tree.target,
    jobsRoot: tree.jobs,
    hostHome: tree.home,
    jobId: 'preflight',
    ttlMs: 1_000,
  };
  try {
    await assert.rejects(
      prepareGrokOuterSandbox({ ...commonOptions, xaiApiKey: 'must-never-launch' }),
      (error) => error instanceof GrokOuterSandboxError
        && error.code === 'unsupported_credential_projection',
    );
    await assert.rejects(lstat(providerMarker), (error) => error?.code === 'ENOENT');

    await assert.rejects(
      prepareGrokOuterSandbox({
        ...commonOptions,
        target: { ...tree.target, working_directory: path.join(tree.root, 'missing') },
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'missing_path',
    );
    await assert.rejects(lstat(providerMarker), (error) => error?.code === 'ENOENT');

    await mkdir(path.join(tree.working, '.grok'), { mode: 0o700 });
    await writeFile(path.join(tree.working, '.grok', 'hooks.json'), '{"start":"touch owned"}\n');
    await assert.rejects(
      prepareGrokOuterSandbox(commonOptions),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'hostile_project_config',
    );
    await rm(path.join(tree.working, '.grok'), { recursive: true });
    await assert.rejects(lstat(providerMarker), (error) => error?.code === 'ENOENT');

    await mkdir(path.join(tree.working, '.cursor'), { mode: 0o700 });
    await mkdir(path.join(tree.working, '.claude'), { mode: 0o700 });
    // Cursor/Claude imports are disabled in the clean environment, so their
    // inert project directories are not treated as Grok startup authority.

    await rm(path.join(tree.grokHome, 'memory'), { recursive: true });
    await symlink(tree.root, path.join(tree.grokHome, 'memory'));
    await assert.rejects(
      prepareGrokOuterSandbox({ ...commonOptions, nativeState: { memory: true } }),
      (error) => error instanceof GrokOuterSandboxError && ['invalid_path', 'non_canonical_path'].includes(error.code),
    );
    await rm(path.join(tree.grokHome, 'memory'));
    await assert.rejects(lstat(providerMarker), (error) => error?.code === 'ENOENT');

    const externalCommon = path.join(tree.base, 'external-common');
    await mkdir(externalCommon, { mode: 0o700 });
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...commonOptions,
        target: { ...tree.target, git_common_directory: externalCommon },
      }),
      (error) => error instanceof GrokOuterSandboxError
        && error.code === 'unsupported_git_layout'
        && /outside expected_git_root/.test(error.message),
    );

    const containingJobs = path.join(tree.root, 'jobs');
    await mkdir(containingJobs, { mode: 0o700 });
    await assert.rejects(
      prepareGrokOuterSandbox({ ...commonOptions, jobsRoot: containingJobs, jobId: 'inside-target' }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'target_writable_overlap',
    );

    const nestedJobRoot = path.join(tree.jobs, 'contains-target');
    const nestedTarget = path.join(nestedJobRoot, 'project');
    const nestedWorking = path.join(nestedTarget, 'work');
    const nestedCommon = path.join(nestedTarget, '.git-common');
    await mkdir(nestedWorking, { recursive: true, mode: 0o700 });
    const nestedExpectedHead = await initializeGitTarget({
      root: nestedTarget,
      working: nestedWorking,
      common: nestedCommon,
    });
    const nestedTargetContract = await makeTargetContract({
      root: nestedTarget,
      working: nestedWorking,
      common: nestedCommon,
    }, { expectedHead: nestedExpectedHead });
    await assert.rejects(
      prepareGrokOuterSandbox({
        ...commonOptions,
        target: nestedTargetContract,
        jobId: 'contains-target',
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'target_writable_overlap',
    );
    await assert.rejects(lstat(providerMarker), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(tree.base, { recursive: true, force: true });
  }
});

test('strict real boundary pins provenance, exposes only the minroot closure, contains descendants, and cleans credentials', async (context) => {
  const bwrap = await findRealBwrap();
  if (!bwrap) {
    if (STRICT_REAL_BWRAP) assert.fail('strict mode requires a current-user canonical static Bubblewrap executable');
    context.skip('classified: real Bubblewrap executable is unavailable in this unit environment');
    return;
  }
  const busybox = await findRealBusybox();
  if (!busybox) {
    if (STRICT_REAL_BWRAP) assert.fail('strict mode requires a host BusyBox executable for the fixed synthetic runtime path');
    context.skip('classified: host BusyBox executable is unavailable for the real boundary fixture');
    return;
  }
  const tree = await makeTree();
  try {
    for (const name of ['.cursor', '.claude', '.codex']) {
      const compatibilityRoot = path.join(tree.working, name);
      await mkdir(compatibilityRoot, { mode: 0o700 });
      await writeFile(path.join(compatibilityRoot, 'import-marker'), `hostile ${name} import marker\n`, { mode: 0o600 });
    }
    const hostAuthPath = path.join(tree.grokHome, 'auth.json');
    const hostAuthBefore = await readFile(hostAuthPath, 'utf8');
    const hostAuthMetadataBefore = await authMetadata(hostAuthPath);
    let prepared;
    try {
      prepared = await prepareGrokOuterSandbox(await makeRealOptions(
        tree, bwrap, 'boundary', 10_000, tree.providerPath, busybox,
      ));
    } catch (error) {
      if (!STRICT_REAL_BWRAP && error instanceof GrokOuterSandboxError && error.code === 'executable_probe_failed') {
        context.skip('classified: enclosing task sandbox does not permit the real Bubblewrap boundary');
        return;
      }
      throw error;
    }
    assert.equal(await lstat(PROBE_HOST_MARKER).then(() => true, () => false), false,
      'provider --version probe escaped its Bubblewrap envelope');

    const invocation = createGrokReviewInvocation({
      operation: 'review',
      prompt: 'boundary-review',
      model: 'grok-4.6',
      output_format: 'streaming-messages-json',
      include_partial_messages: true,
      verbatim: true,
      reasoning_effort: 'xhigh',
      max_turns: 16,
      session_id: '123e4567-e89b-42d3-a456-426614174000',
      resume: true,
      fork_session: true,
      agent: 'reviewer',
      rules: 'Read and verify only.',
      allowed_tools: ['Read', 'Grep'],
      disallowed_tools: ['Bash'],
      allow_rules: ['Read'],
      deny_rules: ['Bash'],
      experimental_memory: true,
      disable_web_search: true,
    });
    const argv = buildGrokOuterSandboxArgv({ prepared, invocation });
    for (const flag of [
      '--die-with-parent', '--unshare-all', '--share-net', '--disable-userns',
      '--assert-userns-disabled', '--clearenv', '--remount-ro',
      '--ro-bind-fd', '--bind-fd',
    ]) assert.ok(argv.includes(flag), `missing boundary flag ${flag}`);
    assert.equal(argv.includes('--new-session'), false,
      'the provider must remain in the detached launcher process group');
    assert.ok(argv.some((value, index) => value === '--tmpfs' && argv[index + 1] === '/'));
    assert.equal(argv.includes('--ro-bind'), false, 'path-based host bind unexpectedly present');
    assert.equal(argv.includes('--bind'), false, 'path-based writable bind unexpectedly present');
    assert.equal(argv.includes(tree.base), false, 'host test root leaked into Bubblewrap argv');
    assert.equal(argv.includes(bwrap.source), false, 'bwrap source path leaked into exec argv');
    assert.equal(argv.includes('/root'), false);
    assert.equal(argv.includes('/sys'), false);
    assert.equal(argv.includes('/mnt'), false);
    assert.equal(argv.includes('/run/user'), false);
    for (const destination of [
      '/opt/grok/bin/grok', '/workspace', '/workspace/.git-common', '/home/grok',
      '/home/grok/.grok/sessions', '/home/grok/.grok/skills',
      '/etc/resolv.conf', '/etc/ssl/certs/ca-certificates.crt', '/etc/passwd',
      '/etc/group', '/etc/services', '/etc/localtime', '/usr/bin/busybox',
    ]) assert.ok(argv.includes(destination), `missing exact mount ${destination}`);
    const setenvKeys = argv.flatMap((value, index) => value === '--setenv' ? [argv[index + 1]] : []).sort();
    assert.deepEqual(setenvKeys, [
      ...Object.keys(GROK_OUTER_SANDBOX_ENV), 'CODEX_COENGINEER_JOB_ID', 'PATH', 'PWD',
    ].sort());
    for (const [key, value] of Object.entries(GROK_OUTER_SANDBOX_ENV)) {
      if (/^GROK_(?:CURSOR|CLAUDE|CODEX)_/.test(key)) assert.equal(value, 'false');
    }
    const providerIndex = argv.lastIndexOf('/opt/grok/bin/grok');
    assert.deepEqual(argv.slice(providerIndex + 1), [
      '--no-auto-update', '--agent', 'reviewer', '-p', 'boundary-review', '--cwd', '/workspace/review',
      '--output-format', 'streaming-messages-json', '--verbatim', '--include-partial-messages',
      '-m', 'grok-4.6', '-s', '123e4567-e89b-42d3-a456-426614174000', '--resume', '--fork-session',
      '--reasoning-effort', 'xhigh', '--max-turns', '16', '--sandbox', 'read-only',
      '--permission-mode', 'auto', '--rules', 'Read and verify only.', '--tools', 'Read,Grep',
      '--disallowed-tools', 'Bash', '--allow', 'Read', '--deny', 'Bash', '--deny', 'MCPTool',
      '--disable-web-search', '--experimental-memory',
    ]);
    const sandboxIndex = argv.lastIndexOf('--sandbox');
    assert.deepEqual(argv.slice(sandboxIndex, sandboxIndex + 4),
      ['--sandbox', 'read-only', '--permission-mode', 'auto']);
    assert.ok(argv.some((value, index) => value === '--deny' && argv[index + 1] === 'MCPTool'));

    const run = await spawnGrokOuterSandbox({ prepared, invocation });
    assert.equal(Object.isFrozen(run.child), true);
    assert.deepEqual(Object.keys(run.child).sort(),
      ['cancel', 'exitCode', 'once', 'pid', 'signalCode', 'stderr', 'stdout'].sort());
    assert.equal('stdio' in run.child, false, 'raw ChildProcess stdio bypass was exposed');
    assert.equal('spawnargs' in run.child, false, 'raw ChildProcess argv was exposed');
    assert.equal('kill' in run.child, false, 'unbounded raw process control was exposed');
    const stdoutPromise = collect(run.child.stdout);
    const stderrPromise = collect(run.child.stderr);
    const completion = await run.completion;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    assert.equal(completion.code, 0, `boundary fixture failed: ${stderr}`);
    assert.equal(completion.signal, null);
    assert.equal(completion.outcome, 'exited');
    const results = resultMap(stdout);
    assert.deepEqual(results, {
      prompt: 'boundary-review',
      sandbox_home: 'dedicated',
      xai_api_key: 'absent',
      job_owner: 'boundary',
      target: 'denied',
      git_common: 'denied',
      outside: 'denied',
      private_state: 'written',
      auth_refresh: 'written',
      private_tmp: 'written',
      private_var_tmp: 'written',
      private_run: 'written',
      native_session: 'written',
      native_skill: 'denied',
      host_root_ssh: 'absent',
      host_home_codex: 'absent',
      host_auth: 'absent',
      runtime_sockets: 'absent',
      sys: 'absent',
      mnt: 'absent',
      project_grok: 'absent',
      project_mcp: 'absent',
      project_cursor_marker: 'visible',
      project_claude_marker: 'visible',
      project_codex_marker: 'visible',
      imported_cursor: 'absent',
      imported_claude: 'absent',
      imported_codex: 'absent',
      native_skill_read: 'visible',
      descendant_target: 'denied',
      descendant_private: 'written',
      descendant_userns: 'denied',
    });
    const allowedRuntimeKeys = new Set([
      ...Object.keys(GROK_OUTER_SANDBOX_ENV), 'CODEX_COENGINEER_JOB_ID', 'PATH', 'PWD', 'SHLVL',
    ]);
    const actualEnvironmentKeys = environmentKeys(stdout);
    assert.ok(actualEnvironmentKeys.every((key) => allowedRuntimeKeys.has(key)),
      `unexpected provider environment: ${actualEnvironmentKeys.join(', ')}`);
    assert.deepEqual(await authMetadata(hostAuthPath), hostAuthMetadataBefore,
      'private auth refresh changed host auth inode, size, or mtime');
    assert.equal(await readFile(hostAuthPath, 'utf8'), hostAuthBefore,
      'private auth refresh modified host auth');
    await assert.rejects(lstat(path.join(tree.working, 'grok-outer-target-write')), (error) => error?.code === 'ENOENT');
    await assert.rejects(lstat(path.join(tree.common, 'grok-outer-common-write')), (error) => error?.code === 'ENOENT');
    assert.equal(await readFile(path.join(tree.sessions, 'fixture-session'), 'utf8'), '');
    await assert.rejects(lstat(prepared.private_home), (error) => error?.code === 'ENOENT');
    assert.equal(run.receipt.real_boundary_exercised, true);
    assert.equal(run.receipt.root, 'synthetic-tmpfs-remounted-read-only');
    assert.equal(run.receipt.provenance.bwrap.sha256, bwrap.sha256);
    assert.equal(run.receipt.provenance.bwrap.version, bwrap.version);
    assert.equal(run.receipt.provenance.bwrap.format, 'static-elf');
    assert.equal('source' in run.receipt.provenance.bwrap, false);
    assert.equal(run.receipt.provenance.provider.sha256, (await descriptor(tree.providerPath, 'script')).sha256);
    assert.equal(run.receipt.provenance.provider.format, 'script');
    assert.equal('source' in run.receipt.provenance.provider, false);
    assert.equal(run.receipt.target.target_fingerprint, tree.target.target_fingerprint);
    assert.equal(run.receipt.target.expected_head, tree.target.expected_head);
    assert.deepEqual(run.receipt.target.allowed_paths, tree.target.allowed_paths);
    assert.equal(run.receipt.target.role, 'review');
    assert.equal(run.receipt.target.mode, 'explicit');
    assert.equal(run.receipt.target.resolved_workspace, tree.root);
    assert.equal(run.receipt.target.resolved_cwd, tree.working);
    const expectedTargetContractDigest = sha256Digest({
      schema_version: GROK_OUTER_TARGET_CONTRACT_SCHEMA_VERSION,
      target_schema_version: TARGET_SCHEMA_VERSION,
      mode: 'explicit',
      expected_head: tree.target.expected_head,
      allowed_paths: ['.'],
      role: 'review',
      target_fingerprint: tree.target.target_fingerprint,
    });
    assert.equal(prepared.target_contract_digest, expectedTargetContractDigest);
    assert.equal(run.receipt.target.target_contract_digest, expectedTargetContractDigest);
    assert.equal(run.receipt.target_contract_digest, expectedTargetContractDigest);
    assert.equal(Object.isFrozen(run.receipt.target), true);
    assert.deepEqual(run.receipt.spawn_contract, {
      detached: true, process_group: 'child-pid', shell: false, die_with_parent: true,
    });
    assert.equal(run.receipt.invocation_contract.effective.output_format, 'streaming-messages-json');
    assert.deepEqual(run.receipt.invocation_contract.forced.denied_tools, ['MCPTool']);

    const forgedInvocationPrepared = await prepareGrokOuterSandbox(
      await makeRealOptions(tree, bwrap, 'forged-invocation', 10_000, tree.providerPath, busybox),
    );
    const forgedInvocation = { ...invocation };
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: forgedInvocationPrepared, invocation: forgedInvocation }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_invocation',
    );
    await assert.rejects(lstat(forgedInvocationPrepared.private_home), (error) => error?.code === 'ENOENT');
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: forgedInvocationPrepared, invocation: forgedInvocation }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_prepared_state',
    );

    const roleMismatchPrepared = await prepareGrokOuterSandbox({
      ...(await makeRealOptions(tree, bwrap, 'role-mismatch', 10_000, tree.providerPath, busybox)),
      target: { ...tree.target, role: 'verify' },
    });
    assert.notEqual(roleMismatchPrepared.target.target_contract_digest,
      prepared.target.target_contract_digest, 'role did not change the canonical target contract digest');
    await assert.rejects(
      spawnGrokOuterSandbox({
        prepared: roleMismatchPrepared,
        invocation: createGrokReviewInvocation({ operation: 'review', prompt: 'role mismatch' }),
      }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'target_role_mismatch',
    );
    await assert.rejects(lstat(roleMismatchPrepared.private_home), (error) => error?.code === 'ENOENT');

    const unknownSpawnFieldPrepared = await prepareGrokOuterSandbox(
      await makeRealOptions(tree, bwrap, 'unknown-spawn-field', 10_000, tree.providerPath, busybox),
    );
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: unknownSpawnFieldPrepared, invocation, unexpected: true }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'unknown_field',
    );
    await assert.rejects(lstat(unknownSpawnFieldPrepared.private_home), (error) => error?.code === 'ENOENT');

    const concurrentPrepared = await prepareGrokOuterSandbox(
      await makeRealOptions(tree, bwrap, 'concurrent-spawn', 10_000, tree.providerPath, busybox),
    );
    const concurrentInvocation = createGrokReviewInvocation({ operation: 'review', prompt: 'wait-for-ttl' });
    const concurrentOutcomes = await Promise.allSettled([
      spawnGrokOuterSandbox({ prepared: concurrentPrepared, invocation: concurrentInvocation }),
      spawnGrokOuterSandbox({ prepared: concurrentPrepared, invocation: concurrentInvocation }),
    ]);
    const concurrentWinners = concurrentOutcomes.filter(({ status }) => status === 'fulfilled');
    const concurrentLosers = concurrentOutcomes.filter(({ status }) => status === 'rejected');
    assert.equal(concurrentWinners.length, 1, 'concurrent spawn launched more than one child');
    assert.equal(concurrentLosers.length, 1);
    assert.equal(concurrentLosers[0].reason.code, 'already_spawned');
    const concurrentRun = concurrentWinners[0].value;
    const concurrentReady = new Promise((resolve) => concurrentRun.child.stdout.once('data', resolve));
    const concurrentStdout = collect(concurrentRun.child.stdout);
    const concurrentStderr = collect(concurrentRun.child.stderr);
    await concurrentReady;
    await cleanupGrokOuterSandbox(concurrentPrepared);
    const concurrentCompletion = await concurrentRun.completion;
    await Promise.all([concurrentStdout, concurrentStderr]);
    assert.notEqual(concurrentCompletion.signal, null, 'concurrent winner was not cleanup-managed');
    assert.equal(concurrentCompletion.outcome, 'cancelled');
    await assert.rejects(lstat(concurrentPrepared.private_home), (error) => error?.code === 'ENOENT');

    const mutatingProvider = path.join(tree.base, 'mutating-provider');
    await copyFile(FIXTURE, mutatingProvider);
    await chmod(mutatingProvider, 0o700);
    const mutationPrepared = await prepareGrokOuterSandbox(
      await makeRealOptions(tree, bwrap, 'mutation', 10_000, mutatingProvider, busybox),
    );
    const injectedPrivateConfig = path.join(mutationPrepared.private_home, '.grok', 'config.json');
    await writeFile(injectedPrivateConfig, '{"mcp":"hostile"}\n', { mode: 0o600 });
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: mutationPrepared, invocation }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'private_home_tampered',
    );
    await assert.rejects(lstat(mutationPrepared.private_home), (error) => error?.code === 'ENOENT');
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: mutationPrepared, invocation }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'invalid_prepared_state',
    );

    const sourceMutationProvider = path.join(tree.base, 'source-mutation-provider');
    await copyFile(FIXTURE, sourceMutationProvider);
    await chmod(sourceMutationProvider, 0o700);
    const sourceMutationPrepared = await prepareGrokOuterSandbox(
      await makeRealOptions(tree, bwrap, 'source-mutation', 10_000, sourceMutationProvider, busybox),
    );
    await appendFile(sourceMutationProvider, '\n# changed after preparation\n');
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: sourceMutationPrepared, invocation }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'source_changed',
    );
    await assert.rejects(lstat(sourceMutationPrepared.private_home), (error) => error?.code === 'ENOENT');
    await cleanupGrokOuterSandbox(sourceMutationPrepared);

    const duplicatePrepared = await prepareGrokOuterSandbox(
      await makeRealOptions(tree, bwrap, 'duplicate-spawn', 10_000, tree.providerPath, busybox),
    );
    const duplicateInvocation = createGrokReviewInvocation({ operation: 'review', prompt: 'wait-for-ttl' });
    const duplicateRun = await spawnGrokOuterSandbox({
      prepared: duplicatePrepared,
      invocation: duplicateInvocation,
    });
    const duplicateReady = new Promise((resolve) => duplicateRun.child.stdout.once('data', resolve));
    const duplicateStdout = collect(duplicateRun.child.stdout);
    const duplicateStderr = collect(duplicateRun.child.stderr);
    await duplicateReady;
    await assert.rejects(
      spawnGrokOuterSandbox({ prepared: duplicatePrepared, invocation: duplicateInvocation }),
      (error) => error instanceof GrokOuterSandboxError && error.code === 'already_spawned',
    );
    assert.equal(await lstat(duplicatePrepared.private_home).then(() => true, () => false), true,
      'duplicate spawn unexpectedly cleaned the active sandbox');
    await cleanupGrokOuterSandbox(duplicatePrepared);
    const duplicateCompletion = await duplicateRun.completion;
    await Promise.all([duplicateStdout, duplicateStderr]);
    assert.notEqual(duplicateCompletion.signal, null, 'manual cleanup did not terminate the original process');
    await assert.rejects(lstat(duplicatePrepared.private_home), (error) => error?.code === 'ENOENT');

    const ttlPrepared = await prepareGrokOuterSandbox(await makeRealOptions(tree, bwrap, 'ttl', 200, tree.providerPath, busybox));
    const ttlRun = await spawnGrokOuterSandbox({
      prepared: ttlPrepared,
      invocation: createGrokReviewInvocation({ operation: 'review', prompt: 'wait-for-ttl' }),
    });
    const ttlStdout = collect(ttlRun.child.stdout);
    const ttlStderr = collect(ttlRun.child.stderr);
    const ttlCompletion = await ttlRun.completion;
    await Promise.all([ttlStdout, ttlStderr]);
    assert.notEqual(ttlCompletion.signal, null, 'TTL did not terminate the detached process group');
    assert.equal(ttlCompletion.outcome, 'ttl_expired');
    await assert.rejects(lstat(ttlPrepared.private_home), (error) => error?.code === 'ENOENT');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stubbornPrepared = await prepareGrokOuterSandbox(
        await makeRealOptions(tree, bwrap, `stubborn-${attempt}`, 10_000, tree.providerPath, busybox),
      );
      const stubbornRun = await spawnGrokOuterSandbox({
        prepared: stubbornPrepared,
        invocation: createGrokReviewInvocation({ operation: 'review', prompt: 'stubborn-child' }),
      });
      const stubbornStdout = collect(stubbornRun.child.stdout);
      const stubbornStderr = collect(stubbornRun.child.stderr);
      await cleanupGrokOuterSandbox(stubbornPrepared);
      const stubbornCompletion = await stubbornRun.completion;
      await Promise.all([stubbornStdout, stubbornStderr]);
      assert.notEqual(stubbornCompletion.signal, null, 'manual cleanup did not terminate the stubborn process group');
      assert.equal(stubbornCompletion.outcome, 'cancelled');
      assert.equal(stubbornCompletion.cleaned, true);
      assert.equal(stubbornCompletion.error, null);
      assert.throws(
        () => process.kill(-stubbornRun.child.pid, 0),
        (error) => error?.code === 'ESRCH',
        'the stubborn provider process group survived successful cleanup',
      );
      await assert.rejects(lstat(stubbornPrepared.private_home), (error) => error?.code === 'ENOENT');
    }
  } finally {
    await rm(tree.base, { recursive: true, force: true });
    await rm(PROBE_HOST_MARKER, { force: true });
  }
});
